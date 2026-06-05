/**
 * Diagnostic read-only du pipeline ticker (Yahoo → IBKR → cartes → combos).
 * Ne modifie aucune donnée source.
 */

import {
  buildCapitalComboCandidate,
  getFinalDisplayRecommendation,
} from "./capitalComboPortfolio.js";
import { candidateRowMatchesSelectedExpiration } from "./expirationKey.js";
import { getCryptoBlockReason } from "../../app/watchlist/cryptoWheelFilter.js";

/** Requête « ticker exact » : 2–8 caractères alphanum / point / tiret. */
export function normalizeTickerQueryForDiagnostic(query) {
  const t = String(query || "").trim().toUpperCase();
  if (t.length < 2 || t.length > 8) return null;
  if (!/^[A-Z][A-Z0-9.-]*$/.test(t)) return null;
  return t;
}

function normalizeSym(value) {
  return String(value || "").trim().toUpperCase();
}

function findRowByTicker(rows, ticker) {
  if (!Array.isArray(rows)) return null;
  const sym = normalizeSym(ticker);
  return (
    rows.find((row) => normalizeSym(row?.ticker || row?.symbol) === sym) ?? null
  );
}

function summarizeLeg(leg, mode, grade) {
  if (!leg || typeof leg !== "object") {
    return { mode, strike: null, yieldPct: null, spreadPct: null, status: "absent" };
  }
  const strike = Number(leg?.strike);
  const yieldPct = Number(leg?.weeklyYield ?? leg?.weeklyYieldPct);
  const spreadRaw = leg?.liquidity?.spreadPct ?? leg?.spreadPct;
  const spreadPct = Number.isFinite(Number(spreadRaw)) ? Number(spreadRaw) : null;
  const resolvedGrade = String(grade || "—").trim() || "—";
  let status = resolvedGrade;
  if (resolvedGrade === "REJECT") status = "REJECT";
  else if (resolvedGrade === "WATCH") status = "WATCH";
  else if (resolvedGrade === "A" || resolvedGrade === "B") status = resolvedGrade;
  else if (resolvedGrade.includes("· grade brut")) status = resolvedGrade;

  return {
    mode,
    strike: Number.isFinite(strike) ? strike : null,
    yieldPct: Number.isFinite(yieldPct) ? yieldPct : null,
    spreadPct,
    status,
    bid: Number.isFinite(Number(leg?.bid)) ? Number(leg.bid) : null,
  };
}

/** Grade affiché : effectif pour la jambe sélectionnée ; note optionnelle si le brut diffère. */
function buildLegGradeDisplay(effectiveGrade, rawGrade, isSelected) {
  const effective = String(effectiveGrade || "—").trim().toUpperCase() || "—";
  if (!isSelected) {
    const raw = String(rawGrade || "").trim();
    return raw ? raw.toUpperCase() : effective;
  }
  const raw = String(rawGrade || "").trim().toUpperCase();
  if (raw && raw !== effective) {
    return `${effective} · grade brut ${raw}`;
  }
  return effective;
}

function findYahooRejectReasonInRows(rows, ticker) {
  if (!Array.isArray(rows)) return null;
  const sym = normalizeSym(ticker);
  const row = rows.find((r) => normalizeSym(r?.symbol || r?.ticker) === sym);
  if (!row) return null;
  const reason = String(row?.reason || row?.status || row?.rejectionReason || "").trim();
  return reason || null;
}

function minimalYahooRejectDebug(row) {
  if (!row || typeof row !== "object") return null;
  const debug = row.debug && typeof row.debug === "object" ? row.debug : {};
  const pick = {};
  for (const key of [
    "stage",
    "targetPremium",
    "safeStrike",
    "aggressiveStrike",
    "lowerBound",
    "reasonKept",
  ]) {
    if (row[key] != null) pick[key] = row[key];
    else if (debug[key] != null) pick[key] = debug[key];
  }
  return Object.keys(pick).length ? pick : null;
}

/**
 * Index complet des rejets Yahoo : symbol → { reason, debug }.
 * @param {unknown[]} rejectedRows payload.rejected complet
 */
export function buildYahooRejectedBySymbol(rejectedRows) {
  /** @type {Record<string, { reason: string, debug: object | null }>} */
  const index = {};
  if (!Array.isArray(rejectedRows)) return index;
  for (const row of rejectedRows) {
    const sym = normalizeSym(row?.symbol || row?.ticker);
    if (!sym) continue;
    index[sym] = {
      reason: String(row?.reason || row?.status || "unknown").trim() || "unknown",
      debug: minimalYahooRejectDebug(row),
    };
  }
  return index;
}

/**
 * Index des rejets watchlist rebuild + troncature limite.
 * @param {{
 *   rejectedRows?: unknown[],
 *   truncatedSymbols?: string[],
 * }} params
 */
export function buildWatchlistRejectedBySymbol({ rejectedRows = [], truncatedSymbols = [] } = {}) {
  /** @type {Record<string, { reason: string, stage: string, source: string }>} */
  const index = {};
  for (const row of rejectedRows || []) {
    const sym = normalizeSym(row?.symbol || row?.ticker);
    if (!sym) continue;
    index[sym] = {
      reason: String(row?.reason || "unknown").trim() || "unknown",
      stage: "watchlist_rebuild",
      source: "watchlistBuilder",
    };
  }
  for (const raw of truncatedSymbols || []) {
    const sym = normalizeSym(raw);
    if (!sym || index[sym]) continue;
    index[sym] = {
      reason: "excluded_by_watchlist_limit",
      stage: "watchlist_rebuild",
      source: "watchlistBuilder",
    };
  }
  return index;
}

/** @param {Record<string, { reason?: string }> | null | undefined} index */
export function lookupWatchlistRejectedBySymbol(index, ticker) {
  const sym = normalizeSym(ticker);
  if (!sym || !index || typeof index !== "object") return null;
  return index[sym] ?? null;
}

