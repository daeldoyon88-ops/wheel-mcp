/**
 * L4C-I2 closed contracts K1..K6.
 *
 * Each contract is checked for registration, closed field order, unknown-field
 * refusal, schemaVersion binding, normalizer idempotence and its id preimage.
 * Every sample is a real object produced by the pipeline and read back from the
 * store, so no expected value is invented by the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHash } from '../src/canonical/canonicalJsonV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS,
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS,
  EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
  EARNINGS_DATASET_BINDING_FIELDS,
  EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_BASIS_VALUES,
  EARNINGS_FISCAL_CLASSIFICATION_METHOD_VALUES,
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_FIELDS,
  EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
  EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS,
  EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
  EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS,
  EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
  EARNINGS_FISCAL_SOURCE_FACT_TAGS,
  EARNINGS_L4C_I2_SCHEMA_VERSIONS,
  normalizeEarningsAsOfMaterializationReportV1,
  normalizeEarningsAsOfResolutionPolicyV1,
  normalizeEarningsDatasetBindingV1,
  normalizeEarningsFiscalClassificationPolicyV1,
  normalizeEarningsFiscalClassificationReportV1,
  normalizeEarningsFiscalPeriodClassificationCoreV1,
} from '../src/contracts/earningsContractsL4CIIV1.mjs';
import {
  EARNINGS_PERIOD_TYPES,
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  normalizeFinancialPeriodIdentityCoreV1,
} from '../src/contracts/earningsContractsL4CIV1.mjs';
import {
  materializeL4CI2Dataset,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

/** One materialization, read back from the store, feeding every K1..K6 sample. */
const SAMPLES = withL4CI2ThreeFilingFixture((ctx) => {
  const { binding, materialization } = materializeL4CI2Dataset(ctx.store, ctx);
  const read = (objectId, schemaVersion) => ctx.store.readCanonicalObject({
    uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
    expectedObjectId: objectId,
    schemaVersion,
  }).value;
  const report = materialization.earningsAsOfMaterializationReport;
  return {
    K1: {
      id: ctx.earningsAsOfResolutionPolicyId,
      value: read(ctx.earningsAsOfResolutionPolicyId,
        EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION),
    },
    K2: {
      id: ctx.earningsFiscalClassificationPolicyId,
      value: read(ctx.earningsFiscalClassificationPolicyId,
        EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION),
    },
    K3: {
      id: report.orderedFiscalClassificationIds[0],
      value: read(report.orderedFiscalClassificationIds[0],
        EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION),
    },
    K4: {
      id: report.orderedFiscalClassificationReportIds[0],
      value: read(report.orderedFiscalClassificationReportIds[0],
        EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION),
    },
    K5: { id: binding.earningsDatasetBindingId, value: binding.earningsDatasetBinding },
    K6: { id: materialization.earningsAsOfMaterializationReportId, value: report },
  };
});

const registeredOnce = (schemaVersion) =>
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.filter((entry) => entry === schemaVersion).length;

/** A field name no closed L4C-I2 contract declares. */
const FOREIGN_FIELD = 'l4cI2ForeignProbeField';

/* --- K1 EarningsAsOfResolutionPolicy/1 ----------------------------------- */

test('I2-K001 EarningsAsOfResolutionPolicy/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION), 1);
  });

test('I2-K002 EarningsAsOfResolutionPolicy/1: closed field set in the exact declared order', () => {
  assert.deepEqual(Object.keys(SAMPLES.K1.value), [...EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS]);
  assert.equal(EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS[0], 'schemaVersion');
});

test('I2-K003 EarningsAsOfResolutionPolicy/1: unknown field raises CANONICAL_UNKNOWN_FIELD', () => {
  assert.throws(() => normalizeEarningsAsOfResolutionPolicyV1(
    { ...SAMPLES.K1.value, [FOREIGN_FIELD]: 1 }),
  (error) => error.code === 'EARNINGS_AS_OF_POLICY_INVALID'
    && /unknown field/u.test(error.message));
});

test('I2-K004 EarningsAsOfResolutionPolicy/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsAsOfResolutionPolicyV1(
    { ...SAMPLES.K1.value, schemaVersion: 'EarningsAsOfResolutionPolicy/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K005 EarningsAsOfResolutionPolicy/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsAsOfResolutionPolicyV1(SAMPLES.K1.value);
  const twice = normalizeEarningsAsOfResolutionPolicyV1(once);
  assert.deepEqual(twice, once);
  assert.notEqual(once, SAMPLES.K1.value);
});

