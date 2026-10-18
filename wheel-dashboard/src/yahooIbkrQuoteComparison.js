/**
 * Comparaison Yahoo / IBKR — observabilité PURE.
 * Aucune requête, aucun recalcul financier. Uniquement des cotations déjà reçues.
 *
 * Une valeur absente n'est pas un zéro. Un droit, un type de marché ou une prime
 * synthétique ne sont jamais inventés. Une comparaison incomplète est
 * INSUFFICIENT_DATA, pas un défaut attribué au fournisseur.
 *
 * Classes :
 *   comparable_consistent
 *   yahoo_unusable_ibkr_usable
 *   ibkr_unusable_yahoo_usable
 *   price_divergence
 *   not_comparable
 *   insufficient_data
 */

const EXACT_MARKET_DATA_KIND = Object.freeze({
  live: "live",
  realtime: "live",
  "real-time": "live",
  "1": "live",
  frozen: "frozen",
  "2": "frozen",
  delayed: "delayed",
  delay: "delayed",
  yahoo_delayed: "delayed",
  "3": "delayed",
  "4": "delayed_frozen",
});

function blank(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function finitePresent(value) {
  if (blank(value)) return { present: false, value: null };
  const n = Number(value);
  if (!Number.isFinite(n)) return { present: false, value: null };
  return { present: true, value: n };
}

function ymd(value) {
  if (blank(value)) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function rightNorm(value) {
  if (blank(value)) return null;
  const s = String(value).trim().toUpperCase();
  if (s === "P" || s === "PUT") return "P";
  if (s === "C" || s === "CALL") return "C";
  return s;
}

function multiplierNorm(value) {
  if (blank(value)) return { present: false, value: null };
  const s = String(value).trim();
  const n = Number(s);
  if (Number.isFinite(n)) return { present: true, value: String(n) };
  return { present: true, value: s };
}

function timestampOf(side) {
  const raw = side?.timestamp ?? side?.quoteTimestamp ?? side?.asOf ?? null;
  if (blank(raw)) return { present: false, value: null };
  return { present: true, value: String(raw).trim() };
}

export function marketDataKind(value) {
  if (blank(value)) return { present: false, token: null, kind: "UNKNOWN" };
  const token = String(value).trim().toLowerCase();
  const kind = Object.hasOwn(EXACT_MARKET_DATA_KIND, token) ? EXACT_MARKET_DATA_KIND[token] : "UNKNOWN";
  return { present: true, token, kind };
}

function delayedVsLive(yahooKind, ibkrKind) {
  const known = new Set(["live", "frozen", "delayed", "delayed_frozen"]);
  if (!known.has(yahooKind) || !known.has(ibkrKind)) return false;
  const yahooLive = yahooKind === "live";
  const ibkrLive = ibkrKind === "live";
  return yahooLive !== ibkrLive;
}

/**
 * Projection fidèle : aucun PUT forcé, aucun type différé forcé,
 * aucune prime synthétique à la place du bid.
 * @param {Record<string, unknown>|null|undefined} raw
 */
export function projectObservedQuoteSide(raw) {
  if (!raw || typeof raw !== "object") return null;
  const bid = raw.bid;
  const ask = raw.ask;
  return {
    symbol: raw.symbol ?? raw.ticker ?? raw.underlying ?? null,
    expiration: raw.expiration ?? raw.returnedExpiration ?? null,
    returnedExpiration: raw.returnedExpiration ?? null,
    right: raw.right ?? raw.optionRight ?? null,
    strike: raw.strike ?? null,
    multiplier: raw.multiplier ?? null,
    bid: blank(bid) ? null : bid,
    ask: blank(ask) ? null : ask,
    marketDataType: raw.marketDataType ?? null,
    timestamp: raw.timestamp ?? raw.quoteTimestamp ?? raw.asOf ?? null,
    contractSymbol: raw.contractSymbol ?? null,
    localSymbol: raw.localSymbol ?? null,
  };
}

/**
 * Identité observée. Le droit manquant reste null.
 * @param {Record<string, unknown>|null|undefined} side
 */
export function contractIdentityFromSide(side) {
  if (!side || typeof side !== "object") return null;
  const symbol = String(side.symbol || side.ticker || side.underlying || "").trim().toUpperCase() || null;
  const expiration = ymd(side.expiration ?? side.returnedExpiration ?? side.lastTradeDateOrContractMonth);
  const right = rightNorm(side.right ?? side.optionRight ?? null);
  const strike = finitePresent(side.strike);
  const multiplier = multiplierNorm(side.multiplier);
  const localSymbol = blank(side.localSymbol) && blank(side.contractSymbol)
    ? null
    : String(side.localSymbol || side.contractSymbol).trim();
  const time = timestampOf(side);
  const dataType = marketDataKind(side.marketDataType);
  if (!symbol && !localSymbol && !strike.present && !expiration && !right) return null;
  return {
    symbol,
    expiration,
    right,
    strike: strike.present && strike.value > 0 ? strike.value : strike.present ? strike.value : null,
    strikePresent: strike.present && strike.value > 0,
    multiplier: multiplier.value,
    multiplierPresent: multiplier.present,
    localSymbol,
    timestamp: time.value,
    timestampPresent: time.present,
    marketDataType: dataType.present ? dataType.token : null,
    marketDataKind: dataType.kind,
    marketDataTypePresent: dataType.present,
  };
}

function identityStatus(a, b) {
  if (!a?.symbol || !b?.symbol) return "insufficient";
  if (a.symbol !== b.symbol) return "mismatch";
  if (!a.expiration || !b.expiration) return "insufficient";
  if (a.expiration !== b.expiration) return "mismatch";
  if (!a.right || !b.right) return "insufficient";
  if (a.right !== b.right) return "mismatch";
  if (!a.strikePresent || !b.strikePresent) return "insufficient";
  if (Math.abs(a.strike - b.strike) > 1e-9) return "mismatch";
  if (!a.multiplierPresent || !b.multiplierPresent) return "insufficient";
  if (a.multiplier !== b.multiplier) return "mismatch";
  return "match";
}

function quoteObservation(side) {
  const bid = finitePresent(side?.bid);
  const ask = finitePresent(side?.ask);
  if (!bid.present || !ask.present) {
    return {
      complete: false,
      usable: null,
      crossed: false,
      zeroBid: bid.present && bid.value === 0,
      bid: bid.present ? bid.value : null,
      ask: ask.present ? ask.value : null,
    };
  }
  const crossed = ask.value < bid.value;
  const usable = bid.value > 0 && ask.value >= bid.value;
  return {
    complete: true,
    usable,
    crossed,
    zeroBid: bid.value === 0,
    bid: bid.value,
    ask: ask.value,
  };
}

function observedSnapshot(side, identity, quote) {
  return {
    symbol: identity?.symbol ?? null,
    expiration: identity?.expiration ?? null,
    right: identity?.right ?? null,
    strike: identity?.strikePresent ? identity.strike : null,
    multiplier: identity?.multiplierPresent ? identity.multiplier : null,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    bidPresent: quote?.bid != null,
    askPresent: quote?.ask != null,
    timestamp: identity?.timestamp ?? null,
    timestampPresent: identity?.timestampPresent === true,
    marketDataType: identity?.marketDataType ?? null,
    marketDataKind: identity?.marketDataKind ?? "UNKNOWN",
  };
}

function result(fields) {
  return {
    comparable: false,
    yahooUsable: null,
    ibkrUsable: null,
    delayedVsRealtime: false,
    ...fields,
  };
}

/**
 * @param {{ yahoo?: object|null, ibkr?: object|null }} input
 */
export function compareYahooIbkrQuotes(input) {
  const yahoo = input?.yahoo && typeof input.yahoo === "object" ? input.yahoo : null;
  const ibkr = input?.ibkr && typeof input.ibkr === "object" ? input.ibkr : null;
  if (!yahoo && !ibkr) {
    return result({
      class: "insufficient_data",
      reason: "neither_provider_quote_present_in_export",
    });
  }
  if (!yahoo || !ibkr) {
    const yQuote = yahoo ? quoteObservation(yahoo) : null;
    const iQuote = ibkr ? quoteObservation(ibkr) : null;
    return result({
      class: "insufficient_data",
      reason: yahoo ? "ibkr_quote_absent_from_export" : "yahoo_quote_absent_from_export",
      yahooUsable: yQuote ? yQuote.usable : null,
      ibkrUsable: iQuote ? iQuote.usable : null,
      note: "Absence dans l'export Wheel n'est pas une preuve d'absence chez le fournisseur.",
      observed: {
        yahoo: yahoo ? observedSnapshot(yahoo, contractIdentityFromSide(yahoo), yQuote) : null,
        ibkr: ibkr ? observedSnapshot(ibkr, contractIdentityFromSide(ibkr), iQuote) : null,
      },
    });
  }

  const yId = contractIdentityFromSide(yahoo);
  const iId = contractIdentityFromSide(ibkr);
  const yQuote = quoteObservation(yahoo);
  const iQuote = quoteObservation(ibkr);
  const delayed = delayedVsLive(yId?.marketDataKind, iId?.marketDataKind);
  const observed = {
    yahoo: observedSnapshot(yahoo, yId, yQuote),
    ibkr: observedSnapshot(ibkr, iId, iQuote),
  };
  const timestamps = {
    yahoo: { present: yId?.timestampPresent === true, value: yId?.timestamp ?? null },
    ibkr: { present: iId?.timestampPresent === true, value: iId?.timestamp ?? null },
  };

  const identity = identityStatus(yId, iId);
  if (identity === "insufficient") {
    return result({
      class: "insufficient_data",
      reason: "contract_identity_incomplete",
      yahooUsable: yQuote.usable,
      ibkrUsable: iQuote.usable,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
      yahooIdentity: yId,
      ibkrIdentity: iId,
    });
  }
  if (identity === "mismatch") {
    return result({
      class: "not_comparable",
      reason: "contract_identity_mismatch",
      yahooUsable: yQuote.usable,
      ibkrUsable: iQuote.usable,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
      yahooIdentity: yId,
      ibkrIdentity: iId,
    });
  }

  if (!yQuote.complete || !iQuote.complete) {
    return result({
      class: "insufficient_data",
      reason: "quote_fields_absent",
      comparable: false,
      yahooUsable: yQuote.usable,
      ibkrUsable: iQuote.usable,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
      note: "Un bid ou un ask absent n'est pas un zéro et ne prouve pas une cotation inutilisable.",
    });
  }

  if (!yQuote.usable && iQuote.usable) {
    return result({
      class: "yahoo_unusable_ibkr_usable",
      reason: yQuote.crossed ? "yahoo_crossed_market" : yQuote.zeroBid ? "yahoo_bid_zero" : "yahoo_quote_unusable_ibkr_quote_usable",
      comparable: true,
      yahooUsable: false,
      ibkrUsable: true,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
    });
  }
  if (yQuote.usable && !iQuote.usable) {
    return result({
      class: "ibkr_unusable_yahoo_usable",
      reason: iQuote.crossed ? "ibkr_crossed_market" : iQuote.zeroBid ? "ibkr_bid_zero" : "ibkr_quote_unusable_yahoo_quote_usable",
      comparable: true,
      yahooUsable: true,
      ibkrUsable: false,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
    });
  }
  if (!yQuote.usable && !iQuote.usable) {
    return result({
      class: "insufficient_data",
      reason: "both_quotes_unusable",
      comparable: true,
      yahooUsable: false,
      ibkrUsable: false,
      delayedVsRealtime: delayed,
      timestamps,
      observed,
    });
  }

  const bidDelta = Math.abs(yQuote.bid - iQuote.bid);
  const askDelta = Math.abs(yQuote.ask - iQuote.ask);
  const threshold = Math.max(0.02, 0.05 * Math.min(yQuote.bid, iQuote.bid));
  const diverges = bidDelta > threshold || askDelta > threshold;

  if (diverges) {
    return result({
      class: delayed ? "not_comparable" : "price_divergence",
      reason: delayed
        ? "price_diff_delayed_vs_realtime_not_an_error"
        : "price_divergence_on_comparable_contract",
      comparable: !delayed,
      yahooUsable: true,
      ibkrUsable: true,
      delayedVsRealtime: delayed,
      bidDelta,
      askDelta,
      timestamps,
      observed,
    });
  }

  return result({
    class: "comparable_consistent",
    reason: delayed ? "consistent_within_delayed_vs_realtime_tolerance" : "quotes_consistent",
    comparable: true,
    yahooUsable: true,
    ibkrUsable: true,
    delayedVsRealtime: delayed,
    bidDelta,
    askDelta,
    timestamps,
    observed,
  });
}
