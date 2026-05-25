/**
 * Snapshot technique léger — sous-jacent au moment du scan Journal POP.
 * Données daily (ohlcCandles du scanner, source Yahoo). Aucune candle brute stockée.
 *
 * Convention realizedVol* : volatilité réalisée annualisée (log-returns, sqrt(252)),
 * identique à computeAnnualizedHv dans marketService.js.
 */

const REALIZED_VOL_CONVENTION = "annualized_log_returns_sqrt252";
const DATA_FREQUENCY = "daily";

const TRACKED_FIELDS = [
  "rsi14",
  "rsi7",
  "macd",
  "macdSignal",
  "macdHistogram",
  "stochK",
  "stochD",
  "ma8",
  "ma21",
  "ma34",
  "ma50",
  "ma200",
  "priceVsMa50Pct",
  "priceVsMa200Pct",
  "atr14",
  "atrPct",
  "realizedVol20",
  "return5dPct",
  "return20dPct",
  "relativeVolume",
  "drawdownFrom20dHighPct",
  "high20",
  "low20",
];

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundNum(value, digits = 4) {
  const n = toNum(value);
  if (n == null) return null;
  return Number(n.toFixed(digits));
}

function normalizeIso(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function pickFirstNumber(...values) {
  for (const value of values) {
    const n = toNum(value);
    if (n != null) return n;
  }
  return null;
}

function pctDiff(price, basis) {
  const p = toNum(price);
  const b = toNum(basis);
  if (p == null || b == null || b === 0) return null;
  return roundNum(((p - b) / b) * 100, 2);
}

function returnPct(closes, lookback) {
  if (!Array.isArray(closes) || closes.length < lookback + 1) return null;
  const last = toNum(closes[closes.length - 1]);
  const prev = toNum(closes[closes.length - 1 - lookback]);
  if (last == null || prev == null || prev === 0) return null;
  return roundNum(((last / prev) - 1) * 100, 2);
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period).map(toNum).filter((v) => v != null);
  if (slice.length < period) return null;
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const nums = values.map(toNum);
  if (nums.some((v) => v == null)) return null;
  const k = 2 / (period + 1);
  let prev = nums.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  const out = [prev];
  for (let i = period; i < nums.length; i += 1) {
    prev = nums[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function computeRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = toNum(closes[i]) - toNum(closes[i - 1]);
    if (change == null) return null;
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = toNum(closes[i]) - toNum(closes[i - 1]);
    if (change == null) return null;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return roundNum(100 - 100 / (1 + rs), 2);
}

export function computeMacd(closes) {
  if (!Array.isArray(closes) || closes.length < 35) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12 || !ema26) return null;
  const offset = ema12.length - ema26.length;
  const macdLine = [];
  for (let i = 0; i < ema26.length; i += 1) {
    macdLine.push(ema12[i + offset] - ema26[i]);
  }
  if (macdLine.length < 9) return null;
  const signalSeries = emaSeries(macdLine, 9);
  if (!signalSeries || signalSeries.length === 0) return null;
  const macd = macdLine[macdLine.length - 1];
  const macdSignal = signalSeries[signalSeries.length - 1];
  const macdHistogram = macd - macdSignal;
  const prevHistogram =
    signalSeries.length >= 2
      ? macdLine[macdLine.length - 2] - signalSeries[signalSeries.length - 2]
      : null;
  return {
    macd: roundNum(macd, 4),
    macdSignal: roundNum(macdSignal, 4),
    macdHistogram: roundNum(macdHistogram, 4),
    macdBullish: macdHistogram > 0,
    macdHistogramRising:
      prevHistogram != null ? macdHistogram > prevHistogram : null,
  };
}

export function computeAtr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const high = toNum(candles[i]?.high ?? candles[i]?.close);
    const low = toNum(candles[i]?.low ?? candles[i]?.close);
    const prevClose = toNum(candles[i - 1]?.close);
    if (high == null || low == null || prevClose == null) return null;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < trs.length; i += 1) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return roundNum(atr, 4);
}