test('I2-K006 EarningsAsOfResolutionPolicy/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_AS_OF_RESOLUTION_POLICY_SCHEMA_VERSION,
      normalizeEarningsAsOfResolutionPolicyV1(SAMPLES.K1.value)), SAMPLES.K1.id);
  });

/* --- K2 EarningsFiscalClassificationPolicy/1 ------------------------------ */

test('I2-K007 EarningsFiscalClassificationPolicy/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION), 1);
  });

test('I2-K008 EarningsFiscalClassificationPolicy/1: closed field set in the exact declared order',
  () => {
    assert.deepEqual(Object.keys(SAMPLES.K2.value),
      [...EARNINGS_FISCAL_CLASSIFICATION_POLICY_FIELDS]);
  });

test('I2-K009 EarningsFiscalClassificationPolicy/1: unknown field raises CANONICAL_UNKNOWN_FIELD',
  () => {
    assert.throws(() => normalizeEarningsFiscalClassificationPolicyV1(
      { ...SAMPLES.K2.value, [FOREIGN_FIELD]: 1 }),
    (error) => error.code === 'EARNINGS_FISCAL_POLICY_INVALID'
      && /unknown field/u.test(error.message));
  });

test('I2-K010 EarningsFiscalClassificationPolicy/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsFiscalClassificationPolicyV1(
    { ...SAMPLES.K2.value, schemaVersion: 'EarningsFiscalClassificationPolicy/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K011 EarningsFiscalClassificationPolicy/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsFiscalClassificationPolicyV1(SAMPLES.K2.value);
  assert.deepEqual(normalizeEarningsFiscalClassificationPolicyV1(once), once);
  assert.notEqual(once, SAMPLES.K2.value);
});

test('I2-K012 EarningsFiscalClassificationPolicy/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_FISCAL_CLASSIFICATION_POLICY_SCHEMA_VERSION,
      normalizeEarningsFiscalClassificationPolicyV1(SAMPLES.K2.value)), SAMPLES.K2.id);
  });

/* --- K3 EarningsFiscalPeriodClassificationCore/1 -------------------------- */

test('I2-K013 EarningsFiscalPeriodClassificationCore/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION), 1);
  });

test('I2-K014 EarningsFiscalPeriodClassificationCore/1: closed field set in the exact declared order',
  () => {
    assert.deepEqual(Object.keys(SAMPLES.K3.value),
      [...EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS]);
    assert.equal(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS.length, 12);
    assert.equal(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS[11], 'orderedSourceFactTags');
  });

test('I2-K015 EarningsFiscalPeriodClassificationCore/1: unknown field raises CANONICAL_UNKNOWN_FIELD',
  () => {
    assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1(
      { ...SAMPLES.K3.value, [FOREIGN_FIELD]: 1 }),
    (error) => error.code === 'EARNINGS_FISCAL_CLASSIFICATION_INVALID'
      && /unknown field/u.test(error.message));
  });

test('I2-K016 EarningsFiscalPeriodClassificationCore/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1(
    { ...SAMPLES.K3.value, schemaVersion: 'EarningsFiscalPeriodClassificationCore/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K017 EarningsFiscalPeriodClassificationCore/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsFiscalPeriodClassificationCoreV1(SAMPLES.K3.value);
  assert.deepEqual(normalizeEarningsFiscalPeriodClassificationCoreV1(once), once);
  assert.notEqual(once.orderedSourceFactTags, SAMPLES.K3.value.orderedSourceFactTags);
});

test('I2-K018 EarningsFiscalPeriodClassificationCore/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_SCHEMA_VERSION,
      normalizeEarningsFiscalPeriodClassificationCoreV1(SAMPLES.K3.value)), SAMPLES.K3.id);
  });

/* --- K4 EarningsFiscalClassificationReport/1 ------------------------------ */

test('I2-K019 EarningsFiscalClassificationReport/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION), 1);
  });

test('I2-K020 EarningsFiscalClassificationReport/1: closed field set in the exact declared order',
  () => {
    assert.deepEqual(Object.keys(SAMPLES.K4.value),
      [...EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS]);
    assert.equal(EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS.length, 15);
  });

test('I2-K021 EarningsFiscalClassificationReport/1: unknown field raises CANONICAL_UNKNOWN_FIELD',
  () => {
    assert.throws(() => normalizeEarningsFiscalClassificationReportV1(
      { ...SAMPLES.K4.value, [FOREIGN_FIELD]: 1 }),
    (error) => error.code === 'EARNINGS_FISCAL_REPORT_INVALID'
      && /unknown field/u.test(error.message));
  });

