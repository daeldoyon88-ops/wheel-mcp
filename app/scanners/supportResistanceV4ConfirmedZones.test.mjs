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

function makeSupportSeries({
  spot,
  supportBase,
  supportSpread = 0.12,
  supportCount = 4,
  wickCount = 3,
}) {
  const earlyNoise = [
    makeCandle(spot * 1.01, { date: "2026-01-01", high: spot * 1.02, low: spot * 0.995 }),
    makeCandle(spot * 0.995, { date: "2026-01-02", high: spot * 1.01, low: spot * 0.985 }),
    makeCandle(spot * 1.005, { date: "2026-01-03", high: spot * 1.015, low: spot * 0.99 }),
  ];

  const supportCandles = Array.from({ length: supportCount }, (_, i) => {
    const d = new Date("2026-01-10");
    d.setDate(d.getDate() + i);
    const close = supportBase + (i % 2 === 0 ? supportSpread : -supportSpread);
    return makeCandle(close, {
      date: d.toISOString().slice(0, 10),
      high: close + 0.22,
      low: close - 0.22,
    });
  });

  const wickCandles = Array.from({ length: wickCount }, (_, i) => {
    const d = new Date("2026-01-20");
    d.setDate(d.getDate() + i);
    return makeCandle(spot + 0.4 + i * 0.1, {
      date: d.toISOString().slice(0, 10),
      high: supportBase + 0.3,
      low: supportBase - 0.3,
    });
  });

  return [...earlyNoise, ...supportCandles, ...wickCandles];
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

test("buildSupportResistanceV4ConfirmedZones: strikeProtectionV4 unavailable si strike absent", () => {
  const ohlcCandles = makeSupportSeries({ spot: 80, supportBase: 70 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 80, dteDays: 7 });
  assert.equal(r.strikeProtectionV4?.status, "unavailable");
  assert.equal(r.strikeProtectionV4?.diagnosticOnly, true);
  assert.equal(r.strikeProtectionV4?.score, 0);
});

test("buildSupportResistanceV4ConfirmedZones: strikeProtectionV4 protected si strike dans la zone", () => {
  const strike = 70;
  const ohlcCandles = makeSupportSeries({ spot: 80, supportBase: 70, supportSpread: 0.08, wickCount: 4 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 80, strike, dteDays: 7 });
  const protection = r.strikeProtectionV4;
  assert.equal(protection?.status, "protected");
  assert.equal(protection?.strikeInsideConfirmedSupportZone, true);
  assert.ok((protection?.score ?? 0) >= 80);
  assert.equal(protection?.summaryFr, "Strike dans une zone support V4 confirmee.");
});

test("buildSupportResistanceV4ConfirmedZones: strikeProtectionV4 partially_protected si strike 1-3% au-dessus d'un support confirme", () => {
  const strike = 70;
  const ohlcCandles = makeSupportSeries({ spot: 80, supportBase: 68.2, supportSpread: 0.08, wickCount: 4 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 80, strike, dteDays: 7 });
  const protection = r.strikeProtectionV4;
  assert.equal(protection?.status, "partially_protected");
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 0) > 0.5);
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 99) <= 3.5);
  assert.equal(protection?.summaryFr, "Strike au-dessus d'un support V4 confirme proche.");
});

test("buildSupportResistanceV4ConfirmedZones: strikeProtectionV4 weakly_protected si support confirme a 5-8% sous le strike", () => {
  const strike = 70;
  const ohlcCandles = makeSupportSeries({ spot: 80, supportBase: 65.2, supportSpread: 0.1, wickCount: 4 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 80, strike, dteDays: 7 });
  const protection = r.strikeProtectionV4;
  assert.equal(protection?.status, "weakly_protected");
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 0) > 5);
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 99) <= 8);
  assert.equal(protection?.summaryFr, "Support V4 confirme present, mais eloigne du strike.");
});

test("buildSupportResistanceV4ConfirmedZones: strikeProtectionV4 unprotected si support confirme a plus de 8% sous le strike", () => {
  const strike = 70;
  const ohlcCandles = makeSupportSeries({ spot: 80, supportBase: 60.4, supportSpread: 0.1, wickCount: 4 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot: 80, strike, dteDays: 7 });
  const protection = r.strikeProtectionV4;
  assert.equal(protection?.status, "unprotected");
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 0) > 8);
  assert.ok((protection?.score ?? 100) <= 34);
  assert.equal(protection?.summaryFr, "Support V4 confirme present, mais trop eloigne du strike.");
});

test("buildSupportResistanceV4ConfirmedZones: cas TQQQ-like reste hors protected/partially_protected", () => {
  const spot = 75;
  const strike = 68;
  const ohlcCandles = makeSupportSeries({ spot, supportBase: 59.7, supportSpread: 1.05, wickCount: 5 });
  const r = buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot, strike, dteDays: 7 });
  const protection = r.strikeProtectionV4;
  assert.notEqual(protection?.status, "protected");
  assert.notEqual(protection?.status, "partially_protected");
  assert.ok(["weakly_protected", "unprotected"].includes(protection?.status));
  assert.ok((protection?.supportDistanceBelowStrikePct ?? 0) > 8);
  assert.match(protection?.summaryFr ?? "", /(trop eloigne|Aucun support V4 confirme proche)/);
});
