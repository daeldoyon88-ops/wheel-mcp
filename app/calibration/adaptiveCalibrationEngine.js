/**
 * Adaptive Calibration Engine — Phase 4A V0
 *
 * READ-ONLY DIAGNOSTIC. DORMANT MODE.
 *
 * NOT connected to:
 *   - Live scanner
 *   - Shortlist ranking
 *   - EliteScore
 *   - IBKR
 *   - UI main pipeline
 *
 * Reads resolved journal records and computes theoretical calibration
 * recommendations for future use only. Returns diagnostics — does NOT
 * modify any scan decision or record.
 */

function toNum(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const nums = values.map(toNum).filter((v) => v != null);
  if (nums.length === 0) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}

function rate(arr, predicate) {
  if (arr.length === 0) return null;
  return (arr.filter(predicate).length / arr.length) * 100;
}

// ─── Ticker-level statistics ──────────────────────────────────────────────────

function computeTickerStats(ticker, resolvedRecords) {
  const rows = resolvedRecords.filter(
    (r) => String(r?.symbol ?? "").toUpperCase() === String(ticker ?? "").toUpperCase()
  );
  if (rows.length === 0) return null;

  const safeRows = rows.filter((r) => r?.strikeMode === "safe");
  const aggRows = rows.filter((r) => r?.strikeMode === "aggressive");

  const safeWinRate = rate(safeRows, (r) => r?.resolution?.popPredictionCorrect === true);
  const aggWinRate = rate(aggRows, (r) => r?.resolution?.popPredictionCorrect === true);
  const avgDrawdown = avg(rows.map((r) => r?.resolution?.drawdownPct));
  const avgFalseSafetyRate = rate(rows, (r) => r?.resolution?.false_safety_flag === true);
  const avgStrikeTouchRate = rate(rows, (r) => r?.resolution?.strikeTouched === true);
  const avgAssignmentRate = rate(rows, (r) => r?.resolution?.assigned === true);
  const avgDqs = avg(rows.map((r) => r?.stress?.data_quality_score));

  return {
    ticker,
    sample_size: rows.length,
    safe_sample_size: safeRows.length,
    aggressive_sample_size: aggRows.length,
    safe_win_rate: safeWinRate,
    aggressive_win_rate: aggWinRate,
    avg_drawdown: avgDrawdown != null ? Number(avgDrawdown.toFixed(4)) : null,
    avg_false_safety_rate: avgFalseSafetyRate,
    avg_strike_touch_rate: avgStrikeTouchRate,
    avg_assignment_rate: avgAssignmentRate,
    seasonality_correlation_score: null,
    data_quality_score: avgDqs != null ? Number(avgDqs.toFixed(2)) : null,
  };
}

// ─── Market regime statistics ─────────────────────────────────────────────────

function computeRegimeStats(regime, resolvedRecords) {
  const rows = resolvedRecords.filter(
    (r) => String(r?.market_regime ?? r?.marketRegime ?? "").toLowerCase() ===
           String(regime ?? "").toLowerCase()
  );
  if (rows.length === 0) return null;

  const safeRows = rows.filter((r) => r?.strikeMode === "safe");
  const aggRows = rows.filter((r) => r?.strikeMode === "aggressive");

  const safeWinRate = rate(safeRows, (r) => r?.resolution?.popPredictionCorrect === true);
  const aggWinRate = rate(aggRows, (r) => r?.resolution?.popPredictionCorrect === true);
  const avgDrawdown = avg(rows.map((r) => r?.resolution?.drawdownPct));

  return {
    market_regime: regime,
    sample_size: rows.length,
    safe_performance: safeWinRate,
    aggressive_performance: aggWinRate,
    drawdown_profile: avgDrawdown != null ? Number(avgDrawdown.toFixed(4)) : null,
  };
}

// ─── Theoretical recommendation (NOT live, NOT applied) ──────────────────────

