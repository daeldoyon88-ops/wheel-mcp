import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';
import {
  EARNINGS_DATASET_SERIES_IDENTITY,
  EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
  EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  EARNINGS_INGESTION_POLICY_VALUES,
  EARNINGS_L4C_I1_SCHEMA_VERSIONS,
  EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  EARNINGS_METRIC_EXTRACTION_POLICY_VALUES,
  EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
  EARNINGS_PERIOD_TYPES,
  EARNINGS_REVISION_CORE_SCHEMA_VERSION,
  EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
  EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
  EARNINGS_UNIT_CODES,
  FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION,
  SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
  XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
  earningsDatasetIdentityKeyV1,
  earningsEventIdentityIdFor,
  earningsFunctionalSnapshotFingerprintV1,
  earningsGroupedMetricObservationDigestV1,
  earningsOrderedExtractionReportDigestV1,
  earningsOrderedEventIdentityDigestV1,
  earningsOrderedDiagnosticDigestV1,
  earningsOrderedMetricObservationIdentityDigestV1,
  earningsOrderedRevisionIdentityDigestV1,
  financialPeriodIdentityIdFor,
  normalizeEarningsDatasetSnapshotManifestV1,
  normalizeEarningsEventIdentityCoreV1,
  normalizeEarningsEventSetManifestV1,
  normalizeEarningsExtractionSetManifestV1,
  normalizeEarningsIngestionPolicyV1,
  normalizeEarningsMetricExtractionPolicyV1,
  normalizeEarningsMetricObservationCoreV1,
  normalizeEarningsMetricExtractionReportV1,
  normalizeEarningsRevisionCoreV1,
  normalizeEarningsRevisionIdentityCoreV1,
  normalizeEarningsRevisionSetManifestV1,
  normalizeFinancialPeriodIdentityCoreV1,
  normalizeSecDocumentBytesCoreV1,
  normalizeSecFilingSourceDocumentCoreV1,
  normalizeXbrlCanonicalUnitCoreV1,
  xbrlCanonicalUnitIdFor,
} from '../../src/contracts/earningsContractsL4CIV1.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS } from '../../src/canonical/canonicalSchemaRegistryV1.mjs';
import { NORMALIZED_NAMESPACE_SCHEMA_VERSIONS } from '../../src/storage/contentAddressedStoreV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../../src/data/transformImplementationManifestV2.mjs';
import {
  assertNoDerivedFinancialPeriodV1,
  buildFinancialPeriodIdentityCore,
} from '../../src/earnings/earningsFinancialPeriodL4CIV1.mjs';
import {
  admitSecFilingForEarningsV1,
  assertEarningsEventTypeV1,
  buildSecFilingSourceDocument,
  earningsEventTypeForFormV1,
} from '../../src/earnings/earningsSecFilingSourceDocumentL4CIV1.mjs';
import {
  buildXbrlCanonicalUnitCore,
  canonicalizeXbrlUnitMeasuresV1,
} from '../../src/earnings/earningsXbrlUnitL4CIV1.mjs';
import {
  buildEarningsExtractionSetManifest,
  verifyEarningsExtractionSetManifest,
} from '../../src/earnings/earningsExtractionSetL4CIV1.mjs';
import {
  buildEarningsDatasetSnapshotManifest,
  verifyEarningsDatasetSnapshotManifest,
} from '../../src/earnings/earningsDatasetSnapshotL4CIV1.mjs';
import { ingestEarningsDatasetL4CIV1 } from '../../src/earnings/earningsIngestionPipelineL4CIV1.mjs';
import { assertEarningsAccessionImmutabilityV1 } from '../../src/earnings/earningsAccessionImmutabilityL4CIV1.mjs';
import {
  buildEarningsMetricObservationCore,
  verifyEarningsMetricObservationCore,
} from '../../src/earnings/earningsMetricObservationL4CIV1.mjs';
import { earningsRevisionSetTipV1 } from '../../src/earnings/earningsRevisionSetL4CIV1.mjs';
import {
  EARNINGS_TRAVERSAL_EDGE_COUNT_V1,
  EARNINGS_TRAVERSAL_EDGES_V1,
  rejectEarningsCasGlobalScanV1,
  verifyEarningsSnapshotTraversalV1,
} from '../../src/earnings/earningsTraversalVerifyL4CIV1.mjs';
import {
  putEarningsSecDocumentBytes,
  verifyEarningsSecDocumentBytes,
} from '../../src/earnings/earningsSecDocumentBytesL4CIV1.mjs';
import {
  withEmptyEarningsL4CI1Fixture,
  withOfficialEarningsL4CI1Fixture,
  pinEarningsTransformImplementationManifestV2,
  pinSyntheticEarningsFiling,
  pinSyntheticTaxonomyBundle,
  synthetic8KFiling,
  withStore,
} from '../earningsIngestionL4CISyntheticFixture.mjs';
import {
  oracleDatasetIdentityKeyV1,
  oracleFunctionalSnapshotFingerprintV1,
  oracleGroupedMetricObservationDigestV1,
  oracleOrderedMetricObservationIdentityDigestV1,
} from './independentEarningsIngestionOracleL4CIV1.mjs';
import { EARNINGS_INTENT_ASSERTIONS } from './earningsIntentAssertionsL4CIV1.mjs';

export const casId = (n) => `sha256:${n.toString(16).padStart(64, '0')}`;
export const errorHasCode = (expected) => (error) => error?.code === expected;

export function assertThrowsCode(expected, callback) {
  assert.throws(callback, errorHasCode(expected));
}

const ingestionPolicy = () => ({
  schemaVersion: EARNINGS_INGESTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(EARNINGS_INGESTION_POLICY_VALUES),
});

const extractionPolicy = () => ({
  schemaVersion: EARNINGS_METRIC_EXTRACTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(EARNINGS_METRIC_EXTRACTION_POLICY_VALUES),
});

const period = (type = 'DURATION') => ({
  schemaVersion: FINANCIAL_PERIOD_IDENTITY_CORE_SCHEMA_VERSION,
  periodType: type,
  periodStart: type === 'INSTANT' ? null : '2026-01-01',
  periodEnd: '2026-03-31',
});

const unit = (unitCode = 'USD') => ({
  schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
  unitCode,
});

const event = (accessionNumber = '1234567890-26-000001') => ({
  schemaVersion: EARNINGS_EVENT_IDENTITY_CORE_SCHEMA_VERSION,
  filerCik: '1234567890',
  accessionNumber,
});

const revision = () => ({
  schemaVersion: EARNINGS_REVISION_CORE_SCHEMA_VERSION,
  earningsRevisionIdentityId: casId(1),
  eventIdentityId: casId(2),
  publicAvailableAt: '2026-04-23T20:05:30.000Z',
  sourceFilingDocumentId: casId(3),
  revisionKind: 'INITIAL',
  parentRevisionIdentityId: null,
});

const revisionIdentity = () => ({
  schemaVersion: EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
  eventIdentityId: casId(2),
  publicAvailableAt: '2026-04-23T20:05:30.000Z',
  sourceFilingDocumentId: casId(3),
});

const observation = (metricCode = 'EPS_DILUTED') => ({
  schemaVersion: EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
  earningsRevisionIdentityId: casId(1),
  financialPeriodIdentityId: casId(2),
  xbrlCanonicalUnitId: casId(3),
  metricCode,
  atoms: metricCode === 'EPS_DILUTED' ? '125' : '125000000',
  scale: metricCode === 'EPS_DILUTED' ? 2 : 0,
  shareBasis: metricCode === 'EPS_DILUTED' ? 'DILUTED' : null,
  accountingBasis: metricCode === 'EPS_DILUTED' ? 'GAAP' : null,
});

const sourceDocument = () => ({
  schemaVersion: SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
  filerCik: '1234567890',
  accessionNumber: '1234567890-26-000001',
  formType: '8-K',
  items: ['2.02'],
  acceptanceDatetimeRaw: '20260423160530',
  publicAvailableAt: '2026-04-23T20:05:30.000Z',
  sourceAuthority: 'SEC_EDGAR',
  amendmentFlag: false,
  amendsFilingAccessionNumber: null,
  orderedDocuments: [{ secDocumentBytesId: casId(1),
    documentRole: 'PRIMARY_XBRL_INSTANCE' }],
});

const documentBytes = () => ({
  schemaVersion: SEC_DOCUMENT_BYTES_CORE_SCHEMA_VERSION,
  documentObjectId: casId(1),
  sha256: casId(1),
  byteLength: 1,
  mediaType: 'application/xml',
  documentFormat: 'XBRL_XML',
  documentRole: 'PRIMARY_XBRL_INSTANCE',
});

