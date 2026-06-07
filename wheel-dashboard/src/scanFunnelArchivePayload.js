/**
 * scanFunnelArchivePayload — helper PUR (sans I/O, sans React) qui transforme les
 * données déjà disponibles côté dashboard en un payload compact pour l'archive
 * forensic du funnel (POST /scan-funnel/archive).
 *
 * Principes :
 *   - Aucun refetch Yahoo/IBKR : on ne lit que ce que le dashboard a déjà calculé.
 *   - Aucun rawJson, aucune chaîne d'options, aucun greek complet.
 *   - Events terminaux utiles uniquement, dédupliqués par symbol+stage, cap 800.
 *
 * Stages Phase 1 :
 *   crypto_blocked · watchlist_rejected · yahoo_rejected · yahoo_returned ·
 *   ibkr_sent · ibkr_rejected · ibkr_retained · ui_lost · ui_displayed
 */

export const MAX_FUNNEL_EVENTS = 800;

/**
 * Plafond spécifique aux watchlist_rejected. Sans lui, excluded_by_watchlist_limit
 * remplit presque toute l'archive et écrase les events proches de la décision finale.
 */
export const MAX_WATCHLIST_REJECTED_EVENTS = 250;

/**
 * Ordre de priorité des stages dans l'archive (Phase 1B). On garde d'abord les
 * étapes proches de la décision finale (UI/IBKR), puis Yahoo, puis crypto, puis
 * watchlist_rejected en dernier. Le slice du cap 800 coupe donc les stages les
 * moins utiles au diagnostic « pourquoi tel ticker n'est pas apparu ? ».
 */
export const FUNNEL_STAGE_PRIORITY = [
  "ui_displayed",
  "ui_lost",
  "ibkr_retained",
  "ibkr_rejected",
  "ibkr_sent",
  "yahoo_returned",
  "yahoo_rejected",
  "crypto_blocked",
  "watchlist_rejected",
];

function normalizeSymbol(symbol) {
  return String(symbol ?? "").trim().toUpperCase();
}

function toSymbolList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeSymbol).filter(Boolean);
}

