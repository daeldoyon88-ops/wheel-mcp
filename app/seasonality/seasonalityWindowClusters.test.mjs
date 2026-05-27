import assert from "node:assert/strict";
import test   from "node:test";

import {
  computeCalendarGapDays,
  mergeSeasonalityClusterWindows,
  createSeasonalityClusters,
  attachSeasonalityClusters,
} from "./seasonalityWindowClusters.js";
import { computeSeasonalityWindowsFromRows } from "./seasonalityEngine.js";

function win(overrides) {
  return {
    startMonth: 4,
    startDay: 15,
    endMonth: 7,
    endDay: 15,
    startWeekOfMonth: 2,
    endWeekOfMonth: 3,
    score: 10,
    avgReturn: 0.08,
    winRate: 0.75,
    sampleSize: 8,
    status: "robuste",
    displayLabel: "15 avr. → 15 juil.",
    ...overrides,
  };
}

test("computeCalendarGapDays: chevauchement → 0", () => {
  const a = win();
  const b = win({ startMonth: 3, startDay: 22, endMonth: 7, endDay: 29, displayLabel: "22 mars → 29 juil." });
  assert.equal(computeCalendarGapDays(a, b), 0);
});

test("computeCalendarGapDays: gap linéaire > 21 entre été et hiver", () => {
  const summer = win({ startMonth: 6, startDay: 1, endMonth: 8, endDay: 31 });
  const winter = win({ startMonth: 12, startDay: 1, endMonth: 2, endDay: 28, displayLabel: "1 déc. → 28 fév." });
  assert.ok(computeCalendarGapDays(summer, winter) > 21);
});

test("ne fusionne pas mars→août avec oct→jan", () => {
  const spring = win({
    startMonth: 3, startDay: 8, endMonth: 8, endDay: 22,
    score: 12, displayLabel: "8 mars → 22 août",
  });
  const fall = win({
    startMonth: 10, startDay: 29, endMonth: 1, endDay: 29,
    score: 11, displayLabel: "29 oct. → 29 jan.",
  });
  const clusters = createSeasonalityClusters([spring, fall], { direction: "bullish", gapToleranceDays: 21 });
  assert.equal(clusters.length, 2);
  const labels = clusters.map((c) => c.displayLabel).join(" ");
  assert.ok(labels.includes("mars") || labels.includes("août"));
  assert.ok(labels.includes("oct") || labels.includes("jan"));
});

test("refuse un cluster bullish > 180 jours calendaires", () => {
  const windows = [];
  for (let m = 1; m <= 12; m++) {
    windows.push(win({
      startMonth: m,
      startDay: 1,
      endMonth: m,
      endDay: 28,
      score: 5 + m,
      displayLabel: `1 ${m} → 28 ${m}`,
    }));
  }
  const clusters = createSeasonalityClusters(windows, {
    direction: "bullish",
    gapToleranceDays: 21,
    maxClusterDurationDays: 180,
  });
  for (const c of clusters) {
    assert.ok(c.durationDays <= 180, `cluster trop long: ${c.durationDays}j`);
    assert.ok(c.monthsCovered <= 6, `trop de mois: ${c.monthsCovered}`);
  }
  assert.ok(clusters.length >= 2, "doit scinder en plusieurs clusters");
});

test("garde oct→jan comme cluster distinct traversant l'année", () => {
  const octJan = win({
    startMonth: 10, startDay: 29, endMonth: 1, endDay: 29,
    score: 8, displayLabel: "29 oct. → 29 jan.",
  });
  const clusters = createSeasonalityClusters([octJan], { direction: "bullish" });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].wrapsYear, true);
  assert.ok(clusters[0].displayLabel.includes("oct"));
  assert.ok(clusters[0].displayLabel.includes("jan"));
  assert.ok(clusters[0].durationDays < 180);
});

test("garde mars→août comme cluster distinct linéaire", () => {
  const variants = [
    win({ score: 12, displayLabel: "22 mars → 29 juil." }),
    win({ score: 11, startMonth: 3, startDay: 8, displayLabel: "8 mars → 15 juil." }),
    win({ score: 10, startMonth: 4, startDay: 1, endMonth: 8, endDay: 15, displayLabel: "1 avr. → 15 août" }),
  ];
  const clusters = createSeasonalityClusters(variants, { direction: "bullish", gapToleranceDays: 21 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].wrapsYear, false);
  assert.ok(clusters[0].displayLabel.includes("mars"));
  assert.ok(clusters[0].displayLabel.includes("août") || clusters[0].displayLabel.includes("juil"));
  assert.ok(clusters[0].monthsCovered <= 6);
});

