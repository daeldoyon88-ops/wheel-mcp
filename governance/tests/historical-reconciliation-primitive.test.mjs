/**
 * HISTORICAL RECONCILIATION PRIMITIVE — architecture proof.
 *
 * This suite proves the narrow HISTORICAL_RECONCILIATION transition class can truthfully represent
 * "the imported status was a conservative UNRESOLVED_STATUS_FALLBACK; authentic historical authority
 * has since been recovered; no new execution occurred" — and that it fails closed everywhere else.
 *
 * Everything runs in throwaway sandboxes below the OS temp dir. The real repository ledger is
 * read only to prove its append-only historical prefix and the one authorized reconciliation
 * cohort; no test mutates it.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateLedger,
  validateLedgerPrefix,
  TRANSITIONS,
  TRANSITION_TYPES,
  NORMAL_EXECUTION_TRANSITION_TYPES,
  HISTORICAL_RECONCILIATION_TRANSITIONS,
  HISTORICAL_RECONCILIATION_TRANSITION_TYPE,
  HISTORICAL_RECONCILIATION_RECORD_REQUIRED_FIELDS,
  HISTORICAL_RECONCILIATION_RECORD_OPTIONAL_FIELDS,
  HISTORICAL_EVIDENCE_GOVERNED_ROOT,
  HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_SCHEMA_PATH,
  EVIDENCE_COHORT_DIGEST_ALGORITHM,
  classifyHistoricalEvidencePath,
  computeEvidenceCohortDigest,
  isCanonicalGovernedPathUnicode,
  resolveHistoricalEvidenceFilesystemPath
} from '../tools/validate-status-ledger.mjs';
import { canonicalize, sha256Canonical, sha256Bytes } from '../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../gee-v1/contracts/validate-against-json-schema.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVENT_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'gate-status-event.schema.json'), 'utf8'));
const RECORD_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'historical-reconciliation.schema.json'), 'utf8'));
const OWNER_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance', 'schemas', 'historical-reconciliation-owner-authorization.schema.json'), 'utf8'));

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) fs.rmSync(dir, { recursive: true, force: true });
});

function mkSandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hrc-${prefix}-`));
  sandboxes.push(dir);
  return dir;
}

function writeFile(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
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

function ledgerBytes(sealed) {
  return Buffer.from(`${sealed.map((e) => canonicalize(e)).join('\n')}\n`, 'utf8');
}

const LEDGER_REL = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const REGISTRY_REL = 'governance/GATE_REGISTRY_00_40.json';
const SOURCE_MAP_REL = 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json';
const OWNER_REL = 'governance/sources/HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_R1.json';

const DISPOSITION_STATUS = { COMPLETE: 'COMPLETE_AGENT', PARTIAL: 'INTERRUPTED_RESUMABLE' };

/**
 * Builds a complete, byte-consistent sandbox: registry, genesis source map documenting the
 * UNRESOLVED_STATUS_FALLBACK, imported evidence cohort files, PROJECT_OWNER authorization,
 * reconciliation record, and an append-only ledger (genesis event, optional intervening events,
 * reconciliation event). Every hostile case below is this same scenario with exactly one thing
 * broken, so a failure can only be attributed to that one thing.
 */
function buildScenario({
  prefix = 'case',
  gateId = 'GATE00',
  historicalDisposition = 'COMPLETE',
  fromStatus = 'NOT_STARTED',
  toStatus = null,
  transitionType = HISTORICAL_RECONCILIATION_TRANSITION_TYPE,
  cohort = null,
  omitCohortFiles = [],
  reconciliationId = null,
  // When set, the PROJECT_OWNER approves this literal cohort digest instead of the digest of the
  // cohort the record actually carries — i.e. the owner approved evidence set E1 and the record
  // then tries to reconcile with a different evidence set E2.
  ownerApprovedDigest = null,
  recordPatch = null,
  ownerPatch = null,
  sourceMapGatePatch = null,
  midEvents = [],
  recordRelPath = null,
  ownerRelPath = OWNER_REL,
  writeOwnerFile = true,
  ledgerBytesPatch = null
} = {}) {
  const root = mkSandbox(prefix);
  const targetStatus = toStatus ?? DISPOSITION_STATUS[historicalDisposition] ?? 'COMPLETE_AGENT';
  const recordReconciliationId = reconciliationId ?? `HISTORICAL_RECONCILIATION_${gateId}_R1`;

  const registry = { schemaVersion: 1, gates: [{ gateId, canonicalObjective: `objective for ${gateId}`, dependencies: [], definitionCompleteness: 'PARTIAL' }] };
  writeFile(root, REGISTRY_REL, JSON.stringify(registry, null, 2));
  const registrySha = sha256Bytes(fs.readFileSync(path.join(root, REGISTRY_REL)));

  let sourceMapGate = {
    gateId,
    importedStatus: fromStatus,
    sourceAuthorityPath: REGISTRY_REL,
    sourceAuthoritySha256: registrySha,
    sourcePointer: `/gates/${gateId}`,
    statusDerivation: 'NO_RESOLVABLE_HISTORICAL_STATUS_AUTHORITY_AT_BOOTSTRAP',
    confidenceClass: 'UNRESOLVED_STATUS_FALLBACK',
    historicalDetailCompleteness: 'UNKNOWN',
    fabricatedTransitionCount: 0,
    authorityKind: 'IMPORTED_EVIDENCE',
    unresolvedHistoricalDetails: ['execution chronology', 'closure evidence']
  };
  if (sourceMapGatePatch) sourceMapGate = sourceMapGatePatch({ ...sourceMapGate });
  writeFile(root, SOURCE_MAP_REL, JSON.stringify({
    document: 'GENESIS_IMPORT_SOURCE_MAP',
    schemaVersion: 1,
    artifactClass: 'DETERMINISTIC_RECONSTRUCTION_AUTHORITY',
    historicalOriginal: false,
    reconstructionRuleId: 'GENESIS_IMPORT_SOURCE_MAP_DETERMINISTIC_RECONSTRUCTION_RULE_R2',
    policy: 'sandbox fixture',
    externalAuthorities: [],
    gates: [sourceMapGate]
  }, null, 2));
  const sourceMapSha = sha256Bytes(fs.readFileSync(path.join(root, SOURCE_MAP_REL)));

  const cohortSpec = cohort ?? [
    {
      gateId,
      evidenceRole: 'STATUS_DISPOSITION_AUTHORITY',
      historicalLocator: `C:\\Users\\owner\\AppData\\Local\\Temp\\gate-archaeology\\${gateId}_FINAL_AGENT_REPORT.md`,
      governedPath: `governance/authority/historical/${gateId}/${gateId}_FINAL_AGENT_REPORT.md`,
      content: `# ${gateId} final agent report\nrecovered historical disposition: ${historicalDisposition}\n`
    }
  ];
  const cohortItems = [];
  for (const item of cohortSpec) {
    const bytes = Buffer.from(item.content, 'utf8');
    if (!omitCohortFiles.includes(item.governedPath)) writeFile(root, item.governedPath, bytes);
    cohortItems.push({
      gateId: item.gateId ?? gateId,
      evidenceRole: item.evidenceRole,
      historicalLocator: item.historicalLocator,
      governedPath: item.governedPath,
      byteLength: bytes.length,
      sha256: sha256Bytes(bytes)
    });
  }

  // The identity of the evidence set the owner is about to approve, derived the same way the
  // validator derives it — never copied from anything the record declares about itself.
  const declaredCohortDigest = computeEvidenceCohortDigest(cohortItems).digest;
  const approvedCohortDigest = ownerApprovedDigest ?? declaredCohortDigest;

  let owner = {
    document: 'HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION',
    schemaVersion: 1,
    authorityId: 'HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_R1',
    authorityClass: 'PROJECT_OWNER_HISTORICAL_RECONCILIATION_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: '2026-08-10T00:00:00.000Z',
    reexecutionAuthorized: false,
    externalConfirmationGranted: false,
    authorizedReconciliations: [{
      reconciliationId: recordReconciliationId,
      gateId,
      historicalDisposition,
      canonicalCurrentStatus: targetStatus,
      evidenceCohortDigest: approvedCohortDigest
    }],
    reason: 'Historical archaeology recovered authentic authority for this gate.'
  };
  if (ownerPatch) owner = ownerPatch({ ...owner }, { reconciliationId: recordReconciliationId, gateId, historicalDisposition, targetStatus, evidenceCohortDigest: approvedCohortDigest });
  if (writeOwnerFile) writeFile(root, ownerRelPath, JSON.stringify(owner, null, 2));
  const ownerSha = writeOwnerFile ? sha256Bytes(fs.readFileSync(path.join(root, ownerRelPath))) : '0'.repeat(64);

  const genesisDraft = {
    schemaVersion: 1,
    eventId: `GENESIS_IMPORT_${gateId}`,
    gateId,
    fromStatus: null,
    toStatus: fromStatus,
    transitionType: 'GENESIS_IMPORT',
    authorityPath: REGISTRY_REL,
    authoritySha256: registrySha,
    recordedAt: '2026-08-01T16:00:00.000Z'
  };
  const genesisSealed = sealEvents([genesisDraft])[0];

  let record = {
    schemaVersion: 1,
    document: 'HISTORICAL_RECONCILIATION_RECORD',
    reconciliationId: recordReconciliationId,
    gateId,
    recordedAt: '2026-08-10T12:00:00.000Z',
    supersededGenesisEventId: genesisSealed.eventId,
    supersededGenesisEventPayloadSha256: genesisSealed.eventPayloadSha256,
    originalImportedStatus: fromStatus,
    originalStatusBasis: 'UNRESOLVED_STATUS_FALLBACK',
    originalStatusBasisSourcePath: SOURCE_MAP_REL,
    originalStatusBasisSourceSha256: sourceMapSha,
    historicalDisposition,
    canonicalCurrentStatus: targetStatus,
    newExecutionOccurred: false,
    externalConfirmationEstablished: false,
    ownerAuthorizationPath: ownerRelPath,
    ownerAuthorizationSha256: ownerSha,
    authorityCohort: cohortItems,
    evidenceCohortDigest: declaredCohortDigest,
    reason: 'The genesis import recorded a conservative unresolved-status fallback; authentic historical authority has since been recovered and is bound by hash. No gate execution occurred.'
  };
  if (historicalDisposition === 'PARTIAL') {
    const residualItem = cohortItems.find((c) => c.evidenceRole === 'RESIDUAL_OBLIGATION_EVIDENCE') ?? cohortItems[0];
    record.residualObligation = {
      description: 'Interrupted before closure evidence was produced; the remaining obligation must be resumed, not assumed discharged.',
      evidenceGovernedPath: residualItem.governedPath,
      evidenceSha256: residualItem.sha256
    };
  }
  if (recordPatch) record = recordPatch({ ...record }, { genesisSealed, cohortItems, sourceMapSha, ownerSha });
  // A cohort mutation leaves the record internally consistent by default, so a hostile case proves
  // the OWNER binding failed rather than merely that the record contradicted itself. A case that
  // deliberately breaks the record's own declaration overrides evidenceCohortDigest in its patch.
  if (record.evidenceCohortDigest === declaredCohortDigest) {
    record.evidenceCohortDigest = computeEvidenceCohortDigest(record.authorityCohort).digest ?? declaredCohortDigest;
  }

  const recordRel = recordRelPath ?? `governance/authority/reconciliation/${gateId}_HISTORICAL_RECONCILIATION_R1.json`;
  writeFile(root, recordRel, JSON.stringify(record, null, 2));
  const recordSha = sha256Bytes(fs.readFileSync(path.join(root, recordRel)));

  const drafts = [genesisDraft];
  let clock = 2;
  for (const mid of midEvents) {
    drafts.push({
      schemaVersion: 1,
      eventId: `${mid.transitionType}_${gateId}`,
      gateId,
      fromStatus: mid.fromStatus,
      toStatus: mid.toStatus,
      transitionType: mid.transitionType,
      authorityPath: REGISTRY_REL,
      authoritySha256: registrySha,
      recordedAt: `2026-08-0${clock}T16:00:00.000Z`
    });
    clock += 1;
  }
  drafts.push({
    schemaVersion: 1,
    eventId: `HISTORICAL_RECONCILIATION_${gateId}`,
    gateId,
    fromStatus: midEvents.length ? midEvents.at(-1).toStatus : fromStatus,
    toStatus: targetStatus,
    transitionType,
    authorityPath: recordRel,
    authoritySha256: recordSha,
    recordedAt: '2026-08-10T12:00:00.000Z'
  });

  const sealed = sealEvents(drafts);
  const bytes = ledgerBytesPatch ? ledgerBytesPatch(ledgerBytes(sealed), sealed) : ledgerBytes(sealed);
  writeFile(root, LEDGER_REL, bytes);

  const ledgerPath = path.join(root, LEDGER_REL);
  return {
    root,
    ledgerPath,
    recordRel,
    record,
    owner,
    sealed,
    genesisSealed,
    registrySha,
    sourceMapSha,
    cohortItems,
    report: validateLedger({ root, ledgerPath })
  };
}