const report = () => ({
  schemaVersion: EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
  earningsRevisionIdentityId: casId(1),
  transformImplementationManifestId: casId(2),
  earningsMetricExtractionPolicyId: casId(3),
  earningsTaxonomyBundleManifestId: casId(4),
  orderedObservationIds: [],
  diagnosticCount: 0,
  orderedDiagnosticDigest: earningsOrderedDiagnosticDigestV1([]),
});

const eventSet = () => ({
  schemaVersion: EARNINGS_EVENT_SET_MANIFEST_SCHEMA_VERSION,
  orderedEventEntries: [],
  eventCount: 0,
  orderedEventIdentityDigest: earningsOrderedEventIdentityDigestV1([]),
});

const emptyExtractionSet = () => ({
  schemaVersion: EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
  earningsRevisionSetManifestId: casId(1),
  transformImplementationManifestId: casId(2),
  earningsMetricExtractionPolicyId: casId(3),
  earningsTaxonomyBundleManifestId: casId(4),
  orderedRevisionExtractionEntries: [],
  extractionReportCount: 0,
  metricObservationCount: 0,
  orderedExtractionReportDigest: earningsOrderedExtractionReportDigestV1([]),
  orderedMetricObservationDigest: earningsGroupedMetricObservationDigestV1([]),
});

const emptyRevisionSet = () => ({
  schemaVersion: EARNINGS_REVISION_SET_MANIFEST_SCHEMA_VERSION,
  orderedEventChains: [],
  revisionCount: 0,
  orderedRevisionIdentityDigest: earningsOrderedRevisionIdentityDigestV1([]),
});

const functionalSample = () => ({
  datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
  earningsIngestionPolicyId: casId(1),
  earningsMetricExtractionPolicyId: casId(2),
  earningsEventSetManifestId: casId(3),
  earningsRevisionSetManifestId: casId(4),
  earningsExtractionSetManifestId: casId(5),
  transformImplementationManifestId: casId(6),
  earningsTaxonomyBundleManifestId: casId(7),
  jurisdictionCode: 'US',
  currencyCode: 'USD',
  eventCount: 0,
  revisionCount: 0,
  extractionReportCount: 0,
  metricObservationCount: 0,
  firstPublicAvailableAt: null,
  lastPublicAvailableAt: null,
  emptySnapshot: true,
  orderedEventIdentityDigest: casId(8),
  orderedRevisionIdentityDigest: casId(9),
  orderedExtractionReportDigest: casId(10),
  orderedMetricObservationDigest: casId(11),
  orderedMetricObservationIdentityDigest: casId(12),
});

function mutateExtractionSet(base, changes) {
  const next = { ...structuredClone(base), ...changes };
  if (changes.orderedRevisionExtractionEntries) {
    next.extractionReportCount = next.orderedRevisionExtractionEntries.length;
    next.metricObservationCount = next.orderedRevisionExtractionEntries.reduce(
      (sum, entry) => sum + entry.orderedMetricObservationIds.length, 0);
    next.orderedExtractionReportDigest = earningsOrderedExtractionReportDigestV1(
      next.orderedRevisionExtractionEntries.map((entry) => entry.earningsMetricExtractionReportId));
    next.orderedMetricObservationDigest =
      earningsGroupedMetricObservationDigestV1(next.orderedRevisionExtractionEntries);
  }
  return next;
}

function malformedStoredExtraction(store, value) {
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
    value,
  }).objectId;
}

function readCanonical(store, objectId, schemaVersion) {
  return store.readCanonicalObject({
    uri: store.uriForObject({ namespace: 'snapshots', objectId }),
    expectedObjectId: objectId,
    schemaVersion,
  }).value;
}

function overlayStore(store, valuesById) {
  const wrapped = {};
  for (const key of Object.keys(store)) {
    wrapped[key] = typeof store[key] === 'function' ? store[key].bind(store) : store[key];
  }
  wrapped.readCanonicalObject = (input) => {
    if (valuesById.has(input.expectedObjectId)) {
      return {
        objectId: input.expectedObjectId,
        uri: input.uri,
        sizeBytes: 1,
        bytes: Buffer.from('{}'),
        value: structuredClone(valuesById.get(input.expectedObjectId)),
      };
    }
    return store.readCanonicalObject(input);
  };
  wrapped.readObject = (input) => {
    if (valuesById.has(input.expectedObjectId)) {
      const bytes = canonicalJsonBytes(valuesById.get(input.expectedObjectId));
      return {
        objectId: input.expectedObjectId,
        uri: input.uri,
        sizeBytes: bytes.length,
        bytes,
      };
    }
    return store.readObject(input);
  };
  return Object.freeze(wrapped);
}

function snapshotBuildInput(pipeline, store, previousSnapshotId) {
  const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
  return {
    store,
    earningsIngestionPolicyId: pipeline.ingestionPolicy.earningsIngestionPolicyId,
    earningsMetricExtractionPolicyId: pipeline.extractionPolicy.earningsMetricExtractionPolicyId,
    earningsEventSetManifestId: pipeline.eventSet.earningsEventSetManifestId,
    earningsRevisionSetManifestId: pipeline.revisionSet.earningsRevisionSetManifestId,
    earningsExtractionSetManifestId: pipeline.extractionSet.earningsExtractionSetManifestId,
    transformImplementationManifestId: snapshot.transformImplementationManifestId,
    earningsTaxonomyBundleManifestId: snapshot.earningsTaxonomyBundleManifestId,
    previousSnapshotId,
  };
}

function snapshotForExtraction(store, pipeline, extractionSetId, extractionSet) {
  const snapshot = structuredClone(pipeline.snapshot.earningsDatasetSnapshotManifest);
  snapshot.earningsExtractionSetManifestId = extractionSetId;
  snapshot.extractionReportCount = extractionSet.extractionReportCount;
  snapshot.metricObservationCount = extractionSet.metricObservationCount;
  snapshot.orderedExtractionReportDigest = extractionSet.orderedExtractionReportDigest;
  snapshot.orderedMetricObservationDigest = extractionSet.orderedMetricObservationDigest;
  snapshot.orderedMetricObservationIdentityDigest =
    earningsOrderedMetricObservationIdentityDigestV1(
      extractionSet.orderedRevisionExtractionEntries
        .flatMap((entry) => entry.orderedMetricObservationIds));
  return store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
    value: snapshot,
  }).objectId;
}

function assertClosureUnexpectedId() {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const base = pipeline.extractionSet.earningsExtractionSetManifest;
    const entries = structuredClone(base.orderedRevisionExtractionEntries);
    entries[0].earningsRevisionIdentityId = casId(61);
    const malformed = mutateExtractionSet(base, { orderedRevisionExtractionEntries: entries });
    const extractionSetId = malformedStoredExtraction(store, malformed);
    const snapshotId = snapshotForExtraction(store, pipeline, extractionSetId, malformed);
    verifyEarningsSnapshotTraversalV1({
      store, earningsDatasetSnapshotManifestId: snapshotId,
    });
  });
}

function assertSnapshotTechnicalMismatch(code, intent) {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const base = pipeline.extractionSet.earningsExtractionSetManifest;
    const malformed = structuredClone(base);
    if (code === 'EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH'
        && /Report/.test(intent)) {
      const entry = malformed.orderedRevisionExtractionEntries[0];
      const report = readCanonical(store, entry.earningsMetricExtractionReportId,
        EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION);
      report.transformImplementationManifestId = casId(91);
      entry.earningsMetricExtractionReportId = store.putCanonicalObject({
        namespace: 'snapshots',
        schemaVersion: EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
        value: report,
      }).objectId;
    } else if (code === 'EARNINGS_REVISION_SET_ID_MISMATCH') {
      return buildEarningsDatasetSnapshotManifest({
        ...snapshotBuildInput(pipeline, store, null),
        earningsRevisionSetManifestId: casId(92),
      });
    } else if (code === 'EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH') {
      malformed.transformImplementationManifestId = casId(93);
    } else if (code === 'EARNINGS_EXTRACTION_POLICY_ID_MISMATCH') {
      malformed.earningsMetricExtractionPolicyId = casId(94);
    } else if (code === 'EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH') {
      malformed.earningsTaxonomyBundleManifestId = casId(95);
    }
    const normalized = mutateExtractionSet(malformed, {
      orderedRevisionExtractionEntries: malformed.orderedRevisionExtractionEntries,
    });
    const extractionSetId = malformedStoredExtraction(store, normalized);
    return buildEarningsDatasetSnapshotManifest({
      ...snapshotBuildInput(pipeline, store, null),
      earningsExtractionSetManifestId: extractionSetId,
    });
  });
}

