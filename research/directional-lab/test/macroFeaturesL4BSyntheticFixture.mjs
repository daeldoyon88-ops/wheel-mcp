/**
 * Synthetic L4B-F1 fixtures: F1 series only (no CPI/UNRATE/ICSA features),
 * market calendar with REGULAR + HALF_DAY + DST boundary, FOMC calendar chain,
 * hike/hold/cut/restructure, stale/withdrawal/missing/future CAS noise.
 * All values are fabricated offline SYNTHETIC_TEST_FIXTURE data.
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
import { addDays } from '../src/time/civilDate.mjs';
import { sessionCloseUtc, sessionOpenUtc } from '../src/time/marketSession.mjs';
import { sha256Digest } from '../src/contracts/marketDataL3CommonV1.mjs';

import { MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION } from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { F1_SERIES_CODES } from '../src/contracts/macroFeatureContractsL4BV1.mjs';
import {
  withMacroStore,
  pinSyntheticSourceDocument,
} from './macroIngestionL4BSyntheticFixture.mjs';
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
import {
  buildMacroReleaseCalendarRegistryGenesis,
  makeMacroReleaseEventVersion,
} from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { buildMacroDatasetBinding } from '../src/macro/macroDatasetBindingL4BV1.mjs';
import { buildMacroMaterializationReport } from '../src/macro/macroMaterializationReportL4BV1.mjs';
import { buildMarketMacroFeatureComputationPolicy } from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { buildMarketMacroFeatureSourceBundle } from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { buildMacroStateBySessionRows } from '../src/macro/macroStateBySessionRowsL4BV1.mjs';
import { buildMarketMacroFeatureComputationReport } from '../src/macro/marketMacroFeatureComputationReportL4BV1.mjs';

export { code, withMacroStore } from './macroIngestionL4BSyntheticFixture.mjs';

function methodologyId(canonicalSeriesCode) {
  return sha256Digest(`SYNTHETIC_TEST_FIXTURE L4B-F1 methodology ${canonicalSeriesCode} v1`);
}

const SERIES_DEFINITIONS = Object.freeze({
  'US.FRB.DFEDTARL': {
    sourceAuthority: 'FRB', frequency: 'EVENT', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'FRB',
  },
  'US.FRB.DFEDTARU': {
    sourceAuthority: 'FRB', frequency: 'EVENT', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'FRB',
  },
  'US.NYFED.EFFR': {
    sourceAuthority: 'NY_FED', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_AVERAGE',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'NY_FED',
  },
  'US.NYFED.SOFR': {
    sourceAuthority: 'NY_FED', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_AVERAGE',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'NY_FED',
  },
  'US.TREAS.DGS3MO': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.TREAS.DGS2': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.TREAS.DGS5': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.TREAS.DGS10': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.TREAS.DGS30': {
    sourceAuthority: 'US_TREASURY', frequency: 'DAILY', units: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'PERIOD_END',
    revisionPolicy: 'VINTAGE_COMPLETE', releaseAuthority: 'US_TREASURY',
  },
  'US.FOMC.DECISION': {
    sourceAuthority: 'FRB', frequency: 'EVENT', units: 'RATE_RANGE_BOUND',
    seasonalAdjustment: 'NOT_APPLICABLE', observationConvention: 'POINT_IN_TIME_EVENT',
    revisionPolicy: 'PUBLICATION_ATTESTED', releaseAuthority: 'FRB',
  },
});

export function syntheticMacroL4BF1SeriesIdentity(canonicalSeriesCode, overrides = {}) {
  const definition = SERIES_DEFINITIONS[canonicalSeriesCode];
  if (!definition) throw new Error(`no F1 synthetic definition for ${canonicalSeriesCode}`);
  return {
    schemaVersion: MACRO_SERIES_IDENTITY_CORE_SCHEMA_VERSION,
    jurisdictionCode: 'UNITED_STATES',
    currencyCode: 'USD',
    canonicalSeriesCode,
    ...definition,
    methodologyVersionId: methodologyId(canonicalSeriesCode),
    validFrom: '2020-01-01',
    validThrough: null,
    ...overrides,
  };
}

function halfDayCloseUtc(sessionDate) {
  // Synthetic early close 13:00 ET.
  const isDst = sessionDate >= '2026-03-08';
  const hourUtc = isDst ? 17 : 18;
  return `${sessionDate}T${String(hourUtc).padStart(2, '0')}:00:00.000Z`;
}

function buildOfficialSessions() {
  return [
    {
      sessionDate: '2026-03-02', sessionKind: 'REGULAR_SESSION',
      openUtc: sessionOpenUtc('2026-03-02'), closeUtc: sessionCloseUtc('2026-03-02'),
      marketValidTime: sessionCloseUtc('2026-03-02'),
    },
    {
      sessionDate: '2026-03-03', sessionKind: 'REGULAR_SESSION',
      openUtc: sessionOpenUtc('2026-03-03'), closeUtc: sessionCloseUtc('2026-03-03'),
      marketValidTime: sessionCloseUtc('2026-03-03'),
    },
    {
      sessionDate: '2026-03-04', sessionKind: 'REGULAR_SESSION',
      openUtc: sessionOpenUtc('2026-03-04'), closeUtc: sessionCloseUtc('2026-03-04'),
      marketValidTime: sessionCloseUtc('2026-03-04'),
    },
    {
      sessionDate: '2026-03-05', sessionKind: 'REGULAR_SESSION',
      openUtc: sessionOpenUtc('2026-03-05'), closeUtc: sessionCloseUtc('2026-03-05'),
      marketValidTime: sessionCloseUtc('2026-03-05'),
    },
    {
      sessionDate: '2026-03-06', sessionKind: 'HALF_DAY_SESSION',
      openUtc: sessionOpenUtc('2026-03-06'), closeUtc: halfDayCloseUtc('2026-03-06'),
      marketValidTime: halfDayCloseUtc('2026-03-06'),
    },
    {
      sessionDate: '2026-03-09', sessionKind: 'REGULAR_SESSION',
      openUtc: sessionOpenUtc('2026-03-09'), closeUtc: sessionCloseUtc('2026-03-09'),
      marketValidTime: sessionCloseUtc('2026-03-09'),
    },
  ];
}

function buildMarketCalendar(store, sessions) {
  const coverageFrom = sessions[0].sessionDate;
  const coverageToExclusive = '2026-03-14';
  const civilDates = [];
  for (let cursor = coverageFrom; cursor < coverageToExclusive; cursor = addDays(cursor, 1)) {
    civilDates.push(cursor);
  }
  const ruleset = buildTimeZoneRuleset({
    store,
    ruleset: {
      schemaVersion: 'TimeZoneRuleset/1',
      rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1',
      zoneId: 'America/New_York/synthetic-l4b-f1',
      validFromDate: coverageFrom,
      validToDateExclusive: coverageToExclusive,
      civilDateBounds: civilDates.map((civilDate) => {
        const next = addDays(civilDate, 1);
        // Contiguous UTC civil bounds (fixture authority). Session open/close
        // remain independently pinned via sessionOpenUtc/sessionCloseUtc DST rules.
        return {
          civilDate,
          startUtc: `${civilDate}T05:00:00.000Z`,
          endUtcExclusive: `${next}T05:00:00.000Z`,
        };
      }),
    },
  });
  const calendarPolicy = buildMarketCalendarAuthorityPolicy({
    store,
    policy: {
      schemaVersion: MARKET_CALENDAR_AUTHORITY_POLICY_SCHEMA_VERSION,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
      calendarNamespaceVersion: 'synthetic-l4b-f1/1',
    },
  });
  const calendar = buildMarketSessionCalendar({
    store,
    calendar: {
      schemaVersion: MARKET_SESSION_CALENDAR_CORE_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      venueId: 'XNAS',
      timeZoneRulesetId: ruleset.timeZoneRulesetId,
      coverageFromDate: coverageFrom,
      coverageToDateExclusive: coverageToExclusive,
      sessions,
    },
  });
  return buildMarketCalendarRegistry({
    store,
    registry: {
      schemaVersion: MARKET_CALENDAR_REGISTRY_MANIFEST_SCHEMA_VERSION,
      calendarAuthorityPolicyId: calendarPolicy.calendarAuthorityPolicyId,
      calendarCoreIds: [calendar.calendarCoreId],
      supersedesCalendarRegistryManifestId: null,
    },
  });
}

function observationFor(seriesBuilt, overrides) {
  return {
    schemaVersion: 'MacroObservationIdentityCore/1',
    macroSeriesIdentityId: seriesBuilt.macroSeriesIdentityId,
    unit: seriesBuilt.macroSeriesIdentity.units,
    seasonalAdjustment: seriesBuilt.macroSeriesIdentity.seasonalAdjustment,
    ...overrides,
  };
}

function pct(atoms) {
  return { atoms: String(atoms), scale: 2 };
}

/**
 * Build the official L4B-F1 context on an existing store (no lifecycle).
 * @param {object} store
 */
