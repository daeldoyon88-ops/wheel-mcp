/**
 * GATE_AUTHORIZATION_AUTHORITY PRIMITIVE — architecture proof.
 *
 * Proves the primitive can truthfully authorize EXACTLY ONE normal Gate
 * transition — NOT_STARTED -> AUTHORIZED_NOT_STARTED, plus the Gate's first
 * sealed R0001 revision — and that it fails closed everywhere else.
 *
 * Everything runs in throwaway sandboxes below the OS temp dir, signed with a
 * test-only ed25519 key pair generated per run. The real repository ledger is
 * read ONLY to assert its invariants; no test mutates it, and no test writes
 * anything into the real GATE14 canonical state.
 *
 * Every hostile case below is the SAME complete, valid scenario with exactly one
 * thing broken, so a BLOCK can only be attributed to that one thing. Cases assert
 * the exact finding id wherever the architecture names one, not merely that the
 * decision was BLOCKED — "it failed" is not evidence that it failed for the right
 * reason.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { validateLedger, TRANSITIONS, TRANSITION_TYPES, STATUSES, NORMAL_EXECUTION_TRANSITION_TYPES, CONTRACT_SUCCESSION_TRANSITION_TYPE, CONTRACT_SUCCESSION_TRANSITIONS } from '../tools/validate-status-ledger.mjs';
import { canonicalize, sha256Canonical, sha256Bytes } from '../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../gee-v1/contracts/validate-against-json-schema.mjs';
import { verifyHeadWitness } from '../gee-v1/core/head-witness.mjs';
import { createWheelProjectAdapter } from '../gee-v1/adapters/wheel/wheel-project-adapter.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';
import {
  GATE_AUTHORIZATION_TRANSITION_TYPE,
  GATE_AUTHORIZATION_FROM_STATUS,
  GATE_AUTHORIZATION_TO_STATUS,
  GATE_AUTHORIZATION_PURPOSE,
  GATE_AUTHORIZATION_FIRST_REVISION,
  GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
  GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS,
  computeGateAuthorizationBindingDigest,
  computeGateAuthorizationRequestDigest,
  evaluateGateAuthorizationAuthority,
  validateGateAuthorizationRecordShape,
  validateGateAuthorizationAuthorityShape,
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  gateAuthorizationStateCohortPaths,
  gateAuthorizationDerivedCohortPaths,
  authorizationSigningPayload
} from '../gee-v1/core/gate-authorization-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'gate-authorization-record.schema.json'), 'utf8'));
const REQUEST_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'gate-authorization-authority-request.schema.json'), 'utf8'));
const AUTHORITY_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'gate-authorization-authority.schema.json'), 'utf8'));

// Test-only owner key. The real owner private key is never read by this suite.
const TEST_KEYS = crypto.generateKeyPairSync('ed25519');
const TEST_OWNER_KEY_ID = 'TEST-OWNER-GATE-AUTHORIZATION';
const TEST_PUBLIC_KEY_PEM = TEST_KEYS.publicKey.export({ type: 'spki', format: 'pem' });

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function mkSandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gau-${prefix}-`));
  sandboxes.push(dir);
  return dir;
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, ...relPath.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function readBytes(root, relPath) {
  return fs.readFileSync(path.join(root, ...relPath.split('/')));
}

function artifactOf(root, cohortRole, relPath) {
  const bytes = readBytes(root, relPath);
  return { cohortRole, repoRelativePath: relPath, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function sealEvents(events) {
  const sealed = [];
  let previous = null;
  for (const [index, event] of events.entries()) {
    const chained = { ...event, ordinal: index + 1, previousEventSha256: previous };
    const finalEvent = { ...chained, eventPayloadSha256: sha256Canonical(chained) };
    sealed.push(finalEvent);
    previous = finalEvent.eventPayloadSha256;
  }
  return sealed;
}

function ledgerText(sealed) {
  return `${sealed.map((e) => canonicalize(e)).join('\n')}\n`;
}

function signAuthority(authority, privateKey = TEST_KEYS.privateKey) {
  return {
    ...authority,
    signature: crypto.sign(null, Buffer.from(authorizationSigningPayload(authority), 'utf8'), privateKey).toString('base64')
  };
}

const SUBJECT_GATE = 'GATE14';
const DEPENDENCY_GATE = 'GATE13';
const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const REGISTRY_REL = 'governance/GATE_REGISTRY_00_40.json';
const SOURCE_MAP_REL = 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json';
const OWNER_KEY_REL = 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json';

// Fixed deterministic timestamps — fixtures must reproduce byte-identically.
const T_GENESIS = '2026-01-01T00:00:00.000Z';
const T_CLOSURE = '2026-02-01T00:00:00.000Z';
const T_GENESIS_SUBJECT = '2026-03-01T00:00:00.000Z';
const T_AUTHORIZATION = '2026-08-10T00:00:00.000Z';
const T_ISSUED = '2026-08-09T00:00:00.000Z';
const T_EXPIRES = '2026-12-31T00:00:00.000Z';

/**
 * Builds a complete, byte-consistent sandbox following the approved acyclic
 * construction order P0..P14:
 *
 *   P0  frozen inputs (registry, source map, owner public key, contracts)
 *   P1  CHECKPOINT       P2  OPEN_DEFECTS      P3  STATE_SEAL      P4  CURRENT_STATE
 *   P5  GATE_AUTHORIZATION_RECORD              P6  AUTHORIZATION ledger event
 *   P7  post-ledger bytes
 *   P8  GATE_STATUS_SNAPSHOT                   P9  ACTIVE_GATE
 *   P10 ACTIVE_GATE_CONTEXT JSON + MD          P11 approved binding digest
 *   P12 unsigned request                       P13 owner-signed authority
 *   P14 byte-identical in-repo owner-authority snapshot
 *
 * Every knob below breaks exactly one link in that chain.
 */