function assertForeignSnapshotParent(intent) {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const fakeParentId = casId(96);
    const parent = structuredClone(pipeline.snapshot.earningsDatasetSnapshotManifest);
    if (/series/.test(intent)) parent.datasetSeriesIdentity = 'OTHER';
    else if (/jur/.test(intent)) parent.jurisdictionCode = 'CA';
    else if (/cur/.test(intent)) parent.currencyCode = 'CAD';
    else {
      const fakePolicyId = casId(97);
      parent.earningsIngestionPolicyId = fakePolicyId;
      const policy = { ...ingestionPolicy(), allowedSourceAuthority: 'OTHER' };
      const wrapped = overlayStore(store, new Map([
        [fakeParentId, parent],
        [fakePolicyId, policy],
      ]));
      return buildEarningsDatasetSnapshotManifest(
        snapshotBuildInput(pipeline, wrapped, fakeParentId));
    }
    const wrapped = overlayStore(store, new Map([[fakeParentId, parent]]));
    return buildEarningsDatasetSnapshotManifest(snapshotBuildInput(pipeline, wrapped, fakeParentId));
  });
}

function assertSnapshotCycle(intent) {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const a = casId(98);
    const b = casId(99);
    const snapshotA = structuredClone(pipeline.snapshot.earningsDatasetSnapshotManifest);
    snapshotA.supersedesEarningsDatasetSnapshotManifestId = /2-cycle/.test(intent) ? b : a;
    const values = new Map([[a, snapshotA]]);
    if (/2-cycle/.test(intent)) {
      const snapshotB = structuredClone(pipeline.snapshot.earningsDatasetSnapshotManifest);
      snapshotB.supersedesEarningsDatasetSnapshotManifestId = a;
      values.set(b, snapshotB);
    }
    verifyEarningsDatasetSnapshotManifest({
      store: overlayStore(store, values),
      earningsDatasetSnapshotManifestId: a,
    });
  });
}

function assertOpaqueStructuredDocumentRejected() {
  return withStore((store) => {
    const document = putEarningsSecDocumentBytes({
      store,
      bytes: Buffer.from('<html>opaque exhibit</html>'),
      mediaType: 'application/xhtml+xml',
      documentFormat: 'IXBRL',
      documentRole: 'EXHIBIT_OTHER',
    });
    const filing = buildSecFilingSourceDocument({
      store,
      filerCik: '1234567890',
      accessionNumber: '1234567890-26-000099',
      formType: '8-K',
      items: ['2.02'],
      acceptanceDatetimeRaw: '20260423160530',
      amendmentFlag: false,
      amendsFilingAccessionNumber: null,
      orderedDocuments: [{
        secDocumentBytesId: document.secDocumentBytesId,
        documentRole: 'EXHIBIT_OTHER',
      }],
    });
    admitSecFilingForEarningsV1({
      store, sourceFilingDocumentId: filing.sourceFilingDocumentId,
    });
  });
}

function assertItem202Rejected() {
  return withStore((store) => {
    const document = putEarningsSecDocumentBytes({
      store,
      bytes: Buffer.from('<xbrl/>'),
      mediaType: 'application/xml',
      documentFormat: 'XBRL_XML',
      documentRole: 'PRIMARY_XBRL_INSTANCE',
    });
    const filing = buildSecFilingSourceDocument({
      store,
      filerCik: '1234567890',
      accessionNumber: '1234567890-26-000098',
      formType: '8-K',
      items: [],
      acceptanceDatetimeRaw: '20260423160530',
      amendmentFlag: false,
      amendsFilingAccessionNumber: null,
      orderedDocuments: [{
        secDocumentBytesId: document.secDocumentBytesId,
        documentRole: 'PRIMARY_XBRL_INSTANCE',
      }],
    });
    admitSecFilingForEarningsV1({
      store, sourceFilingDocumentId: filing.sourceFilingDocumentId,
    });
  });
}

function assertRawBytesCorruptionRejected() {
  return withStore((store, root) => {
    const document = putEarningsSecDocumentBytes({
      store,
      bytes: Buffer.from('<xbrl/>'),
      mediaType: 'application/xml',
      documentFormat: 'XBRL_XML',
      documentRole: 'PRIMARY_XBRL_INSTANCE',
    });
    const uri = store.uriForObject({
      namespace: 'source', objectId: document.documentObjectId,
    });
    writeFileSync(join(root, ...uri.split('/')), Buffer.from('<xbrl>tampered</xbrl>'));
    verifyEarningsSecDocumentBytes({
      store, secDocumentBytesId: document.secDocumentBytesId,
    });
  });
}

function assertMetricUnitRejected(intent) {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const revisionId = pipeline.items[0].revision.earningsRevisionIdentityId;
    const periodCore = buildFinancialPeriodIdentityCore({
      store, periodType: 'DURATION', periodStart: '2026-01-01', periodEnd: '2026-03-31',
    });
    const eps = /EPS/.test(intent);
    const wrongUnit = buildXbrlCanonicalUnitCore({
      store, unitCode: eps ? 'USD' : 'USD_PER_SHARE',
    });
    return buildEarningsMetricObservationCore({
      store,
      earningsRevisionIdentityId: revisionId,
      financialPeriodIdentityId: periodCore.financialPeriodIdentityId,
      xbrlCanonicalUnitId: wrongUnit.xbrlCanonicalUnitId,
      metricCode: eps ? 'EPS_DILUTED' : 'REVENUE_CONSOLIDATED',
      atoms: '1',
      scale: 0,
      shareBasis: eps ? 'DILUTED' : null,
      accountingBasis: eps ? 'GAAP' : null,
    });
  });
}

function assertExtractionSemanticError(code) {
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const base = pipeline.extractionSet.earningsExtractionSetManifest;
    const entries = structuredClone(base.orderedRevisionExtractionEntries);
    let malformed;
    if (code === 'EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION') {
      entries[0].earningsRevisionIdentityId = casId(61);
      malformed = mutateExtractionSet(base, { orderedRevisionExtractionEntries: entries });
    } else if (code === 'EARNINGS_EXTRACTION_ENTRY_ORDER_INVALID') {
      malformed = mutateExtractionSet(base, {
        orderedRevisionExtractionEntries: [entries[1], entries[0], ...entries.slice(2)],
      });
    } else if (code === 'EARNINGS_EXTRACTION_REPORT_MISSING') {
      entries[0].earningsMetricExtractionReportId = casId(62);
      malformed = mutateExtractionSet(base, { orderedRevisionExtractionEntries: entries });
    } else if (code === 'EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH') {
      entries[0].orderedMetricObservationIds = [];
      malformed = mutateExtractionSet(base, { orderedRevisionExtractionEntries: entries });
    } else {
      throw new Error(`unsupported extraction semantic error ${code}`);
    }
    const id = malformedStoredExtraction(store, malformed);
    verifyEarningsExtractionSetManifest({ store, earningsExtractionSetManifestId: id });
  });
}

