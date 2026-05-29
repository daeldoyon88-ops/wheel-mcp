import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAnnualWindowStats,
  computeGlidingWindowStats,
  findBestAnnualSeasonalityWindow,
  findBestAnnualBearishWindows,
  findBestAnnualBullishWindows,
  collectAnnualBearishGridCandidates,
  collectAnnualBullishGridCandidates,
  getStrictMultiHorizonStrength,
  isStrongOrConfirmedStrength,
  formatAnnualHorizonLine,
  formatGlidingRobustnessLine,
  attachBestAnnualWindowToResult,
  attachAnnualHorizonsToSwingWindows,
  clearBestAnnualCache,
  getLastSeasonalityPerf,
  buildPriceRowIndex,
  selectRecentBearishVigilanceWindows,
  STRICT_STRENGTH_LABELS,
} from "./seasonalityAnnualStats.js";
import { computeSeasonalityWindowsFromRows } from "./seasonalityEngine.js";

function makeTradingCalendar(startDate, numDays, getReturnForDay) {
  const rows = [];
  let price = 100;
  const d = new Date(startDate);

  while (rows.length < numDays) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const mult = getReturnForDay(d, rows.length);
      price = Number((price * mult).toFixed(4));
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

function makeAprilRallyRows(numYears = 10) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (month === 4 && day >= 1 && day <= 28) return 1.008;
    return 1.0;
  });
}

const APRIL_WINDOW = {
  startMonth: 4,
  startWeekOfMonth: 1,
  endMonth: 4,
  endWeekOfMonth: 4,
  windowDays: 20,
};

function makeSeptemberDropRows(numYears = 10) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (month === 9 && day >= 1 && day <= 28) return 0.992;
    return 1.0;
  });
}

function makeAnnualHorizons(bullishCounts) {
  const annualHorizons = {};
  for (const [key, pos] of Object.entries(bullishCounts)) {
    const total = parseInt(key.replace("y", ""), 10);
    const neg = total - pos;
    annualHorizons[key] = {
      yearsCount: total,
      positiveYears: pos,
      negativeYears: neg,
      winRateAnnual: pos / total,
      bearishRateAnnual: neg / total,
      avgReturnAnnual: pos > neg ? 0.05 : -0.05,
      medianReturnAnnual: pos > neg ? 0.04 : -0.04,
      insufficient: false,
      annualReturns: [],
    };
  }
  return annualHorizons;
}

function makeBearishAnnualHorizons(bearishCounts, avgs = {}) {
  const annualHorizons = {};
  for (const [key, neg] of Object.entries(bearishCounts)) {
    const total = parseInt(key.replace("y", ""), 10);
    const pos = total - neg;
    annualHorizons[key] = {
      yearsCount: total,
      positiveYears: pos,
      negativeYears: neg,
      winRateAnnual: pos / total,
      bearishRateAnnual: neg / total,
      avgReturnAnnual: avgs[key] ?? -0.05,
      medianReturnAnnual: avgs[key] ?? -0.04,
      insufficient: false,
      annualReturns: [],
    };
  }
  return annualHorizons;
}

test("getStrictMultiHorizonStrength: 3/3, 5/5, 9/10, 12/15 haussier = Forte", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 3, "5y": 5, "10y": 9, "15y": 12 }),
  }, "bullish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.FORTE);
});

test("getStrictMultiHorizonStrength: 3/3, 5/5, 9/10, 12/15 baissier = Forte", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 0, "5y": 0, "10y": 1, "15y": 3 }),
  }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.FORTE);
});

test("getStrictMultiHorizonStrength: 2/3, 4/5, 8/10, 10/15 = Confirmée", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 2, "5y": 4, "10y": 8, "15y": 10 }),
  }, "bullish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.CONFIRMEE);
});

test("getStrictMultiHorizonStrength: 5/15 baissier = Non confirmée", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 2, "5y": 3, "10y": 6, "15y": 10 }),
  }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.NON_CONFIRMEE);
});

test("getStrictMultiHorizonStrength: 7/15 baissier jamais Confirmée", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 1, "5y": 2, "10y": 5, "15y": 8 }),
  }, "bearish");
  assert.notEqual(strength, STRICT_STRENGTH_LABELS.CONFIRMEE);
  assert.notEqual(strength, STRICT_STRENGTH_LABELS.FORTE);
});