function buildScenario({
  prefix = 'case',
  gateId = SUBJECT_GATE,
  dependencyGate = DEPENDENCY_GATE,
  // --- ledger event knobs ---
  eventFromStatus = GATE_AUTHORIZATION_FROM_STATUS,
  eventToStatus = GATE_AUTHORIZATION_TO_STATUS,
  eventTransitionType = GATE_AUTHORIZATION_TRANSITION_TYPE,
  eventRecordedAt = T_AUTHORIZATION,
  eventAuthorityPathOverride = null,
  eventAuthoritySha256Override = null,
  extraEventAfter = null,
  breakPreviousEventSha = false,
  subjectGenesisStatus = GATE_AUTHORIZATION_FROM_STATUS,
  // --- document knobs ---
  recordPatch = null,
  requestPatch = null,
  authorityPatch = null,
  authorityPatchAfterSigning = null,
  signWithWrongKey = false,
  omitSignature = false,
  omitOwnerAuthoritySnapshot = false,
  extraOwnerAuthoritySnapshotPath = null,
  // --- post-signature byte mutation (H18-H21) ---
  mutateAfterSignature = null,
  // --- misc ---
  checkpointMilestone = 'GATE14_DETERMINISTIC_MUTATION_TRAVERSAL',
  openDefects = [],
  sealMembersOverride = null,
  contractSha256Override = null,
  currentContractSha256Override = null,
  dependencyProofPatch = null,
  // --- dependency authority identity (external-identity resolution repair) ---
  // When set, the dependency Gate's terminal event carries this opaque EXTERNAL
  // AUTHORITY IDENTITY instead of a governed path, declared through the source map
  // exactly as the canonical transition-authority resolver expects.
  dependencyAuthorityIdentity = null,
  externalAuthorityDeclarationsOverride = null,
  ownerPublicKeyPem = TEST_PUBLIC_KEY_PEM
} = {}) {
  const root = mkSandbox(prefix);
  const statePaths = gateAuthorizationStateCohortPaths(gateId);
  const derivedPaths = gateAuthorizationDerivedCohortPaths();

  // ---------- P0: frozen inputs ----------
  writeFile(root, REGISTRY_REL, JSON.stringify({
    schemaVersion: 1,
    gates: [
      { gateId: dependencyGate, canonicalObjective: `objective ${dependencyGate}`, dependencies: [], definitionCompleteness: 'PARTIAL' },
      { gateId, canonicalObjective: `objective ${gateId}`, dependencies: [dependencyGate], definitionCompleteness: 'PARTIAL' }
    ]
  }, null, 2));

  writeFile(root, OWNER_KEY_REL, JSON.stringify({
    schemaVersion: 1,
    documentKind: 'PROJECT_OWNER_RELEASE_PUBLIC_KEY',
    keyId: TEST_OWNER_KEY_ID,
    algorithm: 'ed25519',
    publicKeyPem: ownerPublicKeyPem
  }, null, 2));

  const registrySha = sha256Bytes(readBytes(root, REGISTRY_REL));
  const sourceGate = (id, importedStatus) => ({
    gateId: id,
    importedStatus,
    sourceAuthorityPath: REGISTRY_REL,
    sourceAuthoritySha256: registrySha,
    sourcePointer: `/gates/${id}`,
    statusDerivation: 'NO_RESOLVABLE_HISTORICAL_STATUS_AUTHORITY_AT_BOOTSTRAP',
    confidenceClass: 'UNRESOLVED_STATUS_FALLBACK',
    historicalDetailCompleteness: 'UNKNOWN',
    fabricatedTransitionCount: 0,
    authorityKind: 'IMPORTED_EVIDENCE',
    unresolvedHistoricalDetails: ['execution chronology']
  });
  // Dependency Gate's closure authority — cited by the dependency proof.
  const dependencyAuthorityRel = `governance/gates/${dependencyGate}/closure/AGENT_CLOSURE_REPORT.json`;
  writeFile(root, dependencyAuthorityRel, JSON.stringify({ gateId: dependencyGate, verdict: 'COMPLETE_AGENT' }, null, 2));
  const dependencyAuthoritySha = sha256Bytes(readBytes(root, dependencyAuthorityRel));

  // Written after the dependency authority so a declared external identity can pin
  // that document's real bytes. Empty by default: the governed-path case is unchanged.
  const declaredExternalAuthorities = externalAuthorityDeclarationsOverride
    ?? (dependencyAuthorityIdentity
      ? [{ authorityId: dependencyAuthorityIdentity, classification: 'CANONICAL_EVIDENCE', path: dependencyAuthorityRel, sha256: dependencyAuthoritySha }]
      : []);
  writeFile(root, SOURCE_MAP_REL, JSON.stringify({
    schemaVersion: 1,
    documentKind: 'GENESIS_IMPORT_SOURCE_MAP',
    externalAuthorities: declaredExternalAuthorities,
    gates: [sourceGate(dependencyGate, 'IN_PROGRESS'), sourceGate(gateId, subjectGenesisStatus)]
  }, null, 2));

  // The identity the dependency Gate's terminal event actually records.
  const dependencyAuthorityIdentityOrPath = dependencyAuthorityIdentity ?? dependencyAuthorityRel;

  // Subject Gate contracts.
  const contractRel = `governance/gates/${gateId}/contracts/EXECUTION_CONTRACT_${GATE_AUTHORIZATION_FIRST_REVISION}.json`;
  const currentContractRel = `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`;
  writeFile(root, contractRel, JSON.stringify({
    gateId,
    contractRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    canonicalRequirements: [checkpointMilestone]
  }, null, 2));
  const contractSha = sha256Bytes(readBytes(root, contractRel));
  writeFile(root, currentContractRel, JSON.stringify({
    schemaVersion: 1,
    gateId,
    contractRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    contractPath: contractRel,
    contractSha256: contractSha
  }, null, 2));
  const currentContractSha = sha256Bytes(readBytes(root, currentContractRel));

  // ---------- P1: CHECKPOINT ----------
  writeFile(root, statePaths.CHECKPOINT, JSON.stringify({
    gateId,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    milestone: checkpointMilestone,
    resumePoint: 'AUTHORIZED_NOT_STARTED',
    completedTasks: [],
    openTasks: [],
    reusableEvidence: [],
    invalidatedEvidence: [],
    requiredNextActions: ['AWAIT_START_AUTHORITY'],
    protectedHashes: [],
    createdAt: T_AUTHORIZATION
  }, null, 2));

  // ---------- P2: OPEN_DEFECTS ----------
  writeFile(root, statePaths.OPEN_DEFECTS, JSON.stringify({
    gateId,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    defects: openDefects
  }, null, 2));

  // ---------- P3: STATE_SEAL ----------
  const sealedMembers = sealMembersOverride ?? [
    { repoRelativePath: statePaths.CHECKPOINT, ...(() => { const b = readBytes(root, statePaths.CHECKPOINT); return { sha256: sha256Bytes(b), byteLength: b.length }; })() },
    { repoRelativePath: statePaths.OPEN_DEFECTS, ...(() => { const b = readBytes(root, statePaths.OPEN_DEFECTS); return { sha256: sha256Bytes(b), byteLength: b.length }; })() },
    { repoRelativePath: currentContractRel, ...(() => { const b = readBytes(root, currentContractRel); return { sha256: sha256Bytes(b), byteLength: b.length }; })() }
  ];
  const sealPayload = {
    gateId,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    milestone: checkpointMilestone,
    executionStatus: GATE_AUTHORIZATION_TO_STATUS,
    contractSha256: contractSha,
    ledgerMutated: true,
    sealedAt: T_AUTHORIZATION
  };
  writeFile(root, statePaths.STATE_SEAL, JSON.stringify({
    schemaVersion: 1,
    gateId,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    sealedMembers,
    previousStateSealSha256: null,
    sealedAt: T_AUTHORIZATION,
    payload: sealPayload,
    payloadSha256: sha256Canonical(sealPayload)
  }, null, 2));

  // ---------- P4: CURRENT_STATE ----------
  writeFile(root, statePaths.CURRENT_STATE, JSON.stringify({
    schemaVersion: 1,
    gateId,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    revisionPath: `governance/gates/${gateId}/state/revisions/${GATE_AUTHORIZATION_FIRST_REVISION}`,
    stateSealSha256: sha256Bytes(readBytes(root, statePaths.STATE_SEAL)),
    committedByTransactionId: `${gateId}-R0001-AUTHORIZATION`
  }, null, 2));

  // ---------- pre-ledger events (P0 history) ----------
  const priorEvents = sealEvents([
    { schemaVersion: 1, eventId: `EV-${dependencyGate}-GENESIS`, gateId: dependencyGate, fromStatus: null, toStatus: 'IN_PROGRESS', transitionType: 'GENESIS_IMPORT', authorityPath: REGISTRY_REL, authoritySha256: registrySha, recordedAt: T_GENESIS },
    { schemaVersion: 1, eventId: `EV-${dependencyGate}-CLOSURE`, gateId: dependencyGate, fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETE_AGENT', transitionType: 'AGENT_CLOSURE', authorityPath: dependencyAuthorityIdentityOrPath, authoritySha256: dependencyAuthoritySha, recordedAt: T_CLOSURE },
    { schemaVersion: 1, eventId: `EV-${gateId}-GENESIS`, gateId, fromStatus: null, toStatus: subjectGenesisStatus, transitionType: 'GENESIS_IMPORT', authorityPath: REGISTRY_REL, authoritySha256: registrySha, recordedAt: T_GENESIS_SUBJECT }
  ]);
  const preLedgerText = ledgerText(priorEvents);
  const preLedgerSha256 = sha256Bytes(Buffer.from(preLedgerText, 'utf8'));
  const previousEventSha256 = priorEvents.at(-1).eventPayloadSha256;

  const dependencyProof = {
    gateId: dependencyGate,
    status: 'COMPLETE_AGENT',
    authorityPath: dependencyAuthorityIdentityOrPath,
    authoritySha256: dependencyAuthoritySha,
    ...(dependencyProofPatch || {})
  };

  const stateArtifacts = [
    artifactOf(root, 'CURRENT_STATE', statePaths.CURRENT_STATE),
    artifactOf(root, 'CHECKPOINT', statePaths.CHECKPOINT),
    artifactOf(root, 'OPEN_DEFECTS', statePaths.OPEN_DEFECTS),
    artifactOf(root, 'STATE_SEAL', statePaths.STATE_SEAL)
  ];
  const derivedRecordEntries = Object.entries(derivedPaths).map(([cohortRole, repoRelativePath]) => ({ cohortRole, repoRelativePath }));

  // ---------- P5: GATE_AUTHORIZATION_RECORD ----------
  let record = {
    schemaVersion: 1,
    document: 'GATE_AUTHORIZATION_RECORD',
    authorizationId: `GATE_AUTHORIZATION_${gateId}_R1`,
    projectId: 'WHEEL',
    gateId,
    purpose: GATE_AUTHORIZATION_PURPOSE,
    transitionType: GATE_AUTHORIZATION_TRANSITION_TYPE,
    fromStatus: GATE_AUTHORIZATION_FROM_STATUS,
    toStatus: GATE_AUTHORIZATION_TO_STATUS,
    recordedAt: T_AUTHORIZATION,
    baseCommit: 'a'.repeat(40),
    preLedgerSha256,
    previousEventSha256,
    contractSha256: contractSha256Override ?? contractSha,
    currentContractSha256: currentContractSha256Override ?? currentContractSha,
    dependencyProof,
    stateRevision: GATE_AUTHORIZATION_FIRST_REVISION,
    authorizedStateArtifacts: stateArtifacts,
    authorizedDerivedArtifacts: derivedRecordEntries,
    prohibitedOperations: [...GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS],
    executionAuthorized: false,
    reason: 'Immediate dependency is terminal; contract is active; first sealed revision created.'
  };
  if (recordPatch) record = recordPatch({ ...record });
  const recordRel = gateAuthorizationRecordPath(gateId);
  writeFile(root, recordRel, `${JSON.stringify(record, null, 2)}\n`);
  const recordSha = sha256Bytes(readBytes(root, recordRel));

  // ---------- P6: the AUTHORIZATION ledger event ----------
  const authorizationEvent = {
    schemaVersion: 1,
    eventId: `EV-${gateId}-AUTHORIZATION`,
    gateId,
    fromStatus: eventFromStatus,
    toStatus: eventToStatus,
    transitionType: eventTransitionType,
    authorityPath: eventAuthorityPathOverride ?? recordRel,
    authoritySha256: eventAuthoritySha256Override ?? recordSha,
    recordedAt: eventRecordedAt
  };
  const allEventInputs = [
    ...priorEvents.map(({ ordinal, previousEventSha256: p, eventPayloadSha256, ...rest }) => rest),
    authorizationEvent,
    ...(extraEventAfter ? [extraEventAfter({ gateId, recordRel, recordSha })] : [])
  ];
  let finalEvents = sealEvents(allEventInputs);
  if (breakPreviousEventSha) {
    const target = finalEvents.findIndex((e) => e.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE);
    const broken = { ...finalEvents[target], previousEventSha256: 'b'.repeat(64) };
    finalEvents = finalEvents.map((e, i) => (i === target ? { ...broken, eventPayloadSha256: sha256Canonical((({ eventPayloadSha256, ...rest }) => rest)(broken)) } : e));
  }
  writeFile(root, LEDGER_REL, ledgerText(finalEvents));

  // ---------- P7-P10: post-ledger derived views ----------
  writeFile(root, derivedPaths.GATE_STATUS_SNAPSHOT, JSON.stringify({
    schemaVersion: 1, canonical: false, generated: true,
    generatedFrom: LEDGER_REL,
    gates: finalEvents.reduce((acc, e) => ({ ...acc, [e.gateId]: e.toStatus }), {})
  }, null, 2));
  writeFile(root, derivedPaths.ACTIVE_GATE, JSON.stringify({
    schemaVersion: 1, activeGate: dependencyGate,
    currentStateSha256: sha256Bytes(readBytes(root, statePaths.CURRENT_STATE))
  }, null, 2));
  writeFile(root, derivedPaths.ACTIVE_GATE_CONTEXT_JSON, JSON.stringify({
    schemaVersion: 1, canonical: false, generated: true, activeGate: dependencyGate
  }, null, 2));
  writeFile(root, derivedPaths.ACTIVE_GATE_CONTEXT_MD, `# ACTIVE GATE CONTEXT\n\nactiveGate: ${dependencyGate}\n`);

  const derivedArtifacts = Object.entries(derivedPaths).map(([cohortRole, relPath]) => artifactOf(root, cohortRole, relPath));

  // ---------- P11-P12: binding digest + unsigned request ----------
  const bindingSource = {
    projectId: record.projectId,
    gateId: record.gateId,
    purpose: record.purpose,
    transitionType: record.transitionType,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    recordedAt: record.recordedAt,
    baseCommit: record.baseCommit,
    preLedgerSha256: record.preLedgerSha256,
    previousEventSha256: record.previousEventSha256,
    contractSha256: record.contractSha256,
    currentContractSha256: record.currentContractSha256,
    stateRevision: record.stateRevision,
    dependencyProof: record.dependencyProof,
    stateArtifacts: record.authorizedStateArtifacts,
    derivedArtifacts
  };
  const bindingDigest = computeGateAuthorizationBindingDigest(bindingSource).digest;

  let request = {
    schemaVersion: 1,
    documentKind: 'GATE_AUTHORIZATION_AUTHORITY_REQUEST',
    requestId: `GATE_AUTHORIZATION_REQUEST_${gateId}_R1`,
    projectId: record.projectId,
    gateId: record.gateId,
    purpose: record.purpose,
    transitionType: record.transitionType,
    fromStatus: record.fromStatus,
    toStatus: record.toStatus,
    baseCommit: record.baseCommit,
    preLedgerSha256: record.preLedgerSha256,
    previousEventSha256: record.previousEventSha256,
    contractSha256: record.contractSha256,
    currentContractSha256: record.currentContractSha256,
    dependencyProof: record.dependencyProof,
    stateRevision: record.stateRevision,
    authorizedStateArtifacts: record.authorizedStateArtifacts,
    authorizedDerivedArtifacts: derivedArtifacts,
    bindingDigestAlgorithm: GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
    bindingDigest,
    prohibitedOperations: [...GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS],
    executionAuthorized: false,
    expiresAtUtc: T_EXPIRES,
    maxUse: 1
  };
  if (requestPatch) request = requestPatch({ ...request });
  request.requestDigest = computeGateAuthorizationRequestDigest(request);

  // ---------- P13: owner-signed authority ----------
  let authority = {
    schemaVersion: 1,
    documentKind: 'ACTIVE_GATE_AUTHORIZATION_AUTHORITY',
    authorityId: `ACTIVE_GATE_AUTHORIZATION_AUTHORITY_${gateId}_R1`,
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: T_ISSUED,
    expiresAtUtc: request.expiresAtUtc,
    projectId: request.projectId,
    gateId: request.gateId,
    purpose: request.purpose,
    transitionType: request.transitionType,
    fromStatus: request.fromStatus,
    toStatus: request.toStatus,
    baseCommit: request.baseCommit,
    preLedgerSha256: request.preLedgerSha256,
    previousEventSha256: request.previousEventSha256,
    contractSha256: request.contractSha256,
    currentContractSha256: request.currentContractSha256,
    dependencyProof: request.dependencyProof,
    stateRevision: request.stateRevision,
    authorizedStateArtifacts: request.authorizedStateArtifacts,
    authorizedDerivedArtifacts: request.authorizedDerivedArtifacts,
    bindingDigestAlgorithm: GATE_AUTHORIZATION_BINDING_DIGEST_ALGORITHM,
    approvedBindingDigest: request.bindingDigest,
    approvedRequestDigest: request.requestDigest,
    executionAuthorized: false,
    maxUse: 1,
    ownerKeyId: TEST_OWNER_KEY_ID,
    signatureAlgorithm: 'ed25519'
  };
  if (authorityPatch) authority = authorityPatch({ ...authority });
  const signingKey = signWithWrongKey ? crypto.generateKeyPairSync('ed25519').privateKey : TEST_KEYS.privateKey;
  let signed = omitSignature ? { ...authority, signature: '' } : signAuthority(authority, signingKey);
  if (authorityPatchAfterSigning) signed = authorityPatchAfterSigning({ ...signed });

  // ---------- P14: byte-identical in-repo snapshot ----------
  const snapshotRel = gateAuthorizationAuthoritySnapshotPath(gateId);
  if (!omitOwnerAuthoritySnapshot) writeFile(root, snapshotRel, `${JSON.stringify(signed, null, 2)}\n`);
  if (extraOwnerAuthoritySnapshotPath) writeFile(root, extraOwnerAuthoritySnapshotPath, `${JSON.stringify(signed, null, 2)}\n`);

  // ---------- post-signature byte mutation (H18-H21) ----------
  if (mutateAfterSignature) mutateAfterSignature({ root, statePaths, derivedPaths, writeFile });

  return {
    root, gateId, dependencyGate, record, request, authority: signed, recordRel, snapshotRel,
    statePaths, derivedPaths, stateArtifacts, derivedArtifacts, bindingDigest,
    preLedgerSha256, previousEventSha256, contractSha, currentContractSha,
    dependencyProof, events: finalEvents, contractRel, currentContractRel,
    dependencyAuthorityRel, dependencyAuthoritySha
  };
}

function runLedger(scenario) {
  return validateLedger({
    root: scenario.root,
    ledgerPath: path.join(scenario.root, ...LEDGER_REL.split('/')),
    registryPath: path.join(scenario.root, ...REGISTRY_REL.split('/'))
  });
}

function rewriteAuthorizationLedger(scenario, { record = scenario.record, eventPatch = (event) => event } = {}) {
  writeFile(scenario.root, scenario.recordRel, `${JSON.stringify(record, null, 2)}\n`);
  const recordSha = sha256Bytes(readBytes(scenario.root, scenario.recordRel));
  const eventInputs = scenario.events.map(({ ordinal, previousEventSha256, eventPayloadSha256, ...event }) => {
    if (event.transitionType !== GATE_AUTHORIZATION_TRANSITION_TYPE) return event;
    return eventPatch({ ...event, authoritySha256: recordSha });
  });
  const resealed = sealEvents(eventInputs);
  writeFile(scenario.root, LEDGER_REL, ledgerText(resealed));
  return resealed;
}

const blockingIds = (report) => report.findings.filter((f) => f.severity === 'BLOCKING').map((f) => f.detectorId);

/** The live facts a pre-write caller would observe for a fully valid scenario. */
function observedFor(s, overrides = {}) {
  const all = [...s.stateArtifacts, ...s.derivedArtifacts];
  return {
    projectId: 'WHEEL',
    gateId: s.gateId,
    headCommit: s.record.baseCommit,
    preLedgerSha256: s.preLedgerSha256,
    previousEventSha256: s.previousEventSha256,
    currentStatus: GATE_AUTHORIZATION_FROM_STATUS,
    contractSha256: s.contractSha,
    currentContractSha256: s.currentContractSha,
    currentContractPresent: true,
    dependencyProof: s.dependencyProof,
    artifactSha256: Object.fromEntries(all.map((a) => [a.repoRelativePath, a.sha256])),
    artifactByteLength: Object.fromEntries(all.map((a) => [a.repoRelativePath, a.byteLength])),
    competingAuthorityCount: 1,
    existingAuthorizationEventCount: 0,
    consumed: false,
    ...overrides
  };
}

function evaluatePreWrite(s, observedOverrides = {}) {
  return evaluateGateAuthorizationAuthority({
    record: s.record,
    request: s.request,
    authority: s.authority,
    ownerKey: { keyId: TEST_OWNER_KEY_ID, publicKeyPem: TEST_PUBLIC_KEY_PEM },
    observed: observedFor(s, observedOverrides),
    now: new Date(T_AUTHORIZATION)
  });
}

function assertBlockedWith(report, expectedDetectorId, label) {
  const ids = blockingIds(report);
  assert.equal(report.valid, false, `${label}: expected the ledger to be INVALID`);
  assert.ok(ids.includes(expectedDetectorId), `${label}: expected blocking finding ${expectedDetectorId}, got ${JSON.stringify(ids)}`);
}

// ===========================================================================
// POSITIVE MATRIX
// ===========================================================================

test('P01 a valid Gate authorization authority passes pre-write validation', () => {
  const s = buildScenario({ prefix: 'p01' });
  const result = evaluatePreWrite(s);
  assert.deepEqual(result.findings, [], 'pre-write validation must produce no findings');
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.authorizationAuthorized, true);
  assert.equal(result.authorizedPaths.length, 8);
});