function exerciseExactRejection(code, intent) {
  switch (code) {
    case 'CANONICAL_UNKNOWN_FIELD': {
      const extra = { forbiddenField: true };
      if (/Symbol/.test(intent)) {
        const value = unit();
        value[Symbol('wire')] = true;
        return normalizeXbrlCanonicalUnitCoreV1(value);
      }
      if (/IngestionPolicy/.test(intent)) {
        return normalizeEarningsIngestionPolicyV1({ ...ingestionPolicy(), ...extra });
      }
      if (/ExtractionPolicy/.test(intent)) {
        return normalizeEarningsMetricExtractionPolicyV1({ ...extractionPolicy(), ...extra });
      }
      if (/SecFiling|EventSet/.test(intent)) {
        return /EventSet/.test(intent)
          ? normalizeEarningsEventSetManifestV1({ ...eventSet(), ...extra })
          : normalizeSecFilingSourceDocumentCoreV1({ ...sourceDocument(), ...extra });
      }
      if (/SecDocumentBytes|bytes core|path field|mtime|machine/.test(intent)) {
        return normalizeSecDocumentBytesCoreV1({ ...documentBytes(), ...extra });
      }
      if (/FinancialPeriod|period/.test(intent)) {
        return normalizeFinancialPeriodIdentityCoreV1({ ...period(), ...extra });
      }
      if (/EventIdentity/.test(intent)) {
        return normalizeEarningsEventIdentityCoreV1({ ...event(), ...extra });
      }
      if (/RevisionSet/.test(intent)) {
        return normalizeEarningsRevisionSetManifestV1({ ...emptyRevisionSet(), ...extra });
      }
      if (/RevisionIdentity/.test(intent)) {
        return normalizeEarningsRevisionIdentityCoreV1({ ...revisionIdentity(), ...extra });
      }
      if (/RevisionCore/.test(intent)) {
        return normalizeEarningsRevisionCoreV1({ ...revision(), ...extra });
      }
      if (/Observation|sourceItemCode/.test(intent)) {
        return normalizeEarningsMetricObservationCoreV1({ ...observation(), ...extra });
      }
      if (/Report/.test(intent)) {
        return normalizeEarningsMetricExtractionReportV1({ ...report(), ...extra });
      }
      if (/Snapshot/.test(intent)) {
        return normalizeEarningsDatasetSnapshotManifestV1({
          ...functionalSample(),
          schemaVersion: EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
          supersedesEarningsDatasetSnapshotManifestId: null,
          ...extra,
        });
      }
      if (/ExtractionSet/.test(intent)) {
        return normalizeEarningsExtractionSetManifestV1({ ...emptyExtractionSet(), ...extra });
      }
      return normalizeXbrlCanonicalUnitCoreV1({ ...unit(), ...extra });
    }
    case 'EARNINGS_PERIOD_TYPE_INVALID':
      return normalizeFinancialPeriodIdentityCoreV1({ ...period(), periodType: 'QUARTER' });
    case 'EARNINGS_DERIVED_PERIOD_FORBIDDEN':
      return assertNoDerivedFinancialPeriodV1({ derived: true, derivation: 'annual-minus-nine-months' });
    case 'EARNINGS_DATASET_SERIES_IDENTITY_INVALID':
      return normalizeEarningsIngestionPolicyV1({ ...ingestionPolicy(), datasetSeriesIdentity: 'OTHER' });
    case 'EARNINGS_POLICY_INVALID': {
      const value = ingestionPolicy();
      delete value.periodSelectionPolicy;
      return normalizeEarningsIngestionPolicyV1(value);
    }
    case 'EARNINGS_UNIT_INVALID':
      return normalizeXbrlCanonicalUnitCoreV1(new Date());
    case 'EARNINGS_ACCESSION_INVALID':
      return normalizeSecFilingSourceDocumentCoreV1({
        ...sourceDocument(), accessionNumber: 'bad-accession',
      });
    case 'EARNINGS_CIK_INVALID':
      return normalizeSecFilingSourceDocumentCoreV1({
        ...sourceDocument(), filerCik: '1',
      });
    case 'EARNINGS_ACCEPTANCE_DATETIME_INVALID':
      return normalizeSecFilingSourceDocumentCoreV1({
        ...sourceDocument(), acceptanceDatetimeRaw: 'not-a-time',
      });
    case 'EARNINGS_ACCESSION_IMMUTABILITY_CONFLICT':
      return assertEarningsAccessionImmutabilityV1([
        { filerCik: '1234567890', accessionNumber: '1234567890-26-000001',
          sourceFilingDocumentId: casId(1) },
        { filerCik: '1234567890', accessionNumber: '1234567890-26-000001',
          sourceFilingDocumentId: casId(2) },
      ]);
    case 'EARNINGS_SOURCE_DOCUMENT_INVALID': {
      const value = sourceDocument();
      delete value.orderedDocuments;
      return normalizeSecFilingSourceDocumentCoreV1(value);
    }
    case 'EARNINGS_DOCUMENT_BYTES_INVALID': {
      const value = documentBytes();
      delete value.documentObjectId;
      return normalizeSecDocumentBytesCoreV1(value);
    }
    case 'EARNINGS_MEDIA_TYPE_INVALID':
      return normalizeSecDocumentBytesCoreV1({ ...documentBytes(), mediaType: 'text/html' });
    case 'EARNINGS_DOCUMENT_FORMAT_INVALID':
      return normalizeSecDocumentBytesCoreV1({ ...documentBytes(), documentFormat: 'PDF' });
    case 'EARNINGS_DOCUMENT_ROLE_INVALID':
      return normalizeSecDocumentBytesCoreV1({ ...documentBytes(), documentRole: 'OTHER' });
    case 'EARNINGS_SOURCE_BYTES_INVALID':
      return withStore((store) => putEarningsSecDocumentBytes({
        store, bytes: Buffer.alloc(0), mediaType: 'application/xml',
        documentFormat: 'XBRL_XML', documentRole: 'PRIMARY_XBRL_INSTANCE',
      }));
    case 'EARNINGS_SOURCE_BYTES_MISMATCH':
      return assertRawBytesCorruptionRejected();
    case 'EARNINGS_SOURCE_BYTES_MISSING':
      return normalizeSecDocumentBytesCoreV1({
        ...documentBytes(), documentObjectId: 'SHA256:BAD',
      });
    case 'EARNINGS_PERIOD_INVALID':
      return normalizeFinancialPeriodIdentityCoreV1({
        ...period('DURATION'), periodStart: '2026-04-01',
      });
    case 'EARNINGS_REPORT_INVALID': {
      const value = report();
      delete value.earningsRevisionIdentityId;
      return normalizeEarningsMetricExtractionReportV1(value);
    }
    case 'EARNINGS_EVENT_SET_COUNT_MISMATCH':
      return normalizeEarningsEventSetManifestV1({ ...eventSet(), eventCount: 1 });
    case 'EARNINGS_EVENT_SET_DIGEST_MISMATCH':
      return normalizeEarningsEventSetManifestV1({
        ...eventSet(), orderedEventIdentityDigest: casId(78),
      });
    case 'EARNINGS_REVISION_SET_DIGEST_MISMATCH':
      return normalizeEarningsRevisionSetManifestV1({
        ...emptyRevisionSet(), orderedRevisionIdentityDigest: casId(77),
      });
    case 'EARNINGS_SNAPSHOT_INVALID': {
      const value = { ...functionalSample(),
        schemaVersion: EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
        supersedesEarningsDatasetSnapshotManifestId: null };
      delete value.earningsExtractionSetManifestId;
      return normalizeEarningsDatasetSnapshotManifestV1(value);
    }
    case 'EARNINGS_EXTRACTION_SET_INVALID': {
      const value = emptyExtractionSet();
      delete value.earningsRevisionSetManifestId;
      return normalizeEarningsExtractionSetManifestV1(value);
    }
    case 'EARNINGS_REVISION_KIND_FORBIDDEN_V1':
      return normalizeEarningsRevisionCoreV1({ ...revision(),
        revisionKind: 'REPUBLISHED_SOURCE_DOCUMENT' });
    case 'EARNINGS_REVISION_PARENT_FORBIDDEN_V1':
      return normalizeEarningsRevisionCoreV1({ ...revision(), parentRevisionIdentityId: casId(4) });
    case 'EARNINGS_EVENT_TYPE_INVALID':
      return assertEarningsEventTypeV1('EARNINGS_AMENDMENT');
    case 'EARNINGS_REVISION_COUNT_PER_EVENT_INVALID': {
      const value = emptyRevisionSet();
      value.orderedEventChains = [{
        eventIdentityId: casId(1),
        orderedRevisions: [],
      }];
      value.revisionCount = 1;
      return normalizeEarningsRevisionSetManifestV1(value);
    }
    case 'EARNINGS_EXTRACTION_ENTRY_MISSING':
      return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) =>
        buildEarningsExtractionSetManifest({
          store,
          earningsRevisionSetManifestId: pipeline.revisionSet.earningsRevisionSetManifestId,
          transformImplementationManifestId: pipeline.snapshot.earningsDatasetSnapshotManifest
            .transformImplementationManifestId,
          earningsMetricExtractionPolicyId: pipeline.extractionPolicy.earningsMetricExtractionPolicyId,
          earningsTaxonomyBundleManifestId: pipeline.snapshot.earningsDatasetSnapshotManifest
            .earningsTaxonomyBundleManifestId,
          earningsMetricExtractionReportIds: [],
        }));
    case 'EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION':
    case 'EARNINGS_EXTRACTION_ENTRY_ORDER_INVALID':
    case 'EARNINGS_EXTRACTION_REPORT_MISSING':
    case 'EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH':
      return assertExtractionSemanticError(code);
    case 'EARNINGS_EXTRACTION_ENTRY_DUPLICATE': {
      const entry = { earningsRevisionIdentityId: casId(1),
        earningsMetricExtractionReportId: casId(2), orderedMetricObservationIds: [] };
      const entries = [entry, structuredClone(entry)];
      return normalizeEarningsExtractionSetManifestV1(mutateExtractionSet(emptyExtractionSet(),
        { orderedRevisionExtractionEntries: entries }));
    }
    case 'EARNINGS_METRIC_ORPHAN':
      return withStore((store) => verifyEarningsMetricObservationCore({
        store, earningsMetricObservationId: casId(70),
      }));
    case 'EARNINGS_EXTRACTION_OBSERVATION_DUPLICATE': {
      const entry = { earningsRevisionIdentityId: casId(1),
        earningsMetricExtractionReportId: casId(2),
        orderedMetricObservationIds: [casId(3), casId(3)] };
      return normalizeEarningsExtractionSetManifestV1(mutateExtractionSet(emptyExtractionSet(),
        { orderedRevisionExtractionEntries: [entry] }));
    }
    case 'EARNINGS_EXTRACTION_OBSERVATION_ORDER_INVALID': {
      const entry = { earningsRevisionIdentityId: casId(1),
        earningsMetricExtractionReportId: casId(2),
        orderedMetricObservationIds: [casId(4), casId(3)] };
      return normalizeEarningsExtractionSetManifestV1(mutateExtractionSet(emptyExtractionSet(),
        { orderedRevisionExtractionEntries: [entry] }));
    }
    case 'EARNINGS_EXTRACTION_SET_COUNT_MISMATCH':
      return normalizeEarningsExtractionSetManifestV1({
        ...emptyExtractionSet(), extractionReportCount: 1,
      });
    case 'EARNINGS_EXTRACTION_SET_DIGEST_MISMATCH':
      return normalizeEarningsExtractionSetManifestV1({
        ...emptyExtractionSet(), orderedExtractionReportDigest: casId(99),
      });
    case 'EARNINGS_CLOSURE_REFERENCE_MISSING':
      return withStore((store) => verifyEarningsSnapshotTraversalV1({
        store, earningsDatasetSnapshotManifestId: casId(80),
      }));
    case 'EARNINGS_CLOSURE_UNEXPECTED_ID':
      return assertClosureUnexpectedId();
    case 'EARNINGS_CAS_GLOBAL_SCAN_FORBIDDEN':
      return rejectEarningsCasGlobalScanV1();
    case 'EARNINGS_SNAPSHOT_PARENT_MISSING':
      return withEmptyEarningsL4CI1Fixture(({ store, pipeline }) =>
        buildEarningsDatasetSnapshotManifest(snapshotBuildInput(pipeline, store, casId(81))));
    case 'EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET':
      return assertForeignSnapshotParent(intent);
    case 'EARNINGS_SNAPSHOT_SUPERSESSION_CYCLE':
      return assertSnapshotCycle(intent);
    case 'EARNINGS_DATASET_SERIES_IDENTITY_MISMATCH':
      return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
        const id = casId(82);
        const snapshot = structuredClone(pipeline.snapshot.earningsDatasetSnapshotManifest);
        snapshot.datasetSeriesIdentity = 'OTHER';
        return verifyEarningsDatasetSnapshotManifest({
          store: overlayStore(store, new Map([[id, snapshot]])),
          earningsDatasetSnapshotManifestId: id,
        });
      });
    case 'EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH':
    case 'EARNINGS_EXTRACTION_POLICY_ID_MISMATCH':
    case 'EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH':
    case 'EARNINGS_REVISION_SET_ID_MISMATCH':
      return assertSnapshotTechnicalMismatch(code, intent);
    case 'EARNINGS_STRUCTURED_DOCUMENT_ABSENT':
      return assertOpaqueStructuredDocumentRejected();
    case 'EARNINGS_FIXED_POINT_INVALID':
      return normalizeEarningsMetricObservationCoreV1({
        ...observation(), atoms: /NaN/.test(intent) ? 'NaN' : '-0',
      });
    case 'EARNINGS_FIXED_POINT_SCALE_INVALID':
      return normalizeEarningsMetricObservationCoreV1({ ...observation(), atoms: '1250', scale: 2 });
    case 'EARNINGS_UNIT_REJECTED':
      if (/requires/.test(intent)) return assertMetricUnitRejected(intent);
      return normalizeXbrlCanonicalUnitCoreV1({ ...unit(), unitCode: 'SHARES' });
    case 'EARNINGS_EPS_SEMANTIC_INVALID':
      return normalizeEarningsMetricObservationCoreV1({ ...observation(), shareBasis: 'BASIC' });
    case 'EARNINGS_METRIC_CODE_INVALID':
      return normalizeEarningsMetricObservationCoreV1({ ...observation(), metricCode: 'EPS_BASIC' });
    case 'EARNINGS_POLICY_LATEST_FORBIDDEN':
      return normalizeEarningsIngestionPolicyV1({ ...ingestionPolicy(), latestReferencePolicy: 'LATEST' });
    case 'EARNINGS_POLICY_NETWORK_FORBIDDEN':
      return normalizeEarningsIngestionPolicyV1({
        ...ingestionPolicy(), networkDuringComputationPolicy: 'ALLOWED',
      });
    case 'EARNINGS_JURISDICTION_REJECTED':
      return normalizeEarningsIngestionPolicyV1({ ...ingestionPolicy(), jurisdictionCode: 'CA' });
    case 'EARNINGS_CURRENCY_REJECTED_V1':
      return normalizeEarningsIngestionPolicyV1({ ...ingestionPolicy(), currencyCode: 'CAD' });
    case 'EARNINGS_SOURCE_AUTHORITY_REJECTED':
      return normalizeEarningsIngestionPolicyV1({
        ...ingestionPolicy(), allowedSourceAuthority: 'OTHER',
      });
    case 'EARNINGS_ITEM_2_02_ABSENT':
      return assertItem202Rejected();
    case 'EARNINGS_FACT_NIL_REJECTED':
      return normalizeEarningsMetricExtractionPolicyV1({
        ...extractionPolicy(), nilFactPolicy: 'ALLOW',
      });
    case 'EARNINGS_CONTEXT_DIMENSION_REJECTED':
      return normalizeEarningsMetricExtractionPolicyV1({
        ...extractionPolicy(), dimensionPolicy: 'ALLOW',
      });
    case 'EARNINGS_EXTENSION_TAG_REJECTED':
      return normalizeEarningsMetricExtractionPolicyV1({
        ...extractionPolicy(), extensionTagPolicy: 'ALLOW',
      });
    case 'EARNINGS_EPS_TAG_REJECTED':
      return normalizeEarningsMetricExtractionPolicyV1({
        ...extractionPolicy(), epsTagPriority: ['us-gaap:EarningsPerShareBasic'],
      });
    case 'EARNINGS_FORM_REJECTED_V1':
      return /form 20-F|form 40-F/.test(intent)
        ? normalizeSecFilingSourceDocumentCoreV1({
          ...sourceDocument(), formType: /40-F/.test(intent) ? '40-F' : '20-F',
        })
        : normalizeEarningsIngestionPolicyV1({
          ...ingestionPolicy(), allowedFormTypes: ['20-F'],
        });
    default:
      throw new Error(`no production rejection fixture for ${code}: ${intent}`);
  }
}

