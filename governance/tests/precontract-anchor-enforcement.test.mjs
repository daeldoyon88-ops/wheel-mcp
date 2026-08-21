/**
 * ENFORCEMENT OF THE PRECONTRACT CONSUMPTION ANCHOR.
 *
 * THE DEFECT THIS PINS. `anchor-precontract-consumption.mjs` existed, worked, and
 * had no caller. Anchoring was therefore something an agent had to REMEMBER
 * between a bootstrap and the Gate's first lifecycle event. GATE19 was anchored;
 * GATE20 was not, and reached COMPLETE_AGENT carrying a receipt that had quietly
 * stopped verifying — the pre-state it was proven against had scrolled away.
 *
 * Worse than the miss was what the audit said about it:
 *
 *   FINAL_GATE_INTEGRITY   PASS
 *   VERIFY_CONSUMPTION     BLOCKED / CONSUMPTION_RECEIPT_NOT_ANCHORED
 *
 * Two canonical consumers, one repository, opposite answers. The final audit was
 * not being lenient — it was reporting the wrong result, because it never asked.
 *
 * WHAT IS PROVEN HERE. The battery below is deliberately split in two, because
 * the defect had two halves and fixing only one leaves the hole open:
 *
 *   DECISION  (A-R) — the anchor binds Gate, authority, receipt path and receipt
 *                     bytes exactly, survives future ledger appends, descendant
 *                     HEADs and a future clock, and refuses replay. A forger who
 *                     repairs every self-digest within reach still fails.
 *   WIRING          — FGI and the Fast Gate both BLOCK on the same fact, and the
 *                     implication `FGI PASS => VERIFY_CONSUMPTION not BLOCKED`
 *                     is asserted directly on a real audit of real bytes.
 *
 * Fixtures are disposable trees OUTSIDE the repository. Nothing here writes to
 * the governed tree, so a failing assertion cannot leave residue behind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { anchorPrecontractConsumption } from '../tools/anchor-precontract-consumption.mjs';
import { auditFinalGateIntegrity } from '../tools/final-gate-integrity-auditor.mjs';
import {
  evaluatePrecontractAnchorEnforcement,
  ANCHOR_ENFORCEMENT_BLOCKING_CODE
} from '../tools/precontract-anchor-enforcement.mjs';
import { sha256Canonical } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = 'GATE20';
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const ANCHOR_AUTHORITY = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;
const PRECONTRACT_AUTHORITY = `governance/authority/precontract/${GATE}/PROJECT_OWNER_LOCAL_PRECONTRACT_AUTHORITY.json`;
const RECEIPT = `governance/gates/${GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
const ANCHOR_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
const LATER = '2026-08-17T04:00:00.000Z';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const absolute = (root, relative) => path.join(root, ...relative.split('/'));
const readJson = (root, relative) => JSON.parse(fs.readFileSync(absolute(root, relative), 'utf8'));
const writeJson = (root, relative, value) => {
  const target = absolute(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const readEvents = (root) => fs.readFileSync(absolute(root, LEDGER), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const writeEvents = (root, events) => fs.writeFileSync(
  absolute(root, LEDGER), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
);
const codes = (result) => (result.findings ?? []).map((item) => item.code);

/** The event payload digest, computed exactly as the ledger validator recomputes it. */
function payloadDigest(event) {
  const { eventPayloadSha256, ...payload } = event;
  return sha256Canonical(payload);
}

/** VERIFY_CONSUMPTION through the canonical consumer, against real bytes on disk. */
function verifyConsumption(root, { gateId = GATE, when = undefined } = {}) {
  return createWheelPrecontractAuthoritySource(root, {
    authorityPath: absolute(root, PRECONTRACT_AUTHORITY), ...(when ? { now: when } : {})
  }).verifyPrecontractConsumption(gateId);
}

/**
 * ONE disposable clone of the repository, outside it, reused by every test.
 *
 * WHY A CLONE AND NOT A DIRECTORY COPY. A consumption receipt pins the commit it
 * was produced at, and VERIFY_CONSUMPTION resolves that commit through Git. A
 * bare `cp -r governance` has no history, so EVERY verdict in it comes back
 * carrying HISTORICAL_BASE_COMMIT_UNKNOWN — and a tamper test that expected
 * "blocked" would then pass without the tamper doing anything at all. Cloning
 * carries the real history across, so the only variable a test changes is the one
 * it means to change. `--local` hardlinks the object store, so this is cheap.
 *
 * The clone is made once; each test restores `governance/` from a pristine
 * snapshot before mutating, which is why mutations never leak between tests.
 */
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'anchor-enforcement-'));
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

