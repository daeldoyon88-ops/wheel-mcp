/**
 * A SELF-CONTAINED governance repository for exercising CURRENT_STATE bootstrap
 * lineage. Every document is BUILT HERE, from scratch, in a temp directory.
 *
 * WHY BUILT AND NOT COPIED. The predecessor of this fixture cloned an absolute
 * path outside the repository. That made the evidence unreproducible on any other
 * machine, and — worse — silently coupled the proof to whatever those bytes
 * happened to be. A fixture that cannot be rebuilt from nothing is not evidence.
 *
 * WHY THIS IS NOT A PARALLEL TRUST SYSTEM. Nothing here decides anything. The
 * builder only emits documents; every judgement is made by the canonical
 * validators the production code calls. `assertBaselineAdmissible` re-asks those
 * same validators whether the baseline is genuinely valid, so a hostile case that
 * "blocks" because the fixture was malformed all along is caught as a vacuous
 * control rather than counted as a refusal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  gateAuthorizationStateCohortPaths,
  gateAuthorizationDerivedCohortPaths,
  gateAuthorizationRecordPath,
  GATE_AUTHORIZATION_STATE_COHORT_ROLES,
  GATE_AUTHORIZATION_DERIVED_COHORT_ROLES,
  GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS,
  GATE_AUTHORIZATION_PURPOSE,
  GATE_AUTHORIZATION_TRANSITION_TYPE,
  GATE_AUTHORIZATION_FIRST_REVISION,
  validateGateAuthorizationRecordShape
} from '../../gee-v1/core/gate-authorization-authority.mjs';
import {
  REQUIRED_PROHIBITED_OPERATIONS,
  POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS,
  POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
  POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE,
  validatePostFreezeMaintenanceAuthorityV2Shape,
  validateMaintenanceAuthorizedPathManifest,
  validateConsumptionRecordCoherence
} from '../../gee-v1/core/post-freeze-maintenance-authority.mjs';
import {
  evaluateMaintenanceSourceAdmissibility,
  MODE_ADMISSION
} from '../../gee-v1/core/maintenance-publication-admissibility.mjs';

/** The Gate the fixture governs. Nothing in the repair is specific to it. */
export const FIXTURE_GATE = 'GATE31';

const BASE_HEAD = 'a'.repeat(40);
const STATE_PATHS = gateAuthorizationStateCohortPaths(FIXTURE_GATE);
const DERIVED_PATHS = gateAuthorizationDerivedCohortPaths();

export const CURRENT_STATE_PATH = STATE_PATHS.CURRENT_STATE;
export const CHECKPOINT_PATH = STATE_PATHS.CHECKPOINT;
export const OPEN_DEFECTS_PATH = STATE_PATHS.OPEN_DEFECTS;
export const STATE_SEAL_PATH = STATE_PATHS.STATE_SEAL;

/** The four immutable-role paths, so a caller can iterate roles generically. */
export const IMMUTABLE_ROLE_PATHS = Object.freeze({
  CHECKPOINT: CHECKPOINT_PATH,
  OPEN_DEFECTS: OPEN_DEFECTS_PATH,
  STATE_SEAL: STATE_SEAL_PATH
});

/* -------------------------------------------------------------------------- */
/* filesystem primitives                                                       */
/* -------------------------------------------------------------------------- */

export function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'current-state-bootstrap-lineage-'));
}

export function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function absolute(root, relativePath) {
  return path.join(root, ...relativePath.split('/'));
}

