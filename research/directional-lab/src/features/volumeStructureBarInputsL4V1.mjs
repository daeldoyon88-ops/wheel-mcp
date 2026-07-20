/**
 * L4A-B shared input conversion: verified L3-I5 canonical OHLCV rows and
 * verified L4A-A feature rows are converted into internal fixed-point BigInt
 * bars and cells. No IEEE-754 conversion of any price or volume.
 */

import { fixedFromCanonical } from './fixedPointFeatureMathL4V1.mjs';
import { assertMarketVolumeStructureRuntimeSectionV1 } from './marketVolumeStructureRuntimePolicyL4V1.mjs';

/**
 * Convert verified L3-I5 atom rows into fixed-point bars carrying volume.
 * Volume is nullable at L1 and stays null here (never coerced to zero).
 * @param {Array<any>} rows
 */
export function toInternalVolumeStructureBars(rows, config) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  assertMarketVolumeStructureRuntimeSectionV1(config, 'barInputs');
  const { internalScale } = config.scales;
  return rows.map((row) => ({
    source: row,
    open: fixedFromCanonical({ atoms: row.openAtoms, scale: row.priceScale }, internalScale),
    high: fixedFromCanonical({ atoms: row.highAtoms, scale: row.priceScale }, internalScale),
    low: fixedFromCanonical({ atoms: row.lowAtoms, scale: row.priceScale }, internalScale),
    close: fixedFromCanonical({ atoms: row.closeAtoms, scale: row.priceScale }, internalScale),
    volume: row.volumeAtoms === null
      ? null
      : fixedFromCanonical({ atoms: row.volumeAtoms, scale: row.volumeScale }, internalScale),
  }));
}

/** @param {{value: unknown, availability: string}} cell */
function toInternalCell(value, availability, internalScale) {
  if (availability === 'AVAILABLE') {
    return { value: fixedFromCanonical(value, internalScale), availability };
  }
  return { value: null, availability };
}

/**
 * Extract the exact L4A-A cells L4A-B depends on (ATR14, ATR14 percent and
 * the 20-session return), converted to internal fixed-point. Availability
 * reasons are carried through unchanged.
 * @param {Array<any>} technicalRows normalized MarketTechnicalFeatureRows/1 rows
 */
export function extractTechnicalCells(technicalRows, config) {
  if (!Array.isArray(technicalRows)) throw new TypeError('technicalRows must be an array');
  assertMarketVolumeStructureRuntimeSectionV1(config, 'barInputs');
  const { internalScale } = config.scales;
  return technicalRows.map((row) => ({
    atr14: toInternalCell(row.features.volatility.atr14, row.availability.volatility.atr14, internalScale),
    atr14Pct: toInternalCell(
      row.features.volatility.atr14Pct, row.availability.volatility.atr14Pct, internalScale,
    ),
    return20: toInternalCell(
      row.features.returnsDrawdowns.return20, row.availability.returnsDrawdowns.return20, internalScale,
    ),
  }));
}
