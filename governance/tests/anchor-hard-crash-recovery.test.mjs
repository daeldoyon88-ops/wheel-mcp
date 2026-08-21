/**
 * PRECONTRACT ANCHOR PUBLICATION — HARD CRASH, FRESH PROCESS, DETERMINISTIC RECOVERY.
 *
 * WHY THE PREVIOUS HOSTILE PROVED LESS THAN IT LOOKED.
 *
 * `anchor-publication-atomicity.test.mjs` forces an EIO at the ledger write and
 * shows the pre-state is restored byte for byte. That is a real property and it
 * still holds. But it is a property of a THROW: the exception is caught by the
 * very process that raised it, and that process still runs its rollback. Nothing
 * in it says what survives when the process does not.
 *
 * Kill the publisher instead and two states appear that a caught exception never
 * produces:
 *
 *   A. the canonical ledger holding a PREFIX of the candidate — `writeFileSync`
 *      truncates the target and streams into it, so a death mid-write leaves a
 *      truncated final line. Every reader parses every line, so the next read
 *      throws and even the retry that would have repaired it cannot run.
 *
 *   B. a journal stuck in COMMITTING whose `provenance` is null — because the
 *      anchor called `applyCandidate` without an authority, and
 *      `createLifecycleTransactionProvenance` answers null without one. A fresh
 *      process then reaches PENDING_TRANSACTION_PROVENANCE_INVALID /
 *      PROVENANCE_ABSENT_OR_INVALID and stops there, permanently.
 *
 * Both are closed here, and by different means, because they are different
 * defects. A is physical: publication now replaces files by rename, so no
 * observer can see a partial canonical file whatever kills the process. B is
 * evidentiary: the transaction carries the anchor authority it was published
 * under, re-proved at recovery by the same clause set `validate-status-ledger`
 * uses on the event.
 *
 * WHAT "HARD CRASH" MEANS HERE. A child `node` process is killed with SIGKILL —
 * TerminateProcess on Windows — from inside the boundary itself. No exit handler
 * runs, no buffer is flushed, no rollback executes. Recovery is then invoked from
 * a THIRD process that has never seen the publisher's memory.
 *
 * NON-VACUITY IS ASSERTED, NEVER ASSUMED. Every crash boundary writes a durable
 * marker OUTSIDE the repository, recording which boundary was reached and what
 * the ledger looked like at that instant, using fd calls captured before any
 * patching. A hostile that quietly stopped short is precisely the failure this
 * battery exists to rule out, so the marker — and the abnormal termination of the
 * child — are checked before any conclusion is drawn from the repository state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { sha256Bytes } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const TRANSACTIONS = 'governance/transactions';
const GATE = 'GATE20';
const ANCHOR_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
const ANCHOR_AUTHORITY = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;
const RECEIPT = `governance/gates/${GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
const RECORDED_AT = '2026-08-16T23:30:00.000Z';
const TXN_DIR = `${TRANSACTIONS}/TXN_${GATE}_PRECONTRACT_CONSUMPTION_ANCHOR_R1`;

const absolute = (root, relative) => path.resolve(root, ...relative.split('/'));
const readJson = (root, relative) => JSON.parse(fs.readFileSync(absolute(root, relative), 'utf8').replace(/^﻿/, ''));
const writeJson = (root, relative, value) => fs.writeFileSync(absolute(root, relative), `${JSON.stringify(value, null, 2)}\n`);
const ledgerBytes = (root) => fs.readFileSync(absolute(root, LEDGER));
const readEvents = (root) => ledgerBytes(root).toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const writeEvents = (root, events) => fs.writeFileSync(absolute(root, LEDGER), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
const anchorsOf = (root) => readEvents(root).filter((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE);

/**
 * A disposable CLONE, not a directory copy: consumption receipts pin the commit
 * they were produced at and resolve it through Git, and the maintenance
 * observation reads `git rev-parse HEAD`. A historyless copy answers
 * HISTORICAL_BASE_COMMIT_UNKNOWN everywhere, which would let a tamper test pass
 * without the tamper doing anything.
 */
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'anchor-hardcrash-'));
const PRISTINE = path.join(SCRATCH, 'pristine-governance');
const CLONE_SEED = path.join(SCRATCH, 'seed');
{
  const clone = spawnSync('git', ['-c', 'core.longpaths=true', 'clone', '--local', '--quiet', REPO_ROOT, CLONE_SEED], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stdout + clone.stderr);
  spawnSync('git', ['config', 'core.longpaths', 'true'], { cwd: CLONE_SEED, encoding: 'utf8' });
  fs.rmSync(path.join(CLONE_SEED, 'governance'), { recursive: true, force: true });
  fs.cpSync(path.join(REPO_ROOT, 'governance'), PRISTINE, { recursive: true });
}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });

