import assert from "node:assert/strict";
import test   from "node:test";

import {
  flattenSwingCandidates,
  consolidateSwingFamilies,
  buildSwingHorizonFamilies,
  buildHorizonStatsForMembers,
  scoreMultiHorizonSwingFamily,
  multiHorizonConfidenceFromFamily,
  selectAdaptiveSwingSeasonalityWindows,
  attachSwingSeasonalityWindows,
  swingConfidenceFromHorizons,
} from "./seasonalitySwingWindows.js";
import { computeSeasonalityWindowsFromRows } from "./seasonalityEngine.js";
import { buildCalendarCoverageMask } from "./seasonalityWindowDistinct.js";

function win(overrides) {
  return {
    startMonth: 4,
    startDay: 15,
    endMonth: 7,
    endDay: 15,
    startWeekOfMonth: 2,
    endWeekOfMonth: 3,
    windowDays: 60,
    score: 10,
    avgReturn: 0.12,
    winRate: 0.85,
    sampleSize: 10,
    status: "robuste",
    displayLabel: "15 avr. → 15 juil.",
    label: "Avr W2 → Juil W3",
    ...overrides,
  };
}

function mockWindowsData(bullish = [], bearish = []) {
  const byHorizon = new Map();
  for (const w of bullish) {
    const hy = w.horizonYears ?? 5;
    if (!byHorizon.has(hy)) byHorizon.set(hy, []);
    byHorizon.get(hy).push(w);
  }
  for (const w of bearish) {
    const hy = w.horizonYears ?? 5;
    if (!byHorizon.has(hy)) byHorizon.set(hy, []);
    byHorizon.get(hy).push({ ...w, _bear: true });
  }

  const horizons = [];
  for (const [horizonYears, items] of byHorizon) {
    const bestBullish = items.filter((x) => !x._bear);
    const worstBearish = items.filter((x) => x._bear).map(({ _bear, ...rest }) => rest);
    horizons.push({
      horizonYears,
      windows: [{
        windowDays: items[0]?.windowDays ?? 60,
        bestBullish,
        worstBearish,
      }],
    });
  }

  return { horizons, summary: {} };
}

test("exclut fenêtre < 35 jours trading", () => {
  const data = mockWindowsData([win({ windowDays: 20, horizonYears: 5 })]);
  const flat = flattenSwingCandidates(data, "bullish");
  assert.equal(flat.length, 0);
});

test("exclut fenêtre > 119 jours trading ou calendrier trop long", () => {
  const longCal = win({
    startMonth: 3,
    startDay: 1,
    endMonth: 8,
    endDay: 22,
    windowDays: 90,
    displayLabel: "1 mars → 22 août",
    horizonYears: 5,
  });
  const data = mockWindowsData([longCal]);
  const flat = flattenSwingCandidates(data, "bullish");
  assert.equal(flat.length, 0, "mars→août calendrier ~175j doit être exclu");
});

test("inclut fenêtre 6 à 17 semaines (ex. avril → juillet)", () => {
  const data = mockWindowsData([win({ windowDays: 60, horizonYears: 5 })]);
  const flat = flattenSwingCandidates(data, "bullish");
  assert.equal(flat.length, 1);
  assert.ok(flat[0].durationWeeks == null || flat[0].windowDays === 60);
});

test("sélectionne plusieurs fenêtres haussières non chevauchées", () => {
  const spring = win({
    startMonth: 4, endMonth: 7, windowDays: 60, score: 12, horizonYears: 5,
    displayLabel: "15 avr. → 15 juil.",
  });
  const autumn = win({
    startMonth: 9, endMonth: 12, windowDays: 60, score: 11, horizonYears: 5,
    displayLabel: "1 sep. → 15 déc.",
  });
  const result = selectAdaptiveSwingSeasonalityWindows(
    mockWindowsData([spring, autumn]),
    { maxBullish: 3 },
  );
  assert.equal(result.bullish.length, 2);
});

test("ne fusionne pas mars→août swing avec oct→jan dans la sélection finale", () => {
  const spring = win({
    startMonth: 4, endMonth: 7, windowDays: 60, score: 12, horizonYears: 5,
  });
  const fall = win({
    startMonth: 10, endMonth: 1, endDay: 29, windowDays: 60, score: 11, horizonYears: 5,
    displayLabel: "29 oct. → 29 jan.",
  });
  const result = selectAdaptiveSwingSeasonalityWindows(
    mockWindowsData([spring, fall]),
    { maxBullish: 3, maxOverlapRatio: 0.5 },
  );
  assert.equal(result.bullish.length, 2);
});

