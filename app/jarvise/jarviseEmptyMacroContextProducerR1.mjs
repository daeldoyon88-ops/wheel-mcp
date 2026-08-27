import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContentAddressedStore } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { verifyMacroIngestionPolicy } from '../../research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs';
import { verifyMacroAsOfResolutionPolicy } from '../../research/directional-lab/src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { verifyMacroSeriesRegistryManifest } from '../../research/directional-lab/src/macro/macroSeriesRegistryL4BV1.mjs';
import { verifyMacroVintageSetManifest } from '../../research/directional-lab/src/macro/macroVintageSetL4BV1.mjs';
import { verifyMacroDatasetSnapshotManifest } from '../../research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs';
import {
  createMacroContextBinding,
  resolveMacroSnapshot,
} from '../../governance/gates/GATE24/implementation/macro-context-binding-v1.mjs';

export const JARVISE_EMPTY_MACRO_CONTEXT_PRODUCER_CLASSIFICATION =
  'R2_LOCAL_MACRO_UNAVAILABLE_PROVENANCE';
export const EMPTY_MACRO_VINTAGE_STORE = Object.freeze({});

const MODULE_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(MODULE_PATH), '../..');
const DEFAULT_DATA_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/macro-context');
const CAS_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

export class JarviseEmptyMacroContextAuthorityError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseEmptyMacroContextAuthorityError';
    this.code = code;
    this.details = details;
  }
}

function refuse(message, details = {}) {
  throw new JarviseEmptyMacroContextAuthorityError(
    'G24_EMPTY_MACRO_CONTEXT_AUTHORITY_REFUSED',
    message,
    details,
  );
}

function readProjection(dataRoot) {
  let projection;
  try {
    projection = JSON.parse(readFileSync(join(dataRoot, 'binding-projection.json'), 'utf8'));
  } catch (cause) {
    refuse('binding projection is missing or unreadable', { causeCode: cause?.code });
  }
  const requiredIds = [
    'macroIngestionPolicyId',
    'macroSeriesRegistryManifestId',
    'macroVintageSetManifestId',
    'macroDatasetSnapshotManifestId',
    'availableAtPolicyId',
  ];
  if (projection?.schemaVersion !== 'JarviseEmptyMacroContextBindingProjection/1'
      || projection.authoritative !== false
      || projection.producerClassification !== JARVISE_EMPTY_MACRO_CONTEXT_PRODUCER_CLASSIFICATION
      || requiredIds.some((field) => !CAS_ID_PATTERN.test(projection[field] ?? ''))) {
    refuse('binding projection is structurally invalid');
  }
  return projection;
}

function verifyAuthority(dataRoot, projection) {
  let store;
  try {
    store = createContentAddressedStore({ root: join(dataRoot, 'cas') });
    const ingestion = verifyMacroIngestionPolicy({
      store, macroIngestionPolicyId: projection.macroIngestionPolicyId,
    });
    const asOf = verifyMacroAsOfResolutionPolicy({
      store, macroAsOfResolutionPolicyId: projection.availableAtPolicyId,
    });
    const registry = verifyMacroSeriesRegistryManifest({
      store, macroSeriesRegistryManifestId: projection.macroSeriesRegistryManifestId,
    });
    const vintageSet = verifyMacroVintageSetManifest({
      store, macroVintageSetManifestId: projection.macroVintageSetManifestId,
    });
    const snapshot = verifyMacroDatasetSnapshotManifest({
      store, macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId,
    });
    const referencesMatch = vintageSet.vintageSet.macroIngestionPolicyId
        === ingestion.macroIngestionPolicyId
      && vintageSet.vintageSet.macroSeriesRegistryManifestId
        === registry.macroSeriesRegistryManifestId
      && snapshot.datasetSnapshot.macroIngestionPolicyId
        === ingestion.macroIngestionPolicyId
      && snapshot.datasetSnapshot.macroSeriesRegistryManifestId
        === registry.macroSeriesRegistryManifestId
      && snapshot.datasetSnapshot.macroVintageSetManifestId
        === vintageSet.macroVintageSetManifestId
      && asOf.macroAsOfResolutionPolicyId === projection.availableAtPolicyId;
    if (!referencesMatch) refuse('persisted macro authority references disagree');
    const emptyTruth = registry.registry.orderedSeriesEntries.length === 0
      && vintageSet.vintageSet.orderedObservationEntries.length === 0
      && vintageSet.vintageSet.orderedVintageIds.length === 0
      && vintageSet.vintageSet.observationCount === 0
      && vintageSet.vintageSet.vintageCount === 0
      && snapshot.datasetSnapshot.seriesCount === 0
      && snapshot.datasetSnapshot.observationCount === 0
      && snapshot.datasetSnapshot.vintageCount === 0
      && snapshot.datasetSnapshot.emptySnapshot === true;
    if (!emptyTruth) refuse('persisted macro authority is not the admitted empty context');
    return Object.freeze({ ingestion, asOf, registry, vintageSet, snapshot });
  } catch (cause) {
    if (cause instanceof JarviseEmptyMacroContextAuthorityError) throw cause;
    refuse('a projected ID is not backed by its verified CAS artifact', {
      causeCode: cause?.code,
      causeMessage: cause?.message,
    });
  }
}

export function produceJarviseEmptyMacroContextR1({ knowledgeCutoff, dataRoot } = {}) {
  const resolvedDataRoot = resolve(dataRoot ?? DEFAULT_DATA_ROOT);
  const projection = readProjection(resolvedDataRoot);
  const authority = verifyAuthority(resolvedDataRoot, projection);
  const macroContextBinding = createMacroContextBinding({
    macroVintageSetManifestId: projection.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId,
    availableAtPolicyId: projection.availableAtPolicyId,
  });
  const macroSnapshotResolution = resolveMacroSnapshot({
    macroContextBinding,
    vintageStore: EMPTY_MACRO_VINTAGE_STORE,
    knowledgeCutoff,
  });
  return Object.freeze({
    producerClassification: JARVISE_EMPTY_MACRO_CONTEXT_PRODUCER_CLASSIFICATION,
    authority,
    macroContextBinding,
    vintageStore: EMPTY_MACRO_VINTAGE_STORE,
    macroSnapshotResolution,
  });
}
