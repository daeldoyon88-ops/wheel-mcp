import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_SET_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
  compareMarketFeaturePublicationRegistryEntries,
  normalizeMarketFeaturePublicationRegistryManifestV1,
} from '../src/contracts/marketFeaturePublicationContractsV1.mjs';
import {
  MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS,
  MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketTechnicalFeatureComputationL4V1.mjs';
import {
  MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS,
  MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketVolumeStructureFeatureComputationL4V1.mjs';
import {
  MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
  MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
} from '../src/contracts/marketSeasonalityFeatureComputationL4V1.mjs';
import {
  verifyMarketFeaturePublicationRegistryChainV1,
  verifyMarketFeaturePublicationRegistryGraphV1,
  verifyMarketFeaturePublicationRegistryManifest,
  verifyMarketFeaturePublicationRegistryReferenceValuesV1,
} from '../src/publication/marketFeaturePublicationRegistryV1.mjs';

const id = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
const policyId = id(900);
const coverage = () => ({ rowCount: 2, firstSessionDate: '2026-01-02',
  lastSessionDate: '2026-01-03', orderedRowIdentityDigest: id(901) });
const key = (overrides = {}) => ({ instrumentIdentityId: id(1), datasetSnapshotBindingId: id(2),
  publicationAuthorityPolicyId: policyId, featureSetVersion: MARKET_FEATURE_SET_VERSION, ...overrides });

function family(code, offset) {
  const technical = code === MARKET_TECHNICAL_FEATURE_FAMILY_CODE;
  const volume = code === MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE;
  return { familyCode: code,
    featureFamilyVersion: technical ? { ...MARKET_TECHNICAL_FEATURE_FAMILY_VERSIONS }
      : volume ? { ...MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_VERSIONS }
        : MARKET_SEASONALITY_FEATURE_FAMILY_VERSION,
    rowsSchemaVersion: technical ? MARKET_TECHNICAL_FEATURE_ROWS_SCHEMA_VERSION
      : volume ? MARKET_VOLUME_STRUCTURE_FEATURE_ROWS_SCHEMA_VERSION
        : MARKET_SEASONALITY_FEATURE_ROWS_SCHEMA_VERSION,
    reportSchemaVersion: technical ? MARKET_TECHNICAL_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION
      : volume ? MARKET_VOLUME_STRUCTURE_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION
        : MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION,
    sourceBundleId: id(offset), computationPolicyId: id(offset + 1), rowsId: id(offset + 2),
    reportId: id(offset + 3), implementationManifestId: id(offset + 4), instrumentIdentityId: id(1),
    datasetSnapshotBindingId: id(2), datasetSnapshotManifestId: id(3),
    normalizedMarketDataObjectId: id(4), calendarRegistryManifestId: id(5),
    knowledgeCutoff: '2026-01-03T22:00:00.000Z',
    temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED', priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', ...coverage() };
}

function publication() {
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: policyId, featureSetVersion: MARKET_FEATURE_SET_VERSION,
    instrumentIdentityId: id(1), datasetSnapshotBindingId: id(2), datasetSnapshotManifestId: id(3),
    normalizedMarketDataObjectId: id(4), calendarRegistryManifestId: id(5),
    knowledgeCutoff: '2026-01-03T22:00:00.000Z',
    temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED', priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', sessionCoverage: coverage(),
    families: [family(MARKET_TECHNICAL_FEATURE_FAMILY_CODE, 10),
      family(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE, 20),
      family(MARKET_SEASONALITY_FEATURE_FAMILY_CODE, 30)] };
}

function entry(number, cutoff = '2026-01-03T22:00:00.000Z', parent = null, logicalKey = key()) {
  return { publicationManifestId: id(number), logicalKey, knowledgeCutoff: cutoff,
    sessionCoverage: coverage(), supersedesPublicationManifestId: parent };
}

function registry(entries = [], parent = null, authority = policyId) {
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_REGISTRY_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: authority, supersedesRegistryManifestId: parent,
    entries: [...entries].sort(compareMarketFeaturePublicationRegistryEntries) };
}

function refs(registryValue, entries, manifests) {
  return verifyMarketFeaturePublicationRegistryReferenceValuesV1(
    registryValue, entries, new Map(manifests));
}