function detectorIds(report) {
  return report.findings.map((f) => `${f.detectorId}:${f.severity}`);
}

function assertBlocking(report, detectorId) {
  assert.equal(report.valid, false, `expected invalid ledger, findings=${JSON.stringify(detectorIds(report))}`);
  assert.ok(
    report.findings.some((f) => f.detectorId === detectorId && f.severity === 'BLOCKING'),
    `expected BLOCKING ${detectorId}; got ${JSON.stringify(detectorIds(report))}`
  );
  assert.ok(
    !report.findings.some((f) => f.detectorId === 'HISTORICAL_RECONCILIATION_APPLIED'),
    'a rejected reconciliation must never report itself as applied'
  );
}

function assertApplied(report, { gateId, expectedStatus, historicalDisposition }) {
  assert.equal(report.valid, true, `expected valid ledger, findings=${JSON.stringify(report.findings)}`);
  const applied = report.findings.find((f) => f.detectorId === 'HISTORICAL_RECONCILIATION_APPLIED');
  assert.ok(applied, 'reconciliation should be reported as applied');
  assert.equal(applied.severity, 'INFO');
  assert.match(applied.message, new RegExp(`historicalDisposition=${historicalDisposition}`));
  assert.deepEqual(report.gates.find((g) => g.gateId === gateId), { gateId, currentStatus: expectedStatus });
}

// ===========================================================================
// ARCHITECTURE PARITY — the schema and the normative validator must agree, and
// the normal execution class must be provably untouched.
// ===========================================================================

test('ARCH-01: the event schema transitionType enum matches the validator transition types exactly', () => {
  assert.deepEqual(EVENT_SCHEMA.properties.transitionType.enum, TRANSITION_TYPES);
  assert.ok(TRANSITION_TYPES.includes(HISTORICAL_RECONCILIATION_TRANSITION_TYPE));
});

test('ARCH-02: the closed I2 execution table is unchanged — 21 transitions, none of them reconciliation', () => {
  assert.equal(TRANSITIONS.length, 21);
  assert.equal(NORMAL_EXECUTION_TRANSITION_TYPES.length, 15);
  assert.ok(TRANSITIONS.every(([, , type]) => type !== HISTORICAL_RECONCILIATION_TRANSITION_TYPE));
  assert.ok(NORMAL_EXECUTION_TRANSITION_TYPES.every((t) => t !== HISTORICAL_RECONCILIATION_TRANSITION_TYPE));
  // No normal transition ever reaches COMPLETE_AGENT from NOT_STARTED.
  assert.ok(!TRANSITIONS.some(([from, to]) => from === 'NOT_STARTED' && to === 'COMPLETE_AGENT'));
});

test('ARCH-03: the reconciliation table is narrow — only the two owner-authorized corrections', () => {
  assert.deepEqual(HISTORICAL_RECONCILIATION_TRANSITIONS, [
    ['NOT_STARTED', 'COMPLETE_AGENT', 'HISTORICAL_RECONCILIATION'],
    ['NOT_STARTED', 'INTERRUPTED_RESUMABLE', 'HISTORICAL_RECONCILIATION']
  ]);
  assert.ok(!HISTORICAL_RECONCILIATION_TRANSITIONS.some(([, to]) => to === 'COMPLETE_CONFIRMED'));
  assert.ok(HISTORICAL_RECONCILIATION_TRANSITIONS.every(([from]) => from === 'NOT_STARTED'));
});

test('ARCH-04: the record schema and the validator require exactly the same fields', () => {
  assert.deepEqual(RECORD_SCHEMA.required, HISTORICAL_RECONCILIATION_RECORD_REQUIRED_FIELDS);
  const schemaProps = Object.keys(RECORD_SCHEMA.properties);
  const optional = schemaProps.filter((k) => !RECORD_SCHEMA.required.includes(k));
  assert.deepEqual(optional, HISTORICAL_RECONCILIATION_RECORD_OPTIONAL_FIELDS);
  assert.equal(RECORD_SCHEMA.additionalProperties, false);
  assert.equal(OWNER_SCHEMA.additionalProperties, false);
});

test('ARCH-07: the owner authorization binds the exact reconciliation tuple, cohort digest included', () => {
  const entry = OWNER_SCHEMA.properties.authorizedReconciliations.items;
  assert.deepEqual(entry.required, ['reconciliationId', 'gateId', 'historicalDisposition', 'canonicalCurrentStatus', 'evidenceCohortDigest']);
  assert.equal(entry.additionalProperties, false);
  // The owner approves a DIGEST of the evidence set, not a description of it, so no reconciliation
  // can nominate its own evidence cohort.
  assert.equal(entry.properties.evidenceCohortDigest.pattern, '^[a-f0-9]{64}$');
  assert.equal(entry.properties.reconciliationId.pattern, RECORD_SCHEMA.properties.reconciliationId.pattern);
  assert.equal(RECORD_SCHEMA.properties.evidenceCohortDigest.pattern, '^[a-f0-9]{64}$');
  // Evidence identity is confined to permanent governed historical storage by the schema too.
  assert.match(RECORD_SCHEMA.properties.authorityCohort.items.properties.governedPath.pattern, /\^governance\/authority\/historical\//);
  assert.equal(HISTORICAL_EVIDENCE_GOVERNED_ROOT, 'governance/authority/historical');
});

test('ARCH-08: the validator enforces the owner document against the canonical schema FILE itself', () => {
  // Runtime trust and schema validity cannot drift apart if they are literally the same document.
  assert.equal(
    path.resolve(HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_SCHEMA_PATH),
    path.resolve(REPO_ROOT, 'governance', 'schemas', 'historical-reconciliation-owner-authorization.schema.json')
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION_SCHEMA_PATH, 'utf8')), OWNER_SCHEMA);
  assert.equal(EVIDENCE_COHORT_DIGEST_ALGORITHM, 'SHA256_CANONICAL_JSON_SORTED_COHORT_V1');
});

test('ARCH-05: PARTIAL is not a canonical status and COMPLETE_CONFIRMED is not a reconciliation target', () => {
  assert.ok(!EVENT_SCHEMA.properties.toStatus.enum.includes('PARTIAL'));
  assert.ok(!EVENT_SCHEMA.properties.fromStatus.anyOf.some((s) => Array.isArray(s.enum) && s.enum.includes('PARTIAL')));
  assert.deepEqual(RECORD_SCHEMA.properties.canonicalCurrentStatus.enum, ['COMPLETE_AGENT', 'INTERRUPTED_RESUMABLE']);
  assert.deepEqual(RECORD_SCHEMA.properties.historicalDisposition.enum, ['COMPLETE', 'PARTIAL']);
  assert.equal(RECORD_SCHEMA.properties.externalConfirmationEstablished.const, false);
  assert.equal(OWNER_SCHEMA.properties.externalConfirmationGranted.const, false);
  assert.equal(OWNER_SCHEMA.properties.reexecutionAuthorized.const, false);
});

