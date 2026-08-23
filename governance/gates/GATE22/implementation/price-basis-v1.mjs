export const PRICE_BASIS_V1 = Object.freeze(['RAW', 'SPLIT_ADJUSTED', 'TOTAL_RETURN_ADJUSTED']);
export function validatePriceBasisWindow(bases) {
  if (!Array.isArray(bases) || bases.length === 0 || bases.some((basis) => !PRICE_BASIS_V1.includes(basis))) return { status: 'FAIL_CLOSED', code: 'PRICE_BASIS_UNAVAILABLE_FOR_WINDOW' };
  return new Set(bases).size === 1 ? { status: 'RESOLVED', priceBasisId: bases[0] } : { status: 'FAIL_CLOSED', code: 'PRICE_BASIS_MIXED_IN_WINDOW' };
}
