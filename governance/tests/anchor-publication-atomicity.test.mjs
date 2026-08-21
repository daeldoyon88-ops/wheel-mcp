/**
 * LEDGER PUBLICATION ATOMICITY, AND THE COHERENCE HALF OF CONSUMPTION.
 *
 * TWO DEFECTS THIS PINS.
 *
 * 1. R6 — PUBLICATION WAS NOT ATOMIC. anchor-precontract-consumption.mjs ended in
 *    a bare `fs.appendFileSync`. Every earlier hostile against it corrupted the
 *    authority, so the tool blocked during BINDING and never reached a write:
 *    those runs proved "invalid authority -> no write" and nothing whatsoever
 *    about what a FAILING WRITE would leave behind. The answer was: a truncated
 *    JSON line in an append-only ledger. Because every reader parses every line,
 *    the damage was not confined to the failed call — the next read threw, so even
 *    the retry that would have repaired it could not run.
 *
 *    The hostile here therefore lets every validation pass and fails the WRITE
 *    ITSELF, after a real prefix has already landed on disk. It asserts it
 *    actually reached that boundary, because a hostile that silently stops short
 *    is the thing being guarded against.
 *
 * 2. G/H — THE COHORT ADMITTED WHAT THE CONSUMPTION VALIDATOR REJECTED.
 *    deriveCanonicalAuthorizedCohort re-checked five header fields of a
 *    consumption record by hand and never looked at its per-path cohort at all.
 *    So a record whose entries contradicted its own digest-pinned manifest was
 *    admitted, its paths entered the authorized cohort, and FINAL_GATE_INTEGRITY
 *    returned PASS over a program whose canonical validator returned BLOCKED.
 *
 *    The repair delegates to the canonical validator's COHERENCE half. Coherence
 *    is the half that can never legitimately drift; OCCUPANCY — the certified
 *    bytes still being the bytes on disk — is EXPECTED to drift once a later
 *    authorized program rewrites a path. Both directions are asserted, because a
 *    rule that refused drifted history would be just as wrong as one that admitted
 *    incoherence, and only checking one direction would hide that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { anchorPrecontractConsumption } from '../tools/anchor-precontract-consumption.mjs';
import { auditFinalGateIntegrity } from '../tools/final-gate-integrity-auditor.mjs';
import { deriveCanonicalAuthorizedCohort } from '../gee-v1/core/canonical-authorized-cohort.mjs';
import { validateConsumptionRecordCoherence } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { sha256Bytes } from '../tools/canonical-json.mjs';
import { PUBLISH_TEMP_SUFFIX } from '../tools/durable-write.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const TRANSACTIONS = 'governance/transactions';
const GATE = 'GATE20';
const ANCHOR_AUTHORITY = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;
const ANCHOR_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
const RECORDED_AT = '2026-08-16T23:30:00.000Z';

const MAINTENANCE_AUTHORITY = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_PRECONTRACT_ANCHOR_ENFORCEMENT_R1.json';

const absolute = (root, relative) => path.resolve(root, ...relative.split('/'));
const readJson = (root, relative) => JSON.parse(fs.readFileSync(absolute(root, relative), 'utf8').replace(/^﻿/, ''));
const writeJson = (root, relative, value) => fs.writeFileSync(absolute(root, relative), `${JSON.stringify(value, null, 2)}\n`);
const ledgerBytes = (root) => fs.readFileSync(absolute(root, LEDGER));
const readEvents = (root) => ledgerBytes(root).toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const writeEvents = (root, events) => fs.writeFileSync(absolute(root, LEDGER), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);

/**
 * A disposable CLONE, not a directory copy: consumption receipts pin the commit
 * they were produced at and resolve it through Git, so a historyless copy answers
 * HISTORICAL_BASE_COMMIT_UNKNOWN everywhere and would let a tamper test pass
 * without the tamper doing anything.
 */
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'anchor-atomicity-'));
const CLONE = path.join(SCRATCH, 'repo');
const PRISTINE = path.join(SCRATCH, 'pristine-governance');
{
  const clone = spawnSync('git', ['-c', 'core.longpaths=true', 'clone', '--local', '--quiet', REPO_ROOT, CLONE], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stdout + clone.stderr);
  spawnSync('git', ['config', 'core.longpaths', 'true'], { cwd: CLONE, encoding: 'utf8' });
  fs.rmSync(path.join(CLONE, 'governance'), { recursive: true, force: true });
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(CLONE, 'governance'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'governance'), PRISTINE, { recursive: true });
}
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });

