/**
 * Wheel adapter — PRECONTRACT authority source.
 *
 * Repository I/O for the pure core primitive. Two authority modes are served by
 * one code path; the mode is read from the authority document itself, never
 * chosen by the caller:
 *
 *   LEGACY_SIGNED_AUTHORITY  — exactly one request document and exactly one
 *                              owner-signed authority document.
 *   LOCAL_EXPLICIT_AUTHORITY — exactly one self-contained authority document and
 *                              NO request. A request presented alongside a local
 *                              authority is a configuration error, not an extra.
 *
 * The observation set is what replaces the signature in local mode, so it is
 * gathered here exhaustively: HEAD commit, HEAD tree, ledger bytes AND event
 * count, live Gate status, contract presence, the predecessor's resolved
 * dependency proof, the single-use receipt, and the live bytes of every bound
 * artifact.
 *
 * WHAT THE OBSERVATION SET LOOKS AT DEPENDS ON THE PHASE. Before the write, the
 * question is about the present, and the live head answers it. Afterwards, the
 * question is about a moment that has passed, so this adapter additionally
 * supplies the RAW MATERIAL for the core's historical proof — the whole ledger
 * text, the recorded commit's git facts, and the declared CURRENT_CONTRACT link.
 * It supplies material, never a verdict: the core rebuilds and re-digests the
 * ledger prefix itself, so no conclusion reached here can be taken on trust.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  evaluatePrecontractAuthority,
  isLocalPrecontractAuthority,
  reconstructLedgerPrefix,
  PRECONTRACT_OPERATION,
  PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE
} from '../../core/precontract-authority.mjs';
import { loadOwnerReleaseKey, loadReleaseAuthorization } from '../../core/release-authorization-source.mjs';
import { isWithinGovernedRoots } from '../../core/witness-source.mjs';
import { validateAgainstJsonSchema } from '../../contracts/validate-against-json-schema.mjs';
import { resolveGateDependencyProofFromEvents } from './gate-dependency-resolution.mjs';

export const PRECONTRACT_WORK_UNIT_TYPE = 'PRECONTRACT';
export const PRECONTRACT_AUTHORITY_ENV_VAR = 'WHEEL_PRECONTRACT_AUTHORITY_SOURCE';
export const PRECONTRACT_REQUEST_ENV_VAR = 'WHEEL_PRECONTRACT_REQUEST_SOURCE';
export const OWNER_PRECONTRACT_KEY_ENV_VAR = 'WHEEL_OWNER_PRECONTRACT_PUBLIC_KEY';

/** The finite bootstrap cohort, derived from the Gate id. No wildcards, ever. */
export function precontractBootstrapPaths(gateId) {
  return Object.freeze([
    'governance/GATE_REGISTRY_00_40.json',
    `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_R0001.json`,
    `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`,
    precontractConsumptionRecordPath(gateId)
  ]);
}

