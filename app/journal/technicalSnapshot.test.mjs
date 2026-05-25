import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTechnicalSnapshot,
  computeAtr,
  computeMacd,
  computeRealizedVol,
  computeRsi,
  enrichRecordWithTechnicalSnapshotFields,
  parseTechnicalSnapshot,
  TRACKED_FIELDS,
} from "./technicalSnapshot.js";
import { computeOnePercentWheelProfiles, computeDynamicTop20WheelProfiles } from "./wheelValidationService.js";

function buildSyntheticCandles(count, startPrice = 100, drift = 0.002, volatility = 0.015) {
  const candles = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    const change = (Math.sin(i / 3) + Math.cos(i / 7)) * volatility;
    price = Math.max(1, price * (1 + drift + change));
    const high = price * (1 + Math.abs(volatility) * 0.6);
    const low = price * (1 - Math.abs(volatility) * 0.6);
    candles.push({
      date: `2025-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      open,
      high,
      low,
      close: price,
      volume: 1_000_000 + i * 10_000,
    });
  }
  return candles;
}

function buildCandidateWithCandles(candleCount = 220) {
  const ohlcCandles = buildSyntheticCandles(candleCount);
  return {
    symbol: "TEST",
    currentPrice: ohlcCandles[ohlcCandles.length - 1].close,
    ohlcCandles,
    technicals: { rsi: null, trend: "unknown" },
    diagnosticsV12: { volumeVsAvgRatio: 1.15, dailyChangePct: 0.42 },
  };
}

test("RSI se calcule sans erreur avec assez de candles", () => {
  const closes = buildSyntheticCandles(40).map((c) => c.close);
  const rsi14 = computeRsi(closes, 14);
  const rsi7 = computeRsi(closes, 7);
  assert.ok(rsi14 != null);
  assert.ok(rsi7 != null);
  assert.ok(rsi14 >= 0 && rsi14 <= 100);
});

test("MACD se calcule sans erreur avec assez de candles", () => {
  const closes = buildSyntheticCandles(60).map((c) => c.close);
  const macd = computeMacd(closes);
  assert.ok(macd);
  assert.ok(macd.macd != null);
  assert.ok(macd.macdSignal != null);
  assert.ok(macd.macdHistogram != null);
  assert.equal(typeof macd.macdBullish, "boolean");
});

test("MA8/34/50/200 se calculent si assez de données", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: buildCandidateWithCandles(220),
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  assert.ok(snapshot.ma8 != null);
  assert.ok(snapshot.ma34 != null);
  assert.ok(snapshot.ma50 != null);
  assert.ok(snapshot.ma200 != null);
});

test("ATR14 se calcule", () => {
  const candles = buildSyntheticCandles(30);
  const atr = computeAtr(candles, 14);
  assert.ok(atr != null);
  assert.ok(atr > 0);
});

test("snapshot partiel fonctionne avec seulement 30 candles", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: buildCandidateWithCandles(30),
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  assert.ok(snapshot.rsi14 != null);
  assert.ok(snapshot.ma21 != null);
  assert.equal(snapshot.ma50, null);
  assert.equal(snapshot.ma200, null);
  assert.ok(Array.isArray(snapshot.missingFields));
  assert.ok(snapshot.missingFields.includes("ma200"));
  assert.ok(["partial", "calculated"].includes(snapshot.dataConfidence));
});

test("snapshot sans assez de données retourne missingFields sans crash", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: { symbol: "EMPTY", currentPrice: 10 },
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  assert.equal(snapshot.dataConfidence, "missing");
  assert.ok(snapshot.missingFields.length > 0);
  assert.equal(snapshot.rsi14, null);
  assert.equal(snapshot.macd, null);
});

test("JSON technique sérialise/désérialise correctement", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: buildCandidateWithCandles(80),
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  const json = JSON.stringify(snapshot);
  const parsed = parseTechnicalSnapshot({ technical_snapshot_json: json });
  assert.equal(parsed.ticker, "TEST");
  assert.equal(parsed.realizedVolConvention, "annualized_log_returns_sqrt252");
  assert.ok(parsed.rsi14 != null);
});

test("anciens records sans technical_snapshot_json restent compatibles", () => {
  const enriched = enrichRecordWithTechnicalSnapshotFields({
    id: "legacy",
    symbol: "OLD",
    optionQuoteSnapshot: { ticker: "OLD" },
  });
  assert.equal(enriched.hasTechnicalSnapshot, false);
  assert.equal(enriched.technicalDataBadge, "Snapshot absent");
  assert.equal(enriched.technicalDataCompletenessPct, 0);
});

test("JSON snapshot invalide ne plante pas", () => {
  const enriched = enrichRecordWithTechnicalSnapshotFields({
    id: "broken",
    technical_snapshot_json: "{not-json",
  });
  assert.equal(enriched.technicalSnapshotStorageStatus, "snapshot_parse_failed");
  assert.equal(enriched.technicalDataBadge, "Snapshot invalide");
});

test("realizedVol20 est annualisée (convention documentée)", () => {
  const closes = buildSyntheticCandles(40).map((c) => c.close);
  const rv20 = computeRealizedVol(closes, 20);
  assert.ok(rv20 != null);
  assert.ok(rv20 > 0 && rv20 < 5);
});

test("NaN/undefined normalisés vers null dans le snapshot", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: { symbol: "NAN", currentPrice: Number.NaN },
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  assert.equal(snapshot.priceAtScan, null);
  for (const key of TRACKED_FIELDS) {
    const value = snapshot[key];
    if (value != null) {
      assert.ok(!Number.isNaN(value));
    }
  }
});

test("présence snapshot technique ne change pas verdicts Objectif 1 % ni Top 20", () => {
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
  const withTech = baseRecords.map((record) => ({
    ...record,
    technicalSnapshot: buildTechnicalSnapshot({
      candidate: buildCandidateWithCandles(80),
      scanTimestamp: "2026-05-24T15:00:00.000Z",
    }),
  }));

  const baseProfiles = computeOnePercentWheelProfiles(baseRecords, []);
  const techProfiles = computeOnePercentWheelProfiles(withTech, []);
  assert.deepEqual(
    baseProfiles.profiles.map((p) => ({
      ticker: p.ticker,
      verdict: p.onePercentObjective?.verdict,
      score: p.onePercentObjective?.score,
    })),
    techProfiles.profiles.map((p) => ({
      ticker: p.ticker,
      verdict: p.onePercentObjective?.verdict,
      score: p.onePercentObjective?.score,
    }))
  );

  const baseTop20 = computeDynamicTop20WheelProfiles(baseProfiles.profiles ?? []);
  const techTop20 = computeDynamicTop20WheelProfiles(techProfiles.profiles ?? []);
  assert.deepEqual(
    (baseTop20.profiles ?? []).map((p) => p.ticker),
    (techTop20.profiles ?? []).map((p) => p.ticker)
  );
});

test("enrichRecordWithTechnicalSnapshotFields expose les champs backend", () => {
  const snapshot = buildTechnicalSnapshot({
    candidate: buildCandidateWithCandles(100),
    scanTimestamp: "2026-05-24T15:00:00.000Z",
  });
  const enriched = enrichRecordWithTechnicalSnapshotFields({
    id: "tech1",
    technical_snapshot_json: JSON.stringify(snapshot),
  });
  assert.equal(enriched.hasTechnicalSnapshot, true);
  assert.ok(enriched.technicalSnapshot);
  assert.ok(enriched.technicalDataBadge);
  assert.ok(enriched.technicalDataCompletenessPct >= 0);
  assert.ok(Array.isArray(enriched.technicalDataMissingFields));
  assert.ok(["haussier", "neutre", "baissier", "inconnu"].includes(enriched.technicalTrendLabel));
});
