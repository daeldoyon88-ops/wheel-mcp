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

function buildLegacyRecordId(symbol, expiration, strikeMode, strike, scanDate) {
  return `${symbol}_${expiration}_${strikeMode}_${normalizeStrikeToken(strike)}_${scanDate}`;
}

function buildSessionRecordId(symbol, expiration, strikeMode, strike, scanSessionId, scanDate) {
  const session = scanSessionId == null ? "" : String(scanSessionId).trim();
  if (!session) return buildLegacyRecordId(symbol, expiration, strikeMode, strike, scanDate);
  return `${session}_${symbol}_${expiration}_${strikeMode}_${normalizeStrikeToken(strike)}`;
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

  return {
    id: buildSessionRecordId(symbol, expiration, strikeMode, strike, scanSessionId, scanDate),
    scanSessionId: scanSessionId == null ? null : String(scanSessionId).trim() || null,
    scanTimestamp,
    scanDate,
    selectedExpiration: selectedExpiration || null,
    expirationCohort,
    dteAtScan,
    candidateRank,
    captureSource,
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

export function createWheelValidationService(options = {}) {
  const store = createWheelValidationStore(options.journalPath);
  const getHistoricalClose =
    typeof options.getHistoricalClose === "function" ? options.getHistoricalClose : null;
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

  async function resolveExpiredRecords(options = {}) {
    return withWriteLock(async () => {
      const todayYmd = normalizeIsoTimestamp(options.today ?? new Date()).slice(0, 10);
      const journal = await store.load();
      const records = Array.isArray(journal?.records) ? journal.records : [];
      const errors = [];
      let skippedNotExpired = 0;
      let skippedNoClose = 0;
      let resolved = 0;
      if (!getHistoricalClose) {
        return {
          resolved,
          skippedNotExpired: records.length,
          skippedNoClose,
          errors: ["historical_close_provider_unavailable"],
          groupsChecked: 0,
        };
      }

      const groups = new Map();
      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (record?.resolution?.resolved === true) continue;
        const symbol = normalizeSymbol(record?.symbol);
        const expirationYmd = toExpirationYmd(record?.expiration);
        if (!symbol || !expirationYmd) {
          skippedNotExpired += 1;
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

        for (const index of group.indices) {
          const existing = records[index];
          const strike = toNumberOrNull(existing?.strike?.strike);
          if (strike == null) {
            skippedNoClose += 1;
            continue;
          }
          const expiredWorthless = closeNum > strike;
          const premium = toNumberOrNull(existing?.strike?.premium);
          const premiumRealized = premium == null ? null : Number((premium * 100).toFixed(2));
          const realizedPl = expiredWorthless === true ? premiumRealized : null;
          records[index] = {
            ...existing,
            resolution: {
              resolved: true,
              expirationClosePrice: closeNum,
              expiredWorthless,
              assigned: expiredWorthless ? false : true,
              rolled: false,
              realizedPl,
              premiumRealized,
              popPredictionCorrect: expiredWorthless ? true : false,
              outcomeStatus: expiredWorthless ? "expired_worthless" : "assigned_theoretical",
              resolutionDate: todayYmd,
              notes: `auto_resolved_from_yahoo_close_${group.expirationYmd}`,
            },
          };
          resolved += 1;
        }
      }

      if (resolved > 0) {
        journal.updatedAt = new Date().toISOString();
        await store.save(journal);
      }

      return {
        resolved,
        skippedNotExpired,
        skippedNoClose,
        errors,
        groupsChecked,
      };
    });
  }

  return {
    buildRecordsFromCandidates,
    listJournal,
    computeStats,
    captureFromCandidates,
    patchResolution,
    resolveExpiredRecords,
    store,
  };
}
