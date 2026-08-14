import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  REPO_ROOT,
  GATE_ID,
  CONTRACT_PATH,
  VALIDATOR_MODULE_PATH,
  POLICY_PATH,
  VERDICT_REGISTRY_PATH,
  TEST_PATH,
  EVIDENCE_PATH,
  POST_CLOSURE_MAINTENANCE_EVIDENCE_PATH,
  CLOSURE_TIME_SEALED_EVIDENCE,
  POST_CLOSURE_MAINTENANCE_EVIDENCE,
  PRODUCER_ID,
  VERIFIER_ID,
  FUNCTIONAL_PATHS,
  buildCanonicalInput,
  bindReplayIdentity,
  validateCrosscheck,
  validateClosureTimeSealedEvidence,
  validatePostClosureMaintenanceEvidenceArtifact,
  canonicalArtifactIdentities,
  stableBytes,
  sha256Canonical
} from '../implementation/crosscheck-validator.mjs';
import { resolveCanonicalLedgerPrefix } from '../../../tools/validate-status-ledger.mjs';

const ROOT = REPO_ROOT;
const VALIDATOR_CLI = path.join(ROOT, VALIDATOR_MODULE_PATH.replaceAll('/', path.sep));
const EVIDENCE_FILE = path.join(ROOT, EVIDENCE_PATH.replaceAll('/', path.sep));
const POST_CLOSURE_MAINTENANCE_EVIDENCE_FILE = path.join(ROOT, POST_CLOSURE_MAINTENANCE_EVIDENCE_PATH.replaceAll('/', path.sep));
const GENERATE = process.argv.includes('--generate') || process.env.GATE16_GENERATE === '1';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function packageFrom(mutator = null, { rebind = true } = {}) {
  const input = buildCanonicalInput(ROOT);
  if (mutator) mutator(input);
  return rebind ? bindReplayIdentity(input) : input;
}

function resultSummary(result) {
  return {
    document: result.document,
    gateId: result.gateId,
    verifierId: result.verifierId,
    verdict: result.verdict,
    reasonCodes: result.reasonCodes,
    findings: result.findings,
    evidenceDigest: result.evidenceDigest,
    outputDigest: result.outputDigest,
    recalculated: result.recalculated,
    producerComparison: result.producerComparison,
    replay: result.replay
  };
}

function runCase(testCase) {
  const input = packageFrom(testCase.mutation, { rebind: testCase.rebind !== false });
  const result = validateCrosscheck(input, { root: ROOT });
  const expectedPass = testCase.expected === 'PASS';
  const executionPass = expectedPass
    ? result.verdict === 'PASS'
    : result.verdict === 'BLOCKED' && result.reasonCodes.includes(testCase.expected);
  return {
    executionId: `execution:${testCase.testId}`,
    testId: testCase.testId,
    category: testCase.category,
    requirementId: testCase.requirementId || null,
    target: testCase.target || null,
    expectedVerdict: expectedPass ? 'PASS' : 'BLOCKED',
    expectedReasonCode: expectedPass ? null : testCase.expected,
    inputDigest: sha256Canonical(input),
    rawOutput: resultSummary(result),
    outputDigest: result.outputDigest,
    processIdentity: {
      runtime: 'node',
      nodeMajor: Number(process.versions.node.split('.')[0]),
      validatorModule: VALIDATOR_MODULE_PATH,
      executionClass: 'PRODUCTION_VALIDATOR'
    },
    executionPass
  };
}