test('I2-K022 EarningsFiscalClassificationReport/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsFiscalClassificationReportV1(
    { ...SAMPLES.K4.value, schemaVersion: 'EarningsFiscalClassificationReport/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K023 EarningsFiscalClassificationReport/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsFiscalClassificationReportV1(SAMPLES.K4.value);
  assert.deepEqual(normalizeEarningsFiscalClassificationReportV1(once), once);
  assert.notEqual(once.orderedFiscalPeriodClassificationIds,
    SAMPLES.K4.value.orderedFiscalPeriodClassificationIds);
});

test('I2-K024 EarningsFiscalClassificationReport/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_FISCAL_CLASSIFICATION_REPORT_SCHEMA_VERSION,
      normalizeEarningsFiscalClassificationReportV1(SAMPLES.K4.value)), SAMPLES.K4.id);
  });

/* --- K5 EarningsDatasetBinding/1 ------------------------------------------ */

test('I2-K025 EarningsDatasetBinding/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_DATASET_BINDING_SCHEMA_VERSION), 1);
  });

test('I2-K026 EarningsDatasetBinding/1: closed field set in the exact declared order', () => {
  assert.deepEqual(Object.keys(SAMPLES.K5.value), [...EARNINGS_DATASET_BINDING_FIELDS]);
  assert.equal(EARNINGS_DATASET_BINDING_FIELDS.length, 17);
});

test('I2-K027 EarningsDatasetBinding/1: unknown field raises CANONICAL_UNKNOWN_FIELD', () => {
  assert.throws(() => normalizeEarningsDatasetBindingV1(
    { ...SAMPLES.K5.value, [FOREIGN_FIELD]: 1 }),
  (error) => error.code === 'EARNINGS_BINDING_INVALID' && /unknown field/u.test(error.message));
});

test('I2-K028 EarningsDatasetBinding/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsDatasetBindingV1(
    { ...SAMPLES.K5.value, schemaVersion: 'EarningsDatasetBinding/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K029 EarningsDatasetBinding/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsDatasetBindingV1(SAMPLES.K5.value);
  assert.deepEqual(normalizeEarningsDatasetBindingV1(once), once);
  assert.notEqual(once, SAMPLES.K5.value);
});

test('I2-K030 EarningsDatasetBinding/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_DATASET_BINDING_SCHEMA_VERSION,
      normalizeEarningsDatasetBindingV1(SAMPLES.K5.value)), SAMPLES.K5.id);
  });

/* --- K6 EarningsAsOfMaterializationReport/1 ------------------------------- */

test('I2-K031 EarningsAsOfMaterializationReport/1: registered exactly once in SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS',
  () => {
    assert.equal(registeredOnce(EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION), 1);
  });

test('I2-K032 EarningsAsOfMaterializationReport/1: closed field set in the exact declared order',
  () => {
    assert.deepEqual(Object.keys(SAMPLES.K6.value),
      [...EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS]);
    assert.equal(EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS.length, 47);
  });

test('I2-K033 EarningsAsOfMaterializationReport/1: unknown field raises CANONICAL_UNKNOWN_FIELD',
  () => {
    assert.throws(() => normalizeEarningsAsOfMaterializationReportV1(
      { ...SAMPLES.K6.value, [FOREIGN_FIELD]: 1 }),
    (error) => error.code === 'EARNINGS_MATERIALIZATION_INVALID'
      && /unknown field/u.test(error.message));
  });

test('I2-K034 EarningsAsOfMaterializationReport/1: wrong schemaVersion is rejected', () => {
  assert.throws(() => normalizeEarningsAsOfMaterializationReportV1(
    { ...SAMPLES.K6.value, schemaVersion: 'EarningsAsOfMaterializationReport/2' }),
  (error) => error.code === 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED');
});

test('I2-K035 EarningsAsOfMaterializationReport/1: normalizer is idempotent and clones', () => {
  const once = normalizeEarningsAsOfMaterializationReportV1(SAMPLES.K6.value);
  assert.deepEqual(normalizeEarningsAsOfMaterializationReportV1(once), once);
  assert.notEqual(once.orderedVisibleRevisionIdentityIds,
    SAMPLES.K6.value.orderedVisibleRevisionIdentityIds);
});

test('I2-K036 EarningsAsOfMaterializationReport/1: id preimage equals canonicalHash(schemaVersion, normalized)',
  () => {
    assert.equal(canonicalHash(EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
      normalizeEarningsAsOfMaterializationReportV1(SAMPLES.K6.value)), SAMPLES.K6.id);
  });

/* --- cross-contract invariants ------------------------------------------- */

test('I2-K037 the six L4C-I2 schemas are exactly the declared closed list', () => {
  assert.deepEqual([...EARNINGS_L4C_I2_SCHEMA_VERSIONS], [
    'EarningsAsOfResolutionPolicy/1',
    'EarningsFiscalClassificationPolicy/1',
    'EarningsFiscalPeriodClassificationCore/1',
    'EarningsFiscalClassificationReport/1',
    'EarningsDatasetBinding/1',
    'EarningsAsOfMaterializationReport/1',
  ]);
});

test('I2-K038 no L4C-I2 schema is registered in the normalized namespace', () => {
  for (const schemaVersion of EARNINGS_L4C_I2_SCHEMA_VERSIONS) {
    assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.includes(schemaVersion), false,
      schemaVersion);
  }
});

