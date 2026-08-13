#!/usr/bin/env node
/**
 * REGRESSION_IDENTITY_DELTA — compare a governed regression baseline against a
 * current suite run by FAILURE IDENTITY, never by count.
 *
 * WHAT THIS EXISTS TO PREVENT. Two different lies about regressions, both of
 * which a count-based check tells cheerfully:
 *
 *   1. "70 failed before and 70 fail now, so nothing changed" — while one
 *      historical failure was repaired and one new one appeared in its place.
 *   2. "the baseline is self-consistent, so the comparison is sound" — while
 *      the baseline describes a suite that no longer exists.
 *
 * WHY baseHead IS NOT REQUIRED TO EQUAL HEAD. A baseline is captured once and
 * stays valid across later commits that do not change the suite. Demanding
 * baseline.baseHead === currentHead would invalidate a perfectly good baseline
 * on the very next commit, which is how baselines get regenerated mechanically
 * until they mean nothing. What must be established instead is COMPARABILITY:
 * the same suite specification, and every file a baseline identity names still
 * present. Comparability is proven, and if it cannot be proven this fails closed
 * rather than reporting a delta computed against an unknown world.
 *
 * Local, offline, deterministic. Reads only; writes nothing inside the
 * repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from './canonical-json.mjs';

export const DELTA_DOCUMENT = 'REGRESSION_IDENTITY_DELTA';
export const DELTA_VERSION = 'V1';

export const PREEXISTING_UNRELATED = 'PREEXISTING_UNRELATED';
export const REPAIRED = 'REPAIRED';
export const NEW_RELATED = 'NEW_RELATED';
export const NEW_UNRELATED = 'NEW_UNRELATED';
export const STALE_EXPECTATION = 'STALE_EXPECTATION';

export const CLASSIFICATIONS = Object.freeze([
  PREEXISTING_UNRELATED, REPAIRED, NEW_RELATED, NEW_UNRELATED, STALE_EXPECTATION
]);

/** Baseline identities carrying this root cause are lawfully-superseded expectations. */
const STALE_ROOT_CAUSE = 'POST_GATE14_CLOSURE_STALE_EXPECTATION';

/**
 * Parses `node --test --test-reporter=tap` output into failure identities.
 *
 * The identity is `<repo-relative file>::<test name>`, taken from the TAP
 * `location:` field rather than from indentation, because the flat reporter does
 * not nest a test under its file. A `not ok` line whose location cannot be
 * resolved is kept with an explicit UNRESOLVED_LOCATION marker instead of being
 * dropped — a failure nobody can attribute must stay visible.
 */
export function parseTapFailureIdentities({ tapText, repoRoot } = {}) {
  if (typeof tapText !== 'string' || !tapText) throw new Error('TAP_TEXT_REQUIRED');
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('REPO_ROOT_REQUIRED');
  const rootPrefix = `${path.resolve(repoRoot)}${path.sep}`.toLowerCase();
  const lines = tapText.split(/\r?\n/);
  const identities = [];
  for (let index = 0; index < lines.length; index += 1) {
    const failure = /^\s*not ok \d+ - (.*)$/.exec(lines[index]);
    if (!failure) continue;
    const testName = failure[1].trim();
    let file = null;
    for (let scan = index + 1; scan < Math.min(index + 16, lines.length); scan += 1) {
      if (/^\s*\.\.\.\s*$/.test(lines[scan])) break;
      const location = /^\s*location: '(.+?):\d+:\d+'$/.exec(lines[scan]);
      if (location) { file = location[1].replace(/\\\\/g, '\\'); break; }
    }
    if (!file) {
      identities.push({ identity: `UNRESOLVED_LOCATION::${testName}`, file: null, testName, locationResolved: false });
      continue;
    }
    const absolute = path.resolve(file);
    const relative = absolute.toLowerCase().startsWith(rootPrefix)
      ? absolute.slice(rootPrefix.length).split(path.sep).join('/')
      : absolute.split(path.sep).join('/');
    identities.push({ identity: `${relative}::${testName}`, file: relative, testName, locationResolved: true });
  }
  // Two tests may share a name inside one file; the identity is then genuinely
  // ambiguous, so duplicates collapse rather than inflating either side.
  const seen = new Set();
  return identities.filter((entry) => (seen.has(entry.identity) ? false : (seen.add(entry.identity), true)))
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
}

/** Suite identity: what was run, not what it produced. */
export function suiteIdentity({ command, testFiles }) {
  return sha256Canonical({ command, testFiles: [...new Set(testFiles)].sort() });
}

function exists(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split('/'));
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile();
}

/**
 * Establishes whether the two sides describe the same suite well enough that a
 * set difference between them means anything.
 *
 * A baseline identity whose file has been deleted is the one shape that breaks
 * this: its absence from the current run proves nothing, because the test can no
 * longer run at all. That is reported as an unresolvable baseline file, and it
 * blocks — silently calling it REPAIRED would be the fabricated-repair shape.
 */
