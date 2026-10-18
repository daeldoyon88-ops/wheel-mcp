/**
 * Observations forensic — helpers PURS, sans décision financière.
 *
 * Rôle : préserver la distinction entre
 *   - donnée absente (null / undefined / chaîne vide),
 *   - donnée non numérique,
 *   - véritable zéro reçu,
 *   - valeur finie,
 * et relayer, sans recalcul, les diagnostics déjà produits par le moteur IBKR
 * (motif d'arrêt Progressive SAFE, étape d'échec, type de données, trace de
 * cotations bornée, erreurs IBKR). Aucun appel réseau, aucune requête.
 *
 * Unités : les spreads relayés depuis le moteur Python sont des FRACTIONS
 * (0.75 = 75 %). Ils ne sont pas convertis ici ; ils sont déclarés.
 */

export const FORENSIC_SCHEMA_VERSION = "ibkr_rejection_forensics_v2";

export const FORENSIC_UNITS = Object.freeze({
  aggressiveSpreadPct: "fraction_0_to_1",
  bestSafeSpreadPct: "fraction_0_to_1",
  "topPutCandidatesSummary[].spreadPct": "fraction_0_to_1",
  aggressiveYieldPct: "percent",
  bestSafeYieldPct: "percent",
  aggressiveOtmPct: "percent",
  bestSafeOtmPct: "percent",
  premiumDeficitPct: "percent",
  premiumCoveragePct: "percent",
  premiumDeficitDollar: "usd_per_share",
  underlyingPrice: "usd",
  lowerBound: "usd",
  targetPremium: "usd_per_share",
  aggressiveBid: "usd_per_share",
  aggressiveAsk: "usd_per_share",
  aggressiveMid: "usd_per_share",
  aggressivePrimeUsed: "usd_per_share",
  bestSafeBid: "usd_per_share",
  bestSafeAsk: "usd_per_share",
  bestSafeMid: "usd_per_share",
  bestSafePrimeUsed: "usd_per_share",
  aggressiveStrikeValue: "usd",
  bestSafeStrike: "usd",
  durationMs: "milliseconds",
  "forensicTrace.quoteTrace[].requestedAtMs": "milliseconds_since_ticker_start",
  "forensicTrace.quoteTrace[].observedAtMs": "milliseconds_since_ticker_start",
});

/** Valeur absente au sens forensic : null, undefined ou chaîne vide/blanche. */
export function isAbsentObservation(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/**
 * Nombre fini arrondi, ou null si absent / non numérique / non fini.
 * Un vrai zéro reçu reste 0. Contrairement à Number(null) === 0, null et "" donnent null.
 */
export function finiteObservationOrNull(value, decimals = 6) {
  if (isAbsentObservation(value)) return null;
  if (typeof value === "boolean") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return +n.toFixed(decimals);
}

/** Nombre fini strictement positif, ou null (un strike ne peut pas valoir 0). */
export function positiveFiniteOrNull(value, decimals = 6) {
  const n = finiteObservationOrNull(value, decimals);
  return n != null && n > 0 ? n : null;
}

/**
 * Classe une valeur de cotation telle que reçue.
 * @returns {"absent"|"non_numeric"|"zero"|"negative"|"positive"}
 */
export function classifyQuoteValue(value) {
  if (isAbsentObservation(value)) return "absent";
  const n = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(n)) return "non_numeric";
  if (n === 0) return "zero";
  if (n < 0) return "negative";
  return "positive";
}

/**
 * Décrit une paire bid/ask sans l'altérer. `usable` suit la règle Wheel
 * conservatrice : bid strictement positif et ask (s'il existe) non inférieur au bid.
 */
export function describeQuoteObservation(bid, ask) {
  const bidStatus = classifyQuoteValue(bid);
  const askStatus = classifyQuoteValue(ask);
  let unusableReason = null;
  if (bidStatus === "absent") unusableReason = "bid_absent";
  else if (bidStatus === "non_numeric") unusableReason = "bid_non_numeric";
  else if (bidStatus === "zero") unusableReason = "bid_zero";
  else if (bidStatus === "negative") unusableReason = "bid_negative";
  else if (askStatus === "positive" && Number(ask) < Number(bid)) unusableReason = "ask_below_bid";
  else if (askStatus === "negative") unusableReason = "ask_negative";
  return { bidStatus, askStatus, usable: unusableReason == null, unusableReason };
}

const QUOTE_TRACE_FIELDS = Object.freeze([
  "seq", "stage", "role", "conId", "localSymbol", "secType", "right", "strike", "expiration",
  "multiplier", "exchange", "reqId", "requestedAtMs", "observedAtMs", "bidRaw", "askRaw",
  "bidSize", "askSize", "last", "close", "bidStatus", "askStatus", "usable", "unusableReason",
  "tickTime", "marketDataTypeObserved", "marketDataTypeObservedLabel",
]);

const ERROR_EVENT_FIELDS = Object.freeze([
  "atMs", "reqId", "errorCode", "errorString", "conId", "localSymbol", "secType", "strike", "right",
]);