export function buildOfficialMacroL4BF1Context(store) {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const policy = policyBuild.macroIngestionPolicy;
    const series = {};
    for (const codeName of F1_SERIES_CODES) {
      series[codeName] = buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroL4BF1SeriesIdentity(codeName),
      });
    }
    const registry = buildMacroSeriesRegistryGenesis({
      store,
      entries: Object.values(series).map((built) => ({
        macroSeriesIdentityId: built.macroSeriesIdentityId,
        canonicalSeriesCode: built.macroSeriesIdentity.canonicalSeriesCode,
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      })),
    });

    const sessions = buildOfficialSessions();
    const calendarRegistry = buildMarketCalendar(store, sessions);

    const vintage = (options) => buildMacroObservationVintageCore({ store, policy, ...options });
    const docs = {
      base: pinSyntheticSourceDocument(store, 'f1-base'),
      hike: pinSyntheticSourceDocument(store, 'f1-hike'),
      cut: pinSyntheticSourceDocument(store, 'f1-cut'),
      restructure: pinSyntheticSourceDocument(store, 'f1-restructure'),
      withdraw: pinSyntheticSourceDocument(store, 'f1-withdraw'),
      future: pinSyntheticSourceDocument(store, 'f1-future-noise'),
      fomcSchedule: pinSyntheticSourceDocument(store, 'f1-fomc-schedule'),
      fomcReschedule: pinSyntheticSourceDocument(store, 'f1-fomc-reschedule'),
      fomcCancel: pinSyntheticSourceDocument(store, 'f1-fomc-cancel'),
      fomcRelease: pinSyntheticSourceDocument(store, 'f1-fomc-release'),
    };

    const observationVintageIds = [];
    const addDaily = (code, date, atoms, doc = docs.base) => {
      const obs = buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series[code], {
          observationPeriodStart: date,
          observationPeriodEnd: date,
          referencePeriod: date,
        }),
      });
      const built = vintage({
        series: series[code].macroSeriesIdentity,
        observationIdentityId: obs.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
        releaseTimestamp: null,
        releaseCivilDate: date,
        vintageSequence: 0,
        value: pct(atoms),
        revisionKind: 'INITIAL',
        parentVintageId: null,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: doc,
      });
      observationVintageIds.push(built.observationVintageId);
      return { obs, built };
    };

    const addTarget = (code, date, atoms, doc, parent = null, sequence = 0, kind = 'INITIAL') => {
      const obs = parent ? parent.obs : buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series[code], {
          observationPeriodStart: date,
          observationPeriodEnd: date,
          referencePeriod: date,
        }),
      });
      const built = vintage({
        series: series[code].macroSeriesIdentity,
        observationIdentityId: obs.observationIdentityId,
        releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
        releaseTimestamp: null,
        releaseCivilDate: date,
        vintageSequence: sequence,
        value: pct(atoms),
        revisionKind: kind,
        parentVintageId: parent ? parent.built.macroVintageIdentityId : null,
        vintageCompletenessClass: 'VINTAGE_COMPLETE',
        sourceDocumentId: doc,
      });
      observationVintageIds.push(built.observationVintageId);
      return { obs, built };
    };

    // Initial policy rate 4.25–4.50 on 2026-02-27 (available before first session).
    let lower = addTarget('US.FRB.DFEDTARL', '2026-02-27', 425, docs.base);
    let upper = addTarget('US.FRB.DFEDTARU', '2026-02-27', 450, docs.base);

    // Daily money/treasury path across sessions.
    // Curve shapes: normal → flat-ish → partial inv → inverted → steepening after DST.
    const treasuryPath = {
      '2026-03-02': { '3m': 420, '2y': 400, '5y': 390, '10y': 410, '30y': 430 }, // normal
      '2026-03-03': { '3m': 430, '2y': 420, '5y': 415, '10y': 425, '30y': 435 }, // flatter
      '2026-03-04': { '3m': 450, '2y': 440, '5y': 420, '10y': 435, '30y': 430 }, // partial
      '2026-03-05': { '3m': 460, '2y': 450, '5y': 430, '10y': 420, '30y': 410 }, // inverted
      '2026-03-06': { '3m': 455, '2y': 445, '5y': 425, '10y': 415, '30y': 405 }, // still inv
      '2026-03-09': { '3m': 400, '2y': 380, '5y': 390, '10y': 420, '30y': 440 }, // steep
    };
    const effrPath = {
      '2026-03-02': 437, '2026-03-03': 462, '2026-03-04': 437,
      '2026-03-05': 412, '2026-03-06': 412,
      // intentional gap for stale on 2026-03-09 (age > 5 if only early fixes — keep last on 03-02 only for SOFR stale demo)
    };
    const sofrPath = {
      '2026-03-02': 430,
      // leave later sessions to carry-forward then STALE by 03-09 (5 sessions later from 03-02: 03-03,04,05,06,09 = age 5 at 03-09? land on 03-02 age=5 on 03-09 if 5 steps)
    };

    for (const date of Object.keys(treasuryPath)) {
      const t = treasuryPath[date];
      addDaily('US.TREAS.DGS3MO', date, t['3m']);
      addDaily('US.TREAS.DGS2', date, t['2y']);
      addDaily('US.TREAS.DGS5', date, t['5y']);
      addDaily('US.TREAS.DGS10', date, t['10y']);
      addDaily('US.TREAS.DGS30', date, t['30y']);
    }
    for (const date of Object.keys(effrPath)) {
      addDaily('US.NYFED.EFFR', date, effrPath[date]);
    }
    for (const date of Object.keys(sofrPath)) {
      addDaily('US.NYFED.SOFR', date, sofrPath[date]);
    }

    // Hike 2026-03-03 14:00 ET (during session).
    lower = addTarget('US.FRB.DFEDTARL', '2026-03-03', 450, docs.hike);
    upper = addTarget('US.FRB.DFEDTARU', '2026-03-03', 475, docs.hike);
    const fomcHikeObs = buildMacroObservationIdentityCore({
      store,
      identity: observationFor(series['US.FOMC.DECISION'], {
        observationPeriodStart: '2026-03-03',
        observationPeriodEnd: '2026-03-03',
        referencePeriod: '2026-03-03',
      }),
    });
    observationVintageIds.push(vintage({
      series: series['US.FOMC.DECISION'].macroSeriesIdentity,
      observationIdentityId: fomcHikeObs.observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-03-03',
      vintageSequence: 0,
      value: pct(450),
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'PUBLICATION_ATTESTED',
      sourceDocumentId: docs.hike,
    }).observationVintageId);

    // Cut 2026-03-05.
    lower = addTarget('US.FRB.DFEDTARL', '2026-03-05', 425, docs.cut);
    upper = addTarget('US.FRB.DFEDTARU', '2026-03-05', 450, docs.cut);

    // Range restructure 2026-03-06: widen without mid move (4.25-4.75 mid 4.50).
    lower = addTarget('US.FRB.DFEDTARL', '2026-03-06', 425, docs.restructure);
    upper = addTarget('US.FRB.DFEDTARU', '2026-03-06', 475, docs.restructure);

    // Future withdrawal tip after last session close (anti-lookahead noise).
    const effrWithdrawParent = addDaily('US.NYFED.EFFR', '2026-03-09', 400, docs.base);
    observationVintageIds.push(vintage({
      series: series['US.NYFED.EFFR'].macroSeriesIdentity,
      observationIdentityId: effrWithdrawParent.obs.observationIdentityId,
      releaseTimeResolutionMode: 'OFFICIAL_TIMESTAMP',
      releaseTimestamp: '2026-03-10T14:00:00.000Z',
      releaseCivilDate: null,
      vintageSequence: 1,
      value: null,
      revisionKind: 'WITHDRAWAL',
      parentVintageId: effrWithdrawParent.built.macroVintageIdentityId,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.withdraw,
    }).observationVintageId);

    // Future noise vintage after knowledge cutoff.
    observationVintageIds.push(vintage({
      series: series['US.TREAS.DGS10'].macroSeriesIdentity,
      observationIdentityId: buildMacroObservationIdentityCore({
        store,
        identity: observationFor(series['US.TREAS.DGS10'], {
          observationPeriodStart: '2026-03-12',
          observationPeriodEnd: '2026-03-12',
          referencePeriod: '2026-03-12',
        }),
      }).observationIdentityId,
      releaseTimeResolutionMode: 'SERIES_AUTHORITY_POLICY',
      releaseTimestamp: null,
      releaseCivilDate: '2026-03-12',
      vintageSequence: 0,
      value: pct(999),
      revisionKind: 'INITIAL',
      parentVintageId: null,
      vintageCompletenessClass: 'VINTAGE_COMPLETE',
      sourceDocumentId: docs.future,
    }).observationVintageId);
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds,
    });
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
    });

    const asOf = buildMacroAsOfResolutionPolicy({ store });

    const fomcSeriesId = series['US.FOMC.DECISION'].macroSeriesIdentityId;
    const schedule = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-03-18',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'SCHEDULED',
      scheduledReleaseTimestamp: '2026-03-18T18:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-02-15T15:00:00.000Z',
      sourceDocumentId: docs.fomcSchedule,
      supersedesReleaseEventVersionId: null,
      updateReason: 'INITIAL_SCHEDULE',
    });
    const reschedule = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-03-18',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'RESCHEDULED',
      scheduledReleaseTimestamp: '2026-03-19T18:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-03-04T15:00:00.000Z',
      sourceDocumentId: docs.fomcReschedule,
      supersedesReleaseEventVersionId: schedule.releaseEventVersionId,
      updateReason: 'RESCHEDULE',
    });
    const cancelledAlt = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-04-01',
      releaseKind: 'SPECIAL',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'SCHEDULED',
      scheduledReleaseTimestamp: '2026-04-01T18:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-03-01T15:00:00.000Z',
      sourceDocumentId: docs.fomcSchedule,
      supersedesReleaseEventVersionId: null,
      updateReason: 'INITIAL_SCHEDULE',
    });
    const cancelled = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-04-01',
      releaseKind: 'SPECIAL',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'CANCELLED',
      scheduledReleaseTimestamp: '2026-04-01T18:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-03-05T15:00:00.000Z',
      sourceDocumentId: docs.fomcCancel,
      supersedesReleaseEventVersionId: cancelledAlt.releaseEventVersionId,
      updateReason: 'CANCELLATION',
    });
    const releasedSchedule = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-03-03',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'SCHEDULED',
      scheduledReleaseTimestamp: '2026-03-03T19:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-02-20T15:00:00.000Z',
      sourceDocumentId: docs.fomcSchedule,
      supersedesReleaseEventVersionId: null,
      updateReason: 'INITIAL_SCHEDULE',
    });
    const released = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-03-03',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'RELEASED',
      scheduledReleaseTimestamp: '2026-03-03T19:00:00.000Z',
      actualReleaseTimestamp: '2026-03-03T19:00:00.000Z',
      availableAt: '2026-03-03T19:00:00.000Z',
      calendarKnowledgeAvailableAt: '2026-03-03T19:00:00.000Z',
      sourceDocumentId: docs.fomcRelease,
      supersedesReleaseEventVersionId: releasedSchedule.releaseEventVersionId,
      updateReason: 'ACTUAL_RELEASE',
    });
    // Future calendar noise after last session.
    const futureCal = makeMacroReleaseEventVersion({
      macroSeriesIdentityId: fomcSeriesId,
      referencePeriod: '2026-03-18',
      releaseKind: 'REGULAR',
      releaseOrdinal: 0,
      releaseAuthority: 'FRB',
      eventStatus: 'RESCHEDULED',
      scheduledReleaseTimestamp: '2026-03-20T18:00:00.000Z',
      actualReleaseTimestamp: null,
      availableAt: null,
      calendarKnowledgeAvailableAt: '2026-03-12T15:00:00.000Z',
      sourceDocumentId: docs.future,
      supersedesReleaseEventVersionId: reschedule.releaseEventVersionId,
      updateReason: 'RESCHEDULE',
    });

    const releaseCalendar = buildMacroReleaseCalendarRegistryGenesis({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      jurisdictionCode: 'UNITED_STATES',
      currencyCode: 'USD',
      orderedReleaseEventVersions: [
        schedule, reschedule, cancelledAlt, cancelled, releasedSchedule, released, futureCal,
      ],
    });

    const knowledgeCutoff = '2026-03-11T00:00:00.000Z';
    const binding = buildMacroDatasetBinding({
      store,
      macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
      macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
      macroReleaseCalendarRegistryManifestId: releaseCalendar.macroReleaseCalendarRegistryManifestId,
      knowledgeCutoff,
    });
    const materialization = buildMacroMaterializationReport({
      store,
      macroDatasetBindingId: binding.macroDatasetBindingId,
    });
    const featurePolicy = buildMarketMacroFeatureComputationPolicy({ store });
    const sourceBundle = buildMarketMacroFeatureSourceBundle({
      store,
      macroDatasetBindingId: binding.macroDatasetBindingId,
      macroMaterializationReportId: materialization.macroMaterializationReportId,
      marketCalendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
      featureComputationStartSessionDate: '2026-03-02',
      featureComputationEndSessionDateInclusive: '2026-03-09',
    });
    const rows = buildMacroStateBySessionRows({
      store,
      sourceBundleId: sourceBundle.sourceBundleId,
      featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    });
    const report = buildMarketMacroFeatureComputationReport({
      store,
      sourceBundleId: sourceBundle.sourceBundleId,
      featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
      macroStateBySessionRowsId: rows.macroStateBySessionRowsId,
    });

    return {
      store,
      series,
      registry,
      sessions,
      calendarRegistry,
      asOf,
      binding,
      materialization,
      featurePolicy,
      sourceBundle,
      rows,
      report,
      knowledgeCutoff,
      F1_SERIES_CODES,
    };
}

