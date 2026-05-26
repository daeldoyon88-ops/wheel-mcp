import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMarketContextSnapshotFromInputs,
  deriveMarketRegimeLabel,
  deriveMarketRiskLabel,
  deriveRiskOnOffLabel,
  deriveVixRegimeLabel,
  enrichRecordWithMarketContextFields,
  parseMarketContextSnapshot,
} from "./marketContextSnapshot.js";
import { computeOnePercentWheelProfiles, computeDynamicTop20WheelProfiles } from "./wheelValidationService.js";

function buildTrendCandles(startPrice, dailyDrift = 0.002, count = 220) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    price *= 1 + dailyDrift;
    candles.push({
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
    });
  }
  return candles;
}

function buildFlatCandles(price, count = 220) {
  return Array.from({ length: count }, () => ({
    open: price,
    high: price * 1.002,
    low: price * 0.998,
    close: price,
  }));
}

test("buildMarketContextSnapshotFromInputs — QQQ/SPY/VIX disponibles", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400, 0.003),
    spyCandles: buildTrendCandles(500, 0.0025),
    vixCandles: buildFlatCandles(16, 220),
  });
  assert.ok(snapshot.qqqPrice != null);
  assert.ok(snapshot.spyPrice != null);
  assert.ok(snapshot.vixLevel != null);
  assert.equal(snapshot.qqqTrendLabel, "haussier");
  assert.equal(snapshot.spyTrendLabel, "haussier");
  assert.equal(snapshot.vixRegimeLabel, "normal");
  assert.ok(snapshot.marketRegimeLabel === "favorable" || snapshot.marketRegimeLabel === "neutre");
  assert.ok(!JSON.stringify(snapshot).includes('"ohlcCandles"'));
});

test("buildMarketContextSnapshotFromInputs — snapshot partiel sans VIX", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400, 0.001),
    spyCandles: buildTrendCandles(500, 0.001),
    vixCandles: [],
  });
  assert.ok(snapshot.qqqPrice != null);
  assert.ok(snapshot.spyPrice != null);
  assert.equal(snapshot.vixLevel, null);
  assert.ok(snapshot.missingFields.includes("vixLevel"));
  assert.ok(snapshot.warnings.includes("vix_candles_absentes"));
  assert.equal(snapshot.s5thValue, null);
});

test("deriveMarketRegimeLabel — cas favorables et stress", () => {
  assert.equal(
    deriveMarketRegimeLabel({
      qqqPrice: 110,
      qqqMa50: 100,
      spyPrice: 110,
      spyMa50: 100,
      vixRegimeLabel: "normal",
      vixTrendLabel: "stable",
      breadthLabel: "inconnu",
    }),
    "favorable"
  );
  assert.equal(
    deriveMarketRegimeLabel({
      qqqPrice: 90,
      qqqMa50: 100,
      spyPrice: 90,
      spyMa50: 100,
      vixRegimeLabel: "élevé",
      vixTrendLabel: "en hausse",
      breadthLabel: "inconnu",
    }),
    "stress"
  );
  assert.equal(
    deriveMarketRegimeLabel({
      qqqPrice: 90,
      qqqMa50: 100,
      spyPrice: 110,
      spyMa50: 100,
      vixRegimeLabel: "normal",
      vixTrendLabel: "en hausse",
      breadthLabel: "inconnu",
    }),
    "fragile"
  );
});

test("deriveMarketRiskLabel — reflète le niveau VIX", () => {
  assert.equal(deriveMarketRiskLabel({ vixLevel: 12 }), "calme");
  assert.equal(deriveMarketRiskLabel({ vixLevel: 18 }), "normal");
  assert.equal(deriveMarketRiskLabel({ vixLevel: 25 }), "volatil");
  assert.equal(deriveMarketRiskLabel({ vixLevel: 35 }), "extrême");
});

test("JSON marché sérialise/désérialise correctement", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400),
    spyCandles: buildTrendCandles(500),
    vixCandles: buildFlatCandles(17),
  });
  const raw = JSON.stringify(snapshot);
  const parsed = parseMarketContextSnapshot({ market_context_snapshot_json: raw });
  assert.equal(parsed.qqqPrice, snapshot.qqqPrice);
  assert.equal(parsed.marketRegimeLabel, snapshot.marketRegimeLabel);
});

test("anciens records sans market_context_snapshot_json restent compatibles", () => {
  const enriched = enrichRecordWithMarketContextFields({
    id: "legacy1",
    symbol: "AAPL",
    resolution: { resolved: false },
  });
  assert.equal(enriched.hasMarketContextSnapshot, false);
  assert.equal(enriched.marketContextBadge, "Snapshot absent");
  assert.equal(enriched.marketContextCompletenessPct, 0);
});

test("NaN/undefined normalisés vers null", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: [],
    spyCandles: [],
    vixCandles: [],
  });
  assert.equal(snapshot.qqqPrice, null);
  assert.equal(snapshot.vixLevel, null);
  assert.equal(snapshot.s5thValue, null);
  assert.ok(Array.isArray(snapshot.missingFields));
});