function fakeStore(documents) {
  const map = new Map(documents);
  const missing = () => {
    const error = new Error('missing'); error.details = { fsCode: 'ENOENT' }; throw error;
  };
  return {
    putCanonicalObject() { throw new Error('not used'); },
    putSourceBytes() { throw new Error('not used'); },
    uriForObject({ objectId }) { return `memory:${objectId}`; },
    readObject({ expectedObjectId }) {
      const value = map.get(expectedObjectId); if (!value) return missing();
      return { bytes: canonicalJsonBytes(value) };
    },
    readCanonicalObject({ expectedObjectId }) {
      const value = map.get(expectedObjectId); if (!value) return missing();
      return { value };
    },
  };
}

const closedPolicy = { schemaVersion: MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  ...structuredClone(MARKET_FEATURE_PUBLICATION_POLICY_VALUES) };
const genesisId = id(800);
const registryId = id(801);
const validPublication = publication();
const validEntry = entry(100);

function fullRegistryWith(documents, selectedRegistryId = registryId) {
  return verifyMarketFeaturePublicationRegistryManifest({ store: fakeStore(documents),
    registryManifestId: selectedRegistryId });
}

const cases = [
  ['publication inexistante', () => fullRegistryWith([[policyId, closedPolicy],
    [genesisId, registry()], [registryId, registry([validEntry], genesisId)]])],
  ['publication mauvais schéma', () => fullRegistryWith([[policyId, closedPolicy],
    [genesisId, registry()], [registryId, registry([validEntry], genesisId)],
    [validEntry.publicationManifestId, closedPolicy]])],
  ['policy inexistante', () => fullRegistryWith([[genesisId, registry()]], genesisId)],
  ['mauvais featureSetVersion', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ featureSetVersion: 'MARKET_FEATURE_SET_L4A_ABC/2' }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['mauvaise clé logique', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ instrumentIdentityId: id(77) }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['duplicate entry', () => verifyMarketFeaturePublicationRegistryGraphV1([validEntry, validEntry])],
  ['suppression ancienne entrée', () => verifyMarketFeaturePublicationRegistryChainV1([
    { registryManifestId: genesisId, registry: registry() },
    { registryManifestId: id(802), registry: registry([validEntry], genesisId) },
    { registryManifestId: id(803), registry: registry([entry(101)], id(802)) }])],
  ['modification ancienne entrée', () => verifyMarketFeaturePublicationRegistryChainV1([
    { registryManifestId: genesisId, registry: registry() },
    { registryManifestId: id(802), registry: registry([validEntry], genesisId) },
    { registryManifestId: id(803), registry: registry([
      { ...validEntry, knowledgeCutoff: '2026-01-04T22:00:00.000Z' }, entry(101)], id(802)) }])],
  ['ordre historique modifié', () => normalizeMarketFeaturePublicationRegistryManifestV1({
    ...registry(), entries: [entry(102, '2026-01-04T22:00:00.000Z'), validEntry] })],
  ['supersedesRegistryManifestId inexistant', () => fullRegistryWith([
    [policyId, closedPolicy], [registryId, registry([], id(999))]])],
  ['mauvais parent registry', () => verifyMarketFeaturePublicationRegistryChainV1([
    { registryManifestId: genesisId, registry: registry() },
    { registryManifestId: registryId, registry: registry([validEntry], id(999)) }])],
  ['registry self-cycle', () => fullRegistryWith([[policyId, closedPolicy],
    [registryId, registry([], registryId)]])],
  ['cycle registry 2', () => fullRegistryWith([[policyId, closedPolicy],
    [registryId, registry([], id(802))], [id(802), registry([], registryId)]])],
  ['cycle registry 3', () => fullRegistryWith([[policyId, closedPolicy],
    [registryId, registry([], id(802))], [id(802), registry([], id(803))],
    [id(803), registry([], registryId)]])],
  ['publication self-supersedes', () => verifyMarketFeaturePublicationRegistryGraphV1([
    { ...validEntry, supersedesPublicationManifestId: validEntry.publicationManifestId }])],
  ['publication cycle 2', () => verifyMarketFeaturePublicationRegistryGraphV1([
    entry(100, '2026-01-03T22:00:00.000Z', id(101)),
    entry(101, '2026-01-03T22:00:00.000Z', id(100))])],
  ['publication cycle 3', () => verifyMarketFeaturePublicationRegistryGraphV1([
    entry(100, '2026-01-03T22:00:00.000Z', id(102)),
    entry(101, '2026-01-03T22:00:00.000Z', id(100)),
    entry(102, '2026-01-03T22:00:00.000Z', id(101))])],
  ['deux tips même clé', () => verifyMarketFeaturePublicationRegistryGraphV1([validEntry, entry(101)])],
  ['deux branches concurrentes', () => verifyMarketFeaturePublicationRegistryGraphV1([
    validEntry, entry(101, '2026-01-04T22:00:00.000Z', id(100)),
    entry(102, '2026-01-04T22:00:00.000Z', id(100))])],
  ['tip sans parent', () => verifyMarketFeaturePublicationRegistryGraphV1([
    validEntry, entry(101, '2026-01-04T22:00:00.000Z')])],
  ['parent non présent', () => verifyMarketFeaturePublicationRegistryGraphV1([
    entry(101, '2026-01-04T22:00:00.000Z', id(999))])],
  ['tip marqué incorrectement', () => normalizeMarketFeaturePublicationRegistryManifestV1({
    ...registry(), entries: [{ ...validEntry, tip: true }] })],
  ['clé inconnue', () => normalizeMarketFeaturePublicationRegistryManifestV1({
    ...registry(), unknown: true })],
  ['propriété non énumérable', () => {
    const value = registry(); Object.defineProperty(value, 'hidden', { value: true });
    return normalizeMarketFeaturePublicationRegistryManifestV1(value);
  }],
  ['accesseur', () => {
    const value = registry(); Object.defineProperty(value, 'entries', { enumerable: true, get: () => [] });
    return normalizeMarketFeaturePublicationRegistryManifestV1(value);
  }],
  ['clé Symbol', () => {
    const value = registry(); value[Symbol('hidden')] = true;
    return normalizeMarketFeaturePublicationRegistryManifestV1(value);
  }],
  ['knowledgeCutoff incohérent', () => verifyMarketFeaturePublicationRegistryGraphV1([
    validEntry, entry(101, '2026-01-02T22:00:00.000Z', id(100))])],
  ['publication future avant parent causal', () => verifyMarketFeaturePublicationRegistryGraphV1([
    entry(100, '2026-01-05T22:00:00.000Z'),
    entry(101, '2026-01-04T22:00:00.000Z', id(100))])],
  ['manifest instrument différent de la clé', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ instrumentIdentityId: id(77) }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['binding différent de la clé', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ datasetSnapshotBindingId: id(77) }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['policy différente de la clé', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ publicationAuthorityPolicyId: id(77) }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['featureSetVersion différente de la clé', () => refs(registry([validEntry]),
    [{ ...validEntry, logicalKey: key({ featureSetVersion: 'MARKET_FEATURE_SET_L4A_ABC/2' }) }],
    [[validEntry.publicationManifestId, validPublication]])],
  ['ordre canonique invalide', () => normalizeMarketFeaturePublicationRegistryManifestV1({
    ...registry(), entries: [entry(102, '2026-01-04T22:00:00.000Z'), validEntry] })],
  ['registry autre store sans références', () => fullRegistryWith([[policyId, closedPolicy],
    [registryId, registry([validEntry], id(999))]])],
  ['mutation in-place simulée', () => verifyMarketFeaturePublicationRegistryChainV1([
    { registryManifestId: genesisId, registry: registry() },
    { registryManifestId: id(802), registry: registry([validEntry], genesisId) },
    { registryManifestId: id(803), registry: registry([
      { ...validEntry, sessionCoverage: { ...coverage(), rowCount: 3 } },
      entry(101, '2026-01-04T22:00:00.000Z', id(100))], id(802)) }])],
];

test('L4A-C3 registry adversarial — exactement 35 corruptions refusées', async (t) => {
  assert.equal(cases.length, 35);
  for (const [name, attack] of cases) await t.test(name, () => assert.throws(attack));
});