export function computeRealizedVol(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  const returns = [];
  for (let i = 1; i < slice.length; i += 1) {
    const prev = toNum(slice[i - 1]);
    const next = toNum(slice[i]);
    if (prev == null || next == null || prev <= 0 || next <= 0) return null;
    returns.push(Math.log(next / prev));
  }
  if (returns.length < period) return null;
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  const variance = returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / returns.length;
  if (!(variance >= 0)) return null;
  return roundNum(Math.sqrt(variance) * Math.sqrt(252), 6);
}

function computeStochastic(candles, period = 14, smoothK = 3, smoothD = 3) {
  if (!Array.isArray(candles) || candles.length < period + smoothK + smoothD - 1) return null;
  const rawK = [];
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const highs = window.map((c) => toNum(c?.high ?? c?.close)).filter((v) => v != null);
    const lows = window.map((c) => toNum(c?.low ?? c?.close)).filter((v) => v != null);
    const close = toNum(candles[i]?.close);
    if (!highs.length || !lows.length || close == null) return null;
    const highest = Math.max(...highs);
    const lowest = Math.min(...lows);
    if (highest === lowest) rawK.push(50);
    else rawK.push(((close - lowest) / (highest - lowest)) * 100);
  }
  const kSmoothed = [];
  for (let i = smoothK - 1; i < rawK.length; i += 1) {
    const slice = rawK.slice(i - smoothK + 1, i + 1);
    kSmoothed.push(slice.reduce((sum, v) => sum + v, 0) / slice.length);
  }
  const dSmoothed = [];
  for (let i = smoothD - 1; i < kSmoothed.length; i += 1) {
    const slice = kSmoothed.slice(i - smoothD + 1, i + 1);
    dSmoothed.push(slice.reduce((sum, v) => sum + v, 0) / slice.length);
  }
  if (dSmoothed.length === 0) return null;
  const stochK = roundNum(kSmoothed[kSmoothed.length - 1], 2);
  const stochD = roundNum(dSmoothed[dSmoothed.length - 1], 2);
  let stochSignal = "neutre";
  if (stochK != null && stochD != null) {
    if (stochK >= 80 && stochD >= 80) stochSignal = "surachat";
    else if (stochK <= 20 && stochD <= 20) stochSignal = "survente";
  }
  return { stochK, stochD, stochSignal };
}

function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => {
      const close = toNum(c?.close);
      if (close == null || close <= 0) return null;
      const open = toNum(c?.open);
      const high = toNum(c?.high);
      const low = toNum(c?.low);
      const volume = toNum(c?.volume);
      return {
        date: c?.date ?? null,
        open: open != null && open > 0 ? open : close,
        high: high != null && high > 0 ? high : close,
        low: low != null && low > 0 ? low : close,
        close,
        volume: volume != null && volume > 0 ? volume : null,
      };
    })
    .filter(Boolean);
}

function resolveOhlcCandles(candidate) {
  const pools = [
    candidate?.ohlcCandles,
    candidate?.supportResistance?.ohlcCandles,
    candidate?.raw?.ohlcCandles,
  ];
  for (const pool of pools) {
    const normalized = normalizeCandles(pool);
    if (normalized.length > 0) return normalized;
  }
  const closes = candidate?.technicals?.closes60 ?? candidate?.priceSeries?.closes;
  if (Array.isArray(closes) && closes.length >= 2) {
    return closes
      .map((close) => {
        const c = toNum(close);
        return c != null && c > 0 ? { open: c, high: c, low: c, close: c, volume: null } : null;
      })
      .filter(Boolean);
  }
  return [];
}

