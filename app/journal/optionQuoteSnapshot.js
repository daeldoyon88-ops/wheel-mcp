/**
 * Snapshot option live minimal — un contrat par record Journal POP.
 * IBKR prioritaire, Yahoo en repli. Aucune chaîne options complète.
 */

const STALE_QUOTE_MAX_AGE_MS = 120_000;

const TRACKED_FIELDS = [
  "bid",
  "ask",
  "mid",
  "spreadAbs",
  "spreadPct",
  "impliedVolatility",
  "delta",
  "gamma",
  "theta",
  "vega",
  "volume",
  "openInterest",
  "conId",
  "localSymbol",
  "tradingClass",
  "exchange",
  "currency",
  "multiplier",
  "modelPrice",
  "quoteTimestamp",
  "modelGreeksTimestamp",
];

function toNum(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pickFirst(...values) {
  for (const value of values) {
    if (value != null && value !== "") return value;
  }
  return null;
}

function pickFirstNumber(...values) {
  for (const value of values) {
    const n = toNum(value);
    if (n != null) return n;
  }
  return null;
}

function pickFirstText(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeIso(value) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isIbkrCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  return (
    Boolean(candidate?.ibkrDirect) ||
    candidate?.source === "IBKR" ||
    candidate?.optionsSource === "IBKR live" ||
    candidate?.optionSource === "IBKR live"
  );
}

function getIbkrRoot(candidate) {
  const direct = candidate?.ibkrDirect;
  if (!direct || typeof direct !== "object") return null;
  if (direct.raw && typeof direct.raw === "object") return { ...direct.raw, ...direct };
  return direct;
}

function findPutRowByStrike(candidate, strike) {
  const strikeNum = toNum(strike);
  if (strikeNum == null) return null;
  const ibkr = getIbkrRoot(candidate);
  const pools = [
    candidate?.ibkrSafePutRow,
    candidate?.ibkrAggressivePutRow,
    ibkr?.putCandidates,
    candidate?.putCandidates,
    candidate?.raw?.putCandidates,
  ];
  for (const pool of pools) {
    if (!pool) continue;
    if (pool && typeof pool === "object" && !Array.isArray(pool) && toNum(pool.strike) === strikeNum) {
      return pool;
    }
    if (Array.isArray(pool)) {
      const hit = pool.find((row) => toNum(row?.strike) === strikeNum);
      if (hit) return hit;
    }
  }
  return null;
}

function getIbkrStrikeSelection(candidate, strikeMode) {
  const ibkr = getIbkrRoot(candidate);
  if (!ibkr) return null;
  return strikeMode === "safe" ? ibkr.safeStrike ?? null : ibkr.aggressiveStrike ?? null;
}

function resolvePrimarySource(candidate) {
  if (isIbkrCandidate(candidate)) return "IBKR";
  if (candidate?.raw || candidate?.techniqueSource === "Yahoo") return "Yahoo";
  if (candidate?.optionsSource) {
    const src = String(candidate.optionsSource).toLowerCase();
    if (src.includes("ibkr")) return "IBKR";
    if (src.includes("yahoo")) return "Yahoo";
  }
  return "unknown";
}

function computeSpread(bid, ask, mid) {
  if (bid == null || ask == null) return { spreadAbs: null, spreadPct: null };
  const spreadAbs = ask - bid;
  const basis = mid != null && mid > 0 ? mid : ask > 0 ? ask : null;
  const spreadPct = basis != null && basis > 0 ? spreadAbs / basis : null;
  return { spreadAbs, spreadPct };
}

function assessFreshness(quoteTimestamp, scanTimestamp) {
  const quoteIso = normalizeIso(quoteTimestamp);
  const scanIso = normalizeIso(scanTimestamp);
  if (!quoteIso) {
    return { isStale: null, staleReason: "quote_timestamp_absent", freshnessLabel: "inconnue" };
  }
  if (!scanIso) {
    return { isStale: null, staleReason: null, freshnessLabel: "inconnue" };
  }
  const ageMs = new Date(scanIso).getTime() - new Date(quoteIso).getTime();
  if (ageMs > STALE_QUOTE_MAX_AGE_MS) {
    return { isStale: true, staleReason: "quote_older_than_scan_threshold", freshnessLabel: "stale" };
  }
  return { isStale: false, staleReason: null, freshnessLabel: "fraîche" };
}

function buildWarnings(snapshot, primarySource) {
  const warnings = [];
  if (!snapshot.quote?.quoteTimestamp) warnings.push("quote_timestamp_absent");
  if (snapshot.quote?.bid == null || snapshot.quote?.ask == null) warnings.push("bid_ask_incomplete");
  if (snapshot.quote?.spreadPct != null && snapshot.quote.spreadPct > 0.35) {
    warnings.push("spread_eleve");
  }
  if (snapshot.greeks?.impliedVolatility == null) warnings.push("iv_absente");
  if (snapshot.greeks?.delta == null) warnings.push("delta_absent");
  if (snapshot.liquidity?.volume == null && snapshot.liquidity?.openInterest == null) {
    warnings.push("oi_volume_absents");
  }
  if (primarySource === "Yahoo" || snapshot.dataConfidence === "observed_yahoo") {
    warnings.push("source_fallback_yahoo");
  }
  if (snapshot.dataConfidence === "mixed") warnings.push("source_mixte");
  if (snapshot.dataConfidence === "estimated") warnings.push("donnees_estimees");
  return warnings.slice(0, 8);
}

function fieldPresent(snapshot, key) {
  if (key === "spreadAbs") return snapshot?.quote?.spreadAbs != null;
  if (key === "spreadPct") return snapshot?.quote?.spreadPct != null;
  if (key === "impliedVolatility") return snapshot?.greeks?.impliedVolatility != null;
  if (key === "delta") return snapshot?.greeks?.delta != null;
  if (key === "gamma") return snapshot?.greeks?.gamma != null;
  if (key === "theta") return snapshot?.greeks?.theta != null;
  if (key === "vega") return snapshot?.greeks?.vega != null;
  if (key === "volume") return snapshot?.liquidity?.volume != null;
  if (key === "openInterest") return snapshot?.liquidity?.openInterest != null;
  if (key === "conId") return snapshot?.contract?.conId != null;
  if (key === "localSymbol") return snapshot?.contract?.localSymbol != null;
  if (key === "tradingClass") return snapshot?.contract?.tradingClass != null;
  if (key === "exchange") return snapshot?.contract?.exchange != null;
  if (key === "currency") return snapshot?.contract?.currency != null;
  if (key === "multiplier") return snapshot?.contract?.multiplier != null;
  if (key === "modelPrice") return snapshot?.greeks?.modelPrice != null;
  if (key === "quoteTimestamp") return snapshot?.quote?.quoteTimestamp != null;
  if (key === "modelGreeksTimestamp") return snapshot?.greeks?.modelGreeksTimestamp != null;
  return snapshot?.quote?.[key] != null;
}

/**
 * @param {object} params
 * @param {object} params.candidate
 * @param {"safe"|"aggressive"} params.strikeMode
 * @param {string} params.scanTimestamp
 * @param {object|null} params.strikeRow
 */
export function buildOptionQuoteSnapshot({ candidate, strikeMode, scanTimestamp, strikeRow }) {
  const symbol = String(candidate?.symbol ?? candidate?.ticker ?? "").trim().toUpperCase() || null;
  const expiration = pickFirst(
    candidate?.expiration,
    candidate?.targetExpiration,
    candidate?.selectedExpiration,
    candidate?.ibkrDirect?.expiration,
    candidate?.ibkrDirect?.raw?.expiration
  );
  const strike = toNum(strikeRow?.strike);
  const primarySource = resolvePrimarySource(candidate);
  const ibkrSelection = getIbkrStrikeSelection(candidate, strikeMode);
  const ibkrPutRow =
    strikeMode === "safe"
      ? candidate?.ibkrSafePutRow ?? findPutRowByStrike(candidate, strike)
      : candidate?.ibkrAggressivePutRow ?? findPutRowByStrike(candidate, strike);

  const ibkrUsed = isIbkrCandidate(candidate);
  const ibkrStrikeRow =
    ibkrSelection && ibkrPutRow
      ? { ...ibkrPutRow, ...ibkrSelection }
      : ibkrSelection ?? ibkrPutRow ?? null;

  const bid = pickFirstNumber(
    ibkrUsed ? ibkrStrikeRow?.bid : null,
    strikeRow?.bid,
    ibkrStrikeRow?.bid
  );
  const ask = pickFirstNumber(
    ibkrUsed ? ibkrStrikeRow?.ask : null,
    strikeRow?.ask,
    ibkrStrikeRow?.ask
  );
  const mid = pickFirstNumber(
    ibkrUsed ? ibkrStrikeRow?.mid : null,
    strikeRow?.mid,
    ibkrStrikeRow?.mid,
    bid != null && ask != null ? (bid + ask) / 2 : null
  );
  const last = pickFirstNumber(ibkrStrikeRow?.last, strikeRow?.last);
  const mark = pickFirstNumber(ibkrStrikeRow?.mark, strikeRow?.mark);
  const spreadFromRow = computeSpread(
    bid,
    ask,
    mid ??
      toNum(strikeRow?.mid) ??
      toNum(ibkrStrikeRow?.mid)
  );
  const spreadAbs = pickFirstNumber(
    toNum(strikeRow?.spread),
    toNum(strikeRow?.liquidity?.absoluteSpread),
    toNum(ibkrStrikeRow?.spread),
    spreadFromRow.spreadAbs
  );
  const spreadPct = pickFirstNumber(
    toNum(strikeRow?.spreadPct),
    toNum(strikeRow?.liquidity?.spreadPct),
    toNum(ibkrStrikeRow?.spreadPct),
    spreadFromRow.spreadPct
  );

  const impliedVolatility = pickFirstNumber(
    ibkrUsed ? ibkrStrikeRow?.impliedVolatility : null,
    strikeRow?.impliedVolatility,
    ibkrStrikeRow?.impliedVolatility,
    candidate?.diagnosticsV12?.safeStrikeIv
  );

  const delta = pickFirstNumber(ibkrStrikeRow?.delta, strikeRow?.delta);
  const gamma = pickFirstNumber(ibkrStrikeRow?.gamma, strikeRow?.gamma);
  const theta = pickFirstNumber(ibkrStrikeRow?.theta, strikeRow?.theta);
  const vega = pickFirstNumber(ibkrStrikeRow?.vega, strikeRow?.vega);

  const volume = pickFirstNumber(
    ibkrUsed ? ibkrPutRow?.volume : null,
    ibkrUsed ? ibkrPutRow?.optionVolume : null,
    strikeRow?.volume,
    strikeRow?.optionVolume,
    strikeRow?.liquidity?.volume,
    ibkrPutRow?.volume,
    ibkrPutRow?.optionVolume
  );
  const openInterest = pickFirstNumber(
    ibkrUsed ? ibkrPutRow?.openInterest : null,
    ibkrUsed ? ibkrPutRow?.putOpenInterest : null,
    strikeRow?.openInterest,
    strikeRow?.putOpenInterest,
    strikeRow?.liquidity?.openInterest,
    ibkrPutRow?.openInterest,
    ibkrPutRow?.putOpenInterest
  );

  const quoteTimestamp = pickFirst(
    ibkrStrikeRow?.quoteTimestamp,
    ibkrStrikeRow?.quoteTime,
    candidate?.ibkrDirect?.scanCompletedAt,
    getIbkrRoot(candidate)?.scanCompletedAt,
    scanTimestamp
  );

  const spot = pickFirst(
    candidate?.currentPrice,
    candidate?.underlyingPrice,
    candidate?.price,
    getIbkrRoot(candidate)?.underlyingPrice
  );

  const expectedMove = pickFirst(candidate?.expectedMove, null);
  const lowerBound = pickFirst(candidate?.lowerBound, candidate?.expectedMoveLow);
  const upperBound = pickFirst(candidate?.upperBound, candidate?.expectedMoveHigh);

  const premiumUsed = pickFirst(
    strikeRow?.conservativePremium,
    strikeRow?.primeUsed,
    strikeRow?.premiumUsed,
    ibkrStrikeRow?.primeUsed,
    strikeRow?.bid
  );

  const distanceToStrikePct =
    spot != null && strike != null && spot > 0 ? ((spot - strike) / spot) * 100 : null;
  const moneynessPct = distanceToStrikePct;
  const premiumYieldPct =
    premiumUsed != null && strike != null && strike > 0 ? (premiumUsed / strike) * 100 : null;

  const popEstimate = pickFirst(strikeRow?.popEstimate, strikeRow?.popProfitEstimated);
  const dteAtScan = pickFirst(candidate?.dteAtScan, candidate?.dteDays);

  const freshness = assessFreshness(quoteTimestamp, scanTimestamp);

  let dataConfidence = "missing";
  const hasIbkrQuotes = ibkrUsed && bid != null && ask != null;
  const hasYahooQuotes =
    !ibkrUsed && (bid != null || ask != null || strikeRow?.premium != null || candidate?.raw);
  if (hasIbkrQuotes) dataConfidence = "observed_ibkr";
  else if (hasYahooQuotes) dataConfidence = "observed_yahoo";
  else if (bid != null || ask != null || mid != null) dataConfidence = "mixed";
  else if (premiumUsed != null || popEstimate != null) dataConfidence = "estimated";

  const snapshot = {
    source: primarySource === "IBKR" && hasYahooQuotes ? "mixed" : primarySource,
    primaryOptionDataSource: primarySource,
    ticker: symbol,
    optionType: "PUT",
    expiration: expiration ?? null,
    strike,
    dteAtScan: toNum(dteAtScan),
    contract: {
      conId: pickFirstNumber(ibkrStrikeRow?.conId, strikeRow?.conId),
      localSymbol: pickFirstText(ibkrStrikeRow?.localSymbol, strikeRow?.localSymbol),
      tradingClass: pickFirstText(ibkrStrikeRow?.tradingClass, strikeRow?.tradingClass),
      exchange: pickFirstText(ibkrStrikeRow?.exchange, strikeRow?.exchange),
      currency: pickFirstText(ibkrStrikeRow?.currency, strikeRow?.currency, "USD"),
      multiplier: pickFirstText(ibkrStrikeRow?.multiplier, strikeRow?.multiplier),
    },
    quote: {
      bid: bid ?? null,
      ask: ask ?? null,
      mid: mid ?? null,
      last: last ?? null,
      mark: mark ?? null,
      spreadAbs: spreadAbs ?? null,
      spreadPct: spreadPct ?? null,
      quoteTimestamp: normalizeIso(quoteTimestamp),
      scanTimestamp: normalizeIso(scanTimestamp),
      isStale: freshness.isStale,
      staleReason: freshness.staleReason,
      freshnessLabel: freshness.freshnessLabel,
    },
    greeks: {
      impliedVolatility: impliedVolatility ?? null,
      delta: delta ?? null,
      gamma: gamma ?? null,
      theta: theta ?? null,
      vega: vega ?? null,
      modelPrice: pickFirstNumber(ibkrStrikeRow?.modelPrice, strikeRow?.modelPrice),
      modelGreeksTimestamp: normalizeIso(
        pickFirst(ibkrStrikeRow?.modelGreeksTimestamp, strikeRow?.modelGreeksTimestamp)
      ),
      modelGreeksSource: pickFirstText(ibkrStrikeRow?.modelGreeksSource, strikeRow?.modelGreeksSource),
    },
    liquidity: {
      volume: volume ?? null,
      openInterest: openInterest ?? null,
      optionVolumeTimestamp:
        normalizeIso(pickFirst(ibkrPutRow?.optionVolumeTimestamp, strikeRow?.optionVolumeTimestamp)) ?? null,
      openInterestTimestamp:
        normalizeIso(pickFirst(ibkrPutRow?.openInterestTimestamp, strikeRow?.openInterestTimestamp)) ?? null,
    },
    underlying: {
      underlyingPriceAtScan: spot ?? null,
      underlyingBid: pickFirst(getIbkrRoot(candidate)?.underlyingBid, candidate?.underlyingBid) ?? null,
      underlyingAsk: pickFirst(getIbkrRoot(candidate)?.underlyingAsk, candidate?.underlyingAsk) ?? null,
      underlyingTimestamp:
        normalizeIso(
          pickFirst(
            getIbkrRoot(candidate)?.scanCompletedAt,
            candidate?.ibkrDirect?.scanCompletedAt,
            scanTimestamp
          )
        ) ?? null,
    },
    context: {
      moneynessPct,
      distanceToStrikePct,
      premiumYieldPct,
      expectedMove: expectedMove ?? null,
      lowerBound: lowerBound ?? null,
      upperBound: upperBound ?? null,
      popEstimate: popEstimate ?? null,
      popSource: popEstimate != null ? "internal_model" : null,
    },
    dataConfidence,
    missingFields: [],
    warnings: [],
    mixedSourceWarnings: [],
  };

  snapshot.missingFields = TRACKED_FIELDS.filter((key) => !fieldPresent(snapshot, key));
  snapshot.warnings = buildWarnings(snapshot, primarySource);
  if (snapshot.source === "mixed") {
    snapshot.mixedSourceWarnings.push("ibkr_et_yahoo_combines");
  }
  if (primarySource === "Yahoo" && ibkrUsed) {
    snapshot.mixedSourceWarnings.push("ibkr_signale_mais_quotes_yahoo");
  }

  return snapshot;
}

export function parseOptionQuoteSnapshot(record) {
  if (!record || typeof record !== "object") return null;
  const direct = record?.optionQuoteSnapshot;
  if (direct && typeof direct === "object") return direct;
  const raw = record?.option_quote_snapshot_json;
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

function parseOptionQuoteSnapshotWithStatus(record) {
  if (!record || typeof record !== "object") {
    return { snapshot: null, storageStatus: "snapshot_absent", warnings: [] };
  }
  const direct = record?.optionQuoteSnapshot;
  if (direct && typeof direct === "object") {
    return { snapshot: direct, storageStatus: "snapshot_sqlite_present", warnings: [] };
  }
  const raw = record?.option_quote_snapshot_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { snapshot: parsed, storageStatus: "snapshot_sqlite_present", warnings: [] };
      }
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["option_quote_snapshot_json_not_object"],
      };
    } catch (_err) {
      return {
        snapshot: null,
        storageStatus: "snapshot_parse_failed",
        warnings: ["option_quote_snapshot_json_parse_failed"],
      };
    }
  }
  return { snapshot: null, storageStatus: "snapshot_absent", warnings: ["snapshot_absent"] };
}

