/**
 * Closed registry of official source-to-canonical materializers. Callers
 * select a versioned profile ID; they cannot substitute adapter/normalizer
 * callbacks. Every materializer receives the complete normalized snapshot
 * core, even when a particular field is only identity/provenance metadata.
 */

import { canonicalDailyBarsFromDailyBarV1 } from '../canonical/canonicalDailyBarsV1.mjs';
import { CSV_ADAPTER_VERSION, parseCsv } from './csvDailyAdapter.mjs';
import { canonicalizeCsvHeaderRow } from './csvHeader.mjs';
import { JSON_ADAPTER_VERSION, parseSplitRatio } from './jsonDailyAdapter.mjs';
import { NORMALIZE_DAILY_BARS_VERSION, normalizeDailyBars } from './normalizeDailyBars.mjs';
import { corporateActionPolicyFor } from './corporateActionPolicy.mjs';
import {
  LAB_PIPELINE_ROLE_LOGICAL_PATHS,
  buildLabTransformPipelineProfile,
} from './transformPipelineProfilesV1.mjs';
import { TransformPipelineError } from '../contracts/transformPipelineProfileV1.mjs';

export const MATERIALIZER_REGISTRY_VERSION = 'materializerRegistry/1';

const REQUIRED_CSV_COLUMNS = Object.freeze(['date', 'open', 'high', 'low', 'close']);

/** @param {Buffer|Uint8Array} sourceBytes */
function decodeUtf8(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) && !(sourceBytes instanceof Uint8Array)) {
    throw new TypeError('sourceBytes must be bytes');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes);
}

/** @param {any} snapshotCore @param {string} adapterVersion @param {string} sourceFormat */
function assertCoreVersions(snapshotCore, adapterVersion, sourceFormat) {
  if (snapshotCore.adapterVersion !== adapterVersion) {
    throw new Error(`adapterVersion ${snapshotCore.adapterVersion} does not match official ${adapterVersion}`);
  }
  if (snapshotCore.normalizerVersion !== NORMALIZE_DAILY_BARS_VERSION) {
    throw new Error(`normalizerVersion ${snapshotCore.normalizerVersion} does not match official ${NORMALIZE_DAILY_BARS_VERSION}`);
  }
  if (snapshotCore.sourceFormat !== sourceFormat) {
    throw new Error(`sourceFormat ${snapshotCore.sourceFormat} does not match official ${sourceFormat}`);
  }
  corporateActionPolicyFor(snapshotCore.priceBasis);
}

/** @param {() => unknown} operation */
function runNormalizerStage(operation) {
  try {
    return operation();
  } catch (cause) {
    const error = new Error('official normalizer failed', { cause });
    error.materializationStage = 'NORMALIZER';
    throw error;
  }
}

/** @param {any} parsed @param {any} snapshotCore */
function jsonRowsToCanonical(parsed, snapshotCore) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) {
    throw new Error('unrecognized JSON shape (expected { rows: [...] })');
  }
  if (typeof parsed.symbol === 'string'
    && parsed.symbol !== snapshotCore.providerSymbol
    && parsed.symbol !== snapshotCore.canonicalSymbol) {
    throw new Error(`source symbol ${parsed.symbol} does not match snapshot core`);
  }
  const documentedSplits = [];
  if (Array.isArray(parsed.splits)) {
    for (const split of parsed.splits) {
      if (!split || typeof split.date !== 'string') continue;
      const factor = typeof split.ratio === 'string'
        ? parseSplitRatio(split.ratio)
        : typeof split.factor === 'number' ? split.factor : null;
      if (factor !== null) documentedSplits.push({ date: split.date.slice(0, 10), factor, ratioText: split.ratio ?? null });
    }
  }
  return runNormalizerStage(() => {
    const bars = normalizeDailyBars(parsed.rows, {
      ...snapshotCore.normalizationOptions,
      ...snapshotCore.adapterOptions,
      symbol: snapshotCore.canonicalSymbol,
      source: `cas:${snapshotCore.sourceObjectId}`,
      ohlcBasis: snapshotCore.priceBasis,
      documentedSplits,
      loaderVersion: snapshotCore.adapterVersion,
    });
    return canonicalDailyBarsFromDailyBarV1(bars, { priceBasis: snapshotCore.priceBasis });
  });
}

/** @param {string} text @param {any} snapshotCore */
function csvTextToCanonical(text, snapshotCore) {
  const { header, rows } = parseCsv(text);
  const { canonical } = canonicalizeCsvHeaderRow(header);
  for (const required of REQUIRED_CSV_COLUMNS) {
    if (!canonical.includes(required)) throw new Error(`CSV missing required column ${required}`);
  }
  if (rows.length === 0) throw new Error('CSV_NO_DATA_ROWS');
  const objects = rows.map(({ cells, lineNumber }) => {
    if (cells.length !== header.length) throw new Error(`CSV line ${lineNumber} has the wrong cell count`);
    const row = {};
    canonical.forEach((name, index) => {
      if (name !== null) row[name] = cells[index] === '' ? null : cells[index];
    });
    return row;
  });
  return runNormalizerStage(() => {
    const bars = normalizeDailyBars(objects, {
      ...snapshotCore.normalizationOptions,
      ...snapshotCore.adapterOptions,
      symbol: snapshotCore.canonicalSymbol,
      source: `cas:${snapshotCore.sourceObjectId}`,
      ohlcBasis: snapshotCore.priceBasis,
      loaderVersion: snapshotCore.adapterVersion,
    });
    return canonicalDailyBarsFromDailyBarV1(bars, { priceBasis: snapshotCore.priceBasis });
  });
}

const REGISTRY = Object.freeze({
  'lab-json-daily/1': Object.freeze({
    pipelineProfileId: 'lab-json-daily/1',
    requiredRoles: Object.freeze(Object.keys(LAB_PIPELINE_ROLE_LOGICAL_PATHS['lab-json-daily/1']).sort()),
    materialize({ sourceBytes, snapshotCore }) {
      assertCoreVersions(snapshotCore, JSON_ADAPTER_VERSION, 'OHLC_CACHE_JSON_V1');
      return jsonRowsToCanonical(JSON.parse(decodeUtf8(sourceBytes)), snapshotCore);
    },
  }),
  'lab-csv-daily/1': Object.freeze({
    pipelineProfileId: 'lab-csv-daily/1',
    requiredRoles: Object.freeze(Object.keys(LAB_PIPELINE_ROLE_LOGICAL_PATHS['lab-csv-daily/1']).sort()),
    materialize({ sourceBytes, snapshotCore }) {
      assertCoreVersions(snapshotCore, CSV_ADAPTER_VERSION, 'CSV_DAILY_V1');
      return csvTextToCanonical(decodeUtf8(sourceBytes), snapshotCore);
    },
  }),
});

export const OFFICIAL_MATERIALIZER_PIPELINE_IDS = Object.freeze(Object.keys(REGISTRY).sort());

/**
 * @param {{pipelineProfileId: string, transformManifest: unknown}} input
 */
export function resolveOfficialMaterializerPipeline(input) {
  const entry = REGISTRY[input?.pipelineProfileId];
  if (!entry) {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_UNKNOWN', `unknown official pipeline: ${String(input?.pipelineProfileId)}`);
  }
  const pipelineProfile = buildLabTransformPipelineProfile({
    pipelineProfileId: entry.pipelineProfileId,
    transformManifest: input.transformManifest,
  });
  return Object.freeze({
    pipelineProfile,
    requiredRoles: entry.requiredRoles,
    materialize: entry.materialize,
  });
}
