/**
 * Tests for EVIDENCE_SUITE_IDENTITY_GUARD.
 *
 * A guard against vacuous evidence is itself evidence, so it is held to the same
 * standard it enforces: every defect it claims to detect is manufactured here and
 * must be reported, and the shapes it parses are the shapes the real runner
 * actually emits — including the exact top-level output Node produces when a
 * suite throws during module evaluation, which is the defect that motivated the
 * guard and the one a hand-written fixture is most likely to get wrong.
 *
 * The guard's slow half (spawning every suite) is exercised by the CLI in
 * validation runs. What is proven here is the DECISION, which is pure, plus the
 * one structural fact no logic test can supply: that the committed baseline still
 * describes the suites that exist on disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_BASELINE_PATH,
  discoverSuites,
  evaluateEvidenceSuiteIdentity,
  loadBaseline,
  parseSuiteTap
} from '../tools/evidence-suite-identity-guard.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUITE = 'governance/tests/example.test.mjs';

/** TAP as the real reporter emits it for a suite that ran normally. */
function healthyTap(entries) {
  const body = entries.map(([name, ok], index) =>
    `# Subtest: ${name}\n${ok ? 'ok' : 'not ok'} ${index + 1} - ${name}\n  ---\n  duration_ms: 1\n  ...`).join('\n');
  return `TAP version 13\n${body}\n1..${entries.length}\n`;
}

/**
 * The exact shape captured from Node when a suite throws before registering
 * anything: one top-level result naming the FILE, and no `# Subtest:` lines.
 */
const ABORTED_TAP = `TAP version 13
# node:internal/modules/run_main:107
#     triggerUncaughtException(
# AssertionError [ERR_ASSERTION]: LEDGER_ORDINAL_GAP
not ok 1 - governance\\\\tests\\\\example.test.mjs
  ---
  duration_ms: 900
  type: 'test'
  failureType: 'testCodeFailure'
  exitCode: 1
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
`;

const baselineOf = (tests) => ({ suiteDirectory: 'governance/tests', suites: [{ suitePath: SUITE, tests }] });

test('G1 a healthy suite yields its identities, and results are separated from registration', () => {
  const observed = parseSuiteTap(healthyTap([['A one', true], ['B two', false], ['C three', true]]), SUITE);
  assert.equal(observed.setupAborted, false);
  assert.deepEqual(observed.registered, ['A one', 'B two', 'C three']);
  assert.equal(observed.registeredCount, 3);
  assert.equal(observed.executedCount, 3);
  assert.equal(observed.passCount, 2);
  assert.equal(observed.failCount, 1);
  assert.deepEqual(observed.failedIdentities, ['B two']);
});

test('G2 THE DEFECT: an aborted suite is reported as aborted, not as one ordinary failure', () => {
  const observed = parseSuiteTap(ABORTED_TAP, SUITE);
  assert.equal(observed.setupAborted, true);
  assert.equal(observed.registeredCount, 0);
  // The file-level result must not be mistaken for a test the suite declared.
  assert.deepEqual(observed.registered, []);
  assert.deepEqual(observed.executed, []);

  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'FAIL');
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('EVIDENCE_SUITE_SETUP_ABORTED'), JSON.stringify(report.findings));
  // And it says how much coverage went missing, which the pass/fail totals cannot.
  assert.equal(report.findings.find((f) => f.code === 'EVIDENCE_SUITE_SETUP_ABORTED').expectedTestCount, 2);
});

test('G3 a suite that quietly drops one test is blocked by identity, not by count alone', () => {
  const observed = parseSuiteTap(healthyTap([['A one', true], ['C three', true]]), SUITE);
  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two', 'C three']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'FAIL');
  const disappeared = report.findings.find((finding) => finding.code === 'EVIDENCE_TEST_IDENTITY_DISAPPEARED');
  assert.deepEqual(disappeared.missingIdentities, ['B two']);
  assert.ok(report.findings.some((finding) => finding.code === 'EVIDENCE_SUITE_REGISTRATION_SHRANK'));
});

test('G4 a RENAME cannot hide behind a stable total', () => {
  // Same count, same pass rate, different coverage. This is the case a
  // count-only guard is blind to by construction.
  const observed = parseSuiteTap(healthyTap([['A one', true], ['B renamed', true]]), SUITE);
  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'FAIL');
  assert.deepEqual(report.findings.find((f) => f.code === 'EVIDENCE_TEST_IDENTITY_DISAPPEARED').missingIdentities, ['B two']);
  assert.equal(report.registeredTestCount, 2);
});

