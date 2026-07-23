/**
 * Synthetic L4B-F2 official fixture. Extends the F1 rate/FOMC/curve dataset with
 * point-in-time CPI (US.BLS.CPIAUCSL), UNRATE (US.BLS.UNRATE) and initial claims
 * (US.BLS.ICSA), and an L2B instrument identity registry (US equity, US ETF,
 * a non-US instrument and a partially listed US equity). All values are
 * fabricated offline SYNTHETIC_TEST_FIXTURE data; no network, no wall clock.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { buildTimeZoneRuleset } from '../src/data/corporateActionBuildersCore.mjs';
import {
  MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
  buildMarketCalendarAuthorityPolicy,
  buildMarketCalendarRegistry,
  buildMarketSessionCalendar,
} from '../src/contracts/marketCalendarL3V1.mjs';
import { addDays, dayOfWeek } from '../src/time/civilDate.mjs';
import { sessionCloseUtc, sessionOpenUtc } from '../src/time/marketSession.mjs';
import { sha256Digest } from '../src/contracts/marketDataL3CommonV1.mjs';
import { MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION } from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { F1_SERIES_CODES } from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  F2_CPI_SERIES_CODE,
  F2_UNRATE_SERIES_CODE,
  F2_CLAIMS_SERIES_CODE,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import { withMacroStore, pinSyntheticSourceDocument } from './macroIngestionL4BSyntheticFixture.mjs';
import { buildMacroIngestionPolicy } from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  buildMacroSeriesIdentityCore,
  buildMacroSeriesRegistryGenesis,
} from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  buildMacroObservationIdentityCore,
  buildMacroObservationVintageCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import { buildMacroVintageSetManifest } from '../src/macro/macroVintageSetL4BV1.mjs';
import { buildMacroDatasetSnapshotManifest } from '../src/macro/macroDatasetSnapshotL4BV1.mjs';
import { buildMacroAsOfResolutionPolicy } from '../src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { buildMacroReleaseCalendarRegistryGenesis } from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { buildMacroDatasetBinding } from '../src/macro/macroDatasetBindingL4BV1.mjs';
import { buildMacroMaterializationReport } from '../src/macro/macroMaterializationReportL4BV1.mjs';
import { buildMarketMacroFeatureComputationPolicy } from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { buildMarketMacroFeatureSourceBundle } from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { buildMacroStateBySessionRows } from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import { buildMarketMacroFeatureComputationReport } from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';
import {
  buildInstrumentIdentity,
  buildInstrumentDescriptor,
  buildInstrumentAliasBinding,
  buildInstrumentIdentityManifest,
  buildInstrumentIdentityRegistry,
  buildInstrumentIdentityAuthorityPolicy,
  buildSymbolNamespacePolicy,
} from '../src/data/buildInstrumentIdentity.mjs';
import { buildMarketMacroInstrumentProjectionPolicy } from '../src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { buildMarketMacroFullStateRows } from '../src/macro/marketMacroFullStateRowsL4BF2V1.mjs';
import { buildMarketMacroInstrumentRows } from '../src/macro/marketMacroInstrumentRowsL4BF2V1.mjs';
import { buildMarketMacroFullComputationReport } from '../src/macro/marketMacroFullComputationReportL4BF2V1.mjs';

export { code, withMacroStore } from './macroIngestionL4BSyntheticFixture.mjs';

function methodologyId(code) {
  return sha256Digest(`SYNTHETIC_TEST_FIXTURE L4B-F2 methodology ${code} v1`);
}

const F2_SERIES_DEFINITIONS = Object.freeze({
  'US.FRB.DFEDTARL': { sourceAuthority: 'FRB', frequency: 'EVENT', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'FRB' },
  'US.FRB.DFEDTARU': { sourceAuthority: 'FRB', frequency: 'EVENT', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'FRB' },
  'US.NYFED.EFFR': { sourceAuthority: 'NY_FED', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_AVERAGE', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'NY_FED' },
  'US.NYFED.SOFR': { sourceAuthority: 'NY_FED', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_AVERAGE', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'NY_FED' },
  'US.TREAS.DGS3MO': { sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY' },
  'US.TREAS.DGS2': { sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY' },
  'US.TREAS.DGS5': { sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY' },
  'US.TREAS.DGS10': { sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY' },
  'US.TREAS.DGS30': { sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END', revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY' },
  'US.FOMC.DECISION': { sourceAuthority: 'FRB', frequency: 'EVENT', units: 'RATE_RANGE_BOUND', seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT', revisionPolicy: 'PUBLICATION_ATTESTED', releaseAuthority: 'FRB' },
  'US.BLS.CPIAUCSL': { sourceAuthority: 'BLS', frequency: 'MONTHLY', units: 'INDEX', seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_AVERAGE', revisionPolicy: 'VINTAGE_PARTIAL', releaseAuthority: 'BLS' },
  'US.BLS.UNRATE': { sourceAuthority: 'BLS', frequency: 'MONTHLY', units: 'PERCENT', seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_AVERAGE', revisionPolicy: 'VINTAGE_PARTIAL', releaseAuthority: 'BLS' },
  'US.BLS.ICSA': { sourceAuthority: 'BLS', frequency: 'WEEKLY', units: 'COUNT', seasonalAdjustment: 'SEASONALLY_ADJUSTED', observationConvention: 'PERIOD_TOTAL', revisionPolicy: 'VINTAGE_PARTIAL', releaseAuthority: 'BLS' },
});

const F2_SERIES_CODES_ALL = Object.freeze([...F1_SERIES_CODES, F2_CPI_SERIES_CODE, F2_UNRATE_SERIES_CODE, F2_CLAIMS_SERIES_CODE]);

function seriesIdentity(code) {
  const def = F2_SERIES_DEFINITIONS[code];
  return {
    schemaVersion: MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
    jurisdictionCode: 'UNITED_STATES', currencyCode: 'USD', canonicalSeriesCode: code,
    ...def, methodologyVersionId: methodologyId(code), validFrom: '2020-01-01', validThrough: null,
  };
}

function lastDayOfMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const firstNext = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return addDays(firstNext, -1);
}

/** Sessions: monthly mid-month plus a post-DST day and a half-day. */
function buildF2Sessions() {
  const monthly = [
    '2025-05-15', '2025-07-15', '2025-09-15', '2025-12-15',
    '2026-01-15', '2026-02-17', '2026-03-16',
  ];
  const sessions = monthly.map((date) => ({
    sessionDate: date, sessionKind: 'REGULAR_SESSION',
    openUtc: sessionOpenUtc(date), closeUtc: sessionCloseUtc(date),
    marketValidTime: sessionCloseUtc(date),
  }));
  // Post-DST boundary session (DST starts 2025-03-09).
  sessions.push({
    sessionDate: '2025-03-10', sessionKind: 'REGULAR_SESSION',
    openUtc: sessionOpenUtc('2025-03-10'), closeUtc: sessionCloseUtc('2025-03-10'),
    marketValidTime: sessionCloseUtc('2025-03-10'),
  });
  // Half-day session (13:00 ET early close), DST in effect.
  sessions.push({
    sessionDate: '2025-11-28', sessionKind: 'HALF_DAY_SESSION',
    openUtc: sessionOpenUtc('2025-11-28'), closeUtc: '2025-11-28T18:00:00.000Z',
    marketValidTime: '2025-11-28T18:00:00.000Z',
  });
  sessions.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
  return sessions;
}

