import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';

export { sha256Canonical };

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, '../../../../');
export const GATE_ID = 'GATE16';
export const CONTRACT_PATH = 'governance/gates/GATE16/contracts/EXECUTION_CONTRACT_R0001.json';
export const MANDATE_PATH = 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json';
export const VALIDATOR_MODULE_PATH = 'governance/gates/GATE16/implementation/crosscheck-validator.mjs';
export const POLICY_PATH = 'governance/gates/GATE16/implementation/CROSSCHECK_POLICY.json';
export const VERDICT_REGISTRY_PATH = 'governance/gates/GATE16/implementation/INDEPENDENT_VERDICT_REGISTRY.json';
export const TEST_PATH = 'governance/gates/GATE16/tests/gate16-independent-crosscheck.test.mjs';
export const EVIDENCE_PATH = 'governance/gates/GATE16/evidence/CROSSCHECK_REPORT.json';
export const PRODUCER_OUTPUT_PATH = 'governance/sources/GATE15_M3_INDEPENDENT_EXTERNAL_CONFIRMATION_R1_EXTERNAL_REINSPECTION_REPORT.json';
export const VERIFIER_ID = 'GATE16_M2_INDEPENDENT_VERIFIER_R1';
export const PRODUCER_ID = 'GATE15_M3_EXTERNAL_CONFIRMATION_R1';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const START_RECORD_PATH = 'governance/authority/authorizations/GATE16/GATE_START_RECORD.json';

export const REASON_CODES = Object.freeze([
  'REQUIRED_SOURCE_MISSING',
  'CANONICAL_INPUT_SET_MISMATCH',
  'CANONICAL_INPUT_HASH_MISMATCH',
  'SOURCE_EVIDENCE_HASH_MISMATCH',
  'PRODUCER_OUTPUT_MISMATCH',
  'PRODUCER_AUDITOR_NOT_DISTINCT',
  'VERIFIER_IDENTITY_UNRESOLVABLE',
  'PRODUCER_VERDICT_USED_AS_AUTHORITY',
  'CIRCULAR_OR_UNSUPPORTED_CLOSURE',
  'PREDECESSOR_NOT_COMPLETE_CONFIRMED',
  'NON_DETERMINISTIC_REPLAY',
  'UNRELATED_REGRESSION_IDENTITY',
  'FUTURE_GATE_CLAIM',
  'EVIDENCE_ARTIFACT_INVALID'
]);

export const CANONICAL_REQUIRED_PATHS = Object.freeze([
  'governance/PROJECT_CONSTITUTION.json',
  'governance/GATE_REGISTRY_00_40.json',
  MANDATE_PATH,
  'governance/gates/GATE15/state/CURRENT_STATE.json',
  'governance/state/GATE_STATUS_LEDGER.ndjson',
  'governance/active/ACTIVE_GATE.json'
]);

export const FUNCTIONAL_PATHS = Object.freeze([
  POLICY_PATH,
  VERDICT_REGISTRY_PATH,
  VALIDATOR_MODULE_PATH,
  TEST_PATH,
  EVIDENCE_PATH
]);

const OUTPUT_PATH_SET = new Set(FUNCTIONAL_PATHS);
const PRODUCER_AUTHORITY_CLASS = 'PRODUCER_OUTPUT_NON_AUTHORITATIVE';
const VERIFIER_AUTHORITY_CLASS = 'CANONICAL_INDEPENDENT_VERIFIER';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function stableBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function safeRelative(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.length > 0
    && !relativePath.includes('\\')
    && !path.posix.isAbsolute(relativePath)
    && !/^[A-Za-z]:/.test(relativePath)
    && !relativePath.includes('*')
    && !relativePath.includes('?')
    && !relativePath.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function resolveUnderRoot(root, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...relativePath.split('/'));
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}

function readBytes(root, relativePath) {
  const resolved = resolveUnderRoot(root, relativePath);
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved);
}

