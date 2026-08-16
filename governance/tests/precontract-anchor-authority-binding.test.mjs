/**
 * THE ANCHOR AUTHORITY BINDING.
 *
 * THE DEFECT THIS PINS. VERIFY_CONSUMPTION proved the receipt against the ledger
 * anchor EVENT and stopped there. But an event does not get to permit itself: like
 * every other transition class, it cites a single-use authority by path and by
 * hash, and that authority names `consumptionRecordSha256` independently. Nothing
 * in VERIFY_CONSUMPTION ever opened it.
 *
 * So a forger able to edit both the receipt and the ledger could move `recordedAt`,
 * recompute the in-file identity digest with the official helper, recompute the
 * receipt's byte digest, restate that digest in the anchor event, and re-derive
 * `eventPayloadSha256` — a chain internally perfect at every link the consumer
 * inspected. The anchor authority still named the ORIGINAL digest, so
 * `validate-status-ledger` refused it as PRECONTRACT_ANCHOR_DIGEST_MISMATCH while
 * VERIFY_CONSUMPTION returned AUTHORIZED. Two validators over one repository,
 * opposite verdicts: that contradiction is the blocker these tests close.
 *
 * WHAT IS PROVEN HERE. The whole chain — receipt bytes, receipt digest, anchor
 * event, cited authority path, cited authority digest, the authority's own bytes,
 * its Gate binding, its permitted receipt path and digest, and the precontract
 * authority underneath it — plus PARITY between the two consumers on every
 * mutation that touches any link of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  computePrecontractConsumptionIdentityDigest,
  reconstructLedgerPrefix
} from '../gee-v1/core/precontract-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { sha256Canonical } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = 'GATE19';
const OTHER_GATE = 'GATE17';
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const AUTHORITY_RELATIVE = `governance/authority/precontract/${GATE}/PROJECT_OWNER_LOCAL_PRECONTRACT_AUTHORITY.json`;
const ANCHOR_RELATIVE = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;
const CONSUMPTION_RELATIVE = `governance/gates/${GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
const NOW = new Date('2026-08-15T16:00:00.000Z');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const abs = (root, relative) => path.join(root, ...relative.split('/'));
const readJson = (root, relative) => JSON.parse(fs.readFileSync(abs(root, relative), 'utf8'));
const codes = (result) => result.findings.map((item) => item.code);

/** A disposable mirror sharing the real object store; REPO_ROOT is never written. */
function buildLiveMirror() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'anchor-authority-'));
  const cloned = spawnSync('git', ['clone', '--shared', '--no-checkout', '--quiet', REPO_ROOT, root], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}
const live = buildLiveMirror();

const verifyConsumption = () => createWheelPrecontractAuthoritySource(live, {
  authorityPath: abs(live, AUTHORITY_RELATIVE), now: NOW
}).verifyPrecontractConsumption(GATE);

/** The other consumer of the same property, run exactly as a terminal would run it. */
function ledgerDetectors() {
  const result = spawnSync(process.execPath, [abs(live, 'governance/tools/validate-status-ledger.mjs'), '--root', live], { cwd: live, encoding: 'utf8' });
  return JSON.parse(result.stdout).findings.filter((item) => item.severity !== 'INFO').map((item) => item.detectorId);
}

/** Mutate a cohort, judge it, then restore every file byte-exactly even on throw. */
function withTamper(relatives, mutate, assertions) {
  const targets = relatives.map((relative) => abs(live, relative));
  const originals = targets.map((target) => fs.readFileSync(target));
  try {
    mutate();
    assertions();
  } finally {
    for (const [index, target] of targets.entries()) fs.writeFileSync(target, originals[index]);
    for (const [index, target] of targets.entries()) {
      assert.equal(sha256(fs.readFileSync(target)), sha256(originals[index]), 'restore must be byte-exact');
    }
  }
}

const writeJson = (relative, value) => fs.writeFileSync(abs(live, relative), `${JSON.stringify(value, null, 2)}\n`);

