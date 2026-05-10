import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_JSON_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.json");
const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

function createEmptyJournal() {
  return {
    version: "1.0",
    updatedAt: null,
    records: [],
  };
}

function toIntBool(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  return null;
}

function toInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toReal(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeExec(conn, sql) {
  try {
    conn.exec(sql);
  } catch (_) {
    // Idempotent: ignore errors (e.g. column already exists)
  }
}

function normalizeRecordToRow(record, nowIso = new Date().toISOString()) {
  const source = record?.source ?? {};
  const ranks = record?.ranks ?? {};
  const scores = record?.scores ?? {};
  const underlying = record?.underlying ?? {};
  const strike = record?.strike ?? {};
  const context = record?.context ?? {};
  const resolution = record?.resolution ?? {};
  return {
    id: String(record?.id ?? "").trim(),
    scanSessionId: record?.scanSessionId ?? null,
    scanTimestamp: record?.scanTimestamp ?? null,
    scanDate: record?.scanDate ?? null,
    selectedExpiration: record?.selectedExpiration ?? null,
    expiration: record?.expiration ?? null,
    expirationCohort: record?.expirationCohort ?? null,
    dteAtScan: toInt(record?.dteAtScan),
    candidateRank: toInt(record?.candidateRank),
    captureSource: record?.captureSource ?? null,
    captureClass: record?.captureClass ?? null,
    symbol: record?.symbol ?? null,
    strikeMode: record?.strikeMode ?? null,
    yahooValidated: toIntBool(source?.yahoo),
    ibkrValidated: toIntBool(source?.ibkrValidated),
    yahooRank: toInt(ranks?.yahooRank),
    ibkrRank: toInt(ranks?.ibkrRank),
    qualityScoreYahoo: toReal(scores?.qualityScoreYahoo),
    finalScoreYahoo: toReal(scores?.finalScoreYahoo),
    eliteScore: toReal(scores?.eliteScore),
    eliteBadge: scores?.eliteBadge ?? null,
    spotAtScan: toReal(underlying?.spotAtScan),
    expectedMove: toReal(underlying?.expectedMove),
    lowerBound: toReal(underlying?.lowerBound),
    strike: toReal(strike?.strike),
    premium: toReal(strike?.premium),
    bid: toReal(strike?.bid),
    ask: toReal(strike?.ask),
    mid: toReal(strike?.mid),
    spread: toReal(strike?.spread),
    spreadPct: toReal(strike?.spreadPct),
    annualizedYield: toReal(strike?.annualizedYield),
    targetPremium: toReal(strike?.targetPremium),
    popEstimate: toReal(strike?.popEstimate),
    support: toReal(context?.support),
    resistance: toReal(context?.resistance),
    supportStatus: context?.supportStatus ?? null,
    hasEarningsBeforeExpiration: toIntBool(context?.hasEarningsBeforeExpiration),
    earningsDate: context?.earningsDate ?? null,
    earningsDaysUntil: toInt(context?.earningsDaysUntil),
    rsi: toReal(context?.rsi),
    resolved: toIntBool(resolution?.resolved),
    expirationClosePrice: toReal(resolution?.expirationClosePrice),
    expiredWorthless: toIntBool(resolution?.expiredWorthless),
    assigned: toIntBool(resolution?.assigned),
    strikeTouched: toIntBool(resolution?.strikeTouched),
    minPriceBetweenScanAndExpiration: toReal(resolution?.minPriceBetweenScanAndExpiration),
    brokeLowerBound: toIntBool(resolution?.brokeLowerBound),
    maxItmDepth: toReal(resolution?.maxItmDepth),
    lowerBoundDistance: toReal(resolution?.lowerBoundDistance),
    supportBreak: toIntBool(resolution?.supportBreak),
    drawdownPct: toReal(resolution?.drawdownPct),
    rolled: toIntBool(resolution?.rolled),
    realizedPl: toReal(resolution?.realizedPl),
    premiumRealized: toReal(resolution?.premiumRealized),
    realizedReturnPct: toReal(resolution?.realizedReturnPct),
    popPredictionCorrect: toIntBool(resolution?.popPredictionCorrect),
    outcomeStatus: resolution?.outcomeStatus ?? null,
    resultStatus: resolution?.resultStatus ?? null,
    resolvedAt: resolution?.resolvedAt ?? null,
    resolutionDate: resolution?.resolutionDate ?? null,
    notes: resolution?.notes ?? null,
    // Phase 1 — Data Integrity
    trade_signature: record?.trade_signature ?? null,
    duplicate_candidate_flag: toIntBool(record?.duplicate_candidate_flag),
    resolution_confidence: resolution?.resolution_confidence ?? null,
    resolved_source: resolution?.resolved_source ?? null,
    missing_close_flag: toIntBool(resolution?.missing_close_flag),
    stale_quote_flag: toIntBool(record?.stale_quote_flag),
    // Phase 2 — Raw Outcome
    underlying_close_at_expiration: toReal(resolution?.underlying_close_at_expiration),
    underlying_low_between_scan_and_expiration: toReal(resolution?.underlying_low_between_scan_and_expiration),
    underlying_high_between_scan_and_expiration: toReal(resolution?.underlying_high_between_scan_and_expiration),
    expired_otm: toIntBool(resolution?.expired_otm),
    expired_itm: toIntBool(resolution?.expired_itm),
    assigned_flag: toIntBool(resolution?.assigned_flag),
    intrinsic_value_at_expiration: toReal(resolution?.intrinsic_value_at_expiration),
    option_final_value: toReal(resolution?.option_final_value),
    days_held: toInt(resolution?.days_held),
    // Phase 2 — Snapshot au scan
    underlying_price_at_scan: toReal(record?.snapshot?.underlying_price_at_scan),
    distance_strike_from_spot_pct: toReal(record?.snapshot?.distance_strike_from_spot_pct),
    distance_lower_bound_from_spot_pct: toReal(record?.snapshot?.distance_lower_bound_from_spot_pct),
    premium_to_spot_pct: toReal(record?.snapshot?.premium_to_spot_pct),
    // Phase 3 — Stress Metrics (scan-time)
    stress_score: toReal(record?.stress?.stress_score),
    premium_efficiency: toReal(record?.stress?.premium_efficiency),
    risk_adjusted_return: toReal(record?.stress?.risk_adjusted_return),
    strike_safety_margin: toReal(record?.stress?.strike_safety_margin),
    strike_safety_margin_pct: toReal(record?.stress?.strike_safety_margin_pct),
    data_quality_score: toReal(record?.stress?.data_quality_score),
    // Phase 3 — Stress Metrics (resolution-time)
    false_safety_flag: toIntBool(resolution?.false_safety_flag),
    strike_touch_recovery_flag: toIntBool(resolution?.strike_touch_recovery_flag),
    max_itm_depth_pct: toReal(resolution?.max_itm_depth_pct),
    lower_bound_distance_pct: toReal(resolution?.lower_bound_distance_pct),
    support_break_severity: toReal(resolution?.support_break_severity),
    // Phase 4A.1 — Seasonality snapshot
    seasonality_score_at_scan: toReal(record?.seasonality?.seasonality_score_at_scan),
    seasonality_win_rate_at_scan: toReal(record?.seasonality?.seasonality_win_rate_at_scan),
    seasonality_best_window_start: record?.seasonality?.seasonality_best_window_start ?? null,
    seasonality_best_window_end: record?.seasonality?.seasonality_best_window_end ?? null,
    seasonality_direction: record?.seasonality?.seasonality_direction ?? null,
    seasonality_confidence: record?.seasonality?.seasonality_confidence ?? null,
    seasonality_snapshot_version: record?.seasonality?.seasonality_snapshot_version ?? null,
    // Phase 4A.3 — Earnings / Event Risk
    days_to_earnings: toInt(record?.eventRisk?.days_to_earnings),
    earnings_risk_flag: toIntBool(record?.eventRisk?.earnings_risk_flag),
    macro_event_risk_flag: toIntBool(record?.eventRisk?.macro_event_risk_flag),
    fed_event_risk_flag: toIntBool(record?.eventRisk?.fed_event_risk_flag),
    event_risk_score: toReal(record?.eventRisk?.event_risk_score),
    // Phase 4A.4 — IV / Liquidity / Options Quality
    iv_rank_at_scan: toReal(record?.ivSnapshot?.iv_rank_at_scan),
    iv_percentile_at_scan: toReal(record?.ivSnapshot?.iv_percentile_at_scan),
    option_spread_pct_at_scan: toReal(record?.ivSnapshot?.option_spread_pct_at_scan),
    open_interest_at_scan: toInt(record?.ivSnapshot?.open_interest_at_scan),
    volume_at_scan: toInt(record?.ivSnapshot?.volume_at_scan),
    liquidity_score: toReal(record?.ivSnapshot?.liquidity_score),
    options_quality_score: toReal(record?.ivSnapshot?.options_quality_score),
    rawJson: JSON.stringify(record ?? {}),
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

export function createWheelValidationStoreSqlite(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const jsonPath = options.jsonPath ?? DEFAULT_JSON_PATH;
  let db = null;
  let initialized = false;

  async function ensureParentDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  function ensureDbSync() {
    if (db) return db;
    db = new DatabaseSync(sqlitePath);
    return db;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await ensureParentDir(sqlitePath);
    const conn = ensureDbSync();
    conn.exec(`
      CREATE TABLE IF NOT EXISTS wheel_validation_records (
        id TEXT PRIMARY KEY,
        scanSessionId TEXT,
        scanTimestamp TEXT,
        scanDate TEXT,
        selectedExpiration TEXT,
        expiration TEXT,
        expirationCohort TEXT,
        dteAtScan INTEGER,
        candidateRank INTEGER,
        captureSource TEXT,
        captureClass TEXT,
        symbol TEXT,
        strikeMode TEXT,
        yahooValidated INTEGER,
        ibkrValidated INTEGER,
        yahooRank INTEGER,
        ibkrRank INTEGER,
        qualityScoreYahoo REAL,
        finalScoreYahoo REAL,
        eliteScore REAL,
        eliteBadge TEXT,
        spotAtScan REAL,
        expectedMove REAL,
        lowerBound REAL,
        strike REAL,
        premium REAL,
        bid REAL,
        ask REAL,
        mid REAL,
        spread REAL,
        spreadPct REAL,
        annualizedYield REAL,
        targetPremium REAL,
        popEstimate REAL,
        support REAL,
        resistance REAL,
        supportStatus TEXT,
        hasEarningsBeforeExpiration INTEGER,
        earningsDate TEXT,
        earningsDaysUntil INTEGER,
        rsi REAL,
        resolved INTEGER,
        expirationClosePrice REAL,
        expiredWorthless INTEGER,
        assigned INTEGER,
        strikeTouched INTEGER,
        minPriceBetweenScanAndExpiration REAL,
        brokeLowerBound INTEGER,
        maxItmDepth REAL,
        lowerBoundDistance REAL,
        supportBreak INTEGER,
        drawdownPct REAL,
        rolled INTEGER,
        realizedPl REAL,
        premiumRealized REAL,
        realizedReturnPct REAL,
        popPredictionCorrect INTEGER,
        outcomeStatus TEXT,
        resultStatus TEXT,
        resolvedAt TEXT,
        resolutionDate TEXT,
        notes TEXT,
        rawJson TEXT,
        createdAt TEXT,
        updatedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_wvr_symbol ON wheel_validation_records(symbol);
      CREATE INDEX IF NOT EXISTS idx_wvr_expiration ON wheel_validation_records(expiration);
      CREATE INDEX IF NOT EXISTS idx_wvr_expirationCohort ON wheel_validation_records(expirationCohort);
      CREATE INDEX IF NOT EXISTS idx_wvr_dteAtScan ON wheel_validation_records(dteAtScan);
      CREATE INDEX IF NOT EXISTS idx_wvr_resolved ON wheel_validation_records(resolved);
      CREATE INDEX IF NOT EXISTS idx_wvr_strikeMode ON wheel_validation_records(strikeMode);
      CREATE INDEX IF NOT EXISTS idx_wvr_eliteBadge ON wheel_validation_records(eliteBadge);
      CREATE INDEX IF NOT EXISTS idx_wvr_scanDate ON wheel_validation_records(scanDate);
      CREATE INDEX IF NOT EXISTS idx_wvr_scanSessionId ON wheel_validation_records(scanSessionId);
    `);

    // Additive migrations — idempotent, safe for existing databases
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN captureClass TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN strikeTouched INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN minPriceBetweenScanAndExpiration REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN brokeLowerBound INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN maxItmDepth REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN lowerBoundDistance REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN supportBreak INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN drawdownPct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN realizedReturnPct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN resultStatus TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN resolvedAt TEXT`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_wvr_captureClass ON wheel_validation_records(captureClass)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_wvr_resultStatus ON wheel_validation_records(resultStatus)`);

    // Phase 1 — Data Integrity / Resolution Safety
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN trade_signature TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN duplicate_candidate_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN resolution_confidence TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN resolved_source TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN missing_close_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN stale_quote_flag INTEGER`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_wvr_trade_signature ON wheel_validation_records(trade_signature)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_wvr_duplicate_flag ON wheel_validation_records(duplicate_candidate_flag)`);

    // Phase 2 — Raw Outcome + Snapshot au scan
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN underlying_close_at_expiration REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN underlying_low_between_scan_and_expiration REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN underlying_high_between_scan_and_expiration REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN expired_otm INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN expired_itm INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN assigned_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN intrinsic_value_at_expiration REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN option_final_value REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN days_held INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN underlying_price_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN distance_strike_from_spot_pct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN distance_lower_bound_from_spot_pct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN premium_to_spot_pct REAL`);

    // Phase 3 — Stress Metrics
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN stress_score REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN premium_efficiency REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN risk_adjusted_return REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN strike_safety_margin REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN strike_safety_margin_pct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN false_safety_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN strike_touch_recovery_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN max_itm_depth_pct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN lower_bound_distance_pct REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN support_break_severity REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN data_quality_score REAL`);

    // Phase 3 — Market Context Snapshot table (V0 read-only structure)
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS market_context_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_id TEXT,
        scan_date TEXT,
        ticker TEXT,
        expiration TEXT,
        spy_price REAL,
        spy_ma50 REAL,
        spy_ma200 REAL,
        qqq_price REAL,
        qqq_ma50 REAL,
        qqq_ma200 REAL,
        vix_level REAL,
        market_regime TEXT,
        spy_trend_regime TEXT,
        qqq_trend_regime TEXT,
        vix_regime TEXT,
        sector_regime TEXT,
        market_drawdown_regime TEXT,
        created_at TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_mcs_record_id ON market_context_snapshot(record_id)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_mcs_ticker_date ON market_context_snapshot(ticker, scan_date)`);

    // Phase 4A — Market Context Snapshot enriched columns (additive, dormant)
    safeExec(conn, `ALTER TABLE market_context_snapshot ADD COLUMN spy_30d_return REAL`);
    safeExec(conn, `ALTER TABLE market_context_snapshot ADD COLUMN qqq_30d_return REAL`);
    safeExec(conn, `ALTER TABLE market_context_snapshot ADD COLUMN vix_percentile REAL`);
    safeExec(conn, `ALTER TABLE market_context_snapshot ADD COLUMN market_volatility_regime TEXT`);
    safeExec(conn, `ALTER TABLE market_context_snapshot ADD COLUMN broad_market_score REAL`);

    // Phase 4A.1 — Seasonality snapshot (dormant, NULL until seasonality engine feeds it)
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_score_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_win_rate_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_best_window_start TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_best_window_end TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_direction TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_confidence TEXT`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN seasonality_snapshot_version TEXT`);

    // Phase 4A.3 — Earnings / Event Risk snapshot
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN days_to_earnings INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN earnings_risk_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN macro_event_risk_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN fed_event_risk_flag INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN event_risk_score REAL`);

    // Phase 4A.4 — IV / Liquidity / Options Quality snapshot
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN iv_rank_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN iv_percentile_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN option_spread_pct_at_scan REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN open_interest_at_scan INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN volume_at_scan INTEGER`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN liquidity_score REAL`);
    safeExec(conn, `ALTER TABLE wheel_validation_records ADD COLUMN options_quality_score REAL`);

    // Phase 4A.5 — Calibration summary tables (dormant, populated by adaptiveCalibrationEngine)
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS calibration_ticker_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        sample_size INTEGER,
        safe_win_rate REAL,
        aggressive_win_rate REAL,
        avg_drawdown REAL,
        avg_false_safety_rate REAL,
        avg_strike_touch_rate REAL,
        avg_assignment_rate REAL,
        seasonality_correlation_score REAL,
        data_quality_score REAL,
        computed_at TEXT,
        updated_at TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cts_ticker ON calibration_ticker_summary(ticker)`);
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS calibration_market_regime_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_regime TEXT NOT NULL,
        sample_size INTEGER,
        safe_performance REAL,
        aggressive_performance REAL,
        drawdown_profile REAL,
        computed_at TEXT,
        updated_at TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cmrs_regime ON calibration_market_regime_summary(market_regime)`);

    const insertStmt = conn.prepare(`
      INSERT INTO wheel_validation_records (
        id, scanSessionId, scanTimestamp, scanDate, selectedExpiration, expiration, expirationCohort,
        dteAtScan, candidateRank, captureSource, captureClass, symbol, strikeMode, yahooValidated, ibkrValidated,
        yahooRank, ibkrRank, qualityScoreYahoo, finalScoreYahoo, eliteScore, eliteBadge, spotAtScan,
        expectedMove, lowerBound, strike, premium, bid, ask, mid, spread, spreadPct, annualizedYield,
        targetPremium, popEstimate, support, resistance, supportStatus, hasEarningsBeforeExpiration,
        earningsDate, earningsDaysUntil, rsi, resolved, expirationClosePrice, expiredWorthless, assigned,
        strikeTouched, minPriceBetweenScanAndExpiration, brokeLowerBound, maxItmDepth, lowerBoundDistance,
        supportBreak, drawdownPct, rolled, realizedPl, premiumRealized, realizedReturnPct,
        popPredictionCorrect, outcomeStatus, resultStatus, resolvedAt, resolutionDate, notes,
        trade_signature, duplicate_candidate_flag, resolution_confidence, resolved_source,
        missing_close_flag, stale_quote_flag,
        underlying_close_at_expiration, underlying_low_between_scan_and_expiration,
        underlying_high_between_scan_and_expiration, expired_otm, expired_itm, assigned_flag,
        intrinsic_value_at_expiration, option_final_value, days_held,
        underlying_price_at_scan, distance_strike_from_spot_pct,
        distance_lower_bound_from_spot_pct, premium_to_spot_pct,
        stress_score, premium_efficiency, risk_adjusted_return,
        strike_safety_margin, strike_safety_margin_pct, data_quality_score,
        false_safety_flag, strike_touch_recovery_flag, max_itm_depth_pct,
        lower_bound_distance_pct, support_break_severity,
        seasonality_score_at_scan, seasonality_win_rate_at_scan,
        seasonality_best_window_start, seasonality_best_window_end,
        seasonality_direction, seasonality_confidence, seasonality_snapshot_version,
        days_to_earnings, earnings_risk_flag, macro_event_risk_flag, fed_event_risk_flag, event_risk_score,
        iv_rank_at_scan, iv_percentile_at_scan, option_spread_pct_at_scan,
        open_interest_at_scan, volume_at_scan, liquidity_score, options_quality_score,
        rawJson, createdAt, updatedAt
      ) VALUES (
        @id, @scanSessionId, @scanTimestamp, @scanDate, @selectedExpiration, @expiration, @expirationCohort,
        @dteAtScan, @candidateRank, @captureSource, @captureClass, @symbol, @strikeMode, @yahooValidated, @ibkrValidated,
        @yahooRank, @ibkrRank, @qualityScoreYahoo, @finalScoreYahoo, @eliteScore, @eliteBadge, @spotAtScan,
        @expectedMove, @lowerBound, @strike, @premium, @bid, @ask, @mid, @spread, @spreadPct, @annualizedYield,
        @targetPremium, @popEstimate, @support, @resistance, @supportStatus, @hasEarningsBeforeExpiration,
        @earningsDate, @earningsDaysUntil, @rsi, @resolved, @expirationClosePrice, @expiredWorthless, @assigned,
        @strikeTouched, @minPriceBetweenScanAndExpiration, @brokeLowerBound, @maxItmDepth, @lowerBoundDistance,
        @supportBreak, @drawdownPct, @rolled, @realizedPl, @premiumRealized, @realizedReturnPct,
        @popPredictionCorrect, @outcomeStatus, @resultStatus, @resolvedAt, @resolutionDate, @notes,
        @trade_signature, @duplicate_candidate_flag, @resolution_confidence, @resolved_source,
        @missing_close_flag, @stale_quote_flag,
        @underlying_close_at_expiration, @underlying_low_between_scan_and_expiration,
        @underlying_high_between_scan_and_expiration, @expired_otm, @expired_itm, @assigned_flag,
        @intrinsic_value_at_expiration, @option_final_value, @days_held,
        @underlying_price_at_scan, @distance_strike_from_spot_pct,
        @distance_lower_bound_from_spot_pct, @premium_to_spot_pct,
        @stress_score, @premium_efficiency, @risk_adjusted_return,
        @strike_safety_margin, @strike_safety_margin_pct, @data_quality_score,
        @false_safety_flag, @strike_touch_recovery_flag, @max_itm_depth_pct,
        @lower_bound_distance_pct, @support_break_severity,
        @seasonality_score_at_scan, @seasonality_win_rate_at_scan,
        @seasonality_best_window_start, @seasonality_best_window_end,
        @seasonality_direction, @seasonality_confidence, @seasonality_snapshot_version,
        @days_to_earnings, @earnings_risk_flag, @macro_event_risk_flag, @fed_event_risk_flag, @event_risk_score,
        @iv_rank_at_scan, @iv_percentile_at_scan, @option_spread_pct_at_scan,
        @open_interest_at_scan, @volume_at_scan, @liquidity_score, @options_quality_score,
        @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO NOTHING
    `);

    let imported = 0;
    let ignored = 0;
    try {
      const raw = await fs.readFile(jsonPath, "utf8");
      const parsed = JSON.parse(raw);
      const records = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of records) {
        const row = normalizeRecordToRow(record);
        if (!row.id) {
          ignored += 1;
          continue;
        }
        const result = insertStmt.run(row);
        if (Number(result?.changes ?? 0) > 0) imported += 1;
        else ignored += 1;
      }
      if (records.length > 0) {
        console.log(`[wheel-journal-sqlite] json migration imported=${imported} ignored=${ignored}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    initialized = true;
  }

  async function load() {
    await ensureInitialized();
    const conn = ensureDbSync();
    const rows = conn
      .prepare("SELECT id, rawJson, updatedAt FROM wheel_validation_records ORDER BY scanTimestamp DESC, id DESC")
      .all();
    const records = rows
      .map((row) => {
        try {
          const parsed = JSON.parse(String(row?.rawJson ?? "{}"));
          if (!parsed || typeof parsed !== "object") return null;
          if (!parsed.id) parsed.id = row.id;
          return parsed;
        } catch (_error) {
          return null;
        }
      })
      .filter(Boolean);
    const updatedAtRow = conn
      .prepare("SELECT MAX(updatedAt) AS updatedAt FROM wheel_validation_records")
      .get();
    return {
      version: "1.0",
      updatedAt: updatedAtRow?.updatedAt ?? null,
      records,
    };
  }

  async function save(journal) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const nowIso = new Date().toISOString();
    const upsert = conn.prepare(`
      INSERT INTO wheel_validation_records (
        id, scanSessionId, scanTimestamp, scanDate, selectedExpiration, expiration, expirationCohort,
        dteAtScan, candidateRank, captureSource, captureClass, symbol, strikeMode, yahooValidated, ibkrValidated,
        yahooRank, ibkrRank, qualityScoreYahoo, finalScoreYahoo, eliteScore, eliteBadge, spotAtScan,
        expectedMove, lowerBound, strike, premium, bid, ask, mid, spread, spreadPct, annualizedYield,
        targetPremium, popEstimate, support, resistance, supportStatus, hasEarningsBeforeExpiration,
        earningsDate, earningsDaysUntil, rsi, resolved, expirationClosePrice, expiredWorthless, assigned,
        strikeTouched, minPriceBetweenScanAndExpiration, brokeLowerBound, maxItmDepth, lowerBoundDistance,
        supportBreak, drawdownPct, rolled, realizedPl, premiumRealized, realizedReturnPct,
        popPredictionCorrect, outcomeStatus, resultStatus, resolvedAt, resolutionDate, notes,
        trade_signature, duplicate_candidate_flag, resolution_confidence, resolved_source,
        missing_close_flag, stale_quote_flag,
        underlying_close_at_expiration, underlying_low_between_scan_and_expiration,
        underlying_high_between_scan_and_expiration, expired_otm, expired_itm, assigned_flag,
        intrinsic_value_at_expiration, option_final_value, days_held,
        underlying_price_at_scan, distance_strike_from_spot_pct,
        distance_lower_bound_from_spot_pct, premium_to_spot_pct,
        stress_score, premium_efficiency, risk_adjusted_return,
        strike_safety_margin, strike_safety_margin_pct, data_quality_score,
        false_safety_flag, strike_touch_recovery_flag, max_itm_depth_pct,
        lower_bound_distance_pct, support_break_severity,
        seasonality_score_at_scan, seasonality_win_rate_at_scan,
        seasonality_best_window_start, seasonality_best_window_end,
        seasonality_direction, seasonality_confidence, seasonality_snapshot_version,
        days_to_earnings, earnings_risk_flag, macro_event_risk_flag, fed_event_risk_flag, event_risk_score,
        iv_rank_at_scan, iv_percentile_at_scan, option_spread_pct_at_scan,
        open_interest_at_scan, volume_at_scan, liquidity_score, options_quality_score,
        rawJson, createdAt, updatedAt
      ) VALUES (
        @id, @scanSessionId, @scanTimestamp, @scanDate, @selectedExpiration, @expiration, @expirationCohort,
        @dteAtScan, @candidateRank, @captureSource, @captureClass, @symbol, @strikeMode, @yahooValidated, @ibkrValidated,
        @yahooRank, @ibkrRank, @qualityScoreYahoo, @finalScoreYahoo, @eliteScore, @eliteBadge, @spotAtScan,
        @expectedMove, @lowerBound, @strike, @premium, @bid, @ask, @mid, @spread, @spreadPct, @annualizedYield,
        @targetPremium, @popEstimate, @support, @resistance, @supportStatus, @hasEarningsBeforeExpiration,
        @earningsDate, @earningsDaysUntil, @rsi, @resolved, @expirationClosePrice, @expiredWorthless, @assigned,
        @strikeTouched, @minPriceBetweenScanAndExpiration, @brokeLowerBound, @maxItmDepth, @lowerBoundDistance,
        @supportBreak, @drawdownPct, @rolled, @realizedPl, @premiumRealized, @realizedReturnPct,
        @popPredictionCorrect, @outcomeStatus, @resultStatus, @resolvedAt, @resolutionDate, @notes,
        @trade_signature, @duplicate_candidate_flag, @resolution_confidence, @resolved_source,
        @missing_close_flag, @stale_quote_flag,
        @underlying_close_at_expiration, @underlying_low_between_scan_and_expiration,
        @underlying_high_between_scan_and_expiration, @expired_otm, @expired_itm, @assigned_flag,
        @intrinsic_value_at_expiration, @option_final_value, @days_held,
        @underlying_price_at_scan, @distance_strike_from_spot_pct,
        @distance_lower_bound_from_spot_pct, @premium_to_spot_pct,
        @stress_score, @premium_efficiency, @risk_adjusted_return,
        @strike_safety_margin, @strike_safety_margin_pct, @data_quality_score,
        @false_safety_flag, @strike_touch_recovery_flag, @max_itm_depth_pct,
        @lower_bound_distance_pct, @support_break_severity,
        @seasonality_score_at_scan, @seasonality_win_rate_at_scan,
        @seasonality_best_window_start, @seasonality_best_window_end,
        @seasonality_direction, @seasonality_confidence, @seasonality_snapshot_version,
        @days_to_earnings, @earnings_risk_flag, @macro_event_risk_flag, @fed_event_risk_flag, @event_risk_score,
        @iv_rank_at_scan, @iv_percentile_at_scan, @option_spread_pct_at_scan,
        @open_interest_at_scan, @volume_at_scan, @liquidity_score, @options_quality_score,
        @rawJson, @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        scanSessionId=excluded.scanSessionId,
        scanTimestamp=excluded.scanTimestamp,
        scanDate=excluded.scanDate,
        selectedExpiration=excluded.selectedExpiration,
        expiration=excluded.expiration,
        expirationCohort=excluded.expirationCohort,
        dteAtScan=excluded.dteAtScan,
        candidateRank=excluded.candidateRank,
        captureSource=excluded.captureSource,
        captureClass=excluded.captureClass,
        symbol=excluded.symbol,
        strikeMode=excluded.strikeMode,
        yahooValidated=excluded.yahooValidated,
        ibkrValidated=excluded.ibkrValidated,
        yahooRank=excluded.yahooRank,
        ibkrRank=excluded.ibkrRank,
        qualityScoreYahoo=excluded.qualityScoreYahoo,
        finalScoreYahoo=excluded.finalScoreYahoo,
        eliteScore=excluded.eliteScore,
        eliteBadge=excluded.eliteBadge,
        spotAtScan=excluded.spotAtScan,
        expectedMove=excluded.expectedMove,
        lowerBound=excluded.lowerBound,
        strike=excluded.strike,
        premium=excluded.premium,
        bid=excluded.bid,
        ask=excluded.ask,
        mid=excluded.mid,
        spread=excluded.spread,
        spreadPct=excluded.spreadPct,
        annualizedYield=excluded.annualizedYield,
        targetPremium=excluded.targetPremium,
        popEstimate=excluded.popEstimate,
        support=excluded.support,
        resistance=excluded.resistance,
        supportStatus=excluded.supportStatus,
        hasEarningsBeforeExpiration=excluded.hasEarningsBeforeExpiration,
        earningsDate=excluded.earningsDate,
        earningsDaysUntil=excluded.earningsDaysUntil,
        rsi=excluded.rsi,
        resolved=excluded.resolved,
        expirationClosePrice=excluded.expirationClosePrice,
        expiredWorthless=excluded.expiredWorthless,
        assigned=excluded.assigned,
        strikeTouched=excluded.strikeTouched,
        minPriceBetweenScanAndExpiration=excluded.minPriceBetweenScanAndExpiration,
        brokeLowerBound=excluded.brokeLowerBound,
        maxItmDepth=excluded.maxItmDepth,
        lowerBoundDistance=excluded.lowerBoundDistance,
        supportBreak=excluded.supportBreak,
        drawdownPct=excluded.drawdownPct,
        rolled=excluded.rolled,
        realizedPl=excluded.realizedPl,
        premiumRealized=excluded.premiumRealized,
        realizedReturnPct=excluded.realizedReturnPct,
        popPredictionCorrect=excluded.popPredictionCorrect,
        outcomeStatus=excluded.outcomeStatus,
        resultStatus=excluded.resultStatus,
        resolvedAt=excluded.resolvedAt,
        resolutionDate=excluded.resolutionDate,
        notes=excluded.notes,
        trade_signature=excluded.trade_signature,
        duplicate_candidate_flag=excluded.duplicate_candidate_flag,
        resolution_confidence=excluded.resolution_confidence,
        resolved_source=excluded.resolved_source,
        missing_close_flag=excluded.missing_close_flag,
        stale_quote_flag=excluded.stale_quote_flag,
        underlying_close_at_expiration=excluded.underlying_close_at_expiration,
        underlying_low_between_scan_and_expiration=excluded.underlying_low_between_scan_and_expiration,
        underlying_high_between_scan_and_expiration=excluded.underlying_high_between_scan_and_expiration,
        expired_otm=excluded.expired_otm,
        expired_itm=excluded.expired_itm,
        assigned_flag=excluded.assigned_flag,
        intrinsic_value_at_expiration=excluded.intrinsic_value_at_expiration,
        option_final_value=excluded.option_final_value,
        days_held=excluded.days_held,
        underlying_price_at_scan=excluded.underlying_price_at_scan,
        distance_strike_from_spot_pct=excluded.distance_strike_from_spot_pct,
        distance_lower_bound_from_spot_pct=excluded.distance_lower_bound_from_spot_pct,
        premium_to_spot_pct=excluded.premium_to_spot_pct,
        stress_score=excluded.stress_score,
        premium_efficiency=excluded.premium_efficiency,
        risk_adjusted_return=excluded.risk_adjusted_return,
        strike_safety_margin=excluded.strike_safety_margin,
        strike_safety_margin_pct=excluded.strike_safety_margin_pct,
        data_quality_score=excluded.data_quality_score,
        false_safety_flag=excluded.false_safety_flag,
        strike_touch_recovery_flag=excluded.strike_touch_recovery_flag,
        max_itm_depth_pct=excluded.max_itm_depth_pct,
        lower_bound_distance_pct=excluded.lower_bound_distance_pct,
        support_break_severity=excluded.support_break_severity,
        seasonality_score_at_scan=excluded.seasonality_score_at_scan,
        seasonality_win_rate_at_scan=excluded.seasonality_win_rate_at_scan,
        seasonality_best_window_start=excluded.seasonality_best_window_start,
        seasonality_best_window_end=excluded.seasonality_best_window_end,
        seasonality_direction=excluded.seasonality_direction,
        seasonality_confidence=excluded.seasonality_confidence,
        seasonality_snapshot_version=excluded.seasonality_snapshot_version,
        days_to_earnings=excluded.days_to_earnings,
        earnings_risk_flag=excluded.earnings_risk_flag,
        macro_event_risk_flag=excluded.macro_event_risk_flag,
        fed_event_risk_flag=excluded.fed_event_risk_flag,
        event_risk_score=excluded.event_risk_score,
        iv_rank_at_scan=excluded.iv_rank_at_scan,
        iv_percentile_at_scan=excluded.iv_percentile_at_scan,
        option_spread_pct_at_scan=excluded.option_spread_pct_at_scan,
        open_interest_at_scan=excluded.open_interest_at_scan,
        volume_at_scan=excluded.volume_at_scan,
        liquidity_score=excluded.liquidity_score,
        options_quality_score=excluded.options_quality_score,
        rawJson=excluded.rawJson,
        createdAt=COALESCE(wheel_validation_records.createdAt, excluded.createdAt),
        updatedAt=excluded.updatedAt
    `);
    conn.exec("BEGIN");
    try {
      for (const record of records) {
        const row = normalizeRecordToRow(record, nowIso);
        if (!row.id) continue;
        upsert.run(row);
      }
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch (_rollbackError) {
        // Preserve the original failure if rollback itself also errors.
      }
      throw error;
    }
    return {
      version: journal?.version ?? "1.0",
      updatedAt: journal?.updatedAt ?? nowIso,
      records,
    };
  }

  async function insertMarketContextSnapshot(snapshot) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const stmt = conn.prepare(`
      INSERT INTO market_context_snapshot (
        record_id, scan_date, ticker, expiration,
        spy_price, spy_ma50, spy_ma200,
        qqq_price, qqq_ma50, qqq_ma200,
        vix_level, market_regime, spy_trend_regime, qqq_trend_regime,
        vix_regime, sector_regime, market_drawdown_regime,
        spy_30d_return, qqq_30d_return, vix_percentile,
        market_volatility_regime, broad_market_score,
        created_at
      ) VALUES (
        @record_id, @scan_date, @ticker, @expiration,
        @spy_price, @spy_ma50, @spy_ma200,
        @qqq_price, @qqq_ma50, @qqq_ma200,
        @vix_level, @market_regime, @spy_trend_regime, @qqq_trend_regime,
        @vix_regime, @sector_regime, @market_drawdown_regime,
        @spy_30d_return, @qqq_30d_return, @vix_percentile,
        @market_volatility_regime, @broad_market_score,
        @created_at
      )
    `);
    return stmt.run({
      record_id: snapshot?.record_id ?? null,
      scan_date: snapshot?.scan_date ?? null,
      ticker: snapshot?.ticker ?? null,
      expiration: snapshot?.expiration ?? null,
      spy_price: toReal(snapshot?.spy_price),
      spy_ma50: toReal(snapshot?.spy_ma50),
      spy_ma200: toReal(snapshot?.spy_ma200),
      qqq_price: toReal(snapshot?.qqq_price),
      qqq_ma50: toReal(snapshot?.qqq_ma50),
      qqq_ma200: toReal(snapshot?.qqq_ma200),
      vix_level: toReal(snapshot?.vix_level),
      market_regime: snapshot?.market_regime ?? null,
      spy_trend_regime: snapshot?.spy_trend_regime ?? null,
      qqq_trend_regime: snapshot?.qqq_trend_regime ?? null,
      vix_regime: snapshot?.vix_regime ?? null,
      sector_regime: snapshot?.sector_regime ?? null,
      market_drawdown_regime: snapshot?.market_drawdown_regime ?? null,
      spy_30d_return: toReal(snapshot?.spy_30d_return),
      qqq_30d_return: toReal(snapshot?.qqq_30d_return),
      vix_percentile: toReal(snapshot?.vix_percentile),
      market_volatility_regime: snapshot?.market_volatility_regime ?? null,
      broad_market_score: toReal(snapshot?.broad_market_score),
      created_at: new Date().toISOString(),
    });
  }

  async function upsertCalibrationTickerSummary(summary) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const nowIso = new Date().toISOString();
    const existing = conn
      .prepare("SELECT id FROM calibration_ticker_summary WHERE ticker = @ticker")
      .get({ ticker: summary.ticker });
    if (existing) {
      conn.prepare(`
        UPDATE calibration_ticker_summary SET
          sample_size=@sample_size, safe_win_rate=@safe_win_rate,
          aggressive_win_rate=@aggressive_win_rate, avg_drawdown=@avg_drawdown,
          avg_false_safety_rate=@avg_false_safety_rate, avg_strike_touch_rate=@avg_strike_touch_rate,
          avg_assignment_rate=@avg_assignment_rate,
          seasonality_correlation_score=@seasonality_correlation_score,
          data_quality_score=@data_quality_score, computed_at=@computed_at, updated_at=@updated_at
        WHERE ticker=@ticker
      `).run({
        ticker: summary.ticker,
        sample_size: toInt(summary.sample_size),
        safe_win_rate: toReal(summary.safe_win_rate),
        aggressive_win_rate: toReal(summary.aggressive_win_rate),
        avg_drawdown: toReal(summary.avg_drawdown),
        avg_false_safety_rate: toReal(summary.avg_false_safety_rate),
        avg_strike_touch_rate: toReal(summary.avg_strike_touch_rate),
        avg_assignment_rate: toReal(summary.avg_assignment_rate),
        seasonality_correlation_score: toReal(summary.seasonality_correlation_score),
        data_quality_score: toReal(summary.data_quality_score),
        computed_at: summary.computed_at ?? nowIso,
        updated_at: nowIso,
      });
    } else {
      conn.prepare(`
        INSERT INTO calibration_ticker_summary (
          ticker, sample_size, safe_win_rate, aggressive_win_rate, avg_drawdown,
          avg_false_safety_rate, avg_strike_touch_rate, avg_assignment_rate,
          seasonality_correlation_score, data_quality_score, computed_at, updated_at
        ) VALUES (
          @ticker, @sample_size, @safe_win_rate, @aggressive_win_rate, @avg_drawdown,
          @avg_false_safety_rate, @avg_strike_touch_rate, @avg_assignment_rate,
          @seasonality_correlation_score, @data_quality_score, @computed_at, @updated_at
        )
      `).run({
        ticker: summary.ticker,
        sample_size: toInt(summary.sample_size),
        safe_win_rate: toReal(summary.safe_win_rate),
        aggressive_win_rate: toReal(summary.aggressive_win_rate),
        avg_drawdown: toReal(summary.avg_drawdown),
        avg_false_safety_rate: toReal(summary.avg_false_safety_rate),
        avg_strike_touch_rate: toReal(summary.avg_strike_touch_rate),
        avg_assignment_rate: toReal(summary.avg_assignment_rate),
        seasonality_correlation_score: toReal(summary.seasonality_correlation_score),
        data_quality_score: toReal(summary.data_quality_score),
        computed_at: summary.computed_at ?? nowIso,
        updated_at: nowIso,
      });
    }
  }

  async function upsertCalibrationMarketRegimeSummary(summary) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const nowIso = new Date().toISOString();
    const existing = conn
      .prepare("SELECT id FROM calibration_market_regime_summary WHERE market_regime = @market_regime")
      .get({ market_regime: summary.market_regime });
    if (existing) {
      conn.prepare(`
        UPDATE calibration_market_regime_summary SET
          sample_size=@sample_size, safe_performance=@safe_performance,
          aggressive_performance=@aggressive_performance, drawdown_profile=@drawdown_profile,
          computed_at=@computed_at, updated_at=@updated_at
        WHERE market_regime=@market_regime
      `).run({
        market_regime: summary.market_regime,
        sample_size: toInt(summary.sample_size),
        safe_performance: toReal(summary.safe_performance),
        aggressive_performance: toReal(summary.aggressive_performance),
        drawdown_profile: toReal(summary.drawdown_profile),
        computed_at: summary.computed_at ?? nowIso,
        updated_at: nowIso,
      });
    } else {
      conn.prepare(`
        INSERT INTO calibration_market_regime_summary (
          market_regime, sample_size, safe_performance, aggressive_performance,
          drawdown_profile, computed_at, updated_at
        ) VALUES (
          @market_regime, @sample_size, @safe_performance, @aggressive_performance,
          @drawdown_profile, @computed_at, @updated_at
        )
      `).run({
        market_regime: summary.market_regime,
        sample_size: toInt(summary.sample_size),
        safe_performance: toReal(summary.safe_performance),
        aggressive_performance: toReal(summary.aggressive_performance),
        drawdown_profile: toReal(summary.drawdown_profile),
        computed_at: summary.computed_at ?? nowIso,
        updated_at: nowIso,
      });
    }
  }

  async function queryMarketContextSnapshot(filter = {}) {
    await ensureInitialized();
    const conn = ensureDbSync();
    let sql = "SELECT * FROM market_context_snapshot WHERE 1=1";
    const params = {};
    if (filter.record_id != null) { sql += " AND record_id = @record_id"; params.record_id = filter.record_id; }
    if (filter.ticker != null) { sql += " AND ticker = @ticker"; params.ticker = filter.ticker; }
    if (filter.scan_date != null) { sql += " AND scan_date = @scan_date"; params.scan_date = filter.scan_date; }
    sql += " ORDER BY id DESC LIMIT 500";
    return conn.prepare(sql).all(params);
  }

  // Phase 4B-PREP — read-only queries for calibration diagnostic endpoints

  async function getJournalCounts() {
    await ensureInitialized();
    const conn = ensureDbSync();
    const total = conn.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records").get();
    const resolved = conn.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE resolved = 1").get();
    const unresolved = conn.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE resolved != 1 OR resolved IS NULL").get();
    return {
      total: total?.cnt ?? 0,
      resolved: resolved?.cnt ?? 0,
      unresolved: unresolved?.cnt ?? 0,
    };
  }

  async function readCalibrationTickerSummary() {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn.prepare("SELECT * FROM calibration_ticker_summary ORDER BY sample_size DESC").all();
  }

  async function readCalibrationMarketRegimeSummary() {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn.prepare("SELECT * FROM calibration_market_regime_summary ORDER BY sample_size DESC").all();
  }

  return {
    load,
    save,
    sqlitePath,
    jsonPath,
    insertMarketContextSnapshot,
    queryMarketContextSnapshot,
    upsertCalibrationTickerSummary,
    upsertCalibrationMarketRegimeSummary,
    getJournalCounts,
    readCalibrationTickerSummary,
    readCalibrationMarketRegimeSummary,
  };
}