test('ARCH-06: the real repository ledger preserves the frozen prefix and approved reconciliation cohort', () => {
  const ledgerPath = path.join(REPO_ROOT, LEDGER_REL);
  const report = validateLedger({ root: REPO_ROOT, ledgerPath, policy: WHEEL_EXTERNAL_AUTHORITY_POLICY });
  assert.equal(report.valid, true);
  assert.equal(report.findings.filter((f) => f.severity === 'BLOCKING').length, 0);
  const prefix = validateLedgerPrefix({
    root: REPO_ROOT,
    ledgerPath,
    throughOrdinal: 44,
    expectedPrefixSha256: '304a75d6675690e722a84d30fb576007dd34cad9cf0a72052cc338e579077478',
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  assert.equal(prefix.matchesExpectedHistoricalDigest, true);
  assert.equal(prefix.prefixChainValid, true);
  const reconciliations = report.events.slice(44).filter(
    (event) => event.transitionType === HISTORICAL_RECONCILIATION_TRANSITION_TYPE
  );
  assert.equal(reconciliations.length, 12);
  assert.deepEqual(reconciliations.map((event) => event.gateId), [
    'GATE00', 'GATE01', 'GATE02', 'GATE03', 'GATE04', 'GATE05',
    'GATE06', 'GATE07', 'GATE08', 'GATE09', 'GATE10', 'GATE11'
  ]);
  assert.equal(new Set(reconciliations.map((event) => event.gateId)).size, 12);
  // The statuses the APPROVED COHORT carries. These are frozen: each is the
  // toStatus its own reconciliation event recorded, and no later Gate can move
  // them.
  const expectedStatuses = new Map([
    ['GATE00', 'COMPLETE_AGENT'], ['GATE01', 'COMPLETE_AGENT'],
    ['GATE02', 'COMPLETE_AGENT'], ['GATE03', 'COMPLETE_AGENT'],
    ['GATE04', 'INTERRUPTED_RESUMABLE'], ['GATE05', 'COMPLETE_AGENT'],
    ['GATE06', 'COMPLETE_AGENT'], ['GATE07', 'COMPLETE_AGENT'],
    ['GATE08', 'COMPLETE_AGENT'], ['GATE09', 'COMPLETE_AGENT'],
    ['GATE10', 'COMPLETE_AGENT'], ['GATE11', 'COMPLETE_AGENT']
  ]);
  for (const [gateId, status] of expectedStatuses) {
    assert.equal(report.gates.find((gate) => gate.gateId === gateId)?.currentStatus, status, gateId);
    const own = reconciliations.find((event) => event.gateId === gateId);
    assert.equal(own.toStatus, status, `${gateId}'s status must be the one its reconciliation recorded`);
  }
  // The COHORT BOUNDARY, which is what the Gates outside it were here to show.
  // Their live statuses are not part of this property — GATE14 was pinned at
  // NOT_STARTED and has since been lawfully confirmed, which broke the assertion
  // without anything about the reconciliation cohort changing. What must hold is
  // that no Gate outside the approved twelve was ever reconciled at all.
  for (const gateId of new Set(report.events.map((event) => event.gateId))) {
    if (expectedStatuses.has(gateId)) continue;
    assert.equal(
      report.events.filter((event) => event.gateId === gateId && event.transitionType === HISTORICAL_RECONCILIATION_TRANSITION_TYPE).length,
      0,
      `${gateId} is outside the approved cohort and must carry no reconciliation`
    );
  }
});

// ===========================================================================
// POSITIVE CASES
// ===========================================================================

test('P01: UNRESOLVED_STATUS_FALLBACK NOT_STARTED -> historical reconciliation -> COMPLETE_AGENT', () => {
  const scenario = buildScenario({ prefix: 'p01', historicalDisposition: 'COMPLETE' });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  // The correction never implies authorization, start, execution or confirmation.
  const types = scenario.report.events.map((e) => e.transitionType);
  assert.deepEqual(types, ['GENESIS_IMPORT', 'HISTORICAL_RECONCILIATION']);
  assert.ok(!types.includes('AUTHORIZATION') && !types.includes('START') && !types.includes('AGENT_CLOSURE'));
  const instance = validateAgainstJsonSchema(scenario.record, RECORD_SCHEMA);
  assert.deepEqual(instance.errors, []);
  assert.deepEqual(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).errors, []);
});

test('P02: UNRESOLVED_STATUS_FALLBACK NOT_STARTED -> historical reconciliation -> INTERRUPTED_RESUMABLE', () => {
  const scenario = buildScenario({ prefix: 'p02', gateId: 'GATE04', historicalDisposition: 'PARTIAL' });
  assertApplied(scenario.report, { gateId: 'GATE04', expectedStatus: 'INTERRUPTED_RESUMABLE', historicalDisposition: 'PARTIAL' });
  assert.deepEqual(validateAgainstJsonSchema(scenario.record, RECORD_SCHEMA).errors, []);
});

test('P03: a multi-file provenance cohort with exact hashes and portable identities is accepted', () => {
  const gateId = 'GATE07';
  const cohort = [
    { evidenceRole: 'MISSION_PROMPT', historicalLocator: 'D:\\archive\\2026\\gate07-mission.txt', governedPath: `governance/authority/historical/${gateId}/MISSION_PROMPT.txt`, content: 'mission prompt bytes\n' },
    { evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\2026\\gate07-closure.json', governedPath: `governance/authority/historical/${gateId}/CLOSURE_REPORT.json`, content: '{"closure":"COMPLETE"}\n' },
    { evidenceRole: 'INDEPENDENT_AUDIT', historicalLocator: 'D:\\archive\\2026\\gate07-audit.md', governedPath: `governance/authority/historical/${gateId}/AUDIT.md`, content: '# audit\nPASS\n' }
  ];
  const scenario = buildScenario({ prefix: 'p03', gateId, cohort });
  assertApplied(scenario.report, { gateId, expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  assert.equal(scenario.record.authorityCohort.length, 3);
  for (const item of scenario.record.authorityCohort) {
    const bytes = fs.readFileSync(path.join(scenario.root, item.governedPath));
    assert.equal(bytes.length, item.byteLength);
    assert.equal(sha256Bytes(bytes), item.sha256);
    // Host-independent on purpose: path.isAbsolute is platform-native, so a POSIX runner would
    // report "D:\archive\..." as RELATIVE and this proof would silently evaporate off Windows.
    assert.equal(classifyHistoricalEvidencePath(item.governedPath), 'OK', 'governed identity must be portable and inside the canonical historical root');
    assert.ok(
      path.win32.isAbsolute(item.historicalLocator) || path.posix.isAbsolute(item.historicalLocator),
      'original locator is retained as provenance only'
    );
  }
  // Flipping a single byte of any cohort member invalidates the whole reconciliation.
  const victim = path.join(scenario.root, cohort[0].governedPath);
  fs.writeFileSync(victim, 'mission prompt bytes (edited)\n');
  assertBlocking(validateLedger({ root: scenario.root, ledgerPath: scenario.ledgerPath }), 'HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH');
});

test('P04: historicalDisposition=PARTIAL coexists with canonicalCurrentStatus=INTERRUPTED_RESUMABLE, residual preserved', () => {
  const gateId = 'GATE04';
  const cohort = [
    { evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'C:\\Temp\\gate04\\interrupted-report.md', governedPath: `governance/authority/historical/${gateId}/PARTIAL_DISPOSITION.md`, content: '# GATE04\nhistorical disposition: PARTIAL\n' },
    { evidenceRole: 'RESIDUAL_OBLIGATION_EVIDENCE', historicalLocator: 'C:\\Temp\\gate04\\residual.json', governedPath: `governance/authority/historical/${gateId}/RESIDUAL_OBLIGATION.json`, content: '{"remaining":"closure evidence"}\n' }
  ];
  const scenario = buildScenario({ prefix: 'p04', gateId, historicalDisposition: 'PARTIAL', cohort });
  assertApplied(scenario.report, { gateId, expectedStatus: 'INTERRUPTED_RESUMABLE', historicalDisposition: 'PARTIAL' });
  // The historical word and the governed status stay separate concepts.
  assert.equal(scenario.record.historicalDisposition, 'PARTIAL');
  assert.equal(scenario.record.canonicalCurrentStatus, 'INTERRUPTED_RESUMABLE');
  assert.notEqual(scenario.record.historicalDisposition, scenario.record.canonicalCurrentStatus);
  // The residual obligation survives and is bound to real, byte-verified evidence.
  const residual = scenario.record.residualObligation;
  assert.equal(residual.evidenceGovernedPath, cohort[1].governedPath);
  assert.equal(residual.evidenceSha256, sha256Bytes(fs.readFileSync(path.join(scenario.root, cohort[1].governedPath))));
  // PARTIAL never becomes a canonical status anywhere in the ledger projection.
  assert.ok(!scenario.report.gates.some((g) => g.currentStatus === 'PARTIAL'));
  assert.ok(!scenario.report.events.some((e) => e.toStatus === 'PARTIAL' || e.fromStatus === 'PARTIAL'));
});

test('P05: the genesis event stays byte-identical and the reconciliation is strictly appended', () => {
  const scenario = buildScenario({ prefix: 'p05' });
  const genesisOnlyBytes = ledgerBytes([scenario.genesisSealed]);
  const liveBytes = fs.readFileSync(scenario.ledgerPath);

  // The reconciliation added bytes after the genesis line and changed nothing before it.
  assert.ok(liveBytes.subarray(0, genesisOnlyBytes.length).equals(genesisOnlyBytes), 'genesis prefix must be byte-identical');
  assert.ok(liveBytes.length > genesisOnlyBytes.length, 'reconciliation must be an append');
  assert.equal(scenario.sealed[0].eventPayloadSha256, scenario.genesisSealed.eventPayloadSha256);
  assert.equal(scenario.sealed[1].previousEventSha256, scenario.genesisSealed.eventPayloadSha256);

  // The pinned historical prefix still reproduces its original digest through the existing primitive.
  const prefix = validateLedgerPrefix({
    root: scenario.root,
    ledgerPath: scenario.ledgerPath,
    throughOrdinal: 1,
    expectedPrefixSha256: sha256Bytes(genesisOnlyBytes)
  });
  assert.equal(prefix.matchesExpectedHistoricalDigest, true);
  assert.equal(prefix.prefixChainValid, true);
});

// ===========================================================================
// HOSTILE CASES
// ===========================================================================

test('H01: an ordinary transition NOT_STARTED -> COMPLETE_AGENT is rejected without a reconciliation basis', () => {
  for (const transitionType of ['AGENT_CLOSURE', 'AUTHORIZATION', 'RESUME', 'GENESIS_IMPORT']) {
    const scenario = buildScenario({ prefix: 'h01', transitionType, toStatus: 'COMPLETE_AGENT' });
    assert.equal(scenario.report.valid, false);
    assert.ok(
      scenario.report.findings.some((f) => f.detectorId === 'INVALID_STATUS_TRANSITION' && f.severity === 'BLOCKING'),
      `${transitionType} must not reach COMPLETE_AGENT from NOT_STARTED`
    );
    // The reconciliation proof path is never even reached for a normal transition type.
    assert.ok(!scenario.report.findings.some((f) => f.detectorId.startsWith('HISTORICAL_RECONCILIATION')));
  }
});

test('H02: reconciliation is rejected when the original state was not an unresolved genesis fallback', () => {
  const externallyConfirmed = buildScenario({
    prefix: 'h02a',
    sourceMapGatePatch: (g) => ({ ...g, confidenceClass: 'EXTERNAL_REINSPECTION_CONFIRMED' })
  });
  assertBlocking(externallyConfirmed.report, 'HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS');

  // The record's own claim is never sufficient: asserting the basis while the source map disagrees fails.
  const selfAsserted = buildScenario({
    prefix: 'h02b',
    sourceMapGatePatch: (g) => ({ ...g, confidenceClass: 'EXTERNAL_REINSPECTION_CONFIRMED' }),
    recordPatch: (r) => ({ ...r, originalStatusBasis: 'UNRESOLVED_STATUS_FALLBACK' })
  });
  assertBlocking(selfAsserted.report, 'HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS');

  // Substituting a different document for the active source map fails too.
  const substituted = buildScenario({
    prefix: 'h02c',
    recordPatch: (r) => ({ ...r, originalStatusBasisSourcePath: REGISTRY_REL })
  });
  assertBlocking(substituted.report, 'HISTORICAL_RECONCILIATION_WITHOUT_FALLBACK_BASIS');
});

test('H03: reconciliation pointing to missing historical authority is rejected', () => {
  const governedPath = 'governance/authority/historical/GATE00/GATE00_FINAL_AGENT_REPORT.md';
  const scenario = buildScenario({ prefix: 'h03', omitCohortFiles: [governedPath] });
  assert.ok(!fs.existsSync(path.join(scenario.root, governedPath)));
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_AUTHORITY_MISSING');
});

test('H04: reconciliation with a wrong SHA-256 or wrong byte length is rejected', () => {
  const wrongHash = buildScenario({
    prefix: 'h04a',
    recordPatch: (r) => ({ ...r, authorityCohort: r.authorityCohort.map((c) => ({ ...c, sha256: 'f'.repeat(64) })) })
  });
  assertBlocking(wrongHash.report, 'HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH');

  const wrongLength = buildScenario({
    prefix: 'h04b',
    recordPatch: (r) => ({ ...r, authorityCohort: r.authorityCohort.map((c) => ({ ...c, byteLength: c.byteLength + 1 })) })
  });
  assertBlocking(wrongLength.report, 'HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH');
});

test('H05: authority recovered for another gate can never support this gate', () => {
  const foreignCohort = buildScenario({
    prefix: 'h05a',
    recordPatch: (r) => ({ ...r, authorityCohort: r.authorityCohort.map((c) => ({ ...c, gateId: 'GATE09' })) })
  });
  assertBlocking(foreignCohort.report, 'HISTORICAL_RECONCILIATION_GATE_MISMATCH');

  const foreignRecord = buildScenario({
    prefix: 'h05b',
    recordPatch: (r) => ({ ...r, gateId: 'GATE09' })
  });
  assertBlocking(foreignRecord.report, 'HISTORICAL_RECONCILIATION_GATE_MISMATCH');
});

test('H06: reconciliation without genuine PROJECT_OWNER authorization is rejected', () => {
  // Absent authorization document.
  const missing = buildScenario({ prefix: 'h06a', writeOwnerFile: false });
  assertBlocking(missing.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');

  // Present but hash-mismatched (authorization edited after the record pinned it).
  const tampered = buildScenario({ prefix: 'h06b' });
  fs.writeFileSync(path.join(tampered.root, OWNER_REL), JSON.stringify({ ...tampered.owner, reason: 'edited after the fact' }, null, 2));
  assertBlocking(validateLedger({ root: tampered.root, ledgerPath: tampered.ledgerPath }), 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');

  // An unrelated, hash-matching PROJECT_OWNER-ish document never authorizes a status correction.
  const unrelated = buildScenario({
    prefix: 'h06c',
    ownerPatch: (o) => ({ document: 'SOME_OTHER_AUTHORITY', schemaVersion: 1, issuedBy: 'PROJECT_OWNER', authorityClass: 'SOMETHING_ELSE', authorizedReconciliations: o.authorizedReconciliations })
  });
  assertBlocking(unrelated.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');

  // Authorized for a different gate/target than the one being corrected.
  const wrongTarget = buildScenario({
    prefix: 'h06d',
    ownerPatch: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: 'HISTORICAL_RECONCILIATION_GATE09_R1', gateId: 'GATE09', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: ctx.evidenceCohortDigest }] })
  });
  assertBlocking(wrongTarget.report, 'HISTORICAL_RECONCILIATION_TARGET_NOT_AUTHORIZED');

  // The owner cannot pre-authorize re-execution through this primitive.
  const reexec = buildScenario({ prefix: 'h06e', ownerPatch: (o) => ({ ...o, reexecutionAuthorized: true }) });
  assertBlocking(reexec.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');
});

test('H07: reconciliation can never reach COMPLETE_CONFIRMED without external confirmation', () => {
  const scenario = buildScenario({
    prefix: 'h07a',
    toStatus: 'COMPLETE_CONFIRMED',
    recordPatch: (r) => ({ ...r, canonicalCurrentStatus: 'COMPLETE_CONFIRMED' }),
    ownerPatch: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_CONFIRMED', evidenceCohortDigest: ctx.evidenceCohortDigest }] })
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_CANNOT_CONFIRM');
  // The owner cannot even express this approval: COMPLETE_CONFIRMED is absent from the authorization
  // schema's canonicalCurrentStatus enum, so the document is schema-invalid by construction.
  assert.ok(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).errors.some((e) => e.reason === 'ENUM_MISMATCH'));
  // The pre-existing independent-reinspection rule still fires as well — belt and braces.
  assert.ok(scenario.report.findings.some((f) => f.detectorId === 'COMPLETE_CONFIRMED_WITHOUT_INDEPENDENT_REINSPECTION'));
  assert.ok(scenario.report.findings.some((f) => f.detectorId === 'INVALID_STATUS_TRANSITION'));

  // Even claiming confirmation inside the record is refused.
  const claimed = buildScenario({ prefix: 'h07b', recordPatch: (r) => ({ ...r, externalConfirmationEstablished: true }) });
  assertBlocking(claimed.report, 'HISTORICAL_RECONCILIATION_CANNOT_CONFIRM');
});

test('H08: reconciliation that fabricates START/EXECUTION chronology is rejected', () => {
  // Claiming an execution occurred is self-contradictory for a reconciliation.
  const claimsExecution = buildScenario({ prefix: 'h08a', recordPatch: (r) => ({ ...r, newExecutionOccurred: true }) });
  assertBlocking(claimsExecution.report, 'HISTORICAL_RECONCILIATION_FABRICATED_CHRONOLOGY');

  // Reconciliation may not be chained onto invented intermediate chronology.
  const invented = buildScenario({
    prefix: 'h08b',
    midEvents: [{ fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED', transitionType: 'AUTHORIZATION' }]
  });
  assertBlocking(invented.report, 'HISTORICAL_RECONCILIATION_FABRICATED_CHRONOLOGY');

  // A reconciliation pinning a genesis event that is not this gate's genesis is refused.
  const wrongGenesisId = buildScenario({ prefix: 'h08c', recordPatch: (r) => ({ ...r, supersededGenesisEventId: 'GENESIS_IMPORT_GATE09' }) });
  assertBlocking(wrongGenesisId.report, 'HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH');
});

test('H09: an edited old ledger event is rejected, never silently re-based', () => {
  // Naive tamper: rewriting the historical line breaks the append-only hash chain.
  const naive = buildScenario({
    prefix: 'h09a',
    ledgerBytesPatch: (bytes, sealed) => {
      const lines = bytes.toString('utf8').trimEnd().split('\n');
      lines[0] = canonicalize({ ...sealed[0], recordedAt: '2026-07-01T00:00:00.000Z' });
      return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    }
  });
  assertBlocking(naive.report, 'LEDGER_CHAIN_BREAK');
  // The reconciliation's pin is recomputed from the historical event's actual bytes, so leaving the
  // old self-declared payload hash in place does not keep the reconciliation bound.
  assertBlocking(naive.report, 'HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH');

  // Sophisticated tamper: rewrite the genesis event AND re-chain the whole ledger so it is
  // internally consistent. The reconciliation's pinned genesis payload hash still refuses it.
  const rechained = buildScenario({
    prefix: 'h09b',
    ledgerBytesPatch: (bytes, sealed) => {
      const stripped = sealed.map(({ eventPayloadSha256, previousEventSha256, ...rest }) => rest);
      stripped[0] = { ...stripped[0], recordedAt: '2026-07-01T00:00:00.000Z' };
      return ledgerBytes(sealEvents(stripped));
    }
  });
  assert.ok(!rechained.report.findings.some((f) => f.detectorId === 'LEDGER_CHAIN_BREAK'), 'the re-chained ledger is internally consistent');
  assertBlocking(rechained.report, 'HISTORICAL_RECONCILIATION_GENESIS_BINDING_MISMATCH');
});

test('H10: a historically PARTIAL gate can never be promoted to COMPLETE_AGENT', () => {
  const scenario = buildScenario({
    prefix: 'h10a',
    gateId: 'GATE04',
    historicalDisposition: 'PARTIAL',
    toStatus: 'COMPLETE_AGENT',
    recordPatch: (r) => ({ ...r, canonicalCurrentStatus: 'COMPLETE_AGENT' }),
    ownerPatch: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE04', historicalDisposition: 'PARTIAL', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: ctx.evidenceCohortDigest }] })
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_PARTIAL_OVERREACH');

  // Nor may a COMPLETE history be quietly restated as something else.
  const downgraded = buildScenario({
    prefix: 'h10b',
    historicalDisposition: 'COMPLETE',
    toStatus: 'INTERRUPTED_RESUMABLE',
    recordPatch: (r) => ({ ...r, canonicalCurrentStatus: 'INTERRUPTED_RESUMABLE' }),
    ownerPatch: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'INTERRUPTED_RESUMABLE', evidenceCohortDigest: ctx.evidenceCohortDigest }] })
  });
  assertBlocking(downgraded.report, 'HISTORICAL_RECONCILIATION_DISPOSITION_STATUS_MISMATCH');
});

test('H11: a PARTIAL reconciliation that drops its residual obligation is rejected', () => {
  const dropped = buildScenario({
    prefix: 'h11a',
    gateId: 'GATE04',
    historicalDisposition: 'PARTIAL',
    recordPatch: (r) => {
      const { residualObligation, ...rest } = r;
      return rest;
    }
  });
  assertBlocking(dropped.report, 'HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED');

  // Present but not bound to byte-verified evidence is equally refused.
  const unbound = buildScenario({
    prefix: 'h11b',
    gateId: 'GATE04',
    historicalDisposition: 'PARTIAL',
    recordPatch: (r) => ({
      ...r,
      residualObligation: { ...r.residualObligation, evidenceGovernedPath: 'governance/authority/historical/GATE04/NOT_IN_COHORT.md' }
    })
  });
  assertBlocking(unbound.report, 'HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED');

  // An empty description discharges nothing and is refused.
  const empty = buildScenario({
    prefix: 'h11c',
    gateId: 'GATE04',
    historicalDisposition: 'PARTIAL',
    recordPatch: (r) => ({ ...r, residualObligation: { ...r.residualObligation, description: '   ' } })
  });
  assertBlocking(empty.report, 'HISTORICAL_RECONCILIATION_RESIDUAL_OBLIGATION_DROPPED');
});

test('H12: an absolute Temp location is never accepted as permanent authority identity', () => {
  const absoluteTemp = path.join(os.tmpdir(), 'gate-archaeology', 'GATE00_FINAL_AGENT_REPORT.md');
  const asGovernedPath = buildScenario({
    prefix: 'h12a',
    recordPatch: (r) => ({ ...r, authorityCohort: r.authorityCohort.map((c) => ({ ...c, governedPath: absoluteTemp })) })
  });
  assertBlocking(asGovernedPath.report, 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');

  // Escaping the governed root is refused for the same reason.
  const escaping = buildScenario({
    prefix: 'h12b',
    recordPatch: (r) => ({ ...r, authorityCohort: r.authorityCohort.map((c) => ({ ...c, governedPath: '../outside-the-repo/report.md' })) })
  });
  assertBlocking(escaping.report, 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');

  // The reconciliation record itself must also be identified portably.
  const absoluteRecord = buildScenario({ prefix: 'h12c' });
  const lines = fs.readFileSync(absoluteRecord.ledgerPath, 'utf8').trimEnd().split('\n');
  const events = lines.map((l) => JSON.parse(l)).map(({ eventPayloadSha256, previousEventSha256, ...rest }) => rest);
  events[1] = { ...events[1], authorityPath: path.join(absoluteRecord.root, absoluteRecord.recordRel) };
  fs.writeFileSync(absoluteRecord.ledgerPath, ledgerBytes(sealEvents(events)));
  assertBlocking(validateLedger({ root: absoluteRecord.root, ledgerPath: absoluteRecord.ledgerPath }), 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');

  // But retaining the Temp path as PROVENANCE alongside a portable governed identity is accepted.
  const provenanceOnly = buildScenario({
    prefix: 'h12d',
    cohort: [{
      evidenceRole: 'STATUS_DISPOSITION_AUTHORITY',
      historicalLocator: absoluteTemp,
      governedPath: 'governance/authority/historical/GATE00/GATE00_FINAL_AGENT_REPORT.md',
      content: '# GATE00 recovered report\n'
    }]
  });
  assertApplied(provenanceOnly.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  assert.equal(provenanceOnly.record.authorityCohort[0].historicalLocator, absoluteTemp);
});

test('H13: the reconciliation record itself must be pinned, well formed and non-duplicated', () => {
  // Record bytes edited after the event pinned them.
  const unpinned = buildScenario({ prefix: 'h13a' });
  fs.writeFileSync(path.join(unpinned.root, unpinned.recordRel), JSON.stringify({ ...unpinned.record, reason: 'edited' }, null, 2));
  const report = validateLedger({ root: unpinned.root, ledgerPath: unpinned.ledgerPath });
  assert.equal(report.valid, false);
  assert.ok(report.findings.some((f) => f.detectorId === 'AUTHORITY_HASH_MISMATCH'));
  assert.ok(report.findings.some((f) => f.detectorId === 'INVALID_HISTORICAL_RECONCILIATION_RECORD'));

  // Unknown fields are refused (additionalProperties=false, enforced by the validator too).
  const extraField = buildScenario({ prefix: 'h13b', recordPatch: (r) => ({ ...r, bypassProof: true }) });
  assertBlocking(extraField.report, 'INVALID_HISTORICAL_RECONCILIATION_RECORD');

  // A cohort with no disposition authority proves nothing about the target status.
  const noDispositionAuthority = buildScenario({
    prefix: 'h13c',
    cohort: [{ evidenceRole: 'MISSION_PROMPT', historicalLocator: 'C:\\Temp\\x.txt', governedPath: 'governance/authority/historical/GATE00/PROMPT.txt', content: 'prompt\n' }]
  });
  assertBlocking(noDispositionAuthority.report, 'HISTORICAL_RECONCILIATION_DISPOSITION_NOT_PROVEN');

  // A COMPLETE history cannot smuggle in a residual obligation.
  const strayResidual = buildScenario({
    prefix: 'h13d',
    recordPatch: (r) => ({ ...r, residualObligation: { description: 'x', evidenceGovernedPath: r.authorityCohort[0].governedPath, evidenceSha256: r.authorityCohort[0].sha256 } })
  });
  assertBlocking(strayResidual.report, 'INVALID_HISTORICAL_RECONCILIATION_RECORD');

  // A gate may be reconciled once. A second reconciliation would restate recovered history.
  const doubled = buildScenario({
    prefix: 'h13e',
    midEvents: [{ fromStatus: 'NOT_STARTED', toStatus: 'COMPLETE_AGENT', transitionType: HISTORICAL_RECONCILIATION_TRANSITION_TYPE }]
  });
  assertBlocking(doubled.report, 'DUPLICATE_HISTORICAL_RECONCILIATION');
});

// ===========================================================================
// REPAIR R1 REGRESSIONS
//
// Independent reproduction of the four defects the independent audit found, each
// now proven to fail closed. The security boundary under test is OWNER APPROVED
// EXACT COHORT — never "the record called this file a status authority".
// ===========================================================================

// The cohort the PROJECT_OWNER actually reviewed and approved. Every H14-H17 attack below reuses
// this owner approval while quietly reconciling from something else.
const GENUINE_COHORT = [
  { evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\2026\\gate00-closure.json', governedPath: 'governance/authority/historical/GATE00/CLOSURE_REPORT.json', content: '{"closure":"COMPLETE"}\n' },
  { evidenceRole: 'INDEPENDENT_AUDIT', historicalLocator: 'D:\\archive\\2026\\gate00-audit.md', governedPath: 'governance/authority/historical/GATE00/AUDIT.md', content: '# audit\nPASS\n' }
];

function approvedGenuineDigest(prefix) {
  const genuine = buildScenario({ prefix, cohort: GENUINE_COHORT });
  assertApplied(genuine.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  return genuine.record.evidenceCohortDigest;
}

test('H14: an arbitrary file self-labelled STATUS_DISPOSITION_AUTHORITY is not authority (HR-R1-001)', () => {
  const approved = approvedGenuineDigest('h14-approved');

  // The exact independent reproduction: arbitrary byte-valid content, self-declared as the status
  // authority, outside the cohort the owner approved.
  const scenario = buildScenario({
    prefix: 'h14',
    cohort: [{
      evidenceRole: 'STATUS_DISPOSITION_AUTHORITY',
      historicalLocator: 'C:\\Users\\owner\\AppData\\Local\\Temp\\whatever.json',
      governedPath: 'governance/authority/historical/GATE00/whatever.json',
      content: '{"name":"this-is-not-a-status-authority"}'
    }],
    ownerApprovedDigest: approved
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED');

  // Crucially, it is NOT rejected for lacking the role: the role is present and well formed. The
  // record labelling a file "status authority" is exactly what stopped being sufficient.
  assert.ok(!scenario.report.findings.some((f) => f.detectorId === 'HISTORICAL_RECONCILIATION_DISPOSITION_NOT_PROVEN'));
  assert.equal(scenario.record.authorityCohort[0].evidenceRole, 'STATUS_DISPOSITION_AUTHORITY');
});

test('H15: substituting a cohort file after owner authorization breaks the cohort digest', () => {
  const approved = approvedGenuineDigest('h15-approved');

  const substituted = buildScenario({
    prefix: 'h15',
    cohort: GENUINE_COHORT.map((c, i) => (i === 1 ? { ...c, content: '# audit\nPASS (quietly rewritten)\n' } : c)),
    ownerApprovedDigest: approved
  });
  assertBlocking(substituted.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED');
  // The substituted record is internally consistent — its bytes, lengths and hashes all agree. Only
  // the owner binding refuses it, which is the point.
  assert.ok(!substituted.report.findings.some((f) => f.detectorId === 'HISTORICAL_RECONCILIATION_AUTHORITY_HASH_MISMATCH'));

  // And a record-supplied digest is never taken on trust: the validator recomputes it.
  const forgedDigest = buildScenario({
    prefix: 'h15b',
    cohort: GENUINE_COHORT,
    recordPatch: (r) => ({ ...r, evidenceCohortDigest: 'a'.repeat(64) })
  });
  assertBlocking(forgedDigest.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_DIGEST_MISMATCH');
});

test('H16: the same files under a different evidenceRole are a different, unapproved cohort', () => {
  const approved = approvedGenuineDigest('h16-approved');
  const scenario = buildScenario({
    prefix: 'h16',
    cohort: GENUINE_COHORT.map((c, i) => (i === 1 ? { ...c, evidenceRole: 'MISSION_PROMPT' } : c)),
    ownerApprovedDigest: approved
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED');
});

test('H17: the same bytes under a different governedPath are a different, unapproved cohort', () => {
  const approved = approvedGenuineDigest('h17-approved');
  const scenario = buildScenario({
    prefix: 'h17',
    cohort: GENUINE_COHORT.map((c, i) => (i === 1 ? { ...c, governedPath: 'governance/authority/historical/GATE00/AUDIT_COPY.md' } : c)),
    ownerApprovedDigest: approved
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED');
});

test('H18: governedPath=package.json is never historical status authority (HR-R1-002)', () => {
  const scenario = buildScenario({
    prefix: 'h18',
    cohort: [{
      evidenceRole: 'STATUS_DISPOSITION_AUTHORITY',
      historicalLocator: 'C:\\Users\\owner\\AppData\\Local\\Temp\\pkg.json',
      governedPath: 'package.json',
      content: '{"name":"this-is-not-a-status-authority"}'
    }]
  });
  // The owner here even approves this exact cohort digest, so nothing but the governed-root rule
  // can be doing the blocking.
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_OUTSIDE_GOVERNED_ROOT');
  assert.ok(!scenario.report.findings.some((f) => f.detectorId === 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED'));
  assert.equal(classifyHistoricalEvidencePath('package.json'), 'OUTSIDE_ROOT');
});

test('H19: evidence outside the canonical historical governance root is refused', () => {
  const outside = [
    'src/server.js',
    'wheel-dashboard/src/App.jsx',
    'research/directional-lab/report.md',
    'governance/sources/I4_BOOTSTRAP_EXECUTION_AUTHORITY.json',
    'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json',
    'governance/authority/historical'
  ];
  for (const governedPath of outside) {
    assert.equal(classifyHistoricalEvidencePath(governedPath), 'OUTSIDE_ROOT', governedPath);
  }
  const scenario = buildScenario({
    prefix: 'h19',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\x.md', governedPath: 'governance/sources/NOT_HISTORICAL_STORAGE.md', content: 'disposition: COMPLETE\n' }]
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_OUTSIDE_GOVERNED_ROOT');
});

test('H20: a Windows absolute governedPath is refused on every host OS', () => {
  const winAbsolute = 'D:\\archive\\2026\\GATE00_FINAL_AGENT_REPORT.md';
  // Host-independent by construction: this holds identically on Windows and POSIX runners.
  assert.equal(path.win32.isAbsolute(winAbsolute), true);
  assert.equal(path.posix.isAbsolute(winAbsolute), false, 'a POSIX host alone would call this relative');
  assert.equal(classifyHistoricalEvidencePath(winAbsolute), 'UNPORTABLE');
  for (const hostile of ['C:/archive/report.md', 'C:report.md', '\\\\server\\share\\report.md']) {
    assert.equal(classifyHistoricalEvidencePath(hostile), 'UNPORTABLE', hostile);
  }

  const scenario = buildScenario({
    prefix: 'h20',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: winAbsolute, governedPath: winAbsolute, content: '# recovered\n' }],
    omitCohortFiles: [winAbsolute]
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');
});

test('H21: a POSIX absolute governedPath is refused on every host OS', () => {
  const posixAbsolute = '/var/archive/2026/GATE00_FINAL_AGENT_REPORT.md';
  assert.equal(path.posix.isAbsolute(posixAbsolute), true);
  assert.equal(classifyHistoricalEvidencePath(posixAbsolute), 'UNPORTABLE');
  assert.equal(classifyHistoricalEvidencePath('/governance/authority/historical/GATE00/R.md'), 'UNPORTABLE');

  const scenario = buildScenario({
    prefix: 'h21',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: posixAbsolute, governedPath: posixAbsolute, content: '# recovered\n' }],
    omitCohortFiles: [posixAbsolute]
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');
});

test('H22: mixed-separator, traversal and non-normalized escapes are refused on every host OS', () => {
  const escapes = [
    'governance/authority/historical/GATE00/..\\..\\..\\..\\package.json',
    'governance/authority/historical/GATE00/../../../../package.json',
    'governance\\authority\\historical\\GATE00\\..\\..\\secrets.json',
    'governance/authority/historical/./GATE00/R.md',
    'governance/authority/historical//GATE00/R.md',
    'governance/authority/historical/GATE00/R.md/'
  ];
  for (const governedPath of escapes) {
    assert.equal(classifyHistoricalEvidencePath(governedPath), 'UNPORTABLE', governedPath);
  }

  const mixed = 'governance/authority/historical/GATE00/..\\..\\..\\..\\package.json';
  const scenario = buildScenario({
    prefix: 'h22',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\x.md', governedPath: mixed, content: '# recovered\n' }],
    omitCohortFiles: [mixed]
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNPORTABLE_AUTHORITY_IDENTITY');
});

test('H23: an owner authorization missing authorityId cannot authorize anything (HR-R1-003)', () => {
  const scenario = buildScenario({
    prefix: 'h23',
    ownerPatch: (o) => {
      const { authorityId, ...rest } = o;
      return rest;
    }
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');
  assert.ok(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).errors.some((e) => e.jsonPointer === '/authorityId'));
});

test('H24: an owner authorization missing issuedAtUtc cannot authorize anything (HR-R1-003)', () => {
  const scenario = buildScenario({
    prefix: 'h24',
    ownerPatch: (o) => {
      const { issuedAtUtc, ...rest } = o;
      return rest;
    }
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');

  // A present but non-UTC-instant value is refused identically, because the schema states the
  // constraint as a pattern the canonical validator actually enforces.
  const malformed = buildScenario({ prefix: 'h24b', ownerPatch: (o) => ({ ...o, issuedAtUtc: 'sometime in 2026' }) });
  assertBlocking(malformed.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');
});

test('H25: an owner authorization carrying an unknown property is refused (HR-R1-003)', () => {
  const scenario = buildScenario({
    prefix: 'h25',
    ownerPatch: (o) => ({ ...o, thisFieldIsNotInTheSchema: true })
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');
  assert.ok(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).errors.some((e) => e.reason === 'ADDITIONAL_PROPERTY_FORBIDDEN'));
});

test('H26: an owner authorization failing any nested schema constraint is refused (HR-R1-003)', () => {
  const nestedViolations = {
    h26a: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_AGENT' }] }),
    h26b: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: 'NOT-A-SHA256' }] }),
    h26c: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: 'not-a-reconciliation-id', gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: ctx.evidenceCohortDigest }] }),
    h26d: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'MOSTLY_DONE', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: ctx.evidenceCohortDigest }] }),
    h26e: (o, ctx) => ({ ...o, authorizedReconciliations: [{ reconciliationId: ctx.reconciliationId, gateId: 'GATE00', historicalDisposition: 'COMPLETE', canonicalCurrentStatus: 'COMPLETE_AGENT', evidenceCohortDigest: ctx.evidenceCohortDigest, extraKey: 1 }] }),
    h26f: (o) => ({ ...o, authorizedReconciliations: [] })
  };
  for (const [prefix, ownerPatch] of Object.entries(nestedViolations)) {
    const scenario = buildScenario({ prefix, ownerPatch });
    assert.equal(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).valid, false, `${prefix} fixture should be schema-invalid`);
    assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_UNAUTHORIZED');
  }
});

test('H27: an authorization issued for reconciliation A never authorizes reconciliation B', () => {
  const scenario = buildScenario({
    prefix: 'h27',
    reconciliationId: 'HISTORICAL_RECONCILIATION_GATE00_R2',
    ownerPatch: (o) => ({ ...o, authorizedReconciliations: [{ ...o.authorizedReconciliations[0], reconciliationId: 'HISTORICAL_RECONCILIATION_GATE00_R1' }] })
  });
  assert.equal(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).valid, true, 'the authorization is perfectly valid — for a different reconciliation');
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_TARGET_NOT_AUTHORIZED');
});

test('H28: an authorization issued for gate X never authorizes gate Y', () => {
  const scenario = buildScenario({
    prefix: 'h28',
    ownerPatch: (o) => ({ ...o, authorizedReconciliations: [{ ...o.authorizedReconciliations[0], gateId: 'GATE09' }] })
  });
  assert.equal(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).valid, true);
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_TARGET_NOT_AUTHORIZED');
});

test('H29: a digest approved for a COMPLETE cohort never covers a PARTIAL reconciliation cohort', () => {
  const completeDigest = approvedGenuineDigest('h29-approved');

  // Same owner document shape, same gate family, but the reconciliation now carries the PARTIAL
  // evidence cohort while the approval still names the COMPLETE cohort's digest.
  const scenario = buildScenario({
    prefix: 'h29',
    gateId: 'GATE04',
    historicalDisposition: 'PARTIAL',
    cohort: [
      { evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate04-partial.md', governedPath: 'governance/authority/historical/GATE04/PARTIAL_DISPOSITION.md', content: '# GATE04\nhistorical disposition: PARTIAL\n' },
      { evidenceRole: 'RESIDUAL_OBLIGATION_EVIDENCE', historicalLocator: 'D:\\archive\\gate04-residual.json', governedPath: 'governance/authority/historical/GATE04/RESIDUAL_OBLIGATION.json', content: '{"remaining":"closure evidence"}\n' }
    ],
    ownerApprovedDigest: completeDigest
  });
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_EVIDENCE_COHORT_NOT_AUTHORIZED');
});

test('H30: a final evidence-file symlink escaping the historical root is blocked', (t) => {
  const governedPath = 'governance/authority/historical/GATE00/link.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h30',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00.json', governedPath, content }]
  });
  const linkPath = path.join(scenario.root, governedPath);
  const outsidePath = path.join(scenario.root, 'outside-authority.json');
  fs.rmSync(linkPath, { force: true });
  fs.writeFileSync(outsidePath, content);
  try {
    fs.symlinkSync(outsidePath, linkPath, 'file');
  } catch (error) {
    t.skip(`PLATFORM_CAPABILITY_SKIP_FINAL_FILE_SYMLINK:${error.code || error.message}`);
    return;
  }
  assertBlocking(validateLedger({ root: scenario.root, ledgerPath: scenario.ledgerPath }), 'HISTORICAL_RECONCILIATION_EVIDENCE_FILESYSTEM_SECURITY');
});

test('H30D: the production filesystem helper blocks a simulated final-file symlink escape', () => {
  const governedPath = 'governance/authority/historical/GATE00/link.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h30d',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-deterministic.json', governedPath, content }]
  });
  const candidatePath = path.resolve(scenario.root, governedPath);
  const outsidePath = path.resolve(scenario.root, 'outside-authority-deterministic.json');
  fs.rmSync(candidatePath);
  writeFile(scenario.root, 'outside-authority-deterministic.json', content);
  const calls = [];
  const fsOps = {
    lstatSync(target) {
      calls.push({ operation: 'lstatSync', target });
      if (path.resolve(target) === candidatePath) return { isSymbolicLink: () => true, isFile: () => false };
      return fs.lstatSync(target);
    },
    realpathSync(target) {
      calls.push({ operation: 'realpathSync', target });
      if (path.resolve(target) === candidatePath) return outsidePath;
      return fs.realpathSync.native(target);
    }
  };

  const result = resolveHistoricalEvidenceFilesystemPath({ root: scenario.root, governedPath, fsOps });
  assert.equal(result.status, 'INDIRECTION');
  assert.equal(result.realCandidate, outsidePath);
  assert.ok(calls.some(({ operation, target }) => operation === 'lstatSync' && path.resolve(target) === candidatePath));
  assert.ok(calls.some(({ operation, target }) => operation === 'realpathSync' && path.resolve(target) === candidatePath));
});

test('H31: a canonically equivalent NFD governedPath is blocked before digest identity', () => {
  const nfcPath = `governance/authority/historical/GATE00/caf\u00e9.json`;
  const nfdPath = `governance/authority/historical/GATE00/cafe\u0301.json`;
  assert.equal(isCanonicalGovernedPathUnicode(nfcPath), true);
  assert.equal(isCanonicalGovernedPathUnicode(nfdPath), false);
  const approved = buildScenario({
    prefix: 'h31-approved',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-nfc.json', governedPath: nfcPath, content: '{"closure":"COMPLETE"}\n' }]
  });
  const scenario = buildScenario({
    prefix: 'h31',
    ownerApprovedDigest: approved.record.evidenceCohortDigest,
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-nfd.json', governedPath: nfdPath, content: '{"closure":"COMPLETE"}\n' }]
  });
  assert.equal(computeEvidenceCohortDigest(scenario.record.authorityCohort).reason, 'NON_CANONICAL_GOVERNED_PATH_UNICODE');
  assertBlocking(scenario.report, 'HISTORICAL_RECONCILIATION_NON_CANONICAL_GOVERNED_PATH');
});

test('H32: a parent directory symlink or junction escaping the historical root is blocked', (t) => {
  const governedPath = 'governance/authority/historical/GATE00/escaped/report.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h32',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-parent.json', governedPath, content }]
  });
  const escapedPath = path.join(scenario.root, 'governance/authority/historical/GATE00/escaped');
  const outsideDir = path.join(scenario.root, 'outside-directory');
  fs.rmSync(escapedPath, { recursive: true, force: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'report.json'), content);
  try {
    fs.symlinkSync(outsideDir, escapedPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`PLATFORM_CAPABILITY_SKIP_PARENT_LINK:${error.code || error.message}`);
    return;
  }
  assertBlocking(validateLedger({ root: scenario.root, ledgerPath: scenario.ledgerPath }), 'HISTORICAL_RECONCILIATION_EVIDENCE_FILESYSTEM_SECURITY');
});

test('H33: the canonical historical root itself cannot be a symlink or junction', (t) => {
  const governedPath = 'governance/authority/historical/GATE00/report.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h33',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-root.json', governedPath, content }]
  });
  const historicalRoot = path.join(scenario.root, 'governance', 'authority', 'historical');
  const externalRoot = path.join(scenario.root, 'outside-historical-root');
  fs.rmSync(historicalRoot, { recursive: true, force: true });
  writeFile(scenario.root, 'outside-historical-root/GATE00/report.json', content);
  try {
    fs.symlinkSync(externalRoot, historicalRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`PLATFORM_CAPABILITY_SKIP_CANONICAL_HISTORICAL_ROOT_LINK:${error.code || error.message}`);
    return;
  }
  assertBlocking(validateLedger({ root: scenario.root, ledgerPath: scenario.ledgerPath }), 'HISTORICAL_RECONCILIATION_EVIDENCE_FILESYSTEM_SECURITY');
});

test('H34: the canonical authority parent cannot be a symlink or junction', (t) => {
  const governedPath = 'governance/authority/historical/GATE00/report.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h34',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-authority.json', governedPath, content }]
  });
  const authorityPath = path.join(scenario.root, 'governance', 'authority');
  const externalAuthority = path.join(scenario.root, 'outside-authority-parent');
  fs.mkdirSync(path.dirname(externalAuthority), { recursive: true });
  fs.cpSync(authorityPath, externalAuthority, { recursive: true });
  fs.rmSync(authorityPath, { recursive: true, force: true });
  try {
    fs.symlinkSync(externalAuthority, authorityPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`PLATFORM_CAPABILITY_SKIP_CANONICAL_AUTHORITY_PARENT_LINK:${error.code || error.message}`);
    return;
  }
  assertBlocking(validateLedger({ root: scenario.root, ledgerPath: scenario.ledgerPath }), 'HISTORICAL_RECONCILIATION_EVIDENCE_FILESYSTEM_SECURITY');
});

test('H33D: the production helper deterministically blocks a simulated historical-root link', () => {
  const governedPath = 'governance/authority/historical/GATE00/report.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h33d',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-root-deterministic.json', governedPath, content }]
  });
  const historicalRoot = path.resolve(scenario.root, 'governance/authority/historical');
  const candidatePath = path.resolve(scenario.root, governedPath);
  const externalRoot = path.resolve(scenario.root, 'outside-historical-root-deterministic');
  const externalCandidate = path.join(externalRoot, 'GATE00', 'report.json');
  writeFile(scenario.root, 'outside-historical-root-deterministic/GATE00/report.json', content);
  const calls = [];
  const fsOps = {
    lstatSync(target) {
      const resolved = path.resolve(target);
      calls.push({ operation: 'lstatSync', target: resolved });
      if (resolved === historicalRoot) return { isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false };
      return fs.lstatSync(target);
    },
    realpathSync(target) {
      const resolved = path.resolve(target);
      calls.push({ operation: 'realpathSync', target: resolved });
      if (resolved === historicalRoot) return externalRoot;
      if (resolved === candidatePath) return externalCandidate;
      if (resolved === path.join(historicalRoot, 'GATE00')) return path.join(externalRoot, 'GATE00');
      return fs.realpathSync.native(target);
    }
  };
  const result = resolveHistoricalEvidenceFilesystemPath({ root: scenario.root, governedPath, fsOps });
  assert.equal(result.status, 'INDIRECTION');
  assert.equal(result.component, historicalRoot);
  assert.equal(result.realPath, externalRoot);
  assert.ok(calls.some(({ operation, target }) => operation === 'lstatSync' && target === historicalRoot));
  assert.ok(calls.some(({ operation, target }) => operation === 'realpathSync' && target === historicalRoot));
});

test('H34D: the production helper deterministically blocks a simulated authority-parent link', () => {
  const governedPath = 'governance/authority/historical/GATE00/report.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'h34d',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-authority-deterministic.json', governedPath, content }]
  });
  const authorityPath = path.resolve(scenario.root, 'governance/authority');
  const externalAuthority = path.resolve(scenario.root, 'outside-authority-parent-deterministic');
  const calls = [];
  const fsOps = {
    lstatSync(target) {
      const resolved = path.resolve(target);
      calls.push({ operation: 'lstatSync', target: resolved });
      if (resolved === authorityPath) return { isSymbolicLink: () => true, isDirectory: () => true, isFile: () => false };
      return fs.lstatSync(target);
    },
    realpathSync(target) {
      const resolved = path.resolve(target);
      calls.push({ operation: 'realpathSync', target: resolved });
      if (resolved === authorityPath) return externalAuthority;
      return fs.realpathSync.native(target);
    }
  };
  const result = resolveHistoricalEvidenceFilesystemPath({ root: scenario.root, governedPath, fsOps });
  assert.equal(result.status, 'INDIRECTION');
  assert.equal(result.component, authorityPath);
  assert.equal(result.realPath, externalAuthority);
  assert.ok(calls.some(({ operation, target }) => operation === 'lstatSync' && target === authorityPath));
  assert.ok(calls.some(({ operation, target }) => operation === 'realpathSync' && target === authorityPath));
});