/**
 * The clone, restored to production bytes.
 *
 * `withoutAnchor` rewinds exactly one fact — the anchor event — which reproduces
 * the pre-repair world without inventing it: every other byte is production.
 */
function disposable(t, { withoutAnchor = false } = {}) {
  fs.rmSync(path.join(CLONE, 'governance'), { recursive: true, force: true });
  fs.cpSync(PRISTINE, path.join(CLONE, 'governance'), { recursive: true });
  if (withoutAnchor) {
    writeEvents(CLONE, readEvents(CLONE).filter((event) => !(event.gateId === GATE && event.transitionType === ANCHOR_TYPE)));
  }
  return CLONE;
}

// ---------------------------------------------------------------------------
// DECISION — A through R
// ---------------------------------------------------------------------------

test('A the pre-repair world is reproduced: a consumed receipt with no anchor is BLOCKED', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const consumption = verifyConsumption(root);
  assert.ok(codes(consumption).includes('CONSUMPTION_RECEIPT_NOT_ANCHORED'), codes(consumption).join(','));

  const enforcement = evaluatePrecontractAnchorEnforcement({ root, gateId: GATE });
  assert.equal(enforcement.applicable, true);
  assert.equal(enforcement.verdict, 'BLOCKED');
  assert.equal(enforcement.lifecycleProgressionAuthorized, false);
  assert.equal(enforcement.findings[0].code, ANCHOR_ENFORCEMENT_BLOCKING_CODE);
});

test('B the exact anchor makes the same receipt verify, on the repository\'s own bytes', () => {
  const consumption = verifyConsumption(REPO_ROOT);
  assert.deepEqual(codes(consumption), []);
  assert.equal(consumption.consumed, true);

  const enforcement = evaluatePrecontractAnchorEnforcement({ root: REPO_ROOT, gateId: GATE });
  assert.equal(enforcement.verdict, 'ANCHORED');
  assert.equal(enforcement.anchored, true);
  assert.deepEqual(enforcement.findings, []);
});

test('C an unanchored consumption blocks lifecycle progression rather than warning about it', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const enforcement = evaluatePrecontractAnchorEnforcement({ root, gateId: GATE });
  assert.equal(enforcement.lifecycleProgressionAuthorized, false);
  assert.ok(enforcement.remediation.includes('anchor-precontract-consumption.mjs'));
});

test('D an anchor authority naming the wrong receipt digest is refused', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  writeJson(root, ANCHOR_AUTHORITY, { ...readJson(root, ANCHOR_AUTHORITY), consumptionRecordSha256: 'f'.repeat(64) });
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes(result).includes('ANCHOR_RECEIPT_DIGEST_MISMATCH'), codes(result).join(','));
});

test('E a receipt edited and re-sealed no longer matches the anchored bytes', (t) => {
  const root = disposable(t);
  const receipt = readJson(root, RECEIPT);
  // The strongest forger available: change the receipt, then repair the digest
  // the receipt itself carries. The anchor pinned BYTES, so self-repair cannot help.
  const forged = { ...receipt, recordedAt: '2026-01-01T00:00:00.000Z' };
  forged.consumptionIdentityDigest = sha256Canonical({ ...forged, consumptionIdentityDigest: undefined });
  writeJson(root, RECEIPT, forged);
  const consumption = verifyConsumption(root);
  assert.notDeepEqual(codes(consumption), []);
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, false);
});

test('F an anchor event edited and re-chained is still refused: the authority is external to it', (t) => {
  const root = disposable(t);
  const events = readEvents(root);
  const index = events.findIndex((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE);
  const forged = { ...events[index], precontractConsumption: { ...events[index].precontractConsumption, sha256: 'a'.repeat(64) } };
  forged.eventPayloadSha256 = payloadDigest(forged);
  events[index] = forged;
  writeEvents(root, events);
  const consumption = verifyConsumption(root);
  assert.notDeepEqual(codes(consumption), []);
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, false);
});

test('G an anchor event citing a different authority path is refused', (t) => {
  const root = disposable(t);
  const events = readEvents(root);
  const index = events.findIndex((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE);
  const forged = { ...events[index], authorityPath: PRECONTRACT_AUTHORITY };
  forged.eventPayloadSha256 = payloadDigest(forged);
  events[index] = forged;
  writeEvents(root, events);
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, false);
});