function buildF2Calendar(store, sessions) {
  const coverageFrom = '2025-03-01';
  const coverageToExclusive = '2026-03-21';
  const civilDates = [];
  for (let cursor = coverageFrom; cursor < coverageToExclusive; cursor = addDays(cursor, 1)) {
    civilDates.push(cursor);
  }
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: 'TimeZoneRuleset/1', rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l4b-f2', validFromDate: coverageFrom,
      validToDateExclusive: coverageToExclusive,
      civilDateBounds: civilDates.map((civilDate) => ({
        civilDate, startUtc: `${civilDate}T05:00:00.000Z`,
        endUtcExclusive: `${addDays(civilDate, 1)}T05:00:00.000Z`,
      })),
    },
  });
  const calendarPolicy = buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION, venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
      calendarNamespaceVersion: 'synthetic-l4b-f2/1',
    },
  });
  const calendar = buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId, venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId, coverageFromDate: coverageFrom,
      coverageToDateExclusive: coverageToExclusive, sessions,
    },
  });
  return buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [calendar.calendarCoreId], supersedesCalendarRegistryManifestId: null,
    },
  });
}

// Monthly CPI index path (scale 3) keyed by month, plus the F2 release day.
const CPI_MONTHS = [
  ['2024-12', 300000], ['2025-01', 300600], ['2025-02', 301500], ['2025-03', 302100],
  ['2025-04', 302700], ['2025-05', 303300], ['2025-06', 303900], ['2025-07', 304500],
  ['2025-08', 305100], ['2025-09', 305700], ['2025-10', 306300], ['2025-11', 306900],
  ['2025-12', 307200], ['2026-01', 307400],
];
const UNRATE_MONTHS = [
  ['2024-12', 41], ['2025-01', 42], ['2025-02', 43], ['2025-03', 43], ['2025-04', 42],
  ['2025-05', 41], ['2025-06', 41], ['2025-07', 40], ['2025-08', 40], ['2025-09', 41],
  ['2025-10', 42], ['2025-11', 42], ['2025-12', 43], ['2026-01', 44],
];