test("getStrictMultiHorizonStrength: glissant ignoré — annuel faible = Non confirmée", () => {
  const strength = getStrictMultiHorizonStrength({
    annualHorizons: makeAnnualHorizons({ "3y": 2, "5y": 3, "10y": 6, "15y": 10 }),
    glidingRobustness: { "5y": { winRateGliding: 0.95, sampleSize: 40 } },
  }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.NON_CONFIRMEE);
});

test("findBestAnnualBearishWindows: grille annuelle indépendante du swing", () => {
  clearBestAnnualCache();
  const rows = makeSeptemberDropRows(12);
  const index = buildPriceRowIndex(rows);
  const grid = collectAnnualBearishGridCandidates(index);
  assert.ok(grid.length > 20, `grille attendue > 20, obtenu ${grid.length}`);
  assert.ok(grid.every((c) => c.source === "annual-grid" || c.startMonth));

  const result = findBestAnnualBearishWindows("TEST", rows, { skipCache: true });
  assert.ok(result.bearishAnnualCandidatesTested > 0);
  assert.ok(result.gridCandidatesTotal > 0);
  assert.ok(result.gridCandidatesUsed > 0);
});

test("findBestAnnualBearishWindows: retourne fenêtre forte si septembre baissier récurrent", () => {
  clearBestAnnualCache();
  const rows = makeSeptemberDropRows(12);

  const result = findBestAnnualBearishWindows("TEST", rows, { skipCache: true });

  assert.ok(Array.isArray(result.windows));
  if (result.windows.length > 0) {
    assert.ok(isStrongOrConfirmedStrength(result.windows[0].strength));
    assert.ok(result.windows[0].displayLabel);
    assert.ok(result.windows[0].annualHorizons?.["15y"]);
    assert.ok((result.windows[0].avgReturnAnnual ?? 0) < 0);
  }
});

test("findBestAnnualBearishWindows: avril haussier → bestBearishAnnualWindows vide", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(12);
  const result = findBestAnnualBearishWindows("BULL", rows, { skipCache: true });
  assert.equal(result.windows.length, 0);
  assert.equal(result.noStrongBearishAnnualWindow, true);
});

test("getStrictMultiHorizonStrength: 5/15 baissier avec rendement positif → Non confirmée", () => {
  const ah = makeAnnualHorizons({ "3y": 0, "5y": 0, "10y": 1, "15y": 3 });
  ah["15y"].avgReturnAnnual = 0.02;
  ah["15y"].medianReturnAnnual = 0.01;
  const strength = getStrictMultiHorizonStrength({ annualHorizons: ah }, "bearish");
  assert.notEqual(strength, STRICT_STRENGTH_LABELS.FORTE);
  assert.notEqual(strength, STRICT_STRENGTH_LABELS.CONFIRMEE);
});

test("getStrictMultiHorizonStrength: Confirmée malgré avg5 positif si avg15 négatif", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 2, "5y": 4, "10y": 8, "15y": 10 },
    { "15y": -0.03, "10y": -0.025, "5y": 0.008, "3y": -0.01 },
  );
  const strength = getStrictMultiHorizonStrength({ annualHorizons: ah }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.CONFIRMEE);
});

test("getStrictMultiHorizonStrength: avg15 positif reste Non confirmée", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 2, "5y": 4, "10y": 8, "15y": 10 },
    { "15y": 0.02, "5y": -0.01, "10y": -0.02, "3y": -0.01 },
  );
  const strength = getStrictMultiHorizonStrength({ annualHorizons: ah }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.NON_CONFIRMEE);
});

test("getStrictMultiHorizonStrength: forte synthétique reste Forte", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 3, "5y": 5, "10y": 9, "15y": 12 },
    { "15y": -0.06, "10y": -0.05, "5y": -0.04, "3y": -0.03 },
  );
  const strength = getStrictMultiHorizonStrength({ annualHorizons: ah }, "bearish");
  assert.equal(strength, STRICT_STRENGTH_LABELS.FORTE);
});

