import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS, normalizeCanonicalValue } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS, MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  MACRO_AS_OF_RESOLUTION_POLICY_VALUES, normalizeMacroAsOfResolutionPolicyV1,
  normalizeMacroReleaseCalendarRegistryManifestV1, normalizeMacroDatasetBindingV1,
  normalizeMacroMaterializationReportV1,
} from '../src/contracts/macroMaterializationContractsL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture, code } from './macroMaterializationL4BSyntheticFixture.mjs';

const ID = `sha256:${'a'.repeat(64)}`;
const ts = '2026-01-01T00:00:00.000Z';
const valid = {
  policy: () => ({ schemaVersion: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION, ...structuredClone(MACRO_AS_OF_RESOLUTION_POLICY_VALUES) }),
  calendar: () => withOfficialMacroL4BI2Fixture((x) => structuredClone(x.calendar.registry)),
  binding: () => withOfficialMacroL4BI2Fixture((x) => structuredClone(x.binding.binding)),
  report: () => withOfficialMacroL4BI2Fixture((x) => structuredClone(x.report.materializationReport)),
};
const normalize = {
  policy: normalizeMacroAsOfResolutionPolicyV1,
  calendar: normalizeMacroReleaseCalendarRegistryManifestV1,
  binding: normalizeMacroDatasetBindingV1,
  report: normalizeMacroMaterializationReportV1,
};
const schema = {
  policy: MACRO_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  calendar: MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS[1],
  binding: MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS[2],
  report: MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS[3],
};

test('L4B-I2 registers exactly four macro schemas: 101 total, all unique', () => {
  assert.equal(MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS.length, 4);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 105);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 105);
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(-8, -4), MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS);
});
test('L4B-I2 adds no normalized CAS type: exactly 5', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  for (const item of MACRO_MATERIALIZATION_L4B_SCHEMA_VERSIONS) assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(item), false);
});

for (const name of Object.keys(valid)) {
  test(`${name} valid value dispatches and has stable canonical bytes`, () => {
    const value = valid[name]();
    assert.deepEqual(normalizeCanonicalValue(schema[name], value), normalize[name](value));
    assert.deepEqual(canonicalJsonBytes(normalize[name](value)), canonicalJsonBytes(normalize[name](value)));
  });
  test(`${name} rejects an unknown own key`, () => assert.throws(() => normalize[name]({ ...valid[name](), unexpected: true })));
  test(`${name} rejects a missing required key`, () => {
    const value = valid[name](); delete value.schemaVersion;
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a Symbol key`, () => {
    const value = valid[name](); value[Symbol.for('bad')] = true;
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects an accessor`, () => {
    const value = valid[name](); const field = Object.keys(value)[1];
    const previous = value[field]; delete value[field];
    Object.defineProperty(value, field, { enumerable: true, get: () => previous });
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a non-enumerable field`, () => {
    const value = valid[name](); const field = Object.keys(value)[1];
    const previous = value[field]; delete value[field];
    Object.defineProperty(value, field, { enumerable: false, value: previous });
    assert.throws(() => normalize[name](value));
  });
  test(`${name} rejects a prototype carrier`, () => {
    const value = Object.assign(Object.create({ inherited: true }), valid[name]());
    assert.throws(() => normalize[name](value));
  });
}

test('policy rejects every closed enum/value divergence', () => {
  for (const key of Object.keys(MACRO_AS_OF_RESOLUTION_POLICY_VALUES)) {
    const policy = valid.policy(); policy[key] = 'FORGED';
    assert.throws(() => normalize.policy(policy), code('MARKET_DATA_MACRO_AS_OF_POLICY_INVALID'));
  }
});
test('calendar rejects a bad timestamp, bad ordering and bad source reference', () => {
  const badTime = valid.calendar(); badTime.orderedReleaseEventVersions[0].calendarKnowledgeAvailableAt = ts.replace('.000Z', 'Z');
  assert.throws(() => normalize.calendar(badTime));
  const badOrder = valid.calendar(); badOrder.orderedReleaseEventVersions.reverse();
  assert.throws(() => normalize.calendar(badOrder));
  const badRef = valid.calendar(); badRef.macroSeriesRegistryManifestId = 'latest';
  assert.throws(() => normalize.calendar(badRef));
});
test('binding rejects unknown enum, bad timestamp and bad reference', () => {
  const enumValue = valid.binding(); enumValue.currencyCode = 'CAD'; assert.throws(() => normalize.binding(enumValue));
  const time = valid.binding(); time.knowledgeCutoff = '2026-01-01T00:00:00Z'; assert.throws(() => normalize.binding(time));
  const ref = valid.binding(); ref.macroDatasetSnapshotManifestId = ID.slice(0, -1); assert.throws(() => normalize.binding(ref));
});
test('report rejects forged count, unknown enum, bad timestamp and bad ref', () => {
  const count = valid.report(); count.seriesCount += 1; assert.deepEqual(normalize.report(count).seriesCount, count.seriesCount);
  const enumValue = valid.report(); enumValue.currencyCode = 'CAD'; assert.throws(() => normalize.report(enumValue));
  const time = valid.report(); time.knowledgeCutoff = '2026-01-01'; assert.throws(() => normalize.report(time));
  const ref = valid.report(); ref.macroDatasetBindingId = 'latest'; assert.throws(() => normalize.report(ref));
});
