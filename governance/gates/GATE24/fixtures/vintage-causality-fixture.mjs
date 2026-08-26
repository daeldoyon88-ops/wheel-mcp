/**
 * GATE24 vintage causality fixture.
 *
 * FIXTURE SCOPE ONLY. Every identifier minted here is unmistakably fixture-scoped:
 * the calendar namespace is GATE24_FIXTURE_CALENDAR/1, which the production
 * admission in regime-horizon-v1.mjs refuses by construction. No identifier
 * produced by this file may ever become a production identifier.
 *
 * The fixture supplies a GATE23-shaped FeatureSet built with the real GATE23
 * identity primitives, and a macro vintage store carrying genuine revisions so that
 * as-of vintage selection can be proved rather than asserted.
 */

import {
  createCalendarWindowBinding,
  createFeatureWindowSpec,
} from '../../GATE23/implementation/feature-window-v1.mjs';
import { buildSessionUniverse } from '../../GATE23/fixtures/calendar-window-fixture.mjs';
import { createFeatureRecordId } from '../../GATE23/implementation/feature-identity-v1.mjs';

export const FIXTURE_SCOPE = 'GATE24_FIXTURE_ONLY';
export const CALENDAR_NAMESPACE_VERSION = 'GATE24_FIXTURE_CALENDAR/1';
export const CALENDAR_AUTHORITY_POLICY_ID = `sha256:${'a1'.repeat(32)}`;
export const CALENDAR_REGISTRY_MANIFEST_ID = `sha256:${'a2'.repeat(32)}`;

export const FIXTURE_INSTRUMENT_IDENTITY_ID = `sha256:${'c1'.repeat(32)}`;
export const FIXTURE_DATASET_ID_FEATURE = `sha256:${'c2'.repeat(32)}`;
export const FIXTURE_SOURCE_BINDING_ID = 'GATE21_BINDING_V1';
export const FIXTURE_PRICE_BASIS_ID = 'SPLIT_ADJUSTED';

export const FIXTURE_MACRO_VINTAGE_SET_MANIFEST_ID = `sha256:${'d1'.repeat(32)}`;
export const FIXTURE_MACRO_DATASET_SNAPSHOT_MANIFEST_ID = `sha256:${'d2'.repeat(32)}`;
export const FIXTURE_AVAILABLE_AT_POLICY_ID = 'GATE24_FIXTURE_RELEASE_TIME_POLICY/1';

/** Fixture-scoped calendar binding. The production path refuses this namespace. */
export const FIXTURE_CALENDAR_WINDOW_BINDING = createCalendarWindowBinding({
  calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
  calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
  calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
});

/** A second fixture binding, used to prove the horizon identity differential. */
export const FIXTURE_ALTERNATE_CALENDAR_WINDOW_BINDING = createCalendarWindowBinding({
  calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
  calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  allowedSessionKinds: ['REGULAR_SESSION'],
  calendarNamespaceVersion: 'GATE24_FIXTURE_CALENDAR/2',
});

export const SESSION_UNIVERSE = buildSessionUniverse();
export const ANCHOR_SESSIONS = Object.freeze(SESSION_UNIVERSE.slice(-6));
export const ANCHOR_SESSION = ANCHOR_SESSIONS[ANCHOR_SESSIONS.length - 1];
export const ANCHOR_SESSION_DATE = ANCHOR_SESSION.sessionDate;
export const ANCHOR_KNOWLEDGE_CUTOFF = ANCHOR_SESSION.closeUtc;
/** Start of the 21-session horizon; strictly before K(T). */
export const HORIZON_START_KNOWLEDGE_CUTOFF = SESSION_UNIVERSE[SESSION_UNIVERSE.length - 22].closeUtc;

export const FEATURE_MEMBERS_V1 = Object.freeze([
  Object.freeze({ featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21 }),
  Object.freeze({ featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 }),
  Object.freeze({ featureDefinitionId: 'F2_REALIZED_VOLATILITY', sessionCount: 21 }),
  Object.freeze({ featureDefinitionId: 'F3_MAX_DRAWDOWN', sessionCount: 21 }),
  Object.freeze({ featureDefinitionId: 'F4_RELATIVE_VOLUME', sessionCount: 21 }),
]);

export const memberKey = (member) => `${member.featureDefinitionId}@W${member.sessionCount}`;

