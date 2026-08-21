/**
 * GOVERNANCE PREFLIGHT MUST FAIL CLOSED ON A MALFORMED LEDGER.
 *
 * THE DEFECT THIS CLOSES. Preflight parsed the ledger inline with a bare
 * `JSON.parse` per line and no handler, so a truncated or malformed ledger — the
 * state a crashed or partially-written append leaves behind — terminated it with
 * an uncaught SyntaxError. For a fail-closed gate that is the worst available
 * outcome: the tool whose entire job is to decide whether the repository is safe
 * to work in emitted a stack trace instead of a verdict. There was no governed
 * BLOCK to obey, nothing named the defect, and the only signal was an exit code
 * that an uncaught throw and a deliberate refusal happen to share.
 *
 * WHAT IS PROVEN. That a malformed ledger produces a GOVERNED refusal — a
 * verdict, a blocking finding under the name the ledger validator already uses,
 * and a diagnostic naming the file and the line — and that the refusal is not
 * bought by making the good case any weaker.
 *
 * Every hostile runs in an isolated sandbox built as a --shared clone of the real
 * repository, so Git history resolves exactly as it does live. A bare directory
 * copy would lose the object store and change the verdict for reasons that have
 * nothing to do with the ledger.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const PREFLIGHT = 'governance/tools/governance-preflight.mjs';
const LEDGER_UNPARSEABLE = 'NDJSON_PARSE_ERROR';

const sandboxes = [];

/** A disposable mirror that keeps the real Git object history reachable. */
function sandbox(label) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `preflight-${label}-`));
  fs.rmSync(root, { recursive: true, force: true });
  const cloned = spawnSync('git', ['clone', '--shared', '--quiet', REPO_ROOT, root], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  fs.rmSync(path.join(root, 'governance'), { recursive: true, force: true });
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  sandboxes.push(root);
  return root;
}

function runPreflight(root) {
  const result = spawnSync(process.execPath, [PREFLIGHT], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  return { exitCode: result.status, report, combined };
}

const ledgerPath = (root) => path.join(root, ...LEDGER.split('/'));
const ledgerLines = (root) => fs.readFileSync(ledgerPath(root), 'utf8').split(/\r?\n/).filter(Boolean);

/** Every malformed case must reach the same governed shape. */
function assertGovernedBlock({ exitCode, report, combined }, expectedLine) {
  // The primary verdict must be a verdict, not a crash.
  assert.doesNotMatch(combined, /SyntaxError|at JSON\.parse/, 'an uncaught parse error must never be the verdict');
  assert.ok(report, `preflight must still emit a governed report, got: ${combined.slice(0, 300)}`);
  assert.notEqual(exitCode, 0, 'a malformed ledger must exit non-zero');
  assert.equal(report.GOVERNANCE_VERDICT, 'BLOCKED_GOVERNANCE');
  assert.equal(report.configurationValid, false);
  assert.equal(report.governanceStructureValid, false);
  assert.equal(report.executionAuthorized, false);
  assert.ok(report.blockingFindingCount > 0);
  assert.ok(report.findingIds.includes(LEDGER_UNPARSEABLE), JSON.stringify(report.findingIds));
  // The diagnostic must identify the ledger and where it failed.
  assert.equal(report.ledgerParseFailure.path, LEDGER);
  assert.equal(report.ledgerParseFailure.lineNumber, expectedLine);
  assert.equal(typeof report.ledgerParseFailure.message, 'string');
}

test('P-D the canonical good ledger still PASSes, unchanged', () => {
  // The control. A refusal that also refuses the healthy case has proven nothing.
  const { exitCode, report, combined } = runPreflight(REPO_ROOT);
  assert.equal(exitCode, 0, combined.slice(0, 400));
  assert.equal(report.GOVERNANCE_VERDICT, 'PASS');
  assert.equal(report.configurationValid, true);
  assert.equal(report.blockingFindingCount, 0);
  assert.deepEqual(report.findingIds, []);
  assert.equal(report.ledgerParseFailure, undefined, 'a healthy ledger must not report a parse failure');
  // The status still comes from the ledger, so the parse is genuinely being used.
  assert.notEqual(report.activeGateStatus, 'UNKNOWN');
});

test('P-A a truncated final JSON line is a governed BLOCK', () => {
  const root = sandbox('truncated');
  const bytes = fs.readFileSync(ledgerPath(root));
  const lineCount = ledgerLines(root).length;
  fs.writeFileSync(ledgerPath(root), bytes.subarray(0, bytes.length - 120));
  assertGovernedBlock(runPreflight(root), lineCount);
});

test('P-B a malformed line in the MIDDLE is a governed BLOCK', () => {
  // The tail is a special case the reader could get right by accident. A broken
  // line with valid lines after it cannot be.
  const root = sandbox('middle');
  const lines = ledgerLines(root);
  lines[39] = '{"broken": ';
  fs.writeFileSync(ledgerPath(root), `${lines.join('\n')}\n`);
  assertGovernedBlock(runPreflight(root), 40);
});

test('P-C bytes that are not JSON at all are a governed BLOCK', () => {
  const root = sandbox('nonjson');
  const lineCount = ledgerLines(root).length;
  fs.appendFileSync(ledgerPath(root), Buffer.from([0xff, 0xfe, 0x20, 0x6e, 0x6f, 0x0a]));
  assertGovernedBlock(runPreflight(root), lineCount + 1);
});

test('P-E THE PARTIAL-PASS TRAP: a malformed ledger yields no usable events at all', () => {
  // The subtle failure this must not have. 81 of 82 lines still parse, so a
  // reader that skipped the bad line would produce a confident, complete-looking
  // answer from an incomplete ledger — a PASS built on history it silently
  // dropped. Fail-closed means the parse yields NOTHING once any line is bad.
  const root = sandbox('partial');
  const lines = ledgerLines(root);
  const { activeGate } = JSON.parse(fs.readFileSync(path.join(root, 'governance/active/ACTIVE_GATE.json'), 'utf8'));
  // The prefix genuinely does contain this Gate's history, so UNKNOWN below can
  // only mean the reader refused to use a partially-parsed ledger.
  assert.ok(lines.slice(0, -1).some((line) => JSON.parse(line).gateId === activeGate));
  lines[lines.length - 1] = '{"truncated": tru';
  fs.writeFileSync(ledgerPath(root), `${lines.join('\n')}\n`);

  const outcome = runPreflight(root);
  assertGovernedBlock(outcome, lines.length);
  // The status must not have been derived from the surviving prefix.
  assert.equal(outcome.report.activeGateStatus, 'UNKNOWN');
  assert.equal(outcome.report.activeGateExecutable, false);
  assert.ok(activeGate, 'the fixture must genuinely have an active gate to report');
});

test('P-F the ledger validator independently refuses the same bytes', () => {
  // Preflight is not the only guard, and the two must not disagree about one
  // file. This is also where the finding NAME comes from: reusing it is what
  // keeps a single defect from acquiring two vocabularies.
  const root = sandbox('validator-parity');
  const lines = ledgerLines(root);
  lines[39] = '{"broken": ';
  fs.writeFileSync(ledgerPath(root), `${lines.join('\n')}\n`);

  const result = spawnSync(process.execPath, ['governance/tools/validate-status-ledger.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
  const blocking = report.findings.filter((finding) => finding.severity === 'BLOCKING');
  assert.ok(blocking.some((finding) => finding.detectorId === LEDGER_UNPARSEABLE),
    JSON.stringify([...new Set(blocking.map((finding) => finding.detectorId))]));
});

test.after(() => {
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});