function buildRecordOptionDataBadge(diagnostics, storageStatus) {
  if (storageStatus === "snapshot_parse_failed") return "Snapshot invalide";
  if (diagnostics?.hasObservedIbkrOptionData) return "IBKR observé";
  if (diagnostics?.optionDataSourceSummary === "Yahoo") return "Yahoo fallback";
  if (storageStatus === "snapshot_absent") return "Snapshot absent";
  if ((diagnostics?.optionDataCompletenessPct ?? 0) < 100) return "Options incomplètes";
  return "Snapshot présent";
}

export function summarizeOptionQuoteDiagnostics(record) {
  const snapshot = parseOptionQuoteSnapshot(record);
  const hasSnapshot = Boolean(snapshot);
  const primarySource = snapshot?.primaryOptionDataSource ?? snapshot?.source ?? "unknown";
  const hasObservedIbkrOptionData =
    hasSnapshot &&
    (snapshot?.dataConfidence === "observed_ibkr" ||
      (primarySource === "IBKR" &&
        snapshot?.quote?.bid != null &&
        snapshot?.quote?.ask != null));

  const trackedPresent = TRACKED_FIELDS.filter((key) => fieldPresent(snapshot, key)).length;
  const optionDataCompletenessPct = hasSnapshot
    ? Math.round((trackedPresent / TRACKED_FIELDS.length) * 100)
    : 0;

  return {
    hasObservedIbkrOptionData,
    optionDataCompletenessPct,
    optionDataMissingFields: hasSnapshot
      ? snapshot.missingFields ?? []
      : [...TRACKED_FIELDS],
    optionDataSourceSummary: hasSnapshot ? (snapshot.source ?? primarySource) : "absent",
    optionSnapshotStorageStatus: hasSnapshot ? "snapshot_sqlite_present" : "snapshot_absent",
    optionQuoteFreshness: snapshot?.quote?.freshnessLabel ?? "inconnue",
    optionDataWarnings: hasSnapshot ? snapshot.warnings ?? [] : ["snapshot_absent"],
    hasObservedIv: snapshot?.greeks?.impliedVolatility != null,
    hasObservedDelta: snapshot?.greeks?.delta != null,
    hasObservedBidAsk: snapshot?.quote?.bid != null && snapshot?.quote?.ask != null,
    hasObservedOiVolume:
      snapshot?.liquidity?.openInterest != null || snapshot?.liquidity?.volume != null,
  };
}