/** Extrait une raison lisible d'une valeur de map (string | objet). */
function reasonOf(value) {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    return s === "" ? null : s;
  }
  if (typeof value === "object") {
    const r =
      value.reason ??
      value.rejectionReason ??
      value.rejectReason ??
      value.message ??
      value.label ??
      null;
    if (r == null) return null;
    const s = String(r).trim();
    return s === "" ? null : s;
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

function toFiniteOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Itère une map symbol→valeur en normalisant la clé. */
function entriesOfMap(map) {
  if (!map || typeof map !== "object") return [];
  return Object.entries(map)
    .map(([k, v]) => [normalizeSymbol(k), v])
    .filter(([k]) => Boolean(k));
}

/**
 * Construit la liste d'events terminaux.
 * @returns {Array<{symbol,stage,reason,rank,sentToIbkr,ibkrOutcome,metadata}>}
 */
function buildEvents(sources) {
  const cryptoSet = new Set(toSymbolList(sources.cryptoBlockedRemovedSymbols));
  // Dédup global par "SYMBOL stage" : une ligne par couple max.
  const seen = new Set();
  const events = [];

  const push = (symbol, stage, extra = {}) => {
    const sym = normalizeSymbol(symbol);
    if (!sym || !stage) return;
    // Crypto est terminal et exclusif : un ticker crypto bloqué n'émet que crypto_blocked.
    if (cryptoSet.has(sym) && stage !== "crypto_blocked") return;
    const key = `${sym} ${stage}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({
      symbol: sym,
      stage,
      reason: extra.reason ?? null,
      rank: extra.rank ?? null,
      sentToIbkr: extra.sentToIbkr ?? null,
      ibkrOutcome: extra.ibkrOutcome ?? null,
      metadata: extra.metadata ?? null,
    });
  };

  // 1. crypto_blocked (précédence absolue)
  for (const sym of cryptoSet) {
    push(sym, "crypto_blocked", { reason: "crypto_blocked" });
  }

  // 2. watchlist_rejected
  for (const [sym, val] of entriesOfMap(sources.watchlistRejectedBySymbol)) {
    push(sym, "watchlist_rejected", { reason: reasonOf(val) });
  }

  // 3. yahoo_rejected
  for (const [sym, val] of entriesOfMap(sources.yahooRejectedBySymbol)) {
    push(sym, "yahoo_rejected", { reason: reasonOf(val) });
  }

  // 4. Funnel rows (Yahoo → IBKR) : yahoo_returned / ibkr_sent / ibkr_rejected / ibkr_retained
  const funnelRows = Array.isArray(sources.funnelRows)
    ? sources.funnelRows
    : Array.isArray(sources.yahooIbkrFunnelList)
      ? sources.yahooIbkrFunnelList
      : [];
  for (const row of funnelRows) {
    const sym = normalizeSymbol(row?.ticker ?? row?.symbol);
    if (!sym) continue;
    const rank = toFiniteOrNull(row?.yahooRank);
    const sentIbkr = row?.sentIbkr === true;
    const status = String(row?.ibkrStatus ?? "").trim().toLowerCase();

    if (row?.inShortlist === true || sentIbkr || status === "retained" || status === "rejected") {
      push(sym, "yahoo_returned", { rank });
    }
    if (sentIbkr || row?.testedIbkr === true) {
      push(sym, "ibkr_sent", { rank, sentToIbkr: true });
    }
    if (status === "rejected") {
      push(sym, "ibkr_rejected", { rank, sentToIbkr: true, ibkrOutcome: "rejected", reason: reasonOf(row?.reason) });
    } else if (status === "retained") {
      push(sym, "ibkr_retained", { rank, sentToIbkr: true, ibkrOutcome: "retained" });
    }
  }

  // 5. IBKR direct (fallback / complément quand funnelRows incomplet)
  for (const sym of toSymbolList(sources.ibkrDirectSentTickers)) {
    push(sym, "ibkr_sent", { sentToIbkr: true });
  }
  const ibkrResult = sources.ibkrDirectResult && typeof sources.ibkrDirectResult === "object"
    ? sources.ibkrDirectResult
    : null;
  if (ibkrResult) {
    for (const r of Array.isArray(ibkrResult.shortlist) ? ibkrResult.shortlist : []) {
      push(r?.symbol ?? r?.ticker, "ibkr_retained", { sentToIbkr: true, ibkrOutcome: "retained" });
    }
    for (const r of Array.isArray(ibkrResult.rejected) ? ibkrResult.rejected : []) {
      push(r?.symbol ?? r?.ticker, "ibkr_rejected", {
        sentToIbkr: true,
        ibkrOutcome: "rejected",
        reason: reasonOf(r),
      });
    }
  }

  // 6. ui_displayed + ui_lost
  const displayedSet = new Set(toSymbolList(sources.displayedSymbols));
  for (const sym of displayedSet) {
    push(sym, "ui_displayed");
  }
  // Retenus IBKR mais absents de l'UI = ui_lost.
  const retainedSet = new Set(
    events.filter((e) => e.stage === "ibkr_retained").map((e) => e.symbol)
  );
  for (const sym of retainedSet) {
    if (!displayedSet.has(sym)) {
      push(sym, "ui_lost", { reason: "retained_not_displayed" });
    }
  }

  return prioritizeEvents(events);
}

/**
 * Priorise et plafonne les events avant archivage (Phase 1B).
 *
 *   1. Regroupe par stage en conservant l'ordre d'insertion.
 *   2. Limite watchlist_rejected à MAX_WATCHLIST_REJECTED_EVENTS.
 *   3. Réémet selon FUNNEL_STAGE_PRIORITY puis tronque à MAX_FUNNEL_EVENTS.
 *
 * Tout stage inconnu (défensif) est ajouté en queue, avant le cap, pour ne pas
 * perdre silencieusement un futur stage.
 */
function prioritizeEvents(events) {
  const byStage = new Map();
  for (const e of events) {
    let bucket = byStage.get(e.stage);
    if (!bucket) {
      bucket = [];
      byStage.set(e.stage, bucket);
    }
    bucket.push(e);
  }

  const ordered = [];
  const emit = (bucket) => {
    if (!bucket) return;
    for (const e of bucket) {
      if (ordered.length >= MAX_FUNNEL_EVENTS) return;
      ordered.push(e);
    }
  };

  for (const stage of FUNNEL_STAGE_PRIORITY) {
    let bucket = byStage.get(stage);
    if (stage === "watchlist_rejected" && bucket && bucket.length > MAX_WATCHLIST_REJECTED_EVENTS) {
      bucket = bucket.slice(0, MAX_WATCHLIST_REJECTED_EVENTS);
    }
    emit(bucket);
  }

  // Stages non répertoriés (sécurité forward-compat) : ajoutés après les connus.
  for (const [stage, bucket] of byStage) {
    if (FUNNEL_STAGE_PRIORITY.includes(stage)) continue;
    emit(bucket);
  }

  return ordered;
}

/** Compteurs dérivés des events (complétés/écrasés par les counts fournis). */
function deriveCounts(events) {
  const c = {
    cryptoBlockedCount: 0,
    watchlistRejectedCount: 0,
    yahooRejectedCount: 0,
    yahooReturnedCount: 0,
    ibkrSentCount: 0,
    ibkrRejectedCount: 0,
    ibkrRetainedCount: 0,
    uiLostCount: 0,
    uiDisplayedCount: 0,
  };
  for (const e of events) {
    switch (e.stage) {
      case "crypto_blocked": c.cryptoBlockedCount += 1; break;
      case "watchlist_rejected": c.watchlistRejectedCount += 1; break;
      case "yahoo_rejected": c.yahooRejectedCount += 1; break;
      case "yahoo_returned": c.yahooReturnedCount += 1; break;
      case "ibkr_sent": c.ibkrSentCount += 1; break;
      case "ibkr_rejected": c.ibkrRejectedCount += 1; break;
      case "ibkr_retained": c.ibkrRetainedCount += 1; break;
      case "ui_lost": c.uiLostCount += 1; break;
      case "ui_displayed": c.uiDisplayedCount += 1; break;
      default: break;
    }
  }
  return c;
}

/** Nettoie l'objet metadata : supprime les clés volumineuses/interdites. */
function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const FORBIDDEN = new Set(["rawJson", "optionChain", "options", "greeks", "chain"]);
  const out = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Construit le payload compact d'archive funnel.
 * @param {object} sources  données disponibles côté dashboard
 * @returns {{scanSessionId:string|null, scanTimestamp:string|null, selectedExpiration:string|null,
 *   dteAtScan:number|null, poolSource:string|null, captureSource:string|null,
 *   counts:object, metadata:object, events:Array}}
 */
export function buildScanFunnelArchivePayload(sources = {}) {
  const events = buildEvents(sources);
  const derived = deriveCounts(events);
  const providedCounts =
    sources.counts && typeof sources.counts === "object" ? sources.counts : {};
  const counts = { ...derived, ...providedCounts };

  const metadata = sanitizeMetadata(sources.metadata);
  if (metadata.archiveComplete === undefined) {
    metadata.archiveComplete = Boolean(sources.scanSessionId);
  }

  return {
    scanSessionId: sources.scanSessionId != null ? String(sources.scanSessionId) : null,
    scanTimestamp: sources.scanTimestamp != null ? String(sources.scanTimestamp) : null,
    selectedExpiration:
      sources.selectedExpiration != null ? String(sources.selectedExpiration) : null,
    dteAtScan: toFiniteOrNull(sources.dteAtScan),
    poolSource: sources.poolSource != null ? String(sources.poolSource) : null,
    captureSource: sources.captureSource != null ? String(sources.captureSource) : null,
    counts,
    metadata,
    events,
  };
}

export default buildScanFunnelArchivePayload;
