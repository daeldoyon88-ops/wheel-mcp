import assert from "node:assert/strict";
import test   from "node:test";

import {
  computeCalendarFromRows,
  computeSeasonality,
} from "./seasonalityEngine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeMonthRows(year, month, firstPrice, lastPrice) {
  return [
    { date: new Date(Date.UTC(year, month - 1, 1)),  open: firstPrice, high: firstPrice, low: firstPrice, close: firstPrice },
    { date: new Date(Date.UTC(year, month - 1, 15)), open: lastPrice,  high: lastPrice,  low: lastPrice,  close: lastPrice  },
  ];
}

function makeYearsOfData(years, getMonthPrices) {
  // getMonthPrices(year, month) → [firstPrice, lastPrice]
  const rows = [];
  for (const year of years) {
    for (let month = 1; month <= 12; month++) {
      const [first, last] = getMonthPrices(year, month);
      rows.push(...makeMonthRows(year, month, first, last));
    }
  }
  return rows;
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

test("computeCalendarFromRows: retourne null si rows null ou vide", () => {
  assert.equal(computeCalendarFromRows(null), null);
  assert.equal(computeCalendarFromRows([]),   null);
});

test("computeCalendarFromRows: calcule 12 mois sur 5 ans (+10% chaque mois)", () => {
  const years = [2019, 2020, 2021, 2022, 2023];
  const rows  = makeYearsOfData(years, () => [100, 110]);
  const result = computeCalendarFromRows(rows);

  assert.ok(result,                      "result ne doit pas être null");
  assert.equal(result.months.length, 12, "doit retourner 12 mois");

  const jan = result.months.find(m => m.month === 1);
  assert.ok(jan,                  "Janvier doit être présent");
  assert.equal(jan.label,         "Jan");
  assert.equal(jan.sampleSize,    5);
  assert.equal(jan.winRate,       1.0);
  assert.equal(jan.positiveYears, 5);
  assert.equal(jan.negativeYears, 0);
  assert.ok(jan.avgReturn > 0,    "avgReturn doit être positif");
  assert.equal(jan.verdict,       "favorable");
});

test("computeCalendarFromRows: retourne null si toutes les années < MIN_SAMPLE_SIZE (2 ans)", () => {
  const years = [2022, 2023];
  const rows  = makeYearsOfData(years, () => [100, 110]);
  const result = computeCalendarFromRows(rows);
  assert.equal(result, null, "doit retourner null avec seulement 2 ans");
});

test("computeCalendarFromRows: winRate et avgReturn corrects (3 positifs / 1 négatif)", () => {
  const years = [2019, 2020, 2021, 2022];
  // Janvier : +10%, +10%, +10%, -5% — autres mois : flat
  const rows = makeYearsOfData(years, (year, month) => {
    if (month !== 1) return [100, 100];
    const prices = { 2019: [100, 110], 2020: [100, 110], 2021: [100, 110], 2022: [100, 95] };
    return prices[year];
  });
  const result = computeCalendarFromRows(rows);
  assert.ok(result);

  const jan = result.months.find(m => m.month === 1);
  assert.ok(jan);
  assert.equal(jan.winRate,       0.75);
  assert.equal(jan.positiveYears, 3);
  assert.equal(jan.negativeYears, 1);
  // avgReturn = (0.10 + 0.10 + 0.10 - 0.05) / 4 = 0.0625
  assert.ok(Math.abs(jan.avgReturn - 0.0625) < 0.0001, `avgReturn attendu ~0.0625, obtenu ${jan.avgReturn}`);
  assert.equal(jan.verdict, "favorable"); // winRate=0.75>=0.65 ET avgReturn>0
});

test("computeCalendarFromRows: verdict faible si winRate<=0.45 ET avgReturn<0", () => {
  const years = [2019, 2020, 2021, 2022, 2023];
  // Juillet : 5 années négatives (-10% chaque fois)
  const rows = makeYearsOfData(years, (year, month) =>
    month === 7 ? [100, 90] : [100, 100],
  );
  const result = computeCalendarFromRows(rows);
  assert.ok(result);

  const jul = result.months.find(m => m.month === 7);
  assert.ok(jul);
  assert.equal(jul.winRate,  0);
  assert.ok(jul.avgReturn < 0);
  assert.equal(jul.verdict, "faible");
});

test("computeCalendarFromRows: verdict neutre pour winRate intermédiaire (0.60)", () => {
  const years = [2019, 2020, 2021, 2022, 2023];
  // Juin : 3 positifs (+10%), 2 négatifs (-10%) → winRate=0.60, avgReturn=+2%
  const rows = makeYearsOfData(years, (year, month) => {
    if (month !== 6) return [100, 100];
    return [2019, 2020, 2021].includes(year) ? [100, 110] : [100, 90];
  });
  const result = computeCalendarFromRows(rows);
  assert.ok(result);

  const jun = result.months.find(m => m.month === 6);
  assert.ok(jun);
  assert.equal(jun.winRate, 0.6);
  assert.equal(jun.verdict, "neutre"); // 0.60 < 0.65 donc pas favorable
});

test("computeCalendarFromRows: bestMonth et worstMonth corrects", () => {
  const years = [2019, 2020, 2021, 2022, 2023];
  const rows = makeYearsOfData(years, (year, month) => {
    if (month === 3) return [100, 120]; // Mars : meilleur (+20%)
    if (month === 9) return [100, 85];  // Septembre : pire (-15%)
    return [100, 100];
  });
  const result = computeCalendarFromRows(rows);
  assert.ok(result);
  assert.equal(result.summary.bestMonth.month,  3, "Mars doit être le meilleur mois");
  assert.equal(result.summary.worstMonth.month, 9, "Septembre doit être le pire mois");
});

test("computeCalendarFromRows: labels français corrects pour chaque mois", () => {
  const years = [2019, 2020, 2021, 2022, 2023];
  const rows  = makeYearsOfData(years, () => [100, 105]);
  const result = computeCalendarFromRows(rows);
  assert.ok(result);

  const labels = result.months.map(m => m.label);
  const expected = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];
  assert.deepEqual(labels, expected);
});

test("computeCalendarFromRows: yearsCovered exclut l'année courante", () => {
  const currentYear = new Date().getUTCFullYear();
  const pastYears   = [currentYear - 5, currentYear - 4, currentYear - 3, currentYear - 2, currentYear - 1];
  const rows        = makeYearsOfData([...pastYears, currentYear], () => [100, 105]);
  const result      = computeCalendarFromRows(rows);
  assert.ok(result);
  assert.equal(result.summary.yearsCovered, 5, "yearsCovered ne doit compter que les années passées");
});

test("computeSeasonality est toujours exporté et de type function (non-breaking)", () => {
  assert.equal(typeof computeSeasonality, "function");
});