function readJson(root, relativePath) {
  const bytes = readBytes(root, relativePath);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function unique(values) {
  return [...new Set(values)];
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function finding(reasonCode, detail, sourcePath = null) {
  return { reasonCode, sourcePath, detail };
}

function addFinding(findings, reasonCode, detail, sourcePath = null) {
  if (!REASON_CODES.includes(reasonCode)) throw new Error(`UNKNOWN_G16_REASON_CODE:${reasonCode}`);
  findings.push(finding(reasonCode, detail, sourcePath));
}

function inputBody(input) {
  const body = clone(input);
  delete body.replayBinding;
  return body;
}

function inputDigest(input) {
  return sha256Canonical(inputBody(input));
}

export function bindReplayIdentity(input) {
  const output = clone(input);
  output.replayBinding = {
    algorithm: 'SHA256_CANONICAL_JSON_EXCLUDING_REPLAY_BINDING_V1',
    inputDigest: inputDigest(output)
  };
  return output;
}

function preStateBytes(root, relativePath, expectedSha256) {
  if (relativePath !== LEDGER_PATH || typeof expectedSha256 !== 'string') return null;
  const startRecord = readJson(root, START_RECORD_PATH);
  const baseCommit = startRecord?.baseCommit;
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40}$/.test(baseCommit)) return null;
  const result = spawnSync('git', ['show', `${baseCommit}:${relativePath}`], {
    cwd: root,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || sha256Bytes(result.stdout) !== expectedSha256) return null;
  return result.stdout;
}

function boundBytes(root, item) {
  const current = readBytes(root, item.path);
  if (current && (!item.expectedSha256 || sha256Bytes(current) === item.expectedSha256)) return current;
  return preStateBytes(root, item.path, item.expectedSha256) || current;
}

function actualBinding(root, item) {
  const bytes = boundBytes(root, item);
  if (!bytes) return { path: item.path, present: false, sha256: null, byteLength: null };
  return { path: item.path, present: true, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function producerDocument(root) {
  const bytes = readBytes(root, PRODUCER_OUTPUT_PATH);
  if (!bytes) return { bytes: null, document: null };
  try {
    return { bytes, document: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) };
  } catch {
    return { bytes, document: null };
  }
}

export function canonicalArtifactIdentities(root = REPO_ROOT, paths = FUNCTIONAL_PATHS) {
  return paths
    .filter((relativePath) => relativePath !== EVIDENCE_PATH)
    .map((relativePath) => {
      const bytes = readBytes(root, relativePath);
      return { path: relativePath, sha256: bytes ? sha256Bytes(bytes) : null, byteLength: bytes?.length ?? null };
    });
}

export function buildCanonicalInput(root = REPO_ROOT) {
  const contract = readJson(root, CONTRACT_PATH);
  if (!contract || !Array.isArray(contract.requiredInputs)) throw new Error('G16_CONTRACT_REQUIRED_INPUTS_UNREADABLE');
  const canonicalInputs = contract.requiredInputs.map((item) => {
    const observed = actualBinding(root, { path: item.path, expectedSha256: item.sha256 });
    return {
      path: item.path,
      role: item.role,
      expectedSha256: item.sha256,
      expectedByteLength: item.byteLength ?? observed.byteLength,
      observedSha256: observed.sha256,
      observedByteLength: observed.byteLength
    };
  });
  const producer = producerDocument(root);
  const producerBinding = {
    producerId: PRODUCER_ID,
    authorityClass: PRODUCER_AUTHORITY_CLASS,
    path: PRODUCER_OUTPUT_PATH,
    expectedSha256: producer.bytes ? sha256Bytes(producer.bytes) : null,
    expectedByteLength: producer.bytes?.length ?? null,
    observedSha256: producer.bytes ? sha256Bytes(producer.bytes) : null,
    observedByteLength: producer.bytes?.length ?? null,
    gateId: producer.document?.gateId ?? null,
    reportedVerdict: producer.document?.verdict ?? producer.document?.resultingStatus ?? null
  };
  return bindReplayIdentity({
    document: 'GATE16_CROSSCHECK_INPUT',
    schemaVersion: 1,
    gateId: GATE_ID,
    canonicalInputs,
    producerOutput: producerBinding,
    verifier: {
      verifierId: VERIFIER_ID,
      authorityClass: VERIFIER_AUTHORITY_CLASS,
      implementationPath: VALIDATOR_MODULE_PATH
    },
    closureClaims: [
      {
        claimId: 'G16-CLAIM-01',
        subject: 'GATE15_PREDECESSOR_STATUS',
        expectedValue: 'COMPLETE_CONFIRMED',
        sourcePaths: [
          'governance/gates/GATE15/state/CURRENT_STATE.json',
          'governance/state/GATE_STATUS_LEDGER.ndjson'
        ]
      }
    ],
    verdictDerivation: {
      source: 'CANONICAL_INPUT_RECALCULATION',
      producerVerdictConsumed: false,
      producerFieldsCompared: ['gateId', 'programId']
    },
    scope: {
      gateId: GATE_ID,
      unrelatedRegressionIdentities: [],
      futureGateClaims: []
    }
  });
}

function compareCanonicalInputSet(input, contract, findings) {
  const expected = Array.isArray(contract?.requiredInputs) ? contract.requiredInputs : [];
  const actual = Array.isArray(input?.canonicalInputs) ? input.canonicalInputs : [];
  const expectedPaths = expected.map((item) => item.path);
  const actualPaths = actual.map((item) => item.path);
  if (!sameSet(expectedPaths, actualPaths) || actual.length !== expected.length) {
    addFinding(findings, 'CANONICAL_INPUT_SET_MISMATCH', { expectedPaths, actualPaths });
    return;
  }
  for (const item of actual) {
    const contractItem = expected.find((candidate) => candidate.path === item.path);
    if (item.expectedSha256 !== contractItem.sha256) {
      addFinding(findings, 'CANONICAL_INPUT_HASH_MISMATCH', 'Input hash differs from the sealed GATE16 contract.', item.path);
    }
  }
}

function validateSourceBindings(root, input, contract, findings) {
  for (const item of input.canonicalInputs || []) {
    const actual = actualBinding(root, item);
    if (!actual.present) {
      addFinding(findings, 'REQUIRED_SOURCE_MISSING', 'Required canonical source is absent.', item.path);
      continue;
    }
    if (actual.sha256 !== item.expectedSha256
      || actual.byteLength !== item.expectedByteLength
      || actual.sha256 !== item.observedSha256
      || actual.byteLength !== item.observedByteLength) {
      addFinding(findings, 'SOURCE_EVIDENCE_HASH_MISMATCH', {
        expectedSha256: item.expectedSha256,
        observedSha256: actual.sha256,
        declaredObservedSha256: item.observedSha256,
        expectedByteLength: item.expectedByteLength,
        observedByteLength: actual.byteLength,
        declaredObservedByteLength: item.observedByteLength
      }, item.path);
    }
  }
  const requiredPaths = (contract?.requiredInputs || []).map((item) => item.path);
  for (const item of input.canonicalInputs || []) {
    if (OUTPUT_PATH_SET.has(item.path) || item.path === PRODUCER_OUTPUT_PATH) {
      addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'A functional or producer output cannot be a canonical input.', item.path);
    }
  }
  if (!sameSet(requiredPaths, (input.canonicalInputs || []).map((item) => item.path))) {
    addFinding(findings, 'CANONICAL_INPUT_SET_MISMATCH', 'Canonical inputs do not exactly match the contract.', null);
  }
}

function validateProducerBinding(root, input, findings) {
  const producer = input.producerOutput;
  const actual = actualBinding(root, producer || {});
  if (OUTPUT_PATH_SET.has(producer?.path) || (input.canonicalInputs || []).some((item) => item.path === producer?.path)) {
    addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'Producer output cannot be consumed as verifier evidence.', producer?.path ?? null);
  }
  if (!producer || producer.producerId !== PRODUCER_ID || producer.authorityClass !== PRODUCER_AUTHORITY_CLASS || producer.path !== PRODUCER_OUTPUT_PATH) {
    addFinding(findings, 'PRODUCER_OUTPUT_MISMATCH', 'Producer identity, authority class or output path is not canonical.', producer?.path ?? null);
    return;
  }
  if (!actual.present || actual.sha256 !== producer.expectedSha256 || actual.byteLength !== producer.expectedByteLength || actual.sha256 !== producer.observedSha256 || actual.byteLength !== producer.observedByteLength) {
    addFinding(findings, 'SOURCE_EVIDENCE_HASH_MISMATCH', 'Producer output bytes do not match its declared binding.', producer.path);
  }
  const { document } = producerDocument(root);
  if (!document || document.gateId !== 'GATE15') {
    addFinding(findings, 'PRODUCER_OUTPUT_MISMATCH', 'The compared producer output is not the declared GATE15 output.', producer.path);
  }
}