function resolveTechnicalSource(candidate, hasYahooCandles) {
  const ibkrUsed =
    Boolean(candidate?.ibkrDirect) ||
    candidate?.source === "IBKR" ||
    candidate?.optionsSource === "IBKR live";
  if (ibkrUsed && hasYahooCandles) return "mixed";
  if (hasYahooCandles || candidate?.raw || candidate?.techniqueSource === "Yahoo") return "Yahoo";
  if (ibkrUsed) return "IBKR";
  return "unknown";
}

function computeVolumeTrend(volumes) {
  if (!Array.isArray(volumes) || volumes.length < 10) return null;
  const nums = volumes.map(toNum).filter((v) => v != null && v > 0);
  if (nums.length < 10) return null;
  const recent = nums.slice(-5);
  const prior = nums.slice(-10, -5);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const priorAvg = prior.reduce((s, v) => s + v, 0) / prior.length;
  if (!(priorAvg > 0)) return null;
  const ratio = recentAvg / priorAvg;
  if (ratio >= 1.1) return "hausse";
  if (ratio <= 0.9) return "baisse";
  return "stable";
}

function computeRangePct(candles, lookback) {
  if (!Array.isArray(candles) || candles.length < lookback) return null;
  const window = candles.slice(-lookback);
  const highs = window.map((c) => toNum(c.high)).filter((v) => v != null);
  const lows = window.map((c) => toNum(c.low)).filter((v) => v != null);
  if (!highs.length || !lows.length) return null;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  if (!(low > 0)) return null;
  return roundNum(((high - low) / low) * 100, 2);
}

function computeHighLow(candles, lookback) {
  if (!Array.isArray(candles) || candles.length < lookback) return { high: null, low: null };
  const window = candles.slice(-lookback);
  const highs = window.map((c) => toNum(c.high)).filter((v) => v != null);
  const lows = window.map((c) => toNum(c.low)).filter((v) => v != null);
  return {
    high: highs.length ? roundNum(Math.max(...highs), 3) : null,
    low: lows.length ? roundNum(Math.min(...lows), 3) : null,
  };
}

function computeDrawdown(price, high) {
  const p = toNum(price);
  const h = toNum(high);
  if (p == null || h == null || h === 0) return null;
  return roundNum(((p - h) / h) * 100, 2);
}

function deriveTechnicalTrendLabel({ price, ma50, ma200, macdBullish, ma50AboveMa200, priceAboveMa50 }) {
  if (price == null) return "inconnu";
  let score = 0;
  if (priceAboveMa50 === true) score += 1;
  else if (priceAboveMa50 === false) score -= 1;
  if (ma50AboveMa200 === true) score += 1;
  else if (ma50AboveMa200 === false) score -= 1;
  if (macdBullish === true) score += 1;
  else if (macdBullish === false) score -= 1;
  if (score >= 2) return "haussier";
  if (score <= -2) return "baissier";
  if (score === 0 && priceAboveMa50 == null && ma50AboveMa200 == null && macdBullish == null) return "inconnu";
  return "neutre";
}

function deriveTechnicalRiskLabel({ atrPct, realizedVol20 }) {
  const atr = toNum(atrPct);
  const rv = toNum(realizedVol20);
  if (atr == null && rv == null) return "inconnu";
  const ref = Math.max(atr ?? 0, (rv ?? 0) * 100);
  if (ref >= 8) return "extrême";
  if (ref >= 5) return "volatil";
  if (ref >= 2.5) return "normal";
  return "calme";
}

function fieldPresent(snapshot, key) {
  const value = snapshot?.[key];
  if (typeof value === "boolean") return true;
  return value != null;
}

function assessDataConfidence(candleCount, missingCount, trackedTotal) {
  if (candleCount === 0) return "missing";
  const completeness = (trackedTotal - missingCount) / trackedTotal;
  if (candleCount >= 200 && completeness >= 0.85) return "observed";
  if (completeness >= 0.55) return "calculated";
  if (candleCount >= 10) return "partial";
  return "missing";
}