let sandboxOrdinal = 0;
/**
 * A fresh sandbox per scenario. Each crash test really does kill a process, so
 * scenarios cannot share a working tree without one crash's residue becoming
 * another's premise.
 */
function sandbox({ withoutAnchor = true } = {}) {
  sandboxOrdinal += 1;
  const root = path.join(SCRATCH, `case-${sandboxOrdinal}`);
  fs.cpSync(CLONE_SEED, root, { recursive: true });
  fs.cpSync(PRISTINE, path.join(root, 'governance'), { recursive: true });
  // Scoped to THIS Gate: GATE19 carries an anchor of its own, and rewinding that
  // one too would change a second fact no test here means to touch.
  if (withoutAnchor) writeEvents(root, readEvents(root).filter((event) => !(event.gateId === GATE && event.transitionType === ANCHOR_TYPE)));
  return root;
}

/** Half-moved publication bytes next to a canonical path. */
function publicationResidue(root) {
  const stateDir = absolute(root, 'governance/state');
  return fs.readdirSync(stateDir)
    .filter((name) => /__publish__|\.tmp$|\.temp$|\.journal$|\.bak$/.test(name))
    .map((name) => `governance/state/${name}`);
}

/** Everything a killed publication might have left lying around, journal included. */
function residue(root) {
  const transactions = absolute(root, TRANSACTIONS);
  const journals = fs.existsSync(transactions) ? fs.readdirSync(transactions).map((name) => `${TRANSACTIONS}/${name}`) : [];
  return [...publicationResidue(root), ...journals];
}

/* ------------------------------------------------------------------------ *
 * The crashing publisher — a real process, killed from inside a real boundary
 * ------------------------------------------------------------------------ */

const BOUNDARIES = Object.freeze([
  'PREPARED_BEFORE_COMMITTING',
  'COMMITTING_BEFORE_LEDGER_WRITE',
  'LEDGER_PARTIAL_WRITE',
  'LEDGER_WRITTEN_BEFORE_COMMITTED',
  'COMMITTED_BEFORE_DISCARD'
]);