/** CPI release: 14th of month M+1. UNRATE: 6th of M+1. */
function monthReleaseDate(monthKey, day) {
  const [y, m] = monthKey.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Weekly claims value function: a spike week, an elevated week, else a base path. */
function claimsValueFor(weekEnd) {
  if (weekEnd === '2026-01-10') return 420000; // SPIKE
  if (weekEnd === '2025-09-06') return 320000; // ELEVATED
  const day = Number(weekEnd.slice(8, 10));
  return 210000 + (day % 4) * 5000; // 210000..225000 normal band
}

export function buildOfficialMacroL4BF2Context(store, options = {}) {
  const includeF2Observations = options.includeF2Observations !== false;
  const emptySessions = options.emptySessions === true;
  const emptyInstrumentRegistry = options.emptyInstrumentRegistry === true;
  const reverseInsertion = options.reverseInsertion === true;
  const policyBuild = buildMacroIngestionPolicy({ store });
  const policy = policyBuild.macroIngestionPolicy;
  const series = {};
  const seriesCodes = reverseInsertion ? [...F2_SERIES_CODES_ALL].reverse() : F2_SERIES_CODES_ALL;
  for (const code of seriesCodes) {
    series[code] = buildMacroSeriesIdentityCore({ store, identity: seriesIdentity(code) });
  }
  const registry = buildMacroSeriesRegistryGenesis({
    store,
    entries: F2_SERIES_CODES_ALL.map((code) => ({
      macroSeriesIdentityId: series[code].macroSeriesIdentityId,
      canonicalSeriesCode: code, status: 'ACTIVE',
      supersedesSeriesIdentityId: null, replacementReason: null,
    })),
  });

  const sessions = buildF2Sessions();
  const calendarRegistry = buildF2Calendar(store, sessions);
  const docs = {
    base: pinSyntheticSourceDocument(store, 'f2-base'),
    revision: pinSyntheticSourceDocument(store, 'f2-revision'),
    future: pinSyntheticSourceDocument(store, 'f2-future-noise'),
  };
  if (options.addCasNoise === true) pinSyntheticSourceDocument(store, 'f2-unreferenced-cas-noise');

  const observationVintageIds = [];
  const vintage = (options) => buildMacroObservationVintageCore({ store, policy, ...options });

  const addEventOrDaily = (code, date, atoms) => {
    const obs = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: 'MacroObservationIdentityCore/1',
        macroSeriesIdentityId: series[code].macroSeriesIdentityId,
        unit: series[code].macroSeriesIdentity.units,
        seasonalAdjustment: series[code].macroSeriesIdentity.seasonalAdjustment,
        observationPeriodStart: date, observationPeriodEnd: date, referencePeriod: date,
      },
    });
    observationVintageIds.push(vintage({
      series: series[code].macroSeriesIdentity, observationIdentityId: obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: date, vintageSequence: 0, value: { atoms: String(atoms), scale: 2 },
      revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE', sourceDocumentId: docs.base,
    }).observationVintageId);
  };

  // Minimal F1 rate/curve/FOMC path: fed target before the range (never stale),
  // and a small set of daily prints carried forward across sessions.
  addEventOrDaily('US.FRB.DFEDTARL', '2025-02-01', 425);
  addEventOrDaily('US.FRB.DFEDTARU', '2025-02-01', 450);
  for (const date of ['2025-05-01', '2025-09-01', '2026-01-02']) {
    addEventOrDaily('US.NYFED.EFFR', date, 433);
    addEventOrDaily('US.NYFED.SOFR', date, 430);
    addEventOrDaily('US.TREAS.DGS3MO', date, 420);
    addEventOrDaily('US.TREAS.DGS2', date, 400);
    addEventOrDaily('US.TREAS.DGS5', date, 405);
    addEventOrDaily('US.TREAS.DGS10', date, 415);
    addEventOrDaily('US.TREAS.DGS30', date, 445);
  }

  const addMonthly = (code, monthKey, atoms, scale, releaseDay, opts = {}) => {
    const obs = buildMacroObservationIdentityCore({
      store,
      identity: {
        schemaVersion: 'MacroObservationIdentityCore/1',
        macroSeriesIdentityId: series[code].macroSeriesIdentityId,
        unit: series[code].macroSeriesIdentity.units,
        seasonalAdjustment: series[code].macroSeriesIdentity.seasonalAdjustment,
        observationPeriodStart: `${monthKey}-01`,
        observationPeriodEnd: lastDayOfMonth(monthKey), referencePeriod: monthKey,
      },
    });
    const built = vintage({
      series: series[code].macroSeriesIdentity, observationIdentityId: obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: monthReleaseDate(monthKey, releaseDay), vintageSequence: 0,
      value: { atoms: String(atoms), scale }, revisionKind: 'INITIAL', parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.base,
    });
    observationVintageIds.push(built.observationVintageId);
    return { obs, built };
  };

  if (includeF2Observations) {
    const cpiBuilt = {};
    const unrateBuilt = {};
    const claimsBuilt = {};
    for (const [monthKey, atoms] of CPI_MONTHS) {
      cpiBuilt[monthKey] = addMonthly(F2_CPI_SERIES_CODE, monthKey, atoms, 3, 14);
    }
    for (const [monthKey, atoms] of UNRATE_MONTHS) {
      unrateBuilt[monthKey] = addMonthly(F2_UNRATE_SERIES_CODE, monthKey, atoms, 1, 6);
    }

    // Weekly claims: Saturdays from 2024-11-30 through 2026-03-14, released +5 days.
    const weekEnds = [];
    {
      const start = '2024-11-30';
      const offset = (6 - dayOfWeek(start) + 7) % 7;
      for (let cursor = addDays(start, offset); cursor <= '2026-03-14'; cursor = addDays(cursor, 7)) {
        weekEnds.push(cursor);
      }
    }
    for (const weekEnd of weekEnds) {
      const obs = buildMacroObservationIdentityCore({
        store,
        identity: {
          schemaVersion: 'MacroObservationIdentityCore/1',
          macroSeriesIdentityId: series[F2_CLAIMS_SERIES_CODE].macroSeriesIdentityId,
          unit: 'COUNT', seasonalAdjustment: 'SEASONALLY_ADJUSTED',
          observationPeriodStart: addDays(weekEnd, -6), observationPeriodEnd: weekEnd,
          referencePeriod: weekEnd,
        },
      });
      claimsBuilt[weekEnd] = vintage({
        series: series[F2_CLAIMS_SERIES_CODE].macroSeriesIdentity,
        observationIdentityId: obs.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
        releaseCivilDate: addDays(weekEnd, 5), vintageSequence: 0,
        value: { atoms: String(claimsValueFor(weekEnd)), scale: 0 }, revisionKind: 'INITIAL',
        parentVintageId: null, vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.base,
      });
      observationVintageIds.push(claimsBuilt[weekEnd].observationVintageId);
    }

    // A used CPI revision (2025-06 revised, available before later sessions but
    // after the 2025-06/07 sessions saw the initial print).
    observationVintageIds.push(vintage({
      series: series[F2_CPI_SERIES_CODE].macroSeriesIdentity,
      observationIdentityId: cpiBuilt['2025-06'].obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: '2025-08-14', vintageSequence: 1,
      value: { atoms: '303950', scale: 3 }, revisionKind: 'REVISION',
      parentVintageId: cpiBuilt['2025-06'].built.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.revision,
    }).observationVintageId);
    // A current CPI revision, published before the 2026-02-17 close, is
    // intentionally consumed by that session and proves revision selection.
    observationVintageIds.push(vintage({
      series: series[F2_CPI_SERIES_CODE].macroSeriesIdentity,
      observationIdentityId: cpiBuilt['2026-01'].obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: '2026-02-16', vintageSequence: 1,
      value: { atoms: '307450', scale: 3 }, revisionKind: 'REVISION',
      parentVintageId: cpiBuilt['2026-01'].built.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.revision,
    }).observationVintageId);
    // Three after-range revisions remain pinned in the immutable vintage set
    // but are causally inadmissible to every official session.
    observationVintageIds.push(vintage({
      series: series[F2_CPI_SERIES_CODE].macroSeriesIdentity,
      observationIdentityId: cpiBuilt['2025-12'].obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: '2026-04-01', vintageSequence: 1,
      value: { atoms: '999999', scale: 3 }, revisionKind: 'REVISION',
      parentVintageId: cpiBuilt['2025-12'].built.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.future,
    }).observationVintageId);
    observationVintageIds.push(vintage({
      series: series[F2_UNRATE_SERIES_CODE].macroSeriesIdentity,
      observationIdentityId: unrateBuilt['2026-01'].obs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: '2026-04-01', vintageSequence: 1,
      value: { atoms: '99', scale: 1 }, revisionKind: 'REVISION',
      parentVintageId: unrateBuilt['2026-01'].built.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.future,
    }).observationVintageId);
    observationVintageIds.push(vintage({
      series: series[F2_CLAIMS_SERIES_CODE].macroSeriesIdentity,
      observationIdentityId: claimsBuilt['2026-01-10'].observationVintage.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY', releaseTimestamp: null,
      releaseCivilDate: '2026-04-01', vintageSequence: 1,
      value: { atoms: '999999', scale: 0 }, revisionKind: 'REVISION',
      parentVintageId: claimsBuilt['2026-01-10'].macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_PARTIAL', sourceDocumentId: docs.future,
    }).observationVintageId);
    // A future CPI observation (2026-04, released 2026-05-14): anti-lookahead noise,
    // never resolved by any session in range.
    addMonthly(F2_CPI_SERIES_CODE, '2026-04', 308500, 3, 14);
  }

  const vintageSet = buildMacroVintageSetManifest({
    store, macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
    supersedesVintageSetManifestId: null,
    observationVintageIds: reverseInsertion ? [...observationVintageIds].reverse() : observationVintageIds,
  });
  const snapshot = buildMacroDatasetSnapshotManifest({
    store, macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
  });
  const asOf = buildMacroAsOfResolutionPolicy({ store });
  const releaseCalendar = buildMacroReleaseCalendarRegistryGenesis({
    store, macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES', currencyCode: 'USD', orderedReleaseEventVersions: [],
  });
  const knowledgeCutoff = '2026-03-17T00:00:00.000Z';
  const binding = buildMacroDatasetBinding({
    store, macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: releaseCalendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff,
  });
  const materialization = buildMacroMaterializationReport({
    store, macroDatasetBindingId: binding.macroDatasetBindingId,
  });
  const featurePolicy = buildMarketMacroFeatureComputationPolicy({ store });
  const sourceBundle = buildMarketMacroFeatureSourceBundle({
    store, macroDatasetBindingId: binding.macroDatasetBindingId,
    macroMaterializationReportId: materialization.macroMaterializationReportId,
    marketCalendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
    featureComputationStartSessionDate: emptySessions ? '2025-04-01' : '2025-03-10',
    featureComputationEndSessionDateInclusive: emptySessions ? '2025-04-02' : '2026-03-16',
  });
  const f1Rows = buildMacroStateBySessionRows({
    store, sourceBundleId: sourceBundle.sourceBundleId,
    featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
  });
  const f1Report = buildMarketMacroFeatureComputationReport({
    store, sourceBundleId: sourceBundle.sourceBundleId,
    featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    macroStateBySessionRowsId: f1Rows.macroStateBySessionRowsId,
  });

  const instrumentRegistry = buildInstrumentUniverse(store, {
    empty: emptyInstrumentRegistry,
    reverseInsertion,
  });

  const projectionPolicy = buildMarketMacroInstrumentProjectionPolicy({ store });
  const fullRows = buildMarketMacroFullStateRows({
    store,
    f1MacroStateBySessionRowsId: f1Rows.macroStateBySessionRowsId,
    f1SourceBundleId: sourceBundle.sourceBundleId,
    f1FeatureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    f1MacroFeatureComputationReportId: f1Report.macroFeatureComputationReportId,
    instrumentProjectionPolicyId: projectionPolicy.instrumentProjectionPolicyId,
  });
  const instrumentRows = buildMarketMacroInstrumentRows({
    store,
    fullStateRowsId: fullRows.fullStateRowsId,
    f1MacroStateBySessionRowsId: f1Rows.macroStateBySessionRowsId,
    f1SourceBundleId: sourceBundle.sourceBundleId,
    f1FeatureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    f1MacroFeatureComputationReportId: f1Report.macroFeatureComputationReportId,
    instrumentProjectionPolicyId: projectionPolicy.instrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
  });
  const fullReport = buildMarketMacroFullComputationReport({
    store,
    fullStateRowsId: fullRows.fullStateRowsId,
    instrumentRowsId: instrumentRows.instrumentRowsId,
    f1MacroStateBySessionRowsId: f1Rows.macroStateBySessionRowsId,
    f1SourceBundleId: sourceBundle.sourceBundleId,
    f1FeatureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    f1MacroFeatureComputationReportId: f1Report.macroFeatureComputationReportId,
    instrumentProjectionPolicyId: projectionPolicy.instrumentProjectionPolicyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
  });

  return {
    store, series, registry, sessions, calendarRegistry, binding, materialization,
    featurePolicy, sourceBundle, f1Rows, f1Report, knowledgeCutoff, vintageSet,
    instrumentRegistry, projectionPolicy, fullRows, instrumentRows, fullReport,
    f1Ids: {
      f1MacroStateBySessionRowsId: f1Rows.macroStateBySessionRowsId,
      f1SourceBundleId: sourceBundle.sourceBundleId,
      f1FeatureComputationPolicyId: featurePolicy.featureComputationPolicyId,
      f1MacroFeatureComputationReportId: f1Report.macroFeatureComputationReportId,
      instrumentProjectionPolicyId: projectionPolicy.instrumentProjectionPolicyId,
      instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    },
  };
}