/** Raison Yahoo précise si le ticker est absent de la shortlist mais rejeté côté scan. */
export function resolveYahooAbsentReason(ticker, sources = {}) {
  const sym = normalizeSym(ticker);
  const fromIndex = sources.yahooRejectedBySymbol?.[sym]?.reason;
  if (fromIndex) return fromIndex;
  const fromSample = findYahooRejectReasonInRows(sources.yahooDiagnostics?.rejectedSample, sym);
  if (fromSample) return fromSample;
  const fromPayload = findYahooRejectReasonInRows(sources.yahooScanRejected, sym);
  if (fromPayload) return fromPayload;
  return null;
}

/** Raison watchlist / pool pré-scan si le ticker n’est pas dans tickersForScan. */
export function resolvePreScanAbsentReason(ticker, sources = {}) {
  const sym = normalizeSym(ticker);
  const cryptoReason = getCryptoBlockReason(sym);
  if (cryptoReason) {
    return {
      reason: cryptoReason,
      category: "crypto_blocked",
      display: `Exclu du pool pré-scan — ${cryptoReason} (BITX seul crypto autorisé)`,
    };
  }

  const wlEntry = lookupWatchlistRejectedBySymbol(sources.watchlistRejectedBySymbol, sym);
  if (wlEntry?.reason) {
    return {
      reason: wlEntry.reason,
      category: "watchlist_rebuild",
      display: `rejected_by_watchlist_builder: ${wlEntry.reason}`,
    };
  }

  const mode = String(sources.preIbkrPoolMode || "strict_watchlist").trim();
  const watchlistSet = new Set(
    (sources.watchlistTickers || []).map((t) => normalizeSym(t)).filter(Boolean)
  );
  const researchSet = new Set(
    (sources.researchExpandedPool || []).map((t) => normalizeSym(t)).filter(Boolean)
  );
  const truncatedSet = new Set(
    (sources.watchlistTruncatedSymbols || []).map((t) => normalizeSym(t)).filter(Boolean)
  );

  if (mode === "strict_watchlist" && !watchlistSet.has(sym)) {
    if (truncatedSet.has(sym)) {
      return {
        reason: "excluded_by_watchlist_limit",
        category: "watchlist_rebuild",
        display: "absent_from_strict_watchlist_after_rebuild: excluded_by_watchlist_limit",
      };
    }
    return {
      reason: "absent_from_strict_watchlist_after_rebuild",
      category: "watchlist_rebuild",
      display: "absent_from_strict_watchlist_after_rebuild",
    };
  }

  if (mode === "research_expanded" && !researchSet.has(sym)) {
    return {
      reason: "absent_from_research_expanded_pool",
      category: "research_expanded",
      display: "absent_from_research_expanded_pool (limite ou tier)",
    };
  }

  return {
    reason: "absent_from_pre_scan_pool",
    category: "pool_pre_scan",
    display: "Absent du pool scanné par Yahoo / watchlist pré-scan",
  };
}

/** True si la valeur UI OTM diffère du dernier rebuild appliqué. */
export function isOtmRebuildRequired(selectedPct, appliedPct) {
  if (appliedPct == null || !Number.isFinite(Number(appliedPct))) return false;
  if (!Number.isFinite(Number(selectedPct))) return false;
  return Number(selectedPct) !== Number(appliedPct);
}

/** Message UX quand un rebuild est nécessaire après changement de sonde. */
export function buildOtmRebuildRequiredMessage(selectedPct) {
  const pct = Number.isFinite(Number(selectedPct)) ? Number(selectedPct) : "—";
  return `Sonde OTM changée : Rebuild watchlist requis pour appliquer ${pct}%.`;
}

/** Bannière pool pré-scan selon le mode choisi / effectif. */
export function buildOtmPoolSourceBannerMessage(poolSource) {
  const mode = String(poolSource || "").trim();
  if (mode === "research_expanded") {
    return "Attention : Research Expanded ignore la sonde OTM watchlist. Le scan peut inclure des titres non validés par la sonde 6%.";
  }
  if (mode === "strict_watchlist") {
    return "Strict Watchlist : sonde OTM appliquée selon dernier rebuild.";
  }
  return null;
}

/**
 * Traçabilité sonde OTM pour un ticker exact (read-only).
 * @param {string} ticker
 * @param {object} sources
 */
export function resolveOtmProbeTraceability(ticker, sources = {}) {
  const sym = normalizeSym(ticker);
  const selected = sources.liquidityOtmProbePctSelected;
  const appliedRaw = sources.liquidityOtmProbePctApplied;
  const applied =
    appliedRaw == null || !Number.isFinite(Number(appliedRaw)) ? null : Number(appliedRaw);
  const poolSource = String(
    sources.scanPoolSource || sources.preIbkrPoolMode || "strict_watchlist"
  ).trim();

  const wlReject = lookupWatchlistRejectedBySymbol(sources.watchlistRejectedBySymbol, sym);
  const otmReject =
    wlReject?.reason === "liquid_options_otm_probe_failed" ||
    String(wlReject?.reason || "").includes("otm_probe");

  const inWatchlist = (sources.watchlistTickers || []).map(normalizeSym).includes(sym);
  const wasEvaluated = wasEvaluatedInWatchlistBuild(sources, sym);
  const bypassPools = new Set(["research_expanded", "fallback_65"]);

  /** @type {"pass"|"fail"|"penalized"|"bypassed"|"unknown"} */
  let otmProbeStatus = "unknown";
  let otmProbeNote = null;

  if (bypassPools.has(poolSource)) {
    otmProbeStatus = "bypassed";
    otmProbeNote = "Ticker issu d'un pool qui ne filtre pas par sonde OTM";
    if (otmReject) {
      otmProbeNote += ` · Rejet watchlist : ${wlReject.reason}`;
    }
  } else if (otmReject) {
    otmProbeStatus = "fail";
    otmProbeNote = wlReject?.reason || "liquid_options_otm_probe_failed";
  } else if (inWatchlist && wasEvaluated) {
    otmProbeStatus = "pass";
  } else if (!wasEvaluated) {
    otmProbeStatus = "unknown";
    otmProbeNote = "Non évalué au dernier rebuild watchlist";
  } else if (wasEvaluated && !inWatchlist) {
    otmProbeStatus = "unknown";
    otmProbeNote = wlReject?.reason
      ? `Absent watchlist : ${wlReject.reason}`
      : "Absent watchlist (autre raison ou troncature)";
  }

  const otmMismatchNote =
    selected != null && applied != null && Number(selected) !== Number(applied)
      ? `UI affiche ${selected}%, mais dernier rebuild appliqué = ${applied}%`
      : null;

  return {
    liquidityOtmProbePctSelected:
      selected == null || !Number.isFinite(Number(selected)) ? null : Number(selected),
    liquidityOtmProbePctApplied: applied,
    poolSource,
    otmProbeStatus,
    otmProbeNote,
    otmMismatchNote,
    otmRebuildRequired: isOtmRebuildRequired(selected, applied),
    otmRebuildRequiredMessage: isOtmRebuildRequired(selected, applied)
      ? buildOtmRebuildRequiredMessage(selected)
      : null,
  };
}

