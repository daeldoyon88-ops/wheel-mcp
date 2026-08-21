/**
 * CANONICAL_AUTHORIZED_COHORT — the exact set of paths a Gate was allowed to
 * touch, derived from authority documents and nothing else.
 *
 * WHAT THIS EXISTS TO CLOSE. FINAL_GATE_INTEGRITY used to accept its cohort as a
 * `--cohort` argument. A caller could therefore hand it the observed Git delta,
 * and "delta minus cohort is empty" became a tautology that could not fail. A
 * PASS proved only that someone had typed the right list.
 *
 * THE CHAIN, AND WHY EACH LINK IS REQUIRED.
 *
 *   authority document  — names a manifest and pins its digest
 *   authorized manifest — names exact paths, no wildcards, no directories
 *   consumption record  — proves the program actually ran under that authority
 *   derived cohort      — the union of what those documents authorized
 *
 * A post-freeze program contributes paths only when all three links hold. An
 * authority whose manifest digest has drifted contributes nothing; so does one
 * that was never consumed, because an unconsumed authority describes work that
 * did not happen. Both cases are reported as REFUSED sources rather than being
 * silently dropped, so a caller can see WHY a path is absent from the cohort.
 *
 * WHAT NEVER CONTRIBUTES. Git. Not `git status`, not the diff, not the index.
 * The derivation cannot read the thing it exists to judge, so there is no
 * fallback and no union with the observed delta — an empty or partial cohort
 * fails the audit rather than being topped up from what happens to be on disk.
 *
 * THE THIRD PATH CLASS (R2). A lifecycle phase writes three kinds of path, not
 * one: the PAYLOAD paths its record names, the RECORD itself, and the OWNER
 * AUTHORITY document that approved that record. R1 harvested only the payload,
 * so the other two reached the cohort solely by accident of payload shape.
 * GATE_START_RECORD does list its own pair, because gateStartWriteCohortPaths()
 * happens to build authorizedStartWritePaths that way. The other two phases
 * CANNOT list theirs, and the refusal is their own primitive's:
 *
 *   - GATE_AUTHORIZATION_RECORD's cohort is a closed role-keyed set checked
 *     against gateAuthorization{State,Derived}CohortPaths(); naming any other
 *     path raises GATE_AUTHORIZATION_PATH_OUTSIDE_AUTHORIZED_COHORT.
 *   - the precontract authority's authorizedPaths are frozen inside
 *     approvedRequestDigest, so adding an entry invalidates the document.
 *
 * Both phases would therefore be refused for naming the very files the phase
 * exists to write. The pair is DERIVED here instead, from the same canonical
 * path helpers the lifecycle primitives use to LOCATE those documents — never
 * from Git, and never from a per-Gate exception. Deriving it is what makes the
 * rule general: every Gate gets it, and no Gate needs to be special-cased.
 *
 * VALIDITY IS THE GATE, NOT OCCUPANCY. A document contributes paths — including
 * its own — only once its primitive's validator accepts it. Those validators
 * recompute the document's own binding and request digests, so this is a binding
 * test rather than a shape test: an authority-shaped file dropped at a canonical
 * path, or a real authority whose declared pre-state has been altered, fails the
 * recomputation, contributes nothing, and is left outside the cohort for the
 * audit to report as an unexpected delta.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { evaluateMaintenanceSourceAdmissibility, MODE_ADMISSION } from './maintenance-publication-admissibility.mjs';
import {
  collectHistoricalAdmissionBridges,
  collectHistoricalIdentityRatifications,
  resolveHistoricalIdentityDecision
} from './historical-admission-bridge.mjs';
import {
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  validateGateAuthorizationRecordShape,
  validateGateAuthorizationAuthorityShape
} from './gate-authorization-authority.mjs';
import {
  gateStartRecordPath,
  gateStartAuthorityPath,
  validateGateStartRecordShape,
  validateGateStartAuthorityShape
} from './gate-start-authority.mjs';
import {
  precontractLocalAuthorityPath,
  validatePrecontractAuthorityShape
} from './precontract-authority.mjs';
import {
  collectCurrentByteBindings,
  deriveCurrentByteAuthorizationProof,
  STATUS_AUTHORIZED,
  BINDING_OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR,
  BINDING_EXTERNAL_OWNER_BYTE_AUTHORITY
} from './current-byte-authorization.mjs';

export const COHORT_DOCUMENT = 'CANONICAL_AUTHORIZED_COHORT';
export const COHORT_ALGORITHM_VERSION = 'R2';

const GATE_RE = /^GATE[0-9]{2}$/;

function readJsonOrNull(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

function sha256File(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}

function pathsFrom(value, key) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry : entry?.[key]))
    .filter((entry) => typeof entry === 'string' && entry.startsWith('governance/'));
}

/**
 * @returns {{
 *   document: string, algorithmVersion: string, gateId: string,
 *   cohort: string[], cohortDigest: string,
 *   sources: Array<{sourcePath: string, kind: string, sha256: string|null, admitted: boolean, pathCount: number, refusedReason: string|null}>,
 *   refusedSources: number, valid: boolean, findings: Array<{code: string, detail?: string}>
 * }}
 */