test('G5 a failing test is NOT a finding: results are the suite\'s business, existence is the guard\'s', () => {
  const observed = parseSuiteTap(healthyTap([['A one', false], ['B two', false]]), SUITE);
  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'PASS');
  assert.equal(report.findingCount, 0);
  assert.equal(observed.failCount, 2);
});

test('G6 growth is permitted and disclosed; shrinkage is not', () => {
  const observed = parseSuiteTap(healthyTap([['A one', true], ['B two', true], ['D new', true]]), SUITE);
  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'PASS');
  assert.deepEqual(report.information.find((entry) => entry.code === 'EVIDENCE_TEST_IDENTITY_ADDED').addedIdentities, ['D new']);
});

test('G7 a registered test that never produced a result is blocked', () => {
  // Registration without a result is the half-executed case: the suite announced
  // the test and then died before it could report.
  const partial = 'TAP version 13\n# Subtest: A one\nok 1 - A one\n# Subtest: B two\n';
  const observed = parseSuiteTap(partial, SUITE);
  assert.deepEqual(observed.registered, ['A one', 'B two']);
  assert.equal(observed.executedCount, 1);
  const report = evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one', 'B two']) });
  assert.equal(report.EVIDENCE_SUITE_IDENTITY, 'FAIL');
  assert.deepEqual(report.findings.find((f) => f.code === 'EVIDENCE_TEST_REGISTERED_NOT_EXECUTED').unexecutedIdentities, ['B two']);
});

test('G8 a missing suite and an undeclared suite are both blocked', () => {
  const absent = evaluateEvidenceSuiteIdentity({
    observed: [{ suitePath: SUITE, missing: true, registeredCount: 0, executedCount: 0, registered: [], executed: [] }],
    baseline: baselineOf(['A one'])
  });
  assert.ok(absent.findings.some((finding) => finding.code === 'EVIDENCE_SUITE_MISSING'));

  const undeclared = evaluateEvidenceSuiteIdentity({
    observed: [parseSuiteTap(healthyTap([['A one', true]]), 'governance/tests/unlisted.test.mjs')],
    baseline: baselineOf(['A one'])
  });
  assert.ok(undeclared.findings.some((finding) => finding.code === 'EVIDENCE_SUITE_NOT_IN_BASELINE'));
});

test('G9 a skipped test still counts as registered and executed', () => {
  const observed = parseSuiteTap('TAP version 13\n# Subtest: A one\nok 1 - A one # SKIP not applicable\n', SUITE);
  assert.deepEqual(observed.registered, ['A one']);
  assert.equal(observed.skipCount, 1);
  assert.equal(observed.passCount, 0);
  assert.equal(evaluateEvidenceSuiteIdentity({ observed: [observed], baseline: baselineOf(['A one']) }).EVIDENCE_SUITE_IDENTITY, 'PASS');
});

test('G10 the committed baseline still describes the suites that exist on disk', () => {
  // The one fact no synthetic fixture can supply. If a suite is added or removed
  // without the baseline being updated deliberately, that is caught here rather
  // than at the end of a twenty-minute run.
  const baseline = loadBaseline(REPO_ROOT, DEFAULT_BASELINE_PATH);
  assert.equal(baseline.documentKind, 'EVIDENCE_SUITE_IDENTITY_BASELINE');
  assert.deepEqual(baseline.suites.map((entry) => entry.suitePath).sort(), discoverSuites(REPO_ROOT).sort());

  for (const entry of baseline.suites) {
    assert.ok(entry.tests.length > 0, `${entry.suitePath} must declare at least one identity`);
    assert.equal(new Set(entry.tests).size, entry.tests.length, `${entry.suitePath} must not declare a duplicate identity`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...entry.suitePath.split('/'))), entry.suitePath);
  }
});

test('G11 the two suites this repair restored are declared at their full population', () => {
  // Pinned explicitly: these are the files that had collapsed to a single
  // top-level failure each, and the numbers are what the guard exists to defend.
  const baseline = loadBaseline(REPO_ROOT, DEFAULT_BASELINE_PATH);
  const declared = (suitePath) => baseline.suites.find((entry) => entry.suitePath === suitePath).tests.length;
  assert.equal(declared('governance/tests/precontract-consumption-permanence.test.mjs'), 52);
  assert.equal(declared('governance/tests/precontract-local-bootstrap-chain.test.mjs'), 31);
});