test('P02 the exact R0001 cohort is accepted, and all three documents are schema-valid', () => {
  const s = buildScenario({ prefix: 'p02' });
  assert.ok(validateAgainstJsonSchema(s.record, RECORD_SCHEMA).valid, JSON.stringify(validateAgainstJsonSchema(s.record, RECORD_SCHEMA).errors));
  assert.ok(validateAgainstJsonSchema(s.request, REQUEST_SCHEMA).valid, JSON.stringify(validateAgainstJsonSchema(s.request, REQUEST_SCHEMA).errors));
  assert.ok(validateAgainstJsonSchema(s.authority, AUTHORITY_SCHEMA).valid, JSON.stringify(validateAgainstJsonSchema(s.authority, AUTHORITY_SCHEMA).errors));
  assert.ok(validateGateAuthorizationRecordShape(s.record).valid);
  assert.ok(validateGateAuthorizationAuthorityShape(s.authority, { recordedAt: s.record.recordedAt }).valid);

  const expectedState = gateAuthorizationStateCohortPaths(s.gateId);
  assert.deepEqual(
    s.record.authorizedStateArtifacts.map((a) => a.repoRelativePath).sort(),
    Object.values(expectedState).sort()
  );
  assert.deepEqual(
    s.record.authorizedDerivedArtifacts.map((a) => a.repoRelativePath).sort(),
    Object.values(gateAuthorizationDerivedCohortPaths()).sort()
  );
});