export function enrichRecordWithOptionQuoteFields(record) {
  if (!record || typeof record !== "object") return record;
  const parsed = parseOptionQuoteSnapshotWithStatus(record);
  const diagnosticsRecord = parsed.snapshot ? { ...record, optionQuoteSnapshot: parsed.snapshot } : record;
  const diagnostics = summarizeOptionQuoteDiagnostics(diagnosticsRecord);
  return {
    ...record,
    ...(parsed.snapshot ? { optionQuoteSnapshot: parsed.snapshot } : {}),
    ...diagnostics,
    optionSnapshotStorageStatus: parsed.storageStatus,
    optionDataWarnings:
      parsed.warnings.length > 0
        ? [...new Set([...(diagnostics.optionDataWarnings ?? []), ...parsed.warnings])]
        : diagnostics.optionDataWarnings,
    optionDataBadge: buildRecordOptionDataBadge(diagnostics, parsed.storageStatus),
  };
}

export function summarizeOptionDataForProfile(records) {
  const rows = Array.isArray(records) ? records : [];
  if (rows.length === 0) {
    return {
      recordsWithSnapshot: 0,
      recordsWithIbkrObserved: 0,
      avgOptionDataCompletenessPct: 0,
      optionDataSourceSummary: "absent",
      optionSnapshotStorageStatus: "snapshot_absent",
    };
  }
  let withSnapshot = 0;
  let withIbkr = 0;
  let completenessSum = 0;
  const sources = new Map();
  for (const record of rows) {
    const diag = summarizeOptionQuoteDiagnostics(record);
    if (parseOptionQuoteSnapshot(record)) withSnapshot += 1;
    if (diag.hasObservedIbkrOptionData) withIbkr += 1;
    completenessSum += diag.optionDataCompletenessPct ?? 0;
    const src = diag.optionDataSourceSummary ?? "absent";
    sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  const dominantSource =
    [...sources.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "absent";
  return {
    recordsWithSnapshot: withSnapshot,
    recordsWithIbkrObserved: withIbkr,
    avgOptionDataCompletenessPct: Math.round(completenessSum / rows.length),
    optionDataSourceSummary: dominantSource,
    optionSnapshotStorageStatus: withSnapshot > 0 ? "snapshot_sqlite_present" : "snapshot_absent",
  };
}

export function buildOptionDataBadge(summary) {
  if (!summary) return "Snapshot absent";
  if (summary.recordsWithIbkrObserved > 0 && summary.recordsWithSnapshot > 0) {
    return "IBKR observé";
  }
  if (summary.optionDataSourceSummary === "Yahoo" && summary.recordsWithSnapshot > 0) {
    return "Yahoo fallback";
  }
  if (summary.avgOptionDataCompletenessPct < 45 && summary.recordsWithSnapshot > 0) {
    return "Options incomplètes";
  }
  if (summary.recordsWithSnapshot === 0) return "Snapshot absent";
  return "Données estimées";
}
