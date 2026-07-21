import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  MARKET_FEATURE_PUBLICATION_POLICY_VALUES,
  MARKET_FEATURE_SET_VERSION,
  MARKET_SEASONALITY_FEATURE_FAMILY_CODE,
  MARKET_TECHNICAL_FEATURE_FAMILY_CODE,
  MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE,
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
import { assertMarketFeaturePublicationManifestMatchesV1 } from '../src/publication/marketFeaturePublicationV1.mjs';

const id = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
const coverage = () => ({ rowCount: 2, firstSessionDate: '2026-01-02',
  lastSessionDate: '2026-01-03', orderedRowIdentityDigest: id(90) });

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

function manifest() {
  return { schemaVersion: MARKET_FEATURE_PUBLICATION_MANIFEST_SCHEMA_VERSION,
    publicationAuthorityPolicyId: id(6), featureSetVersion: MARKET_FEATURE_SET_VERSION,
    instrumentIdentityId: id(1), datasetSnapshotBindingId: id(2), datasetSnapshotManifestId: id(3),
    normalizedMarketDataObjectId: id(4), calendarRegistryManifestId: id(5),
    knowledgeCutoff: '2026-01-03T22:00:00.000Z',
    temporalCapability: 'POINT_IN_TIME_PUBLICATION_ATTESTED', priceBasis: 'RAW',
    corporateActionTreatment: 'RAW_SOURCE_UNTRANSFORMED', sessionCoverage: coverage(),
    families: [family(MARKET_TECHNICAL_FEATURE_FAMILY_CODE, 10),
      family(MARKET_VOLUME_STRUCTURE_FEATURE_FAMILY_CODE, 20),
      family(MARKET_SEASONALITY_FEATURE_FAMILY_CODE, 30)] };
}

const cases = [
  ['famille A supprimée', (v) => v.families.splice(0, 1)],
  ['famille B supprimée', (v) => v.families.splice(1, 1)],
  ['famille C supprimée', (v) => v.families.splice(2, 1)],
  ['famille A dupliquée', (v) => { v.families[1] = structuredClone(v.families[0]); }],
  ['famille inconnue ajoutée', (v) => v.families.push({ ...structuredClone(v.families[2]), familyCode: 'UNKNOWN' })],
  ['ordre A/C/B', (v) => { [v.families[1], v.families[2]] = [v.families[2], v.families[1]]; }],
  ['familyCode modifié', (v) => { v.families[0].familyCode = 'UNKNOWN'; }],
  ['featureFamilyVersion modifiée', (v) => { v.families[0].featureFamilyVersion.returnsDrawdowns = 'BAD'; }],
  ['rowsSchemaVersion modifiée', (v) => { v.families[0].rowsSchemaVersion = 'Bad/1'; }],
  ['reportSchemaVersion modifiée', (v) => { v.families[0].reportSchemaVersion = 'Bad/1'; }],
  ['sourceBundleId modifié', (v) => { v.families[0].sourceBundleId = id(101); }],
  ['policyId modifié', (v) => { v.families[0].computationPolicyId = id(102); }],
  ['rowsId modifié', (v) => { v.families[0].rowsId = id(103); }],
  ['reportId modifié', (v) => { v.families[0].reportId = id(104); }],
  ['implementationManifestId modifié', (v) => { v.families[0].implementationManifestId = id(105); }],
  ['instrumentIdentityId famille modifié', (v) => { v.families[0].instrumentIdentityId = id(106); }],
  ['bindingId famille modifié', (v) => { v.families[0].datasetSnapshotBindingId = id(107); }],
  ['normalizedMarketDataObjectId modifié', (v) => { v.families[0].normalizedMarketDataObjectId = id(108); }],
  ['knowledgeCutoff modifié', (v) => { v.families[0].knowledgeCutoff = '2026-01-04T22:00:00.000Z'; }],
  ['priceBasis modifiée', (v) => { v.families[0].priceBasis = 'SPLIT_ADJUSTED'; }],
  ['corporateActionTreatment modifié', (v) => { v.families[0].corporateActionTreatment = 'SPLIT_ADJUSTED'; }],
  ['rowCount modifié', (v) => { v.families[0].rowCount = 3; }],
  ['firstSessionDate modifiée', (v) => { v.families[0].firstSessionDate = '2026-01-01'; }],
  ['lastSessionDate modifiée', (v) => { v.families[0].lastSessionDate = '2026-01-04'; }],
  ['digest famille modifié', (v) => { v.families[0].orderedRowIdentityDigest = id(109); }],
  ['instrument parent modifié', (v) => { v.instrumentIdentityId = id(110); }],
  ['binding parent modifié', (v) => { v.datasetSnapshotBindingId = id(111); }],
  ['snapshot parent modifié', (v) => { v.datasetSnapshotManifestId = id(112); }],
  ['cutoff parent modifié', (v) => { v.knowledgeCutoff = '2026-01-04T22:00:00.000Z'; }],
  ['price basis parent modifiée', (v) => { v.priceBasis = 'SPLIT_ADJUSTED'; }],
  ['treatment parent modifié', (v) => { v.corporateActionTreatment = 'SPLIT_ADJUSTED'; }],
  ['rowCount parent modifié', (v) => { v.sessionCoverage.rowCount = 3; }],
  ['first date parent modifiée', (v) => { v.sessionCoverage.firstSessionDate = '2026-01-01'; }],
  ['last date parent modifiée', (v) => { v.sessionCoverage.lastSessionDate = '2026-01-04'; }],
  ['digest parent modifié', (v) => { v.sessionCoverage.orderedRowIdentityDigest = id(113); }],
  ['authorityPolicyId modifié', (v) => { v.publicationAuthorityPolicyId = id(114); }],
  ['featureSetVersion modifiée', (v) => { v.featureSetVersion = 'MARKET_FEATURE_SET_L4A_ABC/2'; }],
  ['clé inconnue', (v) => { v.unknown = true; }],
  ['propriété non énumérable', (v) => Object.defineProperty(v, 'hidden', { value: true })],
  ['accesseur', (v) => Object.defineProperty(v, 'priceBasis', { enumerable: true, get: () => 'RAW' })],
  ['clé Symbol', (v) => { v[Symbol('hidden')] = true; }],
  ['ordre de tableaux invalide', (v) => v.families.reverse()],
  ['famille non vérifiable', (v) => { v.families[1].sourceBundleId = id(115); }],
  ['manifest lié à un autre report', (v) => { v.families[1].reportId = v.families[0].reportId; }],
  ['manifest lié à un autre binding', (v) => { v.families[2].datasetSnapshotBindingId = id(116); }],
];

test('L4A-C3 manifeste adversarial — exactement 45 corruptions refusées', async (t) => {
  assert.equal(cases.length, 45);
  const expected = manifest();
  assert.doesNotThrow(() => assertMarketFeaturePublicationManifestMatchesV1(expected, expected));
  for (const [name, mutate] of cases) await t.test(name, () => {
    const observed = structuredClone(expected);
    mutate(observed);
    assert.throws(() => assertMarketFeaturePublicationManifestMatchesV1(observed, expected));
  });
});

test('L4A-C3 policy fixture remains the exact closed authority', () => {
  assert.equal(MARKET_FEATURE_PUBLICATION_AUTHORITY_POLICY_SCHEMA_VERSION,
    'MarketFeaturePublicationAuthorityPolicy/1');
  assert.equal(MARKET_FEATURE_PUBLICATION_POLICY_VALUES.requiredFeatureSetVersion,
    MARKET_FEATURE_SET_VERSION);
});
