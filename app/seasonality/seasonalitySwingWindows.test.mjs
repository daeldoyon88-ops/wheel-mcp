import assert from "node:assert/strict";
import test   from "node:test";

import {
  flattenSwingCandidates,
  consolidateSwingFamilies,
  selectAdaptiveSwingSeasonalityWindows,
  attachSwingSeasonalityWindows,
  swingConfidenceFromHorizons,
} from "./seasonalitySwingWindows.js";
import { computeSeasonalityWindowsFromRows } from "./seasonalityEngine.js";

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
    win({ horizonYears: 3, score: 9 }),
    win({ horizonYears: 5, score: 11 }),
    win({ horizonYears: 10, score: 10 }),
    win({ horizonYears: 15, score: 10 }),
  ];
  const result = selectAdaptiveSwingSeasonalityWindows(mockWindowsData(variants));
  assert.equal(result.bullish.length, 1);
  assert.equal(result.bullish[0].confidence, "robuste");
  assert.equal(result.bullish[0].horizonsFound.length, 4);
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
  }
});
