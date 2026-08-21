/**
 * EVIDENCE SUITE IDENTITY GUARD — a non-vacuity check for the evidence itself.
 *
 * THE DEFECT THIS EXISTS FOR. A governed repository trusts its test suites to
 * say what is proven. Aggregate PASS/FAIL totals cannot carry that trust,
 * because the cheapest way for a suite to stop failing is to stop running:
 *
 *   - a fixture that throws during module evaluation takes EVERY test in the
 *     file out of the run, and the file reports as ONE failure rather than as
 *     the fifty-one hostile cases that never executed;
 *   - once such a file is "already failing", the totals move by one when the
 *     coverage behind it moves by fifty;
 *   - a suite can be quietly narrowed, and nothing in a pass count notices.
 *
 * Both precontract suites in this repository were in exactly that state: 52 and
 * 31 intended tests had collapsed to 1 top-level failure each, so 81 hostile
 * identities were reported as 2 failures. The totals were not wrong. They were
 * describing a different, much smaller question than the one they appeared to
 * answer.
 *
 * WHAT THIS GUARD ASSERTS. Not results — IDENTITIES. For every declared suite,
 * every test named in the baseline must still be registered and must still
 * produce a result. A test that fails is evidence; a test that vanished is the
 * absence of evidence wearing the same number.
 *
 * WHY THE BASELINE IS DECLARED, NOT DERIVED. A baseline regenerated from the run
 * it is checking proves nothing at all — it would agree with any population,
 * including an empty one. The baseline is therefore a committed expectation that
 * only a human edit can widen or narrow, and this module never writes it:
 * `--print-baseline` emits a proposal to stdout for a person to read and place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const EVIDENCE_SUITE_IDENTITY_GUARD_DOCUMENT = 'EVIDENCE_SUITE_IDENTITY_GUARD_REPORT';
export const DEFAULT_BASELINE_PATH = 'governance/tests/EVIDENCE_SUITE_IDENTITY_BASELINE.json';
export const DEFAULT_SUITE_DIRECTORY = 'governance/tests';

/** TAP escapes `\` and `#` in names; nothing else is escaped by the reporter. */
function unescapeTapName(name) {
  return name.replace(/\\([\\#])/g, '$1');
}

/**
 * The registered and executed test identities in one suite's TAP output.
 *
 * Node reports a suite that threw during setup as a SINGLE result whose name is
 * the suite's own path, with no `# Subtest:` lines at all. That shape is the
 * signature of aborted setup, and it is the one case where a low count is not a
 * small suite but a silenced one, so it is reported as its own defect rather
 * than as a pile of missing identities.
 */
export function parseSuiteTap(tapText, suitePath) {
  const suiteBasename = path.basename(suitePath);
  const registered = [];
  const executed = [];
  for (const rawLine of tapText.split(/\r?\n/)) {
    const subtest = rawLine.match(/^\s*# Subtest: (.*)$/);
    if (subtest) {
      registered.push(unescapeTapName(subtest[1]));
      continue;
    }
    const result = rawLine.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (result) {
      executed.push({
        name: unescapeTapName(result[2]).trimEnd(),
        ok: result[1] === 'ok',
        directive: result[3] ?? null
      });
    }
  }
  // A file-level result naming the suite itself is the runner reporting the
  // FILE, not a test the suite declared.
  const isFileLevel = (name) => name.replaceAll('\\', '/').endsWith(suiteBasename);
  const declared = registered.filter((name) => !isFileLevel(name));
  const declaredResults = executed.filter((entry) => !isFileLevel(entry.name));
  const fileLevelFailure = executed.find((entry) => isFileLevel(entry.name) && !entry.ok) ?? null;

  return {
    suitePath,
    setupAborted: declared.length === 0 && fileLevelFailure !== null,
    registeredCount: declared.length,
    executedCount: declaredResults.length,
    passCount: declaredResults.filter((entry) => entry.ok && entry.directive === null).length,
    failCount: declaredResults.filter((entry) => !entry.ok).length,
    skipCount: declaredResults.filter((entry) => entry.directive !== null).length,
    registered: declared,
    executed: declaredResults,
    failedIdentities: declaredResults.filter((entry) => !entry.ok).map((entry) => entry.name)
  };
}

/** Runs one suite under the TAP reporter and parses what it registered. */
export function observeSuite({ root, suitePath, nodeExecutable = process.execPath }) {
  const absolute = path.join(root, ...suitePath.split('/'));
  if (!fs.existsSync(absolute)) {
    return { suitePath, missing: true, setupAborted: false, registeredCount: 0, executedCount: 0, registered: [], executed: [], failedIdentities: [] };
  }
  const run = spawnSync(nodeExecutable, ['--test', '--test-reporter=tap', absolute], {
    cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024
  });
  return { ...parseSuiteTap(`${run.stdout ?? ''}\n${run.stderr ?? ''}`, suitePath), missing: false, exitCode: run.status };
}

function finding(code, suitePath, message, extra = {}) {
  return { code, severity: 'BLOCKING', suitePath, message, ...extra };
}

/**
 * Compares an observed suite population against the declared baseline.
 *
 * Every check is one-directional on purpose: coverage may GROW without approval
 * and may not SHRINK without it. A new test is reported as information; a
 * missing one is a blocking defect.
 */
export function evaluateEvidenceSuiteIdentity({ observed, baseline }) {
  const findings = [];
  const information = [];
  const byPath = new Map(observed.map((entry) => [entry.suitePath, entry]));

  for (const expected of baseline.suites) {
    const actual = byPath.get(expected.suitePath);
    if (!actual || actual.missing) {
      findings.push(finding('EVIDENCE_SUITE_MISSING', expected.suitePath,
        'A suite named by the baseline is not present, so everything it proved is unproven.'));
      continue;
    }
    if (actual.setupAborted) {
      findings.push(finding('EVIDENCE_SUITE_SETUP_ABORTED', expected.suitePath,
        'The suite threw before registering its tests, so none of them executed and the run reports one failure in place of many.',
        { expectedTestCount: expected.tests.length, registeredCount: 0 }));
      continue;
    }
    const registered = new Set(actual.registered);
    const missing = expected.tests.filter((name) => !registered.has(name));
    if (missing.length > 0) {
      findings.push(finding('EVIDENCE_TEST_IDENTITY_DISAPPEARED', expected.suitePath,
        'Tests named by the baseline were not registered by the suite.',
        { missingIdentities: missing }));
    }
    if (actual.registeredCount < expected.tests.length) {
      findings.push(finding('EVIDENCE_SUITE_REGISTRATION_SHRANK', expected.suitePath,
        'The suite registered fewer tests than the baseline declares.',
        { expectedTestCount: expected.tests.length, registeredCount: actual.registeredCount }));
    }
    const producedResult = new Set(actual.executed.map((entry) => entry.name));
    const neverRan = actual.registered.filter((name) => !producedResult.has(name));
    if (neverRan.length > 0) {
      findings.push(finding('EVIDENCE_TEST_REGISTERED_NOT_EXECUTED', expected.suitePath,
        'Tests were registered but produced no result, so they were never actually run.',
        { unexecutedIdentities: neverRan }));
    }
    const added = actual.registered.filter((name) => !expected.tests.includes(name));
    if (added.length > 0) {
      information.push({ code: 'EVIDENCE_TEST_IDENTITY_ADDED', severity: 'INFO', suitePath: expected.suitePath, addedIdentities: added });
    }
  }

  const declared = new Set(baseline.suites.map((entry) => entry.suitePath));
  for (const entry of observed) {
    if (!declared.has(entry.suitePath)) {
      findings.push(finding('EVIDENCE_SUITE_NOT_IN_BASELINE', entry.suitePath,
        'A suite exists that the baseline does not declare, so its population is unguarded.'));
    }
  }

  return {
    document: EVIDENCE_SUITE_IDENTITY_GUARD_DOCUMENT,
    EVIDENCE_SUITE_IDENTITY: findings.length === 0 ? 'PASS' : 'FAIL',
    findingCount: findings.length,
    findings,
    information,
    suiteCount: observed.length,
    declaredTestCount: baseline.suites.reduce((total, entry) => total + entry.tests.length, 0),
    registeredTestCount: observed.reduce((total, entry) => total + entry.registeredCount, 0),
    executedTestCount: observed.reduce((total, entry) => total + entry.executedCount, 0)
  };
}

/** Every evidence suite on disk, as repo-relative paths, in stable order. */
export function discoverSuites(root, directory = DEFAULT_SUITE_DIRECTORY) {
  const absolute = path.join(root, ...directory.split('/'));
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute).filter((name) => name.endsWith('.test.mjs')).sort()
    .map((name) => `${directory}/${name}`);
}

export function loadBaseline(root, baselinePath = DEFAULT_BASELINE_PATH) {
  return JSON.parse(fs.readFileSync(path.join(root, ...baselinePath.split('/')), 'utf8'));
}

export function runEvidenceSuiteIdentityGuard({ root, baselinePath = DEFAULT_BASELINE_PATH, suitePaths = null }) {
  const baseline = loadBaseline(root, baselinePath);
  const suites = suitePaths ?? discoverSuites(root, baseline.suiteDirectory ?? DEFAULT_SUITE_DIRECTORY);
  const observed = suites.map((suitePath) => observeSuite({ root, suitePath }));
  return { ...evaluateEvidenceSuiteIdentity({ observed, baseline }), observed };
}

function main(argv) {
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : path.resolve(argv[rootIndex + 1]);
  const baselineIndex = argv.indexOf('--baseline');
  const baselinePath = baselineIndex === -1 ? DEFAULT_BASELINE_PATH : argv[baselineIndex + 1];

  if (argv.includes('--print-baseline')) {
    // Emitted to stdout for a person to read and place. Writing it here would
    // make the guard agree with whatever it just observed.
    const suites = discoverSuites(root).map((suitePath) => observeSuite({ root, suitePath }));
    process.stdout.write(`${JSON.stringify({
      documentKind: 'EVIDENCE_SUITE_IDENTITY_BASELINE',
      schemaVersion: 1,
      suiteDirectory: DEFAULT_SUITE_DIRECTORY,
      suites: suites.map((entry) => ({ suitePath: entry.suitePath, tests: entry.registered }))
    }, null, 2)}\n`);
    return 0;
  }

  const report = runEvidenceSuiteIdentityGuard({ root, baselinePath });
  const { observed, ...printable } = report;
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
  return report.EVIDENCE_SUITE_IDENTITY === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href) {
  process.exit(main(process.argv.slice(2)));
}
