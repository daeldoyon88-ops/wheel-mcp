/**
 * DatasetManifestV1 — provenance + coverage + quality summary of one series.
 * Built read-only from a source file; never mutates the source.
 */

export const DATASET_MANIFEST_SCHEMA_VERSION = 'DatasetManifestV1';

/** Coverage field semantics version (available vs complete, full OHLC counts). */
export const COVERAGE_VERSION = 'coverage/1';

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
 * @property {string} coverageVersion
 * @property {number} rawOhlcValidBars
 * @property {number} rawOhlcCoveragePct
 * @property {boolean} rawOhlcAvailable coveragePct > 0 (partial presence allowed)
 * @property {boolean} rawOhlcComplete every bar has full raw OHLC
 * @property {number} adjustedOhlcValidBars
 * @property {number} adjustedOhlcCoveragePct
 * @property {boolean} adjustedOhlcAvailable
 * @property {boolean} adjustedOhlcComplete
 * @property {number} volumeValidBars
 * @property {number} volumeCoveragePct
 * @property {boolean} volumeAvailable
 * @property {boolean} volumeComplete
 * @property {boolean} adjustedCloseAvailable
 * @property {string|null} nativeAdjustmentType
 * @property {boolean} splitsDocumented
 * @property {string[]} qualityFlags
 * @property {string[]} warnings
 * @property {Object} gapStats
 * @property {Object} lineage
 */

/**
 * @param {unknown} n
 * @param {string} name
 * @param {string[]} problems
 * @param {{min?: number, max?: number, integer?: boolean}} [opts]
 */
function checkNumber(n, name, problems, opts = {}) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    problems.push(`${name} must be a finite number`);
    return;
  }
  if (opts.integer && !Number.isInteger(n)) problems.push(`${name} must be an integer`);
  if (opts.min !== undefined && n < opts.min) problems.push(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) problems.push(`${name} must be <= ${opts.max}`);
}

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
  checkNumber(m.barCount, 'barCount', problems, { integer: true, min: 0 });

  if (m.coverageVersion !== COVERAGE_VERSION) {
    problems.push(`coverageVersion must be ${COVERAGE_VERSION}`);
  }

  if (Number.isInteger(m.barCount) && m.barCount >= 0) {
    for (const [countName, pctName, availName, completeName] of [
      ['rawOhlcValidBars', 'rawOhlcCoveragePct', 'rawOhlcAvailable', 'rawOhlcComplete'],
      ['adjustedOhlcValidBars', 'adjustedOhlcCoveragePct', 'adjustedOhlcAvailable', 'adjustedOhlcComplete'],
      ['volumeValidBars', 'volumeCoveragePct', 'volumeAvailable', 'volumeComplete'],
    ]) {
      checkNumber(m[countName], countName, problems, { integer: true, min: 0, max: m.barCount });
      checkNumber(m[pctName], pctName, problems, { min: 0, max: 100 });
      if (typeof m[availName] !== 'boolean') problems.push(`${availName} must be boolean`);
      if (typeof m[completeName] !== 'boolean') problems.push(`${completeName} must be boolean`);
      if (
        Number.isInteger(m[countName])
        && typeof m[pctName] === 'number'
        && Number.isFinite(m[pctName])
        && typeof m[availName] === 'boolean'
        && typeof m[completeName] === 'boolean'
      ) {
        const expectedPct = m.barCount > 0
          ? Math.round((Math.min(m[countName], m.barCount) / m.barCount) * 100 * 1e6) / 1e6
          : 0;
        if (m[pctName] !== expectedPct) {
          problems.push(`${pctName} inconsistent with ${countName}/barCount (expected ${expectedPct})`);
        }
        const expectedAvail = expectedPct > 0;
        if (m[availName] !== expectedAvail) {
          problems.push(`${availName} must equal coveragePct > 0`);
        }
        const expectedComplete = m.barCount > 0 && m[countName] === m.barCount;
        if (m[completeName] !== expectedComplete) {
          problems.push(`${completeName} must equal barCount > 0 && validBars === barCount`);
        }
      }
    }
  }

  if (m.barCount > 0) {
    if (typeof m.firstDate !== 'string' || typeof m.lastDate !== 'string') {
      problems.push('firstDate/lastDate required when barCount > 0');
    } else if (m.firstDate > m.lastDate) {
      problems.push('firstDate must be <= lastDate when barCount > 0');
    }
  } else if (m.barCount === 0) {
    if (m.firstDate !== null || m.lastDate !== null) {
      problems.push('firstDate/lastDate must be null when barCount = 0');
    }
  }

  for (const f of ['adjustedCloseAvailable', 'splitsDocumented']) {
    if (typeof m[f] !== 'boolean') problems.push(`${f} must be boolean`);
  }
  if (!Array.isArray(m.qualityFlags)) problems.push('qualityFlags must be an array');
  if (!Array.isArray(m.warnings)) problems.push('warnings must be an array');
  if (m.gapStats === null || typeof m.gapStats !== 'object') problems.push('gapStats must be an object');
  if (m.lineage === null || typeof m.lineage !== 'object') problems.push('lineage must be an object');
  return problems;
}
