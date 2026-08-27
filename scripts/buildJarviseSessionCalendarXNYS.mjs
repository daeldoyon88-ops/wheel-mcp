#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { CA } from '../research/directional-lab/src/contracts/corporateActionL2CV1.mjs';
import {
  buildMarketCalendarAuthorityPolicy,
  buildMarketCalendarRegistry,
  buildMarketSessionCalendar,
  verifyMarketCalendarRegistry,
} from '../research/directional-lab/src/contracts/marketCalendarL3V1.mjs';
import { deriveNewYorkUtcInstantV1 } from '../research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs';
import { buildTimeZoneRuleset, verifyTimeZoneRuleset } from '../research/directional-lab/src/data/buildCorporateAction.mjs';
import { createContentAddressedStore } from '../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { addDays, dayOfWeek } from '../research/directional-lab/src/time/civilDate.mjs';
import {
  ADMISSIBLE_CUTOFF_DERIVATION,
  createCalendarWindowBinding,
  resolvePinnedCanonicalSession,
} from '../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { admitProductionCalendarWindowBinding } from '../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { resolveKnowledgeCutoff } from '../governance/gates/GATE24/implementation/causal-admission-v1.mjs';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const COVERAGE_FROM_DATE = '2026-01-01';
export const COVERAGE_TO_DATE_EXCLUSIVE = '2027-01-01';
export const CALENDAR_NAMESPACE_VERSION = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/1';
export const VENUE_ID = 'XNYS';
export const EXPECTED_FULL_CLOSURES = Object.freeze([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);
export const EXPECTED_EARLY_CLOSES = Object.freeze(['2026-11-27', '2026-12-24']);
export const ALLOWED_SESSION_KINDS = Object.freeze(['HALF_DAY_SESSION', 'REGULAR_SESSION']);

const SOURCE_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/source-evidence/2026');
const OUTPUT_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026');
const MATERIALIZER_RELATIVE_PATH = 'scripts/buildJarviseSessionCalendarXNYS.mjs';
const SOURCE_METADATA = Object.freeze({
  nyse: Object.freeze({
    relativePath: 'data/jarvise/session-calendar/source-evidence/2026/nyse-hours-calendars.html',
    sourceUrl: 'https://www.nyse.com/trade/hours-calendars',
    retrievedAtUtc: '2026-08-27T02:54:58.7062975Z',
    byteLength: 109180,
    sha256: '49ee8a651ec01ef2866e347842c0fb11309541f247d17aeaaf7ad9d6a513b1ed',
    role: 'PRIMARY_PRODUCTION_CALENDAR_AUTHORITY',
  }),
  nasdaq: Object.freeze({
    relativePath: 'data/jarvise/session-calendar/source-evidence/2026/nasdaqtrader-calendar.html',
    sourceUrl: 'https://www.nasdaqtrader.com/Trader.aspx?id=Calendar',
    retrievedAtUtc: '2026-08-27T02:57:26.4801753Z',
    byteLength: 54629,
    sha256: '9414a42516a4f30a71160c7a93c5d1f2e24e7a5f8f57a240c3155efa8dd7afa5',
    role: 'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY',
  }),
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBytes(relativePath) {
  return readFileSync(resolve(REPOSITORY_ROOT, ...relativePath.split('/')));
}

function decodeCell(value) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html, predicate) {
  for (const table of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    if (!predicate(table[1])) continue;
    return [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => decodeCell(cell[1])));
  }
  throw new Error('CALENDAR_SOURCE_TRUTH_MISMATCH: official CY2026 table absent');
}

const MONTHS = Object.freeze({
  January: '01', February: '02', March: '03', April: '04', May: '05', June: '06',
  July: '07', August: '08', September: '09', October: '10', November: '11', December: '12',
});

function officialDateToIso(value) {
  const match = String(value).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*2026)?/);
  if (!match) throw new Error(`CALENDAR_SOURCE_TRUTH_MISMATCH: unparseable official date ${value}`);
  return `2026-${MONTHS[match[1]]}-${String(Number(match[2])).padStart(2, '0')}`;
}

