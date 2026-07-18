/**
 * Canonical corporate-action policy per price basis — the single source of
 * truth consulted by the backtest engine, the basis selector, the tests and
 * the documentation (DATA_CONTRACT.md).
 *
 * Canonical definitions:
 *  - splitFactor = shares after the split / shares before the split
 *    (2 = 2:1 split, 1.5 = 3:2, 0.2 = 1:5 reverse split); strictly positive;
 *    a factor of exactly 1 is a no-op and is ignored;
 *  - cashDividend = cash per eligible share at the ex-dividend session.
 *
 * Per-basis policy:
 *  - RAW: prices ignore splits and dividends -> the engine applies splits to
 *    the position (quantity x factor, per-share values / factor, cash and
 *    realized PnL untouched) and credits cash dividends separately;
 *  - SPLIT_ADJUSTED: splits already embedded in prices -> never re-applied;
 *    cash dividends are NOT in prices -> credited when amounts are available;
 *  - TOTAL_RETURN_ADJUSTED: splits AND dividends embedded -> nothing is
 *    re-applied and no separate dividend credit (double counting forbidden);
 *  - DERIVED_ADJUSTED: the embedded treatment of a synthetic series cannot be
 *    proven -> any economically meaningful corporate action on the series
 *    refuses the backtest (CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED).
 *
 * Fractional shares: quantity x splitFactor must be a whole number within
 * SPLIT_QUANTITY_TOLERANCE; otherwise the backtest is refused
 * (FRACTIONAL_SPLIT_RESULT_UNSUPPORTED) — V1 has no cash-in-lieu policy and
 * never rounds silently.
 *
 * Same-session split + dividend: when both are present on one session and the
 * engine must act on either, their order is not provable from the source and
 * the backtest is refused (CORPORATE_ACTION_ORDER_AMBIGUOUS).
 */

export const CORPORATE_ACTION_POLICY_VERSION = 'corporateActionPolicy/1';

export const ERROR_CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED = 'CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED';
export const ERROR_CORPORATE_ACTION_ORDER_AMBIGUOUS = 'CORPORATE_ACTION_ORDER_AMBIGUOUS';
export const ERROR_FRACTIONAL_SPLIT_RESULT_UNSUPPORTED = 'FRACTIONAL_SPLIT_RESULT_UNSUPPORTED';

/** Relative tolerance for accepting quantity x splitFactor as whole shares. */
export const SPLIT_QUANTITY_TOLERANCE = 1e-6;

/**
 * @typedef {Object} CorporateActionBasisPolicy
 * @property {string} priceBasis
 * @property {boolean} engineAppliesSplit engine adjusts position/stops on a split
 * @property {boolean} creditsCashDividend engine credits cashDividend to cash
 * @property {boolean} pricesIncludeSplits
 * @property {boolean} pricesIncludeDividends
 * @property {boolean} refusesCorporateActions any meaningful action refuses the run
 */

export const CORPORATE_ACTION_POLICY = Object.freeze({
  RAW: Object.freeze({
    priceBasis: 'RAW',
    engineAppliesSplit: true,
    creditsCashDividend: true,
    pricesIncludeSplits: false,
    pricesIncludeDividends: false,
    refusesCorporateActions: false,
  }),
  SPLIT_ADJUSTED: Object.freeze({
    priceBasis: 'SPLIT_ADJUSTED',
    engineAppliesSplit: false,
    creditsCashDividend: true,
    pricesIncludeSplits: true,
    pricesIncludeDividends: false,
    refusesCorporateActions: false,
  }),
  TOTAL_RETURN_ADJUSTED: Object.freeze({
    priceBasis: 'TOTAL_RETURN_ADJUSTED',
    engineAppliesSplit: false,
    creditsCashDividend: false,
    pricesIncludeSplits: true,
    pricesIncludeDividends: true,
    refusesCorporateActions: false,
  }),
  DERIVED_ADJUSTED: Object.freeze({
    priceBasis: 'DERIVED_ADJUSTED',
    engineAppliesSplit: false,
    creditsCashDividend: false,
    pricesIncludeSplits: true,
    pricesIncludeDividends: true,
    refusesCorporateActions: true,
  }),
});

/**
 * @param {string} priceBasis
 * @returns {CorporateActionBasisPolicy}
 */
export function corporateActionPolicyFor(priceBasis) {
  const policy = CORPORATE_ACTION_POLICY[priceBasis];
  if (!policy) {
    throw new Error(`No corporate action policy for price basis "${priceBasis}" (allowed: ${Object.keys(CORPORATE_ACTION_POLICY).join(', ')})`);
  }
  return policy;
}