const DRIVER = `
import fs from 'node:fs';
import path from 'node:path';

const [root, boundary, markerPath] = process.argv.slice(2);
const ledger = path.resolve(root, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const temporary = ledger + '.__publish__.tmp';
const txnDir = path.resolve(root, ${JSON.stringify(TXN_DIR)});
const prepared = path.join(txnDir, 'PREPARED');
const committed = path.join(txnDir, 'COMMITTED');
const journal = path.join(txnDir, 'TRANSACTION.json');

// Captured BEFORE any patching, so the marker and the partial prefix are written
// with primitives the patches below cannot re-enter.
const rawOpen = fs.openSync, rawWrite = fs.writeSync, rawFsync = fs.fsyncSync, rawClose = fs.closeSync;
const rawExists = fs.existsSync, rawRead = fs.readFileSync, rawStat = fs.statSync;
const realRename = fs.renameSync;

const resolveOrNull = (value) => { try { return path.resolve(String(value)); } catch { return null; } };

function mark(extra) {
  const payload = Buffer.from(JSON.stringify({
    boundary,
    ledgerByteLength: rawExists(ledger) ? rawStat(ledger).size : null,
    temporaryPresent: rawExists(temporary),
    temporaryByteLength: rawExists(temporary) ? rawStat(temporary).size : null,
    preparedPresent: rawExists(prepared),
    committedPresent: rawExists(committed),
    journalState: rawExists(journal) ? JSON.parse(rawRead(journal, 'utf8')).transactionState : null,
    ...extra
  }) + '\\n', 'utf8');
  const fd = rawOpen(markerPath, 'w');
  try { rawWrite(fd, payload, 0, payload.length, 0); rawFsync(fd); } finally { rawClose(fd); }
}

/** No handler runs, nothing is flushed, no rollback executes. */
function die(extra) { mark(extra ?? {}); process.kill(process.pid, 'SIGKILL'); }

// --- boundary arming -------------------------------------------------------
//
// Every canonical write now goes through durable replacement, so the boundaries
// are the fd that a target's temp file was opened on and the rename that puts it
// in place. Scoping the partial write to the LEDGER's own fd matters: the staged
// artifact carries the same bytes and is written first, and a hostile that fired
// there would be crashing before the boundary it claims to test.
let ledgerTemporaryFd = null;

fs.openSync = (file, ...rest) => {
  const resolved = resolveOrNull(file);
  if (boundary === 'COMMITTING_BEFORE_LEDGER_WRITE' && resolved === temporary) {
    // The journal has already been flipped to COMMITTING by this point; the
    // ledger has not been touched at all.
    die({ armedAt: 'LEDGER_TEMP_OPEN' });
  }
  const handle = rawOpen(file, ...rest);
  if (resolved === temporary) ledgerTemporaryFd = handle;
  return handle;
};

fs.writeSync = (fd, buffer, ...rest) => {
  if (boundary === 'LEDGER_PARTIAL_WRITE' && fd === ledgerTemporaryFd && Buffer.isBuffer(buffer) && buffer.length > 1) {
    // A genuine prefix of the candidate reaches stable storage, then the process
    // dies. This is the physical shape of the original defect; what has changed
    // is only WHERE those bytes land.
    const prefix = buffer.subarray(0, Math.floor(buffer.length / 2));
    rawWrite(fd, prefix, 0, prefix.length, 0);
    rawFsync(fd);
    die({ armedAt: 'LEDGER_PARTIAL_WRITE', partialBytes: prefix.length });
  }
  return rawWrite(fd, buffer, ...rest);
};

fs.renameSync = (from, to) => {
  const target = resolveOrNull(to);
  const result = realRename(from, to);
  if (boundary === 'PREPARED_BEFORE_COMMITTING' && target === prepared) die({ armedAt: 'PREPARED_MARKER_COMPLETE' });
  if (boundary === 'LEDGER_WRITTEN_BEFORE_COMMITTED' && target === ledger) die({ armedAt: 'LEDGER_RENAME_COMPLETE' });
  if (boundary === 'COMMITTED_BEFORE_DISCARD' && target === committed) die({ armedAt: 'COMMITTED_MARKER_COMPLETE' });
  return result;
};

const { anchorPrecontractConsumption } = await import(${JSON.stringify(pathToFileUrlLiteral())});
const report = anchorPrecontractConsumption({
  root,
  authorityPath: path.resolve(root, ${JSON.stringify(ANCHOR_AUTHORITY)}),
  recordedAt: ${JSON.stringify(RECORDED_AT)},
  apply: true
});
// Reaching here means the boundary was never hit; the marker records that so the
// test fails loudly rather than silently proving nothing.
mark({ armedAt: 'NEVER_REACHED', verdict: report.verdict, findings: report.findings });
process.exit(0);
`;

function pathToFileUrlLiteral() {
  return new URL('../tools/anchor-precontract-consumption.mjs', import.meta.url).href;
}

/** Kill a real publisher at `boundary`, then report what the corpse left behind. */
function crashPublisher(root, boundary) {
  const driver = path.join(SCRATCH, `driver-${boundary}-${sandboxOrdinal}.mjs`);
  const marker = path.join(SCRATCH, `marker-${boundary}-${sandboxOrdinal}.json`);
  fs.writeFileSync(driver, DRIVER, 'utf8');
  const child = spawnSync(process.execPath, [driver, root, boundary, marker], { encoding: 'utf8' });
  const observed = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  return { child, observed };
}

/** Canonical recovery, from a process that never saw the publisher. */
function recoverInFreshProcess(root) {
  const child = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'governance', 'tools', 'recover-governance-transaction.mjs'),
    '--root', root, '--transaction', absolute(root, `${TXN_DIR}/TRANSACTION.json`), '--apply'
  ], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(child.stdout); } catch { /* reported through child below */ }
  return { child, report };
}