test("consolide fenêtres proches multi-horizons", () => {
  const variants = [
    win({ horizonYears: 3, startWeekOfMonth: 1, endWeekOfMonth: 1, score: 9 }),
    win({ horizonYears: 5, startWeekOfMonth: 4, endWeekOfMonth: 1, score: 11 }),
    win({ horizonYears: 10, startWeekOfMonth: 3, endWeekOfMonth: 2, score: 10 }),
  ];
  const data = mockWindowsData(variants);
  const flat = flattenSwingCandidates(data, "bullish");
  const consolidated = consolidateSwingFamilies(flat);
  assert.ok(consolidated.length <= flat.length);
  const top = consolidated.find((c) => c.horizonsFound?.length >= 2);
  assert.ok(top, "au moins une fenêtre consolidée multi-horizons");
});

test("ne retourne pas deux fenêtres presque identiques", () => {
  const a = win({ score: 12, horizonYears: 5 });
  const b = win({ score: 11, startWeekOfMonth: 3, horizonYears: 5 });
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData([a, b]));
  assert.equal(result.bullish.length, 1);
});

test("swingWindows coexiste avec clusters et distinct", () => {
  const data = {
    horizons: [{
      horizonYears: 5,
      windows: [{ windowDays: 60, bestBullish: [win()], worstBearish: [] }],
    }],
    summary: {},
    distinct: { bullish: [win()], bearish: [], meta: {} },
    clusters: { bullish: [], bearish: [], meta: {} },
  };
  const out = attachSwingSeasonalityWindows(data);
  assert.ok(out.swingWindows);
  assert.ok(out.distinct);
  assert.ok(out.clusters);
});

test("TQQQ-like : pas de swing 1 mars → 22 août si trop long", () => {
  const mega = win({
    startMonth: 3,
    startDay: 1,
    endMonth: 8,
    endDay: 22,
    windowDays: 90,
    displayLabel: "1 mars → 22 août",
    horizonYears: 5,
    score: 20,
  });
  const okWin = win({
    startMonth: 4,
    endMonth: 7,
    windowDays: 60,
    score: 15,
    horizonYears: 5,
  });
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData([mega, okWin]));
  assert.ok(!result.bullish.some((w) =>
    String(w.displayLabel).includes("mars") && String(w.displayLabel).includes("août"),
  ));
  assert.ok(result.bullish.length >= 1);
});

test("confiance swing basée sur horizons confirmés, pas sampleSize seul", () => {
  assert.equal(swingConfidenceFromHorizons([3, 5, 10, 15], 10).confidence, "robuste");
  assert.equal(swingConfidenceFromHorizons([5], 10).confidence, "préliminaire");
  assert.equal(swingConfidenceFromHorizons([5, 15], 8).confidence, "mesurable");
  assert.equal(swingConfidenceFromHorizons([3, 5, 10], 2).confidence, "mesurable");
  assert.ok(swingConfidenceFromHorizons([3, 5, 10], 2).confidenceReason);
});

test("swing format inclut startDayOfYear/endDayOfYear pour fenêtre cross-year", () => {
  const fall = win({
    startMonth: 10,
    startDay: 29,
    endMonth: 1,
    endDay: 29,
    windowDays: 60,
    score: 11,
    horizonYears: 5,
    displayLabel: "29 oct. → 29 jan.",
  });
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData([fall]));
  assert.equal(result.bullish.length, 1);
  const w = result.bullish[0];
  assert.ok(w.startDayOfYear > w.endDayOfYear, "oct→jan traverse l'année");
  assert.equal(w.startDayOfYear, 302);
  assert.equal(w.endDayOfYear, 29);
});

test("fenêtre multi-horizons (3y/5y/10y/15y) affiche confiance robuste", () => {
  const variants = [
    win({ horizonYears: 3, score: 9, sampleSize: 3, winRate: 1.0, avgReturn: 0.537 }),
    win({ horizonYears: 5, score: 11, sampleSize: 5, winRate: 1.0, avgReturn: 0.283 }),
    win({ horizonYears: 10, score: 10, sampleSize: 10, winRate: 1.0, avgReturn: 0.19 }),
    win({ horizonYears: 15, score: 10, sampleSize: 16, winRate: 0.875, avgReturn: 0.166 }),
  ];
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants));
  assert.equal(result.bullish.length, 1);
  const w = result.bullish[0];
  assert.ok(w.horizonStats);
  assert.equal(w.horizonStats["3y"].sampleSize, 3);
  assert.equal(w.horizonStats["15y"].sampleSize, 16);
  assert.equal(w.multiHorizonConfidence, "robuste multi-horizons");
  assert.deepEqual(w.confirmedHorizons, ["3y", "5y", "10y", "15y"]);
  assert.equal(w.avgReturn, 0.166, "expectedReturn = horizon 15y confirmé");
  assert.equal(w.shortTermReturn, 0.537);
  assert.ok(w.selectionReason);
  assert.ok(!String(w.selectionReason).includes("undefined"));
  assert.equal(w.primaryHorizon, "15y");
  assert.equal(w.displaySampleSize, 16);
  assert.notEqual(w.displaySampleSize, w.totalOccurrences);
  assert.equal(w.displayAvgReturn, 0.166);
  assert.equal(w.expectedReturn, 0.166);
  assert.equal(w.displayWinRate, 0.875);
  assert.equal(w.occurrences, 16);
  assert.equal(w.sampleSize, 16);
});