test('P03 exactly one AUTHORIZATION event is accepted by the ledger', () => {
  const s = buildScenario({ prefix: 'p03' });
  const report = runLedger(s);
  assert.deepEqual(blockingIds(report), [], `expected a clean ledger, got ${JSON.stringify(report.findings.filter((f) => f.severity === 'BLOCKING'), null, 2)}`);
  assert.equal(report.valid, true);
  assert.ok(report.findings.some((f) => f.detectorId === 'GATE_AUTHORIZATION_APPLIED' && f.severity === 'INFO'));
  assert.equal(report.events.filter((e) => e.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE).length, 1);
});

test('P04 post-apply replayed status becomes AUTHORIZED_NOT_STARTED', () => {
  const s = buildScenario({ prefix: 'p04' });
  const report = runLedger(s);
  assert.equal(report.valid, true);
  const subject = report.gates.find((g) => g.gateId === s.gateId);
  assert.equal(subject.currentStatus, GATE_AUTHORIZATION_TO_STATUS);
});

test('P05 head witness derives ANCHORED_APPEND_ONLY for a chain-valid ledger with a real transition', () => {
  const s = buildScenario({ prefix: 'p05' });
  const report = runLedger(s);
  const trust = verifyHeadWitness({
    ledgerSha256: report.ledgerSha256,
    chainValid: report.valid,
    hasNonGenesisTransition: true,
    witnesses: []
  });
  assert.equal(trust.trustLevel, 'ANCHORED_APPEND_ONLY');
});

test('P06 sealed OPEN_DEFECTS with defects=[] derives KNOWN_ZERO through real sealed provenance', () => {
  // Proven against the REAL repository, read-only: GATE13's OPEN_DEFECTS is a
  // genuine sealed member whose hash and length reproduce its live bytes.
  const adapter = createWheelProjectAdapter(REPO_ROOT);
  const view = adapter.getWorkUnitView('GATE13');
  assert.equal(view.defectsOpenKnowledge, 'KNOWN_ZERO');
  assert.equal(view.defectsOpenCount, 0);
  assert.equal(view.authorityState.statusKnowledge, 'SEAL_VERIFIED');
});

test('P07 executionAuthorized remains false at every outcome', () => {
  const good = buildScenario({ prefix: 'p07a' });
  const bad = buildScenario({ prefix: 'p07b', recordPatch: (r) => ({ ...r, gateId: 'GATE15' }) });
  for (const [label, s] of [['authorized', good], ['blocked', bad]]) {
    const result = evaluateGateAuthorizationAuthority({
      record: s.record, request: s.request, authority: s.authority,
      ownerKey: { keyId: TEST_OWNER_KEY_ID, publicKeyPem: TEST_PUBLIC_KEY_PEM },
      observed: { projectId: 'WHEEL', gateId: s.gateId }, now: new Date(T_AUTHORIZATION)
    });
    assert.equal(result.executionAuthorized, false, `${label}: executionAuthorized must be false`);
  }
  // Structurally unrepresentable, not merely defaulted.
  assert.equal(validateGateAuthorizationRecordShape({ ...good.record, executionAuthorized: true }).valid, false);
  assert.equal(validateGateAuthorizationAuthorityShape({ ...good.authority, executionAuthorized: true }, { recordedAt: good.record.recordedAt }).valid, false);
});