function wasEvaluatedInWatchlistBuild(sources, sym) {
  const watchlistSet = new Set(
    (sources.watchlistTickers || []).map((t) => normalizeSym(t)).filter(Boolean)
  );
  if (watchlistSet.has(sym)) return true;
  if (lookupWatchlistRejectedBySymbol(sources.watchlistRejectedBySymbol, sym)) return true;
  const truncatedSet = new Set(
    (sources.watchlistTruncatedSymbols || []).map((t) => normalizeSym(t)).filter(Boolean)
  );
  if (truncatedSet.has(sym)) return true;
  const cryptoBuild = (sources.cryptoBlockedRemovedSymbols || []).map(normalizeSym);
  if (cryptoBuild.includes(sym)) return true;
  return false;
}

/**
 * Trace 10 étapes pré-IBKR pour un ticker (lecture seule).
 * @returns {Array<{ step: string, present: boolean, reason: string, source: string }>}
 */
export function buildTickerPipelineTraceSteps(ticker, sources = {}) {
  const sym = normalizeSym(ticker);
  if (!sym) return [];

  const inUniverseBuild = wasEvaluatedInWatchlistBuild(sources, sym);
  const inWatchlist = (sources.watchlistTickers || [])
    .map(normalizeSym)
    .includes(sym);
  const inResearchPool = (sources.researchExpandedPool || [])
    .map(normalizeSym)
    .includes(sym);
  const cryptoReason = getCryptoBlockReason(sym);
  const wlReject = lookupWatchlistRejectedBySymbol(sources.watchlistRejectedBySymbol, sym);
  const otmFailed =
    wlReject?.reason === "liquid_options_otm_probe_failed" ||
    String(wlReject?.reason || "").includes("otm_probe");
  const inPreScan = (sources.tickersForScan || []).map(normalizeSym).includes(sym);
  const inYahooShortlist = findRowByTicker(sources.yahooReturnedCandidates, sym) != null;
  const yahooReject = sources.yahooRejectedBySymbol?.[sym]?.reason
    ?? resolveYahooAbsentReason(sym, sources);
  const sentToIbkr = (sources.ibkrDirectSentTickers || []).map(normalizeSym).includes(sym);

  const preScanReason = !inPreScan ? resolvePreScanAbsentReason(sym, sources) : null;

  return [
    {
      step: "universe.master (évalué dernier build)",
      present: inUniverseBuild,
      reason: inUniverseBuild ? "—" : "non évalué / absent du dernier build watchlist",
      source: "watchlistStats / build payload",
    },
    {
      step: "watchlist strict (courante)",
      present: inWatchlist,
      reason: inWatchlist ? "—" : wlReject?.reason || "absent après rebuild",
      source: "watchlistTickers",
    },
    {
      step: "après rebuild watchlist",
      present: inWatchlist && !wlReject,
      reason: wlReject?.reason || (inWatchlist ? "conservé" : "absent ou tronqué"),
      source: "watchlistBuilder",
    },
    {
      step: "filtre crypto",
      present: !cryptoReason,
      reason: cryptoReason || "—",
      source: "cryptoWheelFilter",
    },
    {
      step: "watchlistBuilder",
      present: !wlReject,
      reason: wlReject?.reason || "—",
      source: "watchlistRejectedBySymbol",
    },
    {
      step: "sonde OTM",
      present: !otmFailed,
      reason: otmFailed ? "liquid_options_otm_probe_failed" : "—",
      source: "watchlistBuilder / liquidityOtmProbePct",
    },
    {
      step: "envoyé /scan_shortlist",
      present: inPreScan,
      reason: preScanReason?.display || "—",
      source: sources.preIbkrPoolMode || "preIbkrPool",
    },
    {
      step: "payload.shortlist (Yahoo retourné)",
      present: inYahooShortlist,
      reason: inYahooShortlist ? "—" : yahooReject ? `rejeté — ${yahooReject}` : "absent shortlist",
      source: "scan_shortlist",
    },
    {
      step: "payload.rejected (Yahoo)",
      present: Boolean(yahooReject),
      reason: yahooReject || "—",
      source: "yahooRejectedBySymbol",
    },
    {
      step: "envoyé IBKR auto",
      present: sentToIbkr,
      reason: sentToIbkr ? "—" : inYahooShortlist ? "cap depth / scan non lancé" : "non qualifié Yahoo",
      source: "ibkrDirectSentTickers",
    },
  ];
}

