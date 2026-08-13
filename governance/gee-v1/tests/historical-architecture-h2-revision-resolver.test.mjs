/**
 * H2 — the current state revision is decided by the ledger, not the filesystem.
 *
 * The regression these tests exist to prevent is subtle and was real: with
 * directory authority, planting `state/revisions/R9999/` made the validator
 * report the CORRECT CURRENT_STATE as a CHECKPOINT_ROLLBACK "expected R9999".
 * A directory name redefined history. H2-10 pins that exact scenario.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  resolveStateRevisionLineage,
  collectStateBindingEvents,
  DECIDED_BY_NATIVE_EVENT_PIN,
  DECIDED_BY_LEGACY_BINDING_RECORD,
  DECIDED_BY_SEAL_CHAIN_HEAD,
  ANCHOR_LEDGER,
  ANCHOR_PRE_BINDING_ERA,
  LEGACY_ERA_MAX_ORDINAL
} from '../core/state-revision-resolver.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GATE = 'GATEX';
const codes = (result) => result.findings.map((f) => f.code);

// Seal digests must be real 64-char lowercase hex, because the resolver refuses
// anything else — deriving them from the revision number keeps them valid and unique.
const digestFor = (revision) => String(revision.slice(1)).padStart(64, '0');
const sealOf = (revision, previous) => ({
  sha256: digestFor(revision),
  gateId: GATE,
  stateRevision: revision,
  previousStateSealSha256: previous
});

function sealMap(entries) {
  return new Map(entries.map(([name, previous]) => [name, sealOf(name, previous)]));
}

const R1 = sealOf('R0001', null).sha256;
const R2 = sealOf('R0002', R1).sha256;

function legacyBinding(overrides = {}) {
  return {
    eventOrdinal: 57, eventId: 'E57', gateId: GATE, toStatus: 'AUTHORIZED_NOT_STARTED',
    eventPayloadSha256: 'p57', originalAuthorityPath: 'a/57.json', originalAuthoritySha256: 'h57',
    stateRevision: 'R0001', stateRevisionSealSha256: R1, ...overrides
  };
}

function legacyEvent(overrides = {}) {
  return {
    ordinal: 57, eventId: 'E57', gateId: GATE, toStatus: 'AUTHORIZED_NOT_STARTED',
    eventPayloadSha256: 'p57', authorityPath: 'a/57.json', authoritySha256: 'h57', ...overrides
  };
}

function nativeEvent(ordinal, revision, sealSha, overrides = {}) {
  return {
    ordinal, eventId: `E${ordinal}`, gateId: GATE, toStatus: 'IN_PROGRESS',
    stateRevision: revision, stateRevisionSealSha256: sealSha, ...overrides
  };
}

// --- the two eras -----------------------------------------------------------

test('H2-01: a legacy-era event resolves through its legacy binding record', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [legacyEvent()], legacyBindings: [legacyBinding()],
    seals: sealMap([['R0001', null]]), presentRevisions: ['R0001']
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.resolved, 'R0001');
  assert.equal(result.decidedBy, DECIDED_BY_LEGACY_BINDING_RECORD);
  assert.equal(result.anchorState, ANCHOR_LEDGER);
});

test('H2-02: a native-era event resolves through its own pin', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE,
    events: [legacyEvent(), nativeEvent(59, 'R0002', R2)],
    legacyBindings: [legacyBinding()],
    seals: sealMap([['R0001', null], ['R0002', R1]]),
    presentRevisions: ['R0001', 'R0002']
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.resolved, 'R0002');
  assert.equal(result.decidedBy, DECIDED_BY_NATIVE_EVENT_PIN);
  assert.deepEqual(result.sealChain, ['R0001', 'R0002']);
});

test('H2-03: there is NO migration fallback in the native era', () => {
  // A legacy record reaching forward past the era boundary is refused...
  const forward = collectStateBindingEvents({
    gateId: GATE, events: [nativeEvent(59, 'R0002', R2)],
    legacyBindings: [legacyBinding({ eventOrdinal: 59, eventId: 'E59', stateRevision: 'R0002', stateRevisionSealSha256: R2 })]
  });
  assert.ok(codes(forward).includes('NATIVE_ERA_MIGRATION_FORBIDDEN'));
  // ...and a native-era event that claims state without a valid pin blocks
  // rather than silently resolving some other way.
  const unpinned = collectStateBindingEvents({
    gateId: GATE, events: [nativeEvent(59, 'R0002', 'not-a-sha')], legacyBindings: []
  });
  assert.ok(codes(unpinned).includes('NATIVE_STATE_PIN_INVALID'));
  assert.equal(unpinned.bindings.length, 0);
});

test('H2-04: the legacy era boundary is exactly 58', () => {
  assert.equal(LEGACY_ERA_MAX_ORDINAL, 58);
});

// --- a legacy record must agree with the event it claims --------------------

for (const [name, override] of [
  ['H2-05 wrong eventId', { eventId: 'OTHER' }],
  ['H2-05 wrong payload digest', { eventPayloadSha256: 'other' }],
  ['H2-06 wrong toStatus', { toStatus: 'IN_PROGRESS' }],
  ['H2-07 wrong authority path', { originalAuthorityPath: 'a/other.json' }],
  ['H2-07 wrong authority digest', { originalAuthoritySha256: 'other' }],
  ['H2-08 invalid revision', { stateRevision: 'NOPE' }],
  ['H2-08 invalid seal digest', { stateRevisionSealSha256: 'nope' }]
]) {
  test(`${name} is refused`, () => {
    const result = collectStateBindingEvents({
      gateId: GATE, events: [legacyEvent()], legacyBindings: [legacyBinding(override)]
    });
    assert.equal(result.bindings.length, 0, JSON.stringify(result.findings));
    assert.ok(result.findings.length > 0);
  });
}

test('H2-09: duplicate legacy bindings for one ordinal are refused', () => {
  const result = collectStateBindingEvents({
    gateId: GATE, events: [legacyEvent()], legacyBindings: [legacyBinding(), legacyBinding()]
  });
  assert.ok(codes(result).includes('LEGACY_BINDING_DUPLICATE'));
});

// --- the R9999 scenario, pinned ---------------------------------------------

test('H2-10: a planted maximum-looking revision cannot change what resolves', () => {
  const withoutIntruder = resolveStateRevisionLineage({
    gateId: GATE, events: [legacyEvent(), nativeEvent(59, 'R0002', R2)], legacyBindings: [legacyBinding()],
    seals: sealMap([['R0001', null], ['R0002', R1]]), presentRevisions: ['R0001', 'R0002']
  });
  const seals = sealMap([['R0001', null], ['R0002', R1]]);
  seals.set('R9999', { sha256: digestFor('R9999'), gateId: GATE, stateRevision: 'R9999', previousStateSealSha256: R1 });
  const withIntruder = resolveStateRevisionLineage({
    gateId: GATE, events: [legacyEvent(), nativeEvent(59, 'R0002', R2)], legacyBindings: [legacyBinding()],
    seals, presentRevisions: ['R0001', 'R0002', 'R9999']
  });
  // The answer to "which revision is current" is identical.
  assert.equal(withIntruder.resolved, withoutIntruder.resolved);
  assert.equal(withIntruder.resolved, 'R0002');
  assert.deepEqual(withIntruder.sealChain, withoutIntruder.sealChain);
  // And the intruder is named, not ignored.
  assert.deepEqual(withIntruder.orphans, ['R9999']);
  assert.ok(codes(withIntruder).includes('ORPHAN_REVISION'));
  assert.ok(codes(withIntruder).includes('REVISION_FORK'));
  // Crucially, the correct pointer is NOT accused of rolling back.
  assert.equal(codes(withIntruder).includes('REVISION_ROLLBACK'), false);
});

// --- rollback, fork, orphan, broken chain -----------------------------------

test('H2-11: a later binding naming an earlier revision is a rollback and blocks', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE,
    events: [nativeEvent(59, 'R0002', R2), nativeEvent(60, 'R0001', R1)],
    seals: sealMap([['R0001', null], ['R0002', R1]]), presentRevisions: ['R0001', 'R0002']
  });
  assert.ok(codes(result).includes('REVISION_ROLLBACK'));
});

test('H2-12: two revisions claiming one predecessor is a fork and blocks', () => {
  const seals = sealMap([['R0001', null], ['R0002', R1]]);
  seals.set('R0003', { sha256: digestFor('R0003'), gateId: GATE, stateRevision: 'R0003', previousStateSealSha256: R1 });
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [nativeEvent(59, 'R0002', R2)], seals, presentRevisions: ['R0001', 'R0002', 'R0003']
  });
  assert.ok(codes(result).includes('REVISION_FORK'));
});

test('H2-13: a chain that does not reach the root blocks', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [nativeEvent(59, 'R0002', R2)],
    seals: sealMap([['R0002', R1]]), presentRevisions: ['R0002']
  });
  assert.ok(codes(result).includes('REVISION_CHAIN_BROKEN') || codes(result).includes('REVISION_CHAIN_NOT_ROOTED'));
});

test('H2-14: a resolved revision whose seal digest disagrees with the event blocks', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [nativeEvent(59, 'R0002', 'f'.repeat(64))],
    seals: sealMap([['R0001', null], ['R0002', R1]]), presentRevisions: ['R0001', 'R0002']
  });
  assert.ok(codes(result).includes('RESOLVED_REVISION_SEAL_DIGEST_MISMATCH'));
});

test('H2-15: a cross-gate seal on the chain blocks', () => {
  const seals = sealMap([['R0001', null], ['R0002', R1]]);
  seals.set('R0002', { ...seals.get('R0002'), gateId: 'OTHERGATE' });
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [nativeEvent(59, 'R0002', seals.get('R0002').sha256)], seals, presentRevisions: ['R0001', 'R0002']
  });
  assert.ok(codes(result).includes('REVISION_CHAIN_CROSS_GATE'));
});

// --- pre-binding era --------------------------------------------------------

test('H2-16: a gate the ledger never bound resolves from the seal chain, reported as such', () => {
  const result = resolveStateRevisionLineage({
    gateId: GATE, events: [{ ordinal: 44, eventId: 'E44', gateId: GATE, toStatus: 'COMPLETE_CONFIRMED' }],
    seals: sealMap([['R0001', null], ['R0002', R1]]), presentRevisions: ['R0001', 'R0002']
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.resolved, 'R0002');
  assert.equal(result.decidedBy, DECIDED_BY_SEAL_CHAIN_HEAD);
  // The weaker claim is never presented as a ledger anchor.
  assert.equal(result.anchorState, ANCHOR_PRE_BINDING_ERA);
});

test('H2-17: an ambiguous pre-binding head blocks instead of preferring the highest name', () => {
  const seals = sealMap([['R0001', null], ['R0002', R1]]);
  seals.set('R0009', { sha256: digestFor('R0009'), gateId: GATE, stateRevision: 'R0009', previousStateSealSha256: null });
  const result = resolveStateRevisionLineage({ gateId: GATE, events: [], seals, presentRevisions: ['R0001', 'R0002', 'R0009'] });
  assert.equal(result.resolved, null);
  assert.ok(codes(result).includes('REVISION_CHAIN_AMBIGUOUS_HEAD'));
});

// --- the real repository ----------------------------------------------------

test('H2-18: real GATE14 resolves its head revision from the ledger with a rooted chain', () => {
  const events = fs.readFileSync(path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8')
    .split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  const legacy = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/historical-architecture/LEGACY_STATE_BINDINGS.json'), 'utf8'));
  const seals = new Map();
  for (const revision of ['R0001', 'R0002', 'R0003']) {
    const file = path.join(REPO_ROOT, `governance/gates/GATE14/state/revisions/${revision}/STATE_SEAL.json`);
    const bytes = fs.readFileSync(file);
    const json = JSON.parse(bytes.toString('utf8'));
    seals.set(revision, {
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      gateId: json.gateId, stateRevision: json.stateRevision, previousStateSealSha256: json.previousStateSealSha256
    });
  }
  const result = resolveStateRevisionLineage({
    gateId: 'GATE14', events, legacyBindings: legacy.bindings,
    legacyEraMaxOrdinal: legacy.legacyEraMaxOrdinal, seals, presentRevisions: ['R0001', 'R0002', 'R0003']
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.resolved, 'R0003');
  assert.equal(result.anchorState, ANCHOR_LEDGER);
  // R0001 and R0002 come from legacy binding records; R0003 comes from the
  // native pin carried by event 59 itself. Both eras resolve into one chain.
  assert.equal(result.decidedBy, DECIDED_BY_NATIVE_EVENT_PIN);
  assert.deepEqual(result.sealChain, ['R0001', 'R0002', 'R0003']);
  assert.deepEqual(result.bindings.map((b) => `${b.eventOrdinal}:${b.stateRevision}:${b.decidedBy}`), [
    `57:R0001:${DECIDED_BY_LEGACY_BINDING_RECORD}`,
    `58:R0002:${DECIDED_BY_LEGACY_BINDING_RECORD}`,
    `59:R0003:${DECIDED_BY_NATIVE_EVENT_PIN}`
  ]);
});
