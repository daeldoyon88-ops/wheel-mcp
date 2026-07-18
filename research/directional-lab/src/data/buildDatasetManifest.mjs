/**
 * Build a DatasetManifestV1 from a source file + its normalized bars.
 * Read-only over the source; the manifest is returned, never written unless
 * the caller passes an explicit output path (CLI --output).
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DATASET_MANIFEST_SCHEMA_VERSION } from '../contracts/datasetManifestV1.mjs';
import { validateDailyBars } from './validateDailyBars.mjs';

/**
 * @param {{sourcePath: string, symbol: string, format: string, bars: import('../contracts/dailyBarV1.mjs').DailyBarV1[], sourceGitStatus?: 'tracked'|'untracked'|'fixture'|'unknown', sourceMeta?: Object}} input
 * @returns {{manifest: Object, validation: import('./validateDailyBars.mjs').SeriesValidation}}
 */
export function buildDatasetManifest(input) {
  const { sourcePath, symbol, format, bars } = input;
  const bytes = readFileSync(sourcePath);
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const validation = validateDailyBars(bars);

  const volumeAvailable = bars.some((b) => (b.adjusted?.volume ?? b.raw?.volume) !== null);
  const rawOhlcAvailable = bars.length > 0 && bars.every((b) => b.raw.close !== null);
  const adjustedOhlcAvailable = bars.length > 0 && bars.every((b) => b.adjusted.close !== null);
  const adjustedCloseAvailable = adjustedOhlcAvailable
    || bars.some((b) => typeof b.lineage?.totalReturnClose === 'number');
  const nativeAdjustmentType = bars.length > 0 ? bars[0].adjusted.adjustmentType : null;
  const splitsDocumented = bars.some((b) => b.corporateActions.splitFactor !== null);

  const qualityFlags = [];
  if (!rawOhlcAvailable) qualityFlags.push('RAW_OHLC_MISSING');
  if (!volumeAvailable) qualityFlags.push('VOLUME_MISSING');
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
    firstDate: validation.stats.firstDate,
    lastDate: validation.stats.lastDate,
    barCount: bars.length,
    volumeAvailable,
    rawOhlcAvailable,
    adjustedOhlcAvailable,
    adjustedCloseAvailable,
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
      builder: 'buildDatasetManifest/1',
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
