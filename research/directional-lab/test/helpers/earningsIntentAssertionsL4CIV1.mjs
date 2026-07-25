/**
 * Per-test-ID authoritative intent assertions for L4C-I1.
 *
 * The official harness dispatches by category.  A category dispatcher alone
 * cannot demonstrate that each authoritative test ID exercises the production
 * branch its own intent names, so every ID whose intent is not already pinned
 * by a category branch gets an explicit assertion here.  Each entry calls
 * production code, uses an input that distinguishes it from its siblings and
 * asserts a property that is false when the named production branch breaks.
 *
 * Test IDs and intents are authoritative and are never changed here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CanonicalizationError, canonicalHash } from '../../src/canonical/canonicalJsonV1.mjs';
import {
  NORMALIZED_NAMESPACE_SCHEMA_VERSIONS,
} from '../../src/storage/contentAddressedStoreV1.mjs';
import {
  SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS,
  normalizeCanonicalValue,
} from '../../src/canonical/canonicalSchemaRegistryV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  TRANSFORM_SOURCE_TEXT_POLICY_VERSION,
  transformSourceTextSha256,
} from '../../src/data/transformImplementationManifestV2.mjs';
import {
  EARNINGS_DATASET_SERIES_IDENTITY,
  EARNINGS_EPS_TAG_PRIORITY,
  EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  EARNINGS_INGESTION_POLICY_VALUES,
  EARNINGS_L4C_I1_SCHEMA_VERSIONS,
  EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_POLICY_VALUES,
  EARNINGS_REVENUE_TAG_PRIORITY,
  EARNINGS_STRUCTURED_DOCUMENT_ROLES,
  EARNINGS_TAXONOMY_AUTHORITY,
  EARNINGS_UNIT_CODES,
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
  earningsDatasetIdentityKeyV1,
  earningsEventIdentityIdFor,
  earningsIngestionPolicyIdFor,
  earningsMetricExtractionPolicyIdFor,
  earningsOrderedDiagnosticDigestV1,
  earningsOrderedEventIdentityDigestV1,
  earningsOrderedMetricObservationIdentityDigestV1,
  earningsOrderedRevisionIdentityDigestV1,
  financialPeriodIdentityIdFor,
  normalizeEarningsIngestionPolicyV1,
  normalizeEarningsMetricExtractionPolicyV1,
  secAcceptanceDatetimeToUtcV1,
  xbrlCanonicalUnitIdFor,
} from '../../src/contracts/earningsContractsL4CIV1.mjs';
import {
  assertExplicitPinnedEarningsIdV1,
  verifyEarningsIngestionPolicy,
} from '../../src/earnings/earningsIngestionPolicyL4CIV1.mjs';
import {
  buildFinancialPeriodIdentityCore,
  verifyFinancialPeriodIdentityCore,
} from '../../src/earnings/earningsFinancialPeriodL4CIV1.mjs';
import {
  admitSecFilingForEarningsV1,
  buildSecFilingSourceDocument,
  earningsEventTypeForFormV1,
} from '../../src/earnings/earningsSecFilingSourceDocumentL4CIV1.mjs';
import {
  buildXbrlCanonicalUnitCore,
  buildXbrlCanonicalUnitFromMeasures,
  canonicalizeXbrlUnitMeasuresV1,
  verifyXbrlCanonicalUnitCore,
} from '../../src/earnings/earningsXbrlUnitL4CIV1.mjs';
import {
  buildEarningsEventIdentityCore,
} from '../../src/earnings/earningsEventIdentityL4CIV1.mjs';
import {
  verifyEarningsRevisionCore,
  verifyEarningsRevisionIdentityCore,
} from '../../src/earnings/earningsRevisionL4CIV1.mjs';
import {
  putEarningsSecDocumentBytes,
  verifyEarningsSecDocumentBytes,
} from '../../src/earnings/earningsSecDocumentBytesL4CIV1.mjs';
import {
  buildEarningsMetricObservationCore,
  verifyEarningsMetricObservationCore,
} from '../../src/earnings/earningsMetricObservationL4CIV1.mjs';
import {
  EARNINGS_TRAVERSAL_EDGE_COUNT_V1,
  EARNINGS_TRAVERSAL_EDGES_V1,
  verifyEarningsSnapshotTraversalV1,
} from '../../src/earnings/earningsTraversalVerifyL4CIV1.mjs';
import { ingestEarningsDatasetL4CIV1 } from '../../src/earnings/earningsIngestionPipelineL4CIV1.mjs';
import {
  pinEarningsTransformImplementationManifestV2,
  pinSyntheticEarningsFiling,
  pinSyntheticTaxonomyBundle,
  synthetic10KAFiling,
  synthetic10QFiling,
  synthetic8KFiling,
  syntheticFilingDefinition,
  withEmptyEarningsL4CI1Fixture,
  withOfficialEarningsL4CI1Fixture,
  withStore,
} from '../earningsIngestionL4CISyntheticFixture.mjs';
import {
  oracleDatasetIdentityKeyV1,
} from './independentEarningsIngestionOracleL4CIV1.mjs';

const TEST_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const OFFICIAL_TEST_FILE = /^market-earnings-l4c-i1-.*\.test\.mjs$/;

const ingestionPolicyRecord = () => ({
  schemaVersion: EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(EARNINGS_INGESTION_POLICY_VALUES),
});

const extractionPolicyRecord = () => ({
  schemaVersion: EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(EARNINGS_METRIC_EXTRACTION_POLICY_VALUES),
});

/** Assert that flipping one closed policy field is rejected with its own code. */
function policyPin(field, expected, mutation, code) {
  const policy = normalizeEarningsIngestionPolicyV1(ingestionPolicyRecord());
  assert.equal(policy[field], expected, `${field} must be pinned to ${expected}`);
  const broken = { ...ingestionPolicyRecord(), [field]: mutation };
  assert.throws(() => normalizeEarningsIngestionPolicyV1(broken),
    (error) => error?.code === code);
}

function extractionPin(field, expected, mutation, code) {
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  assert.deepEqual(policy[field], expected);
  const broken = { ...extractionPolicyRecord(), [field]: mutation };
  assert.throws(() => normalizeEarningsMetricExtractionPolicyV1(broken),
    (error) => error?.code === code);
}

/** Pin one synthetic filing in a fresh store and run the closed admission gate. */
function admitDefinition(definition) {
  return withStore((store) => {
    const filing = pinSyntheticEarningsFiling(store, definition);
    return admitSecFilingForEarningsV1({
      store, sourceFilingDocumentId: filing.sourceFilingDocumentId,
    });
  });
}

/**
 * Ingest an explicit list of synthetic filing definitions end to end and hand
 * the still-live store to the callback, so stored objects can be read back.
 */
function withIngestedDefinitions(definitions, callback) {
  return withStore((store) => {
    const transform = pinEarningsTransformImplementationManifestV2(store);
    const taxonomy = pinSyntheticTaxonomyBundle(store);
    const filings = definitions.map((definition) =>
      pinSyntheticEarningsFiling(store, definition));
    const pipeline = ingestEarningsDatasetL4CIV1({
      store,
      sourceFilingDocumentIds: filings.map((item) => item.sourceFilingDocumentId),
      transformImplementationManifestId: transform.transformImplementationManifestId,
      earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
      previousSnapshotId: null,
    });
    return callback({ store, transform, taxonomy, filings, pipeline });
  });
}

/** Ingest an explicit list of synthetic filing definitions end to end. */
function ingestDefinitions(definitions) {
  return withIngestedDefinitions(definitions, (context) => context);
}

/** Every observation id the ExtractionSet reaches, in manifest order. */
function pipelineObservationIds(pipeline) {
  return pipeline.extractionSet.earningsExtractionSetManifest
    .orderedRevisionExtractionEntries.flatMap((entry) => entry.orderedMetricObservationIds);
}

/** Read every stored observation back, resolving its canonical unit code. */
function pipelineObservations(store, pipeline) {
  return pipelineObservationIds(pipeline).map((earningsMetricObservationId) => {
    const core = verifyEarningsMetricObservationCore({
      store, earningsMetricObservationId,
    }).earningsMetricObservationCore;
    const unitCode = verifyXbrlCanonicalUnitCore({
      store, xbrlCanonicalUnitId: core.xbrlCanonicalUnitId,
    }).xbrlCanonicalUnitCore.unitCode;
    return { earningsMetricObservationId, unitCode, ...core };
  });
}

/** Pin one filing whose primary XBRL instance carries explicit custom bytes. */
function pinCustomXbrlFiling(store, definition, xml) {
  const document = putEarningsSecDocumentBytes({
    store, bytes: Buffer.from(xml, 'utf8'), mediaType: 'application/xml',
    documentFormat: 'XBRL_XML', documentRole: 'PRIMARY_XBRL_INSTANCE',
  });
  return buildSecFilingSourceDocument({
    store,
    filerCik: definition.filerCik,
    accessionNumber: definition.accessionNumber,
    formType: definition.formType,
    items: definition.items,
    acceptanceDatetimeRaw: definition.acceptanceDatetimeRaw,
    amendmentFlag: definition.amendmentFlag,
    amendsFilingAccessionNumber: definition.amendsFilingAccessionNumber,
    orderedDocuments: [{
      secDocumentBytesId: document.secDocumentBytesId,
      documentRole: 'PRIMARY_XBRL_INSTANCE',
    }],
  });
}

/**
 * Fabricated instance carrying one current-period EPS fact (context D1, the
 * DocumentPeriodEndDate period) and one prior-year comparative EPS fact under
 * the very same tag (context D0). No value is real market data.
 */