function freshProcessResult(input) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gate16-fresh-process-'));
  const inputFile = path.join(tempRoot, 'crosscheck-input.json');
  try {
    fs.writeFileSync(inputFile, stableBytes(input));
    const child = spawnSync(process.execPath, [VALIDATOR_CLI, '--root', ROOT, '--input', inputFile], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' }
    });
    const output = child.stdout ? JSON.parse(child.stdout) : null;
    return { status: child.status, output };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const positiveCases = [
  { testId: 'G16-POS-01', category: 'POSITIVE', requirementId: 'G16-CROSSCHECK-01', expected: 'PASS', description: 'distinct producer and independent verifier identities' },
  { testId: 'G16-POS-02', category: 'POSITIVE', requirementId: 'G16-CROSSCHECK-02', expected: 'PASS', description: 'canonical recalculation excludes producer verdict' },
  { testId: 'G16-POS-03', category: 'POSITIVE', requirementId: 'G16-CROSSCHECK-03', expected: 'PASS', description: 'canonical source and producer bytes reproduce their hashes' },
  { testId: 'G16-POS-04', category: 'POSITIVE', requirementId: 'G16-CROSSCHECK-05', expected: 'PASS', description: 'fresh-process replay is identical' }
];

const negativeCases = [
  { testId: 'G16-NEG-01', category: 'NEGATIVE', requirementId: 'G16-CROSSCHECK-01', expected: 'PRODUCER_AUDITOR_NOT_DISTINCT', description: 'producer is reused as independent verifier', mutation: (input) => { input.verifier.verifierId = PRODUCER_ID; } },
  { testId: 'G16-NEG-02', category: 'NEGATIVE', requirementId: 'G16-CROSSCHECK-02', expected: 'PRODUCER_VERDICT_USED_AS_AUTHORITY', description: 'producer PASS is made the verdict authority', mutation: (input) => { input.verdictDerivation.producerVerdictConsumed = true; } },
  { testId: 'G16-NEG-03', category: 'NEGATIVE', requirementId: 'G16-CROSSCHECK-03', expected: 'SOURCE_EVIDENCE_HASH_MISMATCH', description: 'canonical source hash is changed', mutation: (input) => { input.canonicalInputs[0].expectedSha256 = '0'.repeat(64); } },
  { testId: 'G16-NEG-04', category: 'NEGATIVE', requirementId: 'G16-CROSSCHECK-04', expected: 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', description: 'closure claim loses its canonical evidence edge', mutation: (input) => { input.closureClaims[0].sourcePaths = []; } },
  { testId: 'G16-NEG-05', category: 'NEGATIVE', requirementId: 'G16-CROSSCHECK-05', expected: 'NON_DETERMINISTIC_REPLAY', description: 'replay identity is altered between processes', mutation: (input) => { input.replayBinding.inputDigest = '0'.repeat(64); }, rebind: false }
];

const counterCases = [
  { testId: 'G16-CT-01', category: 'COUNTER', target: 'verifier identity', expected: 'PRODUCER_AUDITOR_NOT_DISTINCT', mutation: negativeCases[0].mutation },
  { testId: 'G16-CT-02', category: 'COUNTER', target: 'verdict calculation', expected: 'SOURCE_EVIDENCE_HASH_MISMATCH', mutation: (input) => { input.canonicalInputs[1].expectedSha256 = 'f'.repeat(64); input.producerOutput.reportedVerdict = 'PASS'; } },
  { testId: 'G16-CT-03', category: 'COUNTER', target: 'evidence graph', expected: 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', mutation: (input) => { input.closureClaims = []; } },
  { testId: 'G16-CT-04', category: 'COUNTER', target: 'fresh-process replay', expected: 'NON_DETERMINISTIC_REPLAY', mutation: (input) => { input.scope.gateId = 'GATE17'; }, rebind: false },
  { testId: 'G16-CT-05', category: 'COUNTER', target: 'closure scope', expected: 'UNRELATED_REGRESSION_IDENTITY', mutation: (input) => { input.scope.unrelatedRegressionIdentities.push('unrelated-suite-v1'); } }
];

const hostileCases = [
  { testId: 'G16-HST-01', category: 'HOSTILE', expected: 'SOURCE_EVIDENCE_HASH_MISMATCH', mutation: (input) => { input.producerOutput.expectedSha256 = '1'.repeat(64); } },
  { testId: 'G16-HST-02', category: 'HOSTILE', expected: 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', mutation: (input) => { input.producerOutput.path = EVIDENCE_PATH; } },
  { testId: 'G16-HST-03', category: 'HOSTILE', expected: 'VERIFIER_IDENTITY_UNRESOLVABLE', mutation: (input) => { input.verifier.implementationPath = input.producerOutput.path; } },
  { testId: 'G16-HST-04', category: 'HOSTILE', expected: 'CIRCULAR_OR_UNSUPPORTED_CLOSURE', mutation: (input) => { input.closureClaims.push({ claimId: 'G16-FUTURE-CLAIM', subject: 'GATE17_STATUS', expectedValue: 'COMPLETE_AGENT', sourcePaths: [EVIDENCE_PATH] }); } },
  { testId: 'G16-HST-05', category: 'HOSTILE', expected: 'CANONICAL_INPUT_SET_MISMATCH', mutation: (input) => { input.canonicalInputs.pop(); } },
  { testId: 'G16-HST-06', category: 'HOSTILE', expected: 'FUTURE_GATE_CLAIM', mutation: (input) => { input.scope.futureGateClaims.push('GATE17'); } }
];

const allCases = [...positiveCases, ...negativeCases, ...counterCases, ...hostileCases];

const coverageBindings = {
  'G16-ENTRY-01': ['G16-POS-01'],
  'G16-ENTRY-02': ['G16-POS-03'],
  'G16-ENTRY-03': ['G16-POS-01', 'G16-NEG-01'],
  'G16-ENTRY-04': ['G16-POS-02'],
  'G16-CROSSCHECK-01': ['G16-POS-01', 'G16-NEG-01', 'G16-CT-01'],
  'G16-CROSSCHECK-02': ['G16-POS-02', 'G16-NEG-02', 'G16-CT-02'],
  'G16-CROSSCHECK-03': ['G16-POS-03', 'G16-NEG-03', 'G16-HST-01'],
  'G16-CROSSCHECK-04': ['G16-POS-03', 'G16-NEG-04', 'G16-CT-03'],
  'G16-CROSSCHECK-05': ['G16-POS-04', 'G16-NEG-05', 'G16-CT-04'],
  'G16-CROSSCHECK-06': ['G16-POS-03', 'G16-CT-05', 'G16-HST-05']
};

function buildCoverage(records) {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, CONTRACT_PATH.replaceAll('/', path.sep)), 'utf8'));
  const rows = contract.canonicalRequirements.map((requirement) => {
    const testIds = coverageBindings[requirement.requirementId] || [];
    const observed = records.filter((record) => testIds.includes(record.testId));
    return {
      requirementId: requirement.requirementId,
      statement: requirement.statement,
      validatorRule: requirement.requirementId.startsWith('G16-ENTRY-') ? 'ENTRY_CANONICAL_AUTHORITY' : requirement.requirementId,
      testIds,
      observedRunCount: observed.length,
      result: testIds.length > 0 && observed.length === testIds.length && observed.every((record) => record.executionPass) ? 'COVERED' : 'UNCOVERED'
    };
  });
  return {
    rows,
    mandatoryRequirementCount: rows.length,
    uncoveredMandatoryClassCount: rows.filter((row) => row.result !== 'COVERED').length,
    verdict: rows.every((row) => row.result === 'COVERED') ? 'PASS' : 'BLOCKED'
  };
}

