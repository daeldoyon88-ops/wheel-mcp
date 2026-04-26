import { createPopCalibrationStore } from "./popCalibrationStore.js";

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStrikeRecord(scanItem, strikeMode, strikeRow, scanTimestamp) {
  const symbol = String(scanItem?.symbol ?? "").trim().toUpperCase();
  const expiration = String(scanItem?.expiration ?? "").trim();
  const strike = toNumber(strikeRow?.strike);
  const premium =
    toNumber(strikeRow?.conservativePremium) ??
    toNumber(strikeRow?.bid) ??
    toNumber(strikeRow?.premium) ??
    null;
  const spotAtScan = toNumber(scanItem?.currentPrice);
  const breakEven =
    strike != null && premium != null ? Number((strike - premium).toFixed(4)) : null;
  const scanDate = String(scanTimestamp).slice(0, 10);
  const strikeToken = strike != null ? String(strike).replace(".", "_") : "na";
  return {
    id: `${symbol}_${scanDate}_${expiration}_${strikeMode}_${strikeToken}`,
    symbol,
    scanDate,
    scanTimestamp,
    expiration,
    dte: toNumber(scanItem?.dteDays),
    strikeMode,
    strike,
    premium,
    breakEven,
    spotAtScan,
    popEstimate: toNumber(strikeRow?.popEstimate),
    popModel: strikeRow?.popModel ?? null,
    finalScore: toNumber(scanItem?.finalScore),
    executionScore: toNumber(scanItem?.executionScore),
    distanceScore: toNumber(scanItem?.distanceScore),
    hasEarnings: Boolean(scanItem?.hasEarnings),
    hasEarningsBeforeExpiration: Boolean(scanItem?.hasEarningsBeforeExpiration),
    hasUpcomingEarningsBeforeExpiration: Boolean(scanItem?.hasUpcomingEarningsBeforeExpiration),
    hasPastEarningsBeforeExpiration: Boolean(scanItem?.hasPastEarningsBeforeExpiration),
    earningsDate: scanItem?.earningsDate ?? null,
    earningsMoment: scanItem?.earningsMoment ?? null,
    resolved: false,
    resolution: null,
  };
}

export function createPopCalibrationService(options = {}) {
  const store = createPopCalibrationStore(options.journalPath);

  function buildRecordsFromShortlist(shortlist, scanTimestamp = new Date().toISOString()) {
    if (!Array.isArray(shortlist)) return [];
    const records = [];
    for (const item of shortlist) {
      const safe = item?.safeStrike ?? null;
      const aggressive = item?.aggressiveStrike ?? null;
      if (safe?.strike != null) {
        records.push(normalizeStrikeRecord(item, "safe", safe, scanTimestamp));
      }
      if (aggressive?.strike != null) {
        records.push(normalizeStrikeRecord(item, "aggressive", aggressive, scanTimestamp));
      }
    }
    return records;
  }

  async function captureFromShortlist(shortlist, scanTimestamp = new Date().toISOString()) {
    const records = buildRecordsFromShortlist(shortlist, scanTimestamp);
    if (records.length === 0) {
      return { captured: 0, records: [], journal: await store.load() };
    }
    const journal = await store.appendMany(records);
    return { captured: records.length, records, journal };
  }

  return {
    buildRecordsFromShortlist,
    captureFromShortlist,
    store,
  };
}