const COMPARATIVE_INSTANCE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
 xmlns:xbrli="http://www.xbrl.org/2003/instance"
 xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
 xmlns:us-gaap="http://fasb.org/us-gaap/2025"
 xmlns:dei="http://xbrl.sec.gov/dei/2025">
 <context id="D1"><entity><identifier scheme="http://www.sec.gov/CIK">1234567890</identifier></entity>
  <period><startDate>2026-01-01</startDate><endDate>2026-03-31</endDate></period></context>
 <context id="D0"><entity><identifier scheme="http://www.sec.gov/CIK">1234567890</identifier></entity>
  <period><startDate>2025-01-01</startDate><endDate>2025-03-31</endDate></period></context>
 <context id="I1"><entity><identifier scheme="http://www.sec.gov/CIK">1234567890</identifier></entity>
  <period><instant>2026-03-31</instant></period></context>
 <unit id="USDPS"><divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator>
  <unitDenominator><measure>xbrli:shares</measure></unitDenominator></divide></unit>
 <dei:DocumentPeriodEndDate contextRef="I1">2026-03-31</dei:DocumentPeriodEndDate>
 <us-gaap:EarningsPerShareDiluted contextRef="D1" unitRef="USDPS" decimals="2">1.25</us-gaap:EarningsPerShareDiluted>
 <us-gaap:EarningsPerShareDiluted contextRef="D0" unitRef="USDPS" decimals="2">0.77</us-gaap:EarningsPerShareDiluted>
