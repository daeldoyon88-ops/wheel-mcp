/**
 * Snapshot contexte marché léger — QQQ/SPY/IWM/VIX au moment du scan Journal POP.
 * Données daily Yahoo via marketService.getSupportResistance. Aucune candle brute stockée.
 */

import {
  computeAtr,
  computeRealizedVol,
  computeRsi,
  computeSma,
  pctDiff,
  returnPct,
  roundNum,
  toNum,
} from "./technicalSnapshot.js";

const DATA_FREQUENCY = "daily";

const TRACKED_FIELDS = [
  "qqqPrice",
  "qqqRsi14",
  "qqqReturn5dPct",
  "qqqPriceVsMa50Pct",
  "qqqTrendLabel",
  "spyPrice",
  "spyRsi14",
  "spyReturn5dPct",
  "spyPriceVsMa50Pct",
  "spyTrendLabel",
  "vixLevel",
  "vixRegimeLabel",
  "vixTrendLabel",
  "marketRegimeLabel",
  "marketRiskLabel",
  "riskOnOffLabel",
];

function normalizeIso(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
      return {
        open: open != null && open > 0 ? open : close,
        high: high != null && high > 0 ? high : close,
        low: low != null && low > 0 ? low : close,
        close,
      };
    })
    .filter(Boolean);
}

function fieldPresent(snapshot, key) {
  const value = snapshot?.[key];
  return value != null && value !== "inconnu";
}

function assessDataConfidence(candleCounts, missingCount, trackedTotal) {
  const maxCandles = Math.max(0, ...candleCounts);
  if (maxCandles === 0) return "missing";
  const completeness = (trackedTotal - missingCount) / trackedTotal;
  if (maxCandles >= 200 && completeness >= 0.75) return "observed";
  if (completeness >= 0.5) return "calculated";
  if (maxCandles >= 10) return "partial";
  return "missing";
}

function deriveIndexTrendLabel(price, ma50, ma200) {
  if (price == null) return "inconnu";
  const aboveMa50 = ma50 != null ? price > ma50 : null;
  const ma50AboveMa200 = ma50 != null && ma200 != null ? ma50 > ma200 : null;
  if (aboveMa50 === true && ma50AboveMa200 === true) return "haussier";
  if (aboveMa50 === false && ma50AboveMa200 === false) return "baissier";
  if (aboveMa50 == null && ma50AboveMa200 == null) return "inconnu";
  return "neutre";
}

export function deriveVixRegimeLabel(vixLevel) {
  const v = toNum(vixLevel);
  if (v == null) return "inconnu";
  if (v < 15) return "bas";
  if (v < 20) return "normal";
  if (v < 30) return "élevé";
  return "extrême";
}

export function deriveVixTrendLabel(vixReturn5dPct) {
  const r = toNum(vixReturn5dPct);
  if (r == null) return "inconnu";
  if (r > 5) return "en hausse";
  if (r < -5) return "en baisse";
  return "stable";
}

export function deriveMarketRegimeLabel({
  qqqPrice,
  qqqMa50,
  spyPrice,
  spyMa50,
  vixRegimeLabel,
  vixTrendLabel,
  breadthLabel,
}) {
  const qqqAboveMa50 = qqqPrice != null && qqqMa50 != null ? qqqPrice > qqqMa50 : null;
  const spyAboveMa50 = spyPrice != null && spyMa50 != null ? spyPrice > spyMa50 : null;
  const vixStress =
    vixRegimeLabel === "élevé" ||
    vixRegimeLabel === "extrême" ||
    vixTrendLabel === "en hausse";
  const breadthStress = breadthLabel === "faible" || breadthLabel === "stress";

  if (
    qqqAboveMa50 === true &&
    spyAboveMa50 === true &&
    (vixRegimeLabel === "bas" || vixRegimeLabel === "normal")
  ) {
    return "favorable";
  }
  if (
    (qqqAboveMa50 === false && spyAboveMa50 === false) ||
    vixRegimeLabel === "élevé" ||
    vixRegimeLabel === "extrême" ||
    breadthStress
  ) {
    return "stress";
  }
  if (qqqAboveMa50 === false || spyAboveMa50 === false || vixStress) {
    return "fragile";
  }
  if (qqqAboveMa50 == null && spyAboveMa50 == null && vixRegimeLabel === "inconnu") {
    return "inconnu";
  }
  return "neutre";
}