test("empêche l'effet domino mars→décembre via gap linéaire", () => {
  const chain = [];
  for (let m = 3; m <= 11; m++) {
    chain.push(win({
      startMonth: m,
      startDay: 1,
      endMonth: m,
      endDay: 20,
      score: 20 - m,
      displayLabel: `fen ${m}`,
    }));
  }
  const clusters = createSeasonalityClusters(chain, {
    direction: "bullish",
    gapToleranceDays: 21,
    maxClusterDurationDays: 180,
  });
  assert.ok(clusters.length >= 2, "domino ne doit pas créer un seul méga-cluster");
});

test("fusionne fenêtres chevauchées et gap <= 21 dans la même saison", () => {
  const a = win({ startMonth: 3, startDay: 1, endMonth: 3, endDay: 25, displayLabel: "1 mars → 25 mars" });
  const b = win({ startMonth: 4, startDay: 10, endMonth: 4, endDay: 30, score: 9, displayLabel: "10 avr. → 30 avr." });
  assert.ok(computeCalendarGapDays(a, b) <= 21);
  const clusters = createSeasonalityClusters([a, b], { direction: "bullish", gapToleranceDays: 21 });
  assert.equal(clusters.length, 1);
});

test("gère octobre → janvier + décembre → mars (zone fin d'année)", () => {
  const octJan = win({
    startMonth: 10, startDay: 29, endMonth: 1, endDay: 29,
    score: 8, displayLabel: "29 oct. → 29 jan.",
  });
  const decMar = win({
    startMonth: 12, startDay: 22, endMonth: 3, endDay: 15,
    score: 7, displayLabel: "22 déc. → 15 mars",
  });
  const clusters = createSeasonalityClusters([octJan, decMar], { direction: "bullish", gapToleranceDays: 21 });
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].wrapsYear);
});

test("label start/end correct pour cluster traversant l'année", () => {
  const merged = mergeSeasonalityClusterWindows([
    win({ startMonth: 10, startDay: 29, endMonth: 1, endDay: 29, displayLabel: "29 oct. → 29 jan." }),
    win({ startMonth: 12, startDay: 22, endMonth: 2, endDay: 15, displayLabel: "22 déc. → 15 fév." }),
  ], { direction: "bullish" });
  assert.ok(merged.displayLabel.includes("oct"));
  assert.ok(merged.displayLabel.includes("jan") || merged.displayLabel.includes("fév"));
  assert.notEqual(merged.startLabel.toLowerCase(), "1 jan.");
});

test("mergeSeasonalityClusterWindows: monthsCovered et stats pondérées", () => {
  const merged = mergeSeasonalityClusterWindows([
    win({ avgReturn: 0.10, sampleSize: 10, winRate: 0.8, worstReturn: -0.05, bestReturn: 0.20 }),
    win({ avgReturn: 0.20, sampleSize: 6, winRate: 0.9, worstReturn: -0.10, bestReturn: 0.30, score: 15 }),
  ], { direction: "bullish" });

  assert.ok(merged.monthsCovered >= 1);
  assert.ok(Array.isArray(merged.coveredMonthLabels));
  assert.equal(merged.subWindows.length, 2);
});

test("attachSeasonalityClusters: conserve distinct et horizons", () => {
  const data = {
    horizons: [{
      horizonYears: 3,
      windows: [{
        windowDays: 60,
        bestBullish: [win(), win({ startMonth: 3, startDay: 8, score: 9 })],
        worstBearish: [],
      }],
    }],
    summary: {},
    distinct: {
      bullish: [win()],
      bearish: [],
      meta: { algorithm: "greedy-by-score" },
    },
  };

  const out = attachSeasonalityClusters(data);
  assert.ok(out.clusters);
  assert.ok(out.distinct);
  assert.ok(out.horizons);
  assert.equal(out.clusters.meta.maxClusterDurationDays, 180);
});

test("computeSeasonalityWindowsFromRows: clusters + distinct + horizons", () => {
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
    windowDays: [60],
    topN: 5,
  });

  assert.ok(result.horizons?.length);
  assert.ok(result.distinct);
  assert.ok(result.clusters);
  for (const c of result.clusters.bullish ?? []) {
    assert.ok(c.durationDays <= 180);
    assert.ok(c.monthsCovered <= 6);
  }
});
