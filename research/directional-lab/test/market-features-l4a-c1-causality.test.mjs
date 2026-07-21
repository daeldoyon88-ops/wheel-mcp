import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { normalizeMarketSeasonalityFeatureRowsV1 } from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import { addDays } from '../src/time/civilDate.mjs';
import {
  assertSeasonalityOccurrenceSetClosedV1,
  buildMarketSeasonalityOccurrenceIdentityV1,
  calculateCurrentSeasonalityWindowV1,
  deriveMarketSeasonalityFeatureRowV1,
  deriveMarketSeasonalityFeatureRowsDocumentV1,
  resolveHistoricalSeasonalityOccurrencesV1,
  resolveSeasonalityCivilDateV1,
  validateSeasonalityPriceBasisClosureV1,
} from '../src/features/marketSeasonalityOccurrenceEngineL4V1.mjs';
import { MARKET_SEASONALITY_RUNTIME_POLICY_V1 as RUNTIME } from '../src/features/marketSeasonalityRuntimePolicyL4V1.mjs';
import { makeSeasonalityCausalFixture } from './marketSeasonalityL4SyntheticFixture.mjs';

const fixture = makeSeasonalityCausalFixture();
const TARGET = '2026-01-02';

function resolved(horizonYears, forwardSessionCount, overrides = {}) {
  return resolveHistoricalSeasonalityOccurrencesV1({
    sourceRows: fixture.sourceRows,
    calendarSessions: fixture.calendarSessions,
    calendarCoverage: fixture.calendarCoverage,
    asOfSessionDate: TARGET,
    horizonYears,
    forwardSessionCount,
    instrumentIdentityId: fixture.sourceBundle.instrumentIdentityId,
    datasetSnapshotBindingId: fixture.sourceBundle.subjectBindingId,
    priceBasis: fixture.sourceBundle.priceBasis,
    corporateActionTreatment: fixture.sourceBundle.corporateActionTreatment,
    ...overrides,
  }, RUNTIME);
}

test('L4A-C1 forwardSessionCount=5 means index i to i+5 and six required bars', () => {
  const result = resolved(3, 5);
  assert.equal(result.occurrences.length, 3);
  for (const occurrence of result.occurrences) {
    assert.equal(occurrence.endSessionDate, addDays(occurrence.startSessionDate, 5));
  }
  const terminalDate = result.occurrences[0].endSessionDate;
  const missingTerminal = resolved(3, 5, {
    sourceRows: fixture.sourceRows.filter((row) => row.sessionDate !== terminalDate),
  });
  assert.equal(missingTerminal.occurrences.length, 2);
  assert.equal(missingTerminal.diagnostics.missingInputCount, 1);
});

test('L4A-C1 forwardSessionCount=10 means ten transitions and eleven bars', () => {
  const result = resolved(3, 10);
  assert.equal(result.occurrences.length, 3);
  assert.equal(result.occurrences.every((occurrence) => (
    occurrence.endSessionDate === addDays(occurrence.startSessionDate, 10)
  )), true);
  const terminal = result.occurrences[0].endSessionDate;
  assert.equal(resolved(3, 10, {
    sourceRows: fixture.sourceRows.filter((row) => row.sessionDate !== terminal),
  }).diagnostics.missingInputCount, 1);
});

test('L4A-C1 horizons are nested without cross-horizon summation', () => {
  const sets = new Map([3, 5, 10, 15].map((horizon) => [
    horizon,
    new Set(resolved(horizon, 20).occurrences.map((item) => item.occurrenceIdentityId)),
  ]));
  for (const [shorter, longer] of [[3, 5], [5, 10], [10, 15]]) {
    assert.equal([...sets.get(shorter)].every((id) => sets.get(longer).has(id)), true);
    assert.ok(sets.get(shorter).size <= shorter);
  }
  assert.equal(sets.get(15).size, 15);
  assert.equal(sets.get(3).size + sets.get(5).size + sets.get(10).size + sets.get(15).size, 33);
  assert.notEqual(sets.get(15).size, 33);
});

test('L4A-C1 shared historical occurrence has the same ID in 3y and 15y', () => {
  const short = resolved(3, 10).occurrences;
  const long = resolved(15, 10).occurrences;
  for (const occurrence of short) {
    assert.equal(
      long.find((candidate) => candidate.historicalYear === occurrence.historicalYear)
        .occurrenceIdentityId,
      occurrence.occurrenceIdentityId,
    );
  }
});