test('I2-K039 EarningsFiscalPeriodClassificationCore/1 carries no knowledgeCutoff field', () => {
  assert.equal(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS.includes('knowledgeCutoff'),
    false);
  assert.equal(Object.hasOwn(SAMPLES.K3.value, 'knowledgeCutoff'), false);
});

test('I2-K040 EarningsFiscalPeriodClassificationCore/1 carries no snapshot reference', () => {
  for (const field of EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS) {
    assert.equal(field.toLowerCase().includes('snapshot'), false, field);
  }
});

test('I2-K041 no L4C-I2 contract declares a supersedes field', () => {
  const allFields = [
    ...EARNINGS_AS_OF_RESOLUTION_POLICY_FIELDS,
    ...EARNINGS_FISCAL_CLASSIFICATION_POLICY_FIELDS,
    ...EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS,
    ...EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS,
    ...EARNINGS_DATASET_BINDING_FIELDS,
    ...EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS,
  ];
  for (const field of allFields) assert.equal(field.startsWith('supersedes'), false, field);
  assert.throws(() => normalizeEarningsDatasetBindingV1(
    { ...SAMPLES.K5.value, supersedesEarningsDatasetBindingId: null }),
  (error) => error.code === 'EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN');
});

test('I2-K042 FinancialPeriodIdentityCore/1 field list is unchanged by L4C-I2', () => {
  const normalized = normalizeFinancialPeriodIdentityCoreV1({
    schemaVersion: FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    periodType: 'DURATION', periodStart: '2026-01-01', periodEnd: '2026-03-31',
  });
  assert.deepEqual(Object.keys(normalized),
    ['schemaVersion', 'periodType', 'periodStart', 'periodEnd']);
  // No L4C-I2 field ever reaches the raw period contract.
  assert.throws(() => normalizeFinancialPeriodIdentityCoreV1(
    { ...normalized, fiscalPeriodClass: 'QUARTER' }),
  (error) => typeof error.code === 'string');
});

test('I2-K043 EARNINGS_PERIOD_TYPES is still exactly INSTANT and DURATION', () => {
  assert.deepEqual([...EARNINGS_PERIOD_TYPES], ['INSTANT', 'DURATION']);
});

test('I2-K044 the sixteen L4C-I1 schema versions are unchanged', () => {
  assert.deepEqual(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.slice(113, 129), [
    'EarningsIngestionPolicy/1', 'EarningsMetricExtractionPolicy/1',
    'SecFilingSourceDocumentCore/1', 'SecDocumentBytesCore/1',
    'EarningsTaxonomyBundleManifest/1', 'XbrlCanonicalUnitCore/1',
    'FinancialPeriodIdentityCore/1', 'EarningsEventIdentityCore/1',
    'EarningsRevisionIdentityCore/1', 'EarningsRevisionCore/1',
    'EarningsMetricObservationCore/1', 'EarningsMetricExtractionReport/1',
    'EarningsEventSetManifest/1', 'EarningsRevisionSetManifest/1',
    'EarningsExtractionSetManifest/1', 'EarningsDatasetSnapshotManifest/1',
  ]);
});

/* --- classification evidence model ---------------------------------------- */

test('I2-F316 K2: classificationBasisValues is the closed pair {SOURCE_ATTESTED,POLICY_INFERRED}',
  () => {
    assert.deepEqual([...EARNINGS_FISCAL_CLASSIFICATION_BASIS_VALUES],
      ['SOURCE_ATTESTED', 'POLICY_INFERRED']);
    assert.deepEqual(SAMPLES.K2.value.classificationBasisValues,
      ['SOURCE_ATTESTED', 'POLICY_INFERRED']);
  });