function buildReport() {
  const records = allCases.map(runCase);
  const localInput = buildCanonicalInput(ROOT);
  const localResult = validateCrosscheck(localInput, { root: ROOT });
  const fresh = freshProcessResult(localInput);
  const freshIdentical = fresh.status === 0
    && fresh.output?.verdict === localResult.verdict
    && fresh.output?.reasonCodes?.join('|') === localResult.reasonCodes.join('|')
    && fresh.output?.evidenceDigest === localResult.evidenceDigest
    && fresh.output?.outputDigest === localResult.outputDigest;
  const coverage = buildCoverage(records);
  const closureConditions = {
    'G16-CROSSCHECK-01': localResult.verdict === 'PASS' && localResult.verifierId === VERIFIER_ID && localResult.producerComparison.producerId === PRODUCER_ID && localResult.producerComparison.producerVerdictUsedAsAuthority === false,
    'G16-CROSSCHECK-02': localResult.recalculated.source === 'CANONICAL_INPUT_RECALCULATION' && localResult.recalculated.producerVerdictConsumed === false,
    'G16-CROSSCHECK-03': localResult.sourceBindings.length === 6 && localResult.sourceBindings.every((binding) => binding.expectedSha256 === binding.observedSha256),
    'G16-CROSSCHECK-04': records.filter((record) => ['NEGATIVE', 'COUNTER', 'HOSTILE'].includes(record.category)).every((record) => record.executionPass),
    'G16-CROSSCHECK-05': freshIdentical,
    'G16-CROSSCHECK-06': localResult.scope.unrelatedRegressionIdentities.length === 0 && localResult.scope.futureGateClaims.length === 0
  };
  const report = {
    document: 'GATE16_CROSSCHECK_REPORT',
    schemaVersion: 1,
    gateId: GATE_ID,
    reportId: 'GATE16_CROSSCHECK_REPORT_R1',
    derivation: {
      contract: CONTRACT_PATH,
      mandate: 'governance/sources/GATE16_40_OWNER_RATIFICATION_R2.json',
      method: 'Machine-derived from canonical source bytes, production validator executions and an independent fresh-process replay; producer PASS is comparison-only.'
    },
    independentVerifier: {
      verifierId: localResult.verifierId,
      implementationPath: VALIDATOR_MODULE_PATH,
      authorityClass: 'CANONICAL_INDEPENDENT_VERIFIER'
    },
    producerComparison: localResult.producerComparison,
    canonicalCrosscheck: {
      verdict: localResult.verdict,
      evidenceDigest: localResult.evidenceDigest,
      outputDigest: localResult.outputDigest,
      recalculated: localResult.recalculated,
      replay: localResult.replay
    },
    artifactHashes: canonicalArtifactIdentities(ROOT),
    artifactSelfExclusion: {
      path: EVIDENCE_PATH,
      reason: 'The report cannot hash its own final bytes; the enclosing governed cohort binds the report bytes.'
    },
    executions: records,
    coverage,
    freshProcessReplay: {
      verdict: fresh.status === 0 && fresh.output?.verdict === 'PASS' ? 'PASS' : 'BLOCKED',
      identical: freshIdentical,
      comparedFields: ['verdict', 'reasonCodes', 'evidenceDigest', 'outputDigest']
    },
    closureConditions,
    scope: {
      authorizedFunctionalPaths: FUNCTIONAL_PATHS,
      unexpectedWriteCount: 0,
      unrelatedRegressionIdentities: [],
      futureGateClaims: [],
      externalConfirmationEmitted: false,
      gate17Authorized: false,
      r8Present: false
    },
    counts: {
      positive: records.filter((record) => record.category === 'POSITIVE' && record.executionPass).length,
      negative: records.filter((record) => record.category === 'NEGATIVE' && record.executionPass).length,
      counter: records.filter((record) => record.category === 'COUNTER' && record.executionPass).length,
      hostile: records.filter((record) => record.category === 'HOSTILE' && record.executionPass).length,
      total: records.length
    },
    verdict: localResult.verdict === 'PASS' && coverage.verdict === 'PASS' && freshIdentical && Object.values(closureConditions).every(Boolean) && records.every((record) => record.executionPass) ? 'PASS' : 'BLOCKED'
  };
  return report;
}

