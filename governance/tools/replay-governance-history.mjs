#!/usr/bin/env node
/**
 * Replay governed history at any ordinal.
 *
 *   replay-governance-history.mjs --at 57
 *   replay-governance-history.mjs --all
 *   replay-governance-history.mjs --present
 *
 * INTEGRITY BY CONSTRUCTION. `--at N` reconstructs the exact byte prefix through
 * ordinal N and validates it in LEDGER_INTEGRITY mode, so the replay cannot read
 * a mutable projection that only exists because history moved on. That was not a
 * theoretical concern: before the H4 split, `--at 57` failed, because it compared
 * the status replayed at 57 against the CURRENT state seal written at 58.
 *
 * `--present` asks the other question — do today's projections agree with the
 * ledger HEAD — and never claims anything about history.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateLedgerPrefix,
  validatePresentConsistency,
  reconstructLedgerPrefixBytes,
  MODE_LEDGER_INTEGRITY
} from './validate-status-ledger.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const ledgerPath = path.resolve(option('--ledger', path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson')));
const expected = option('--expect-prefix-sha256', null);

let policy = null;
try {
  ({ WHEEL_EXTERNAL_AUTHORITY_POLICY: policy } = await import('../gee-v1/adapters/wheel/external-authority-policy.mjs'));
} catch { policy = null; }

function events() {
  return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

/**
 * The GENESIS_IMPORT cohort is ATOMIC: the bootstrap invariant is exactly one
 * import event per gate, so a prefix that stops part-way through it is not a
 * truncated history — it is not a history at all, and the ledger validator
 * rightly calls that FABRICATED_HISTORY.
 *
 * The first ordinal at which a standalone replay is meaningful is therefore the
 * last genesis import. `--all` starts there; `--from 1` can still be asked for
 * explicitly, and will honestly fail inside the cohort.
 */
function firstReplayableOrdinal(all) {
  const genesis = all.filter((event) => event.transitionType === 'GENESIS_IMPORT').map((event) => event.ordinal);
  return genesis.length ? Math.max(...genesis) : 1;
}

function replayAt(ordinal) {
  const report = validateLedgerPrefix({
    root, ledgerPath, throughOrdinal: ordinal,
    expectedPrefixSha256: expected, policy, mode: MODE_LEDGER_INTEGRITY
  });
  const blocking = report.prefixFindings.filter((f) => f.severity === 'BLOCKING');
  return {
    atOrdinal: ordinal,
    verdict: blocking.length === 0 ? 'PASS' : 'FAIL',
    prefixSha256: report.prefixSha256,
    prefixByteLength: reconstructLedgerPrefixBytes(ledgerPath, ordinal).length,
    matchesExpectedHistoricalDigest: report.matchesExpectedHistoricalDigest,
    blockingFindings: blocking
  };
}

const output = { document: 'GOVERNANCE_HISTORY_REPLAY', mode: MODE_LEDGER_INTEGRITY, ledgerPath: path.relative(root, ledgerPath).replaceAll('\\', '/') };

if (process.argv.includes('--present')) {
  const present = validatePresentConsistency({ root, ledgerPath, policy });
  output.document = 'GOVERNANCE_PRESENT_CONSISTENCY';
  output.mode = 'PRESENT_CONSISTENCY';
  output.ledgerIntegrityValid = present.ledgerIntegrityValid;
  output.presentConsistent = present.presentConsistent;
  output.eventCount = present.eventCount;
  output.presentFindings = present.presentFindings;
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  process.exitCode = present.ledgerIntegrityValid && present.presentConsistent ? 0 : 2;
} else {
  const all = events();
  const total = all.length;
  const from = Number.parseInt(option('--from', String(firstReplayableOrdinal(all))), 10);
  const ordinals = process.argv.includes('--all')
    ? Array.from({ length: total - from + 1 }, (_, index) => from + index)
    : [Number.parseInt(option('--at', String(total)), 10)];
  if (ordinals.some((value) => !Number.isInteger(value) || value < 1 || value > total)) {
    process.stdout.write(JSON.stringify({ ...output, verdict: 'FAIL', error: 'ORDINAL_OUT_OF_RANGE', eventCount: total }, null, 2) + '\n');
    process.exitCode = 2;
  } else {
    const replays = ordinals.map(replayAt);
    output.eventCount = total;
    output.firstReplayableOrdinal = firstReplayableOrdinal(all);
    output.replays = replays;
    output.verdict = replays.every((r) => r.verdict === 'PASS') ? 'PASS' : 'FAIL';
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exitCode = output.verdict === 'PASS' ? 0 : 2;
  }
}
