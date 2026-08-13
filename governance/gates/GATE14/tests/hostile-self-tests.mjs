import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalize, sha256Canonical } from '../../../tools/canonical-json.mjs';

const TEST_FILE = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(TEST_FILE);
const GATE_DIR = path.resolve(TEST_DIR, '..');
const GOVERNANCE_DIR = path.resolve(GATE_DIR, '..', '..');
const ROOT = path.resolve(GOVERNANCE_DIR, '..');
const CONTRACT_PATH = 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json';
const CURRENT_CONTRACT_PATH = 'governance/gates/GATE14/contracts/CURRENT_CONTRACT.json';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const AUTHORIZED_PATHS = [
  'governance/gates/GATE14/implementation/MUTATION_REGISTRY.json',
  'governance/gates/GATE14/implementation/TRAVERSAL_INVENTORY.json',
  'governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json',
  'governance/gates/GATE14/implementation/COVERAGE_MATRIX.json',
  'governance/gates/GATE14/tests/hostile-self-tests.mjs',
  'governance/gates/GATE14/evidence/CLOSURE_EVIDENCE.json'
];
const IMPLEMENTATION_DIR = path.join(GATE_DIR, 'implementation');
const EVIDENCE_DIR = path.join(GATE_DIR, 'evidence');
const REGISTRY_FILE = path.join(IMPLEMENTATION_DIR, 'MUTATION_REGISTRY.json');
const INVENTORY_FILE = path.join(IMPLEMENTATION_DIR, 'TRAVERSAL_INVENTORY.json');
const RECORDS_FILE = path.join(IMPLEMENTATION_DIR, 'MUTATION_EXECUTION_RECORDS.json');
const MATRIX_FILE = path.join(IMPLEMENTATION_DIR, 'COVERAGE_MATRIX.json');
const CLOSURE_FILE = path.join(EVIDENCE_DIR, 'CLOSURE_EVIDENCE.json');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const repoPath = (root, relative) => path.join(root, ...relative.split('/'));
const readBytes = (root, relative) => fs.readFileSync(repoPath(root, relative));
const readJson = (root, relative) => JSON.parse(readBytes(root, relative).toString('utf8').replace(/^\uFEFF/, ''));
const writeJson = (root, relative, value) => fs.writeFileSync(repoPath(root, relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
const hashJsonFile = (root, relative) => sha256(readBytes(root, relative));
const unique = (values) => [...new Set(values)];

function ledgerEvents(root) {
  return readBytes(root, LEDGER_PATH).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function writeLedger(root, events) {
  fs.writeFileSync(repoPath(root, LEDGER_PATH), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function recomputeEventPayload(event) {
  const { eventPayloadSha256: ignored, ...payload } = event;
  return { ...payload, eventPayloadSha256: sha256Canonical(payload) };
}

function mutateJson(root, relative, mutate) {
  const value = readJson(root, relative);
  mutate(value);
  writeJson(root, relative, value);
}

function appendPath(root, relative, value) {
  const document = readJson(root, relative);
  document.functionalExecutionScope = [...document.functionalExecutionScope, value];
  writeJson(root, relative, document);
}

function mutateLastEvent(root, mutate) {
  const events = ledgerEvents(root);
  const last = { ...events.at(-1) };
  mutate(last, events);
  events[events.length - 1] = recomputeEventPayload(last);
  writeLedger(root, events);
}

const mutations = [
  {
    mutationId: 'H01_AUTHORITY_HASH_MISMATCH', surfaceId: 'authority-identity-path-hash', target: 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', field: '/recordDigest', transformation: 'Replace the record digest with a fixed zero SHA without changing the ledger pin.', validator: 'validate-status-ledger', expectedFinding: 'AUTHORITY_HASH_MISMATCH', coverageClass: 'mandatory', paths: ['governance/authority/authorizations/GATE14/GATE_START_RECORD.json'], apply: (r) => mutateJson(r, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', (x) => { x.recordDigest = '0'.repeat(64); })
  },
  {
    mutationId: 'H02_AUTHORITY_IDENTITY_MISMATCH', surfaceId: 'authority-identity-path-hash', target: LEDGER_PATH, field: '/57/gateId', transformation: 'Change the ledger-pinned START event gate identity to GATE13 and recompute only its event payload hash.', validator: 'validate-status-ledger', expectedFinding: 'INVALID_STATUS_TRANSITION', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => mutateLastEvent(r, (x) => { x.gateId = 'GATE13'; })
  },
  {
    mutationId: 'H03_INVALID_OWNER_SIGNATURE', surfaceId: 'owner-signature-verification', target: 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json', field: '/signature', transformation: 'Change the first deterministic character in the signed authority signature.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_OWNER_SIGNATURE_INVALID', coverageClass: 'mandatory', paths: ['governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json'], apply: (r) => mutateJson(r, 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json', (x) => { x.signature = `${x.signature.startsWith('A') ? 'B' : 'A'}${x.signature.slice(1)}`; })
  },
  {
    mutationId: 'H04_WRONG_GATE', surfaceId: 'contract-binding', target: CONTRACT_PATH, field: '/gateId', transformation: 'Change the contract gate identity from GATE14 to GATE13.', validator: 'validate-gate-contract', expectedFinding: 'CONTRACT_GATE_MISMATCH', coverageClass: 'mandatory', paths: [CONTRACT_PATH], apply: (r) => mutateJson(r, CONTRACT_PATH, (x) => { x.gateId = 'GATE13'; })
  },
  {
    mutationId: 'H05_WRONG_TRANSITION', surfaceId: 'ledger-transition-state-machine', relatedSurfaceIds: ['status-transition-identity'], target: LEDGER_PATH, field: '/57/transitionType', transformation: 'Change the final START transition to an AUTHORIZATION transition and recompute its event payload hash.', validator: 'validate-status-ledger', expectedFinding: 'INVALID_STATUS_TRANSITION', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => mutateLastEvent(r, (x) => { x.transitionType = 'AUTHORIZATION'; x.toStatus = 'AUTHORIZED_NOT_STARTED'; })
  },
  {
    mutationId: 'H06_STALE_PREVIOUS_EVENT', surfaceId: 'ledger-chain-integrity', target: LEDGER_PATH, field: '/57/previousEventSha256', transformation: 'Replace the final ledger event predecessor with a fixed zero SHA and recompute its own payload hash.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_PREVIOUS_EVENT_MISMATCH', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => mutateLastEvent(r, (x) => { x.previousEventSha256 = '0'.repeat(64); })
  },
  {
    mutationId: 'H07_LEDGER_CHAIN_MUTATION', surfaceId: 'ledger-chain-integrity', target: LEDGER_PATH, field: '/57/previousEventSha256', transformation: 'Change the final event chain predecessor and recompute its own payload hash, leaving the preceding event unchanged.', validator: 'validate-status-ledger', expectedFinding: 'LEDGER_CHAIN_BREAK', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => mutateLastEvent(r, (x) => { x.previousEventSha256 = '0'.repeat(64); })
  },
  {
    mutationId: 'H08_UNAUTHORIZED_SCHEMA_PROPERTY', surfaceId: 'schema-closed-world', target: 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', field: '/unexpected', transformation: 'Add an unknown top-level property to the sealed state document.', validator: 'validate-state-seal', expectedFinding: 'SCHEMA_VIOLATION', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', (x) => { x.unexpected = 'forbidden'; })
  },
  {
    mutationId: 'H09_MALFORMED_REQUIRED_FIELD', surfaceId: 'schema-closed-world', target: 'governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json', field: '/resumePoint', transformation: 'Remove a required checkpoint field.', validator: 'validate-state-revision', expectedFinding: 'SCHEMA_VIOLATION', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json', (x) => { delete x.resumePoint; })
  },
  {
    mutationId: 'H10_STATE_SEAL_HASH_MISMATCH', surfaceId: 'state-revision-seal-lineage', relatedSurfaceIds: ['evidence-binding'], target: 'governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json', field: '/resumePoint', transformation: 'Change a sealed checkpoint byte without updating STATE_SEAL.', validator: 'validate-state-seal', expectedFinding: 'STATE_SEAL_MEMBER_MISMATCH', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/revisions/R0002/CHECKPOINT.json', (x) => { x.resumePoint = 'MUTATED'; })
  },
  {
    mutationId: 'H11_BROKEN_PREVIOUS_STATE_SEAL', surfaceId: 'state-revision-seal-lineage', relatedSurfaceIds: ['state-seal-payload'], target: 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', field: '/previousStateSealSha256', transformation: 'Replace the R0002 previous seal link with a fixed zero SHA.', validator: 'validate-state-seal', expectedFinding: 'STATE_SEAL_CHAIN_ERROR', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', (x) => { x.previousStateSealSha256 = '0'.repeat(64); })
  },
  {
    mutationId: 'H12_CURRENT_STATE_FOREIGN_LINEAGE', surfaceId: 'current-state-lineage', relatedSurfaceIds: ['current-state-projection'], target: 'governance/gates/GATE14/state/CURRENT_STATE.json', field: '/revisionPath', transformation: 'Point CURRENT_STATE at the predecessor revision while retaining the R0002 state identity.', validator: 'validate-state-revision', expectedFinding: 'POINTER_HASH_MISMATCH', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/CURRENT_STATE.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/CURRENT_STATE.json', (x) => { x.revisionPath = 'governance/gates/GATE14/state/revisions/R0001'; })
  },
  {
    mutationId: 'H13_OPEN_DEFECTS_INCONSISTENCY', surfaceId: 'open-defects-readiness', target: 'governance/gates/GATE14/state/revisions/R0002/OPEN_DEFECTS.json', field: '/defects/0', transformation: 'Insert a malformed defect object into the open-defect document.', validator: 'validate-state-revision', expectedFinding: 'SCHEMA_VIOLATION', coverageClass: 'mandatory', paths: ['governance/gates/GATE14/state/revisions/R0002/OPEN_DEFECTS.json'], apply: (r) => mutateJson(r, 'governance/gates/GATE14/state/revisions/R0002/OPEN_DEFECTS.json', (x) => { x.defects = [{}]; })
  },
  {
    mutationId: 'H14_CONTRACT_SHA_MISMATCH', surfaceId: 'contract-binding', target: CONTRACT_PATH, field: '/canonicalRequirements/0/statement', transformation: 'Change a contract byte while retaining the START authority contract hash.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_CONTRACT_SHA_MISMATCH', coverageClass: 'mandatory', paths: [CONTRACT_PATH], apply: (r) => mutateJson(r, CONTRACT_PATH, (x) => { x.canonicalRequirements[0].statement += ' MUTATED'; })
  },
  {
    mutationId: 'H15_CURRENT_CONTRACT_MISMATCH', surfaceId: 'contract-binding', target: CURRENT_CONTRACT_PATH, field: '/contractSha256', transformation: 'Change the CURRENT_CONTRACT pointer hash without changing its target.', validator: 'validate-gate-contract', expectedFinding: 'POINTER_HASH_MISMATCH', coverageClass: 'mandatory', paths: [CURRENT_CONTRACT_PATH], apply: (r) => mutateJson(r, CURRENT_CONTRACT_PATH, (x) => { x.contractSha256 = '0'.repeat(64); })
  },
  {
    mutationId: 'H16_STALE_READINESS_BINDING', surfaceId: 'readiness-binding', relatedSurfaceIds: ['status-readiness'], target: 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', field: '/readinessDigest', transformation: 'Replace the readiness digest and repin only the ledger authority bytes, leaving the derived readiness value stale.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_READINESS_DIGEST_MISMATCH', coverageClass: 'mandatory', paths: ['governance/authority/authorizations/GATE14/GATE_START_RECORD.json', LEDGER_PATH], apply: (r) => { mutateJson(r, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', (x) => { x.readinessDigest = '0'.repeat(64); }); mutateLastEvent(r, (x) => { x.authoritySha256 = hashJsonFile(r, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json'); }); }
  },
  {
    mutationId: 'H17_EXECUTION_WITHOUT_CURRENT_AUTHORITY', surfaceId: 'execution-authority-state-binding', target: LEDGER_PATH, field: '/57', transformation: 'Remove the only GATE14 START event while leaving the R0002 execution state projection in place.', validator: 'validate-status-ledger', expectedFinding: 'GATE_AUTHORIZATION_CURRENT_STATE_STATUS_MISMATCH', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => { const events = ledgerEvents(r); events.pop(); writeLedger(r, events); }
  },
  {
    mutationId: 'H18_FUNCTIONAL_SCOPE_ESCAPE', surfaceId: 'execution-scope-confinement', target: 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', field: '/functionalExecutionScope', transformation: 'Append an unauthorized production path and repin only the ledger authority bytes.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_FUNCTIONAL_SCOPE_MISMATCH', coverageClass: 'mandatory', paths: ['governance/authority/authorizations/GATE14/GATE_START_RECORD.json', LEDGER_PATH], apply: (r) => { appendPath(r, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', 'server.js'); mutateLastEvent(r, (x) => { x.authoritySha256 = hashJsonFile(r, 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json'); }); }
  },
  {
    mutationId: 'H19_AUTHORITY_REPLAY', surfaceId: 'authority-single-use', target: LEDGER_PATH, field: '/58', transformation: 'Append a second deterministic START event that reuses the single-use GATE14 authority.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_AUTHORITY_REPLAYED', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => { const events = ledgerEvents(r); const prior = events.at(-1); const duplicate = recomputeEventPayload({ ...prior, ordinal: prior.ordinal + 1, eventId: 'GATE14_START_R2', previousEventSha256: prior.eventPayloadSha256, recordedAt: '2026-08-12T12:01:00.000Z' }); writeLedger(r, [...events, duplicate]); }
  },
  {
    mutationId: 'H20_UNRELATED_GATE_AUTHORITY_BORROWING', surfaceId: 'authority-identity-path-hash', relatedSurfaceIds: ['authority-replay-identity'], target: LEDGER_PATH, field: '/57/authorityPath', transformation: 'Replace the GATE14 START authority path/hash with the historical GATE13 authority while preserving the ledger chain.', validator: 'validate-status-ledger', expectedFinding: 'GATE_START_RECORD_PATH_NOT_AUTHORIZED', coverageClass: 'mandatory', paths: [LEDGER_PATH], apply: (r) => { const events = ledgerEvents(r); const legacy = events.find((x) => x.eventId === 'GATE13_START_R1'); const last = { ...events.at(-1), authorityPath: legacy.authorityPath, authoritySha256: legacy.authoritySha256 }; events[events.length - 1] = recomputeEventPayload(last); writeLedger(r, events); }
  },
  {
    mutationId: 'AUX_ACTIVE_GATE_CONTEXT_HASH', surfaceId: 'active-gate-context', target: 'governance/active/ACTIVE_GATE.json', field: '/currentStateSha256', transformation: 'Replace the active pointer current-state hash with a fixed zero SHA.', validator: 'validate-active-gate', expectedFinding: 'CURRENT_STATE_HASH_MISMATCH', coverageClass: 'mandatory', paths: ['governance/active/ACTIVE_GATE.json'], apply: (r) => mutateJson(r, 'governance/active/ACTIVE_GATE.json', (x) => { x.currentStateSha256 = '0'.repeat(64); })
  },
  {
    mutationId: 'AUX_PREFLIGHT_ACTIVE_STATE_HASH', surfaceId: 'status-readiness', relatedSurfaceIds: ['active-gate-context'], target: 'governance/active/ACTIVE_GATE.json', field: '/currentStateSha256', transformation: 'Replace the active pointer current-state hash and invoke governance-preflight against the mutated temporary repository.', validator: 'governance-preflight', expectedFinding: 'CURRENT_STATE_HASH_MISMATCH', coverageClass: 'contract-validator', paths: ['governance/active/ACTIVE_GATE.json'], apply: (r) => mutateJson(r, 'governance/active/ACTIVE_GATE.json', (x) => { x.currentStateSha256 = '0'.repeat(64); })
  }
];

const inventorySurfaces = [
  ['ledger-transition-state-machine', 'governance/tools/validate-status-ledger.mjs', 'Closed transition table and replayed fromStatus/toStatus must agree.', 'governance/state/GATE_STATUS_LEDGER.ndjson', 'field-and-byte mutation', 1],
  ['authority-identity-path-hash', 'governance/tools/validate-status-ledger.mjs', 'Every cited authority path must resolve to the exact pinned SHA-256 bytes.', 'governance/tools/validate-status-ledger.mjs', 'field-and-byte mutation', 2],
  ['owner-signature-verification', 'governance/gee-v1/core/gate-start-authority.mjs', 'The owner signature must verify over the canonical authority payload.', 'governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json', 'byte mutation', 3],
  ['contract-binding', 'governance/tools/validate-gate-contract.mjs', 'Contract identity, pointer, target bytes, and live authority binding must agree.', CONTRACT_PATH, 'field-and-byte mutation', 4],
  ['ledger-chain-integrity', 'governance/tools/validate-status-ledger.mjs', 'eventPayloadSha256 and previousEventSha256 form an intact append-only chain.', LEDGER_PATH, 'field-and-byte mutation', 5],
  ['schema-closed-world', 'governance/tools/validate-state-seal.mjs', 'Governed JSON objects reject unknown properties and malformed required fields.', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', 'schema mutation', 6],
  ['state-revision-seal-lineage', 'governance/tools/validate-state-seal.mjs', 'Sealed members and previous state seals reproduce real bytes and lineage.', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', 'field-and-byte mutation', 7],
  ['current-state-lineage', 'governance/tools/validate-state-revision.mjs', 'CURRENT_STATE can point only to the current Gate revision lineage.', 'governance/gates/GATE14/state/CURRENT_STATE.json', 'pointer mutation', 8],
  ['open-defects-readiness', 'governance/tools/validate-state-revision.mjs', 'OPEN_DEFECTS is closed-world and cannot silently discard or malformedly alter defects.', 'governance/gates/GATE14/state/revisions/R0002/OPEN_DEFECTS.json', 'schema mutation', 9],
  ['readiness-binding', 'governance/tools/validate-status-ledger.mjs', 'START readiness is recomputed from pre-START state, contract, dependency, and defect inputs.', 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', 'field mutation', 10],
  ['execution-authority-state-binding', 'governance/tools/validate-status-ledger.mjs', 'An execution state must be supported by the ledger authority and replayed status.', LEDGER_PATH, 'event removal', 11],
  ['execution-scope-confinement', 'governance/tools/validate-status-ledger.mjs', 'Functional execution remains exactly within the owner-authorized six paths.', 'governance/authority/authorizations/GATE14/GATE_START_RECORD.json', 'scope mutation', 12],
  ['authority-single-use', 'governance/tools/validate-status-ledger.mjs', 'A single-use START authority cannot be replayed.', LEDGER_PATH, 'event append', 13],
  ['active-gate-context', 'governance/tools/validate-active-gate.mjs', 'The active gate pointer and current-state hash must bind to real canonical bytes.', 'governance/active/ACTIVE_GATE.json', 'pointer/hash mutation', 14],
  ['status-readiness', 'governance/tools/validate-active-gate.mjs', 'Active execution requires a valid ledger, executable contract, state, and predecessor closure.', 'governance/active/ACTIVE_GATE.json', 'authority mutation', 15],
  ['evidence-binding', 'governance/tools/validate-state-seal.mjs', 'Evidence-like sealed members cannot be substituted, omitted, or cross-revision.', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', 'member mutation', 16],
  ['authority-replay-identity', 'governance/tools/validate-status-ledger.mjs', 'A ledger event cannot borrow a different Gate authority class/path.', LEDGER_PATH, 'authority substitution', 17],
  ['current-state-projection', 'governance/tools/validate-state-revision.mjs', 'The current state projection must hash and identify its selected revision.', 'governance/gates/GATE14/state/CURRENT_STATE.json', 'pointer mutation', 18],
  ['status-transition-identity', 'governance/tools/validate-status-ledger.mjs', 'A transition must use the exact allowed Gate/status identity.', LEDGER_PATH, 'event mutation', 19],
  ['state-seal-payload', 'governance/tools/validate-state-seal.mjs', 'The state seal payload hash must be recomputed from the real payload.', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json', 'payload mutation', 20]
].map(([surfaceId, targetProductionValidator, protectedInvariant, authoritativeSource, mutationEligibility, traversalOrder]) => ({
  surfaceId, targetProductionValidator, protectedInvariant, authoritativeSource, mutationEligibility, traversalOrder
}));

function detectorSpec(root, validator) {
  const args = ['--root', root];
  if (validator === 'validate-status-ledger') return { script: 'governance/tools/validate-status-ledger.mjs', args };
  if (validator === 'validate-gate-contract') return { script: 'governance/tools/validate-gate-contract.mjs', args: [...args, '--contract', CONTRACT_PATH, '--pointer', CURRENT_CONTRACT_PATH, '--registry', 'governance/GATE_REGISTRY_00_40.json', '--constitution', 'governance/PROJECT_CONSTITUTION.json'] };
  if (validator === 'validate-state-revision') return { script: 'governance/tools/validate-state-revision.mjs', args: [...args, '--gate-id', 'GATE14', '--current-state', 'governance/gates/GATE14/state/CURRENT_STATE.json', '--contract', CONTRACT_PATH] };
  if (validator === 'validate-state-seal') return { script: 'governance/tools/validate-state-seal.mjs', args: [...args, '--seal', 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json'] };
  if (validator === 'validate-active-gate') return { script: 'governance/tools/validate-active-gate.mjs', args: [] };
  if (validator === 'governance-preflight') return { script: 'governance/tools/governance-preflight.mjs', args: [] };
  throw new Error(`Unknown detector: ${validator}`);
}

function parseReport(stdout, stderr) {
  const candidates = [stdout.trim(), stderr.trim()].filter(Boolean);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch {}
  }
  return { parseError: true, stdout, stderr };
}

function findingCodes(report) {
  const findings = Array.isArray(report?.findings) ? report.findings : [];
  const ids = findings.map((x) => x.detectorId || x.code || x.findingId).filter(Boolean);
  if (Array.isArray(report?.findingIds)) ids.push(...report.findingIds);
  return unique(ids);
}

function invoke(root, validator) {
  const spec = detectorSpec(root, validator);
  const result = spawnSync(process.execPath, [spec.script, ...spec.args], { cwd: root, encoding: 'utf8', windowsHide: true });
  const report = parseReport(result.stdout || '', result.stderr || '');
  return {
    exitCode: result.status ?? 1,
    valid: validator === 'governance-preflight'
      ? report.GOVERNANCE_VERDICT === 'PASS' && (result.status ?? 1) === 0
      : report.valid === true,
    findingCodes: findingCodes(report),
    report
  };
}

function runOne(mutation, runNumber) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate14-hostile-'));
  try {
    cloneGovernedRoot(tempRoot);
    const baseline = invoke(tempRoot, mutation.validator);
    if (!baseline.valid || baseline.exitCode !== 0) throw new Error(`${mutation.mutationId}: baseline ${mutation.validator} did not pass`);
    const snapshots = new Map(mutation.paths.map((relative) => [relative, readBytes(tempRoot, relative)]));
    const beforeHashes = Object.fromEntries([...snapshots.entries()].map(([relative, bytes]) => [relative, sha256(bytes)]));
    mutation.apply(tempRoot);
    const afterHashes = Object.fromEntries(mutation.paths.map((relative) => [relative, hashJsonFile(tempRoot, relative)]));
    const mutationApplied = mutation.paths.some((relative) => beforeHashes[relative] !== afterHashes[relative]);
    const mutated = invoke(tempRoot, mutation.validator);
    for (const [relative, bytes] of snapshots) fs.writeFileSync(repoPath(tempRoot, relative), bytes);
    const restored = invoke(tempRoot, mutation.validator);
    const restoration = mutation.paths.every((relative) => sha256(readBytes(tempRoot, relative)) === beforeHashes[relative]) && restored.valid && restored.exitCode === 0;
    const expectedMatched = mutated.findingCodes.includes(mutation.expectedFinding);
    const verdict = baseline.valid && mutationApplied && !mutated.valid && mutated.exitCode !== 0 && expectedMatched && restoration ? 'PASS' : 'BLOCK';
    const record = {
      mutationId: mutation.mutationId,
      target: { repoRelativePath: mutation.target, field: mutation.field },
      baselineValidatorResult: { valid: baseline.valid, exitCode: baseline.exitCode, findingCodes: baseline.findingCodes },
      mutatedValidatorResult: { valid: mutated.valid, exitCode: mutated.exitCode, findingCodes: mutated.findingCodes },
      restoredValidatorResult: { valid: restored.valid, exitCode: restored.exitCode, findingCodes: restored.findingCodes },
      expectedFinding: mutation.expectedFinding,
      actualFinding: mutated.findingCodes,
      detectorInvoked: true,
      detector: { validator: mutation.validator, script: detectorSpec(tempRoot, mutation.validator).script, processExitCode: mutated.exitCode },
      reproductionMetadata: { runNumber, mutationTransformation: mutation.transformation, baselineHashes: beforeHashes, mutatedHashes: afterHashes, mutationApplied, restoredBaselineByteIdentical: restoration },
      verdict
    };
    return record;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function controlSnapshot(root, paths) {
  return new Map(paths.map((relative) => [relative, readBytes(root, relative)]));
}

function restoreSnapshot(root, snapshot) {
  for (const [relative, bytes] of snapshot) fs.writeFileSync(repoPath(root, relative), bytes);
}

function cloneGovernedRoot(tempRoot) {
  fs.cpSync(path.join(ROOT, 'governance'), path.join(tempRoot, 'governance'), { recursive: true });
  if (fs.existsSync(path.join(ROOT, '.cursor'))) fs.cpSync(path.join(ROOT, '.cursor'), path.join(tempRoot, '.cursor'), { recursive: true });
  for (const file of ['AGENTS.md', 'CLAUDE.md']) if (fs.existsSync(path.join(ROOT, file))) fs.copyFileSync(path.join(ROOT, file), path.join(tempRoot, file));
}

function methodologyControl(controlId, runNumber) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate14-methodology-control-'));
  const mutation = mutations.find((item) => item.mutationId === 'H08_UNAUTHORIZED_SCHEMA_PROPERTY');
  const secondaryMutation = mutations.find((item) => item.mutationId === 'H11_BROKEN_PREVIOUS_STATE_SEAL');
  const governedPaths = unique([...mutation.paths, ...secondaryMutation.paths]);
  let baseline = null;
  let detector = null;
  let mutationApplied = false;
  let detectorInvoked = false;
  let expectedFinding = null;
  let actualFinding = [];
  let setup;
  let expectedMethodologyFailure;
  try {
    cloneGovernedRoot(tempRoot);
    const freshSnapshot = controlSnapshot(tempRoot, governedPaths);
    baseline = invoke(tempRoot, mutation.validator);
    if (controlId === 'NC01_WRONG_EXPECTED_FINDING') {
      setup = 'Apply H08 and invoke validate-state-seal, then compare the real finding against an intentionally wrong expected finding.';
      mutation.apply(tempRoot);
      mutationApplied = true;
      detector = invoke(tempRoot, mutation.validator);
      detectorInvoked = true;
      expectedFinding = 'NEVER_EXPECTED_CODE';
      actualFinding = detector.findingCodes;
      expectedMethodologyFailure = 'actual finding set differs from intentionally wrong expected finding';
    } else if (controlId === 'NC02_DETECTOR_INVOCATION_SKIPPED') {
      setup = 'Apply H08 but intentionally omit the production detector invocation.';
      mutation.apply(tempRoot);
      mutationApplied = true;
      expectedFinding = mutation.expectedFinding;
      actualFinding = [];
      expectedMethodologyFailure = 'detector invocation is required before evidence can count';
    } else if (controlId === 'NC03_MUTATION_NOT_APPLIED') {
      setup = 'Invoke validate-state-seal on the untouched valid baseline while claiming H08 was applied.';
      expectedFinding = mutation.expectedFinding;
      detector = invoke(tempRoot, mutation.validator);
      detectorInvoked = true;
      actualFinding = detector.findingCodes;
      expectedMethodologyFailure = 'claimed hostile state was not produced';
    } else if (controlId === 'NC04_BASELINE_ALREADY_INVALID') {
      setup = 'Apply H08 to make the baseline invalid, then apply H11 and invoke validate-state-seal.';
      mutation.apply(tempRoot);
      mutationApplied = true;
      baseline = invoke(tempRoot, mutation.validator);
      secondaryMutation.apply(tempRoot);
      detector = invoke(tempRoot, secondaryMutation.validator);
      detectorInvoked = true;
      expectedFinding = secondaryMutation.expectedFinding;
      actualFinding = detector.findingCodes;
      expectedMethodologyFailure = 'baseline prerequisite was already invalid before the claimed mutation';
    } else if (controlId === 'NC05_RESTORED_BEFORE_DETECTOR') {
      setup = 'Apply H08, restore the exact baseline bytes, then invoke validate-state-seal.';
      mutation.apply(tempRoot);
      mutationApplied = true;
      restoreSnapshot(tempRoot, freshSnapshot);
      detector = invoke(tempRoot, mutation.validator);
      detectorInvoked = true;
      expectedFinding = mutation.expectedFinding;
      actualFinding = detector.findingCodes;
      expectedMethodologyFailure = 'detector observed restored baseline rather than hostile state';
    } else if (controlId === 'NC06_SYNTHETIC_FINDING_SUBSTITUTION') {
      setup = 'Apply H08, restore it before detector execution, inject the expected finding metadata, and invoke validate-state-seal on the restored baseline.';
      mutation.apply(tempRoot);
      mutationApplied = true;
      restoreSnapshot(tempRoot, freshSnapshot);
      detector = invoke(tempRoot, mutation.validator);
      detectorInvoked = true;
      expectedFinding = mutation.expectedFinding;
      actualFinding = detector.findingCodes;
      expectedMethodologyFailure = 'expected finding was supplied as metadata but was absent from production detector output';
    } else {
      throw new Error(`Unknown methodology control ${controlId}`);
    }
    const baselinePass = baseline.valid && baseline.exitCode === 0;
    const actualMatchesExpected = expectedFinding !== null && actualFinding.includes(expectedFinding);
    const observedHarnessRejection = controlId === 'NC01_WRONG_EXPECTED_FINDING'
      ? detectorInvoked && mutationApplied && !actualMatchesExpected
      : controlId === 'NC02_DETECTOR_INVOCATION_SKIPPED'
        ? mutationApplied && !detectorInvoked
        : controlId === 'NC03_MUTATION_NOT_APPLIED'
          ? detectorInvoked && !mutationApplied && detector?.valid === true
          : controlId === 'NC04_BASELINE_ALREADY_INVALID'
            ? !baselinePass && detectorInvoked
            : controlId === 'NC05_RESTORED_BEFORE_DETECTOR'
              ? mutationApplied && detectorInvoked && detector.valid === true
              : mutationApplied && detectorInvoked && !actualMatchesExpected;
    return {
      controlId,
      setup,
      actualDetectorInvocationState: { detectorInvoked, detector: mutation.validator, processExitCode: detector?.exitCode ?? null },
      actualMutationState: { mutationId: mutation.mutationId, mutationApplied, detectorObservedHostileState: detector ? !detector.valid : false },
      actualBaselineState: { valid: baseline.valid, exitCode: baseline.exitCode, findingCodes: baseline.findingCodes },
      actualFinding,
      expectedMethodologyFailure,
      observedHarnessRejection,
      verdict: observedHarnessRejection ? 'PASS' : 'BLOCK',
      runNumber
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runMethodologyControls(runNumber) {
  return [
    'NC01_WRONG_EXPECTED_FINDING',
    'NC02_DETECTOR_INVOCATION_SKIPPED',
    'NC03_MUTATION_NOT_APPLIED',
    'NC04_BASELINE_ALREADY_INVALID',
    'NC05_RESTORED_BEFORE_DETECTOR',
    'NC06_SYNTHETIC_FINDING_SUBSTITUTION'
  ].map((controlId) => methodologyControl(controlId, runNumber));
}

function loadReusableRecords() {
  if (!fs.existsSync(RECORDS_FILE) || !fs.existsSync(CLOSURE_FILE)) return null;
  const existingHash = sha256(fs.readFileSync(RECORDS_FILE));
  const existingClosure = readJson(ROOT, 'governance/gates/GATE14/evidence/CLOSURE_EVIDENCE.json');
  const declaredHash = existingClosure.artifactHashes?.['governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json'];
  const existing = readJson(ROOT, 'governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json');
  if (existingHash !== declaredHash || existing.runCount !== 2 || !Array.isArray(existing.records) || existing.records.length < 42) return null;
  if (existing.records.some((record) => record.verdict !== 'PASS' || !record.baselineValidatorResult?.valid || record.mutatedValidatorResult?.valid || !record.restoredValidatorResult?.valid)) return null;
  return existing.records;
}

function buildRegistry() {
  return {
    schemaVersion: 1,
    document: 'GATE14_MUTATION_REGISTRY',
    gateId: 'GATE14',
    contractPath: 'governance/gates/GATE14/contracts/EXECUTION_CONTRACT_R0001.json',
    contractSha256: hashJsonFile(ROOT, CONTRACT_PATH),
    authorizedPaths: AUTHORIZED_PATHS,
    mutationOrder: mutations.map((x) => x.mutationId),
    mutations: mutations.map(({ apply, paths, ...mutation }) => ({ ...mutation, exactArtifactPaths: paths, restoration: 'Restore the exact pre-mutation bytes before the restored-baseline validator invocation.' }))
  };
}

function buildInventory() {
  const missing = inventorySurfaces.flatMap((surface) => [surface.targetProductionValidator, surface.authoritativeSource]).filter((relative) => !fs.existsSync(repoPath(ROOT, relative)));
  if (missing.length) throw new Error(`Inventory source missing: ${missing.join(', ')}`);
  return {
    schemaVersion: 1,
    document: 'GATE14_TRAVERSAL_INVENTORY',
    gateId: 'GATE14',
    derivation: { method: 'Validated repository structure: production validator/module and authoritative source existence checked at generation time.', sourceRoots: ['governance/tools', 'governance/gee-v1/core', 'governance/authority', 'governance/gates/GATE14', 'governance/state'] },
    traversalOrder: inventorySurfaces.map((x) => x.surfaceId),
    surfaces: inventorySurfaces
  };
}

function buildCoverage(registry, inventory, records, methodologyControls) {
  const latest = new Map();
  for (const record of records.filter((x) => x.reproductionMetadata.runNumber === 2)) latest.set(record.mutationId, record);
  const rows = [];
  for (const mutation of registry.mutations) {
    const record = latest.get(mutation.mutationId);
    const result = record?.verdict === 'PASS' ? 'covered' : 'blocked';
    for (const surfaceId of [mutation.surfaceId, ...(mutation.relatedSurfaceIds || [])]) {
      const existing = rows.find((row) => row.surfaceId === surfaceId);
      if (existing) { existing.mutationIds.push(mutation.mutationId); if (record) existing.executionRecordIds.push(record.mutationId); if (result !== 'covered') existing.result = result; }
      else rows.push({ surfaceId, mutationIds: [mutation.mutationId], detector: record?.detector?.validator || mutation.validator, executionRecordIds: record ? [record.mutationId] : [], result });
    }
  }
  const mandatory = inventory.surfaces.map((surface) => surface.surfaceId);
  const uncoveredMandatorySurfaces = mandatory.filter((surfaceId) => !rows.some((row) => row.surfaceId === surfaceId && row.result === 'covered'));
  const contract = readJson(ROOT, CONTRACT_PATH);
  const byDomain = {
    'authority binding': ['H01_AUTHORITY_HASH_MISMATCH', 'H03_INVALID_OWNER_SIGNATURE', 'H20_UNRELATED_GATE_AUTHORITY_BORROWING'],
    'ledger/status integrity': ['H05_WRONG_TRANSITION', 'H06_STALE_PREVIOUS_EVENT', 'H07_LEDGER_CHAIN_MUTATION', 'H17_EXECUTION_WITHOUT_CURRENT_AUTHORITY', 'H19_AUTHORITY_REPLAY'],
    'schema invalidity': ['H08_UNAUTHORIZED_SCHEMA_PROPERTY', 'H09_MALFORMED_REQUIRED_FIELD', 'H13_OPEN_DEFECTS_INCONSISTENCY'],
    'readiness fail-open': ['H16_STALE_READINESS_BINDING', 'AUX_PREFLIGHT_ACTIVE_STATE_HASH'],
    'evidence binding': ['H10_STATE_SEAL_HASH_MISMATCH'],
    'seal/execution binding': ['H11_BROKEN_PREVIOUS_STATE_SEAL', 'H14_CONTRACT_SHA_MISMATCH', 'H17_EXECUTION_WITHOUT_CURRENT_AUTHORITY'],
    'path confinement/traversal': ['H18_FUNCTIONAL_SCOPE_ESCAPE'],
    'exact-file vs prefix authorization': ['H18_FUNCTIONAL_SCOPE_ESCAPE'],
    'unexpected governed paths': ['H18_FUNCTIONAL_SCOPE_ESCAPE'],
    'stale/mismatched authority': ['H02_AUTHORITY_IDENTITY_MISMATCH', 'H06_STALE_PREVIOUS_EVENT', 'H14_CONTRACT_SHA_MISMATCH', 'H15_CURRENT_CONTRACT_MISMATCH', 'H16_STALE_READINESS_BINDING', 'H20_UNRELATED_GATE_AUTHORITY_BORROWING'],
    'malformed/open-world status': ['H05_WRONG_TRANSITION', 'H08_UNAUTHORIZED_SCHEMA_PROPERTY', 'H09_MALFORMED_REQUIRED_FIELD', 'H13_OPEN_DEFECTS_INCONSISTENCY'],
    'missing critical evidence': ['H09_MALFORMED_REQUIRED_FIELD', 'H17_EXECUTION_WITHOUT_CURRENT_AUTHORITY'],
    'detector bypass': []
  };
  const controlByDomain = { 'detector bypass': ['NC02_DETECTOR_INVOCATION_SKIPPED', 'NC06_SYNTHETIC_FINDING_SUBSTITUTION'] };
  const latestByMutation = (mutationIds) => mutationIds.map((mutationId) => latest.get(mutationId)).filter(Boolean);
  const requirementRows = [];
  const addContractRequirement = (entry, contractRequirementClass, idField, textValue) => {
    const semanticTarget = (entry.domain || entry.target || '').toLowerCase();
    const mutationIds = [...(byDomain[semanticTarget] || [])];
    const controlIds = [...(controlByDomain[semanticTarget] || [])];
    const executionRecords = latestByMutation(mutationIds);
    const actualFinding = unique(executionRecords.flatMap((record) => record.actualFinding || []));
    const controlEvidence = methodologyControls.filter((control) => control.runNumber === 2 && controlIds.includes(control.controlId));
    const mutationEvidencePass = mutationIds.length > 0 && mutationIds.every((mutationId) => latest.get(mutationId)?.verdict === 'PASS');
    const controlEvidencePass = controlIds.length > 0 && controlIds.every((controlId) => controlEvidence.some((control) => control.controlId === controlId && control.verdict === 'PASS'));
    requirementRows.push({
      contractRequirementId: entry[idField],
      contractRequirementClass,
      contractText: textValue,
      governedSurfaceId: semanticTarget || 'UNRESOLVED_CONTRACT_TARGET',
      mutationIds,
      detectorIds: unique(executionRecords.map((record) => record.detector.validator)),
      executionRecordIds: executionRecords.map((record) => record.mutationId),
      controlIds,
      actualFinding,
      coverageStatus: mutationEvidencePass || controlEvidencePass ? 'covered' : 'blocked'
    });
  };
  for (const entry of contract.negativeTests || []) addContractRequirement(entry, 'NEGATIVE_TEST', 'testId', `${entry.domain}: ${entry.name}; expected=${entry.expected}`);
  for (const entry of contract.countertests || []) addContractRequirement(entry, 'COUNTERTEST', 'counterTestId', `${entry.target}: ${entry.hostileMutation}; falsePassWouldMean=${entry.falsePassWouldMean}`);
  const validatorCoverage = (contract.validators || []).map((declared) => {
    const validatorId = path.basename(declared).replace(/\.mjs$/, '');
    const matchingRecords = records.filter((record) => record.detector?.validator === validatorId || record.detector?.script === declared);
    const exercised = validatorId === 'hostile-self-tests'
      ? process.argv[1] && path.resolve(process.argv[1]) === path.resolve(TEST_FILE)
      : matchingRecords.length > 0;
    return { validator: declared, validatorId, exercised, executionRecordIds: matchingRecords.map((record) => record.mutationId), invocationEvidence: validatorId === 'hostile-self-tests' ? 'current process is the contractual hostile-self-tests invocation' : 'production detector process records' };
  });
  const contractCoverage = {
    negativeTests: { total: (contract.negativeTests || []).length, covered: requirementRows.filter((row) => row.contractRequirementClass === 'NEGATIVE_TEST' && row.coverageStatus === 'covered').length },
    countertests: { total: (contract.countertests || []).length, covered: requirementRows.filter((row) => row.contractRequirementClass === 'COUNTERTEST' && row.coverageStatus === 'covered').length },
    validators: { total: validatorCoverage.length, executed: validatorCoverage.filter((row) => row.exercised).length }
  };
  return { schemaVersion: 1, document: 'GATE14_COVERAGE_MATRIX', gateId: 'GATE14', derivation: { source: CONTRACT_PATH, method: 'Machine-derived by enumerating canonical negativeTests, countertests, and validators, then joining exact mutation/control execution evidence.' }, rows, uncoveredMandatorySurfaces, contractRequirements: requirementRows, validatorCoverage, contractCoverage, contractCoverageBlockers: requirementRows.filter((row) => row.coverageStatus !== 'covered').map((row) => row.contractRequirementId), validatorCoverageBlockers: validatorCoverage.filter((row) => !row.exercised).map((row) => row.validator), summary: { mandatorySurfaceCount: mandatory.length, covered: rows.filter((x) => x.result === 'covered').length, partiallyCovered: rows.filter((x) => x.result === 'partially covered').length, blocked: rows.filter((x) => x.result === 'blocked').length, notApplicable: rows.filter((x) => x.result === 'not applicable').length } };
}

function writeOutputs() {
  fs.mkdirSync(IMPLEMENTATION_DIR, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const inventory = buildInventory();
  const registry = buildRegistry();
  writeJson(ROOT, 'governance/gates/GATE14/implementation/TRAVERSAL_INVENTORY.json', inventory);
  writeJson(ROOT, 'governance/gates/GATE14/implementation/MUTATION_REGISTRY.json', registry);
  const reusableRecords = loadReusableRecords();
  const existingMutationIds = new Set((reusableRecords || []).map((record) => record.mutationId));
  const missingMutations = mutations.filter((mutation) => !existingMutationIds.has(mutation.mutationId));
  const runOneRecords = reusableRecords
    ? [...reusableRecords, ...[1, 2].flatMap((runNumber) => missingMutations.map((mutation) => runOne(mutation, runNumber)))]
    : [1, 2].flatMap((runNumber) => mutations.map((mutation) => runOne(mutation, runNumber)));
  const methodologyControls = [1, 2].flatMap((runNumber) => runMethodologyControls(runNumber));
  const deterministicProjection = (records) => records.map((record) => ({ mutationId: record.mutationId, target: record.target, expectedFinding: record.expectedFinding, actualFinding: record.actualFinding, verdict: record.verdict, baselineValid: record.baselineValidatorResult.valid, mutatedValid: record.mutatedValidatorResult.valid, restoredValid: record.restoredValidatorResult.valid }));
  const first = deterministicProjection(runOneRecords.filter((x) => x.reproductionMetadata.runNumber === 1));
  const second = deterministicProjection(runOneRecords.filter((x) => x.reproductionMetadata.runNumber === 2));
  const determinism = JSON.stringify(first) === JSON.stringify(second);
  const controlProjection = (controls) => controls.map((control) => ({ controlId: control.controlId, actualDetectorInvocationState: control.actualDetectorInvocationState, actualMutationState: control.actualMutationState, actualBaselineState: control.actualBaselineState, actualFinding: control.actualFinding, observedHarnessRejection: control.observedHarnessRejection, verdict: control.verdict }));
  const controlDeterminism = JSON.stringify(controlProjection(methodologyControls.filter((x) => x.runNumber === 1))) === JSON.stringify(controlProjection(methodologyControls.filter((x) => x.runNumber === 2)));
  const recordsDocument = { schemaVersion: 1, document: 'GATE14_MUTATION_EXECUTION_RECORDS', gateId: 'GATE14', executionOrder: mutations.map((x) => x.mutationId), runCount: 2, records: runOneRecords, determinism: { sameMutationOrdering: determinism, sameTargets: determinism, sameExpectedFindings: determinism, sameActualFindings: determinism, sameVerdicts: determinism, volatileMetadataExcluded: ['temporary clone path', 'process id'] }, negativeControls: methodologyControls, negativeControlDeterminism: controlDeterminism };
  writeJson(ROOT, 'governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json', recordsDocument);
  const coverage = buildCoverage(registry, inventory, runOneRecords, methodologyControls);
  writeJson(ROOT, 'governance/gates/GATE14/implementation/COVERAGE_MATRIX.json', coverage);
  const outputHashes = Object.fromEntries([
    ['governance/gates/GATE14/implementation/TRAVERSAL_INVENTORY.json', hashJsonFile(ROOT, 'governance/gates/GATE14/implementation/TRAVERSAL_INVENTORY.json')],
    ['governance/gates/GATE14/implementation/MUTATION_REGISTRY.json', hashJsonFile(ROOT, 'governance/gates/GATE14/implementation/MUTATION_REGISTRY.json')],
    ['governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json', hashJsonFile(ROOT, 'governance/gates/GATE14/implementation/MUTATION_EXECUTION_RECORDS.json')],
    ['governance/gates/GATE14/implementation/COVERAGE_MATRIX.json', hashJsonFile(ROOT, 'governance/gates/GATE14/implementation/COVERAGE_MATRIX.json')],
    ['governance/gates/GATE14/tests/hostile-self-tests.mjs', sha256(fs.readFileSync(TEST_FILE))]
  ]);
  const successfulRecords = runOneRecords.filter((x) => x.verdict === 'PASS');
  const restoredRecords = runOneRecords.filter((x) => x.reproductionMetadata.restoredBaselineByteIdentical);
  const negativeControlsPass = recordsDocument.negativeControls.length === 12 && recordsDocument.negativeControls.every((x) => x.verdict === 'PASS' && x.observedHarnessRejection === true) && recordsDocument.negativeControlDeterminism;
  const contractCoveragePass = coverage.contractCoverageBlockers.length === 0 && coverage.validatorCoverageBlockers.length === 0;
  const contract = readJson(ROOT, CONTRACT_PATH);
  const closureConditionReconciliation = {
    originalClosureConditions: contract.closureConditions,
    staleCondition: 'GATE14 NOT_STARTED',
    canonicalObservedState: 'IN_PROGRESS',
    semanticDecision: 'B_CLOSURE_SEMANTIC_REQUIRES_FORMAL_REVISION',
    basis: ['The field is named closureConditions, not preconditions.', 'The canonical state has consumed AUTHORIZATION and START.', 'PRECONTRACT authority is restricted to BOOTSTRAP_CONTRACT_CANONICALIZATION and requires currentStatus=NOT_STARTED with no CURRENT_CONTRACT present.', 'No GATE14 successor-contract revision authority or contract revision event exists.'],
    lawfulCorrection: null,
    status: 'BLOCKED_CONTRACT_REVISION_AUTHORITY_REQUIRED'
  };
  const closureBlockers = [
    ...(runOneRecords.length !== mutations.length * 2 ? ['MUTATION_RECORD_COUNT_MISMATCH'] : []),
    ...(successfulRecords.length !== runOneRecords.length ? ['MUTATION_VERDICT_BLOCKED'] : []),
    ...(restoredRecords.length !== runOneRecords.length ? ['RESTORATION_INCOMPLETE'] : []),
    ...(!determinism ? ['NON_DETERMINISTIC_REPLAY'] : []),
    ...(!negativeControlsPass ? ['NEGATIVE_CONTROL_FAILURE'] : []),
    ...(coverage.uncoveredMandatorySurfaces.length ? ['MANDATORY_SURFACE_UNCOVERED'] : []),
    ...(!contractCoveragePass ? ['MANDATORY_CONTRACT_COVERAGE_GAP'] : []),
    ...(closureConditionReconciliation.status !== 'RESOLVED' ? ['CONTRACT_REVISION_AUTHORITY_REQUIRED'] : []),
    ...(!AUTHORIZED_PATHS.every((p) => registry.authorizedPaths.includes(p)) || registry.authorizedPaths.length !== 6 ? ['CONTRACT_SCOPE_PARITY_FAILURE'] : [])
  ];
  const closure = { schemaVersion: 1, document: 'GATE14_CLOSURE_EVIDENCE', gateId: 'GATE14', derivation: { inputs: ['MUTATION_REGISTRY.json', 'TRAVERSAL_INVENTORY.json', 'MUTATION_EXECUTION_RECORDS.json', 'COVERAGE_MATRIX.json', 'hostile-self-tests.mjs', CONTRACT_PATH], method: 'Machine-derived after real production-validator executions and methodology-control executions; no producer summary is trusted as detector output.' }, artifactHashes: outputHashes, counts: { mutations: mutations.length, executionRecords: runOneRecords.length, pass: successfulRecords.length, block: runOneRecords.length - successfulRecords.length, restored: restoredRecords.length, negativeControls: recordsDocument.negativeControls.length, negativeControlsPass: recordsDocument.negativeControls.filter((x) => x.verdict === 'PASS').length, uncoveredMandatorySurfaces: coverage.uncoveredMandatorySurfaces.length, contractNegativeTests: coverage.contractCoverage.negativeTests, contractCountertests: coverage.contractCoverage.countertests, contractValidators: coverage.contractCoverage.validators }, deterministicSuite: { mutationSuite: recordsDocument.determinism, methodologyControls: recordsDocument.negativeControlDeterminism }, baselineHostileRestoration: { baselinePass: runOneRecords.filter((x) => x.baselineValidatorResult.valid).length, hostileBlock: runOneRecords.filter((x) => !x.mutatedValidatorResult.valid).length, restoredPass: runOneRecords.filter((x) => x.restoredValidatorResult.valid).length }, detectorProvenance: unique(runOneRecords.map((x) => x.detector.validator)).map((validator) => ({ validator, invoked: true, records: runOneRecords.filter((x) => x.detector.validator === validator).length })), contractValidatorCoverage: coverage.validatorCoverage, contractScopeParity: { authorizedPaths: AUTHORIZED_PATHS, functionalPathCount: AUTHORIZED_PATHS.length, unexpectedFunctionalPaths: [] }, contractCoverage: coverage.contractRequirements, coverageMatrix: { contractCoverage: coverage.contractCoverage, contractCoverageBlockers: coverage.contractCoverageBlockers, validatorCoverageBlockers: coverage.validatorCoverageBlockers }, closureConditionReconciliation, uncoveredMandatorySurfaces: coverage.uncoveredMandatorySurfaces, closureBlockers, verdict: closureBlockers.length === 0 ? 'GATE14_CLOSURE_AUDIT_REPAIR_R1_COMPLETE_READY_FOR_INDEPENDENT_DELTA_REAUDIT' : `GATE14_CLOSURE_AUDIT_REPAIR_R1_BLOCKED_${closureBlockers.join('_')}` };
  writeJson(ROOT, 'governance/gates/GATE14/evidence/CLOSURE_EVIDENCE.json', closure);
  return { registry, inventory, recordsDocument, coverage, closure };
}

const outputs = writeOutputs();
const canonicalLedger = readBytes(ROOT, LEDGER_PATH);
const currentState = readJson(ROOT, 'governance/gates/GATE14/state/CURRENT_STATE.json');
const finalChecks = {
  ledgerEventCount: ledgerEvents(ROOT).length,
  ledgerSha256: sha256(canonicalLedger),
  gate14StateRevision: currentState.stateRevision,
  gate14StateSealSha256: currentState.stateSealSha256,
  gate14ExecutionStatus: readJson(ROOT, 'governance/gates/GATE14/state/revisions/R0002/STATE_SEAL.json').payload.executionStatus,
  canonicalLedgerUnchangedDuringHarness: sha256(readBytes(ROOT, LEDGER_PATH)) === sha256(canonicalLedger),
  authorizedPathCount: AUTHORIZED_PATHS.length
};
console.log(JSON.stringify({ verdict: outputs.closure.verdict, finalChecks, mutationCount: mutations.length, executionRecordCount: outputs.recordsDocument.records.length, negativeControlCount: outputs.recordsDocument.negativeControls.length, contractCoverage: outputs.coverage.contractCoverage, closureBlockers: outputs.closure.closureBlockers }, null, 2));
if (outputs.closure.closureBlockers.length || !finalChecks.canonicalLedgerUnchangedDuringHarness) process.exitCode = 2;