test('L4A-C1 occurrence identity is canonical, insertion-order independent and field-sensitive', () => {
  const value = {
    instrumentIdentityId: fixture.sourceBundle.instrumentIdentityId,
    datasetSnapshotBindingId: fixture.sourceBundle.subjectBindingId,
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
    forwardSessionCount: 5,
    historicalYear: 2025,
    startSessionDate: '2025-01-02',
    endSessionDate: '2025-01-07',
    anchorMonth: 1,
    anchorDay: 2,
  };
  const first = buildMarketSeasonalityOccurrenceIdentityV1(value).occurrenceIdentityId;
  const reversed = Object.fromEntries(Object.entries(value).reverse());
  assert.equal(buildMarketSeasonalityOccurrenceIdentityV1(reversed).occurrenceIdentityId, first);
  for (const [field, replacement] of [
    ['priceBasis', 'SPLIT_ADJUSTED'],
    ['startSessionDate', '2025-01-03'],
    ['endSessionDate', '2025-01-08'],
  ]) {
    assert.notEqual(
      buildMarketSeasonalityOccurrenceIdentityV1({ ...value, [field]: replacement })
        .occurrenceIdentityId,
      first,
    );
  }
});

test('L4A-C1 duplicate identity or duplicate historical year fails closed', () => {
  const base = { occurrenceIdentityId: `sha256:${'1'.repeat(64)}`, historicalYear: 2024 };
  assert.throws(
    () => assertSeasonalityOccurrenceSetClosedV1([base, { ...base }]),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_OCCURRENCE_IDENTITY_CONFLICT',
  );
  assert.throws(
    () => assertSeasonalityOccurrenceSetClosedV1([
      base,
      { occurrenceIdentityId: `sha256:${'2'.repeat(64)}`, historicalYear: 2024 },
    ]),
    (error) => error?.code === 'MARKET_DATA_SEASONALITY_OCCURRENCE_IDENTITY_CONFLICT',
  );
});

test('L4A-C1 row bytes are prefix invariant after future bars and calendar sessions are appended', () => {
  const prefixRows = fixture.sourceRows.filter((row) => row.sessionDate <= TARGET);
  const prefixCalendar = fixture.calendarSessions.filter((session) => session.sessionDate <= TARGET);
  const prefixRow = deriveMarketSeasonalityFeatureRowV1({
    ...fixture,
    sourceRows: prefixRows,
    calendarSessions: prefixCalendar,
  }, TARGET, RUNTIME);
  const fullRow = deriveMarketSeasonalityFeatureRowV1(fixture, TARGET, RUNTIME);
  assert.equal(canonicalJsonBytes(prefixRow).equals(canonicalJsonBytes(fullRow)), true);
  assert.equal(
    fullRow.features.seasonality.horizonWindows.every((window) => (
      window.diagnostics.lookaheadRejectedCount === 0
    )),
    true,
  );
  assert.equal(
    fullRow.features.seasonality.currentWindows.every((window) => window.status === 'IN_PROGRESS'),
    true,
  );
});

test('L4A-C1 excludes the current year from every historical set', () => {
  for (const horizon of RUNTIME.horizons) {
    const years = resolved(horizon, 5).occurrences.map((occurrence) => occurrence.historicalYear);
    assert.equal(years.includes(2026), false);
    assert.equal(Math.max(...years), 2025);
  }
});