const anchorInFreshProcess = (root) => {
  const child = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'governance', 'tools', 'anchor-precontract-consumption.mjs'),
    '--root', root, '--authority', absolute(root, ANCHOR_AUTHORITY), '--recorded-at', RECORDED_AT, '--apply'
  ], { encoding: 'utf8' });
  let report = null;
  try { report = JSON.parse(child.stdout); } catch { /* reported through child below */ }
  return { child, report };
};

/** The publisher really died rather than returning. */
function assertHardCrash({ child, observed }, boundary) {
  assert.ok(observed, `no crash marker was written for ${boundary}: the boundary was never reached`);
  assert.equal(observed.boundary, boundary);
  assert.notEqual(observed.armedAt, 'NEVER_REACHED', `publication completed without hitting ${boundary}: ${JSON.stringify(observed)}`);
  assert.notEqual(child.status, 0, `publisher exited normally (${child.status}) at ${boundary}; SIGKILL never took effect`);
}

/* ------------------------------------------------------------------------ *
 * A / B / C — crash, fresh-process recovery, one legal state
 * ------------------------------------------------------------------------ */

test('A: killed after PREPARED and before COMMITTING, the ledger is untouched and recovery completes the candidate', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  const crash = crashPublisher(root, 'PREPARED_BEFORE_COMMITTING');
  assertHardCrash(crash, 'PREPARED_BEFORE_COMMITTING');
  assert.equal(crash.observed.preparedPresent, true, 'the PREPARED marker was never written');

  // EXACT PRE-STATE, by construction: nothing canonical had moved yet.
  assert.deepEqual(ledgerBytes(root), before);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.child.status, 0, recovery.child.stdout + recovery.child.stderr);
  assert.equal(recovery.report.valid, true);
  assert.equal(recovery.report.recoveryAction, 'ROLL_FORWARD_COMPLETE');
  assert.equal(anchorsOf(root).length, 1);
  assert.doesNotThrow(() => readEvents(root));
});

test('B: killed mid-ledger-write, the canonical ledger is byte-identical and recovery still completes', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  const beforeCount = readEvents(root).length;
  const crash = crashPublisher(root, 'LEDGER_PARTIAL_WRITE');
  assertHardCrash(crash, 'LEDGER_PARTIAL_WRITE');

  // NON-VACUITY: real bytes were forced to stable storage before the kill.
  assert.ok(crash.observed.partialBytes > 0, 'no partial bytes were actually written');
  assert.equal(crash.observed.temporaryPresent, true, 'the partial write did not land in a temp file');
  assert.ok(crash.observed.temporaryByteLength > 0);

  // THE DEFECT, CLOSED: the canonical ledger never held the prefix. Under the
  // original truncate-and-stream write this file was corrupt at this instant and
  // readEvents threw.
  assert.deepEqual(ledgerBytes(root), before, 'a partial event reached the canonical ledger');
  assert.equal(readEvents(root).length, beforeCount);
  assert.doesNotThrow(() => readEvents(root));

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.child.status, 0, recovery.child.stdout + recovery.child.stderr);
  assert.equal(recovery.report.recoveryAction, 'ROLL_FORWARD_COMPLETE');
  assert.equal(anchorsOf(root).length, 1);

  // The half-written bytes are gone, and the transaction is RESOLVED.
  //
  // DECLARED SEMANTIC CHANGE (D-03 residue-0 requirement). This test previously
  // asserted that recovery left its journal on disk as COMMITTED-with-its-marker,
  // and that a LATER sweep discarded it. That was the standalone recovery tool's
  // behaviour and it was the only publication path with it: `applyCandidate`
  // discards its own transaction the moment it commits, and
  // `recoverPendingLifecycleTransactions` discards after recovering. So a
  // completed recovery through the tool an operator actually runs still left a
  // directory behind for the next reader to interpret, and the "residue 0" the
  // transaction model claims was never true through that entry point.
  //
  // The tool now discards a resolved transaction itself. The property asserted
  // here is therefore strictly STRONGER than the one it replaces — not "terminal,
  // and safely re-swept by somebody later" but "resolved, with nothing left to
  // interpret or re-apply". Every other guarantee of this test is unchanged.
  assert.deepEqual(publicationResidue(root), [], 'the interrupted temp file survived a completed recovery');
  assert.equal(fs.existsSync(absolute(root, `${TXN_DIR}/TRANSACTION.json`)), false, 'a resolved journal survived its own recovery');
  assert.deepEqual(residue(root), [], 'a completed recovery left residue behind');

  // And a subsequent pass through the publisher still refuses to re-anchor.
  assert.equal(anchorInFreshProcess(root).report.verdict, 'BLOCKED');
  assert.deepEqual(residue(root), [], 'a later pass reintroduced residue');
});