function pickFields(obj, fields) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const key of fields) if (Object.hasOwn(obj, key)) out[key] = obj[key];
  return out;
}

/**
 * Projection bornée de `forensicTrace` émis par le moteur Python.
 * Ne fabrique rien : champs absents → absents ; `truncated` relayé tel quel.
 */
export function projectForensicTrace(trace, { maxQuoteEntries = 24, maxErrorEvents = 30 } = {}) {
  if (!trace || typeof trace !== "object") return null;
  const quoteTrace = Array.isArray(trace.quoteTrace)
    ? trace.quoteTrace.slice(0, maxQuoteEntries).map((e) => pickFields(e, QUOTE_TRACE_FIELDS))
    : [];
  const ibkrErrorEvents = Array.isArray(trace.ibkrErrorEvents)
    ? trace.ibkrErrorEvents.slice(0, maxErrorEvents).map((e) => pickFields(e, ERROR_EVENT_FIELDS))
    : [];
  return {
    schemaVersion: trace.schemaVersion ?? null,
    quoteTrace,
    quoteTraceCount: Number.isFinite(Number(trace.quoteTraceCount)) ? Number(trace.quoteTraceCount) : quoteTrace.length,
    quoteTraceTruncated: trace.quoteTraceTruncated === true || quoteTrace.length < (Array.isArray(trace.quoteTrace) ? trace.quoteTrace.length : 0),
    ibkrErrorEvents,
    ibkrErrorEventCount: Number.isFinite(Number(trace.ibkrErrorEventCount)) ? Number(trace.ibkrErrorEventCount) : ibkrErrorEvents.length,
    ibkrErrorEventsTruncated: trace.ibkrErrorEventsTruncated === true,
    marketDataTypesObserved: Array.isArray(trace.marketDataTypesObserved) ? trace.marketDataTypesObserved : [],
  };
}

const EM_OPTION_FIELDS = Object.freeze([
  "role", "right", "strike", "bid", "ask", "mid", "primeUsed", "primeReason", "conId", "localSymbol", "reason",
]);

/**
 * Diagnostics IBKR déjà produits, relayés par symbole (rejets ET retenus).
 * Toute valeur absente reste null/absente ; `unknown` reste `unknown`.
 */
export function pickIbkrForensicDiagnostics(row) {
  if (!row || typeof row !== "object") return {};
  const m = row.ibkrCallMetrics && typeof row.ibkrCallMetrics === "object" ? row.ibkrCallMetrics : {};
  const emOptions = Array.isArray(row.expectedMoveOptions) ? row.expectedMoveOptions : null;
  return {
    forensicSchemaVersion: FORENSIC_SCHEMA_VERSION,
    errorDetail: row.errorDetail ?? null,
    failureStage: row.failureStage ?? null,
    safeSelectionReason: row.safeSelectionReason ?? null,
    safeScanStoppedReason: m.safeScanStoppedReason ?? null,
    safeScanStoppedAtStrike: positiveFiniteOrNull(m.safeScanStoppedAtStrike),
    safeScanLastAboveTargetStrike: positiveFiniteOrNull(m.safeScanLastAboveTargetStrike),
    lastSafeScanStage: m.lastSafeScanStage ?? null,
    validPutContractsChecked: finiteObservationOrNull(m.validPutContractsChecked, 0),
    unusablePutContractsQuoted: finiteObservationOrNull(m.unusablePutContractsQuoted, 0),
    putContractsQuotedTotal: finiteObservationOrNull(m.putContractsQuotedTotal, 0),
    rawPutStrikesExamined: finiteObservationOrNull(m.rawPutStrikesExamined, 0),
    invalidPutStrikesSkipped: finiteObservationOrNull(m.invalidPutStrikesSkipped, 0),
    unusableQuoteCount: finiteObservationOrNull(m.unusableQuoteCount, 0),
    unusableQuoteStreak: finiteObservationOrNull(m.unusableQuoteStreak, 0),
    maxValidPutContractsToProbe: finiteObservationOrNull(m.maxValidPutContractsToProbe, 0),
    softTimeoutTriggered: typeof m.softTimeoutTriggered === "boolean" ? m.softTimeoutTriggered : null,
    timeoutStageMetric: m.timeoutStage ?? null,
    marketDataTypeRequested: finiteObservationOrNull(row.marketDataTypeRequested, 0),
    marketDataTypeRequestedLabel: row.marketDataTypeRequestedLabel ?? null,
    marketDataTypeReceivedLabel: row.marketDataTypeReceivedLabel ?? "unknown",
    strikeValidation: row.strikeValidation && typeof row.strikeValidation === "object" ? row.strikeValidation : null,
    expectedMoveOptionsCount: emOptions ? emOptions.length : null,
    expectedMoveOptionsSummary: emOptions
      ? emOptions.slice(0, 8).map((o) => {
          const picked = pickFields(o, EM_OPTION_FIELDS) ?? {};
          return { ...picked, ...describeQuoteObservation(o?.bid, o?.ask) };
        })
      : null,
    forensicTrace: projectForensicTrace(row.forensicTrace),
    units: FORENSIC_UNITS,
  };
}