/** Catégorie funnel pour un ticker coupé avant IBKR. */
export function categorizePreIbkrCut(entry) {
  const stage = String(entry?.stageLost || "").trim();
  const reason = String(entry?.reason || "").toLowerCase();
  if (entry?.cryptoBlocked) return "crypto_blocked";
  if (stage === "watchlist_rebuild" || reason.includes("watchlist") || reason.includes("otm_probe") || reason.includes("excluded_by_watchlist")) {
    return "watchlist_rebuild";
  }
  if (stage === "pool_pre_scan" || reason.includes("research_expanded") || reason.includes("pre_scan")) {
    return "pool_pre_scan";
  }
  if (stage === "yahoo_returned" || entry?.rejectedYahoo) {
    if (reason.includes("expiration")) return "expiration_error";
    if (reason.includes("scan_failed") || reason.includes("not_ok")) return "yahoo_scan_failed";
    return "yahoo_rejected";
  }
  if (reason.includes("expiration")) return "expiration_error";
  return "unknown";
}

const PRE_IBKR_CUT_CATEGORY_LABELS = Object.freeze({
  watchlist_rebuild: "Coupés au rebuild watchlist",
  pool_pre_scan: "Coupés au pool pré-scan",
  yahoo_rejected: "Rejetés par Yahoo",
  yahoo_scan_failed: "Yahoo scan failed",
  crypto_blocked: "Crypto bloqués",
  expiration_error: "Erreur expiration",
  unknown: "Autre / unknown",
});

/**
 * Liste globale des tickers perdus avant IBKR (diagnostic).
 * @param {object} sources snapshots dashboard
 * @param {{ limit?: number }} [opts]
 */
export function buildPreIbkrCutTickerList(sources = {}, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 500);
  /** @type {Map<string, object>} */
  const byTicker = new Map();

  const ensure = (sym) => {
    const key = normalizeSym(sym);
    if (!key) return null;
    if (!byTicker.has(key)) {
      byTicker.set(key, {
        ticker: key,
        stageLost: null,
        reason: null,
        wasInUniverse: false,
        wasInWatchlist: false,
        sentYahoo: false,
        rejectedYahoo: false,
        cryptoBlocked: false,
        otmProbeStatus: "—",
        comment: "",
        category: "unknown",
      });
    }
    return byTicker.get(key);
  };

  for (const sym of (sources.watchlistTickers || []).map(normalizeSym).filter(Boolean)) {
    const row = ensure(sym);
    if (!row) continue;
    row.wasInWatchlist = true;
    row.wasInUniverse = true;
  }

  for (const [sym, entry] of Object.entries(sources.watchlistRejectedBySymbol || {})) {
    const row = ensure(sym);
    if (!row) continue;
    row.wasInUniverse = true;
    row.stageLost = "watchlist_rebuild";
    row.reason = entry.reason;
    row.comment = `rejected_by_watchlist_builder: ${entry.reason}`;
    if (String(entry.reason).includes("otm_probe")) row.otmProbeStatus = "failed";
    else if (String(entry.reason).includes("liquid_options")) row.otmProbeStatus = entry.reason;
  }

  for (const sym of (sources.watchlistTruncatedSymbols || []).map(normalizeSym).filter(Boolean)) {
    const row = ensure(sym);
    if (!row) continue;
    row.wasInUniverse = true;
    if (!row.stageLost) {
      row.stageLost = "watchlist_rebuild";
      row.reason = "excluded_by_watchlist_limit";
      row.comment = "troncature limite watchlist";
    }
  }

  for (const sym of (sources.cryptoBlockedRemovedSymbols || []).map(normalizeSym).filter(Boolean)) {
    const row = ensure(sym);
    if (!row) continue;
    row.wasInUniverse = true;
    row.cryptoBlocked = true;
    row.stageLost = "pool_pre_scan";
    row.reason = getCryptoBlockReason(sym) || "crypto_blocked_except_bitx";
    row.comment = "crypto filter (BITX seul autorisé)";
  }

  const preScanSet = new Set((sources.tickersForScan || []).map(normalizeSym).filter(Boolean));
  for (const [sym, row] of byTicker) {
    if (preScanSet.has(sym)) {
      row.sentYahoo = true;
      continue;
    }
    if (!row.stageLost && row.wasInUniverse) {
      const pre = resolvePreScanAbsentReason(sym, sources);
      row.stageLost = "pool_pre_scan";
      row.reason = pre.reason;
      row.comment = pre.display;
      if (pre.category === "crypto_blocked") row.cryptoBlocked = true;
    }
  }

  for (const [sym, entry] of Object.entries(sources.yahooRejectedBySymbol || {})) {
    const row = ensure(sym);
    if (!row) continue;
    row.sentYahoo = true;
    row.wasInUniverse = true;
    row.rejectedYahoo = true;
    row.stageLost = "yahoo_returned";
    row.reason = entry.reason;
    row.comment = `Rejet Yahoo : ${entry.reason}`;
  }

  const yahooReturnedSet = new Set(
    (sources.yahooReturnedCandidates || [])
      .map((r) => normalizeSym(r?.ticker || r?.symbol))
      .filter(Boolean)
  );
  const ibkrSentSet = new Set(
    (sources.ibkrDirectSentTickers || []).map(normalizeSym).filter(Boolean)
  );

  for (const sym of preScanSet) {
    const row = ensure(sym);
    if (!row) continue;
    row.sentYahoo = true;
    if (yahooReturnedSet.has(sym)) continue;
    if (row.rejectedYahoo) continue;
    row.stageLost = row.stageLost || "yahoo_returned";
    row.reason = row.reason || "scan_failed / not_ok";
    row.comment = row.comment || "Scanné mais ni shortlist ni rejected indexé";
  }

  const rows = [];
  for (const row of byTicker.values()) {
    if (ibkrSentSet.has(row.ticker)) continue;
    if (yahooReturnedSet.has(row.ticker) && !row.rejectedYahoo) continue;
    if (!row.stageLost && !row.rejectedYahoo && !row.cryptoBlocked) continue;
    row.category = categorizePreIbkrCut(row);
    rows.push(row);
  }

  rows.sort((a, b) => {
    const cat = String(a.category).localeCompare(String(b.category));
    if (cat !== 0) return cat;
    return String(a.ticker).localeCompare(String(b.ticker));
  });

  return rows.slice(0, limit);
}