test('C: killed after the full ledger write and before COMMITTED, recovery rolls forward exactly once', () => {
  const root = sandbox();
  const beforeCount = readEvents(root).length;
  const crash = crashPublisher(root, 'LEDGER_WRITTEN_BEFORE_COMMITTED');
  assertHardCrash(crash, 'LEDGER_WRITTEN_BEFORE_COMMITTED');
  assert.equal(crash.observed.committedPresent, false, 'the COMMITTED marker existed before the kill');
  assert.equal(crash.observed.journalState, 'COMMITTING');

  // The candidate is already on disk; the transaction has not been closed.
  assert.equal(readEvents(root).length, beforeCount + 1);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.child.status, 0, recovery.child.stdout + recovery.child.stderr);
  assert.equal(recovery.report.valid, true);
  assert.equal(recovery.report.recoveryAction, 'ROLL_FORWARD_COMPLETE');
  assert.equal(readEvents(root).length, beforeCount + 1, 'roll-forward duplicated the event');
  assert.equal(anchorsOf(root).length, 1);
});

test('A2: killed after COMMITTING and before any ledger byte, recovery reaches the same committed state', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  const crash = crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE');
  assertHardCrash(crash, 'COMMITTING_BEFORE_LEDGER_WRITE');
  assert.equal(crash.observed.journalState, 'COMMITTING');
  assert.deepEqual(ledgerBytes(root), before, 'the ledger moved before its write boundary');

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.recoveryAction, 'ROLL_FORWARD_COMPLETE');
  assert.equal(anchorsOf(root).length, 1);
});

test('M: killed between the COMMITTED marker and cleanup, a later recovery pass discards the residue', () => {
  const root = sandbox();
  const crash = crashPublisher(root, 'COMMITTED_BEFORE_DISCARD');
  assertHardCrash(crash, 'COMMITTED_BEFORE_DISCARD');
  assert.equal(anchorsOf(root).length, 1, 'the event was not published before the marker');
  assert.ok(fs.existsSync(absolute(root, TXN_DIR)), 'nothing was left behind to sweep');

  // A committed-but-unswept journal used to survive every later pass: recovery
  // short-circuits on COMMITTED and the sweep stepped over it.
  const retry = anchorInFreshProcess(root);
  assert.equal(retry.report.verdict, 'BLOCKED');
  assert.deepEqual(retry.report.findings.map((item) => item.code), ['ANCHOR_ALREADY_PRESENT']);
  assert.deepEqual(residue(root), [], 'a terminal transaction directory survived');
  assert.equal(anchorsOf(root).length, 1);
});

/* ------------------------------------------------------------------------ *
 * D / E — retry and idempotence across the crash
 * ------------------------------------------------------------------------ */

test('D: a fresh anchor attempt after a crash recovers the pending transaction and yields exactly one anchor', () => {
  const root = sandbox();
  const beforeCount = readEvents(root).length;
  assertHardCrash(crashPublisher(root, 'LEDGER_PARTIAL_WRITE'), 'LEDGER_PARTIAL_WRITE');

  const retry = anchorInFreshProcess(root);
  assert.ok(['ANCHORED', 'BLOCKED'].includes(retry.report.verdict), JSON.stringify(retry.report));
  assert.equal(readEvents(root).length, beforeCount + 1, 'the retry did not settle on exactly one appended event');
  assert.equal(anchorsOf(root).length, 1);
  assert.deepEqual(residue(root), []);

  // And it is now genuinely spent.
  const replay = anchorInFreshProcess(root);
  assert.equal(replay.report.verdict, 'BLOCKED');
  assert.deepEqual(replay.report.findings.map((item) => item.code), ['ANCHOR_ALREADY_PRESENT']);
});