/** The clone at production bytes; `withoutAnchor` rewinds exactly one fact. */
function fixture({ withoutAnchor = false } = {}) {
  fs.rmSync(path.join(CLONE, 'governance'), { recursive: true, force: true });
  fs.cpSync(PRISTINE, path.join(CLONE, 'governance'), { recursive: true });
  // Scoped to THIS Gate: GATE19 carries an anchor of its own, and rewinding that
  // one too would change a second fact the test never meant to touch.
  if (withoutAnchor) {
    writeEvents(CLONE, readEvents(CLONE).filter((e) => !(e.gateId === GATE && e.transitionType === ANCHOR_TYPE)));
  }
  return CLONE;
}

/** Anything a failed publication might have left lying around. */
function residue(root) {
  const stray = [];
  const stateDir = absolute(root, 'governance/state');
  for (const name of fs.readdirSync(stateDir)) {
    if (/__publish__|\.tmp$|\.temp$|\.journal$|\.bak$/.test(name)) stray.push(`governance/state/${name}`);
  }
  const txn = absolute(root, TRANSACTIONS);
  if (fs.existsSync(txn)) for (const name of fs.readdirSync(txn)) stray.push(`${TRANSACTIONS}/${name}`);
  return stray;
}

function projectionDigests(root) {
  const out = {};
  for (const rel of ['governance/state/generated/GATE_STATUS_SNAPSHOT.json', 'governance/generated/ACTIVE_GATE_CONTEXT.json']) {
    const file = absolute(root, rel);
    out[rel] = fs.existsSync(file) ? sha256Bytes(fs.readFileSync(file)) : null;
  }
  return out;
}

/**
 * Run `body` with the ledger's write boundary failing ONCE, after a genuine
 * prefix has landed.
 *
 * WHERE THE BOUNDARY MOVED, AND WHY THIS STILL TESTS THE SAME THING. Publication
 * no longer truncates the canonical ledger and streams into it; it fills a temp
 * file beside it and renames. So the write that can fail part-way is the temp
 * fill, and that is where the failure is injected — after a real prefix has been
 * forced to stable storage, exactly as before. What the assertions below claim is
 * unchanged: a publication that fails mid-write leaves the canonical ledger
 * byte-identical, parseable and retryable. It is now true for a stronger reason —
 * the canonical file was never opened — and the companion battery in
 * anchor-hard-crash-recovery.test.mjs proves that reason holds under a real
 * process kill, which no caught exception can demonstrate.
 *
 * The prefix is written with raw fd calls captured before patching, because going
 * through any fs.* wrapper would re-enter the patch and abort before a single
 * byte reached the disk — which would make this hostile quietly vacuous.
 */
function withFailingLedgerWrite(root, body) {
  const ledger = absolute(root, LEDGER);
  const temporary = `${ledger}${PUBLISH_TEMP_SUFFIX}`;
  const rawOpen = fs.openSync, rawWrite = fs.writeSync, rawFsync = fs.fsyncSync;
  const state = { reached: false, partialBytes: 0 };
  let armed = true;
  let temporaryFd = null;

  fs.openSync = (file, ...rest) => {
    const handle = rawOpen(file, ...rest);
    try { if (path.resolve(String(file)) === temporary) temporaryFd = handle; } catch { /* not a path we track */ }
    return handle;
  };
  fs.writeSync = (fd, buffer, ...rest) => {
    if (!armed || fd !== temporaryFd || !Buffer.isBuffer(buffer) || buffer.length < 2) return rawWrite(fd, buffer, ...rest);
    armed = false;
    state.reached = true;
    const prefix = buffer.subarray(0, Math.floor(buffer.length / 2));
    state.partialBytes = prefix.length;
    rawWrite(fd, prefix, 0, prefix.length, 0);
    rawFsync(fd);
    const error = new Error('EIO: i/o error, write');
    error.code = 'EIO';
    throw error;
  };

  try { state.result = body(); } catch (error) { state.threw = error; } finally {
    fs.openSync = rawOpen;
    fs.writeSync = rawWrite;
  }
  return state;
}

const anchor = (root) => anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: RECORDED_AT, apply: true });