function validateVerifier(input, findings) {
  const verifier = input.verifier;
  const producer = input.producerOutput;
  if (!verifier || verifier.verifierId !== VERIFIER_ID || verifier.authorityClass !== VERIFIER_AUTHORITY_CLASS || verifier.implementationPath !== VALIDATOR_MODULE_PATH) {
    addFinding(findings, 'VERIFIER_IDENTITY_UNRESOLVABLE', 'Verifier identity is not the canonical GATE16 production validator.');
  }
  if (verifier?.verifierId === producer?.producerId || verifier?.implementationPath === producer?.path) {
    addFinding(findings, 'PRODUCER_AUDITOR_NOT_DISTINCT', 'Producer and verifier identities must remain distinct.');
  }
}

function validateDerivation(input, findings) {
  const derivation = input.verdictDerivation;
  if (!derivation || derivation.source !== 'CANONICAL_INPUT_RECALCULATION' || derivation.producerVerdictConsumed !== false) {
    addFinding(findings, 'PRODUCER_VERDICT_USED_AS_AUTHORITY', 'The verdict derivation must explicitly exclude the producer verdict.');
  }
  const claims = Array.isArray(input.closureClaims) ? input.closureClaims : [];
  if (!claims.length) addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'At least one supported closure claim is required.');
  for (const claim of claims) {
    if (claim.claimId !== 'G16-CLAIM-01' || claim.subject !== 'GATE15_PREDECESSOR_STATUS' || claim.expectedValue !== 'COMPLETE_CONFIRMED' || !Array.isArray(claim.sourcePaths) || claim.sourcePaths.length === 0 || claim.sourcePaths.some((sourcePath) => !CANONICAL_REQUIRED_PATHS.includes(sourcePath))) {
      addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'Closure claim is unsupported or lacks a canonical evidence edge.', claim.claimId ?? null);
    }
  }
}

