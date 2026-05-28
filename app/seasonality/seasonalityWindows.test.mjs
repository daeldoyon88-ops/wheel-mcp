import assert from "node:assert/strict";
import test   from "node:test";

import {
  computeSeasonalityWindowsFromRows,
  computeSeasonality,
  computeSeasonalityCalendar,
  computeSeasonalityShortTerm,
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

function makeAprilRallyRows(numYears = 8) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();

    // Avril W1 → fin avril : hausse récurrente (~+20 % sur ~20 jours de bourse)
    if (month === 4 && day >= 1 && day <= 28) return 1.008;
    return 1.0;
  });
}

function makeSeptemberDropRows(numYears = 8) {
  const startYear = new Date().getUTCFullYear() - numYears - 1;
  const startDate = new Date(Date.UTC(startYear, 0, 2));

  return makeTradingCalendar(startDate, numYears * 260, (date) => {
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();

    // Septembre W1 → fin septembre : baisse récurrente
    if (month === 9 && day >= 1 && day <= 28) return 0.992;
    return 1.0;
  });
}

function makeConstantGrowthRows(numDays, dailyMult = 1.005) {
  return makeTradingCalendar(new Date(Date.UTC(2015, 0, 2)), numDays, () => dailyMult);
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

test("computeSeasonalityWindowsFromRows: retourne null si rows null ou vide", () => {
  assert.equal(computeSeasonalityWindowsFromRows(null), null);
  assert.equal(computeSeasonalityWindowsFromRows([]),   null);
});

test("computeSeasonalityWindowsFromRows: retourne les horizons 3 / 5 / 10 / 15", () => {
  const rows   = makeConstantGrowthRows(3200);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result, "result ne doit pas être null");
  const horizons = result.horizons.map(h => h.horizonYears);
  assert.deepEqual(horizons, [3, 5, 10, 15]);
});

test("computeSeasonalityWindowsFromRows: retourne les durées 20 / 40 / 60 / 90", () => {
  const rows   = makeConstantGrowthRows(3200);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result);
  for (const h of result.horizons) {
    const days = h.windows.map(w => w.windowDays);
    assert.deepEqual(days, [20, 40, 60, 90], `horizon ${h.horizonYears}Y`);
  }
});

test("computeSeasonalityWindowsFromRows: avgReturn et winRate corrects sur rows simulées", () => {
  const rows = makeConstantGrowthRows(3200, 1.005);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [3],
    windowDays: [20],
    topN: 1,
  });

  assert.ok(result);
  const block = result.horizons[0].windows[0];
  assert.ok(block.bestBullish.length >= 1);

  const top = block.bestBullish[0];
  assert.ok(top.avgReturn > 0, "avgReturn doit être positif avec croissance constante");
  assert.equal(top.winRate, 1.0);
  assert.equal(top.positiveCount, top.sampleSize);
  assert.equal(top.negativeCount, 0);
});

test("computeSeasonalityWindowsFromRows: détecte une fenêtre haussière récurrente (avril)", () => {
  const rows   = makeAprilRallyRows(10);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 5,
  });

  assert.ok(result);
  const block = result.horizons[0].windows[0];
  assert.ok(block.bestBullish.length >= 1, "au moins une fenêtre haussière attendue");

  const aprilWindows = block.bestBullish.filter(w => w.startMonth === 4);
  assert.ok(aprilWindows.length >= 1, "une fenêtre début avril doit être détectée");
  assert.ok(aprilWindows[0].winRate >= 0.5);
  assert.ok(aprilWindows[0].avgReturn > 0);
});

test("computeSeasonalityWindowsFromRows: détecte une fenêtre baissière récurrente (septembre)", () => {
  const rows   = makeSeptemberDropRows(10);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 5,
  });

  assert.ok(result);
  const block = result.horizons[0].windows[0];
  assert.ok(block.worstBearish.length >= 1, "au moins une fenêtre baissière attendue");

  const sepWindows = block.worstBearish.filter(w => w.startMonth === 9);
  assert.ok(sepWindows.length >= 1, "une fenêtre début septembre doit être détectée");
  assert.ok(sepWindows[0].avgReturn < 0 || sepWindows[0].winRate < 0.5);
});