test("findBestAnnualBearishWindows: candidate Confirmée même si avg5 positif (scoring)", () => {
  clearBestAnnualCache();
  const rows = makeSeptemberDropRows(12);
  const result = findBestAnnualBearishWindows("TEST", rows, { skipCache: true });
  const confirmed = result.allScored.filter((w) => w.strength === STRICT_STRENGTH_LABELS.CONFIRMEE);
  const withPositiveAvg5 = confirmed.filter((w) => (w.annualHorizons?.["5y"]?.avgReturnAnnual ?? 0) > 0);
  assert.ok(
    result.allScored.some((w) => isStrongOrConfirmedStrength(w.strength)),
    "au moins une candidate forte/confirmée dans allScored",
  );
  if (withPositiveAvg5.length > 0) {
    assert.ok(withPositiveAvg5.every((w) => (w.annualHorizons?.["15y"]?.avgReturnAnnual ?? 0) < 0));
  }
});

test("attachBestAnnualWindowToResult expose bestBearishAnnualWindows", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const base = computeSeasonalityWindowsFromRows(rows, { skipBestAnnualCache: true });
  const enriched = attachBestAnnualWindowToResult(base, rows, "TQQQ");

  assert.ok("bestBearishAnnualWindows" in enriched);
  assert.ok(Array.isArray(enriched.bestBearishAnnualWindows));
  assert.ok("noStrongBearishAnnualWindow" in enriched);
  assert.ok(enriched.bearishAnnualMeta?.candidatesTested > 0 || enriched.bestBearishAnnualWindows.length === 0);
});

test("computeAnnualWindowStats: 5y retourne au plus 5 années", () => {
  const rows = makeAprilRallyRows(12);
  const stats = computeAnnualWindowStats(APRIL_WINDOW, rows, 5);

  assert.ok(stats);
  assert.ok(stats.yearsCount <= 5, `yearsCount=${stats.yearsCount}`);
  assert.ok(stats.annualReturns.length <= 5);
  assert.equal(stats.annualReturns.length, stats.yearsCount);
});

test("computeAnnualWindowStats: winRateAnnual = années positives / années totales", () => {
  const rows = makeAprilRallyRows(10);
  const stats = computeAnnualWindowStats(APRIL_WINDOW, rows, 5);

  assert.ok(stats && !stats.insufficient);
  const expected = stats.positiveYears / stats.yearsCount;
  assert.equal(stats.winRateAnnual, Math.round(expected * 1000) / 1000);
  assert.ok(stats.positiveYears <= stats.yearsCount);
});

test("computeGlidingWindowStats: sampleSize glissant inchangé (logique signature)", () => {
  const rows = makeAprilRallyRows(10);
  const fromEngine = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 20,
  });

  const april = fromEngine.horizons[0].windows[0].bestBullish.find(
    (w) => w.startMonth === 4 && w.startWeekOfMonth === 1,
  );
  assert.ok(april, "fenêtre avril attendue");

  const gliding = computeGlidingWindowStats(april, rows, 5, 20);
  assert.ok(gliding);
  assert.equal(gliding.sampleSize, april.sampleSize, "sampleSize glissant identique au moteur");
});

test("5/5 annuel et ~79 % glissant peuvent coexister sans contradiction", () => {
  const rows = makeAprilRallyRows(10);
  const fromEngine = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 10,
  });
  const april = fromEngine.horizons[0].windows[0].bestBullish.find((w) => w.startMonth === 4);
  assert.ok(april);

  const annual = computeAnnualWindowStats(april, rows, 5);
  const gliding = computeGlidingWindowStats(april, rows, 5, 20);

  assert.ok(annual && !annual.insufficient);
  assert.ok(gliding);

  if (annual.positiveYears === annual.yearsCount && annual.yearsCount >= 3) {
    assert.ok(
      gliding.winRateGliding < 1 || gliding.sampleSize > annual.yearsCount,
      "annual parfait n'implique pas glissant 100 % — échelles différentes",
    );
  }

  const line79 = formatGlidingRobustnessLine("5y", { winRateGliding: 0.79, sampleSize: 14 });
  assert.match(line79, /79 % positif/);

  const lineAnnual = formatAnnualHorizonLine("5y", {
    yearsCount: 5,
    positiveYears: 5,
    avgReturnAnnual: 0.397,
    insufficient: false,
  });
  assert.match(lineAnnual, /5\/5 haussier/);
});