/**
 * Funnel complet « Yahoo → IBKR » par symbole (lecture seule, aucun filtre de la sélection).
 *
 * Fusionne, sans rien exclure (y compris les tickers envoyés à IBKR) :
 *  - stats.funnelTopCandidates  → rang Yahoo, score Yahoo, dans Top 250, dans shortlist
 *  - yahooReturnedCandidates    → rang / score de repli si absent du snapshot Top 250
 *  - ibkrDirectSentTickers      → envoyé IBKR
 *  - ibkrDirectResult.testedSymbols / shortlist / rejected / errors → statut IBKR
 *
 * @param {object} sources snapshots dashboard
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{
 *   ticker: string,
 *   yahooRank: number|null,
 *   yahooScore: number|null,
 *   inTop250: boolean,
 *   inShortlist: boolean,
 *   sentIbkr: boolean,
 *   testedIbkr: boolean,
 *   ibkrStatus: "retained"|"rejected"|"error"|"nonTested",
 *   stageLost: string|null,
 *   reason: string,
 * }>}
 */
export function buildYahooIbkrFunnel(sources = {}, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 600);

  const funnelTop = Array.isArray(sources.funnelTopCandidates)
    ? sources.funnelTopCandidates
    : [];
  const yahooReturned = Array.isArray(sources.yahooReturnedCandidates)
    ? sources.yahooReturnedCandidates
    : [];
  const ibkrResult = sources.ibkrDirectResult || null;

  /** @type {Map<string, { rankBeforeLimit: number|null, watchlistScore: number|null, keptBeforeLimit: boolean, reason: string|null }>} */
  const topBySym = new Map();
  for (const r of funnelTop) {
    const sym = normalizeSym(r?.symbol || r?.ticker);
    if (!sym) continue;
    topBySym.set(sym, {
      rankBeforeLimit: Number.isFinite(Number(r?.rankBeforeLimit)) ? Number(r.rankBeforeLimit) : null,
      watchlistScore: Number.isFinite(Number(r?.watchlistScore)) ? Number(r.watchlistScore) : null,
      keptBeforeLimit: r?.keptBeforeLimit === true,
      reason: r?.reason != null ? String(r.reason) : null,
    });
  }

  /** @type {Map<string, { rank: number|null, score: number|null }>} */
  const yahooBySym = new Map();
  yahooReturned.forEach((row, idx) => {
    const sym = normalizeSym(row?.ticker || row?.symbol);
    if (!sym || yahooBySym.has(sym)) return;
    const rank = Number.isFinite(Number(row?.rank)) ? Number(row.rank) : idx + 1;
    const score = Number.isFinite(Number(row?.watchlistScore))
      ? Number(row.watchlistScore)
      : Number.isFinite(Number(row?.score))
        ? Number(row.score)
        : null;
    yahooBySym.set(sym, { rank, score });
  });

  const shortlistSet = new Set(
    (sources.tickersForScan || []).map(normalizeSym).filter(Boolean)
  );
  const sentSet = new Set(
    (sources.ibkrDirectSentTickers || []).map(normalizeSym).filter(Boolean)
  );
  const testedSet = new Set(
    (Array.isArray(ibkrResult?.testedSymbols) ? ibkrResult.testedSymbols : [])
      .map(normalizeSym)
      .filter(Boolean)
  );
  const retainedSet = new Set(
    (Array.isArray(ibkrResult?.shortlist) ? ibkrResult.shortlist : [])
      .map((r) => normalizeSym(r?.symbol || r?.ticker))
      .filter(Boolean)
  );
  /** @type {Map<string, string>} */
  const rejectedBySym = new Map();
  for (const r of Array.isArray(ibkrResult?.rejected) ? ibkrResult.rejected : []) {
    const sym = normalizeSym(r?.symbol || r?.ticker);
    if (!sym) continue;
    rejectedBySym.set(sym, ibkrRejectReason(r) || "Rejeté par IBKR");
  }
  /** @type {Map<string, string>} */
  const errorBySym = new Map();
  for (const r of Array.isArray(ibkrResult?.errors) ? ibkrResult.errors : []) {
    const sym = normalizeSym(r?.symbol || r?.ticker);
    if (!sym) continue;
    errorBySym.set(sym, String(r?.message || r?.error || r?.reason || "erreur IBKR").trim() || "erreur IBKR");
  }

  const allSymbols = new Set();
  for (const sym of topBySym.keys()) allSymbols.add(sym);
  for (const sym of yahooBySym.keys()) allSymbols.add(sym);
  for (const sym of shortlistSet) allSymbols.add(sym);
  for (const sym of sentSet) allSymbols.add(sym);
  for (const sym of testedSet) allSymbols.add(sym);
  for (const sym of retainedSet) allSymbols.add(sym);
  for (const sym of rejectedBySym.keys()) allSymbols.add(sym);
  for (const sym of errorBySym.keys()) allSymbols.add(sym);

  const rows = [];
  for (const sym of allSymbols) {
    const top = topBySym.get(sym) || null;
    const yh = yahooBySym.get(sym) || null;

    const inTop250 = top != null;
    const inShortlist = top ? top.keptBeforeLimit : shortlistSet.has(sym);
    const sentIbkr = sentSet.has(sym);
    const testedIbkr = sentIbkr || testedSet.has(sym);

    const yahooRank = top?.rankBeforeLimit ?? yh?.rank ?? null;
    const yahooScore = top?.watchlistScore ?? yh?.score ?? null;

    let ibkrStatus = "nonTested";
    if (retainedSet.has(sym)) ibkrStatus = "retained";
    else if (rejectedBySym.has(sym)) ibkrStatus = "rejected";
    else if (errorBySym.has(sym)) ibkrStatus = "error";

    let stageLost = null;
    let reason = "";
    if (!inTop250 && !inShortlist) {
      stageLost = "top250";
      reason =
        resolveYahooAbsentReason(sym, sources) ||
        resolvePreScanAbsentReason(sym, sources)?.display ||
        "Hors Top 250 watchlist (rang > 250 ou non classé)";
    } else if (!inShortlist) {
      stageLost = "shortlist";
      reason = top?.reason || "Hors shortlist demandée (exclu par la limite watchlist)";
    } else if (!sentIbkr && !testedIbkr) {
      stageLost = "ibkr_send";
      reason = "Dans la shortlist mais non envoyé à IBKR (cap Audit Depth / topN ou scan non lancé)";
    } else if (ibkrStatus === "rejected") {
      stageLost = "ibkr_rejected";
      reason = rejectedBySym.get(sym) || "Rejeté par IBKR";
    } else if (ibkrStatus === "error") {
      stageLost = "ibkr_error";
      reason = errorBySym.get(sym) || "Erreur IBKR";
    } else if (ibkrStatus === "nonTested" && testedIbkr) {
      stageLost = "ibkr_no_result";
      reason = "Envoyé à IBKR mais ni shortlist ni rejected enregistré";
    } else if (ibkrStatus === "retained") {
      stageLost = null;
      reason = "Retenu IBKR";
    } else {
      stageLost = "ibkr_send";
      reason = "Non envoyé à IBKR";
    }

    rows.push({
      ticker: sym,
      yahooRank,
      yahooScore,
      inTop250,
      inShortlist,
      sentIbkr,
      testedIbkr,
      ibkrStatus,
      stageLost,
      reason,
    });
  }

  rows.sort((a, b) => {
    const ra = a.yahooRank == null ? Number.POSITIVE_INFINITY : a.yahooRank;
    const rb = b.yahooRank == null ? Number.POSITIVE_INFINITY : b.yahooRank;
    if (ra !== rb) return ra - rb;
    return String(a.ticker).localeCompare(String(b.ticker));
  });

  return rows.slice(0, limit);
}