/**
 * Official L4B-F1 golden fixture builder.
 * @param {(context: any) => unknown} callback
 */
export function withOfficialMacroL4BF1Fixture(callback) {
  return withMacroStore((store) => callback(buildOfficialMacroL4BF1Context(store)));
}

/**
 * Build once and keep the store open until close(). For dense suites.
 */
export function openOfficialMacroL4BF1Live() {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l4b-f1-live-'));
  const store = createContentAddressedStore({ root });
  const ctx = buildOfficialMacroL4BF1Context(store);
  return {
    ...ctx,
    root,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Empty F1: sessions range with no matching sessions / empty rows. */
export function withEmptyMacroL4BF1Fixture(callback) {
  return withMacroStore((store) => {
    const policyBuild = buildMacroIngestionPolicy({ store });
    const series = {};
    for (const codeName of F1_SERIES_CODES) {
      series[codeName] = buildMacroSeriesIdentityCore({
        store, identity: syntheticMacroL4BF1SeriesIdentity(codeName),
      });
    }
    const registry = buildMacroSeriesRegistryGenesis({
      store,
      entries: Object.values(series).map((built) => ({
        macroSeriesIdentityId: built.macroSeriesIdentityId,
        canonicalSeriesCode: built.macroSeriesIdentity.canonicalSeriesCode,
        status: 'ACTIVE',
        supersedesSeriesIdentityId: null,
        replacementReason: null,
      })),
    });
    const sessions = buildOfficialSessions();
    const calendarRegistry = buildMarketCalendar(store, sessions);
    const vintageSet = buildMacroVintageSetManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
      supersedesVintageSetManifestId: null,
      observationVintageIds: [],
    });
    const snapshot = buildMacroDatasetSnapshotManifest({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
      macroIngestionPolicyId: policyBuild.macroIngestionPolicyId,
    });
    const asOf = buildMacroAsOfResolutionPolicy({ store });
    const releaseCalendar = buildMacroReleaseCalendarRegistryGenesis({
      store,
      macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
      jurisdictionCode: 'UNITED_STATES',
      currencyCode: 'USD',
      orderedReleaseEventVersions: [],
    });
    const binding = buildMacroDatasetBinding({
      store,
      macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
      macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
      macroReleaseCalendarRegistryManifestId: releaseCalendar.macroReleaseCalendarRegistryManifestId,
      knowledgeCutoff: '2026-06-01T00:00:00.000Z',
    });
    const materialization = buildMacroMaterializationReport({
      store, macroDatasetBindingId: binding.macroDatasetBindingId,
    });
    const featurePolicy = buildMarketMacroFeatureComputationPolicy({ store });
    // Empty computation: civil range with zero sessions on calendar.
    const sourceBundle = buildMarketMacroFeatureSourceBundle({
      store,
      macroDatasetBindingId: binding.macroDatasetBindingId,
      macroMaterializationReportId: materialization.macroMaterializationReportId,
      marketCalendarRegistryManifestId: calendarRegistry.calendarRegistryManifestId,
      featureComputationStartSessionDate: '2026-03-07',
      featureComputationEndSessionDateInclusive: '2026-03-08',
    });
    const rows = buildMacroStateBySessionRows({
      store,
      sourceBundleId: sourceBundle.sourceBundleId,
      featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
    });
    const report = buildMarketMacroFeatureComputationReport({
      store,
      sourceBundleId: sourceBundle.sourceBundleId,
      featureComputationPolicyId: featurePolicy.featureComputationPolicyId,
      macroStateBySessionRowsId: rows.macroStateBySessionRowsId,
    });
    return callback({
      store, series, registry, calendarRegistry, asOf, binding, materialization,
      featurePolicy, sourceBundle, rows, report,
    });
  });
}