/* ------------------------------------------------------------------------ *
 * R6 — a failing publication leaves the ledger byte-identical
 * ------------------------------------------------------------------------ */

test('R6: a forced I/O failure at ledger publication rolls back byte-exactly', () => {
  const root = fixture({ withoutAnchor: true });
  const before = ledgerBytes(root);
  const beforeSha = sha256Bytes(before);
  const beforeCount = readEvents(root).length;
  const beforeProjections = projectionDigests(root);

  const run = withFailingLedgerWrite(root, () => anchor(root));

  // NON-VACUITY. Without this the whole test could pass by never writing at all,
  // which is exactly how the previous hostile fooled its own author.
  assert.equal(run.reached, true, 'hostile never reached the publication write path');
  assert.ok(run.partialBytes > 0, 'no partial bytes were actually forced onto disk');

  assert.notEqual(run.result?.verdict, 'ANCHORED');
  assert.equal(run.result?.verdict, 'BLOCKED', `expected BLOCKED, got ${run.result?.verdict ?? `throw ${run.threw?.message}`}`);
  assert.equal(run.result.phase, 'PUBLICATION');
  assert.ok(run.result.findings.some((f) => f.code === 'ANCHOR_PUBLICATION_FAILED_ROLLED_BACK'), JSON.stringify(run.result.findings));
  assert.equal(run.result.rolledBack, true);

  assert.deepEqual(ledgerBytes(root), before, 'ledger bytes are not byte-identical to the pre-state');
  assert.equal(sha256Bytes(ledgerBytes(root)), beforeSha);
  assert.equal(readEvents(root).length, beforeCount, 'a partial event survived');
  assert.deepEqual(residue(root), [], 'stale temp or journal residue remained');
  assert.deepEqual(projectionDigests(root), beforeProjections, 'projections moved');
});

test('R6: the ledger still parses after a failed publication, so a retry can run', () => {
  const root = fixture({ withoutAnchor: true });
  const run = withFailingLedgerWrite(root, () => anchor(root));
  assert.equal(run.reached, true);
  // The original defect made this throw: a truncated final line broke every read.
  assert.doesNotThrow(() => readEvents(root));
});

test('R6: retry after a failed publication succeeds exactly once', () => {
  const root = fixture({ withoutAnchor: true });
  const beforeCount = readEvents(root).length;
  const run = withFailingLedgerWrite(root, () => anchor(root));
  assert.equal(run.reached, true);

  const retry = anchor(root);
  assert.equal(retry.verdict, 'ANCHORED');
  assert.equal(readEvents(root).length, beforeCount + 1, 'retry did not append exactly one event');
  assert.equal(readEvents(root).filter((e) => e.gateId === GATE && e.transitionType === ANCHOR_TYPE).length, 1);
  assert.deepEqual(residue(root), []);
});

test('R6: replay after a successful publication is blocked and writes nothing', () => {
  const root = fixture({ withoutAnchor: true });
  assert.equal(anchor(root).verdict, 'ANCHORED');
  const after = ledgerBytes(root);

  const replay = anchor(root);
  assert.equal(replay.verdict, 'BLOCKED');
  assert.deepEqual(replay.findings.map((f) => f.code), ['ANCHOR_ALREADY_PRESENT']);
  assert.deepEqual(ledgerBytes(root), after, 'a blocked replay still moved the ledger');
});

test('R6: a cleanly rolled back transaction is discarded, not left to be rolled forward', () => {
  const root = fixture({ withoutAnchor: true });
  const run = withFailingLedgerWrite(root, () => anchor(root));
  assert.equal(run.reached, true);
  // recoverTransaction short-circuits only on COMMITTED, so a surviving ABORTED
  // journal would be eligible for ROLL_FORWARD_FROM_STAGED_ARTIFACTS and would
  // re-append the event that was just undone.
  assert.equal(fs.existsSync(absolute(root, TRANSACTIONS)), false, 'an aborted transaction journal survived');
});

/* ------------------------------------------------------------------------ *
 * G/H — the cohort and FGI cannot admit what the consumption validator rejects
 * ------------------------------------------------------------------------ */

/** Break the record's agreement with its own manifest, changing nothing else. */
function makeConsumptionIncoherent(root) {
  const authority = readJson(root, MAINTENANCE_AUTHORITY);
  const record = readJson(root, authority.consumptionRecordPath);
  record.cohort[0].reason = `${record.cohort[0].reason} (reworded after the fact)`;
  writeJson(root, authority.consumptionRecordPath, record);
  return { authority, recordPath: authority.consumptionRecordPath };
}

