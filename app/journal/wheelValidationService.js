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

function buildResolutionDefaults() {
  return {
    resolved: false,
    expirationClosePrice: null,
    expiredWorthless: null,
    assigned: null,
    rolled: null,
    realizedPl: null,
    premiumRealized: null,
    popPredictionCorrect: null,
    outcomeStatus: null,
    resolutionDate: null,
    notes: null,
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

function normalizeRecord(candidate, strikeMode, scanTimestamp, scanSessionId = null) {
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

  return {
    id: `${symbol}_${expiration}_${strikeMode}_${normalizeStrikeToken(strike)}_${scanDate}`,
    scanSessionId: scanSessionId == null ? null : String(scanSessionId).trim() || null,
    scanTimestamp,
    scanDate,
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
    strike: {
      strike,
      premium:
        toNumberOrNull(strikeRow?.premium) ??
        toNumberOrNull(strikeRow?.premiumUsed) ??
        toNumberOrNull(strikeRow?.mid) ??
        toNumberOrNull(strikeRow?.bid) ??
        null,
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
    },
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
    resolution: buildResolutionDefaults(),
  };
}

function normalizeResolutionPatch(patch) {
  const resolved = typeof patch?.resolved === "boolean" ? patch.resolved : true;
  const expiredWorthless = toBooleanOrNull(patch?.expiredWorthless);
  return {
    resolved,
    expirationClosePrice: toNumberOrNull(patch?.expirationClosePrice),
    expiredWorthless,
    assigned: toBooleanOrNull(patch?.assigned),
    rolled: toBooleanOrNull(patch?.rolled),
    realizedPl: toNumberOrNull(patch?.realizedPl),
    premiumRealized: toNumberOrNull(patch?.premiumRealized),
    popPredictionCorrect:
      resolved === true
        ? expiredWorthless === true
          ? true
          : expiredWorthless === false
          ? false
          : null
        : null,
    outcomeStatus: patch?.outcomeStatus == null ? null : String(patch.outcomeStatus).trim() || null,
    resolutionDate:
      patch?.resolutionDate == null ? null : String(patch.resolutionDate).trim() || null,
    notes: patch?.notes == null ? null : String(patch.notes),
  };
}

export function createWheelValidationService(options = {}) {
  const store = createWheelValidationStore(options.journalPath);
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
    for (const candidate of finalCandidates) {
      const safeRecord = normalizeRecord(candidate, "safe", scanTimestamp, scanSessionId);
      if (safeRecord) records.push(safeRecord);
      const aggressiveRecord = normalizeRecord(candidate, "aggressive", scanTimestamp, scanSessionId);
      if (aggressiveRecord) records.push(aggressiveRecord);
    }
    return records;
  }

  async function listJournal() {
    return store.load();
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
          requestedTopN: Number.isFinite(Number(options.topN)) ? Math.max(1, Number(options.topN)) : 30,
          records: [],
          journal,
        };
      }

      const existingIds = new Set(
        journal.records.map((record) => String(record?.id ?? "").trim()).filter(Boolean)
      );
      const uniqueRecords = [];
      let duplicates = 0;
      for (const record of records) {
        if (existingIds.has(record.id)) {
          duplicates += 1;
          continue;
        }
        existingIds.add(record.id);
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

  return {
    buildRecordsFromCandidates,
    listJournal,
    captureFromCandidates,
    patchResolution,
    store,
  };
}