// ===========================================================================
// REPAIR R1 POSITIVE CONTROLS
// ===========================================================================

test('P06: the owner authorization binds one exact reconciliationId and one exact evidence digest', () => {
  const scenario = buildScenario({ prefix: 'p06', cohort: GENUINE_COHORT });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });

  const [approval] = scenario.owner.authorizedReconciliations;
  assert.equal(scenario.owner.authorizedReconciliations.length, 1);
  assert.equal(approval.reconciliationId, scenario.record.reconciliationId);
  assert.equal(approval.gateId, scenario.record.gateId);
  assert.equal(approval.historicalDisposition, scenario.record.historicalDisposition);
  assert.equal(approval.canonicalCurrentStatus, scenario.record.canonicalCurrentStatus);

  // The digest the owner approved is the one an independent recomputation of the record's own
  // cohort produces — the record never gets to assert it.
  const recomputed = computeEvidenceCohortDigest(scenario.record.authorityCohort);
  assert.equal(recomputed.reason, null);
  assert.equal(recomputed.digest, approval.evidenceCohortDigest);
  assert.equal(recomputed.digest, scenario.record.evidenceCohortDigest);

  // The owner authorization is a separate document: it lives outside the record and the record only
  // ever points at it by governed path plus hash, so a record can never authorize itself.
  assert.notEqual(scenario.record.ownerAuthorizationPath, scenario.recordRel);
  assert.equal(sha256Bytes(fs.readFileSync(path.join(scenario.root, OWNER_REL))), scenario.record.ownerAuthorizationSha256);
});