test('E: retrying once the anchor is committed is BLOCKED and moves nothing', () => {
  const root = sandbox();
  const first = anchorInFreshProcess(root);
  assert.equal(first.report.verdict, 'ANCHORED');
  const after = ledgerBytes(root);

  const replay = anchorInFreshProcess(root);
  assert.equal(replay.report.verdict, 'BLOCKED');
  assert.deepEqual(replay.report.findings.map((item) => item.code), ['ANCHOR_ALREADY_PRESENT']);
  assert.deepEqual(ledgerBytes(root), after);
});

/* ------------------------------------------------------------------------ *
 * F / G — provenance is mandatory, and forged provenance is refused
 * ------------------------------------------------------------------------ */

test('G: a publication whose journal would not recover is refused before a byte moves', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  // Break the binding the provenance validator re-proves: the receipt digest the
  // anchor authority names. The tool's own BINDING phase catches this first,
  // which is itself the point — the refusal happens with nothing written.
  const authority = readJson(root, ANCHOR_AUTHORITY);
  authority.consumptionRecordSha256 = 'a'.repeat(64);
  writeJson(root, ANCHOR_AUTHORITY, authority);

  const attempt = anchorInFreshProcess(root);
  assert.equal(attempt.report.verdict, 'BLOCKED');
  assert.deepEqual(ledgerBytes(root), before);
  assert.deepEqual(residue(root), []);
});

test('G2: a pending transaction carrying no provenance is refused, never rolled forward', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.ok(journal.provenance, 'the repaired publisher wrote a journal without provenance');
  journal.provenance = null;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.equal(recovery.report.recoveryAction, 'PENDING_TRANSACTION_PROVENANCE_INVALID');
  assert.deepEqual(ledgerBytes(root), before, 'a provenance-less journal was rolled forward anyway');
});

test('F: provenance naming an authority it was not published under is refused', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.provenance.authority.authorityId = 'SOME_OTHER_AUTHORITY_R1';
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.equal(recovery.report.recoveryAction, 'PENDING_TRANSACTION_PROVENANCE_INVALID');
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_AUTHORITY_BINDING_MISMATCH'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before);
});

test('F2: provenance claiming an unknown binding class is refused rather than defaulted', () => {
  const root = sandbox();
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');
  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  delete journal.provenance.authorityBinding;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.recoveryAction, 'PENDING_TRANSACTION_PROVENANCE_INVALID');
  assert.ok(recovery.report.findings.some((item) => item.detail === 'AUTHORITY_BINDING_UNKNOWN'), JSON.stringify(recovery.report.findings));
});

/* ------------------------------------------------------------------------ *
 * H / I / J / K — tamper, in every direction recovery could be pushed
 * ------------------------------------------------------------------------ */

test('H: a tampered staged artifact is never trusted for roll-forward', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journal = JSON.parse(fs.readFileSync(absolute(root, `${TXN_DIR}/TRANSACTION.json`), 'utf8'));
  const staged = absolute(root, journal.stagedArtifacts[0].sourcePath);
  const tampered = Buffer.concat([fs.readFileSync(staged), Buffer.from('{"eventId":"SMUGGLED"}\n', 'utf8')]);
  fs.writeFileSync(staged, tampered);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_STAGED_ARTIFACT_ALTERED'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before, 'tampered staged bytes reached the canonical ledger');
});

test('I: an authority swapped under a pending transaction is refused', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const authority = readJson(root, ANCHOR_AUTHORITY);
  authority.gateId = 'GATE19';
  writeJson(root, ANCHOR_AUTHORITY, authority);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_AUTHORITY_SHA_MISMATCH'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before);
});

test('I2: a receipt rewritten after the transaction was prepared is refused', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const receipt = readJson(root, RECEIPT);
  receipt.recordedAt = '2030-01-01T00:00:00.000Z';
  writeJson(root, RECEIPT, receipt);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_ANCHOR_RECEIPT_BYTES_MISMATCH'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before);
});

test('J: provenance whose pre-state receipt disagrees with itself is refused', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.provenance.preState.ledgerEventCount += 5;
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_PRESTATE_RECEIPT_MISMATCH'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before);
});