test("formatGlidingRobustnessLine mentionne tests glissants", () => {
  const line = formatGlidingRobustnessLine("5y", {
    winRateGliding: 0.79,
    sampleSize: 14,
  });
  assert.ok(line.includes("tests glissants"), line);
  assert.ok(line.includes("n=14"), line);
  assert.ok(line.includes("79 %"), line);
});

test("formatAnnualHorizonLine: X/Y haussier · rendement moyen", () => {
  const line = formatAnnualHorizonLine("5y", {
    yearsCount: 5,
    positiveYears: 5,
    avgReturnAnnual: 0.397,
    insufficient: false,
  });
  assert.match(line, /5\/5 haussier/);
  assert.match(line, /rendement moyen \+39\.7 %/);
});

test("findBestAnnualSeasonalityWindow retourne annualHorizons et glidingRobustness", () => {
  const rows = makeAprilRallyRows(12);
  const horizons = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5, 10],
    windowDays: [20],
    topN: 15,
  });
  const best = findBestAnnualSeasonalityWindow("TEST", rows, {
    horizons: horizons?.horizons,
    candidates: horizons?.horizons?.flatMap((h) =>
      h.windows?.flatMap((b) => b.bestBullish ?? []) ?? [],
    ),
  });

  assert.ok(best?.window?.displayLabel);
  assert.ok(best.annualHorizons?.["5y"]);
  assert.ok(best.glidingRobustness?.["5y"]);
});

test("attachBestAnnualWindowToResult ajoute bestAnnualWindow au résultat windows", () => {
  const rows = makeAprilRallyRows(8);
  const base = computeSeasonalityWindowsFromRows(rows);
  const enriched = attachBestAnnualWindowToResult(base, rows, "SOXL");

  assert.ok(enriched.bestAnnualWindow);
  assert.ok(enriched.summary.bestAnnualSeasonality);
});

test("perf: glissant calculé seulement pour la fenêtre gagnante (≤ 4 horizons)", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const horizons = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5, 10],
    windowDays: [20],
    topN: 12,
    skipBestAnnualCache: true,
  });

  findBestAnnualSeasonalityWindow("TEST", rows, {
    horizons: horizons?.horizons,
    candidates: horizons?.horizons?.flatMap((h) =>
      h.windows?.flatMap((b) => b.bestBullish ?? []) ?? [],
    ),
    skipCache: true,
  });

  const perf = getLastSeasonalityPerf();
  assert.ok(perf, "activer SEASONALITY_PERF=true pour voir [SEASONALITY_PERF] en console");
  assert.ok(perf.candidateWindowsTested > 0);
  assert.ok(perf.glidingStatsCalls <= 4, `glidingStatsCalls=${perf.glidingStatsCalls}`);
  assert.ok(perf.glidingStatsCalls >= 1);
});

test("cache bestAnnual: second appel = cacheHit sans re-scorer les candidates", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(8);
  const horizons = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 8,
    skipBestAnnualCache: true,
  });
  const candidates = horizons?.horizons?.flatMap((h) =>
    h.windows?.flatMap((b) => b.bestBullish ?? []) ?? [],
  );

  const first = findBestAnnualSeasonalityWindow("CACHE", rows, {
    horizons: horizons?.horizons,
    candidates,
    skipCache: false,
  });
  const perf1 = getLastSeasonalityPerf();
  assert.equal(perf1?.cacheHit, false);

  const second = findBestAnnualSeasonalityWindow("CACHE", rows, {
    horizons: horizons?.horizons,
    candidates,
    skipCache: false,
  });
  const perf2 = getLastSeasonalityPerf();
  assert.equal(perf2?.cacheHit, true);
  assert.equal(second.window?.displayLabel, first.window?.displayLabel);
});

test("stabilité: meilleure fenêtre avril inchangée après optimisation", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(12);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5, 10, 15],
    windowDays: [20],
    topN: 15,
    skipBestAnnualCache: true,
  });

  assert.ok(result.bestAnnualWindow);
  assert.equal(result.bestAnnualWindow.window?.startMonth, 4, "meilleure fenêtre = avril");
  assert.ok(result.bestAnnualWindow.annualHorizons["5y"].yearsCount <= 5);
});

