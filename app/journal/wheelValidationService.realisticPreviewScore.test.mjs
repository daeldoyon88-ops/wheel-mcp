import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRealisticPreviewScore,
  computeRealisticDecisionMetrics,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "./wheelValidationService.js";

let __idSeq = 0;
function rec({
  ticker = "TEST",
  expiration = "2025-01-10",
  mode = "safe",
  dte = 7,
  strike = 100,
  premium = 1,
  assigned = false,
  close = null,
  resolved = true,
  captureClass = "primaryDaily",
  id = null,
} = {}) {
  __idSeq += 1;
  const resolution = {
    resolved,
    assigned_flag: assigned,
    expiredWorthless: assigned ? false : true,
  };
  if (close != null) resolution.underlying_close_at_expiration = close;
  return {
    id: id ?? `id-${String(__idSeq).padStart(4, "0")}`,
    symbol: ticker,
    selectedExpiration: expiration,
    strikeMode: mode,
    dteAtScan: dte,
    strike: { strike, premium },
    captureClass,
    resolution,
  };
}

test("computeRealisticPreviewScore — pénalité duplication élevée", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 80,
    assignmentRate: 20,
    realisticDecisionMetrics: {
      selectedTradeCount: 5,
      duplicationRatio: 6,
      selectedAssignmentRatePct: 20,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.7,
      selectedWinRatePct: 80,
    },
  });
  assert.equal(preview.baseScore, 80);
  assert.equal(preview.score, 70);
  assert.ok(preview.penalties.some((p) => p.reason === "duplication élevée"));
  assert.equal(preview.previewOnly, true);
});

test("computeRealisticPreviewScore — bonus assignation réelle inférieure", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 65,
    assignmentRate: 20,
    realisticDecisionMetrics: {
      selectedTradeCount: 6,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 10,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.9,
      selectedWinRatePct: 90,
    },
  });
  assert.ok(preview.score > preview.baseScore);
  assert.ok(preview.bonuses.some((b) => b.reason === "assignation réelle inférieure"));
  assert.ok(preview.bonuses.some((b) => b.reason === "win rate réel élevé"));
});

test("computeRealisticPreviewScore — échantillon faible baisse confiance", () => {
  const preview = computeRealisticPreviewScore({
    dynamicTop20Score: 70,
    assignmentRate: 10,
    realisticDecisionMetrics: {
      selectedTradeCount: 3,
      duplicationRatio: 2,
      selectedAssignmentRatePct: 0,
      selectedDeepAssignmentRatePct: 0,
      selectedAvgCspYieldPct: 0.8,
      selectedWinRatePct: 100,
    },
  });
  assert.equal(preview.confidence, "low");
  assert.ok(preview.penalties.some((p) => p.reason === "échantillon faible"));
});

test("additivité — realisticPreview présent sans modifier dynamicTop20Score ni le tri", () => {
  const records = [];
  const tickers = ["AAA", "BBB", "CCC", "DDD", "EEE"];
  for (const t of tickers) {
    for (let e = 0; e < 6; e += 1) {
      const expiration = `2025-02-0${e + 1}`;
      records.push(
        rec({ ticker: t, expiration, mode: "safe", assigned: e === 0, close: e === 0 ? 99.5 : null, premium: 1.0 }),
      );
      records.push(rec({ ticker: t, expiration, mode: "aggressive", assigned: false, premium: 1.2 }));
    }
  }

  const { profiles } = computeOnePercentWheelProfiles(records, [], { today: "2026-01-01" });
  const withPreview = computeDynamicTop20WheelProfiles(profiles, { today: "2026-01-01" });

  const stripped = profiles.map((p) => {
    const { realisticDecisionMetrics, ...rest } = p;
    void realisticDecisionMetrics;
    return rest;
  });
  const withoutRdm = computeDynamicTop20WheelProfiles(stripped, { today: "2026-01-01" });

  const order = (res) =>
    [...res.top20, ...res.nearEntry, ...res.watchValidate, ...res.insufficientSample].map((r) => ({
      ticker: r.ticker,
      score: r.dynamicTop20Score,
      status: r.dynamicTop20Status,
      rank: r.rank,
    }));

  assert.deepEqual(order(withPreview), order(withoutRdm));

  const top20Row = withPreview.top20?.[0];
  if (top20Row) {
    assert.ok("realisticPreview" in top20Row);
    assert.ok("realisticPreviewRank" in top20Row);
    assert.equal(top20Row.dynamicTop20Score, order(withoutRdm).find((r) => r.ticker === top20Row.ticker)?.score);
  }
});

test("realisticPreviewRank — ordre simulé distinct du rang officiel possible", () => {
  const rows = [
    {
      ticker: "HIGH",
      rank: 1,
      n: 50,
      dynamicTop20Score: 90,
      assignmentRate: 5,
      realisticDecisionMetrics: {
        selectedTradeCount: 5,
        duplicationRatio: 6,
        selectedAssignmentRatePct: 20,
        selectedDeepAssignmentRatePct: 45,
        selectedAvgCspYieldPct: 0.7,
        selectedWinRatePct: 80,
      },
    },
    {
      ticker: "LOW",
      rank: 2,
      n: 40,
      dynamicTop20Score: 70,
      assignmentRate: 15,
      realisticDecisionMetrics: {
        selectedTradeCount: 8,
        duplicationRatio: 2,
        selectedAssignmentRatePct: 10,
        selectedDeepAssignmentRatePct: 0,
        selectedAvgCspYieldPct: 1.0,
        selectedWinRatePct: 95,
      },
    },
  ];

  for (const row of rows) {
    row.realisticPreview = computeRealisticPreviewScore(row);
  }

  const rankable = rows
    .slice()
    .sort((a, b) => (b.realisticPreview.score ?? 0) - (a.realisticPreview.score ?? 0));
  rankable.forEach((row, i) => {
    row.realisticPreviewRank = i + 1;
  });

  const high = rows.find((r) => r.ticker === "HIGH");
  const low = rows.find((r) => r.ticker === "LOW");
  assert.ok(low.realisticPreview.score > high.realisticPreview.score);
  assert.equal(low.realisticPreviewRank, 1);
  assert.equal(high.realisticPreviewRank, 2);
});

test("computeRealisticDecisionMetrics reste indépendant du preview score", () => {
  const records = [rec({ premium: 1.0 }), rec({ premium: 1.1 })];
  const m1 = computeRealisticDecisionMetrics(records);
  const m2 = computeRealisticDecisionMetrics(records);
  assert.deepEqual(m1, m2);
  void computeRealisticPreviewScore({
    dynamicTop20Score: 50,
    assignmentRate: 10,
    realisticDecisionMetrics: m1,
  });
});
