/**
 * Canonical OHLC / volume coverage metrics for DatasetManifestV1.
 *
 * Semantics (coverageVersion coverage/1):
 *  - available  <=> coveragePct > 0
 *  - complete   <=> barCount > 0 && validBars === barCount
 *  - close alone never counts as a complete OHLC bar
 *
 * Percentages use six-decimal deterministic rounding:
 *   round(validBars / barCount * 100 * 1e6) / 1e6
 */

import { COVERAGE_VERSION } from '../contracts/datasetManifestV1.mjs';

export { COVERAGE_VERSION };

/**
 * @param {number} validBars
 * @param {number} barCount
 * @returns {number} coverage percent in [0, 100]
 */
export function coveragePercent(validBars, barCount) {
  if (!Number.isInteger(barCount) || barCount <= 0) return 0;
  if (!Number.isInteger(validBars) || validBars < 0) return 0;
  const capped = Math.min(validBars, barCount);
  return Math.round((capped / barCount) * 100 * 1e6) / 1e6;
}

/**
 * @param {number|null|undefined} v
 * @returns {boolean}
 */
export function isStrictPositiveFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * @param {number|null|undefined} v
 * @returns {boolean}
 */
export function isNonNegativeFinite(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Full OHLC (open, high, low, close) all present, finite, strictly positive.
 * @param {{open?: unknown, high?: unknown, low?: unknown, close?: unknown}|null|undefined} block
 * @returns {boolean}
 */
export function isCompleteOhlcBlock(block) {
  if (block === null || typeof block !== 'object') return false;
  return (
    isStrictPositiveFinite(block.open)
    && isStrictPositiveFinite(block.high)
    && isStrictPositiveFinite(block.low)
    && isStrictPositiveFinite(block.close)
  );
}

/**
 * @param {import('../contracts/dailyBarV1.mjs').DailyBarV1[]} bars
 * @returns {{
 *   coverageVersion: string,
 *   barCount: number,
 *   rawOhlcValidBars: number,
 *   rawOhlcCoveragePct: number,
 *   rawOhlcAvailable: boolean,
 *   rawOhlcComplete: boolean,
 *   adjustedOhlcValidBars: number,
 *   adjustedOhlcCoveragePct: number,
 *   adjustedOhlcAvailable: boolean,
 *   adjustedOhlcComplete: boolean,
 *   volumeValidBars: number,
 *   volumeCoveragePct: number,
 *   volumeAvailable: boolean,
 *   volumeComplete: boolean,
 *   adjustedCloseAvailable: boolean,
 * }}
 */
export function computeCoverageMetrics(bars) {
  if (!Array.isArray(bars)) {
    throw new Error('computeCoverageMetrics: bars must be an array');
  }
  const barCount = bars.length;
  let rawOhlcValidBars = 0;
  let adjustedOhlcValidBars = 0;
  let volumeValidBars = 0;
  let adjustedCloseAvailable = false;

  for (const bar of bars) {
    if (isCompleteOhlcBlock(bar?.raw)) rawOhlcValidBars++;
    if (isCompleteOhlcBlock(bar?.adjusted)) adjustedOhlcValidBars++;
    const vol = bar?.adjusted?.volume ?? bar?.raw?.volume ?? null;
    if (isNonNegativeFinite(vol)) volumeValidBars++;
    if (isStrictPositiveFinite(bar?.adjusted?.close)) adjustedCloseAvailable = true;
    else if (typeof bar?.lineage?.totalReturnClose === 'number' && Number.isFinite(bar.lineage.totalReturnClose)) {
      adjustedCloseAvailable = true;
    }
  }

  const rawOhlcCoveragePct = coveragePercent(rawOhlcValidBars, barCount);
  const adjustedOhlcCoveragePct = coveragePercent(adjustedOhlcValidBars, barCount);
  const volumeCoveragePct = coveragePercent(volumeValidBars, barCount);

  return {
    coverageVersion: COVERAGE_VERSION,
    barCount,
    rawOhlcValidBars,
    rawOhlcCoveragePct,
    rawOhlcAvailable: rawOhlcCoveragePct > 0,
    rawOhlcComplete: barCount > 0 && rawOhlcValidBars === barCount,
    adjustedOhlcValidBars,
    adjustedOhlcCoveragePct,
    adjustedOhlcAvailable: adjustedOhlcCoveragePct > 0,
    adjustedOhlcComplete: barCount > 0 && adjustedOhlcValidBars === barCount,
    volumeValidBars,
    volumeCoveragePct,
    volumeAvailable: volumeCoveragePct > 0,
    volumeComplete: barCount > 0 && volumeValidBars === barCount,
    adjustedCloseAvailable,
  };
}
