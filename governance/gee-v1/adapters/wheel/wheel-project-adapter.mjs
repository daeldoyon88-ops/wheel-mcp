import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadLegacyGateContract, mapLegacyGateContractToExecutionView } from './map-gate-contract.mjs';
import { validateStateSeal } from '../../../tools/validate-state-seal.mjs';
import { validateLedger, validateLedgerPrefix } from '../../../tools/validate-status-ledger.mjs';
import { resolveOpenDefectsKnowledgeFromJsonText } from '../../contracts/validate-open-defects-knowledge.mjs';
import { assertIdentityBinding } from '../../core/identity-binding.mjs';
import { requireVerifiedState } from '../../core/authoritative-state.mjs';
import { verifyHeadWitness } from '../../core/head-witness.mjs';
import { deriveAuthoritativeStateFromLedger, hasNonGenesisTransition, deriveActivationLedgerBinding } from '../../core/authority-event-log.mjs';
import { loadConfiguredExternalWitnesses } from '../../core/witness-source.mjs';
import { isTrustSufficientFor, minTrustLevelFor } from '../../core/trust-policy.mjs';
import { validateStateRevision } from '../../../tools/validate-state-revision.mjs';
import { activationIdOf } from '../../contracts/activation-anchor.mjs';
import { sealExecutionContract } from '../../contracts/seal-execution-contract.mjs';
import { sha256Bytes } from '../../../tools/canonical-json.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from './external-authority-policy.mjs';

const LEDGER_RELATIVE_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';

/**
 * R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: the canonical ledger transitionType that, for the
 * Wheel/GATE work-unit model, freezes/activates an execution contract under a specific
 * activation-authority record. Reused as-is from the existing closed transition table
 * (AUTHORIZED_NOT_STARTED -> IN_PROGRESS : START — see governance/tools/validate-status-ledger.mjs)
 * rather than inventing a second authority spine or a new transitionType: real historical gate
 * START events already pin authorityPath+authoritySha256 for whatever authorizes that gate's
 * execution start. Exported so tests can build ledger fixtures against the same constant instead
 * of duplicating the literal.
 */
export const ACTIVATION_LEDGER_TRANSITION_TYPE = 'START';

/**
 * TJ-02: sealedAt for the read-time-derived execution seal (see view.execution.seal below) is
 * pinned to this fixed constant rather than wall-clock time, so the derivation reproduces
 * byte-identically on every call. Exported so tests can independently compute the same expected
 * seal a real activation record must pin against, without duplicating a literal that could
 * silently drift from the adapter's own value.
 */
export const EXECUTION_SEAL_DERIVATION_EPOCH = '1970-01-01T00:00:00.000Z';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function existsFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function loadRegistry(repoRoot) {
  const registryPath = path.join(repoRoot, 'governance', 'GATE_REGISTRY_00_40.json');
  return { registryPath, registry: readJson(registryPath) };
}

function loadSnapshotStatus(repoRoot, gateId) {
  const snapshotPath = path.join(repoRoot, 'governance', 'state', 'generated', 'GATE_STATUS_SNAPSHOT.json');
  if (!existsFile(snapshotPath)) return { status: null, authority: null };
  const snapshot = readJson(snapshotPath);
  const gates = Array.isArray(snapshot.gates) ? snapshot.gates : [];
  const row = gates.find((g) => g.gateId === gateId);
  return {
    status: row?.currentStatus || null,
    authority: snapshotPath.replace(/\\/g, '/')
  };
}

/**
 * RC-1/RC-2: the ledger is the single authority spine. Loaded once per view
 * (validateLedger already re-derives everything from live bytes; no caching
 * of a verdict across calls). Missing ledger fails closed, never throws.
 */
