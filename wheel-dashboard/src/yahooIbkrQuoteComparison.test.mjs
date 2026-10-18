import assert from "node:assert/strict";
import test from "node:test";

import {
  compareYahooIbkrQuotes,
  contractIdentityFromSide,
  marketDataKind,
  projectObservedQuoteSide,
} from "./yahooIbkrQuoteComparison.js";

const baseYahoo = {
  symbol: "TQQQ",
  expiration: "2026-10-23",
  right: "P",
  strike: 50,
  multiplier: "100",
  bid: 0.8,
  ask: 0.9,
  marketDataType: "yahoo_delayed",
};
const baseIbkr = {
  symbol: "TQQQ",
  expiration: "2026-10-23",
  right: "P",
  strike: 50,
  multiplier: "100",
  bid: 0.81,
  ask: 0.91,
  marketDataType: "live",
};

test("comparable_consistent sur le même contrat", () => {
  const r = compareYahooIbkrQuotes({ yahoo: baseYahoo, ibkr: baseIbkr });
  assert.equal(r.class, "comparable_consistent");
  assert.equal(r.delayedVsRealtime, true);
});

test("yahoo_unusable_ibkr_usable", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, bid: 0, ask: 0.9 },
    ibkr: baseIbkr,
  });
  assert.equal(r.class, "yahoo_unusable_ibkr_usable");
});

test("bid absent n'est pas un zéro et reste INSUFFICIENT_DATA", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: baseYahoo,
    ibkr: { ...baseIbkr, bid: null, ask: 0.9 },
  });
  assert.equal(r.class, "insufficient_data");
  assert.equal(r.reason, "quote_fields_absent");
  assert.equal(r.observed.ibkr.bidPresent, false);
  assert.notEqual(r.class, "ibkr_unusable_yahoo_usable");
});

test("zéro réel observé est inutilisable, pas une absence", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, bid: 0, ask: 0.9 },
    ibkr: baseIbkr,
  });
  assert.equal(r.class, "yahoo_unusable_ibkr_usable");
  assert.equal(r.reason, "yahoo_bid_zero");
  assert.equal(r.observed.yahoo.bid, 0);
  assert.equal(r.observed.yahoo.bidPresent, true);
});

test("ask absent ou marché croisé", () => {
  const partial = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, ask: null },
    ibkr: baseIbkr,
  });
  assert.equal(partial.class, "insufficient_data");
  const crossed = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, bid: 1.2, ask: 0.4 },
    ibkr: baseIbkr,
  });
  assert.equal(crossed.class, "yahoo_unusable_ibkr_usable");
  assert.equal(crossed.reason, "yahoo_crossed_market");
});

test("PUT et CALL incompatibles", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, right: "C" },
    ibkr: baseIbkr,
  });
  assert.equal(r.class, "not_comparable");
  assert.equal(r.reason, "contract_identity_mismatch");
});

test("droit, strike ou expiration absents → INSUFFICIENT_DATA", () => {
  assert.equal(
    compareYahooIbkrQuotes({ yahoo: { ...baseYahoo, right: null }, ibkr: baseIbkr }).class,
    "insufficient_data"
  );
  assert.equal(
    compareYahooIbkrQuotes({ yahoo: { ...baseYahoo, strike: null }, ibkr: baseIbkr }).class,
    "insufficient_data"
  );
  assert.equal(
    compareYahooIbkrQuotes({ yahoo: { ...baseYahoo, expiration: null }, ibkr: baseIbkr }).class,
    "insufficient_data"
  );
});

test("expirations différentes et multiplicateurs incompatibles", () => {
  assert.equal(
    compareYahooIbkrQuotes({
      yahoo: { ...baseYahoo, expiration: "2026-10-30" },
      ibkr: baseIbkr,
    }).class,
    "not_comparable"
  );
  assert.equal(
    compareYahooIbkrQuotes({
      yahoo: { ...baseYahoo, multiplier: "100" },
      ibkr: { ...baseIbkr, multiplier: 10 },
    }).class,
    "not_comparable"
  );
  assert.equal(
    compareYahooIbkrQuotes({
      yahoo: { ...baseYahoo, multiplier: null },
      ibkr: baseIbkr,
    }).class,
    "insufficient_data"
  );
});

test("horodatage absent et type ambigu ne deviennent pas différé", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, marketDataType: "unspecified", timestamp: null },
    ibkr: { ...baseIbkr, marketDataType: "live", timestamp: "2026-10-16T14:00:00Z" },
  });
  assert.equal(r.delayedVsRealtime, false);
  assert.equal(r.timestamps.yahoo.present, false);
  assert.equal(r.timestamps.ibkr.present, true);
  assert.equal(marketDataKind("yahoo").kind, "UNKNOWN");
  assert.equal(marketDataKind("2").kind, "frozen");
  assert.equal(marketDataKind("3").kind, "delayed");
});

test("projection n'invente ni PUT, ni différé, ni bid synthétique", () => {
  const side = projectObservedQuoteSide({
    symbol: "IONQ",
    strike: 20,
    conservativePremium: 1.25,
    bid: null,
    ask: 1.4,
  });
  assert.equal(side.right, null);
  assert.equal(side.marketDataType, null);
  assert.equal(side.bid, null);
  assert.equal(side.ask, 1.4);
  const compared = compareYahooIbkrQuotes({ yahoo: side, ibkr: { ...baseIbkr, symbol: "IONQ", strike: 20 } });
  assert.equal(compared.class, "insufficient_data");
});

test("price_divergence sans différé vs live n'est pas une erreur de type", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, bid: 0.4, ask: 0.5, marketDataType: "live" },
    ibkr: { ...baseIbkr, bid: 0.9, ask: 1.0, marketDataType: "live" },
  });
  assert.equal(r.class, "price_divergence");
});

test("différé vs temps réel avec écart de prix → not_comparable, pas une erreur", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, bid: 0.4, ask: 0.5 },
    ibkr: { ...baseIbkr, bid: 0.9, ask: 1.0, marketDataType: "live" },
  });
  assert.equal(r.class, "not_comparable");
  assert.equal(r.reason, "price_diff_delayed_vs_realtime_not_an_error");
  assert.equal(r.delayedVsRealtime, true);
});

test("contrats non appariés → not_comparable", () => {
  const r = compareYahooIbkrQuotes({
    yahoo: { ...baseYahoo, strike: 45 },
    ibkr: baseIbkr,
  });
  assert.equal(r.class, "not_comparable");
});

test("insufficient_data si un côté manque dans l'export", () => {
  const r = compareYahooIbkrQuotes({ yahoo: baseYahoo, ibkr: null });
  assert.equal(r.class, "insufficient_data");
  assert.match(r.note, /Absence dans l'export/);
});

test("contractIdentityFromSide normalise PUT et expiration compacte", () => {
  const id = contractIdentityFromSide({ symbol: "aapl", expiration: "20261023", right: "PUT", strike: "12" });
  assert.equal(id.symbol, "AAPL");
  assert.equal(id.expiration, "2026-10-23");
  assert.equal(id.right, "P");
  assert.equal(id.strike, 12);
});