test('H an anchor event pinning the wrong authority digest is refused', (t) => {
  const root = disposable(t);
  const events = readEvents(root);
  const index = events.findIndex((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE);
  const forged = { ...events[index], authoritySha256: 'b'.repeat(64) };
  forged.eventPayloadSha256 = payloadDigest(forged);
  events[index] = forged;
  writeEvents(root, events);
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, false);
});

test('I an anchor authority bound to another Gate cannot anchor this one', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  writeJson(root, ANCHOR_AUTHORITY, { ...readJson(root, ANCHOR_AUTHORITY), gateId: 'GATE21' });
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes(result).some((code) => code.startsWith('ANCHOR_PRECONTRACT_')), codes(result).join(','));
});

test('J an anchor authority naming a receipt the precontract never designated is refused', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const decoy = `governance/gates/${GATE}/contracts/DECOY_CONSUMPTION.json`;
  writeJson(root, decoy, readJson(root, RECEIPT));
  writeJson(root, ANCHOR_AUTHORITY, {
    ...readJson(root, ANCHOR_AUTHORITY),
    consumptionRecordPath: decoy,
    consumptionRecordSha256: sha256(fs.readFileSync(absolute(root, decoy)))
  });
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes(result).includes('ANCHOR_PRECONTRACT_PATH_MISMATCH'), codes(result).join(','));
});

test('K an anchor authority of the wrong kind or mode is refused before anything is read', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const authority = readJson(root, ANCHOR_AUTHORITY);
  for (const mutation of [{ documentKind: 'SOMETHING_ELSE' }, { authorityMode: 'LEGACY_SIGNED_AUTHORITY' }, { maxUse: 2 }]) {
    writeJson(root, ANCHOR_AUTHORITY, { ...authority, ...mutation });
    const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER });
    assert.equal(result.verdict, 'BLOCKED', JSON.stringify(mutation));
    assert.equal(result.phase, 'AUTHORITY', JSON.stringify(mutation));
  }
});

test('L a second anchor for the same Gate is refused as a replay', (t) => {
  const root = disposable(t);
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes(result).includes('ANCHOR_ALREADY_PRESENT'), codes(result).join(','));
});

test('M a future ledger append leaves the historical consumption verifiable', (t) => {
  const root = disposable(t);
  const events = readEvents(root);
  const head = events.at(-1);
  const appended = {
    schemaVersion: 1, ordinal: head.ordinal + 1, eventId: 'GATE21_AUTHORIZATION_FUTURE',
    gateId: 'GATE21', fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED',
    transitionType: 'AUTHORIZATION', authorityPath: 'governance/GATE_REGISTRY_00_40.json',
    authoritySha256: 'c'.repeat(64), previousEventSha256: head.eventPayloadSha256,
    recordedAt: '2026-09-01T00:00:00.000Z'
  };
  appended.eventPayloadSha256 = payloadDigest(appended);
  writeEvents(root, [...events, appended]);
  assert.deepEqual(codes(verifyConsumption(root)), []);
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, true);
});

test('N a descendant HEAD leaves the historical consumption verifiable', (t) => {
  const root = disposable(t);
  // The receipt binds a baseCommit that is now an ANCESTOR. That is the normal
  // future, and it must not be mistaken for drift.
  const receipt = readJson(root, RECEIPT);
  assert.ok(receipt.baseCommit, 'receipt pins a base commit');
  assert.deepEqual(codes(verifyConsumption(root)), []);
});

test('O a clock far past issuance leaves the historical consumption verifiable', (t) => {
  const root = disposable(t);
  assert.deepEqual(codes(verifyConsumption(root, { when: new Date('2030-01-01T00:00:00.000Z') })), []);
  assert.equal(verifyConsumption(root, { when: new Date('2030-01-01T00:00:00.000Z') }).consumed, true);
});

test('P a failed anchor publication leaves the ledger byte-identical', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const before = fs.readFileSync(absolute(root, LEDGER));
  writeJson(root, ANCHOR_AUTHORITY, { ...readJson(root, ANCHOR_AUTHORITY), consumptionRecordSha256: 'd'.repeat(64) });
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER, apply: true });
  assert.equal(result.verdict, 'BLOCKED');
  assert.deepEqual(fs.readFileSync(absolute(root, LEDGER)), before, 'a blocked anchor wrote nothing');
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, false);
});