/**
 * @param {object} params
 * @param {object} params.candidate
 * @param {string} params.scanTimestamp
 */
export function buildTechnicalSnapshot({ candidate, scanTimestamp }) {
  const ticker =
    String(candidate?.symbol ?? candidate?.ticker ?? "").trim().toUpperCase() || null;
  const candles = resolveOhlcCandles(candidate);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const lastCandle = candles.length ? candles[candles.length - 1] : null;
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : null;

  const priceAtScan = pickFirstNumber(
    candidate?.currentPrice,
    candidate?.underlyingPrice,
    candidate?.price,
    lastCandle?.close,
    candidate?.technicals?.currentPrice
  );

  const diagnostics = candidate?.diagnosticsV12 ?? null;

  const ma8 = roundNum(sma(closes, 8), 3);
  const ma21 = roundNum(sma(closes, 21), 3);
  const ma34 = roundNum(sma(closes, 34), 3);
  const ma50 = roundNum(sma(closes, 50), 3);
  const ma200 = roundNum(sma(closes, 200), 3);

  const macdInfo = computeMacd(closes);
  const stochInfo = computeStochastic(candles);
  const atr14 = computeAtr(candles, 14);
  const atrPct =
    atr14 != null && priceAtScan != null && priceAtScan > 0
      ? roundNum((atr14 / priceAtScan) * 100, 2)
      : null;

  const avgVolume20 =
    (() => {
      const volWindow = volumes.slice(-20).map(toNum).filter((v) => v != null && v > 0);
      if (volWindow.length >= 5) {
        return roundNum(volWindow.reduce((s, v) => s + v, 0) / volWindow.length, 0);
      }
      return null;
    })();

  const lastVolume = lastCandle?.volume ?? null;
  const relativeVolumeFromDiag = toNum(diagnostics?.volumeVsAvgRatio);
  const relativeVolume =
    relativeVolumeFromDiag ??
    (lastVolume != null && avgVolume20 != null && avgVolume20 > 0
      ? roundNum(lastVolume / avgVolume20, 2)
      : null);

  const hl20 = computeHighLow(candles, 20);
  const hl50 = computeHighLow(candles, 50);

  const priceAboveMa50 = ma50 != null && priceAtScan != null ? priceAtScan > ma50 : null;
  const priceAboveMa200 = ma200 != null && priceAtScan != null ? priceAtScan > ma200 : null;
  const ma8AboveMa34 = ma8 != null && ma34 != null ? ma8 > ma34 : null;
  const ma50AboveMa200 = ma50 != null && ma200 != null ? ma50 > ma200 : null;

  const dayHigh = toNum(lastCandle?.high);
  const dayLow = toNum(lastCandle?.low);
  const dayRangePct =
    dayHigh != null && dayLow != null && dayLow > 0
      ? roundNum(((dayHigh - dayLow) / dayLow) * 100, 2)
      : null;
  const closePositionInDayRangePct =
    priceAtScan != null && dayHigh != null && dayLow != null && dayHigh !== dayLow
      ? roundNum(((priceAtScan - dayLow) / (dayHigh - dayLow)) * 100, 2)
      : null;

  const snapshot = {
    source: resolveTechnicalSource(candidate, candles.length > 0),
    dataFrequency: DATA_FREQUENCY,
    realizedVolConvention: REALIZED_VOL_CONVENTION,
    ticker,
    snapshotTimestamp: normalizeIso(scanTimestamp),
    priceAtScan: roundNum(priceAtScan, 3),
    previousClose: roundNum(prevCandle?.close, 3),
    open: roundNum(lastCandle?.open, 3),
    high: roundNum(lastCandle?.high, 3),
    low: roundNum(lastCandle?.low, 3),
    close: roundNum(lastCandle?.close, 3),
    volume: lastVolume != null ? Math.round(lastVolume) : null,
    rsi14: computeRsi(closes, 14),
    rsi7: computeRsi(closes, 7),
    macd: macdInfo?.macd ?? null,
    macdSignal: macdInfo?.macdSignal ?? null,
    macdHistogram: macdInfo?.macdHistogram ?? null,
    macdBullish: macdInfo?.macdBullish ?? null,
    macdHistogramRising: macdInfo?.macdHistogramRising ?? null,
    stochK: stochInfo?.stochK ?? null,
    stochD: stochInfo?.stochD ?? null,
    stochSignal: stochInfo?.stochSignal ?? null,
    ma8,
    ma21,
    ma34,
    ma50,
    ma200,
    priceVsMa8Pct: pctDiff(priceAtScan, ma8),
    priceVsMa21Pct: pctDiff(priceAtScan, ma21),
    priceVsMa34Pct: pctDiff(priceAtScan, ma34),
    priceVsMa50Pct: pctDiff(priceAtScan, ma50),
    priceVsMa200Pct: pctDiff(priceAtScan, ma200),
    ma8AboveMa34,
    ma50AboveMa200,
    priceAboveMa50,
    priceAboveMa200,
    atr14,
    atrPct,
    realizedVol10: computeRealizedVol(closes, 10),
    realizedVol20: computeRealizedVol(closes, 20),
    realizedVol30: computeRealizedVol(closes, 30),
    return1dPct:
      toNum(diagnostics?.dailyChangePct) ?? returnPct(closes, 1),
    return5dPct: returnPct(closes, 5),
    return10dPct: returnPct(closes, 10),
    return20dPct: returnPct(closes, 20),
    avgVolume20,
    relativeVolume,
    volumeTrend: computeVolumeTrend(volumes),
    dayRangePct,
    range5dPct: computeRangePct(candles, 5),
    range20dPct: computeRangePct(candles, 20),
    high20: hl20.high,
    low20: hl20.low,
    distanceFromHigh20Pct: pctDiff(priceAtScan, hl20.high),
    distanceFromLow20Pct: pctDiff(priceAtScan, hl20.low),
    drawdownFrom20dHighPct: computeDrawdown(priceAtScan, hl20.high),
    drawdownFrom50dHighPct: computeDrawdown(priceAtScan, hl50.high),
    closePositionInDayRangePct,
    technicalTrendLabel: "inconnu",
    technicalRiskLabel: "inconnu",
    dataConfidence: "missing",
    missingFields: [],
    warnings: [],
    candlesUsed: candles.length,
  };

  snapshot.technicalTrendLabel = deriveTechnicalTrendLabel({
    price: priceAtScan,
    ma50,
    ma200,
    macdBullish: snapshot.macdBullish,
    ma50AboveMa200,
    priceAboveMa50,
  });
  snapshot.technicalRiskLabel = deriveTechnicalRiskLabel({
    atrPct: snapshot.atrPct,
    realizedVol20: snapshot.realizedVol20,
  });

  snapshot.missingFields = TRACKED_FIELDS.filter((key) => !fieldPresent(snapshot, key));
  snapshot.dataConfidence = assessDataConfidence(
    candles.length,
    snapshot.missingFields.length,
    TRACKED_FIELDS.length
  );

  if (candles.length === 0) snapshot.warnings.push("ohlc_candles_absentes");
  else if (candles.length < 50) snapshot.warnings.push("historique_court");
  if (candles.length > 0 && candles.length < 200) snapshot.warnings.push("ma200_peut_manquer");
  if (snapshot.source === "mixed") snapshot.warnings.push("prix_ibkr_candles_yahoo");

  return snapshot;
}