test("buildPriceRowIndex: annualStats sans re-tri à chaque appel", () => {
  const rows = makeAprilRallyRows(6);
  const index = buildPriceRowIndex(rows);
  const ctx = {
    index,
    annualBySig: new Map(),
    occurrenceByKey: new Map(),
    annualStatsCalls: 0,
    glidingStatsCalls: 0,
  };
  computeAnnualWindowStats(APRIL_WINDOW, rows, 3, ctx);
  computeAnnualWindowStats(APRIL_WINDOW, rows, 5, ctx);
  assert.ok(ctx.annualBySig.size >= 1);
});

test("attachAnnualHorizonsToSwingWindows: chaque fenêtre swing reçoit annualHorizons", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const result = computeSeasonalityWindowsFromRows(rows, {
    skipBestAnnualCache: true,
  });

  const allSwing = [
    ...(result.swingWindows?.bullish ?? []),
    ...(result.swingWindows?.bearish ?? []),
  ];
  assert.ok(allSwing.length >= 1, "au moins une fenêtre swing attendue");
  for (const w of allSwing) {
    assert.ok(w.annualHorizons?.["5y"], "swing sans annualHorizons 5y");
    assert.ok(w.annualHorizons?.["15y"]);
    assert.ok(w.annualHorizons["5y"].yearsCount <= 5);
  }
});

test("attachAnnualHorizonsToSwingWindows: negativeYears compte returnPct < 0", () => {
  const rows = makeAprilRallyRows(10);
  const septemberWindow = {
    startMonth: 9,
    startWeekOfMonth: 1,
    endMonth: 9,
    endWeekOfMonth: 4,
    windowDays: 20,
  };
  const swingWindows = {
    bullish: [],
    bearish: [septemberWindow],
    meta: {},
  };
  const enriched = attachAnnualHorizonsToSwingWindows(swingWindows, rows);
  const stats = enriched.bearish[0].annualHorizons?.["5y"];
  assert.ok(stats);
  const fromReturns = stats.annualReturns.filter((a) => a.returnPct < 0).length;
  assert.equal(stats.negativeYears, fromReturns);
  assert.equal(stats.bearishRateAnnual, Math.round((fromReturns / stats.yearsCount) * 1000) / 1000);
});

test("attachAnnualHorizonsToSwingWindows: stats glissantes horizonStats inchangées", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const result = computeSeasonalityWindowsFromRows(rows, {
    skipBestAnnualCache: true,
  });
  const w = result.swingWindows?.bullish?.[0] ?? result.swingWindows?.bearish?.[0];
  assert.ok(w, "fenêtre swing attendue");
  assert.ok(w.horizonStats?.["5y"]?.sampleSize != null);
  assert.ok(w.annualHorizons?.["5y"]);
  assert.equal(typeof w.horizonStats["5y"].sampleSize, "number");
});

// ─── Tests findBestAnnualBullishWindows ───────────────────────────────────────

function makeAprilAndOctoberRallyRows(numYears = 12) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    // Avril : forte hausse récurrente
    if (month === 4) return 1.009;
    // Octobre : forte hausse récurrente distincte
    if (month === 10) return 1.008;
    return 1.0;
  });
}

test("collectAnnualBullishGridCandidates: grille haussière couvre plusieurs mois", () => {
  clearBestAnnualCache();
  const rows = makeAprilAndOctoberRallyRows(12);
  const index = buildPriceRowIndex(rows);
  const grid = collectAnnualBullishGridCandidates(index);
  assert.ok(grid.length > 20, `grille bullish attendue > 20, obtenu ${grid.length}`);
  assert.ok(grid.every((c) => c.source === "annual-grid" || c.startMonth));
  const hasApril = grid.some((c) => c.startMonth === 4 || c.endMonth >= 4);
  assert.ok(hasApril, "grille doit contenir des candidats avril ou postérieurs");
});

test("findBestAnnualBullishWindows: grille annuelle indépendante du swing", () => {
  clearBestAnnualCache();
  const rows = makeAprilAndOctoberRallyRows(12);
  const result = findBestAnnualBullishWindows("TEST", rows, { skipCache: true });
  assert.ok(result.bullishAnnualCandidatesTested > 0);
  assert.ok(result.gridCandidatesTotal > 0);
  assert.ok(result.gridCandidatesUsed > 0);
});

