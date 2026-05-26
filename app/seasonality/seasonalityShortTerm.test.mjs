import assert from "node:assert/strict";
import test   from "node:test";

import {
  computeShortTermFromRows,
  computeSeasonality,
  computeSeasonalityCalendar,
} from "./seasonalityEngine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeDailyRows(prices) {
  // prices: array of close values, one per trading day starting 2020-01-02
  const base = new Date(Date.UTC(2020, 0, 2));
  return prices.map((close, i) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() + i);
    return { date, open: close, high: close, low: close, close };
  });
}

function makeStableBullishRows(count = 500) {
  // +0.5% chaque jour — haussier stable
  const prices = [];
  let p = 100;
  for (let i = 0; i < count; i++) {
    p *= 1.005;
    prices.push(Number(p.toFixed(4)));
  }
  return makeDailyRows(prices);
}

function makeBearishRows(count = 500) {
  // -1% chaque jour — baissier
  const prices = [];
  let p = 100;
  for (let i = 0; i < count; i++) {
    p *= 0.99;
    prices.push(Number(p.toFixed(4)));
  }
  return makeDailyRows(prices);
}

function makeRallyRows(count = 500) {
  // +2% chaque jour — forts rallies
  const prices = [];
  let p = 100;
  for (let i = 0; i < count; i++) {
    p *= 1.02;
    prices.push(Number(p.toFixed(4)));
  }
  return makeDailyRows(prices);
}

function makeFlatRows(count = 500) {
  return makeDailyRows(Array(count).fill(100));
}