test("computeSeasonalityWindowsFromRows: labels français corrects (ex. Avr W1 → …)", () => {
  const rows   = makeAprilRallyRows(10);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [20],
    topN: 5,
  });

  assert.ok(result);
  const allWindows = result.horizons.flatMap(h =>
    h.windows.flatMap(w => [...w.bestBullish, ...w.worstBearish]),
  );

  const avrWindow = allWindows.find(w => w.startMonth === 4 && w.startWeekOfMonth === 1);
  assert.ok(avrWindow, "fenêtre débutant en Avr W1 attendue");
  assert.ok(avrWindow.label.startsWith("Avr W1 →"), `label attendu Avr W1 → …, obtenu ${avrWindow.label}`);
  assert.match(avrWindow.label, /^Avr W1 → [A-ZÉû][a-zéû]* W[1-5]$/);
});

test("computeSeasonalityWindowsFromRows: status robuste / mesurable / préliminaire selon sampleSize", () => {
  const rows   = makeAprilRallyRows(12);
  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [10],
    windowDays: [20],
    topN: 10,
  });

  assert.ok(result);
  const allWindows = result.horizons.flatMap(h =>
    h.windows.flatMap(w => [...w.bestBullish, ...w.worstBearish]),
  );

  assert.ok(allWindows.length >= 1);
  for (const w of allWindows) {
    assert.ok(
      ['robuste', 'mesurable', 'préliminaire'].includes(w.status),
      `status invalide: ${w.status}`,
    );
    if (w.sampleSize >= 10) assert.equal(w.status, 'robuste');
    else if (w.sampleSize >= 5) assert.equal(w.status, 'mesurable');
    else assert.equal(w.status, 'préliminaire');
  }
});

test("computeSeasonalityWindowsFromRows: summary.bestOverallBullish et worstOverallBearish présents", () => {
  const rows   = makeAprilRallyRows(8);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result);
  assert.ok(result.summary.bestOverallBullish,  "bestOverallBullish manquant");
  assert.ok(result.summary.worstOverallBearish !== undefined, "worstOverallBearish manquant");
  assert.equal(result.summary.source, "Yahoo Finance");
  assert.equal(result.summary.cacheTtlHours, 4);
  assert.ok(Array.isArray(result.summary.activeNow));
});

test("computeSeasonalityWindowsFromRows: distinct.bullish et distinct.bearish présents (additif)", () => {
  const rows   = makeAprilRallyRows(8);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result.distinct);
  assert.ok(Array.isArray(result.distinct.bullish));
  assert.ok(Array.isArray(result.distinct.bearish));
  assert.ok(result.distinct.bullish.length <= 4);
  assert.ok(result.distinct.bearish.length <= 4);
  assert.equal(result.distinct.meta.algorithm, "greedy-by-score");
  assert.ok(result.horizons.length >= 1);
});

test("computeSeasonalityWindowsFromRows: clusters.bullish et clusters.bearish présents (additif)", () => {
  const rows   = makeAprilRallyRows(8);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result.clusters);
  assert.ok(Array.isArray(result.clusters.bullish));
  assert.ok(Array.isArray(result.clusters.bearish));
  assert.equal(result.clusters.meta.algorithm, "merge-overlap-and-nearby-calendar-windows");
  assert.equal(result.clusters.meta.gapToleranceDays, 21);
  assert.ok(result.distinct);
  assert.ok(result.horizons.length >= 1);
});

test("computeSeasonalityWindowsFromRows: swingWindows présent (additif)", () => {
  const rows   = makeAprilRallyRows(8);
  const result = computeSeasonalityWindowsFromRows(rows);

  assert.ok(result.swingWindows);
  assert.ok(Array.isArray(result.swingWindows.bullish));
  assert.ok(Array.isArray(result.swingWindows.bearish));
  assert.equal(result.swingWindows.meta.algorithm, "multi-horizon-adaptive-seasonality-swing-windows");
  assert.ok(result.distinct);
  assert.ok(result.clusters);
});

test("computeSeasonality, computeSeasonalityCalendar et computeSeasonalityShortTerm restent exportés", () => {
  assert.equal(typeof computeSeasonality,         "function");
  assert.equal(typeof computeSeasonalityCalendar, "function");
  assert.equal(typeof computeSeasonalityShortTerm, "function");
});