/** Rewrite the anchor event and re-derive its payload digest exactly as the tool does. */
function rewriteAnchorEvent(mutate) {
  const target = abs(live, LEDGER);
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
  const index = lines.findIndex((line) => line.includes('PRECONTRACT_CONSUMPTION_ANCHOR'));
  const event = JSON.parse(lines[index]);
  mutate(event);
  const { eventPayloadSha256: _superseded, ...payload } = event;
  event.eventPayloadSha256 = sha256Canonical(payload);
  lines[index] = JSON.stringify(event);
  fs.writeFileSync(target, `${lines.join('\n')}\n`);
}

/** Re-pin the event to whatever the anchor authority now says, so the attack is complete. */
function repinAnchorAuthority() {
  const bytes = fs.readFileSync(abs(live, ANCHOR_RELATIVE));
  rewriteAnchorEvent((event) => { event.authoritySha256 = sha256(bytes); });
}

/** The forgery the blocker named: a receipt rewritten and re-anchored perfectly. */
function forgeReceiptAndEvent(recordedAt = '2026-08-15T14:02:00.000Z') {
  const receipt = readJson(live, CONSUMPTION_RELATIVE);
  const authority = readJson(live, AUTHORITY_RELATIVE);
  const prefix = reconstructLedgerPrefix(fs.readFileSync(abs(live, LEDGER), 'utf8'), authority.preState.ledgerEventCount);
  receipt.recordedAt = recordedAt;
  receipt.consumptionIdentityDigest = computePrecontractConsumptionIdentityDigest({
    authority, ledgerPrefixSha256: prefix.sha256, ledgerEventCount: prefix.eventCount,
    cohort: authority.artifactBindings, recordedAt, consumedUse: receipt.consumedUse
  });
  writeJson(CONSUMPTION_RELATIVE, receipt);
  const forged = sha256(fs.readFileSync(abs(live, CONSUMPTION_RELATIVE)));
  rewriteAnchorEvent((event) => { event.precontractConsumption.sha256 = forged; });
  return forged;
}

// ---------------------------------------------------------------------------
// CONTROL — the property must not be bought by refusing everything.
// ---------------------------------------------------------------------------

test('AA0 CONTROL: the original bytes are AUTHORIZED by both consumers', () => {
  const result = verifyConsumption();
  assert.equal(result.decision, 'AUTHORIZED', JSON.stringify(result.findings));
  assert.deepEqual(ledgerDetectors(), []);
});

// ---------------------------------------------------------------------------
// THE PRINCIPAL FORGERY
// ---------------------------------------------------------------------------

test('AA1 MANDATORY: a perfectly rehashed receipt + event is BLOCKED by the anchor authority', () => {
  const anchorBefore = sha256(fs.readFileSync(abs(live, ANCHOR_RELATIVE)));
  withTamper([CONSUMPTION_RELATIVE, LEDGER], () => { forgeReceiptAndEvent(); }, () => {
    // The anchor authority is strictly untouched: it is the only unrewritten witness.
    assert.equal(sha256(fs.readFileSync(abs(live, ANCHOR_RELATIVE))), anchorBefore);

    const result = verifyConsumption();
    assert.equal(result.decision, 'BLOCKED', JSON.stringify(result.findings));
    // The BLOCK must come from the anchor-authority binding.
    assert.ok(codes(result).includes('CONSUMPTION_ANCHOR_RECORD_DIGEST_MISMATCH'), JSON.stringify(result.findings));
    // And from NOTHING else: every other leg the forgery repaired is genuinely
    // satisfied, so the test cannot pass for an accidental reason.
    assert.deepEqual(codes(result), ['CONSUMPTION_ANCHOR_RECORD_DIGEST_MISMATCH'], JSON.stringify(result.findings));
  });
});

// ---------------------------------------------------------------------------
// EVERY OTHER LINK OF THE SAME CHAIN
// ---------------------------------------------------------------------------