export function deriveCanonicalAuthorizedCohort({ root, gateId }) {
  const findings = [];
  const sources = [];
  const cohort = new Set();
  if (!GATE_RE.test(gateId || '')) {
    return {
      document: COHORT_DOCUMENT, algorithmVersion: COHORT_ALGORITHM_VERSION, gateId,
      cohort: [], cohortDigest: null, sources, refusedSources: 0, valid: false,
      findings: [{ code: 'GATE_ID_INVALID', detail: gateId }]
    };
  }

  const admit = (sourcePath, kind, paths) => {
    sources.push({ sourcePath, kind, sha256: sha256File(root, sourcePath), admitted: true, pathCount: paths.length, refusedReason: null });
    for (const entry of paths) cohort.add(entry);
  };
  const refuse = (sourcePath, kind, reason) => {
    sources.push({ sourcePath, kind, sha256: sha256File(root, sourcePath), admitted: false, pathCount: 0, refusedReason: reason });
    findings.push({ code: 'AUTHORITY_SOURCE_REFUSED', detail: `${sourcePath}:${reason}` });
  };

  /**
   * Admits one lifecycle phase: its payload paths, its own record, and the owner
   * authority document bound to that record.
   *
   * The owner snapshot is contributed only when it is BOTH present and valid.
   * Absent is legitimate — under legacy signed mode the owner document lives
   * outside the governed set entirely — so absence contributes nothing and
   * refuses nothing. Present-but-invalid is a real defect and is refused: a
   * document sitting at a canonical authority path while failing its own digest
   * recomputation is not an authority, and must not be mistaken for one.
   */
  const admitLifecyclePhase = ({ kind, recordPath, record, recordValid, payloadPaths, snapshotPath }) => {
    if (!recordValid) { refuse(recordPath, kind, 'AUTHORITY_DOCUMENT_INVALID'); return; }
    if (record.gateId !== gateId) { refuse(recordPath, kind, 'AUTHORITY_BOUND_TO_OTHER_GATE'); return; }
    const paths = [...payloadPaths, recordPath];
    if (snapshotPath) {
      const snapshot = readJsonOrNull(root, snapshotPath.path);
      if (snapshot !== null) {
        if (!snapshotPath.validate(snapshot).valid) {
          refuse(snapshotPath.path, `${kind}_OWNER_AUTHORITY`, 'AUTHORITY_DOCUMENT_INVALID');
          return;
        }
        if (snapshot.gateId !== gateId) {
          refuse(snapshotPath.path, `${kind}_OWNER_AUTHORITY`, 'AUTHORITY_BOUND_TO_OTHER_GATE');
          return;
        }
        paths.push(snapshotPath.path);
      }
    }
    admit(recordPath, kind, paths);
  };

  /* ---- Gate lifecycle authority records ------------------------------- */
  const authorizationPath = gateAuthorizationRecordPath(gateId);
  const authorization = readJsonOrNull(root, authorizationPath);
  if (!authorization) refuse(authorizationPath, 'GATE_AUTHORIZATION_RECORD', 'ABSENT_OR_UNREADABLE');
  else {
    admitLifecyclePhase({
      kind: 'GATE_AUTHORIZATION_RECORD',
      recordPath: authorizationPath,
      record: authorization,
      recordValid: validateGateAuthorizationRecordShape(authorization).valid,
      payloadPaths: [
        ...pathsFrom(authorization.authorizedStateArtifacts, 'repoRelativePath'),
        ...pathsFrom(authorization.authorizedDerivedArtifacts, 'repoRelativePath')
      ],
      // recordedAt is what ties the owner's approved binding digest to THIS
      // record; validating the authority without it would accept an owner
      // approval issued for some other authorization of the same Gate.
      snapshotPath: {
        path: gateAuthorizationAuthoritySnapshotPath(gateId),
        validate: (snapshot) => validateGateAuthorizationAuthorityShape(snapshot, { recordedAt: authorization.recordedAt })
      }
    });
  }

  const startPath = gateStartRecordPath(gateId);
  const start = readJsonOrNull(root, startPath);
  if (!start) refuse(startPath, 'GATE_START_RECORD', 'ABSENT_OR_UNREADABLE');
  else {
    admitLifecyclePhase({
      kind: 'GATE_START_RECORD',
      recordPath: startPath,
      record: start,
      recordValid: validateGateStartRecordShape(start).valid,
      payloadPaths: [
        ...pathsFrom(start.authorizedStartWritePaths, 'path'),
        ...pathsFrom(start.functionalExecutionScope, 'path')
      ],
      snapshotPath: { path: gateStartAuthorityPath(gateId), validate: validateGateStartAuthorityShape }
    });
  }

  /* ---- Precontract bootstrap authority ---------------------------------
   *
   * Absent is legitimate: a Gate whose contract was not bootstrapped this way
   * has no such document, so absence contributes nothing rather than blocking.
   * The authority IS the owner document here, so there is no separate snapshot.
   */
  const precontractPath = precontractLocalAuthorityPath(gateId);
  const precontract = readJsonOrNull(root, precontractPath);
  if (precontract) {
    admitLifecyclePhase({
      kind: 'PRECONTRACT_LOCAL_AUTHORITY',
      recordPath: precontractPath,
      record: precontract,
      recordValid: validatePrecontractAuthorityShape(precontract).valid,
      payloadPaths: pathsFrom(precontract.authorizedPaths, 'path'),
      snapshotPath: null
    });
  }

  /* ---- The execution contract this Gate is actually bound to ----------- */
  const current = readJsonOrNull(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractPath = typeof current?.contractPath === 'string' && current.contractPath.startsWith('governance/') && !current.contractPath.includes('..')
    ? current.contractPath
    : null;
  if (contractPath) {
    const contract = readJsonOrNull(root, contractPath);
    if (!contract) refuse(contractPath, 'EXECUTION_CONTRACT', 'ABSENT_OR_UNREADABLE');
    else {
      admit(contractPath, 'EXECUTION_CONTRACT', [
        ...pathsFrom(contract.requiredOutputs, 'path'),
        ...pathsFrom(contract.authorizedPaths, 'path')
      ]);
    }
  }

  /* ---- Post-freeze maintenance programs bound to this Gate ------------- */
  //
  // Selection is by the authority's own pre-state, not by file name: a program
  // belongs to this Gate when it declared this Gate as the state it acts on.
  // BOUNDED HISTORICAL ADMISSIONS, RESOLVED ONCE.
  //
  // These are owner-issued documents that admit ONE exact historical publication
  // apiece, by programId and by the three digests of its authority, manifest and
  // consumption record. Reading them here — rather than inside the admissibility
  // evaluator — keeps that evaluator pure and keeps the bridge on the same footing
  // as every other authority document: it is loaded, validated, and then used to
  // judge bytes the caller already has. A malformed bridge is a finding, never a
  // silent absence.
  const bridges = collectHistoricalAdmissionBridges({ root, gateId });
  for (const item of bridges.findings) findings.push({ code: 'HISTORICAL_ADMISSION_BRIDGE_INVALID', detail: `${item.code}:${item.detail ?? ''}` });
  // The Owner ratifications that RESERVE historical identities. Loaded once and
  // handed to the shared resolver, so the cohort forms no opinion of its own.
  const ratifications = collectHistoricalIdentityRatifications({ root, gateId });
  for (const item of ratifications.findings) findings.push({ code: 'HISTORICAL_IDENTITY_RATIFICATION_INVALID', detail: `${item.code}:${item.detail ?? ''}` });

  const sourcesDir = path.resolve(root, 'governance', 'sources');
  const sourceFiles = fs.existsSync(sourcesDir)
    ? fs.readdirSync(sourcesDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of sourceFiles) {
    const relativePath = `governance/sources/${name}`;
    const authority = readJsonOrNull(root, relativePath);
    // Selection, not judgement. A file that is not a maintenance authority, or
    // that is scoped to another Gate, is not this Gate's business and is passed
    // over silently. Everything that IS this Gate's business is then judged, and
    // gets an explicit verdict — admitted or refused with a reason. A source
    // scoped here can no longer vanish between the two.
    if (authority?.document !== 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY') continue;
    if (authority?.preState?.gateId !== gateId) continue;

    const manifestPath = authority.authorizedPathManifestPath;
    const manifest = typeof manifestPath === 'string' ? readJsonOrNull(root, manifestPath) : null;
    const consumption = typeof authority.consumptionRecordPath === 'string' ? readJsonOrNull(root, authority.consumptionRecordPath) : null;

    // ONE EVALUATION, SHARED WITH THE PUBLISHER. This derivation used to carry its
    // own opinion of admissibility, and it was a WEAKER opinion than the canonical
    // publisher's: it accepted a manifest that binds no pre-state, which the
    // publisher refuses outright. That gap is what let AUTHORIZED_COHORT include
    // paths from programs no publisher could have run. The question is now asked
    // in exactly one place, so the two cannot disagree.
    const manifestDigest = typeof manifestPath === 'string' ? sha256File(root, manifestPath) : null;
    // ONE historical-identity decision, from the one resolver the publisher and the
    // current-byte proof also call. Reserved-ness is decided by the OWNER document,
    // not by this source, so a source cannot dodge its own reservation.
    const historicalIdentity = resolveHistoricalIdentityDecision({
      root, gateId, authority, authorityPath: relativePath,
      authoritySha256: sha256File(root, relativePath),
      manifest, manifestSha256: manifestDigest,
      consumption, consumptionSha256: typeof authority.consumptionRecordPath === 'string' ? sha256File(root, authority.consumptionRecordPath) : null,
      ratifications, bridges
    });

    const admissibility = evaluateMaintenanceSourceAdmissibility({
      authority, manifest, manifestSha256: manifestDigest,
      consumption, requireConsumption: true, historicalIdentity,
      // ADMISSION, AND NO ANCHOR — because there is nothing here that could
      // honestly supply one.
      //
      // An earlier pass tried to admit legacy V1 normal-maintenance sources
      // against a "committed at base HEAD" anchor, read with `git cat-file`. That
      // is a real anchor, and it is unusable HERE: this derivation is forbidden to
      // consult Git at all. The rule is not incidental — C16 proves it by deriving
      // the cohort in a tree with no `.git` present and requiring an identical
      // digest, because a derivation that reads Git can no longer be an
      // independent judge of what Git shows.
      //
      // Inside the information this function is permitted to see — documents on
      // disk — a legacy V1 source and one authored a minute ago are
      // indistinguishable. So there is no honest anchor to pass, and inventing one
      // would mean admitting a source because its documents exist, which is
      // exactly the self-authorization being closed.
      //
      // The consequence is accepted rather than worked around: a V1
      // normal-maintenance source is REFUSED, with a reason, because no canonical
      // publisher could publish it today. Admissibility is thereby the exact
      // biconditional of canonical publishability. Every such source belongs to a
      // closed Gate and contributes nothing to the current delta.
      mode: MODE_ADMISSION
    });
    if (!admissibility.admissible) {
      refuse(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', admissibility.reason);
      continue;
    }
    admit(relativePath, 'POST_FREEZE_MAINTENANCE_AUTHORITY', admissibility.authorizedPaths);
  }

  /* Only exact live bytes with one of the two bootstrap bindings contribute. */
  const currentByteBindings = collectCurrentByteBindings({ root, gateId });
  for (const [relativePath, bindings] of currentByteBindings.bindings) {
    if (!bindings.some((binding) => binding.bindingClass === BINDING_OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR || binding.bindingClass === BINDING_EXTERNAL_OWNER_BYTE_AUTHORITY)) continue;
    const proof = deriveCurrentByteAuthorizationProof({ root, gateId, path: relativePath, bindings: currentByteBindings.bindings });
    if (proof.status === STATUS_AUTHORIZED) admit(proof.authorityPath, proof.bindingClass, [relativePath]);
    else refuse(proof.authorityPath ?? relativePath, proof.bindingClass ?? 'BOOTSTRAP_BYTE_BINDING', proof.reason);
  }

  const ordered = [...cohort].sort();
  return {
    document: COHORT_DOCUMENT,
    algorithmVersion: COHORT_ALGORITHM_VERSION,
    gateId,
    cohort: ordered,
    cohortDigest: sha256Canonical({ gateId, algorithmVersion: COHORT_ALGORITHM_VERSION, cohort: ordered }),
    sources,
    refusedSources: sources.filter((entry) => !entry.admitted).length,
    valid: findings.length === 0,
    findings
  };
}