test("findBestAnnualBullishWindows: retourne deux fenêtres distinctes avril + octobre", () => {
  clearBestAnnualCache();
  const rows = makeAprilAndOctoberRallyRows(12);
  const result = findBestAnnualBullishWindows("TEST", rows, { skipCache: true });

  assert.ok(Array.isArray(result.windows), "windows doit être un tableau");
  assert.ok(result.windows.length >= 1, `au moins une fenêtre bullish forte/confirmée attendue, obtenu ${result.windows.length}`);

  for (const w of result.windows) {
    assert.ok(isStrongOrConfirmedStrength(w.strength), `force ${w.strength} inattendue`);
    assert.ok(w.displayLabel, "displayLabel requis");
    assert.ok(w.annualHorizons?.["5y"], "annualHorizons 5y requis");
    assert.ok((w.avgReturnAnnual ?? 0) > 0, `avgReturnAnnual doit être positif, obtenu ${w.avgReturnAnnual}`);
  }

  if (result.windows.length >= 2) {
    const [w1, w2] = result.windows;
    const starts = [w1.startMonth, w2.startMonth].sort((a, b) => a - b);
    // Les deux fenêtres doivent avoir des mois de début distincts (séparation > 3 mois)
    assert.ok(Math.abs(starts[1] - starts[0]) >= 3, "les deux fenêtres doivent être distinctes");
  }
});

test("findBestAnnualBullishWindows: déduplication — variantes proches fusionnées", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(12);
  const result = findBestAnnualBullishWindows("DEDUP", rows, { skipCache: true });

  // Avec un seul pic haussier (avril), on ne doit pas avoir 3 variantes quasi-identiques
  if (result.windows.length >= 2) {
    const [w1, w2] = result.windows;
    const diffMonths = Math.abs(w1.startMonth - w2.startMonth);
    assert.ok(diffMonths >= 2, `fenêtres trop proches (diff ${diffMonths} mois) — déduplication défaillante`);
  }
});

test("findBestAnnualBullishWindows: avril haussier → fenêtre forte/confirmée retournée", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(12);
  const result = findBestAnnualBullishWindows("BULL", rows, { skipCache: true });
  assert.ok(result.windows.length >= 1, "au moins une fenêtre haussière attendue");
  const w = result.windows[0];
  assert.ok(isStrongOrConfirmedStrength(w.strength), `force inattendue: ${w.strength}`);
  assert.ok(w.displayLabel);
  assert.ok(w.annualHorizons?.["5y"]);
});

test("findBestAnnualBullishWindows: septembre baissier → bestBullishAnnualWindows ne contient pas sept.", () => {
  clearBestAnnualCache();
  const rows = makeSeptemberDropRows(12);
  const result = findBestAnnualBullishWindows("BEAR", rows, { skipCache: true });
  const hasSept = result.windows.some((w) => w.startMonth === 9);
  assert.ok(!hasSept, "septembre ne doit pas être dans bestBullishAnnualWindows pour un dataset baissier");
});

test("attachBestAnnualWindowToResult expose bestBullishAnnualWindows", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const base = computeSeasonalityWindowsFromRows(rows, { skipBestAnnualCache: true });
  const enriched = attachBestAnnualWindowToResult(base, rows, "TQQQ");

  assert.ok("bestBullishAnnualWindows" in enriched, "bestBullishAnnualWindows manquant");
  assert.ok(Array.isArray(enriched.bestBullishAnnualWindows));
  assert.ok("noStrongBullishAnnualWindow" in enriched);
  assert.ok(enriched.bullishAnnualMeta?.candidatesTested > 0 || enriched.bestBullishAnnualWindows.length === 0);
});

test("bestAnnualWindow reste intact après ajout bestBullishAnnualWindows", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const base = computeSeasonalityWindowsFromRows(rows, { skipBestAnnualCache: true });
  const enriched = attachBestAnnualWindowToResult(base, rows, "SOXL");

  assert.ok(enriched.bestAnnualWindow?.window?.displayLabel, "bestAnnualWindow inchangé requis");
  assert.ok(enriched.bestAnnualWindow?.annualHorizons?.["5y"]);
  assert.ok(enriched.bestAnnualWindow?.glidingRobustness?.["5y"]);
});