const FORMULA_IDS = Object.freeze({
  F1_SIMPLE_RETURN: 'GATE23_SIMPLE_RETURN/1',
  F2_REALIZED_VOLATILITY: 'GATE24_FIXTURE_REALIZED_VOLATILITY/1',
  F3_MAX_DRAWDOWN: 'GATE24_FIXTURE_MAX_DRAWDOWN/1',
  F4_RELATIVE_VOLUME: 'GATE24_FIXTURE_RELATIVE_VOLUME/1',
});

/**
 * Builds a GATE23-shaped FeatureSet with genuine FeatureRecordIds.
 *
 * `values` maps a member key to its resolved value; a member key listed in
 * `missing` is omitted entirely, and one listed in `insufficient` is present with
 * INSUFFICIENT_DATA so dimension-local fail-closed behaviour can be exercised.
 */
export function buildFeatureSet({
  sessionDate = ANCHOR_SESSION_DATE,
  knowledgeCutoff = ANCHOR_KNOWLEDGE_CUTOFF,
  calendarWindowBinding = FIXTURE_CALENDAR_WINDOW_BINDING,
  datasetIdFeature = FIXTURE_DATASET_ID_FEATURE,
  instrumentIdentityId = FIXTURE_INSTRUMENT_IDENTITY_ID,
  values = {},
  missing = [],
  insufficient = [],
  calendarWindowBindingIdOverrides = {},
} = {}) {
  const records = FEATURE_MEMBERS_V1
    .filter((member) => !missing.includes(memberKey(member)))
    .map((member) => {
      const key = memberKey(member);
      const featureWindowSpec = createFeatureWindowSpec({ sessionCount: member.sessionCount, calendarWindowBinding });
      const isInsufficient = insufficient.includes(key);
      const missingnessStateId = isInsufficient
        ? 'GATE23_MissingnessState/1:INSUFFICIENT_HISTORY'
        : 'GATE23_MissingnessState/1:COMPLETE';
      const identity = {
        InstrumentIdentityId: instrumentIdentityId,
        SessionDate: sessionDate,
        KnowledgeCutoff: knowledgeCutoff,
        FeatureDefinitionId: member.featureDefinitionId,
        FormulaId: FORMULA_IDS[member.featureDefinitionId],
        FeatureWindowSpecId: featureWindowSpec.featureWindowSpecId,
        CalendarWindowBindingId: calendarWindowBindingIdOverrides[key] ?? calendarWindowBinding.calendarWindowBindingId,
        SourceBindingId: FIXTURE_SOURCE_BINDING_ID,
        DatasetId_observation: datasetIdFeature,
        PriceBasisId: FIXTURE_PRICE_BASIS_ID,
        MissingnessStateId: missingnessStateId,
      };
      return Object.freeze({
        featureRecordId: createFeatureRecordId(identity),
        identity: Object.freeze(identity),
        featureDefinitionId: member.featureDefinitionId,
        featureWindowSpecId: featureWindowSpec.featureWindowSpecId,
        sessionCount: member.sessionCount,
        status: isInsufficient ? 'INSUFFICIENT_DATA' : 'RESOLVED',
        value: isInsufficient ? null : (values[key] ?? 0),
        missingnessStateId,
      });
    });
  return Object.freeze({
    instrumentIdentityId,
    sessionDate,
    knowledgeCutoff,
    datasetIdFeature,
    records: Object.freeze(records),
  });
}

/** Feature values that resolve primaryMarketRegime BULL and volatilityState NORMAL. */
export const COMPLETE_FEATURE_VALUES = Object.freeze({
  'F1_SIMPLE_RETURN@W21': 0.08,
  'F1_SIMPLE_RETURN@W5': 0.01,
  'F2_REALIZED_VOLATILITY@W21': 0.15,
  'F3_MAX_DRAWDOWN@W21': -0.04,
  'F4_RELATIVE_VOLUME@W21': 1.1,
});

const macroObservation = ({ seriesCode, value, availableAt, vintageAvailableAt, sequenceId }) => Object.freeze({
  seriesCode,
  value,
  availableAt,
  vintageAvailableAt: vintageAvailableAt ?? availableAt,
  sequenceId,
});

