import assert from "node:assert/strict";
import test   from "node:test";

import {
  buildSeasonalWindowDisplayFields,
  enrichSeasonalityWindowDisplay,
  weekOfMonthToDay,
  resolveEndYear,
} from "./seasonalityWindowDisplay.js";
import { computeSeasonalityWindowsFromRows } from "./seasonalityEngine.js";

test("weekOfMonthToDay: W1–W4 mapping fixe", () => {
  assert.equal(weekOfMonthToDay(4, 1, 2026), 1);
  assert.equal(weekOfMonthToDay(4, 2, 2026), 8);
  assert.equal(weekOfMonthToDay(4, 3, 2026), 15);
  assert.equal(weekOfMonthToDay(4, 4, 2026), 22);
});

test("weekOfMonthToDay: W5 = min(29, dernier jour du mois)", () => {
  assert.equal(weekOfMonthToDay(2, 5, 2026), 28);
  assert.equal(weekOfMonthToDay(4, 5, 2026), 29);
  assert.equal(weekOfMonthToDay(2, 5, 2024), 29);
});

test("buildSeasonalWindowDisplayFields: Avr W3 → Juil W3 avec jours", () => {
  const d = buildSeasonalWindowDisplayFields({
    startMonth: 4,
    startWeekOfMonth: 3,
    endMonth: 7,
    endWeekOfMonth: 3,
    label: "Avr W3 → Juil W3",
    windowDays: 60,
    referenceYear: 2026,
  });

  assert.equal(d.label, "Avr W3 → Juil W3");
  assert.equal(d.startDay, 15);
  assert.equal(d.endDay, 15);
  assert.equal(d.displayLabel, "15 avr. → 15 juil.");
  assert.equal(d.displayLabelWithYear, "15 avr. 2026 → 15 juil. 2026");
  assert.equal(d.startDateCurrentYear, "2026-04-15");
  assert.equal(d.endDateCurrentYear, "2026-07-15");
  assert.equal(d.windowDays, 60);
});

test("buildSeasonalWindowDisplayFields: Déc W4 → Mar W3 traverse l'année", () => {
  const d = buildSeasonalWindowDisplayFields({
    startMonth: 12,
    startWeekOfMonth: 4,
    endMonth: 3,
    endWeekOfMonth: 3,
    label: "Déc W4 → Mar W3",
    referenceYear: 2026,
  });

  assert.equal(d.startDay, 22);
  assert.equal(d.endDay, 15);
  assert.equal(d.displayLabel, "22 déc. → 15 mars");
  assert.equal(d.displayLabelWithYear, "22 déc. 2026 → 15 mars 2027");
  assert.equal(d.startDateCurrentYear, "2026-12-22");
  assert.equal(d.endDateCurrentYear, "2027-03-15");
  assert.equal(resolveEndYear(12, 22, 3, 15, 2026), 2027);
});

test("enrichSeasonalityWindowDisplay: conserve label existant", () => {
  const w = enrichSeasonalityWindowDisplay({
    label: "Mar W4 → Juil W5",
    startMonth: 3,
    startWeekOfMonth: 4,
    endMonth: 7,
    endWeekOfMonth: 5,
    windowDays: 90,
  });

  assert.equal(w.label, "Mar W4 → Juil W5");
  assert.ok(w.displayLabel.includes("→"));
  assert.match(w.displayLabel, /\d+ mars/);
  assert.equal(w.startDay, 22);
  assert.equal(w.endDay, 29);
});

test("computeSeasonalityWindowsFromRows: fenêtres incluent displayLabel et label", () => {
  const startYear = new Date().getUTCFullYear() - 8;
  const rows = [];
  let price = 100;
  const d = new Date(Date.UTC(startYear, 0, 2));
  while (rows.length < 8 * 260) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const mult = month === 4 && day >= 15 && day <= 30 ? 1.01 : 1.0;
      price = Number((price * mult).toFixed(4));
      rows.push({ date: new Date(d), open: price, high: price, low: price, close: price });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [60],
    topN: 3,
  });

  assert.ok(result);
  const all = result.horizons.flatMap((h) =>
    h.windows.flatMap((b) => [...b.bestBullish, ...b.worstBearish]),
  );
  assert.ok(all.length >= 1);

  for (const w of all) {
    assert.ok(w.label, "label doit rester présent");
    assert.ok(w.displayLabel, "displayLabel doit être présent");
    assert.ok(w.displayLabel.includes("→"));
    assert.ok(w.startDay >= 1 && w.startDay <= 31);
    assert.ok(w.endDay >= 1 && w.endDay <= 31);
    assert.match(w.startDateCurrentYear, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(w.endDateCurrentYear, /^\d{4}-\d{2}-\d{2}$/);
  }

  if (result.summary.bestOverallBullish) {
    assert.ok(result.summary.bestOverallBullish.displayLabel);
    assert.ok(result.summary.bestOverallBullish.label);
  }
});