function assertContractIntent(intent) {
  if (/registry SNAPSHOT/.test(intent)) return assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
  if (/registry NORMALIZED/.test(intent)) return assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
  if (/schemaVersion list/.test(intent)) return assert.equal(new Set(EARNINGS_L4C_I1_SCHEMA_VERSIONS).size, 16);
  if (/ExtractionSet/.test(intent)) {
    const value = normalizeEarningsExtractionSetManifestV1(emptyExtractionSet());
    return assert.equal(value.orderedRevisionExtractionEntries.length, 0);
  }
  if (/Snapshot/.test(intent)) {
    const value = normalizeEarningsDatasetSnapshotManifestV1({
      ...functionalSample(),
      schemaVersion: EARNINGS_DATASET_SNAPSHOT_MANIFEST_SCHEMA_VERSION,
      supersedesEarningsDatasetSnapshotManifestId: null,
    });
    return assert.equal(value.datasetSeriesIdentity, EARNINGS_DATASET_SERIES_IDENTITY);
  }
  if (/Period|INSTANT|DURATION/.test(intent)) {
    const instant = normalizeFinancialPeriodIdentityCoreV1(period('INSTANT'));
    const duration = normalizeFinancialPeriodIdentityCoreV1(period('DURATION'));
    return /distinct/.test(intent)
      ? assert.notEqual(financialPeriodIdentityIdFor(instant), financialPeriodIdentityIdFor(duration))
      : assert.ok(EARNINGS_PERIOD_TYPES.includes(/INSTANT/.test(intent) ? instant.periodType : duration.periodType));
  }
  if (/Unit|USD/.test(intent)) {
    const code = /PER_SHARE/.test(intent) ? 'USD_PER_SHARE' : 'USD';
    return assert.equal(normalizeXbrlCanonicalUnitCoreV1(unit(code)).unitCode, code);
  }
  if (/EventIdentity/.test(intent)) {
    return assert.match(earningsEventIdentityIdFor(normalizeEarningsEventIdentityCoreV1(event())),
      /^sha256:[0-9a-f]{64}$/);
  }
  if (/Observation|fixed-point|Revenue|EPS/.test(intent)) {
    const metric = /Revenue/.test(intent) ? 'REVENUE_CONSOLIDATED' : 'EPS_DILUTED';
    return assert.equal(normalizeEarningsMetricObservationCoreV1(observation(metric)).metricCode, metric);
  }
  const normalized = normalizeEarningsIngestionPolicyV1(ingestionPolicy());
  assert.equal(normalized.datasetSeriesIdentity, EARNINGS_DATASET_SERIES_IDENTITY);
}