const generatedReport = GENERATE ? buildReport() : null;
if (GENERATE) {
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, stableBytes(generatedReport));
}

test('G16-POS-01 distinct producer and independent verifier identities pass', () => {
  const record = runCase(positiveCases[0]);
  assert.equal(record.executionPass, true, JSON.stringify(record));
});

test('G16-POS-02 verdict is recalculated from canonical inputs', () => {
  const input = packageFrom((value) => { value.producerOutput.reportedVerdict = 'BLOCKED'; });
  const result = validateCrosscheck(input, { root: ROOT });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.recalculated.source, 'CANONICAL_INPUT_RECALCULATION');
  assert.equal(result.recalculated.producerVerdictConsumed, false);
});

test('G16-POS-03 canonical and producer source bytes reproduce all hashes', () => {
  const result = validateCrosscheck(packageFrom(), { root: ROOT });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result));
  assert.equal(result.sourceBindings.length, 6);
  assert.ok(result.sourceBindings.every((binding) => binding.expectedSha256 === binding.observedSha256));
});

test('G16-POS-04 fresh-process replay returns identical verdict and evidence digest', () => {
  const input = packageFrom();
  const local = validateCrosscheck(input, { root: ROOT });
  const fresh = freshProcessResult(input);
  assert.equal(fresh.status, 0, JSON.stringify(fresh));
  assert.deepEqual({ verdict: fresh.output.verdict, reasonCodes: fresh.output.reasonCodes, evidenceDigest: fresh.output.evidenceDigest, outputDigest: fresh.output.outputDigest }, { verdict: local.verdict, reasonCodes: local.reasonCodes, evidenceDigest: local.evidenceDigest, outputDigest: local.outputDigest });
});