/** Build the L2B instrument universe: US equity, US ETF, non-US, partial listing. */
export function buildInstrumentUniverse(store, options = {}) {
  const authority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l4b-f2-instruments/1', identitySeedFormat: 'HEX_LOWERCASE',
    identitySeedLength: 64,
  });
  const namespace = buildSymbolNamespacePolicy({
    store, namespaceId: 'l4b-f2-ns', namespaceVersion: 1, providerId: 'SYNTHETIC',
    venuePolicy: 'OPTIONAL', casePolicy: 'ASCII_UPPERCASE', currencyPolicy: 'OPTIONAL',
  });
  let definitions = [
    { seed: '1'.repeat(64), kind: 'EQUITY', symbol: 'USEQ', domicile: 'US', currency: 'USD', from: '2020-01-01', to: null },
    // TQQQ is intentionally only a ticker/ETF identity here. No authoritative
    // leverage metadata exists in L2B, so F2 must keep NOT_AUTHORITATIVE.
    { seed: '2'.repeat(64), kind: 'ETF', symbol: 'TQQQ', domicile: 'US', currency: 'USD', from: '2020-01-01', to: null },
    { seed: '3'.repeat(64), kind: 'EQUITY', symbol: 'CAEQ', domicile: 'CA', currency: 'CAD', from: '2020-01-01', to: null },
    { seed: '4'.repeat(64), kind: 'EQUITY', symbol: 'LATEQ', domicile: 'US', currency: 'USD', from: '2025-06-01', to: '2026-04-01' },
  ];
  if (options.empty === true) definitions = [];
  if (options.reverseInsertion === true) definitions = [...definitions].reverse();
  const manifestIds = [];
  for (const def of definitions) {
    const identity = buildInstrumentIdentity({
      store, authorityPolicyId: authority.authorityPolicyId, identitySeed: def.seed,
      instrumentKind: def.kind,
    });
    const descriptor = buildInstrumentDescriptor({
      store, instrumentIdentityId: identity.instrumentIdentityId,
      legalName: `${def.symbol} Legal Name`, displayName: def.symbol, instrumentKind: def.kind,
      domicileCountry: def.domicile, primaryCurrency: def.currency, status: 'ACTIVE',
    });
    const alias = buildInstrumentAliasBinding({
      store, instrumentIdentityId: identity.instrumentIdentityId,
      namespacePolicyId: namespace.namespacePolicyId, venueId: null, symbol: def.symbol,
      currency: def.currency, validFrom: def.from, validToExclusive: def.to,
      bindingStatus: 'CONFIRMED',
    });
    const manifest = buildInstrumentIdentityManifest({
      store, instrumentIdentityId: identity.instrumentIdentityId,
      descriptorCoreIds: [descriptor.descriptorCoreId],
      aliasBindingCoreIds: [alias.aliasBindingCoreId],
    });
    manifestIds.push(manifest.identityManifestId);
  }
  return buildInstrumentIdentityRegistry({
    store, authorityPolicyId: authority.authorityPolicyId, identityManifestIds: manifestIds,
  });
}

export function withOfficialMacroL4BF2Fixture(callback, options = {}) {
  return withMacroStore((store) => callback(buildOfficialMacroL4BF2Context(store, options)));
}

export function openOfficialMacroL4BF2Live(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l4b-f2-live-'));
  const store = createContentAddressedStore({ root });
  const ctx = buildOfficialMacroL4BF2Context(store, options);
  return { ...ctx, root, close() { rmSync(root, { recursive: true, force: true }); } };
}
