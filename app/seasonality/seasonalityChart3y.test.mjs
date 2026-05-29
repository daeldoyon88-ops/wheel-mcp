import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHART_YEARS,
  buildSeasonalityChart3yFromRows,
  computeActiveWindowProgress,
  computeOccurrence,
  computePaceStatus,
  computeProgressTimePct,
  filterPriceSeries3y,
  findBarOnOrAfter,
  findBarOnOrBefore,
  isCrossYearWindow,
  resolveOccurrenceDates,
  toIsoDate,
} from './seasonalityChart3y.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTradingDays(startDate, numDays, getClose = (_d, p) => p) {
  const rows = [];
  const d = new Date(startDate);
  let price = 100;

  while (rows.length < numDays) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      price = Number(getClose(d, price).toFixed(4));
      rows.push({
        date: new Date(d),
        open: price,
        high: price,
        low: price,
        close: price,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return rows;
}

function mockSwingWindow(overrides = {}) {
  return {
    displayLabel: '15 avr. → 15 juil.',
    startMonth: 4,
    startDay: 15,
    endMonth: 7,
    endDay: 15,
    startDayOfYear: 105,
    endDayOfYear: 196,
    avgReturn: 0.721,
    winRate: 1,
    worstReturn: 0.499,
    confidence: 'robuste',
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('filterPriceSeries3y ne garde que les ~3 dernières années', () => {
  const start = new Date(Date.UTC(2018, 0, 2));
  const rows = makeTradingDays(start, 260 * 6);
  const asOf = new Date(Date.UTC(2024, 5, 15));
  const filtered = filterPriceSeries3y(rows, asOf, CHART_YEARS);

  const startIso = toIsoDate(filtered[0].date);
  const cutoff = new Date(asOf);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - CHART_YEARS);
  const cutoffIso = toIsoDate(cutoff);

  assert.ok(filtered.length >= 650 && filtered.length <= 820, `points=${filtered.length}`);
  assert.ok(startIso >= cutoffIso, `start ${startIso} doit être >= ${cutoffIso}`);
  assert.equal(filtered.length, filterPriceSeries3y(rows, asOf, CHART_YEARS).length);
});

test('occurrence normale — startClose, endClose et realizedReturn corrects', () => {
  const rows = makeTradingDays(new Date(Date.UTC(2023, 0, 2)), 600, (date, price) => {
    const iso = toIsoDate(date);
    if (iso === '2024-04-15') return 42.12;
    if (iso === '2024-07-15') return 67.80;
    return price;
  });

  const window = mockSwingWindow();
  const occ = computeOccurrence(window, rows, 2024, new Date(Date.UTC(2024, 11, 31)));

  assert.equal(occ.status, 'complete');
  assert.equal(occ.startDate, '2024-04-15');
  assert.equal(occ.endDate, '2024-07-15');
  assert.equal(occ.startClose, 42.12);
  assert.equal(occ.endClose, 67.8);
  assert.ok(Math.abs(occ.realizedReturn - 0.6098) < 0.001);
});

test('occurrence cross-year — une seule occurrence continue oct→jan', () => {
  const crossWindow = mockSwingWindow({
    displayLabel: '29 oct. → 29 jan.',
    startMonth: 10,
    startDay: 29,
    endMonth: 1,
    endDay: 29,
    startDayOfYear: 302,
    endDayOfYear: 29,
  });

  assert.ok(isCrossYearWindow(crossWindow));

  const dates = resolveOccurrenceDates(crossWindow, 2024);
  assert.equal(dates.startDate, '2024-10-29');
  assert.equal(dates.endDate, '2025-01-29');

  const rows = makeTradingDays(new Date(Date.UTC(2023, 0, 2)), 600, (date, price) => {
    const iso = toIsoDate(date);
    if (iso === '2024-10-29') return 50;
    if (iso === '2025-01-29') return 60;
    return price;
  });

  const occ = computeOccurrence(crossWindow, rows, 2024, new Date(Date.UTC(2025, 2, 1)));
  assert.equal(occ.status, 'complete');
  assert.equal(occ.startDate, '2024-10-29');
  assert.equal(occ.endDate, '2025-01-29');
  assert.equal(occ.realizedReturn, 0.2);

  const chart = buildSeasonalityChart3yFromRows(rows, {
    asOfDate: new Date(Date.UTC(2025, 2, 1)),
    symbol: 'TEST',
    years: 3,
    annualDisplayWindows: {
      bullish: [crossWindow],
      bearishConfirmed: [],
      vigilance: [],
    },
    swingWindows: { bullish: [crossWindow], bearish: [] },
  });

  const overlay = chart.annualOverlays.find((o) => o.id === 'bullish-1');
  const occ2024 = overlay.occurrences.filter((o) => o.year === 2024);
  assert.equal(occ2024.length, 1, 'une seule occurrence cross-year, pas deux segments');
});

test('fenêtre active — progressTimePct et progressReturnPct séparés', () => {
  const window = mockSwingWindow();
  const asOf = new Date(Date.UTC(2026, 4, 27)); // 27 mai 2026

  const rows = makeTradingDays(new Date(Date.UTC(2023, 0, 2)), 900, (date, price) => {
    const iso = toIsoDate(date);
    if (iso === '2026-04-15') return 61.20;
    if (iso === '2026-05-27') return 93.40;
    return price;
  });

  const swingOverlays = [{
    id: 'bullish-1',
    type: 'bullish',
    rank: 1,
    displayLabel: window.displayLabel,
    expectedReturn: 0.721,
    startDayOfYear: window.startDayOfYear,
    endDayOfYear: window.endDayOfYear,
    startMonth: window.startMonth,
    startDay: window.startDay,
    endMonth: window.endMonth,
    endDay: window.endDay,
    occurrences: [],
  }];

  const active = computeActiveWindowProgress(swingOverlays, rows, asOf);

  assert.equal(active.isActive, true);
  assert.equal(active.startDate, '2026-04-15');
  assert.equal(active.endDate, '2026-07-15');
  assert.equal(active.asOfDate, '2026-05-27');
  assert.equal(active.startClose, 61.2);
  assert.equal(active.currentClose, 93.4);

  const expectedRealized = _r4((93.40 / 61.20) - 1);
  assert.equal(active.realizedReturn, expectedRealized);

  const timePct = computeProgressTimePct('2026-04-15', '2026-07-15', '2026-05-27');
  assert.ok(timePct > 0.3 && timePct < 0.6, `progressTimePct=${timePct}`);
  assert.notEqual(active.progressTimePct, active.progressReturnPct);
  assert.ok(active.progressReturnPct != null);
  assert.ok(['ahead', 'behind', 'on_track', 'too_advanced'].includes(active.paceStatus));
});

test('données insuffisantes — status insufficient_data sans crash', () => {
  const window = mockSwingWindow();
  const rows = makeTradingDays(new Date(Date.UTC(2025, 0, 2)), 30);
  const occ = computeOccurrence(window, rows, 2020, new Date(Date.UTC(2025, 1, 1)));

  assert.equal(occ.status, 'insufficient_data');
  assert.equal(occ.realizedReturn, null);

  const chart = buildSeasonalityChart3yFromRows(rows, {
    asOfDate: new Date(Date.UTC(2025, 1, 1)),
    symbol: 'TEST',
    annualDisplayWindows: {
      bullish: [window],
      bearishConfirmed: [],
      vigilance: [],
    },
    swingWindows: { bullish: [window], bearish: [] },
  });

  assert.ok(chart);
  assert.ok(chart.annualOverlays[0].occurrences.every(
    (o) => o.status === 'insufficient_data' || o.realizedReturn == null || typeof o.realizedReturn === 'number',
  ));
});

test('computePaceStatus — seuils behind / ahead / too_advanced', () => {
  assert.equal(computePaceStatus(0.5, 0.2), 'behind');
  assert.equal(computePaceStatus(0.5, 0.8), 'ahead');
  assert.equal(computePaceStatus(0.5, 0.45), 'on_track');
  assert.equal(computePaceStatus(0.5, 0.95), 'too_advanced');
});

test('findBarOnOrAfter / findBarOnOrBefore', () => {
  const rows = makeTradingDays(new Date(Date.UTC(2024, 0, 2)), 10);
  const firstIso = toIsoDate(rows[0].date);
  const barAfter = findBarOnOrAfter(rows, firstIso);
  const barBefore = findBarOnOrBefore(rows, toIsoDate(rows[rows.length - 1].date));
  assert.equal(barAfter.close, rows[0].close);
  assert.equal(barBefore.close, rows[rows.length - 1].close);
});

function _r4(n) {
  return Math.round(n * 10_000) / 10_000;
}
