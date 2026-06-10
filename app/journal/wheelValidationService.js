import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createWheelValidationStore } from "./wheelValidationStore.js";
import {
  buildOptionDataBadge,
  buildOptionQuoteSnapshot,
  enrichRecordWithOptionQuoteFields,
  parseOptionQuoteSnapshot,
  summarizeOptionDataForProfile,
  summarizeOptionQuoteDiagnostics,
} from "./optionQuoteSnapshot.js";
import {
  buildMarketContextSnapshot,
  enrichRecordWithMarketContextFields,
} from "./marketContextSnapshot.js";
import {
  buildTechnicalSnapshot,
  enrichRecordWithTechnicalSnapshotFields,
} from "./technicalSnapshot.js";
import { buildSeasonalitySnapshotFromCache } from "./seasonalitySnapshot.js";
import { isCryptoDigitalAssetBlocked } from "../watchlist/cryptoWheelFilter.js";

function toNumberOrNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntegerWithin(value, { min = 1, max = 500, fallback = 50 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
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

function quoteSqlIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name ?? ""))) {
    throw new Error("invalid_sql_identifier");
  }
  return `"${name}"`;
}

function pickExistingColumn(columns, candidates) {
  for (const candidate of candidates) {
    if (columns.has(candidate)) return candidate;
  }
  return null;
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

function getRecordYieldPct(record) {
  const premium = getPremiumCandidate(record);
  const strike = toNumberOrNull(record?.strike?.strike);
  if (premium != null && strike != null && strike > 0) {
    return (premium / strike) * 100;
  }
  return (
    toNumberOrNull(record?.strike?.annualizedYield) ??
    toNumberOrNull(record?.snapshot?.premium_to_spot_pct) ??
    null
  );
}

function getStoredSnapshotScanTimestamp(row) {
  return (
    row?.scanTimestamp ??
    row?.scan_timestamp ??
    row?.created_at ??
    row?.createdAt ??
    row?.updated_at ??
    row?.updatedAt ??
    row?.scanDate ??
    null
  );
}

function hasStoredOptionSnapshot(row) {
  if (row?.optionQuoteSnapshot && typeof row.optionQuoteSnapshot === "object") return true;
  const raw = row?.option_quote_snapshot_json;
  return typeof raw === "string" && raw.trim() !== "";
}

function parseStoredOptionQuoteSnapshot(row) {
  if (!row || typeof row !== "object") {
    return { snapshot: null, parseWarnings: ["snapshot_record_invalid"] };
  }
  if (row.optionQuoteSnapshot && typeof row.optionQuoteSnapshot === "object") {
    return { snapshot: row.optionQuoteSnapshot, parseWarnings: [] };
  }
  const raw = row.option_quote_snapshot_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return { snapshot: parsed, parseWarnings: [] };
      return { snapshot: null, parseWarnings: ["option_quote_snapshot_json_not_object"] };
    } catch (_error) {
      return { snapshot: null, parseWarnings: ["option_quote_snapshot_json_parse_failed"] };
    }
  }
  const parsed = parseOptionQuoteSnapshot(row);
  return {
    snapshot: parsed,
    parseWarnings: parsed ? [] : ["snapshot_absent"],
  };
}

function computeRowPremiumYieldPct(row, snapshot) {
  const fromSnapshot = toNumberOrNull(snapshot?.context?.premiumYieldPct);
  if (fromSnapshot != null) return fromSnapshot;
  const premium = toNumberOrNull(row?.premium);
  const strike = toNumberOrNull(row?.strike ?? snapshot?.strike);
  if (premium != null && strike != null && strike > 0) return (premium / strike) * 100;
  return toNumberOrNull(row?.annualizedYield);
}

function buildLatestOptionSnapshotBadge(snapshot, diagnostics, storageStatus) {
  if (storageStatus === "snapshot_parse_failed") return "Snapshot incomplet";
  if (diagnostics?.hasObservedIbkrOptionData) return "IBKR observé";
  const source = snapshot?.source ?? diagnostics?.optionDataSourceSummary;
  if (source === "Yahoo" || snapshot?.dataConfidence === "observed_yahoo") return "Yahoo fallback";
  if (!snapshot) return "Snapshot absent";
  if ((diagnostics?.optionDataCompletenessPct ?? 0) < 70) return "Options incomplètes";
  return "Snapshot présent";
}

function buildLatestOptionSnapshotRecord(row) {
  const { snapshot, parseWarnings } = parseStoredOptionQuoteSnapshot(row);
  const diagnosticsRecord = snapshot ? { ...row, optionQuoteSnapshot: snapshot } : row;
  const diagnostics = summarizeOptionQuoteDiagnostics(diagnosticsRecord);
  const quote = snapshot?.quote ?? {};
  const greeks = snapshot?.greeks ?? {};
  const liquidity = snapshot?.liquidity ?? {};
  const contract = snapshot?.contract ?? {};
  const context = snapshot?.context ?? {};
  const storageStatus = parseWarnings.includes("option_quote_snapshot_json_parse_failed")
    ? "snapshot_parse_failed"
    : diagnostics.optionSnapshotStorageStatus;
  const warnings = [
    ...(Array.isArray(snapshot?.warnings) ? snapshot.warnings : []),
    ...parseWarnings.filter((warning) => warning !== "snapshot_absent"),
  ];

  return {
    ticker: normalizeSymbol(row?.symbol ?? row?.ticker ?? snapshot?.ticker) || null,
    mode: row?.strikeMode ?? row?.mode ?? null,
    expiration: row?.expiration ?? snapshot?.expiration ?? row?.selectedExpiration ?? null,
    strike: toNumberOrNull(row?.strike ?? snapshot?.strike),
    dteAtScan: toNumberOrNull(row?.dteAtScan ?? snapshot?.dteAtScan),
    premiumYieldPct: computeRowPremiumYieldPct(row, snapshot),
    popEstimate: toNumberOrNull(row?.popEstimate ?? context?.popEstimate),
    optionDataBadge: buildLatestOptionSnapshotBadge(snapshot, diagnostics, storageStatus),
    hasObservedIbkrOptionData: diagnostics.hasObservedIbkrOptionData,
    optionDataCompletenessPct: diagnostics.optionDataCompletenessPct,
    optionDataMissingFields: diagnostics.optionDataMissingFields,
    optionDataSourceSummary: diagnostics.optionDataSourceSummary,
    optionSnapshotStorageStatus: storageStatus,
    optionQuoteSnapshot: {
      source: snapshot?.source ?? null,
      dataConfidence: snapshot?.dataConfidence ?? null,
      bid: toNumberOrNull(quote?.bid),
      ask: toNumberOrNull(quote?.ask),
      mid: toNumberOrNull(quote?.mid),
      last: toNumberOrNull(quote?.last),
      mark: toNumberOrNull(quote?.mark),
      spreadAbs: toNumberOrNull(quote?.spreadAbs),
      spreadPct: toNumberOrNull(quote?.spreadPct),
      impliedVolatility: toNumberOrNull(greeks?.impliedVolatility),
      delta: toNumberOrNull(greeks?.delta),
      gamma: toNumberOrNull(greeks?.gamma),
      theta: toNumberOrNull(greeks?.theta),
      vega: toNumberOrNull(greeks?.vega),
      modelPrice: toNumberOrNull(greeks?.modelPrice),
      modelGreeksTimestamp: greeks?.modelGreeksTimestamp ?? null,
      volume: toNumberOrNull(liquidity?.volume),
      openInterest: toNumberOrNull(liquidity?.openInterest),
      conId: contract?.conId ?? null,
      localSymbol: contract?.localSymbol ?? null,
      tradingClass: contract?.tradingClass ?? null,
      exchange: contract?.exchange ?? null,
      currency: contract?.currency ?? null,
      multiplier: contract?.multiplier ?? null,
      quoteTimestamp: quote?.quoteTimestamp ?? null,
      scanTimestamp: quote?.scanTimestamp ?? getStoredSnapshotScanTimestamp(row),
      missingFields: Array.isArray(snapshot?.missingFields) ? snapshot.missingFields : [],
      warnings,
    },
  };
}

function summarizeLatestOptionSnapshotRecords(records, latestScanTotalCount) {
  const rows = Array.isArray(records) ? records : [];
  const summary = {
    ibkrObservedCount: 0,
    yahooFallbackCount: 0,
    incompleteCount: 0,
    ivPresentCount: 0,
    deltaPresentCount: 0,
    bidAskPresentCount: 0,
    oiVolumePresentCount: 0,
    conIdPresentCount: 0,
    localSymbolPresentCount: 0,
    snapshotAbsentCount: Math.max(0, (latestScanTotalCount ?? rows.length) - rows.length),
  };

  for (const record of rows) {
    const snapshot = record?.optionQuoteSnapshot ?? {};
    if (record?.hasObservedIbkrOptionData) summary.ibkrObservedCount += 1;
    if (snapshot.source === "Yahoo" || snapshot.dataConfidence === "observed_yahoo") {
      summary.yahooFallbackCount += 1;
    }
    if ((record?.optionDataCompletenessPct ?? 0) < 100) summary.incompleteCount += 1;
    if (snapshot.impliedVolatility != null) summary.ivPresentCount += 1;
    if (snapshot.delta != null) summary.deltaPresentCount += 1;
    if (snapshot.bid != null && snapshot.ask != null) summary.bidAskPresentCount += 1;
    if (snapshot.openInterest != null || snapshot.volume != null) summary.oiVolumePresentCount += 1;
    if (snapshot.conId != null) summary.conIdPresentCount += 1;
    if (snapshot.localSymbol != null) summary.localSymbolPresentCount += 1;
  }

  return summary;
}

export function buildLatestOptionSnapshotsPayload(input = {}, options = {}) {
  const limit = toIntegerWithin(options?.limit, { min: 1, max: 50, fallback: 50 });
  const snapshotRows = Array.isArray(input?.rows) ? input.rows : [];
  const allRecords = snapshotRows.map((row) => buildLatestOptionSnapshotRecord(row));
  const latestScanSnapshotCount = input?.latestScanSnapshotCount ?? allRecords.length;
  const latestScanTotalCount = input?.latestScanTotalCount ?? latestScanSnapshotCount;

  return {
    ok: true,
    latestScanTimestamp:
      input?.latestScanTimestamp ?? getStoredSnapshotScanTimestamp(snapshotRows[0]) ?? null,
    totalWithSnapshot: input?.totalWithSnapshot ?? snapshotRows.length,
    latestScanSnapshotCount,
    records: allRecords.slice(0, limit),
    summary: summarizeLatestOptionSnapshotRecords(allRecords, latestScanTotalCount),
  };
}

function readLatestOptionSnapshotRowsFromSqlite(sqlitePath) {
  if (!sqlitePath) return null;
  if (!existsSync(sqlitePath)) return null;
  let conn = null;
  try {
    conn = new DatabaseSync(sqlitePath);
    const columns = new Set(
      conn.prepare("PRAGMA table_info(wheel_validation_records)").all().map((column) => column?.name).filter(Boolean)
    );
    const snapshotColumn = pickExistingColumn(columns, ["option_quote_snapshot_json"]);
    const scanColumn = pickExistingColumn(columns, [
      "scanTimestamp",
      "scan_timestamp",
      "created_at",
      "createdAt",
      "updated_at",
      "updatedAt",
      "scanDate",
    ]);
    if (!snapshotColumn || !scanColumn) {
      return {
        latestScanTimestamp: null,
        totalWithSnapshot: 0,
        latestScanSnapshotCount: 0,
        latestScanTotalCount: 0,
        rows: [],
      };
    }

    const snapshotSql = quoteSqlIdentifier(snapshotColumn);
    const scanSql = quoteSqlIdentifier(scanColumn);
    const snapshotWhere = `${snapshotSql} IS NOT NULL AND TRIM(CAST(${snapshotSql} AS TEXT)) != ''`;
    const latestRow = conn
      .prepare(
        `SELECT ${scanSql} AS latestScanTimestamp
         FROM wheel_validation_records
         WHERE ${snapshotWhere} AND ${scanSql} IS NOT NULL AND TRIM(CAST(${scanSql} AS TEXT)) != ''
         ORDER BY ${scanSql} DESC
         LIMIT 1`
      )
      .get();
    const latestScanTimestamp = latestRow?.latestScanTimestamp ?? null;
    const totalWithSnapshot =
      conn.prepare(`SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE ${snapshotWhere}`).get()?.cnt ?? 0;
    if (!latestScanTimestamp) {
      return {
        latestScanTimestamp: null,
        totalWithSnapshot,
        latestScanSnapshotCount: 0,
        latestScanTotalCount: 0,
        rows: [],
      };
    }

    const latestScanTotalCount =
      conn
        .prepare(`SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE ${scanSql} = @latestScanTimestamp`)
        .get({ latestScanTimestamp })?.cnt ?? 0;
    const latestScanSnapshotCount =
      conn
        .prepare(
          `SELECT COUNT(*) AS cnt
           FROM wheel_validation_records
           WHERE ${scanSql} = @latestScanTimestamp AND ${snapshotWhere}`
        )
        .get({ latestScanTimestamp })?.cnt ?? 0;

    const desiredColumns = [
      "id",
      "scanSessionId",
      "scanTimestamp",
      "scan_timestamp",
      "scanDate",
      "createdAt",
      "created_at",
      "updatedAt",
      "updated_at",
      "candidateRank",
      "symbol",
      "ticker",
      "strikeMode",
      "mode",
      "expiration",
      "selectedExpiration",
      "dteAtScan",
      "strike",
      "premium",
      "annualizedYield",
      "popEstimate",
      "option_quote_snapshot_json",
    ].filter((column, index, array) => columns.has(column) && array.indexOf(column) === index);
    const selectSql = desiredColumns.map(quoteSqlIdentifier).join(", ");
    const orderSql = columns.has("candidateRank")
      ? `${quoteSqlIdentifier("candidateRank")} IS NULL, ${quoteSqlIdentifier("candidateRank")} ASC, ${quoteSqlIdentifier("id")} ASC`
      : `${quoteSqlIdentifier("id")} ASC`;
    const rows = conn
      .prepare(
        `SELECT ${selectSql}
         FROM wheel_validation_records
         WHERE ${scanSql} = @latestScanTimestamp AND ${snapshotWhere}
         ORDER BY ${orderSql}`
      )
      .all({ latestScanTimestamp });

    return {
      latestScanTimestamp,
      totalWithSnapshot,
      latestScanSnapshotCount,
      latestScanTotalCount,
      rows,
    };
  } catch (_error) {
    return null;
  } finally {
    try {
      conn?.close?.();
    } catch (_error) {
      // Best-effort close only.
    }
  }
}

function buildLatestOptionSnapshotsFromLoadedJournal(journal) {
  const records = Array.isArray(journal?.records) ? journal.records : [];
  const snapshotRecords = records.filter(hasStoredOptionSnapshot);
  const latestScanTimestamp = snapshotRecords
    .map(getStoredSnapshotScanTimestamp)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const latestRows = latestScanTimestamp
    ? snapshotRecords.filter((record) => getStoredSnapshotScanTimestamp(record) === latestScanTimestamp)
    : [];
  const latestScanTotalCount = latestScanTimestamp
    ? records.filter((record) => getStoredSnapshotScanTimestamp(record) === latestScanTimestamp).length
    : 0;
  return {
    latestScanTimestamp,
    totalWithSnapshot: snapshotRecords.length,
    latestScanSnapshotCount: latestRows.length,
    latestScanTotalCount,
    rows: latestRows,
  };
}

function getDteBucketLabel(dteAtScan) {
  const dte = toNumberOrNull(dteAtScan);
  if (dte == null) return "DTE_UNKNOWN";
  if (dte <= 1) return "DTE_0_1";
  if (dte <= 3) return "DTE_2_3";
  if (dte <= 7) return "DTE_4_7";
  if (dte <= 14) return "DTE_8_14";
  return "DTE_15_PLUS";
}

function formatYmdForDisplay(value) {
  const normalized = normalizeYmd(value);
  if (normalized) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  const raw = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function computeHistoryDaysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const startUtc = new Date(`${startDate}T00:00:00.000Z`);
  const endUtc = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(startUtc.getTime()) || Number.isNaN(endUtc.getTime())) return null;
  return Math.max(1, Math.round((endUtc.getTime() - startUtc.getTime()) / 86400000) + 1);
}

// V3 — deduplicate resolved outcomes: ticker + mode + expirationDate (ignores strike/rescans).
function buildV3ExpirationCohortKey(ticker, mode, expiration) {
  const exp = normalizeYmd(expiration) || String(expiration ?? "").trim();
  return `${ticker}|${mode}|${exp}`;
}

function buildV3TickerExpirationCohortKey(ticker, expiration) {
  const exp = normalizeYmd(expiration) || String(expiration ?? "").trim();
  return `${ticker}|${exp}`;
}

function normalizeV3ProfileScope(scopeRaw) {
  const raw = String(scopeRaw ?? "ticker_mode_dte").trim().toLowerCase();
  if (raw === "ticker") return "ticker";
  if (raw === "ticker_mode") return "ticker_mode";
  if (raw === "ticker_mode_dte") return "ticker_mode_dte";
  return "ticker_mode_dte";
}

function buildV3ProfileGroupKey(record, scope) {
  const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
  const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
  const dteBucket = getDteBucketLabel(record?.dteAtScan);
  if (scope === "ticker") return ticker;
  if (scope === "ticker_mode") return `${ticker}|${mode}`;
  return `${ticker}|${mode}|${dteBucket}`;
}

function buildV3CohortKeyForScope(ticker, mode, expiration, scope) {
  if (scope === "ticker") return buildV3TickerExpirationCohortKey(ticker, expiration);
  return buildV3ExpirationCohortKey(ticker, mode, expiration);
}

const V3_SAMPLE_QUALITY_RANK = { strong: 4, medium: 3, preliminary: 2, weak: 1 };