function validateScope(input, findings) {
  const scope = input.scope;
  if (!scope || scope.gateId !== GATE_ID) addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'Crosscheck scope must be GATE16.');
  if (Array.isArray(scope?.unrelatedRegressionIdentities) && scope.unrelatedRegressionIdentities.length) addFinding(findings, 'UNRELATED_REGRESSION_IDENTITY', scope.unrelatedRegressionIdentities);
  if (Array.isArray(scope?.futureGateClaims) && scope.futureGateClaims.length) addFinding(findings, 'FUTURE_GATE_CLAIM', scope.futureGateClaims);
}

function recalculateFromCanonicalInputs(root, input, findings) {
  const ledger = readJsonLinesFromBoundInput(root, input, 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const state = readJsonFromBoundInput(root, input, 'governance/gates/GATE15/state/CURRENT_STATE.json');
  const gateEvents = (ledger || []).filter((event) => event && event.gateId === 'GATE15');
  const lastEvent = gateEvents.at(-1) || null;
  const observedStatus = lastEvent?.toStatus ?? 'UNKNOWN';
  const observedRevision = state?.stateRevision ?? null;
  if (observedStatus !== 'COMPLETE_CONFIRMED' || !observedRevision || lastEvent?.stateRevision !== observedRevision) {
    addFinding(findings, 'PREDECESSOR_NOT_COMPLETE_CONFIRMED', { observedStatus, observedRevision, ledgerRevision: lastEvent?.stateRevision ?? null });
  }
  return {
    claimId: 'G16-CLAIM-01',
    subject: 'GATE15_PREDECESSOR_STATUS',
    observedValue: observedStatus,
    stateRevision: observedRevision,
    source: 'CANONICAL_INPUT_RECALCULATION',
    producerVerdictConsumed: false,
    ledgerEventId: lastEvent?.eventId ?? null,
    ledgerEventOrdinal: lastEvent?.ordinal ?? null
  };
}

function readJsonFromBoundInput(root, input, relativePath) {
  if (!(input.canonicalInputs || []).some((item) => item.path === relativePath)) return null;
  return readJson(root, relativePath);
}

function readJsonLinesFromBoundInput(root, input, relativePath) {
  const item = (input.canonicalInputs || []).find((candidate) => candidate.path === relativePath);
  if (!item) return null;
  const bytes = boundBytes(root, item);
  if (!bytes) return null;
  try { return bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return null; }
}

export function validateCrosscheck(input, { root = REPO_ROOT } = {}) {
  const findings = [];
  const contract = readJson(root, CONTRACT_PATH);
  if (!input || input.document !== 'GATE16_CROSSCHECK_INPUT' || input.schemaVersion !== 1 || input.gateId !== GATE_ID) {
    addFinding(findings, 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', 'Input package identity is not the canonical GATE16 crosscheck package.');
  }
  if (!contract) addFinding(findings, 'REQUIRED_SOURCE_MISSING', 'GATE16 execution contract is unreadable.', CONTRACT_PATH);
  compareCanonicalInputSet(input || {}, contract, findings);
  validateSourceBindings(root, input || {}, contract, findings);
  validateProducerBinding(root, input || {}, findings);
  validateVerifier(input || {}, findings);
  validateDerivation(input || {}, findings);
  validateScope(input || {}, findings);

  const replayExpected = input?.replayBinding?.inputDigest;
  if (!replayExpected || replayExpected !== inputDigest(input)) {
    addFinding(findings, 'NON_DETERMINISTIC_REPLAY', { expected: replayExpected, recomputed: input ? inputDigest(input) : null });
  }

  const recalculated = recalculateFromCanonicalInputs(root, input || {}, findings);
  const producer = input?.producerOutput || {};
  const producerComparison = {
    producerId: producer.producerId ?? null,
    producerOutputPath: producer.path ?? null,
    producerGateId: producer.gateId ?? null,
    comparedFields: ['gateId', 'programId'],
    producerVerdictObserved: producer.reportedVerdict ?? null,
    producerVerdictUsedAsAuthority: false,
    canonicalStatus: recalculated.observedValue,
    statusAgrees: producer.gateId === 'GATE15'
  };
  const evidenceDigest = sha256Canonical({
    canonicalInputs: input?.canonicalInputs || [],
    sourceBindings: (input?.canonicalInputs || []).map((item) => actualBinding(root, item)),
    recalculated,
    producerComparison: { ...producerComparison, producerVerdictObserved: null },
    verifier: input?.verifier || null
  });
  const verdict = findings.length === 0 ? 'PASS' : 'BLOCKED';
  const reasonCodes = unique(findings.map((item) => item.reasonCode));
  const result = {
    document: 'GATE16_INDEPENDENT_CROSSCHECK_RESULT',
    schemaVersion: 1,
    gateId: GATE_ID,
    verifierId: input?.verifier?.verifierId ?? null,
    verdict,
    reasonCodes,
    findings,
    evidenceDigest,
    recalculated,
    producerComparison,
    sourceBindings: (input?.canonicalInputs || []).map((item) => ({
      path: item.path,
      expectedSha256: item.expectedSha256,
      observedSha256: actualBinding(root, item).sha256,
      byteLength: actualBinding(root, item).byteLength
    })),
    replay: {
      algorithm: input?.replayBinding?.algorithm ?? null,
      declaredInputDigest: replayExpected ?? null,
      recomputedInputDigest: input ? inputDigest(input) : null,
      identical: Boolean(replayExpected && replayExpected === inputDigest(input))
    },
    scope: input?.scope || null
  };
  result.outputDigest = sha256Canonical({
    verdict: result.verdict,
    reasonCodes: result.reasonCodes,
    evidenceDigest: result.evidenceDigest,
    recalculated: result.recalculated,
    producerComparison: { ...result.producerComparison, producerVerdictObserved: null },
    replay: result.replay
  });
  return result;
}

function evidenceFinding(reasonCode, detail, sourcePath = null) {
  return { reasonCode, sourcePath, detail };
}

export function validateEvidenceArtifact(report, { root = REPO_ROOT } = {}) {
  const findings = [];
  if (!report || report.document !== 'GATE16_CROSSCHECK_REPORT' || report.gateId !== GATE_ID) {
    findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Evidence document identity is invalid.'));
  }
  const canonical = validateCrosscheck(buildCanonicalInput(root), { root });
  if (canonical.verdict !== 'PASS') findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Current canonical input no longer independently validates.', canonical.outputDigest));
  if (report?.canonicalCrosscheck?.outputDigest !== canonical.outputDigest || report?.canonicalCrosscheck?.evidenceDigest !== canonical.evidenceDigest) {
    findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Report does not bind the recomputed canonical crosscheck result.'));
  }
  const expectedArtifacts = canonicalArtifactIdentities(root);
  const actualArtifacts = Array.isArray(report?.artifactHashes) ? report.artifactHashes : [];
  for (const expected of expectedArtifacts) {
    const observed = actualArtifacts.find((item) => item.path === expected.path);
    if (!observed || observed.sha256 !== expected.sha256 || observed.byteLength !== expected.byteLength) {
      findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Artifact hash or byte length is not bound to current bytes.', expected.path));
    }
  }
  const rows = Array.isArray(report?.coverage?.rows) ? report.coverage.rows : [];
  if (rows.length !== 10 || rows.some((row) => row.result !== 'COVERED')) findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Canonical requirement coverage is incomplete.'));
  const executions = Array.isArray(report?.executions) ? report.executions : [];
  if (!executions.length || executions.some((record) => record.executionPass !== true)) findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'A recorded positive, negative, counter or hostile execution did not pass its expected assertion.'));
  const closures = report?.closureConditions;
  if (!closures || Object.keys(closures).length !== 6 || Object.values(closures).some((value) => value !== true)) findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'One or more GATE16 closure conditions are false.'));
  if (report?.freshProcessReplay?.verdict !== 'PASS' || report?.freshProcessReplay?.identical !== true) findings.push(evidenceFinding('EVIDENCE_ARTIFACT_INVALID', 'Fresh-process replay evidence is absent or non-identical.'));
  return {
    document: 'GATE16_EVIDENCE_VALIDATION_RESULT',
    gateId: GATE_ID,
    verdict: findings.length === 0 ? 'PASS' : 'BLOCKED',
    reasonCodes: unique(findings.map((item) => item.reasonCode)),
    findings,
    canonicalOutputDigest: canonical.outputDigest,
    evidenceDigest: sha256Canonical({ canonicalOutputDigest: canonical.outputDigest, artifactHashes: actualArtifacts, coverage: report?.coverage || null, closureConditions: closures || null })
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const root = path.resolve(option('--root', REPO_ROOT));
  const inputPath = option('--input');
  const input = inputPath
    ? JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8').replace(/^\uFEFF/, ''))
    : buildCanonicalInput(root);
  const result = validateCrosscheck(input, { root });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verdict === 'PASS' ? 0 : 2;
}
