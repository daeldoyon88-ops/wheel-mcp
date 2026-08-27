import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildTimeZoneRuleset } from '../src/data/buildCorporateAction.mjs';
import {
  buildMarketCalendarAuthorityPolicy,
  buildMarketCalendarRegistry,
  buildMarketSessionCalendar,
  verifyMarketCalendarRegistry,
} from '../src/contracts/marketCalendarL3V1.mjs';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { createCalendarWindowBinding, resolvePinnedCanonicalSession } from '../../../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { admitProductionCalendarWindowBinding } from '../../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { resolveKnowledgeCutoff } from '../../../governance/gates/GATE24/implementation/causal-admission-v1.mjs';
import {
  ALLOWED_SESSION_KINDS,
  CALENDAR_NAMESPACE_VERSION,
  EXPECTED_EARLY_CLOSES,
  EXPECTED_FULL_CLOSURES,
  REPOSITORY_ROOT,
  parseNasdaqCalendar2026,
  parseNyseCalendar2026,
} from '../../../scripts/buildJarviseSessionCalendarXNYS.mjs';

const DATA_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026');
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/source-evidence/2026');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'jarvise-calendar-test-'));
  try { return fn(createContentAddressedStore({ root })); } finally { rmSync(root, { recursive: true, force: true }); }
}

function seedProductionObjects(store) {
  const ruleset = buildTimeZoneRuleset({ store, ruleset: readJson(resolve(DATA_ROOT, 'timezone-ruleset.json')) });
  const policy = buildMarketCalendarAuthorityPolicy({ store, policy: readJson(resolve(DATA_ROOT, 'authority-policy.json')) });
  const calendar = buildMarketSessionCalendar({ store, calendar: readJson(resolve(DATA_ROOT, 'session-calendar-core.json')) });
  const registry = buildMarketCalendarRegistry({ store, registry: readJson(resolve(DATA_ROOT, 'registry-manifest.json')) });
  return { ruleset, policy, calendar, registry };
}

test('official CY2026 evidence reproduces the frozen source truth', () => {
  const nyse = parseNyseCalendar2026(readFileSync(resolve(SOURCE_ROOT, 'nyse-hours-calendars.html'), 'utf8'));
  const nasdaq = parseNasdaqCalendar2026(readFileSync(resolve(SOURCE_ROOT, 'nasdaqtrader-calendar.html'), 'utf8'));
  assert.deepEqual(nyse.fullClosureDates, [...EXPECTED_FULL_CLOSURES]);
  assert.deepEqual(nasdaq.fullClosureDates, [...EXPECTED_FULL_CLOSURES]);
  assert.deepEqual(nyse.earlyCloseDates, [...EXPECTED_EARLY_CLOSES]);
  assert.deepEqual(nasdaq.earlyCloseDates, [...EXPECTED_EARLY_CLOSES]);
});

test('H1-H8 and production counts cover EST, EDT, holidays, early close and weekend', () => {
  const core = readJson(resolve(DATA_ROOT, 'session-calendar-core.json'));
  const byDate = new Map(core.sessions.map((session) => [session.sessionDate, session]));
  assert.deepEqual(byDate.get('2026-01-02'), {
    sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION',
    openUtc: '2026-01-02T14:30:00.000Z', closeUtc: '2026-01-02T21:00:00.000Z', marketValidTime: '2026-01-02T21:00:00.000Z',
  });
  assert.deepEqual(byDate.get('2026-07-06'), {
    sessionDate: '2026-07-06', sessionKind: 'REGULAR_SESSION',
    openUtc: '2026-07-06T13:30:00.000Z', closeUtc: '2026-07-06T20:00:00.000Z', marketValidTime: '2026-07-06T20:00:00.000Z',
  });
  assert.notEqual(byDate.get('2026-01-02').openUtc.slice(11, 16), byDate.get('2026-07-06').openUtc.slice(11, 16));
  assert.equal(byDate.has('2026-01-01'), false);
  assert.equal(byDate.has('2026-07-03'), false);
  assert.equal(byDate.get('2026-07-02').sessionKind, 'REGULAR_SESSION');
  assert.equal(byDate.has('2026-04-03'), false);
  assert.deepEqual(byDate.get('2026-11-27'), {
    sessionDate: '2026-11-27', sessionKind: 'HALF_DAY_SESSION',
    openUtc: '2026-11-27T14:30:00.000Z', closeUtc: '2026-11-27T18:00:00.000Z', marketValidTime: '2026-11-27T18:00:00.000Z',
  });
  assert.equal(byDate.has('2026-01-03'), false);
  assert.equal(core.sessions.length, 251);
  assert.equal(core.sessions.filter((session) => session.sessionKind === 'REGULAR_SESSION').length, 249);
  assert.equal(core.sessions.filter((session) => session.sessionKind === 'HALF_DAY_SESSION').length, 2);
  assert.equal(new Set(core.sessions.map((session) => session.sessionDate)).size, 251);
  assert.deepEqual(core.sessions.map((session) => session.sessionDate), [...core.sessions.map((session) => session.sessionDate)].sort());
  assert.ok(core.sessions.every((session) => session.sessionDate >= '2026-01-01' && session.sessionDate < '2027-01-01'));
  assert.ok(core.sessions.every((session) => session.marketValidTime === session.closeUtc));
});

test('registry graph, production namespace and pinned K(T) proofs verify canonically', () => withStore((store) => {
  const { policy, calendar, registry } = seedProductionObjects(store);
  const verified = verifyMarketCalendarRegistry({ store, calendarRegistryManifestId: registry.calendarRegistryManifestId });
  assert.equal(verified.calendarRegistryManifestId, registry.calendarRegistryManifestId);
  const binding = createCalendarWindowBinding({
    calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
    calendarRegistryManifestId: registry.calendarRegistryManifestId,
    allowedSessionKinds: [...ALLOWED_SESSION_KINDS],
    calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
    cutoffDerivation: 'PINNED_CANONICAL_SESSION_CLOSE_UTC',
  });
  assert.equal(admitProductionCalendarWindowBinding(binding).status, 'ADMITTED');
  const expected = {
    '2026-01-02': '2026-01-02T21:00:00.000Z',
    '2026-07-06': '2026-07-06T20:00:00.000Z',
    '2026-11-27': '2026-11-27T18:00:00.000Z',
    '2026-12-24': '2026-12-24T18:00:00.000Z',
  };
  for (const [sessionDate, cutoff] of Object.entries(expected)) {
    assert.equal(resolvePinnedCanonicalSession({ sessionDate, calendarWindowBinding: binding, sessions: calendar.calendarCore.sessions }).knowledgeCutoff, cutoff);
    assert.equal(resolveKnowledgeCutoff({ sessionDate, calendarWindowBinding: binding, sessions: calendar.calendarCore.sessions }).knowledgeCutoff, cutoff);
  }
  for (const sessionDate of ['2026-01-01', '2026-01-03', '2026-07-03']) {
    assert.equal(resolveKnowledgeCutoff({ sessionDate, calendarWindowBinding: binding, sessions: calendar.calendarCore.sessions }).status, 'FAIL_CLOSED');
  }
  const provenance = readJson(resolve(DATA_ROOT, 'PROVENANCE.json'));
  assert.equal(provenance.calendarWindowBindingId, binding.calendarWindowBindingId);
  assert.equal(provenance.calendarNamespaceVersion, CALENDAR_NAMESPACE_VERSION);
}));