export function deriveMarketRiskLabel({ vixLevel, qqqRealizedVol20, spyRealizedVol20 }) {
  const vix = toNum(vixLevel);
  if (vix != null) {
    if (vix >= 30) return "extrême";
    if (vix >= 22) return "volatil";
    if (vix >= 15) return "normal";
    return "calme";
  }
  const rv = Math.max(toNum(qqqRealizedVol20) ?? 0, toNum(spyRealizedVol20) ?? 0);
  if (rv <= 0) return "inconnu";
  const rvPct = rv * 100;
  if (rvPct >= 35) return "extrême";
  if (rvPct >= 25) return "volatil";
  if (rvPct >= 15) return "normal";
  return "calme";
}

export function deriveRiskOnOffLabel({
  qqqPrice,
  qqqMa50,
  spyPrice,
  spyMa50,
  iwmPrice,
  iwmMa50,
  vixRegimeLabel,
  vixTrendLabel,
}) {
  const qqqAbove = qqqPrice != null && qqqMa50 != null ? qqqPrice > qqqMa50 : null;
  const spyAbove = spyPrice != null && spyMa50 != null ? spyPrice > spyMa50 : null;
  const iwmAbove = iwmPrice != null && iwmMa50 != null ? iwmPrice > iwmMa50 : null;
  const vixCalm = vixRegimeLabel === "bas" || vixRegimeLabel === "normal";
  const vixStress =
    vixRegimeLabel === "élevé" ||
    vixRegimeLabel === "extrême" ||
    vixTrendLabel === "en hausse";

  if (
    qqqAbove === true &&
    spyAbove === true &&
    vixCalm &&
    vixTrendLabel !== "en hausse" &&
    (iwmAbove == null || iwmAbove === true)
  ) {
    return "risk_on";
  }
  if (qqqAbove === false || spyAbove === false || vixStress || iwmAbove === false) {
    return "risk_off";
  }
  if (qqqAbove == null && spyAbove == null) return "inconnu";
  return "neutre";
}

function buildIndexBlock(candles, prefix) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((c) => c.close);
  const price = closes.length ? closes[closes.length - 1] : null;
  const ma20 = roundNum(computeSma(closes, 20), 3);
  const ma50 = roundNum(computeSma(closes, 50), 3);
  const ma200 = roundNum(computeSma(closes, 200), 3);
  const atr14 = computeAtr(normalized, 14);
  const atrPct =
    atr14 != null && price != null && price > 0 ? roundNum((atr14 / price) * 100, 2) : null;

  return {
    [`${prefix}Price`]: roundNum(price, 3),
    [`${prefix}Rsi14`]: computeRsi(closes, 14),
    [`${prefix}Return1dPct`]: returnPct(closes, 1),
    [`${prefix}Return5dPct`]: returnPct(closes, 5),
    [`${prefix}Return20dPct`]: returnPct(closes, 20),
    [`${prefix}Ma20`]: ma20,
    [`${prefix}Ma50`]: ma50,
    [`${prefix}Ma200`]: ma200,
    [`${prefix}PriceVsMa50Pct`]: pctDiff(price, ma50),
    [`${prefix}PriceVsMa200Pct`]: pctDiff(price, ma200),
    [`${prefix}AtrPct`]: atrPct,
    [`${prefix}RealizedVol20`]: computeRealizedVol(closes, 20),
    [`${prefix}TrendLabel`]: deriveIndexTrendLabel(price, ma50, ma200),
    _price: price,
    _ma50: ma50,
    _ma200: ma200,
  };
}