function buildRecommendation(tickerStats, seasonalityContext, marketRegimeStats) {
  if (!tickerStats || tickerStats.sample_size < 5) {
    return {
      recommended_mode: null,
      recommended_pop_min: null,
      recommended_strike_adjustment: null,
      ticker_penalty_score: null,
      seasonality_weight: null,
      confidence_score: null,
      confidence_reason: "insufficient_sample_size",
      diagnostic: "Need at least 5 resolved records for calibration recommendation.",
    };
  }

  const safeWr = toNum(tickerStats.safe_win_rate) ?? 100;
  const aggWr = toNum(tickerStats.aggressive_win_rate) ?? 100;
  const touchRate = toNum(tickerStats.avg_strike_touch_rate) ?? 0;
  const falseSafetyRate = toNum(tickerStats.avg_false_safety_rate) ?? 0;
  const drawdown = toNum(tickerStats.avg_drawdown) ?? 0;

  // Recommended mode: safe if aggressive underperforms by >10pp, else maintain
  let recommendedMode = "maintain";
  if (aggWr < safeWr - 10) recommendedMode = "prefer_safe";
  else if (safeWr >= 95 && aggWr >= 90) recommendedMode = "both_viable";

  // Recommended POP min: raise if touch rate is high
  let recommendedPopMin = 85;
  if (touchRate > 40) recommendedPopMin = 92;
  else if (touchRate > 25) recommendedPopMin = 88;

  // Strike adjustment: tighten if false safety flag is common
  let recommendedStrikeAdjustment = "none";
  if (falseSafetyRate > 20) recommendedStrikeAdjustment = "tighten_to_lowerBound";
  else if (touchRate > 40) recommendedStrikeAdjustment = "tighten_one_strike";

  // Ticker penalty score: 0 = excellent, 100 = worst
  let tickerPenalty = 0;
  if (safeWr < 80) tickerPenalty += 30;
  else if (safeWr < 90) tickerPenalty += 10;
  if (touchRate > 40) tickerPenalty += 25;
  else if (touchRate > 25) tickerPenalty += 10;
  if (falseSafetyRate > 20) tickerPenalty += 20;
  if (drawdown > 15) tickerPenalty += 15;

  // Seasonality weight (placeholder — feeds from seasonalityContext when available)
  const seasonalityWeight = seasonalityContext?.seasonality_score_at_scan != null
    ? Math.min(1, Math.max(0, Number(seasonalityContext.seasonality_score_at_scan) / 100))
    : null;

  // Confidence: higher with more samples and good data quality
  const sampleConfidence = Math.min(1, tickerStats.sample_size / 30);
  const dqsConfidence = toNum(tickerStats.data_quality_score) != null
    ? toNum(tickerStats.data_quality_score) / 100
    : 0.5;
  const confidenceScore = Number(((sampleConfidence * 0.6 + dqsConfidence * 0.4) * 100).toFixed(1));

  const marketPressure = marketRegimeStats
    ? `${marketRegimeStats.market_regime} (safe=${marketRegimeStats.safe_performance?.toFixed(1)}% / agg=${marketRegimeStats.aggressive_performance?.toFixed(1)}%)`
    : "regime_unknown";

  return {
    recommended_mode: recommendedMode,
    recommended_pop_min: recommendedPopMin,
    recommended_strike_adjustment: recommendedStrikeAdjustment,
    ticker_penalty_score: Math.min(100, tickerPenalty),
    seasonality_weight: seasonalityWeight,
    confidence_score: confidenceScore,
    confidence_reason: confidenceScore >= 60 ? "adequate_sample" : "low_sample_or_data_quality",
    market_context: marketPressure,
    diagnostic: `Based on ${tickerStats.sample_size} resolved trades. Mode: ${recommendedMode}. Touch rate: ${touchRate.toFixed(1)}%.`,
  };
}

// ─── Public factory ───────────────────────────────────────────────────────────

export function createAdaptiveCalibrationEngine(options = {}) {
  const store = options.store ?? null;

  // Load resolved records from store — read only
  async function loadResolvedRecords() {
    if (!store) return [];
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    return records.filter((r) => r?.resolution?.resolved === true);
  }

  // Per-ticker diagnostic (read-only)
  async function computeTickerDiagnostic(ticker) {
    const resolved = await loadResolvedRecords();
    return computeTickerStats(ticker, resolved);
  }

  // Portfolio-wide diagnostic — top tickers by sample size
  async function computePortfolioDiagnostic() {
    const resolved = await loadResolvedRecords();
    const tickers = [...new Set(resolved.map((r) => String(r?.symbol ?? "")).filter(Boolean))];
    const stats = tickers
      .map((t) => computeTickerStats(t, resolved))
      .filter((s) => s != null && s.sample_size >= 3)
      .sort((a, b) => b.sample_size - a.sample_size)
      .slice(0, 30);

    const overall = {
      total_resolved: resolved.length,
      tickers_with_data: stats.length,
      avg_safe_win_rate: avg(stats.map((s) => s.safe_win_rate)),
      avg_aggressive_win_rate: avg(stats.map((s) => s.aggressive_win_rate)),
      avg_drawdown: avg(stats.map((s) => s.avg_drawdown)),
      avg_strike_touch_rate: avg(stats.map((s) => s.avg_strike_touch_rate)),
      avg_false_safety_rate: avg(stats.map((s) => s.avg_false_safety_rate)),
    };

    return { overall, tickerStats: stats };
  }

  // Theoretical recommendation for a ticker (NOT applied to scanner)
  async function computeRecommendation(ticker, marketRegime, seasonalityContext) {
    const resolved = await loadResolvedRecords();
    const tickerStats = computeTickerStats(ticker, resolved);
    const regimeStats = marketRegime ? computeRegimeStats(marketRegime, resolved) : null;
    return buildRecommendation(tickerStats, seasonalityContext, regimeStats);
  }

  // Compute all ticker summaries and optionally persist to calibration_ticker_summary
  async function computeAndPersistTickerSummary() {
    const resolved = await loadResolvedRecords();
    const tickers = [...new Set(resolved.map((r) => String(r?.symbol ?? "")).filter(Boolean))];
    const nowIso = new Date().toISOString();
    const results = [];

    for (const ticker of tickers) {
      const stats = computeTickerStats(ticker, resolved);
      if (!stats || stats.sample_size < 3) continue;
      const summary = { ...stats, computed_at: nowIso };
      if (store?.upsertCalibrationTickerSummary) {
        await store.upsertCalibrationTickerSummary(summary);
      }
      results.push(summary);
    }
    return results;
  }

  // Compute regime summaries and optionally persist to calibration_market_regime_summary
  async function computeAndPersistMarketRegimeSummary() {
    const resolved = await loadResolvedRecords();
    const regimes = [...new Set(
      resolved.map((r) => r?.market_regime ?? r?.marketRegime ?? null).filter(Boolean)
    )];
    const nowIso = new Date().toISOString();
    const results = [];

    for (const regime of regimes) {
      const stats = computeRegimeStats(regime, resolved);
      if (!stats || stats.sample_size < 3) continue;
      const summary = { ...stats, computed_at: nowIso };
      if (store?.upsertCalibrationMarketRegimeSummary) {
        await store.upsertCalibrationMarketRegimeSummary(summary);
      }
      results.push(summary);
    }
    return results;
  }

  return {
    computeTickerDiagnostic,
    computePortfolioDiagnostic,
    computeRecommendation,
    computeAndPersistTickerSummary,
    computeAndPersistMarketRegimeSummary,
  };
}