for (const testCase of negativeCases) {
  test(`${testCase.testId} ${testCase.expected}`, () => {
    const record = runCase(testCase);
    assert.equal(record.executionPass, true, JSON.stringify(record));
  });
}

for (const testCase of counterCases) {
  test(`${testCase.testId} countertest`, () => {
    const record = runCase(testCase);
    assert.equal(record.executionPass, true, JSON.stringify(record));
  });
}

for (const testCase of hostileCases) {
  test(`${testCase.testId} hostile case`, () => {
    const record = runCase(testCase);
    assert.equal(record.executionPass, true, JSON.stringify(record));
  });
}

test('G16 canonical policy, registry and exact functional scope are consistent', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, CONTRACT_PATH.replaceAll('/', path.sep)), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, POLICY_PATH.replaceAll('/', path.sep)), 'utf8'));
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, VERDICT_REGISTRY_PATH.replaceAll('/', path.sep)), 'utf8'));
  assert.deepEqual(contract.authorizedPaths, FUNCTIONAL_PATHS);
  assert.deepEqual(registry.authorizedFunctionalPaths, FUNCTIONAL_PATHS);
  assert.equal(policy.roles.verifier.identity, VERIFIER_ID);
  assert.equal(policy.roles.producer.maySupplyAuthority, false);
});

test('G16 evidence report is independently bound and complete', () => {
  assert.ok(fs.existsSync(EVIDENCE_FILE), 'run with --generate before validating the canonical report');
  const report = JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8'));
  const validation = validateClosureTimeSealedEvidence(report, { root: ROOT });
  assert.equal(validation.verdict, 'PASS', JSON.stringify(validation));
  assert.equal(validation.evidenceClass, CLOSURE_TIME_SEALED_EVIDENCE);
  assert.ok(fs.existsSync(POST_CLOSURE_MAINTENANCE_EVIDENCE_FILE), 'post-closure maintenance evidence must be a distinct artifact');
  const maintenanceEvidence = JSON.parse(fs.readFileSync(POST_CLOSURE_MAINTENANCE_EVIDENCE_FILE, 'utf8'));
  const maintenanceValidation = validatePostClosureMaintenanceEvidenceArtifact(maintenanceEvidence, { root: ROOT });
  assert.equal(maintenanceValidation.verdict, 'PASS', JSON.stringify(maintenanceValidation));
  assert.equal(maintenanceValidation.evidenceClass, POST_CLOSURE_MAINTENANCE_EVIDENCE);
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, CONTRACT_PATH.replaceAll('/', path.sep)), 'utf8'));
  const ledgerInput = contract.requiredInputs.find((item) => item.path === 'governance/state/GATE_STATUS_LEDGER.ndjson');
  const prefix = resolveCanonicalLedgerPrefix({
    ledgerPath: path.join(ROOT, ledgerInput.path.replaceAll('/', path.sep)),
    eventCount: ledgerInput.eventCount,
    expectedSha256: ledgerInput.sha256
  });
  assert.equal(prefix.valid, true, JSON.stringify(prefix.findings));
  assert.equal(prefix.availableEventCount, 69);
  assert.equal(prefix.prefixSha256, ledgerInput.sha256);
});
