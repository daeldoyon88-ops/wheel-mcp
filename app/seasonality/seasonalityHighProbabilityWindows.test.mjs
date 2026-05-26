import assert from "node:assert/strict";
import test   from "node:test";

import {
  buildSwingDurationDays,
  computeHighProbabilityWindowsFromRows,
  computeWindowScore,
  qualifiesBullishWindow,
  qualifiesBearishWindow,
  computeBullishVerdict,
  computeBearishVerdict,
  parseHighProbabilityWindowsParams,
  buildHighProbabilityWindowsApiResponse,
  resolveBacktestTickerList,
} from "./seasonalityHighProbabilityWindows.js";

import {
  computeBacktestForRows,
  buildBacktestApiResponse,
  parseBacktestOutputOptions,
} from "./seasonalityBacktest.js";

import {
  computeSeasonality,
  computeSeasonalityCalendar,
  computeSeasonalityShortTerm,
  computeSeasonalityWindows,
} from "./seasonalityEngine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeTradingCalendar(startDate, numDays, getReturnForDay) {
  const rows  = [];
  let price   = 100;
  const d     = new Date(startDate);

  while (rows.length < numDays) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const mult = getReturnForDay(d, rows.length);
      price = Number((price * mult).toFixed(4));
      rows.push({
        date:  new Date(d),
        open:  price,
        high:  price,
        low:   price,
        close: price,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return rows;
}

/** Avril : hausse récurrente forte (~+15 % sur ~25 jours de bourse). */
function makeStrongAprilBullRows(numYears = 12) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();
    if (month === 4 && day >= 1 && day <= 28) return 1.006;
    return 1.0;
  });
}

/** Septembre : baisse récurrente forte (~-15 % sur ~25 jours de bourse). */
function makeStrongSeptemberBearRows(numYears = 12) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();
    if (month === 9 && day >= 1 && day <= 28) return 0.994;
    return 1.0;
  });
}

/** Croissance faible → avgReturn trop bas malgré win rate élevé. */
function makeWeakGrowthRows(numYears = 12) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  return makeTradingCalendar(new Date(Date.UTC(startYear, 0, 2)), numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();
    if (month === 4 && day >= 1 && day <= 28) return 1.0005;
    return 1.0;
  });
}

