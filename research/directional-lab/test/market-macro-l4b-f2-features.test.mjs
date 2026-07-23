/**
 * L4B-F2 CPI / UNRATE / claims causal feature computers, exercised on synthetic
 * series indices with hand-computed fixed-point expectations. Independent of the
 * CAS fixture. Covers MoM/YoY, acceleration, missing months, revisions,
 * withdrawal, staleness, four-week windows, spike thresholds and the ratio
 * primitive boundaries.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  normalizeMarketMacroInstrumentProjectionPolicyV1,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import { computeInflationState } from '../src/macro/macroInflationFeaturesL4BF2V1.mjs';
import { computeUnemploymentState } from '../src/macro/macroLaborFeaturesL4BF2V1.mjs';
import { computeClaimsState } from '../src/macro/macroClaimsFeaturesL4BF2V1.mjs';
import {
  macroRatioChangeFixed,
  macroNominalDeltaFixed,
  macroWindowAverageFixed,
  macroFixedSign,
  addMonthsToMonthKey,
  monthsBetweenMonthKeys,
} from '../src/macro/macroFixedPointRatioL4BF2V1.mjs';
import { syntheticSeriesIndex, fp } from './helpers/macroSyntheticSeriesIndexL4BF2V1.mjs';

const POLICY = normalizeMarketMacroInstrumentProjectionPolicyV1({
  schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
});

const CUTOFF = '2026-03-01T00:00:00.000Z';
function avail(monthKey, day) {
  return `${addMonthsToMonthKey(monthKey, 1)}-${String(day).padStart(2, '0')}T13:30:00.000Z`;
}
function cpiMonth(monthKey, atoms, extraVintages = []) {
  return {
    referencePeriod: monthKey, periodStart: `${monthKey}-01`, periodEnd: `${monthKey}-28`,
    vintages: [{ availableAt: avail(monthKey, 14), value: fp(atoms, 3) }, ...extraVintages],
  };
}

test('CPI MoM, YoY, acceleration on exact months (hand-computed fixed-point)', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2024-12', 300000), cpiMonth('2025-01', 300000),
    cpiMonth('2025-02', 300500), cpiMonth('2025-03', 301000),
    cpiMonth('2025-04', 301500), cpiMonth('2025-05', 302000),
    cpiMonth('2025-06', 303000), cpiMonth('2025-07', 304000),
    cpiMonth('2025-08', 305000), cpiMonth('2025-09', 306000),
    cpiMonth('2025-10', 306500),
    cpiMonth('2025-11', 306900), cpiMonth('2025-12', 307200), cpiMonth('2026-01', 307400),
  ]);
  const { inflationState } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(inflationState.cpiReferencePeriod, '2026-01');
  assert.deepEqual(inflationState.cpiLevel, fp(307400, 3));
  assert.deepEqual(inflationState.cpiMoM, fp(651, 6)); // 307400/307200-1
  assert.deepEqual(inflationState.cpiYoY, fp(24667, 6)); // 307400/300000-1
  assert.deepEqual(inflationState.cpiMoMChange, fp(-327, 6)); // 651 - 978
  assert.deepEqual(inflationState.cpiYoYChange, fp(667, 6)); // 24667 - 24000
  assert.equal(inflationState.inflationDirection, 'RISING'); // YoY change > 0
  assert.equal(inflationState.inflationAccelerationState, 'MIXED'); // MoM- , YoY+
  assert.equal(inflationState.cpiAvailabilityStatus, 'AVAILABLE');
  assert.equal(inflationState.monthsSinceLatestCpi, 1);
});

test('CPI missing prior month yields null MoM, never an approximation', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2025-01', 300000), cpiMonth('2026-01', 307400), // 2025-12 absent
  ]);
  const { inflationState } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(inflationState.cpiMoM, null);
  assert.equal(inflationState.cpiMoMChange, null);
  assert.equal(inflationState.cpiYoY, null); // every intermediate month is required
});

test('CPI YoY absent when the exact year-ago month is missing', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2025-12', 307200), cpiMonth('2026-01', 307400), // 2025-01 absent
  ]);
  const { inflationState } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(inflationState.cpiMoM, fp(651, 6));
  assert.equal(inflationState.cpiYoY, null);
  assert.equal(inflationState.inflationDirection, 'NOT_AVAILABLE');
});

test('CPI selects a causally available revision over the initial print', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2025-12', 307200),
    cpiMonth('2026-01', 307400, [{
      availableAt: '2026-02-20T13:30:00.000Z', sequence: 1, parentSequence: 0,
      revisionKind: 'REVISION', value: fp(307600, 3),
    }]),
  ]);
  const { inflationState } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(inflationState.cpiLevel, fp(307600, 3));
  assert.equal(inflationState.cpiRevisionKind, 'REVISION');
});

test('CPI future revision is never applied to a past cutoff (anti-lookahead)', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2025-12', 307200),
    cpiMonth('2026-01', 307400, [{
      availableAt: '2026-03-20T13:30:00.000Z', sequence: 1, parentSequence: 0,
      revisionKind: 'REVISION', value: fp(999999, 3),
    }]),
  ]);
  const before = computeInflationState({
    cpiIndex, knowledgeCutoff: '2026-02-28T00:00:00.000Z', sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(before.inflationState.cpiLevel, fp(307400, 3)); // initial, not the future revision
});

test('CPI release after the session close is NOT_AVAILABLE for that session', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [{
    referencePeriod: '2026-01',
    vintages: [{ availableAt: '2026-02-17T21:00:00.001Z', value: fp(307400, 3) }],
  }]);
  const result = computeInflationState({
    cpiIndex, knowledgeCutoff: '2026-02-17T21:00:00.000Z',
    sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.inflationState.cpiAvailabilityStatus, 'NOT_AVAILABLE');
});

test('CPI future reference period cannot backfill a past session even if misdated available', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [{
    referencePeriod: '2026-03',
    vintages: [{ availableAt: '2026-01-01T00:00:00.000Z', value: fp(999999, 3) }],
  }]);
  const result = computeInflationState({
    cpiIndex, knowledgeCutoff: '2026-02-17T21:00:00.000Z',
    sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.inflationState.cpiLevel, null);
});

test('CPI input scale divergence is rejected by the closed policy', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [{
    referencePeriod: '2026-01',
    vintages: [{ availableAt: '2026-02-14T13:30:00.000Z', value: fp(30740, 2) }],
  }]);
  assert.throws(() => computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  }), /CPI input scale must equal closed policy scale 3/u);
});

test('CPI withdrawal removes availability from its availableAt', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [
    cpiMonth('2025-12', 307200),
    cpiMonth('2026-01', 307400, [{
      availableAt: '2026-02-20T13:30:00.000Z', sequence: 1, parentSequence: 0,
      revisionKind: 'WITHDRAWAL', value: null,
    }]),
  ]);
  const { inflationState, availability } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(inflationState.cpiAvailabilityStatus, 'WITHDRAWN');
  assert.equal(inflationState.cpiLevel, null);
  assert.equal(availability, 'UNAVAILABLE');
});

test('CPI staleness flips to STALE beyond the policy month horizon', () => {
  const cpiIndex = syntheticSeriesIndex('CPI', [cpiMonth('2025-09', 305700)]);
  const { inflationState } = computeInflationState({
    cpiIndex, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(inflationState.monthsSinceLatestCpi, 5); // 2025-09 -> 2026-02
  assert.equal(inflationState.cpiAvailabilityStatus, 'STALE'); // > cpiStalenessMaxMonths (3)
});

test('UNRATE direction, trend and three-month change (nominal points)', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [
    { referencePeriod: '2025-10', vintages: [{ availableAt: avail('2025-10', 6), value: fp(42, 1) }] },
    { referencePeriod: '2025-11', vintages: [{ availableAt: avail('2025-11', 6), value: fp(42, 1) }] },
    { referencePeriod: '2025-12', vintages: [{ availableAt: avail('2025-12', 6), value: fp(43, 1) }] },
    { referencePeriod: '2026-01', vintages: [{ availableAt: avail('2026-01', 6), value: fp(44, 1) }] },
  ]);
  const { unemploymentState } = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(unemploymentState.unemploymentRate, fp(44, 1));
  assert.deepEqual(unemploymentState.unemploymentMoMChange, fp(1, 1)); // 4.4 - 4.3 = 0.1
  assert.deepEqual(unemploymentState.unemploymentThreeMonthChange, fp(2, 1)); // 4.4 - 4.2 = 0.2
  assert.equal(unemploymentState.unemploymentDirection, 'RISING');
  assert.equal(unemploymentState.unemploymentTrend, 'DETERIORATING'); // nominal rise
});

test('UNRATE falling reads as IMPROVING (narrow nominal semantics)', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [
    { referencePeriod: '2025-10', vintages: [{ availableAt: avail('2025-10', 6), value: fp(45, 1) }] },
    { referencePeriod: '2025-11', vintages: [{ availableAt: avail('2025-11', 6), value: fp(45, 1) }] },
    { referencePeriod: '2025-12', vintages: [{ availableAt: avail('2025-12', 6), value: fp(44, 1) }] },
    { referencePeriod: '2026-01', vintages: [{ availableAt: avail('2026-01', 6), value: fp(42, 1) }] },
  ]);
  const { unemploymentState } = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(unemploymentState.unemploymentMoMChange, fp(-2, 1)); // 4.2 - 4.4 = -0.2
  assert.equal(unemploymentState.unemploymentDirection, 'FALLING');
  assert.equal(unemploymentState.unemploymentTrend, 'IMPROVING');
});

test('UNRATE missing intermediate month refuses the three-month trend', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [
    { referencePeriod: '2025-10', vintages: [{ availableAt: avail('2025-10', 6), value: fp(41, 1) }] },
    // 2025-11 deliberately absent.
    { referencePeriod: '2025-12', vintages: [{ availableAt: avail('2025-12', 6), value: fp(42, 1) }] },
    { referencePeriod: '2026-01', vintages: [{ availableAt: avail('2026-01', 6), value: fp(43, 1) }] },
  ]);
  const { unemploymentState, availability } = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(unemploymentState.unemploymentMoMChange, fp(1, 1));
  assert.equal(unemploymentState.unemploymentThreeMonthChange, null);
  assert.equal(unemploymentState.unemploymentTrend, 'NOT_AVAILABLE');
  assert.equal(availability, 'PARTIAL');
});

test('UNRATE future revision is excluded before its availableAt', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [{
    referencePeriod: '2026-01',
    vintages: [
      { availableAt: '2026-02-06T13:30:00.000Z', value: fp(44, 1) },
      { availableAt: '2026-04-01T13:30:00.000Z', sequence: 1, parentSequence: 0, value: fp(99, 1) },
    ],
  }]);
  const result = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.deepEqual(result.unemploymentState.unemploymentRate, fp(44, 1));
});

test('UNRATE after-close publication does not affect the closing session', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [{
    referencePeriod: '2026-01',
    vintages: [{ availableAt: '2026-02-17T21:00:00.001Z', value: fp(44, 1) }],
  }]);
  const result = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: '2026-02-17T21:00:00.000Z',
    sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.unemploymentState.unemploymentAvailabilityStatus, 'NOT_AVAILABLE');
});

test('UNRATE withdrawal is explicit and unavailable', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [{
    referencePeriod: '2026-01',
    vintages: [
      { availableAt: '2026-02-06T13:30:00.000Z', value: fp(44, 1) },
      { availableAt: '2026-02-20T13:30:00.000Z', sequence: 1, parentSequence: 0,
        revisionKind: 'WITHDRAWAL', value: null },
    ],
  }]);
  const result = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.unemploymentState.unemploymentAvailabilityStatus, 'WITHDRAWN');
  assert.equal(result.availability, 'UNAVAILABLE');
});

test('UNRATE stale state is not marked fresh', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [{
    referencePeriod: '2025-09',
    vintages: [{ availableAt: '2025-10-06T13:30:00.000Z', value: fp(41, 1) }],
  }]);
  const result = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.unemploymentState.monthsSinceLatestUnrate, 5);
  assert.equal(result.unemploymentState.unemploymentAvailabilityStatus, 'STALE');
});

test('UNRATE opposing MoM and three-month signs produce MIXED', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [
    { referencePeriod: '2025-10', vintages: [{ availableAt: avail('2025-10', 6), value: fp(42, 1) }] },
    { referencePeriod: '2025-11', vintages: [{ availableAt: avail('2025-11', 6), value: fp(43, 1) }] },
    { referencePeriod: '2025-12', vintages: [{ availableAt: avail('2025-12', 6), value: fp(44, 1) }] },
    { referencePeriod: '2026-01', vintages: [{ availableAt: avail('2026-01', 6), value: fp(43, 1) }] },
  ]);
  const result = computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  });
  assert.equal(result.unemploymentState.unemploymentDirection, 'FALLING');
  assert.equal(result.unemploymentState.unemploymentTrend, 'MIXED');
});

test('UNRATE input scale divergence is rejected by the closed policy', () => {
  const unrate = syntheticSeriesIndex('UNRATE', [{
    referencePeriod: '2026-01',
    vintages: [{ availableAt: '2026-02-06T13:30:00.000Z', value: fp(440, 2) }],
  }]);
  assert.throws(() => computeUnemploymentState({
    unrateIndex: unrate, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY,
  }), /UNRATE input scale must equal closed policy scale 1/u);
});

function claimsWeek(weekEnd, value) {
  return {
    referencePeriod: weekEnd, periodStart: weekEnd, periodEnd: weekEnd,
    vintages: [{ availableAt: `${weekEnd}T13:30:00.000Z`, value: fp(value, 0) }],
  };
}

test('claims WoW, four-week average and spike classification', () => {
  const claims = syntheticSeriesIndex('ICSA', [
    claimsWeek('2025-12-13', 220000), claimsWeek('2025-12-20', 230000),
    claimsWeek('2025-12-27', 240000), claimsWeek('2026-01-03', 250000),
    claimsWeek('2026-01-10', 420000),
  ]);
  const { claimsState } = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.deepEqual(claimsState.initialClaims, fp(420000, 0));
  assert.equal(claimsState.claimsReferenceWeek, '2026-01-10');
  assert.deepEqual(claimsState.claimsWoWChange, fp(170000, 0)); // 420000 - 250000
  // four weeks: 420000,250000,240000,230000 -> 1140000/4 = 285000
  assert.deepEqual(claimsState.claimsFourWeekAverage, fp(285000, 0));
  assert.equal(claimsState.claimsSpikeState, 'SPIKE'); // >= 400000
  assert.equal(claimsState.claimsDirection, 'RISING');
});

test('claims elevated band and missing week yields null WoW', () => {
  const claims = syntheticSeriesIndex('ICSA', [
    claimsWeek('2025-08-30', 300000), claimsWeek('2025-09-06', 320000), // 2025-08-30..gap
  ]);
  // Current 2025-09-06 elevated; prior exact week 2025-08-30 present -> WoW available.
  const withPrev = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2025-09-11', policy: POLICY,
  });
  assert.equal(withPrev.claimsState.claimsSpikeState, 'ELEVATED');
  assert.deepEqual(withPrev.claimsState.claimsWoWChange, fp(20000, 0));
  assert.equal(withPrev.claimsState.claimsFourWeekAverage, null); // only two weeks present

  const claimsGap = syntheticSeriesIndex('ICSA', [claimsWeek('2025-09-06', 320000)]);
  const noPrev = computeClaimsState({
    claimsIndex: claimsGap, knowledgeCutoff: CUTOFF, sessionDate: '2025-09-11', policy: POLICY,
  });
  assert.equal(noPrev.claimsState.claimsWoWChange, null);
  assert.equal(noPrev.claimsState.claimsDirection, 'NOT_AVAILABLE');
});

test('claims future revision is excluded before availableAt', () => {
  const claims = syntheticSeriesIndex('ICSA', [{
    referencePeriod: '2026-01-10',
    vintages: [
      { availableAt: '2026-01-15T13:30:00.000Z', value: fp(220000, 0) },
      { availableAt: '2026-04-01T13:30:00.000Z', sequence: 1, parentSequence: 0,
        value: fp(999999, 0) },
    ],
  }]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: '2026-01-15T21:00:00.000Z',
    sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.deepEqual(result.claimsState.initialClaims, fp(220000, 0));
});

test('claims after-close release is NOT_AVAILABLE for that session', () => {
  const claims = syntheticSeriesIndex('ICSA', [{
    referencePeriod: '2026-01-10',
    vintages: [{ availableAt: '2026-01-15T21:00:00.001Z', value: fp(220000, 0) }],
  }]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: '2026-01-15T21:00:00.000Z',
    sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.equal(result.claimsState.claimsAvailabilityStatus, 'NOT_AVAILABLE');
});

test('claims future reference week cannot backfill a past session', () => {
  const claims = syntheticSeriesIndex('ICSA', [{
    referencePeriod: '2026-02-07',
    vintages: [{ availableAt: '2026-01-01T00:00:00.000Z', value: fp(999999, 0) }],
  }]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: '2026-01-15T21:00:00.000Z',
    sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.equal(result.claimsState.initialClaims, null);
});

test('claims withdrawal is explicit and unavailable', () => {
  const claims = syntheticSeriesIndex('ICSA', [{
    referencePeriod: '2026-01-10',
    vintages: [
      { availableAt: '2026-01-15T13:30:00.000Z', value: fp(220000, 0) },
      { availableAt: '2026-01-20T13:30:00.000Z', sequence: 1, parentSequence: 0,
        revisionKind: 'WITHDRAWAL', value: null },
    ],
  }]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2026-01-22', policy: POLICY,
  });
  assert.equal(result.claimsState.claimsAvailabilityStatus, 'WITHDRAWN');
  assert.equal(result.availability, 'UNAVAILABLE');
});

test('claims five-week path computes exact four-week average change', () => {
  const claims = syntheticSeriesIndex('ICSA', [
    claimsWeek('2025-12-13', 200000), claimsWeek('2025-12-20', 210000),
    claimsWeek('2025-12-27', 220000), claimsWeek('2026-01-03', 230000),
    claimsWeek('2026-01-10', 240000),
  ]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.deepEqual(result.claimsState.claimsFourWeekAverage, fp(225000, 0));
  assert.deepEqual(result.claimsState.claimsFourWeekAverageChange, fp(10000, 0));
});

test('claims opposing WoW and average signs produce MIXED', () => {
  const claims = syntheticSeriesIndex('ICSA', [
    claimsWeek('2025-12-13', 100), claimsWeek('2025-12-20', 100),
    claimsWeek('2025-12-27', 100), claimsWeek('2026-01-03', 400),
    claimsWeek('2026-01-10', 300),
  ]);
  const result = computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2026-01-15', policy: POLICY,
  });
  assert.equal(result.claimsState.claimsDirection, 'FALLING');
  assert.equal(result.claimsState.claimsTrend, 'MIXED');
});

test('claims input scale divergence is rejected by the closed policy', () => {
  const claims = syntheticSeriesIndex('ICSA', [{
    referencePeriod: '2026-01-10',
    vintages: [{ availableAt: '2026-01-15T13:30:00.000Z', value: fp(2200000, 1) }],
  }]);
  assert.throws(() => computeClaimsState({
    claimsIndex: claims, knowledgeCutoff: CUTOFF, sessionDate: '2026-01-15', policy: POLICY,
  }), /claims input scale must equal closed policy scale 0/u);
});

test('unavailable series produce NOT_AVAILABLE state', () => {
  const missing = { status: 'SERIES_NOT_IN_BINDING', byReferencePeriod: new Map(), orderedReferencePeriods: [] };
  const inflation = computeInflationState({ cpiIndex: missing, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY });
  assert.equal(inflation.inflationState.cpiAvailabilityStatus, 'NOT_AVAILABLE');
  assert.equal(inflation.availability, 'UNAVAILABLE');
  const labor = computeUnemploymentState({ unrateIndex: missing, knowledgeCutoff: CUTOFF, sessionMonthKey: '2026-02', policy: POLICY });
  assert.equal(labor.unemploymentState.unemploymentAvailabilityStatus, 'NOT_AVAILABLE');
  const claims = computeClaimsState({ claimsIndex: missing, knowledgeCutoff: CUTOFF, sessionDate: '2026-02-15', policy: POLICY });
  assert.equal(claims.claimsState.claimsSpikeState, 'NOT_AVAILABLE');
});

test('ratio primitive: division by zero is fail-closed', () => {
  assert.throws(() => macroRatioChangeFixed(fp(100, 2), fp(0, 2), 'MARKET_DATA_MACRO_CPI_RATIO_INVALID'),
    /MARKET_DATA_MACRO_CPI_RATIO_INVALID/);
});

test('ratio primitive: HALF_EVEN rounding at a tie boundary', () => {
  // 1.0000005 / 1 - 1 rounded to scale 6 ties to even -> 0.000000 (down to even 0)
  const r = macroRatioChangeFixed(fp(10000005, 7), fp(10000000, 7), 'X', 6);
  assert.deepEqual(r, fp(0, 6));
  // 1.0000015 -> ties to even -> 0.000002
  const r2 = macroRatioChangeFixed(fp(10000015, 7), fp(10000000, 7), 'X', 6);
  assert.deepEqual(r2, fp(2, 6));
});

test('ratio primitive: negative results carry a canonical sign and no -0', () => {
  const r = macroRatioChangeFixed(fp(99, 2), fp(100, 2), 'X'); // -0.01
  assert.deepEqual(r, fp(-10000, 6));
  assert.equal(macroFixedSign(fp(0, 6)), 0);
  assert.equal(macroFixedSign(r), -1);
});

test('ratio primitive handles large atoms and different input scales deterministically', () => {
  const first = macroRatioChangeFixed(
    fp('922337203685477', 4), fp('922337203685000', 4), 'X', 6,
  );
  const second = macroRatioChangeFixed(
    fp('922337203685477', 4), fp('922337203685000', 4), 'X', 6,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(macroRatioChangeFixed(fp(1005, 2), fp(1000, 3), 'X'), fp(9050000, 6));
});

test('nominal delta and window average are exact', () => {
  assert.deepEqual(macroNominalDeltaFixed(fp(43, 1), fp(41, 1), 'X'), fp(2, 1)); // 4.3 - 4.1 = 0.2
  assert.deepEqual(macroWindowAverageFixed([fp(200000, 0), fp(210000, 0), fp(220000, 0), fp(230000, 0)], 4, 0, 'X'),
    fp(215000, 0));
  assert.throws(() => macroWindowAverageFixed([fp(1, 0)], 4, 0, 'X'), /window average requires exactly 4/);
});

test('month arithmetic is closed and reversible', () => {
  assert.equal(addMonthsToMonthKey('2026-01', -1), '2025-12');
  assert.equal(addMonthsToMonthKey('2026-01', -13), '2024-12');
  assert.equal(addMonthsToMonthKey('2025-12', 1), '2026-01');
  assert.equal(monthsBetweenMonthKeys('2025-09', '2026-02'), 5);
  assert.equal(monthsBetweenMonthKeys('2026-01', '2026-01'), 0);
});
