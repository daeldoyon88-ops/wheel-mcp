import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonBytes } from '../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { createContentAddressedStore } from '../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import {
  buildMacroIngestionPolicy,
  verifyMacroIngestionPolicy,
} from '../research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  buildMacroAsOfResolutionPolicy,
  verifyMacroAsOfResolutionPolicy,
} from '../research/directional-lab/src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import {
  buildMacroSeriesRegistryGenesis,
  verifyMacroSeriesRegistryManifest,
} from '../research/directional-lab/src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  buildMacroVintageSetManifest,
  verifyMacroVintageSetManifest,
} from '../research/directional-lab/src/macro/macroVintageSetL4BV1.mjs';
import {
  buildMacroDatasetSnapshotManifest,
  verifyMacroDatasetSnapshotManifest,
} from '../research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs';

export const MISSION_ID = 'WHEEL_JARVISE_G24_EMPTY_UNAVAILABLE_MACRO_CONTEXT_BUILD_R1';
export const PRODUCER_CLASSIFICATION = 'R2_LOCAL_MACRO_UNAVAILABLE_PROVENANCE';
export const MACRO_CONTEXT_RELATIVE_ROOT = 'data/jarvise/macro-context';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_OUTPUT_ROOT = resolve(REPOSITORY_ROOT, ...MACRO_CONTEXT_RELATIVE_ROOT.split('/'));

export class JarviseEmptyMacroContextMaterializationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseEmptyMacroContextMaterializationError';
    this.code = code;
    this.details = details;
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new JarviseEmptyMacroContextMaterializationError(
      'G24_EMPTY_MACRO_CONTEXT_SCOPE_EXPANSION_REQUIRED',
      'the CAS contains a non-regular filesystem entry',
      { path: relative(root, path) },
    );
  }
  return files.sort();
}

function byteInventory(root) {
  return Object.fromEntries(regularFiles(root).map((path) => {
    const bytes = readFileSync(path);
    return [relative(root, path).replaceAll('\\', '/'), {
      byteLength: bytes.length,
      sha256: sha256(bytes),
    }];
  }));
}

function writeStableCanonical(path, value) {
  const bytes = canonicalJsonBytes(value);
  if (existsSync(path)) {
    const present = readFileSync(path);
    if (!present.equals(bytes)) {
      throw new JarviseEmptyMacroContextMaterializationError(
        'G24_EMPTY_CONTEXT_IDEMPOTENCE_FAILURE',
        'existing non-authoritative metadata differs from the deterministic projection',
        { path },
      );
    }
    return { created: false, byteLength: present.length, sha256: sha256(present) };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' });
  const persisted = readFileSync(path);
  if (!persisted.equals(bytes)) {
    throw new JarviseEmptyMacroContextMaterializationError(
      'G24_EMPTY_CONTEXT_IDEMPOTENCE_FAILURE',
      'persisted metadata bytes differ from their canonical bytes',
      { path },
    );
  }
  return { created: true, byteLength: persisted.length, sha256: sha256(persisted) };
}

function assertOutputRoot(options) {
  const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT);
  if (outputRoot !== DEFAULT_OUTPUT_ROOT && options.testOnlyAllowOutputRoot !== true) {
    throw new JarviseEmptyMacroContextMaterializationError(
      'G24_EMPTY_MACRO_CONTEXT_SCOPE_EXPANSION_REQUIRED',
      'a non-production output root is allowed only for isolated tests',
    );
  }
  return outputRoot;
}

function assertEmptyTruth(registry, vintageSet, snapshot) {
  const valid = registry.orderedSeriesEntries.length === 0
    && vintageSet.orderedObservationEntries.length === 0
    && vintageSet.orderedVintageIds.length === 0
    && vintageSet.observationCount === 0
    && vintageSet.vintageCount === 0
    && vintageSet.firstAvailableAt === null
    && vintageSet.lastAvailableAt === null
    && snapshot.seriesCount === 0
    && snapshot.observationCount === 0
    && snapshot.vintageCount === 0
    && snapshot.firstAvailableAt === null
    && snapshot.lastAvailableAt === null
    && snapshot.emptySnapshot === true;
  if (!valid) {
    throw new JarviseEmptyMacroContextMaterializationError(
      'G24_ZERO_SERIES_RUNTIME_CONTRADICTION',
      'unchanged macro builders did not produce the accepted empty state',
    );
  }
}