test("présence snapshot marché ne change pas verdicts Objectif 1 % ni Top 20", () => {
  const baseRecords = [
    {
      id: "r1",
      symbol: "AAA",
      expiration: "20260605",
      strikeMode: "safe",
      dteAtScan: 5,
      strike: { strike: 50, premium: 0.5, popEstimate: 0.9 },
      scores: { eliteScore: 80 },
      resolution: { resolved: false },
    },
    {
      id: "r2",
      symbol: "BBB",
      expiration: "20260605",
      strikeMode: "aggressive",
      dteAtScan: 5,
      strike: { strike: 48, premium: 0.7, popEstimate: 0.85 },
      scores: { eliteScore: 75 },
      resolution: { resolved: true, expiredWorthless: true },
    },
  ];
  const marketSnapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400),
    spyCandles: buildTrendCandles(500),
    vixCandles: buildFlatCandles(16),
  });
  const withMarket = baseRecords.map((record) => ({
    ...record,
    marketContextSnapshot: marketSnapshot,
  }));

  const baseProfiles = computeOnePercentWheelProfiles(baseRecords, []);
  const marketProfiles = computeOnePercentWheelProfiles(withMarket, []);
  assert.deepEqual(
    baseProfiles.profiles.map((p) => ({
      ticker: p.ticker,
      verdict: p.onePercentObjective?.verdict,
      score: p.onePercentObjective?.score,
    })),
    marketProfiles.profiles.map((p) => ({
      ticker: p.ticker,
      verdict: p.onePercentObjective?.verdict,
      score: p.onePercentObjective?.score,
    }))
  );

  const baseTop20 = computeDynamicTop20WheelProfiles(baseProfiles.profiles ?? []);
  const marketTop20 = computeDynamicTop20WheelProfiles(marketProfiles.profiles ?? []);
  assert.deepEqual(
    (baseTop20.profiles ?? []).map((p) => p.ticker),
    (marketTop20.profiles ?? []).map((p) => p.ticker)
  );
});

test("snapshot n'inclut pas de candles brutes", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400),
    spyCandles: buildTrendCandles(500),
    vixCandles: buildFlatCandles(16),
  });
  const json = JSON.stringify(snapshot);
  assert.equal(json.includes('"ohlcCandles"'), false);
  assert.equal(json.includes('"quotes"'), false);
  assert.ok(snapshot.candlesUsed.qqq > 0);
  assert.ok(Object.keys(snapshot).every(
    (key) =>
      !Array.isArray(snapshot[key]) ||
      key === "missingFields" ||
      key === "warnings" ||
      key === "fetchDiagnostics"
  ));
});

test("enrichRecordWithMarketContextFields expose les champs backend", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: buildTrendCandles(400),
    spyCandles: buildTrendCandles(500),
    vixCandles: buildFlatCandles(16),
  });
  const enriched = enrichRecordWithMarketContextFields({
    id: "mkt1",
    market_context_snapshot_json: JSON.stringify(snapshot),
  });
  assert.equal(enriched.hasMarketContextSnapshot, true);
  assert.ok(enriched.marketContextSnapshot);
  assert.ok(enriched.marketContextBadge);
  assert.ok(enriched.marketContextCompletenessPct >= 0);
  assert.ok(["favorable", "neutre", "fragile", "stress", "inconnu"].includes(enriched.marketRegimeLabel));
  assert.ok(["calme", "normal", "volatil", "extrême", "inconnu"].includes(enriched.marketRiskLabel));
});

test("buildMarketContextSnapshotFromInputs — fetchDiagnostics exposés si fetch vide", () => {
  const snapshot = buildMarketContextSnapshotFromInputs({
    scanTimestamp: "2026-05-24T15:00:00.000Z",
    qqqCandles: [],
    spyCandles: [],
    vixCandles: [],
    fetchDiagnostics: [
      {
        symbol: "QQQ",
        label: "qqq",
        status: "empty",
        candleCount: 0,
        reason: "yahoo_zero_candle",
      },
      {
        symbol: "^VIX",
        label: "vix",
        status: "empty",
        candleCount: 0,
        reason: "symbole_vix_sans_candles",
      },
    ],
  });
  assert.equal(snapshot.fetchDiagnostics.length, 2);
  assert.ok(snapshot.warnings.includes("fetch_qqq_yahoo_zero_candle"));
  assert.ok(snapshot.warnings.includes("fetch_vix_symbole_vix_sans_candles"));
});

test("deriveVixRegimeLabel et deriveRiskOnOffLabel", () => {
  assert.equal(deriveVixRegimeLabel(14), "bas");
  assert.equal(deriveVixRegimeLabel(32), "extrême");
  assert.equal(
    deriveRiskOnOffLabel({
      qqqPrice: 110,
      qqqMa50: 100,
      spyPrice: 110,
      spyMa50: 100,
      iwmPrice: 110,
      iwmMa50: 100,
      vixRegimeLabel: "bas",
      vixTrendLabel: "stable",
    }),
    "risk_on"
  );
});