test('L4A-C1 admits causal cross-year windows and rejects a terminal session after t', () => {
  const sessions = [];
  const rows = [];
  for (let offset = 0; offset < 20; offset += 1) {
    const sessionDate = addDays('2025-12-28', offset);
    sessions.push({ sessionDate, sessionKind: 'REGULAR_SESSION' });
    rows.push({
      ...fixture.sourceRows[0],
      sessionDate,
      barIdentityId: `sha256:${(offset + 5000).toString(16).padStart(64, '0')}`,
      resolvedObservationId: `sha256:${(offset + 6000).toString(16).padStart(64, '0')}`,
      closeAtoms: String(10000 + offset), highAtoms: String(10010 + offset),
      lowAtoms: String(9990 + offset), openAtoms: String(10000 + offset),
    });
  }
  sessions.push({ sessionDate: '2026-12-28', sessionKind: 'REGULAR_SESSION' });
  rows.push({
    ...fixture.sourceRows[0],
    sessionDate: '2026-12-28',
    barIdentityId: `sha256:${(7000).toString(16).padStart(64, '0')}`,
    resolvedObservationId: `sha256:${(8000).toString(16).padStart(64, '0')}`,
  });
  const common = {
    sourceRows: rows,
    calendarSessions: sessions,
    calendarCoverage: [{ coverageFromDate: '2025-12-01', coverageToDateExclusive: '2026-02-01' }],
    horizonYears: 3,
    forwardSessionCount: 10,
    instrumentIdentityId: fixture.sourceBundle.instrumentIdentityId,
    datasetSnapshotBindingId: fixture.sourceBundle.subjectBindingId,
    priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED',
  };
  const crossYear = resolveHistoricalSeasonalityOccurrencesV1({
    ...common, asOfSessionDate: '2026-12-28',
  }, RUNTIME);
  assert.equal(crossYear.occurrences.some((item) => (
    item.historicalYear === 2025 && item.endSessionDate.startsWith('2026-')
  )), true);

  const sparseDates = [
    '2025-01-02', '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-01-04', '2026-01-05', '2026-01-06',
  ];
  const sparseRows = sparseDates.map((sessionDate, index) => ({
    ...fixture.sourceRows[0],
    sessionDate,
    barIdentityId: `sha256:${(9000 + index).toString(16).padStart(64, '0')}`,
    resolvedObservationId: `sha256:${(10000 + index).toString(16).padStart(64, '0')}`,
  }));
  const lookahead = resolveHistoricalSeasonalityOccurrencesV1({
    ...common,
    sourceRows: sparseRows,
    calendarSessions: sparseDates.map((sessionDate) => ({
      sessionDate, sessionKind: 'REGULAR_SESSION',
    })),
    calendarCoverage: [{ coverageFromDate: '2025-01-01', coverageToDateExclusive: '2026-02-01' }],
    asOfSessionDate: '2026-01-02',
    forwardSessionCount: 5,
  }, RUNTIME);
  assert.equal(lookahead.diagnostics.lookaheadRejectedCount, 1);
});

test('L4A-C1 leap day policy is UTC-civil and deterministic', () => {
  assert.equal(resolveSeasonalityCivilDateV1(2024, 2, 29, RUNTIME), '2024-02-29');
  assert.equal(resolveSeasonalityCivilDateV1(2023, 2, 29, RUNTIME), '2023-02-28');
  assert.equal(resolveSeasonalityCivilDateV1(2100, 2, 29, RUNTIME), '2100-02-28');
  assert.equal(resolveSeasonalityCivilDateV1(2000, 2, 29, RUNTIME), '2000-02-29');
});

test('L4A-C1 currentWindow closes NOT_STARTED, IN_PROGRESS, COMPLETE and UNAVAILABLE', () => {
  const common = {
    sourceRows: fixture.sourceRows,
    calendarSessions: fixture.calendarSessions,
    calendarCoverage: fixture.calendarCoverage,
    forwardSessionCount: 5,
  };
  assert.equal(calculateCurrentSeasonalityWindowV1({
    ...common, anchorCivilDate: '2026-01-03', asOfSessionDate: '2026-01-02',
  }, RUNTIME).status, 'NOT_STARTED');
  const progress = calculateCurrentSeasonalityWindowV1({
    ...common, anchorCivilDate: '2026-01-02', asOfSessionDate: '2026-01-02',
  }, RUNTIME);
  assert.equal(progress.status, 'IN_PROGRESS');
  assert.equal(progress.sessionsElapsed, 0);
  assert.equal(progress.sessionsRemaining, 5);
  assert.equal(progress.returnToDate.atoms, '0');
  assert.equal(progress.expectedEndSessionDate, null);
  const complete = calculateCurrentSeasonalityWindowV1({
    ...common, anchorCivilDate: '2025-01-02', asOfSessionDate: '2025-01-07',
  }, RUNTIME);
  assert.equal(complete.status, 'COMPLETE_AS_OF_T');
  assert.equal(complete.sessionsElapsed, 5);
  assert.equal(complete.sessionsRemaining, 0);
  assert.equal(complete.expectedEndSessionDate, '2025-01-07');
  assert.equal(calculateCurrentSeasonalityWindowV1({
    ...common,
    anchorCivilDate: '2001-01-02',
    asOfSessionDate: '2001-01-02',
  }, RUNTIME).status, 'UNAVAILABLE');
});