/**
 * Compteurs funnel Yahoo → IBKR (valeurs réelles, sans hardcoder 150).
 * @param {ReturnType<typeof buildYahooIbkrFunnel>} rows
 */
export function summarizeYahooIbkrFunnel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = {
    total: list.length,
    inTop250: 0,
    inShortlist: 0,
    sentIbkr: 0,
    notSentIbkr: 0,
    retained: 0,
    rejected: 0,
    error: 0,
    nonTested: 0,
  };
  for (const r of list) {
    if (r.inTop250) counts.inTop250 += 1;
    if (r.inShortlist) counts.inShortlist += 1;
    if (r.sentIbkr) counts.sentIbkr += 1;
    else counts.notSentIbkr += 1;
    if (r.ibkrStatus === "retained") counts.retained += 1;
    else if (r.ibkrStatus === "rejected") counts.rejected += 1;
    else if (r.ibkrStatus === "error") counts.error += 1;
    else counts.nonTested += 1;
  }
  return counts;
}

/** Comptes par catégorie pour la liste des coupés avant IBKR. */
export function summarizePreIbkrCutByCategory(rows) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const key of Object.keys(PRE_IBKR_CUT_CATEGORY_LABELS)) counts[key] = 0;
  for (const row of rows || []) {
    const cat = categorizePreIbkrCut(row);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return { counts, labels: PRE_IBKR_CUT_CATEGORY_LABELS };
}

function resolveFinalStatusLabel(finalDisplayMode, finalDisplayGrade) {
  const mode = String(finalDisplayMode || "").toUpperCase();
  const grade = String(finalDisplayGrade || "").toUpperCase();
  if (mode === "REJECT") return "Non actionnable";
  if ((mode === "SAFE" || mode === "AGGRESSIVE") && (grade === "A" || grade === "B")) return "Actionnable";
  if ((mode === "SAFE" || mode === "AGGRESSIVE") && grade === "WATCH") return "À surveiller";
  return "Indéterminé";
}

function yahooStatusFromRow(row) {
  if (!row) return "absent";
  if (row.passesFilter === true) return "qualifié (passesFilter)";
  if (row.noYahooLiquidity === true) return "retourné — liquidité Yahoo non fiable";
  const reason = row?.debug?.reasonKept || row?.rejectionReason || row?.reason;
  if (reason) return String(reason);
  if (row.ok === true) return "ok";
  return "retourné — filtre final non passé";
}

function ibkrRejectReason(row) {
  if (!row) return null;
  return (
    String(row?.reason || row?.status || row?.error || "").trim() || null
  );
}