function sortV3Profiles(profiles) {
  return [...profiles].sort((a, b) => {
    const qA = V3_SAMPLE_QUALITY_RANK[a.sampleQuality] ?? 0;
    const qB = V3_SAMPLE_QUALITY_RANK[b.sampleQuality] ?? 0;
    if (qB !== qA) return qB - qA;

    const primeA = a.primeStrengthLabel === "forte" ? 1 : 0;
    const primeB = b.primeStrengthLabel === "forte" ? 1 : 0;
    if (primeB !== primeA) return primeB - primeA;

    const assignA = a.assignmentRatePct ?? 999;
    const assignB = b.assignmentRatePct ?? 999;
    if (assignA !== assignB) return assignA - assignB;

    const expA = a.uniqueExpirationCount ?? 0;
    const expB = b.uniqueExpirationCount ?? 0;
    if (expB !== expA) return expB - expA;

    const yieldA = a.latestYieldPct ?? -1;
    const yieldB = b.latestYieldPct ?? -1;
    if (yieldB !== yieldA) return yieldB - yieldA;

    const tickerCmp = String(a.ticker).localeCompare(String(b.ticker));
    if (tickerCmp !== 0) return tickerCmp;

    const modeCmp = String(a.mode).localeCompare(String(b.mode));
    if (modeCmp !== 0) return modeCmp;

    return String(a.dteBucket).localeCompare(String(b.dteBucket));
  });
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
  const candidateExpiration = normalizeExpiration(
    candidate?.expiration ??
      candidate?.targetExpiration ??
      candidate?.ibkrDirect?.raw?.expiration ??
      candidate?.raw?.expiration
  );
  const scanDate = scanTimestamp.slice(0, 10);
  const selectedExpiration = normalizeExpiration(
    options.selectedExpiration ?? candidate?.targetExpiration ?? candidate?.selectedExpiration ?? candidate?.expiration
  );
  // Patch J2-B — quand l'UI fournit une selectedExpiration (expiration réelle du
  // contrat vendu), elle fait autorité : expiration ne doit jamais diverger de
  // selectedExpiration à la capture. Sinon on retombe sur l'ancien comportement
  // (expiration ← candidate.*). Empêche le décalage cohorte/contrat (+7j) à la
  // création. Ne re-résout rien, ne touche pas au schéma DB.
  const expiration = normalizeExpiration(options.selectedExpiration)
    ? selectedExpiration
    : candidateExpiration;
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
    // Phase 4A.1 — seasonality snapshot (Phase 1 cache-only : rempli depuis
    // seasonality_cache via options.seasonalitySnapshot quand disponible, sinon null).
    seasonality: options.seasonalitySnapshot ?? {
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
    optionQuoteSnapshot: buildOptionQuoteSnapshot({
      candidate,
      strikeMode,
      scanTimestamp,
      strikeRow,
    }),
    technicalSnapshot: buildTechnicalSnapshot({
      candidate,
      scanTimestamp,
    }),
    marketContextSnapshot: options.marketContextSnapshot ?? null,
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

const REAL_POP_BUCKET_DEFINITIONS = [
  { bucket: "97–100 %", match: (value) => value != null && value >= 97 && value <= 100 },
  { bucket: "95–97 %", match: (value) => value != null && value >= 95 && value < 97 },
  { bucket: "90–95 %", match: (value) => value != null && value >= 90 && value < 95 },
  { bucket: "85–90 %", match: (value) => value != null && value >= 85 && value < 90 },
  { bucket: "80–85 %", match: (value) => value != null && value >= 80 && value < 85 },
  { bucket: "<80 %", match: (value) => value != null && value < 80 },
];

const REAL_YIELD_BUCKET_DEFINITIONS = [
  { bucket: "<0,5 %", match: (value) => value != null && value < 0.5 },
  { bucket: "0,5–0,7 %", match: (value) => value != null && value >= 0.5 && value < 0.7 },
  { bucket: "0,7–0,9 %", match: (value) => value != null && value >= 0.7 && value < 0.9 },
  { bucket: "0,9–1,1 %", match: (value) => value != null && value >= 0.9 && value < 1.1 },
  { bucket: ">1,1 %", match: (value) => value != null && value >= 1.1 },
];

function getAnnouncedPopPct(record) {
  const probability = normalizePopToProbability(record?.strike?.popEstimate);
  return probability == null ? null : probability * 100;
}

function summarizeRealPopMetrics(rows) {
  const n = rows.length;
  if (n === 0) {
    return {
      tradesResolved: 0,
      avgPopAnnounced: null,
      realWinRate: null,
      assignmentRate: null,
      strikeTouchRate: null,
      lowerBoundBreakRate: null,
      avgPremium: null,
      avgYieldPct: null,
      popRealDelta: null,
    };
  }

  const outcomes = rows
    .map((record) => getCalibrationIsCorrect(record))
    .filter((value) => typeof value === "boolean");
  const winCount = outcomes.filter((value) => value === true).length;
  const realWinRate = outcomes.length > 0 ? (winCount / outcomes.length) * 100 : null;

  const pops = rows.map((record) => getAnnouncedPopPct(record)).filter((value) => value != null);
  const avgPopAnnounced =
    pops.length > 0 ? pops.reduce((sum, value) => sum + value, 0) / pops.length : null;
  const popRealDelta =
    realWinRate != null && avgPopAnnounced != null
      ? roundMetric(realWinRate - avgPopAnnounced, 1)
      : null;

  const assignedKnown = rows.filter((record) => getAssignedFlag(record) != null);
  const assignmentRate =
    assignedKnown.length > 0
      ? (assignedKnown.filter((record) => getAssignedFlag(record) === true).length /
          assignedKnown.length) *
        100
      : null;

  const strikeTouchedKnown = rows.filter((record) => getStrikeTouchedFlag(record) != null);
  const strikeTouchRate =
    strikeTouchedKnown.length > 0
      ? (strikeTouchedKnown.filter((record) => getStrikeTouchedFlag(record) === true).length /
          strikeTouchedKnown.length) *
        100
      : null;

  const lowerBoundKnown = rows.filter((record) => getBrokeLowerBoundFlag(record) != null);
  const lowerBoundBreakRate =
    lowerBoundKnown.length > 0
      ? (lowerBoundKnown.filter((record) => getBrokeLowerBoundFlag(record) === true).length /
          lowerBoundKnown.length) *
        100
      : null;

  const premiums = rows.map((record) => getPremiumCandidate(record)).filter((value) => value != null);
  const avgPremium =
    premiums.length > 0 ? roundMetric(premiums.reduce((sum, value) => sum + value, 0) / premiums.length, 4) : null;

  const yields = rows.map((record) => getRecordYieldPct(record)).filter((value) => value != null);
  const avgYieldPct =
    yields.length > 0 ? roundMetric(yields.reduce((sum, value) => sum + value, 0) / yields.length, 2) : null;

  return {
    tradesResolved: n,
    avgPopAnnounced: avgPopAnnounced == null ? null : roundMetric(avgPopAnnounced, 1),
    realWinRate: realWinRate == null ? null : roundMetric(realWinRate, 1),
    assignmentRate: assignmentRate == null ? null : roundMetric(assignmentRate, 1),
    strikeTouchRate: strikeTouchRate == null ? null : roundMetric(strikeTouchRate, 1),
    lowerBoundBreakRate: lowerBoundBreakRate == null ? null : roundMetric(lowerBoundBreakRate, 1),
    avgPremium,
    avgYieldPct,
    popRealDelta,
  };
}

function computeRealPopVerdict(metrics) {
  const n = metrics.tradesResolved ?? 0;
  const delta = metrics.popRealDelta;
  const win = metrics.realWinRate;
  const touch = metrics.strikeTouchRate;
  const lb = metrics.lowerBoundBreakRate;
  const assign = metrics.assignmentRate;

  if (n < 5) {
    return { verdict: "non prouvé", confidenceWarning: "échantillon < 5" };
  }

  let confidenceWarning = null;
  if (n < 20) confidenceWarning = "échantillon préliminaire";
  else if (n < 30) confidenceWarning = "échantillon < 30";
  else if (n < 50) confidenceWarning = "échantillon < 50";

  const stressCache =
    win != null &&
    win >= 75 &&
    ((touch != null && touch >= 35) ||
      (lb != null && lb >= 45) ||
      (assign != null && assign >= 15));

  if (stressCache) {
    return {
      verdict: "stress caché",
      confidenceWarning: confidenceWarning ?? "win élevé avec stress observé",
    };
  }

  if (delta != null && delta <= -5) {
    return { verdict: "POP optimiste", confidenceWarning };
  }
  if (delta != null && delta >= 5) {
    return { verdict: "POP conservateur", confidenceWarning };
  }
  if (n >= 30 && delta != null && Math.abs(delta) <= 3) {
    return { verdict: "bien calibré", confidenceWarning };
  }
  if (n >= 50 && delta != null && Math.abs(delta) <= 5) {
    return { verdict: "crédible", confidenceWarning };
  }
  if (n >= 20) {
    return { verdict: "mesurable", confidenceWarning };
  }
  return { verdict: "préliminaire", confidenceWarning };
}

function bucketizeRealPopRows(records, definitions, pickValue) {
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

  return buckets.map((entry) => {
    const metrics = summarizeRealPopMetrics(entry.rows);
    const { verdict, confidenceWarning } = computeRealPopVerdict(metrics);
    return {
      bucket: entry.bucket,
      ...metrics,
      verdict,
      confidenceWarning,
    };
  });
}

function buildRealPopYieldMatrix(records) {
  const matrix = [];
  for (const popDef of REAL_POP_BUCKET_DEFINITIONS) {
    for (const yieldDef of REAL_YIELD_BUCKET_DEFINITIONS) {
      const cellRows = records.filter((record) => {
        const pop = getAnnouncedPopPct(record);
        const yieldPct = getRecordYieldPct(record);
        return popDef.match(pop, record) && yieldDef.match(yieldPct, record);
      });
      const metrics = summarizeRealPopMetrics(cellRows);
      const { verdict, confidenceWarning } = computeRealPopVerdict(metrics);
      matrix.push({
        popBucket: popDef.bucket,
        yieldBucket: yieldDef.bucket,
        count: metrics.tradesResolved,
        winRate: metrics.realWinRate,
        assignmentRate: metrics.assignmentRate,
        avgPopAnnounced: metrics.avgPopAnnounced,
        popRealDelta: metrics.popRealDelta,
        verdict,
        confidenceWarning,
      });
    }
  }
  return matrix;
}

function isPrimaryResolvedExpiredCalibrationRecord(record, todayYmd) {
  if (record?.resolution?.resolved !== true) return false;
  if ((record?.captureClass ?? "primaryDaily") === "intradayRetest") return false;
  const expirationYmd = toExpirationYmd(record?.expiration ?? record?.expirationCohort);
  if (!expirationYmd || expirationYmd >= todayYmd) return false;
  if (record?.strike?.popEstimate == null) return false;
  return true;
}

function getAssignmentStrikeForDepth(record) {
  return (
    toNumberOrNull(record?.strike?.strike) ??
    toNumberOrNull(record?.strike) ??
    toNumberOrNull(record?.assignment_strike) ??
    null
  );
}

function getExpirationCloseForAssignmentDepth(record) {
  return (
    toNumberOrNull(record?.resolution?.underlying_close_at_expiration) ??
    toNumberOrNull(record?.resolution?.expirationClosePrice) ??
    toNumberOrNull(record?.underlying_close_at_expiration) ??
    toNumberOrNull(record?.expirationClosePrice) ??
    toNumberOrNull(record?.assignment_price) ??
    null
  );
}

function buildAssignmentDepthNaResult(warning = null) {
  return {
    assignmentDepthPct: null,
    assignmentDepthClass: "na",
    assignmentDepthLabel: "N/D",
    assignmentDepthWarning: warning,
  };
}

/**
 * Classifie la profondeur d'une assignation CSP vs le strike à l'expiration.
 * Pur — dérivation à la volée, sans persistance SQLite.
 */
export function classifyAssignmentDepth(record) {
  const assigned =
    getAssignedFlag(record) === true ||
    record?.assigned === true ||
    record?.assigned === 1 ||
    record?.assigned_flag === 1;

  if (!assigned) {
    return buildAssignmentDepthNaResult(null);
  }

  const strike = getAssignmentStrikeForDepth(record);
  const closeExpiration = getExpirationCloseForAssignmentDepth(record);

  if (strike == null || closeExpiration == null || !(strike > 0)) {
    return buildAssignmentDepthNaResult("Données insuffisantes");
  }

  const assignmentDepthPct = Number((((closeExpiration - strike) / strike) * 100).toFixed(2));

  if (assignmentDepthPct <= 0 && assignmentDepthPct >= -1.5) {
    return {
      assignmentDepthPct,
      assignmentDepthClass: "proche",
      assignmentDepthLabel: "proche",
      assignmentDepthWarning: "Assignation proche du strike — CC potentiellement exploitable",
    };
  }

  if (assignmentDepthPct < -1.5 && assignmentDepthPct >= -4) {
    return {
      assignmentDepthPct,
      assignmentDepthClass: "moderee",
      assignmentDepthLabel: "modérée",
      assignmentDepthWarning: "Assignation modérée — surveiller recovery",
    };
  }

  if (assignmentDepthPct < -4) {
    return {
      assignmentDepthPct,
      assignmentDepthClass: "profonde",
      assignmentDepthLabel: "profonde",
      assignmentDepthWarning: "Assignation profonde — risque de capital bloqué",
    };
  }

  return buildAssignmentDepthNaResult("Données insuffisantes");
}

export function enrichWithAssignmentDepthFields(entity) {
  if (!entity || typeof entity !== "object") return entity;
  return { ...entity, ...classifyAssignmentDepth(entity) };
}

export function summarizeAssignmentDepthCounts(entities) {
  const summary = { proche: 0, moderee: 0, profonde: 0, nd: 0 };
  for (const entity of Array.isArray(entities) ? entities : []) {
    const depth = classifyAssignmentDepth(entity);
    if (depth.assignmentDepthClass === "proche") summary.proche += 1;
    else if (depth.assignmentDepthClass === "moderee") summary.moderee += 1;
    else if (depth.assignmentDepthClass === "profonde") summary.profonde += 1;
    else summary.nd += 1;
  }
  return summary;
}

export function computeRealPopCalibration(records, options = {}) {
  const todayYmd = normalizeIsoTimestamp(options.today ?? options.asOfDate ?? new Date())
    .slice(0, 10);
  const allRecords = Array.isArray(records) ? records : [];

  const totalRecords = allRecords.length;
  const resolvedRecords = allRecords.filter((record) => record?.resolution?.resolved === true).length;
  const excludedIntradayRetests = allRecords.filter(
    (record) =>
      record?.resolution?.resolved === true &&
      (record?.captureClass ?? "primaryDaily") === "intradayRetest"
  ).length;

  let futureExpiration = 0;
  let pastUnresolved = 0;
  for (const record of allRecords) {
    const expirationYmd = toExpirationYmd(record?.expiration ?? record?.expirationCohort);
    if (!expirationYmd) continue;
    const isResolved = record?.resolution?.resolved === true;
    if (expirationYmd >= todayYmd) {
      futureExpiration += 1;
    } else if (!isResolved) {
      pastUnresolved += 1;
    }
  }

  const calibrationRecords = allRecords.filter((record) =>
    isPrimaryResolvedExpiredCalibrationRecord(record, todayYmd)
  );
  const primaryResolvedExpired = calibrationRecords.length;
  const excludedFromCalibration = totalRecords - primaryResolvedExpired;

  const buckets = bucketizeRealPopRows(
    calibrationRecords,
    REAL_POP_BUCKET_DEFINITIONS,
    (record) => getAnnouncedPopPct(record)
  );
  const matrix = buildRealPopYieldMatrix(calibrationRecords);

  return {
    calibration: {
      asOfDate: todayYmd,
      primaryResolvedExpired,
      totalRecords,
      resolvedRecords,
      excludedIntradayRetests,
      buckets,
    },
    matrix,
    pending: {
      futureExpiration,
      pastUnresolved,
      excludedFromCalibration,
    },
  };
}

const ONE_PERCENT_YIELD_TARGET_PCT = 0.9;
const ONE_PERCENT_MIN_MODE_PROFILE_N = 15;
const ONE_PERCENT_LB_ELEVATED_MIN_PCT = 15;

/**
 * Classifie le signal LB cassé pour un profil Objectif 1 %+ (stress de modèle vs dommage réel).
 */
export function classifyLowerBoundStressForOnePercentProfile(profileMetrics) {
  const n =
    toNumberOrNull(profileMetrics?.n) ??
    toNumberOrNull(profileMetrics?.recordsResolved) ??
    toNumberOrNull(profileMetrics?.csp?.recordsResolved) ??
    0;
  const lb =
    toNumberOrNull(profileMetrics?.lowerBoundBreakRate) ??
    toNumberOrNull(profileMetrics?.csp?.lowerBoundBreakRate);
  const win =
    toNumberOrNull(profileMetrics?.realWinRate) ?? toNumberOrNull(profileMetrics?.csp?.realWinRate);
  const assign =
    toNumberOrNull(profileMetrics?.assignmentRate) ??
    toNumberOrNull(profileMetrics?.csp?.assignmentRate);
  const touch =
    toNumberOrNull(profileMetrics?.strikeTouchRate) ??
    toNumberOrNull(profileMetrics?.csp?.strikeTouchRate);
  const profondeRate =
    toNumberOrNull(profileMetrics?.profondeRatePct) ??
    toNumberOrNull(profileMetrics?.assignment?.profondeRatePct);
  const profondeCount =
    toNumberOrNull(profileMetrics?.profondeCount) ??
    toNumberOrNull(profileMetrics?.assignment?.profondeCount) ??
    0;
  const wheel = profileMetrics?.wheel ?? {};
  const hasClosedCycles = (wheel.cyclesClosed ?? 0) > 0;
  const closedPnl = toNumberOrNull(wheel.avgWheelPnl);
  const recoveryRate = toNumberOrNull(wheel.recoveryRatePct);
  const cyclesAvailable = wheel.cyclesAvailable ?? 0;
  const recoveryWeak =
    recoveryRate != null && recoveryRate < 40 && cyclesAvailable >= 2;
  const wheelPnlWeak = hasClosedCycles && closedPnl != null && closedPnl <= 0;

  if (n < 15 || lb == null) {
    return {
      lbStressClass: "non_determinant",
      lbStressLabel: "LB non déterminant",
      lbStressReason:
        n < 15
          ? "Échantillon limité pour interpréter le LB cassé"
          : "Taux LB cassé non disponible sur l'échantillon",
    };
  }

  if (lb < ONE_PERCENT_LB_ELEVATED_MIN_PCT) {
    return {
      lbStressClass: "none",
      lbStressLabel: "LB non problématique",
      lbStressReason: `LB cassé faible (${roundMetric(lb, 1)}% sous le seuil ${ONE_PERCENT_LB_ELEVATED_MIN_PCT}%)`,
    };
  }

  const assignHigh = assign != null && assign >= 25;
  const profondeHigh = profondeRate != null && profondeRate >= 30;
  const touchStressLevel = touch != null && touch >= 35;
  const winStrong = win == null || win >= 85;
  const assignLow = assign == null || assign <= 15;
  const profondeLow = profondeRate == null || profondeRate < 20;
  const wheelOk = !hasClosedCycles || closedPnl == null || closedPnl > 0;

  if (
    (lb >= 25 && (assignHigh || profondeHigh || wheelPnlWeak)) ||
    (lb >= 15 && recoveryWeak && (assignHigh || profondeCount >= 1)) ||
    (lb >= 50 && win != null && win < 80)
  ) {
    const parts = [`LB cassé ${roundMetric(lb, 1)}%`];
    if (assignHigh) parts.push(`assignation ${roundMetric(assign, 1)}%`);
    if (profondeHigh) parts.push(`profondeur ${roundMetric(profondeRate, 1)}%`);
    if (wheelPnlWeak) parts.push("P/L Wheel faible");
    if (recoveryWeak) parts.push("recovery faible");
    return {
      lbStressClass: "critique",
      lbStressLabel: "LB cassé critique",
      lbStressReason: `${parts.join(" · ")} — risque réel sur le cycle`,
    };
  }

  if (winStrong && assignLow && profondeLow && wheelOk && !touchStressLevel && !assignHigh) {
    return {
      lbStressClass: "sans_dommage",
      lbStressLabel: "LB cassé sans dommage",
      lbStressReason: `LB cassé ${roundMetric(lb, 1)}% mais win CSP ${win == null ? "N/D" : `${roundMetric(win, 1)}%`} et assignation faible — stress théorique`,
    };
  }

  const stressParts = [`LB cassé ${roundMetric(lb, 1)}%`];
  if (touchStressLevel) stressParts.push(`touch ${roundMetric(touch, 1)}%`);
  if (assign != null && assign > 15) stressParts.push(`assignation ${roundMetric(assign, 1)}%`);
  if (win != null && win < 85) stressParts.push(`win CSP ${roundMetric(win, 1)}%`);

  return {
    lbStressClass: "avec_stress",
    lbStressLabel: "LB cassé avec stress",
    lbStressReason: `${stressParts.join(" · ")} — surveiller touch et assignation`,
  };
}

function isLowerBoundStressDamagingForOnePercent(lbStressClass) {
  return lbStressClass === "avec_stress" || lbStressClass === "critique";
}

function isOnePercentProfileRecord(record, todayYmd) {
  if (!getResolvedFlag(record)) return false;
  if ((record?.captureClass ?? "primaryDaily") === "intradayRetest") return false;
  // Patch J2-B — éligibilité Top 20 / Objectif 1%+ basée sur l'expiration réelle
  // du contrat (selectedExpiration) et non la cohorte. Aligne ce filtre sur
  // resolveExpiredRecords (selectedExpiration ?? expiration) pour ne plus inclure
  // un record « expiré » jusqu'à 7j avant la vraie expiration. Seuils/verdicts inchangés.
  const expirationYmd = toExpirationYmd(
    record?.selectedExpiration ?? record?.expiration ?? record?.expirationCohort
  );
  if (!expirationYmd || expirationYmd >= todayYmd) return false;
  return true;
}

function getTheoreticalCycleExitStatusForProfile(cycle) {
  if (cycle?.cycle_status === "closed" || String(cycle?.status ?? "").toLowerCase() === "closed_theoretical") {
    return "closed";
  }
  return "open";
}

function getTheoreticalCycleMultiCcForProfile(cycle) {
  const m = cycle?.multi_cc_summary;
  return {
    ccSold: toNumberOrNull(cycle?.cc_sold_count ?? m?.cc_sold_count) ?? 0,
    ccWait: toNumberOrNull(cycle?.cc_not_sold_count ?? m?.cc_not_sold_count) ?? 0,
    weeksWithoutCc: toNumberOrNull(cycle?.weeks_without_cc ?? m?.weeks_without_cc) ?? 0,
    totalPremium: toNumberOrNull(cycle?.total_cc_premium_conservative ?? m?.total_cc_premium_conservative),
  };
}

function normalizeCycleStrikeMode(cycle) {
  const raw = String(cycle?.strike_mode ?? "").trim().toLowerCase();
  if (raw === "safe" || raw === "aggressive") return raw;
  return null;
}

function buildOnePercentSampleCredibility(n) {
  if (n < 5) return "non prouvé";
  if (n < 15) return "très préliminaire";
  if (n < 30) return "préliminaire";
  if (n < 50) return "mesurable";
  return "mesurable";
}

function buildOnePercentRate(rows, selector, useKnownOnly = false) {
  const src = useKnownOnly ? rows.filter((row) => selector(row) != null) : rows;
  if (src.length === 0) return null;
  return roundMetric((src.filter((row) => selector(row) === true).length / src.length) * 100, 1);
}

function summarizeOnePercentCspMetrics(rows) {
  const n = rows.length;
  const yields = rows.map((record) => getRecordYieldPct(record)).filter((value) => value != null);
  const highYieldRows = rows.filter((record) => {
    const y = getRecordYieldPct(record);
    return y != null && y >= ONE_PERCENT_YIELD_TARGET_PCT;
  });
  const highMetrics = summarizeRealPopMetrics(highYieldRows);
  const baseMetrics = summarizeRealPopMetrics(rows);

  const outcomes = rows
    .map((record) => getCalibrationIsCorrect(record))
    .filter((value) => typeof value === "boolean");
  const realWinRate =
    outcomes.length > 0
      ? roundMetric((outcomes.filter((value) => value === true).length / outcomes.length) * 100, 1)
      : null;

  return {
    recordsResolved: n,
    recordsTotal: n,
    avgYieldPct: yields.length > 0 ? roundMetric(average(yields), 2) : null,
    medianYieldPct: yields.length > 0 ? roundMetric(median(yields), 2) : null,
    avgPopAnnounced: baseMetrics.avgPopAnnounced,
    realWinRate,
    assignmentRate: baseMetrics.assignmentRate,
    strikeTouchRate: baseMetrics.strikeTouchRate,
    lowerBoundBreakRate: baseMetrics.lowerBoundBreakRate,
    highYieldCount: highYieldRows.length,
    highYieldRatePct: n > 0 ? roundMetric((highYieldRows.length / n) * 100, 1) : null,
    highYieldRealWinRate: highMetrics.realWinRate,
    highYieldAssignmentRate: highMetrics.assignmentRate,
    highYieldStrikeTouchRate: highMetrics.strikeTouchRate,
    highYieldLowerBoundBreakRate: highMetrics.lowerBoundBreakRate,
  };
}

function summarizeOnePercentAssignmentMetrics(rows) {
  const assignedRows = rows.filter((record) => getAssignedFlag(record) === true);
  const depthCounts = summarizeAssignmentDepthCounts(assignedRows);
  const depthPcts = assignedRows
    .map((record) => classifyAssignmentDepth(record).assignmentDepthPct)
    .filter((value) => value != null);

  const totalAssignments = assignedRows.length;
  return {
    totalAssignments,
    procheCount: depthCounts.proche,
    modereeCount: depthCounts.moderee,
    profondeCount: depthCounts.profonde,
    ndCount: depthCounts.nd,
    procheRatePct:
      totalAssignments > 0 ? roundMetric((depthCounts.proche / totalAssignments) * 100, 1) : null,
    profondeRatePct:
      totalAssignments > 0 ? roundMetric((depthCounts.profonde / totalAssignments) * 100, 1) : null,
    avgDepthPct: depthPcts.length > 0 ? roundMetric(average(depthPcts), 2) : null,
  };
}

function summarizeOnePercentWheelMetrics(cycles) {
  const all = Array.isArray(cycles) ? cycles : [];
  if (all.length === 0) {
    return {
      cyclesAvailable: 0,
      cyclesClosed: 0,
      cyclesOpen: 0,
      recoveryRatePct: null,
      avgDaysBelowStrike: null,
      avgCcSold: null,
      avgCcWait: null,
      avgCcPremiumCumulative: null,
      avgCcYieldPct: null,
      calledAwayRatePct: null,
      avgWheelPnl: null,
      avgWheelReturnPct: null,
      avgCycleDurationDays: null,
    };
  }

  const closed = all.filter((cycle) => getTheoreticalCycleExitStatusForProfile(cycle) === "closed");
  const open = all.filter((cycle) => getTheoreticalCycleExitStatusForProfile(cycle) === "open");
  const recoveryKnown = all.filter(
    (cycle) => cycle?.assignment_recovered === 1 || cycle?.assignment_recovered === 0,
  );
  const recoveryRatePct =
    recoveryKnown.length > 0
      ? roundMetric(
          (recoveryKnown.filter((cycle) => cycle?.assignment_recovered === 1).length / recoveryKnown.length) *
            100,
          1,
        )
      : null;

  const multiSummaries = all.map((cycle) => getTheoreticalCycleMultiCcForProfile(cycle));
  const daysBelow = all
    .map((cycle) => toNumberOrNull(cycle?.days_below_assignment_strike))
    .filter((value) => value != null);
  const ccYields = all
    .map((cycle) => toNumberOrNull(cycle?.first_cc_step?.cc_yield_conservative_pct))
    .filter((value) => value != null);
  const ccPremiums = multiSummaries
    .map((summary) => summary.totalPremium)
    .filter((value) => value != null);

  const calledAwayClosed =
    closed.length > 0
      ? closed.filter((cycle) => cycle?.close_reason === "cc_called_away").length
      : 0;
  const calledAwayRatePct =
    closed.length > 0 ? roundMetric((calledAwayClosed / closed.length) * 100, 1) : null;

  const closedPnl = closed
    .map((cycle) => toNumberOrNull(cycle?.total_pnl_contract) ?? toNumberOrNull(cycle?.total_pnl_per_share))
    .filter((value) => value != null);
  const closedReturns = closed
    .map((cycle) => toNumberOrNull(cycle?.return_on_assignment_pct))
    .filter((value) => value != null);
  const closedDurations = closed
    .map(
      (cycle) =>
        toNumberOrNull(cycle?.days_in_cycle) ?? toNumberOrNull(cycle?.days_after_assignment_to_exit),
    )
    .filter((value) => value != null);

  return {
    cyclesAvailable: all.length,
    cyclesClosed: closed.length,
    cyclesOpen: open.length,
    recoveryRatePct,
    avgDaysBelowStrike: daysBelow.length > 0 ? roundMetric(average(daysBelow), 1) : null,
    avgCcSold:
      multiSummaries.length > 0
        ? roundMetric(average(multiSummaries.map((summary) => summary.ccSold)), 2)
        : null,
    avgCcWait:
      multiSummaries.length > 0
        ? roundMetric(average(multiSummaries.map((summary) => summary.ccWait)), 2)
        : null,
    avgCcPremiumCumulative: ccPremiums.length > 0 ? roundMetric(average(ccPremiums), 4) : null,
    avgCcYieldPct: ccYields.length > 0 ? roundMetric(average(ccYields), 2) : null,
    calledAwayRatePct,
    avgWheelPnl: closedPnl.length > 0 ? roundMetric(average(closedPnl), 4) : null,
    avgWheelReturnPct: closedReturns.length > 0 ? roundMetric(average(closedReturns), 2) : null,
    avgCycleDurationDays: closedDurations.length > 0 ? roundMetric(average(closedDurations), 1) : null,
  };
}

function buildOnePercentVerdictReasons(metrics) {
  const {
    n,
    credibility,
    highYieldSignal,
    moderateYieldSignal,
    touchStress,
    lbStress,
    lowerBoundStress,
    assignHigh,
    profondeHigh,
    wheel,
    wheelPnlWeak,
    wheelPnlPositive,
    ccWaitDominant,
    recoveryWeak,
    recoveryOk,
    calledAwayOk,
    winOk,
    win,
    procheRate,
    procheCount,
    ccSold,
    primaryVerdict,
  } = metrics;

  const reasons = [];

  if (credibility === "non prouvé") reasons.push("Échantillon non prouvé");
  else if (credibility === "très préliminaire") reasons.push("Échantillon très préliminaire");
  else if (credibility === "préliminaire") reasons.push("Échantillon préliminaire");
  else if (n >= 30) reasons.push("Échantillon mesurable");

  if (highYieldSignal) reasons.push("Rendement CSP élevé");
  else if (moderateYieldSignal) reasons.push("Rendement CSP modéré");

  if (touchStress) reasons.push("Touch élevé");
  if (lowerBoundStress?.lbStressClass && lowerBoundStress.lbStressClass !== "none") {
    reasons.push(lowerBoundStress.lbStressLabel);
  } else if (lbStress) {
    reasons.push("LB cassé élevé");
  }
  if (assignHigh) reasons.push("Assignation élevée");
  if (profondeHigh) reasons.push("Assignation profonde");
  if (assignHigh && procheRate != null && procheRate < 20) reasons.push("Peu d'assignations proches");

  if ((wheel.cyclesAvailable ?? 0) === 0) reasons.push("Wheel non disponible");
  if (wheelPnlWeak) reasons.push("P/L Wheel faible");
  if (ccWaitDominant && (wheel.cyclesAvailable ?? 0) > 0) reasons.push("Attente CC dominante");
  if (recoveryWeak) reasons.push("Recovery faible");
  if (!winOk && win != null) reasons.push("Win CSP faible");

  if (primaryVerdict === "1 % défendable") {
    if (
      !touchStress &&
      (!lbStress || lowerBoundStress?.lbStressClass === "sans_dommage")
    ) {
      reasons.push("Stress maîtrisé");
    }
    if (wheelPnlPositive) reasons.push("P/L Wheel positif");
  } else if (primaryVerdict === "faux 1 %") {
    reasons.push("Prime élevée mais cycle fragile");
  } else if (primaryVerdict === "1 % à valider" && n >= 15 && n < 30) {
    reasons.push("Validation après n≥30");
  } else if (primaryVerdict === "assignation exploitable") {
    if (procheCount >= 2) reasons.push("Assignations proches");
    if (recoveryOk) reasons.push("Recovery correcte");
    if (ccSold > 0) reasons.push("CC vendus");
  } else if (primaryVerdict === "assignation défavorable" && profondeHigh) {
    reasons.push("Profondeur défavorable");
  } else if (primaryVerdict === "Wheel favorable" && calledAwayOk) {
    reasons.push("Called away favorable");
  } else if (primaryVerdict === "capital bloqué") {
    reasons.push("Cycles ouverts bloquants");
  }

  return [...new Set(reasons)].slice(0, 6);
}

function buildOnePercentProfileVerdicts(ctx) {
  const verdicts = [];
  const n = ctx.n;
  const credibility = buildOnePercentSampleCredibility(n);
  const avgYield = ctx.csp.avgYieldPct;
  const highYieldRate = ctx.csp.highYieldRatePct;
  const win = ctx.csp.realWinRate;
  const assign = ctx.csp.assignmentRate;
  const touch = ctx.csp.strikeTouchRate;
  const lb = ctx.csp.lowerBoundBreakRate;
  const profondeRate = ctx.assignment.profondeRatePct;
  const procheRate = ctx.assignment.procheRatePct;
  const wheel = ctx.wheel;
  const ccWait = wheel.avgCcWait ?? 0;
  const ccSold = wheel.avgCcSold ?? 0;
  const ccWaitDominant = ccSold + ccWait > 0 && ccWait > ccSold;
  const closedPnl = wheel.avgWheelPnl;
  const hasClosedCycles = (wheel.cyclesClosed ?? 0) > 0;

  if (credibility === "non prouvé" || credibility === "très préliminaire") {
    verdicts.push(credibility);
  } else if (credibility === "préliminaire") {
    verdicts.push("préliminaire");
  } else {
    verdicts.push("mesurable");
  }

  const highYieldSignal =
    (avgYield != null && avgYield >= ONE_PERCENT_YIELD_TARGET_PCT) ||
    (highYieldRate != null && highYieldRate >= 30);
  const moderateYieldSignal = avgYield != null && avgYield >= 0.75;
  const winOk = win == null || win >= 60;
  const assignHigh = assign != null && assign >= 25;
  const profondeHigh = profondeRate != null && profondeRate >= 30;
  const profondeLow = profondeRate == null || profondeRate < 20;
  const touchStress = touch != null && touch >= 35;
  const lbStress = lb != null && lb >= ONE_PERCENT_LB_ELEVATED_MIN_PCT;
  const lowerBoundStress = classifyLowerBoundStressForOnePercentProfile({
    n,
    csp: ctx.csp,
    assignment: ctx.assignment,
    wheel,
  });
  const lbStressDamaging = isLowerBoundStressDamagingForOnePercent(lowerBoundStress.lbStressClass);
  const wheelPnlWeak = hasClosedCycles && closedPnl != null && closedPnl <= 0;
  const wheelPnlPositive = hasClosedCycles && closedPnl != null && closedPnl > 0;
  const recoveryWeak =
    wheel.recoveryRatePct != null && wheel.recoveryRatePct < 40 && (wheel.cyclesAvailable ?? 0) >= 2;
  const recoveryOk = wheel.recoveryRatePct == null || wheel.recoveryRatePct >= 50;
  const calledAwayOk = wheel.calledAwayRatePct != null && wheel.calledAwayRatePct >= 25;

  if (n >= 30 && highYieldSignal && assignHigh && (profondeHigh || ccWaitDominant || recoveryWeak || wheelPnlWeak)) {
    verdicts.push("faux 1 %");
  } else if (
    n >= 30 &&
    (moderateYieldSignal || highYieldSignal) &&
    winOk &&
    profondeLow &&
    !touchStress &&
    !lbStressDamaging &&
    (!hasClosedCycles || wheelPnlPositive) &&
    !ccWaitDominant
  ) {
    verdicts.push("1 % défendable");
  } else if (
    highYieldSignal &&
    (touchStress || lbStressDamaging || assignHigh || profondeHigh || wheelPnlWeak)
  ) {
    verdicts.push("1 % stressé");
  } else if (n >= 15 && n < 30 && (moderateYieldSignal || highYieldSignal)) {
    verdicts.push("1 % à valider");
  }

  if (
    (ctx.assignment.procheCount ?? 0) >= 2 &&
    profondeLow &&
    (ccSold > 0 || calledAwayOk) &&
    recoveryOk &&
    (!hasClosedCycles || wheelPnlPositive || calledAwayOk)
  ) {
    verdicts.push("assignation exploitable");
  } else if (profondeHigh || (assignHigh && procheRate != null && procheRate < 20)) {
    verdicts.push("assignation défavorable");
  }

  if (calledAwayOk && (!hasClosedCycles || wheelPnlPositive)) {
    verdicts.push("Wheel favorable");
  }
  if (ccWaitDominant && (wheel.cyclesAvailable ?? 0) > 0) {
    verdicts.push("CC insuffisants");
  }
  if (profondeHigh && (wheel.cyclesOpen ?? 0) > 0 && !calledAwayOk) {
    verdicts.push("capital bloqué");
  }

  const unique = [...new Set(verdicts)];
  const priority = [
    "faux 1 %",
    "1 % défendable",
    "1 % stressé",
    "1 % à valider",
    "assignation exploitable",
    "assignation défavorable",
    "Wheel favorable",
    "CC insuffisants",
    "capital bloqué",
    "mesurable",
    "préliminaire",
    "très préliminaire",
    "non prouvé",
  ];
  const primaryVerdict = priority.find((item) => unique.includes(item)) ?? unique[0] ?? "non prouvé";

  const verdictReasonMetrics = {
    n,
    credibility,
    highYieldSignal,
    moderateYieldSignal,
    touchStress,
    lbStress,
    lowerBoundStress,
    assignHigh,
    profondeHigh,
    wheel,
    wheelPnlWeak,
    wheelPnlPositive,
    ccWaitDominant,
    recoveryWeak,
    recoveryOk,
    calledAwayOk,
    winOk,
    win,
    procheRate,
    procheCount: ctx.assignment.procheCount ?? 0,
    ccSold,
    primaryVerdict,
  };

  if (n < 30 && unique.includes("1 % défendable")) {
    const filtered = unique.filter((item) => item !== "1 % défendable");
    if (!filtered.includes("1 % à valider") && n >= 15) filtered.push("1 % à valider");
    const adjustedPrimary = priority.find((item) => filtered.includes(item)) ?? "1 % à valider";
    return {
      verdicts: filtered,
      primaryVerdict: adjustedPrimary,
      sampleCredibility: credibility,
      lowerBoundStress,
      verdictReasons: buildOnePercentVerdictReasons({
        ...verdictReasonMetrics,
        primaryVerdict: adjustedPrimary,
      }),
    };
  }

  return {
    verdicts: unique,
    primaryVerdict,
    sampleCredibility: credibility,
    lowerBoundStress,
    verdictReasons: buildOnePercentVerdictReasons(verdictReasonMetrics),
  };
}

function scoreOnePercentProfileForSort(profile) {
  const verdict = profile?.primaryVerdict ?? "";
  const verdictScoreMap = {
    "1 % défendable": 1000,
    "assignation exploitable": 900,
    "Wheel favorable": 850,
    "1 % à valider": 700,
    "mesurable": 500,
    "préliminaire": 300,
    "très préliminaire": 150,
    "1 % stressé": 100,
    "faux 1 %": 50,
    "CC insuffisants": 40,
    "assignation défavorable": 30,
    "capital bloqué": 20,
    "non prouvé": 10,
  };
  let score = verdictScoreMap[verdict] ?? 0;
  score += Math.min(profile?.csp?.recordsResolved ?? 0, 100);
  score += profile?.csp?.avgYieldPct ?? 0;
  if (profile?.wheel?.avgWheelReturnPct != null) score += profile.wheel.avgWheelReturnPct;
  return score;
}

function buildOnePercentProfile({
  ticker,
  mode,
  groupType,
  records,
  cycles,
  recordsTotalInTicker,
}) {
  const n = records.length;
  const csp = summarizeOnePercentCspMetrics(records);
  csp.recordsTotal = recordsTotalInTicker ?? n;
  const assignment = summarizeOnePercentAssignmentMetrics(records);
  const wheel = summarizeOnePercentWheelMetrics(cycles);
  const { verdicts, primaryVerdict, sampleCredibility, verdictReasons, lowerBoundStress } =
    buildOnePercentProfileVerdicts({
      n,
      csp,
      assignment,
      wheel,
    });

  const displayMode =
    groupType === "ticker"
      ? "GLOBAL"
      : String(mode ?? "").trim().toLowerCase() === "aggressive"
      ? "AGRESSIF"
      : String(mode ?? "").trim().toLowerCase() === "safe"
      ? "SAFE"
      : "—";
  const optionData = summarizeOptionDataForProfile(records);
  const optionDiagnostics = summarizeOptionQuoteDiagnosticsFromProfile({ optionData });

  return {
    ticker,
    mode: displayMode,
    groupType,
    sampleCredibility,
    verdicts,
    primaryVerdict,
    verdictReasons,
    lowerBoundStress,
    csp,
    onePercentObjective: {
      highYieldCount: csp.highYieldCount,
      highYieldRatePct: csp.highYieldRatePct,
      highYieldRealWinRate: csp.highYieldRealWinRate,
      highYieldAssignmentRate: csp.highYieldAssignmentRate,
      highYieldStrikeTouchRate: csp.highYieldStrikeTouchRate,
      highYieldLowerBoundBreakRate: csp.highYieldLowerBoundBreakRate,
    },
    assignment,
    wheel,
    optionData,
    ...optionDiagnostics,
    // J5-B1 — bloc additif « décision réelle » (BALANCED). N'entre dans aucun score/tri.
    realisticDecisionMetrics: computeRealisticDecisionMetrics(records, { policy: "BALANCED" }),
    sortScore: 0,
  };
}

// ── J5-B1 — Métriques « décision réelle » additives (politique BALANCED) ──────
// Strictement additif. Ne modifie AUCUN score, tri ni verdict (Top 20 / 1%+).
const REALISTIC_DECISION_PREFERRED_DTE = new Set([7, 4]);
const REALISTIC_DECISION_MIN_CSP_YIELD_PCT = 0.5;
const REALISTIC_DECISION_SAFE_TIE_BREAK_PCT = 0.15;

// ── J5-B6 — Remplissage Top 20 réaliste « à confirmer » ───────────────────────
// Quand les stricts (selectedTradeCount≥5 + garde-fous) sont insuffisants pour
// remplir 20 lignes, on autorise des candidats « à confirmer » à compléter le
// Top 20 DERRIÈRE les stricts. Ces candidats ont un échantillon décision réelle
// encore faible (3–4 décisions) mais un échantillon observationnel suffisant et
// les mêmes garde-fous qualité (rendement réel ≥0,5 %, profondeur réelle ≤50 %).
const REALISTIC_CONFIRM_MIN_TRADE_COUNT = 3;
const REALISTIC_STRICT_MIN_TRADE_COUNT = 5;
const REALISTIC_CONFIRM_MIN_OBS_RESOLVED = 15;

function realisticDecisionNormMode(record) {
  const m = String(record?.strikeMode ?? "").trim().toLowerCase();
  if (m === "safe") return "SAFE";
  if (m === "aggressive" || m === "agressif") return "AGGRESSIVE";
  return "OTHER";
}

function realisticDecisionExpirationKey(record) {
  return (
    toExpirationYmd(record?.selectedExpiration ?? record?.expiration ?? record?.expirationCohort) ??
    null
  );
}

// Hiérarchie résultat/risque : 0 non assigné < 1 proche < 2 modérée < 3 profonde.
function realisticDecisionRiskTier(record) {
  if (getAssignedFlag(record) !== true) return 0;
  const depthClass = classifyAssignmentDepth(record).assignmentDepthClass;
  if (depthClass === "proche") return 1;
  if (depthClass === "moderee") return 2;
  if (depthClass === "profonde") return 3;
  return 2;
}

function realisticDecisionStableCompare(a, b) {
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

// Sélection BALANCED déterministe d'une observation par groupe (ticker × expiration).
function selectBalancedRealisticDecision(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const admissible = candidates.filter((r) => {
    const y = getRecordYieldPct(r);
    return y != null && y >= REALISTIC_DECISION_MIN_CSP_YIELD_PCT;
  });
  const pool = admissible.length > 0 ? admissible : candidates;
  if (pool.length === 0) return [...candidates].sort(realisticDecisionStableCompare)[0] ?? null;

  const maxYield = Math.max(
    0,
    ...admissible.map((r) => getRecordYieldPct(r)).filter((y) => y != null),
  );

  const sorted = [...pool].sort((a, b) => {
    // 1-4 : non assigné > proche > modéré > profond.
    const tierA = realisticDecisionRiskTier(a);
    const tierB = realisticDecisionRiskTier(b);
    if (tierA !== tierB) return tierA - tierB;

    // 8 : SAFE préféré si rendement presque équivalent (≤0,15 % d'écart).
    const yieldA = getRecordYieldPct(a) ?? 0;
    const yieldB = getRecordYieldPct(b) ?? 0;
    const safeBonusA =
      realisticDecisionNormMode(a) === "SAFE" && yieldA >= maxYield - REALISTIC_DECISION_SAFE_TIE_BREAK_PCT
        ? 1
        : 0;
    const safeBonusB =
      realisticDecisionNormMode(b) === "SAFE" && yieldB >= maxYield - REALISTIC_DECISION_SAFE_TIE_BREAK_PCT
        ? 1
        : 0;
    if (safeBonusA !== safeBonusB) return safeBonusB - safeBonusA;

    // 5-6 : rendement plus élevé préféré.
    if (yieldA !== yieldB) return yieldB - yieldA;

    // 7 : DTE 7 ou 4 préféré avant 3/2 à résultat comparable.
    const dteA = toNumberOrNull(a?.dteAtScan);
    const dteB = toNumberOrNull(b?.dteAtScan);
    const prefA = REALISTIC_DECISION_PREFERRED_DTE.has(dteA) ? 0 : 1;
    const prefB = REALISTIC_DECISION_PREFERRED_DTE.has(dteB) ? 0 : 1;
    if (prefA !== prefB) return prefA - prefB;

    // 9 : observation la plus stable / première déterministe.
    return realisticDecisionStableCompare(a, b);
  });
  return sorted[0];
}

function computeRealisticDecisionWinRatePct(records) {
  const outcomes = records
    .map((r) => getCalibrationIsCorrect(r))
    .filter((v) => typeof v === "boolean");
  if (outcomes.length > 0) {
    return roundMetric((outcomes.filter((v) => v).length / outcomes.length) * 100, 1);
  }
  const known = records.filter((r) => getAssignedFlag(r) != null);
  if (known.length === 0) return null;
  return roundMetric((known.filter((r) => getAssignedFlag(r) !== true).length / known.length) * 100, 1);
}

/**
 * J5-B1 — Métriques « décision réelle » additives, politique BALANCED.
 *
 * Réduit un ensemble d'observations résolues à une décision théorique unique par
 * ticker × selectedExpiration (déduplication), puis calcule des métriques de risque
 * réel sur ces décisions. STRICTEMENT ADDITIF : n'altère aucun score (`dynamicTop20Score`),
 * tri ni verdict existant (Top 20 / Objectif 1%+). Diagnostic post-analyse uniquement.
 *
 * Définition : une décision théorique = 1 sélection par ticker + selectedExpiration.
 *
 * LIMITE : la sélection BALANCED peut s'appuyer sur le résultat observé
 * (assignation / profondeur) pour départager les variantes — légitime UNIQUEMENT en
 * analyse post-mortem. Ces champs ne doivent jamais alimenter le score live actuel.
 */
export function computeRealisticDecisionMetrics(records, options = {}) {
  const policy = options.policy ?? "BALANCED";
  const all = Array.isArray(records) ? records : [];
  // Même base d'éligibilité que Top 20 / 1%+ : résolu, hors intradayRetest.
  const resolved = all.filter(
    (r) => getResolvedFlag(r) && (r?.captureClass ?? "primaryDaily") !== "intradayRetest",
  );

  const groups = new Map();
  for (const r of resolved) {
    const ticker = normalizeSymbol(r?.symbol ?? r?.ticker);
    const expKey = realisticDecisionExpirationKey(r);
    const key = `${ticker}|${expKey ?? "na"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const selected = [];
  for (const candidates of groups.values()) {
    const pick = selectBalancedRealisticDecision(candidates);
    if (pick) selected.push(pick);
  }

  const selectedTradeCount = selected.length;
  const assignedSelected = selected.filter((r) => getAssignedFlag(r) === true);
  const selectedAssignedCount = assignedSelected.length;

  const depth = { proche: 0, moderee: 0, profonde: 0, nd: 0 };
  const depthPcts = [];
  for (const r of assignedSelected) {
    const d = classifyAssignmentDepth(r);
    if (d.assignmentDepthClass === "proche") depth.proche += 1;
    else if (d.assignmentDepthClass === "moderee") depth.moderee += 1;
    else if (d.assignmentDepthClass === "profonde") depth.profonde += 1;
    else depth.nd += 1;
    if (d.assignmentDepthPct != null) depthPcts.push(d.assignmentDepthPct);
  }

  const yields = selected.map((r) => getRecordYieldPct(r)).filter((y) => y != null);
  const modeSplit = { SAFE: 0, AGGRESSIVE: 0, OTHER: 0 };
  const dteSplit = {};
  for (const r of selected) {
    modeSplit[realisticDecisionNormMode(r)] += 1;
    const dte = toNumberOrNull(r?.dteAtScan);
    if (dte != null) dteSplit[dte] = (dteSplit[dte] ?? 0) + 1;
  }

  const observationResolvedCount = resolved.length;
  const observationAssignedCount = resolved.filter((r) => getAssignedFlag(r) === true).length;
  const distinctExpirationCount = new Set(
    resolved.map((r) => realisticDecisionExpirationKey(r)).filter(Boolean),
  ).size;

  return {
    policy,
    selectedTradeCount,
    selectedAssignedCount,
    selectedAssignmentRatePct:
      selectedTradeCount > 0
        ? roundMetric((selectedAssignedCount / selectedTradeCount) * 100, 1)
        : null,
    selectedNearAssignmentCount: depth.proche,
    selectedModerateAssignmentCount: depth.moderee,
    selectedDeepAssignmentCount: depth.profonde,
    selectedDeepAssignmentRatePct:
      selectedAssignedCount > 0
        ? roundMetric((depth.profonde / selectedAssignedCount) * 100, 1)
        : null,
    selectedWinRatePct: computeRealisticDecisionWinRatePct(selected),
    selectedAvgCspYieldPct: yields.length > 0 ? roundMetric(average(yields), 2) : null,
    selectedMedianCspYieldPct: yields.length > 0 ? roundMetric(median(yields), 2) : null,
    selectedAvgDepthPct: depthPcts.length > 0 ? roundMetric(average(depthPcts), 2) : null,
    selectedModeSplit: modeSplit,
    selectedDteSplit: dteSplit,
    duplicationRatio:
      selectedTradeCount > 0
        ? roundMetric(observationResolvedCount / selectedTradeCount, 2)
        : null,
    observationResolvedCount,
    observationAssignedCount,
    distinctExpirationCount,
  };
}

/**
 * J5-B3-A — Score réaliste simulé (preview seulement).
 *
 * Ajuste légèrement le `dynamicTop20Score` officiel à partir des métriques
 * `realisticDecisionMetrics` (BALANCED). STRICTEMENT ADDITIF : ne remplace ni
 * `dynamicTop20Score`, ni `dynamicTop20Status`, ni le tri Top 20.
 */
export function computeRealisticPreviewScore(profileOrRow) {
  const row = profileOrRow ?? {};
  const baseScore = toNumberOrNull(row.dynamicTop20Score);
  const rdm = row.realisticDecisionMetrics ?? null;
  const assignmentRate =
    toNumberOrNull(row.assignmentRate) ?? toNumberOrNull(row?.csp?.assignmentRate);

  if (baseScore == null) return null;
  if (!rdm || Number(rdm.selectedTradeCount ?? 0) <= 0) {
    return {
      score: baseScore,
      baseScore,
      rankImpactReason: "données décision réelle indisponibles",
      penalties: [],
      bonuses: [],
      confidence: "low",
      confidenceBadge: "données décision indisponibles",
      // Absence de base décision : on ne bloque pas le Top 20 (les gardes E2b restent).
      eligibleForTop20: true,
      eligibilityReason: null,
      // J5-B6 — sans base décision réelle, on reste sur le chemin « strict » historique
      // (les garde-fous E2b restent seuls juges). Pas de remplissage « confirm ».
      eligibleForTop20Confirm: false,
      dynamicTop20RealisticBucket: "strict",
      dynamicTop20Confidence: "normal",
      selectedTradeCountGuard: "ok",
      realisticEligibilityReason: "données décision réelle indisponibles",
      wouldImprove: false,
      wouldDecline: false,
      rankDelta: 0,
      previewOnly: true,
    };
  }

  let score = baseScore;
  const penalties = [];
  const bonuses = [];
  let confidence = "high";

  const dup = toNumberOrNull(rdm.duplicationRatio) ?? 0;
  if (dup >= 4) {
    const points = dup >= 6 ? -10 : -5;
    penalties.push({ reason: "duplication élevée", points, detail: `${dup}×` });
    score += points;
  }

  const deepPct = toNumberOrNull(rdm.selectedDeepAssignmentRatePct) ?? 0;
  if (deepPct > 30) {
    const points = deepPct > 50 ? -15 : deepPct > 40 ? -10 : -5;
    penalties.push({ reason: "profondeur réelle", points, detail: `${deepPct}%` });
    score += points;
  }

  const tradeCount = Number(rdm.selectedTradeCount ?? 0);
  if (tradeCount < 5) {
    penalties.push({ reason: "échantillon faible", points: -10, detail: `${tradeCount} décisions` });
    score -= 10;
    confidence = "low";
  } else if (tradeCount < 8) {
    confidence = "medium";
  }

  const selAssign = toNumberOrNull(rdm.selectedAssignmentRatePct);
  if (assignmentRate != null && selAssign != null && selAssign < assignmentRate) {
    const delta = assignmentRate - selAssign;
    const points = delta >= 10 ? 8 : delta >= 5 ? 5 : 3;
    bonuses.push({
      reason: "assignation réelle inférieure",
      points,
      detail: `${selAssign}% vs ${assignmentRate}%`,
    });
    score += points;
  }

  const yieldPct = toNumberOrNull(rdm.selectedAvgCspYieldPct);
  const assignAcceptable = selAssign == null || selAssign <= 25;
  if (yieldPct != null && yieldPct >= 0.8 && assignAcceptable) {
    const points = yieldPct >= 1.0 ? 8 : yieldPct >= 0.9 ? 5 : 3;
    bonuses.push({ reason: "rendement réel solide", points, detail: `${yieldPct}%` });
    score += points;
  }

  // Garde-fou J5-B3-B — un ticker qui ne paie pas ≥0,5 % CSP réel ne doit pas être favorisé.
  const lowYield = yieldPct != null && yieldPct < REALISTIC_DECISION_MIN_CSP_YIELD_PCT;
  if (lowYield) {
    const points = yieldPct < 0.3 ? -20 : -12;
    penalties.push({ reason: "rendement réel insuffisant", points, detail: `${yieldPct}% < 0.5%` });
    score += points;
  }

  const winRate = toNumberOrNull(rdm.selectedWinRatePct);
  if (winRate != null && winRate >= 85) {
    const points = winRate >= 90 ? 8 : 5;
    bonuses.push({ reason: "win rate réel élevé", points, detail: `${winRate}%` });
    score += points;
  }

  score = roundMetric(Math.max(0, Math.min(100, score)), 1);

  // Garde-fous d'admissibilité Top 20 principal (J5-B3-B) — la confiance dépend du
  // nombre de décisions réelles (selectedTradeCount), pas du nombre d'observations.
  // `eligibleForTop20` = admissibilité STRICTE (inchangé) : selectedTradeCount≥5 +
  // rendement réel ≥0,5 % + profondeur réelle ≤50 %.
  let eligibleForTop20 = true;
  let eligibilityReason = null;
  if (tradeCount < REALISTIC_STRICT_MIN_TRADE_COUNT) {
    eligibleForTop20 = false;
    eligibilityReason = "échantillon décision réelle insuffisant (<5)";
  } else if (lowYield) {
    eligibleForTop20 = false;
    eligibilityReason = "rendement réel décision <0,5 %";
  } else if (deepPct > 50) {
    eligibleForTop20 = false;
    eligibilityReason = "assignation profonde réelle >50 %";
  }

  // J5-B6 — classification en buckets de remplissage Top 20 réaliste.
  //   strict   : eligibleForTop20 (selectedTradeCount≥5 + garde-fous qualité OK).
  //   confirm  : 3–4 décisions réelles + garde-fous qualité OK + échantillon
  //              observationnel suffisant (observationResolvedCount≥15). Peut
  //              REMPLIR le Top 20 derrière les stricts, jamais devant.
  //   rejected : rendement réel <0,5 %, profondeur réelle >50 %, ou échantillon
  //              décision réelle trop faible (<3) / observations insuffisantes.
  const obsResolved = toNumberOrNull(rdm.observationResolvedCount) ?? 0;
  const qualityGuardsOk = !lowYield && deepPct <= 50;
  let selectedTradeCountGuard;
  if (tradeCount >= REALISTIC_STRICT_MIN_TRADE_COUNT) selectedTradeCountGuard = "ok";
  else if (tradeCount >= REALISTIC_CONFIRM_MIN_TRADE_COUNT) selectedTradeCountGuard = "confirm";
  else selectedTradeCountGuard = "insufficient";

  let dynamicTop20RealisticBucket;
  let dynamicTop20Confidence;
  let realisticEligibilityReason;
  let eligibleForTop20Confirm = false;
  if (!qualityGuardsOk) {
    dynamicTop20RealisticBucket = "rejected";
    dynamicTop20Confidence = "insufficient";
    realisticEligibilityReason = lowYield
      ? "rendement réel décision <0,5 % — exclu"
      : "assignation profonde réelle >50 % — exclu";
  } else if (tradeCount >= REALISTIC_STRICT_MIN_TRADE_COUNT) {
    dynamicTop20RealisticBucket = "strict";
    dynamicTop20Confidence = "normal";
    realisticEligibilityReason = "admissible réaliste";
  } else if (
    tradeCount >= REALISTIC_CONFIRM_MIN_TRADE_COUNT &&
    obsResolved >= REALISTIC_CONFIRM_MIN_OBS_RESOLVED
  ) {
    dynamicTop20RealisticBucket = "confirm";
    dynamicTop20Confidence = "low";
    realisticEligibilityReason = "échantillon décision réelle faible — à confirmer";
    eligibleForTop20Confirm = true;
  } else {
    dynamicTop20RealisticBucket = "rejected";
    dynamicTop20Confidence = "insufficient";
    realisticEligibilityReason =
      "échantillon décision réelle insuffisant (<3 décisions ou <15 observations)";
  }

  let confidenceBadge = "normale";
  if (tradeCount < REALISTIC_STRICT_MIN_TRADE_COUNT) {
    confidenceBadge = eligibleForTop20Confirm ? "à confirmer" : "échantillon insuffisant";
  } else if (tradeCount < 8) confidenceBadge = "confiance faible";

  const dominantPenalty = penalties.sort((a, b) => a.points - b.points)[0]?.reason ?? null;
  const dominantBonus = bonuses.sort((a, b) => b.points - a.points)[0]?.reason ?? null;
  let rankImpactReason = "stable";
  if (dominantPenalty && dominantBonus) {
    rankImpactReason = `${dominantPenalty} / ${dominantBonus}`;
  } else if (dominantPenalty) {
    rankImpactReason = dominantPenalty;
  } else if (dominantBonus) {
    rankImpactReason = dominantBonus;
  }

  return {
    score,
    baseScore,
    rankImpactReason,
    penalties,
    bonuses,
    confidence,
    confidenceBadge,
    eligibleForTop20,
    eligibilityReason,
    // J5-B6 — buckets de remplissage Top 20 réaliste (additifs).
    eligibleForTop20Confirm,
    dynamicTop20RealisticBucket,
    dynamicTop20Confidence,
    selectedTradeCountGuard,
    realisticEligibilityReason,
    wouldImprove: false,
    wouldDecline: false,
    rankDelta: 0,
    previewOnly: true,
  };
}

/**
 * J5-B3-B — Score réaliste ACTIF d'un profil Top 20.
 *
 * Construit la ligne minimale attendue par computeRealisticPreviewScore à partir du
 * profil 1 %+ et du score officiel précédent (E2b/compétitif), puis renvoie l'objet
 * réaliste (score + garde-fous d'admissibilité). Ce score pilote désormais le
 * classement Top 20 — ce n'est plus une simple simulation.
 */
function computeRealisticActiveScoreForProfile(profile, baseScore) {
  return computeRealisticPreviewScore({
    dynamicTop20Score: baseScore,
    assignmentRate: profile?.csp?.assignmentRate ?? null,
    realisticDecisionMetrics: profile?.realisticDecisionMetrics ?? null,
  });
}

/**
 * J5-B3-B — Résumé lisible de la raison du score réaliste actif d'une ligne Top 20.
 * Mentionne le score réaliste, l'ancien score E2b en référence et les métriques
 * décision réelle clés (échantillon, assignation, profondeur, rendement, duplication).
 */
function buildRealisticActiveReasonSummary(realistic, rdm, legacyScore) {
  if (!realistic || realistic.score == null) return null;
  const parts = [`score réaliste actif ${realistic.score}`];
  if (legacyScore != null) parts.push(`ancien score obs. ${legacyScore}`);
  const bonusReasons = (realistic.bonuses ?? []).map((b) => b.reason);
  const penaltyReasons = (realistic.penalties ?? []).map((p) => p.reason);
  const drivers = [...bonusReasons, ...penaltyReasons];
  if (drivers.length > 0) parts.push(drivers.slice(0, 3).join(", "));
  if (realistic.eligibilityReason) parts.push(realistic.eligibilityReason);
  if (rdm) {
    const tc = toNumberOrNull(rdm.selectedTradeCount);
    const sa = toNumberOrNull(rdm.selectedAssignmentRatePct);
    const sd = toNumberOrNull(rdm.selectedDeepAssignmentRatePct);
    const sy = toNumberOrNull(rdm.selectedAvgCspYieldPct);
    const dup = toNumberOrNull(rdm.duplicationRatio);
    const metricParts = [];
    if (tc != null) metricParts.push(`n déc. ${tc}`);
    if (sa != null) metricParts.push(`assign. ${sa}%`);
    if (sd != null) metricParts.push(`prof. ${sd}%`);
    if (sy != null) metricParts.push(`rend. ${sy}%`);
    if (dup != null) metricParts.push(`dup. ${dup}×`);
    if (metricParts.length > 0) parts.push(metricParts.join(" · "));
  }
  return parts.join(" — ");
}

/** Buckets comparables pour le rang preview (simulation seulement). */
const REALISTIC_PREVIEW_RANK_BUCKETS = [
  "top20",
  "nearEntry",
  "watchValidate",
  "insufficientSample",
];

/**
 * Attache `realisticPreview` + `realisticPreviewRank` aux lignes Top 20.
 *
 * J5-B3-A : preview additif sur le score legacy.
 * J5-B3-B : dans le pipeline E2b, `dynamicTop20Score` EST déjà le score réaliste actif ;
 * le preview est donc recalculé sur la base legacy (`dynamicTop20ScoreLegacy`) pour
 * exposer le même détail (et éviter une double application sur le score déjà réaliste).
 */
function attachRealisticPreviewToDynamicTop20Result(result) {
  if (!result || typeof result !== "object") return result;

  const allRows = [];
  for (const bucket of REALISTIC_PREVIEW_RANK_BUCKETS) {
    const group = result[bucket];
    if (!Array.isArray(group)) continue;
    for (const row of group) {
      if (!row || typeof row !== "object") continue;
      // Base du preview = ancien score officiel quand le score actif est déjà réaliste.
      const previewBaseRow =
        row.dynamicTop20ScoreLegacy != null
          ? { ...row, dynamicTop20Score: row.dynamicTop20ScoreLegacy }
          : row;
      row.realisticPreview = computeRealisticPreviewScore(previewBaseRow);
      allRows.push(row);
    }
  }

  const rankable = allRows
    .filter((row) => row.realisticPreview?.score != null)
    .slice()
    .sort((a, b) => {
      const scoreDelta = (b.realisticPreview.score ?? 0) - (a.realisticPreview.score ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      const nDelta = (b.n ?? 0) - (a.n ?? 0);
      if (nDelta !== 0) return nDelta;
      return String(a.ticker ?? "").localeCompare(String(b.ticker ?? ""));
    });

  rankable.forEach((row, index) => {
    const previewRank = index + 1;
    row.realisticPreviewRank = previewRank;
    const currentRank = toNumberOrNull(row.rank);
    if (currentRank != null && row.realisticPreview) {
      const rankDelta = currentRank - previewRank;
      row.realisticPreview.rankDelta = rankDelta;
      row.realisticPreview.wouldImprove = rankDelta > 0;
      row.realisticPreview.wouldDecline = rankDelta < 0;
    }
  });

  return result;
}

/**
 * Profils read-only — objectif 1 %+ avec cycle Wheel complet (CSP → assignation → CC → sortie).
 */
export function computeOnePercentWheelProfiles(records, cycles, options = {}) {
  const todayYmd = normalizeIsoTimestamp(options.today ?? options.asOfDate ?? new Date()).slice(0, 10);
  const allRecords = Array.isArray(records) ? records : [];
  const allCycles = Array.isArray(cycles) ? cycles : [];
  const minModeProfileN = Math.max(
    toNumberOrNull(options?.minModeProfileN) ?? ONE_PERCENT_MIN_MODE_PROFILE_N,
    5,
  );

  const profileRecords = allRecords.filter((record) => isOnePercentProfileRecord(record, todayYmd));

  const recordsByTicker = new Map();
  const recordsByTickerMode = new Map();
  const totalByTicker = new Map();

  for (const record of allRecords) {
    const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
    if (!ticker) continue;
    totalByTicker.set(ticker, (totalByTicker.get(ticker) ?? 0) + 1);
  }

  for (const record of profileRecords) {
    const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
    const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
    if (!ticker) continue;

    if (!recordsByTicker.has(ticker)) recordsByTicker.set(ticker, []);
    recordsByTicker.get(ticker).push(record);

    if (mode === "safe" || mode === "aggressive") {
      const key = `${ticker}|${mode}`;
      if (!recordsByTickerMode.has(key)) recordsByTickerMode.set(key, []);
      recordsByTickerMode.get(key).push(record);
    }
  }

  const cyclesByTicker = new Map();
  const cyclesByTickerMode = new Map();
  for (const cycle of allCycles) {
    const ticker = normalizeSymbol(cycle?.ticker);
    if (!ticker) continue;
    if (!cyclesByTicker.has(ticker)) cyclesByTicker.set(ticker, []);
    cyclesByTicker.get(ticker).push(cycle);

    const mode = normalizeCycleStrikeMode(cycle);
    if (mode) {
      const key = `${ticker}|${mode}`;
      if (!cyclesByTickerMode.has(key)) cyclesByTickerMode.set(key, []);
      cyclesByTickerMode.get(key).push(cycle);
    }
  }

  const profiles = [];

  for (const [ticker, rows] of recordsByTicker.entries()) {
    profiles.push(
      buildOnePercentProfile({
        ticker,
        mode: null,
        groupType: "ticker",
        records: rows,
        cycles: cyclesByTicker.get(ticker) ?? [],
        recordsTotalInTicker: totalByTicker.get(ticker) ?? rows.length,
      }),
    );
  }

  for (const [key, rows] of recordsByTickerMode.entries()) {
    if (rows.length < minModeProfileN) continue;
    const [ticker, mode] = key.split("|");
    profiles.push(
      buildOnePercentProfile({
        ticker,
        mode,
        groupType: "ticker_mode",
        records: rows,
        cycles: cyclesByTickerMode.get(key) ?? cyclesByTicker.get(ticker) ?? [],
        recordsTotalInTicker: totalByTicker.get(ticker) ?? rows.length,
      }),
    );
  }

  for (const profile of profiles) {
    profile.sortScore = scoreOnePercentProfileForSort(profile);
  }

  profiles.sort((a, b) => {
    if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
    const nDelta = (b.csp?.recordsResolved ?? 0) - (a.csp?.recordsResolved ?? 0);
    if (nDelta !== 0) return nDelta;
    const yieldDelta = (b.csp?.avgYieldPct ?? -1) - (a.csp?.avgYieldPct ?? -1);
    if (yieldDelta !== 0) return yieldDelta;
    if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
    return String(a.mode).localeCompare(String(b.mode));
  });

  const tickersAnalyzed = new Set(profiles.filter((p) => p.groupType === "ticker").map((p) => p.ticker)).size;
  const countByVerdict = (label) =>
    profiles.filter((profile) => profile.verdicts.includes(label) || profile.primaryVerdict === label).length;

  return {
    ok: true,
    asOfDate: todayYmd,
    profiles,
    summary: {
      tickersAnalyzed,
      profilesTotal: profiles.length,
      profilesNonProuves: profiles.filter((p) => p.sampleCredibility === "non prouvé").length,
      profilesTresPreliminaires: profiles.filter((p) => p.sampleCredibility === "très préliminaire").length,
      profilesPreliminaires: profiles.filter((p) => p.sampleCredibility === "préliminaire").length,
      profilesMesurables: profiles.filter((p) => p.sampleCredibility === "mesurable").length,
      profilesOnePercentDefendable: countByVerdict("1 % défendable"),
      profilesOnePercentStresse: countByVerdict("1 % stressé"),
      profilesFauxOnePercent: countByVerdict("faux 1 %"),
      profilesAssignationExploitable: countByVerdict("assignation exploitable"),
      profilesWheelFavorable: countByVerdict("Wheel favorable"),
      profilesCcInsuffisants: countByVerdict("CC insuffisants"),
      recordsUsed: profileRecords.length,
      cyclesUsed: allCycles.length,
    },
    meta: {
      readOnly: true,
      minModeProfileN,
      grouping: ["ticker", "ticker_mode"],
      warning:
        "Module read-only — profils historiques, aucune recommandation de trade. POP gelé au scan.",
    },
  };
}

const DYNAMIC_TOP20_STATUS_LABELS = {
  top20_experimental: "Top 20 expérimental",
  near_entry: "Proche d'entrer",
  watch_validate: "À valider",
  stressed: "Stressé",
  exclude_high_yield: "À exclure malgré rendement",
  insufficient_sample: "Échantillon insuffisant",
  exclude_crypto_blocked: "Exclu — crypto/digital asset bloqué",
};

/** Raison d'exclusion crypto/digital asset (sauf BITX) du laboratoire Top 20. */
const TOP20_CRYPTO_BLOCK_REASON = "Exclu Top 20 : crypto/digital asset bloqué";

const DYNAMIC_TOP20_CONTEXT_AVAILABILITY = {
  ivIntegrated: false,
  seasonalityIntegrated: false,
  marketContextIntegrated: false,
  note: "IV/saisonnalité/contexte marché non encore intégrés au score.",
};

function hasDefensibleCspQualityForTop20(profile) {
  const win = profile?.csp?.realWinRate;
  const assign = profile?.csp?.assignmentRate;
  const profondeRate = profile?.assignment?.profondeRatePct;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const verdict = profile?.primaryVerdict ?? "";
  return (
    lbClass !== "critique" &&
    (win == null || win >= 80) &&
    (assign == null || assign <= 20) &&
    (profondeRate == null || profondeRate === 0) &&
    !["faux 1 %", "assignation défavorable", "1 % stressé"].includes(verdict)
  );
}

export function getExperimentalTop20IneligibilityReasons(profile, enforceN15Guard = false) {
  const reasons = [];
  const n = profile?.csp?.recordsResolved ?? 0;
  const verdict = profile?.primaryVerdict ?? "";
  const win = profile?.csp?.realWinRate;
  const assign = profile?.csp?.assignmentRate;
  const avgYield = profile?.csp?.avgYieldPct;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const lbLabel = String(profile?.lowerBoundStress?.lbStressLabel ?? "");
  const lbCode = profile?.lowerBoundStress?.lbStressCode ?? lbClass;
  const profondeRate = profile?.assignment?.profondeRatePct;
  const verdictReasons = Array.isArray(profile?.verdictReasons) ? profile.verdictReasons : [];

  if (lbClass === "critique" || lbCode === "critique" || lbLabel.includes("critique")) {
    reasons.push("Exclu du Top 20 : LB critique");
  } else if (verdictReasons.includes("LB cassé critique")) {
    reasons.push("Exclu du Top 20 : LB critique");
  }

  if (verdict === "faux 1 %" || verdict.includes("faux 1 %")) {
    reasons.push("Exclu du Top 20 : verdict stressé");
  }
  if (verdict === "assignation défavorable" || verdict.includes("assignation défavorable")) {
    reasons.push("Exclu du Top 20 : verdict stressé");
  }
  if (verdict === "1 % stressé" || verdict.includes("1 % stressé")) {
    reasons.push("Exclu du Top 20 : verdict stressé");
  }
  if (
    (verdict === "CC insuffisants" || profile?.verdicts?.includes("CC insuffisants")) &&
    ((avgYield != null && avgYield < 0.9) || (assign != null && assign > 20))
  ) {
    reasons.push("Exclu du Top 20 : verdict stressé");
  }

  if (win != null && win < 80) {
    reasons.push("Exclu du Top 20 : win < 80 %");
  }
  if (assign != null && assign > 20) {
    reasons.push("Exclu du Top 20 : assignation > 20 %");
  }
  if (profondeRate != null && profondeRate > 0) {
    reasons.push("Exclu du Top 20 : assignation profonde");
  }
  if (n < 5) {
    reasons.push("Exclu du Top 20 : échantillon insuffisant (n<5)");
  } else if (enforceN15Guard && n < 15) {
    reasons.push("Exclu du Top 20 : échantillon insuffisant (n<15)");
  }

  return [...new Set(reasons)];
}

export function isEligibleForExperimentalTop20(profile, options = {}) {
  const enforceN15Guard = options.enforceN15Guard === true;
  const reasons = getExperimentalTop20IneligibilityReasons(profile, enforceN15Guard);
  return { eligible: reasons.length === 0, reasons };
}

function isDynamicTop20HighYieldExclusion(profile) {
  const avgYield = profile?.csp?.avgYieldPct;
  if (avgYield == null || avgYield < 0.8) return false;

  const riskReasons = getExperimentalTop20IneligibilityReasons(profile, false).filter(
    (reason) => !reason.includes("échantillon"),
  );
  return riskReasons.length > 0;
}

function computeDynamicTop20LaboratoryScore(profile) {
  const n = profile?.csp?.recordsResolved ?? 0;
  const avgYield = profile?.csp?.avgYieldPct;
  const win = profile?.csp?.realWinRate;
  const assign = profile?.csp?.assignmentRate;
  const touch = profile?.csp?.strikeTouchRate;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const profondeRate = profile?.assignment?.profondeRatePct;
  const procheRate = profile?.assignment?.procheRatePct;
  const wheel = profile?.wheel ?? {};
  const verdict = profile?.primaryVerdict ?? "";

  let score = 50;
  const scoreReasons = [];
  const scoreWarnings = [];

  if (avgYield != null && avgYield >= 0.9) {
    score += 25;
    scoreReasons.push("Rendement CSP ≥ 0,9 %");
  } else if (avgYield != null && avgYield >= 0.8) {
    score += 15;
    scoreReasons.push("Rendement CSP ≥ 0,8 %");
  }

  if (
    avgYield != null &&
    avgYield >= 1 &&
    ((win != null && win < 70) || (assign != null && assign >= 30))
  ) {
    score -= 18;
    scoreWarnings.push("Rendement élevé mais qualité CSP faible");
  }

  const cspDefensible = hasDefensibleCspQualityForTop20(profile);

  if (win != null && win >= 85) {
    score += 15;
    scoreReasons.push("Win CSP élevé");
  } else if (win != null && win >= 80) {
    score += 8;
    scoreReasons.push("Win CSP acceptable");
  } else if (win != null && win >= 70) {
    score -= 5;
    scoreWarnings.push("Win CSP modéré");
  } else if (win != null && win < 70) {
    score -= 15;
    scoreWarnings.push("Win CSP faible");
  }

  if (assign != null && assign <= 15) {
    score += 10;
    scoreReasons.push("Assignation faible");
  } else if (assign != null && assign > 20) {
    score -= 18;
    scoreWarnings.push("Assignation élevée");
  } else if (assign != null && assign > 15) {
    score -= 6;
    scoreWarnings.push("Assignation modérée");
  }

  if (touch != null && touch >= 35) {
    score -= 10;
    scoreWarnings.push("Touch élevé");
  } else if (touch != null && touch <= 20) {
    score += 5;
  }

  if (lbClass === "sans_dommage") {
    score += 4;
  } else if (lbClass === "avec_stress") {
    score -= 18;
    scoreWarnings.push("LB avec stress");
  } else if (lbClass === "critique") {
    score -= 35;
    scoreWarnings.push("LB critique");
  } else if (lbClass === "non_determinant") {
    score -= 5;
    scoreWarnings.push("LB non déterminant");
  }

  if (profondeRate != null && profondeRate > 0) {
    score -= 35;
    scoreWarnings.push("Assignation profonde");
  } else if (
    cspDefensible &&
    profondeRate != null &&
    profondeRate < 15 &&
    procheRate != null &&
    procheRate >= 20 &&
    ((wheel.recoveryRatePct ?? 0) >= 50 || (wheel.avgCcSold ?? 0) > 0)
  ) {
    score += 8;
    scoreReasons.push("Assignations proches maîtrisées");
  }

  if (cspDefensible) {
    if (wheel.avgWheelReturnPct != null && wheel.avgWheelReturnPct > 0) {
      score += 10;
      scoreReasons.push("Rendement Wheel positif");
    }
    if (wheel.recoveryRatePct != null && wheel.recoveryRatePct >= 60) {
      score += 8;
      scoreReasons.push("Recovery favorable");
    }
    if ((wheel.avgCcSold ?? 0) >= 1) {
      score += 6;
      scoreReasons.push("CC vendus");
    }
  } else if (wheel.avgWheelReturnPct != null && wheel.avgWheelReturnPct > 0) {
    score -= 5;
    scoreWarnings.push("Rendement Wheel insuffisant pour compenser CSP stressé");
  }
  if (verdict === "CC insuffisants" || profile?.verdicts?.includes("CC insuffisants")) {
    score -= 12;
    scoreWarnings.push("CC insuffisants");
  }
  if ((wheel.cyclesOpen ?? 0) > 0) {
    score -= 3;
    scoreWarnings.push("Cycles ouverts");
  }

  if (n >= 50 && win != null && win >= 75) {
    score += 10;
    scoreReasons.push("Échantillon robuste (n≥50)");
  }

  let scoreCap = null;
  if (n < 5) {
    scoreCap = 20;
    scoreWarnings.push("Échantillon insuffisant (n<5)");
  } else if (n < 15) {
    scoreCap = 55;
    scoreWarnings.push("Échantillon à valider (n<15)");
  } else if (n < 30) {
    scoreCap = 75;
    scoreWarnings.push("Échantillon préliminaire (n<30)");
  }
  if (scoreCap != null && score > scoreCap) score = scoreCap;

  const verdictAdjustments = {
    "1 % défendable": 20,
    "1 % à valider": 10,
    "assignation exploitable": 8,
    "Wheel favorable": 8,
    "1 % stressé": -15,
    "faux 1 %": -40,
    "assignation défavorable": -35,
    "CC insuffisants": -10,
    "capital bloqué": -15,
  };
  const verdictDelta = verdictAdjustments[verdict] ?? 0;
  if (verdictDelta > 0) {
    score += verdictDelta;
    scoreReasons.push(`Verdict : ${verdict}`);
  } else if (verdictDelta < 0) {
    score += verdictDelta;
    scoreWarnings.push(`Verdict : ${verdict}`);
  }

  return {
    dynamicTop20Score: roundMetric(score, 1),
    scoreReasons: [...new Set(scoreReasons)].slice(0, 4),
    scoreWarnings: [...new Set(scoreWarnings)].slice(0, 4),
  };
}

/* ───────────────────────────────────────────────────────────────────────────
 * Formule compétitive Top 20 — E2b (candidate finale).
 *
 * Score compétitif = points de mérite + bonus résilience + bonus historique
 * robuste − pénalités graduées.
 *
 * Portage fidèle de la simulation read-only validée
 * (debug/top20FormulaE2bRobustHistorySim.mjs, variante E2b +8/+3) dans le moteur.
 * Activée uniquement quand les enregistrements bruts (records) sont disponibles
 * — sinon le scoring legacy `computeDynamicTop20LaboratoryScore` est conservé
 * (compatibilité tests + appels sans records).
 *
 * Ne touche ni au Pine, ni à crypto-block, ni à selectedExpiration/dteAtScan.
 * ────────────────────────────────────────────────────────────────────────── */

const E2B_RANKING_FORMULA_VERSION = "E2b";
const E2B_STRESS_KRACH_EXP = "2026-06-05";
const E2B_EXPLOITABLE_MIN_SCORE = 35;
const E2B_EXPLOITABLE_MIN_N = 10;
const E2B_DTE_TARGETS = [2, 3, 4, 7];

const E2B_CONFIG = {
  meritWeights: { win: 1.12, yield: 1.2, lowAssign: 1.05, lbHeld: 1.12, stability: 1.05, sample: 1.0, shortDte: 1.0 },
  resilWeights: { stressSurvival: 1.25, winMaintained: 1.2, lbHeldUnderStress: 1.25 },
  resilCap: 30,
  deepExpsPenalties: { 1: -6, 2: -22, 3: -36 },
  winPenalties: { 50: -30, 70: -22, 75: -14, 80: -7 },
  lbPenalties: { avec_stress: -10, critique: -20 },
  assignPenalties: { 20: -10, 30: -17, 40: -26 },
  deepRatePenalty: -6,
  lbCritiqueReduced: true,
  lbCritiqueReducedValue: -12,
  stressKrachMultiplier: 1.25,
  stressKrachLbBonus: 5,
  hardExcludeStrict: true,
  robustHistoryBaseBonus: 8,
  robustHistoryExtraBonus: 3,
};

// ── helpers locaux (portés de la simulation pour fidélité 1:1) ────────────────
const e2bSym = (v) => String(v ?? "").trim().toUpperCase();
const e2bYmd = (v) => {
  const c = String(v ?? "").trim().replace(/-/g, "");
  return /^\d{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : null;
};
const e2bRound1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const e2bClamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const e2bNumberOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const e2bRecordResolved = (r) => (r?.resolution?.resolved ?? r?.resolved) === true;
const e2bRecordAssigned = (r) =>
  r?.resolution?.assigned === true || r?.assigned === true || r?.assigned === 1;
const e2bAssignedFlag = (r) => {
  if (r?.resolution?.assigned_flag === true || r?.resolution?.assigned === true) return true;
  if (r?.resolution?.assigned_flag === false || r?.resolution?.assigned === false) return false;
  if (r?.assigned_flag === true || r?.assigned === true) return true;
  if (r?.assigned_flag === false || r?.assigned === false) return false;
  return null;
};
const e2bStrikeOf = (r) =>
  e2bNumberOrNull(r?.strike?.strike) ?? e2bNumberOrNull(r?.strike) ?? e2bNumberOrNull(r?.assignment_strike) ?? null;
const e2bCloseOf = (r) =>
  e2bNumberOrNull(r?.resolution?.underlying_close_at_expiration) ??
  e2bNumberOrNull(r?.resolution?.expirationClosePrice) ??
  e2bNumberOrNull(r?.underlying_close_at_expiration) ??
  e2bNumberOrNull(r?.expirationClosePrice) ??
  e2bNumberOrNull(r?.assignment_price) ??
  null;
const e2bDepthClass = (r) => {
  if (e2bAssignedFlag(r) !== true) return "na";
  const s = e2bStrikeOf(r);
  const c = e2bCloseOf(r);
  if (s == null || c == null || s <= 0) return "na";
  const d = ((c - s) / s) * 100;
  if (d <= 0 && d >= -1.5) return "proche";
  if (d < -4) return "profonde";
  if (d < -1.5) return "moderee";
  return "na";
};
const e2bExpKey = (r) =>
  String(r?.selectedExpiration ?? r?.expiration ?? "").trim().replace(/-/g, "") || null;

/** Unicité événement par ticker — réplique la logique du panneau JournalPop. */
function computeE2bTickerEventUniqueness(ticker, records) {
  const t = e2bSym(ticker);
  const eligible = records.filter((r) => {
    const sym = e2bSym(r?.symbol ?? r?.ticker);
    const dte = e2bNumberOrNull(r?.dteAtScan);
    return (
      sym === t &&
      E2B_DTE_TARGETS.includes(dte) &&
      e2bRecordResolved(r) &&
      (r?.captureClass ?? "primaryDaily") !== "intradayRetest"
    );
  });
  const totalN = eligible.length;
  const assigned = eligible.filter((r) => e2bAssignedFlag(r) === true);
  const deep = assigned.filter((r) => e2bDepthClass(r) === "profonde");
  const distinctAsg = new Set(assigned.map(e2bExpKey).filter(Boolean));
  const distinctDeep = new Set(deep.map(e2bExpKey).filter(Boolean));
  let conc = null;
  if (assigned.length) {
    const c = {};
    for (const r of assigned) {
      const k = e2bExpKey(r) ?? "?";
      c[k] = (c[k] ?? 0) + 1;
    }
    conc = (Math.max(...Object.values(c)) / assigned.length) * 100;
  }
  const assignmentRate = totalN ? (assigned.length / totalN) * 100 : null;
  const distinctExpirationCount = new Set(eligible.map(e2bExpKey).filter(Boolean)).size;
  return {
    totalN,
    assignmentRate,
    distinctExpirationCount,
    distinctAssignedExpirationCount: distinctAsg.size,
    distinctDeepAssignmentExpirationCount: distinctDeep.size,
    assignmentConcentrationPct: conc,
    confirmedRepeatedRisk: (() => {
      const multiDeep = distinctDeep.size >= 2;
      const multiAssignHigh = (assignmentRate ?? 0) > 20 && distinctAsg.size >= 2;
      return multiDeep || multiAssignHigh;
    })(),
  };
}

/**
 * Contexte E2b partagé : agrégation par ticker×expiration, stress de marché par
 * expiration, et unicité événement par ticker. Calculé une fois par appel.
 */
function buildE2bContext(records, todayYmd) {
  const byTickerExp = new Map();
  for (const r of records) {
    if (!e2bRecordResolved(r)) continue;
    if ((r?.captureClass ?? "primaryDaily") === "intradayRetest") continue;
    const exp = e2bYmd(r?.expiration ?? r?.expirationCohort);
    if (!exp || exp >= todayYmd) continue;
    const t = e2bSym(r?.symbol ?? r?.ticker);
    if (!t) continue;
    if (!byTickerExp.has(t)) byTickerExp.set(t, new Map());
    const m = byTickerExp.get(t);
    if (!m.has(exp)) m.set(exp, { n: 0, assigned: 0, deep: 0 });
    const cell = m.get(exp);
    cell.n += 1;
    if (e2bRecordAssigned(r)) {
      cell.assigned += 1;
      if (classifyAssignmentDepth(r).assignmentDepthClass === "profonde") cell.deep += 1;
    }
  }

  const expAgg = new Map();
  for (const m of byTickerExp.values()) {
    for (const [exp, c] of m) {
      if (!expAgg.has(exp)) expAgg.set(exp, { n: 0, assigned: 0, deep: 0 });
      const a = expAgg.get(exp);
      a.n += c.n;
      a.assigned += c.assigned;
      a.deep += c.deep;
    }
  }
  const expStress = new Map();
  for (const [exp, a] of expAgg) {
    const assignedPct = a.n ? (a.assigned / a.n) * 100 : 0;
    const deepOfAssignedPct = a.assigned ? (a.deep / a.assigned) * 100 : 0;
    let weight = 0;
    let tier = "none";
    if (assignedPct >= 45) {
      weight = 1.0;
      tier = "severe";
    } else if (assignedPct >= 25) {
      weight = 0.5;
      tier = "moderate";
    } else if (assignedPct >= 15) {
      weight = 0.25;
      tier = "mild";
    }
    expStress.set(exp, {
      assignedPct: e2bRound1(assignedPct),
      deepOfAssignedPct: e2bRound1(deepOfAssignedPct),
      weight,
      tier,
    });
  }

  return { byTickerExp, expStress };
}

function computeE2bResilienceProfile(ticker, profile, ctx) {
  const m = ctx.byTickerExp.get(ticker) ?? new Map();
  const win = profile?.csp?.realWinRate;
  const exps = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalExps = exps.length;
  const deepExps = exps.filter(([, c]) => c.deep > 0).length;
  const cleanExps = exps.filter(([, c]) => c.deep === 0 && (c.n ? c.assigned / c.n : 0) <= 0.34).length;

  const perStress = [];
  let krachSurvived = false;
  let krachLbHeld = false;
  for (const [exp, c] of exps) {
    const s = ctx.expStress.get(exp);
    if (!s || s.weight === 0) continue;
    const assignedPct = c.n ? (c.assigned / c.n) * 100 : 0;
    let bonus = 0;
    let kind = null;
    if (c.assigned === 0) {
      bonus = s.tier === "severe" ? 10 : s.tier === "moderate" ? 6 : 4;
      kind = "non_assigné_pendant_stress";
      if (exp === E2B_STRESS_KRACH_EXP) krachSurvived = true;
    } else if (c.deep === 0 && assignedPct <= 50 && win != null && win >= 70) {
      bonus = s.tier === "severe" ? 5 : 3;
      kind = "assigné_mais_contenu";
    }
    if (exp === E2B_STRESS_KRACH_EXP && c.assigned === 0) krachLbHeld = true;
    perStress.push({ expiration: exp, tier: s.tier, bonus, kind });
  }
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  if (krachSurvived && (lbClass === "sans_dommage" || lbClass === "none" || lbClass === "non_problématique")) {
    krachLbHeld = true;
  }
  return { totalExps, deepExps, cleanExps, perStress, krachSurvived, krachLbHeld };
}

function e2bMeritWin(win) {
  if (win == null) return 0;
  if (win >= 95) return 25;
  if (win >= 90) return 22;
  if (win >= 85) return 18;
  if (win >= 80) return 14;
  if (win >= 75) return 8;
  if (win >= 70) return 3;
  return 0;
}
function e2bMeritYield(yld) {
  if (yld == null) return 0;
  if (yld >= 1.1) return 20;
  if (yld >= 1.0) return 18;
  if (yld >= 0.9) return 15;
  if (yld >= 0.8) return 11;
  if (yld >= 0.7) return 6;
  if (yld >= 0.6) return 3;
  return 0;
}
function e2bMeritLowAssign(assign) {
  if (assign == null) return 0;
  if (assign === 0) return 15;
  if (assign <= 5) return 12;
  if (assign <= 10) return 9;
  if (assign <= 15) return 6;
  if (assign <= 20) return 3;
  return 0;
}
function e2bMeritLbHeld(lbClass) {
  if (lbClass === "sans_dommage") return 15;
  if (lbClass === "none" || lbClass === "non_problématique") return 12;
  if (lbClass === "non_determinant") return 6;
  return 0;
}

/** Bonus historique robuste E2b (+8 base, +3 si n≥45 & win≥85 %). */
function computeE2bRobustHistoryBonus(profile, uniqueness, cryptoBlocked, hardExclude) {
  const n = profile?.csp?.recordsResolved ?? 0;
  const win = profile?.csp?.realWinRate;
  const assign = profile?.csp?.assignmentRate;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const baseAmount = E2B_CONFIG.robustHistoryBaseBonus;
  const extraAmount = E2B_CONFIG.robustHistoryExtraBonus;

  const blocked = [];
  if (cryptoBlocked) blocked.push("crypto bloqué");
  if (hardExclude.length > 0) blocked.push("exclusion dure");
  if (n < 30) blocked.push(`n=${n} < 30`);
  if (win == null || win < 85) blocked.push(`win ${win ?? "—"} % < 85 %`);
  if (assign != null && assign > 25) blocked.push(`assignation ${assign} % > 25 %`);
  if (lbClass === "critique" && (win == null || win < 85)) blocked.push("LB critique + win < 85 %");
  if (uniqueness.distinctDeepAssignmentExpirationCount !== 1) {
    blocked.push(`${uniqueness.distinctDeepAssignmentExpirationCount} exp. profondes distinctes (≠ 1)`);
  }
  const assignConcentrated =
    uniqueness.distinctAssignedExpirationCount <= 1 ||
    (uniqueness.assignmentConcentrationPct != null && uniqueness.assignmentConcentrationPct >= 99.9);
  if (!assignConcentrated) {
    blocked.push(`assignation sur ${uniqueness.distinctAssignedExpirationCount} expirations distinctes`);
  }
  if (uniqueness.confirmedRepeatedRisk) blocked.push("risque confirmé répété");

  if (blocked.length) {
    return { bonus: 0, baseBonus: 0, extraBonus: 0, eligible: false, blocked, reasons: blocked.join(" · ") };
  }

  const reasons = [];
  let extraBonus = 0;
  if (n >= 45 && win >= 85) {
    extraBonus = extraAmount;
    reasons.push(`+${baseAmount} base historique robuste`);
    reasons.push(`+${extraAmount} échantillon large (n≥45, win≥85 %)`);
  } else {
    reasons.push(`+${baseAmount} base historique robuste (n≥30, win≥85 %, 1 exp. profonde, risque événement unique)`);
  }
  return { bonus: baseAmount + extraBonus, baseBonus: baseAmount, extraBonus, eligible: true, blocked: [], reasons: reasons.join(" · ") };
}

/**
 * Score compétitif E2b complet pour un profil, avec ventilation et exclusions
 * dures (souples) — voir spécification E2b.
 */
function computeE2bCompetitiveScore(profile, ctx, eventUniqueness, cryptoBlocked) {
  const ticker = e2bSym(profile?.ticker);
  const cfg = E2B_CONFIG;
  const n = profile?.csp?.recordsResolved ?? 0;
  const win = profile?.csp?.realWinRate;
  const yld = profile?.csp?.avgYieldPct;
  const assign = profile?.csp?.assignmentRate;
  const touch = profile?.csp?.strikeTouchRate;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const profonde = profile?.assignment?.profondeRatePct;
  const res = computeE2bResilienceProfile(ticker, profile, ctx);
  const mw = cfg.meritWeights;

  // A) Points de mérite
  const merit = {};
  merit.win = Math.round(e2bMeritWin(win) * mw.win);
  merit.yield = Math.round(e2bMeritYield(yld) * mw.yield);
  merit.lowAssign = Math.round(e2bMeritLowAssign(assign) * mw.lowAssign);
  merit.lbHeld = Math.round(e2bMeritLbHeld(lbClass) * mw.lbHeld);
  if (res.totalExps >= 3) merit.stability = Math.round(10 * (res.cleanExps / res.totalExps) * mw.stability);
  else if (res.totalExps === 2) merit.stability = Math.round(6 * (res.cleanExps / res.totalExps) * mw.stability);
  else merit.stability = 0;
  merit.sample = Math.round(
    (n >= 50 ? 10 : n >= 30 ? 8 : n >= 20 ? 6 : n >= 15 ? 4 : n >= 10 ? 2 : n >= 5 ? 1 : 0) * mw.sample,
  );
  if (touch != null) merit.shortDte = Math.round((touch <= 20 ? 5 : touch <= 30 ? 2 : 0) * mw.shortDte);
  else merit.shortDte = 0;

  // B) Bonus résilience (plafonné)
  const resil = {};
  let resBonus = 0;
  for (const s of res.perStress) {
    let b = s.bonus;
    if (s.expiration === E2B_STRESS_KRACH_EXP && cfg.stressKrachMultiplier) {
      b = Math.round(b * cfg.stressKrachMultiplier);
    }
    resBonus += b;
  }
  resil.stressSurvival = Math.round(resBonus * (cfg.resilWeights.stressSurvival ?? 1));
  if (win != null && win >= 85 && res.perStress.length > 0) {
    resil.winMaintained = Math.round(5 * (cfg.resilWeights.winMaintained ?? 1));
  }
  if (
    (lbClass === "sans_dommage" || lbClass === "none" || lbClass === "non_problématique") &&
    res.perStress.some((s) => s.tier === "severe")
  ) {
    resil.lbHeldUnderStress = Math.round(5 * (cfg.resilWeights.lbHeldUnderStress ?? 1));
  }
  if (cfg.stressKrachLbBonus && res.krachLbHeld) {
    resil.krachLbHeld = cfg.stressKrachLbBonus;
  }
  let resilTotal = Object.values(resil).reduce((a, b) => a + b, 0);
  if (resilTotal > cfg.resilCap) {
    resil._cap = cfg.resilCap - resilTotal;
    resilTotal = cfg.resilCap;
  }

  // D) Pénalités graduées
  const pen = {};
  const dp = cfg.deepExpsPenalties;
  if (res.deepExps === 1) pen.deepExps = dp[1];
  else if (res.deepExps === 2) pen.deepExps = dp[2];
  else if (res.deepExps >= 3) pen.deepExps = dp[3];

  const wp = cfg.winPenalties;
  if (win != null) {
    if (win < 50) pen.win = wp[50];
    else if (win < 70) pen.win = wp[70];
    else if (win < 75) pen.win = wp[75];
    else if (win < 80) pen.win = wp[80];
  }

  const lp = cfg.lbPenalties;
  if (lbClass === "avec_stress") pen.lb = lp.avec_stress;
  else if (lbClass === "critique") {
    if (cfg.lbCritiqueReduced && win != null && win >= 85 && res.deepExps === 1) {
      pen.lb = cfg.lbCritiqueReducedValue;
      pen.lbNote = "LB critique réduit (win≥85 %, 1 exp profonde)";
    } else {
      pen.lb = lp.critique;
    }
  }

  const ap = cfg.assignPenalties;
  if (assign != null) {
    if (assign > 40) pen.assign = ap[40];
    else if (assign > 30) pen.assign = ap[30];
    else if (assign > 20) pen.assign = ap[20];
  }
  if (profonde != null && profonde >= 50 && res.deepExps >= 1) pen.deepRate = cfg.deepRatePenalty;

  const meritTotal = Object.values(merit).reduce((a, b) => a + b, 0);
  const penTotal = Object.values(pen).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);

  // Exclusions dures (souples) — ne restent que pour le risque confirmé répété
  // et les données critiques absentes.
  const hardExclude = [];
  if (lbClass === "critique" && (res.deepExps >= 2 || (win != null && win < 70) || (assign != null && assign > 35))) {
    hardExclude.push("Risque confirmé répété : LB critique + (≥2 expirations profondes ou win<70 % ou assignation>35 %)");
  }
  if (cfg.hardExcludeStrict && lbClass === "critique" && res.deepExps >= 1 && win != null && win < 80 && assign != null && assign > 25) {
    hardExclude.push("Garde-fou défensif : LB critique + assignation>25 % + win<80 %");
  }
  if (n === 0 || profile?.csp == null) hardExclude.push("Données critiques absentes");

  // C) Bonus historique robuste E2b
  const bonus = {};
  const robustBonus = computeE2bRobustHistoryBonus(profile, eventUniqueness, cryptoBlocked, hardExclude);
  if (robustBonus.bonus > 0) bonus.robustHistory = robustBonus.bonus;

  let scoreBeforeCap = meritTotal + resilTotal + penTotal + robustBonus.bonus;

  let cap = null;
  if (n < 5) cap = 25;
  else if (n < 10) cap = 50;
  else if (n < 15) cap = 65;
  else if (n < 30) cap = 85;
  const cappedBy = cap != null && scoreBeforeCap > cap ? cap : null;
  let score = scoreBeforeCap;
  if (cap != null && score > cap) score = cap;
  score = e2bClamp(score, -50, 100);

  const mainReason = buildE2bMainReason({ merit, pen, resilTotal, robustBonus, res, hardExclude });

  return {
    score: e2bRound1(score),
    meritTotal,
    resilTotal,
    penTotal,
    bonusTotal: robustBonus.bonus,
    cappedBy,
    merit,
    resil,
    pen,
    bonus,
    resilience: res,
    hardExclude,
    mainReason,
    robustHistoryBonus: robustBonus,
    stressSurvivalBonus: resil.stressSurvival ?? 0,
    distinctExpirationCount: eventUniqueness.distinctExpirationCount ?? 0,
    distinctAssignedExpirationCount: eventUniqueness.distinctAssignedExpirationCount ?? 0,
    distinctDeepAssignmentExpirationCount: eventUniqueness.distinctDeepAssignmentExpirationCount ?? 0,
  };
}

function buildE2bMainReason(ctx) {
  if (ctx.hardExclude.length) return ctx.hardExclude[0];
  const parts = [];
  const topMerit = Object.entries(ctx.merit).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [k, v] of topMerit) parts.push(`+${v} ${k}`);
  if (ctx.resilTotal > 0) parts.push(`résilience +${ctx.resilTotal}`);
  if (ctx.robustBonus?.bonus > 0) parts.push(`historique robuste +${ctx.robustBonus.bonus}`);
  const topPen = Object.entries(ctx.pen).filter(([, v]) => typeof v === "number" && v < 0).sort((a, b) => a[1] - b[1]).slice(0, 2);
  for (const [k, v] of topPen) parts.push(`${v} ${k}`);
  if (ctx.res.krachSurvived) parts.push("survivant krach 06-05");
  return parts.slice(0, 5).join(" · ") || "profil neutre";
}

/**
 * Pipeline E2b : score compétitif + classement relatif + buckets.
 * Remplace les exclusions binaires brutales par des pénalités graduées : un
 * ticker faible descend dans le classement au lieu de disparaître. Les
 * exclusions dures ne restent que pour crypto-block, données critiques absentes,
 * risque confirmé répété, et échantillon inutilisable.
 */
function computeE2bDynamicTop20(tickerProfiles, records, todayYmd, cryptoBlockedSet) {
  const ctx = buildE2bContext(records, todayYmd);

  const scored = tickerProfiles.map((profile) => {
    const ticker = e2bSym(profile?.ticker);
    const cryptoBlocked = cryptoBlockedSet.has(ticker);
    const uniqueness = computeE2bTickerEventUniqueness(ticker, records);
    const e2b = computeE2bCompetitiveScore(profile, ctx, uniqueness, cryptoBlocked);
    // J5-B3-B — le score RÉALISTE (décision réelle BALANCED + garde-fous) devient le
    // score actif qui pilote le classement Top 20. Le score E2b reste comme référence.
    const realistic = computeRealisticActiveScoreForProfile(profile, e2b.score);
    const activeScore = realistic?.score != null ? realistic.score : e2b.score;
    return {
      profile,
      ticker,
      n: profile?.csp?.recordsResolved ?? 0,
      selectedTradeCount: profile?.realisticDecisionMetrics?.selectedTradeCount ?? 0,
      yieldPct: profile?.csp?.avgYieldPct ?? null,
      verdict: profile?.primaryVerdict ?? "",
      lbClass: profile?.lowerBoundStress?.lbStressClass ?? "none",
      cryptoBlocked,
      uniqueness,
      e2b,
      realistic,
      activeScore,
    };
  });

  const rankable = scored.filter((s) => !s.cryptoBlocked && s.e2b.hardExclude.length === 0);
  // Tri par score réaliste actif (et non plus par score E2b brut).
  rankable.sort(
    (a, b) =>
      b.activeScore - a.activeScore ||
      b.n - a.n ||
      (b.yieldPct ?? -1) - (a.yieldPct ?? -1) ||
      a.ticker.localeCompare(b.ticker),
  );

  // Admissibilité Top 20 principal STRICTE : score réaliste suffisant + échantillon
  // observationnel minimal + garde-fous décision réelle (selectedTradeCount≥5,
  // rendement réel ≥0,5 %, assignation profonde réelle ≤50 %).
  const scoreAndSampleOk = (s) =>
    s.activeScore >= E2B_EXPLOITABLE_MIN_SCORE && s.n >= E2B_EXPLOITABLE_MIN_N;
  const strictEligible = rankable.filter(
    (s) => scoreAndSampleOk(s) && (s.realistic?.eligibleForTop20 ?? true),
  );
  const strictSet = new Set(strictEligible.map((s) => s.ticker));

  // J5-B6 — Candidats « à confirmer » : remplissent le Top 20 DERRIÈRE les stricts
  // quand ceux-ci sont insuffisants (3–4 décisions réelles + garde-fous qualité OK +
  // échantillon observationnel suffisant). Jamais devant un strict (concaténés après).
  const confirmEligible = rankable.filter(
    (s) =>
      !strictSet.has(s.ticker) &&
      scoreAndSampleOk(s) &&
      (s.realistic?.eligibleForTop20Confirm ?? false),
  );

  const bucketByTicker = new Map();
  let rank = 0;

  // Stricts d'abord (triés par score réaliste), puis confirm (triés par score réaliste),
  // le tout plafonné à 20. Un confirm n'entre que si les places strictes sont insuffisantes.
  const top20List = [...strictEligible, ...confirmEligible].slice(0, 20);
  const top20Set = new Set(top20List.map((s) => s.ticker));
  const strictInTop20 = top20List.filter((s) => strictSet.has(s.ticker)).length;
  const confirmInTop20 = top20List.length - strictInTop20;
  for (const s of top20List) {
    rank += 1;
    bucketByTicker.set(s.ticker, { bucket: "top20", rank });
  }

  const rest = rankable.filter((s) => !top20Set.has(s.ticker));
  const nearEntryList = rest.filter((s) => s.activeScore >= 20 && s.n >= 5).slice(0, 12);
  const nearSet = new Set(nearEntryList.map((s) => s.ticker));
  for (const s of nearEntryList) {
    rank += 1;
    bucketByTicker.set(s.ticker, { bucket: "nearEntry", rank });
  }

  const watchList = rest.filter((s) => !nearSet.has(s.ticker) && s.n >= 5 && s.activeScore >= 0);
  const watchSet = new Set(watchList.map((s) => s.ticker));
  for (const s of watchList) {
    rank += 1;
    bucketByTicker.set(s.ticker, { bucket: "watchValidate", rank });
  }

  // Reste (score < 0, ou n < 5) : ne disparaît pas — descend en bas / surveillé /
  // exclu. On le ventile entre stressé, échantillon insuffisant, et exclus.
  const lowList = rest.filter((s) => !nearSet.has(s.ticker) && !watchSet.has(s.ticker));
  for (const s of lowList) {
    let bucket;
    if (s.n < 5) bucket = "insufficientSample";
    else if (s.verdict === "1 % stressé" || s.lbClass === "avec_stress") bucket = "stressed";
    else bucket = "excludedHighYield";
    bucketByTicker.set(s.ticker, { bucket, rank: null });
  }

  // Exclusions dures (risque confirmé répété / données critiques absentes).
  for (const s of scored.filter((r) => !r.cryptoBlocked && r.e2b.hardExclude.length > 0)) {
    bucketByTicker.set(s.ticker, { bucket: "excludedHighYield", rank: null });
  }

  return {
    ctx,
    scored,
    bucketByTicker,
    top20Count: top20List.length,
    // `exploitableCount` reste = nombre d'admissibles STRICTS (rétrocompat meta).
    exploitableCount: strictEligible.length,
    strictEligibleCount: strictEligible.length,
    confirmEligibleCount: confirmEligible.length,
    strictInTop20,
    confirmInTop20,
  };
}

function mapDynamicTop20ProfileRow(profile, rank, status, extra = {}) {
  const n = profile?.csp?.recordsResolved ?? 0;
  const scoring = computeDynamicTop20LaboratoryScore(profile);
  const scoreReasons =
    scoring.scoreReasons.length > 0
      ? scoring.scoreReasons
      : Array.isArray(profile?.verdictReasons)
      ? profile.verdictReasons.slice(0, 3)
      : [];
  const top20ExclusionReasons =
    Array.isArray(extra.top20ExclusionReasons) && extra.top20ExclusionReasons.length > 0
      ? extra.top20ExclusionReasons
      : status === "top20_experimental"
      ? []
      : getExperimentalTop20IneligibilityReasons(profile, false).filter(
          (reason) => !reason.includes("échantillon"),
        );

  // Diagnostic E2b — quand le pipeline compétitif est actif, le score RÉALISTE devient
  // le score affiché (dynamicTop20Score) et le score E2b est conservé en référence.
  const e2b = extra.e2b ?? null;
  // J5-B3-B — score réaliste actif (pilote le classement). Le fallback sur e2b.score
  // garantit qu'une ligne sans bloc décision réelle reste classée par l'ancien score.
  const realistic = extra.realistic ?? null;
  const realisticActiveScore =
    realistic && realistic.score != null ? realistic.score : e2b ? e2b.score : null;
  const e2bMetaFields = extra.e2bMetaFields ?? {};
  const e2bFields = e2b
    ? {
        // Score réaliste ACTIF — pilote désormais le classement Top 20.
        dynamicTop20Score: realisticActiveScore,
        dynamicTop20ScoreRealistic: realisticActiveScore,
        dynamicTop20ScoreSource: realistic && realistic.score != null ? "realistic" : "competitive",
        // Ancien score officiel Top 20 (compétitif E2b) — conservé en référence.
        dynamicTop20ScoreLegacy: e2b.score,
        dynamicTop20ScoreE2b: e2b.score,
        // Ancien score laboratoire (observationnel) — conservé en référence secondaire.
        dynamicTop20ScoreLaboratory: scoring.dynamicTop20Score,
        // Détail réaliste (garde-fous, pénalités/bonus, confiance) porté sur la ligne.
        realisticActive: realistic
          ? {
              score: realistic.score,
              baseScore: realistic.baseScore,
              eligibleForTop20: realistic.eligibleForTop20,
              eligibilityReason: realistic.eligibilityReason,
              confidence: realistic.confidence,
              confidenceBadge: realistic.confidenceBadge,
              rankImpactReason: realistic.rankImpactReason,
              penalties: realistic.penalties,
              bonuses: realistic.bonuses,
              // J5-B6 — buckets de remplissage Top 20 réaliste.
              eligibleForTop20Confirm: realistic.eligibleForTop20Confirm ?? false,
              dynamicTop20RealisticBucket: realistic.dynamicTop20RealisticBucket ?? null,
              dynamicTop20Confidence: realistic.dynamicTop20Confidence ?? null,
              selectedTradeCountGuard: realistic.selectedTradeCountGuard ?? null,
              realisticEligibilityReason: realistic.realisticEligibilityReason ?? null,
            }
          : null,
        // J5-B6 — champs de remplissage portés au niveau de la ligne (UI / rapports).
        dynamicTop20RealisticBucket: realistic?.dynamicTop20RealisticBucket ?? null,
        dynamicTop20Confidence: realistic?.dynamicTop20Confidence ?? null,
        selectedTradeCountGuard: realistic?.selectedTradeCountGuard ?? null,
        realisticEligibilityReason: realistic?.realisticEligibilityReason ?? null,
        realisticReasonSummary: buildRealisticActiveReasonSummary(
          realistic,
          profile?.realisticDecisionMetrics ?? null,
          // Référence = ancien score officiel Top 20 (compétitif E2b), cohérent avec la colonne.
          e2b.score,
        ),
        competitiveScoreV2: e2b.score,
        competitiveScoreBreakdown: {
          meritTotal: e2b.meritTotal,
          resilTotal: e2b.resilTotal,
          penTotal: e2b.penTotal,
          robustHistoryBonus: e2b.bonusTotal,
          cappedBy: e2b.cappedBy,
          merit: e2b.merit,
          resil: e2b.resil,
          penalties: e2b.pen,
          mainReason: e2b.mainReason,
        },
        meritPoints: e2b.meritTotal,
        resiliencePoints: e2b.resilTotal,
        robustHistoryBonus: e2b.bonusTotal,
        robustHistoryBonusDetail: e2b.robustHistoryBonus,
        penaltyPoints: e2b.penTotal,
        distinctExpirationCount: e2b.distinctExpirationCount,
        distinctAssignedExpirationCount: e2b.distinctAssignedExpirationCount,
        distinctDeepAssignmentExpirationCount: e2b.distinctDeepAssignmentExpirationCount,
        stressSurvivalBonus: e2b.stressSurvivalBonus,
        hardExclusionReasonsV2: e2b.hardExclude,
        rankingFormulaVersion: E2B_RANKING_FORMULA_VERSION,
      }
    : {};

  return {
    rank,
    ticker: profile.ticker,
    mode: profile.mode,
    dynamicTop20Score: scoring.dynamicTop20Score,
    dynamicTop20Status: status,
    dynamicTop20StatusLabel: DYNAMIC_TOP20_STATUS_LABELS[status] ?? status,
    scoreReasons,
    scoreWarnings: scoring.scoreWarnings,
    top20ExclusionReasons,
    currentVerdict: profile.primaryVerdict,
    sampleLabel: profile.sampleCredibility,
    sampleDisplayLabel:
      status === "top20_experimental" && n >= 15 ? (n >= 30 ? "mesurable" : "préliminaire") : null,
    n,
    avgCspYieldPct: profile?.csp?.avgYieldPct ?? null,
    avgPop: profile?.csp?.avgPopAnnounced ?? null,
    winRate: profile?.csp?.realWinRate ?? null,
    assignmentRate: profile?.csp?.assignmentRate ?? null,
    nearAssignmentRate: profile?.assignment?.procheRatePct ?? null,
    deepAssignmentRate: profile?.assignment?.profondeRatePct ?? null,
    avgWheelReturnPct: profile?.wheel?.avgWheelReturnPct ?? null,
    lbStressLabel: profile?.lowerBoundStress?.lbStressLabel ?? null,
    primaryReason: profile?.verdictReasons?.[0] ?? profile?.primaryVerdict ?? null,
    verdictReasons: profile?.verdictReasons ?? [],
    // J5-B1 — porte le bloc additif « décision réelle » du profil vers la ligne Top 20.
    realisticDecisionMetrics: profile?.realisticDecisionMetrics ?? null,
    ...summarizeOptionQuoteDiagnosticsFromProfile(profile),
    ...e2bMetaFields,
    ...e2bFields,
  };
}

function summarizeOptionQuoteDiagnosticsFromProfile(profile) {
  const summary = profile?.optionData ?? summarizeOptionDataForProfile([]);
  return {
    hasObservedIbkrOptionData: (summary?.recordsWithIbkrObserved ?? 0) > 0,
    optionDataCompletenessPct: summary?.avgOptionDataCompletenessPct ?? 0,
    optionDataMissingFields: [],
    optionDataSourceSummary: summary?.optionDataSourceSummary ?? "absent",
    optionSnapshotStorageStatus: summary?.optionSnapshotStorageStatus ?? "snapshot_absent",
    optionDataBadge: buildOptionDataBadge(summary),
  };
}

/**
 * Construit le résultat Top 20 via le pipeline compétitif E2b et le projette sur
 * la même structure de retour que le moteur legacy (mêmes buckets et champs),
 * en ajoutant les champs de diagnostic E2b à chaque ligne. L'UI reste compatible.
 */
function buildDynamicTop20E2bResult({
  tickerProfiles,
  records,
  todayYmd,
  cryptoBlockedProfiles,
  asOfDate,
  dteFilter = null,
}) {
  const cryptoBlockedSet = new Set(
    (cryptoBlockedProfiles ?? []).map((p) => e2bSym(p?.ticker)),
  );
  const e2bResult = computeE2bDynamicTop20(tickerProfiles, records, todayYmd, cryptoBlockedSet);
  const { scored, bucketByTicker } = e2bResult;

  const sortByRank = (a, b) => (a._rank ?? 1e9) - (b._rank ?? 1e9);

  // Regrouper par bucket en conservant le rang relatif E2b.
  const grouped = {
    top20: [],
    nearEntry: [],
    watchValidate: [],
    stressed: [],
    excludedHighYield: [],
    insufficientSample: [],
  };
  for (const s of scored) {
    const placement = bucketByTicker.get(s.ticker) ?? { bucket: "excludedHighYield", rank: null };
    const target = grouped[placement.bucket] ?? grouped.excludedHighYield;
    target.push({ ...s, _rank: placement.rank });
  }
  for (const key of Object.keys(grouped)) grouped[key].sort(sortByRank);

  const buildRow = (s, displayRank, status) => {
    const hardReasons = s.e2b.hardExclude ?? [];
    let exclusionReasons = [];
    if (status === "exclude_high_yield") {
      exclusionReasons = hardReasons.length > 0 ? hardReasons : [s.e2b.mainReason];
    } else if (status === "stressed") {
      exclusionReasons = [s.e2b.mainReason];
    }
    return mapDynamicTop20ProfileRow(s.profile, displayRank, status, {
      e2b: s.e2b,
      realistic: s.realistic,
      ...(exclusionReasons.length > 0 ? { top20ExclusionReasons: exclusionReasons } : {}),
    });
  };

  const top20 = grouped.top20.map((s, i) => buildRow(s, i + 1, "top20_experimental"));
  const nearEntry = grouped.nearEntry.map((s, i) => buildRow(s, top20.length + i + 1, "near_entry"));
  const watchValidate = grouped.watchValidate.map((s, i) => buildRow(s, i + 1, "watch_validate"));
  const stressed = grouped.stressed.map((s, i) => buildRow(s, i + 1, "stressed"));
  const excludedHighYield = grouped.excludedHighYield.map((s, i) => buildRow(s, i + 1, "exclude_high_yield"));
  const insufficientSample = grouped.insufficientSample.map((s, i) =>
    buildRow(s, i + 1, "insufficient_sample"),
  );
  const excludedCrypto = (cryptoBlockedProfiles ?? [])
    .slice()
    .sort((a, b) => String(a?.ticker ?? "").localeCompare(String(b?.ticker ?? "")))
    .map((profile, index) =>
      mapDynamicTop20ProfileRow(profile, index + 1, "exclude_crypto_blocked", {
        top20ExclusionReasons: [TOP20_CRYPTO_BLOCK_REASON],
        e2bMetaFields: {
          hardExclusionReasonsV2: [TOP20_CRYPTO_BLOCK_REASON],
          rankingFormulaVersion: E2B_RANKING_FORMULA_VERSION,
        },
      }),
    );

  return attachRealisticPreviewToDynamicTop20Result({
    ok: true,
    asOfDate,
    top20,
    nearEntry,
    watchValidate,
    excludedHighYield,
    stressed,
    insufficientSample,
    excludedCrypto,
    summary: {
      totalProfiles: tickerProfiles.length,
      top20Count: top20.length,
      nearEntryCount: nearEntry.length,
      watchValidateCount: watchValidate.length,
      stressedCount: stressed.length,
      excludedHighYieldCount: excludedHighYield.length,
      insufficientSampleCount: insufficientSample.length,
      excludedCryptoCount: excludedCrypto.length,
      contextAvailability: { ...DYNAMIC_TOP20_CONTEXT_AVAILABILITY },
    },
    meta: {
      readOnly: true,
      experimental: true,
      // J5-B3-B — le score réaliste (décision réelle BALANCED + garde-fous) pilote le tri.
      scoreType: "dynamicTop20ScoreRealistic",
      scoreSource: "realistic",
      // J6-A — horizon DTE sur lequel ce classement a été recalculé (null = tous DTE).
      dteFilter: dteFilter ?? null,
      rankingFormulaVersion: E2B_RANKING_FORMULA_VERSION,
      scoreNote:
        "Score réaliste actif (décision réelle BALANCED 1 trade/ticker×expiration + garde-fous) — pilote le classement Top 20. Score compétitif E2b conservé en référence (dynamicTop20ScoreLegacy).",
      guardrails: {
        exploitableForTop20Count: e2bResult.exploitableCount,
        exploitableMinScore: E2B_EXPLOITABLE_MIN_SCORE,
        exploitableMinN: E2B_EXPLOITABLE_MIN_N,
        realisticMinSelectedTradeCount: REALISTIC_STRICT_MIN_TRADE_COUNT,
        realisticMinSelectedYieldPct: REALISTIC_DECISION_MIN_CSP_YIELD_PCT,
        realisticMaxDeepAssignmentRatePct: 50,
        // J5-B6 — remplissage « à confirmer » derrière les stricts.
        realisticConfirmMinSelectedTradeCount: REALISTIC_CONFIRM_MIN_TRADE_COUNT,
        realisticConfirmMinObservationResolved: REALISTIC_CONFIRM_MIN_OBS_RESOLVED,
        strictEligibleForTop20Count: e2bResult.strictEligibleCount,
        confirmEligibleForTop20Count: e2bResult.confirmEligibleCount,
        strictInTop20Count: e2bResult.strictInTop20,
        confirmInTop20Count: e2bResult.confirmInTop20,
      },
      realisticScoreActiveNote:
        "dynamicTop20Score = score réaliste actif (pilote le classement). dynamicTop20ScoreLegacy = ancien score compétitif E2b (référence). Pas de second classement.",
      realisticTop20FillNote:
        "J5-B6 — le Top 20 est rempli d'abord par les admissibles STRICTS (selectedTradeCount≥5 + garde-fous), puis complété par des candidats « à confirmer » (3–4 décisions, garde-fous OK, observations≥15) DERRIÈRE les stricts. Un seul classement, score réaliste inchangé.",
    },
  });
}

// ── J6-A — Filtre DTE réel du Top réaliste ────────────────────────────────────
// Permet de recalculer/filtrer le Top réaliste sur un horizon DTE unique (7/4/3/2).
// `null` / "all" / "tous" = comportement actuel (tous DTE mélangés). Le filtre est
// appliqué AVANT toute métrique réaliste : les observations hors DTE sont retirées
// puis les profils sont RECONSTRUITS sur le sous-ensemble (donc selectedTradeCount,
// rendement réel, assignation réelle, score réaliste sont recalculés par DTE).
const DYNAMIC_TOP20_DTE_VIEW_TARGETS = [7, 4, 3];

function normalizeDynamicTop20DteFilter(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (raw === "" || raw === "all" || raw === "tous") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classement expérimental Top 20 — laboratoire read-only à partir des profils 1 %+ Wheel.
 *
 * J6-A — `options.dteFilter` (7/4/3/2 ou null/"all") recalcule le Top réaliste sur les
 * seules observations du DTE choisi. Quand un filtre est actif et que les records bruts
 * sont fournis, les profils passés en argument sont reconstruits depuis le sous-ensemble
 * DTE (`options.cycles` réutilisés pour le bloc Wheel). Sans filtre, le comportement
 * global d'origine est strictement conservé.
 */
export function computeDynamicTop20WheelProfiles(profiles, options = {}) {
  const dteFilter = normalizeDynamicTop20DteFilter(options.dteFilter);
  let inputProfiles = Array.isArray(profiles) ? profiles : [];
  let optionRecords = Array.isArray(options.records) ? options.records : null;
  if (dteFilter != null && optionRecords) {
    // Filtre DTE AVANT reconstruction des profils → toutes les métriques réalistes
    // (decisionMetrics, csp, assignment, score, garde-fous) sont recalculées par DTE.
    optionRecords = optionRecords.filter(
      (record) => toNumberOrNull(record?.dteAtScan) === dteFilter,
    );
    const rebuilt = computeOnePercentWheelProfiles(
      optionRecords,
      Array.isArray(options.cycles) ? options.cycles : [],
      options,
    );
    inputProfiles = Array.isArray(rebuilt.profiles) ? rebuilt.profiles : [];
  }

  const allProfiles = inputProfiles;
  const tickerProfilesAll = allProfiles.filter((profile) => profile?.groupType === "ticker");

  // Bug fix — règle crypto-block : crypto/digital asset exclus du laboratoire Top 20
  // (sauf BITX) AVANT la constitution des buckets. Source unique app/watchlist/cryptoWheelFilter.js.
  const cryptoBlockedProfiles = tickerProfilesAll.filter((profile) =>
    isCryptoDigitalAssetBlocked(profile?.ticker),
  );
  const tickerProfiles = tickerProfilesAll.filter(
    (profile) => !isCryptoDigitalAssetBlocked(profile?.ticker),
  );
  const excludedCrypto = cryptoBlockedProfiles
    .slice()
    .sort((a, b) => String(a?.ticker ?? "").localeCompare(String(b?.ticker ?? "")))
    .map((profile, index) =>
      mapDynamicTop20ProfileRow(profile, index + 1, "exclude_crypto_blocked", {
        top20ExclusionReasons: [TOP20_CRYPTO_BLOCK_REASON],
      }),
    );

  // ── Pipeline compétitif E2b (candidate finale) ────────────────────────────
  // Activé seulement quand les enregistrements bruts sont disponibles
  // (chemin de production via le journal). Sans records → scoring legacy ci-dessous
  // (compatibilité des tests unitaires existants appelant sans records).
  const e2bRecords = optionRecords;
  if (e2bRecords && e2bRecords.length > 0) {
    const asOfDate = normalizeIsoTimestamp(options.today ?? options.asOfDate ?? new Date()).slice(0, 10);
    return buildDynamicTop20E2bResult({
      tickerProfiles,
      records: e2bRecords,
      todayYmd: asOfDate,
      cryptoBlockedProfiles,
      asOfDate,
      dteFilter,
    });
  }

  const scored = tickerProfiles.map((profile) => {
    const scoring = computeDynamicTop20LaboratoryScore(profile);
    return { profile, ...scoring };
  });

  scored.sort((a, b) => {
    if (b.dynamicTop20Score !== a.dynamicTop20Score) return b.dynamicTop20Score - a.dynamicTop20Score;
    const nDelta = (b.profile?.csp?.recordsResolved ?? 0) - (a.profile?.csp?.recordsResolved ?? 0);
    if (nDelta !== 0) return nDelta;
    const yieldDelta = (b.profile?.csp?.avgYieldPct ?? -1) - (a.profile?.csp?.avgYieldPct ?? -1);
    if (yieldDelta !== 0) return yieldDelta;
    return String(a.profile?.ticker ?? "").localeCompare(String(b.profile?.ticker ?? ""));
  });

  const profilesN15Plus = scored.filter((item) => (item.profile?.csp?.recordsResolved ?? 0) >= 15);
  const enforceN15Guard = profilesN15Plus.length >= 20;

  const eligibleItems = scored.filter(
    (item) => isEligibleForExperimentalTop20(item.profile, { enforceN15Guard }).eligible,
  );

  const top20Items = eligibleItems.slice(0, 20);
  const top20Tickers = new Set(top20Items.map((item) => item.profile.ticker));

  const excludedHighYield = scored
    .filter((item) => !top20Tickers.has(item.profile.ticker))
    .filter((item) => isDynamicTop20HighYieldExclusion(item.profile))
    .map((item, index) => {
      const riskReasons = getExperimentalTop20IneligibilityReasons(item.profile, false).filter(
        (reason) => !reason.includes("échantillon"),
      );
      return mapDynamicTop20ProfileRow(item.profile, index + 1, "exclude_high_yield", {
        top20ExclusionReasons: riskReasons,
      });
    });

  const excludedTickers = new Set(excludedHighYield.map((row) => row.ticker));

  const top20 = top20Items.map((item, index) =>
    mapDynamicTop20ProfileRow(item.profile, index + 1, "top20_experimental"),
  );

  const nearEntryItems = scored
    .filter((item) => !top20Tickers.has(item.profile.ticker))
    .filter((item) => !excludedTickers.has(item.profile.ticker))
    .filter((item) => (item.profile?.csp?.recordsResolved ?? 0) >= 5)
    .filter((item) => !isDynamicTop20HighYieldExclusion(item.profile))
    .slice(0, 10);

  const nearEntry = nearEntryItems.map((item, index) =>
    mapDynamicTop20ProfileRow(item.profile, top20.length + index + 1, "near_entry"),
  );

  const watchValidate = scored
    .filter((item) => !top20Tickers.has(item.profile.ticker))
    .filter((item) => !excludedTickers.has(item.profile.ticker))
    .filter((item) => {
      const n = item.profile?.csp?.recordsResolved ?? 0;
      return (
        (n >= 5 && n < 15) ||
        (n >= 15 && n < 30 && item.profile?.primaryVerdict === "1 % à valider")
      );
    })
    .filter((item) => !isDynamicTop20HighYieldExclusion(item.profile))
    .slice(0, 30)
    .map((item, index) => mapDynamicTop20ProfileRow(item.profile, index + 1, "watch_validate"));

  const stressed = scored
    .filter((item) => !top20Tickers.has(item.profile.ticker))
    .filter((item) => !excludedTickers.has(item.profile.ticker))
    .filter((item) => {
      const verdict = item.profile?.primaryVerdict ?? "";
      const lbClass = item.profile?.lowerBoundStress?.lbStressClass ?? "none";
      return verdict === "1 % stressé" || lbClass === "avec_stress";
    })
    .filter((item) => !isDynamicTop20HighYieldExclusion(item.profile))
    .slice(0, 30)
    .map((item, index) => mapDynamicTop20ProfileRow(item.profile, index + 1, "stressed"));

  const insufficientSample = scored
    .filter((item) => (item.profile?.csp?.recordsResolved ?? 0) < 5)
    .map((item, index) => mapDynamicTop20ProfileRow(item.profile, index + 1, "insufficient_sample"));

  const asOfDate = normalizeIsoTimestamp(options.today ?? options.asOfDate ?? new Date()).slice(0, 10);

  return attachRealisticPreviewToDynamicTop20Result({
    ok: true,
    asOfDate,
    top20,
    nearEntry,
    watchValidate,
    excludedHighYield,
    stressed,
    insufficientSample,
    excludedCrypto,
    summary: {
      totalProfiles: tickerProfiles.length,
      top20Count: top20.length,
      nearEntryCount: nearEntry.length,
      watchValidateCount: watchValidate.length,
      stressedCount: stressed.length,
      excludedHighYieldCount: excludedHighYield.length,
      insufficientSampleCount: insufficientSample.length,
      excludedCryptoCount: excludedCrypto.length,
      contextAvailability: { ...DYNAMIC_TOP20_CONTEXT_AVAILABILITY },
    },
    meta: {
      readOnly: true,
      experimental: true,
      scoreType: "dynamicTop20Score",
      // J6-A — horizon DTE sur lequel ce classement a été recalculé (null = tous DTE).
      dteFilter: dteFilter ?? null,
      scoreNote:
        "Score provisoire de laboratoire — ne constitue pas un score final ni une recommandation de trade.",
      guardrails: {
        enforceN15Guard,
        eligibleForTop20Count: eligibleItems.length,
      },
      realisticPreviewNote:
        "realisticPreview / realisticPreviewRank = simulation J5-B3-A — n'influencent pas le classement officiel.",
    },
  });
}

export function createWheelValidationService(options = {}) {
  const store = options.store ?? createWheelValidationStore(options.journalPath);
  const marketService = options.marketService ?? null;
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
    const skippedReasons = {
      missingTicker: 0,
      missingStrike: 0,
      missingExpiration: 0,
      missingPremium: 0,
      missingMode: 0,
      duplicate: 0,
      invalidCandidate: 0,
    };
    const sampleSkipped = [];
    const pushSampleSkipped = (candidate, reason) => {
      if (sampleSkipped.length >= 5) return;
      sampleSkipped.push({
        ticker: candidate?.symbol ?? candidate?.ticker ?? null,
        reason,
        keys: Object.keys(candidate || {}),
      });
    };
    const diagnoseSkip = (candidate, strikeMode) => {
      if (!candidate || typeof candidate !== "object") {
        skippedReasons.invalidCandidate += 1;
        pushSampleSkipped(candidate, "invalidCandidate");
        return;
      }
      const symbol = normalizeSymbol(candidate?.symbol ?? candidate?.ticker);
      if (!symbol) {
        skippedReasons.missingTicker += 1;
        pushSampleSkipped(candidate, "missingTicker");
        return;
      }
      const expiration = normalizeExpiration(
        candidate?.expiration ??
          candidate?.targetExpiration ??
          candidate?.ibkrDirect?.raw?.expiration ??
          candidate?.raw?.expiration
      );
      if (!expiration) {
        skippedReasons.missingExpiration += 1;
        pushSampleSkipped(candidate, "missingExpiration");
      }
      const strikeRow = getStrikeRow(candidate, strikeMode);
      const strike = toNumberOrNull(strikeRow?.strike);
      if (strike == null) {
        skippedReasons.missingStrike += 1;
        pushSampleSkipped(candidate, `missingStrike:${strikeMode}`);
        return;
      }
      const premium =
        toNumberOrNull(strikeRow?.premium) ??
        toNumberOrNull(strikeRow?.premiumUsed) ??
        toNumberOrNull(strikeRow?.mid) ??
        toNumberOrNull(strikeRow?.bid) ??
        null;
      if (premium == null) {
        skippedReasons.missingPremium += 1;
        pushSampleSkipped(candidate, `missingPremium:${strikeMode}`);
      }
    };
    const sharedMarketContextSnapshot = options.marketContextSnapshot ?? null;
    // Phase 1 — saisonnalité cache-only, best-effort, dédupliquée par symbole
    // (une seule lecture cache pour les records safe + aggressive d'un ticker).
    // Injectable pour les tests via options.resolveSeasonalitySnapshot.
    const seasonalityBySymbol = new Map();
    const resolveSeasonalitySnapshot =
      typeof options.resolveSeasonalitySnapshot === "function"
        ? options.resolveSeasonalitySnapshot
        : (sym) => buildSeasonalitySnapshotFromCache(sym);
    const getSeasonalitySnapshot = (symbolRaw) => {
      const sym = normalizeSymbol(symbolRaw);
      if (!sym) return null;
      if (seasonalityBySymbol.has(sym)) return seasonalityBySymbol.get(sym);
      let snapshot = null;
      try {
        snapshot = resolveSeasonalitySnapshot(sym) ?? null;
      } catch (_) {
        snapshot = null; // best-effort : jamais bloquant pour la capture
      }
      seasonalityBySymbol.set(sym, snapshot);
      return snapshot;
    };
    for (let index = 0; index < finalCandidates.length; index += 1) {
      const candidate = finalCandidates[index];
      const perCandidateOptions = {
        selectedExpiration: options.selectedExpiration,
        captureSource: options.captureSource,
        dteAtScan: options.dteAtScan,
        candidateRank: toNumberOrNull(candidate?.rank) ?? index + 1,
        marketContextSnapshot: sharedMarketContextSnapshot,
        seasonalitySnapshot: getSeasonalitySnapshot(candidate?.symbol ?? candidate?.ticker),
      };
      const safeRecord = normalizeRecord(candidate, "safe", scanTimestamp, scanSessionId, perCandidateOptions);
      if (safeRecord) records.push(safeRecord);
      else diagnoseSkip(candidate, "safe");
      const aggressiveRecord = normalizeRecord(
        candidate,
        "aggressive",
        scanTimestamp,
        scanSessionId,
        perCandidateOptions
      );
      if (aggressiveRecord) records.push(aggressiveRecord);
      else diagnoseSkip(candidate, "aggressive");
    }
    records._diagnostics = { skippedReasons, sampleSkipped };
    return records;
  }

  function buildMarketContextSnapshotRowForCapture(record, marketContextSnapshot) {
    if (!record || !marketContextSnapshot || typeof marketContextSnapshot !== "object") return null;
    return {
      record_id: record?.id ?? null,
      scan_date: record?.scanDate ?? null,
      ticker: record?.symbol ?? null,
      expiration: record?.expiration ?? record?.selectedExpiration ?? null,
      spy_price: marketContextSnapshot.spyPrice ?? null,
      spy_ma50: marketContextSnapshot.spyMa50 ?? null,
      spy_ma200: marketContextSnapshot.spyMa200 ?? null,
      qqq_price: marketContextSnapshot.qqqPrice ?? null,
      qqq_ma50: marketContextSnapshot.qqqMa50 ?? null,
      qqq_ma200: marketContextSnapshot.qqqMa200 ?? null,
      vix_level: marketContextSnapshot.vixLevel ?? null,
      market_regime: marketContextSnapshot.marketRegimeLabel ?? null,
      spy_trend_regime: marketContextSnapshot.spyTrendLabel ?? null,
      qqq_trend_regime: marketContextSnapshot.qqqTrendLabel ?? null,
      vix_regime: marketContextSnapshot.vixRegimeLabel ?? null,
      sector_regime: marketContextSnapshot.breadthLabel ?? null,
      market_drawdown_regime: null,
      spy_30d_return: null,
      qqq_30d_return: null,
      vix_percentile: null,
      market_volatility_regime: marketContextSnapshot.marketRiskLabel ?? null,
      broad_market_score: null,
    };
  }

  async function persistMarketContextSnapshotForCapture(uniqueRecords, marketContextSnapshot) {
    if (typeof store?.insertMarketContextSnapshot !== "function") return;
    if (!marketContextSnapshot || typeof marketContextSnapshot !== "object") return;
    if (!Array.isArray(uniqueRecords) || uniqueRecords.length === 0) return;

    const representativeRecord = uniqueRecords[0];
    const row = buildMarketContextSnapshotRowForCapture(representativeRecord, marketContextSnapshot);
    if (!row) return;

    try {
      await store.insertMarketContextSnapshot(row);
    } catch (error) {
      console.warn(
        `[wheelValidationService] insertMarketContextSnapshot failed: ${error?.message || String(error)}`
      );
    }
  }

  async function listJournal() {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    return {
      ...journal,
      records: records.map((record) =>
        enrichRecordWithMarketContextFields(
          enrichRecordWithTechnicalSnapshotFields(
            enrichRecordWithOptionQuoteFields(enrichWithAssignmentDepthFields(record))
          )
        )
      ),
    };
  }

  async function getLatestOptionSnapshots(options = {}) {
    const limit = toIntegerWithin(options?.limit, { min: 1, max: 50, fallback: 50 });
    if (store?.sqlitePath) {
      const sqliteRows = readLatestOptionSnapshotRowsFromSqlite(store.sqlitePath);
      if (sqliteRows) return buildLatestOptionSnapshotsPayload(sqliteRows, { limit });
    }
    if (typeof store?.listLatestOptionSnapshotRows === "function") {
      const rows = await store.listLatestOptionSnapshotRows({ limit });
      return buildLatestOptionSnapshotsPayload(rows, { limit });
    }
    const journal = await store.load();
    return buildLatestOptionSnapshotsPayload(buildLatestOptionSnapshotsFromLoadedJournal(journal), { limit });
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

  async function computeRealPopCalibrationFromJournal(options = {}) {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    return computeRealPopCalibration(records, options);
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
      const scanTimestamp = normalizeIsoTimestamp(options.scanTimestamp);
      let marketContextSnapshot = options.marketContextSnapshot ?? null;
      if (!marketContextSnapshot && marketService) {
        try {
          marketContextSnapshot = await buildMarketContextSnapshot({
            marketService,
            scanTimestamp,
          });
        } catch (_err) {
          marketContextSnapshot = null;
        }
      }
      const records = buildRecordsFromCandidates(candidates, {
        ...options,
        scanTimestamp,
        marketContextSnapshot,
      });
      const buildDiagnostics = records._diagnostics ?? { skippedReasons: {}, sampleSkipped: [] };
      delete records._diagnostics;
      if (records.length === 0) {
        return {
          captured: 0,
          duplicates: 0,
          skipped: 0,
          primaryDailyCount: 0,
          intradayRetestCount: 0,
          requestedTopN: Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30,
          skippedReasons: buildDiagnostics.skippedReasons,
          sampleSkipped: buildDiagnostics.sampleSkipped,
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
        await persistMarketContextSnapshotForCapture(uniqueRecords, marketContextSnapshot);
      }

      const skippedReasons = { ...buildDiagnostics.skippedReasons };
      if (duplicates > 0) skippedReasons.duplicate = duplicates;
      return {
        captured: uniqueRecords.length,
        duplicates,
        skipped: records.length - uniqueRecords.length,
        requestedTopN: Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30,
        primaryDailyCount,
        intradayRetestCount,
        skippedReasons,
        sampleSkipped: buildDiagnostics.sampleSkipped,
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
        const recordExpirationYmd = toExpirationYmd(record?.expiration);
        const selectedExpirationYmd = toExpirationYmd(record?.selectedExpiration);
        // Bug fix — la date de résolution doit suivre l'expiration réelle du contrat
        // vendu (selectedExpiration), jamais la clé de cohorte (expiration) si elles
        // divergent. Empêche de résoudre prématurément (ex. option 20260612 résolue
        // sur le close du 20260605). expiration n'écrase pas selectedExpiration.
        const expirationYmd = selectedExpirationYmd ?? recordExpirationYmd;
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

  /**
   * Remédiation — rouvre (dé-résout) les records résolus prématurément à cause du
   * mismatch expiration/selectedExpiration : une ligne dont selectedExpiration est
   * postérieure à expiration a été résolue sur le close de la mauvaise (plus proche)
   * expiration. On efface la résolution erronée pour qu'une prochaine passe
   * resolveExpiredRecords (logique corrigée) les traite sur selectedExpiration.
   * @param {{dryRun?: boolean}} [options]
   */
  async function reopenPrematurelyResolvedRecords(options = {}) {
    const dryRun = options?.dryRun === true;
    return withWriteLock(async () => {
      const journal = await store.load();
      const records = Array.isArray(journal?.records) ? journal.records : [];
      const reopened = [];
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record?.resolution?.resolved !== true) continue;
        const expirationYmd = toExpirationYmd(record?.expiration);
        const selectedExpirationYmd = toExpirationYmd(record?.selectedExpiration);
        if (!expirationYmd || !selectedExpirationYmd) continue;
        // Mismatch avec selectedExpiration future = résolution prématurée à corriger.
        if (selectedExpirationYmd <= expirationYmd) continue;
        reopened.push({
          id: record?.id ?? null,
          symbol: record?.symbol ?? null,
          expiration: record?.expiration ?? null,
          selectedExpiration: record?.selectedExpiration ?? null,
          wasAssigned: record?.resolution?.assigned === true,
          resolutionDate: record?.resolution?.resolutionDate ?? record?.resolution?.resolvedAt ?? null,
        });
        if (!dryRun) {
          records[i] = {
            ...record,
            resolution: {
              resolved: false,
              reopened: true,
              reopened_reason: "expiration_mismatch_selected_future",
              reopened_at: new Date().toISOString(),
              previous_resolution: record.resolution,
            },
          };
        }
      }
      if (!dryRun && reopened.length > 0) {
        journal.updatedAt = new Date().toISOString();
        await store.save(journal);
      }
      return { reopenedCount: reopened.length, dryRun, reopened };
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

  async function computeNormalizedDailyPopObservations(options = {}) {
    const journal = await store.load();
    const allRecords = Array.isArray(journal?.records) ? journal.records : [];

    const tickerFilter = options.ticker ? normalizeSymbol(options.ticker) : null;
    const modeRaw = String(options.mode ?? "all").trim().toLowerCase();
    const modeFilter = modeRaw === "safe" ? "safe" : modeRaw === "aggressive" ? "aggressive" : null;
    const limitValue = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.min(Math.max(1, Number(options.limit)), 50000)
      : 5000;

    function extractRecordPremium(record) {
      return (
        toNumberOrNull(record?.strike?.premium) ??
        toNumberOrNull(record?.strike?.mid) ??
        toNumberOrNull(record?.strike?.bid) ??
        null
      );
    }

    function buildGroupKey(record) {
      const t = normalizeSymbol(record?.symbol);
      const m = String(record?.strikeMode ?? "").trim().toLowerCase();
      const d = String(toNumberOrNull(record?.dteAtScan) ?? "na");
      const s = String(toNumberOrNull(record?.strike?.strike) ?? "na");
      const e = String(record?.expiration ?? "").trim();
      const sd = String(record?.scanDate ?? "").trim().slice(0, 10);
      return `${t}|${m}|${d}|${s}|${e}|${sd}`;
    }

    const groups = new Map();
    let rawRecordsUsed = 0;

    for (const record of allRecords) {
      const ticker = normalizeSymbol(record?.symbol);
      if (!ticker) continue;
      if (tickerFilter && ticker !== tickerFilter) continue;
      const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
      if (modeFilter && mode !== modeFilter) continue;

      const key = buildGroupKey(record);
      if (!groups.has(key)) {
        groups.set(key, {
          ticker,
          mode,
          dteAtScan: toNumberOrNull(record?.dteAtScan),
          strike: toNumberOrNull(record?.strike?.strike),
          expiration: String(record?.expiration ?? "").trim(),
          scanDate: String(record?.scanDate ?? "").trim().slice(0, 10),
          records: [],
        });
      }
      groups.get(key).records.push(record);
      rawRecordsUsed += 1;
    }

    const observations = [];
    let multiScanGroups = 0;
    let singleScanGroups = 0;
    const groupsWithMixedOutcomes = [];
    const groupsMissingPremiumList = [];
    const groupsMissingTimestampList = [];
    const topMultiScanGroups = [];

    for (const group of groups.values()) {
      const { ticker, mode, dteAtScan, strike, expiration, scanDate, records } = group;

      const sorted = [...records].sort((a, b) => {
        const ta = a.scanTimestamp ? new Date(a.scanTimestamp).getTime() : (a.scanDate ? new Date(a.scanDate).getTime() : 0);
        const tb = b.scanTimestamp ? new Date(b.scanTimestamp).getTime() : (b.scanDate ? new Date(b.scanDate).getTime() : 0);
        return ta - tb;
      });

      const rawScanCount = sorted.length;
      if (rawScanCount > 1) multiScanGroups += 1;
      else singleScanGroups += 1;

      const premiumValues = sorted.map(extractRecordPremium).filter((v) => v != null);
      if (premiumValues.length === 0) {
        groupsMissingPremiumList.push({ ticker, mode, scanDate, rawScanCount });
        continue;
      }

      const hasMissingTimestamp = sorted.some((r) => !r.scanTimestamp && !r.scanDate);
      if (hasMissingTimestamp) {
        groupsMissingTimestampList.push({ ticker, mode, scanDate });
      }

      const firstRecord = sorted[0];
      const lastRecord = sorted[rawScanCount - 1];

      const firstPremium = extractRecordPremium(firstRecord) ?? premiumValues[0];
      const medianPremium = median(premiumValues);
      const avgPremium = average(premiumValues);
      const minPremium = Math.min(...premiumValues);
      const maxPremium = Math.max(...premiumValues);

      const normalizedPremium = rawScanCount === 1
        ? roundMetric(firstPremium, 4)
        : roundMetric(0.70 * firstPremium + 0.30 * medianPremium, 4);

      const intradayPremiumRange = roundMetric(maxPremium - minPremium, 4);
      const intradayPremiumRangePct =
        medianPremium != null && medianPremium > 0
          ? roundMetric((intradayPremiumRange / medianPremium) * 100, 2)
          : null;

      const firstBid = toNumberOrNull(firstRecord?.strike?.bid);
      const firstAsk = toNumberOrNull(firstRecord?.strike?.ask);
      const firstMid = toNumberOrNull(firstRecord?.strike?.mid);
      const spreadPcts = sorted.map((r) => toNumberOrNull(r?.strike?.spreadPct)).filter((v) => v != null);
      const medianSpreadPct = roundMetric(median(spreadPcts), 4);

      const assignedFlags = sorted.map((r) => getAssignedFlag(r));
      const expiredOtmFlags = sorted.map((r) => getExpiredOtmFlag(r));
      const strikeTouchedFlags = sorted.map((r) => getStrikeTouchedFlag(r));
      const brokeLowerBoundFlags = sorted.map((r) => getBrokeLowerBoundFlag(r));

      const assignedFlag = assignedFlags.some((v) => v === true) ? true : assignedFlags.some((v) => v != null) ? false : null;
      const expiredOtmKnown = expiredOtmFlags.filter((v) => v != null);
      const expiredOtmTrueCount = expiredOtmKnown.filter((v) => v === true).length;
      const expiredOtm = expiredOtmKnown.length === 0 ? null : expiredOtmTrueCount >= Math.ceil(expiredOtmKnown.length / 2);
      const strikeTouched = strikeTouchedFlags.some((v) => v === true) ? true : strikeTouchedFlags.some((v) => v != null) ? false : null;
      const brokeLowerBound = brokeLowerBoundFlags.some((v) => v === true) ? true : brokeLowerBoundFlags.some((v) => v != null) ? false : null;

      let outcomeMergeNote;
      if (rawScanCount === 1) {
        outcomeMergeNote = "single_scan";
      } else {
        const assignedKnown = assignedFlags.filter((v) => v != null);
        const expiredKnown = expiredOtmFlags.filter((v) => v != null);
        const assignedConsistent = assignedKnown.length <= 1 || assignedKnown.every((v) => v === assignedKnown[0]);
        const expiredConsistent = expiredKnown.length <= 1 || expiredKnown.every((v) => v === expiredKnown[0]);
        outcomeMergeNote = assignedConsistent && expiredConsistent ? "multi_scan_consistent" : "multi_scan_mixed_outcome";
      }

      if (outcomeMergeNote === "multi_scan_mixed_outcome") {
        groupsWithMixedOutcomes.push({ ticker, mode, scanDate, rawScanCount });
      }
      if (rawScanCount > 1) {
        topMultiScanGroups.push({ ticker, mode, dteAtScan, strike, expiration, scanDate, rawScanCount });
      }

      observations.push({
        ticker,
        mode,
        dteAtScan,
        strike,
        expiration,
        scanDate,
        rawScanCount,
        firstScanTimestamp: firstRecord?.scanTimestamp ?? firstRecord?.scanDate ?? null,
        lastScanTimestamp: lastRecord?.scanTimestamp ?? lastRecord?.scanDate ?? null,
        firstPremium: roundMetric(firstPremium, 4),
        medianPremium: roundMetric(medianPremium, 4),
        avgPremium: roundMetric(avgPremium, 4),
        minPremium: roundMetric(minPremium, 4),
        maxPremium: roundMetric(maxPremium, 4),
        normalizedPremium,
        intradayPremiumRange,
        intradayPremiumRangePct,
        firstBid,
        firstAsk,
        firstMid,
        medianSpreadPct,
        assignedFlag,
        expiredOtm,
        strikeTouched,
        brokeLowerBound,
        outcomeMergeNote,
        sourceRecordIds: sorted.map((r) => String(r?.id ?? "")).filter(Boolean),
      });
    }

    observations.sort((a, b) => {
      if (b.rawScanCount !== a.rawScanCount) return b.rawScanCount - a.rawScanCount;
      if (b.scanDate !== a.scanDate) return b.scanDate.localeCompare(a.scanDate);
      return a.ticker.localeCompare(b.ticker);
    });

    const limitedObs = observations.slice(0, limitValue);
    topMultiScanGroups.sort((a, b) => b.rawScanCount - a.rawScanCount);
    const tickersSet = new Set(observations.map((o) => o.ticker));
    const avgScansPerObs = observations.length > 0 ? rawRecordsUsed / observations.length : null;
    const maxScansInOneGroup = observations.length > 0 ? Math.max(...observations.map((o) => o.rawScanCount)) : 0;

    return {
      ok: true,
      summary: {
        raw_records_used: rawRecordsUsed,
        normalized_observations: observations.length,
        compression_ratio: observations.length > 0 ? roundMetric(rawRecordsUsed / observations.length, 3) : null,
        multi_scan_groups: multiScanGroups,
        single_scan_groups: singleScanGroups,
        tickers_count: tickersSet.size,
        avg_scans_per_observation: avgScansPerObs != null ? roundMetric(avgScansPerObs, 2) : null,
        max_scans_in_one_group: maxScansInOneGroup,
        generatedAt: new Date().toISOString(),
      },
      observations: limitedObs,
      diagnostics: {
        groups_with_mixed_outcomes: groupsWithMixedOutcomes.length,
        groups_missing_premium: groupsMissingPremiumList.length,
        groups_missing_timestamp: groupsMissingTimestampList.length,
        top_multi_scan_groups: topMultiScanGroups.slice(0, 5),
      },
    };
  }

  async function computeSafeAggressiveComparison(options = {}) {
    const tickerFilter = options.ticker ? normalizeSymbol(options.ticker) : null;
    const dteFilter = toNumberOrNull(options.dte);
    const limitValue = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.min(Math.max(1, Number(options.limit)), 50000)
      : 5000;
    const minSample = Number.isFinite(Number(options.minSample)) && Number(options.minSample) > 0
      ? Math.max(1, Math.trunc(Number(options.minSample)))
      : 2;

    const normalizedResult = await computeNormalizedDailyPopObservations({
      ticker: tickerFilter ?? undefined,
      limit: limitValue,
    });
    let observations = Array.isArray(normalizedResult?.observations) ? normalizedResult.observations : [];
    if (dteFilter != null) {
      observations = observations.filter((obs) => toNumberOrNull(obs?.dteAtScan) === dteFilter);
    }

    function buildSampleQuality(sampleCount) {
      if (sampleCount === 0) return "absent";
      if (sampleCount < 5) return "faible";
      if (sampleCount < 15) return "moyen";
      return "bon";
    }

    function buildRatePct(rows, selector, useKnownDenominator = false) {
      const source = useKnownDenominator ? rows.filter((row) => selector(row) != null) : rows;
      if (source.length === 0) return null;
      const count = source.filter((row) => selector(row) === true).length;
      return roundMetric((count / source.length) * 100, 2);
    }

    function buildModeStats(rows) {
      const sampleCount = rows.length;
      if (sampleCount === 0) {
        return {
          sampleCount: 0,
          sampleQuality: "absent",
          avgPremium: null,
          medianPremium: null,
          minPremium: null,
          maxPremium: null,
          avgPremiumPerDay: null,
          medianPremiumPerDay: null,
          assignmentRatePct: null,
          otmRatePct: null,
          strikeTouchedRatePct: null,
          brokeLowerBoundRatePct: null,
          avgSpreadPct: null,
          medianSpreadPct: null,
          avgStrike: null,
          medianStrike: null,
        };
      }

      const premiums = rows.map((row) => toNumberOrNull(row?.normalizedPremium)).filter((v) => v != null);
      const premiumsPerDay = rows
        .map((row) => {
          const premium = toNumberOrNull(row?.normalizedPremium);
          const dte = toNumberOrNull(row?.dteAtScan);
          if (premium == null || dte == null) return null;
          return premium / Math.max(dte, 1);
        })
        .filter((v) => v != null);
      const spreadPcts = rows.map((row) => toNumberOrNull(row?.medianSpreadPct)).filter((v) => v != null);
      const strikes = rows.map((row) => toNumberOrNull(row?.strike)).filter((v) => v != null);

      return {
        sampleCount,
        sampleQuality: buildSampleQuality(sampleCount),
        avgPremium: roundMetric(average(premiums), 4),
        medianPremium: roundMetric(median(premiums), 4),
        minPremium: premiums.length > 0 ? roundMetric(Math.min(...premiums), 4) : null,
        maxPremium: premiums.length > 0 ? roundMetric(Math.max(...premiums), 4) : null,
        avgPremiumPerDay: roundMetric(average(premiumsPerDay), 4),
        medianPremiumPerDay: roundMetric(median(premiumsPerDay), 4),
        assignmentRatePct: buildRatePct(rows, (row) => row?.assignedFlag),
        otmRatePct: buildRatePct(rows, (row) => row?.expiredOtm),
        strikeTouchedRatePct: buildRatePct(rows, (row) => row?.strikeTouched, true),
        brokeLowerBoundRatePct: buildRatePct(rows, (row) => row?.brokeLowerBound, true),
        avgSpreadPct: roundMetric(average(spreadPcts), 2),
        medianSpreadPct: roundMetric(median(spreadPcts), 2),
        avgStrike: roundMetric(average(strikes), 2),
        medianStrike: roundMetric(median(strikes), 2),
      };
    }

    function buildPublicModeStats(stats) {
      return {
        sampleCount: stats.sampleCount,
        sampleQuality: stats.sampleQuality,
        avgPremium: stats.avgPremium,
        medianPremium: stats.medianPremium,
        avgPremiumPerDay: stats.avgPremiumPerDay,
        medianPremiumPerDay: stats.medianPremiumPerDay,
        assignmentRatePct: stats.assignmentRatePct,
        otmRatePct: stats.otmRatePct,
        strikeTouchedRatePct: stats.strikeTouchedRatePct,
        brokeLowerBoundRatePct: stats.brokeLowerBoundRatePct,
        medianSpreadPct: stats.medianSpreadPct,
        medianStrike: stats.medianStrike,
      };
    }

    function computeComparisonScore({
      recommendedMode,
      premiumLiftPct,
      assignmentDeltaPct,
      lowerBoundDeltaPct,
      aggressiveSpread,
      safeCount,
      aggressiveCount,
    }) {
      let score = 50;
      const minCount = Math.min(safeCount, aggressiveCount);
      if (safeCount < minSample || aggressiveCount < minSample) {
        return Math.min(55, score);
      }

      if (premiumLiftPct != null) {
        if (recommendedMode === "AGRESSIF") {
          score += Math.min(30, Math.max(0, premiumLiftPct) * 0.35);
        } else if (recommendedMode === "SAFE") {
          score += Math.min(25, Math.max(0, 15 - premiumLiftPct) * 1.5);
        }
      }

      if (assignmentDeltaPct != null) {
        score -= Math.max(0, assignmentDeltaPct - 5) * 1.5;
      }
      if (lowerBoundDeltaPct != null) {
        score -= Math.max(0, lowerBoundDeltaPct - 8) * 1.2;
      }
      if (aggressiveSpread != null && aggressiveSpread > 20) {
        score -= (aggressiveSpread - 20) * 0.5;
      }

      if (minCount < 5) score = Math.min(score, 55);
      else if (minCount < 15) score = Math.min(score, 75);

      return Math.round(Math.max(0, Math.min(100, score)));
    }

    const SAMPLE_CONFIRMED_MIN = 5;

    function isSafeAggRecommendationConfirmed(safeCount, aggressiveCount) {
      return Math.min(safeCount, aggressiveCount) >= SAMPLE_CONFIRMED_MIN;
    }

    function buildDecision({
      safeStats,
      aggressiveStats,
      premiumLiftPct,
      assignmentDeltaPct,
      lowerBoundDeltaPct,
      spreadDeltaPct,
      comparisonStatus,
    }) {
      const reasons = [];
      const safeCount = safeStats.sampleCount;
      const aggressiveCount = aggressiveStats.sampleCount;
      const aggSpread = aggressiveStats.medianSpreadPct;
      const minModeCount = Math.min(safeCount, aggressiveCount);

      if (comparisonStatus === "safe_only" || comparisonStatus === "aggressive_only") {
        if (comparisonStatus === "safe_only") reasons.push("Seulement des observations SAFE");
        else reasons.push("Seulement des observations AGRESSIF");
        return {
          recommendedMode: "À confirmer",
          modeDecision: "À confirmer",
          decisionConfidence: "faible",
          comparisonScore: Math.min(55, 40),
          reasons: reasons.slice(0, 3),
          recommendationConfirmed: false,
        };
      }

      if (safeCount < minSample || aggressiveCount < minSample) {
        reasons.push("Échantillon faible");
        return {
          recommendedMode: "À confirmer",
          modeDecision: "À confirmer",
          decisionConfidence: "faible",
          comparisonScore: Math.min(55, 45),
          reasons: reasons.slice(0, 3),
          recommendationConfirmed: false,
        };
      }

      if (minModeCount < SAMPLE_CONFIRMED_MIN) {
        reasons.push("Échantillon faible");
        if (premiumLiftPct != null) {
          reasons.push(`Écart prime ${premiumLiftPct >= 0 ? "+" : ""}${premiumLiftPct.toFixed(1)} %`);
        }
        if (assignmentDeltaPct != null) {
          reasons.push(`Écart assignation ${assignmentDeltaPct >= 0 ? "+" : ""}${assignmentDeltaPct.toFixed(1)} %`);
        }
        if (spreadDeltaPct != null) {
          reasons.push(`Écart spread ${spreadDeltaPct >= 0 ? "+" : ""}${spreadDeltaPct.toFixed(1)} %`);
        }
        const comparisonScore = Math.min(
          55,
          computeComparisonScore({
            recommendedMode: "À confirmer",
            premiumLiftPct,
            assignmentDeltaPct,
            lowerBoundDeltaPct,
            aggressiveSpread: aggSpread,
            safeCount,
            aggressiveCount,
          }),
        );
        return {
          recommendedMode: "À confirmer",
          modeDecision: "Mode non confirmé — échantillon faible",
          decisionConfidence: "faible",
          comparisonScore,
          reasons: reasons.slice(0, 3),
          recommendationConfirmed: false,
        };
      }

      const safePreferred =
        (premiumLiftPct != null && premiumLiftPct < 15) ||
        (assignmentDeltaPct != null && assignmentDeltaPct > 12) ||
        (lowerBoundDeltaPct != null && lowerBoundDeltaPct > 20) ||
        (aggSpread != null && aggSpread > 35);

      const aggressivePreferred =
        premiumLiftPct != null &&
        premiumLiftPct >= 25 &&
        (assignmentDeltaPct == null || assignmentDeltaPct <= 8) &&
        (lowerBoundDeltaPct == null || lowerBoundDeltaPct <= 15) &&
        (aggSpread == null || aggSpread <= 20);

      let recommendedMode = "À confirmer";
      let modeDecision = "À confirmer";

      if (safePreferred) {
        recommendedMode = "SAFE";
        if (premiumLiftPct != null && premiumLiftPct < 15) {
          modeDecision = "SAFE préféré : prime agressive insuffisamment supérieure";
          reasons.push("SAFE préféré : prime similaire");
        } else if (assignmentDeltaPct != null && assignmentDeltaPct > 12) {
          modeDecision = "AGRESSIF trop stressé";
          reasons.push(`Assignation +${assignmentDeltaPct.toFixed(1)} %`);
        } else if (lowerBoundDeltaPct != null && lowerBoundDeltaPct > 20) {
          modeDecision = "AGRESSIF trop stressé";
          reasons.push("Borne basse plus souvent cassée");
        } else if (aggSpread != null && aggSpread > 35) {
          modeDecision = "AGRESSIF paie plus mais exécution trop faible";
          reasons.push("Spread agressif trop large");
        }
      } else if (aggressivePreferred) {
        recommendedMode = "AGRESSIF";
        if (premiumLiftPct != null && premiumLiftPct >= 25) {
          reasons.push(`AGRESSIF +${premiumLiftPct.toFixed(0)} % de prime`);
        }
        if (assignmentDeltaPct != null && assignmentDeltaPct <= 8) {
          reasons.push(`Assignation +${assignmentDeltaPct.toFixed(1)} % seulement`);
        }
        if (aggSpread == null || aggSpread <= 20) {
          reasons.push("Spread agressif acceptable");
        }
        if (
          premiumLiftPct != null &&
          premiumLiftPct >= 25 &&
          assignmentDeltaPct != null &&
          assignmentDeltaPct > 0 &&
          assignmentDeltaPct <= 8
        ) {
          modeDecision = "AGRESSIF paie beaucoup plus, risque encore acceptable";
        } else {
          modeDecision = "AGRESSIF recommandé";
        }
      } else {
        if (premiumLiftPct != null) {
          reasons.push(`Écart prime ${premiumLiftPct >= 0 ? "+" : ""}${premiumLiftPct.toFixed(1)} %`);
        }
        if (assignmentDeltaPct != null) {
          reasons.push(`Écart assignation ${assignmentDeltaPct >= 0 ? "+" : ""}${assignmentDeltaPct.toFixed(1)} %`);
        }
        if (spreadDeltaPct != null) {
          reasons.push(`Écart spread ${spreadDeltaPct >= 0 ? "+" : ""}${spreadDeltaPct.toFixed(1)} %`);
        }
      }

      const comparisonScore = computeComparisonScore({
        recommendedMode,
        premiumLiftPct,
        assignmentDeltaPct,
        lowerBoundDeltaPct,
        aggressiveSpread: aggSpread,
        safeCount,
        aggressiveCount,
      });

      const decisionConfidence =
        comparisonScore >= 75 ? "élevée" : comparisonScore >= 55 ? "moyenne" : "faible";

      const recommendationConfirmed =
        isSafeAggRecommendationConfirmed(safeCount, aggressiveCount) &&
        (recommendedMode === "AGRESSIF" || recommendedMode === "SAFE");

      return {
        recommendedMode,
        modeDecision,
        decisionConfidence,
        comparisonScore,
        reasons: reasons.slice(0, 3),
        recommendationConfirmed,
      };
    }

    const groupMap = new Map();
    for (const obs of observations) {
      const ticker = normalizeSymbol(obs?.ticker);
      const dteAtScan = toNumberOrNull(obs?.dteAtScan);
      const mode = String(obs?.mode ?? "").trim().toLowerCase();
      if (!ticker || dteAtScan == null) continue;
      if (mode !== "safe" && mode !== "aggressive") continue;

      const key = `${ticker}|${dteAtScan}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, { ticker, dteAtScan, safe: [], aggressive: [] });
      }
      groupMap.get(key)[mode === "safe" ? "safe" : "aggressive"].push(obs);
    }

    const allComparisons = [];
    for (const group of groupMap.values()) {
      const safeStats = buildModeStats(group.safe);
      const aggressiveStats = buildModeStats(group.aggressive);

      let comparisonStatus = "comparable";
      if (safeStats.sampleCount === 0 && aggressiveStats.sampleCount > 0) {
        comparisonStatus = "aggressive_only";
      } else if (aggressiveStats.sampleCount === 0 && safeStats.sampleCount > 0) {
        comparisonStatus = "safe_only";
      }

      const premiumLiftAbs =
        safeStats.avgPremium != null && aggressiveStats.avgPremium != null
          ? roundMetric(aggressiveStats.avgPremium - safeStats.avgPremium, 4)
          : null;
      const premiumLiftPct =
        safeStats.avgPremium != null &&
        aggressiveStats.avgPremium != null &&
        safeStats.avgPremium !== 0
          ? roundMetric(((aggressiveStats.avgPremium - safeStats.avgPremium) / safeStats.avgPremium) * 100, 2)
          : null;
      const assignmentDeltaPct =
        safeStats.assignmentRatePct != null && aggressiveStats.assignmentRatePct != null
          ? roundMetric(aggressiveStats.assignmentRatePct - safeStats.assignmentRatePct, 2)
          : null;
      const strikeTouchedDeltaPct =
        safeStats.strikeTouchedRatePct != null && aggressiveStats.strikeTouchedRatePct != null
          ? roundMetric(aggressiveStats.strikeTouchedRatePct - safeStats.strikeTouchedRatePct, 2)
          : null;
      const lowerBoundDeltaPct =
        safeStats.brokeLowerBoundRatePct != null && aggressiveStats.brokeLowerBoundRatePct != null
          ? roundMetric(aggressiveStats.brokeLowerBoundRatePct - safeStats.brokeLowerBoundRatePct, 2)
          : null;
      const spreadDeltaPct =
        safeStats.medianSpreadPct != null && aggressiveStats.medianSpreadPct != null
          ? roundMetric(aggressiveStats.medianSpreadPct - safeStats.medianSpreadPct, 2)
          : null;

      const decision = buildDecision({
        safeStats,
        aggressiveStats,
        premiumLiftPct,
        assignmentDeltaPct,
        lowerBoundDeltaPct,
        spreadDeltaPct,
        comparisonStatus,
      });

      allComparisons.push({
        ticker: group.ticker,
        dteAtScan: group.dteAtScan,
        safe: buildPublicModeStats(safeStats),
        aggressive: buildPublicModeStats(aggressiveStats),
        premiumLiftAbs,
        premiumLiftPct,
        assignmentDeltaPct,
        strikeTouchedDeltaPct,
        lowerBoundDeltaPct,
        spreadDeltaPct,
        comparisonStatus,
        recommendedMode: decision.recommendedMode,
        comparisonScore: decision.comparisonScore,
        decisionConfidence: decision.decisionConfidence,
        modeDecision: decision.modeDecision,
        reasons: decision.reasons,
        recommendationConfirmed: decision.recommendationConfirmed === true,
      });
    }

    allComparisons.sort((a, b) => {
      if (b.comparisonScore !== a.comparisonScore) return b.comparisonScore - a.comparisonScore;
      const liftA = a.premiumLiftPct ?? -Infinity;
      const liftB = b.premiumLiftPct ?? -Infinity;
      if (liftB !== liftA) return liftB - liftA;
      if (a.ticker !== b.ticker) return a.ticker.localeCompare(b.ticker);
      return (a.dteAtScan ?? 0) - (b.dteAtScan ?? 0);
    });

    const comparisons = allComparisons.slice(0, limitValue);
    const tickersSet = new Set(allComparisons.map((item) => item.ticker));
    const dteSet = new Set(allComparisons.map((item) => item.dteAtScan));
    const comparableGroups = allComparisons.filter((item) => item.comparisonStatus === "comparable").length;
    const safeOnlyGroups = allComparisons.filter((item) => item.comparisonStatus === "safe_only").length;
    const aggressiveOnlyGroups = allComparisons.filter((item) => item.comparisonStatus === "aggressive_only").length;
    const aggressiveRecommended = allComparisons.filter((item) => item.recommendedMode === "AGRESSIF").length;
    const safeRecommended = allComparisons.filter((item) => item.recommendedMode === "SAFE").length;
    const aggressiveRecommendedConfirmed = allComparisons.filter(
      (item) => item.recommendedMode === "AGRESSIF" && item.recommendationConfirmed === true,
    ).length;
    const safeRecommendedConfirmed = allComparisons.filter(
      (item) => item.recommendedMode === "SAFE" && item.recommendationConfirmed === true,
    ).length;

    return {
      ok: true,
      summary: {
        comparisons_total: allComparisons.length,
        tickers_count: tickersSet.size,
        dte_count: dteSet.size,
        observations_used: observations.length,
        comparable_groups: comparableGroups,
        safe_only_groups: safeOnlyGroups,
        aggressive_only_groups: aggressiveOnlyGroups,
        aggressive_recommended: aggressiveRecommended,
        safe_recommended: safeRecommended,
        aggressive_recommended_confirmed: aggressiveRecommendedConfirmed,
        safe_recommended_confirmed: safeRecommendedConfirmed,
        sample_confirmed_min: SAMPLE_CONFIRMED_MIN,
        generatedAt: new Date().toISOString(),
      },
      comparisons,
      diagnostics: {
        min_sample_used: minSample,
        observations_source: normalizedResult?.summary ?? null,
        confirm_count: allComparisons.filter((item) => item.recommendedMode === "À confirmer").length,
        aggressive_recommended_confirmed: aggressiveRecommendedConfirmed,
        safe_recommended_confirmed: safeRecommendedConfirmed,
        weak_sample_groups: allComparisons.filter(
          (item) =>
            item.comparisonStatus === "comparable" &&
            (item.safe?.sampleQuality === "faible" || item.aggressive?.sampleQuality === "faible")
        ).length,
      },
    };
  }

  async function computeOnePercentWheelProfilesFromJournal(options = {}) {
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const theoreticalCycles = Array.isArray(options?.theoreticalCycles) ? options.theoreticalCycles : [];
    return computeOnePercentWheelProfiles(records, theoreticalCycles, options);
  }

  async function computeDynamicTop20WheelProfilesFromJournal(options = {}) {
    const theoreticalCycles = Array.isArray(options?.theoreticalCycles) ? options.theoreticalCycles : [];
    const journal = await store.load();
    const records = Array.isArray(journal?.records) ? journal.records : [];
    const onePercentResult = await computeOnePercentWheelProfilesFromJournal({
      ...options,
      theoreticalCycles,
    });
    const profiles = onePercentResult.profiles ?? [];
    const buildView = (dteFilter) =>
      computeDynamicTop20WheelProfiles(profiles, {
        ...options,
        records,
        cycles: theoreticalCycles,
        dteFilter,
      });

    // J6-A — vues par DTE recalculées sur le sous-ensemble d'observations (7/4/3),
    // en plus du Top réaliste global (tous DTE). Le résultat de premier niveau RESTE
    // la vue « tous DTE » (rétrocompat) ; `dynamicTop20DteViews` porte les vues par DTE.
    const dteViews = { all: buildView(null) };
    for (const dte of DYNAMIC_TOP20_DTE_VIEW_TARGETS) {
      dteViews[`dte${dte}`] = buildView(dte);
    }

    return { ...dteViews.all, dynamicTop20DteViews: dteViews };
  }

  async function computeV3CandidateProfiles(options = {}) {
    const journal = await store.load();
    const allRecords = Array.isArray(journal?.records) ? journal.records : [];

    const scope = normalizeV3ProfileScope(options?.scope);
    const tickerFilter = options.ticker ? normalizeSymbol(options.ticker) : null;
    const modeRaw = String(options?.mode ?? "all").trim().toLowerCase();
    const modeFilter = modeRaw === "safe" || modeRaw === "aggressive" ? modeRaw : null;
    const limitValue = Math.min(Math.max(toNumberOrNull(options?.limit) ?? 50, 1), 500);
    const minExpirations = Math.max(toNumberOrNull(options?.minExpirations) ?? 0, 0);
    const includeWeak = options?.includeWeak !== false && String(options?.includeWeak ?? "true").toLowerCase() !== "false";

    const resolvedRecords = allRecords.filter((record) => {
      if (!getResolvedFlag(record)) return false;
      const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
      if (!ticker) return false;
      if (tickerFilter && ticker !== tickerFilter) return false;
      const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
      if (mode !== "safe" && mode !== "aggressive") return false;
      if (modeFilter && mode !== modeFilter) return false;
      return true;
    });

    const profileMap = new Map();
    for (const record of resolvedRecords) {
      const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
      const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
      const dteBucket = getDteBucketLabel(record?.dteAtScan);
      const profileKey = buildV3ProfileGroupKey(record, scope);
      if (!profileMap.has(profileKey)) {
        profileMap.set(profileKey, {
          ticker,
          mode: scope === "ticker" ? "GLOBAL" : mode,
          dteBucket: scope === "ticker_mode_dte" ? dteBucket : "ALL",
          dteValues: [],
          records: [],
        });
      }
      const profile = profileMap.get(profileKey);
      profile.records.push(record);
      const dte = toNumberOrNull(record?.dteAtScan);
      if (dte != null) profile.dteValues.push(dte);
    }

    function buildV3SampleQuality(uniqueExpirationCount, recordsResolvedCount, historyDays) {
      if (
        uniqueExpirationCount < 3 ||
        recordsResolvedCount < 8 ||
        (historyDays != null && historyDays < 14)
      ) {
        return "weak";
      }
      if (
        uniqueExpirationCount >= 10 &&
        recordsResolvedCount >= 25 &&
        historyDays != null &&
        historyDays >= 60
      ) {
        return "strong";
      }
      if (
        uniqueExpirationCount >= 6 &&
        recordsResolvedCount >= 15 &&
        historyDays != null &&
        historyDays >= 30
      ) {
        return "medium";
      }
      if (
        uniqueExpirationCount >= 3 &&
        recordsResolvedCount >= 8 &&
        historyDays != null &&
        historyDays >= 14
      ) {
        return "preliminary";
      }
      return "weak";
    }

    function buildConfidenceLabel(sampleQuality) {
      if (sampleQuality === "strong") return "forte";
      if (sampleQuality === "medium") return "moyenne";
      if (sampleQuality === "preliminary") return "préliminaire";
      return "faible";
    }

    function buildAssignmentRarityLabel(uniqueExpirationCount, assignmentRatePct) {
      if (uniqueExpirationCount < 6) return "insufficient";
      if (assignmentRatePct == null) return "insufficient";
      if (assignmentRatePct <= 10) return "rare";
      if (assignmentRatePct <= 30) return "normale";
      return "fréquente";
    }

    function buildPrimeStrengthLabel(latestYieldPct, medianYieldPct) {
      if (latestYieldPct == null) return "inconnue";
      if (medianYieldPct != null && medianYieldPct > 0) {
        if (latestYieldPct >= medianYieldPct * 1.15) return "forte";
        if (latestYieldPct < medianYieldPct) return "faible";
        return "normale";
      }
      if (latestYieldPct >= 0.75) return "forte";
      if (latestYieldPct >= 0.5) return "normale";
      return "faible";
    }

    function buildV3Verdict({
      sampleQuality,
      primeStrengthLabel,
      assignmentRarityLabel,
      uniqueExpirationCount,
      assignedCount,
      historyDays,
    }) {
      if (sampleQuality === "weak" || uniqueExpirationCount < 3) {
        return "Données insuffisantes — historique trop court";
      }
      if (sampleQuality === "preliminary" && historyDays != null && historyDays < 21) {
        return "Historique trop court — ne pas surinterpréter";
      }

      const primePart =
        primeStrengthLabel === "forte"
          ? "Prime forte"
          : primeStrengthLabel === "faible"
          ? "Prime faible"
          : primeStrengthLabel === "inconnue"
          ? "Prime inconnue"
          : "Prime correcte";

      let assignPart;
      if (assignmentRarityLabel === "insufficient") {
        assignPart = `assignation à confirmer (${assignedCount}/${uniqueExpirationCount} exp.)`;
      } else if (assignmentRarityLabel === "rare") {
        assignPart = `assignation rare (${assignedCount}/${uniqueExpirationCount} exp.)`;
      } else if (assignmentRarityLabel === "fréquente") {
        assignPart = `assignations fréquentes (${assignedCount}/${uniqueExpirationCount} exp.)`;
      } else {
        assignPart = `assignation normale (${assignedCount}/${uniqueExpirationCount} exp.)`;
      }

      if (primeStrengthLabel === "forte" && assignmentRarityLabel === "fréquente") {
        return "Prime forte mais assignations fréquentes";
      }
      if (sampleQuality === "preliminary") {
        return `${primePart}, ${assignPart} — échantillon préliminaire`;
      }
      if (sampleQuality === "weak") {
        return `${primePart}, ${assignPart} — échantillon faible`;
      }
      return `${primePart}, ${assignPart}`;
    }

    function buildProfileWarnings(ctx) {
      const warnings = [];
      if (ctx.scope === "ticker") {
        warnings.push("Profil ticker global — modes et DTE mélangés");
        warnings.push("Données ticker globales, pas strike exact");
      } else if (ctx.scope === "ticker_mode") {
        warnings.push("Profil ticker/mode global — DTE mélangés");
        warnings.push("Données ticker/mode, pas strike exact");
      } else {
        warnings.push("Données ticker/mode, pas strike exact");
      }
      if (ctx.historyDays != null && ctx.historyDays < 21) warnings.push("Historique court");
      if (ctx.uniqueExpirationCount < 6) warnings.push("Moins de 6 expirations uniques");
      if (ctx.multiStrikeCohorts > 0) warnings.push("Plusieurs strikes dans une même cohorte");
      if (ctx.scope === "ticker_mode_dte" && ctx.hasMultiBucketExpiration) {
        warnings.push("Même expiration observée dans plusieurs buckets DTE");
      }
      if (ctx.mixedOutcomeCohorts > 0) warnings.push("Résultats mixtes sur même expiration");
      if (ctx.latestPremium == null) warnings.push("Prime actuelle absente");
      if (ctx.strikeTouchedRatePct != null && ctx.strikeTouchedRatePct >= 30) {
        warnings.push("Touch strike élevé");
      }
      if (ctx.lowerBoundBrokenCount > 0) warnings.push("LowerBound cassé détecté");
      if (ctx.sampleQuality === "weak") warnings.push("Échantillon faible — ne pas surinterpréter");
      return [...new Set(warnings)];
    }

    let historyStartGlobal = null;
    let historyEndGlobal = null;
    for (const record of resolvedRecords) {
      const scanDay = formatYmdForDisplay(record?.scanDate) ?? String(record?.scanDate ?? "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDay)) continue;
      if (!historyStartGlobal || scanDay < historyStartGlobal) historyStartGlobal = scanDay;
      if (!historyEndGlobal || scanDay > historyEndGlobal) historyEndGlobal = scanDay;
    }
    const historyDaysGlobal = computeHistoryDaysBetween(historyStartGlobal, historyEndGlobal);

    // V3 — detect expirations scanned at different DTE values (span multiple buckets).
    const multiBucketExpirationKeys = new Set();
    if (scope === "ticker_mode_dte") {
      const expirationBucketMap = new Map();
      for (const record of resolvedRecords) {
        const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
        const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
        const expiration = record?.expiration ?? record?.expirationCohort ?? "";
        const expKey = buildV3ExpirationCohortKey(ticker, mode, expiration);
        const dteBucket = getDteBucketLabel(record?.dteAtScan);
        if (!expirationBucketMap.has(expKey)) expirationBucketMap.set(expKey, new Set());
        expirationBucketMap.get(expKey).add(dteBucket);
      }
      for (const [key, buckets] of expirationBucketMap.entries()) {
        if (buckets.size > 1) multiBucketExpirationKeys.add(key);
      }
    }

    const allProfiles = [];

    for (const group of profileMap.values()) {
      const recordsResolvedCount = group.records.length;
      const cohortMap = new Map();

      for (const record of group.records) {
        const expiration = record?.expiration ?? record?.expirationCohort ?? "";
        const recordMode = String(record?.strikeMode ?? "").trim().toLowerCase();
        const cohortKey = buildV3CohortKeyForScope(group.ticker, recordMode, expiration, scope);
        if (!cohortMap.has(cohortKey)) {
          cohortMap.set(cohortKey, {
            expiration,
            records: [],
            strikes: new Set(),
          });
        }
        const cohort = cohortMap.get(cohortKey);
        cohort.records.push(record);
        const strike = toNumberOrNull(record?.strike?.strike);
        if (strike != null) cohort.strikes.add(strike);
      }

      let assignedCount = 0;
      let expiredWorthlessCount = 0;
      let strikeTouchedCount = 0;
      let lowerBoundBrokenCount = 0;
      let multiStrikeCohorts = 0;
      let mixedOutcomeCohorts = 0;
      let hasMultiBucketExpiration = false;

      const cohortYields = [];
      const cohortPremiums = [];
      let historyStartDate = null;
      let historyEndDate = null;

      for (const cohort of cohortMap.values()) {
        const cohortKey =
          scope === "ticker_mode_dte"
            ? buildV3ExpirationCohortKey(
                group.ticker,
                String(group.mode ?? "").trim().toLowerCase(),
                cohort.expiration
              )
            : null;
        if (cohortKey && multiBucketExpirationKeys.has(cohortKey)) hasMultiBucketExpiration = true;

        const assignedFlags = cohort.records.map((r) => getAssignedFlag(r));
        const expiredFlags = cohort.records.map((r) => getExpiredOtmFlag(r));
        const touchedFlags = cohort.records.map((r) => getStrikeTouchedFlag(r));
        const lbFlags = cohort.records.map((r) => getBrokeLowerBoundFlag(r));

        const assignedKnown = assignedFlags.filter((v) => v != null);
        const assignedMixed =
          assignedKnown.length > 1 && !assignedKnown.every((v) => v === assignedKnown[0]);
        const cohortAssigned = assignedFlags.some((v) => v === true);
        const cohortExpiredWorthless =
          !cohortAssigned &&
          (expiredFlags.some((v) => v === true) || assignedKnown.some((v) => v === false));
        const cohortTouched = touchedFlags.some((v) => v === true);
        const cohortLbBroken = lbFlags.some((v) => v === true);

        if (assignedMixed) mixedOutcomeCohorts += 1;
        if (cohort.strikes.size > 1) multiStrikeCohorts += 1;

        if (cohortAssigned) assignedCount += 1;
        if (cohortExpiredWorthless) expiredWorthlessCount += 1;
        if (cohortTouched) strikeTouchedCount += 1;
        if (cohortLbBroken) lowerBoundBrokenCount += 1;

        const latestCohortRecord = [...cohort.records].sort(
          (a, b) => getLatestTimestamp(b) - getLatestTimestamp(a)
        )[0];
        const yieldPct = getRecordYieldPct(latestCohortRecord);
        const premium = getPremiumCandidate(latestCohortRecord);
        if (yieldPct != null) cohortYields.push(yieldPct);
        if (premium != null) cohortPremiums.push(premium);

        for (const record of cohort.records) {
          const scanDay =
            formatYmdForDisplay(record?.scanDate) ?? String(record?.scanDate ?? "").trim().slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(scanDay)) continue;
          if (!historyStartDate || scanDay < historyStartDate) historyStartDate = scanDay;
          if (!historyEndDate || scanDay > historyEndDate) historyEndDate = scanDay;
        }
      }

      const uniqueExpirationCount = cohortMap.size;
      if (uniqueExpirationCount < minExpirations) continue;

      const historyDays = computeHistoryDaysBetween(historyStartDate, historyEndDate);
      const sampleQuality = buildV3SampleQuality(uniqueExpirationCount, recordsResolvedCount, historyDays);
      if (!includeWeak && sampleQuality === "weak") continue;

      const assignmentRatePct =
        uniqueExpirationCount > 0 ? roundMetric((assignedCount / uniqueExpirationCount) * 100, 2) : null;
      const expiredWorthlessRatePct =
        uniqueExpirationCount > 0
          ? roundMetric((expiredWorthlessCount / uniqueExpirationCount) * 100, 2)
          : null;
      const strikeTouchedRatePct =
        uniqueExpirationCount > 0
          ? roundMetric((strikeTouchedCount / uniqueExpirationCount) * 100, 2)
          : null;
      const lowerBoundBrokenRatePct =
        uniqueExpirationCount > 0
          ? roundMetric((lowerBoundBrokenCount / uniqueExpirationCount) * 100, 2)
          : null;

      const allYields = group.records.map((r) => getRecordYieldPct(r)).filter((v) => v != null);
      const allPremiums = group.records.map((r) => getPremiumCandidate(r)).filter((v) => v != null);
      const avgYieldPct = roundMetric(average(allYields), 2);
      const medianYieldPct = roundMetric(median(allYields), 2);
      const avgPremium = roundMetric(average(allPremiums), 4);
      const medianPremium = roundMetric(median(allPremiums), 4);

      const latestRecord = [...group.records].sort((a, b) => getLatestTimestamp(b) - getLatestTimestamp(a))[0];
      const latestPremium = roundMetric(getPremiumCandidate(latestRecord), 4);
      const latestYieldPct = roundMetric(getRecordYieldPct(latestRecord), 2);
      const premiumVsMedianPct =
        latestPremium != null && medianPremium != null && medianPremium !== 0
          ? roundMetric(((latestPremium - medianPremium) / medianPremium) * 100, 2)
          : null;

      const confidenceLabel = buildConfidenceLabel(sampleQuality);
      const primeStrengthLabel = buildPrimeStrengthLabel(latestYieldPct, medianYieldPct);
      const assignmentRarityLabel = buildAssignmentRarityLabel(uniqueExpirationCount, assignmentRatePct);
      const v3Verdict = buildV3Verdict({
        sampleQuality,
        primeStrengthLabel,
        assignmentRarityLabel,
        uniqueExpirationCount,
        assignedCount,
        historyDays,
      });
      const warnings = buildProfileWarnings({
        scope,
        historyDays,
        uniqueExpirationCount,
        multiStrikeCohorts,
        mixedOutcomeCohorts,
        hasMultiBucketExpiration,
        latestPremium,
        strikeTouchedRatePct,
        lowerBoundBrokenCount,
        sampleQuality,
      });

      const avgDte =
        group.dteValues.length > 0
          ? roundMetric(average(group.dteValues), 1)
          : null;

      const displayMode =
        scope === "ticker"
          ? "GLOBAL"
          : group.mode === "GLOBAL"
          ? "GLOBAL"
          : group.mode.toUpperCase();

      allProfiles.push({
        ticker: group.ticker,
        mode: displayMode,
        dteBucket: group.dteBucket,
        avgDte,
        recordsResolvedCount,
        uniqueExpirationCount,
        assignedCount,
        expiredWorthlessCount,
        assignmentRatePct,
        expiredWorthlessRatePct,
        strikeTouchedCount,
        strikeTouchedRatePct,
        lowerBoundBrokenCount,
        lowerBoundBrokenRatePct,
        historyStartDate,
        historyEndDate,
        historyDays,
        avgPremium,
        medianPremium,
        avgYieldPct,
        medianYieldPct,
        latestPremium,
        latestYieldPct,
        premiumVsMedianPct,
        sampleQuality,
        confidenceLabel,
        primeStrengthLabel,
        assignmentRarityLabel,
        v3Verdict,
        warnings,
      });
    }

    const sortedProfiles = sortV3Profiles(allProfiles);
    const profiles = sortedProfiles.slice(0, limitValue);
    const uniqueExpirationsUsed = new Set(
      resolvedRecords.map((record) => {
        const ticker = normalizeSymbol(record?.symbol ?? record?.ticker);
        const mode = String(record?.strikeMode ?? "").trim().toLowerCase();
        const expiration = record?.expiration ?? record?.expirationCohort ?? "";
        return buildV3CohortKeyForScope(ticker, mode, expiration, scope);
      })
    ).size;

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      scope,
      warning: "Read-only preliminary V3 metrics. Not a final trade recommendation.",
      meta: {
        totalProfiles: allProfiles.length,
        profilesReturned: profiles.length,
        scope,
        historyStartDate: historyStartGlobal,
        historyEndDate: historyEndGlobal,
        historyDays: historyDaysGlobal,
        resolvedRecordsUsed: resolvedRecords.length,
        uniqueExpirationsUsed,
        sort: "sampleQuality,primeStrength,assignmentRate,expirations,yield,ticker",
        filters: {
          scope,
          limit: limitValue,
          ticker: tickerFilter || null,
          mode: modeFilter ? modeFilter.toUpperCase() : "ALL",
          minExpirations,
          includeWeak,
        },
      },
      profiles,
    };
  }

  return {
    buildRecordsFromCandidates,
    listJournal,
    getLatestOptionSnapshots,
    computeStats,
    computeCohortSummary,
    computeCalibrationSummary,
    computeRealPopCalibration: computeRealPopCalibrationFromJournal,
    computeModeComparison,
    computePremiumStability,
    computeTickerRanking,
    computeNormalizedDailyPopObservations,
    computeSafeAggressiveComparison,
    computeV3CandidateProfiles,
    computeOnePercentWheelProfiles: computeOnePercentWheelProfilesFromJournal,
    computeDynamicTop20WheelProfiles: computeDynamicTop20WheelProfilesFromJournal,
    captureFromCandidates,
    patchResolution,
    resolveExpiredRecords,
    reopenPrematurelyResolvedRecords,
    store,
  };
}

// Exports réservés aux tests (patch J2-B) — exposent les fonctions internes de
// capture/éligibilité sans modifier l'API publique du service.
export const __testables__ = {
  normalizeRecord,
  isOnePercentProfileRecord,
  selectBalancedRealisticDecision,
};