function alternateTransformPipeline(store, transform, taxonomy, filings) {
  const manifest = buildTransformImplementationManifestV2({
    labRoot: transform.labRoot,
    logicalPaths: transform.transformImplementationManifest.modules
      .map((module) => module.logicalPath),
    runtimeContractVersion: 'NODE_L4C_I1_V1_ALTERNATE_PARSER',
  });
  const stored = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    value: manifest,
  });
  return ingestEarningsDatasetL4CIV1({
    store,
    sourceFilingDocumentIds: filings.map((item) => item.sourceFilingDocumentId),
    transformImplementationManifestId: stored.objectId,
    earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
    previousSnapshotId: null,
  });
}

function assertHistoricalIntent(id) {
  if (id === 'I1-H017') {
    return withEmptyEarningsL4CI1Fixture(({ pipeline }) => {
      const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
      assert.equal(snapshot.emptySnapshot, true);
      assert.equal(snapshot.eventCount, 0);
      assert.equal(pipeline.extractionSet.earningsExtractionSetManifest.extractionReportCount, 0);
    });
  }
  return withOfficialEarningsL4CI1Fixture(({ store, transform, taxonomy, filings, pipeline }) => {
    if (['I1-H008', 'I1-H009', 'I1-H010', 'I1-H011', 'I1-H012'].includes(id)) {
      const alternate = alternateTransformPipeline(store, transform, taxonomy, filings);
      if (id === 'I1-H008') {
        assert.equal(alternate.eventSet.earningsEventSetManifestId,
          pipeline.eventSet.earningsEventSetManifestId);
      } else if (id === 'I1-H009' || id === 'I1-H012') {
        assert.equal(alternate.revisionSet.earningsRevisionSetManifestId,
          pipeline.revisionSet.earningsRevisionSetManifestId);
      } else if (id === 'I1-H010') {
        assert.notEqual(alternate.extractionSet.earningsExtractionSetManifestId,
          pipeline.extractionSet.earningsExtractionSetManifestId);
      } else {
        assert.notEqual(alternate.snapshot.earningsDatasetSnapshotManifestId,
          pipeline.snapshot.earningsDatasetSnapshotManifestId);
      }
      return;
    }
    const snapshot = pipeline.snapshot.earningsDatasetSnapshotManifest;
    if (id === 'I1-H013' || id === 'I1-H014') {
      const field = id === 'I1-H013'
        ? 'earningsTaxonomyBundleManifestId' : 'earningsMetricExtractionPolicyId';
      const changed = { ...functionalSample(), [field]: casId(120) };
      assert.notEqual(earningsFunctionalSnapshotFingerprintV1(functionalSample()),
        earningsFunctionalSnapshotFingerprintV1(changed));
    } else if (id === 'I1-H015') {
      assert.equal(snapshot.eventCount, pipeline.eventSet.earningsEventSetManifest.eventCount);
      assert.equal(snapshot.extractionReportCount,
        pipeline.extractionSet.earningsExtractionSetManifest.extractionReportCount);
    } else if (id === 'I1-H016') {
      assert.equal(snapshot.orderedMetricObservationDigest,
        pipeline.extractionSet.earningsExtractionSetManifest.orderedMetricObservationDigest);
    } else {
      for (const field of ['earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
        'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
        'earningsExtractionSetManifestId', 'transformImplementationManifestId',
        'earningsTaxonomyBundleManifestId']) {
        assert.match(snapshot[field], /^sha256:[0-9a-f]{64}$/);
      }
    }
  });
}

function assertSnapshotIntent(id) {
  if (id === 'I1-H032') {
    const base = { datasetSeriesIdentity: 'SERIES_A', jurisdictionCode: 'US',
      currencyCode: 'USD', allowedSourceAuthority: 'SEC_EDGAR' };
    assert.notEqual(earningsDatasetIdentityKeyV1(base),
      earningsDatasetIdentityKeyV1({ ...base, datasetSeriesIdentity: 'SERIES_B' }));
    return;
  }
  if (['I1-H022', 'I1-H033', 'I1-H034', 'I1-H035', 'I1-H045'].includes(id)) {
    const fields = {
      'I1-H022': ['eventCount', 1],
      'I1-H033': ['transformImplementationManifestId', casId(101)],
      'I1-H034': ['earningsTaxonomyBundleManifestId', casId(102)],
      'I1-H035': ['earningsMetricExtractionPolicyId', casId(103)],
      'I1-H045': ['metricObservationCount', 1],
    };
    const [field, value] = fields[id];
    assert.notEqual(earningsFunctionalSnapshotFingerprintV1(functionalSample()),
      earningsFunctionalSnapshotFingerprintV1({ ...functionalSample(), [field]: value }));
    return;
  }
  if (['I1-H044', 'I1-H047', 'I1-H048', 'I1-H049', 'I1-H050', 'I1-H051'].includes(id)) {
    const sample = functionalSample();
    assert.equal(earningsFunctionalSnapshotFingerprintV1(sample),
      oracleFunctionalSnapshotFingerprintV1(sample));
    return;
  }
  if (id === 'I1-H046') {
    const left = { ...functionalSample(), supersedesEarningsDatasetSnapshotManifestId: null };
    const right = { ...left, supersedesEarningsDatasetSnapshotManifestId: casId(104) };
    assert.equal(earningsFunctionalSnapshotFingerprintV1(left),
      earningsFunctionalSnapshotFingerprintV1(right));
    return;
  }
  if (id === 'I1-H052') {
    assert.match(earningsFunctionalSnapshotFingerprintV1(functionalSample()),
      /^sha256:[0-9a-f]{64}$/);
    return;
  }
  return withOfficialEarningsL4CI1Fixture(
    ({ store, transform, taxonomy, filings, pipeline }) => {
      const first = pipeline.snapshot;
      if (id === 'I1-H019') {
        assert.equal(first.created, true);
        assert.equal(first.earningsDatasetSnapshotManifest
          .supersedesEarningsDatasetSnapshotManifestId, null);
        return;
      }
      if (id === 'I1-H043') {
        const snapshot = first.earningsDatasetSnapshotManifest;
        const extractionSet = pipeline.extractionSet.earningsExtractionSetManifest;
        assert.equal(snapshot.transformImplementationManifestId,
          extractionSet.transformImplementationManifestId);
        assert.equal(snapshot.earningsMetricExtractionPolicyId,
          extractionSet.earningsMetricExtractionPolicyId);
        assert.equal(snapshot.earningsTaxonomyBundleManifestId,
          extractionSet.earningsTaxonomyBundleManifestId);
        return;
      }
      if (id === 'I1-R016') {
        const changed = ingestEarningsDatasetL4CIV1({
          store,
          sourceFilingDocumentIds: filings.slice(0, 2)
            .map((item) => item.sourceFilingDocumentId),
          transformImplementationManifestId: transform.transformImplementationManifestId,
          earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
          previousSnapshotId: first.earningsDatasetSnapshotManifestId,
        });
        assert.equal(changed.snapshot.earningsDatasetSnapshotManifest
          .supersedesEarningsDatasetSnapshotManifestId,
        first.earningsDatasetSnapshotManifestId);
        assert.notEqual(changed.snapshot.earningsDatasetSnapshotManifestId,
          first.earningsDatasetSnapshotManifestId);
        return;
      }
      const repeated = buildEarningsDatasetSnapshotManifest(
        snapshotBuildInput(pipeline, store, first.earningsDatasetSnapshotManifestId));
      assert.equal(repeated.earningsDatasetSnapshotManifestId,
        first.earningsDatasetSnapshotManifestId);
      assert.equal(repeated.created, false);
    });
}

function assertIndependentStores(id) {
  if (id === 'I1-D014') {
    return withStore((storeA, rootA) => withStore((storeB, rootB) => {
      assert.notEqual(rootA, rootB);
      const input = { periodType: 'DURATION', periodStart: '2026-01-01',
        periodEnd: '2026-03-31' };
      assert.equal(buildFinancialPeriodIdentityCore({ store: storeA, ...input }).financialPeriodIdentityId,
        buildFinancialPeriodIdentityCore({ store: storeB, ...input }).financialPeriodIdentityId);
    }));
  }
  if (id === 'I1-U010') {
    return withStore((storeA, rootA) => withStore((storeB, rootB) => {
      assert.notEqual(rootA, rootB);
      assert.equal(buildXbrlCanonicalUnitCore({ store: storeA, unitCode: 'USD' }).xbrlCanonicalUnitId,
        buildXbrlCanonicalUnitCore({ store: storeB, unitCode: 'USD' }).xbrlCanonicalUnitId);
    }));
  }
  return withOfficialEarningsL4CI1Fixture((first) =>
    withOfficialEarningsL4CI1Fixture((second) => {
      assert.notEqual(first.root, second.root);
      if (id === 'I1-B020') {
        assert.equal(first.filings[0].secFilingSourceDocument
          .orderedDocuments[0].secDocumentBytesId,
        second.filings[0].secFilingSourceDocument.orderedDocuments[0].secDocumentBytesId);
      } else if (id === 'I1-C095') {
        assert.equal(first.pipeline.extractionSet.earningsExtractionSetManifest
          .orderedMetricObservationDigest,
        second.pipeline.extractionSet.earningsExtractionSetManifest
          .orderedMetricObservationDigest);
      } else if (id === 'I1-C088') {
        assert.equal(first.pipeline.extractionSet.earningsExtractionSetManifestId,
          second.pipeline.extractionSet.earningsExtractionSetManifestId);
      } else {
        if (id === 'I1-R004') second.store.putSourceBytes(Buffer.from('outside-closure-noise'));
        assert.equal(first.pipeline.snapshot.earningsDatasetSnapshotManifestId,
          second.pipeline.snapshot.earningsDatasetSnapshotManifestId);
      }
    }));
}