function computeLostAtStep(flags) {
  const {
    inPreScanPool,
    presentInYahoo,
    sentToIbkr,
    presentInIbkrShortlist,
    presentInIbkrRejected,
    ibkrTested,
    presentInBackendCandidates,
    presentInEnriched,
    presentInFilteredCards,
    presentInComboPool,
    uiFilterBlocks,
    expirationBlocks,
  } = flags;

  if (!inPreScanPool) {
    const preScan = flags.preScanAbsentReason;
    if (preScan?.display) {
      return { lostAtStep: "pool_pre_scan", likelyReason: preScan.display };
    }
    const cryptoReason = flags.cryptoBlockReason;
    if (cryptoReason) {
      return {
        lostAtStep: "pool_pre_scan",
        likelyReason: `Exclu du pool pré-scan — ${cryptoReason} (BITX seul crypto autorisé)`,
      };
    }
    return { lostAtStep: "pool_pre_scan", likelyReason: "Absent du pool pré-scan / watchlist du refresh courant" };
  }
  if (!presentInYahoo) {
    const yahooReason = String(flags.yahooRejectReason || "").trim();
    return {
      lostAtStep: "yahoo_returned",
      likelyReason: yahooReason
        ? `Rejet Yahoo : ${yahooReason}`
        : "Absent du pool scanné par Yahoo / watchlist pré-scan",
    };
  }
  if (!sentToIbkr && !ibkrTested) {
    return {
      lostAtStep: "ibkr_send",
      likelyReason: "Non envoyé à IBKR auto (cap Audit Depth, priorité ou scan IBKR non lancé)",
    };
  }
  if (presentInIbkrRejected && !presentInIbkrShortlist) {
    return {
      lostAtStep: "ibkr_rejected",
      likelyReason: flags.ibkrRejectReason || "Rejeté par IBKR (pas de jambe safe/aggressive valide)",
    };
  }
  if (ibkrTested && !presentInIbkrShortlist && !presentInIbkrRejected) {
    return {
      lostAtStep: "ibkr_no_result",
      likelyReason: "Envoyé à IBKR mais ni shortlist ni rejected enregistré",
    };
  }
  if (presentInIbkrShortlist && !presentInBackendCandidates) {
    return {
      lostAtStep: "ibkr_display_slice",
      likelyReason:
        flags.notDisplayedReason ||
        "Retenu IBKR mais exclu après tri / slice finalDisplayedTarget (cartes primaires)",
    };
  }
  if (presentInBackendCandidates && !presentInEnriched) {
    return { lostAtStep: "ui_active_candidates", likelyReason: "Absent de la liste active (topN ou source)" };
  }
  if (presentInEnriched && expirationBlocks) {
    return {
      lostAtStep: "ui_expiration_filter",
      likelyReason: `Expiration embarquée ≠ expiration sélectionnée (${flags.selectedExpiration || "—"})`,
    };
  }
  if (presentInEnriched && uiFilterBlocks) {
    return {
      lostAtStep: "ui_verdict_filter",
      likelyReason: `Filtre UI actif (« ${flags.filter} ») masque ce ticker`,
    };
  }
  if (presentInEnriched && !presentInFilteredCards) {
    return {
      lostAtStep: "ui_search_filter",
      likelyReason: "Absent de filtered (recherche partielle ou tri — utiliser le ticker exact)",
    };
  }
  if (presentInFilteredCards && !presentInComboPool) {
    return {
      lostAtStep: "combo_pool",
      likelyReason:
        flags.comboExclusionReason ||
        "Carte visible mais non éligible au pool combinaisons capital (grade, yield, spread, IBKR rejeté)",
    };
  }
  if (presentInFilteredCards) {
    return { lostAtStep: null, likelyReason: "Présent dans les cartes filtrées du scan courant" };
  }
  return { lostAtStep: "unknown", likelyReason: "Parcours pipeline incomplet — vérifier les logs scan" };
}

/**
 * @param {string} ticker symbole normalisé
 * @param {object} sources snapshots read-only
 */