test('L4A-C1 price-basis closure supports RAW and SPLIT_ADJUSTED without fallback', () => {
  assert.equal(validateSeasonalityPriceBasisClosureV1({
    priceBasis: 'RAW', corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', rows: [],
  }), true);
  assert.equal(validateSeasonalityPriceBasisClosureV1({
    priceBasis: 'SPLIT_ADJUSTED',
    corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED', rows: [],
  }), true);
  assert.throws(() => validateSeasonalityPriceBasisClosureV1({
    priceBasis: 'RAW',
    corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED', rows: [],
  }), (error) => error?.code === 'MARKET_DATA_SEASONALITY_PRICE_BASIS_MISMATCH');
  assert.throws(() => validateSeasonalityPriceBasisClosureV1({
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', rows: [],
  }), (error) => error?.code === 'MARKET_DATA_SEASONALITY_PRICE_BASIS_UNAVAILABLE');
});

test('L4A-C1 availability priority is unique for available, minimum, insufficient and empty samples', () => {
  const windowFor = (sourceRows, mutate = {}) => deriveMarketSeasonalityFeatureRowV1({
    ...fixture,
    sourceRows,
    ...mutate,
  }, TARGET, RUNTIME).features.seasonality.horizonWindows.find((window) => (
    window.horizonYears === 15 && window.forwardSessionCount === 5
  ));
  assert.equal(windowFor(fixture.sourceRows).primaryAvailabilityReason, 'AVAILABLE');

  const twoYears = fixture.sourceRows.filter((row) => (
    row.sessionDate < '2011-01-01'
    || row.sessionDate.startsWith('2024-')
    || row.sessionDate.startsWith('2025-')
    || row.sessionDate === TARGET
  ));
  const minimum = windowFor(twoYears);
  assert.equal(minimum.occurrenceCount, 2);
  assert.equal(minimum.primaryAvailabilityReason, 'MINIMUM_SAMPLE_NOT_MET');

  const short = fixture.sourceRows.filter((row) => row.sessionDate >= '2023-01-01');
  const insufficient = windowFor(short);
  assert.equal(insufficient.occurrenceCount, 3);
  assert.equal(insufficient.primaryAvailabilityReason, 'INSUFFICIENT_HISTORY');

  const emptyHistory = fixture.sourceRows.filter((row) => (
    row.sessionDate < '2011-01-01' || row.sessionDate === TARGET
  ));
  const empty = windowFor(emptyHistory);
  assert.equal(empty.occurrenceCount, 0);
  assert.equal(empty.primaryAvailabilityReason, 'NO_ELIGIBLE_OCCURRENCE');

  const missingCoverage = windowFor(fixture.sourceRows, {
    calendarCoverage: fixture.calendarCoverage.filter((range) => (
      !range.coverageFromDate.startsWith('2025-')
    )),
  });
  assert.equal(missingCoverage.primaryAvailabilityReason, 'CALENDAR_ALIGNMENT_UNAVAILABLE');
});

test('L4A-C1 MAE/MFE excludes the start bar, includes terminal bar and rejects missing inputs', () => {
  const baseline = resolved(3, 5).occurrences.find((item) => item.historicalYear === 2025);
  const startExtremeRows = fixture.sourceRows.map((row) => row.sessionDate === '2025-01-02'
    ? { ...row, highAtoms: '999999999', lowAtoms: '1' }
    : row);
  const startExtreme = resolved(3, 5, { sourceRows: startExtremeRows })
    .occurrences.find((item) => item.historicalYear === 2025);
  assert.deepEqual(startExtreme.maxAdverseExcursion, baseline.maxAdverseExcursion);
  assert.deepEqual(startExtreme.maxFavorableExcursion, baseline.maxFavorableExcursion);

  const terminalExtremeRows = fixture.sourceRows.map((row) => row.sessionDate === '2025-01-07'
    ? { ...row, highAtoms: '999999999', lowAtoms: '1' }
    : row);
  const terminalExtreme = resolved(3, 5, { sourceRows: terminalExtremeRows })
    .occurrences.find((item) => item.historicalYear === 2025);
  assert.ok(terminalExtreme.maxFavorableExcursion.atoms > baseline.maxFavorableExcursion.atoms);
  assert.ok(terminalExtreme.maxAdverseExcursion.atoms < baseline.maxAdverseExcursion.atoms);

  const missingHigh = fixture.sourceRows.map((row) => row.sessionDate === '2025-01-05'
    ? { ...row, highAtoms: null }
    : row);
  const rejected = resolved(3, 5, { sourceRows: missingHigh });
  assert.equal(rejected.occurrences.some((item) => item.historicalYear === 2025), false);
  assert.equal(rejected.diagnostics.missingInputCount, 1);
});