function buildVixBlock(candles) {
  const normalized = normalizeCandles(candles);
  const closes = normalized.map((c) => c.close);
  const level = closes.length ? closes[closes.length - 1] : null;
  const ma20 = roundNum(computeSma(closes, 20), 3);
  return {
    vixLevel: roundNum(level, 2),
    vixReturn1dPct: returnPct(closes, 1),
    vixReturn5dPct: returnPct(closes, 5),
    vixReturn20dPct: returnPct(closes, 20),
    vixMa20: ma20,
    vixLevelVsMa20Pct: pctDiff(level, ma20),
    vixRegimeLabel: deriveVixRegimeLabel(level),
    vixTrendLabel: deriveVixTrendLabel(returnPct(closes, 5)),
  };
}

export function resolveMarketSessionStatus(now = new Date()) {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    let weekday = "";
    let hour = 0;
    let minute = 0;
    for (const p of parts) {
      if (p.type === "weekday") weekday = p.value;
      if (p.type === "hour") hour = Number(p.value);
      if (p.type === "minute") minute = Number(p.value);
    }
    if (weekday === "Saturday" || weekday === "Sunday") return "closed";
    const mins = hour * 60 + minute;
    const openM = 9 * 60 + 30;
    const closeM = 16 * 60;
    const preM = 4 * 60;
    if (mins >= openM && mins < closeM) return "open";
    if (mins >= preM && mins < openM) return "premarket";
    if (mins >= closeM) return "afterhours";
    return "closed";
  } catch (_err) {
    return "unknown";
  }
}

function stripInternalFields(block) {
  if (!block || typeof block !== "object") return {};
  const out = { ...block };
  delete out._price;
  delete out._ma50;
  delete out._ma200;
  return out;
}

/**
 * Construit le snapshot à partir de candles déjà récupérées (tests / cache scan).
 */
