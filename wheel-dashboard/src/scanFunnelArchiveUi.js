/** Stages funnel archivés — ordre d'affichage (liste groupée + chaîne ticker). */
export const FUNNEL_ARCHIVE_STAGE_ORDER = [
  "ui_displayed",
  "ibkr_retained",
  "ibkr_rejected",
  "ibkr_sent",
  "yahoo_returned",
  "yahoo_rejected",
  "crypto_blocked",
  "watchlist_rejected",
  "ui_lost",
];

/** Ordre chronologique pour la chaîne d'un ticker (du pool vers l'UI). */
export const FUNNEL_TICKER_CHAIN_ORDER = [
  "watchlist_rejected",
  "crypto_blocked",
  "yahoo_rejected",
  "yahoo_returned",
  "ibkr_sent",
  "ibkr_rejected",
  "ibkr_retained",
  "ui_lost",
  "ui_displayed",
];

export const FUNNEL_STAGE_LABEL_FR = {
  ui_displayed: "UI affiché",
  ibkr_retained: "IBKR retenu",
  ibkr_rejected: "IBKR rejeté",
  ibkr_sent: "IBKR envoyé",
  yahoo_returned: "Yahoo retourné",
  yahoo_rejected: "Yahoo rejeté",
  crypto_blocked: "Crypto bloqué",
  watchlist_rejected: "Watchlist rejeté",
  ui_lost: "Retenu non affiché",
};

export function funnelStageLabel(stage) {
  return FUNNEL_STAGE_LABEL_FR[stage] || stage || "—";
}

/** Date ISO → format court français lisible. */
export function formatFunnelArchiveTimestamp(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function funnelArchiveCount(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : String(value);
}

export function normalizeFunnelTickerQuery(raw) {
  return String(raw ?? "").trim().toUpperCase();
}

/** Compte les events par stage. */
export function countEventsByStage(events) {
  const counts = {};
  if (!Array.isArray(events)) return counts;
  for (const e of events) {
    const stage = e?.stage;
    if (!stage) continue;
    counts[stage] = (counts[stage] || 0) + 1;
  }
  return counts;
}

/** Groupe les symboles uniques par stage (ordre d'apparition conservé). */
export function groupSymbolsByStage(events) {
  const out = {};
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    const stage = e?.stage;
    const symbol = String(e?.symbol ?? "").trim().toUpperCase();
    if (!stage || !symbol) continue;
    if (!out[stage]) out[stage] = [];
    if (!out[stage].includes(symbol)) out[stage].push(symbol);
  }
  return out;
}

/**
 * Résumé session : counts session + dérivés depuis events si calculables.
 * @param {object} session — ligne scan_funnel_sessions (snake_case API)
 * @param {Array} events
 */
export function buildFunnelSessionSummary(session, events) {
  const stageCounts = countEventsByStage(events);
  const ibkrRetained = Number(session?.ibkr_retained_count);
  const uiDisplayed = Number(session?.ui_displayed_count);
  const retainedNotDisplayed =
    Number.isFinite(ibkrRetained) && Number.isFinite(uiDisplayed)
      ? Math.max(0, ibkrRetained - uiDisplayed)
      : null;

  return {
    preIbkr: session?.pre_ibkr_count ?? null,
    yahooReturned: session?.yahoo_returned_count ?? null,
    yahooRejected: stageCounts.yahoo_rejected ?? null,
    cryptoBlocked: stageCounts.crypto_blocked ?? null,
    watchlistRejected: stageCounts.watchlist_rejected ?? null,
    ibkrSent: session?.ibkr_sent_count ?? null,
    ibkrRetained: session?.ibkr_retained_count ?? null,
    ibkrRejected: session?.ibkr_rejected_count ?? null,
    uiDisplayed: session?.ui_displayed_count ?? null,
    retainedNotDisplayed,
    eventTotal: Array.isArray(events) ? events.length : null,
  };
}

function stageSortIndex(stage, order) {
  const idx = order.indexOf(stage);
  return idx === -1 ? order.length + 1 : idx;
}

/** Events d'un ticker triés selon le parcours funnel. */
export function getTickerFunnelChain(events, symbol) {
  const sym = normalizeFunnelTickerQuery(symbol);
  if (!sym || !Array.isArray(events)) return [];
  return events
    .filter((e) => String(e?.symbol ?? "").trim().toUpperCase() === sym)
    .slice()
    .sort(
      (a, b) =>
        stageSortIndex(a.stage, FUNNEL_TICKER_CHAIN_ORDER) -
        stageSortIndex(b.stage, FUNNEL_TICKER_CHAIN_ORDER)
    );
}

/** archiveComplete depuis metadata session. */
export function isFunnelArchiveComplete(session) {
  if (session?.metadata?.archiveComplete === true) return true;
  if (session?.metadata?.archiveComplete === false) return false;
  return null;
}
