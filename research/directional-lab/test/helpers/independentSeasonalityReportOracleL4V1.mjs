/**
 * Independent L4A-C2 report oracle.
 * Must not import report builder, compute orchestration, or occurrence engine.
 * Digest uses CanonicalJSON from the shared canonical module to avoid encoding drift.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';

const HORIZONS = Object.freeze([3, 5, 10, 15]);
const FORWARDS = Object.freeze([5, 10, 20, 40, 60]);
const PRIMARY_REASONS = Object.freeze([
  'PRICE_BASIS_UNAVAILABLE',
  'CALENDAR_ALIGNMENT_UNAVAILABLE',
  'NO_ELIGIBLE_OCCURRENCE',
  'INSUFFICIENT_HISTORY',
  'MINIMUM_SAMPLE_NOT_MET',
  'AVAILABLE',
]);
const REJECTED_KEYS = Object.freeze([
  'calendarAlignmentUnavailableCount',
  'lookaheadRejectedCount',
  'missingInputCount',
  'divisionByZeroCount',
]);
const CURRENT_STATUSES = Object.freeze([
  'NOT_STARTED', 'IN_PROGRESS', 'COMPLETE_AS_OF_T', 'UNAVAILABLE',
]);

function emptyBucket() {
  return { rowPresenceCount: 0, occurrenceCountSum: 0 };
}

function emptyCounts(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

/** SHA-256 of CanonicalJSON([{ sessionDate, subjectBarIdentityId }, ...]) in row order. */
export function oracleOrderedRowIdentityDigest(rows) {
  const projection = rows.map((row) => ({
    sessionDate: row.sessionDate,
    subjectBarIdentityId: row.subjectBarIdentityId,
  }));
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(projection)).digest('hex')}`;
}

/**
 * Counters derivable from rows alone (plus optional occurrence unions for distinct fields).
 * Does NOT invent distinctOccurrenceCount from Σ occurrenceCount.
 * @param {{ rows: object[] }} document
 * @param {object} [unions]
 */
export function oracleReportCountersFromRows(document, unions = undefined) {
  const rows = document.rows;
  const countsByHorizon = Object.fromEntries(HORIZONS.map((h) => [String(h), emptyBucket()]));
  const countsByForwardSessionCount = Object.fromEntries(
    FORWARDS.map((f) => [String(f), emptyBucket()]),
  );
  const availabilityCounts = {
    availableHorizonWindowCount: 0,
    unavailableHorizonWindowCount: 0,
  };
  const primaryAvailabilityReasonCounts = emptyCounts(PRIMARY_REASONS);
  const rejectedOccurrenceCounts = emptyCounts(REJECTED_KEYS);
  const currentWindowStatusCounts = emptyCounts(CURRENT_STATUSES);

  for (const row of rows) {
    availabilityCounts.availableHorizonWindowCount += row.availability.availableHorizonWindowCount;
    availabilityCounts.unavailableHorizonWindowCount += row.availability.unavailableHorizonWindowCount;
    for (const window of row.features.seasonality.horizonWindows) {
      const horizonKey = String(window.horizonYears);
      const forwardKey = String(window.forwardSessionCount);
      countsByHorizon[horizonKey].rowPresenceCount += 1;
      countsByHorizon[horizonKey].occurrenceCountSum += window.occurrenceCount;
      countsByForwardSessionCount[forwardKey].rowPresenceCount += 1;
      countsByForwardSessionCount[forwardKey].occurrenceCountSum += window.occurrenceCount;
      primaryAvailabilityReasonCounts[window.primaryAvailabilityReason] += 1;
      for (const key of REJECTED_KEYS) {
        rejectedOccurrenceCounts[key] += window.diagnostics[key];
      }
    }
    for (const window of row.features.seasonality.currentWindows) {
      currentWindowStatusCounts[window.status] += 1;
    }
  }

  const result = {
    rowCount: rows.length,
    firstSessionDate: rows.length === 0 ? null : rows[0].sessionDate,
    lastSessionDate: rows.length === 0 ? null : rows[rows.length - 1].sessionDate,
    emptySnapshot: rows.length === 0,
    orderedRowIdentityDigest: oracleOrderedRowIdentityDigest(rows),
    countsByHorizon,
    countsByForwardSessionCount,
    availabilityCounts,
    primaryAvailabilityReasonCounts,
    rejectedOccurrenceCounts,
    currentWindowStatusCounts,
    partialCurrentWindowCount: currentWindowStatusCounts.IN_PROGRESS,
    completedCurrentWindowCount: currentWindowStatusCounts.COMPLETE_AS_OF_T,
  };

  if (unions !== undefined) {
    result.distinctOccurrenceCount = unions.distinctOccurrenceCount;
    result.distinctHistoricalYearCount = unions.distinctHistoricalYearCount;
    for (const horizon of HORIZONS) {
      const key = String(horizon);
      countsByHorizon[key].distinctOccurrenceCount = unions.distinctOccurrenceCountByHorizon[key];
    }
    for (const forward of FORWARDS) {
      const key = String(forward);
      countsByForwardSessionCount[key].distinctOccurrenceCount =
        unions.distinctOccurrenceCountByForwardSessionCount[key];
    }
  }

  return result;
}

const ID = (digit) => `sha256:${digit.repeat(64)}`;

function diag(overrides = {}) {
  return {
    candidateYearCount: 0,
    calendarAlignmentUnavailableCount: 0,
    lookaheadRejectedCount: 0,
    missingInputCount: 0,
    divisionByZeroCount: 0,
    rawHistoryCoverageComplete: false,
    ...overrides,
  };
}

function horizonWindow(horizonYears, forwardSessionCount, overrides = {}) {
  return {
    horizonYears,
    forwardSessionCount,
    occurrenceCount: 0,
    primaryAvailabilityReason: 'INSUFFICIENT_HISTORY',
    diagnostics: diag(),
    ...overrides,
  };
}

function currentWindow(forwardSessionCount, status = 'NOT_STARTED') {
  return { forwardSessionCount, status };
}

function allHorizons(overridesByPair = {}) {
  const windows = [];
  for (const horizon of HORIZONS) {
    for (const forward of FORWARDS) {
      const key = `${horizon}:${forward}`;
      windows.push(horizonWindow(horizon, forward, overridesByPair[key] ?? {}));
    }
  }
  return windows;
}

function allCurrent(statusByForward = {}) {
  return FORWARDS.map((forward) => currentWindow(forward, statusByForward[forward] ?? 'NOT_STARTED'));
}

function stubRow(sessionDate, barDigit, options = {}) {
  const horizonWindows = options.horizonWindows ?? allHorizons(options.overridesByPair ?? {});
  const available = horizonWindows.filter((w) => w.primaryAvailabilityReason === 'AVAILABLE').length;
  return {
    sessionDate,
    subjectBarIdentityId: ID(barDigit),
    availability: options.availability ?? {
      availableHorizonWindowCount: available,
      unavailableHorizonWindowCount: horizonWindows.length - available,
    },
    features: {
      seasonality: {
        horizonWindows,
        currentWindows: options.currentWindows ?? allCurrent(options.statusByForward ?? {}),
      },
    },
  };
}

const EMPTY_EXPECTED = oracleReportCountersFromRows({ rows: [] });

const oneRow = stubRow('2024-01-02', '1');
const twoA = stubRow('2024-01-02', '1');
const twoB = stubRow('2024-01-03', '2');
const mixed = stubRow('2025-06-01', '3', {
  overridesByPair: {
    '3:5': {
      occurrenceCount: 2,
      primaryAvailabilityReason: 'AVAILABLE',
      diagnostics: diag({ candidateYearCount: 3, missingInputCount: 1 }),
    },
    '5:10': {
      occurrenceCount: 1,
      primaryAvailabilityReason: 'MINIMUM_SAMPLE_NOT_MET',
      diagnostics: diag({ lookaheadRejectedCount: 2 }),
    },
  },
  statusByForward: { 5: 'IN_PROGRESS', 10: 'COMPLETE_AS_OF_T', 20: 'UNAVAILABLE' },
});
const rejectedHeavy = stubRow('2023-03-15', '4', {
  overridesByPair: Object.fromEntries(
    HORIZONS.flatMap((h) => FORWARDS.map((f) => [
      `${h}:${f}`,
      {
        primaryAvailabilityReason: 'CALENDAR_ALIGNMENT_UNAVAILABLE',
        diagnostics: diag({ calendarAlignmentUnavailableCount: 1, divisionByZeroCount: 1 }),
      },
    ])),
  ),
});

/** ≥20 named vector fixtures for the independent report oracle. */
export const REPORT_ORACLE_VECTORS = Object.freeze([
  {
    name: 'empty-rows',
    rows: [],
    expected: EMPTY_EXPECTED,
  },
  {
    name: 'one-row-baseline',
    rows: [oneRow],
    expected: oracleReportCountersFromRows({ rows: [oneRow] }),
  },
  {
    name: 'two-rows-ordered',
    rows: [twoA, twoB],
    expected: oracleReportCountersFromRows({ rows: [twoA, twoB] }),
  },
  {
    name: 'two-rows-inverted-order-digest-differs',
    rows: [twoB, twoA],
    expected: {
      ...oracleReportCountersFromRows({ rows: [twoB, twoA] }),
      // Detect inverted presentation vs canonical ascending order.
      _digestDiffersFromCanonical: oracleOrderedRowIdentityDigest([twoB, twoA])
        !== oracleOrderedRowIdentityDigest([twoA, twoB]),
    },
  },
  {
    name: 'mixed-availability-and-status',
    rows: [mixed],
    expected: oracleReportCountersFromRows({ rows: [mixed] }),
  },
  {
    name: 'rejected-diagnostics-sum',
    rows: [rejectedHeavy],
    expected: oracleReportCountersFromRows({ rows: [rejectedHeavy] }),
  },
  {
    name: 'three-rows-dates',
    rows: [
      stubRow('2020-01-02', '1'),
      stubRow('2021-01-02', '2'),
      stubRow('2022-01-02', '3'),
    ],
    expected: oracleReportCountersFromRows({
      rows: [
        stubRow('2020-01-02', '1'),
        stubRow('2021-01-02', '2'),
        stubRow('2022-01-02', '3'),
      ],
    }),
  },
  {
    name: 'all-available-one-horizon-pair',
    rows: [stubRow('2024-07-01', '5', {
      overridesByPair: {
        '15:60': { occurrenceCount: 4, primaryAvailabilityReason: 'AVAILABLE' },
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2024-07-01', '5', {
        overridesByPair: {
          '15:60': { occurrenceCount: 4, primaryAvailabilityReason: 'AVAILABLE' },
        },
      })],
    }),
  },
  {
    name: 'partial-and-completed-current',
    rows: [stubRow('2024-08-01', '6', {
      statusByForward: {
        5: 'IN_PROGRESS',
        10: 'IN_PROGRESS',
        20: 'COMPLETE_AS_OF_T',
        40: 'COMPLETE_AS_OF_T',
        60: 'NOT_STARTED',
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2024-08-01', '6', {
        statusByForward: {
          5: 'IN_PROGRESS',
          10: 'IN_PROGRESS',
          20: 'COMPLETE_AS_OF_T',
          40: 'COMPLETE_AS_OF_T',
          60: 'NOT_STARTED',
        },
      })],
    }),
  },
  {
    name: 'price-basis-unavailable',
    rows: [stubRow('2024-09-01', '7', {
      overridesByPair: Object.fromEntries(
        HORIZONS.flatMap((h) => FORWARDS.map((f) => [
          `${h}:${f}`,
          { primaryAvailabilityReason: 'PRICE_BASIS_UNAVAILABLE' },
        ])),
      ),
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2024-09-01', '7', {
        overridesByPair: Object.fromEntries(
          HORIZONS.flatMap((h) => FORWARDS.map((f) => [
            `${h}:${f}`,
            { primaryAvailabilityReason: 'PRICE_BASIS_UNAVAILABLE' },
          ])),
        ),
      })],
    }),
  },
  {
    name: 'no-eligible-occurrence',
    rows: [stubRow('2024-10-01', '8', {
      overridesByPair: {
        '3:5': { primaryAvailabilityReason: 'NO_ELIGIBLE_OCCURRENCE' },
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2024-10-01', '8', {
        overridesByPair: {
          '3:5': { primaryAvailabilityReason: 'NO_ELIGIBLE_OCCURRENCE' },
        },
      })],
    }),
  },
  {
    name: 'occurrence-sum-across-two-rows',
    rows: [
      stubRow('2024-01-02', '1', {
        overridesByPair: { '3:5': { occurrenceCount: 3, primaryAvailabilityReason: 'AVAILABLE' } },
      }),
      stubRow('2024-01-03', '2', {
        overridesByPair: { '3:5': { occurrenceCount: 2, primaryAvailabilityReason: 'AVAILABLE' } },
      }),
    ],
    expected: oracleReportCountersFromRows({
      rows: [
        stubRow('2024-01-02', '1', {
          overridesByPair: { '3:5': { occurrenceCount: 3, primaryAvailabilityReason: 'AVAILABLE' } },
        }),
        stubRow('2024-01-03', '2', {
          overridesByPair: { '3:5': { occurrenceCount: 2, primaryAvailabilityReason: 'AVAILABLE' } },
        }),
      ],
    }),
  },
  {
    name: 'forward-bucket-presence',
    rows: [stubRow('2024-11-01', '9')],
    expected: oracleReportCountersFromRows({ rows: [stubRow('2024-11-01', '9')] }),
  },
  {
    name: 'lookahead-rejected-count',
    rows: [stubRow('2024-12-01', 'a', {
      overridesByPair: {
        '10:20': {
          diagnostics: diag({ lookaheadRejectedCount: 5 }),
          primaryAvailabilityReason: 'INSUFFICIENT_HISTORY',
        },
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2024-12-01', 'a', {
        overridesByPair: {
          '10:20': {
            diagnostics: diag({ lookaheadRejectedCount: 5 }),
            primaryAvailabilityReason: 'INSUFFICIENT_HISTORY',
          },
        },
      })],
    }),
  },
  {
    name: 'division-by-zero-count',
    rows: [stubRow('2025-01-01', 'b', {
      overridesByPair: {
        '15:5': {
          diagnostics: diag({ divisionByZeroCount: 3 }),
          primaryAvailabilityReason: 'INSUFFICIENT_HISTORY',
        },
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2025-01-01', 'b', {
        overridesByPair: {
          '15:5': {
            diagnostics: diag({ divisionByZeroCount: 3 }),
            primaryAvailabilityReason: 'INSUFFICIENT_HISTORY',
          },
        },
      })],
    }),
  },
  {
    name: 'unavailable-current-status',
    rows: [stubRow('2025-02-01', 'c', {
      statusByForward: {
        5: 'UNAVAILABLE', 10: 'UNAVAILABLE', 20: 'UNAVAILABLE',
        40: 'UNAVAILABLE', 60: 'UNAVAILABLE',
      },
    })],
    expected: oracleReportCountersFromRows({
      rows: [stubRow('2025-02-01', 'c', {
        statusByForward: {
          5: 'UNAVAILABLE', 10: 'UNAVAILABLE', 20: 'UNAVAILABLE',
          40: 'UNAVAILABLE', 60: 'UNAVAILABLE',
        },
      })],
    }),
  },
  {
    name: 'empty-with-optional-zero-unions',
    rows: [],
    unions: {
      distinctOccurrenceCount: 0,
      distinctHistoricalYearCount: 0,
      distinctOccurrenceCountByHorizon: { 3: 0, 5: 0, 10: 0, 15: 0 },
      distinctOccurrenceCountByForwardSessionCount: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 },
    },
    expected: oracleReportCountersFromRows({ rows: [] }, {
      distinctOccurrenceCount: 0,
      distinctHistoricalYearCount: 0,
      distinctOccurrenceCountByHorizon: { 3: 0, 5: 0, 10: 0, 15: 0 },
      distinctOccurrenceCountByForwardSessionCount: { 5: 0, 10: 0, 20: 0, 40: 0, 60: 0 },
    }),
  },
  {
    name: 'digest-identity-only-fields',
    rows: [stubRow('2025-03-01', 'd')],
    expected: {
      orderedRowIdentityDigest: oracleOrderedRowIdentityDigest([stubRow('2025-03-01', 'd')]),
      rowCount: 1,
      emptySnapshot: false,
      firstSessionDate: '2025-03-01',
      lastSessionDate: '2025-03-01',
    },
    compare: 'identity-subset',
  },
  {
    name: 'bar-id-change-changes-digest',
    rows: [stubRow('2025-03-01', 'e')],
    expected: {
      digestDiffersFromSibling: oracleOrderedRowIdentityDigest([stubRow('2025-03-01', 'e')])
        !== oracleOrderedRowIdentityDigest([stubRow('2025-03-01', 'f')]),
    },
    compare: 'digest-diff',
  },
  {
    name: 'session-date-change-changes-digest',
    rows: [stubRow('2025-03-01', 'e')],
    expected: {
      digestDiffersFromSibling: oracleOrderedRowIdentityDigest([stubRow('2025-03-01', 'e')])
        !== oracleOrderedRowIdentityDigest([stubRow('2025-03-02', 'e')]),
    },
    compare: 'digest-diff',
  },
  {
    name: 'two-row-availability-aggregate',
    rows: [
      stubRow('2025-04-01', '1', {
        overridesByPair: { '3:5': { primaryAvailabilityReason: 'AVAILABLE', occurrenceCount: 1 } },
      }),
      stubRow('2025-04-02', '2', {
        overridesByPair: { '5:10': { primaryAvailabilityReason: 'AVAILABLE', occurrenceCount: 1 } },
      }),
    ],
    expected: oracleReportCountersFromRows({
      rows: [
        stubRow('2025-04-01', '1', {
          overridesByPair: { '3:5': { primaryAvailabilityReason: 'AVAILABLE', occurrenceCount: 1 } },
        }),
        stubRow('2025-04-02', '2', {
          overridesByPair: { '5:10': { primaryAvailabilityReason: 'AVAILABLE', occurrenceCount: 1 } },
        }),
      ],
    }),
  },
  {
    // Each row contributes one presence per (horizon × forward) pair → 2 rows × 5 forwards = 10.
    name: 'horizon-row-presence-equals-rows-times-forwards',
    rows: [stubRow('2025-05-01', '1'), stubRow('2025-05-02', '2')],
    expected: {
      countsByHorizon: {
        3: { rowPresenceCount: 10 },
        5: { rowPresenceCount: 10 },
        10: { rowPresenceCount: 10 },
        15: { rowPresenceCount: 10 },
      },
    },
    compare: 'horizon-presence',
  },
]);
