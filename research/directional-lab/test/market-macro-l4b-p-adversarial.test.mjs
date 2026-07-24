import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKET_MACRO_AUTHORITY_PIN_FIELDS,
  MARKET_MACRO_AUTHORITY_POLICY_VALUES,
  MARKET_MACRO_COVERAGE_COUNT_FIELDS,
  normalizeMarketMacroFeatureAuthorityPolicyV1,
  normalizeMarketMacroFeatureCoverageReportV1,
  normalizeMarketMacroFeaturePublicationManifestV1,
  normalizeMarketMacroFeatureRegistryManifestV1,
} from '../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import {
  sampleCoverage,
  samplePolicy,
  samplePublication,
  sampleRegistry,
} from './helpers/marketMacroFeaturePublicationSamplesL4BPV1.mjs';

const cases = [];
const add = (name, factory, normalize, corrupt) =>
  cases.push({ name, factory, normalize, corrupt });

for (const field of Object.keys(MARKET_MACRO_AUTHORITY_POLICY_VALUES)) {
  if (field === 'schemaVersion') continue;
  add(`policy divergence ${field}`, samplePolicy,
    normalizeMarketMacroFeatureAuthorityPolicyV1,
    (value) => { value[field] = typeof value[field] === 'boolean' ? !value[field] : 'FORGED'; });
}

for (let index = 0; index < 8; index += 1) {
  add(`registry family ${index} unknown`, sampleRegistry,
    normalizeMarketMacroFeatureRegistryManifestV1,
    (value) => { value.entries[index].familyCode = `FORGED_${index}`; });
  add(`registry rows ${index} malformed`, sampleRegistry,
    normalizeMarketMacroFeatureRegistryManifestV1,
    (value) => { value.entries[index].rowsId = 'latest'; });
  add(`registry entry digest ${index} malformed`, sampleRegistry,
    normalizeMarketMacroFeatureRegistryManifestV1,
    (value) => { value.entries[index].entryIdentityDigest = `sha256:${'A'.repeat(64)}`; });
}
add('registry family order reversed', sampleRegistry,
  normalizeMarketMacroFeatureRegistryManifestV1,
  (value) => { value.entries.reverse(); });

for (const field of MARKET_MACRO_COVERAGE_COUNT_FIELDS) {
  add(`coverage negative count ${field}`, sampleCoverage,
    normalizeMarketMacroFeatureCoverageReportV1,
    (value) => { value[field] = -1; });
}
for (let index = 0; index < 8; index += 1) {
  add(`coverage family negative ${index}`, sampleCoverage,
    normalizeMarketMacroFeatureCoverageReportV1,
    (value) => { value.familyCoverage[index].availableSessionCount = -1; });
}
for (const field of ['orderedSessionDigest', 'orderedRowDigest',
  'orderedInstrumentRowDigest', 'orderedProvenanceDigest',
  'orderedPublicationEntryDigest']) {
  add(`coverage malformed digest ${field}`, sampleCoverage,
    normalizeMarketMacroFeatureCoverageReportV1,
    (value) => { value[field] = 'sha256:bad'; });
}
for (const field of MARKET_MACRO_AUTHORITY_PIN_FIELDS) {
  add(`coverage malformed pin ${field}`, sampleCoverage,
    normalizeMarketMacroFeatureCoverageReportV1,
    (value) => { value.authorityPins[field] = 'latest'; });
}

for (let index = 0; index < 4; index += 1) {
  add(`manifest implementation identity ${index} malformed`, samplePublication,
    normalizeMarketMacroFeaturePublicationManifestV1,
    (value) => { value.implementationIdentities[index].implementationManifestId = 'latest'; });
}
for (let index = 0; index < 8; index += 1) {
  add(`manifest publication entry ${index} malformed`, samplePublication,
    normalizeMarketMacroFeaturePublicationManifestV1,
    (value) => { value.publishedEntries[index].entryIdentityDigest = 'sha256:bad'; });
}
for (const field of ['authorityPolicyId', 'registryManifestId', 'coverageReportId']) {
  add(`manifest top reference ${field} malformed`, samplePublication,
    normalizeMarketMacroFeaturePublicationManifestV1,
    (value) => { value[field] = 'latest'; });
}

test('L4B-P adversarial inventory contains exactly 101 internal corruptions', () => {
  assert.equal(cases.length, 101);
  assert.equal(new Set(cases.map((item) => item.name)).size, 101);
});

for (const item of cases) {
  test(`L4B-P fail-closed: ${item.name}`, () => {
    const value = item.factory();
    item.corrupt(value);
    assert.throws(() => item.normalize(value));
  });
}