export function buildTickerPipelineDiagnostic(ticker, sources = {}) {
  const sym = normalizeSym(ticker);
  if (!sym) return null;

  const tickersForScan = sources.tickersForScan || [];
  const yahooReturnedCandidates = sources.yahooReturnedCandidates || [];
  const ibkrDirectSentTickers = sources.ibkrDirectSentTickers || [];
  const ibkrDirectResult = sources.ibkrDirectResult || null;
  const backendCandidates = sources.backendCandidates || [];
  const enrichedCandidates = sources.enrichedCandidates || [];
  const filtered = sources.filtered || [];
  const ibkrRejectedSymbols = sources.ibkrRejectedSymbols || new Set();
  const yahooRankMap = sources.yahooRankForIbkrBySymbol;

  const inPreScanPool = tickersForScan.some(
    (t) => normalizeSym(t) === sym
  );

  const yahooRow = findRowByTicker(yahooReturnedCandidates, sym);
  const presentInYahoo = yahooRow != null;
  let yahooRank = null;
  if (presentInYahoo) {
    const idx = yahooReturnedCandidates.findIndex(
      (r) => normalizeSym(r?.ticker || r?.symbol) === sym
    );
    yahooRank = Number.isFinite(Number(yahooRow?.rank))
      ? Number(yahooRow.rank)
      : idx >= 0
        ? idx + 1
        : null;
  }
  if (yahooRank == null && yahooRankMap) {
    const fromMap =
      yahooRankMap instanceof Map
        ? yahooRankMap.get(sym)
        : yahooRankMap?.[sym];
    if (Number.isFinite(Number(fromMap))) yahooRank = Number(fromMap);
  }

  const sentSet = new Set(
    (ibkrDirectSentTickers || []).map((t) => normalizeSym(t)).filter(Boolean)
  );
  const testedSet = new Set(
    (Array.isArray(ibkrDirectResult?.testedSymbols) ? ibkrDirectResult.testedSymbols : [])
      .map((t) => normalizeSym(t))
      .filter(Boolean)
  );
  const sentToIbkr = sentSet.has(sym);
  const ibkrTested = sentToIbkr || testedSet.has(sym);

  const ibkrShortlistRow = findRowByTicker(ibkrDirectResult?.shortlist, sym);
  const ibkrRejectedRow = findRowByTicker(ibkrDirectResult?.rejected, sym);
  const presentInIbkrShortlist = ibkrShortlistRow != null;
  const presentInIbkrRejected =
    ibkrRejectedSymbols.has(sym) || ibkrRejectedRow != null;

  const backendRow = findRowByTicker(backendCandidates, sym);
  const presentInBackendCandidates = backendRow != null;

  const enrichedRow =
    findRowByTicker(enrichedCandidates, sym) ||
    backendRow ||
    (presentInIbkrShortlist
      ? { ticker: sym, safeStrike: ibkrShortlistRow?.safeStrike, aggressiveStrike: ibkrShortlistRow?.aggressiveStrike }
      : null);

  const selectedExpiration = sources.selectedExpiration ?? null;
  const filter = sources.filter ?? "all";
  const expirationBlocks =
    enrichedRow != null && !candidateRowMatchesSelectedExpiration(enrichedRow, selectedExpiration);

  let uiFilterBlocks = false;
  if (enrichedRow && filter !== "all") {
    if (filter === "validated") uiFilterBlocks = enrichedRow.ok !== true;
    else uiFilterBlocks = enrichedRow.verdict !== filter;
  }

  const presentInEnriched = enrichedRow != null;
  const presentInFilteredCards = findRowByTicker(filtered, sym) != null;

  const usableCapital =
    Number(sources.capital) > 0
      ? Number(sources.capital) * (Number(sources.maxCapitalPct) / 100)
      : 0;

  let presentInComboPool = false;
  let comboExclusionReason = null;
  const comboSourceRow =
    findRowByTicker(filtered, sym) || findRowByTicker(enrichedCandidates, sym) || backendRow;
  if (comboSourceRow && !ibkrRejectedSymbols.has(sym)) {
    try {
      const built = buildCapitalComboCandidate(comboSourceRow, usableCapital);
      presentInComboPool = built?._isCapitalComboEligible === true;
      if (!presentInComboPool) {
        const reasons = built?._capitalComboExclusionReasons;
        comboExclusionReason = Array.isArray(reasons) && reasons.length
          ? reasons.slice(0, 3).join(" · ")
          : "non éligible (_isCapitalComboEligible false)";
      }
    } catch {
      comboExclusionReason = "erreur lecture éligibilité combo (données incomplètes)";
    }
  } else if (ibkrRejectedSymbols.has(sym)) {
    comboExclusionReason = "symbole dans ibkrRejectedSymbols";
  } else if (!comboSourceRow) {
    comboExclusionReason = "aucune carte source pour le combo";
  }

  const displayCandidate =
    findRowByTicker(filtered, sym) ||
    findRowByTicker(enrichedCandidates, sym) ||
    backendRow;

  let safeCandidateSummary = summarizeLeg(null, "SAFE", null);
  let aggressiveCandidateSummary = summarizeLeg(null, "AGGRESSIVE", null);
  let selectedMode = null;
  let finalStatus = "Absent du scan affiché";

  if (displayCandidate) {
    const rec = getFinalDisplayRecommendation(displayCandidate);
    selectedMode = rec.finalDisplayMode;
    finalStatus = resolveFinalStatusLabel(rec.finalDisplayMode, rec.finalDisplayGrade);
    const rawSafeGrade = displayCandidate.safeGrade;
    const rawAggressiveGrade = displayCandidate.aggressiveGrade;
    const isSafeSelected = rec.finalDisplayMode === "SAFE";
    const isAggSelected = rec.finalDisplayMode === "AGGRESSIVE";
    safeCandidateSummary = summarizeLeg(
      displayCandidate.safeStrike,
      "SAFE",
      buildLegGradeDisplay(
        isSafeSelected ? rec.finalDisplayGrade : rawSafeGrade,
        rawSafeGrade,
        isSafeSelected
      )
    );
    aggressiveCandidateSummary = summarizeLeg(
      displayCandidate.aggressiveStrike,
      "AGGRESSIVE",
      buildLegGradeDisplay(
        isAggSelected ? rec.finalDisplayGrade : rawAggressiveGrade,
        rawAggressiveGrade,
        isAggSelected
      )
    );
    if (isSafeSelected) safeCandidateSummary.status = `${safeCandidateSummary.status} (sélectionné)`;
    if (isAggSelected) aggressiveCandidateSummary.status = `${aggressiveCandidateSummary.status} (sélectionné)`;
  } else if (ibkrShortlistRow) {
    safeCandidateSummary = summarizeLeg(ibkrShortlistRow.safeStrike, "SAFE", null);
    aggressiveCandidateSummary = summarizeLeg(ibkrShortlistRow.aggressiveStrike, "AGGRESSIVE", null);
    finalStatus = "IBKR retenu — pas dans cartes primaires";
  } else if (yahooRow) {
    safeCandidateSummary = summarizeLeg(yahooRow.safeStrike, "SAFE", null);
    aggressiveCandidateSummary = summarizeLeg(yahooRow.aggressiveStrike, "AGGRESSIVE", null);
    finalStatus = "Yahoo seulement — IBKR non affiché";
  }

  const yahooRejectReason = !presentInYahoo ? resolveYahooAbsentReason(sym, sources) : null;
  const cryptoBlockReason = getCryptoBlockReason(sym);
  const preScanAbsentReason = !inPreScanPool ? resolvePreScanAbsentReason(sym, sources) : null;
  const pipelineTrace = buildTickerPipelineTraceSteps(sym, sources);
  const otmTraceability = resolveOtmProbeTraceability(sym, sources);

  const { lostAtStep, likelyReason } = computeLostAtStep({
    inPreScanPool,
    presentInYahoo,
    sentToIbkr,
    presentInIbkrShortlist,
    presentInIbkrRejected,
    ibkrTested,
    presentInBackendCandidates,
    presentInEnriched,
    presentInFilteredCards,
    presentInComboPool,
    uiFilterBlocks,
    expirationBlocks,
    ibkrRejectReason: ibkrRejectReason(ibkrRejectedRow),
    notDisplayedReason: sources.notDisplayedReason ?? null,
    comboExclusionReason,
    selectedExpiration,
    filter,
    yahooRejectReason,
    cryptoBlockReason,
    preScanAbsentReason,
  });

  return {
    ticker: sym,
    presentInYahoo,
    yahooRank,
    yahooStatus: yahooStatusFromRow(yahooRow),
    sentToIbkr,
    ibkrTested,
    presentInIbkrShortlist,
    presentInIbkrRejected,
    ibkrRejectReason: ibkrRejectReason(ibkrRejectedRow),
    presentInBackendCandidates,
    presentInEnriched,
    presentInFilteredCards,
    presentInComboPool,
    safeCandidateSummary,
    aggressiveCandidateSummary,
    selectedMode,
    finalStatus,
    lostAtStep,
    likelyReason,
    cryptoBlockReason,
    yahooRejectReason,
    preScanAbsentReason: preScanAbsentReason?.display ?? null,
    pipelineTrace,
    dataSource: sources.dataSource ?? null,
    topN: sources.topN ?? null,
    ibkrAutoMaxTickers: sources.ibkrAutoMaxTickers ?? null,
    ...(displayCandidate?.safeSpreadRescue ?? displayCandidate?.recommendationDiagnostics ?? {}),
    ...otmTraceability,
  };
}