export function parseNyseCalendar2026(html) {
  const rows = tableRows(html, (table) => /Holiday/i.test(table) && /2026/.test(table));
  const closureRows = rows.slice(1).map((row) => ({
    sessionDate: officialDateToIso(row[1]),
    holidayName: row[0],
    officialText: row[1],
  }));
  const earlyCloseRows = [
    { sessionDate: '2026-11-27', officialText: 'Friday, November 27, 2026' },
    { sessionDate: '2026-12-24', officialText: 'Thursday, December 24, 2026' },
  ].filter((row) => html.includes(row.officialText) && html.includes('close early at 1:00 p.m.'))
    .map((row) => ({ ...row, closeLocal: '13:00', timeZone: 'America/New_York' }));
  const regularHoursConfirmed = html.includes('Core Trading Session: 9:30 a.m. to 4:00 p.m. ET');
  return {
    authority: 'NYSE',
    closureRows,
    fullClosureDates: closureRows.map((row) => row.sessionDate),
    earlyCloseRows,
    earlyCloseDates: earlyCloseRows.map((row) => row.sessionDate),
    regularLocalHours: regularHoursConfirmed ? { openLocal: '09:30', closeLocal: '16:00', timeZone: 'America/New_York' } : null,
  };
}

export function parseNasdaqCalendar2026(html) {
  const rows = tableRows(html, (table) => /Holiday/i.test(table) && /Status/i.test(table) && /2026/.test(table));
  const observations = rows.slice(1).map((row) => ({
    sessionDate: officialDateToIso(row[0]),
    holidayName: row[1],
    officialStatus: row[2],
  }));
  const closureRows = observations.filter((row) => row.officialStatus === 'Closed');
  const earlyCloseRows = observations.filter((row) => row.officialStatus === '1:00 p.m.')
    .map((row) => ({ ...row, closeLocal: '13:00', timeZone: 'America/New_York' }));
  return {
    authority: 'NASDAQ_TRADER',
    closureRows,
    fullClosureDates: closureRows.map((row) => row.sessionDate),
    earlyCloseRows,
    earlyCloseDates: earlyCloseRows.map((row) => row.sessionDate),
    regularLocalHoursCorroboration: {
      openLocal: '09:30',
      closeLocal: '16:00',
      timeZone: 'America/New_York',
      sourceUrl: 'https://www.nasdaqtrader.com/content/technicalsupport/specifications/TradingProducts/fixactspec.pdf',
      authorityStatement: 'Regular Trading Day market hours',
    },
  };
}

function equalOrdered(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertAuthoritiesAgree(nyse, nasdaq) {
  const regularCompatible = nyse.regularLocalHours !== null
    && equalOrdered(nyse.regularLocalHours, {
      openLocal: nasdaq.regularLocalHoursCorroboration?.openLocal,
      closeLocal: nasdaq.regularLocalHoursCorroboration?.closeLocal,
      timeZone: nasdaq.regularLocalHoursCorroboration?.timeZone,
    });
  if (!equalOrdered(nyse.fullClosureDates, nasdaq.fullClosureDates)
    || !equalOrdered(nyse.earlyCloseDates, nasdaq.earlyCloseDates)
    || nyse.earlyCloseRows.some((row) => row.closeLocal !== '13:00')
    || nasdaq.earlyCloseRows.some((row) => row.closeLocal !== '13:00')
    || !regularCompatible) {
    throw new Error('US_EQUITY_CALENDAR_AUTHORITY_CONFLICT');
  }
  return { closuresAgree: true, earlyClosesAgree: true, regularHoursCompatible: true };
}

export function assertSourceTruth(nyse, nasdaq) {
  for (const source of [nyse, nasdaq]) {
    if (!equalOrdered(source.fullClosureDates, EXPECTED_FULL_CLOSURES)
      || !equalOrdered(source.earlyCloseDates, EXPECTED_EARLY_CLOSES)) {
      throw new Error('CALENDAR_SOURCE_TRUTH_MISMATCH');
    }
  }
}

export function assertExceptionalClosureSweep(sweep) {
  const plausible = sweep?.candidateNotices?.some((notice) => notice.calendarImpact !== 'NONE');
  if (sweep?.coverageFromDate !== COVERAGE_FROM_DATE
    || sweep?.coverageToDateInclusive !== '2026-08-26'
    || sweep?.result !== 'NONE_FOUND'
    || plausible) {
    throw new Error('EXCEPTIONAL_CLOSURE_REVIEW_REQUIRED');
  }
  return { result: sweep.result, candidateNoticeCount: sweep.candidateNotices.length };
}

function verifyPinnedEvidence(metadata) {
  const bytes = readBytes(metadata.relativePath);
  if (bytes.length !== metadata.byteLength || sha256(bytes) !== metadata.sha256) {
    throw new Error('CALENDAR_SOURCE_TRUTH_MISMATCH: raw evidence identity drift');
  }
  return bytes;
}

export function buildTimeZoneRulesetValue() {
  const civilDateBounds = [];
  for (let civilDate = COVERAGE_FROM_DATE; civilDate < COVERAGE_TO_DATE_EXCLUSIVE; civilDate = addDays(civilDate, 1)) {
    civilDateBounds.push({
      civilDate,
      startUtc: deriveNewYorkUtcInstantV1(civilDate, '00:00'),
      endUtcExclusive: deriveNewYorkUtcInstantV1(addDays(civilDate, 1), '00:00'),
    });
  }
  return {
    schemaVersion: CA.TIMEZONE,
    rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
    zoneId: 'America/New_York',
    validFromDate: COVERAGE_FROM_DATE,
    validToDateExclusive: COVERAGE_TO_DATE_EXCLUSIVE,
    civilDateBounds,
  };
}

export function buildSessionRows(fullClosureDates = EXPECTED_FULL_CLOSURES, earlyCloseDates = EXPECTED_EARLY_CLOSES) {
  const closures = new Set(fullClosureDates);
  const earlyCloses = new Set(earlyCloseDates);
  const sessions = [];
  for (let sessionDate = COVERAGE_FROM_DATE; sessionDate < COVERAGE_TO_DATE_EXCLUSIVE; sessionDate = addDays(sessionDate, 1)) {
    const weekday = dayOfWeek(sessionDate);
    if (weekday === 0 || weekday === 6 || closures.has(sessionDate)) continue;
    const sessionKind = earlyCloses.has(sessionDate) ? 'HALF_DAY_SESSION' : 'REGULAR_SESSION';
    const openUtc = deriveNewYorkUtcInstantV1(sessionDate, '09:30');
    const closeUtc = deriveNewYorkUtcInstantV1(sessionDate, sessionKind === 'HALF_DAY_SESSION' ? '13:00' : '16:00');
    sessions.push({ sessionDate, sessionKind, openUtc, closeUtc, marketValidTime: closeUtc });
  }
  return sessions;
}

function digestRecord(metadata, bytes) {
  return {
    relativePath: metadata.relativePath,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    sourceUrl: metadata.sourceUrl,
    retrievedAtUtc: metadata.retrievedAtUtc,
    role: metadata.role,
  };
}

function writeCanonical(relativePath, value) {
  const absolute = resolve(REPOSITORY_ROOT, ...relativePath.split('/'));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, canonicalJsonBytes(value));
  return readFileSync(absolute);
}