export function buildMarketContextSnapshotFromInputs({
  scanTimestamp,
  source = "Yahoo",
  marketSessionStatus = null,
  qqqCandles = [],
  spyCandles = [],
  iwmCandles = [],
  vixCandles = [],
  s5thValue = null,
  s5thSignal = null,
  s5thTrend = null,
}) {
  const qqqBlock = buildIndexBlock(qqqCandles, "qqq");
  const spyBlock = buildIndexBlock(spyCandles, "spy");
  const iwmBlock = buildIndexBlock(iwmCandles, "iwm");
  const vixBlock = buildVixBlock(vixCandles);

  const breadthLabel = "inconnu";

  const snapshot = {
    source,
    snapshotTimestamp: normalizeIso(scanTimestamp),
    dataFrequency: DATA_FREQUENCY,
    marketSessionStatus: marketSessionStatus ?? resolveMarketSessionStatus(),
    ...stripInternalFields(qqqBlock),
    ...stripInternalFields(spyBlock),
    iwmPrice: iwmBlock.iwmPrice ?? null,
    iwmRsi14: iwmBlock.iwmRsi14 ?? null,
    iwmReturn5dPct: iwmBlock.iwmReturn5dPct ?? null,
    iwmReturn20dPct: iwmBlock.iwmReturn20dPct ?? null,
    iwmPriceVsMa50Pct: iwmBlock.iwmPriceVsMa50Pct ?? null,
    iwmPriceVsMa200Pct: iwmBlock.iwmPriceVsMa200Pct ?? null,
    iwmTrendLabel: iwmBlock.iwmTrendLabel ?? "inconnu",
    ...vixBlock,
    s5thValue: toNum(s5thValue),
    s5thSignal: s5thSignal ?? null,
    s5thTrend: s5thTrend ?? null,
    breadthLabel,
    marketRegimeLabel: "inconnu",
    marketRiskLabel: "inconnu",
    riskOnOffLabel: "inconnu",
    dataConfidence: "missing",
    missingFields: [],
    warnings: [],
    candlesUsed: {
      qqq: normalizeCandles(qqqCandles).length,
      spy: normalizeCandles(spyCandles).length,
      iwm: normalizeCandles(iwmCandles).length,
      vix: normalizeCandles(vixCandles).length,
    },
  };

  snapshot.marketRegimeLabel = deriveMarketRegimeLabel({
    qqqPrice: qqqBlock._price,
    qqqMa50: qqqBlock._ma50,
    spyPrice: spyBlock._price,
    spyMa50: spyBlock._ma50,
    vixRegimeLabel: snapshot.vixRegimeLabel,
    vixTrendLabel: snapshot.vixTrendLabel,
    breadthLabel: snapshot.breadthLabel,
  });
  snapshot.marketRiskLabel = deriveMarketRiskLabel({
    vixLevel: snapshot.vixLevel,
    qqqRealizedVol20: snapshot.qqqRealizedVol20,
    spyRealizedVol20: snapshot.spyRealizedVol20,
  });
  snapshot.riskOnOffLabel = deriveRiskOnOffLabel({
    qqqPrice: qqqBlock._price,
    qqqMa50: qqqBlock._ma50,
    spyPrice: spyBlock._price,
    spyMa50: spyBlock._ma50,
    iwmPrice: iwmBlock._price,
    iwmMa50: iwmBlock._ma50,
    vixRegimeLabel: snapshot.vixRegimeLabel,
    vixTrendLabel: snapshot.vixTrendLabel,
  });

  snapshot.missingFields = TRACKED_FIELDS.filter((key) => !fieldPresent(snapshot, key));
  snapshot.dataConfidence = assessDataConfidence(
    [
      snapshot.candlesUsed.qqq,
      snapshot.candlesUsed.spy,
      snapshot.candlesUsed.iwm,
      snapshot.candlesUsed.vix,
    ],
    snapshot.missingFields.length,
    TRACKED_FIELDS.length
  );

  if (snapshot.candlesUsed.qqq === 0) snapshot.warnings.push("qqq_candles_absentes");
  if (snapshot.candlesUsed.spy === 0) snapshot.warnings.push("spy_candles_absentes");
  if (snapshot.candlesUsed.vix === 0) snapshot.warnings.push("vix_candles_absentes");
  if (snapshot.s5thValue == null) snapshot.warnings.push("s5th_non_disponible");

  return snapshot;
}

/**
 * @param {object} params
 * @param {object} params.marketService
 * @param {string} params.scanTimestamp
 */
export async function buildMarketContextSnapshot({ marketService, scanTimestamp }) {
  if (!marketService || typeof marketService.getSupportResistance !== "function") {
    return buildMarketContextSnapshotFromInputs({
      scanTimestamp,
      source: "unknown",
      warnings: ["market_service_indisponible"],
    });
  }

  const fetchCandles = async (symbol) => {
    try {
      const result = await marketService.getSupportResistance(symbol);
      return Array.isArray(result?.ohlcCandles) ? result.ohlcCandles : [];
    } catch (_err) {
      return [];
    }
  };

  const [qqqCandles, spyCandles, iwmCandles, vixCandles] = await Promise.all([
    fetchCandles("QQQ"),
    fetchCandles("SPY"),
    fetchCandles("IWM"),
    fetchCandles("^VIX"),
  ]);

  return buildMarketContextSnapshotFromInputs({
    scanTimestamp,
    source: "Yahoo",
    marketSessionStatus: resolveMarketSessionStatus(new Date(scanTimestamp)),
    qqqCandles,
    spyCandles,
    iwmCandles,
    vixCandles,
  });
}

