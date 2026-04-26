import { toNumber } from "../utils/number.js";

export function adaptIbkrQuoteToMarketServiceShape(rawQuote) {
  const symbol = String(rawQuote?.symbol || "").trim().toUpperCase();
  const last = toNumber(rawQuote?.last);
  const close = toNumber(rawQuote?.close);
  const bid = toNumber(rawQuote?.bid);
  const ask = toNumber(rawQuote?.ask);
  const volume = toNumber(rawQuote?.volume);

  return {
    symbol,
    shortName: symbol || null,
    currency: "USD",
    regularMarketPrice: last || close || bid || ask || null,
    regularMarketVolume: volume || null,
    averageDailyVolume3Month: null,
    averageDailyVolume10Day: null,
    earningsDate: null,
    nextEarningsDate: null,
    earningsCallTimestampStart: null,
    earningsCallTimestampEnd: null,
    earningsTimestamp: null,
    earningsTimestampStart: null,
    earningsTimestampEnd: null,
    exchangeTimezoneName: null,
    exchangeTimezoneShortName: null,
    isEarningsDateEstimate: null,
    earningsMoment: null,
    source: "ibkr",
    fetchedAt: rawQuote?.fetchedAt ?? null,
  };
}