test("displaySampleSize utilise primaryHorizon, pas la somme totalOccurrences", () => {
  const variants = [
    win({ horizonYears: 3, sampleSize: 3, winRate: 1.0, avgReturn: 0.537 }),
    win({ horizonYears: 5, sampleSize: 5, winRate: 1.0, avgReturn: 0.283 }),
    win({ horizonYears: 10, sampleSize: 10, winRate: 1.0, avgReturn: 0.19 }),
    win({ horizonYears: 15, sampleSize: 16, winRate: 0.875, avgReturn: 0.166 }),
  ];
  const w = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants)).bullish[0];
  assert.equal(w.totalOccurrences, 34);
  assert.equal(w.displaySampleSize, 16);
  assert.notEqual(w.displaySampleSize, 34);
});

test("15y confirmé → primaryHorizon 15y", () => {
  const variants = [
    win({ horizonYears: 15, sampleSize: 16, winRate: 0.875, avgReturn: 0.166 }),
  ];
  const w = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants)).bullish[0];
  assert.equal(w.primaryHorizon, "15y");
  assert.equal(w.primaryHorizonSampleSize, 16);
});

test("15y absent mais 10y confirmé → primaryHorizon 10y", () => {
  const variants = [
    win({ horizonYears: 10, sampleSize: 10, winRate: 0.8, avgReturn: 0.19 }),
    win({ horizonYears: 5, sampleSize: 5, winRate: 1.0, avgReturn: 0.283 }),
  ];
  const w = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants)).bullish[0];
  assert.equal(w.primaryHorizon, "10y");
  assert.equal(w.displaySampleSize, 10);
  assert.equal(w.displayAvgReturn, 0.19);
  assert.equal(w.displayWinRate, 0.8);
});

test("rendement affiché aligné sur primaryHorizon (pas winRate agrégé)", () => {
  const variants = [
    win({ horizonYears: 3, sampleSize: 3, winRate: 1.0, avgReturn: 0.80 }),
    win({ horizonYears: 15, sampleSize: 16, winRate: 0.875, avgReturn: 0.166 }),
  ];
  const w = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants)).bullish[0];
  assert.equal(w.primaryHorizon, "15y");
  assert.equal(w.displayAvgReturn, 0.166);
  assert.equal(w.displayWinRate, 0.875);
  assert.notEqual(w.displayWinRate, 1.0);
});

test("fenêtre seulement 3y ne peut pas devenir Robuste multi-horizons", () => {
  const only3y = win({
    horizonYears: 3,
    score: 50,
    sampleSize: 3,
    winRate: 1.0,
    avgReturn: 0.516,
    displayLabel: "1 avr. → 1 juil.",
  });
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData([only3y]));
  assert.equal(result.bullish.length, 1);
  assert.notEqual(result.bullish[0].multiHorizonConfidence, "robuste multi-horizons");
  assert.equal(Object.keys(result.bullish[0].horizonStats ?? {}).length, 1);
});

test("fenêtre 15y confirmée préférée à fenêtre 3y spectaculaire", () => {
  const spectacular3y = win({
    horizonYears: 3,
    score: 99,
    sampleSize: 3,
    winRate: 1.0,
    avgReturn: 0.80,
    startMonth: 4,
    endMonth: 7,
    displayLabel: "1 avr. → 1 juil.",
  });
  const robust15y = win({
    horizonYears: 15,
    score: 20,
    sampleSize: 16,
    winRate: 0.875,
    avgReturn: 0.166,
    startMonth: 9,
    startWeekOfMonth: 1,
    endMonth: 12,
    endWeekOfMonth: 2,
    displayLabel: "Sep W1 → Dec W2",
  });
  const result = selectAdaptiveSwingSeasonalityWindows(
    mockWindowsData([spectacular3y, robust15y]),
    { maxBullish: 2 },
  );
  assert.equal(result.bullish.length, 2);
  const first = result.bullish[0];
  const second = result.bullish[1];
  assert.ok(first.horizonStats?.["15y"], "fenêtre 15y classée avant la 3y spectaculaire");
  assert.ok((first.multiHorizonScore ?? 0) > (second.multiHorizonScore ?? 0));
  assert.ok(first.longHorizonConfirmed);
  assert.ok(second.horizonStats?.["3y"] || (second.confirmedHorizons ?? []).includes("3y"));
});