function assertIntegrationEdgeIntent(id) {
  return withOfficialEarningsL4CI1Fixture(
    ({ store, root, transform, taxonomy, filings, pipeline }) => {
      if (id === 'I1-R027') {
        const noise = store.putSourceBytes(Buffer.from('corrupt outside closure'));
        const uri = store.uriForObject({ namespace: 'source', objectId: noise.objectId });
        writeFileSync(join(root, ...uri.split('/')), Buffer.from('tampered outside closure'));
      }
      let snapshotId = pipeline.snapshot.earningsDatasetSnapshotManifestId;
      if (id === 'I1-R026') {
        const child = ingestEarningsDatasetL4CIV1({
          store,
          sourceFilingDocumentIds: filings.slice(0, 2)
            .map((item) => item.sourceFilingDocumentId),
          transformImplementationManifestId: transform.transformImplementationManifestId,
          earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
          previousSnapshotId: snapshotId,
        });
        snapshotId = child.snapshot.earningsDatasetSnapshotManifestId;
      }
      let scanCalls = 0;
      const storeForTraversal = id === 'I1-R018'
        ? Object.freeze({
          ...Object.fromEntries(Object.keys(store).map((key) =>
            [key, typeof store[key] === 'function' ? store[key].bind(store) : store[key]])),
          readdirSync() {
            scanCalls += 1;
            rejectEarningsCasGlobalScanV1();
          },
          globSync() {
            scanCalls += 1;
            rejectEarningsCasGlobalScanV1();
          },
        })
        : store;
      const verified = verifyEarningsSnapshotTraversalV1({
        store: storeForTraversal,
        earningsDatasetSnapshotManifestId: snapshotId,
        labRoot: transform.labRoot,
      });
      assert.equal(verified.verified, true);
      assert.equal(verified.edgeCount, 35);
      if (id === 'I1-R018') assert.equal(scanCalls, 0);
      if (id === 'I1-R026') {
        assert.ok(verified.closureObjectIds.includes(
          pipeline.snapshot.earningsDatasetSnapshotManifestId));
      }
    });
}

function assertExtractionSetPositive(id) {
  if (id === 'I1-C083' || id === 'I1-C091') {
    return withEmptyEarningsL4CI1Fixture(({ pipeline }) => {
      const extractionSet = pipeline.extractionSet.earningsExtractionSetManifest;
      assert.deepEqual(extractionSet.orderedRevisionExtractionEntries, []);
      assert.equal(extractionSet.metricObservationCount, 0);
    });
  }
  if (id === 'I1-C082') {
    return withStore((store) => {
      const transform = pinEarningsTransformImplementationManifestV2(store);
      const taxonomy = pinSyntheticTaxonomyBundle(store);
      const filing = pinSyntheticEarningsFiling(store,
        synthetic8KFiling({ includeMetrics: false }));
      const pipeline = ingestEarningsDatasetL4CIV1({
        store,
        sourceFilingDocumentIds: [filing.sourceFilingDocumentId],
        transformImplementationManifestId: transform.transformImplementationManifestId,
        earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
        previousSnapshotId: null,
      });
      assert.equal(pipeline.extractionSet.earningsExtractionSetManifest.metricObservationCount, 0);
      assert.equal(pipeline.extractionSet.earningsExtractionSetManifest.extractionReportCount, 1);
    });
  }
  if (id === 'I1-C089') {
    const a = [{ earningsRevisionIdentityId: casId(1),
      orderedMetricObservationIds: [casId(3)] },
    { earningsRevisionIdentityId: casId(2), orderedMetricObservationIds: [casId(4)] }];
    const b = [{ earningsRevisionIdentityId: casId(1),
      orderedMetricObservationIds: [casId(3), casId(4)] },
    { earningsRevisionIdentityId: casId(2), orderedMetricObservationIds: [] }];
    assert.notEqual(earningsGroupedMetricObservationDigestV1(a),
      earningsGroupedMetricObservationDigestV1(b));
    return;
  }
  if (id === 'I1-C090') {
    const entries = [
      { earningsRevisionIdentityId: casId(1), orderedMetricObservationIds: [] },
      { earningsRevisionIdentityId: casId(2), orderedMetricObservationIds: [] },
    ];
    assert.equal(earningsGroupedMetricObservationDigestV1(entries),
      oracleGroupedMetricObservationDigestV1(entries));
    return;
  }
  return withOfficialEarningsL4CI1Fixture(({ store, pipeline }) => {
    const verified = verifyEarningsExtractionSetManifest({
      store,
      earningsExtractionSetManifestId: pipeline.extractionSet.earningsExtractionSetManifestId,
    });
    assert.equal(verified.earningsExtractionSetManifest.extractionReportCount,
      pipeline.items.length);
  });
}

function assertPositive(id, group, intent) {
  // An explicit per-ID assertion always wins over the category dispatcher, so
  // that every authoritative intent is pinned to the production branch it names.
  const intentAssertion = EARNINGS_INTENT_ASSERTIONS.get(id);
  if (intentAssertion) return intentAssertion();
  if (['I1-B020', 'I1-D014', 'I1-U010', 'I1-C088', 'I1-C095',
    'I1-R001', 'I1-R003', 'I1-R004'].includes(id)) return assertIndependentStores(id);
  if (group === 'contracts') return assertContractIntent(intent);
  if (group === 'policy') {
    const ingest = normalizeEarningsIngestionPolicyV1(ingestionPolicy());
    const extract = normalizeEarningsMetricExtractionPolicyV1(extractionPolicy());
    if (/event type|8-K/.test(intent)) assert.equal(earningsEventTypeForFormV1('8-K'), 'EARNINGS_RELEASE');
    else if (/datasetSeriesIdentity/.test(intent)) assert.equal(ingest.datasetSeriesIdentity, EARNINGS_DATASET_SERIES_IDENTITY);
    else assert.ok(extract.epsTagPriority[0].includes('Diluted'));
    return;
  }
  if (group === 'periods') {
    const type = /instant|INSTANT/.test(intent) ? 'INSTANT' : 'DURATION';
    return withStore((store) => {
      const sample = period(type);
      const built = buildFinancialPeriodIdentityCore({
        store,
        periodType: sample.periodType,
        periodStart: sample.periodStart,
        periodEnd: sample.periodEnd,
      });
      assert.equal(built.financialPeriodIdentityCore.periodType, type);
    });
  }
  if (group === 'units') {
    const code = /PER_SHARE|divide|EPS/.test(intent) ? 'USD_PER_SHARE' : 'USD';
    return withStore((store) => {
      const built = buildXbrlCanonicalUnitCore({ store, unitCode: code });
      assert.equal(built.xbrlCanonicalUnitId, xbrlCanonicalUnitIdFor(unit(code)));
    });
  }
  if (group === 'oracle') {
    const identity = { datasetSeriesIdentity: EARNINGS_DATASET_SERIES_IDENTITY,
      jurisdictionCode: 'US', currencyCode: 'USD', allowedSourceAuthority: 'SEC_EDGAR' };
    const sample = functionalSample();
    const selector = Number(id.slice(-3)) % 4;
    if (selector === 0) assert.equal(earningsDatasetIdentityKeyV1(identity), oracleDatasetIdentityKeyV1(identity));
    else if (selector === 1) assert.equal(earningsFunctionalSnapshotFingerprintV1(sample),
      oracleFunctionalSnapshotFingerprintV1(sample));
    else if (selector === 2) {
      const entries = [{ earningsRevisionIdentityId: casId(1),
        orderedMetricObservationIds: [casId(2)] }];
      assert.equal(earningsGroupedMetricObservationDigestV1(entries),
        oracleGroupedMetricObservationDigestV1(entries));
    } else {
      const values = [casId(2), casId(1)];
      assert.equal(earningsOrderedMetricObservationIdentityDigestV1(values),
        oracleOrderedMetricObservationIdentityDigestV1(values));
    }
    return;
  }
  if (group === 'registry') {
    const n = Number(id.slice(-3));
    if (n % 4 === 0) assert.equal(EARNINGS_TRAVERSAL_EDGES_V1.length, EARNINGS_TRAVERSAL_EDGE_COUNT_V1);
    else if (n % 4 === 1) assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length, 129);
    else if (n % 4 === 2) assert.equal(NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length, 5);
    else assert.equal(new Set(EARNINGS_L4C_I1_SCHEMA_VERSIONS).size, 16);
    return;
  }
  if (group === 'integration' && ['I1-R018', 'I1-R026', 'I1-R027'].includes(id)) {
    return assertIntegrationEdgeIntent(id);
  }
  if (group === 'extraction-set') {
    return assertExtractionSetPositive(id);
  }
  if (group === 'historical') return assertHistoricalIntent(id);
  if (group === 'snapshot') return assertSnapshotIntent(id);
  if (group === 'revision-set' || group === 'identities') {
    return withOfficialEarningsL4CI1Fixture(({ pipeline }) => {
      const chain = pipeline.revisionSet.earningsRevisionSetManifest.orderedEventChains[0];
      if (/tip/.test(intent)) {
        assert.equal(earningsRevisionSetTipV1(
          pipeline.revisionSet.earningsRevisionSetManifest, chain.eventIdentityId),
        chain.orderedRevisions[0].earningsRevisionIdentityId);
      } else {
        assert.equal(chain.orderedRevisions.length, 1);
        assert.equal(chain.orderedRevisions[0].parentRevisionIdentityId, null);
      }
    });
  }
  if (group === 'source-document') {
    return withOfficialEarningsL4CI1Fixture(({ store, filings }) => {
      const filing = filings[0].secFilingSourceDocument;
      const object = store.readCanonicalObject({
        uri: store.uriForObject({ namespace: 'snapshots',
          objectId: filing.orderedDocuments[0].secDocumentBytesId }),
        expectedObjectId: filing.orderedDocuments[0].secDocumentBytesId,
        schemaVersion: 'SecDocumentBytesCore/1',
      });
      assert.match(object.value.documentObjectId, /^sha256:[0-9a-f]{64}$/);
    });
  }
  return withOfficialEarningsL4CI1Fixture(({ store, transform, pipeline }) => {
    const traversal = verifyEarningsSnapshotTraversalV1({
      store,
      earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
      labRoot: transform.labRoot,
    });
    assert.equal(traversal.verified, true);
    assert.equal(traversal.edgeCount, 35);
    assert.ok(traversal.closureObjectIds.length > 0);
  });
}

