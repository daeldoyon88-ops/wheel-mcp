import assert from "node:assert/strict";
import test from "node:test";

import { buildSupportResistanceV4ConfirmedZones } from "./supportResistanceV4ConfirmedZones.js";

function makeCandle(close, { date = null, high = null, low = null, open = null, volume = null } = {}) {
  return { date, open, high, low, close, volume };
}

// Build N candles all at approximately the same close price
function candlesAt(price, n, { dateStart = "2026-01-01", offset = 0, spread = 0.05 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(dateStart);
    d.setDate(d.getDate() + offset + i);
    const cl = price + (i % 2 === 0 ? spread : -spread);
    return makeCandle(cl, {
      date: d.toISOString().slice(0, 10),
      high: cl + 0.2,
      low: cl - 0.2,
    });
  });
}

test("buildSupportResistanceV4ConfirmedZones: retour stable si ohlcCandles absent", () => {
  const r = buildSupportResistanceV4ConfirmedZones({ spot: 50, strike: 47, dteDays: 5 });
  assert.equal(r.available, false);
  assert.equal(r.diagnosticOnly, true);
  assert.equal(r.zonesCount, 0);
  assert.deepEqual(r.supports, []);
  assert.deepEqual(r.resistances, []);
  assert.equal(r.bestSupportZone, null);
  assert.equal(r.bestResistanceZone, null);
});

test("buildSupportResistanceV4ConfirmedZones: retour stable si ohlcCandles vide", () => {
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles: [], spot: 50, strike: 47, dteDays: 5 });
  assert.equal(r.available, false);
  assert.equal(r.diagnosticOnly, true);
});

test("buildSupportResistanceV4ConfirmedZones: retour stable sans argument", () => {
  const r = buildSupportResistanceV4ConfirmedZones();
  assert.equal(r.available, false);
  assert.equal(r.diagnosticOnly, true);
});

test("buildSupportResistanceV4ConfirmedZones: support confirmé par 3 closes sous spot", () => {
  const spot = 100;
  // 3 candles clustered near 80, well below spot
  const supportCandles = candlesAt(80, 3, { dateStart: "2026-01-01", spread: 0.1 });
  // a few scattered candles near spot to have a realistic series
  const noise = [
    makeCandle(99, { date: "2026-01-10", high: 101, low: 97 }),
    makeCandle(101, { date: "2026-01-11", high: 103, low: 99 }),
  ];
  const ohlcCandles = [...supportCandles, ...noise];

  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot, strike: 90, dteDays: 7 });
  assert.equal(r.available, true);
  assert.equal(r.diagnosticOnly, true);
  assert.ok(r.supports.length >= 1, "doit détecter au moins 1 support");
  const best = r.bestSupportZone;
  assert.ok(best != null);
  assert.ok(best.closeTouchCount >= 3, "support doit avoir >= 3 clôtures");
  assert.ok(best.zoneMid < spot, "zoneMid doit être sous spot");
});

test("buildSupportResistanceV4ConfirmedZones: résistance confirmée par 3 closes au-dessus spot", () => {
  const spot = 100;
  const resistanceCandles = candlesAt(120, 3, { dateStart: "2026-01-01", spread: 0.1 });
  const noise = [
    makeCandle(99, { date: "2026-01-10", high: 101, low: 97 }),
    makeCandle(101, { date: "2026-01-11", high: 103, low: 99 }),
  ];
  const ohlcCandles = [...resistanceCandles, ...noise];

  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot, strike: 95, dteDays: 7 });
  assert.equal(r.available, true);
  assert.ok(r.resistances.length >= 1, "doit détecter au moins 1 résistance");
  const best = r.bestResistanceZone;
  assert.ok(best != null);
  assert.ok(best.closeTouchCount >= 3);
  assert.ok(best.zoneMid > spot, "zoneMid doit être au-dessus de spot");
});

test("buildSupportResistanceV4ConfirmedZones: mèches seules ne créent pas de zone confirmée", () => {
  const spot = 100;
  // Only 2 close touches near 80, but many wick touches
  const twoCloses = candlesAt(80, 2, { dateStart: "2026-01-01" });
  const wickOnly = Array.from({ length: 5 }, (_, i) => makeCandle(100 + i, {
    date: `2026-01-${10 + i}`,
    high: 82,  // wick into the 80 zone
    low: 78,
  }));
  const ohlcCandles = [...twoCloses, ...wickOnly];

  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot, strike: 90, dteDays: 7 });
  // The zone at ~80 must NOT be confirmed because it only has 2 close touches
  const zoneAt80 = [...r.supports, ...r.resistances].find((z) => z.zoneMid < 85);
  assert.ok(!zoneAt80 || zoneAt80.closeTouchCount >= 3,
    "mèches seules ne doivent pas créer une zone confirmée (closeTouchCount doit être >= 3)");
});

test("buildSupportResistanceV4ConfirmedZones: ne plante pas avec candles invalides et date null", () => {
  const ohlcCandles = [
    { date: null, open: null, high: null, low: null, close: 50, volume: null },
    { date: null, open: null, high: null, low: null, close: 50.05, volume: null },
    { date: null, open: null, high: null, low: null, close: 49.95, volume: null },
    { date: null, open: null, high: "bad", low: null, close: null, volume: null }, // invalid
    { date: null, open: null, high: null, low: null, close: NaN, volume: null },  // invalid
    makeCandle(100, { date: null, high: 102, low: 98 }),
  ];
  let r;
  assert.doesNotThrow(() => {
    r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 100, strike: 95, dteDays: 7 });
  });
  assert.equal(r.diagnosticOnly, true);
});

test("buildSupportResistanceV4ConfirmedZones: diagnosticOnly est toujours true", () => {
  const cases = [
    buildSupportResistanceV4ConfirmedZones(),
    buildSupportResistanceV4ConfirmedZones({ ohlcCandles: [], spot: 50 }),
    buildSupportResistanceV4ConfirmedZones({
      ohlcCandles: candlesAt(80, 4, { dateStart: "2026-01-01" }),
      spot: 100,
      strike: 90,
      dteDays: 7,
    }),
  ];
  for (const r of cases) {
    assert.equal(r.diagnosticOnly, true, "diagnosticOnly doit toujours être true");
  }
});
