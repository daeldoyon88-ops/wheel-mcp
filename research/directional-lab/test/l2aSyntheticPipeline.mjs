/** Synthetic fixture data only; production verification uses the closed official registry. */

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import { buildDatasetSnapshot } from '../src/data/buildDatasetSnapshot.mjs';
import {
  buildTransformImplementationManifestV2,
  transformImplementationManifestHash,
} from '../src/data/transformImplementationManifestV2.mjs';
import {
  buildLabTransformPipelineProfile,
  labPipelineLogicalPaths,
} from '../src/data/transformPipelineProfilesV1.mjs';
import { resolveOfficialMaterializerPipeline } from '../src/data/materializerRegistryV1.mjs';
import { JSON_ADAPTER_VERSION } from '../src/data/jsonDailyAdapter.mjs';
import { NORMALIZE_DAILY_BARS_VERSION } from '../src/data/normalizeDailyBars.mjs';

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OFFICIAL_TEST_PIPELINE_ID = 'lab-json-daily/1';
export const HASH_A = `sha256:${'a'.repeat(64)}`;
export const HASH_B = `sha256:${'b'.repeat(64)}`;

/** Assertion matcher for coded errors. @param {string} expected */
export function code(expected) {
  return (error) => error && error.code === expected;
}
/** @param {(store: any, root: string) => unknown} fn */
export function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l2a-'));
  try { return fn(createContentAddressedStore({ root }), root); } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Node 20.0-compatible recursive file listing. @param {string} root */
export function listFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  visit(root);
  return files.sort();
}

export function syntheticTransformManifest(overrides = {}) {
  const manifest = buildTransformImplementationManifestV2({
    labRoot: LAB_ROOT,
    logicalPaths: labPipelineLogicalPaths(OFFICIAL_TEST_PIPELINE_ID),
    runtimeContractVersion: 'directional-lab-runtime/2',
  });
  return { ...manifest, ...overrides };
}

export function syntheticPipelineProfile(overrides = {}) {
  return buildLabTransformPipelineProfile({
    pipelineProfileId: overrides.pipelineProfileId ?? OFFICIAL_TEST_PIPELINE_ID,
    transformManifest: overrides.transformManifest ?? syntheticTransformManifest(),
  });
}

export const DEFAULT_ROWS = Object.freeze([
  Object.freeze(['2026-04-01', 30, 32, 29, 31, 1000]),
  Object.freeze(['2026-04-02', 31, 33, 30, 32, 1100]),
]);

/** @param {readonly (readonly unknown[])[]} rows */
export function syntheticSourceBytes(rows) {
  return Buffer.from(JSON.stringify({
    symbol: 'SYNTH',
    rows: rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume })),
  }), 'utf8');
}

/** Test-only arbitrary callback used solely to prove the official API rejects it. */
export function syntheticMaterializer() {
  return Object.freeze({
    adapt() { throw new Error('test-only callback must never execute'); },
    normalize() { throw new Error('test-only callback must never execute'); },
  });
}

/** Store an official-registry-compatible synthetic JSON snapshot. */
export function buildSyntheticSnapshot(store, options = {}) {
  const rows = options.rows ?? DEFAULT_ROWS;
  const sourceBytes = options.sourceBytes ?? syntheticSourceBytes(rows);
  const storedFromBytes = options.storedFromBytes ?? sourceBytes;
  const manifest = options.manifest ?? syntheticTransformManifest();
  const transformHash = options.coreTransformHash ?? transformImplementationManifestHash(manifest);
  const sourceObjectId = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`;
  const coreFields = {
    canonicalSymbol: 'SYNTH',
    providerId: 'fixture-provider',
    providerSymbol: 'SYNTH',
    sourceFormat: 'OHLC_CACHE_JSON_V1',
    adapterVersion: JSON_ADAPTER_VERSION,
    adapterOptions: options.coreAdapterOptions ?? {},
    normalizerVersion: NORMALIZE_DAILY_BARS_VERSION,
    normalizationOptions: options.coreNormalizationOptions ?? {},
    canonicalSerializationVersion: 'CanonicalJSON/1',
    priceBasis: options.corePriceBasis ?? 'RAW',
    corporateActionPolicyHash: HASH_A,
    calendarId: 'SYNTHETIC_WEEKDAY',
    calendarVersion: 'calendar/1',
    transformImplementationHash: transformHash,
    ...(options.coreOverrides ?? {}),
  };
  const previewCore = {
    schemaVersion: 'DatasetSnapshotCore/1',
    sourceObjectId,
    normalizedObjectId: `sha256:${'0'.repeat(64)}`,
    ...coreFields,
  };
  const pipeline = resolveOfficialMaterializerPipeline({
    pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID,
    transformManifest: manifest,
  });
  const normalizedDailyBars = options.normalizedDailyBars ?? pipeline.materialize({
    sourceBytes: storedFromBytes,
    snapshotCore: previewCore,
  });
  const built = buildDatasetSnapshot({
    store,
    sourceBytes,
    normalizedDailyBars,
    core: coreFields,
    record: {
      sourceAcquiredAt: null,
      ingestedIntoLabAt: options.ingestedIntoLabAt ?? '2026-07-18T14:00:00Z',
      acquisitionMethod: 'synthetic-fixture',
      acquisitionToolVersion: 'fixture-tool/1',
      acquisitionRequestIdentity: { request: 'fixture-only' },
      acquisitionEvidenceIds: [],
      ...(options.recordOverrides ?? {}),
    },
  });
  return { built, manifest, sourceBytes, pipelineProfileId: OFFICIAL_TEST_PIPELINE_ID };
}