export function writeText(root, relativePath, text) {
  const file = absolute(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function writeJson(root, relativePath, value) {
  writeText(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(absolute(root, relativePath), 'utf8'));
}

export function identity(root, relativePath) {
  const bytes = fs.readFileSync(absolute(root, relativePath));
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
}

/** The exact bytes a CURRENT_STATE projection holds at a given revision. */
export function currentStateBytes(stateRevision) {
  return `${JSON.stringify({
    gateId: FIXTURE_GATE,
    stateRevision,
    revisionPath: `governance/gates/${FIXTURE_GATE}/state/revisions/${stateRevision}`,
    stateSealSha256: crypto.createHash('sha256').update(`seal:${stateRevision}`).digest('hex')
  }, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* the Gate's own AUTHORIZATION record — the bootstrap pin                      */
/* -------------------------------------------------------------------------- */

/**
 * Writes the four R0001 state artifacts and the AUTHORIZATION record that pins
 * them. The record's CURRENT_STATE digest is THE BOOTSTRAP PIN under test.
 *
 * No PROJECT_OWNER_GATE_AUTHORIZATION_AUTHORITY snapshot is written: the
 * production collector treats an absent snapshot as "no owner document to
 * contradict the record", which is the shape a locally-authorized Gate has.
 */
export function writeAuthorization(root, { currentStateRevision = GATE_AUTHORIZATION_FIRST_REVISION } = {}) {
  writeText(root, CURRENT_STATE_PATH, currentStateBytes(currentStateRevision));
  writeJson(root, CHECKPOINT_PATH, { gateId: FIXTURE_GATE, stateRevision: GATE_AUTHORIZATION_FIRST_REVISION, checkpoint: 'authorized' });
  writeJson(root, OPEN_DEFECTS_PATH, { gateId: FIXTURE_GATE, stateRevision: GATE_AUTHORIZATION_FIRST_REVISION, openDefects: [] });
  writeJson(root, STATE_SEAL_PATH, { gateId: FIXTURE_GATE, stateRevision: GATE_AUTHORIZATION_FIRST_REVISION, sealedMembers: [] });

  const hex = (seed) => crypto.createHash('sha256').update(seed).digest('hex');
  const record = {
    schemaVersion: 1,
    document: 'GATE_AUTHORIZATION_RECORD',
    authorizationId: 'GATE_AUTHORIZATION_FIXTURE_R1',
    projectId: 'WHEEL_FIXTURE',
    gateId: FIXTURE_GATE,
    purpose: GATE_AUTHORIZATION_PURPOSE,
    transitionType: GATE_AUTHORIZATION_TRANSITION_TYPE,
    fromStatus: 'NOT_STARTED',
    toStatus: 'AUTHORIZED_NOT_STARTED',
    recordedAt: '2026-01-01T00:00:00.000Z',
    baseCommit: BASE_HEAD,
    preLedgerSha256: hex('pre-ledger'),
    previousEventSha256: hex('previous-event'),
    contractSha256: hex('contract'),
    currentContractSha256: hex('current-contract'),
    dependencyProof: {
      gateId: 'GATE30',
      status: 'COMPLETE_CONFIRMED',
      authorityPath: 'governance/authority/fixture/GATE30_DEPENDENCY.json',
      authoritySha256: hex('dependency')
    },
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    authorizedStateArtifacts: GATE_AUTHORIZATION_STATE_COHORT_ROLES.map((cohortRole) => {
      const observed = identity(root, STATE_PATHS[cohortRole]);
      return { cohortRole, repoRelativePath: STATE_PATHS[cohortRole], sha256: observed.sha256, byteLength: observed.byteLength };
    }),
    authorizedDerivedArtifacts: GATE_AUTHORIZATION_DERIVED_COHORT_ROLES.map((cohortRole) => ({
      cohortRole, repoRelativePath: DERIVED_PATHS[cohortRole]
    })),
    prohibitedOperations: [...GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS],
    executionAuthorized: false,
    reason: 'Fixture authorization pinning the initial state cohort.'
  };
  writeJson(root, gateAuthorizationRecordPath(FIXTURE_GATE), record);
  return record;
}

/** Rewrites the AUTHORIZATION record after a caller mutated it. */
export function rewriteAuthorization(root, mutate) {
  const record = readJson(root, gateAuthorizationRecordPath(FIXTURE_GATE));
  mutate(record);
  writeJson(root, gateAuthorizationRecordPath(FIXTURE_GATE), record);
  return record;
}

/* -------------------------------------------------------------------------- */
/* a governed maintenance publication — a real successor                        */
/* -------------------------------------------------------------------------- */

/**
 * Publishes `paths` (path -> exact bytes) as one governed FINAL_CLOSURE program,
 * writing the bytes and the authority/manifest/consumption trio that certifies
 * them. The trio is byte-bound the way the production documents are: the
 * authority pins the manifest digest, and the consumption record restates the
 * authority id, program id, manifest digest, base head and commit message.
 *
 * FINAL_CLOSURE is used because it is exactly the class the GATE20 closure
 * belongs to, so the fixture reproduces the real admissibility path rather than
 * an easier neighbouring one.
 */
export function publish(root, { programSuffix, paths, transactionId = null }) {
  const programId = `FIXTURE_PUBLICATION_${programSuffix}`;
  const authorityId = `FIXTURE_AUTHORITY_${programSuffix}`;
  const manifestPath = `governance/historical-architecture/FIXTURE_${programSuffix}_AUTHORIZED_PATHS.json`;
  const consumptionPath = `governance/historical-architecture/FIXTURE_${programSuffix}_CONSUMPTION.json`;
  const authorityPath = `governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_FIXTURE_${programSuffix}.json`;
  const commitMessage = `governance: fixture publication ${programSuffix}`;

  for (const [relativePath, bytes] of Object.entries(paths)) writeText(root, relativePath, bytes);

  // The receipt is inside its own authorized cohort but excluded from the
  // certified entries — it cannot hash its own final bytes.
  const manifestEntries = [
    ...Object.keys(paths).map((relativePath) => ({
      path: relativePath,
      operation: 'MODIFY',
      phase: 'AGENT_CLOSURE',
      reason: `Fixture publication ${programSuffix} writes this path.`,
      artifactClass: 'AGENT_CLOSURE'
    })),
    {
      path: consumptionPath,
      operation: 'CREATE',
      phase: 'AGENT_CLOSURE',
      reason: 'Single-use consumption receipt for this fixture publication.',
      artifactClass: 'AGENT_CLOSURE'
    }
  ];
  const manifest = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORIZED_PATH_MANIFEST',
    schemaVersion: 1,
    manifestId: `FIXTURE_${programSuffix}_AUTHORIZED_PATHS`,
    programId,
    paths: manifestEntries
  };
  writeJson(root, manifestPath, manifest);
  const manifestIdentity = identity(root, manifestPath);

  const authority = {
    document: 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY',
    schemaVersion: 2,
    authorityId,
    authorityClass: POST_FREEZE_MAINTENANCE_AUTHORITY_CLASS,
    authorityMode: POST_FREEZE_MAINTENANCE_AUTHORITY_MODE,
    issuedBy: 'PROJECT_OWNER',
    createdAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    targetSystem: 'PROJECT_GOVERNANCE',
    programId,
    authorityPurpose: POST_FREEZE_MAINTENANCE_AUTHORITY_PURPOSE_FINAL_CLOSURE,
    resumePoint: `FIXTURE_${programSuffix}`,
    maxUse: 1,
    preState: {
      baseHead: BASE_HEAD,
      ledgerEventCount: 1,
      ledgerPrefixSha256: crypto.createHash('sha256').update('ledger-prefix').digest('hex'),
      gateId: FIXTURE_GATE,
      gateStatus: 'COMPLETE_AGENT',
      stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
      contractRevision: GATE_AUTHORIZATION_FIRST_REVISION,
      activeGate: FIXTURE_GATE,
      R8ExpectedAbsent: true
    },
    authorizedPathManifestPath: manifestPath,
    authorizedPathManifestSha256: manifestIdentity.sha256,
    authorizedOperationClasses: ['AGENT_CLOSURE'],
    commitPolicy: {
      maxCommitCount: 1,
      allowedGitOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
      commitMessage,
      thirdCommitAuthorized: false
    },
    pushAuthorized: false,
    authorityPredecessor: null,
    authorityHeadBinding: { mode: 'BASE_HEAD', baseHead: BASE_HEAD },
    consumptionRecordPath: consumptionPath,
    prohibitedOperations: [...REQUIRED_PROHIBITED_OPERATIONS]
  };
  writeJson(root, authorityPath, authority);

  const consumption = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION',
    schemaVersion: 2,
    authorityId,
    programId,
    manifestSha256: manifestIdentity.sha256,
    baseHead: BASE_HEAD,
    consumedUse: 1,
    transactionId: transactionId ?? `TXN_FIXTURE_${programSuffix}`,
    recordedAt: '2026-02-01T01:00:00.000Z',
    commitMessage,
    cohortSelfExclusion: { path: consumptionPath, reason: 'A receipt cannot certify its own final bytes.' },
    cohortPathCount: manifestEntries.length,
    // Every certified entry restates its manifest entry's metadata verbatim; the
    // canonical coherence check compares them field by field.
    cohort: manifestEntries.filter((entry) => entry.path !== consumptionPath).map((entry) => {
      const observed = identity(root, entry.path);
      return {
        path: entry.path,
        sha256: observed.sha256,
        byteLength: observed.byteLength,
        operation: entry.operation,
        reason: entry.reason,
        artifactClass: entry.artifactClass
      };
    })
  };
  writeJson(root, consumptionPath, consumption);

  return { programId, authorityId, authorityPath, manifestPath, consumptionPath };
}

/** Rewrites one document of a publication after a caller mutated it. */
export function rewrite(root, relativePath, mutate) {
  const document = readJson(root, relativePath);
  mutate(document);
  writeJson(root, relativePath, document);
  return document;
}

/* -------------------------------------------------------------------------- */
/* non-vacuity: the baseline must genuinely satisfy the canonical validators    */
/* -------------------------------------------------------------------------- */

/**
 * Re-asks the CANONICAL validators whether the fixture's documents are valid.
 *
 * This is what stops a hostile case from passing for the wrong reason. If the
 * fixture drifts out of shape, every BLOCK assertion would still "succeed" while
 * proving nothing at all; asserting admissibility first makes that failure loud.
 */
export function assertBaselineAdmissible(root, publication, label) {
  const recordResult = validateGateAuthorizationRecordShape(readJson(root, gateAuthorizationRecordPath(FIXTURE_GATE)));
  assert.equal(recordResult.valid, true, `${label}: authorization record invalid ${JSON.stringify(recordResult.findings)}`);

  if (!publication) return;
  const authority = readJson(root, publication.authorityPath);
  const manifest = readJson(root, publication.manifestPath);
  const consumption = readJson(root, publication.consumptionPath);

  const authorityResult = validatePostFreezeMaintenanceAuthorityV2Shape(authority);
  assert.equal(authorityResult.valid, true, `${label}: authority invalid ${JSON.stringify(authorityResult.findings)}`);

  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
  assert.equal(manifestResult.valid, true, `${label}: manifest invalid ${JSON.stringify(manifestResult.findings)}`);

  const coherence = [];
  validateConsumptionRecordCoherence(consumption, authority, manifest, coherence);
  assert.equal(coherence.length, 0, `${label}: consumption incoherent ${JSON.stringify(coherence)}`);

  const admissibility = evaluateMaintenanceSourceAdmissibility({
    authority,
    manifest,
    manifestSha256: identity(root, publication.manifestPath).sha256,
    consumption,
    requireConsumption: true,
    mode: MODE_ADMISSION,
    historicalIdentity: null
  });
  assert.equal(admissibility.admissible, true, `${label}: publication not admissible (${admissibility.reason})`);
}