export function parseTechnicalSnapshot(record) {
  if (!record || typeof record !== "object") return null;
  const direct = record?.technicalSnapshot;
  if (direct && typeof direct === "object") return direct;
  const raw = record?.technical_snapshot_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_err) {
      return null;
    }
  }
  return null;
}

function parseTechnicalSnapshotWithStatus(record) {
  if (!record || typeof record !== "object") {
    return { snapshot: null, storageStatus: "snapshot_absent", warnings: [] };
  }
  if (record.technicalSnapshot && typeof record.technicalSnapshot === "object") {
    return { snapshot: record.technicalSnapshot, storageStatus: "snapshot_sqlite_present", warnings: [] };
  }
  const raw = record.technical_snapshot_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { snapshot: parsed, storageStatus: "snapshot_sqlite_present", warnings: [] };
      }
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["technical_snapshot_json_not_object"],
      };
    } catch (_err) {
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["technical_snapshot_json_parse_failed"],
      };
    }
  }
  return { snapshot: null, storageStatus: "snapshot_absent", warnings: ["snapshot_absent"] };
}

function buildRecordTechnicalDataBadge(snapshot, storageStatus, completenessPct) {
  if (storageStatus === "snapshot_parse_failed") return "Snapshot invalide";
  if (!snapshot) return "Snapshot absent";
  if (completenessPct < 45) return "Tech incomplet";
  const label = snapshot.technicalTrendLabel;
  if (label === "haussier") return "Tech haussier";
  if (label === "baissier") return "Tech baissier";
  if (label === "neutre") return "Tech neutre";
  return "Tech incomplet";
}