const INFERRED_REJECTION_CODES = new Map(Object.entries({
  'I1-C005': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C006': 'EARNINGS_POLICY_INVALID',
  'I1-C008': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C010': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C011': 'EARNINGS_SOURCE_DOCUMENT_INVALID',
  'I1-C013': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C014': 'EARNINGS_DOCUMENT_BYTES_INVALID',
  'I1-C016': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C019': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C022': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C023': 'EARNINGS_PERIOD_INVALID',
  'I1-C029': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C032': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C033': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C035': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C038': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C040': 'EARNINGS_FIXED_POINT_SCALE_INVALID',
  'I1-C042': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C043': 'EARNINGS_REPORT_INVALID',
  'I1-C045': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C046': 'EARNINGS_EVENT_SET_COUNT_MISMATCH',
  'I1-C048': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C049': 'EARNINGS_REVISION_SET_DIGEST_MISMATCH',
  'I1-C051': 'CANONICAL_UNKNOWN_FIELD',
  'I1-C052': 'EARNINGS_SNAPSHOT_INVALID',
  'I1-C053': 'EARNINGS_POLICY_INVALID',
  'I1-D006': 'EARNINGS_PERIOD_INVALID',
  'I1-D007': 'EARNINGS_PERIOD_INVALID',
  'I1-D008': 'EARNINGS_PERIOD_INVALID',
  'I1-U003': 'EARNINGS_UNIT_REJECTED',
  'I1-U004': 'EARNINGS_UNIT_REJECTED',
  'I1-U005': 'EARNINGS_UNIT_REJECTED',
  'I1-U006': 'EARNINGS_UNIT_REJECTED',
  'I1-U008': 'CANONICAL_UNKNOWN_FIELD',
  'I1-U011': 'EARNINGS_UNIT_REJECTED',
  'I1-P028': 'EARNINGS_CAS_GLOBAL_SCAN_FORBIDDEN',
  'I1-P009': 'EARNINGS_ITEM_2_02_ABSENT',
  'I1-P020': 'EARNINGS_STRUCTURED_DOCUMENT_ABSENT',
  'I1-P021': 'EARNINGS_FACT_NIL_REJECTED',
  'I1-P022': 'EARNINGS_CONTEXT_DIMENSION_REJECTED',
  'I1-B005': 'EARNINGS_MEDIA_TYPE_INVALID',
  'I1-B006': 'EARNINGS_DOCUMENT_FORMAT_INVALID',
  'I1-B007': 'EARNINGS_DOCUMENT_ROLE_INVALID',
  'I1-B009': 'EARNINGS_SOURCE_BYTES_MISSING',
  'I1-B010': 'EARNINGS_SOURCE_BYTES_MISMATCH',
  'I1-B014': 'CANONICAL_UNKNOWN_FIELD',
  'I1-B017': 'EARNINGS_SOURCE_BYTES_MISMATCH',
  'I1-B018': 'EARNINGS_SOURCE_BYTES_INVALID',
  'I1-B019': 'EARNINGS_SOURCE_BYTES_MISSING',
  'I1-A001': 'CANONICAL_UNKNOWN_FIELD',
  'I1-A002': 'EARNINGS_UNIT_INVALID',
  'I1-A003': 'EARNINGS_ACCESSION_INVALID',
  'I1-A004': 'EARNINGS_CIK_INVALID',
  'I1-A005': 'EARNINGS_FORM_REJECTED_V1',
  'I1-A006': 'EARNINGS_FORM_REJECTED_V1',
  'I1-A007': 'EARNINGS_ACCEPTANCE_DATETIME_INVALID',
  'I1-A008': 'EARNINGS_POLICY_LATEST_FORBIDDEN',
  'I1-A009': 'EARNINGS_POLICY_NETWORK_FORBIDDEN',
  'I1-A010': 'CANONICAL_UNKNOWN_FIELD',
  'I1-A011': 'CANONICAL_UNKNOWN_FIELD',
  'I1-A012': 'CANONICAL_UNKNOWN_FIELD',
  'I1-A013': 'EARNINGS_EPS_TAG_REJECTED',
  'I1-A014': 'EARNINGS_EPS_SEMANTIC_INVALID',
  'I1-A015': 'EARNINGS_FIXED_POINT_INVALID',
  'I1-A016': 'EARNINGS_FIXED_POINT_INVALID',
  'I1-A017': 'EARNINGS_CONTEXT_DIMENSION_REJECTED',
  'I1-A018': 'EARNINGS_EXTENSION_TAG_REJECTED',
  'I1-A019': 'EARNINGS_PERIOD_TYPE_INVALID',
  'I1-A020': 'EARNINGS_DERIVED_PERIOD_FORBIDDEN',
  'I1-A021': 'EARNINGS_METRIC_ORPHAN',
  'I1-A022': 'EARNINGS_EVENT_SET_DIGEST_MISMATCH',
  'I1-I005': 'EARNINGS_EVENT_TYPE_INVALID',
  'I1-I009': 'CANONICAL_UNKNOWN_FIELD',
  'I1-I016': 'EARNINGS_ACCESSION_IMMUTABILITY_CONFLICT',
  'I1-G007': 'EARNINGS_REVISION_COUNT_PER_EVENT_INVALID',
  'I1-G008': 'EARNINGS_REVISION_PARENT_FORBIDDEN_V1',
  'I1-G009': 'EARNINGS_REVISION_PARENT_FORBIDDEN_V1',
  'I1-G010': 'EARNINGS_REVISION_PARENT_FORBIDDEN_V1',
  'I1-G011': 'EARNINGS_REVISION_PARENT_FORBIDDEN_V1',
  'I1-G014': 'EARNINGS_REVISION_COUNT_PER_EVENT_INVALID',
  'I1-G019': 'CANONICAL_UNKNOWN_FIELD',
  'I1-G020': 'EARNINGS_REVISION_COUNT_PER_EVENT_INVALID',
  'I1-G021': 'CANONICAL_UNKNOWN_FIELD',
  'I1-G023': 'EARNINGS_REVISION_KIND_FORBIDDEN_V1',
}));

export function authoritativeCase(id, group, intent, expectedErrorCode = '') {
  test(`${id}: ${intent}`, () => {
    const code = expectedErrorCode || INFERRED_REJECTION_CODES.get(id) || '';
    if (code) {
      assert.throws(() => exerciseExactRejection(code, intent),
        errorHasCode(code));
      return;
    }
    assertPositive(id, group, intent);
  });
}