test('P08 START remains unauthorized: the primitive cannot represent it', () => {
  const s = buildScenario({ prefix: 'p08' });
  const result = evaluateGateAuthorizationAuthority({
    record: s.record, request: s.request, authority: s.authority,
    ownerKey: { keyId: TEST_OWNER_KEY_ID, publicKeyPem: TEST_PUBLIC_KEY_PEM },
    observed: { projectId: 'WHEEL', gateId: s.gateId }, now: new Date(T_AUTHORIZATION)
  });
  assert.equal(result.startAuthorized, false);
  // An authority naming START is refused by shape, before any decision.
  for (const mutation of [{ transitionType: 'START' }, { toStatus: 'IN_PROGRESS' }, { purpose: 'START' }]) {
    assert.equal(validateGateAuthorizationAuthorityShape({ ...s.authority, ...mutation }, { recordedAt: s.record.recordedAt }).valid, false, `authority must not represent ${JSON.stringify(mutation)}`);
  }
  assert.ok(GATE_AUTHORIZATION_REQUIRED_PROHIBITIONS.includes('START'));
  assert.ok(s.record.prohibitedOperations.includes('START'));
});

test('P09 the primitive is generic: a GATE15 fixture works with no GATE14 hard-coding', () => {
  const s = buildScenario({ prefix: 'p09', gateId: 'GATE15', checkpointMilestone: 'GATE15_GENERIC_PROOF' });
  const report = runLedger(s);
  assert.deepEqual(blockingIds(report), [], JSON.stringify(report.findings.filter((f) => f.severity === 'BLOCKING'), null, 2));
  assert.equal(report.gates.find((g) => g.gateId === 'GATE15').currentStatus, GATE_AUTHORIZATION_TO_STATUS);
  // No production module may contain the proof-fixture Gate literal.
  for (const rel of [
    'governance/gee-v1/core/gate-authorization-authority.mjs',
    'governance/gee-v1/adapters/wheel/gate-authorization-authority-source.mjs',
    'governance/tools/validate-gate-authorization-authority.mjs'
  ]) {
    assert.equal(/GATE14/.test(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8')), false, `${rel} must not hard-code GATE14`);
  }
});

test('P10 the derived artifact cohort is deterministic and closed', () => {
  const a = gateAuthorizationDerivedCohortPaths();
  const b = gateAuthorizationDerivedCohortPaths();
  assert.deepEqual(a, b);
  assert.deepEqual(Object.values(a), [
    'governance/state/generated/GATE_STATUS_SNAPSHOT.json',
    'governance/active/ACTIVE_GATE.json',
    'governance/generated/ACTIVE_GATE_CONTEXT.json',
    'governance/generated/ACTIVE_GATE_CONTEXT.md'
  ]);
  // The binding digest is order-independent but content-sensitive.
  const s = buildScenario({ prefix: 'p10' });
  const base = {
    ...s.record,
    stateArtifacts: s.record.authorizedStateArtifacts,
    derivedArtifacts: s.derivedArtifacts
  };
  const shuffled = { ...base, derivedArtifacts: [...s.derivedArtifacts].reverse(), stateArtifacts: [...s.record.authorizedStateArtifacts].reverse() };
  assert.equal(computeGateAuthorizationBindingDigest(base).digest, computeGateAuthorizationBindingDigest(shuffled).digest);
  const tampered = { ...base, derivedArtifacts: s.derivedArtifacts.map((d, i) => (i === 0 ? { ...d, sha256: 'c'.repeat(64) } : d)) };
  assert.notEqual(computeGateAuthorizationBindingDigest(base).digest, computeGateAuthorizationBindingDigest(tampered).digest);
});

// ===========================================================================
// HOSTILE MATRIX H01-H32
// ===========================================================================

test('H01 wrong gateId in the record', () => {
  const s = buildScenario({ prefix: 'h01', recordPatch: (r) => ({ ...r, gateId: 'GATE15' }) });
  // The record now sits at GATE14's path but claims GATE15: its cohort paths no longer
  // match its own gateId, and the event's authorityPath is no longer that Gate's template.
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H01');
});

test('H02 wrong base commit', () => {
  // baseCommit is a PRE-WRITE binding: the ledger records no HEAD, so this is
  // enforced where it is actually observable — against the live repository HEAD.
  const s = buildScenario({ prefix: 'h02' });
  const result = evaluatePreWrite(s, { headCommit: 'f'.repeat(40) });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.map((f) => f.code).includes('BASE_COMMIT_MISMATCH'), JSON.stringify(result.findings));

  // Editing baseCommit in the signed authority breaks the digest it is bound to,
  // because baseCommit is part of the binding identity.
  const tampered = buildScenario({ prefix: 'h02b', authorityPatchAfterSigning: (a) => ({ ...a, baseCommit: 'f'.repeat(40) }) });
  assertBlockedWith(runLedger(tampered), 'GATE_AUTHORIZATION_UNAUTHORIZED', 'H02 post-signature baseCommit edit');

  // The hardest variant: an authority that is internally self-consistent — its
  // approvedBindingDigest genuinely reproduces its own cohort, and it is validly
  // signed — but was approved over a DIFFERENT baseCommit than the record the
  // ledger pins. Only the record/authority cross-check can catch this one.
  const drifted = buildScenario({
    prefix: 'h02c',
    authorityPatch: (a) => {
      const patched = { ...a, baseCommit: 'f'.repeat(40) };
      patched.approvedBindingDigest = computeGateAuthorizationBindingDigest({
        ...patched,
        recordedAt: T_AUTHORIZATION,
        stateArtifacts: patched.authorizedStateArtifacts,
        derivedArtifacts: patched.authorizedDerivedArtifacts
      }).digest;
      return patched;
    }
  });
  assertBlockedWith(runLedger(drifted), 'GATE_AUTHORIZATION_RECORD_AUTHORITY_MISMATCH', 'H02 record/authority drift');
});

test('H03 wrong pre-ledger SHA', () => {
  const s = buildScenario({ prefix: 'h03', recordPatch: (r) => ({ ...r, preLedgerSha256: 'd'.repeat(64) }) });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_PRE_LEDGER_MISMATCH', 'H03');
});

test('H04 wrong ledger head hash (previousEventSha256 in the record)', () => {
  const s = buildScenario({ prefix: 'h04', recordPatch: (r) => ({ ...r, previousEventSha256: 'e'.repeat(64) }) });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_EVENT_CHAIN_MISMATCH', 'H04');
});

test('H05 current status is not NOT_STARTED', () => {
  // The Gate was imported IN_PROGRESS, so NOT_STARTED -> AUTHORIZED_NOT_STARTED cannot apply.
  const s = buildScenario({ prefix: 'h05', subjectGenesisStatus: 'IN_PROGRESS' });
  assertBlockedWith(runLedger(s), 'INVALID_STATUS_TRANSITION', 'H05');
});

test('H06 target status is not AUTHORIZED_NOT_STARTED', () => {
  const s = buildScenario({ prefix: 'h06', eventToStatus: 'IN_PROGRESS' });
  assertBlockedWith(runLedger(s), 'INVALID_STATUS_TRANSITION', 'H06');
});

test('H07 transitionType is not AUTHORIZATION', () => {
  const s = buildScenario({ prefix: 'h07', eventTransitionType: 'START', eventFromStatus: 'AUTHORIZED_NOT_STARTED' });
  const report = runLedger(s);
  assert.equal(report.valid, false);
  assert.ok(blockingIds(report).includes('GATE_AUTHORIZATION_RECORD_TRANSITION_BORROWED'), `H07: got ${JSON.stringify(blockingIds(report))}`);
});

test('H08 a second AUTHORIZATION event for the same Gate', () => {
  const s = buildScenario({
    prefix: 'h08',
    extraEventAfter: ({ gateId, recordRel, recordSha }) => ({
      schemaVersion: 1, eventId: `EV-${gateId}-AUTHORIZATION-2`, gateId,
      fromStatus: GATE_AUTHORIZATION_FROM_STATUS, toStatus: GATE_AUTHORIZATION_TO_STATUS,
      transitionType: GATE_AUTHORIZATION_TRANSITION_TYPE,
      authorityPath: recordRel, authoritySha256: recordSha, recordedAt: '2026-08-11T00:00:00.000Z'
    })
  });
  const report = runLedger(s);
  assert.equal(report.valid, false);
  const ids = blockingIds(report);
  assert.ok(ids.includes('DUPLICATE_GATE_AUTHORIZATION') || ids.includes('INVALID_STATUS_TRANSITION'), `H08: got ${JSON.stringify(ids)}`);
});

test('H09 the record claims START privilege', () => {
  const s = buildScenario({
    prefix: 'h09',
    recordPatch: (r) => ({ ...r, prohibitedOperations: r.prohibitedOperations.filter((op) => op !== 'START') })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H09');
});

test('H10 the record claims AGENT_CLOSURE privilege', () => {
  const s = buildScenario({
    prefix: 'h10',
    recordPatch: (r) => ({ ...r, prohibitedOperations: r.prohibitedOperations.filter((op) => op !== 'AGENT_CLOSURE') })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H10');
});

test('H11 an extra state path rides along with the authorization', () => {
  const s = buildScenario({
    prefix: 'h11',
    recordPatch: (r) => ({
      ...r,
      authorizedStateArtifacts: [...r.authorizedStateArtifacts, {
        cohortRole: 'CHECKPOINT',
        repoRelativePath: `governance/gates/${SUBJECT_GATE}/state/revisions/R0002/CHECKPOINT.json`,
        sha256: 'a'.repeat(64), byteLength: 10
      }]
    })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H11');
});

test('H12 a cross-Gate path is smuggled into the state cohort', () => {
  const s = buildScenario({
    prefix: 'h12',
    recordPatch: (r) => ({
      ...r,
      authorizedStateArtifacts: r.authorizedStateArtifacts.map((a) => (a.cohortRole === 'CHECKPOINT'
        ? { ...a, repoRelativePath: `governance/gates/${DEPENDENCY_GATE}/state/revisions/R0001/CHECKPOINT.json` }
        : a))
    })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H12');
});

test('H13 a GEE R8 path is smuggled into the derived cohort', () => {
  const s = buildScenario({
    prefix: 'h13',
    recordPatch: (r) => ({
      ...r,
      authorizedDerivedArtifacts: r.authorizedDerivedArtifacts.map((a) => (a.cohortRole === 'ACTIVE_GATE'
        ? { ...a, repoRelativePath: 'governance/gee-v1/revisions/R8/GEE_R8.json' }
        : a))
    })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H13');
});

test('H14 a governance/** wildcard is not an authorizable path', () => {
  const s = buildScenario({
    prefix: 'h14',
    recordPatch: (r) => ({
      ...r,
      authorizedDerivedArtifacts: r.authorizedDerivedArtifacts.map((a) => (a.cohortRole === 'ACTIVE_GATE'
        ? { ...a, repoRelativePath: 'governance/**' }
        : a))
    })
  });
  assertBlockedWith(runLedger(s), 'INVALID_GATE_AUTHORIZATION_RECORD', 'H14');
});

test('H15 malformed CHECKPOINT bytes break the approved state cohort', () => {
  const s = buildScenario({
    prefix: 'h15',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.CHECKPOINT, '{ not json')
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', 'H15');
});

test('H16 malformed OPEN_DEFECTS bytes break the approved state cohort', () => {
  const s = buildScenario({
    prefix: 'h16',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.OPEN_DEFECTS, '{ "defects": ')
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', 'H16');
});

test('H17 fake KNOWN_ZERO without valid sealed provenance resolves UNKNOWN (M2)', () => {
  // A real repository copy, with GATE13's OPEN_DEFECTS removed from its seal's
  // sealedMembers. The file itself still parses as a perfectly clean {"defects": []}.
  const root = mkSandbox('h17');
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });

  const before = createWheelProjectAdapter(root).getWorkUnitView('GATE13');
  assert.equal(before.defectsOpenKnowledge, 'KNOWN_ZERO', 'sanity: the untouched copy must still read KNOWN_ZERO');

  const currentState = JSON.parse(fs.readFileSync(path.join(root, 'governance/gates/GATE13/state/CURRENT_STATE.json'), 'utf8'));
  const sealAbs = path.join(root, ...currentState.revisionPath.split('/'), 'STATE_SEAL.json');
  const seal = JSON.parse(fs.readFileSync(sealAbs, 'utf8'));
  const defectsRel = `governance/gates/GATE13/state/revisions/${currentState.stateRevision}/OPEN_DEFECTS.json`;
  seal.sealedMembers = seal.sealedMembers.filter((m) => m.repoRelativePath !== defectsRel);
  seal.payloadSha256 = sha256Canonical(seal.payload);
  fs.writeFileSync(sealAbs, `${JSON.stringify(seal, null, 2)}\n`);
  // Re-point CURRENT_STATE at the rewritten seal so the seal layer still verifies:
  // this isolates "not a sealed member" from "seal is broken".
  currentState.stateSealSha256 = sha256Bytes(fs.readFileSync(sealAbs));
  fs.writeFileSync(path.join(root, 'governance/gates/GATE13/state/CURRENT_STATE.json'), `${JSON.stringify(currentState, null, 2)}\n`);

  const after = createWheelProjectAdapter(root).getWorkUnitView('GATE13');
  assert.equal(after.defectsOpenKnowledge, 'UNKNOWN', 'unsealed OPEN_DEFECTS must never assert KNOWN_ZERO');
  assert.equal(after.defectsOpenCount, null);
  // Which of M2's four gates fires first is not the claim under test; that no path
  // reaches KNOWN_ZERO without verified sealed provenance is. Here gate (1) fires,
  // because validate-state-seal independently requires OPEN_DEFECTS membership, so
  // removing it also invalidates the seal. Gates (2)-(4) remain as non-redundant
  // defence in depth for any seal verified under different membership rules.
  assert.match(after.defectsValidationReason, /^(DEFECTS_PROVENANCE_UNVERIFIED:|OPEN_DEFECTS_NOT_A_SEALED_MEMBER$)/);
});

test('H17b OPEN_DEFECTS mutated after sealing also resolves UNKNOWN (M2)', () => {
  const root = mkSandbox('h17b');
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });

  const before = createWheelProjectAdapter(root).getWorkUnitView('GATE13');
  assert.equal(before.defectsOpenKnowledge, 'KNOWN_ZERO');

  // A syntactically perfect, still-clean OPEN_DEFECTS whose bytes are simply not
  // the bytes that were sealed. It parses to defects: [] exactly as before.
  const currentState = JSON.parse(fs.readFileSync(path.join(root, 'governance/gates/GATE13/state/CURRENT_STATE.json'), 'utf8'));
  const defectsAbs = path.join(root, ...currentState.revisionPath.split('/'), 'OPEN_DEFECTS.json');
  const defects = JSON.parse(fs.readFileSync(defectsAbs, 'utf8'));
  fs.writeFileSync(defectsAbs, `${JSON.stringify({ ...defects, defects: [] }, null, 4)}\n`);

  const after = createWheelProjectAdapter(root).getWorkUnitView('GATE13');
  assert.equal(after.defectsOpenKnowledge, 'UNKNOWN', 'bytes that were never sealed must never assert KNOWN_ZERO');
  assert.equal(after.defectsOpenCount, null);
});

test('H18 CHECKPOINT changed after signature', () => {
  const s = buildScenario({
    prefix: 'h18',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.CHECKPOINT, JSON.stringify({ gateId: SUBJECT_GATE, tampered: true }, null, 2))
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', 'H18');
});

test('H19 OPEN_DEFECTS changed after signature', () => {
  const s = buildScenario({
    prefix: 'h19',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.OPEN_DEFECTS, JSON.stringify({ gateId: SUBJECT_GATE, stateRevision: 'R0001', defects: [{ id: 'D1', status: 'OPEN' }] }, null, 2))
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', 'H19');
});

test('H20 STATE_SEAL changed after signature', () => {
  const s = buildScenario({
    prefix: 'h20',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.STATE_SEAL, JSON.stringify({ gateId: SUBJECT_GATE, tampered: true }, null, 2))
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_STATE_ARTIFACT_BYTES_CHANGED', 'H20');
});

test('H21 CURRENT_STATE changed after signature', () => {
  const s = buildScenario({
    prefix: 'h21',
    mutateAfterSignature: ({ root, statePaths, writeFile: w }) => w(root, statePaths.CURRENT_STATE, JSON.stringify({ gateId: SUBJECT_GATE, tampered: true }, null, 2))
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_CURRENT_STATE_REVISION_INVALID', 'H21');
});

test('H22 wrong contract SHA', () => {
  const s = buildScenario({ prefix: 'h22', contractSha256Override: 'a'.repeat(64) });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_CONTRACT_SHA_MISMATCH', 'H22');
});

test('H23 wrong CURRENT_CONTRACT SHA', () => {
  const s = buildScenario({ prefix: 'h23', currentContractSha256Override: 'b'.repeat(64) });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_CONTRACT_SHA_MISMATCH', 'H23');
});

test('H24 dependency mismatch: the cited predecessor status is not what the ledger replays', () => {
  const s = buildScenario({
    prefix: 'h24',
    dependencyProofPatch: { status: 'COMPLETE_CONFIRMED' }
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', 'H24');
});

test('H25 unsigned / invalid owner signature', () => {
  const unsigned = buildScenario({ prefix: 'h25a', omitSignature: true });
  assertBlockedWith(runLedger(unsigned), 'GATE_AUTHORIZATION_UNAUTHORIZED', 'H25 unsigned');

  const wrongKey = buildScenario({ prefix: 'h25b', signWithWrongKey: true });
  assertBlockedWith(runLedger(wrongKey), 'GATE_AUTHORIZATION_OWNER_SIGNATURE_INVALID', 'H25 wrong key');
});

test('H26 expired authority, judged against the event recordedAt', () => {
  const s = buildScenario({
    prefix: 'h26',
    requestPatch: (r) => ({ ...r, expiresAtUtc: '2026-08-09T00:00:00.000Z' })
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_EXPIRED', 'H26');
});

test('H27 replay after consumption is refused at the pre-write decision', () => {
  const s = buildScenario({ prefix: 'h27' });
  const observed = {
    projectId: 'WHEEL', gateId: s.gateId, headCommit: s.record.baseCommit,
    preLedgerSha256: s.preLedgerSha256, previousEventSha256: s.previousEventSha256,
    currentStatus: GATE_AUTHORIZATION_FROM_STATUS,
    contractSha256: s.contractSha, currentContractSha256: s.currentContractSha, currentContractPresent: true,
    dependencyProof: s.dependencyProof,
    artifactSha256: Object.fromEntries([...s.stateArtifacts, ...s.derivedArtifacts].map((a) => [a.repoRelativePath, a.sha256])),
    artifactByteLength: Object.fromEntries([...s.stateArtifacts, ...s.derivedArtifacts].map((a) => [a.repoRelativePath, a.byteLength])),
    competingAuthorityCount: 1,
    // The authorization has already been spent: the event exists in the ledger.
    existingAuthorizationEventCount: 1,
    consumed: true
  };
  const result = evaluateGateAuthorizationAuthority({
    record: s.record, request: s.request, authority: s.authority,
    ownerKey: { keyId: TEST_OWNER_KEY_ID, publicKeyPem: TEST_PUBLIC_KEY_PEM },
    observed, now: new Date(T_AUTHORIZATION)
  });
  assert.equal(result.decision, 'BLOCKED');
  const codes = result.findings.map((f) => f.code);
  assert.ok(codes.includes('AUTHORITY_ALREADY_CONSUMED'), JSON.stringify(codes));
  assert.ok(codes.includes('GATE_ALREADY_AUTHORIZED'), JSON.stringify(codes));
});

test('H28 competing authorities are refused rather than arbitrated', () => {
  const s = buildScenario({ prefix: 'h28' });
  const result = evaluateGateAuthorizationAuthority({
    record: s.record, request: s.request, authority: s.authority,
    ownerKey: { keyId: TEST_OWNER_KEY_ID, publicKeyPem: TEST_PUBLIC_KEY_PEM },
    observed: { projectId: 'WHEEL', gateId: s.gateId, competingAuthorityCount: 2 },
    now: new Date(T_AUTHORIZATION)
  });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.map((f) => f.code).includes('COMPETING_GATE_AUTHORIZATION_AUTHORITIES'));
});

test('H29 missing owner authority snapshot / malformed event payload', () => {
  const missing = buildScenario({ prefix: 'h29a', omitOwnerAuthoritySnapshot: true });
  assertBlockedWith(runLedger(missing), 'GATE_AUTHORIZATION_OWNER_AUTHORITY_MISSING', 'H29 missing snapshot');

  // A malformed record is not a usable authorization payload.
  const malformed = buildScenario({ prefix: 'h29b' });
  fs.writeFileSync(path.join(malformed.root, ...malformed.recordRel.split('/')), '{ broken');
  const report = runLedger(malformed);
  assert.equal(report.valid, false);
  assert.ok(blockingIds(report).includes('AUTHORITY_HASH_MISMATCH'), JSON.stringify(blockingIds(report)));
});

test('H30 a GATE_AUTHORIZATION_RECORD used to authorize START is refused', () => {
  const s = buildScenario({
    prefix: 'h30',
    eventTransitionType: 'START',
    eventFromStatus: 'AUTHORIZED_NOT_STARTED',
    eventToStatus: 'IN_PROGRESS',
    subjectGenesisStatus: 'AUTHORIZED_NOT_STARTED'
  });
  const report = runLedger(s);
  assert.equal(report.valid, false);
  assert.ok(blockingIds(report).includes('GATE_AUTHORIZATION_RECORD_TRANSITION_BORROWED'), `H30: got ${JSON.stringify(blockingIds(report))}`);
});

test('H31 event-chain previous hash mismatch', () => {
  const s = buildScenario({ prefix: 'h31', breakPreviousEventSha: true });
  assertBlockedWith(runLedger(s), 'LEDGER_CHAIN_BREAK', 'H31');
});

test('H32 timestamp / signature mutation after signing', () => {
  const timestamp = buildScenario({
    prefix: 'h32a',
    authorityPatchAfterSigning: (a) => ({ ...a, issuedAtUtc: '2026-07-01T00:00:00.000Z' })
  });
  assertBlockedWith(runLedger(timestamp), 'GATE_AUTHORIZATION_OWNER_SIGNATURE_INVALID', 'H32 timestamp');

  const signature = buildScenario({
    prefix: 'h32b',
    authorityPatchAfterSigning: (a) => ({ ...a, signature: Buffer.from('forged-signature-bytes-padding').toString('base64') })
  });
  assertBlockedWith(runLedger(signature), 'GATE_AUTHORIZATION_OWNER_SIGNATURE_INVALID', 'H32 signature');
});

test('H32B record recordedAt mutation without owner re-signature is refused', () => {
  const s = buildScenario({ prefix: 'h32b-recorded-at-record' });
  const mutatedRecord = { ...s.record, recordedAt: '2026-08-10T00:00:01.000Z' };
  rewriteAuthorizationLedger(s, { record: mutatedRecord });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_RECORDED_AT_MISMATCH', 'H32B record recordedAt');
});

test('H32C event recordedAt mutation without owner re-signature is refused', () => {
  const s = buildScenario({ prefix: 'h32c-recorded-at-event' });
  rewriteAuthorizationLedger(s, {
    eventPatch: (event) => ({ ...event, recordedAt: '2026-08-10T00:00:01.000Z' })
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_RECORDED_AT_MISMATCH', 'H32C event recordedAt');
});

test('H32D a coherent owner-approved recordedAt change remains valid', () => {
  const recordedAt = '2026-08-10T00:00:01.000Z';
  const s = buildScenario({
    prefix: 'h32d-recorded-at-resigned',
    recordPatch: (record) => ({ ...record, recordedAt }),
    eventRecordedAt: recordedAt
  });
  const report = runLedger(s);
  assert.deepEqual(blockingIds(report), [], JSON.stringify(report.findings.filter((finding) => finding.severity === 'BLOCKING'), null, 2));
  assert.equal(report.valid, true);
});

// ===========================================================================
// INVARIANTS — the real repository is never mutated by this suite
// ===========================================================================

test('the real repository ledger remains valid, 57 events, unchanged digest', () => {
  // The Wheel policy is required exactly as the CLI supplies it: without a project
  // policy the generic core can never assert an external reinspection verdict, so
  // COMPLETE_CONFIRMED events fail closed. That is pre-existing, correct behavior.
  const report = validateLedger({
    root: REPO_ROOT,
    ledgerPath: path.join(REPO_ROOT, ...LEDGER_REL.split('/')),
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  assert.equal(report.valid, true);
  assert.equal(report.events.length, 57);
  assert.equal(report.ledgerSha256, 'c4dfefd7790cfc30f3f13a5159362b03b9902273ac6b3d7db8ab5dba6ba6ab6b');
  assert.equal(report.events.filter((e) => e.transitionType === GATE_AUTHORIZATION_TRANSITION_TYPE).length, 1);
  assert.equal(report.gates.find((g) => g.gateId === 'GATE14').currentStatus, 'AUTHORIZED_NOT_STARTED');
});

test('no new status was introduced, and the closed I2 execution table is untouched', () => {
  // The closed I2 execution table is still exactly 21 transitions. Contract
  // succession did NOT widen it: it is a third narrow class, added the same way
  // HISTORICAL_RECONCILIATION was, with its own table and its own obligations.
  assert.equal(TRANSITIONS.length, 21);
  assert.equal(NORMAL_EXECUTION_TRANSITION_TYPES.length, 15);
  assert.equal(TRANSITION_TYPES.length, 17);
  assert.equal(TRANSITIONS.filter(([, , type]) => type === GATE_AUTHORIZATION_TRANSITION_TYPE).length, 1);
  assert.deepEqual(
    TRANSITIONS.find(([, , type]) => type === GATE_AUTHORIZATION_TRANSITION_TYPE),
    ['NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'AUTHORIZATION']
  );

  // NO NEW STATUS. This is the property that actually matters: a new transition
  // class must not create a new place a Gate can be.
  assert.deepEqual(STATUSES, [
    'NOT_STARTED', 'AUTHORIZED_NOT_STARTED', 'IN_PROGRESS', 'REPAIR_REQUIRED',
    'BLOCKED_GOVERNANCE', 'INTERRUPTED_RESUMABLE', 'COMPLETE_AGENT',
    'COMPLETE_CONFIRMED', 'SUPERSEDED', 'REOPENED_AUTHORIZED'
  ]);

  // The succession class cannot borrow execution permissions, and its single
  // entry is a SELF-transition: it reaches no status the Gate was not already in,
  // so it can never start, close or confirm a Gate.
  assert.equal(NORMAL_EXECUTION_TRANSITION_TYPES.includes(CONTRACT_SUCCESSION_TRANSITION_TYPE), false);
  assert.equal(TRANSITIONS.some(([, , type]) => type === CONTRACT_SUCCESSION_TRANSITION_TYPE), false);
  assert.deepEqual(CONTRACT_SUCCESSION_TRANSITIONS, [['IN_PROGRESS', 'IN_PROGRESS', 'CONTRACT_SUCCESSION']]);
  for (const [from, to] of CONTRACT_SUCCESSION_TRANSITIONS) {
    assert.equal(from, to, 'a succession must never move a Gate to a different status');
    assert.ok(STATUSES.includes(to));
  }
});

// ===========================================================================
// DEPENDENCY AUTHORITY IDENTITY RESOLUTION
//
// A dependency proof's authorityPath is not free-form: it must be exactly what the
// dependency Gate's TERMINAL ledger event records. That value may legitimately be a
// declared EXTERNAL AUTHORITY IDENTITY rather than a governed repository-relative
// path. Permanent re-verification therefore resolves it through the SAME declaration
// policy the canonical transition-authority resolver uses. Reading it unconditionally
// as a path made such a proof unsatisfiable: pre-write demanded the identity, while
// permanent validation demanded a file, so no single value could satisfy both.
//
// Identity and resolved bytes stay separate concepts — the identity is never rewritten
// into the declaration's path — and every resolution failure is fail-closed.
// ===========================================================================

const EXTERNAL_IDENTITY = 'TEST-DEP-INDEPENDENT-VERDICT-20260808-093157';
const DEPENDENCY_AUTHORITY_REL = `governance/gates/${DEPENDENCY_GATE}/closure/AGENT_CLOSURE_REPORT.json`;

/** Asserts the dependency branch blocked for the stated reason, not merely that it blocked. */
function assertDependencyBlockedBecause(report, fragment, label) {
  assertBlockedWith(report, 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', label);
  const messages = report.findings
    .filter((f) => f.detectorId === 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH')
    .map((f) => f.message);
  assert.ok(
    messages.some((m) => m.includes(fragment)),
    `${label}: expected a dependency finding mentioning "${fragment}", got ${JSON.stringify(messages)}`
  );
}

test('D-R01 a dependency proof citing a declared external authority identity validates permanently', () => {
  const s = buildScenario({ prefix: 'dr01', dependencyAuthorityIdentity: EXTERNAL_IDENTITY });
  assert.equal(s.dependencyProof.authorityPath, EXTERNAL_IDENTITY, 'the proof must carry the identity verbatim');
  assert.notEqual(s.dependencyProof.authorityPath, s.dependencyAuthorityRel, 'the identity must not be rewritten into the declared path');
  const report = runLedger(s);
  assert.equal(report.valid, true, `expected a valid ledger, got ${JSON.stringify(blockingIds(report))}`);
  assert.ok(report.findings.some((f) => f.detectorId === 'GATE_AUTHORIZATION_APPLIED'), 'the authorization must be applied');
});

test('D-R02 the dependency hash is verified against the RESOLVED evidence bytes, never the declaration', () => {
  // The declaration points at REAL, present evidence but claims a hash those bytes do
  // not reproduce. Resolution therefore succeeds and every other guard is satisfied —
  // the proof's own sha256 matches both the live bytes and the terminal event — so only
  // the "declaration never outranks its bytes" rule can catch this.
  const s = buildScenario({
    prefix: 'dr02',
    dependencyAuthorityIdentity: EXTERNAL_IDENTITY,
    externalAuthorityDeclarationsOverride: [
      { authorityId: EXTERNAL_IDENTITY, classification: 'CANONICAL_EVIDENCE', path: DEPENDENCY_AUTHORITY_REL, sha256: 'e'.repeat(64) }
    ]
  });
  assert.equal(s.dependencyProof.authoritySha256, s.dependencyAuthoritySha, 'the proof itself must be internally correct');
  assertDependencyBlockedBecause(runLedger(s), 'could not be resolved to trusted evidence', 'D-R02');
});

test('D-R03 an undeclared external identity resolves to nothing and blocks', () => {
  const s = buildScenario({
    prefix: 'dr03',
    dependencyAuthorityIdentity: EXTERNAL_IDENTITY,
    externalAuthorityDeclarationsOverride: []
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', 'D-R03');
});

test('D-R04 a declared identity whose evidence is missing blocks', () => {
  const s = buildScenario({
    prefix: 'dr04',
    dependencyAuthorityIdentity: EXTERNAL_IDENTITY,
    externalAuthorityDeclarationsOverride: [
      { authorityId: EXTERNAL_IDENTITY, classification: 'CANONICAL_EVIDENCE', path: 'governance/authority/snapshots/ABSENT.json', sha256: 'f'.repeat(64) }
    ]
  });
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', 'D-R04');
});

test('D-R05 competing declarations for one identity are refused rather than arbitrated', () => {
  const s = buildScenario({ prefix: 'dr05', dependencyAuthorityIdentity: EXTERNAL_IDENTITY });
  // Re-declare the SAME identity twice, both pointing at real, hash-matching evidence.
  const sourceMap = JSON.parse(readBytes(s.root, SOURCE_MAP_REL).toString('utf8'));
  sourceMap.externalAuthorities = [
    { authorityId: EXTERNAL_IDENTITY, classification: 'CANONICAL_EVIDENCE', path: s.dependencyAuthorityRel, sha256: s.dependencyAuthoritySha },
    { authorityId: EXTERNAL_IDENTITY, classification: 'CANONICAL_EVIDENCE', path: s.dependencyAuthorityRel, sha256: s.dependencyAuthoritySha }
  ];
  writeFile(s.root, SOURCE_MAP_REL, JSON.stringify(sourceMap, null, 2));
  assertBlockedWith(runLedger(s), 'GATE_AUTHORIZATION_DEPENDENCY_MISMATCH', 'D-R05');
});

test('D-R06 substituting the declaration path for the identity blocks: the proof must be the terminal event representation', () => {
  const s = buildScenario({
    prefix: 'dr06',
    dependencyAuthorityIdentity: EXTERNAL_IDENTITY,
    // A governed path that resolves to the very same bytes with the very same hash —
    // and yet is NOT the identity the terminal event records. Only the terminal-event
    // equality rule can refuse it, which is exactly what keeps pre-write and permanent
    // validation answering the same question about the same value.
    dependencyProofPatch: { authorityPath: DEPENDENCY_AUTHORITY_REL }
  });
  assertDependencyBlockedBecause(runLedger(s), 'the dependency Gate terminal event actually records', 'D-R06');
});

test('D-R07 a governed repository-relative dependency authority still validates unchanged', () => {
  const s = buildScenario({ prefix: 'dr07' });
  assert.ok(s.dependencyProof.authorityPath.includes('/'), 'the default scenario must use a governed relative path');
  const report = runLedger(s);
  assert.equal(report.valid, true, `expected a valid ledger, got ${JSON.stringify(blockingIds(report))}`);
});

test('real GATE14 canonical authorization state is present and valid', () => {
  for (const rel of [
    gateAuthorizationRecordPath('GATE14'),
    gateAuthorizationAuthoritySnapshotPath('GATE14'),
    ...Object.values(gateAuthorizationStateCohortPaths('GATE14'))
  ]) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, ...rel.split('/'))), true, `${rel} must exist`);
  }
});
