import assert from "node:assert/strict";
import test   from "node:test";

import {
  buildCalendarCoverageMask,
  computeCalendarOverlapRatio,
  areSeasonalityWindowsOverlapping,
  flattenSeasonalityWindows,
  selectDistinctSeasonalityWindows,
  attachDistinctSeasonalityWindows,
} from "./seasonalityWindowDistinct.js";
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
    ...overrides,
  };
}

test("computeCalendarOverlapRatio: fenêtres identiques → ratio 1", () => {
  const a = win({ startMonth: 4, startDay: 15, endMonth: 7, endDay: 15 });
  const b = win({ startMonth: 4, startDay: 15, endMonth: 7, endDay: 15 });
  assert.equal(computeCalendarOverlapRatio(a, b), 1);
});

test("computeCalendarOverlapRatio: variantes mars-été fortement chevauchées", () => {
  const a = win({ startMonth: 3, startDay: 22, endMonth: 7, endDay: 29 });
  const b = win({ startMonth: 4, startDay: 15, endMonth: 7, endDay: 15 });
  const ratio = computeCalendarOverlapRatio(a, b);
  assert.ok(ratio >= 0.6, `ratio attendu >= 0.6, reçu ${ratio}`);
});

test("computeCalendarOverlapRatio: fenêtres éloignées → ratio faible", () => {
  const summer = win({ startMonth: 6, startDay: 1, endMonth: 8, endDay: 31 });
  const winter = win({ startMonth: 12, startDay: 1, endMonth: 2, endDay: 28 });
  const ratio = computeCalendarOverlapRatio(summer, winter);
  assert.ok(ratio < 0.2, `ratio attendu < 0.2, reçu ${ratio}`);
});

test("chevauchement décembre → mars (wrap annuel)", () => {
  const decMar = win({ startMonth: 12, startDay: 1, endMonth: 3, endDay: 15 });
  const decFeb = win({ startMonth: 12, startDay: 8, endMonth: 2, endDay: 22 });
  const cov = buildCalendarCoverageMask(decMar);
  assert.ok(cov.mask[12] && cov.mask[366] && cov.mask[1] && cov.mask[3]);
  const ratio = computeCalendarOverlapRatio(decMar, decFeb);
  assert.ok(ratio >= 0.6);
  assert.ok(areSeasonalityWindowsOverlapping(decMar, decFeb));
});

test("selectDistinctSeasonalityWindows: garde une seule variante mars-été", () => {
  const variants = [
    win({ startMonth: 3, startDay: 22, endMonth: 7, endDay: 29, score: 12 }),
    win({ startMonth: 4, startDay: 15, endMonth: 7, endDay: 15, score: 11 }),
    win({ startMonth: 3, startDay: 8,  endMonth: 7, endDay: 15, score: 10 }),
    win({ startMonth: 4, startDay: 1,  endMonth: 8, endDay: 15, score: 9 }),
    win({ startMonth: 3, startDay: 29, endMonth: 8, endDay: 1,  score: 8 }),
  ];
  const distinct = selectDistinctSeasonalityWindows(variants, { maxDistinct: 4 });
  assert.equal(distinct.length, 1);
  assert.equal(distinct[0].score, 12);
});

test("selectDistinctSeasonalityWindows: conserve été et hiver distincts", () => {
  const summer = win({ startMonth: 4, startDay: 1, endMonth: 8, endDay: 31, score: 10 });
  const winter = win({ startMonth: 11, startDay: 1, endMonth: 2, endDay: 28, score: 9 });
  const distinct = selectDistinctSeasonalityWindows([summer, winter], { maxDistinct: 4 });
  assert.equal(distinct.length, 2);
});

test("flattenSeasonalityWindows et attachDistinct sur résultat moteur", () => {
  const windowsData = {
    horizons: [
      {
        horizonYears: 3,
        windows: [
          {
            windowDays: 60,
            bestBullish: [
              win({ score: 5 }),
              win({ startMonth: 3, startDay: 8, score: 4 }),
            ],
            worstBearish: [
              win({ startMonth: 9, startDay: 1, endMonth: 10, endDay: 15, score: 6 }),
            ],
          },
        ],
      },
    ],
    summary: {},
  };

  const flat = flattenSeasonalityWindows(windowsData, "bullish");
  assert.equal(flat.length, 2);
  assert.equal(flat[0].days, 60);

  const attached = attachDistinctSeasonalityWindows(windowsData);
  assert.ok(attached.distinct);
  assert.ok(attached.distinct.bullish.length <= 4);
  assert.equal(attached.distinct.bullish.length, 1);
  assert.equal(attached.distinct.meta.algorithm, "greedy-by-score");
  assert.ok(attached.horizons);
});

test("computeSeasonalityWindowsFromRows expose distinct sans casser horizons", () => {
  const startYear = new Date().getUTCFullYear() - 10;
  const d = new Date(Date.UTC(startYear, 0, 2));
  const rows = [];
  let price = 100;
  while (rows.length < 2600) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) {
      const month = d.getUTCMonth() + 1;
      const mult = month === 4 ? 1.008 : 1.0;
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

  const result = computeSeasonalityWindowsFromRows(rows, {
    horizonsYears: [5],
    windowDays: [60],
    topN: 3,
  });

  assert.ok(result?.horizons?.length);
  assert.ok(result.distinct);
  assert.ok(Array.isArray(result.distinct.bullish));
  assert.ok(Array.isArray(result.distinct.bearish));
  assert.equal(result.distinct.meta.overlapThreshold, 0.6);
});
