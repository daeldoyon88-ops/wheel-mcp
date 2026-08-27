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
import { deriveNewYorkUtcInstantV1 } from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { createCalendarWindowBinding } from '../../../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { admitProductionCalendarWindowBinding } from '../../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import {
  ALLOWED_SESSION_KINDS,
  CALENDAR_NAMESPACE_VERSION,
  REPOSITORY_ROOT,
  assertAuthoritiesAgree,
  assertExceptionalClosureSweep,
  parseNasdaqCalendar2026,
  parseNyseCalendar2026,
} from '../../../scripts/buildJarviseSessionCalendarXNYS.mjs';

const DATA_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026');
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/source-evidence/2026');
const MATERIALIZER = resolve(REPOSITORY_ROOT, 'scripts/buildJarviseSessionCalendarXNYS.mjs');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'jarvise-calendar-hostile-'));
  try { return fn(createContentAddressedStore({ root })); } finally { rmSync(root, { recursive: true, force: true }); }
}

function seed(store) {
  const ruleset = buildTimeZoneRuleset({ store, ruleset: readJson(resolve(DATA_ROOT, 'timezone-ruleset.json')) });
  const policy = buildMarketCalendarAuthorityPolicy({ store, policy: readJson(resolve(DATA_ROOT, 'authority-policy.json')) });
  const calendar = buildMarketSessionCalendar({ store, calendar: readJson(resolve(DATA_ROOT, 'session-calendar-core.json')) });
  const registry = buildMarketCalendarRegistry({ store, registry: readJson(resolve(DATA_ROOT, 'registry-manifest.json')) });
  return { ruleset, policy, calendar, registry };
}

function expectThrowCode(fn, code) {
  assert.throws(fn, (error) => String(error?.code || error?.message || error).includes(code));
}

test('H9-H12 reject invalid date, duplicate date, close <= open and marketValidTime mismatch', () => {
  assert.throws(() => deriveNewYorkUtcInstantV1('2026-02-30', '09:30'));
  withStore((store) => {
    const { calendar } = seed(store);
    const duplicate = structuredClone(calendar.calendarCore);
    duplicate.sessions.splice(1, 0, structuredClone(duplicate.sessions[0]));
    expectThrowCode(() => buildMarketSessionCalendar({ store, calendar: duplicate }), 'MARKET_DATA_CALENDAR_SESSION_DUPLICATE');
    const inverted = structuredClone(calendar.calendarCore);
    inverted.sessions[0].closeUtc = inverted.sessions[0].openUtc;
    inverted.sessions[0].marketValidTime = inverted.sessions[0].closeUtc;
    expectThrowCode(() => buildMarketSessionCalendar({ store, calendar: inverted }), 'MARKET_DATA_INPUT_INVALID');
    const mismatched = structuredClone(calendar.calendarCore);
    mismatched.sessions[0].marketValidTime = mismatched.sessions[1].closeUtc;
    expectThrowCode(() => buildMarketSessionCalendar({ store, calendar: mismatched }), 'MARKET_DATA_INPUT_INVALID');
  });
});

test('H13 fixture namespace is blocked from production admission', () => {
  const binding = createCalendarWindowBinding({
    calendarAuthorityPolicyId: 'sha256:' + '1'.repeat(64),
    calendarRegistryManifestId: 'sha256:' + '2'.repeat(64),
    allowedSessionKinds: [...ALLOWED_SESSION_KINDS],
    calendarNamespaceVersion: 'GATE23_FIXTURE_CALENDAR/1',
  });
  assert.equal(admitProductionCalendarWindowBinding(binding).code, 'FIXTURE_CALENDAR_NAMESPACE_FORBIDDEN');
});

test('H14 unknown authority and manifest references fail closed', () => withStore((store) => {
  const unknown = 'sha256:' + '0'.repeat(64);
  expectThrowCode(() => buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: 'MarketCalendarAuthorityPolicy/1', venueId: 'XNYS', timeZoneRulesetId: unknown,
      allowedSessionKinds: [...ALLOWED_SESSION_KINDS], calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
    },
  }), 'MARKET_DATA_REFERENCE_MISSING');
  expectThrowCode(() => verifyMarketCalendarRegistry({ store, calendarRegistryManifestId: unknown }), 'MARKET_DATA_REFERENCE_MISSING');
}));

test('H15 NYSE/Nasdaq disagreement blocks materialization', () => {
  const nyse = parseNyseCalendar2026(readFileSync(resolve(SOURCE_ROOT, 'nyse-hours-calendars.html'), 'utf8'));
  const nasdaq = parseNasdaqCalendar2026(readFileSync(resolve(SOURCE_ROOT, 'nasdaqtrader-calendar.html'), 'utf8'));
  nasdaq.fullClosureDates = nasdaq.fullClosureDates.slice(1);
  assert.throws(() => assertAuthoritiesAgree(nyse, nasdaq), /US_EQUITY_CALENDAR_AUTHORITY_CONFLICT/);
});

test('H16 exceptional closure and invalid registry supersession both fail closed', () => {
  const sweep = readJson(resolve(SOURCE_ROOT, 'EXCEPTIONAL_CLOSURE_SWEEP.json'));
  sweep.result = 'PLAUSIBLE_CHANGE_FOUND';
  sweep.candidateNotices.push({ calendarImpact: 'PLAUSIBLE_MARKET_WIDE_CHANGE' });
  assert.throws(() => assertExceptionalClosureSweep(sweep), /EXCEPTIONAL_CLOSURE_REVIEW_REQUIRED/);
  withStore((store) => {
    const { policy, calendar } = seed(store);
    expectThrowCode(() => buildMarketCalendarRegistry({
      store,
      registry: {
        schemaVersion: 'MarketCalendarRegistryManifest/1',
        calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
        calendarCoreIds: [calendar.calendarCoreId],
        supersedesCalendarRegistryManifestId: 'sha256:' + 'f'.repeat(64),
      },
    }), 'MARKET_DATA_REFERENCE_MISSING');
  });
});

test('H17 fixed UTC implementation and forbidden sessionCloseUtc primitive are absent', () => {
  const source = readFileSync(MATERIALIZER, 'utf8');
  assert.equal(source.includes('marketSession.mjs'), false);
  assert.equal(source.includes('sessionCloseUtc'), false);
  assert.equal(/T(?:13:30|14:30|18:00|20:00|21:00):00\.000Z/.test(source), false);
  assert.match(source, /deriveNewYorkUtcInstantV1\(sessionDate/);
});

test('H18 Date.now and wall-clock cutoff derivations are rejected', () => {
  const source = readFileSync(MATERIALIZER, 'utf8');
  assert.equal(source.includes('Date.now'), false);
  assert.match(source, /resolveKnowledgeCutoff/);
  assert.throws(() => createCalendarWindowBinding({
    calendarAuthorityPolicyId: 'sha256:' + '1'.repeat(64),
    calendarRegistryManifestId: 'sha256:' + '2'.repeat(64),
    allowedSessionKinds: [...ALLOWED_SESSION_KINDS],
    calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
    cutoffDerivation: '16:00',
  }), /WALL_CLOCK_CUTOFF_DERIVATION_FORBIDDEN/);
});