function makeMixedRows() {
  // Pattern répété : +1%, +1%, +1%, -8%, +1%, +1%, +1%, -8% ...
  const prices = [100];
  for (let i = 1; i < 500; i++) {
    const prev = prices[i - 1];
    prices.push(i % 8 === 3 ? prev * 0.92 : prev * 1.01);
  }
  return makeDailyRows(prices);
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

test("computeShortTermFromRows: retourne null si rows null ou vide", () => {
  assert.equal(computeShortTermFromRows(null), null);
  assert.equal(computeShortTermFromRows([]),   null);
});

test("computeShortTermFromRows: calcule les fenêtres 3 / 4 / 7 / 14 jours", () => {
  const rows   = makeStableBullishRows(600);
  const result = computeShortTermFromRows(rows);

  assert.ok(result, "result ne doit pas être null");
  assert.equal(result.windows.length, 4, "doit retourner 4 fenêtres");

  const days = result.windows.map(w => w.days);
  assert.deepEqual(days, [3, 4, 7, 14]);

  for (const w of result.windows) {
    assert.ok(w.label,           `label manquant pour ${w.days}j`);
    assert.ok(w.sampleSize >= 3, `sampleSize trop faible pour ${w.days}j`);
    assert.ok(typeof w.avgReturn === "number");
    assert.ok(typeof w.winRate === "number");
    assert.ok(typeof w.cspVerdict === "string");
    assert.ok(typeof w.ccVerdict === "string");
  }
});

test("computeShortTermFromRows: avgReturn et winRate corrects sur rows simulées", () => {
  // Croissance constante : chaque jour +3.228% → rendement sur 3 jours de bourse ≈ +10%
  const k = Math.pow(1.10, 1 / 3);
  const prices = [100];
  for (let i = 1; i < 30; i++) {
    prices.push(Number((prices[i - 1] * k).toFixed(4)));
  }
  const rows   = makeDailyRows(prices);
  const result = computeShortTermFromRows(rows, { daysList: [3] });

  assert.ok(result);
  const w = result.windows[0];
  assert.equal(w.days, 3);
  assert.ok(Math.abs(w.avgReturn - 0.10) < 0.001, `avgReturn attendu ~0.10, obtenu ${w.avgReturn}`);
  assert.equal(w.winRate, 1.0);
  assert.equal(w.positiveCount, w.sampleSize);
  assert.equal(w.negativeCount, 0);
});

test("computeShortTermFromRows: pctBelow3 / pctBelow5 / pctBelow10 corrects", () => {
  // Alternance : +1% puis -6% (déclenche below5 mais pas below10)
  const prices = [100];
  for (let i = 1; i < 200; i++) {
    prices.push(i % 2 === 0 ? prices[i - 1] * 1.01 : prices[i - 1] * 0.94);
  }
  const rows   = makeDailyRows(prices);
  const result = computeShortTermFromRows(rows, { daysList: [1] });

  assert.ok(result);
  const w = result.windows[0];
  assert.ok(w.pctBelow3  > 0, "pctBelow3 doit être > 0");
  assert.ok(w.pctBelow5  > 0, "pctBelow5 doit être > 0");
  assert.equal(w.pctBelow10, 0, "pctBelow10 doit être 0 (baisse max ~6%)");
});

test("computeShortTermFromRows: pctAbove3 / pctAbove5 / pctAbove10 corrects", () => {
  const rows   = makeRallyRows(300);
  const result = computeShortTermFromRows(rows, { daysList: [7] });

  assert.ok(result);
  const w = result.windows[0];
  // +2%/jour sur 7 jours de bourse ≈ +14.9% → pctAbove10 élevé
  assert.ok(w.pctAbove3  > 0.5, "pctAbove3 doit être élevé avec +2%/jour");
  assert.ok(w.pctAbove5  > 0.5, "pctAbove5 doit être élevé");
  assert.ok(w.pctAbove10 > 0.5, "pctAbove10 doit être élevé");
});

test("computeShortTermFromRows: cspVerdict favorable dans un scénario haussier stable", () => {
  const rows   = makeStableBullishRows(600);
  const result = computeShortTermFromRows(rows);

  assert.ok(result);
  const favorable = result.windows.filter(w => w.cspVerdict === "favorable");
  assert.ok(favorable.length >= 1, "au moins une fenêtre CSP favorable attendue");
});

test("computeShortTermFromRows: cspVerdict defavorable dans un scénario avec grosses baisses", () => {
  const rows   = makeBearishRows(600);
  const result = computeShortTermFromRows(rows);

  assert.ok(result);
  const defavorable = result.windows.filter(w => w.cspVerdict === "defavorable");
  assert.ok(defavorable.length >= 1, "au moins une fenêtre CSP defavorable attendue");
});

test("computeShortTermFromRows: ccVerdict risque_hausse dans un scénario avec forts rallies", () => {
  const rows   = makeRallyRows(600);
  const result = computeShortTermFromRows(rows);

  assert.ok(result);
  const risque = result.windows.filter(w => w.ccVerdict === "risque_hausse");
  assert.ok(risque.length >= 1, "au moins une fenêtre CC risque_hausse attendue");
});

test("computeShortTermFromRows: ccVerdict favorable dans un scénario faible upside", () => {
  const rows   = makeFlatRows(600);
  const result = computeShortTermFromRows(rows);

  assert.ok(result);
  for (const w of result.windows) {
    assert.equal(w.ccVerdict, "favorable", `fenêtre ${w.days}j doit être CC favorable (flat)`);
  }
});

test("computeSeasonality et computeSeasonalityCalendar restent exportés et non cassés", () => {
  assert.equal(typeof computeSeasonality,         "function");
  assert.equal(typeof computeSeasonalityCalendar, "function");
});

test("computeShortTermFromRows: summary contient bestCspWindow et riskiestCcWindow", () => {
  const rows   = makeMixedRows();
  const result = computeShortTermFromRows(rows);

  assert.ok(result);
  assert.ok(result.summary.bestCspWindow,    "bestCspWindow manquant");
  assert.ok(result.summary.worstCspWindow,   "worstCspWindow manquant");
  assert.ok(result.summary.bestCcWindow,     "bestCcWindow manquant");
  assert.ok(result.summary.riskiestCcWindow, "riskiestCcWindow manquant");
  assert.equal(result.summary.source, "Yahoo Finance");
  assert.equal(result.summary.cacheTtlHours, 4);
});