const HOSTILES = [
  ['AA2 wrong authorityPath', [LEDGER], () => {
    // Cite a real, hash-correct governed document that is not an anchor authority.
    const bytes = fs.readFileSync(abs(live, AUTHORITY_RELATIVE));
    rewriteAnchorEvent((event) => { event.authorityPath = AUTHORITY_RELATIVE; event.authoritySha256 = sha256(bytes); });
  }, 'CONSUMPTION_ANCHOR_AUTHORITY_KIND_INVALID'],

  ['AA3 wrong authoritySha256', [LEDGER], () => {
    rewriteAnchorEvent((event) => { event.authoritySha256 = '7'.repeat(64); });
  }, 'CONSUMPTION_ANCHOR_AUTHORITY_BYTES_MISMATCH'],

  ['AA4 missing anchor authority', [ANCHOR_RELATIVE], () => {
    fs.rmSync(abs(live, ANCHOR_RELATIVE));
  }, 'CONSUMPTION_ANCHOR_AUTHORITY_UNRESOLVED'],

  ['AA5 authority bound to the wrong gate', [ANCHOR_RELATIVE, LEDGER], () => {
    const record = readJson(live, ANCHOR_RELATIVE);
    record.gateId = OTHER_GATE;
    writeJson(ANCHOR_RELATIVE, record);
    repinAnchorAuthority();
  }, 'CONSUMPTION_ANCHOR_AUTHORITY_GATE_MISMATCH'],

  ['AA6 authority naming the wrong consumptionRecordPath', [ANCHOR_RELATIVE, LEDGER], () => {
    const record = readJson(live, ANCHOR_RELATIVE);
    record.consumptionRecordPath = `governance/gates/${OTHER_GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
    writeJson(ANCHOR_RELATIVE, record);
    repinAnchorAuthority();
  }, 'CONSUMPTION_ANCHOR_RECORD_PATH_MISMATCH'],

  ['AA7 authority keeping the stale receipt SHA against a forged event', [CONSUMPTION_RELATIVE, LEDGER], () => {
    forgeReceiptAndEvent('2026-08-15T14:44:00.000Z');
  }, 'CONSUMPTION_ANCHOR_RECORD_DIGEST_MISMATCH'],

  ['AA8 event stating a receipt digest nothing backs', [LEDGER], () => {
    rewriteAnchorEvent((event) => { event.precontractConsumption.sha256 = '9'.repeat(64); });
  }, 'CONSUMPTION_ANCHOR_RECORD_DIGEST_MISMATCH'],

  ['AA9 event stating the wrong receipt path', [LEDGER], () => {
    rewriteAnchorEvent((event) => { event.precontractConsumption.path = `governance/gates/${OTHER_GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`; });
  }, 'CONSUMPTION_ANCHOR_PATH_MISMATCH']
];

for (const [name, cohort, mutate, expected] of HOSTILES) {
  test(`${name} is BLOCKED`, () => {
    withTamper(cohort, mutate, () => {
      const result = verifyConsumption();
      assert.equal(result.decision, 'BLOCKED', `${name}: ${JSON.stringify(result.findings)}`);
      assert.ok(codes(result).includes(expected), `${name}: ${JSON.stringify(result.findings)}`);
    });
  });
}

// ---------------------------------------------------------------------------
// CONSUMER PARITY — the contradiction itself, refused as its own property.
// ---------------------------------------------------------------------------

test('AA10 MANDATORY: the two consumers never disagree on this property', () => {
  const rows = [];
  const observe = (name) => rows.push([name, verifyConsumption().decision === 'AUTHORIZED', ledgerDetectors().length === 0]);
  // The control belongs in the table too: parity that only holds for BLOCK is not parity.
  observe('AA0 control');
  for (const [name, cohort, mutate] of HOSTILES) withTamper(cohort, mutate, () => observe(name));
  withTamper([CONSUMPTION_RELATIVE, LEDGER], () => { forgeReceiptAndEvent(); }, () => observe('AA1 principal forgery'));

  const contradictions = rows.filter(([, consumer, ledger]) => consumer !== ledger);
  assert.deepEqual(contradictions, [], `PASS/BLOCK contradiction: ${JSON.stringify(contradictions)}`);
  assert.equal(rows.length, HOSTILES.length + 2);
  // Exactly one row may PASS, and it must be the control.
  assert.deepEqual(rows.filter(([, consumer]) => consumer).map(([name]) => name), ['AA0 control']);
});

test.after(() => fs.rmSync(live, { recursive: true, force: true }));
