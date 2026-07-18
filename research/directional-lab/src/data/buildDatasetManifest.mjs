/**
 * Build a DatasetManifestV1 from a source file + its normalized bars.
 * Read-only over the source; the manifest is returned, never written unless
 * the caller passes an explicit output path (CLI --output).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DATASET_MANIFEST_SCHEMA_VERSION } from '../contracts/datasetManifestV1.mjs';
import { validateDailyBars } from './validateDailyBars.mjs';
import { computeCoverageMetrics } from './coverageMetrics.mjs';

/**
 * @param {{sourcePath: string, symbol: string, format: string, bars: import('../contracts/dailyBarV1.mjs').DailyBarV1[], sourceGitStatus?: 'tracked'|'untracked'|'fixture'|'unknown', sourceMeta?: Object}} input
 * @returns {{manifest: Object, validation: import('./validateDailyBars.mjs').SeriesValidation}}
 */
export function buildDatasetManifest(input) {
  const { sourcePath, symbol, format, bars } = input;
  if (!Array.isArray(bars)) {
    throw new Error('buildDatasetManifest: bars must be an array');
  }
  const bytes = readFileSync(sourcePath);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const validation = validateDailyBars(bars);
  const coverage = computeCoverageMetrics(bars);

  const nativeAdjustmentType = bars.length > 0 ? bars[0].adjusted.adjustmentType : null;
  const splitsDocumented = bars.some((b) => b.corporateActions.splitFactor !== null);

  const qualityFlags = [];
  if (coverage.barCount === 0) qualityFlags.push('EMPTY_DATASET');
  if (!coverage.rawOhlcComplete) qualityFlags.push('RAW_OHLC_INCOMPLETE');
  if (!coverage.rawOhlcAvailable) qualityFlags.push('RAW_OHLC_MISSING');
  if (!coverage.adjustedOhlcComplete && coverage.adjustedOhlcAvailable) qualityFlags.push('ADJUSTED_OHLC_INCOMPLETE');
  if (!coverage.volumeAvailable) qualityFlags.push('VOLUME_MISSING');
  else if (!coverage.volumeComplete) qualityFlags.push('VOLUME_INCOMPLETE');
  if (validation.stats.splitSuspects.length > 0) qualityFlags.push('SPLIT_SUSPECT');
  if (validation.stats.duplicateDates > 0) qualityFlags.push('DUPLICATE_DATES');
  if (validation.stats.unsortedPairs > 0) qualityFlags.push('UNSORTED_DATES');
  if (validation.stats.barsWithNullClose > 0) qualityFlags.push('NULL_CLOSES_PRESENT');

  const manifest = {
    schemaVersion: DATASET_MANIFEST_SCHEMA_VERSION,
    symbol,
    sourcePath,
    sourceGitStatus: input.sourceGitStatus ?? 'unknown',
    sourceFormat: format,
    contentHash,
    firstDate: coverage.barCount > 0 ? validation.stats.firstDate : null,
    lastDate: coverage.barCount > 0 ? validation.stats.lastDate : null,
    barCount: coverage.barCount,
    coverageVersion: coverage.coverageVersion,
    rawOhlcValidBars: coverage.rawOhlcValidBars,
    rawOhlcCoveragePct: coverage.rawOhlcCoveragePct,
    rawOhlcAvailable: coverage.rawOhlcAvailable,
    rawOhlcComplete: coverage.rawOhlcComplete,
    adjustedOhlcValidBars: coverage.adjustedOhlcValidBars,
    adjustedOhlcCoveragePct: coverage.adjustedOhlcCoveragePct,
    adjustedOhlcAvailable: coverage.adjustedOhlcAvailable,
    adjustedOhlcComplete: coverage.adjustedOhlcComplete,
    volumeValidBars: coverage.volumeValidBars,
    volumeCoveragePct: coverage.volumeCoveragePct,
    volumeAvailable: coverage.volumeAvailable,
    volumeComplete: coverage.volumeComplete,
    adjustedCloseAvailable: coverage.adjustedCloseAvailable,
    nativeAdjustmentType,
    splitsDocumented,
    qualityFlags,
    warnings: validation.warnings,
    gapStats: {
      missingWeekdays: validation.stats.missingWeekdays,
      maxConsecutiveMissingWeekdays: validation.stats.maxConsecutiveMissingWeekdays,
      weekendSessions: validation.stats.weekendSessions,
    },
    lineage: {
      builder: 'buildDatasetManifest/2',
      sourceDeclared: input.sourceMeta && typeof (/** @type {any} */ (input.sourceMeta).source) === 'string'
        ? /** @type {any} */ (input.sourceMeta).source
        : null,
      sourceSavedAt: input.sourceMeta && typeof (/** @type {any} */ (input.sourceMeta).savedAt) === 'string'
        ? /** @type {any} */ (input.sourceMeta).savedAt
        : null,
    },
  };
  return { manifest, validation };
}