test('J2: a ledger truncated behind the transaction is failed closed, never rolled forward', () => {
  const root = sandbox();
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  // Untrusted canonical bytes: neither the pre-state nor the candidate.
  const truncated = ledgerBytes(root).subarray(0, 20000);
  fs.writeFileSync(absolute(root, LEDGER), truncated);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_CANONICAL_BYTES_UNEXPECTED'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), truncated, 'recovery wrote over bytes it had refused to judge');
});

test('K: a journal that will not parse BLOCKS instead of crashing recovery', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  fs.writeFileSync(journalPath, fs.readFileSync(journalPath, 'utf8').slice(0, 400));

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.child.status, 2, `recovery crashed instead of blocking: ${recovery.child.stderr}`);
  assert.equal(recovery.report.recoveryAction, 'TRANSACTION_JOURNAL_UNPARSEABLE');
  assert.deepEqual(ledgerBytes(root), before);
});

test('K2: a journal whose commit order was widened is refused', () => {
  const root = sandbox();
  const before = ledgerBytes(root);
  assertHardCrash(crashPublisher(root, 'COMMITTING_BEFORE_LEDGER_WRITE'), 'COMMITTING_BEFORE_LEDGER_WRITE');

  const journalPath = absolute(root, `${TXN_DIR}/TRANSACTION.json`);
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.commitOrder = [...journal.commitOrder, 'governance/active/ACTIVE_GATE.json'];
  fs.writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.valid, false);
  assert.ok(recovery.report.findings.some((item) => item.code === 'PENDING_TRANSACTION_COMMIT_ORDER_MISMATCH'), JSON.stringify(recovery.report.findings));
  assert.deepEqual(ledgerBytes(root), before);
});

/* ------------------------------------------------------------------------ *
 * L / N / O / P — what a recovered anchor must leave exactly as it found
 * ------------------------------------------------------------------------ */

test('L/N/O/P: after crash recovery the history, the anchor and both Gates are exactly as expected', () => {
  const root = sandbox();
  const preceding = readEvents(root);
  assertHardCrash(crashPublisher(root, 'LEDGER_PARTIAL_WRITE'), 'LEDGER_PARTIAL_WRITE');
  const recovery = recoverInFreshProcess(root);
  assert.equal(recovery.report.recoveryAction, 'ROLL_FORWARD_COMPLETE');

  const events = readEvents(root);

  // N: every event preceding the anchor is byte-identical.
  assert.deepEqual(events.slice(0, preceding.length), preceding);
  // L: exactly one anchor, and it is the ledger head, so a later append still
  // leaves the recovered anchor verifiable where it stands.
  const anchors = events.filter((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].ordinal, events.length);
  assert.equal(anchors[0].fromStatus, anchors[0].toStatus, 'the anchor is not a self-transition');
  assert.equal(anchors[0].previousEventSha256, preceding.at(-1).eventPayloadSha256);

  // O/P.
  const status = new Map();
  for (const event of events) status.set(event.gateId, event.toStatus);
  assert.equal(status.get('GATE20'), 'COMPLETE_AGENT');
  assert.equal(status.get('GATE21') ?? 'NOT_STARTED', 'NOT_STARTED');
});

test('L: a recovered anchor still verifies once the ledger has moved on beyond it', () => {
  const root = sandbox();
  assertHardCrash(crashPublisher(root, 'LEDGER_PARTIAL_WRITE'), 'LEDGER_PARTIAL_WRITE');
  assert.equal(recoverInFreshProcess(root).report.recoveryAction, 'ROLL_FORWARD_COMPLETE');

  const events = readEvents(root);
  const anchor = events.at(-1);
  const anchorSha = sha256Bytes(Buffer.from(JSON.stringify(anchor), 'utf8'));

  // A later, unrelated append must not disturb what the anchor states.
  writeEvents(root, [...events, { ...anchor, eventId: 'SYNTHETIC_LATER_EVENT', ordinal: events.length + 1, previousEventSha256: anchor.eventPayloadSha256 }]);
  const reread = readEvents(root)[events.length - 1];
  assert.equal(sha256Bytes(Buffer.from(JSON.stringify(reread), 'utf8')), anchorSha);
  assert.equal(reread.precontractConsumption.sha256, readJson(root, ANCHOR_AUTHORITY).consumptionRecordSha256);
});