const PRIOR_INSTANT = HORIZON_START_KNOWLEDGE_CUTOFF;
const CURRENT_INSTANT = ANCHOR_KNOWLEDGE_CUTOFF;
/** Strictly after K(T): admissible only to a future observer, never at T. */
export const FUTURE_INSTANT = '2099-01-01T00:00:00.000Z';

/**
 * Macro vintage store. US.TREAS.DGS10 carries a genuine revision history, including
 * a later vintage of an earlier observation, so that latest-value substitution and
 * future-vintage leakage are distinguishable from correct as-of selection.
 */
export function buildMacroVintageStore({
  curveShape = 'NORMAL',
  curveDirection = 'STEEPENING',
  cpiYoY = 0.035,
  ratesCurrent = 0.0455,
  ratesPrior = 0.0410,
  includeFutureVintage = true,
  omitSeries = [],
} = {}) {
  const store = {
    'US.TREAS.DGS10': [
      macroObservation({ seriesCode: 'US.TREAS.DGS10', value: ratesPrior, availableAt: PRIOR_INSTANT, sequenceId: '0001' }),
      macroObservation({ seriesCode: 'US.TREAS.DGS10', value: ratesCurrent, availableAt: CURRENT_INSTANT, sequenceId: '0002' }),
    ],
    'US.TREAS.DGS3MO': [macroObservation({ seriesCode: 'US.TREAS.DGS3MO', value: 0.0525, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.TREAS.DGS2': [macroObservation({ seriesCode: 'US.TREAS.DGS2', value: 0.0470, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.TREAS.DGS5': [macroObservation({ seriesCode: 'US.TREAS.DGS5', value: 0.0440, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.TREAS.DGS30': [macroObservation({ seriesCode: 'US.TREAS.DGS30', value: 0.0475, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.FRB.DFEDTARU': [macroObservation({ seriesCode: 'US.FRB.DFEDTARU', value: 0.0550, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.FRB.DFEDTARL': [macroObservation({ seriesCode: 'US.FRB.DFEDTARL', value: 0.0525, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.NYFED.EFFR': [macroObservation({ seriesCode: 'US.NYFED.EFFR', value: 0.0533, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.NYFED.SOFR': [macroObservation({ seriesCode: 'US.NYFED.SOFR', value: 0.0531, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.FOMC.DECISION': [macroObservation({ seriesCode: 'US.FOMC.DECISION', value: 'HOLD', availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.BLS.CPIAUCSL': [macroObservation({ seriesCode: 'US.BLS.CPIAUCSL', value: 312.4, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    'US.BLS.UNRATE': [macroObservation({ seriesCode: 'US.BLS.UNRATE', value: 0.041, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    cpiYoY: [macroObservation({ seriesCode: 'cpiYoY', value: cpiYoY, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    cpiMoM: [macroObservation({ seriesCode: 'cpiMoM', value: 0.003, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    SPREAD_10Y_2Y: [macroObservation({ seriesCode: 'SPREAD_10Y_2Y', value: -0.0015, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    SPREAD_10Y_3M: [macroObservation({ seriesCode: 'SPREAD_10Y_3M', value: -0.0070, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    SPREAD_5Y_2Y: [macroObservation({ seriesCode: 'SPREAD_5Y_2Y', value: -0.0030, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    curveShape: [macroObservation({ seriesCode: 'curveShape', value: curveShape, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    curveDirection: [macroObservation({ seriesCode: 'curveDirection', value: curveDirection, availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
    inversionFlags: [macroObservation({ seriesCode: 'inversionFlags', value: 'PARTIAL', availableAt: CURRENT_INSTANT, sequenceId: '0001' })],
  };
  if (includeFutureVintage) {
    /* A revision of the 10Y published long after K(T). Selecting it would be
       future-vintage leakage; selecting it "because it is newest" would be
       latest-value substitution. Correct as-of selection ignores it. */
    store['US.TREAS.DGS10'] = [
      ...store['US.TREAS.DGS10'],
      macroObservation({ seriesCode: 'US.TREAS.DGS10', value: 0.0900, availableAt: FUTURE_INSTANT, sequenceId: '0003' }),
    ];
  }
  for (const code of omitSeries) delete store[code];
  return Object.freeze(store);
}

export const MACRO_VINTAGE_STORE = buildMacroVintageStore();

/** An entirely absent macro perimeter, for the macro-absence resolution path. */
export const EMPTY_MACRO_VINTAGE_STORE = Object.freeze({});
