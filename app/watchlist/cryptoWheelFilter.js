/**
 * Filtre crypto Wheel — crypto/digital asset exclu sauf BITX.
 * Source unique pour watchlist, research pool et dashboard.
 */

export const CRYPTO_BLOCK_REASON = "crypto_blocked_except_bitx";

/** Seul crypto/digital asset autorisé dans la stratégie Wheel. */
export const CRYPTO_ALLOWED_SYMBOLS = new Set(["BITX"]);

/**
 * ETF / trusts crypto spot ou produits digital asset — exclus (BITX sauf via whitelist).
 * Miners historiques conservés ici ; COIN/MSTR sont dans CRYPTO_RELATED_EQUITY_SYMBOLS.
 */
export const CRYPTO_DIGITAL_ASSET_BLOCKED_SYMBOLS = new Set([
  // Liste explicite digital asset (mission)
  "ETHA",
  "GBTC",
  "IBIT",
  "ETHE",
  "BITO",
  "BITB",
  "ARKB",
  "FBTC",
  "EZBC",
  "HODL",
  "BRRR",
  "BTCW",
  "BTCO",
  "DEFI",
  // Miners / infra crypto (existant — hors COIN)
  "RIOT",
  "CIFR",
  "WULF",
  "IREN",
  "MARA",
  "CLSK",
  "HUT",
  "BTBT",
  "BITF",
  "BMNR",
  "BTDR",
  "BLSH",
  "CRCL",
  "CORZ",
]);

/**
 * Actions crypto-adjacentes — non bloquées automatiquement ; classées à part.
 * MSTR / COIN restent scannables tant qu’aucune règle métier supplémentaire ne s’applique.
 */
export const CRYPTO_RELATED_EQUITY_SYMBOLS = new Set(["MSTR", "COIN"]);

/**
 * @param {unknown} symbol
 * @returns {string}
 */
export function normalizeTickerSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

/**
 * @param {unknown} symbol
 */
export function isCryptoAllowed(symbol) {
  return CRYPTO_ALLOWED_SYMBOLS.has(normalizeTickerSymbol(symbol));
}

/**
 * @param {unknown} symbol
 */
export function isCryptoRelatedEquity(symbol) {
  return CRYPTO_RELATED_EQUITY_SYMBOLS.has(normalizeTickerSymbol(symbol));
}

/**
 * @param {unknown} symbol
 */
export function isCryptoDigitalAssetBlocked(symbol) {
  const sym = normalizeTickerSymbol(symbol);
  if (!sym) return false;
  if (isCryptoAllowed(sym)) return false;
  return CRYPTO_DIGITAL_ASSET_BLOCKED_SYMBOLS.has(sym);
}

/**
 * @param {unknown} symbol
 * @returns {typeof CRYPTO_BLOCK_REASON | null}
 */
export function getCryptoBlockReason(symbol) {
  return isCryptoDigitalAssetBlocked(symbol) ? CRYPTO_BLOCK_REASON : null;
}

/**
 * @param {Iterable<unknown>} symbols
 */
export function collectCryptoFilterDiagnostics(symbols) {
  const removedSymbols = [];
  const allowedRetained = [];
  for (const raw of symbols) {
    const sym = normalizeTickerSymbol(raw);
    if (!sym) continue;
    if (isCryptoAllowed(sym)) {
      allowedRetained.push(sym);
      continue;
    }
    if (isCryptoDigitalAssetBlocked(sym)) {
      removedSymbols.push(sym);
    }
  }
  removedSymbols.sort();
  allowedRetained.sort();
  return {
    cryptoBlockedRemovedCount: removedSymbols.length,
    cryptoBlockedRemovedSymbols: removedSymbols,
    cryptoAllowedRetained: allowedRetained,
    cryptoRelatedEquityPresent: [...CRYPTO_RELATED_EQUITY_SYMBOLS].filter((sym) =>
      [...symbols].some((raw) => normalizeTickerSymbol(raw) === sym)
    ),
  };
}

/**
 * @param {Iterable<unknown>} symbols
 * @returns {string[]}
 */
export function filterCryptoBlockedSymbols(symbols) {
  return [...symbols]
    .map((s) => normalizeTickerSymbol(s))
    .filter((sym) => sym && !isCryptoDigitalAssetBlocked(sym));
}