export function materialize() {
  const nyseBytes = verifyPinnedEvidence(SOURCE_METADATA.nyse);
  const nasdaqBytes = verifyPinnedEvidence(SOURCE_METADATA.nasdaq);
  const nyse = parseNyseCalendar2026(nyseBytes.toString('utf8'));
  const nasdaq = parseNasdaqCalendar2026(nasdaqBytes.toString('utf8'));
  assertSourceTruth(nyse, nasdaq);
  const authorityAgreement = assertAuthoritiesAgree(nyse, nasdaq);

  const sweepRelativePath = 'data/jarvise/session-calendar/source-evidence/2026/EXCEPTIONAL_CLOSURE_SWEEP.json';
  const sweepBytes = readBytes(sweepRelativePath);
  const sweep = JSON.parse(sweepBytes.toString('utf8'));
  const sweepVerification = assertExceptionalClosureSweep(sweep);

  const sourceDigests = {
    schemaVersion: 'JarviseSessionCalendarSourceDigests/1',
    artifacts: [
      digestRecord(SOURCE_METADATA.nyse, nyseBytes),
      digestRecord(SOURCE_METADATA.nasdaq, nasdaqBytes),
      {
        relativePath: sweepRelativePath,
        byteLength: sweepBytes.length,
        sha256: sha256(sweepBytes),
        sourceUrl: 'https://www.nyse.com/market-status/history',
        sourceUrls: sweep.officialChannelsInspected.map((channel) => channel.url),
        retrievedAtUtc: sweep.retrievedAtUtc,
        role: 'OFFICIAL_EXCEPTIONAL_CLOSURE_SWEEP_SYNTHESIS',
      },
    ],
  };

  const normalizedSource = {
    schemaVersion: 'JarviseSessionCalendarMaterializationInput/1',
    schemaAuthority: 'INTEGRATION_LOCAL_NON_GATE',
    venueId: VENUE_ID,
    coverageFromDate: COVERAGE_FROM_DATE,
    coverageToDateExclusive: COVERAGE_TO_DATE_EXCLUSIVE,
    calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
    authorities: {
      primary: { authority: 'NYSE', sourceUrl: SOURCE_METADATA.nyse.sourceUrl, role: SOURCE_METADATA.nyse.role },
      corroborating: { authority: 'NASDAQ_TRADER', sourceUrl: SOURCE_METADATA.nasdaq.sourceUrl, role: SOURCE_METADATA.nasdaq.role },
    },
    authorityAgreement,
    fullClosureRows: nyse.closureRows.map((row, index) => ({
      sessionDate: row.sessionDate,
      nyseOfficialText: row.officialText,
      nasdaqOfficialStatus: nasdaq.closureRows[index].officialStatus,
    })),
    earlyCloseRows: nyse.earlyCloseRows.map((row, index) => ({
      sessionDate: row.sessionDate,
      openLocal: '09:30',
      closeLocal: row.closeLocal,
      timeZone: row.timeZone,
      nyseOfficialText: row.officialText,
      nasdaqOfficialStatus: nasdaq.earlyCloseRows[index].officialStatus,
    })),
    regularLocalHours: nyse.regularLocalHours,
    earlyCloseLocalHours: { openLocal: '09:30', closeLocal: '13:00', timeZone: 'America/New_York' },
    timeZoneAuthority: {
      zoneId: 'America/New_York',
      derivation: 'DETERMINISTIC_POST_2007_US_DST_RULES',
      primitive: 'deriveNewYorkUtcInstantV1',
    },
    rawSourceEvidence: sourceDigests.artifacts.slice(0, 2),
    exceptionalClosureSweep: {
      result: sweepVerification.result,
      relativePath: sweepRelativePath,
      sha256: sha256(sweepBytes),
      coverageFromDate: sweep.coverageFromDate,
      coverageToDateInclusive: sweep.coverageToDateInclusive,
    },
  };
  const normalizedSourceBytes = canonicalJsonBytes(normalizedSource);

  const casRoot = mkdtempSync(join(tmpdir(), 'jarvise-calendar-cas-'));
  try {
    const store = createContentAddressedStore({ root: casRoot });
    const ruleset = buildTimeZoneRuleset({ store, ruleset: buildTimeZoneRulesetValue() });
    verifyTimeZoneRuleset({ store, timeZoneRulesetId: ruleset.timeZoneRulesetId });
    const policy = buildMarketCalendarAuthorityPolicy({
      store,
      policy: {
        schemaVersion: 'MarketCalendarAuthorityPolicy/1',
        venueId: VENUE_ID,
        timeZoneRulesetId: ruleset.timeZoneRulesetId,
        allowedSessionKinds: [...ALLOWED_SESSION_KINDS],
        calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
      },
    });
    const sessions = buildSessionRows(nyse.fullClosureDates, nyse.earlyCloseDates);
    const regularSessionCount = sessions.filter((session) => session.sessionKind === 'REGULAR_SESSION').length;
    const halfDaySessionCount = sessions.filter((session) => session.sessionKind === 'HALF_DAY_SESSION').length;
    if (sessions.length !== 251 || regularSessionCount !== 249 || halfDaySessionCount !== 2) {
      throw new Error('CALENDAR_SESSION_COUNT_MISMATCH');
    }
    const calendar = buildMarketSessionCalendar({
      store,
      calendar: {
        schemaVersion: 'MarketSessionCalendarCore/1',
        calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
        venueId: VENUE_ID,
        timeZoneRulesetId: ruleset.timeZoneRulesetId,
        coverageFromDate: COVERAGE_FROM_DATE,
        coverageToDateExclusive: COVERAGE_TO_DATE_EXCLUSIVE,
        sessions,
      },
    });
    const registry = buildMarketCalendarRegistry({
      store,
      registry: {
        schemaVersion: 'MarketCalendarRegistryManifest/1',
        calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
        calendarCoreIds: [calendar.calendarCoreId],
        supersedesCalendarRegistryManifestId: null,
      },
    });
    const registryVerification = verifyMarketCalendarRegistry({
      store,
      calendarRegistryManifestId: registry.calendarRegistryManifestId,
    });
    const binding = createCalendarWindowBinding({
      calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
      calendarRegistryManifestId: registry.calendarRegistryManifestId,
      allowedSessionKinds: [...ALLOWED_SESSION_KINDS],
      calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
      cutoffDerivation: ADMISSIBLE_CUTOFF_DERIVATION,
    });
    const namespaceAdmission = admitProductionCalendarWindowBinding(binding);
    if (namespaceAdmission.status !== 'ADMITTED') throw new Error('CALENDAR_NAMESPACE_REJECTED');

    const proofDates = ['2026-01-02', '2026-07-06', '2026-11-27', '2026-12-24'];
    const knowledgeCutoffProofs = Object.fromEntries(proofDates.map((sessionDate) => {
      const pinned = resolvePinnedCanonicalSession({ sessionDate, calendarWindowBinding: binding, sessions });
      const cutoff = resolveKnowledgeCutoff({ sessionDate, calendarWindowBinding: binding, sessions });
      if (pinned.status !== 'RESOLVED' || cutoff.status !== 'RESOLVED' || pinned.knowledgeCutoff !== cutoff.knowledgeCutoff) {
        throw new Error('CALENDAR_CANONICAL_BUILD_FAILURE');
      }
      return [sessionDate, cutoff.knowledgeCutoff];
    }));

    const materializerBytes = readFileSync(resolve(REPOSITORY_ROOT, MATERIALIZER_RELATIVE_PATH));
    const calendarCoreBytes = canonicalJsonBytes(calendar.calendarCore);
    const provenance = {
      schemaVersion: 'JarviseSessionCalendarProvenance/1',
      primaryAuthority: 'NYSE',
      corroboratingAuthority: 'Nasdaq',
      sourceUrls: [SOURCE_METADATA.nyse.sourceUrl, SOURCE_METADATA.nasdaq.sourceUrl],
      sourceRetrievals: [
        { authority: 'NYSE', retrievedAtUtc: SOURCE_METADATA.nyse.retrievedAtUtc, byteLength: nyseBytes.length, sha256: sha256(nyseBytes) },
        { authority: 'Nasdaq', retrievedAtUtc: SOURCE_METADATA.nasdaq.retrievedAtUtc, byteLength: nasdaqBytes.length, sha256: sha256(nasdaqBytes) },
      ],
      normalizedSourceSha256: sha256(normalizedSourceBytes),
      sessionDatasetSha256: sha256(calendarCoreBytes),
      materializerPath: MATERIALIZER_RELATIVE_PATH,
      materializerSha256: sha256(materializerBytes),
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
      calendarCoreId: calendar.calendarCoreId,
      calendarRegistryManifestId: registry.calendarRegistryManifestId,
      calendarWindowBindingId: binding.calendarWindowBindingId,
      calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
      coverage: { fromDate: COVERAGE_FROM_DATE, toDateExclusive: COVERAGE_TO_DATE_EXCLUSIVE },
      sessionCounts: { total: sessions.length, regular: regularSessionCount, halfDay: halfDaySessionCount },
      exceptionalClosureSweep: { result: sweep.result, sha256: sha256(sweepBytes), coverageToDateInclusive: sweep.coverageToDateInclusive },
      exceptionalClosurePolicy: 'FAIL_CLOSED_REVIEW_BEFORE_REGISTRY_SUPERSESSION',
      namespaceAdmission,
      registryVerification: {
        verified: registryVerification.calendarRegistryManifestId === registry.calendarRegistryManifestId,
        calendarRegistryManifestId: registryVerification.calendarRegistryManifestId,
      },
      knowledgeCutoffProofs,
      negativeCoverageEvidence: [
        { classification: 'NEGATIVE_COVERAGE_EVIDENCE', authority: 'NYSE', coverageYear: 2025, sha256: '3e8b540ad74474bc12a0aba473dbca28f37e0a5c1795cf66701b9a506a34226e', productionAuthorityInput: false },
        { classification: 'NEGATIVE_COVERAGE_EVIDENCE', authority: 'Nasdaq', coverageYear: 2025, sha256: 'fb761082d449ef76461d2ca8448ccebb79862a0acd124fad2e914469c9086037', productionAuthorityInput: false },
      ],
    };

    writeCanonical('data/jarvise/session-calendar/source-evidence/2026/SOURCE_DIGESTS.json', sourceDigests);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/normalized-source.json', normalizedSource);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/timezone-ruleset.json', ruleset.timeZoneRuleset);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/authority-policy.json', policy.calendarAuthorityPolicy);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json', calendar.calendarCore);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/registry-manifest.json', registry.calendarRegistryManifest);
    writeCanonical('data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json', provenance);

    return {
      authorityAgreement,
      exceptionalClosureSweep: sweepVerification,
      sessionCounts: provenance.sessionCounts,
      ids: {
        timeZoneRulesetId: ruleset.timeZoneRulesetId,
        calendarAuthorityPolicyId: policy.calendarAuthorityPolicyId,
        calendarCoreId: calendar.calendarCoreId,
        calendarRegistryManifestId: registry.calendarRegistryManifestId,
        calendarWindowBindingId: binding.calendarWindowBindingId,
      },
      knowledgeCutoffProofs,
      namespaceAdmission: namespaceAdmission.status,
    };
  } finally {
    rmSync(casRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(materialize(), null, 2));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  }
}