</xbrl>`;

function buildPeriod(store, periodType, periodStart, periodEnd) {
  return buildFinancialPeriodIdentityCore({ store, periodType, periodStart, periodEnd });
}

/** Same period inputs must reduce to one CAS identity; different inputs must not. */
function periodIdFor(periodType, periodStart, periodEnd) {
  return financialPeriodIdentityIdFor({
    schemaVersion: FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    periodType, periodStart, periodEnd,
  });
}

function officialCaseRows() {
  const rows = [];
  const call = /authoritativeCase\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,/g;
  for (const file of readdirSync(TEST_DIR).filter((name) => OFFICIAL_TEST_FILE.test(name)).sort()) {
    const source = readFileSync(join(TEST_DIR, file), 'utf8');
    let match;
    while ((match = call.exec(source)) !== null) {
      rows.push({ file, id: match[1], group: match[2] });
    }
  }
  return rows;
}

function earningsSourceText() {
  const root = join(dirname(TEST_DIR), 'src', 'earnings');
  return readdirSync(root).map((name) => readFileSync(join(root, name), 'utf8')).join('\n');
}

const A = new Map();
const define = (id, fn) => { A.set(id, fn); };

/* ---------------------------------------------------------------- policy -- */

define('I1-P002', () => {
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  assert.deepEqual(policy.epsTagPriority, [...EARNINGS_EPS_TAG_PRIORITY]);
  assert.deepEqual(policy.revenueTagPriority, [...EARNINGS_REVENUE_TAG_PRIORITY]);
  const reordered = { ...extractionPolicyRecord(), epsTagPriority: [...EARNINGS_EPS_TAG_PRIORITY].reverse() };
  assert.throws(() => normalizeEarningsMetricExtractionPolicyV1(reordered),
    (error) => error?.code === 'EARNINGS_EPS_TAG_REJECTED');
});
define('I1-P003', () => policyPin('latestReferencePolicy', 'FORBIDDEN', 'ALLOWED',
  'EARNINGS_POLICY_LATEST_FORBIDDEN'));
define('I1-P004', () => policyPin('networkDuringComputationPolicy', 'FORBIDDEN', 'ALLOWED',
  'EARNINGS_POLICY_NETWORK_FORBIDDEN'));
define('I1-P005', () => policyPin('allowedSourceAuthority', 'SEC_EDGAR', 'YAHOO',
  'EARNINGS_SOURCE_AUTHORITY_REJECTED'));
define('I1-P006', () => policyPin('jurisdictionCode', 'US', 'CA',
  'EARNINGS_JURISDICTION_REJECTED'));
define('I1-P007', () => policyPin('currencyCode', 'USD', 'EUR',
  'EARNINGS_CURRENCY_REJECTED_V1'));
define('I1-P012', () => {
  const admission = admitDefinition(synthetic10QFiling());
  assert.equal(admission.admission, 'ADMIT');
  assert.equal(admission.eventType, 'EARNINGS_FILING');
  assert.deepEqual(admission.secFilingSourceDocument.items, []);
  assert.equal(admission.secFilingSourceDocument.formType, '10-Q');
  assert.deepEqual(admission.diagnostics, []);
});
define('I1-P013', () => {
  const admission = admitDefinition(syntheticFilingDefinition('10-K/A', {
    formType: '10-K', amendmentFlag: false, amendsFilingAccessionNumber: null,
    accessionNumber: '1234567890-26-000004',
  }));
  assert.equal(admission.admission, 'ADMIT');
  assert.equal(admission.eventType, 'EARNINGS_FILING');
  assert.deepEqual(admission.secFilingSourceDocument.items, []);
  assert.equal(admission.secFilingSourceDocument.formType, '10-K');
});
define('I1-P014', () => policyPin('periodSelectionPolicy', 'CURRENT_REPORTED_PERIODS_ONLY',
  'ALL_PERIODS', 'EARNINGS_POLICY_INVALID'));
define('I1-P015', () => {
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  assert.ok(policy.epsTagPriority.length > 0);
  for (const tag of policy.epsTagPriority) assert.match(tag, /Diluted$/);
  assert.equal(policy.epsTagPriority[0], 'us-gaap:EarningsPerShareDiluted');
  assert.ok(!policy.epsTagPriority.includes('us-gaap:EarningsPerShareBasic'));
});
define('I1-P016', () => {
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  assert.equal(policy.revenueTagPriority[0],
    'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax');
  assert.ok(policy.revenueTagPriority.includes('us-gaap:Revenues'));
  for (const tag of policy.revenueTagPriority) assert.ok(!/Segment|Disaggregat/.test(tag));
});
define('I1-P017', () => extractionPin('extensionTagPolicy', 'REJECTED_V1', 'ACCEPTED',
  'EARNINGS_EXTENSION_TAG_REJECTED'));
define('I1-P018', () => extractionPin('duplicateFactPolicy', 'DEDUP_IDENTICAL_REJECT_CONFLICTING',
  'KEEP_LAST', 'EARNINGS_DUPLICATE_FACT_POLICY_VIOLATION'));
define('I1-P023', () => {
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  assert.deepEqual(policy.allowedStructuredDocumentRoles, [...EARNINGS_STRUCTURED_DOCUMENT_ROLES]);
  assert.ok(policy.allowedStructuredDocumentRoles.includes('PRIMARY_IXBRL'));
  assert.ok(!policy.allowedStructuredDocumentRoles.includes('EXHIBIT_OTHER'));
  const widened = { ...extractionPolicyRecord(),
    allowedStructuredDocumentRoles: [...EARNINGS_STRUCTURED_DOCUMENT_ROLES, 'EXHIBIT_OTHER'] };
  assert.throws(() => normalizeEarningsMetricExtractionPolicyV1(widened),
    (error) => error?.code === 'EARNINGS_UNSTRUCTURED_SOURCE_REJECTED');
});
define('I1-P024', () => {
  assert.equal(EARNINGS_TAXONOMY_AUTHORITY, 'US_GAAP_DEI_V1');
  const policy = normalizeEarningsMetricExtractionPolicyV1(extractionPolicyRecord());
  for (const tag of [...policy.epsTagPriority, ...policy.revenueTagPriority]) {
    assert.match(tag, /^us-gaap:/);
  }
});
define('I1-P025', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling({ includeMetrics: false })]);
  const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
  assert.equal(snapshot.eventCount, 1, 'the release is retained');
  assert.equal(snapshot.revisionCount, 1);
  assert.equal(snapshot.extractionReportCount, 1, 'an empty report is still emitted');
  assert.equal(snapshot.metricObservationCount, 0, 'zero supported metrics');
  assert.equal(snapshot.emptySnapshot, false);
});
define('I1-P026', () => {
  // Both sides of this comparison are EarningsIngestionPolicy/1 records that
  // differ in exactly one functional field; an ingestion/extraction pair would
  // prove nothing about a policy *change*.
  const schemaVersion = EARNINGS_INGESTION_POLICY_SCHEMA_VERSION;
  const baseId = earningsIngestionPolicyIdFor(ingestionPolicyRecord());
  const sameInputId = earningsIngestionPolicyIdFor(ingestionPolicyRecord());
  assert.equal(baseId, sameInputId, 'an unchanged policy keeps its id');
  const base = normalizeEarningsIngestionPolicyV1(ingestionPolicyRecord());
  assert.equal(base.schemaVersion, schemaVersion);
  assert.equal(canonicalHash(schemaVersion, base), baseId,
    'the policy id is the canonical hash of the whole normalized policy record');
  // The closed singleton admits exactly one value per field, so no second
  // valid ingestion policy exists to compare against. That constraint is
  // demonstrated rather than worked around: each changed value is rejected by
  // the contract, and the same one-field change still has to move the id.
  const changes = [
    ['datasetSeriesIdentity', 'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V2'],
    ['jurisdictionCode', 'CA'],
    ['currencyCode', 'EUR'],
    ['allowedSourceAuthority', 'YAHOO'],
    ['latestReferencePolicy', 'ALLOWED'],
    ['networkDuringComputationPolicy', 'ALLOWED'],
    ['item202Rule', 'OPTIONAL_FOR_8K_FAMILY'],
    ['periodSelectionPolicy', 'ALL_PERIODS'],
  ];
  for (const [field, value] of changes) {
    assert.ok(Object.hasOwn(base, field),
      `${field} must be part of the canonical policy preimage`);
    assert.notEqual(base[field], value, `${field} must really change`);
    const changed = { ...base, [field]: value };
    assert.deepEqual(Object.keys(changed), Object.keys(base), 'exactly one field changes');
    const changedId = canonicalHash(schemaVersion, changed);
    assert.notEqual(changedId, baseId, `a changed ${field} must create a new policy id`);
    assert.throws(() => earningsIngestionPolicyIdFor({ ...ingestionPolicyRecord(), [field]: value }),
      (error) => typeof error?.code === 'string' && error.code.length > 0,
      `${field} is pinned: a changed policy is inadmissible, never a silent id reuse`);
  }
  // Sanity: the allowedFormTypes list is closed too, and reordering it moves the id.
  const reordered = { ...base, allowedFormTypes: [...base.allowedFormTypes].reverse() };
  assert.notEqual(canonicalHash(schemaVersion, reordered), baseId);
  assert.notEqual(baseId, earningsMetricExtractionPolicyIdFor(extractionPolicyRecord()));
});
define('I1-P027', () => {
  const ingestionId = earningsIngestionPolicyIdFor(ingestionPolicyRecord());
  const extractionId = earningsMetricExtractionPolicyIdFor(extractionPolicyRecord());
  assert.notEqual(ingestionId, extractionId);
  assert.match(ingestionId, /^sha256:[0-9a-f]{64}$/);
  assert.match(extractionId, /^sha256:[0-9a-f]{64}$/);
});

/* --------------------------------------------------------------- periods -- */

define('I1-D001', () => withStore((store) => {
  const built = buildPeriod(store, 'INSTANT', null, '2026-03-31');
  assert.equal(built.financialPeriodIdentityCore.periodType, 'INSTANT');
  assert.equal(built.financialPeriodIdentityCore.periodStart, null);
  assert.equal(built.financialPeriodIdentityCore.periodEnd, '2026-03-31');
  assert.equal(built.financialPeriodIdentityId, periodIdFor('INSTANT', null, '2026-03-31'));
}));
define('I1-D002', () => withStore((store) => {
  const built = buildPeriod(store, 'DURATION', '2026-01-01', '2026-03-31');
  assert.equal(built.financialPeriodIdentityCore.periodStart, '2026-01-01');
  assert.equal(built.financialPeriodIdentityCore.periodEnd, '2026-03-31');
  assert.throws(() => buildPeriod(store, 'DURATION', '2026-03-31', '2026-01-01'),
    (error) => error?.code === 'EARNINGS_PERIOD_INVALID');
}));
define('I1-D003', () => withStore((store) => {
  // 52-week and 53-week years ending on the same date are distinct identities.
  const week52 = buildPeriod(store, 'DURATION', '2025-12-29', '2026-12-27');
  const week53 = buildPeriod(store, 'DURATION', '2025-12-22', '2026-12-27');
  assert.notEqual(week52.financialPeriodIdentityId, week53.financialPeriodIdentityId);
  assert.equal(week52.financialPeriodIdentityCore.periodEnd,
    week53.financialPeriodIdentityCore.periodEnd);
}));
define('I1-D004', () => {
  // No 90-day approximation: a near-identical span is a different identity.
  const exact = periodIdFor('DURATION', '2026-01-01', '2026-03-31');
  const approx = periodIdFor('DURATION', '2026-01-01', '2026-04-01');
  assert.notEqual(exact, approx);
});
define('I1-D005', () => withStore((store) => {
  const quarter = buildPeriod(store, 'DURATION', '2026-01-01', '2026-03-31');
  const year = buildPeriod(store, 'DURATION', '2025-04-01', '2026-03-31');
  assert.equal(quarter.financialPeriodIdentityCore.periodEnd, '2026-03-31');
  assert.equal(year.financialPeriodIdentityCore.periodEnd, '2026-03-31');
  assert.notEqual(quarter.financialPeriodIdentityId, year.financialPeriodIdentityId);
}));
define('I1-D009', () => {
  // Only the three closed fields feed the identity; DEI metadata cannot enter.
  const id = periodIdFor('DURATION', '2026-01-01', '2026-03-31');
  assert.equal(id, periodIdFor('DURATION', '2026-01-01', '2026-03-31'));
  assert.throws(() => financialPeriodIdentityIdFor({
    schemaVersion: FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
    periodType: 'DURATION', periodStart: '2026-01-01', periodEnd: '2026-03-31',
    documentFiscalPeriodFocus: 'Q1',
  }), (error) => error instanceof CanonicalizationError);
});
define('I1-D010', () => withStore((store) => {
  // The instance carries the current reported EPS and a prior-year comparative
  // EPS under the same tag; only the current one may become an observation.
  assert.equal(COMPARATIVE_INSTANCE_XML.split('us-gaap:EarningsPerShareDiluted').length - 1, 4,
    'the fixture really carries two EPS facts (open and close tags)');
  assert.ok(COMPARATIVE_INSTANCE_XML.includes('<startDate>2025-01-01</startDate>'),
    'the fixture really carries a comparative duration context');
  const current = buildPeriod(store, 'DURATION', '2026-01-01', '2026-03-31');
  const comparative = buildPeriod(store, 'DURATION', '2025-01-01', '2025-03-31');
  assert.notEqual(current.financialPeriodIdentityId, comparative.financialPeriodIdentityId);

  const transform = pinEarningsTransformImplementationManifestV2(store);
  const taxonomy = pinSyntheticTaxonomyBundle(store);
  const filing = pinCustomXbrlFiling(store, synthetic8KFiling(), COMPARATIVE_INSTANCE_XML);
  const pipeline = ingestEarningsDatasetL4CIV1({
    store,
    sourceFilingDocumentIds: [filing.sourceFilingDocumentId],
    transformImplementationManifestId: transform.transformImplementationManifestId,
    earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
    previousSnapshotId: null,
  });

  const observations = pipelineObservations(store, pipeline);
  assert.equal(observations.length, 1, 'only the current reported period is observed');
  assert.equal(pipeline.snapshot.earningsDatasetSnapshotManifest.metricObservationCount, 1);
  const [observed] = observations;
  assert.equal(observed.metricCode, 'EPS_DILUTED');
  assert.equal(observed.financialPeriodIdentityId, current.financialPeriodIdentityId,
    'the extracted fact belongs to the current reported period');
  assert.equal(observed.atoms, '125', 'the current fact value, not the comparative one');
  assert.equal(observed.scale, 2);
  for (const observation of observations) {
    assert.notEqual(observation.financialPeriodIdentityId, comparative.financialPeriodIdentityId,
      'the comparative period never reaches an observation');
    assert.notEqual(observation.atoms, '77', 'the comparative value never reaches an observation');
  }
  // A comparative fact is out of scope by policy, not an extraction defect, so
  // the report stays diagnostic-free and keeps the closed empty-list digest.
  const report = pipeline.items[0].report.earningsMetricExtractionReport;
  assert.equal(report.diagnosticCount, 0);
  assert.equal(report.orderedDiagnosticDigest, earningsOrderedDiagnosticDigestV1([]));
  assert.deepEqual(report.orderedObservationIds,
    observations.map((observation) => observation.earningsMetricObservationId));
  const policy = normalizeEarningsIngestionPolicyV1(ingestionPolicyRecord());
  assert.equal(policy.periodSelectionPolicy, 'CURRENT_REPORTED_PERIODS_ONLY');
}));
define('I1-D011', () => withStore((store) => {
  const documentPeriodEndDate = '2026-03-31';
  const instant = buildPeriod(store, 'INSTANT', null, documentPeriodEndDate);
  assert.equal(instant.financialPeriodIdentityCore.periodEnd, documentPeriodEndDate);
  const verified = verifyFinancialPeriodIdentityCore({
    store, financialPeriodIdentityId: instant.financialPeriodIdentityId,
  });
  assert.equal(verified.financialPeriodIdentityCore.periodType, 'INSTANT');
}));
define('I1-D012', () => withStore((store) => {
  const documentPeriodEndDate = '2026-03-31';
  const duration = buildPeriod(store, 'DURATION', '2026-01-01', documentPeriodEndDate);
  assert.equal(duration.financialPeriodIdentityCore.periodEnd, documentPeriodEndDate);
  assert.notEqual(duration.financialPeriodIdentityId,
    periodIdFor('INSTANT', null, documentPeriodEndDate));
}));
define('I1-D013', () => {
  const base = periodIdFor('DURATION', '2026-01-01', '2026-03-31');
  for (const shifted of ['2026-03-30', '2026-04-01', '2026-03-29']) {
    assert.notEqual(base, periodIdFor('DURATION', '2026-01-01', shifted));
  }
});

/* ----------------------------------------------------------------- units -- */

define('I1-U001', () => withStore((store) => {
  const built = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  assert.equal(built.xbrlCanonicalUnitCore.unitCode, 'USD');
  assert.equal(built.xbrlCanonicalUnitId,
    xbrlCanonicalUnitIdFor({ schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, unitCode: 'USD' }));
}));
define('I1-U002', () => withStore((store) => {
  const built = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD_PER_SHARE' });
  assert.equal(built.xbrlCanonicalUnitCore.unitCode, 'USD_PER_SHARE');
  assert.notEqual(built.xbrlCanonicalUnitId,
    xbrlCanonicalUnitIdFor({ schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, unitCode: 'USD' }));
}));
define('I1-U007', () => {
  // Both admitted QName spellings of the same namespace map to one unit code.
  assert.equal(canonicalizeXbrlUnitMeasuresV1({ measures: ['iso4217:USD'] }), 'USD');
  assert.equal(canonicalizeXbrlUnitMeasuresV1({
    measures: ['{http://www.xbrl.org/2003/iso4217}USD'] }), 'USD');
  assert.throws(() => canonicalizeXbrlUnitMeasuresV1({ measures: ['iso4217:EUR'] }),
    (error) => error?.code === 'EARNINGS_UNIT_REJECTED');
});
define('I1-U009', () => withStore((store) => {
  const built = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  assert.equal(built.xbrlCanonicalUnitCore.schemaVersion, XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(built.xbrlCanonicalUnitCore), ['schemaVersion', 'unitCode']);
}));
define('I1-U012', () => withStore((store) => {
  assert.equal(canonicalizeXbrlUnitMeasuresV1({
    numeratorMeasures: ['iso4217:USD'], denominatorMeasures: ['xbrli:shares'],
  }), 'USD_PER_SHARE');
  const built = buildXbrlCanonicalUnitFromMeasures({
    store, unit: { numeratorMeasures: ['iso4217:USD'], denominatorMeasures: ['xbrli:shares'] },
  });
  assert.equal(built.xbrlCanonicalUnitCore.unitCode, 'USD_PER_SHARE');
  assert.throws(() => canonicalizeXbrlUnitMeasuresV1({
    numeratorMeasures: ['xbrli:shares'], denominatorMeasures: ['iso4217:USD'],
  }), (error) => error?.code === 'EARNINGS_UNIT_REJECTED');
}));
define('I1-U013', () => withStore((store) => {
  const built = buildXbrlCanonicalUnitFromMeasures({ store, unit: { measures: ['iso4217:USD'] } });
  assert.equal(built.xbrlCanonicalUnitCore.unitCode, 'USD');
  assert.throws(() => canonicalizeXbrlUnitMeasuresV1({ measures: ['xbrli:pure'] }),
    (error) => error?.code === 'EARNINGS_UNIT_REJECTED');
}));
define('I1-U014', () => withStore((store) => {
  const built = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD_PER_SHARE' });
  const recomputed = xbrlCanonicalUnitIdFor(built.xbrlCanonicalUnitCore);
  assert.equal(built.xbrlCanonicalUnitId, recomputed);
}));
define('I1-U015', () => withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
  const earningsRevisionIdentityId = pipeline.revisionSet.earningsRevisionSetManifest
    .orderedEventChains[0].orderedRevisions[0].earningsRevisionIdentityId;
  const unit = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD_PER_SHARE' });
  const period = buildPeriod(store, 'DURATION', '2026-01-01', '2026-03-31');
  const observation = buildEarningsMetricObservationCore({
    store,
    earningsRevisionIdentityId,
    financialPeriodIdentityId: period.financialPeriodIdentityId,
    xbrlCanonicalUnitId: unit.xbrlCanonicalUnitId,
    metricCode: 'EPS_DILUTED', atoms: '125', scale: 2,
    shareBasis: 'DILUTED', accountingBasis: 'GAAP',
  });
  assert.equal(observation.earningsMetricObservationCore.xbrlCanonicalUnitId,
    unit.xbrlCanonicalUnitId);
  // The unit pin is load-bearing: EPS with a USD unit is rejected outright.
  const usd = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  assert.throws(() => buildEarningsMetricObservationCore({
    store,
    earningsRevisionIdentityId,
    financialPeriodIdentityId: period.financialPeriodIdentityId,
    xbrlCanonicalUnitId: usd.xbrlCanonicalUnitId,
    metricCode: 'EPS_DILUTED', atoms: '125', scale: 2,
    shareBasis: 'DILUTED', accountingBasis: 'GAAP',
  }), (error) => error?.code === 'EARNINGS_UNIT_REJECTED');
}));
define('I1-U016', () => withStore((store) => {
  const unit = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  const verified = verifyXbrlCanonicalUnitCore({ store, xbrlCanonicalUnitId: unit.xbrlCanonicalUnitId });
  assert.equal(verified.xbrlCanonicalUnitCore.unitCode, 'USD');
  assert.throws(() => verifyXbrlCanonicalUnitCore({
    store, xbrlCanonicalUnitId: `sha256:${'e'.repeat(64)}`,
  }), (error) => error?.code === 'EARNINGS_UNIT_MISSING');
}));
define('I1-U017', () => withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
  const earningsRevisionIdentityId = pipeline.revisionSet.earningsRevisionSetManifest
    .orderedEventChains[0].orderedRevisions[0].earningsRevisionIdentityId;
  const unit = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  const period = buildPeriod(store, 'DURATION', '2026-01-01', '2026-03-31');
  const observation = (scale) => buildEarningsMetricObservationCore({
    store,
    earningsRevisionIdentityId,
    financialPeriodIdentityId: period.financialPeriodIdentityId,
    xbrlCanonicalUnitId: unit.xbrlCanonicalUnitId,
    metricCode: 'REVENUE_CONSOLIDATED', atoms: '125000000', scale,
    shareBasis: null, accountingBasis: null,
  });
  assert.equal(observation(0).earningsMetricObservationCore.scale, 0);
  for (const forbidden of [1.5, Number.NaN, -1]) {
    assert.throws(() => observation(forbidden),
      (error) => error?.code === 'EARNINGS_FIXED_POINT_SCALE_INVALID');
  }
}));
define('I1-U018', () => {
  assert.equal(EARNINGS_UNIT_CODES.length, 2);
  assert.deepEqual([...EARNINGS_UNIT_CODES], ['USD', 'USD_PER_SHARE']);
});
define('I1-U019', () => withStore((store) => {
  const unit = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  const again = buildXbrlCanonicalUnitCore({ store, unitCode: 'USD' });
  assert.equal(unit.xbrlCanonicalUnitId, again.xbrlCanonicalUnitId,
    'unit identity never depends on any observation value');
}));
define('I1-U020', () => {
  const ordered = xbrlCanonicalUnitIdFor({
    schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, unitCode: 'USD_PER_SHARE' });
  const reversed = xbrlCanonicalUnitIdFor({
    unitCode: 'USD_PER_SHARE', schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION });
  assert.equal(ordered, reversed);
});

/* ---------------------------------------------------------------- oracle -- */

define('I1-O001', () => withOfficialEarningsL4CI1Fixture(({ store, filings }) => {
  const filing = filings[0];
  const bytesId = filing.secFilingSourceDocument.orderedDocuments[0].secDocumentBytesId;
  const bytes = verifyEarningsSecDocumentBytes({ store, secDocumentBytesId: bytesId });
  assert.equal(bytes.secDocumentBytesCore.documentObjectId, bytes.secDocumentBytesCore.sha256);
  assert.equal(bytes.secDocumentBytesCore.byteLength, bytes.bytes.length);
  assert.match(filing.sourceFilingDocumentId, /^sha256:[0-9a-f]{64}$/);
}));
define('I1-O002', () => {
  const golden = earningsEventIdentityIdFor({
    schemaVersion: EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
    filerCik: '1234567890', accessionNumber: '1234567890-26-000001',
  });
  const built = withStore((store) => buildEarningsEventIdentityCore({
    store, filerCik: '1234567890', accessionNumber: '1234567890-26-000001',
  }).eventIdentityId);
  assert.equal(built, golden, 'event identity derives from cik+accession only');
});
define('I1-O003', () => withStore((store) => {
  const first = buildEarningsEventIdentityCore({
    store, filerCik: '1234567890', accessionNumber: '1234567890-26-000001' });
  const second = buildEarningsEventIdentityCore({
    store, filerCik: '1234567890', accessionNumber: '1234567890-26-000002' });
  assert.notEqual(first.eventIdentityId, second.eventIdentityId);
}));
define('I1-O006', () => {
  const q1 = periodIdFor('DURATION', '2026-01-01', '2026-03-31');
  const h1 = periodIdFor('DURATION', '2025-10-01', '2026-03-31');
  const instant = periodIdFor('INSTANT', null, '2026-03-31');
  assert.equal(new Set([q1, h1, instant]).size, 3, 'raw spans stay distinct without fiscal labels');
});
define('I1-O007', () => {
  const current = periodIdFor('DURATION', '2026-01-01', '2026-03-31');
  const comparative = periodIdFor('DURATION', '2025-01-01', '2025-03-31');
  assert.notEqual(current, comparative);
  const digest = earningsOrderedMetricObservationIdentityDigestV1([current, comparative]);
  assert.equal(digest, earningsOrderedMetricObservationIdentityDigestV1([comparative, current]),
    'digest is order-independent over the sorted identity set');
});
define('I1-O008', () => {
  const duration = periodIdFor('DURATION', '2025-01-01', '2025-12-31');
  assert.match(duration, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(duration, periodIdFor('INSTANT', null, '2025-12-31'));
});
define('I1-O009', () => {
  assert.deepEqual([...EARNINGS_EPS_TAG_PRIORITY], [
    'us-gaap:EarningsPerShareDiluted',
    'us-gaap:EarningsPerShareBasicAndDiluted',
  ]);
});
define('I1-O010', () => {
  assert.deepEqual([...EARNINGS_REVENUE_TAG_PRIORITY], [
    'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax',
    'us-gaap:Revenues',
    'us-gaap:SalesRevenueNet',
  ]);
});
define('I1-O011', () => withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
  const entry = pipeline.extractionSet.earningsExtractionSetManifest
    .orderedRevisionExtractionEntries.find((item) => item.orderedMetricObservationIds.length > 0);
  assert.ok(entry, 'the official fixture extracts metrics');
  const observations = entry.orderedMetricObservationIds.map((id) => store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: id }),
    expectedObjectId: id, schemaVersion: 'EarningsMetricObservationCore/1',
  }).value);
  const eps = observations.find((item) => item.metricCode === 'EPS_DILUTED');
  assert.ok(eps, 'EPS observation present');
  // 1.25 encodes as atoms 125 with scale 2 under the minimal fixed-point rule.
  assert.equal(eps.atoms, '125');
  assert.equal(eps.scale, 2);
  assert.equal(eps.shareBasis, 'DILUTED');
  assert.equal(eps.accountingBasis, 'GAAP');
}));
define('I1-O012', () => withOfficialEarningsL4CI1Fixture(({ pipeline }) => {
  const manifest = pipeline.eventSet.earningsEventSetManifest;
  assert.equal(manifest.orderedEventIdentityDigest, earningsOrderedEventIdentityDigestV1(
    manifest.orderedEventEntries.map((entry) => entry.eventIdentityId)));
}));
define('I1-O013', () => withOfficialEarningsL4CI1Fixture(({ pipeline }) => {
  const manifest = pipeline.revisionSet.earningsRevisionSetManifest;
  assert.equal(manifest.orderedRevisionIdentityDigest, earningsOrderedRevisionIdentityDigestV1(
    manifest.orderedEventChains.map((chain) =>
      chain.orderedRevisions[0].earningsRevisionIdentityId)));
}));
define('I1-O014', () => withOfficialEarningsL4CI1Fixture(({ pipeline }) => {
  const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
  assert.equal(snapshot.datasetSeriesIdentity, EARNINGS_DATASET_SERIES_IDENTITY);
  assert.equal(snapshot.earningsExtractionSetManifestId,
    pipeline.extractionSet.earningsExtractionSetManifestId);
  assert.equal(snapshot.supersedesEarningsDatasetSnapshotManifestId, null);
  for (const field of ['orderedEventIdentityDigest', 'orderedRevisionIdentityDigest',
    'orderedExtractionReportDigest', 'orderedMetricObservationDigest',
    'orderedMetricObservationIdentityDigest']) {
    assert.match(snapshot[field], /^sha256:[0-9a-f]{64}$/);
  }
}));
define('I1-O015', () => {
  // April is EDT (UTC-4); January is EST (UTC-5).  Both pinned independently.
  assert.equal(secAcceptanceDatetimeToUtcV1('20260423160530'), '2026-04-23T20:05:30.000Z');
  assert.equal(secAcceptanceDatetimeToUtcV1('20260115160530'), '2026-01-15T21:05:30.000Z');
});
define('I1-O016', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling({ includeMetrics: false })]);
  const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
  assert.equal(snapshot.eventCount, 1);
  assert.equal(snapshot.metricObservationCount, 0);
  assert.notEqual(snapshot.firstPublicAvailableAt, null);
});
define('I1-O017', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling()]);
  const chains = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains;
  assert.equal(chains.length, 1);
  assert.equal(chains[0].orderedRevisions.length, 1);
  assert.equal(chains[0].orderedRevisions[0].parentRevisionIdentityId, null);
  assert.equal(pipeline.snapshot.earningsDatasetSnapshotManifest.revisionCount, 1);
});
define('I1-O018', () => {
  const { pipeline } = ingestDefinitions([
    synthetic8KFiling(),
    synthetic8KFiling({ accessionNumber: '1234567890-26-000009', formType: '8-K/A',
      amendmentFlag: true, amendsFilingAccessionNumber: '1234567890-26-000001' }),
  ]);
  const chains = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains;
  assert.equal(chains.length, 2, 'the /A accession is an independent event');
  for (const chain of chains) {
    assert.equal(chain.orderedRevisions.length, 1);
    assert.equal(chain.orderedRevisions[0].parentRevisionIdentityId, null);
  }
});
define('I1-O019', () => {
  const identity = { datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
    jurisdictionCode: 'US', currencyCode: 'USD', allowedSourceAuthority: 'SEC_EDGAR' };
  const key = earningsDatasetIdentityKeyV1(identity);
  assert.match(key, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(key, earningsDatasetIdentityKeyV1({ ...identity, currencyCode: 'EUR' }));
});
define('I1-O020', () => {
  const a = `sha256:${'1'.repeat(64)}`;
  const b = `sha256:${'2'.repeat(64)}`;
  assert.equal(earningsOrderedMetricObservationIdentityDigestV1([a, b]),
    earningsOrderedMetricObservationIdentityDigestV1([b, a]));
  assert.notEqual(earningsOrderedMetricObservationIdentityDigestV1([a]),
    earningsOrderedMetricObservationIdentityDigestV1([a, b]));
});
define('I1-O021', () => {
  const empties = [
    earningsOrderedEventIdentityDigestV1([]),
    earningsOrderedRevisionIdentityDigestV1([]),
    earningsOrderedMetricObservationIdentityDigestV1([]),
  ];
  for (const digest of empties) assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(new Set(empties).size, 3, 'each domain separates its own empty-list digest');
});

/* -------------------------------------------------------------- registry -- */

define('I1-M001', () => {
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  assert.equal(new Set(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS).size, 129);
});
define('I1-M002', () => {
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(new Set(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS).size, 5);
});
define('I1-M003', () => {
  assert.equal(EARNINGS_L4C_I1_SCHEMA_VERSIONS.length, 16);
  assert.equal(new Set(EARNINGS_L4C_I1_SCHEMA_VERSIONS).size, 16);
  for (const schema of EARNINGS_L4C_I1_SCHEMA_VERSIONS) {
    assert.ok(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(schema), `${schema} registered`);
  }
});
define('I1-M004', () => {
  assert.ok(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION));
  assert.ok(!EARNINGS_L4C_I1_SCHEMA_VERSIONS.includes(
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION), 'TIM/2 is reused, not redefined');
});
define('I1-M005', () => {
  assert.ok(!SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('EarningsParserImplementationManifest/1'));
  assert.throws(() => normalizeCanonicalValue('EarningsParserImplementationManifest/1', {}),
    (error) => error?.code === 'CANONICAL_SCHEMA_UNKNOWN');
});
define('I1-M006', () => {
  assert.equal(officialCaseRows().length, 365);
});
define('I1-M007', () => {
  const ids = officialCaseRows().map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'official test ids are unique');
});
define('I1-M008', () => withOfficialEarningsL4CI1Fixture(({ store, transform, pipeline, filings }) => {
  const traversal = verifyEarningsSnapshotTraversalV1({
    store,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    labRoot: transform.labRoot,
  });
  for (const filing of filings) {
    assert.ok(traversal.closureObjectIds.includes(filing.sourceFilingDocumentId),
      'every filing is reachable from the snapshot');
  }
}));
define('I1-M009', () => withOfficialEarningsL4CI1Fixture(({ store, transform, pipeline }) => {
  const traversal = verifyEarningsSnapshotTraversalV1({
    store,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    labRoot: transform.labRoot,
  });
  const entries = pipeline.extractionSet.earningsExtractionSetManifest
    .orderedRevisionExtractionEntries;
  const observationIds = entries.flatMap((entry) => entry.orderedMetricObservationIds);
  assert.ok(observationIds.length > 0);
  for (const id of observationIds) assert.ok(traversal.closureObjectIds.includes(id));
}));
define('I1-M010', () => {
  const policy = normalizeEarningsIngestionPolicyV1(ingestionPolicyRecord());
  assert.equal(policy.latestReferencePolicy, 'FORBIDDEN');
  // The guard is the production branch: any "latest" pin is refused, and only
  // explicit CAS ids pass.
  for (const alias of ['latest', 'LATEST', ' latest ']) {
    assert.throws(() => assertExplicitPinnedEarningsIdV1(alias, 'earningsIngestionPolicyId'),
      (error) => error?.code === 'EARNINGS_POLICY_LATEST_FORBIDDEN');
  }
  assert.equal(assertExplicitPinnedEarningsIdV1(`sha256:${'a'.repeat(64)}`, 'pin'), undefined);
  withStore((store) => {
    assert.throws(() => verifyEarningsIngestionPolicy({
      store, earningsIngestionPolicyId: 'latest',
    }), (error) => error?.code === 'EARNINGS_POLICY_LATEST_FORBIDDEN');
  });
});
define('I1-M011', () => {
  const policy = normalizeEarningsIngestionPolicyV1(ingestionPolicyRecord());
  assert.equal(policy.networkDuringComputationPolicy, 'FORBIDDEN');
  const source = earningsSourceText();
  for (const token of ['node:http', 'node:https', 'node:net', 'fetch(', 'axios']) {
    assert.ok(!source.includes(token), `no earnings module references ${token}`);
  }
});
define('I1-M013', () => {
  const rows = officialCaseRows();
  const files = new Set(rows.map((row) => row.file));
  assert.equal(files.size, 14);
  assert.ok(files.has('market-earnings-l4c-i1-extraction-set.test.mjs'));
  assert.equal(rows.filter((row) => row.group === 'extraction-set').length, 23);
});
define('I1-M014', () => {
  // The PASS C checklist reduces to these closed design invariants.
  assert.equal(EARNINGS_L4C_I1_SCHEMA_VERSIONS.length, 16);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  assert.equal(EARNINGS_TRAVERSAL_EDGES_V1.length, 35);
  assert.equal(officialCaseRows().length, 365);
  assert.equal(EARNINGS_INGESTION_POLICY_VALUES.datasetSeriesIdentity,
    'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1');
});
define('I1-M015', () => {
  assert.equal(EARNINGS_TRAVERSAL_EDGES_V1.length, EARNINGS_TRAVERSAL_EDGE_COUNT_V1);
  assert.equal(EARNINGS_TRAVERSAL_EDGE_COUNT_V1, 35);
  const keys = EARNINGS_TRAVERSAL_EDGES_V1.map((edge) => edge.join(' '));
  assert.equal(new Set(keys).size, 35, 'no duplicate traversal edge');
});
define('I1-M016', () => {
  assert.equal(EARNINGS_L4C_I1_SCHEMA_VERSIONS.length, 16);
  assert.ok(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes(
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION));
  assert.ok(!SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('EarningsParserImplementationManifest/1'));
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
});

/* --------------------------------------------- identities / revision-set -- */

function officialChain(callback) {
  return withOfficialEarningsL4CI1Fixture((context) => {
    const chains = context.pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains;
    return callback({ ...context, chains });
  });
}

define('I1-I001', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling()]);
  assert.equal(pipeline.eventSet.earningsEventSetManifest.eventCount, 1);
  assert.equal(pipeline.revisionSet.earningsRevisionSetManifest.revisionCount, 1);
});
define('I1-I002', () => withStore((store) => {
  const built = buildEarningsEventIdentityCore({
    store, filerCik: '1234567890', accessionNumber: '1234567890-26-000001' });
  assert.deepEqual(Object.keys(built.earningsEventIdentityCore),
    ['schemaVersion', 'filerCik', 'accessionNumber']);
}));
define('I1-I003', () => {
  assert.equal(earningsEventTypeForFormV1('8-K'), 'EARNINGS_RELEASE');
  assert.equal(earningsEventTypeForFormV1('8-K/A'), 'EARNINGS_RELEASE');
});
define('I1-I004', () => {
  assert.equal(earningsEventTypeForFormV1('10-Q'), 'EARNINGS_FILING');
  assert.equal(earningsEventTypeForFormV1('10-K'), 'EARNINGS_FILING');
  assert.equal(earningsEventTypeForFormV1('10-K/A'), 'EARNINGS_FILING');
});
define('I1-I006', () => officialChain(({ store, chains }) => {
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: chains[0].orderedRevisions[0].earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.equal(identity.eventIdentityId, chains[0].eventIdentityId);
}));
define('I1-I007', () => officialChain(({ store, chains }) => {
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: chains[0].orderedRevisions[0].earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.match(identity.publicAvailableAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}));
define('I1-I008', () => officialChain(({ store, chains }) => {
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: chains[0].orderedRevisions[0].earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.match(identity.sourceFilingDocumentId, /^sha256:[0-9a-f]{64}$/);
}));
define('I1-I010', () => officialChain(({ store, chains }) => {
  const entry = chains[0].orderedRevisions[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: entry.earningsRevisionId }).earningsRevisionCore;
  assert.deepEqual(Object.keys(core), ['schemaVersion', 'earningsRevisionIdentityId',
    'eventIdentityId', 'publicAvailableAt', 'sourceFilingDocumentId', 'revisionKind',
    'parentRevisionIdentityId']);
  assert.equal(core.earningsRevisionIdentityId, entry.earningsRevisionIdentityId);
  assert.equal(core.revisionKind, 'INITIAL');
}));
define('I1-I011', () => officialChain(({ store, chains }) => {
  const entry = chains[0].orderedRevisions[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: entry.earningsRevisionId }).earningsRevisionCore;
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.equal(core.eventIdentityId, identity.eventIdentityId);
}));
define('I1-I012', () => officialChain(({ store, chains }) => {
  const entry = chains[0].orderedRevisions[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: entry.earningsRevisionId }).earningsRevisionCore;
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.equal(core.sourceFilingDocumentId, identity.sourceFilingDocumentId);
}));
define('I1-I013', () => officialChain(({ store, chains }) => {
  const entry = chains[0].orderedRevisions[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: entry.earningsRevisionId }).earningsRevisionCore;
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.equal(core.publicAvailableAt, identity.publicAvailableAt);
}));
define('I1-I014', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling(), synthetic10KAFiling()]);
  assert.equal(pipeline.eventSet.earningsEventSetManifest.eventCount, 2);
  for (const chain of pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains) {
    assert.equal(chain.orderedRevisions[0].parentRevisionIdentityId, null);
  }
});
define('I1-I015', () => {
  const first = ingestDefinitions([synthetic8KFiling()]);
  const second = ingestDefinitions([synthetic8KFiling()]);
  assert.equal(first.pipeline.snapshot.earningsDatasetSnapshotManifestId,
    second.pipeline.snapshot.earningsDatasetSnapshotManifestId,
    'identical content in two stores is hash-stable, not an immutability conflict');
});
define('I1-I017', () => {
  const admission = admitDefinition(synthetic10KAFiling());
  const filing = admission.secFilingSourceDocument;
  assert.equal(filing.amendmentFlag, true);
  assert.equal(filing.amendsFilingAccessionNumber, '1234567890-26-000000');
  assert.equal(earningsEventTypeForFormV1(filing.formType), 'EARNINGS_FILING');
});
define('I1-I018', () => {
  const withMetrics = ingestDefinitions([synthetic8KFiling()]);
  const withoutMetrics = ingestDefinitions([synthetic8KFiling({ includeMetrics: false })]);
  assert.equal(withMetrics.pipeline.eventSet.earningsEventSetManifest
    .orderedEventEntries[0].eventIdentityId,
  withoutMetrics.pipeline.eventSet.earningsEventSetManifest
    .orderedEventEntries[0].eventIdentityId,
  'event identity never depends on extracted periods');
});

define('I1-G001', () => officialChain(({ store, chains }) => {
  for (const chain of chains) {
    assert.equal(chain.orderedRevisions.length, 1);
    const core = verifyEarningsRevisionCore({
      store, earningsRevisionId: chain.orderedRevisions[0].earningsRevisionId,
    }).earningsRevisionCore;
    assert.equal(core.revisionKind, 'INITIAL');
    assert.equal(core.parentRevisionIdentityId, null);
  }
}));
define('I1-G002', () => officialChain(({ chains }) => {
  for (const chain of chains) {
    const entry = chain.orderedRevisions[0];
    assert.match(entry.earningsRevisionId, /^sha256:[0-9a-f]{64}$/);
    assert.match(entry.earningsRevisionIdentityId, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(entry.earningsRevisionId, entry.earningsRevisionIdentityId);
  }
}));
define('I1-G003', () => officialChain(({ chains }) => {
  const ids = chains.map((chain) => chain.eventIdentityId);
  assert.deepEqual(ids, [...ids].sort(), 'chains are canonically ordered by event id');
  assert.equal(new Set(ids).size, ids.length);
}));
define('I1-G004', () => officialChain(({ pipeline, chains }) => {
  assert.equal(pipeline.revisionSet.earningsRevisionSetManifest.revisionCount, chains.length);
  assert.equal(pipeline.eventSet.earningsEventSetManifest.eventCount, chains.length);
}));
define('I1-G005', () => officialChain(({ pipeline, chains }) => {
  assert.equal(pipeline.revisionSet.earningsRevisionSetManifest.orderedRevisionIdentityDigest,
    earningsOrderedRevisionIdentityDigestV1(
      chains.map((chain) => chain.orderedRevisions[0].earningsRevisionIdentityId)));
}));
define('I1-G015', () => officialChain(({ store, chains }) => {
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: chains[0].orderedRevisions[0].earningsRevisionId,
  }).earningsRevisionCore;
  assert.equal(core.revisionKind, 'INITIAL');
  assert.equal(core.parentRevisionIdentityId, null);
}));
define('I1-G016', () => officialChain(({ store, chains }) => {
  const entry = chains[0].orderedRevisions[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: entry.earningsRevisionId }).earningsRevisionCore;
  assert.equal(entry.earningsRevisionIdentityId, core.earningsRevisionIdentityId);
}));
define('I1-G022', () => officialChain(({ chains }) => {
  assert.equal(chains.length, 3, 'the official fixture is a forest of three events');
  for (const chain of chains) assert.equal(chain.orderedRevisions.length, 1);
  assert.equal(new Set(chains.map((chain) => chain.eventIdentityId)).size, 3);
}));
define('I1-G030', () => {
  const one = ingestDefinitions([synthetic8KFiling()]);
  const two = ingestDefinitions([synthetic8KFiling(), synthetic10QFiling()]);
  assert.notEqual(one.pipeline.revisionSet.earningsRevisionSetManifestId,
    two.pipeline.revisionSet.earningsRevisionSetManifestId,
    'a RevisionSet content change yields a new CAS id');
  const manifest = two.pipeline.revisionSet.earningsRevisionSetManifest;
  assert.ok(!Object.hasOwn(manifest, 'supersedesEarningsRevisionSetManifestId'));
  assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'orderedEventChains',
    'revisionCount', 'orderedRevisionIdentityDigest']);
});
define('I1-G031', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling()]);
  const chains = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains;
  assert.equal(chains.length, 1);
  assert.equal(chains[0].orderedRevisions.length, 1);
  assert.equal(chains[0].orderedRevisions[0].parentRevisionIdentityId, null);
});
define('I1-G035', () => {
  const { pipeline } = ingestDefinitions([
    synthetic8KFiling(),
    synthetic8KFiling({ accessionNumber: '1234567890-26-000010', formType: '8-K/A',
      amendmentFlag: true, amendsFilingAccessionNumber: '1234567890-26-000001' }),
  ]);
  const chains = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains;
  assert.equal(chains.length, 2);
  for (const chain of chains) {
    assert.equal(chain.orderedRevisions.length, 1);
    assert.equal(chain.orderedRevisions[0].parentRevisionIdentityId, null);
  }
});

/* ------------------------------------------------------- source-document -- */

function officialBytes(callback) {
  return withOfficialEarningsL4CI1Fixture((context) => {
    const filing = context.filings[0].secFilingSourceDocument;
    const bytesId = filing.orderedDocuments[0].secDocumentBytesId;
    const verified = verifyEarningsSecDocumentBytes({ store: context.store, secDocumentBytesId: bytesId });
    return callback({ ...context, filing, bytesId, verified });
  });
}

define('I1-B001', () => officialBytes(({ verified }) => {
  assert.match(verified.secDocumentBytesCore.documentObjectId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(verified.secDocumentBytesCore.documentObjectId,
    verified.secDocumentBytesCore.sha256);
}));
define('I1-B002', () => officialBytes(({ store, verified }) => {
  const raw = store.readObject({
    uri: store.uriForObject({ namespace: 'source',
      objectId: verified.secDocumentBytesCore.documentObjectId }),
    expectedObjectId: verified.secDocumentBytesCore.documentObjectId,
  });
  assert.ok(raw.bytes.length > 0);
  assert.ok(raw.bytes.toString('utf8').startsWith('<?xml'));
}));
define('I1-B003', () => officialBytes(({ verified }) => {
  const recomputed = `sha256:${createHash('sha256').update(verified.bytes).digest('hex')}`;
  assert.equal(verified.secDocumentBytesCore.sha256, recomputed,
    'the pinned sha256 is the digest of the raw bytes actually stored');
  assert.equal(verified.secDocumentBytesCore.documentObjectId, recomputed);
}));
define('I1-B004', () => officialBytes(({ verified }) => {
  assert.equal(verified.secDocumentBytesCore.byteLength, verified.bytes.length);
  assert.ok(verified.secDocumentBytesCore.byteLength >= 1);
}));
define('I1-B008', () => officialBytes(({ store, filing }) => {
  for (const entry of filing.orderedDocuments) {
    const resolved = verifyEarningsSecDocumentBytes({
      store, secDocumentBytesId: entry.secDocumentBytesId });
    assert.equal(resolved.secDocumentBytesCore.documentRole, entry.documentRole);
  }
}));
define('I1-B011', () => officialBytes(({ filing }) => {
  assert.ok(Array.isArray(filing.orderedDocuments));
  assert.ok(filing.orderedDocuments.length >= 1);
  assert.deepEqual(Object.keys(filing.orderedDocuments[0]),
    ['secDocumentBytesId', 'documentRole'], 'entry order is the filing order carrier');
}));
define('I1-B012', () => officialBytes(({ filing }) => {
  assert.ok(filing.orderedDocuments.some((entry) =>
    EARNINGS_STRUCTURED_DOCUMENT_ROLES.includes(entry.documentRole)));
}));
define('I1-B013', () => officialBytes(({ store, verified }) => {
  const uri = store.uriForObject({ namespace: 'source',
    objectId: verified.secDocumentBytesCore.documentObjectId });
  assert.ok(!/\.\./.test(uri), 'no parent traversal in the object uri');
  assert.match(verified.secDocumentBytesCore.documentObjectId, /^sha256:[0-9a-f]{64}$/);
}));
define('I1-B015', () => withOfficialEarningsL4CI1Fixture(({ store, taxonomy }) => {
  const ids = taxonomy.earningsTaxonomyBundleManifest.orderedComponentDocumentIds;
  assert.ok(ids.length >= 1);
  for (const id of ids) {
    const component = verifyEarningsSecDocumentBytes({ store, secDocumentBytesId: id });
    assert.equal(component.secDocumentBytesCore.documentRole, 'TAXONOMY_SCHEMA');
  }
}));
define('I1-B016', () => officialBytes(({ store, verified, bytesId }) => {
  const snapshotsUri = store.uriForObject({ namespace: 'snapshots', objectId: bytesId });
  const sourceUri = store.uriForObject({ namespace: 'source',
    objectId: verified.secDocumentBytesCore.documentObjectId });
  assert.notEqual(snapshotsUri, sourceUri);
  assert.ok(/source/.test(sourceUri), 'raw bytes live in the source namespace');
}));

/* --------------------------------------------------- integration closure -- */

function officialTraversal(callback) {
  return withOfficialEarningsL4CI1Fixture((context) => {
    const traversal = verifyEarningsSnapshotTraversalV1({
      store: context.store,
      earningsDatasetSnapshotManifestId:
        context.pipeline.snapshot.earningsDatasetSnapshotManifestId,
      labRoot: context.transform.labRoot,
    });
    assert.equal(traversal.verified, true);
    assert.equal(traversal.edgeCount, 35);
    return callback({ ...context, traversal });
  });
}

define('I1-R002', () => officialTraversal(({ traversal }) => {
  for (const id of traversal.closureObjectIds) assert.match(id, /^sha256:[0-9a-f]{64}$/);
}));
define('I1-R005', () => {
  const ordered = earningsIngestionPolicyIdFor(ingestionPolicyRecord());
  const record = ingestionPolicyRecord();
  const shuffled = Object.fromEntries(Object.keys(record).reverse().map((key) => [key, record[key]]));
  assert.equal(ordered, earningsIngestionPolicyIdFor(shuffled));
});
define('I1-R006', () => officialTraversal(({ store, transform, pipeline }) => {
  // Two byte-different encodings of one logical source text hash identically.
  const lf = Buffer.from('line1\nline2\n', 'utf8');
  const crlf = Buffer.from('line1\r\nline2\r\n', 'utf8');
  assert.notEqual(lf.toString('hex'), crlf.toString('hex'), 'the encodings really differ');
  assert.equal(crlf.length, lf.length + 2);
  const hashLf = transformSourceTextSha256(lf);
  const hashCrlf = transformSourceTextSha256(crlf);
  assert.equal(hashLf, hashCrlf, 'CRLF is normalized to LF before the module hash');
  assert.equal(hashLf, `sha256:${createHash('sha256').update(lf).digest('hex')}`,
    'the normalized form is the LF form, not the CRLF form');
  assert.equal(transformSourceTextSha256(Buffer.from('line1\rline2\r', 'utf8')), hashLf,
    'an isolated CR normalizes to LF the same way');
  // Only line endings are neutral: real content differences still move the hash.
  assert.notEqual(hashLf, transformSourceTextSha256(Buffer.from('line1\nline3\n', 'utf8')));
  assert.notEqual(hashLf, transformSourceTextSha256(Buffer.from('line1\nline2', 'utf8')),
    'a missing terminal newline stays significant');
  assert.notEqual(hashLf, transformSourceTextSha256(Buffer.from('line1\n\nline2\n', 'utf8')));
  assert.equal(transform.transformImplementationManifest.moduleHashPolicyVersion,
    TRANSFORM_SOURCE_TEXT_POLICY_VERSION);
  // The transform manifest re-derives its module hashes from disk on verify.
  const rebuilt = verifyEarningsSnapshotTraversalV1({
    store,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    labRoot: transform.labRoot,
  });
  assert.equal(rebuilt.verified, true);
  assert.ok(transform.transformImplementationManifest.modules.length >= 1);
}));
define('I1-R007', () => withIngestedDefinitions([synthetic8KFiling({ eps: '-1.25' })],
  ({ store, pipeline }) => {
    assert.equal(pipeline.snapshot.earningsDatasetSnapshotManifest.eventCount, 1);
    const observations = pipelineObservations(store, pipeline);
    const eps = observations.filter((item) => item.metricCode === 'EPS_DILUTED');
    assert.equal(eps.length, 1, 'the negative EPS fact is admitted, not dropped');
    assert.equal(eps[0].atoms, '-125', 'the sign survives the fixed-point encoding');
    assert.equal(eps[0].scale, 2);
    assert.equal(eps[0].unitCode, 'USD_PER_SHARE');
    assert.equal(eps[0].shareBasis, 'DILUTED');
    assert.equal(eps[0].accountingBasis, 'GAAP');
    // Positive control: the sign is the only difference against the same fixture.
    const positive = ingestDefinitions([synthetic8KFiling({ eps: '1.25' })]);
    assert.equal(positive.pipeline.snapshot.earningsDatasetSnapshotManifest
      .metricObservationCount,
    pipeline.snapshot.earningsDatasetSnapshotManifest.metricObservationCount);
    assert.notEqual(positive.pipeline.snapshot.earningsDatasetSnapshotManifestId,
      pipeline.snapshot.earningsDatasetSnapshotManifestId,
      'a negative EPS is a distinct snapshot from its positive twin');
  }));
define('I1-R008', () => withIngestedDefinitions([synthetic8KFiling({ revenue: '-125000000' })],
  ({ store, pipeline }) => {
    assert.equal(pipeline.snapshot.earningsDatasetSnapshotManifest.eventCount, 1);
    const observations = pipelineObservations(store, pipeline);
    const revenue = observations.filter((item) => item.metricCode === 'REVENUE_CONSOLIDATED');
    assert.equal(revenue.length, 1, 'the negative revenue fact is admitted, not dropped');
    assert.equal(revenue[0].atoms, '-125000000', 'the sign survives the fixed-point encoding');
    assert.equal(revenue[0].scale, 0);
    assert.equal(revenue[0].unitCode, 'USD');
    assert.equal(revenue[0].shareBasis, null);
    assert.equal(revenue[0].accountingBasis, null);
    // Positive control: the sign is the only difference against the same fixture.
    const positive = ingestDefinitions([synthetic8KFiling({ revenue: '125000000' })]);
    assert.equal(positive.pipeline.snapshot.earningsDatasetSnapshotManifest
      .metricObservationCount,
    pipeline.snapshot.earningsDatasetSnapshotManifest.metricObservationCount);
    assert.notEqual(positive.pipeline.snapshot.earningsDatasetSnapshotManifestId,
      pipeline.snapshot.earningsDatasetSnapshotManifestId,
      'a negative revenue is a distinct snapshot from its positive twin');
  }));
define('I1-R009', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling(), synthetic10QFiling()]);
  const entries = pipeline.eventSet.earningsEventSetManifest.orderedEventEntries;
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.eventIdentityId)).size, 2);
});
define('I1-R010', () => officialTraversal(({ traversal, pipeline }) => {
  assert.ok(traversal.closureObjectIds.includes(
    pipeline.extractionSet.earningsExtractionSetManifestId));
  assert.equal(new Set(traversal.closureObjectIds).size, traversal.closureObjectIds.length);
}));
define('I1-R011', () => {
  const { pipeline } = ingestDefinitions([synthetic8KFiling(), synthetic10KAFiling()]);
  const entries = pipeline.eventSet.earningsEventSetManifest.orderedEventEntries;
  assert.equal(entries.length, 2, 'the amended filing never rewrites the original event');
});
define('I1-R012', () => withEmptyEarningsL4CI1Fixture(({ store, transform, pipeline }) => {
  const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
  assert.equal(snapshot.emptySnapshot, true);
  assert.equal(snapshot.eventCount, 0);
  assert.equal(snapshot.extractionReportCount, 0);
  assert.equal(snapshot.metricObservationCount, 0);
  assert.equal(snapshot.firstPublicAvailableAt, null);
  const traversal = verifyEarningsSnapshotTraversalV1({
    store,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    labRoot: transform.labRoot,
  });
  assert.equal(traversal.verified, true);
}));
define('I1-R017', () => officialTraversal(({ store, traversal }) => {
  for (const objectId of traversal.closureObjectIds) {
    const uri = store.uriForObject({ namespace: 'snapshots', objectId });
    assert.ok(typeof uri === 'string' && uri.length > 0);
  }
  assert.ok(traversal.closureObjectIds.length > 10);
}));
define('I1-R019', () => officialTraversal(({ store, pipeline, traversal }) => {
  const chain = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains[0];
  const core = verifyEarningsRevisionCore({
    store, earningsRevisionId: chain.orderedRevisions[0].earningsRevisionId,
  }).earningsRevisionCore;
  const identity = verifyEarningsRevisionIdentityCore({
    store, earningsRevisionIdentityId: chain.orderedRevisions[0].earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  assert.equal(core.sourceFilingDocumentId, identity.sourceFilingDocumentId);
  assert.ok(traversal.closureObjectIds.includes(core.sourceFilingDocumentId));
}));
define('I1-R020', () => officialTraversal(({ traversal, filings }) => {
  for (const filing of filings) {
    for (const entry of filing.secFilingSourceDocument.orderedDocuments) {
      assert.ok(traversal.closureObjectIds.includes(entry.secDocumentBytesId));
    }
  }
}));
define('I1-R021', () => officialTraversal(({ store, traversal, filings }) => {
  const bytesId = filings[0].secFilingSourceDocument.orderedDocuments[0].secDocumentBytesId;
  const verified = verifyEarningsSecDocumentBytes({ store, secDocumentBytesId: bytesId });
  assert.ok(traversal.closureObjectIds.includes(verified.secDocumentBytesCore.documentObjectId));
  assert.ok(verified.bytes.length > 0);
}));
define('I1-R022', () => officialTraversal(({ traversal, pipeline }) => {
  const ids = pipeline.extractionSet.earningsExtractionSetManifest
    .orderedRevisionExtractionEntries.flatMap((entry) => entry.orderedMetricObservationIds);
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(traversal.closureObjectIds.includes(id));
}));
define('I1-R023', () => officialTraversal(({ store, traversal, pipeline }) => {
  const ids = pipeline.extractionSet.earningsExtractionSetManifest
    .orderedRevisionExtractionEntries.flatMap((entry) => entry.orderedMetricObservationIds);
  const observation = store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId: ids[0] }),
    expectedObjectId: ids[0], schemaVersion: 'EarningsMetricObservationCore/1',
  }).value;
  assert.ok(traversal.closureObjectIds.includes(observation.financialPeriodIdentityId));
  assert.ok(traversal.closureObjectIds.includes(observation.xbrlCanonicalUnitId));
}));
define('I1-R024', () => officialTraversal(({ traversal, taxonomy }) => {
  for (const id of taxonomy.earningsTaxonomyBundleManifest.orderedComponentDocumentIds) {
    assert.ok(traversal.closureObjectIds.includes(id));
  }
}));
define('I1-R025', () => withOfficialEarningsL4CI1Fixture(({ store, transform, pipeline }) => {
  const modules = transform.transformImplementationManifest.modules;
  assert.ok(modules.length >= 1);
  for (const module of modules) {
    // A TIM/2 module is addressed by a safe relative lab path, never by CAS id.
    assert.ok(!/^sha256:/.test(module.logicalPath),
      'logicalPath is a lab-root path, never a CAS object id');
    assert.match(module.logicalPath, /^src\//);
    assert.ok(!isAbsolute(module.logicalPath), 'logicalPath stays relative');
    assert.ok(!module.logicalPath.includes('\\'), 'logicalPath uses portable separators');
    assert.ok(!module.logicalPath.split('/').includes('..'), 'logicalPath never escapes labRoot');
    assert.match(module.canonicalContentSha256, /^sha256:[0-9a-f]{64}$/);
    // The recorded hash must re-derive from the real bytes on disk.
    const bytes = readFileSync(join(transform.labRoot, ...module.logicalPath.split('/')));
    assert.ok(bytes.length > 0, `${module.logicalPath} must be a real readable module`);
    assert.equal(transformSourceTextSha256(bytes), module.canonicalContentSha256,
      `${module.logicalPath} module hash must re-derive from the real file`);
    // One significant character changed in a temporary copy must break the match.
    const text = bytes.toString('utf8');
    assert.ok(text.includes('export '), `${module.logicalPath} must contain the mutated token`);
    const mutatedCopy = Buffer.from(text.replace('export ', 'exporT '), 'utf8');
    assert.notEqual(mutatedCopy.toString('hex'), bytes.toString('hex'));
    assert.notEqual(transformSourceTextSha256(mutatedCopy), module.canonicalContentSha256,
      `${module.logicalPath} module hash must be content sensitive`);
  }
  assert.equal(new Set(modules.map((module) => module.canonicalContentSha256)).size,
    modules.length, 'distinct modules never collapse onto one hash');
  const traversal = verifyEarningsSnapshotTraversalV1({
    store,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    labRoot: transform.labRoot,
  });
  assert.equal(traversal.verified, true);
  assert.equal(traversal.edgeCount, 35);
}));

/* ---------------------------------------------------------------- oracle -- */

define('I1-O019', () => {
  const identity = {
    datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
    jurisdictionCode: 'US',
    currencyCode: 'USD',
    allowedSourceAuthority: 'SEC_EDGAR',
  };
  assert.equal(identity.datasetSeriesIdentity, 'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1');
  // The preimage is written out field by field here, never taken from
  // production, and the golden below is its literal SHA-256.
  const preimage = Buffer.from([
    'EarningsDatasetIdentityKey/1',
    'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1',
    'US',
    'USD',
    'SEC_EDGAR',
    '',
  ].join('\n'), 'utf8');
  assert.equal(preimage.length, 87, 'the preimage is exactly the five LF-terminated lines');
  const GOLDEN_DATASET_IDENTITY_KEY =
    'sha256:4488962c76ac24a0d52a8f3f72692f9389b7d6ec2ca07a46958adce363afe8bd';
  assert.equal(`sha256:${createHash('sha256').update(preimage).digest('hex')}`,
    GOLDEN_DATASET_IDENTITY_KEY,
    'the literal golden really is the SHA-256 of the literal preimage');
  assert.equal(earningsDatasetIdentityKeyV1(identity), GOLDEN_DATASET_IDENTITY_KEY,
    'production reproduces the independently computed golden');
  assert.equal(oracleDatasetIdentityKeyV1(identity), GOLDEN_DATASET_IDENTITY_KEY);
  // Domain, separator, field order and every field are load bearing.
  const variants = [
    ['EarningsDatasetIdentityKey/2', ...preimage.toString('utf8').split('\n').slice(1)].join('\n'),
    preimage.toString('utf8').replace(/\n/g, ''),
    ['EarningsDatasetIdentityKey/1', 'US', 'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1',
      'USD', 'SEC_EDGAR', ''].join('\n'),
    ['EarningsDatasetIdentityKey/1', 'SEC_US_DOMESTIC_EARNINGS_RELEASE_ONLY_V1',
      'USD', 'SEC_EDGAR', ''].join('\n'),
  ];
  for (const variant of variants) {
    assert.notEqual(`sha256:${createHash('sha256').update(Buffer.from(variant, 'utf8')).digest('hex')}`,
      GOLDEN_DATASET_IDENTITY_KEY,
      'a changed domain, separator, field order or missing field must move the digest');
  }
  for (const field of Object.keys(identity)) {
    const changed = { ...identity, [field]: `${identity[field]}_X` };
    assert.notEqual(earningsDatasetIdentityKeyV1(changed), GOLDEN_DATASET_IDENTITY_KEY,
      `${field} must enter the dataset identity key`);
    assert.equal(earningsDatasetIdentityKeyV1(changed), oracleDatasetIdentityKeyV1(changed));
  }
  assert.equal(earningsDatasetIdentityKeyV1(identity),
    earningsDatasetIdentityKeyV1({ ...identity }), 'the key is a pure function of the four fields');
});

/* ----------------------------------------------------------- adversarial -- */

define('I1-A023', () => {
  const forward = ingestDefinitions([synthetic8KFiling(), synthetic10QFiling(), synthetic10KAFiling()]);
  const reverse = ingestDefinitions([synthetic10KAFiling(), synthetic10QFiling(), synthetic8KFiling()]);
  assert.equal(forward.pipeline.snapshot.earningsDatasetSnapshotManifestId,
    reverse.pipeline.snapshot.earningsDatasetSnapshotManifestId,
    'ingestion order never changes the canonical sort');
});

export const EARNINGS_INTENT_ASSERTIONS = A;