export function parseMarketContextSnapshot(record) {
  if (!record || typeof record !== "object") return null;
  const direct = record?.marketContextSnapshot;
  if (direct && typeof direct === "object") return direct;
  const raw = record?.market_context_snapshot_json;
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

function parseMarketContextSnapshotWithStatus(record) {
  if (!record || typeof record !== "object") {
    return { snapshot: null, storageStatus: "snapshot_absent", warnings: [] };
  }
  if (record.marketContextSnapshot && typeof record.marketContextSnapshot === "object") {
    return { snapshot: record.marketContextSnapshot, storageStatus: "snapshot_sqlite_present", warnings: [] };
  }
  const raw = record.market_context_snapshot_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { snapshot: parsed, storageStatus: "snapshot_sqlite_present", warnings: [] };
      }
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["market_context_snapshot_json_not_object"],
      };
    } catch (_err) {
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["market_context_snapshot_json_parse_failed"],
      };
    }
  }
  return { snapshot: null, storageStatus: "snapshot_absent", warnings: ["snapshot_absent"] };
}

function buildRecordMarketContextBadge(snapshot, storageStatus, completenessPct) {
  if (storageStatus === "snapshot_parse_failed") return "Snapshot invalide";
  if (!snapshot) return "Snapshot absent";
  if (completenessPct < 45) return "Marché incomplet";
  const label = snapshot.marketRegimeLabel;
  if (label === "favorable") return "Marché favorable";
  if (label === "neutre") return "Marché neutre";
  if (label === "fragile") return "Marché fragile";
  if (label === "stress") return "Marché stress";
  return "Marché incomplet";
}

export function summarizeMarketContextDiagnostics(record) {
  const snapshot = parseMarketContextSnapshot(record);
  const hasSnapshot = Boolean(snapshot);
  const trackedPresent = TRACKED_FIELDS.filter((key) => fieldPresent(snapshot, key)).length;
  const marketContextCompletenessPct = hasSnapshot
    ? Math.round((trackedPresent / TRACKED_FIELDS.length) * 100)
    : 0;

  return {
    hasMarketContextSnapshot: hasSnapshot,
    marketContextCompletenessPct,
    marketContextMissingFields: hasSnapshot ? snapshot.missingFields ?? [] : [...TRACKED_FIELDS],
    marketRegimeLabel: snapshot?.marketRegimeLabel ?? "inconnu",
    marketRiskLabel: snapshot?.marketRiskLabel ?? "inconnu",
    riskOnOffLabel: snapshot?.riskOnOffLabel ?? "inconnu",
    vixRegimeLabel: snapshot?.vixRegimeLabel ?? "inconnu",
    marketContextSource: snapshot?.source ?? "absent",
    marketContextWarnings: hasSnapshot ? snapshot.warnings ?? [] : ["snapshot_absent"],
  };
}

export function enrichRecordWithMarketContextFields(record) {
  if (!record || typeof record !== "object") return record;
  const parsed = parseMarketContextSnapshotWithStatus(record);
  const diagnostics = summarizeMarketContextDiagnostics(
    parsed.snapshot ? { ...record, marketContextSnapshot: parsed.snapshot } : record
  );
  return {
    ...record,
    ...(parsed.snapshot ? { marketContextSnapshot: parsed.snapshot } : {}),
    ...diagnostics,
    marketContextSnapshotStorageStatus: parsed.storageStatus,
    marketContextWarnings:
      parsed.warnings.length > 0
        ? [...new Set([...(diagnostics.marketContextWarnings ?? []), ...parsed.warnings])]
        : diagnostics.marketContextWarnings,
    marketContextBadge: buildRecordMarketContextBadge(
      parsed.snapshot,
      parsed.storageStatus,
      diagnostics.marketContextCompletenessPct
    ),
  };
}

export function buildMarketContextBadge(summary) {
  if (!summary?.hasMarketContextSnapshot) return "Snapshot absent";
  if ((summary.marketContextCompletenessPct ?? 0) < 45) return "Marché incomplet";
  const label = summary.marketRegimeLabel;
  if (label === "favorable") return "Marché favorable";
  if (label === "neutre") return "Marché neutre";
  if (label === "fragile") return "Marché fragile";
  if (label === "stress") return "Marché stress";
  return "Marché incomplet";
}

export { TRACKED_FIELDS as MARKET_CONTEXT_TRACKED_FIELDS };