export function precontractConsumptionRecordPath(gateId) {
  return `governance/gates/${gateId}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
function sourcePaths(explicit, env, variable) {
  const value = explicit || env?.[variable] || null;
  return value ? (Array.isArray(value) ? value : [value]) : [];
}
function gitRevision(repoRoot, revision) {
  const result = spawnSync('git', ['rev-parse', revision], { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Facts about a commit the authority recorded in the past, for the historical
 * pre-state proof. Equality with the live HEAD is deliberately NOT one of them:
 * committing after a bootstrap is lawful. What must hold is that the commit is
 * real, names the recorded tree, and is still part of this history.
 *
 * Fail-closed: an unparsable id, a missing object or an unavailable git all
 * report `present: false`, which the core turns into a blocking finding.
 */
function gitCommitFacts(repoRoot, commit) {
  const absent = { present: false, tree: null, reachableFromHead: false };
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) return absent;
  const type = spawnSync('git', ['cat-file', '-t', commit], { cwd: repoRoot, encoding: 'utf8' });
  if (type.status !== 0 || type.stdout.trim() !== 'commit') return absent;
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return { present: true, tree: gitRevision(repoRoot, `${commit}^{tree}`), reachableFromHead: ancestor.status === 0 };
}

/** The link CURRENT_CONTRACT declares, read as data; the core decides on it. */
function currentContractLink(currentContractPath, overlayBytes) {
  try {
    const document = overlayBytes ? JSON.parse(overlayBytes.toString('utf8')) : readJson(currentContractPath);
    return { gateId: document.gateId, contractPath: document.contractPath, contractSha256: document.contractSha256 };
  } catch { return null; }
}
function ledgerEvents(repoRoot) {
  const file = path.join(repoRoot, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function loadExternal(filePath, root) {
  const loaded = loadReleaseAuthorization(filePath, { governedRoots: [root] });
  if (loaded.finding) return { value: null, finding: loaded.finding };
  try { return { value: readJson(filePath), finding: null }; } catch { return { value: null, finding: 'AUTHORITY_OR_REQUEST_MALFORMED' }; }
}

/**
 * LOCATION IS MODE-DEPENDENT, AND DELIBERATELY SO.
 *
 * A LEGACY_SIGNED_AUTHORITY must live OUTSIDE the governed set: its real
 * defence is the owner's private key, and refusing an in-repo copy is the
 * defence in depth that stops an agent honouring a document it just wrote
 * (release-authorization-source.mjs states this rule).
 *
 * A LOCAL_EXPLICIT_AUTHORITY has the opposite requirement. There is no key; its
 * defence is exhaustive binding to a pre-state that the repository itself
 * proves, and that only works if the document is a GOVERNED artifact — versioned,
 * hashable, part of the cohort, visible to final integrity audit. An unsigned
 * authority read from outside the repository would be an unversioned, unaudited
 * file claiming authority, which is strictly worse than the in-repo case.
 *
 * So the document is located first and the rule applied after the mode is known;
 * neither mode can borrow the other's location.
 */
function loadGoverned(filePath, root) {
  if (typeof filePath !== 'string' || !filePath) return { value: null, finding: 'AUTHORITY_ABSENT', governed: false };
  let real;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { value: null, finding: 'AUTHORITY_ABSENT', governed: false };
    real = fs.realpathSync(filePath);
  } catch { return { value: null, finding: 'AUTHORITY_ABSENT', governed: false }; }
  const governed = isWithinGovernedRoots(real, [root]);
  if (!governed) return { value: null, finding: null, governed: false };
  try { return { value: readJson(real), finding: null, governed: true }; } catch { return { value: null, finding: 'AUTHORITY_OR_REQUEST_MALFORMED', governed: true }; }
}
/**
 * The bytes of the authority each anchor event cites, keyed by that event's OWN
 * `authorityPath`. Raw material only: the digest is taken from the bytes actually
 * read, and the core decides whether it matches what the event pinned.
 *
 * The citation is followed only when it stays inside the governed tree — an
 * escaping or absolute path is observed as ABSENT rather than resolved, so a
 * forged citation cannot reach a document the audit never sees. Every anchor of
 * the Gate is resolved, not just the first: choosing one here would hand the
 * selection to the adapter, and the core refuses ambiguity itself.
 */
function anchorAuthorityObservations(root, events, gateId) {
  const observations = {};
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.gateId !== gateId || event?.transitionType !== PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITION_TYPE) continue;
    const cited = event.authorityPath;
    if (typeof cited !== 'string' || !cited || cited.split('/').includes('..') || path.isAbsolute(cited)) continue;
    const absent = { present: false, sha256: null, record: null };
    try {
      const real = fs.realpathSync(path.join(root, ...cited.split('/')));
      if (!isWithinGovernedRoots(real, [root]) || !fs.statSync(real).isFile()) { observations[cited] = absent; continue; }
      const bytes = fs.readFileSync(real);
      let record = null;
      try { record = JSON.parse(bytes.toString('utf8')); } catch { record = null; }
      observations[cited] = { present: true, sha256: sha256(bytes), record };
    } catch { observations[cited] = absent; }
  }
  return observations;
}

function targetHashes(root, bindings, overlay) {
  const values = {};
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (overlay && Object.prototype.hasOwnProperty.call(overlay, binding.path)) {
      values[binding.path] = sha256(overlay[binding.path]);
      continue;
    }
    const target = path.join(root, ...String(binding.path).split('/'));
    try {
      const real = fs.realpathSync(target);
      values[binding.path] = isWithinGovernedRoots(real, [root]) ? sha256(fs.readFileSync(real)) : '__SYMLINK_ESCAPE__';
    } catch { values[binding.path] = null; }
  }
  return values;
}

/**
 * @param {object|null} options.candidateOverlay  Relative path -> candidate
 *   bytes. When present, those paths are observed from the candidate instead of
 *   from disk, which is what lets a bootstrap prove its consumption BEFORE
 *   publishing anything. It is an observation substitution and nothing more: the
 *   decision still runs through the same primitive, on the same code path, so a
 *   pre-publication proof and a post-publication proof cannot diverge.
 */
export function createWheelPrecontractAuthoritySource(repoRoot, { authorityPath = null, requestPath = null, authorityPaths = null, requestPaths = null, ownerKeyPath = null, env = process.env, operation = PRECONTRACT_OPERATION, now = new Date(), candidateOverlay = null } = {}) {
  const root = path.resolve(repoRoot);
  const authorities = sourcePaths(authorityPaths || authorityPath, env, PRECONTRACT_AUTHORITY_ENV_VAR);
  const requests = sourcePaths(requestPaths || requestPath, env, PRECONTRACT_REQUEST_ENV_VAR);
  const keyPath = ownerKeyPath || env?.[OWNER_PRECONTRACT_KEY_ENV_VAR] || path.join(root, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json');

  function evaluate(workUnitId, phase) {
    const findings = [];
    if (authorities.length > 1 || requests.length > 1) {
      return { decision: 'BLOCKED', bootstrapAuthorized: false, executionAuthorized: false, authorizedPaths: [], findings: [{ code: 'PRECONTRACT_AUTHORITY_CONFLICT' }] };
    }
    if (!workUnitId || authorities.length !== 1) {
      return { decision: 'BLOCKED', bootstrapAuthorized: false, executionAuthorized: false, authorizedPaths: [], findings: [{ code: 'PRECONTRACT_SOURCE_UNCONFIGURED' }] };
    }
    const governedAuthority = loadGoverned(authorities[0], root);
    const externalAuthority = governedAuthority.governed ? null : loadExternal(authorities[0], root);
    const authority = governedAuthority.governed ? governedAuthority.value : externalAuthority.value;
    const local = isLocalPrecontractAuthority(authority);
    if (local && !governedAuthority.governed) findings.push({ code: 'LOCAL_AUTHORITY_MUST_BE_GOVERNED', detail: authorities[0] });
    if (!local && governedAuthority.governed) findings.push({ code: 'AUTHORIZATION_INSIDE_GOVERNED_SET' });
    const loadFinding = governedAuthority.governed ? governedAuthority.finding : externalAuthority.finding;
    if (loadFinding) findings.push({ code: loadFinding });

    // A local authority is self-contained by construction. Accepting a request
    // beside it would create a second, unbound description of the same write.
    if (local && requests.length !== 0) findings.push({ code: 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED' });
    if (!local && requests.length !== 1) findings.push({ code: 'PRECONTRACT_SOURCE_UNCONFIGURED' });

    const loadedRequest = !local && requests.length === 1 ? loadExternal(requests[0], root) : { value: null, finding: null };
    if (loadedRequest.finding) findings.push({ code: loadedRequest.finding });
    const request = loadedRequest.value;

    try {
      const authoritySchema = readJson(path.join(root, local
        ? 'governance/schemas/precontract-local-authority.schema.json'
        : 'governance/schemas/precontract-authority.schema.json'));
      if (!validateAgainstJsonSchema(authority, authoritySchema).valid) findings.push({ code: 'AUTHORITY_SCHEMA_INVALID' });
      if (!local) {
        const requestSchema = readJson(path.join(root, 'governance/schemas/precontract-authority-request.schema.json'));
        if (!validateAgainstJsonSchema(request, requestSchema).valid) findings.push({ code: 'REQUEST_SCHEMA_INVALID' });
      }
    } catch {
      findings.push({ code: 'PRECONTRACT_SCHEMA_UNAVAILABLE' });
    }

    const bootstrapPaths = new Set(precontractBootstrapPaths(workUnitId));
    const declaredPaths = (local ? authority?.authorizedPaths : request?.authorizedPaths) || [];
    for (const authorizedPath of declaredPaths) {
      if (!bootstrapPaths.has(authorizedPath)) findings.push({ code: 'PRECONTRACT_PATH_OUTSIDE_BOOTSTRAP_SCOPE', detail: authorizedPath });
    }

    const ledgerPath = path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson');
    const ledgerBytes = fs.readFileSync(ledgerPath);
    const ledgerText = ledgerBytes.toString('utf8');
    const events = ledgerEvents(root);
    const event = events.filter((item) => item.gateId === workUnitId).at(-1) || null;
    const dependency = local ? authority?.dependencyProof : request?.dependencyProof;

    /**
     * REPLAY SCOPE FOLLOWS THE PHASE.
     *
     * Before the write the question is present-tense: is the predecessor closed
     * NOW? After the write it is historical: was it closed at the moment this
     * authority was consumed? Resolving the historical question against the live
     * ledger would let a later event on the dependency Gate retroactively
     * invalidate a lawful bootstrap — the same defect the pre-state proof fixes,
     * one field over.
     *
     * The prefix is rebuilt with the CORE's reconstruction so there is exactly
     * one implementation of it; the core independently rebuilds and re-digests it
     * when it decides, so nothing here is trusted as a verdict.
     */
    const historicalPhase = local && phase === 'VERIFY_CONSUMPTION';
    const historicalPrefix = historicalPhase ? reconstructLedgerPrefix(ledgerText, authority?.preState?.ledgerEventCount) : null;
    const dependencyEvents = historicalPhase ? (historicalPrefix.valid ? historicalPrefix.events : null) : events;
    const dependencyResolution = dependency?.gateId && dependencyEvents
      ? resolveGateDependencyProofFromEvents({ root, gateId: dependency.gateId, events: dependencyEvents })
      : null;
    const currentContractRelativePath = `governance/gates/${workUnitId}/contracts/CURRENT_CONTRACT.json`;
    const currentContractPath = path.join(root, ...currentContractRelativePath.split('/'));
    const overlayCurrentContract = candidateOverlay?.[currentContractRelativePath] ?? null;
    const consumptionRelativePath = local ? authority?.consumptionRecordPath : null;
    const consumptionAbsolute = consumptionRelativePath && !consumptionRelativePath.includes('..')
      ? path.join(root, ...consumptionRelativePath.split('/'))
      : null;
    const overlayConsumption = candidateOverlay && consumptionRelativePath
      ? candidateOverlay[consumptionRelativePath] ?? null : null;
    const consumptionRecordPresent = Boolean(overlayConsumption)
      || Boolean(consumptionAbsolute && fs.existsSync(consumptionAbsolute));
    let consumptionRecord = null;
    // The receipt's own byte digest, so the core can compare it against what the
    // ledger anchored. Taken from the bytes, never from anything the receipt says
    // about itself.
    let consumptionRecordSha256 = null;
    if (overlayConsumption) {
      consumptionRecordSha256 = sha256(overlayConsumption);
      try { consumptionRecord = JSON.parse(overlayConsumption.toString('utf8')); } catch { findings.push({ code: 'CONSUMPTION_RECORD_MALFORMED' }); }
    } else if (consumptionRecordPresent) {
      try {
        consumptionRecordSha256 = sha256(fs.readFileSync(consumptionAbsolute));
        consumptionRecord = readJson(consumptionAbsolute);
      } catch { findings.push({ code: 'CONSUMPTION_RECORD_MALFORMED' }); }
    }
    const ownerKey = local ? null : loadOwnerReleaseKey(keyPath).ownerKey;
    const bindings = (local ? authority?.artifactBindings : request?.artifactBindings) || [];
    const observed = {
      projectId: 'WHEEL', gateId: workUnitId,
      headCommit: gitRevision(root, 'HEAD'), headTree: gitRevision(root, 'HEAD^{tree}'),
      ledgerSha256: sha256(ledgerBytes), ledgerEventCount: events.length,
      currentStatus: event?.toStatus || null,
      currentContractPresent: Boolean(overlayCurrentContract) || fs.existsSync(currentContractPath),
      consumed: fs.existsSync(currentContractPath),
      consumptionRecordPresent,
      consumptionRecordSha256,
      dependencyProof: dependencyResolution?.proof || null,
      targetFileSha256: targetHashes(root, bindings, candidateOverlay),
      // Raw material for the historical pre-state proof. The ledger text is
      // passed whole so the core rebuilds and re-digests the prefix itself; the
      // parsed events serve the consumption-time bracket.
      ledgerText,
      ledgerEvents: events,
      anchorAuthorities: anchorAuthorityObservations(root, events, workUnitId),
      historicalCommit: historicalPhase ? gitCommitFacts(root, authority?.preState?.baseCommit) : null,
      currentContractRelativePath,
      currentContractLink: historicalPhase ? currentContractLink(currentContractPath, overlayCurrentContract) : null
    };
    const result = evaluatePrecontractAuthority({
      request: local ? null : request, authority, ownerKey, observed, operation, now, phase, consumptionRecord
    });
    findings.push(...result.findings);
    const clean = findings.length === 0;
    const authorized = clean && result.bootstrapAuthorized;
    const consumed = clean && result.consumed;
    return {
      decision: clean ? result.decision : 'BLOCKED',
      authorityMode: result.authorityMode,
      bootstrapAuthorized: authorized,
      consumed,
      executionAuthorized: false,
      authorizedPaths: clean ? result.authorizedPaths : [], findings,
      proofs: {
        EXECUTION_CONTRACT: { state: 'NOT_APPLICABLE', reason: 'precontract phase precedes CURRENT_CONTRACT' },
        CONTRACT_INTEGRITY: { state: 'NOT_APPLICABLE', reason: 'normal contract validation follows bootstrap' },
        PREREQUISITES: {
          state: dependencyResolution?.satisfied && dependencyResolution.status === dependency?.status ? 'PROVEN' : 'FAILED',
          reason: dependencyResolution?.reason || 'predecessor terminal proof'
        },
        WORK_UNIT_EXECUTABLE: { state: 'FAILED', reason: 'PRECONTRACT is non-execution authority' }
      }, workUnitId, workUnitType: PRECONTRACT_WORK_UNIT_TYPE, authoritySource: 'wheel-precontract-authority-source'
    };
  }

  function resolvePrecontractAuthority(workUnitId) { return evaluate(workUnitId, 'AUTHORIZE_WRITE'); }
  function verifyPrecontractConsumption(workUnitId) { return evaluate(workUnitId, 'VERIFY_CONSUMPTION'); }

  return {
    projectId: 'WHEEL', workUnitType: PRECONTRACT_WORK_UNIT_TYPE, sourceId: 'wheel-precontract-authority-source',
    resolvePrecontractAuthority, verifyPrecontractConsumption, resolveWorkUnitAuthority: resolvePrecontractAuthority
  };
}