export function materializeJarviseEmptyMacroContextR1(options = {}) {
  const outputRoot = assertOutputRoot(options);
  const casRoot = join(outputRoot, 'cas');
  mkdirSync(casRoot, { recursive: true });
  const before = byteInventory(casRoot);
  const store = createContentAddressedStore({ root: casRoot });

  const ingestion = buildMacroIngestionPolicy({ store });
  const asOf = buildMacroAsOfResolutionPolicy({ store });
  const registry = buildMacroSeriesRegistryGenesis({ store, entries: [] });
  const vintageSet = buildMacroVintageSetManifest({
    store,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    supersedesVintageSetManifestId: null,
    observationVintageIds: [],
  });
  const snapshot = buildMacroDatasetSnapshotManifest({
    store,
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
  });

  const verified = {
    macroIngestionPolicy: verifyMacroIngestionPolicy({
      store, macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    }),
    macroAsOfResolutionPolicy: verifyMacroAsOfResolutionPolicy({
      store, macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
    }),
    macroSeriesRegistryManifest: verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    }),
    macroVintageSetManifest: verifyMacroVintageSetManifest({
      store, macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    }),
    macroDatasetSnapshotManifest: verifyMacroDatasetSnapshotManifest({
      store, macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
    }),
  };
  assertEmptyTruth(
    verified.macroSeriesRegistryManifest.registry,
    verified.macroVintageSetManifest.vintageSet,
    verified.macroDatasetSnapshotManifest.datasetSnapshot,
  );

  const artifacts = [
    ['MacroIngestionPolicy/1', ingestion.macroIngestionPolicyId],
    ['MacroAsOfResolutionPolicy/1', asOf.macroAsOfResolutionPolicyId],
    ['MacroSeriesRegistryManifest/1', registry.macroSeriesRegistryManifestId],
    ['MacroVintageSetManifest/1', vintageSet.macroVintageSetManifestId],
    ['MacroDatasetSnapshotManifest/1', snapshot.macroDatasetSnapshotManifestId],
  ].map(([schemaVersion, objectId]) => ({
    schemaVersion,
    objectId,
    uri: store.uriForObject({ namespace: 'snapshots', objectId }),
  }));
  const expectedFiles = artifacts.map((artifact) => artifact.uri).sort();
  const actualFiles = regularFiles(casRoot)
    .map((path) => relative(casRoot, path).replaceAll('\\', '/'))
    .sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new JarviseEmptyMacroContextMaterializationError(
      'G24_EMPTY_MACRO_CONTEXT_SCOPE_EXPANSION_REQUIRED',
      'the production CAS file cohort is not exactly the five authoritative objects',
      { expectedFiles, actualFiles },
    );
  }

  const ids = Object.freeze({
    macroIngestionPolicyId: ingestion.macroIngestionPolicyId,
    macroAsOfResolutionPolicyId: asOf.macroAsOfResolutionPolicyId,
    macroSeriesRegistryManifestId: registry.macroSeriesRegistryManifestId,
    macroVintageSetManifestId: vintageSet.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: snapshot.macroDatasetSnapshotManifestId,
  });
  const bindingProjection = {
    schemaVersion: 'JarviseEmptyMacroContextBindingProjection/1',
    authoritative: false,
    producerClassification: PRODUCER_CLASSIFICATION,
    macroVintageSetManifestId: ids.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: ids.macroDatasetSnapshotManifestId,
    availableAtPolicyId: ids.macroAsOfResolutionPolicyId,
    macroIngestionPolicyId: ids.macroIngestionPolicyId,
    macroSeriesRegistryManifestId: ids.macroSeriesRegistryManifestId,
  };
  const provenance = {
    schemaVersion: 'JarviseEmptyMacroContextProvenance/1',
    authoritative: false,
    mission: MISSION_ID,
    producerClassification: PRODUCER_CLASSIFICATION,
    truthStatement: "At materialization, this Jarvise implementation admitted no macro observations. This is a statement about this producer's admitted content, not about macro-data availability in the market.",
    artifactIds: ids,
    builderModules: [
      'research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs::buildMacroIngestionPolicy',
      'research/directional-lab/src/macro/macroAsOfResolutionPolicyL4BV1.mjs::buildMacroAsOfResolutionPolicy',
      'research/directional-lab/src/macro/macroSeriesRegistryL4BV1.mjs::buildMacroSeriesRegistryGenesis',
      'research/directional-lab/src/macro/macroVintageSetL4BV1.mjs::buildMacroVintageSetManifest',
      'research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs::buildMacroDatasetSnapshotManifest',
    ],
    runtimeModule: 'app/jarvise/jarviseEmptyMacroContextProducerR1.mjs',
    bindingContract: 'governance/gates/GATE24/implementation/macro-context-binding-v1.mjs::GATE24_MacroContextBinding/1',
  };
  const projectionWrite = writeStableCanonical(join(outputRoot, 'binding-projection.json'), bindingProjection);
  const provenanceWrite = writeStableCanonical(join(outputRoot, 'PROVENANCE.json'), provenance);
  const after = byteInventory(casRoot);
  const changedAuthoritativePaths = Object.keys(after).filter(
    (path) => before[path] && before[path].sha256 !== after[path].sha256,
  );
  if (changedAuthoritativePaths.length > 0) {
    throw new JarviseEmptyMacroContextMaterializationError(
      'G24_EMPTY_CONTEXT_IDEMPOTENCE_FAILURE',
      'an existing authoritative object changed bytes',
      { changedAuthoritativePaths },
    );
  }

  return Object.freeze({
    status: 'MATERIALIZED_AND_VERIFIED',
    outputRoot,
    authoritativeObjectCount: artifacts.length,
    authoritativeSchemas: artifacts.map((artifact) => artifact.schemaVersion),
    ids,
    artifacts: artifacts.map((artifact) => Object.freeze({
      ...artifact,
      created: before[artifact.uri] === undefined,
      ...after[artifact.uri],
      verified: true,
    })),
    emptyState: Object.freeze({
      seriesCount: snapshot.datasetSnapshot.seriesCount,
      observationCount: snapshot.datasetSnapshot.observationCount,
      vintageCount: snapshot.datasetSnapshot.vintageCount,
      firstAvailableAt: snapshot.datasetSnapshot.firstAvailableAt,
      lastAvailableAt: snapshot.datasetSnapshot.lastAvailableAt,
      emptySnapshot: snapshot.datasetSnapshot.emptySnapshot,
    }),
    newAuthoritativeObjectCount: artifacts.filter((artifact) => before[artifact.uri] === undefined).length,
    changedAuthoritativeIds: 0,
    changedAuthoritativeBytes: changedAuthoritativePaths.length,
    duplicateAuthorities: 0,
    bindingProjection: Object.freeze({ authoritative: false, ...projectionWrite }),
    provenance: Object.freeze({ authoritative: false, ...provenanceWrite }),
  });
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    process.stdout.write(`${JSON.stringify(materializeJarviseEmptyMacroContextR1(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      verdict: error?.code ?? 'REPAIR_REQUIRED',
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
