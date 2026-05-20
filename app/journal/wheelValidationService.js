import { createWheelValidationStore } from "./wheelValidationStore.js";

function toNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return null;
}

function normalizeIsoTimestamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeExpiration(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/-/g, "");
  return /^\d{8}$/.test(compact) ? compact : raw;
}

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeStrikeToken(value) {
  const strike = toNumberOrNull(value);
  if (strike == null) return "na";
  return String(strike).replace(".", "_");
}

function normalizeYmd(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/-/g, "");
  return /^\d{8}$/.test(compact) ? compact : "";
}

function formatExpirationCohort(expirationYmd) {
  const normalized = normalizeYmd(expirationYmd);
  if (!normalized) return null;
  return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
}

function computeDteAtScan(scanTimestamp, expirationYmd) {
  const exp = normalizeYmd(expirationYmd);
  if (!exp) return null;
  const scanDate = normalizeIsoTimestamp(scanTimestamp).slice(0, 10);
  const scanUtc = new Date(`${scanDate}T00:00:00.000Z`);
  const expUtc = new Date(`${exp.slice(0, 4)}-${exp.slice(4, 6)}-${exp.slice(6, 8)}T00:00:00.000Z`);
  if (Number.isNaN(scanUtc.getTime()) || Number.isNaN(expUtc.getTime())) return null;
  return Math.round((expUtc.getTime() - scanUtc.getTime()) / 86400000);
}