test('L4A-C1 MAE may be positive and MFE may be negative without sign clamping', () => {
  const start = fixture.sourceRows.find((row) => row.sessionDate === '2025-01-02');
  const startAtoms = BigInt(start.closeAtoms);
  const positiveAdverseRows = fixture.sourceRows.map((row) => (
    row.sessionDate > '2025-01-02' && row.sessionDate <= '2025-01-07'
      ? { ...row, highAtoms: (startAtoms + 10n).toString(), lowAtoms: (startAtoms + 1n).toString() }
      : row
  ));
  const positiveAdverse = resolved(3, 5, { sourceRows: positiveAdverseRows })
    .occurrences.find((item) => item.historicalYear === 2025);
  assert.ok(positiveAdverse.maxAdverseExcursion.atoms > 0n);

  const negativeFavorableRows = fixture.sourceRows.map((row) => (
    row.sessionDate > '2025-01-02' && row.sessionDate <= '2025-01-07'
      ? { ...row, highAtoms: (startAtoms - 1n).toString(), lowAtoms: (startAtoms - 10n).toString() }
      : row
  ));
  const negativeFavorable = resolved(3, 5, { sourceRows: negativeFavorableRows })
    .occurrences.find((item) => item.historicalYear === 2025);
  assert.ok(negativeFavorable.maxFavorableExcursion.atoms < 0n);
});

test('L4A-C1 division by zero and a middle-session hole reject only the affected occurrence', () => {
  const zeroStart = fixture.sourceRows.map((row) => row.sessionDate === '2025-01-02'
    ? { ...row, closeAtoms: '0' }
    : row);
  const zero = resolved(3, 5, { sourceRows: zeroStart });
  assert.equal(zero.diagnostics.divisionByZeroCount, 1);
  assert.equal(zero.occurrences.length, 2);

  const hole = resolved(3, 5, {
    sourceRows: fixture.sourceRows.filter((row) => row.sessionDate !== '2025-01-05'),
  });
  assert.equal(hole.diagnostics.missingInputCount, 1);
  assert.equal(hole.occurrences.length, 2);
});

test('L4A-C1 half-day sessions are ordinary observed sessions and no bar is invented', () => {
  const result = resolved(3, 20);
  assert.equal(result.occurrences.length, 3);
  assert.equal(result.occurrences.every((occurrence) => (
    occurrence.endSessionDate === addDays(occurrence.startSessionDate, 20)
  )), true);
});

test('L4A-C1 empty source derives rows=[] and a long fixture completes without a time oracle', () => {
  const empty = deriveMarketSeasonalityFeatureRowsDocumentV1({
    ...fixture,
    sourceRows: [],
    calendarSessions: [],
    calendarCoverage: [],
  }, RUNTIME);
  assert.deepEqual(empty.rows, []);

  const longFixture = makeSeasonalityCausalFixture({ firstYear: 2020, lastYear: 2026 });
  const document = deriveMarketSeasonalityFeatureRowsDocumentV1(longFixture, RUNTIME);
  assert.equal(document.rows.length, longFixture.sourceRows.length);
  assert.equal(document.rows[0].sessionDate, longFixture.sourceRows[0].sessionDate);
  assert.equal(document.rows.at(-1).sessionDate, longFixture.sourceRows.at(-1).sessionDate);
  assert.throws(() => normalizeMarketSeasonalityFeatureRowsV1({
    schemaVersion: 'MarketSeasonalityFeatureRows/1',
    rows: [document.rows[1], document.rows[0]],
  }));
});

test('L4A-C1 on-or-after alignment skips closed civil days without inventing sessions', () => {
  const rows = fixture.sourceRows.filter((row) => row.sessionDate === '2025-01-08');
  const current = calculateCurrentSeasonalityWindowV1({
    sourceRows: rows,
    calendarSessions: [{ sessionDate: '2025-01-08', sessionKind: 'REGULAR_SESSION' }],
    calendarCoverage: [{ coverageFromDate: '2025-01-01', coverageToDateExclusive: '2025-01-10' }],
    anchorCivilDate: '2025-01-06',
    asOfSessionDate: '2025-01-08',
    forwardSessionCount: 5,
  }, RUNTIME);
  assert.equal(current.startSessionDate, '2025-01-08');
  assert.equal(current.sessionsElapsed, 0);
  assert.equal(current.status, 'IN_PROGRESS');
});