test('Q after the authority is corrected the retry succeeds exactly once', (t) => {
  const root = disposable(t, { withoutAnchor: true });
  const authority = readJson(root, ANCHOR_AUTHORITY);
  writeJson(root, ANCHOR_AUTHORITY, { ...authority, consumptionRecordSha256: 'e'.repeat(64) });
  assert.equal(anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER, apply: true }).verdict, 'BLOCKED');

  writeJson(root, ANCHOR_AUTHORITY, authority);
  const applied = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER, apply: true });
  assert.equal(applied.verdict, 'ANCHORED');
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: GATE }).anchored, true);

  const replay = anchorPrecontractConsumption({ root, authorityPath: absolute(root, ANCHOR_AUTHORITY), recordedAt: LATER, apply: true });
  assert.equal(replay.verdict, 'BLOCKED');
  assert.equal(readEvents(root).filter((event) => event.gateId === GATE && event.transitionType === ANCHOR_TYPE).length, 1);
});

test('R a Gate that never bootstrapped from a precontract is NOT_APPLICABLE, not blocked', (t) => {
  const root = disposable(t);
  for (const gateId of ['GATE21', 'GATE17']) {
    const enforcement = evaluatePrecontractAnchorEnforcement({ root, gateId });
    assert.equal(enforcement.applicable, false, gateId);
    assert.equal(enforcement.verdict, 'NOT_APPLICABLE', gateId);
    assert.equal(enforcement.lifecycleProgressionAuthorized, true, gateId);
  }
  // And the rule is not GATE20-shaped: GATE19, bootstrapped and anchored the
  // canonical way, passes the identical check without any special case.
  assert.equal(evaluatePrecontractAnchorEnforcement({ root, gateId: 'GATE19' }).verdict, 'ANCHORED');
});

// ---------------------------------------------------------------------------
// WIRING — the two consumers, and the implication that binds them
// ---------------------------------------------------------------------------

const gitFixture = disposable;

test('FGI blocks on an unanchored consumption instead of passing over it', (t) => {
  const root = gitFixture(t, { withoutAnchor: true });
  const report = auditFinalGateIntegrity({ root, gateId: GATE });
  assert.equal(report.FINAL_GATE_INTEGRITY, 'FAIL');
  assert.ok(
    report.findings.some((finding) => finding.defectClass === ANCHOR_ENFORCEMENT_BLOCKING_CODE),
    report.findings.map((finding) => finding.defectClass).join(',')
  );
});

test('CONTRADICTION: FINAL_GATE_INTEGRITY PASS implies VERIFY_CONSUMPTION is not BLOCKED', (t) => {
  // Asserted as the implication itself, over both worlds, so neither a passing
  // audit nor a blocking consumer can be reached without the other agreeing.
  const observed = [];
  for (const withoutAnchor of [false, true]) {
    const root = gitFixture(t, { withoutAnchor });
    const report = auditFinalGateIntegrity({ root, gateId: GATE });
    const consumptionBlocked = codes(verifyConsumption(root)).length > 0;
    observed.push({ withoutAnchor, integrity: report.FINAL_GATE_INTEGRITY, consumptionBlocked });

    if (report.FINAL_GATE_INTEGRITY === 'PASS') {
      assert.equal(consumptionBlocked, false,
        `FGI PASS while VERIFY_CONSUMPTION blocked (withoutAnchor=${withoutAnchor})`);
    }
    // The reverse direction is the one that was actually broken, so it is stated
    // explicitly rather than left implied by the contrapositive.
    if (consumptionBlocked) {
      assert.notEqual(report.FINAL_GATE_INTEGRITY, 'PASS',
        `VERIFY_CONSUMPTION blocked while FGI passed (withoutAnchor=${withoutAnchor})`);
    }
  }

  // NON-VACUITY. An implication is satisfied for free when its antecedent never
  // holds, so a run in which FGI never passes proves nothing at all. Both sides
  // must actually be exercised: one world where the audit passes with the
  // consumption clean, and one where removing the anchor blocks both.
  assert.ok(
    observed.some((row) => row.integrity === 'PASS' && !row.consumptionBlocked),
    `no world reached FGI PASS, so the implication held vacuously: ${JSON.stringify(observed)}`
  );
  assert.ok(
    observed.some((row) => row.integrity !== 'PASS' && row.consumptionBlocked),
    `no world reached a blocked consumption: ${JSON.stringify(observed)}`
  );
});

test('the enforcement decision is delegated, never re-derived', () => {
  // Both consumers must agree with the canonical consumer by construction. If a
  // future edit reimplements the rule locally, this equality is what breaks.
  const enforcement = evaluatePrecontractAnchorEnforcement({ root: REPO_ROOT, gateId: GATE });
  const canonical = verifyConsumption(REPO_ROOT);
  assert.equal(enforcement.anchored, canonical.findings.length === 0 && canonical.consumed === true);
});