function getScanDayInfo(scanDate) {
  const raw = String(scanDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { label: "Inconnu", dow: null };
  const d = new Date(`${raw}T12:00:00.000Z`);
  const dayNum = d.getUTCDay();
  const labels = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  return { label: labels[dayNum], dow: dayNum };
}

function buildLegacyRecordId(symbol, expiration, strikeMode, strike, scanDate) {
  return `${symbol}_${expiration}_${strikeMode}_${normalizeStrikeToken(strike)}_${scanDate}`;
}

function buildSessionRecordId(symbol, expiration, strikeMode, strike, scanSessionId, scanDate) {
  const session = scanSessionId == null ? "" : String(scanSessionId).trim();
  if (!session) return buildLegacyRecordId(symbol, expiration, strikeMode, strike, scanDate);
  return `${session}_${symbol}_${expiration}_${strikeMode}_${normalizeStrikeToken(strike)}`;
}

// Phase 1 — trade_signature identifies a unique logical trade (symbol+expiration+mode+strike)
// SAFE and AGGRESSIVE are distinct signatures — both can be legitimate simultaneously.
function buildTradeSignature(symbol, expiration, strikeMode, strike) {
  const strikeToken = normalizeStrikeToken(strike);
  return `${symbol}_${expiration}_${strikeMode}_${strikeToken}`;
}

// Phase 2 — Snapshot fields computed at scan time from available candidate data
function computeSnapshotAtScan(spot, strike, lowerBound, premium) {
  const distanceStrikeFromSpotPct =
    spot != null && spot > 0 && strike != null
      ? Number((((spot - strike) / spot) * 100).toFixed(4))
      : null;
  const distanceLowerBoundFromSpotPct =
    spot != null && spot > 0 && lowerBound != null
      ? Number((((spot - lowerBound) / spot) * 100).toFixed(4))
      : null;
  const premiumToSpotPct =
    spot != null && spot > 0 && premium != null
      ? Number(((premium / spot) * 100).toFixed(4))
      : null;
  return {
    underlying_price_at_scan: spot,
    distance_strike_from_spot_pct: distanceStrikeFromSpotPct,
    distance_lower_bound_from_spot_pct: distanceLowerBoundFromSpotPct,
    premium_to_spot_pct: premiumToSpotPct,
  };
}

// Phase 3 — Stress metrics computable at scan time
function computeStressAtScan(spot, strike, premium, bid, ask, expectedMove, lowerBound, support, popEstimate) {
  const strikeSafetyMargin =
    spot != null && strike != null ? Number((spot - strike).toFixed(4)) : null;
  const strikeSafetyMarginPct =
    spot != null && spot > 0 && strike != null
      ? Number((((spot - strike) / spot) * 100).toFixed(4))
      : null;
  const premiumEfficiency =
    premium != null && strike != null && strike > 0
      ? Number(((premium / strike) * 100).toFixed(4))
      : null;

  // data_quality_score: 100 minus deductions for missing key fields
  let dataQuality = 100;
  if (spot == null) dataQuality -= 20;
  if (strike == null) dataQuality -= 20;
  if (premium == null) dataQuality -= 15;
  if (bid == null && ask == null) dataQuality -= 10;
  if (expectedMove == null) dataQuality -= 10;
  if (lowerBound == null) dataQuality -= 5;
  if (support == null) dataQuality -= 5;
  if (popEstimate == null) dataQuality -= 10;

  return {
    stress_score: null,
    premium_efficiency: premiumEfficiency,
    risk_adjusted_return: null,
    strike_safety_margin: strikeSafetyMargin,
    strike_safety_margin_pct: strikeSafetyMarginPct,
    data_quality_score: Math.max(0, dataQuality),
  };
}

// Phase 4A.3 — event_risk_score: 0-100, higher means higher event risk before expiration
function computeEventRiskScore(hasEarningsBeforeExpiration, earningsDaysUntil) {
  if (hasEarningsBeforeExpiration === true) return 100;
  const daysUntil = toNumberOrNull(earningsDaysUntil);
  if (daysUntil != null && daysUntil <= 7) return 80;
  if (daysUntil != null && daysUntil <= 14) return 50;
  return 0;
}

// Phase 4A.4 — liquidity_score: 0-100 based on spread quality and open interest
function computeLiquidityScore(bid, ask, spreadPct, openInterest) {
  if (bid == null && ask == null) return null;
  let score = 100;
  const sp = toNumberOrNull(spreadPct);
  if (sp != null) {
    if (sp > 0.3) score -= 40;
    else if (sp > 0.2) score -= 25;
    else if (sp > 0.1) score -= 10;
  }
  const oi = toNumberOrNull(openInterest);
  if (oi != null) {
    if (oi < 100) score -= 20;
    else if (oi < 500) score -= 10;
  }
  return Math.max(0, score);
}

// Phase 1 — stale_quote_flag: 1 if bid+ask both absent, or spread is suspiciously wide (>50%)
function computeStaleQuoteFlag(strikeRow) {
  const bid = toNumberOrNull(strikeRow?.bid);
  const ask = toNumberOrNull(strikeRow?.ask);
  if (bid == null && ask == null) return true;
  const spreadPct =
    toNumberOrNull(strikeRow?.spreadPct) ??
    toNumberOrNull(strikeRow?.liquidity?.spreadPct);
  if (spreadPct != null && spreadPct > 0.5) return true;
  return false;
}

function average(values) {
  const nums = values.map((value) => toNumberOrNull(value)).filter((value) => value != null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function median(values) {
  const nums = values.map((value) => toNumberOrNull(value)).filter((value) => value != null).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function stddevPopulation(values, mean = average(values)) {
  const nums = values.map((value) => toNumberOrNull(value)).filter((value) => value != null);
  if (nums.length === 0 || mean == null) return null;
  const variance = nums.reduce((sum, value) => sum + (value - mean) ** 2, 0) / nums.length;
  return Math.sqrt(variance);
}

function roundMetric(value, digits = 4) {
  const n = toNumberOrNull(value);
  if (n == null) return null;
  return Number(n.toFixed(digits));
}

function getPremiumCandidate(record) {
  return (
    toNumberOrNull(record?.premium) ??
    toNumberOrNull(record?.strike?.premium) ??
    toNumberOrNull(record?.mid) ??
    toNumberOrNull(record?.strike?.mid) ??
    toNumberOrNull(record?.bid) ??
    toNumberOrNull(record?.strike?.bid) ??
    null
  );
}

function getLatestTimestamp(record) {
  const raw = record?.scanTimestamp ?? record?.scanDate ?? null;
  const date = raw == null ? null : new Date(raw);
  const time = date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
  return time ?? -Infinity;
}

function getAssignedFlag(record) {
  return (
    toBooleanOrNull(record?.resolution?.assigned_flag) ??
    toBooleanOrNull(record?.resolution?.assigned) ??
    toBooleanOrNull(record?.assigned_flag) ??
    toBooleanOrNull(record?.assigned) ??
    null
  );
}

function getExpiredOtmFlag(record) {
  return (
    toBooleanOrNull(record?.resolution?.expired_otm) ??
    toBooleanOrNull(record?.resolution?.expiredWorthless) ??
    toBooleanOrNull(record?.expired_otm) ??
    toBooleanOrNull(record?.expiredWorthless) ??
    null
  );
}

function getStrikeTouchedFlag(record) {
  return (
    toBooleanOrNull(record?.resolution?.strikeTouched) ??
    toBooleanOrNull(record?.strikeTouched) ??
    null
  );
}

function getBrokeLowerBoundFlag(record) {
  return (
    toBooleanOrNull(record?.resolution?.brokeLowerBound) ??
    toBooleanOrNull(record?.brokeLowerBound) ??
    null
  );
}

function getResolvedFlag(record) {
  return (
    toBooleanOrNull(record?.resolution?.resolved) ??
    toBooleanOrNull(record?.resolved) ??
    false
  ) === true;
}

function buildResolutionDefaults() {
  return {
    resolved: false,
    expirationClosePrice: null,
    expiredWorthless: null,
    assigned: null,
    strikeTouched: null,
    minPriceBetweenScanAndExpiration: null,
    brokeLowerBound: null,
    maxItmDepth: null,
    lowerBoundDistance: null,
    supportBreak: null,
    drawdownPct: null,
    rolled: null,
    realizedPl: null,
    premiumRealized: null,
    realizedReturnPct: null,
    popPredictionCorrect: null,
    outcomeStatus: null,
    resultStatus: null,
    resolvedAt: null,
    resolutionDate: null,
    notes: null,
    // Phase 1 — Resolution integrity
    resolved_source: null,
    resolution_confidence: null,
    missing_close_flag: null,
    // Phase 2 — Raw outcome
    underlying_close_at_expiration: null,
    underlying_low_between_scan_and_expiration: null,
    underlying_high_between_scan_and_expiration: null,
    expired_otm: null,
    expired_itm: null,
    assigned_flag: null,
    intrinsic_value_at_expiration: null,
    option_final_value: null,
    days_held: null,
    // Phase 3 — Resolution-time stress metrics
    false_safety_flag: null,
    strike_touch_recovery_flag: null,
    max_itm_depth_pct: null,
    lower_bound_distance_pct: null,
    support_break_severity: null,
  };
}

function getFinalScoreYahoo(candidate) {
  return (
    toNumberOrNull(candidate?.finalScore) ??
    toNumberOrNull(candidate?.proFinalScore) ??
    null
  );
}

function getSpotAtScan(candidate) {
  return (
    toNumberOrNull(candidate?.currentPrice) ??
    toNumberOrNull(candidate?.underlyingPrice) ??
    toNumberOrNull(candidate?.price) ??
    null
  );
}

function getExpectedMove(candidate) {
  const direct = toNumberOrNull(candidate?.expectedMove);
  if (direct != null) return direct;
  const high = toNumberOrNull(candidate?.expectedMoveHigh);
  const spot = getSpotAtScan(candidate);
  return high != null && spot != null ? Number((high - spot).toFixed(4)) : null;
}

function getLowerBound(candidate) {
  return (
    toNumberOrNull(candidate?.lowerBound) ??
    toNumberOrNull(candidate?.expectedMoveLow) ??
    null
  );
}

function getStrikeRow(candidate, strikeMode) {
  return strikeMode === "safe" ? candidate?.safeStrike ?? null : candidate?.aggressiveStrike ?? null;
}

function getMarketCap(candidate) {
  return (
    toNumberOrNull(candidate?.marketCap) ??
    toNumberOrNull(candidate?.raw?.quote?.marketCap) ??
    toNumberOrNull(candidate?.ibkrDirect?.raw?.quote?.marketCap) ??
    toNumberOrNull(candidate?.scoreBreakdown?.marketCap) ??
    null
  );
}

function getAverageVolume(candidate) {
  return (
    toNumberOrNull(candidate?.averageVolume) ??
    toNumberOrNull(candidate?.raw?.quote?.averageDailyVolume3Month) ??
    toNumberOrNull(candidate?.raw?.quote?.regularMarketVolume) ??
    toNumberOrNull(candidate?.ibkrDirect?.raw?.quote?.averageDailyVolume3Month) ??
    toNumberOrNull(candidate?.scoreBreakdown?.averageVolume) ??
    null
  );
}

function getQuoteType(candidate) {
  return (
    candidate?.quoteType ??
    candidate?.raw?.quote?.quoteType ??
    candidate?.ibkrDirect?.raw?.quote?.quoteType ??
    null
  );
}

function normalizeDiagnosticsV12(candidate) {
  const diagnostics = candidate?.diagnosticsV12;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const challengerReasons = Array.isArray(diagnostics?.challengerReasons)
    ? diagnostics.challengerReasons
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    : [];
  const normalized = {
    hv10: toNumberOrNull(diagnostics?.hv10),
    hv20: toNumberOrNull(diagnostics?.hv20),
    hv30: toNumberOrNull(diagnostics?.hv30),
    safeStrikeIv: toNumberOrNull(diagnostics?.safeStrikeIv),
    atmIv: toNumberOrNull(diagnostics?.atmIv),
    ivHvRatio: toNumberOrNull(diagnostics?.ivHvRatio),
    ivHvEdge: typeof diagnostics?.ivHvEdge === "boolean" ? diagnostics.ivHvEdge : null,
    dailyChangePct: toNumberOrNull(diagnostics?.dailyChangePct),
    zScore20: toNumberOrNull(diagnostics?.zScore20),
    volumeVsAvgRatio: toNumberOrNull(diagnostics?.volumeVsAvgRatio),
    challengerCandidate:
      typeof diagnostics?.challengerCandidate === "boolean"
        ? diagnostics.challengerCandidate
        : null,
    challengerReasons,
  };
  const hasValue =
    normalized.hv10 != null ||
    normalized.hv20 != null ||
    normalized.hv30 != null ||
    normalized.safeStrikeIv != null ||
    normalized.atmIv != null ||
    normalized.ivHvRatio != null ||
    normalized.ivHvEdge != null ||
    normalized.dailyChangePct != null ||
    normalized.zScore20 != null ||
    normalized.volumeVsAvgRatio != null ||
    normalized.challengerCandidate != null ||
    normalized.challengerReasons.length > 0;
  return hasValue ? normalized : null;
}

function normalizeRecord(candidate, strikeMode, scanTimestamp, scanSessionId = null, options = {}) {
  const strikeRow = getStrikeRow(candidate, strikeMode);
  const strike = toNumberOrNull(strikeRow?.strike);
  if (strike == null) return null;

  const symbol = normalizeSymbol(candidate?.symbol ?? candidate?.ticker);
  const expiration = normalizeExpiration(
    candidate?.expiration ??
      candidate?.targetExpiration ??
      candidate?.ibkrDirect?.raw?.expiration ??
      candidate?.raw?.expiration
  );
  const scanDate = scanTimestamp.slice(0, 10);
  const selectedExpiration = normalizeExpiration(
    options.selectedExpiration ?? candidate?.targetExpiration ?? candidate?.selectedExpiration ?? candidate?.expiration
  );
  const expirationCohort = formatExpirationCohort(expiration);
  const dteAtScan =
    toNumberOrNull(options.dteAtScan) ??
    toNumberOrNull(candidate?.dteAtScan) ??
    computeDteAtScan(scanTimestamp, expiration);
  const candidateRank =
    toNumberOrNull(options.candidateRank) ??
    toNumberOrNull(candidate?.rank) ??
    toNumberOrNull(candidate?.yahooRank) ??
    null;
  const captureSource =
    options.captureSource == null ? null : String(options.captureSource).trim() || null;

  // Phase 2 — snapshot at scan time
  const spot = getSpotAtScan(candidate);
  const lowerBound = getLowerBound(candidate);
  const premium =
    toNumberOrNull(strikeRow?.premium) ??
    toNumberOrNull(strikeRow?.premiumUsed) ??
    toNumberOrNull(strikeRow?.mid) ??
    toNumberOrNull(strikeRow?.bid) ??
    null;
  const snapshotAtScan = computeSnapshotAtScan(spot, strike, lowerBound, premium);

  // Phase 3 — stress at scan time
  const expectedMove = getExpectedMove(candidate);
  const support =
    toNumberOrNull(candidate?.support) ??
    toNumberOrNull(candidate?.supportResistance?.support) ??
    null;
  const popEstimate =
    toNumberOrNull(strikeRow?.popEstimate) ??
    toNumberOrNull(strikeRow?.popProfitEstimated) ??
    null;
  const stressAtScan = computeStressAtScan(
    spot, strike, premium,
    toNumberOrNull(strikeRow?.bid),
    toNumberOrNull(strikeRow?.ask),
    expectedMove, lowerBound, support, popEstimate
  );

  return {
    id: buildSessionRecordId(symbol, expiration, strikeMode, strike, scanSessionId, scanDate),
    // Phase 1 — trade identity & integrity
    trade_signature: buildTradeSignature(symbol, expiration, strikeMode, strike),
    duplicate_candidate_flag: false,
    stale_quote_flag: computeStaleQuoteFlag(strikeRow),
    scanSessionId: scanSessionId == null ? null : String(scanSessionId).trim() || null,
    scanTimestamp,
    scanDate,
    selectedExpiration: selectedExpiration || null,
    expirationCohort,
    dteAtScan,
    candidateRank,
    captureSource,
    captureClass: null,
    // Traçabilité mode/source — null si non transmis par le frontend
    portfolioMode: options.portfolioMode ?? candidate?.portfolioMode ?? null,
    strikeLegUsed: strikeMode === "safe" ? "safe" : strikeMode === "aggressive" ? "aggressive" : null,
    optionSource:
      candidate?.source === "IBKR" || candidate?.optionsSource === "IBKR live"
        ? "IBKR live"
        : candidate?.raw != null
        ? "Yahoo"
        : candidate?.optionsSource ?? null,
    symbol,
    expiration,
    strikeMode,
    source: {
      yahoo: candidate?.techniqueSource === "Yahoo" || Boolean(candidate?.raw),
      ibkrValidated:
        Boolean(candidate?.ibkrDirect) ||
        candidate?.optionsSource === "IBKR live" ||
        candidate?.source === "IBKR",
    },
    ranks: {
      yahooRank:
        toNumberOrNull(candidate?.yahooRank) ??
        toNumberOrNull(candidate?.rank) ??
        null,
      ibkrRank: toNumberOrNull(candidate?.ibkrRank),
    },
    scores: {
      qualityScoreYahoo: toNumberOrNull(candidate?.qualityScore),
      finalScoreYahoo: getFinalScoreYahoo(candidate),
      eliteScore: toNumberOrNull(candidate?.eliteScore),
      eliteBadge: candidate?.eliteBadge ?? null,
    },
    underlying: {
      spotAtScan: getSpotAtScan(candidate),
      expectedMove: getExpectedMove(candidate),
      lowerBound: getLowerBound(candidate),
    },
    strike: (() => {
      // Résolution de la prime officielle avec traçabilité de la source
      const _cprem = toNumberOrNull(strikeRow?.conservativePremium);
      const _pprem = toNumberOrNull(strikeRow?.primeUsed);
      const _puprem = toNumberOrNull(strikeRow?.premiumUsed);
      const _bprem = toNumberOrNull(strikeRow?.bid);
      const _prem = toNumberOrNull(strikeRow?.premium);
      const _mprem = toNumberOrNull(strikeRow?.mid);
      const officialPremiumUsed =
        _cprem ?? _pprem ?? _puprem ?? _bprem ?? _prem ?? _mprem ?? null;
      const premiumSource =
        _cprem != null ? "conservativePremium" :
        _pprem != null ? "primeUsed" :
        _puprem != null ? "premiumUsed" :
        _bprem != null ? "bid" :
        _prem != null ? "premium" :
        _mprem != null ? "mid" :
        null;
      return {
        strike,
        premium:
          toNumberOrNull(strikeRow?.premium) ??
          toNumberOrNull(strikeRow?.premiumUsed) ??
          toNumberOrNull(strikeRow?.mid) ??
          toNumberOrNull(strikeRow?.bid) ??
          null,
        officialPremiumUsed,
        premiumSource,
        bid: toNumberOrNull(strikeRow?.bid),
        ask: toNumberOrNull(strikeRow?.ask),
        mid: toNumberOrNull(strikeRow?.mid),
        spread: toNumberOrNull(strikeRow?.spread),
        spreadPct:
          toNumberOrNull(strikeRow?.spreadPct) ??
          toNumberOrNull(strikeRow?.liquidity?.spreadPct) ??
          null,
        annualizedYield: toNumberOrNull(strikeRow?.annualizedYield),
        targetPremium: toNumberOrNull(candidate?.targetPremium ?? candidate?.minPremium),
        popEstimate:
          toNumberOrNull(strikeRow?.popEstimate) ??
          toNumberOrNull(strikeRow?.popProfitEstimated) ??
          null,
      };
    })(),
    context: {
      support:
        toNumberOrNull(candidate?.support) ??
        toNumberOrNull(candidate?.supportResistance?.support) ??
        null,
      resistance:
        toNumberOrNull(candidate?.resistance) ??
        toNumberOrNull(candidate?.supportResistance?.resistance) ??
        null,
      supportStatus:
        candidate?.supportStatus ??
        candidate?.supportResistance?.supportStatus ??
        null,
      hasEarningsBeforeExpiration:
        candidate?.hasUpcomingEarningsBeforeExpiration === true ||
        candidate?.hasEarningsBeforeExpiration === true,
      earningsDate: candidate?.earningsDate ?? candidate?.nextEarningsDate ?? null,
      earningsDaysUntil: toNumberOrNull(candidate?.earningsDaysUntil),
      marketCap: getMarketCap(candidate),
      averageVolume: getAverageVolume(candidate),
      quoteType: getQuoteType(candidate),
      rsi:
        toNumberOrNull(candidate?.rsi) ??
        toNumberOrNull(candidate?.raw?.technicals?.rsi) ??
        null,
    },
    diagnosticsV12: normalizeDiagnosticsV12(candidate),
    // Phase 2 — snapshot at scan time
    snapshot: snapshotAtScan,
    // Phase 3 — stress at scan time (resolution-time stress fields stay in resolution object)
    stress: stressAtScan,
    // Phase 4A.1 — seasonality snapshot (dormant: null until seasonality engine feeds it)
    seasonality: {
      seasonality_score_at_scan: null,
      seasonality_win_rate_at_scan: null,
      seasonality_best_window_start: null,
      seasonality_best_window_end: null,
      seasonality_direction: null,
      seasonality_confidence: null,
      seasonality_snapshot_version: null,
    },
    // Phase 4A.3 — earnings / event risk (partially populated from candidate data)
    eventRisk: {
      days_to_earnings: toNumberOrNull(candidate?.earningsDaysUntil),
      earnings_risk_flag:
        candidate?.hasUpcomingEarningsBeforeExpiration === true ||
        candidate?.hasEarningsBeforeExpiration === true,
      macro_event_risk_flag: null,
      fed_event_risk_flag: null,
      event_risk_score: computeEventRiskScore(
        candidate?.hasUpcomingEarningsBeforeExpiration === true ||
        candidate?.hasEarningsBeforeExpiration === true,
        candidate?.earningsDaysUntil
      ),
    },
    // Phase 4A.4 — IV / liquidity / options quality (populated where data is available)
    ivSnapshot: {
      iv_rank_at_scan: null,
      iv_percentile_at_scan: null,
      option_spread_pct_at_scan:
        toNumberOrNull(strikeRow?.spreadPct) ??
        toNumberOrNull(strikeRow?.liquidity?.spreadPct) ??
        null,
      open_interest_at_scan:
        toNumberOrNull(strikeRow?.openInterest) ??
        toNumberOrNull(strikeRow?.liquidity?.openInterest) ??
        null,
      volume_at_scan:
        toNumberOrNull(strikeRow?.volume) ??
        toNumberOrNull(strikeRow?.liquidity?.volume) ??
        null,
      liquidity_score: computeLiquidityScore(
        toNumberOrNull(strikeRow?.bid),
        toNumberOrNull(strikeRow?.ask),
        toNumberOrNull(strikeRow?.spreadPct) ?? toNumberOrNull(strikeRow?.liquidity?.spreadPct),
        toNumberOrNull(strikeRow?.openInterest) ?? toNumberOrNull(strikeRow?.liquidity?.openInterest)
      ),
      options_quality_score: null,
    },
    resolution: buildResolutionDefaults(),
  };
}

function normalizeResolutionPatch(patch) {
  const resolved = typeof patch?.resolved === "boolean" ? patch.resolved : true;
  const expiredWorthless = toBooleanOrNull(patch?.expiredWorthless);
  const assigned = toBooleanOrNull(patch?.assigned);
  const expirationClosePrice = toNumberOrNull(patch?.expirationClosePrice);
  const minPriceBetweenScanAndExpiration = toNumberOrNull(patch?.minPriceBetweenScanAndExpiration);
  const resultStatus =
    patch?.resultStatus == null ? null : String(patch.resultStatus).trim() || null;
  const resolvedAt =
    resolved === true
      ? patch?.resolvedAt == null
        ? new Date().toISOString()
        : String(patch.resolvedAt).trim() || new Date().toISOString()
      : null;

  // Phase 2 — intrinsic value for manual patches if close price provided
  const strikeForPatch = toNumberOrNull(patch?.strike);
  const intrinsicValueAtExpiration =
    patch?.intrinsic_value_at_expiration != null
      ? toNumberOrNull(patch.intrinsic_value_at_expiration)
      : assigned === true && strikeForPatch != null && expirationClosePrice != null
      ? Number(Math.max(0, strikeForPatch - expirationClosePrice).toFixed(4))
      : null;

  return {
    resolved,
    expirationClosePrice,
    expiredWorthless,
    assigned,
    strikeTouched: toBooleanOrNull(patch?.strikeTouched),
    minPriceBetweenScanAndExpiration,
    brokeLowerBound: toBooleanOrNull(patch?.brokeLowerBound),
    maxItmDepth: toNumberOrNull(patch?.maxItmDepth),
    lowerBoundDistance: toNumberOrNull(patch?.lowerBoundDistance),
    supportBreak: toBooleanOrNull(patch?.supportBreak),
    drawdownPct: toNumberOrNull(patch?.drawdownPct),
    rolled: toBooleanOrNull(patch?.rolled),
    realizedPl: toNumberOrNull(patch?.realizedPl),
    premiumRealized: toNumberOrNull(patch?.premiumRealized),
    realizedReturnPct: toNumberOrNull(patch?.realizedReturnPct),
    popPredictionCorrect:
      resolved === true
        ? expiredWorthless === true
          ? true
          : expiredWorthless === false
          ? false
          : null
        : null,
    outcomeStatus: patch?.outcomeStatus == null ? null : String(patch.outcomeStatus).trim() || null,
    resultStatus,
    resolvedAt,
    resolutionDate:
      patch?.resolutionDate == null ? null : String(patch.resolutionDate).trim() || null,
    notes: patch?.notes == null ? null : String(patch.notes),
    // Phase 1 — manual resolution always has high confidence
    resolved_source: patch?.resolved_source ?? "manual",
    resolution_confidence: patch?.resolution_confidence ?? "high",
    missing_close_flag: expirationClosePrice == null,
    // Phase 2 — raw outcome from manual patch
    underlying_close_at_expiration:
      toNumberOrNull(patch?.underlying_close_at_expiration) ?? expirationClosePrice,
    underlying_low_between_scan_and_expiration:
      toNumberOrNull(patch?.underlying_low_between_scan_and_expiration) ?? minPriceBetweenScanAndExpiration,
    underlying_high_between_scan_and_expiration:
      toNumberOrNull(patch?.underlying_high_between_scan_and_expiration),
    expired_otm: expiredWorthless === true ? true : expiredWorthless === false ? false : null,
    expired_itm: expiredWorthless === false ? true : expiredWorthless === true ? false : null,
    assigned_flag: assigned,
    intrinsic_value_at_expiration: intrinsicValueAtExpiration,
    option_final_value: toNumberOrNull(patch?.option_final_value) ?? intrinsicValueAtExpiration,
    days_held: toNumberOrNull(patch?.days_held),
    // Phase 3 — resolution-time stress (pass through if provided in patch, otherwise null)
    false_safety_flag: patch?.false_safety_flag != null ? toBooleanOrNull(patch.false_safety_flag) : null,
    strike_touch_recovery_flag:
      patch?.strike_touch_recovery_flag != null
        ? toBooleanOrNull(patch.strike_touch_recovery_flag)
        : null,
    max_itm_depth_pct: toNumberOrNull(patch?.max_itm_depth_pct),
    lower_bound_distance_pct: toNumberOrNull(patch?.lower_bound_distance_pct),
    support_break_severity: toNumberOrNull(patch?.support_break_severity),
  };
}

function toExpirationYmd(value) {
  const compact = normalizeYmd(value);
  if (!compact) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

function isExpiredExpiration(expiration, todayYmd) {
  const expYmd = toExpirationYmd(expiration);
  if (!expYmd) return false;
  return expYmd < todayYmd;
}

function buildAutoResolvedOutcomeV1(record, closeNum, todayYmd, expirationYmd) {
  const strike = toNumberOrNull(record?.strike?.strike);
  if (strike == null) return null;
  const expiredWorthless = closeNum > strike;
  const assigned = !expiredWorthless;
  const premium = toNumberOrNull(record?.strike?.premium);
  const premiumRealized = premium == null ? null : Number((premium * 100).toFixed(2));
  const realizedPl = expiredWorthless === true ? premiumRealized : null;
  const realizedReturnPct =
    expiredWorthless === true && premiumRealized != null && strike > 0
      ? Number(((premiumRealized / (strike * 100)) * 100).toFixed(4))
      : null;
  const resultStatus = expiredWorthless ? "expired_worthless" : "assigned";

  // Phase 2 — intrinsic value at expiration (put)
  const intrinsicValueAtExpiration = assigned
    ? Number(Math.max(0, strike - closeNum).toFixed(4))
    : 0;
  const optionFinalValue = assigned ? intrinsicValueAtExpiration : 0;

  // Phase 2 — days held from scan date to expiration
  const scanDate = String(record?.scanDate ?? "").trim();
  let daysHeld = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(scanDate) && expirationYmd) {
    const scanMs = new Date(`${scanDate}T00:00:00.000Z`).getTime();
    const expMs = new Date(`${expirationYmd}T00:00:00.000Z`).getTime();
    if (!Number.isNaN(scanMs) && !Number.isNaN(expMs)) {
      daysHeld = Math.max(0, Math.round((expMs - scanMs) / 86400000));
    }
  }

  return {
    resolved: true,
    expirationClosePrice: closeNum,
    expiredWorthless,
    assigned,
    strikeTouched: null,
    minPriceBetweenScanAndExpiration: null,
    brokeLowerBound: null,
    maxItmDepth: null,
    lowerBoundDistance: null,
    supportBreak: null,
    drawdownPct: null,
    rolled: false,
    realizedPl,
    premiumRealized,
    realizedReturnPct,
    popPredictionCorrect: expiredWorthless === true,
    outcomeStatus: expiredWorthless ? "expired_worthless" : "assigned_theoretical",
    resultStatus,
    resolvedAt: new Date().toISOString(),
    resolutionDate: todayYmd,
    notes: `auto_resolved_from_yahoo_close_${expirationYmd}`,
    // Phase 1 — resolution traceability
    resolved_source: "auto_yahoo_close_v1",
    resolution_confidence: "medium",
    missing_close_flag: false,
    // Phase 2 — raw outcome
    underlying_close_at_expiration: closeNum,
    underlying_low_between_scan_and_expiration: null,
    underlying_high_between_scan_and_expiration: null,
    expired_otm: expiredWorthless,
    expired_itm: assigned,
    assigned_flag: assigned,
    intrinsic_value_at_expiration: intrinsicValueAtExpiration,
    option_final_value: optionFinalValue,
    days_held: daysHeld,
    // Phase 3 — resolution-time stress (no window data at v1)
    false_safety_flag: null,
    strike_touch_recovery_flag: null,
    max_itm_depth_pct: null,
    lower_bound_distance_pct: null,
    support_break_severity: null,
  };
}

function buildResolutionOutcomeV2(baseOutcome, record, historicalMetrics) {
  const strike = toNumberOrNull(record?.strike?.strike);
  const lowerBound = toNumberOrNull(record?.underlying?.lowerBound);
  const support = toNumberOrNull(record?.context?.support);
  const spotAtScan = toNumberOrNull(record?.underlying?.spotAtScan);
  const minPrice = toNumberOrNull(historicalMetrics?.minPriceBetweenScanAndExpiration);
  const maxPrice = toNumberOrNull(historicalMetrics?.maxPriceBetweenScanAndExpiration);
  const historicalUnavailable = historicalMetrics?.historicalUnavailable !== false;

  if (historicalUnavailable || minPrice == null || strike == null) {
    return {
      ...baseOutcome,
      // Phase 1 — confidence stays medium when no window data
      resolution_confidence: "medium",
      resolved_source: baseOutcome.resolved_source ?? "auto_yahoo_close_v1",
      strikeTouched: null,
      minPriceBetweenScanAndExpiration: null,
      underlying_low_between_scan_and_expiration: null,
      underlying_high_between_scan_and_expiration: null,
      maxItmDepth: null,
      brokeLowerBound: null,
      lowerBoundDistance: null,
      supportBreak: null,
      drawdownPct: null,
      // Phase 3 — stress unavailable without window data
      false_safety_flag: null,
      strike_touch_recovery_flag: null,
      max_itm_depth_pct: null,
      lower_bound_distance_pct: null,
      support_break_severity: null,
    };
  }

  const strikeTouched = minPrice <= strike;
  const maxItmDepth = strikeTouched ? Number((strike - minPrice).toFixed(4)) : 0;
  const brokeLowerBound = lowerBound != null ? minPrice < lowerBound : null;
  const lowerBoundDistance = lowerBound != null ? Number((minPrice - lowerBound).toFixed(4)) : null;
  const supportBreak = support != null ? minPrice < support : null;
  const drawdownPct =
    spotAtScan != null && spotAtScan > 0
      ? Number((((spotAtScan - minPrice) / spotAtScan) * 100).toFixed(4))
      : null;

  // Phase 3 — resolution-time stress metrics (only computable with window data)
  const maxItmDepthPct =
    strikeTouched && strike > 0
      ? Number((((strike - minPrice) / strike) * 100).toFixed(4))
      : null;
  const lowerBoundDistancePct =
    lowerBoundDistance != null && spotAtScan != null && spotAtScan > 0
      ? Number(((lowerBoundDistance / spotAtScan) * 100).toFixed(4))
      : null;
  const supportBreakSeverity =
    supportBreak === true && support != null && support > 0
      ? Number((((support - minPrice) / support) * 100).toFixed(4))
      : null;
  const falseSafetyFlag = !strikeTouched && brokeLowerBound === true;
  const strikeTouchRecoveryFlag = strikeTouched && baseOutcome.expiredWorthless === true;

  return {
    ...baseOutcome,
    // Phase 1 — upgrade confidence when historical window data is available
    resolution_confidence: "high",
    resolved_source: "auto_yahoo_close_v2",
    // Phase 2 — underlying low and high
    underlying_low_between_scan_and_expiration: Number(minPrice.toFixed(4)),
    underlying_high_between_scan_and_expiration: maxPrice != null ? Number(maxPrice.toFixed(4)) : null,
    strikeTouched,
    minPriceBetweenScanAndExpiration: Number(minPrice.toFixed(4)),
    maxItmDepth,
    brokeLowerBound,
    lowerBoundDistance,
    supportBreak,
    drawdownPct,
    // Phase 3 — resolution-time stress
    false_safety_flag: falseSafetyFlag,
    strike_touch_recovery_flag: strikeTouchRecoveryFlag,
    max_itm_depth_pct: maxItmDepthPct,
    lower_bound_distance_pct: lowerBoundDistancePct,
    support_break_severity: supportBreakSeverity,
  };
}

function getCalibrationIsCorrect(record) {
  if (record?.resolution?.popPredictionCorrect === true) return true;
  if (record?.resolution?.popPredictionCorrect === false) return false;
  if (record?.resolution?.expiredWorthless === true) return true;
  if (record?.resolution?.expiredWorthless === false) return false;
  return null;
}

function normalizePopToProbability(value) {
  const n = toNumberOrNull(value);
  if (n == null) return null;
  if (n > 1) return Math.max(0, Math.min(1, n / 100));
  return Math.max(0, Math.min(1, n));
}

function getFinalTradeQualityScore(record) {
  return (
    toNumberOrNull(record?.finalTradeQualityScore) ??
    toNumberOrNull(record?.scores?.finalTradeQualityScore) ??
    toNumberOrNull(record?.scoreBreakdown?.finalTradeQualityScore) ??
    null
  );
}

function summarizeCalibrationBucket(bucket, rows) {
  const confidenceWarning = rows.length < 30 ? "sampleSize < 30" : null;
  if (rows.length === 0) {
    return {
      bucket,
      sampleSize: 0,
      predictedAvgPop: null,
      actualWinRate: null,
      correctCount: 0,
      incorrectCount: 0,
      brierScore: null,
      confidenceWarning,
    };
  }

  const outcomes = rows
    .map((record) => getCalibrationIsCorrect(record))
    .filter((value) => typeof value === "boolean");
  const correctCount = outcomes.filter((value) => value === true).length;
  const incorrectCount = outcomes.filter((value) => value === false).length;
  const actualWinRate =
    outcomes.length > 0 ? (correctCount / outcomes.length) * 100 : null;

  const predictedProbabilities = rows
    .map((record) => normalizePopToProbability(record?.strike?.popEstimate))
    .filter((value) => value != null);
  const predictedAvgPop =
    predictedProbabilities.length > 0
      ? (predictedProbabilities.reduce((sum, value) => sum + value, 0) / predictedProbabilities.length) * 100
      : null;

  const brierPairs = rows
    .map((record) => {
      const predicted = normalizePopToProbability(record?.strike?.popEstimate);
      const isCorrect = getCalibrationIsCorrect(record);
      if (predicted == null || typeof isCorrect !== "boolean") return null;
      return { predicted, actual: isCorrect ? 1 : 0 };
    })
    .filter(Boolean);
  const brierScore =
    brierPairs.length > 0
      ? brierPairs.reduce((sum, pair) => sum + (pair.predicted - pair.actual) ** 2, 0) / brierPairs.length
      : null;

  return {
    bucket,
    sampleSize: rows.length,
    predictedAvgPop,
    actualWinRate,
    correctCount,
    incorrectCount,
    brierScore,
    confidenceWarning,
  };
}

function bucketizeCalibration(records, definitions, pickValue) {
  const buckets = definitions.map((definition) => ({
    bucket: definition.bucket,
    rows: [],
  }));

  for (const record of records) {
    const value = pickValue(record);
    let matched = false;
    for (let i = 0; i < definitions.length; i += 1) {
      if (definitions[i].match(value, record)) {
        buckets[i].rows.push(record);
        matched = true;
        break;
      }
    }
    if (!matched && buckets.length > 0) {
      buckets[buckets.length - 1].rows.push(record);
    }
  }

  return buckets.map((bucket) => summarizeCalibrationBucket(bucket.bucket, bucket.rows));
}

function summarizeV2Metrics(rows) {
  const resolvedRows = rows.filter((r) => r?.resolution?.resolved === true);
  const n = resolvedRows.length;
  const sampleSize = rows.length;
  const confidenceWarning = n < 30 ? "sampleSize < 30" : null;

  if (n === 0) {
    return {
      sampleSize,
      resolvedCount: 0,
      actualWinRate: null,
      strikeTouchRate: null,
      avgDrawdownPct: null,
      lowerBoundBreakRate: null,
      supportBreakRate: null,
      assignmentRate: null,
      avgPremium: null,
      premiumEfficiency: null,
      avgPop: null,
      confidenceWarning,
    };
  }

  const outcomes = resolvedRows
    .map((r) => getCalibrationIsCorrect(r))
    .filter((v) => typeof v === "boolean");
  const correctCount = outcomes.filter((v) => v === true).length;
  const actualWinRate = outcomes.length > 0 ? (correctCount / outcomes.length) * 100 : null;

  const strikeTouchedKnown = resolvedRows.filter((r) => r?.resolution?.strikeTouched != null);
  const strikeTouchRate =
    strikeTouchedKnown.length > 0
      ? (strikeTouchedKnown.filter((r) => r.resolution.strikeTouched === true).length /
          strikeTouchedKnown.length) *
        100
      : null;

  const drawdownValues = resolvedRows
    .map((r) => toNumberOrNull(r?.resolution?.drawdownPct))
    .filter((v) => v != null);
  const avgDrawdownPct =
    drawdownValues.length > 0
      ? drawdownValues.reduce((s, v) => s + v, 0) / drawdownValues.length
      : null;

  const lbKnown = resolvedRows.filter((r) => r?.resolution?.brokeLowerBound != null);
  const lowerBoundBreakRate =
    lbKnown.length > 0
      ? (lbKnown.filter((r) => r.resolution.brokeLowerBound === true).length / lbKnown.length) * 100
      : null;

  const sbKnown = resolvedRows.filter((r) => r?.resolution?.supportBreak != null);
  const supportBreakRate =
    sbKnown.length > 0
      ? (sbKnown.filter((r) => r.resolution.supportBreak === true).length / sbKnown.length) * 100
      : null;

  const assignedKnown = resolvedRows.filter((r) => r?.resolution?.assigned != null);
  const assignmentRate =
    assignedKnown.length > 0
      ? (assignedKnown.filter((r) => r.resolution.assigned === true).length / assignedKnown.length) *
        100
      : null;

  const premiums = resolvedRows
    .map((r) => toNumberOrNull(r?.strike?.premium))
    .filter((v) => v != null);
  const avgPremium =
    premiums.length > 0 ? premiums.reduce((s, v) => s + v, 0) / premiums.length : null;

  const strikes = resolvedRows
    .map((r) => toNumberOrNull(r?.strike?.strike))
    .filter((v) => v != null);
  const avgStrikeVal =
    strikes.length > 0 ? strikes.reduce((s, v) => s + v, 0) / strikes.length : null;

  const premiumEfficiency =
    avgPremium != null && avgStrikeVal != null && avgStrikeVal > 0
      ? (avgPremium / avgStrikeVal) * 100
      : null;

  const pops = resolvedRows
    .map((r) => normalizePopToProbability(r?.strike?.popEstimate))
    .filter((v) => v != null);
  const avgPop = pops.length > 0 ? (pops.reduce((s, v) => s + v, 0) / pops.length) * 100 : null;

  return {
    sampleSize,
    resolvedCount: n,
    actualWinRate,
    strikeTouchRate,
    avgDrawdownPct,
    lowerBoundBreakRate,
    supportBreakRate,
    assignmentRate,
    avgPremium,
    premiumEfficiency,
    avgPop,
    confidenceWarning,
  };
}

function bucketizeV2(records, definitions, pickValue) {
  const buckets = definitions.map((def) => ({ bucket: def.bucket, rows: [] }));
  for (const record of records) {
    const value = pickValue(record);
    let matched = false;
    for (let i = 0; i < definitions.length; i += 1) {
      if (definitions[i].match(value, record)) {
        buckets[i].rows.push(record);
        matched = true;
        break;
      }
    }
    if (!matched && buckets.length > 0) {
      buckets[buckets.length - 1].rows.push(record);
    }
  }
  return buckets.map((b) => ({ bucket: b.bucket, ...summarizeV2Metrics(b.rows) }));
}

function computeTickerCohortsV2(resolvedRecords) {
  const map = new Map();
  for (const record of resolvedRecords) {
    const ticker = normalizeSymbol(record?.symbol);
    if (!ticker) continue;
    if (!map.has(ticker)) map.set(ticker, []);
    map.get(ticker).push(record);
  }
  return Array.from(map.entries())
    .filter(([, rows]) => rows.length >= 3)
    .map(([ticker, rows]) => ({ ticker, ...summarizeV2Metrics(rows) }))
    .sort(
      (a, b) =>
        b.resolvedCount - a.resolvedCount ||
        Number(b.actualWinRate ?? -1) - Number(a.actualWinRate ?? -1)
    )
    .slice(0, 20);
}

function computeSectorCohortsV2(resolvedRecords) {
  const map = new Map();
  for (const record of resolvedRecords) {
    const sector =
      record?.sector ??
      record?.context?.sector ??
      record?.scores?.sector ??
      null;
    if (!sector) continue;
    const key = String(sector).trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(record);
  }
  return Array.from(map.entries())
    .filter(([, rows]) => rows.length >= 2)
    .map(([sector, rows]) => ({ sector, ...summarizeV2Metrics(rows) }))
    .sort((a, b) => b.resolvedCount - a.resolvedCount);
}

export function createWheelValidationService(options = {}) {
  const store = options.store ?? createWheelValidationStore(options.journalPath);
  const getHistoricalClose =
    typeof options.getHistoricalClose === "function" ? options.getHistoricalClose : null;
  const getHistoricalWindowMetrics =
    typeof options.getHistoricalWindowMetrics === "function" ? options.getHistoricalWindowMetrics : null;
  let writeChain = Promise.resolve();

  function withWriteLock(task) {
    const next = writeChain.then(task, task);
    writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  function buildRecordsFromCandidates(candidates, options = {}) {
    const scanTimestamp = normalizeIsoTimestamp(options.scanTimestamp);
    const scanSessionId =
      options.scanSessionId == null ? null : String(options.scanSessionId).trim() || null;
    const topN = Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30;
    const finalCandidates = Array.isArray(candidates) ? candidates.slice(0, topN) : [];
    const records = [];
    for (let index = 0; index < finalCandidates.length; index += 1) {
      const candidate = finalCandidates[index];
      const perCandidateOptions = {
        selectedExpiration: options.selectedExpiration,
        captureSource: options.captureSource,
        dteAtScan: options.dteAtScan,
        candidateRank: toNumberOrNull(candidate?.rank) ?? index + 1,
      };
      const safeRecord = normalizeRecord(candidate, "safe", scanTimestamp, scanSessionId, perCandidateOptions);
      if (safeRecord) records.push(safeRecord);
      const aggressiveRecord = normalizeRecord(
        candidate,
        "aggressive",
        scanTimestamp,
        scanSessionId,
        perCandidateOptions
      );
      if (aggressiveRecord) records.push(aggressiveRecord);
    }
    return records;
  }

  async function listJournal() {
    return store.load();
  }

  async function computeStats() {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const resolvedRecords = records.filter((record) => record?.resolution?.resolved === true);
    const unresolvedRecords = records.length - resolvedRecords.length;

    const avg = (values) => {
      const nums = values.map((v) => toNumberOrNull(v)).filter((v) => v != null);
      if (nums.length === 0) return null;
      return nums.reduce((sum, n) => sum + n, 0) / nums.length;
    };

    const successCount = resolvedRecords.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
    const overall = {
      successRate: resolvedRecords.length > 0 ? (successCount / resolvedRecords.length) * 100 : null,
      avgPopEstimate: avg(resolvedRecords.map((record) => record?.strike?.popEstimate)),
      avgEliteScore: avg(resolvedRecords.map((record) => record?.scores?.eliteScore)),
    };

    const groupResolved = (keyFn) => {
      const map = new Map();
      for (const record of resolvedRecords) {
        const key = keyFn(record);
        const normalizedKey = key == null || String(key).trim() === "" ? "unknown" : String(key).trim();
        if (!map.has(normalizedKey)) map.set(normalizedKey, []);
        map.get(normalizedKey).push(record);
      }
      return map;
    };

    const byDte = Array.from(groupResolved((record) => record?.dteAtScan).entries())
      .map(([dteAtScan, rows]) => {
        const success = rows.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
        return {
          dteAtScan: toNumberOrNull(dteAtScan),
          count: rows.length,
          successCount: success,
          failureCount: rows.length - success,
          successRate: rows.length > 0 ? (success / rows.length) * 100 : null,
          avgPopEstimate: avg(rows.map((record) => record?.strike?.popEstimate)),
          avgEliteScore: avg(rows.map((record) => record?.scores?.eliteScore)),
        };
      })
      .sort((a, b) => Number(a?.dteAtScan ?? 1e9) - Number(b?.dteAtScan ?? 1e9));

    const byStrikeMode = Array.from(groupResolved((record) => record?.strikeMode).entries())
      .map(([strikeMode, rows]) => {
        const success = rows.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
        return {
          strikeMode,
          count: rows.length,
          successRate: rows.length > 0 ? (success / rows.length) * 100 : null,
          avgPopEstimate: avg(rows.map((record) => record?.strike?.popEstimate)),
          avgPremium: avg(rows.map((record) => record?.strike?.premium)),
          avgEliteScore: avg(rows.map((record) => record?.scores?.eliteScore)),
        };
      })
      .sort((a, b) => String(a.strikeMode).localeCompare(String(b.strikeMode)));

    const byEliteBadge = Array.from(groupResolved((record) => record?.scores?.eliteBadge).entries())
      .map(([eliteBadge, rows]) => {
        const success = rows.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
        return {
          eliteBadge,
          count: rows.length,
          successRate: rows.length > 0 ? (success / rows.length) * 100 : null,
          avgPopEstimate: avg(rows.map((record) => record?.strike?.popEstimate)),
          avgEliteScore: avg(rows.map((record) => record?.scores?.eliteScore)),
        };
      })
      .sort((a, b) => b.count - a.count);

    const byExpirationCohort = Array.from(
      groupResolved((record) => record?.expirationCohort ?? toExpirationYmd(record?.expiration)).entries()
    )
      .map(([expirationCohort, rows]) => {
        const success = rows.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
        const assignedCount = rows.filter((record) => record?.resolution?.assigned === true).length;
        const expiredWorthlessCount = rows.filter(
          (record) => record?.resolution?.expiredWorthless === true
        ).length;
        return {
          expirationCohort,
          count: rows.length,
          successRate: rows.length > 0 ? (success / rows.length) * 100 : null,
          resolvedCount: rows.length,
          assignedCount,
          expiredWorthlessCount,
        };
      })
      .sort((a, b) => String(a.expirationCohort).localeCompare(String(b.expirationCohort)));

    const byTickerTop = Array.from(groupResolved((record) => record?.symbol).entries())
      .map(([symbol, rows]) => {
        const success = rows.filter((record) => record?.resolution?.popPredictionCorrect === true).length;
        return {
          symbol,
          count: rows.length,
          successRate: rows.length > 0 ? (success / rows.length) * 100 : null,
        };
      })
      .filter((row) => row.count >= 3)
      .sort((a, b) => b.count - a.count || Number(b.successRate ?? -1) - Number(a.successRate ?? -1))
      .slice(0, 20);

    return {
      totalRecords: records.length,
      resolvedRecords: resolvedRecords.length,
      unresolvedRecords,
      overall,
      byDte,
      byStrikeMode,
      byEliteBadge,
      byExpirationCohort,
      byTickerTop,
    };
  }

  async function computeCohortSummary() {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];

    const avg = (values) => {
      const nums = values.map((v) => toNumberOrNull(v)).filter((v) => v != null);
      if (nums.length === 0) return null;
      return nums.reduce((sum, n) => sum + n, 0) / nums.length;
    };

    const summarizeRows = (rows) => {
      const resolvedCount = rows.filter((record) => record?.resolution?.resolved === true).length;
      const symbols = new Set(
        rows.map((record) => normalizeSymbol(record?.symbol)).filter((symbol) => symbol)
      );
      return {
        candidateCount: rows.length,
        uniqueSymbols: symbols.size,
        unresolvedCount: rows.length - resolvedCount,
        resolvedCount,
        avgPopEstimate: avg(rows.map((record) => record?.strike?.popEstimate)),
        avgEliteScore: avg(rows.map((record) => record?.scores?.eliteScore)),
      };
    };

    const cohorts = new Map();
    for (const record of records) {
      const expirationCohort =
        record?.expirationCohort ?? toExpirationYmd(record?.expiration) ?? "unknown";
      const cohortKey = String(expirationCohort || "unknown").trim() || "unknown";
      if (!cohorts.has(cohortKey)) {
        cohorts.set(cohortKey, {
          expirationCohort: cohortKey,
          rows: [],
          dteBuckets: new Map(),
          scanSessions: new Map(),
        });
      }

      const cohort = cohorts.get(cohortKey);
      cohort.rows.push(record);

      const dteAtScan = toNumberOrNull(record?.dteAtScan);
      const dteKey = dteAtScan == null ? "unknown" : String(dteAtScan);
      if (!cohort.dteBuckets.has(dteKey)) {
        cohort.dteBuckets.set(dteKey, { dteAtScan, rows: [] });
      }
      cohort.dteBuckets.get(dteKey).rows.push(record);

      const sessionKey =
        String(record?.scanSessionId ?? record?.scanTimestamp ?? record?.scanDate ?? "unknown").trim() ||
        "unknown";
      if (!cohort.scanSessions.has(sessionKey)) {
        cohort.scanSessions.set(sessionKey, {
          scanSessionId: record?.scanSessionId ?? null,
          scanTimestamp: record?.scanTimestamp ?? null,
          scanDate: record?.scanDate ?? null,
          rows: [],
        });
      }
      cohort.scanSessions.get(sessionKey).rows.push(record);
    }

    return Array.from(cohorts.values())
      .map((cohort) => {
        const dteValues = cohort.rows
          .map((record) => toNumberOrNull(record?.dteAtScan))
          .filter((value) => value != null);
        const dteBuckets = Array.from(cohort.dteBuckets.values())
          .map((bucket) => ({
            dteAtScan: bucket.dteAtScan,
            ...summarizeRows(bucket.rows),
          }))
          .sort((a, b) => {
            const left = a.dteAtScan == null ? Number.POSITIVE_INFINITY : a.dteAtScan;
            const right = b.dteAtScan == null ? Number.POSITIVE_INFINITY : b.dteAtScan;
            return left - right;
          });
        const scanSessions = Array.from(cohort.scanSessions.values())
          .map((session) => ({
            scanSessionId: session.scanSessionId,
            scanTimestamp: session.scanTimestamp,
            scanDate: session.scanDate,
            ...summarizeRows(session.rows),
          }))
          .sort((a, b) => {
            const left = String(a.scanTimestamp ?? a.scanDate ?? "");
            const right = String(b.scanTimestamp ?? b.scanDate ?? "");
            return right.localeCompare(left);
          });

        return {
          expirationCohort: cohort.expirationCohort,
          scanCount: scanSessions.length,
          ...summarizeRows(cohort.rows),
          minDte: dteValues.length > 0 ? Math.min(...dteValues) : null,
          maxDte: dteValues.length > 0 ? Math.max(...dteValues) : null,
          dteBuckets,
          scanSessions,
        };
      })
      .sort((a, b) => String(a.expirationCohort).localeCompare(String(b.expirationCohort)));
  }

  async function computeCalibrationSummary() {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const resolvedRecords = records.filter((record) => record?.resolution?.resolved === true);
    const totalResolved = resolvedRecords.length;
    const totalUnresolved = records.length - totalResolved;

    // Calibration uses primaryDaily only — legacy (null captureClass) treated as primary for backward compat
    const calibrationRecords = resolvedRecords.filter(
      (r) => (r?.captureClass ?? "primaryDaily") !== "intradayRetest"
    );
    const totalIntradayRetestResolved = totalResolved - calibrationRecords.length;

    const popBuckets = bucketizeCalibration(
      calibrationRecords,
      [
        { bucket: "<80", match: (value) => value != null && value < 80 },
        { bucket: "80-85", match: (value) => value != null && value >= 80 && value < 85 },
        { bucket: "85-90", match: (value) => value != null && value >= 85 && value < 90 },
        { bucket: "90-95", match: (value) => value != null && value >= 90 && value < 95 },
        { bucket: "95-98", match: (value) => value != null && value >= 95 && value < 98 },
        { bucket: "98+", match: (value) => value != null && value >= 98 },
      ],
      (record) => {
        const probability = normalizePopToProbability(record?.strike?.popEstimate);
        return probability == null ? null : probability * 100;
      }
    );

    const dteBuckets = bucketizeCalibration(
      calibrationRecords,
      [
        { bucket: "0-3", match: (value) => value != null && value >= 0 && value <= 3 },
        { bucket: "4-7", match: (value) => value != null && value >= 4 && value <= 7 },
        { bucket: "8-14", match: (value) => value != null && value >= 8 && value <= 14 },
        { bucket: "15-30", match: (value) => value != null && value >= 15 && value <= 30 },
        { bucket: "31+", match: (value) => value != null && value >= 31 },
      ],
      (record) => toNumberOrNull(record?.dteAtScan)
    );

    const strikeModeBuckets = bucketizeCalibration(
      calibrationRecords,
      [
        { bucket: "safe", match: (_value, record) => String(record?.strikeMode ?? "").trim().toLowerCase() === "safe" },
        {
          bucket: "aggressive",
          match: (_value, record) =>
            String(record?.strikeMode ?? "").trim().toLowerCase() === "aggressive",
        },
        { bucket: "unknown", match: () => true },
      ],
      () => null
    );

    const ftqsBuckets = bucketizeCalibration(
      calibrationRecords.filter((record) => getFinalTradeQualityScore(record) != null),
      [
        { bucket: "<60", match: (value) => value != null && value < 60 },
        { bucket: "60-70", match: (value) => value != null && value >= 60 && value < 70 },
        { bucket: "70-80", match: (value) => value != null && value >= 70 && value < 80 },
        { bucket: "80-90", match: (value) => value != null && value >= 80 && value < 90 },
        { bucket: "90+", match: (value) => value != null && value >= 90 },
      ],
      (record) => getFinalTradeQualityScore(record)
    );

    const popBucketsV2 = bucketizeV2(
      calibrationRecords,
      [
        { bucket: "<80", match: (value) => value != null && value < 80 },
        { bucket: "80-85", match: (value) => value != null && value >= 80 && value < 85 },
        { bucket: "85-90", match: (value) => value != null && value >= 85 && value < 90 },
        { bucket: "90-95", match: (value) => value != null && value >= 90 && value < 95 },
        { bucket: "95-98", match: (value) => value != null && value >= 95 && value < 98 },
        { bucket: "98+", match: (value) => value != null && value >= 98 },
      ],
      (record) => {
        const p = normalizePopToProbability(record?.strike?.popEstimate);
        return p == null ? null : p * 100;
      }
    );

    const dteBucketsV2 = bucketizeV2(
      calibrationRecords,
      [
        { bucket: "0-3", match: (value) => value != null && value >= 0 && value <= 3 },
        { bucket: "4-7", match: (value) => value != null && value >= 4 && value <= 7 },
        { bucket: "8-14", match: (value) => value != null && value >= 8 && value <= 14 },
        { bucket: "15-30", match: (value) => value != null && value >= 15 && value <= 30 },
        { bucket: "31+", match: (value) => value != null && value >= 31 },
      ],
      (record) => toNumberOrNull(record?.dteAtScan)
    );

    const strikeModeV2 = bucketizeV2(
      calibrationRecords,
      [
        {
          bucket: "safe",
          match: (_v, r) => String(r?.strikeMode ?? "").trim().toLowerCase() === "safe",
        },
        {
          bucket: "aggressive",
          match: (_v, r) => String(r?.strikeMode ?? "").trim().toLowerCase() === "aggressive",
        },
        { bucket: "unknown", match: () => true },
      ],
      () => null
    );

    const ftqsBucketsV2 = bucketizeV2(
      calibrationRecords.filter((r) => getFinalTradeQualityScore(r) != null),
      [
        { bucket: "<60", match: (value) => value != null && value < 60 },
        { bucket: "60-70", match: (value) => value != null && value >= 60 && value < 70 },
        { bucket: "70-80", match: (value) => value != null && value >= 70 && value < 80 },
        { bucket: "80-90", match: (value) => value != null && value >= 80 && value < 90 },
        { bucket: "90+", match: (value) => value != null && value >= 90 },
      ],
      (record) => getFinalTradeQualityScore(record)
    );

    const tickerCohorts = computeTickerCohortsV2(calibrationRecords);
    const sectorCohorts = computeSectorCohortsV2(calibrationRecords);

    return {
      totalRecords: records.length,
      totalResolved,
      totalUnresolved,
      totalResolvedPrimary: calibrationRecords.length,
      totalIntradayRetestResolved,
      hasResolvedRecords: totalResolved > 0,
      popBuckets,
      dteBuckets,
      strikeModeBuckets,
      ftqsBuckets,
      hasFtqsData: ftqsBuckets.some((bucket) => bucket.sampleSize > 0),
      v2: {
        popBucketsV2,
        dteBucketsV2,
        strikeModeV2,
        ftqsBucketsV2,
        tickerCohorts,
        sectorCohorts,
        hasSectorData: sectorCohorts.length > 0,
        hasFtqsV2Data: ftqsBucketsV2.some((b) => b.resolvedCount > 0),
      },
    };
  }

  async function captureFromCandidates(candidates, options = {}) {
    return withWriteLock(async () => {
      const journal = await store.load();
      const records = buildRecordsFromCandidates(candidates, options);
      if (records.length === 0) {
        return {
          captured: 0,
          duplicates: 0,
          skipped: 0,
          primaryDailyCount: 0,
          intradayRetestCount: 0,
          requestedTopN: Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30,
          records: [],
          journal,
        };
      }

      const existingIds = new Set(
        journal.records.map((record) => String(record?.id ?? "").trim()).filter(Boolean)
      );

      // Build (scanDate|expirationCohort|captureSource) combinations already in journal
      const existingCombinations = new Set();
      for (const record of journal.records) {
        const sd = String(record?.scanDate ?? "").trim();
        const ec = String(record?.expirationCohort ?? "").trim();
        const cs = String(record?.captureSource ?? "").trim();
        if (sd) existingCombinations.add(`${sd}|${ec}|${cs}`);
      }

      const captureClassOverride =
        options.captureClass == null ? null : String(options.captureClass).trim() || null;

      const uniqueRecords = [];
      let duplicates = 0;
      let intradayRetestCount = 0;
      let primaryDailyCount = 0;
      for (const record of records) {
        if (existingIds.has(record.id)) {
          duplicates += 1;
          continue;
        }
        existingIds.add(record.id);

        let captureClass;
        if (captureClassOverride) {
          captureClass = captureClassOverride;
        } else {
          const key = `${record.scanDate}|${String(record.expirationCohort ?? "")}|${String(record.captureSource ?? "")}`;
          captureClass = existingCombinations.has(key) ? "intradayRetest" : "primaryDaily";
        }
        record.captureClass = captureClass;
        // Phase 1 — flag intraday retests as duplicate candidates (soft flag, not suppressed)
        if (captureClass === "intradayRetest") {
          record.duplicate_candidate_flag = true;
          intradayRetestCount += 1;
        } else {
          primaryDailyCount += 1;
        }

        uniqueRecords.push(record);
      }

      if (uniqueRecords.length > 0) {
        journal.records.push(...uniqueRecords);
        journal.updatedAt = new Date().toISOString();
        await store.save(journal);
      }

      return {
        captured: uniqueRecords.length,
        duplicates,
        skipped: records.length - uniqueRecords.length,
        requestedTopN: Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30,
        primaryDailyCount,
        intradayRetestCount,
        records: uniqueRecords,
        journal: uniqueRecords.length > 0 ? journal : await store.load(),
      };
    });
  }

  async function patchResolution(id, patch) {
    return withWriteLock(async () => {
      const journal = await store.load();
      const normalizedId = String(id ?? "").trim();
      const index = journal.records.findIndex((record) => String(record?.id ?? "").trim() === normalizedId);
      if (index < 0) {
        const error = new Error("wheel_validation_record_not_found");
        error.code = "NOT_FOUND";
        throw error;
      }

      const existing = journal.records[index];
      const nextResolution = normalizeResolutionPatch(patch);
      journal.records[index] = {
        ...existing,
        resolution: nextResolution,
      };
      journal.updatedAt = new Date().toISOString();
      await store.save(journal);
      return journal.records[index];
    });
  }

  async function resolveExpiredRecords(options = {}) {
    return withWriteLock(async () => {
      const todayYmd = normalizeIsoTimestamp(options.today ?? new Date()).slice(0, 10);
      const journal = await store.load();
      const records = Array.isArray(journal?.records) ? journal.records : [];
      const errors = [];
      const scannedRecords = records.length;
      let skippedResolved = 0;
      let skippedNotExpired = 0;
      let skippedNoClose = 0;
      let skippedInvalidRecord = 0;
      let resolved = 0;
      let touchedCount = 0;
      let lowerBoundBreakCount = 0;
      let supportBreakCount = 0;
      let historicalUnavailableCount = 0;
      let v2ResolvedCount = 0;
      if (!getHistoricalClose) {
        const skippedRecords = scannedRecords;
        return {
          scannedRecords,
          resolvedRecords: resolved,
          skippedRecords,
          skippedBreakdown: {
            alreadyResolved: skippedResolved,
            notExpired: skippedNotExpired,
            noClose: skippedNoClose,
            invalidRecord: skippedInvalidRecord,
          },
          resolved,
          skippedNotExpired: records.length,
          skippedNoClose,
          errors: ["historical_close_provider_unavailable"],
          touchedCount,
          lowerBoundBreakCount,
          supportBreakCount,
          historicalUnavailableCount: scannedRecords,
          v2ResolvedCount,
          groupsChecked: 0,
        };
      }

      const groups = new Map();
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record?.resolution?.resolved === true) {
          skippedResolved += 1;
          continue;
        }
        const symbol = normalizeSymbol(record?.symbol);
        const expirationYmd = toExpirationYmd(record?.expiration);
        if (!symbol || !expirationYmd) {
          skippedInvalidRecord += 1;
          continue;
        }
        if (!(expirationYmd < todayYmd)) {
          skippedNotExpired += 1;
          continue;
        }
        const key = `${symbol}_${expirationYmd}`;
        if (!groups.has(key)) groups.set(key, { symbol, expirationYmd, indices: [] });
        groups.get(key).indices.push(i);
      }

      let groupsChecked = 0;
      for (const group of groups.values()) {
        groupsChecked += 1;
        let close = null;
        try {
          close = await getHistoricalClose(group.symbol, group.expirationYmd);
        } catch (error) {
          errors.push(`${group.symbol} ${group.expirationYmd}: ${error?.message || String(error)}`);
          continue;
        }
        const closeNum = toNumberOrNull(close);
        if (closeNum == null) {
          skippedNoClose += group.indices.length;
          continue;
        }

        let historicalBySymbolExpiration = {
          historicalUnavailable: true,
          minPriceBetweenScanAndExpiration: null,
        };
        if (getHistoricalWindowMetrics) {
          try {
            for (const index of group.indices) {
              const record = records[index];
              const scanDate = String(record?.scanDate ?? "").trim();
              if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDate)) continue;
              historicalBySymbolExpiration = await getHistoricalWindowMetrics(
                group.symbol,
                scanDate,
                group.expirationYmd
              );
              break;
            }
          } catch (_error) {
            historicalBySymbolExpiration = {
              historicalUnavailable: true,
              minPriceBetweenScanAndExpiration: null,
            };
          }
        }

        for (const index of group.indices) {
          const existing = records[index];
          const baseOutcome = buildAutoResolvedOutcomeV1(existing, closeNum, todayYmd, group.expirationYmd);
          if (!baseOutcome) {
            skippedNoClose += 1;
            continue;
          }
          const outcome = buildResolutionOutcomeV2(baseOutcome, existing, historicalBySymbolExpiration);
          records[index] = {
            ...existing,
            resolution: outcome,
          };
          resolved += 1;
          v2ResolvedCount += 1;
          if (outcome?.strikeTouched === true) touchedCount += 1;
          if (outcome?.brokeLowerBound === true) lowerBoundBreakCount += 1;
          if (outcome?.supportBreak === true) supportBreakCount += 1;
          if (outcome?.minPriceBetweenScanAndExpiration == null) historicalUnavailableCount += 1;
        }
      }

      if (resolved > 0) {
        journal.updatedAt = new Date().toISOString();
        await store.save(journal);
      }

      const skippedRecords = scannedRecords - resolved;
      return {
        scannedRecords,
        resolvedRecords: resolved,
        skippedRecords,
        skippedBreakdown: {
          alreadyResolved: skippedResolved,
          notExpired: skippedNotExpired,
          noClose: skippedNoClose,
          invalidRecord: skippedInvalidRecord,
        },
        resolved,
        skippedNotExpired,
        skippedNoClose,
        errors,
        touchedCount,
        lowerBoundBreakCount,
        supportBreakCount,
        historicalUnavailableCount,
        v2ResolvedCount,
        groupsChecked,
      };
    });
  }

  async function computeModeComparison() {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];

    function modeStats(modeRecords) {
      const totalRecords = modeRecords.length;
      const resolvedRecs = modeRecords.filter((r) => r?.resolution?.resolved === true);
      const resolvedCount = resolvedRecs.length;
      const unresolvedRecords = totalRecords - resolvedCount;

      const assignedCount = resolvedRecs.filter((r) =>
        r?.resolution?.assigned_flag === true ||
        (r?.resolution?.assigned_flag == null && r?.resolution?.assigned === true)
      ).length;
      const assignedRatePct = resolvedCount > 0 ? (assignedCount / resolvedCount) * 100 : null;

      const expiredOtmCount = resolvedRecs.filter((r) =>
        r?.resolution?.expired_otm === true || r?.resolution?.expiredWorthless === true
      ).length;
      const expiredOtmRatePct = resolvedCount > 0 ? (expiredOtmCount / resolvedCount) * 100 : null;

      const stTouchKnown = resolvedRecs.filter((r) => r?.resolution?.strikeTouched != null);
      const strikeTouchedCount = stTouchKnown.filter((r) => r?.resolution?.strikeTouched === true).length;
      const strikeTouchedRatePct = stTouchKnown.length > 0 ? (strikeTouchedCount / stTouchKnown.length) * 100 : null;

      const lbKnown = resolvedRecs.filter((r) => r?.resolution?.brokeLowerBound != null);
      const brokeLowerBoundCount = lbKnown.filter((r) => r?.resolution?.brokeLowerBound === true).length;
      const brokeLowerBoundRatePct = lbKnown.length > 0 ? (brokeLowerBoundCount / lbKnown.length) * 100 : null;

      const avg = (fn) => {
        const vals = resolvedRecs.map(fn).filter((v) => v != null);
        return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
      };

      return {
        total_records: totalRecords,
        resolved_records: resolvedCount,
        unresolved_records: unresolvedRecords,
        assigned_count: assignedCount,
        assigned_rate_pct: assignedRatePct,
        expired_otm_count: expiredOtmCount,
        expired_otm_rate_pct: expiredOtmRatePct,
        strike_touched_count: strikeTouchedCount,
        strike_touched_rate_pct: strikeTouchedRatePct,
        broke_lower_bound_count: brokeLowerBoundCount,
        broke_lower_bound_rate_pct: brokeLowerBoundRatePct,
        avg_premium: avg((r) => toNumberOrNull(r?.strike?.premium)),
        avg_yield_pct: avg((r) => toNumberOrNull(r?.strike?.annualizedYield)),
        avg_pop_estimate: avg((r) => {
          const n = toNumberOrNull(r?.strike?.popEstimate);
          if (n == null) return null;
          return n > 1 ? n : n * 100;
        }),
        avg_distance_strike_pct: avg((r) => toNumberOrNull(r?.snapshot?.distance_strike_from_spot_pct)),
        avg_spread_pct: avg((r) => toNumberOrNull(r?.strike?.spreadPct)),
        avg_drawdown_pct: avg((r) => toNumberOrNull(r?.resolution?.drawdownPct)),
        avg_max_itm_depth_pct: avg((r) => toNumberOrNull(r?.resolution?.max_itm_depth_pct)),
        avg_data_quality_score: avg((r) => toNumberOrNull(r?.stress?.data_quality_score)),
      };
    }

    const safeRecords = records.filter((r) => r?.strikeMode === "safe");
    const aggRecords = records.filter((r) => r?.strikeMode === "aggressive");
    const safe = modeStats(safeRecords);
    const aggressive = modeStats(aggRecords);

    const assignmentRateDeltaPct =
      safe.assigned_rate_pct != null && aggressive.assigned_rate_pct != null
        ? aggressive.assigned_rate_pct - safe.assigned_rate_pct
        : null;
    const premiumDeltaDollar =
      safe.avg_premium != null && aggressive.avg_premium != null
        ? aggressive.avg_premium - safe.avg_premium
        : null;

    let aggressiveRiskVerdict;
    if (safe.resolved_records < 10 || aggressive.resolved_records < 10) {
      aggressiveRiskVerdict = "insufficient_data";
    } else if (assignmentRateDeltaPct != null && assignmentRateDeltaPct > 5 && premiumDeltaDollar != null && premiumDeltaDollar > 0) {
      aggressiveRiskVerdict = "higher_risk_partially_compensated";
    } else if (assignmentRateDeltaPct != null && assignmentRateDeltaPct > 5) {
      aggressiveRiskVerdict = "higher_risk_not_compensated";
    } else if (assignmentRateDeltaPct != null && assignmentRateDeltaPct <= 2) {
      aggressiveRiskVerdict = "similar_risk";
    } else {
      aggressiveRiskVerdict = "moderate_risk_delta";
    }

    const comparison = {
      assignmentRateDeltaPct,
      otmRateDeltaPct:
        safe.expired_otm_rate_pct != null && aggressive.expired_otm_rate_pct != null
          ? aggressive.expired_otm_rate_pct - safe.expired_otm_rate_pct
          : null,
      premiumDeltaDollar,
      yieldDeltaPct:
        safe.avg_yield_pct != null && aggressive.avg_yield_pct != null
          ? aggressive.avg_yield_pct - safe.avg_yield_pct
          : null,
      popDeltaPct:
        safe.avg_pop_estimate != null && aggressive.avg_pop_estimate != null
          ? aggressive.avg_pop_estimate - safe.avg_pop_estimate
          : null,
      distanceDeltaPct:
        safe.avg_distance_strike_pct != null && aggressive.avg_distance_strike_pct != null
          ? aggressive.avg_distance_strike_pct - safe.avg_distance_strike_pct
          : null,
      strikeTouchedDeltaPct:
        safe.strike_touched_rate_pct != null && aggressive.strike_touched_rate_pct != null
          ? aggressive.strike_touched_rate_pct - safe.strike_touched_rate_pct
          : null,
      aggressiveRiskVerdict,
    };

    const tickerMap = new Map();
    for (const record of records) {
      const symbol = normalizeSymbol(record?.symbol);
      if (!symbol) continue;
      if (!tickerMap.has(symbol)) tickerMap.set(symbol, { safe: [], aggressive: [] });
      const mode = record?.strikeMode;
      if (mode === "safe") tickerMap.get(symbol).safe.push(record);
      else if (mode === "aggressive") tickerMap.get(symbol).aggressive.push(record);
    }

    const byTicker = Array.from(tickerMap.entries())
      .filter(([, { safe: sr, aggressive: ar }]) => sr.length > 0 && ar.length > 0)
      .map(([symbol, { safe: sr, aggressive: ar }]) => {
        const avgOf = (recs, fn) => {
          const vals = recs.map(fn).filter((v) => v != null);
          return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        };
        const safeResolved = sr.filter((r) => r?.resolution?.resolved === true);
        const aggResolved = ar.filter((r) => r?.resolution?.resolved === true);

        const safeAssigned = safeResolved.filter((r) =>
          r?.resolution?.assigned_flag === true ||
          (r?.resolution?.assigned_flag == null && r?.resolution?.assigned === true)
        ).length;
        const aggAssigned = aggResolved.filter((r) =>
          r?.resolution?.assigned_flag === true ||
          (r?.resolution?.assigned_flag == null && r?.resolution?.assigned === true)
        ).length;

        const safeAssignedRatePct = safeResolved.length > 0 ? (safeAssigned / safeResolved.length) * 100 : null;
        const aggAssignedRatePct = aggResolved.length > 0 ? (aggAssigned / aggResolved.length) * 100 : null;

        const safeAvgPremium = avgOf(safeResolved, (r) => toNumberOrNull(r?.strike?.premium));
        const aggAvgPremium = avgOf(aggResolved, (r) => toNumberOrNull(r?.strike?.premium));
        const safeAvgYieldPct = avgOf(safeResolved, (r) => toNumberOrNull(r?.strike?.annualizedYield));
        const aggAvgYieldPct = avgOf(aggResolved, (r) => toNumberOrNull(r?.strike?.annualizedYield));

        const safeOtmCount = safeResolved.filter((r) =>
          r?.resolution?.expired_otm === true || r?.resolution?.expiredWorthless === true
        ).length;
        const aggOtmCount = aggResolved.filter((r) =>
          r?.resolution?.expired_otm === true || r?.resolution?.expiredWorthless === true
        ).length;

        const safeTouchKnown = safeResolved.filter((r) => r?.resolution?.strikeTouched != null);
        const aggTouchKnown = aggResolved.filter((r) => r?.resolution?.strikeTouched != null);

        const sampleSizeStatus =
          safeResolved.length >= 3 && aggResolved.length >= 3 ? "ok" : "faible";

        return {
          symbol,
          safe_total: sr.length,
          aggressive_total: ar.length,
          safe_resolved: safeResolved.length,
          aggressive_resolved: aggResolved.length,
          safe_assigned_rate_pct: safeAssignedRatePct,
          aggressive_assigned_rate_pct: aggAssignedRatePct,
          assignment_delta_pct:
            safeAssignedRatePct != null && aggAssignedRatePct != null
              ? aggAssignedRatePct - safeAssignedRatePct
              : null,
          safe_avg_premium: safeAvgPremium,
          aggressive_avg_premium: aggAvgPremium,
          premium_delta:
            safeAvgPremium != null && aggAvgPremium != null
              ? aggAvgPremium - safeAvgPremium
              : null,
          safe_avg_yield_pct: safeAvgYieldPct,
          aggressive_avg_yield_pct: aggAvgYieldPct,
          yield_delta_pct:
            safeAvgYieldPct != null && aggAvgYieldPct != null
              ? aggAvgYieldPct - safeAvgYieldPct
              : null,
          safe_otm_rate_pct: safeResolved.length > 0 ? (safeOtmCount / safeResolved.length) * 100 : null,
          aggressive_otm_rate_pct: aggResolved.length > 0 ? (aggOtmCount / aggResolved.length) * 100 : null,
          safe_strike_touched_rate_pct: safeTouchKnown.length > 0
            ? (safeTouchKnown.filter((r) => r.resolution.strikeTouched === true).length / safeTouchKnown.length) * 100
            : null,
          aggressive_strike_touched_rate_pct: aggTouchKnown.length > 0
            ? (aggTouchKnown.filter((r) => r.resolution.strikeTouched === true).length / aggTouchKnown.length) * 100
            : null,
          sample_size_status: sampleSizeStatus,
        };
      })
      .sort((a, b) => {
        if (a.sample_size_status !== b.sample_size_status) {
          return a.sample_size_status === "ok" ? -1 : 1;
        }
        const totalA = a.safe_resolved + a.aggressive_resolved;
        const totalB = b.safe_resolved + b.aggressive_resolved;
        return totalB - totalA;
      });

    // byTickerDte: group records by (symbol, dteAtScan) then compare SAFE vs AGGRESSIVE
    const tickerDteMap = new Map();
    for (const record of records) {
      const symbol = normalizeSymbol(record?.symbol);
      const dte = toNumberOrNull(record?.dteAtScan);
      if (!symbol || dte == null) continue;
      const key = `${symbol}__${dte}`;
      if (!tickerDteMap.has(key)) tickerDteMap.set(key, { symbol, dteAtScan: dte, safe: [], aggressive: [] });
      const mode = record?.strikeMode;
      if (mode === "safe") tickerDteMap.get(key).safe.push(record);
      else if (mode === "aggressive") tickerDteMap.get(key).aggressive.push(record);
    }

    const byTickerDte = Array.from(tickerDteMap.values())
      .filter(({ safe: sr, aggressive: ar }) => sr.length > 0 || ar.length > 0)
      .map(({ symbol, dteAtScan, safe: sr, aggressive: ar }) => {
        const avgOf = (recs, fn) => {
          const vals = recs.map(fn).filter((v) => v != null);
          return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        };

        const safeResolved = sr.filter((r) => r?.resolution?.resolved === true);
        const aggResolved = ar.filter((r) => r?.resolution?.resolved === true);

        // Most common scan day of week across all records in the group
        const dayCounts = new Map();
        for (const r of [...sr, ...ar]) {
          const info = getScanDayInfo(r?.scanDate);
          if (info.dow != null) {
            const k = String(info.dow);
            dayCounts.set(k, { count: (dayCounts.get(k)?.count ?? 0) + 1, label: info.label, dow: info.dow });
          }
        }
        let scanDayLabel = "Inconnu";
        let scanDayOfWeek = null;
        if (dayCounts.size > 0) {
          const best = Array.from(dayCounts.values()).sort((a, b) => b.count - a.count)[0];
          scanDayLabel = best.label;
          scanDayOfWeek = best.dow;
        }

        const safeAssigned = safeResolved.filter((r) =>
          r?.resolution?.assigned_flag === true ||
          (r?.resolution?.assigned_flag == null && r?.resolution?.assigned === true)
        ).length;
        const aggAssigned = aggResolved.filter((r) =>
          r?.resolution?.assigned_flag === true ||
          (r?.resolution?.assigned_flag == null && r?.resolution?.assigned === true)
        ).length;

        const safeAssignedRatePct = safeResolved.length > 0 ? (safeAssigned / safeResolved.length) * 100 : null;
        const aggAssignedRatePct = aggResolved.length > 0 ? (aggAssigned / aggResolved.length) * 100 : null;

        const safeAvgPremium = avgOf(safeResolved, (r) => toNumberOrNull(r?.strike?.premium));
        const aggAvgPremium = avgOf(aggResolved, (r) => toNumberOrNull(r?.strike?.premium));
        const safeAvgYieldPct = avgOf(safeResolved, (r) => toNumberOrNull(r?.strike?.annualizedYield));
        const aggAvgYieldPct = avgOf(aggResolved, (r) => toNumberOrNull(r?.strike?.annualizedYield));

        // Weekly yield estimate: premium / strike * 7 / max(dteAtScan, 1) * 100
        const safeWeeklyYieldPct = avgOf(safeResolved, (r) => {
          const prem = toNumberOrNull(r?.strike?.premium);
          const stk = toNumberOrNull(r?.strike?.strike);
          const dte = toNumberOrNull(r?.dteAtScan) ?? dteAtScan;
          if (prem == null || stk == null || stk <= 0) return null;
          return (prem / stk) * (7 / Math.max(dte, 1)) * 100;
        });
        const aggWeeklyYieldPct = avgOf(aggResolved, (r) => {
          const prem = toNumberOrNull(r?.strike?.premium);
          const stk = toNumberOrNull(r?.strike?.strike);
          const dte = toNumberOrNull(r?.dteAtScan) ?? dteAtScan;
          if (prem == null || stk == null || stk <= 0) return null;
          return (prem / stk) * (7 / Math.max(dte, 1)) * 100;
        });

        const safeOtmCount = safeResolved.filter((r) =>
          r?.resolution?.expired_otm === true || r?.resolution?.expiredWorthless === true
        ).length;
        const aggOtmCount = aggResolved.filter((r) =>
          r?.resolution?.expired_otm === true || r?.resolution?.expiredWorthless === true
        ).length;

        const safeTouchKnown = safeResolved.filter((r) => r?.resolution?.strikeTouched != null);
        const aggTouchKnown = aggResolved.filter((r) => r?.resolution?.strikeTouched != null);
        const safeLbKnown = safeResolved.filter((r) => r?.resolution?.brokeLowerBound != null);
        const aggLbKnown = aggResolved.filter((r) => r?.resolution?.brokeLowerBound != null);

        const premiumDelta =
          safeAvgPremium != null && aggAvgPremium != null ? aggAvgPremium - safeAvgPremium : null;
        const weeklyYieldDelta =
          safeWeeklyYieldPct != null && aggWeeklyYieldPct != null
            ? aggWeeklyYieldPct - safeWeeklyYieldPct
            : null;
        const sampleSizeStatus =
          safeResolved.length >= 3 && aggResolved.length >= 3 ? "ok" : "faible";

        return {
          symbol,
          dteAtScan,
          scanDayLabel,
          scanDayOfWeek,
          safe_total: sr.length,
          aggressive_total: ar.length,
          safe_resolved: safeResolved.length,
          aggressive_resolved: aggResolved.length,
          safe_assigned_rate_pct: safeAssignedRatePct,
          aggressive_assigned_rate_pct: aggAssignedRatePct,
          assignment_delta_pct:
            safeAssignedRatePct != null && aggAssignedRatePct != null
              ? aggAssignedRatePct - safeAssignedRatePct
              : null,
          safe_avg_premium: safeAvgPremium,
          aggressive_avg_premium: aggAvgPremium,
          premium_delta: premiumDelta,
          safe_avg_yield_pct: safeAvgYieldPct,
          aggressive_avg_yield_pct: aggAvgYieldPct,
          yield_delta_pct:
            safeAvgYieldPct != null && aggAvgYieldPct != null
              ? aggAvgYieldPct - safeAvgYieldPct
              : null,
          safe_avg_weekly_yield_pct: safeWeeklyYieldPct,
          aggressive_avg_weekly_yield_pct: aggWeeklyYieldPct,
          weekly_yield_delta_pct: weeklyYieldDelta,
          safe_otm_rate_pct:
            safeResolved.length > 0 ? (safeOtmCount / safeResolved.length) * 100 : null,
          aggressive_otm_rate_pct:
            aggResolved.length > 0 ? (aggOtmCount / aggResolved.length) * 100 : null,
          safe_strike_touched_rate_pct:
            safeTouchKnown.length > 0
              ? (safeTouchKnown.filter((r) => r.resolution.strikeTouched === true).length /
                  safeTouchKnown.length) *
                100
              : null,
          aggressive_strike_touched_rate_pct:
            aggTouchKnown.length > 0
              ? (aggTouchKnown.filter((r) => r.resolution.strikeTouched === true).length /
                  aggTouchKnown.length) *
                100
              : null,
          safe_broke_lower_bound_rate_pct:
            safeLbKnown.length > 0
              ? (safeLbKnown.filter((r) => r.resolution.brokeLowerBound === true).length /
                  safeLbKnown.length) *
                100
              : null,
          aggressive_broke_lower_bound_rate_pct:
            aggLbKnown.length > 0
              ? (aggLbKnown.filter((r) => r.resolution.brokeLowerBound === true).length /
                  aggLbKnown.length) *
                100
              : null,
          sample_size_status: sampleSizeStatus,
        };
      })
      .sort((a, b) => {
        if (a.sample_size_status !== b.sample_size_status) return a.sample_size_status === "ok" ? -1 : 1;
        const symCmp = a.symbol.localeCompare(b.symbol);
        if (symCmp !== 0) return symCmp;
        return a.dteAtScan - b.dteAtScan;
      });

    return {
      generatedAt: new Date().toISOString(),
      modes: { safe, aggressive },
      comparison,
      byTicker,
      byTickerDte,
    };
  }

  async function computePremiumStability(options = {}) {
    const journal = await store.load();
    const allRecords = Array.isArray(journal?.records) ? journal.records : [];
    const tickerFilter = normalizeSymbol(options?.ticker);
    const requestedMode = String(options?.mode ?? "all").trim().toLowerCase();
    const modeFilter = requestedMode === "safe" || requestedMode === "aggressive" ? requestedMode : "all";
    const limitRaw = toNumberOrNull(options?.limit);
    const limit = limitRaw != null ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50000) : 5000;

    const filteredRecords = allRecords
      .filter((record) => {
        const symbol = normalizeSymbol(record?.symbol ?? record?.ticker);
        if (!symbol) return false;
        if (tickerFilter && symbol !== tickerFilter) return false;
        if (modeFilter !== "all" && String(record?.strikeMode ?? "").trim().toLowerCase() !== modeFilter) return false;
        return true;
      })
      .sort((a, b) => getLatestTimestamp(b) - getLatestTimestamp(a))
      .slice(0, limit);

    const usableRecords = filteredRecords
      .map((record) => {
        const premium = getPremiumCandidate(record);
        const symbol = normalizeSymbol(record?.symbol ?? record?.ticker);
        const strikeMode = String(record?.strikeMode ?? "").trim().toLowerCase();
        const dteAtScan = toNumberOrNull(record?.dteAtScan);
        if (!symbol || !strikeMode || dteAtScan == null || premium == null) return null;
        return {
          record,
          symbol,
          strikeMode,
          dteAtScan,
          premium,
          resolved: getResolvedFlag(record),
          assigned: getAssignedFlag(record),
          expiredOtm: getExpiredOtmFlag(record),
          strikeTouched: getStrikeTouchedFlag(record),
          brokeLowerBound: getBrokeLowerBoundFlag(record),
          latestTimestamp: getLatestTimestamp(record),
        };
      })
      .filter(Boolean);

    const groupMap = new Map();
    for (const item of usableRecords) {
      const key = `${item.symbol}__${item.strikeMode}__${item.dteAtScan}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          ticker: item.symbol,
          strikeMode: item.strikeMode,
          dteAtScan: item.dteAtScan,
          rows: [],
        });
      }
      groupMap.get(key).rows.push(item);
    }

    const buildRate = (rows, selector, useKnownDenominator = false) => {
      const source = useKnownDenominator ? rows.filter((row) => selector(row) != null) : rows;
      if (source.length === 0) return null;
      const count = source.filter((row) => selector(row) === true).length;
      return (count / source.length) * 100;
    };

    const groups = Array.from(groupMap.values()).map((group) => {
      const premiums = group.rows.map((row) => row.premium);
      const avgPremium = average(premiums);
      const medianPremium = median(premiums);
      const minPremium = premiums.length > 0 ? Math.min(...premiums) : null;
      const maxPremium = premiums.length > 0 ? Math.max(...premiums) : null;
      const stddevPremium = stddevPopulation(premiums, avgPremium);
      const coefficientVariationPct =
        avgPremium != null && avgPremium !== 0 && stddevPremium != null
          ? (stddevPremium / avgPremium) * 100
          : null;
      const premiumsPerDay = group.rows.map((row) => row.premium / Math.max(row.dteAtScan, 1));
      const resolvedRows = group.rows.filter((row) => row.resolved === true);
      const latest = [...group.rows].sort((a, b) => b.latestTimestamp - a.latestTimestamp)[0] ?? null;
      const sampleCount = group.rows.length;
      const resolvedCount = resolvedRows.length;
      const sampleQuality =
        sampleCount < 5 ? "faible" : sampleCount < 15 ? "moyen" : "bon";
      const stabilityLabel =
        sampleCount < 5
          ? "\u00e9chantillon faible"
          : coefficientVariationPct == null
          ? "\u00e9chantillon faible"
          : coefficientVariationPct <= 20
          ? "stable"
          : coefficientVariationPct <= 40
          ? "variable"
          : "volatile";
      const normalRangeLow = medianPremium != null ? medianPremium * 0.85 : null;
      const normalRangeHigh = medianPremium != null ? medianPremium * 1.15 : null;
      const latestPremium = latest?.premium ?? null;
      const latestVsMedianPct =
        latestPremium != null && medianPremium != null && medianPremium !== 0
          ? ((latestPremium - medianPremium) / medianPremium) * 100
          : null;
      const spikeCount =
        medianPremium != null
          ? group.rows.filter((row) => row.premium > medianPremium * 1.35).length
          : 0;
      const lowAnomalyCount =
        medianPremium != null
          ? group.rows.filter((row) => row.premium < medianPremium * 0.7).length
          : 0;

      let reading = "Prime normale";
      if (sampleCount < 5) reading = "\u00c9chantillon faible";
      else if (latestPremium != null && normalRangeLow != null && latestPremium >= normalRangeLow && latestPremium <= (normalRangeHigh ?? Infinity)) {
        reading = "Prime dans la zone normale";
      } else if (latestPremium != null && normalRangeHigh != null && latestPremium > normalRangeHigh) {
        reading = "Prime sup\u00e9rieure \u00e0 la normale";
      } else if (latestPremium != null && normalRangeLow != null && latestPremium < normalRangeLow) {
        reading = "Prime inf\u00e9rieure \u00e0 la normale";
      }

      return {
        ticker: group.ticker,
        strikeMode: group.strikeMode,
        dteAtScan: group.dteAtScan,
        sample_count: sampleCount,
        resolved_count: resolvedCount,
        avg_premium: roundMetric(avgPremium),
        median_premium: roundMetric(medianPremium),
        min_premium: roundMetric(minPremium),
        max_premium: roundMetric(maxPremium),
        stddev_premium: roundMetric(stddevPremium),
        coefficient_variation_pct: roundMetric(coefficientVariationPct, 2),
        avg_premium_per_day: roundMetric(average(premiumsPerDay)),
        median_premium_per_day: roundMetric(median(premiumsPerDay)),
        assigned_rate_pct: roundMetric(buildRate(resolvedRows, (row) => row.assigned), 2),
        otm_rate_pct: roundMetric(buildRate(resolvedRows, (row) => row.expiredOtm), 2),
        strike_touched_rate_pct: roundMetric(buildRate(resolvedRows, (row) => row.strikeTouched, true), 2),
        broke_lower_bound_rate_pct: roundMetric(buildRate(resolvedRows, (row) => row.brokeLowerBound, true), 2),
        stability_label: stabilityLabel,
        sample_quality: sampleQuality,
        normal_range_low: roundMetric(normalRangeLow),
        normal_range_high: roundMetric(normalRangeHigh),
        latest_premium: roundMetric(latestPremium),
        latest_scan_date: latest?.record?.scanDate ?? latest?.record?.scanTimestamp ?? null,
        latest_vs_median_pct: roundMetric(latestVsMedianPct, 2),
        spike_count: spikeCount,
        low_anomaly_count: lowAnomalyCount,
        practical_entry_score: 0,
        reading,
      };
    });

    const pairMap = new Map();
    for (const group of groups) {
      const key = `${group.ticker}__${group.strikeMode}`;
      if (!pairMap.has(key)) pairMap.set(key, []);
      pairMap.get(key).push(group);
    }

    for (const list of pairMap.values()) {
      const perDayValues = list
        .map((group) => toNumberOrNull(group.median_premium_per_day))
        .filter((value) => value != null);
      const maxPerDay = perDayValues.length > 0 ? Math.max(...perDayValues) : null;
      for (const group of list) {
        const medianPerDay = toNumberOrNull(group.median_premium_per_day);
        const premiumScore =
          maxPerDay != null && maxPerDay > 0 && medianPerDay != null
            ? Math.max(0, Math.min(40, (medianPerDay / maxPerDay) * 40))
            : 0;
        const stabilityScore =
          group.stability_label === "stable"
            ? 25
            : group.stability_label === "variable"
            ? 15
            : group.stability_label === "volatile"
            ? 5
            : 5;
        const assignedRate = toNumberOrNull(group.assigned_rate_pct);
        const assignmentScore =
          assignedRate == null
            ? 12
            : assignedRate <= 5
            ? 20
            : assignedRate <= 15
            ? 12
            : assignedRate <= 30
            ? 6
            : 0;
        const sampleScore =
          group.sample_quality === "bon" ? 15 : group.sample_quality === "moyen" ? 8 : 2;
        group.practical_entry_score = Math.round(
          Math.max(0, Math.min(100, premiumScore + stabilityScore + assignmentScore + sampleScore))
        );
      }
    }

    groups.sort((a, b) => {
      const tickerCmp = String(a.ticker).localeCompare(String(b.ticker));
      if (tickerCmp !== 0) return tickerCmp;
      const modeCmp = String(a.strikeMode).localeCompare(String(b.strikeMode));
      if (modeCmp !== 0) return modeCmp;
      return Number(a.dteAtScan ?? 1e9) - Number(b.dteAtScan ?? 1e9);
    });

    const recommendedWindows = Array.from(pairMap.entries())
      .map(([, list]) => {
        const rows = [...list].sort((a, b) => Number(a.dteAtScan ?? 1e9) - Number(b.dteAtScan ?? 1e9));
        const theoreticalBest = [...rows].sort((a, b) => {
          const scoreDelta = (b.practical_entry_score ?? -Infinity) - (a.practical_entry_score ?? -Infinity);
          if (scoreDelta !== 0) return scoreDelta;
          const perDayDelta =
            (toNumberOrNull(b.median_premium_per_day) ?? -Infinity) -
            (toNumberOrNull(a.median_premium_per_day) ?? -Infinity);
          if (perDayDelta !== 0) return perDayDelta;
          return Number(a.dteAtScan ?? 1e9) - Number(b.dteAtScan ?? 1e9);
        })[0] ?? null;

        const bestMedianPremium = Math.max(
          ...rows.map((row) => toNumberOrNull(row.median_premium) ?? 0)
        );
        const admissibleRows = rows.filter((row) => {
          const medianPremium = toNumberOrNull(row.median_premium);
          const assignedRate = toNumberOrNull(row.assigned_rate_pct);
          if (medianPremium == null || bestMedianPremium <= 0) return false;
          if (medianPremium < bestMedianPremium * 0.9) return false;
          if (row.stability_label !== "stable" && row.stability_label !== "variable") return false;
          if (assignedRate != null && assignedRate > 15) return false;
          if (row.sample_count < 5) return false;
          return true;
        });

        const practicalBest = admissibleRows[0] ?? theoreticalBest;
        const recommendedSet = admissibleRows.length > 0 ? admissibleRows : practicalBest ? [practicalBest] : [];
        const dtes = recommendedSet
          .map((row) => toNumberOrNull(row.dteAtScan))
          .filter((value) => value != null)
          .sort((a, b) => a - b);
        const minDte = dtes.length > 0 ? dtes[0] : null;
        const maxDte = dtes.length > 0 ? dtes[dtes.length - 1] : null;
        const recommendedRange =
          minDte == null
            ? null
            : minDte === maxDte
            ? `DTE ${minDte}`
            : `DTE ${minDte}-${maxDte}`;

        let reason = "Donn\u00e9es insuffisantes";
        if (practicalBest && theoreticalBest) {
          const theoreticalDte = toNumberOrNull(theoreticalBest.dteAtScan);
          const practicalDte = toNumberOrNull(practicalBest.dteAtScan);
          const bestMedian = toNumberOrNull(theoreticalBest.median_premium);
          const practicalMedian = toNumberOrNull(practicalBest.median_premium);
          if (
            practicalDte != null &&
            theoreticalDte != null &&
            practicalDte > theoreticalDte &&
            bestMedian != null &&
            practicalMedian != null &&
            bestMedian > 0
          ) {
            const pct = (practicalMedian / bestMedian) * 100;
            reason = `Prime proche du meilleur niveau (${pct.toFixed(0)}% du pic), avec stabilit\u00e9 correcte et risque d'assignation contenu.`;
          } else if (practicalBest.stability_label === "stable") {
            reason = "Prime dans une zone normale stable, utile pour entrer plus t\u00f4t sans attendre un DTE extr\u00eame.";
          } else if (practicalBest.stability_label === "variable") {
            reason = "Prime encore exploitable, mais avec variabilit\u00e9 mod\u00e9r\u00e9e.";
          } else {
            reason = "Meilleur compromis disponible sur l'\u00e9chantillon actuel.";
          }
        }

        return {
          ticker: rows[0]?.ticker ?? null,
          strikeMode: rows[0]?.strikeMode ?? null,
          recommended_dte_range: recommendedRange,
          theoretical_best_dte: theoreticalBest?.dteAtScan ?? null,
          practical_best_dte: practicalBest?.dteAtScan ?? null,
          reason,
          dte_groups: rows.map((row) => ({
            dteAtScan: row.dteAtScan,
            median_premium: row.median_premium,
            median_premium_per_day: row.median_premium_per_day,
            assigned_rate_pct: row.assigned_rate_pct,
            stability_label: row.stability_label,
            practical_entry_score: row.practical_entry_score,
          })),
        };
      })
      .filter((row) => row.ticker && row.strikeMode)
      .sort((a, b) => {
        const tickerCmp = String(a.ticker).localeCompare(String(b.ticker));
        if (tickerCmp !== 0) return tickerCmp;
        return String(a.strikeMode).localeCompare(String(b.strikeMode));
      });

    const summary = {
      groups_total: groups.length,
      tickers_count: new Set(groups.map((group) => group.ticker)).size,
      records_used: usableRecords.length,
      stable_groups_count: groups.filter((group) => group.stability_label === "stable").length,
      volatile_groups_count: groups.filter((group) => group.stability_label === "volatile").length,
      weak_sample_groups_count: groups.filter((group) => group.sample_quality === "faible").length,
    };

    return {
      generatedAt: new Date().toISOString(),
      filters: {
        ticker: tickerFilter || null,
        mode: modeFilter,
        limit,
      },
      summary,
      groups,
      recommendedWindows,
    };
  }

  async function computeTickerRanking(options = {}) {
    const journal = await store.load();
    const allRecords = Array.isArray(journal?.records) ? journal.records : [];

    const tickerFilter = normalizeSymbol(options?.ticker ?? "");
    const requestedMode = String(options?.mode ?? "all").trim().toLowerCase();
    const modeFilter = requestedMode === "safe" || requestedMode === "aggressive" ? requestedMode : "all";
    const limit = Math.min(Math.max(toNumberOrNull(options?.limit) ?? 50, 1), 100);
    const minSample = Math.max(toNumberOrNull(options?.minSample) ?? 3, 1);
    const theoreticalCycles = Array.isArray(options?.theoreticalCycles) ? options.theoreticalCycles : [];

    // ── Group ALL records by ticker (no early filter — scores must use global refs) ──
    const tickerRecordsMap = new Map();
    for (const record of allRecords) {
      const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
      if (!ticker) continue;
      if (!tickerRecordsMap.has(ticker)) tickerRecordsMap.set(ticker, []);
      tickerRecordsMap.get(ticker).push(record);
    }

    // ── CC data by ticker ────────────────────────────────────────────────────
    const ccMap = new Map();
    for (const cycle of theoreticalCycles) {
      const ticker = normalizeSymbol(cycle?.ticker);
      if (!ticker) continue;
      if (!ccMap.has(ticker)) ccMap.set(ticker, []);
      ccMap.get(ticker).push(cycle);
    }

    // ── Stability groups by (ticker, mode, dte) ──────────────────────────────
    const stabilityGroupMap = new Map();
    for (const [ticker, records] of tickerRecordsMap.entries()) {
      for (const record of records) {
        const premium = getPremiumCandidate(record);
        const strikeMode = String(record?.strikeMode ?? "").trim().toLowerCase();
        const dteAtScan = toNumberOrNull(record?.dteAtScan);
        if (!strikeMode || dteAtScan == null || premium == null) continue;
        const key = `${ticker}__${strikeMode}__${dteAtScan}`;
        if (!stabilityGroupMap.has(key)) {
          stabilityGroupMap.set(key, { ticker, strikeMode, dteAtScan, rows: [] });
        }
        stabilityGroupMap.get(key).rows.push({
          premium,
          resolved: getResolvedFlag(record),
          assigned: getAssignedFlag(record),
          expiredOtm: getExpiredOtmFlag(record),
          strikeTouched: getStrikeTouchedFlag(record),
          brokeLowerBound: getBrokeLowerBoundFlag(record),
        });
      }
    }

    const buildRateLocal = (rows, sel, useKnown = false) => {
      const src = useKnown ? rows.filter((r) => sel(r) != null) : rows;
      if (src.length === 0) return null;
      return (src.filter((r) => sel(r) === true).length / src.length) * 100;
    };

    const stabilityGroups = Array.from(stabilityGroupMap.values()).map((group) => {
      const premiums = group.rows.map((r) => r.premium);
      const avgPremium = average(premiums);
      const medianPremium = median(premiums);
      const stddevPremium = stddevPopulation(premiums, avgPremium);
      const cv = avgPremium != null && avgPremium !== 0 && stddevPremium != null
        ? (stddevPremium / avgPremium) * 100 : null;
      const premiumsPerDay = group.rows.map((r) => r.premium / Math.max(group.dteAtScan, 1));
      const medianPerDay = median(premiumsPerDay);
      const sampleCount = group.rows.length;
      const resolvedRows = group.rows.filter((r) => r.resolved);
      const stabilityLabel = sampleCount < 5 ? "échantillon faible"
        : cv == null ? "échantillon faible"
        : cv <= 20 ? "stable"
        : cv <= 40 ? "variable"
        : "volatile";
      const sampleQuality = sampleCount < 5 ? "faible" : sampleCount < 15 ? "moyen" : "bon";
      return {
        ticker: group.ticker,
        strikeMode: group.strikeMode,
        dteAtScan: group.dteAtScan,
        sampleCount,
        resolvedCount: resolvedRows.length,
        medianPremium,
        medianPerDay,
        stabilityLabel,
        sampleQuality,
        assignedRate: buildRateLocal(resolvedRows, (r) => r.assigned),
        strikeTouchedRate: buildRateLocal(resolvedRows, (r) => r.strikeTouched, true),
        brokeLowerBoundRate: buildRateLocal(resolvedRows, (r) => r.brokeLowerBound, true),
        otmRate: buildRateLocal(resolvedRows, (r) => r.expiredOtm),
      };
    });

    // Group stability results by (ticker, mode)
    const tickerModeMap = new Map();
    for (const g of stabilityGroups) {
      const key = `${g.ticker}__${g.strikeMode}`;
      if (!tickerModeMap.has(key)) tickerModeMap.set(key, []);
      tickerModeMap.get(key).push(g);
    }

    function computeDteWindow(groups) {
      if (groups.length === 0) {
        return { recommendedDteRange: null, theoreticalBestDte: null, practicalBestDte: null };
      }
      const rows = [...groups].sort((a, b) => Number(a.dteAtScan ?? 0) - Number(b.dteAtScan ?? 0));
      const theoreticalBest = [...rows].sort((a, b) => {
        const pa = a.medianPerDay ?? -Infinity;
        const pb = b.medianPerDay ?? -Infinity;
        if (pb !== pa) return pb - pa;
        return Number(a.dteAtScan ?? 1e9) - Number(b.dteAtScan ?? 1e9);
      })[0] ?? null;
      const bestMedian = Math.max(0, ...rows.map((g) => g.medianPremium ?? 0).filter(Number.isFinite));
      const admissible = rows.filter((g) => {
        if (!g.medianPremium || bestMedian <= 0) return false;
        if (g.medianPremium < bestMedian * 0.9) return false;
        if (g.stabilityLabel !== "stable" && g.stabilityLabel !== "variable") return false;
        if (g.assignedRate != null && g.assignedRate > 15) return false;
        if (g.sampleCount < 5) return false;
        return true;
      });
      const practicalBest = admissible[0] ?? theoreticalBest;
      const set = admissible.length > 0 ? admissible : practicalBest ? [practicalBest] : [];
      const dtes = set.map((g) => g.dteAtScan).filter((v) => v != null).sort((a, b) => a - b);
      const minDte = dtes[0] ?? null;
      const maxDte = dtes[dtes.length - 1] ?? null;
      const range = minDte == null ? null
        : minDte === maxDte ? `DTE ${minDte}`
        : `DTE ${minDte}-${maxDte}`;
      return {
        recommendedDteRange: range,
        theoreticalBestDte: theoreticalBest?.dteAtScan ?? null,
        practicalBestDte: practicalBest?.dteAtScan ?? null,
      };
    }

    // ── Execution quality: compute spread metrics from stored records ─────────
    function computeExecutionData(tickerRecords) {
      const spreadPctValues = [];
      let validBidAskCount = 0;
      const totalCount = tickerRecords.length;

      for (const record of tickerRecords) {
        const bid = toNumberOrNull(record?.strike?.bid);
        const ask = toNumberOrNull(record?.strike?.ask);
        const mid = toNumberOrNull(record?.strike?.mid);

        // Primary: stored spreadPct — normalize fraction vs percent
        const rawSp = toNumberOrNull(record?.strike?.spreadPct) ??
          toNumberOrNull(record?.ivSnapshot?.option_spread_pct_at_scan);
        let spreadFrac = rawSp == null ? null : rawSp > 1 ? rawSp / 100 : rawSp;

        // Fallback: compute from bid/ask
        if (spreadFrac == null && bid != null && ask != null && bid >= 0 && ask > 0) {
          const midCalc = mid != null && mid > 0 ? mid : (bid + ask) / 2;
          if (midCalc > 0) spreadFrac = (ask - bid) / midCalc;
        }

        // Clamp to sane range (< 10 = 1000% spread, clearly bad data)
        if (spreadFrac != null && spreadFrac >= 0 && spreadFrac < 10) {
          spreadPctValues.push(spreadFrac * 100);
        }

        if (bid != null && bid > 0 && ask != null && ask > 0) validBidAskCount++;
      }

      return {
        medianSpreadPct: median(spreadPctValues),
        avgSpreadPct: average(spreadPctValues),
        bidAskCoveragePct: totalCount > 0 ? (validBidAskCount / totalCount) * 100 : null,
        recordsWithValidBidAsk: validBidAskCount,
        hasSpreadData: spreadPctValues.length > 0,
      };
    }

    // ── Per-ticker summaries ─────────────────────────────────────────────────
    const preSummaries = Array.from(tickerRecordsMap.entries()).map(([ticker, tickerRecords]) => {
      const totalSample = tickerRecords.length;
      if (totalSample < minSample) return null;

      const resolvedRecords = tickerRecords.filter((r) => getResolvedFlag(r));
      const safeRecords = tickerRecords.filter((r) => String(r?.strikeMode ?? "").toLowerCase() === "safe");
      const aggRecords = tickerRecords.filter((r) => String(r?.strikeMode ?? "").toLowerCase() === "aggressive");
      const safeResolved = safeRecords.filter((r) => getResolvedFlag(r));
      const aggResolved = aggRecords.filter((r) => getResolvedFlag(r));

      const assignedCount = resolvedRecords.filter((r) => getAssignedFlag(r) === true).length;
      const assignmentRatePct = resolvedRecords.length > 0 ? (assignedCount / resolvedRecords.length) * 100 : null;

      const otmCount = resolvedRecords.filter((r) => getExpiredOtmFlag(r) === true).length;
      const otmRatePct = resolvedRecords.length > 0 ? (otmCount / resolvedRecords.length) * 100 : null;

      const stTouchKnown = resolvedRecords.filter((r) => getStrikeTouchedFlag(r) != null);
      const strikeTouchedRatePct = stTouchKnown.length > 0
        ? (stTouchKnown.filter((r) => getStrikeTouchedFlag(r) === true).length / stTouchKnown.length) * 100
        : null;

      const lbKnown = resolvedRecords.filter((r) => getBrokeLowerBoundFlag(r) != null);
      const brokeLowerBoundRatePct = lbKnown.length > 0
        ? (lbKnown.filter((r) => getBrokeLowerBoundFlag(r) === true).length / lbKnown.length) * 100
        : null;

      const safeGroups = tickerModeMap.get(`${ticker}__safe`) ?? [];
      const aggGroups = tickerModeMap.get(`${ticker}__aggressive`) ?? [];
      const allGroups = [...safeGroups, ...aggGroups];

      const bestGroup = [...allGroups].sort((a, b) => (b.medianPerDay ?? -Infinity) - (a.medianPerDay ?? -Infinity))[0] ?? null;
      const stabilityLabel = bestGroup?.stabilityLabel ?? "échantillon faible";
      const sampleQuality = totalSample < 5 ? "faible" : totalSample < 15 ? "moyen" : "bon";
      const medianPremium = bestGroup?.medianPremium ?? null;
      const medianPerDay = bestGroup?.medianPerDay ?? null;

      const safeWindow = computeDteWindow(safeGroups);
      const aggWindow = computeDteWindow(aggGroups);

      const safeAvgPremium = safeResolved.length > 0
        ? average(safeResolved.map((r) => getPremiumCandidate(r)).filter((v) => v != null))
        : null;
      const aggAvgPremium = aggResolved.length > 0
        ? average(aggResolved.map((r) => getPremiumCandidate(r)).filter((v) => v != null))
        : null;
      const safeAssignRate = safeResolved.length > 0
        ? (safeResolved.filter((r) => getAssignedFlag(r) === true).length / safeResolved.length) * 100
        : null;
      const aggAssignRate = aggResolved.length > 0
        ? (aggResolved.filter((r) => getAssignedFlag(r) === true).length / aggResolved.length) * 100
        : null;

      let preferredMode = "À confirmer";
      if (safeResolved.length >= 3 && aggResolved.length >= 3) {
        const premiumDelta = safeAvgPremium != null && aggAvgPremium != null ? aggAvgPremium - safeAvgPremium : null;
        const assignDelta = safeAssignRate != null && aggAssignRate != null ? aggAssignRate - safeAssignRate : null;
        if (premiumDelta != null && assignDelta != null) {
          if (premiumDelta > 0 && assignDelta <= 5) {
            preferredMode = "AGRESSIF";
          } else if (assignDelta > 5) {
            preferredMode = "SAFE";
          }
        }
      } else if (safeRecords.length > 0 && aggRecords.length === 0) {
        preferredMode = "SAFE";
      } else if (aggRecords.length > 0 && safeRecords.length === 0) {
        preferredMode = "AGRESSIF";
      }

      let recommendedWindow;
      if (preferredMode === "AGRESSIF" && aggWindow.recommendedDteRange) {
        recommendedWindow = aggWindow;
      } else if (safeWindow.recommendedDteRange) {
        recommendedWindow = safeWindow;
      } else {
        recommendedWindow = aggWindow;
      }

      const ccCycles = ccMap.get(ticker) ?? [];
      const ccStats = ccCycles.length > 0 ? (() => {
        const total = ccCycles.length;
        const sold = ccCycles.filter((c) => Number(c?.first_cc_step?.cc_sold_theoretical) === 1);
        const premiums = sold
          .map((c) => { const p = toNumberOrNull(c?.first_cc_step?.premium_conservative); return p != null ? p * 100 : null; })
          .filter((v) => v != null);
        const yields = sold.map((c) => toNumberOrNull(c?.first_cc_step?.cc_yield_conservative_pct)).filter((v) => v != null);
        return {
          total,
          soldCount: sold.length,
          ccSellableRatePct: (sold.length / total) * 100,
          avgCcPremiumPerContract: premiums.length > 0 ? average(premiums) : null,
          avgCcYieldPct: yields.length > 0 ? average(yields) : null,
        };
      })() : null;

      const executionData = computeExecutionData(tickerRecords);

      return {
        ticker, totalSample, resolvedCount: resolvedRecords.length,
        safeResolvedCount: safeResolved.length, aggResolvedCount: aggResolved.length,
        assignmentRatePct, otmRatePct, strikeTouchedRatePct, brokeLowerBoundRatePct,
        medianPremium, medianPerDay, stabilityLabel, sampleQuality,
        preferredMode, recommendedWindow, safeWindow, aggWindow, ccStats, executionData,
      };
    }).filter(Boolean);

    // ── Percentile-based premium normalization (cap at p90 to resist outliers) ──
    function localPercentile(sorted, pct) {
      if (sorted.length === 0) return null;
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
      return sorted[idx];
    }
    const sortedPerDay = preSummaries
      .map((t) => t.medianPerDay)
      .filter((v) => v != null && Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const sortedPremium = preSummaries
      .map((t) => t.medianPremium)
      .filter((v) => v != null && Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const p90PerDay = localPercentile(sortedPerDay, 90) ?? (sortedPerDay.length > 0 ? sortedPerDay[sortedPerDay.length - 1] : null);
    const p90Premium = localPercentile(sortedPremium, 90) ?? (sortedPremium.length > 0 ? sortedPremium[sortedPremium.length - 1] : null);

    // ── Score per ticker — V2-L-D weights: 30/25/15/15/10/5 ─────────────────
    const rankingItems = preSummaries.map((t) => {

      // ── RISK SCORE: 30 pts ────────────────────────────────────────────────
      const ar = t.assignmentRatePct;
      const assignmentScore = ar == null ? 6 : ar <= 5 ? 12 : ar <= 10 ? 10 : ar <= 15 ? 8 : ar <= 25 ? 5 : 2;

      const otm = t.otmRatePct;
      const otmScore = otm == null ? 4 : otm >= 95 ? 8 : otm >= 90 ? 7 : otm >= 80 ? 5 : otm >= 70 ? 3 : 1;

      const st = t.strikeTouchedRatePct;
      const strikeTouchScore = st == null ? 2 : st <= 5 ? 5 : st <= 15 ? 4 : st <= 30 ? 2 : 0;

      const lb = t.brokeLowerBoundRatePct;
      const lowerBoundScore = lb == null ? 2 : lb <= 5 ? 5 : lb <= 15 ? 4 : lb <= 30 ? 2 : 0;

      const riskScore = Math.min(30, Math.max(0, assignmentScore + otmScore + strikeTouchScore + lowerBoundScore));

      // ── PREMIUM SCORE: 25 pts (percentile-normalized, p90 cap) ───────────
      const perDayNorm = p90PerDay != null && p90PerDay > 0 && t.medianPerDay != null
        ? Math.min(1, t.medianPerDay / p90PerDay) : 0;
      const premNorm = p90Premium != null && p90Premium > 0 && t.medianPremium != null
        ? Math.min(1, t.medianPremium / p90Premium) : 0;
      const premiumMetric = 0.6 * perDayNorm + 0.4 * premNorm;
      const premiumScore = Math.round(Math.min(25, Math.max(0, premiumMetric * 25)));

      // ── STABILITY SCORE: 15 pts ───────────────────────────────────────────
      const stabMap = { stable: 15, variable: 9, volatile: 3, "échantillon faible": 5 };
      const stabilityScore = stabMap[t.stabilityLabel] ?? 5;
      const sampleQualityTicker = t.totalSample >= 30 ? "bon" : t.totalSample >= 15 ? "moyen" : "faible";

      // ── EXECUTION QUALITY SCORE: 15 pts ──────────────────────────────────
      const exec = t.executionData;
      let executionQualityScore, executionQualityLabel;
      if (!exec.hasSpreadData) {
        executionQualityScore = 5;
        executionQualityLabel = "Données spread manquantes";
      } else {
        const msp = exec.medianSpreadPct;
        if (msp <= 5) {
          executionQualityScore = 15; executionQualityLabel = "Exécution bonne";
        } else if (msp <= 10) {
          executionQualityScore = 12; executionQualityLabel = "Exécution correcte";
        } else if (msp <= 20) {
          executionQualityScore = 8; executionQualityLabel = "Spread large";
        } else if (msp <= 35) {
          executionQualityScore = 4; executionQualityLabel = "Spread très large";
        } else {
          executionQualityScore = 0; executionQualityLabel = "Spread très large";
        }
        // Additional penalty if bid/ask coverage is very poor
        if (exec.bidAskCoveragePct != null && exec.bidAskCoveragePct < 50) {
          executionQualityScore = Math.max(0, executionQualityScore - 3);
          if (executionQualityScore <= 4) executionQualityLabel = "Spread très large";
        }
      }

      // ── SAMPLE SCORE: 10 pts ──────────────────────────────────────────────
      const sampleScore = t.sampleQuality === "bon" ? 10 : t.sampleQuality === "moyen" ? 6 : 2;

      // ── CC SCORE: 5 pts max — bonus/malus secondaire ──────────────────────
      const cc = t.ccStats;
      const ccSellRate = cc?.ccSellableRatePct ?? null;
      const ccYield = cc?.avgCcYieldPct ?? null;

      let ccStatus, ccStatusLabel, ccScore;
      if (ccSellRate != null) {
        if (ccSellRate >= 90) {
          ccStatus = "testé_fort"; ccStatusLabel = "CC fort"; ccScore = 5;
        } else if (ccSellRate >= 70) {
          ccStatus = "testé_correct"; ccStatusLabel = "CC correct"; ccScore = 4;
        } else if (ccSellRate >= 50) {
          ccStatus = "testé_correct"; ccStatusLabel = "CC correct"; ccScore = 2;
        } else {
          ccStatus = "testé_faible"; ccStatusLabel = "CC faible"; ccScore = 0;
        }
      } else {
        if (ar != null && ar <= 5) {
          ccStatus = "non_testé_assignation_faible";
          ccStatusLabel = "CC non testé — assignation faible";
          ccScore = 3;
        } else if (ar != null && ar <= 15) {
          ccStatus = "non_testé_assignation_modérée";
          ccStatusLabel = "CC non testé — assignation modérée";
          ccScore = 2;
        } else {
          ccStatus = "non_testé_risque_assignation";
          ccStatusLabel = "CC non testé — risque assignation";
          ccScore = 1;
        }
      }

      const score = Math.min(100, Math.max(1,
        riskScore + premiumScore + stabilityScore + executionQualityScore + sampleScore + ccScore));
      const scoreLabel = score >= 85 ? "Excellent" : score >= 70 ? "Bon" : score >= 55 ? "Moyen" : score >= 40 ? "Faible" : "À éviter";

      // ── Confidence ────────────────────────────────────────────────────────
      const premiumWindowConfidence = t.stabilityLabel === "stable" ? "bon" : t.stabilityLabel === "variable" ? "moyen" : "faible";
      const hasCcTested = ccStatus.startsWith("testé");
      const confidence =
        sampleQualityTicker === "bon" && premiumWindowConfidence !== "faible" && hasCcTested ? "élevée" :
        sampleQualityTicker === "bon" ? "moyenne" :
        sampleQualityTicker === "moyen" && t.resolvedCount >= 5 ? "moyenne" :
        "faible";

      // ── Reading ───────────────────────────────────────────────────────────
      let reading;
      if (executionQualityScore <= 4) reading = "Potentiel théorique, spread à surveiller";
      else if (score >= 85) reading = "Excellent vendeur de prime";
      else if (score >= 70) reading = "Bon candidat récurrent";
      else if (score >= 55) reading = "Candidat correct";
      else if (ar != null && ar <= 5 && ccStatus.startsWith("non_testé")) reading = "Bon CSP, CC à confirmer";
      else if (ccStatus === "testé_faible") reading = "CC post-assignation faible";
      else reading = "À surveiller";

      // ── Reasons (max 3, ordered by priority) ─────────────────────────────
      const reasons = [];
      if (executionQualityScore === 0) reasons.push("Spread très large");
      else if (executionQualityScore <= 4) reasons.push("Spread à surveiller");
      if (ar != null && ar <= 5 && reasons.length < 3) reasons.push("Assignation faible");
      if (premiumScore >= 18 && reasons.length < 3) reasons.push("Prime CSP forte");
      if (stabilityScore <= 5 && reasons.length < 3) reasons.push("Fenêtre DTE à confirmer");
      if (ccStatus === "testé_fort" && reasons.length < 3) reasons.push("CC fort après assignation");
      if (ccStatus.startsWith("non_testé") && reasons.length < 3) reasons.push("CC non testé");

      const rec = t.recommendedWindow;
      return {
        ticker: t.ticker,
        score,
        scoreLabel,
        preferredMode: t.preferredMode,
        recommendedDteWindow: rec?.recommendedDteRange ?? null,
        practicalBestDte: rec?.practicalBestDte ?? null,
        theoreticalBestDte: rec?.theoreticalBestDte ?? null,
        sampleCount: t.totalSample,
        sampleQuality: t.sampleQuality,
        sampleQualityTicker,
        assignmentRatePct: roundMetric(t.assignmentRatePct, 1),
        otmRatePct: roundMetric(t.otmRatePct, 1),
        strikeTouchedRatePct: roundMetric(t.strikeTouchedRatePct, 1),
        brokeLowerBoundRatePct: roundMetric(t.brokeLowerBoundRatePct, 1),
        avgPremium: roundMetric(t.medianPremium),
        medianPremium: roundMetric(t.medianPremium),
        premiumStabilityLabel: t.stabilityLabel,
        ccSellableRatePct: roundMetric(cc?.ccSellableRatePct, 1),
        avgCcPremiumPerContract: roundMetric(cc?.avgCcPremiumPerContract, 2),
        avgCcYieldPct: roundMetric(cc?.avgCcYieldPct, 2),
        ccStatus,
        ccStatusLabel,
        executionQualityScore,
        executionQualityLabel,
        medianSpreadPct: roundMetric(exec.medianSpreadPct, 2),
        avgSpreadPct: roundMetric(exec.avgSpreadPct, 2),
        bidAskCoveragePct: roundMetric(exec.bidAskCoveragePct, 1),
        confidence,
        reading,
        reasons: reasons.slice(0, 3),
        components: { riskScore, premiumScore, stabilityScore, executionQualityScore, sampleScore, ccScore },
      };
    });

    // ── Filter by ticker / mode — applied AFTER global scoring ─────────────
    let filtered = rankingItems;
    if (tickerFilter) {
      filtered = filtered.filter((t) => t.ticker === tickerFilter);
    }
    if (modeFilter === "safe") {
      filtered = filtered.filter((t) => t.preferredMode !== "AGRESSIF");
    } else if (modeFilter === "aggressive") {
      filtered = filtered.filter((t) => t.preferredMode === "AGRESSIF");
    }

    const confOrder = { "élevée": 0, "moyenne": 1, "faible": 2 };
    filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ca = confOrder[a.confidence] ?? 2;
      const cb = confOrder[b.confidence] ?? 2;
      if (ca !== cb) return ca - cb;
      const ccDelta = (b.ccSellableRatePct ?? -1) - (a.ccSellableRatePct ?? -1);
      if (ccDelta !== 0) return ccDelta;
      const arA = a.assignmentRatePct ?? 100;
      const arB = b.assignmentRatePct ?? 100;
      if (arA !== arB) return arA - arB;
      return a.ticker.localeCompare(b.ticker);
    });

    const limited = filtered.slice(0, limit);
    const rankings = limited.map((item, i) => ({ rank: i + 1, ...item }));

    const scores = rankings.map((r) => r.score);
    return {
      ok: true,
      summary: {
        tickers_ranked: rankings.length,
        records_used: allRecords.length,
        avg_score: scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
        top_score: scores.length > 0 ? Math.max(...scores) : null,
        weak_sample_count: rankings.filter((r) => r.sampleQuality === "faible").length,
        generatedAt: new Date().toISOString(),
      },
      rankings,
    };
  }

  return {
    buildRecordsFromCandidates,
    listJournal,
    computeStats,
    computeCohortSummary,
    computeCalibrationSummary,
    computeModeComparison,
    computePremiumStability,
    computeTickerRanking,
    captureFromCandidates,
    patchResolution,
    resolveExpiredRecords,
    store,
  };
}
