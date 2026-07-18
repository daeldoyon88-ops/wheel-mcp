/**
 * Select ONE coherent tradable price basis from DailyBarV1 bars.
 *
 * Hard rules:
 *  - never mixes raw close with adjusted open/high/low (or vice versa);
 *  - refuses a basis whose data is not actually present;
 *  - DERIVED_ADJUSTED (raw OHLC scaled by adjustedClose/rawClose ratio) is
 *    only produced on explicit request, is flagged on every bar, and is
 *    refused in strict mode.
 */

import { ADJUSTMENT_TYPES } from '../contracts/dailyBarV1.mjs';

/**
 * @typedef {Object} BasisBar
 * @property {string} sessionDate
 * @property {string} eventTime
 * @property {string} availableAt
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number|null} volume
 * @property {number|null} splitFactor
 * @property {number|null} cashDividend
 * @property {string[]} qualityFlags
 */

/**
 * @param {import('../contracts/dailyBarV1.mjs').DailyBarV1[]} bars
 * @param {'RAW'|'SPLIT_ADJUSTED'|'TOTAL_RETURN_ADJUSTED'|'DERIVED_ADJUSTED'} basis
 * @param {{strict?: boolean}} [options] strict=true refuses derived series
 * @returns {{series: BasisBar[], basis: string, warnings: string[]}}
 */
export function selectPriceBasis(bars, basis, options = {}) {
  if (!ADJUSTMENT_TYPES.includes(basis)) {
    throw new Error(`Unknown price basis "${basis}" (allowed: ${ADJUSTMENT_TYPES.join(', ')})`);
  }
  if (!Array.isArray(bars) || bars.length === 0) throw new Error('selectPriceBasis: no bars');
  const warnings = [];
  const series = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    let block = null;
    let flags = [];

    if (basis === 'RAW') {
      block = bar.raw;
      if (block.close === null || block.open === null || block.high === null || block.low === null) {
        throw new Error(
          `Price basis RAW unavailable for ${bar.symbol} at ${bar.sessionDate}: raw OHLC is null ` +
          `(source provides only ${bar.adjusted.adjustmentType ?? 'nothing'}); refusing to substitute adjusted prices silently`
        );
      }
    } else if (basis === 'DERIVED_ADJUSTED') {
      if (options.strict) {
        throw new Error('Strict mode refuses DERIVED_ADJUSTED series (transformation is synthetic, not native)');
      }
      const raw = bar.raw;
      const trClose = typeof bar.lineage?.totalReturnClose === 'number' ? bar.lineage.totalReturnClose : null;
      if (raw.close === null || raw.open === null || raw.high === null || raw.low === null || trClose === null || raw.close === 0) {
        throw new Error(
          `Cannot derive adjusted OHLC for ${bar.symbol} at ${bar.sessionDate}: needs full raw OHLC + total-return close`
        );
      }
      const ratio = trClose / raw.close;
      block = {
        open: raw.open * ratio,
        high: raw.high * ratio,
        low: raw.low * ratio,
        close: trClose,
        volume: raw.volume,
      };
      flags = ['DERIVED_FROM_CLOSE_RATIO', `ratio=${ratio}`];
    } else {
      block = bar.adjusted;
      if (bar.adjusted.adjustmentType !== basis) {
        throw new Error(
          `Price basis ${basis} requested but ${bar.symbol} at ${bar.sessionDate} carries ` +
          `adjustmentType=${bar.adjusted.adjustmentType ?? 'null'}; refusing incoherent configuration`
        );
      }
      if (block.close === null || block.open === null || block.high === null || block.low === null) {
        throw new Error(`Price basis ${basis} unavailable for ${bar.symbol} at ${bar.sessionDate}: adjusted OHLC incomplete`);
      }
    }

    series.push({
      sessionDate: bar.sessionDate,
      eventTime: bar.eventTime,
      availableAt: bar.availableAt,
      open: block.open,
      high: block.high,
      low: block.low,
      close: block.close,
      volume: block.volume,
      splitFactor: bar.corporateActions.splitFactor,
      cashDividend: bar.corporateActions.cashDividend,
      qualityFlags: [...bar.qualityFlags, ...flags],
    });
  }

  if (basis === 'SPLIT_ADJUSTED') {
    warnings.push('DIVIDENDS_NOT_INCLUDED: split-adjusted close excludes dividends; total return is understated for dividend payers');
  }
  if (basis === 'DERIVED_ADJUSTED') {
    warnings.push('DERIVED_ADJUSTED: adjusted OHLC synthesized from close ratio; not a native series');
  }
  return { series, basis, warnings };
}