export function establishComparability({ baseline, current, root } = {}) {
  const reasons = [];
  const baselineCommand = baseline?.suiteSpec?.command ?? null;
  const currentCommand = current?.suiteSpec?.command ?? null;
  if (!baselineCommand) reasons.push('BASELINE_SUITE_COMMAND_ABSENT');
  if (!currentCommand) reasons.push('CURRENT_SUITE_COMMAND_ABSENT');
  if (baselineCommand && currentCommand && baselineCommand !== currentCommand) reasons.push('SUITE_COMMAND_CHANGED');

  const baselineIdentities = Array.isArray(baseline?.failureIdentities) ? baseline.failureIdentities : null;
  if (!baselineIdentities) reasons.push('BASELINE_IDENTITIES_ABSENT');
  if (baselineIdentities && baselineIdentities.length !== baseline.failureIdentityCount) reasons.push('BASELINE_SELF_INCONSISTENT');

  const unresolvableBaselineFiles = (baselineIdentities || [])
    .map((entry) => entry.file)
    .filter((file, index, all) => typeof file === 'string' && all.indexOf(file) === index)
    .filter((file) => !exists(root, file));
  if (unresolvableBaselineFiles.length) reasons.push('BASELINE_TEST_FILE_ABSENT');

  const unresolvedCurrent = (current?.failureIdentities || []).filter((entry) => entry.locationResolved === false);
  if (unresolvedCurrent.length) reasons.push('CURRENT_FAILURE_LOCATION_UNRESOLVED');

  return {
    comparable: reasons.length === 0,
    reasons,
    unresolvableBaselineFiles,
    unresolvedCurrentFailures: unresolvedCurrent.map((entry) => entry.identity),
    baselineHead: baseline?.baseHead ?? null,
    currentHead: current?.head ?? null,
    // Stated explicitly so nobody reintroduces an equality requirement here.
    headEqualityRequired: false,
    baselineSuiteIdentity: baselineCommand ? suiteIdentity({ command: baselineCommand, testFiles: (baselineIdentities || []).map((entry) => entry.file).filter(Boolean) }) : null,
    currentSuiteIdentity: currentCommand ? suiteIdentity({ command: currentCommand, testFiles: (current?.failureIdentities || []).map((entry) => entry.file).filter(Boolean) }) : null
  };
}

/**
 * Classifies every identity on both sides.
 *
 * `cohortPaths` is what separates a new failure this mission caused from one it
 * merely observed. It is the mission's own authorized path set, so a new failure
 * inside it is NEW_RELATED — owned, and to be fixed here — and anything else is
 * NEW_UNRELATED, which is the invariant that must stay at zero.
 */
export function compareRegressionIdentities({ baseline, current, root, cohortPaths = [] } = {}) {
  const comparability = establishComparability({ baseline, current, root });
  const baselineEntries = Array.isArray(baseline?.failureIdentities) ? baseline.failureIdentities : [];
  const currentEntries = Array.isArray(current?.failureIdentities) ? current.failureIdentities : [];
  const baselineById = new Map(baselineEntries.map((entry) => [entry.identity, entry]));
  const currentIds = new Set(currentEntries.map((entry) => entry.identity));
  const cohort = new Set(cohortPaths);

  const classified = [];
  for (const entry of baselineEntries) {
    if (currentIds.has(entry.identity)) {
      classified.push({
        identity: entry.identity,
        file: entry.file ?? null,
        classification: entry.rootCauseClass === STALE_ROOT_CAUSE ? STALE_EXPECTATION : PREEXISTING_UNRELATED,
        rootCauseClass: entry.rootCauseClass ?? null
      });
    } else {
      classified.push({
        identity: entry.identity,
        file: entry.file ?? null,
        classification: REPAIRED,
        rootCauseClass: entry.rootCauseClass ?? null
      });
    }
  }
  for (const entry of currentEntries) {
    if (baselineById.has(entry.identity)) continue;
    classified.push({
      identity: entry.identity,
      file: entry.file ?? null,
      classification: entry.file && cohort.has(entry.file) ? NEW_RELATED : NEW_UNRELATED,
      rootCauseClass: null
    });
  }
  classified.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

  const countOf = (classification) => classified.filter((entry) => entry.classification === classification).length;
  const counts = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, countOf(classification)]));

  // Fail closed: without comparability there is no delta, only a difference
  // between two sets that may describe different suites.
  const verdict = !comparability.comparable
    ? 'BLOCKED_NOT_COMPARABLE'
    : counts[NEW_UNRELATED] === 0 ? 'PASS' : 'FAIL_NEW_UNRELATED_REGRESSIONS';

  return {
    document: DELTA_DOCUMENT,
    version: DELTA_VERSION,
    verdict,
    comparability,
    baselineFailureIdentityCount: baselineEntries.length,
    currentFailureIdentityCount: currentEntries.length,
    counts,
    cohortPaths: [...cohort].sort(),
    identities: classified
  };
}

/** Reads a TAP report from disk and compares it against the governed baseline. */
export function runRegressionIdentityDelta({ root, tapPath, baselinePath, command, currentHead, cohortPaths = [] } = {}) {
  const baseline = JSON.parse(fs.readFileSync(path.resolve(root, ...baselinePath.split('/')), 'utf8').replace(/^﻿/, ''));
  const tapText = fs.readFileSync(path.resolve(tapPath), 'utf8');
  const failureIdentities = parseTapFailureIdentities({ tapText, repoRoot: root });
  const current = {
    head: currentHead ?? null,
    suiteSpec: { command: command ?? baseline?.suiteSpec?.command ?? null },
    failureIdentities
  };
  return compareRegressionIdentities({ baseline, current, root, cohortPaths });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const tapPath = option('--tap');
  if (!tapPath) {
    process.stderr.write('--tap <file> is required (node --test --test-reporter=tap ... > file)\n');
    process.exitCode = 2;
  } else {
    const report = runRegressionIdentityDelta({
      root,
      tapPath,
      baselinePath: option('--baseline', 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json'),
      command: option('--command'),
      currentHead: option('--head'),
      cohortPaths: (option('--cohort', '') || '').split(',').filter(Boolean)
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.verdict === 'PASS' ? 0 : 2;
  }
}
