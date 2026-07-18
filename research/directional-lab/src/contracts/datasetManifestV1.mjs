/**
 * DatasetManifestV1 — provenance + coverage + quality summary of one series.
 * Built read-only from a source file; never mutates the source.
 */

export const DATASET_MANIFEST_SCHEMA_VERSION = 'DatasetManifestV1';

/**
 * @typedef {Object} DatasetManifestV1
 * @property {'DatasetManifestV1'} schemaVersion
 * @property {string} symbol
 * @property {string} sourcePath
 * @property {'tracked'|'untracked'|'fixture'|'unknown'} sourceGitStatus
 * @property {string} sourceFormat e.g. OHLC_CACHE_JSON_V1, CSV_DAILY_V1
 * @property {string} contentHash sha256 of the source file bytes
 * @property {string|null} firstDate
 * @property {string|null} lastDate
 * @property {number} barCount
 * @property {boolean} volumeAvailable
 * @property {boolean} rawOhlcAvailable
 * @property {boolean} adjustedOhlcAvailable
 * @property {boolean} adjustedCloseAvailable
 * @property {string|null} nativeAdjustmentType
 * @property {boolean} splitsDocumented
 * @property {string[]} qualityFlags
 * @property {string[]} warnings
 * @property {Object} gapStats
 * @property {Object} lineage
 */

/**
 * @param {unknown} manifest
 * @returns {string[]} problems, empty when valid
 */
export function datasetManifestProblems(manifest) {
  const problems = [];
  if (manifest === null || typeof manifest !== 'object') return ['manifest is not an object'];
  const m = /** @type {any} */ (manifest);
  if (m.schemaVersion !== DATASET_MANIFEST_SCHEMA_VERSION) problems.push(`schemaVersion must be ${DATASET_MANIFEST_SCHEMA_VERSION}`);
  if (typeof m.symbol !== 'string' || !m.symbol) problems.push('symbol required');
  if (typeof m.sourcePath !== 'string' || !m.sourcePath) problems.push('sourcePath required');
  if (!['tracked', 'untracked', 'fixture', 'unknown'].includes(m.sourceGitStatus)) problems.push('sourceGitStatus invalid');
  if (typeof m.sourceFormat !== 'string' || !m.sourceFormat) problems.push('sourceFormat required');
  if (typeof m.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.contentHash)) problems.push('contentHash must be a sha256 hex string');
  if (!Number.isInteger(m.barCount) || m.barCount < 0) problems.push('barCount must be a non-negative integer');
  if (m.barCount > 0 && (typeof m.firstDate !== 'string' || typeof m.lastDate !== 'string')) {
    problems.push('firstDate/lastDate required when barCount > 0');
  }
  for (const f of ['volumeAvailable', 'rawOhlcAvailable', 'adjustedOhlcAvailable', 'adjustedCloseAvailable', 'splitsDocumented']) {
    if (typeof m[f] !== 'boolean') problems.push(`${f} must be boolean`);
  }
  if (!Array.isArray(m.qualityFlags)) problems.push('qualityFlags must be an array');
  if (!Array.isArray(m.warnings)) problems.push('warnings must be an array');
  if (m.gapStats === null || typeof m.gapStats !== 'object') problems.push('gapStats must be an object');
  if (m.lineage === null || typeof m.lineage !== 'object') problems.push('lineage must be an object');
  return problems;
}
