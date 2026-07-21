/** Causal occurrence resolution and row derivation for L4A-C1. */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
  MARKET_SEASONALITY_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
  normalizeMarketSeasonalityFeatureRowsV1,
} from '../contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  compareFixed,
  fixedFromCanonical,
  fixedToCanonical,
  ratioChangeFixed,
} from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketSeasonalityRuntimePolicyV1 } from './marketSeasonalityRuntimePolicyL4V1.mjs';
import { calculateSeasonalityStatisticsV1 } from './marketSeasonalityStatisticsL4V1.mjs';

const BASIS_TREATMENT = Object.freeze({
  RAW: 'RAW_SOURCE_UNTRANSFORMED',
  SPLIT_ADJUSTED: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
});

function fail(code, message, details = {}) {
  throw new MarketDataL3Error(code, message, details);
}

function civilParts(civilDate) {
  if (typeof civilDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'civil date is invalid');
  }
  return {
    year: Number(civilDate.slice(0, 4)),
    month: Number(civilDate.slice(5, 7)),
    day: Number(civilDate.slice(8, 10)),
  };
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function resolveSeasonalityCivilDateV1(year, anchorMonth, anchorDay, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(anchorMonth)
      || !Number.isSafeInteger(anchorDay) || anchorMonth < 1 || anchorMonth > 12
      || anchorDay < 1 || anchorDay > 31) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'seasonality civil anchor is invalid');
  }
  const day = anchorMonth === 2 && anchorDay === 29 && !isLeapYear(year) ? 28 : anchorDay;
  return `${String(year).padStart(4, '0')}-${String(anchorMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Verify the binding-selected basis; no transformation or fallback occurs. */
export function validateSeasonalityPriceBasisClosureV1(input) {
  const expectedTreatment = BASIS_TREATMENT[input?.priceBasis];
  if (expectedTreatment === undefined) {
    fail(
      'MARKET_DATA_SEASONALITY_PRICE_BASIS_UNAVAILABLE',
      'seasonality price basis is absent or unsupported',
    );
  }
  if (input.corporateActionTreatment !== expectedTreatment) {
    fail(
      'MARKET_DATA_SEASONALITY_PRICE_BASIS_MISMATCH',
      'seasonality price basis and corporate-action treatment disagree',
    );
  }
  if (input.rows !== undefined) {
    if (!Array.isArray(input.rows)) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'price-basis rows must be an array');
    }
    for (let index = 0; index < input.rows.length; index += 1) {
      if (input.rows[index].priceBasis !== input.priceBasis) {
        fail(
          'MARKET_DATA_SEASONALITY_PRICE_BASIS_MISMATCH',
          'seasonality row price basis diverges from the binding', { index },
        );
      }
    }
  }
  return true;
}

function lowerBound(dates, target) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dates[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBound(dates, target) {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (dates[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function buildCalendarIndex(calendarSessions, calendarCoverage) {
  if (!Array.isArray(calendarSessions) || !Array.isArray(calendarCoverage)) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'calendar sessions and coverage must be arrays');
  }
  const dates = [];
  const kinds = [];
  const seen = new Set();
  for (const session of calendarSessions) {
    const date = session?.sessionDate;
    civilParts(date);
    if (!['REGULAR_SESSION', 'HALF_DAY_SESSION'].includes(session.sessionKind)) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'calendar session kind is unsupported');
    }
    if (seen.has(date)) fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'calendar contains duplicate session date');
    if (dates.length > 0 && dates.at(-1) >= date) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'calendar sessions must be sorted');
    }
    seen.add(date);
    dates.push(date);
    kinds.push(session.sessionKind);
  }
  const coverage = calendarCoverage.map((item) => {
    civilParts(item.coverageFromDate);
    civilParts(item.coverageToDateExclusive);
    if (item.coverageFromDate >= item.coverageToDateExclusive) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'calendar coverage is reversed');
    }
    return {
      coverageFromDate: item.coverageFromDate,
      coverageToDateExclusive: item.coverageToDateExclusive,
    };
  }).sort((left, right) => left.coverageFromDate.localeCompare(right.coverageFromDate));
  return { dates, kinds, coverage };
}

function isCovered(calendar, date) {
  return calendar.coverage.some((range) => (
    range.coverageFromDate <= date && date < range.coverageToDateExclusive
  ));
}

function buildBarIndex(rows) {
  if (!Array.isArray(rows)) fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'source rows must be an array');
  const byDate = new Map();
  let previousKey = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    civilParts(row.sessionDate);
    const key = `${row.sessionDate}\0${row.barIdentityId}`;
    if (previousKey !== null && previousKey >= key) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'source rows must use canonical ordering');
    }
    if (byDate.has(row.sessionDate)) {
      fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'source rows contain duplicate session date');
    }
    previousKey = key;
    byDate.set(row.sessionDate, row);
  }
  return byDate;
}

function price(row, field, runtime) {
  const atoms = row?.[`${field}Atoms`];
  if (typeof atoms !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(atoms)
      || !Number.isSafeInteger(row?.priceScale) || row.priceScale < 0) return null;
  try {
    return fixedFromCanonical({ atoms, scale: row.priceScale }, runtime.internalScale);
  } catch {
    return null;
  }
}

function occurrenceMetrics(rows, runtime) {
  const startClose = price(rows[0], 'close', runtime);
  const endClose = price(rows.at(-1), 'close', runtime);
  if (startClose === null || endClose === null) return { reason: 'MISSING_INPUT' };
  if (startClose.atoms === 0n) return { reason: 'DIVISION_BY_ZERO' };
  let adverse = null;
  let favorable = null;
  for (let index = 1; index < rows.length; index += 1) {
    const high = price(rows[index], 'high', runtime);
    const low = price(rows[index], 'low', runtime);
    if (high === null || low === null) return { reason: 'MISSING_INPUT' };
    const highChange = ratioChangeFixed(high, startClose, runtime.internalScale);
    const lowChange = ratioChangeFixed(low, startClose, runtime.internalScale);
    if (favorable === null || compareFixed(highChange, favorable) > 0) favorable = highChange;
    if (adverse === null || compareFixed(lowChange, adverse) < 0) adverse = lowChange;
  }
  return {
    reason: null,
    returnValue: ratioChangeFixed(endClose, startClose, runtime.internalScale),
    maxAdverseExcursion: adverse,
    maxFavorableExcursion: favorable,
  };
}

export function buildMarketSeasonalityOccurrenceIdentityV1(value) {
  const fields = [
    'instrumentIdentityId', 'datasetSnapshotBindingId', 'priceBasis',
    'corporateActionTreatment', 'forwardSessionCount', 'historicalYear',
    'startSessionDate', 'endSessionDate', 'anchorMonth', 'anchorDay',
  ];
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Reflect.ownKeys(value).length !== fields.length
      || fields.some((field) => !Object.hasOwn(value, field))) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'occurrence identity input is not closed');
  }
  const identity = {
    schemaVersion: MARKET_SEASONALITY_OCCURRENCE_IDENTITY_SCHEMA_VERSION,
    instrumentIdentityId: value.instrumentIdentityId,
    datasetSnapshotBindingId: value.datasetSnapshotBindingId,
    priceBasis: value.priceBasis,
    corporateActionTreatment: value.corporateActionTreatment,
    forwardSessionCount: value.forwardSessionCount,
    historicalYear: value.historicalYear,
    startSessionDate: value.startSessionDate,
    endSessionDate: value.endSessionDate,
    anchorMonth: value.anchorMonth,
    anchorDay: value.anchorDay,
  };
  return { identity, occurrenceIdentityId: canonicalHash(identity.schemaVersion, identity) };
}

export function assertSeasonalityOccurrenceSetClosedV1(occurrences) {
  if (!Array.isArray(occurrences)) fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'occurrences must be an array');
  const byId = new Set();
  const byYear = new Map();
  for (const occurrence of occurrences) {
    if (byId.has(occurrence.occurrenceIdentityId)) {
      fail(
        'MARKET_DATA_SEASONALITY_OCCURRENCE_IDENTITY_CONFLICT',
        'duplicate occurrence identity inside one horizon',
      );
    }
    byId.add(occurrence.occurrenceIdentityId);
    const existing = byYear.get(occurrence.historicalYear);
    if (existing !== undefined && existing !== occurrence.occurrenceIdentityId) {
      fail(
        'MARKET_DATA_SEASONALITY_OCCURRENCE_IDENTITY_CONFLICT',
        'two occurrence identities claim the same historical year',
      );
    }
    byYear.set(occurrence.historicalYear, occurrence.occurrenceIdentityId);
  }
  return occurrences;
}

function emptyDiagnostics(candidateYearCount) {
  return {
    candidateYearCount,
    calendarAlignmentUnavailableCount: 0,
    lookaheadRejectedCount: 0,
    missingInputCount: 0,
    divisionByZeroCount: 0,
    rawHistoryCoverageComplete: false,
  };
}

/** Resolve exactly one occurrence per candidate historical year. */
export function resolveHistoricalSeasonalityOccurrencesV1(input, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  const calendar = input.preparedCalendarIndex
    ?? buildCalendarIndex(input.calendarSessions, input.calendarCoverage);
  const bars = input.preparedBarIndex ?? buildBarIndex(input.sourceRows);
  const anchor = civilParts(input.asOfSessionDate);
  if (!runtime.horizons.includes(input.horizonYears)
      || !runtime.forwardSessionCounts.includes(input.forwardSessionCount)) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'horizon or forwardSessionCount is outside V1');
  }
  const diagnostics = emptyDiagnostics(input.horizonYears);
  const occurrences = [];
  const maximumVisibleIndex = upperBound(calendar.dates, input.asOfSessionDate) - 1;
  const oldestYear = anchor.year - input.horizonYears;
  let oldestStartCivil = null;
  for (let historicalYear = oldestYear; historicalYear <= anchor.year - 1; historicalYear += 1) {
    const startCivil = resolveSeasonalityCivilDateV1(
      historicalYear, anchor.month, anchor.day, runtime,
    );
    if (oldestStartCivil === null) oldestStartCivil = startCivil;
    if (!isCovered(calendar, startCivil)) {
      diagnostics.calendarAlignmentUnavailableCount += 1;
      continue;
    }
    const startIndex = lowerBound(calendar.dates, startCivil);
    if (startIndex >= calendar.dates.length || !isCovered(calendar, calendar.dates[startIndex])) {
      diagnostics.calendarAlignmentUnavailableCount += 1;
      continue;
    }
    const endIndex = startIndex + input.forwardSessionCount;
    if (endIndex >= calendar.dates.length || !isCovered(calendar, calendar.dates[endIndex])) {
      diagnostics.calendarAlignmentUnavailableCount += 1;
      continue;
    }
    if (endIndex > maximumVisibleIndex) {
      diagnostics.lookaheadRejectedCount += 1;
      continue;
    }
    const occurrenceRows = [];
    let missing = false;
    for (let index = startIndex; index <= endIndex; index += 1) {
      const row = bars.get(calendar.dates[index]);
      if (row === undefined) {
        missing = true;
        break;
      }
      occurrenceRows.push(row);
    }
    if (missing) {
      diagnostics.missingInputCount += 1;
      continue;
    }
    const metrics = occurrenceMetrics(occurrenceRows, runtime);
    if (metrics.reason === 'MISSING_INPUT') {
      diagnostics.missingInputCount += 1;
      continue;
    }
    if (metrics.reason === 'DIVISION_BY_ZERO') {
      diagnostics.divisionByZeroCount += 1;
      continue;
    }
    const identity = buildMarketSeasonalityOccurrenceIdentityV1({
      instrumentIdentityId: input.instrumentIdentityId,
      datasetSnapshotBindingId: input.datasetSnapshotBindingId,
      priceBasis: input.priceBasis,
      corporateActionTreatment: input.corporateActionTreatment,
      forwardSessionCount: input.forwardSessionCount,
      historicalYear,
      startSessionDate: calendar.dates[startIndex],
      endSessionDate: calendar.dates[endIndex],
      anchorMonth: anchor.month,
      anchorDay: anchor.day,
    });
    occurrences.push({
      occurrenceIdentityId: identity.occurrenceIdentityId,
      historicalYear,
      startSessionDate: calendar.dates[startIndex],
      endSessionDate: calendar.dates[endIndex],
      returnValue: metrics.returnValue,
      maxAdverseExcursion: metrics.maxAdverseExcursion,
      maxFavorableExcursion: metrics.maxFavorableExcursion,
    });
  }
  assertSeasonalityOccurrenceSetClosedV1(occurrences);
  diagnostics.rawHistoryCoverageComplete = input.sourceRows.length > 0
    && oldestStartCivil !== null && input.sourceRows[0].sessionDate <= oldestStartCivil;
  return { occurrences, diagnostics };
}

function primaryAvailability(occurrenceCount, diagnostics, runtime) {
  if (diagnostics.calendarAlignmentUnavailableCount > 0) return 'CALENDAR_ALIGNMENT_UNAVAILABLE';
  if (occurrenceCount === 0) return 'NO_ELIGIBLE_OCCURRENCE';
  if (!diagnostics.rawHistoryCoverageComplete) return 'INSUFFICIENT_HISTORY';
  if (occurrenceCount < runtime.minimumOccurrenceCount) return 'MINIMUM_SAMPLE_NOT_MET';
  return 'AVAILABLE';
}

function canonicalMetric(value, runtime) {
  return value === null ? null : fixedToCanonical(value, runtime.ratioScale);
}

/** Descriptive current-year window, bounded strictly by asOfSessionDate. */
export function calculateCurrentSeasonalityWindowV1(input, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  const calendar = input.preparedCalendarIndex
    ?? buildCalendarIndex(input.calendarSessions, input.calendarCoverage);
  const bars = input.preparedBarIndex ?? buildBarIndex(input.sourceRows);
  const anchorCivilDate = input.anchorCivilDate;
  civilParts(anchorCivilDate);
  civilParts(input.asOfSessionDate);
  const base = {
    forwardSessionCount: input.forwardSessionCount,
    anchorCivilDate,
  };
  if (anchorCivilDate > input.asOfSessionDate) {
    return {
      ...base, status: 'NOT_STARTED', startSessionDate: null, expectedEndSessionDate: null,
      sessionsElapsed: null, sessionsRemaining: input.forwardSessionCount, returnToDate: null,
      maxAdverseExcursionToDate: null, maxFavorableExcursionToDate: null,
      availabilityReason: 'FUTURE_WINDOW',
    };
  }
  if (!isCovered(calendar, anchorCivilDate)) {
    return {
      ...base, status: 'UNAVAILABLE', startSessionDate: null, expectedEndSessionDate: null,
      sessionsElapsed: null, sessionsRemaining: null, returnToDate: null,
      maxAdverseExcursionToDate: null, maxFavorableExcursionToDate: null,
      availabilityReason: 'CALENDAR_ALIGNMENT_UNAVAILABLE',
    };
  }
  const startIndex = lowerBound(calendar.dates, anchorCivilDate);
  const maximumVisibleIndex = upperBound(calendar.dates, input.asOfSessionDate) - 1;
  if (startIndex >= calendar.dates.length || startIndex > maximumVisibleIndex) {
    return {
      ...base, status: 'NOT_STARTED', startSessionDate: null, expectedEndSessionDate: null,
      sessionsElapsed: null, sessionsRemaining: input.forwardSessionCount, returnToDate: null,
      maxAdverseExcursionToDate: null, maxFavorableExcursionToDate: null,
      availabilityReason: 'FUTURE_WINDOW',
    };
  }
  const targetEndIndex = startIndex + input.forwardSessionCount;
  const visibleEndIndex = Math.min(maximumVisibleIndex, targetEndIndex);
  const rows = [];
  for (let index = startIndex; index <= visibleEndIndex; index += 1) {
    const row = bars.get(calendar.dates[index]);
    if (row === undefined) {
      return {
        ...base, status: 'UNAVAILABLE', startSessionDate: calendar.dates[startIndex],
        expectedEndSessionDate: null, sessionsElapsed: null, sessionsRemaining: null,
        returnToDate: null, maxAdverseExcursionToDate: null,
        maxFavorableExcursionToDate: null, availabilityReason: 'MISSING_INPUT',
      };
    }
    rows.push(row);
  }
  const startClose = price(rows[0], 'close', runtime);
  const endClose = price(rows.at(-1), 'close', runtime);
  if (startClose === null || endClose === null) {
    return {
      ...base, status: 'UNAVAILABLE', startSessionDate: calendar.dates[startIndex],
      expectedEndSessionDate: null, sessionsElapsed: null, sessionsRemaining: null,
      returnToDate: null, maxAdverseExcursionToDate: null,
      maxFavorableExcursionToDate: null, availabilityReason: 'MISSING_INPUT',
    };
  }
  if (startClose.atoms === 0n) {
    return {
      ...base, status: 'UNAVAILABLE', startSessionDate: calendar.dates[startIndex],
      expectedEndSessionDate: null, sessionsElapsed: null, sessionsRemaining: null,
      returnToDate: null, maxAdverseExcursionToDate: null,
      maxFavorableExcursionToDate: null, availabilityReason: 'DIVISION_BY_ZERO',
    };
  }
  let adverse = null;
  let favorable = null;
  for (let index = 1; index < rows.length; index += 1) {
    const high = price(rows[index], 'high', runtime);
    const low = price(rows[index], 'low', runtime);
    if (high === null || low === null) {
      return {
        ...base, status: 'UNAVAILABLE', startSessionDate: calendar.dates[startIndex],
        expectedEndSessionDate: null, sessionsElapsed: null, sessionsRemaining: null,
        returnToDate: null, maxAdverseExcursionToDate: null,
        maxFavorableExcursionToDate: null, availabilityReason: 'MISSING_INPUT',
      };
    }
    const highChange = ratioChangeFixed(high, startClose, runtime.internalScale);
    const lowChange = ratioChangeFixed(low, startClose, runtime.internalScale);
    if (favorable === null || compareFixed(highChange, favorable) > 0) favorable = highChange;
    if (adverse === null || compareFixed(lowChange, adverse) < 0) adverse = lowChange;
  }
  const sessionsElapsed = visibleEndIndex - startIndex;
  const complete = sessionsElapsed === input.forwardSessionCount;
  return {
    ...base,
    status: complete ? 'COMPLETE_AS_OF_T' : 'IN_PROGRESS',
    startSessionDate: calendar.dates[startIndex],
    expectedEndSessionDate: complete ? calendar.dates[targetEndIndex] : null,
    sessionsElapsed,
    sessionsRemaining: input.forwardSessionCount - sessionsElapsed,
    returnToDate: canonicalMetric(
      ratioChangeFixed(endClose, startClose, runtime.internalScale), runtime,
    ),
    maxAdverseExcursionToDate: canonicalMetric(adverse, runtime),
    maxFavorableExcursionToDate: canonicalMetric(favorable, runtime),
    availabilityReason: complete ? 'AVAILABLE' : 'PARTIAL_WINDOW',
  };
}

/** Build normalized rows end-to-end without creating a C2 report/verifier. */
export function deriveMarketSeasonalityFeatureRowsDocumentV1(sourceRuntime, runtime) {
  assertMarketSeasonalityRuntimePolicyV1(runtime);
  validateSeasonalityPriceBasisClosureV1({
    priceBasis: sourceRuntime.sourceBundle.priceBasis,
    corporateActionTreatment: sourceRuntime.sourceBundle.corporateActionTreatment,
    rows: sourceRuntime.sourceRows,
  });
  const preparedCalendarIndex = buildCalendarIndex(
    sourceRuntime.calendarSessions, sourceRuntime.calendarCoverage,
  );
  const preparedBarIndex = buildBarIndex(sourceRuntime.sourceRows);
  const outputSourceRows = sourceRuntime.targetSessionDate === undefined
    ? sourceRuntime.sourceRows
    : sourceRuntime.sourceRows.filter((row) => row.sessionDate === sourceRuntime.targetSessionDate);
  const rows = outputSourceRows.map((sourceRow) => {
    const horizonWindows = [];
    for (const horizonYears of runtime.horizons) {
      for (const forwardSessionCount of runtime.forwardSessionCounts) {
        const resolved = resolveHistoricalSeasonalityOccurrencesV1({
          sourceRows: sourceRuntime.sourceRows,
          calendarSessions: sourceRuntime.calendarSessions,
          calendarCoverage: sourceRuntime.calendarCoverage,
          asOfSessionDate: sourceRow.sessionDate,
          horizonYears,
          forwardSessionCount,
          instrumentIdentityId: sourceRuntime.sourceBundle.instrumentIdentityId,
          datasetSnapshotBindingId: sourceRuntime.sourceBundle.subjectBindingId,
          priceBasis: sourceRuntime.sourceBundle.priceBasis,
          corporateActionTreatment: sourceRuntime.sourceBundle.corporateActionTreatment,
          preparedCalendarIndex,
          preparedBarIndex,
        }, runtime);
        horizonWindows.push({
          horizonYears,
          forwardSessionCount,
          ...calculateSeasonalityStatisticsV1(resolved.occurrences, runtime),
          primaryAvailabilityReason: primaryAvailability(
            resolved.occurrences.length, resolved.diagnostics, runtime,
          ),
          diagnostics: resolved.diagnostics,
        });
      }
    }
    const currentWindows = runtime.forwardSessionCounts.map((forwardSessionCount) => (
      calculateCurrentSeasonalityWindowV1({
        sourceRows: sourceRuntime.sourceRows,
        calendarSessions: sourceRuntime.calendarSessions,
        calendarCoverage: sourceRuntime.calendarCoverage,
        anchorCivilDate: sourceRow.sessionDate,
        asOfSessionDate: sourceRow.sessionDate,
        forwardSessionCount,
        preparedCalendarIndex,
        preparedBarIndex,
      }, runtime)
    ));
    const available = horizonWindows.filter(
      (window) => window.primaryAvailabilityReason === 'AVAILABLE',
    ).length;
    return {
      sourceBundleId: sourceRuntime.sourceBundleId,
      computationPolicyId: sourceRuntime.computationPolicyId,
      datasetSnapshotBindingId: sourceRuntime.sourceBundle.subjectBindingId,
      instrumentIdentityId: sourceRuntime.sourceBundle.instrumentIdentityId,
      sessionDate: sourceRow.sessionDate,
      subjectBarIdentityId: sourceRow.barIdentityId,
      subjectResolvedObservationId: sourceRow.resolvedObservationId,
      features: { seasonality: { horizonWindows, currentWindows } },
      availability: {
        availableHorizonWindowCount: available,
        unavailableHorizonWindowCount: horizonWindows.length - available,
      },
    };
  });
  return normalizeMarketSeasonalityFeatureRowsV1({
    schemaVersion: MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    rows,
  });
}

/** Testable single-row derivation using the same authoritative implementation. */
export function deriveMarketSeasonalityFeatureRowV1(sourceRuntime, sessionDate, runtime) {
  const document = deriveMarketSeasonalityFeatureRowsDocumentV1({
    ...sourceRuntime,
    targetSessionDate: sessionDate,
  }, runtime);
  if (document.rows.length !== 1) {
    fail('MARKET_DATA_SEASONALITY_INPUT_INVALID', 'target sessionDate must identify exactly one source row');
  }
  return document.rows[0];
}