test('G: the canonical cohort admits this maintenance program while it is coherent', () => {
  const root = fixture();
  const cohort = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const source = cohort.sources.find((s) => s.sourcePath === MAINTENANCE_AUTHORITY);
  // Non-vacuity for the refusal test below: the program must really be admitted
  // here, or "refused after tampering" would prove nothing.
  assert.ok(source, 'the maintenance program was not even considered');
  assert.equal(source.admitted, true, `expected admitted, refused for ${source.refusedReason}`);
  assert.ok(source.pathCount > 0);
});

test('G: the canonical cohort REFUSES a program whose consumption contradicts its manifest', () => {
  const root = fixture();
  makeConsumptionIncoherent(root);

  const cohort = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const source = cohort.sources.find((s) => s.sourcePath === MAINTENANCE_AUTHORITY);
  assert.equal(source.admitted, false, 'an incoherent consumption was admitted to the cohort');
  assert.match(source.refusedReason, /^CONSUMPTION_INCOHERENT:CONSUMPTION_COHORT_METADATA_MISMATCH$/);
  assert.equal(cohort.valid, false);
  assert.ok(cohort.findings.some((f) => f.code === 'AUTHORITY_SOURCE_REFUSED'));
});

test('H: FINAL_GATE_INTEGRITY cannot PASS while a maintenance consumption is incoherent', () => {
  const root = fixture();

  // The implication is only meaningful if the antecedent really holds first.
  const clean = auditFinalGateIntegrity({ root, gateId: GATE });
  assert.equal(clean.FINAL_GATE_INTEGRITY, 'PASS', `expected a PASS to contradict, got ${JSON.stringify(clean.findings)}`);

  makeConsumptionIncoherent(root);
  const tampered = auditFinalGateIntegrity({ root, gateId: GATE });
  assert.notEqual(tampered.FINAL_GATE_INTEGRITY, 'PASS', 'FGI passed over an incoherent maintenance consumption');
});

test('G: coherence is judged against the manifest, not against the bytes on disk', () => {
  const root = fixture();
  const authority = readJson(root, MAINTENANCE_AUTHORITY);
  const manifest = readJson(root, authority.authorizedPathManifestPath);
  const record = readJson(root, authority.consumptionRecordPath);

  // OCCUPANCY drift — a later authorized program lawfully rewrote a certified
  // path — must NOT be read as incoherence, or the cohort would refuse the Gate's
  // own completed history.
  const drifted = structuredClone(record);
  drifted.cohort[0].sha256 = 'f'.repeat(64);
  const driftFindings = [];
  validateConsumptionRecordCoherence(drifted, authority, manifest, driftFindings);
  assert.deepEqual(driftFindings, [], 'occupancy drift was misreported as incoherence');

  // COHERENCE breakage is refused.
  const incoherent = structuredClone(record);
  incoherent.cohort[0].reason = 'something the manifest never said';
  const coherenceFindings = [];
  validateConsumptionRecordCoherence(incoherent, authority, manifest, coherenceFindings);
  assert.ok(coherenceFindings.some((f) => f.code === 'CONSUMPTION_COHORT_METADATA_MISMATCH'));
});

/* ------------------------------------------------------------------------ *
 * L/M/N — the surrounding state this repair must not disturb
 * ------------------------------------------------------------------------ */

test('L/M/N: prior events, GATE20 and GATE21 are exactly where they were', () => {
  const root = fixture();
  const events = readEvents(root);

  // L: every event before the anchor is untouched, and the anchor is one append.
  const anchors = events.filter((e) => e.gateId === GATE && e.transitionType === ANCHOR_TYPE);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].ordinal, events.length);
  assert.equal(anchors[0].fromStatus, anchors[0].toStatus, 'the anchor is not a self-transition');

  const withoutAnchor = readEvents(fixture({ withoutAnchor: true }));
  assert.deepEqual(withoutAnchor, events.slice(0, events.length - 1));

  // M/N.
  const status = new Map();
  for (const event of events) status.set(event.gateId, event.toStatus);
  assert.equal(status.get('GATE20'), 'COMPLETE_AGENT');
  assert.equal(status.get('GATE21') ?? 'NOT_STARTED', 'NOT_STARTED');
});