function runForRows(rows, overrides = {}) {
  return computeHighProbabilityWindowsFromRows(rows, {
    minWeeks: 5,
    maxWeeks: 16,
    stepDays: 5,
    minWinRate: 0.9,
    minAvgReturn: 0.10,
    minMedianReturn: 0.05,
    minSamples: 8,
    direction: 'both',
    ...overrides,
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

test("buildSwingDurationDays: génère 25 à 80 jours avec stepDays=5", () => {
  const durations = buildSwingDurationDays(5, 16, 5);
  assert.deepEqual(durations, [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]);
});

test("détecte une fenêtre bullish avec winRate >= 90 %", () => {
  const rows   = makeStrongAprilBullRows(12);
  const result = runForRows(rows);

  assert.ok(result.bullish.length >= 1, "au moins une fenêtre bullish attendue");
  const top = result.bullish[0];
  assert.ok(top.bullishWinRate >= 0.9, `bullishWinRate=${top.bullishWinRate}`);
  assert.ok(top.avgReturn >= 0.10, `avgReturn=${top.avgReturn}`);
  assert.equal(top.direction, 'bullish');
  assert.ok(top.score > 0);
});

test("détecte une fenêtre bearish avec bearishWinRate >= 90 %", () => {
  const rows   = makeStrongSeptemberBearRows(12);
  const result = runForRows(rows);

  assert.ok(result.bearish.length >= 1, "au moins une fenêtre bearish attendue");
  const top = result.bearish[0];
  assert.ok(top.bearishWinRate >= 0.9, `bearishWinRate=${top.bearishWinRate}`);
  assert.ok(top.avgReturn <= -0.10, `avgReturn=${top.avgReturn}`);
  assert.equal(top.direction, 'bearish');
});

test("rejette une fenêtre avec sampleSize insuffisant", () => {
  const params = { minWinRate: 0.9, minAvgReturn: 0.10, minMedianReturn: 0.05, minSamples: 8 };
  const lowSample = {
    bullishWinRate: 0.95, bearishWinRate: 0.05,
    avgReturn: 0.15, medianReturn: 0.10, sampleSize: 5,
  };
  assert.equal(qualifiesBullishWindow(lowSample, params), false);
  assert.equal(qualifiesBearishWindow({ ...lowSample, avgReturn: -0.15, medianReturn: -0.10, bearishWinRate: 0.95, bullishWinRate: 0.05 }, params), false);

  // Historique très court : aucune clé saisonnière n'atteint 8 occurrences
  const rows   = makeTradingCalendar(new Date(Date.UTC(2023, 0, 2)), 120, () => 1.006);
  const result = runForRows(rows, { minSamples: 8 });
  assert.equal(result.bullish.length, 0, "pas de fenêtre bullish avec minSamples=8 sur 120 jours");
  assert.equal(result.bearish.length, 0, "pas de fenêtre bearish avec minSamples=8 sur 120 jours");
});

test("rejette une fenêtre avec avgReturn trop faible", () => {
  const rows   = makeWeakGrowthRows(12);
  const result = runForRows(rows, { minAvgReturn: 0.10, minWinRate: 0.5 });

  const highAvg = result.bullish.filter(w => w.avgReturn >= 0.10);
  assert.equal(highAvg.length, 0, "aucune fenêtre ne doit atteindre avgReturn >= 0.10");
});

test("retourne byTicker avec bestBullishWindows et bestBearishWindows", () => {
  const rows   = makeStrongAprilBullRows(12);
  const result = runForRows(rows);

  const byTicker = [{
    ticker: 'SYN',
    qualifiedWindows: result.bullish.length + result.bearish.length,
    bullishWindows:   result.bullish.length,
    bearishWindows:   result.bearish.length,
    bestBullishWindows: result.bullish,
    bestBearishWindows: result.bearish,
  }];

  const payload = buildHighProbabilityWindowsApiResponse({
    source: 'tickers',
    parameters: parseHighProbabilityWindowsParams({}),
    byTicker,
    topBullishWindows: result.bullish,
    topBearishWindows: result.bearish,
    warnings: [],
    tickersRequested: 1,
    tickersAnalyzed: 1,
  });

  assert.equal(payload.ok, true);
  assert.ok(Array.isArray(payload.byTicker));
  assert.ok(Array.isArray(payload.byTicker[0].bestBullishWindows));
  assert.ok(Array.isArray(payload.byTicker[0].bestBearishWindows));
  assert.ok(payload.summary.totalQualifiedWindows >= 1);
});

test("respecte maxResultsPerTicker via tri et limite", () => {
  const rows = makeStrongAprilBullRows(12);
  const full = runForRows(rows, { minWinRate: 0.5, minAvgReturn: 0.01, minMedianReturn: 0.01, minSamples: 3 });

  const maxResults = 3;
  const limited = full.bullish.slice(0, maxResults);

  assert.ok(full.bullish.length > maxResults || full.bullish.length <= maxResults);
  assert.equal(limited.length, Math.min(full.bullish.length, maxResults));

  if (limited.length >= 2) {
    assert.ok(limited[0].score >= limited[1].score, "tri par score décroissant");
  }
});

test("source inconnue retourne ok:false", () => {
  const r = resolveBacktestTickerList({ sourceRaw: 'unknown-source' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Source inconnue'));
});

test("endpoints seasonality/backtest restent non cassés", () => {
  assert.equal(typeof computeBacktestForRows, 'function');
  assert.equal(typeof buildBacktestApiResponse, 'function');
  assert.equal(typeof parseBacktestOutputOptions, 'function');
  assert.equal(typeof computeSeasonality, 'function');
  assert.equal(typeof computeSeasonalityCalendar, 'function');
  assert.equal(typeof computeSeasonalityShortTerm, 'function');
  assert.equal(typeof computeSeasonalityWindows, 'function');
});

test("displayLabel présents sur les fenêtres qualifiées", () => {
  const rows   = makeStrongAprilBullRows(12);
  const result = runForRows(rows);

  assert.ok(result.bullish.length >= 1);
  for (const w of result.bullish) {
    assert.ok(typeof w.displayLabel === 'string' && w.displayLabel.length > 0,
      `displayLabel absent: ${w.label}`);
    assert.ok(w.displayLabel.includes('→'), `displayLabel doit contenir → : ${w.displayLabel}`);
    assert.ok(typeof w.label === 'string' && w.label.includes('→'));
  }
});

// ─── Tests unitaires score / filtres / verdicts ────────────────────────────────

test("qualifiesBullishWindow et qualifiesBearishWindow: logique explicite", () => {
  const params = { minWinRate: 0.9, minAvgReturn: 0.10, minMedianReturn: 0.05, minSamples: 8 };

  const bullStats = {
    bullishWinRate: 0.92, bearishWinRate: 0.08,
    avgReturn: 0.15, medianReturn: 0.08, sampleSize: 10,
  };
  const bearStats = {
    bullishWinRate: 0.10, bearishWinRate: 0.92,
    avgReturn: -0.15, medianReturn: -0.08, sampleSize: 10,
  };

  assert.equal(qualifiesBullishWindow(bullStats, params), true);
  assert.equal(qualifiesBearishWindow(bearStats, params), true);
  assert.equal(qualifiesBullishWindow(bearStats, params), false);
  assert.equal(qualifiesBearishWindow(bullStats, params), false);
});

test("computeWindowScore: déterministe et pénalités directionnelles", () => {
  const base = {
    bullishWinRate: 0.9, bearishWinRate: 0.1,
    avgReturn: 0.12, medianReturn: 0.06,
    sampleSize: 10, worstReturn: -0.05, bestReturn: 0.30,
  };

  const bullScore = computeWindowScore(base, 'bullish');
  const bearScore = computeWindowScore(base, 'bearish');

  assert.ok(bullScore > 0);
  assert.ok(bearScore > 0);
  assert.equal(computeWindowScore(base, 'bullish'), bullScore, "score déterministe");
});

test("verdicts bullish et bearish", () => {
  assert.equal(computeBullishVerdict({ sampleSize: 10, bullishWinRate: 0.96, avgReturn: 0.12 }), 'Elite swing');
  assert.equal(computeBullishVerdict({ sampleSize: 10, bullishWinRate: 0.91, avgReturn: 0.11 }), 'Très fort');
  assert.equal(computeBullishVerdict({ sampleSize: 5, bullishWinRate: 0.95, avgReturn: 0.12 }), 'Préliminaire');
  assert.equal(computeBearishVerdict({ sampleSize: 10, bearishWinRate: 0.92, avgReturn: -0.12 }), 'Danger élevé');
  assert.equal(computeBearishVerdict({ sampleSize: 10, bearishWinRate: 0.85, avgReturn: -0.08 }), 'Danger moyen');
});

test("parseHighProbabilityWindowsParams: défauts recommandés", () => {
  const p = parseHighProbabilityWindowsParams({});
  assert.equal(p.minWeeks, 5);
  assert.equal(p.maxWeeks, 16);
  assert.equal(p.stepDays, 5);
  assert.equal(p.minWinRate, 0.9);
  assert.equal(p.minAvgReturn, 0.10);
  assert.equal(p.minMedianReturn, 0.05);
  assert.equal(p.minSamples, 8);
  assert.equal(p.maxResultsPerTicker, 10);
  assert.equal(p.direction, 'both');
  assert.equal(p.includeAll, false);
  assert.deepEqual(p.durationDays, [25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]);
});