test('P07: cohort identity is canonical — iteration order never changes the digest, content always does', () => {
  const items = [
    { gateId: 'GATE00', evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\a.json', governedPath: 'governance/authority/historical/GATE00/A.json', byteLength: 10, sha256: 'a'.repeat(64) },
    { gateId: 'GATE00', evidenceRole: 'INDEPENDENT_AUDIT', historicalLocator: 'C:\\Temp\\b.md', governedPath: 'governance/authority/historical/GATE00/B.md', byteLength: 20, sha256: 'b'.repeat(64) },
    { gateId: 'GATE00', evidenceRole: 'MISSION_PROMPT', historicalLocator: '/mnt/c.txt', governedPath: 'governance/authority/historical/GATE00/C.txt', byteLength: 30, sha256: 'c'.repeat(64) }
  ];
  const base = computeEvidenceCohortDigest(items).digest;
  assert.match(base, /^[a-f0-9]{64}$/);

  // Order-independent.
  for (const permutation of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) {
    assert.equal(computeEvidenceCohortDigest(permutation.map((i) => items[i])).digest, base);
  }
  // Machine-specific provenance is excluded from permanent identity.
  assert.equal(computeEvidenceCohortDigest(items.map((i) => ({ ...i, historicalLocator: `/other/root/${i.governedPath}` }))).digest, base);
  // Every bound field changes identity.
  for (const field of ['gateId', 'evidenceRole', 'governedPath', 'byteLength', 'sha256']) {
    const mutated = items.map((item, i) => (i === 1 ? { ...item, [field]: typeof item[field] === 'number' ? item[field] + 1 : `${item[field]}X` } : item));
    assert.notEqual(computeEvidenceCohortDigest(mutated).digest, base, `${field} must change cohort identity`);
  }
  // Duplicates are never additional proof.
  assert.deepEqual(computeEvidenceCohortDigest([items[0], { ...items[0] }]), { digest: null, reason: 'DUPLICATE_COHORT_ENTRY' });
  assert.equal(computeEvidenceCohortDigest([]).digest, null);
  assert.equal(computeEvidenceCohortDigest([{ ...items[0], sha256: 42 }]).reason, 'MALFORMED_COHORT_ITEM');

  // End to end: the same cohort declared in a different order is the same authorized reconciliation.
  const forward = buildScenario({ prefix: 'p07a', cohort: GENUINE_COHORT });
  const reversed = buildScenario({ prefix: 'p07b', cohort: [...GENUINE_COHORT].reverse() });
  assertApplied(reversed.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  assert.equal(reversed.record.evidenceCohortDigest, forward.record.evidenceCohortDigest);
});

test('P08: governed paths beneath the canonical historical root are accepted identically on Windows and POSIX', () => {
  const valid = [
    'governance/authority/historical/GATE00/REPORT.md',
    'governance/authority/historical/GATE04/nested/deeper/RESIDUAL_OBLIGATION.json',
    'governance/authority/historical/GATE40/report-with.dots_and-dashes.txt'
  ];
  for (const governedPath of valid) assert.equal(classifyHistoricalEvidencePath(governedPath), 'OK', governedPath);

  // classifyHistoricalEvidencePath consults path.win32 and path.posix explicitly and never the
  // host-native `path`, so these verdicts are the same on every runner.
  const source = fs.readFileSync(path.join(REPO_ROOT, 'governance', 'tools', 'validate-status-ledger.mjs'), 'utf8');
  const body = source.slice(source.indexOf('export function classifyHistoricalEvidencePath'), source.indexOf('export const EVIDENCE_COHORT_DIGEST_ALGORITHM'));
  assert.ok(!/[^.\w]path\.isAbsolute\(/.test(body), 'host-native path.isAbsolute must not decide portability');
  assert.ok(body.includes('path.win32.isAbsolute') && body.includes('path.posix.isAbsolute'));

  const scenario = buildScenario({
    prefix: 'p08',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\deep.md', governedPath: 'governance/authority/historical/GATE00/nested/deeper/CLOSURE.md', content: '# closure\nCOMPLETE\n' }]
  });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
});

test('P09: runtime owner-authorization validation is equivalent to the JSON Schema, case by case', () => {
  // Each mutation is applied to the same otherwise-valid authorization; the runtime verdict and the
  // schema verdict must agree on every one of them, in both directions.
  const mutations = {
    valid: (o) => o,
    'missing-document': (o) => { const { document, ...rest } = o; return rest; },
    'missing-authorityId': (o) => { const { authorityId, ...rest } = o; return rest; },
    'missing-issuedAtUtc': (o) => { const { issuedAtUtc, ...rest } = o; return rest; },
    'missing-authorizedReconciliations': (o) => { const { authorizedReconciliations, ...rest } = o; return rest; },
    'unknown-property': (o) => ({ ...o, sneaky: 1 }),
    'wrong-schemaVersion': (o) => ({ ...o, schemaVersion: 2 }),
    'wrong-issuedBy': (o) => ({ ...o, issuedBy: 'SOMEONE_ELSE' }),
    'wrong-authorityClass': (o) => ({ ...o, authorityClass: 'SOMETHING_ELSE' }),
    'reexecution-authorized': (o) => ({ ...o, reexecutionAuthorized: true }),
    'external-confirmation-granted': (o) => ({ ...o, externalConfirmationGranted: true }),
    'empty-authorityId': (o) => ({ ...o, authorityId: '' }),
    'malformed-issuedAtUtc': (o) => ({ ...o, issuedAtUtc: '2026-08-10 00:00:00' }),
    'nested-missing-digest': (o) => ({ ...o, authorizedReconciliations: o.authorizedReconciliations.map(({ evidenceCohortDigest, ...rest }) => rest) }),
    'nested-unknown-property': (o) => ({ ...o, authorizedReconciliations: o.authorizedReconciliations.map((a) => ({ ...a, extra: true })) }),
    'nested-bad-enum': (o) => ({ ...o, authorizedReconciliations: o.authorizedReconciliations.map((a) => ({ ...a, canonicalCurrentStatus: 'COMPLETE_CONFIRMED' })) }),
    'empty-allow-list': (o) => ({ ...o, authorizedReconciliations: [] })
  };

  for (const [name, ownerPatch] of Object.entries(mutations)) {
    const scenario = buildScenario({ prefix: `p09-${name}`, ownerPatch });
    const schemaValid = validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).valid;
    const runtimeRejectedAsInvalid = scenario.report.findings.some((f) =>
      f.detectorId === 'HISTORICAL_RECONCILIATION_UNAUTHORIZED' && f.jsonPointer === '/ownerAuthorizationPath');
    assert.equal(runtimeRejectedAsInvalid, !schemaValid, `runtime and schema must agree for ${name}`);
    if (schemaValid) assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  }
});

test('P10: GATE04 PARTIAL -> INTERRUPTED_RESUMABLE still succeeds under owner-bound exact cohort', () => {
  const gateId = 'GATE04';
  const cohort = [
    { evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'C:\\Users\\owner\\AppData\\Local\\Temp\\gate04\\interrupted-report.md', governedPath: `governance/authority/historical/${gateId}/PARTIAL_DISPOSITION.md`, content: '# GATE04\nhistorical disposition: PARTIAL\n' },
    { evidenceRole: 'RESIDUAL_OBLIGATION_EVIDENCE', historicalLocator: 'C:\\Users\\owner\\AppData\\Local\\Temp\\gate04\\residual.json', governedPath: `governance/authority/historical/${gateId}/RESIDUAL_OBLIGATION.json`, content: '{"remaining":"closure evidence"}\n' }
  ];
  const scenario = buildScenario({ prefix: 'p10', gateId, historicalDisposition: 'PARTIAL', cohort });
  assertApplied(scenario.report, { gateId, expectedStatus: 'INTERRUPTED_RESUMABLE', historicalDisposition: 'PARTIAL' });

  // The historical word stays separate from the governed status, and the residual survives, bound to
  // a cohort item that the owner's digest covers.
  assert.equal(scenario.record.historicalDisposition, 'PARTIAL');
  assert.equal(scenario.record.canonicalCurrentStatus, 'INTERRUPTED_RESUMABLE');
  assert.equal(scenario.record.residualObligation.evidenceGovernedPath, cohort[1].governedPath);
  assert.equal(
    scenario.owner.authorizedReconciliations[0].evidenceCohortDigest,
    computeEvidenceCohortDigest(scenario.record.authorityCohort).digest
  );
  assert.deepEqual(validateAgainstJsonSchema(scenario.record, RECORD_SCHEMA).errors, []);
  assert.deepEqual(validateAgainstJsonSchema(scenario.owner, OWNER_SCHEMA).errors, []);

  // COMPLETE_CONFIRMED remains unreachable and PARTIAL remains a non-status.
  assert.ok(!scenario.report.events.some((e) => e.toStatus === 'COMPLETE_CONFIRMED'));
  assert.ok(!scenario.report.gates.some((g) => g.currentStatus === 'PARTIAL'));
});

test('P11: a regular historical authority file is physically contained and accepted', () => {
  const scenario = buildScenario({
    prefix: 'p11',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\regular.json', governedPath: 'governance/authority/historical/GATE00/regular.json', content: '{"closure":"COMPLETE"}\n' }]
  });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
});

test('P12: a canonical NFC governedPath is preserved and accepted', () => {
  const governedPath = `governance/authority/historical/GATE00/caf\u00e9.json`;
  assert.equal(isCanonicalGovernedPathUnicode(governedPath), true);
  const scenario = buildScenario({
    prefix: 'p12',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\nfc.json', governedPath, content: '{"closure":"COMPLETE"}\n' }]
  });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
  assert.equal(scenario.record.authorityCohort[0].governedPath, governedPath);
});

test('P13: nested regular directories without indirection are accepted', () => {
  const scenario = buildScenario({
    prefix: 'p13',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\nested.json', governedPath: 'governance/authority/historical/GATE00/nested/deeper/report.json', content: '{"closure":"COMPLETE"}\n' }]
  });
  assertApplied(scenario.report, { gateId: 'GATE00', expectedStatus: 'COMPLETE_AGENT', historicalDisposition: 'COMPLETE' });
});

test('P14: the production filesystem helper accepts an injected regular file inside the root', () => {
  const governedPath = 'governance/authority/historical/GATE00/deterministic-regular.json';
  const content = '{"closure":"COMPLETE"}\n';
  const scenario = buildScenario({
    prefix: 'p14',
    cohort: [{ evidenceRole: 'STATUS_DISPOSITION_AUTHORITY', historicalLocator: 'D:\\archive\\gate00-deterministic-regular.json', governedPath, content }]
  });
  const calls = [];
  const fsOps = {
    lstatSync(target) {
      calls.push({ operation: 'lstatSync', target });
      return fs.lstatSync(target);
    },
    realpathSync(target) {
      calls.push({ operation: 'realpathSync', target });
      return fs.realpathSync.native(target);
    }
  };

  const result = resolveHistoricalEvidenceFilesystemPath({ root: scenario.root, governedPath, fsOps });
  assert.equal(result.status, 'OK');
  assert.equal(path.resolve(result.realCandidate), path.resolve(scenario.root, governedPath));
  assert.ok(calls.some(({ operation }) => operation === 'lstatSync'));
  assert.ok(calls.some(({ operation }) => operation === 'realpathSync'));
});