function loadLedgerContext(repoRoot) {
  const ledgerPath = path.join(repoRoot, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const report = validateLedger({ root: repoRoot, ledgerPath, policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  return { report, ledgerPath: path.relative(repoRoot, ledgerPath).split(path.sep).join('/') };
}

/**
 * RC-1/FINAL-01: graded trust level for one work unit's ledger-derived state.
 * External witnesses are loaded from OUTSIDE the governed set via
 * core/witness-source.mjs (GEE_HEAD_WITNESS_SOURCE env var, or none). Absence
 * of a configured source yields an empty witness list — the same as before —
 * so ANCHORED_EXTERNAL is only reached when a real out-of-repo witness is
 * actually supplied, never fabricated here.
 *
 * TJ-01: `governedRoots` is the entire repo root, not just governance/ — a
 * witness source whose resolved real path lands anywhere inside the mutable
 * repository (directly, via traversal, via a symlink, or under governance/
 * itself) can never be honored, so a self-witness can never reach
 * ANCHORED_EXTERNAL. External means outside the whole repository, not merely
 * outside governance/.
 */
function computeGateAuthoritativeState(gateId, ledgerContext, repoRoot) {
  const { report, ledgerPath } = ledgerContext;
  const trust = verifyHeadWitness({
    ledgerSha256: report.ledgerSha256,
    chainValid: report.valid,
    hasNonGenesisTransition: hasNonGenesisTransition(report, gateId),
    witnesses: loadConfiguredExternalWitnesses({ governedRoots: [repoRoot] })
  });
  return deriveAuthoritativeStateFromLedger({
    ledgerReport: report,
    ledgerPath,
    workUnitId: gateId,
    projectId: 'WHEEL',
    trustLevel: trust.trustLevel,
    subtreePrefix: `governance/gates/${gateId}/`
  });
}

/**
 * Pure seal-layer resolution: does a sealed revision exist for this gate, is
 * it internally valid, and does it bind to the SAME work unit it is being
 * read for? This function makes NO ledger decision — RC-2 sources `status`
 * from the ledger, not from here.
 *
 * RC-2/CT-B repair: identity is asserted BEFORE any evidence is interpreted.
 * CURRENT_STATE.gateId, CURRENT_STATE.revisionPath (must resolve under this
 * gate's own subtree), STATE_SEAL.gateId, and CURRENT_STATE.stateSealSha256
 * (must match the real seal bytes) are all checked. Any mismatch discards the
 * evidence — IDENTITY_BINDING_VIOLATION / POINTER_HASH_MISMATCH — it is never
 * silently trusted for a different subject.
 */
function loadSealLayer(repoRoot, gateId) {
  const currentStatePath = path.join(repoRoot, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json');
  if (!existsFile(currentStatePath)) {
    return { status: null, statusKnowledge: 'ABSENT', stateRevision: null, sealPath: null, sealPayload: null, sealValid: false, sources: [] };
  }
  const currentState = readJson(currentStatePath);
  const subtreePrefix = `governance/gates/${gateId}/`;
  const sources = [`governance/gates/${gateId}/state/CURRENT_STATE.json`];

  const pointerBinding = assertIdentityBinding(
    { workUnitId: gateId, subtreePrefix },
    [
      { source: 'CURRENT_STATE.gateId', workUnitId: currentState.gateId },
      { source: 'CURRENT_STATE.revisionPath', path: currentState.revisionPath }
    ]
  );
  if (pointerBinding.status !== 'BOUND') {
    return {
      status: null, statusKnowledge: 'IDENTITY_BINDING_VIOLATION', stateRevision: currentState.stateRevision || null,
      sealPath: null, sealPayload: null, sealValid: false, sources, currentState,
      identityViolations: pointerBinding.violations
    };
  }

  const sealPath = path.join(repoRoot, currentState.revisionPath, 'STATE_SEAL.json');
  sources.push(path.relative(repoRoot, sealPath).split(path.sep).join('/'));
  if (!existsFile(sealPath)) {
    return { status: null, statusKnowledge: 'SEAL_ABSENT', stateRevision: currentState.stateRevision, sealPath, sealPayload: null, sealValid: false, sources, currentState };
  }

  const sealBytesSha = sha256File(sealPath);
  const sealReport = validateStateSeal({ root: repoRoot, sealPath });
  if (!sealReport.valid) {
    return {
      status: 'UNVERIFIED', statusKnowledge: 'SEAL_INVALID', stateRevision: currentState.stateRevision, sealPath,
      sealPayload: null, sealValid: false, sealFindings: sealReport.findings, sealSha256: sealBytesSha, sources, currentState
    };
  }

  const seal = readJson(sealPath);
  const sealBinding = assertIdentityBinding({ workUnitId: gateId, subtreePrefix }, [{ source: 'STATE_SEAL.gateId', workUnitId: seal.gateId }]);
  const pointerHashMatches = currentState.stateSealSha256 === sealBytesSha;
  if (sealBinding.status !== 'BOUND' || !pointerHashMatches) {
    return {
      status: 'UNVERIFIED',
      statusKnowledge: sealBinding.status !== 'BOUND' ? 'IDENTITY_BINDING_VIOLATION' : 'POINTER_HASH_MISMATCH',
      stateRevision: currentState.stateRevision, sealPath, sealPayload: null, sealValid: false, sealSha256: sealBytesSha,
      identityViolations: sealBinding.violations, sources, currentState
    };
  }

  const payload = seal.payload || {};
  const status = payload.executionStatus || payload.i4Status || null;
  return {
    status, statusKnowledge: 'SEAL_VERIFIED', stateRevision: currentState.stateRevision,
    sealPath, sealPayload: payload, sealValid: true, sealSha256: sealBytesSha, sources, currentState, seal
  };
}

/**
 * FC-02: is this specific PROTECTED_HASH_MISMATCH finding a PROVEN historical
 * ledger-prefix evolution, and nothing else? A checkpoint's protectedHashes
 * pin can legitimately go stale ONLY for the append-only ledger itself, and
 * ONLY when the pinned expected digest is reproducible as an EXACT, chain-
 * verified byte prefix of the CURRENT live ledger (i.e. the pin names a real
 * earlier head of the very same append-only log, not an arbitrary hash).
 * There is no blanket path allowlist: any other protected path, or a ledger
 * pin whose expected digest does not reproduce as a valid prefix, is fail-
 * closed BLOCKING — the caller never downgrades on detectorId alone.
 */
function isProvenHistoricalLedgerPrefixDrift(repoRoot, findingRecord) {
  const protectedHash = findingRecord?.actualValue;
  if (!protectedHash || typeof protectedHash !== 'object') return false;
  const protectedPath = typeof protectedHash.path === 'string' ? protectedHash.path.split(path.sep).join('/') : null;
  if (protectedPath !== LEDGER_RELATIVE_PATH) return false;
  const expectedSha256 = protectedHash.sha256;
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) return false;

  const ledgerPath = path.join(repoRoot, LEDGER_RELATIVE_PATH);
  if (!existsFile(ledgerPath)) return false;
  const lineCount = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.length > 0).length;
  for (let ordinal = 1; ordinal <= lineCount; ordinal += 1) {
    let result;
    try {
      result = validateLedgerPrefix({
        root: repoRoot, ledgerPath, throughOrdinal: ordinal,
        expectedPrefixSha256: expectedSha256, policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
      });
    } catch {
      continue;
    }
    if (result.matchesExpectedHistoricalDigest && result.prefixChainValid) return true;
  }
  return false;
}

/**
 * FINAL-04/FC-02: reach the canonical validate-state-revision.mjs instead of
 * relying only on the adapter's own ad hoc pointer/seal identity checks
 * above. PROTECTED_HASH_MISMATCH is BLOCKING BY DEFAULT, exactly like every
 * other structural/identity finding here — it is downgraded to disclosed,
 * non-blocking drift ONLY per-finding, and ONLY when
 * isProvenHistoricalLedgerPrefixDrift proves that specific pin names a real,
 * chain-verified, reproducible earlier head of the ledger itself. Any other
 * protected-path mismatch, or a ledger pin that fails to reproduce, blocks
 * exactly like an unrelated structural finding — canonicalRevisionStructurally
 * Valid can never read true while a real, unproven PROTECTED_HASH_MISMATCH is
 * present, no matter what its detectorId is.
 */
function checkCanonicalRevisionStructural(repoRoot, gateId) {
  const currentStatePath = path.join(repoRoot, 'governance', 'gates', gateId, 'state', 'CURRENT_STATE.json');
  if (!existsFile(currentStatePath)) {
    return { applicable: false, structurallyValid: true, driftFindings: [], blockingFindings: [] };
  }
  const report = validateStateRevision({ root: repoRoot, gateId, currentStatePath });
  const driftFindings = [];
  const blockingFindings = [];
  for (const findingRecord of report.findings) {
    if (findingRecord.detectorId === 'PROTECTED_HASH_MISMATCH' && isProvenHistoricalLedgerPrefixDrift(repoRoot, findingRecord)) {
      driftFindings.push(findingRecord);
    } else {
      blockingFindings.push(findingRecord);
    }
  }
  return { applicable: true, structurallyValid: blockingFindings.length === 0, driftFindings, blockingFindings };
}

/**
 * Fail-closed open-defects resolution.
 * Absence / unreadable / structurally invalid => UNKNOWN — never silently 0.
 *
 * M2 (monotonic fail-closed hardening). Parsing an OPEN_DEFECTS.json that
 * happens to sit at the right path is NOT knowledge. Before this change, a
 * well-formed `{"defects": []}` dropped into a revision directory resolved to
 * KNOWN_ZERO on the strength of its own bytes alone — no proof it was ever the
 * document the gate actually sealed. "No open defects" is a load-bearing claim:
 * readiness and closure both consume it, so an unsealed file could assert a
 * clean gate it never earned.
 *
 * Defects knowledge is therefore now reachable ONLY through verified sealed
 * provenance. ALL of the following must hold, or the answer is UNKNOWN:
 *
 *   1. the seal layer itself resolved SEAL_VERIFIED — a real, internally valid,
 *      identity-bound seal for THIS gate (SEAL_INVALID, SEAL_ABSENT,
 *      POINTER_HASH_MISMATCH and IDENTITY_BINDING_VIOLATION all fail here);
 *   2. the EXACT OPEN_DEFECTS path is present in that seal's sealedMembers —
 *      membership is matched on the full repo-relative path, never a suffix;
 *   3. the sealed member's sha256 reproduces the LIVE bytes;
 *   4. the sealed member's byteLength reproduces the LIVE byte length.
 *
 * Hash and length are checked against bytes read ONCE, so the document that is
 * hashed is the same document that is parsed — no re-read window in between.
 *
 * There is no direct-trust label and no per-gate exception: a gate with no seal
 * is UNKNOWN, which is exactly what "we do not know" should mean. This can only
 * ever move an answer from KNOWN* to UNKNOWN, never the reverse.
 */
function loadOpenDefectsState(repoRoot, gateId, exec) {
  const unknown = (reason) => ({ defectsOpenCount: null, defectsOpenKnowledge: 'UNKNOWN', defectsValidationReason: reason });
  const stateRevision = exec?.stateRevision;
  if (!stateRevision) return unknown('NO_STATE_REVISION');

  // (1) Only a verified seal may carry defects provenance.
  if (exec?.statusKnowledge !== 'SEAL_VERIFIED') return unknown(`DEFECTS_PROVENANCE_UNVERIFIED:${exec?.statusKnowledge || 'ABSENT'}`);

  const defectsRelativePath = `governance/gates/${gateId}/state/revisions/${stateRevision}/OPEN_DEFECTS.json`;
  const defectsPath = path.join(repoRoot, 'governance', 'gates', gateId, 'state', 'revisions', stateRevision, 'OPEN_DEFECTS.json');
  if (!existsFile(defectsPath)) return unknown('OPEN_DEFECTS_ABSENT');

  // (2) Exact sealed-member match — full path, never a suffix or prefix test.
  const members = Array.isArray(exec?.seal?.sealedMembers) ? exec.seal.sealedMembers : [];
  const member = members.find((m) => m?.repoRelativePath === defectsRelativePath);
  if (!member) return unknown('OPEN_DEFECTS_NOT_A_SEALED_MEMBER');

  let bytes;
  try {
    bytes = fs.readFileSync(defectsPath);
  } catch {
    return unknown('OPEN_DEFECTS_UNREADABLE');
  }
  // (3)+(4) The sealed member must pin the very bytes about to be interpreted.
  if (member.sha256 !== sha256Bytes(bytes)) return unknown('OPEN_DEFECTS_SEALED_HASH_MISMATCH');
  if (member.byteLength !== bytes.length) return unknown('OPEN_DEFECTS_SEALED_BYTE_LENGTH_MISMATCH');

  const resolved = resolveOpenDefectsKnowledgeFromJsonText(bytes.toString('utf8'));
  return {
    defectsOpenCount: resolved.defectsOpenCount,
    defectsOpenKnowledge: resolved.defectsOpenKnowledge,
    defectsValidationReason: resolved.reason
  };
}

/**
 * Real, checked determination of activation: does any sealed member for this
 * gate's current revision reference an activation record? No gate in this
 * repository has ever gone through the activation-anchor flow, so this
 * legitimately (not by silent default) resolves to false today for every
 * gate — an affirmative NOT_APPLICABLE, evidenced by absence of a real
 * activation record, not a caller-omitted parameter (RC-4/CT-E).
 *
 * FC-03: when a sealed activation member IS found, this now constructs the
 * REAL activation anchor from the member's on-disk bytes (record + content-
 * addressed activationId + a STATE_SEAL_MEMBER authority pointer back at this
 * exact seal), instead of always returning anchor:null. It does not itself
 * re-implement anchor validation: contracts/validate-activation-anchor.mjs
 * (invoked downstream by readiness/build-readiness-context.mjs) already
 * re-validates the seal, re-checks the sealedMembers hash against live bytes.
 *
 * R1_FINAL_ACTIVATION_LEDGER_BINDING_FIX: view.authorityState.consistent alone is NOT
 * sufficient — it only proves the ledger agrees with the work unit's generic status STRING,
 * never WHICH activation-authority bytes earned that status. A coordinated local reseal
 * (contract + seal + activation-authority record recomputed together, then STATE_SEAL/
 * CURRENT_STATE resealed to match) reproduces the same status string and stays locally
 * INTACT + "consistent" while pinning nothing to the ledger. `ledgerBinding` below closes that
 * gap: it asks the generic, project-agnostic core/authority-event-log.mjs helper whether a
 * canonical ACTIVATION_LEDGER_TRANSITION_TYPE event for THIS exact workUnitId pins THIS exact
 * activation-authority file's live bytes. Only when that also reads PROVEN can
 * readiness/build-readiness-context.mjs's deriveActivationProof read ACTIVATION_ANCHOR=PROVEN.
 */
function deriveActivation(repoRoot, exec, { ledgerReport, workUnitId } = {}) {
  const members = Array.isArray(exec.seal?.sealedMembers) ? exec.seal.sealedMembers : [];
  const activationMember = members.find((m) => typeof m?.repoRelativePath === 'string' && m.repoRelativePath.toUpperCase().includes('ACTIVATION'));
  if (!activationMember) {
    return { activated: false, anchor: null, source: 'NO_ACTIVATION_RECORD_FOUND_IN_SEALED_MEMBERS', ledgerBinding: null };
  }
  const source = `sealed-member:${activationMember.repoRelativePath}`;
  const memberAbsPath = path.join(repoRoot, activationMember.repoRelativePath);
  if (!existsFile(memberAbsPath)) {
    return { activated: true, anchor: null, source, ledgerBinding: { state: 'UNKNOWN', reason: 'ACTIVATION_RECORD_FILE_ABSENT', eventOrdinal: null, eventId: null } };
  }
  const bytes = fs.readFileSync(memberAbsPath);
  const liveAuthoritySha256 = sha256Bytes(bytes);
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { activated: true, anchor: null, source, ledgerBinding: { state: 'UNKNOWN', reason: 'ACTIVATION_RECORD_JSON_INVALID', eventOrdinal: null, eventId: null } };
  }
  const anchor = {
    record,
    activationId: activationIdOf(record),
    authority: {
      kind: 'STATE_SEAL_MEMBER',
      repoRoot,
      sealPath: path.relative(repoRoot, exec.sealPath).split(path.sep).join('/'),
      memberRepoRelativePath: activationMember.repoRelativePath
    }
  };
  const ledgerBinding = deriveActivationLedgerBinding({
    ledgerReport,
    workUnitId,
    transitionType: ACTIVATION_LEDGER_TRANSITION_TYPE,
    authorityPath: activationMember.repoRelativePath,
    authoritySha256: liveAuthoritySha256
  });
  return { activated: true, anchor, source, ledgerBinding };
}

/**
 * Wheel project adapter.
 * Interprets canonical Wheel governance sources; does not duplicate authority.
 */
export function createWheelProjectAdapter(repoRoot) {
  const root = path.resolve(repoRoot);
  const { registryPath, registry } = loadRegistry(root);
  const gates = Array.isArray(registry.gates) ? registry.gates : [];

  return {
    projectId: 'WHEEL',
    workUnitType: 'GATE',
    adapterSchema: {
      schemaVersion: 1,
      projectId: 'WHEEL',
      workUnitType: 'GATE',
      capabilities: {
        listWorkUnitIds: true,
        getWorkUnitView: true,
        resolvePrerequisite: true,
        loadStrategicContract: true,
        loadExecutionContract: true
      },
      notes: 'Interprets GATE_REGISTRY, gate contracts, state, seals, defects, active pointer, and the GATE_STATUS_LEDGER authority spine. No second authority copy.'
    },

    listWorkUnitIds() {
      return gates.map((g) => g.gateId);
    },

    getWorkUnitView(workUnitId) {
      const entry = gates.find((g) => g.gateId === workUnitId);
      if (!entry) {
        throw new Error(`UNKNOWN_WORK_UNIT:${workUnitId}`);
      }

      const ledgerContext = loadLedgerContext(root);
      const authoritativeState = computeGateAuthoritativeState(workUnitId, ledgerContext, root);
      const exec = loadSealLayer(root, workUnitId);
      const revisionCheck = checkCanonicalRevisionStructural(root, workUnitId);

      const interpreted = [path.relative(root, registryPath).split(path.sep).join('/'), ledgerContext.ledgerPath];
      interpreted.push(...exec.sources);

      const snap = loadSnapshotStatus(root, workUnitId);
      if (snap.authority) interpreted.push(path.relative(root, snap.authority).split(path.sep).join('/'));

      // RC-2/RC-6: `status` is sourced from the ledger, never from the seal payload or the
      // non-canonical generated snapshot. `authorityState.consistent` (used by
      // resolvePrerequisite/readiness) additionally requires a sufficient ledger trust level
      // AND, when a sealed revision exists, agreement between the seal and the ledger — if they
      // disagree, the ledger's value is still shown, but consistency is false either way.
      let status;
      let statusAuthority;
      let authorityConsistent = false;
      let authorityReason;
      if (authoritativeState.verified) {
        status = authoritativeState.value;
        statusAuthority = `gate-status-ledger:${workUnitId}`;
        const requireResult = requireVerifiedState(authoritativeState, { allow: [authoritativeState.value], minTrustLevel: minTrustLevelFor('SATISFY_PREREQUISITE') });
        if (exec.statusKnowledge === 'SEAL_VERIFIED') {
          const sealAgrees = exec.status === authoritativeState.value;
          authorityConsistent = requireResult.satisfied && sealAgrees;
          authorityReason = authorityConsistent ? undefined : (sealAgrees ? requireResult.reason : 'SEAL_AND_LEDGER_DISAGREE_LEDGER_WINS');
        } else if (exec.statusKnowledge === 'ABSENT') {
          authorityConsistent = requireResult.satisfied;
          authorityReason = requireResult.satisfied ? undefined : requireResult.reason;
        } else {
          // SEAL_INVALID / SEAL_ABSENT / IDENTITY_BINDING_VIOLATION / POINTER_HASH_MISMATCH:
          // the seal layer itself reported a problem — never consistent, regardless of the
          // ledger's own trust level.
          authorityConsistent = false;
          authorityReason = exec.statusKnowledge;
        }
        // FINAL-04: the canonical validate-state-revision.mjs structural/identity findings (never
        // its disclosed, expected PROTECTED_HASH_MISMATCH drift alone) must also hold.
        if (authorityConsistent && !revisionCheck.structurallyValid) {
          authorityConsistent = false;
          authorityReason = 'CANONICAL_REVISION_STRUCTURAL_VIOLATION';
        }
      } else {
        status = 'UNKNOWN';
        statusAuthority = 'ledger-unverified';
        authorityConsistent = false;
        authorityReason = 'LEDGER_NOT_VERIFIED';
      }

      const legacy = loadLegacyGateContract(root, workUnitId);
      if (legacy.present) {
        interpreted.push(legacy.contractPath);
        interpreted.push(path.relative(root, legacy.pointerPath).split(path.sep).join('/'));
      }

      const mapped = legacy.present
        ? mapLegacyGateContractToExecutionView(legacy.contract, {
            objective: entry.canonicalObjective,
            sourcePath: legacy.contractPath,
            sourceSha256: legacy.contractSha256,
            prerequisites: Array.isArray(entry.dependencies)
              ? entry.dependencies.map((d, i) => ({
                  id: typeof d === 'string' ? d : `DEP-${i}`,
                  statement: typeof d === 'string' ? d : JSON.stringify(d),
                  critical: true
                }))
              : []
          })
        : null;

      // TJ-02: the canonical execution seal for a legacy Wheel gate contract is
      // sealExecutionContract's deterministic seal over the SAME mapped contract exposed as
      // view.contract — a pure function of the contract's own canonical bytes, not a second,
      // independently-tracked authority. It is null (seal unavailable) whenever the contract
      // itself does not validate, never fabricated. Surfaced here so build-readiness-context.mjs
      // can read a real seal instead of hardcoding null.
      //
      // sealedAt is pinned to a fixed constant (EXECUTION_SEAL_DERIVATION_EPOCH) rather than
      // wall-clock time: this is a read-time DERIVATION of what the contract's seal looks like,
      // not a new real sealing event, and it must reproduce byte-identically on every call so an
      // activation record's expectedSealSha256 (pinned once, at real activation time) keeps
      // validating for as long as the contract itself is unchanged — the contract's own canonical
      // bytes (already content-addressed into payload.contractSha256) are what actually make the
      // seal change when the contract changes.
      const executionSeal = mapped?.contract
        ? sealExecutionContract(mapped.contract, { sealedAt: EXECUTION_SEAL_DERIVATION_EPOCH }).seal
        : null;

      const activePath = path.join(root, 'governance', 'active', 'ACTIVE_GATE.json');
      let activeGate = null;
      if (existsFile(activePath)) {
        activeGate = readJson(activePath).activeGate;
        interpreted.push('governance/active/ACTIVE_GATE.json');
      }

      return {
        schemaVersion: 1,
        projectId: 'WHEEL',
        workUnitId,
        workUnitType: 'GATE',
        status,
        statusAuthority,
        state: authoritativeState,
        authorityState: {
          consistent: authorityConsistent,
          source: statusAuthority,
          reason: authorityReason === undefined ? null : authorityReason,
          sealValid: Boolean(exec.sealValid),
          statusKnowledge: exec.statusKnowledge || null,
          trustLevel: authoritativeState.trustLevel,
          canonicalRevisionStructurallyValid: revisionCheck.structurallyValid,
          canonicalRevisionDriftFindingCount: revisionCheck.driftFindings.length
        },
        activation: deriveActivation(root, exec, { ledgerReport: ledgerContext.report, workUnitId }),
        objective: entry.canonicalObjective,
        stateRevision: exec.stateRevision || null,
        contract: mapped?.contract || null,
        execution: { contract: mapped?.contract || null, seal: executionSeal },
        provenance: mapped?.provenance || null,
        prerequisites: mapped?.contract?.prerequisites || [],
        dependencies: Array.isArray(entry.dependencies) ? entry.dependencies : [],
        evidence: exec.sealPath && existsFile(exec.sealPath)
          ? [{ kind: 'STATE_SEAL', path: path.relative(root, exec.sealPath).split(path.sep).join('/'), sha256: exec.sealSha256, verified: Boolean(exec.sealValid) }]
          : [],
        // FINAL-06: closure is derived from AUTHORITATIVE_STATE only — never from the raw
        // STATE_SEAL payload. A STATE_SEAL may still surface informative metadata (nextAction)
        // but it can no longer independently assert the normative gateCompleteConfirmed boolean.
        // gateCompleteConfirmed additionally requires MODERN_FINAL_CLOSURE trust (ANCHORED_EXTERNAL);
        // at ANCHORED_APPEND_ONLY the ledger value may already read COMPLETE_CONFIRMED, but that is
        // not yet a modern final-authoritative closure.
        closure: authoritativeState.verified
          ? {
              executionStatus: status,
              gateCompleteConfirmed: Boolean(
                authorityConsistent
                && authoritativeState.identityBinding === 'BOUND'
                && authoritativeState.value === 'COMPLETE_CONFIRMED'
                && isTrustSufficientFor('MODERN_FINAL_CLOSURE', authoritativeState.trustLevel)
              ),
              finalClosureTrustLevel: authoritativeState.trustLevel,
              nextAction: exec.sealValid && exec.sealPayload ? (exec.sealPayload.nextAction || null) : null
            }
          : null,
        // M2: the whole seal layer is passed, not just the revision id — defects knowledge now
        // requires verified sealed provenance, which only `exec` can prove.
        ...loadOpenDefectsState(root, workUnitId, exec),
        sources: {
          interpreted,
          copiedAuthority: false
        },
        compatibility: {
          registryDefinitionCompleteness: entry.definitionCompleteness || null,
          legacyContractPresent: legacy.present,
          activeGate,
          ledgerOrSnapshotStatus: snap.status,
          sealedExecutionStatus: exec.sealValid ? exec.status : null
        }
      };
    },

    resolvePrerequisite(workUnitId, prerequisite) {
      const id = typeof prerequisite === 'string' ? prerequisite : prerequisite?.id;
      if (!id) return { id: null, status: 'UNKNOWN' };

      // Registry-driven: recognize any work unit present in the loaded registry.
      // No numeric GATE00->GATE40 bound — future gates (GATE41+) work when registered.
      const registered = gates.some((g) => g.gateId === id);
      if (registered) {
        const view = this.getWorkUnitView(id);
        const requireResult = requireVerifiedState(view.state, { allow: ['COMPLETE_CONFIRMED', 'SUPERSEDED'], minTrustLevel: minTrustLevelFor('SATISFY_PREREQUISITE') });
        return { id, status: requireResult.satisfied ? 'SATISFIED' : 'UNSATISFIED', observedStatus: view.status, reason: requireResult.reason };
      }

      // Not in registry: unknown work unit / textual prerequisite — not auto-satisfied.
      return { id, status: 'UNKNOWN', reason: 'WORK_UNIT_NOT_IN_REGISTRY' };
    },

    loadStrategicContract(workUnitId) {
      const entry = gates.find((g) => g.gateId === workUnitId);
      if (!entry) return null;
      const hasStrategicPurpose = typeof entry.strategicPurpose === 'string' && entry.strategicPurpose.length > 0;
      return {
        schemaVersion: 1,
        contractKind: 'STRATEGIC',
        id: workUnitId,
        type: 'GATE',
        version: 'R0000',
        objective: entry.canonicalObjective || '',
        ...(hasStrategicPurpose ? { strategicPurpose: entry.strategicPurpose } : {}),
        prerequisites: [],
        invariants: ['NO_GATE_MANDATE_REDEFINITION', 'AUTHORIZED_PATHS_ONLY'],
        authorizedVerdicts: ['AUTHORIZED_NOT_STARTED', 'COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'NOT_STARTED', 'SUPERSEDED'],
        notes: 'Derived view from GATE_REGISTRY; registry remains canonical.'
      };
    },

    loadExecutionContract(workUnitId) {
      const view = this.getWorkUnitView(workUnitId);
      return view.contract;
    }
  };
}