export function summarizeTechnicalSnapshotDiagnostics(record) {
  const snapshot = parseTechnicalSnapshot(record);
  const hasSnapshot = Boolean(snapshot);
  const trackedPresent = TRACKED_FIELDS.filter((key) => fieldPresent(snapshot, key)).length;
  const technicalDataCompletenessPct = hasSnapshot
    ? Math.round((trackedPresent / TRACKED_FIELDS.length) * 100)
    : 0;

  return {
    hasTechnicalSnapshot: hasSnapshot,
    technicalDataCompletenessPct,
    technicalDataMissingFields: hasSnapshot ? snapshot.missingFields ?? [] : [...TRACKED_FIELDS],
    technicalTrendLabel: snapshot?.technicalTrendLabel ?? "inconnu",
    technicalRiskLabel: snapshot?.technicalRiskLabel ?? "inconnu",
    technicalDataSource: snapshot?.source ?? "absent",
    technicalDataWarnings: hasSnapshot ? snapshot.warnings ?? [] : ["snapshot_absent"],
  };
}

export function enrichRecordWithTechnicalSnapshotFields(record) {
  if (!record || typeof record !== "object") return record;
  const parsed = parseTechnicalSnapshotWithStatus(record);
  const diagnosticsRecord = parsed.snapshot
    ? { ...record, technicalSnapshot: parsed.snapshot }
    : record;
  const diagnostics = summarizeTechnicalSnapshotDiagnostics(diagnosticsRecord);
  return {
    ...record,
    ...(parsed.snapshot ? { technicalSnapshot: parsed.snapshot } : {}),
    ...diagnostics,
    technicalSnapshotStorageStatus: parsed.storageStatus,
    technicalDataWarnings:
      parsed.warnings.length > 0
        ? [...new Set([...(diagnostics.technicalDataWarnings ?? []), ...parsed.warnings])]
        : diagnostics.technicalDataWarnings,
    technicalDataBadge: buildRecordTechnicalDataBadge(
      parsed.snapshot,
      parsed.storageStatus,
      diagnostics.technicalDataCompletenessPct
    ),
  };
}

export function buildTechnicalDataBadge(summary) {
  if (!summary?.hasTechnicalSnapshot) return "Snapshot absent";
  if ((summary.technicalDataCompletenessPct ?? 0) < 45) return "Tech incomplet";
  const label = summary.technicalTrendLabel;
  if (label === "haussier") return "Tech haussier";
  if (label === "baissier") return "Tech baissier";
  if (label === "neutre") return "Tech neutre";
  return "Tech incomplet";
}

export { TRACKED_FIELDS };