test('I2-F317 K2: classificationMethodValues is closed to the three declared methods', () => {
  assert.deepEqual([...EARNINGS_FISCAL_CLASSIFICATION_METHOD_VALUES],
    ['DECLARED_FOCUS', 'RELATIONAL_SPAN_ORDER', 'Q1_DUAL_ROLE']);
  assert.deepEqual(SAMPLES.K2.value.classificationMethodValues,
    ['DECLARED_FOCUS', 'RELATIONAL_SPAN_ORDER', 'Q1_DUAL_ROLE']);
});

test('I2-F318 K2: terminalQuarterProvabilityPolicy is FAIL_CLOSED_UNPROVABLE', () => {
  assert.equal(SAMPLES.K2.value.terminalQuarterProvabilityPolicy, 'FAIL_CLOSED_UNPROVABLE');
});

test('I2-F319 K3: classificationBasis is required and closed', () => {
  assert.equal(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS.includes('classificationBasis'),
    true);
  assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1(
    { ...SAMPLES.K3.value, classificationBasis: 'DERIVED' }),
  (error) => error.code === 'EARNINGS_FISCAL_CLASSIFICATION_INVALID');
});

test('I2-F320 K3: classificationMethod is required and closed', () => {
  assert.equal(EARNINGS_FISCAL_PERIOD_CLASSIFICATION_CORE_FIELDS.includes('classificationMethod'),
    true);
  assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1(
    { ...SAMPLES.K3.value, classificationMethod: 'GUESSED' }),
  (error) => error.code === 'EARNINGS_FISCAL_CLASSIFICATION_INVALID');
});

test('I2-F321 K3: orderedSourceFactTags is required, unique, source-only and in canonical order DocumentPeriodEndDate, DocumentFiscalPeriodFocus, DocumentFiscalYearFocus',
  () => {
    assert.deepEqual([...EARNINGS_FISCAL_SOURCE_FACT_TAGS],
      ['DocumentPeriodEndDate', 'DocumentFiscalPeriodFocus', 'DocumentFiscalYearFocus']);
    const tags = SAMPLES.K3.value.orderedSourceFactTags;
    assert.ok(tags.length > 0);
    let cursor = -1;
    for (const tag of tags) {
      const position = EARNINGS_FISCAL_SOURCE_FACT_TAGS.indexOf(tag);
      assert.ok(position > cursor, tag);
      cursor = position;
    }
  });

test('I2-F322 K4: attested and inferred counters are declared', () => {
  assert.equal(
    EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS.includes('sourceAttestedClassificationCount'),
    true);
  assert.equal(
    EARNINGS_FISCAL_CLASSIFICATION_REPORT_FIELDS.includes('policyInferredClassificationCount'),
    true);
  assert.equal(typeof SAMPLES.K4.value.sourceAttestedClassificationCount, 'number');
  assert.equal(typeof SAMPLES.K4.value.policyInferredClassificationCount, 'number');
});

test('I2-F323 K6: attested and inferred counters are declared', () => {
  assert.equal(
    EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS.includes('sourceAttestedClassificationCount'),
    true);
  assert.equal(
    EARNINGS_AS_OF_MATERIALIZATION_REPORT_FIELDS.includes('policyInferredClassificationCount'),
    true);
  assert.equal(SAMPLES.K6.value.sourceAttestedClassificationCount
    + SAMPLES.K6.value.policyInferredClassificationCount,
  SAMPLES.K6.value.fiscalClassificationCount);
});

test('I2-F334 K3 rejects RawPeriodSpanOrder in orderedSourceFactTags because it is derived evidence',
  () => {
    assert.equal(EARNINGS_FISCAL_SOURCE_FACT_TAGS.includes('RawPeriodSpanOrder'), false);
    assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1({
      ...SAMPLES.K3.value, orderedSourceFactTags: ['RawPeriodSpanOrder'],
    }), (error) => error.code === 'EARNINGS_FISCAL_SOURCE_FACT_TAGS_INVALID');
  });

test('I2-F335 K3 rejects duplicated, unknown or noncanonical orderedSourceFactTags', () => {
  const invalidSets = [
    ['DocumentPeriodEndDate', 'DocumentPeriodEndDate'],
    ['DocumentFiscalPeriodFocus', 'DocumentPeriodEndDate'],
    ['dei:DocumentPeriodEndDate'],
    ['RELATIONAL_SPAN_ORDER'],
  ];
  for (const orderedSourceFactTags of invalidSets) {
    assert.throws(() => normalizeEarningsFiscalPeriodClassificationCoreV1(
      { ...SAMPLES.K3.value, orderedSourceFactTags }),
    (error) => error.code === 'EARNINGS_FISCAL_SOURCE_FACT_TAGS_INVALID',
    JSON.stringify(orderedSourceFactTags));
  }
});