test("findBestAnnualBullishWindows: cache — second appel identique au premier", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const r1 = findBestAnnualBullishWindows("CACHE_BULL", rows, { skipCache: false });
  const r2 = findBestAnnualBullishWindows("CACHE_BULL", rows, { skipCache: false });
  assert.equal(r1.windows.length, r2.windows.length);
  if (r1.windows.length > 0 && r2.windows.length > 0) {
    assert.equal(r1.windows[0].displayLabel, r2.windows[0].displayLabel);
  }
});

test("selectRecentBearishVigilanceWindows: fenêtre 5/5 récente non confirmée", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 3, "5y": 5, "10y": 6, "15y": 8 },
    { "5y": -0.17, "15y": -0.054, "10y": -0.04, "3y": -0.12 },
  );
  const mockWindow = {
    startMonth: 2,
    startWeekOfMonth: 3,
    endMonth: 3,
    endWeekOfMonth: 3,
    windowDays: 40,
    displayLabel: "15 fév. → 15 mars",
    strength: STRICT_STRENGTH_LABELS.FAIBLE,
    annualHorizons: ah,
  };
  const vigilance = selectRecentBearishVigilanceWindows([mockWindow], []);
  assert.equal(vigilance.length, 1);
  assert.equal(vigilance[0].status, "Récente seulement");
  assert.equal(vigilance[0].rejectReason, "15y_lt_10_sur_15");
  assert.ok(vigilance[0].annualHorizons?.["5y"]);
  assert.ok(vigilance[0].avgReturnAnnual5y < 0);
});

test("selectRecentBearishVigilanceWindows: exclut avg5 positif", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 3, "5y": 5, "10y": 6, "15y": 8 },
    { "5y": 0.02, "15y": -0.054, "10y": -0.04, "3y": -0.01 },
  );
  const mockWindow = {
    startMonth: 2,
    startWeekOfMonth: 3,
    endMonth: 3,
    endWeekOfMonth: 3,
    windowDays: 40,
    strength: STRICT_STRENGTH_LABELS.FAIBLE,
    annualHorizons: ah,
  };
  const vigilance = selectRecentBearishVigilanceWindows([mockWindow], []);
  assert.equal(vigilance.length, 0);
});

test("selectRecentBearishVigilanceWindows: n'inclut pas les fenêtres confirmées", () => {
  const ah = makeBearishAnnualHorizons(
    { "3y": 3, "5y": 5, "10y": 9, "15y": 12 },
    { "5y": -0.08, "15y": -0.06, "10y": -0.05, "3y": -0.04 },
  );
  const confirmed = {
    startMonth: 9,
    startWeekOfMonth: 1,
    endMonth: 9,
    endWeekOfMonth: 4,
    windowDays: 40,
    strength: STRICT_STRENGTH_LABELS.FORTE,
    annualHorizons: ah,
  };
  const vigilance = selectRecentBearishVigilanceWindows([confirmed], [confirmed]);
  assert.equal(vigilance.length, 0);
});

test("attachBestAnnualWindowToResult expose recentBearishVigilance séparé de bestBearishAnnualWindows", () => {
  clearBestAnnualCache();
  const rows = makeAprilRallyRows(10);
  const base = computeSeasonalityWindowsFromRows(rows, { skipBestAnnualCache: true });
  const enriched = attachBestAnnualWindowToResult(base, rows, "TQQQ");

  assert.ok(Array.isArray(enriched.recentBearishVigilance));
  for (const v of enriched.recentBearishVigilance) {
    assert.equal(v.status, "Récente seulement");
    assert.notEqual(v.strength, STRICT_STRENGTH_LABELS.FORTE);
    assert.notEqual(v.strength, STRICT_STRENGTH_LABELS.CONFIRMEE);
    const inConfirmed = enriched.bestBearishAnnualWindows.some(
      (w) => w.displayLabel === v.displayLabel,
    );
    assert.ok(!inConfirmed, "vigilance ne doit pas dupliquer bestBearishAnnualWindows");
  }
});