test("bearish : downRate = 1 - winRate et direction confirmée", () => {
  const bear = win({
    horizonYears: 10,
    avgReturn: -0.12,
    winRate: 0.30,
    sampleSize: 10,
    displayLabel: "Sep → Oct",
    startMonth: 9,
    endMonth: 10,
  });
  const stats = buildHorizonStatsForMembers([bear], "bearish");
  assert.equal(stats["10y"].downRate, 0.7);
  assert.equal(stats["10y"].directionConfirmed, true);
});

test("cross-year : Sep → Jan dans buildSwingHorizonFamilies", () => {
  const fall = win({
    startMonth: 10,
    startDay: 29,
    endMonth: 1,
    endDay: 29,
    windowDays: 60,
    score: 11,
    horizonYears: 10,
    sampleSize: 10,
    winRate: 0.8,
    avgReturn: 0.15,
    displayLabel: "29 oct. → 29 jan.",
  });
  const families = buildSwingHorizonFamilies([fall], { direction: "bullish" });
  assert.equal(families.length, 1);
  const { startDOY, endDOY } = buildCalendarCoverageMask(families[0]);
  assert.ok(startDOY > endDOY, "oct→jan traverse l'année");
});

test("totalOccurrences somme les horizons", () => {
  const members = [
    win({ horizonYears: 3, sampleSize: 3, winRate: 1, avgReturn: 0.5 }),
    win({ horizonYears: 15, sampleSize: 16, winRate: 0.875, avgReturn: 0.166 }),
  ];
  const family = buildSwingHorizonFamilies(members, { direction: "bullish" })[0];
  assert.equal(family.totalOccurrences, 19);
});

test("scoreMultiHorizonSwingFamily pénalise 3y seul", () => {
  const only3 = {
    horizonStats: {
      "3y": { sampleSize: 3, avgReturn: 0.5, winRate: 1, downRate: 0, directionConfirmed: true },
    },
    totalOccurrences: 3,
  };
  const multi = {
    horizonStats: {
      "3y": { sampleSize: 3, avgReturn: 0.5, winRate: 1, downRate: 0, directionConfirmed: true },
      "15y": { sampleSize: 16, avgReturn: 0.166, winRate: 0.875, downRate: 0.125, directionConfirmed: true },
    },
    totalOccurrences: 19,
  };
  assert.ok(scoreMultiHorizonSwingFamily(multi, "bullish") > scoreMultiHorizonSwingFamily(only3, "bullish"));
});

test("multiHorizonConfidenceFromFamily : règles clés", () => {
  const robustMulti = {
    horizonStats: {
      "3y": { directionConfirmed: true, sampleSize: 3 },
      "5y": { directionConfirmed: true, sampleSize: 5 },
      "10y": { directionConfirmed: true, sampleSize: 10 },
      "15y": { directionConfirmed: true, sampleSize: 16 },
    },
    totalOccurrences: 34,
  };
  assert.equal(multiHorizonConfidenceFromFamily(robustMulti), "robuste multi-horizons");

  const only3 = {
    horizonStats: { "3y": { directionConfirmed: true, sampleSize: 3 } },
    totalOccurrences: 3,
  };
  assert.equal(multiHorizonConfidenceFromFamily(only3), "échantillon limité");
});

test("computeSeasonalityWindowsFromRows expose swingWindows", () => {
  const startYear = new Date().getUTCFullYear() - 10;
  const d = new Date(Date.UTC(startYear, 0, 2));
  const rows = [];
  let price = 100;
  while (rows.length < 2600) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const month = d.getUTCMonth() + 1;
      const mult = month === 4 ? 1.008 : 1.0;
      price = Number((price * mult).toFixed(4));
      rows.push({ date: new Date(d), open: price, high: price, low: price, close: price });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [40, 60, 90],
    topN: 8,
  });

  assert.ok(result.swingWindows);
  assert.ok(result.distinct);
  assert.ok(result.clusters);
  for (const w of [...result.swingWindows.bullish, ...result.swingWindows.bearish]) {
    assert.ok(w.durationDays >= 35 && w.durationDays <= 119);
    assert.ok(w.horizonsFound);
    assert.ok(w.momentumTriggerHint);
    if (w.horizonStats) {
      assert.ok(w.multiHorizonConfidence);
      assert.ok(w.selectionReason);
    }
  }
});
