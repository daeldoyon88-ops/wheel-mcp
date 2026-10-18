/**
 * L4C-I2 EarningsAsOfMaterializationReport/1: the pinned answer to "what does
 * this binding make visible, and how are its fiscal periods classified?".
 *
 * Follows the L4B-I2 precedent macroMaterializationReportL4BV1.mjs: the report
 * is built from the binding id alone - there is no second temporal argument,
 * because the cutoff is already pinned inside the binding. Every counter, every
 * ordered list and all eight digests are recomputed; nothing written into a
 * stored report is ever trusted.
 *
 * Seven ordered-list digests plus the functional fingerprint share one closed
 * preimage shape, domain-separated by a NUL byte:
 *
 *   sha256( UTF-8(domain) || 0x00 || canonicalJsonBytes(value) )
 *
 * where canonicalJsonBytes is the repository's canonical JSON encoding (JCS key
 * order, UTF-8, trailing LF). The diagnostic digest is the one exception: its
 * preimage was closed earlier by the owner authority OWNER-L4C-I2-D01-2026-07-26
 * and lives in the contract module as
 * earningsFiscalClassificationDiagnosticDigestV1.
 *
 * F1 excludes exactly five K6 fields - schemaVersion (carried by the domain),
 * earningsDatasetBindingId and earningsDatasetSnapshotManifestId (provenance),
 * knowledgeCutoff (query identity) and the fingerprint itself (no recursive
 * self-hashing). Two materializations with the same visible closure therefore
 * share F1 even when they were reached through different bindings, different
 * cutoffs, different snapshots or different store roots.
 */

import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import { EARNINGS_DATASET_SERIES_IDENTITY } from '../contracts/earningsContractsL4CIV1.mjs';
import {
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_POLICY_VERSION,
  EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  EARNINGS_FISCAL_PERIOD_CLASSES,
  EARNINGS_FISCAL_PERIOD_FOCUS_BUCKETS,
  earningsFiscalClassificationDiagnosticDigestV1,
  normalizeEarningsAsOfMaterializationReportV1,
} from '../contracts/earningsContractsL4CIIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsDatasetBinding } from './earningsDatasetBindingL4CIIV1.mjs';
import { resolveEarningsAsOfV1 } from './resolveEarningsAsOfL4CIIV1.mjs';
import {
  classifyEarningsFiscalPeriodsForRevisionV1,
  verifyEarningsFiscalPeriodClassificationCore,
} from './earningsFiscalClassificationL4CIIV1.mjs';

/* ------------------------------------------------------------------------- *
 * Closed digest domains, in K6 field order.
 * ------------------------------------------------------------------------- */

export const EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN = 'EarningsAsOfVisibleEventDigest/1';
export const EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN = 'EarningsAsOfVisibleRevisionDigest/1';
export const EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN =
  'EarningsAsOfVisibleExtractionReportDigest/1';
export const EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN =
  'EarningsAsOfVisibleObservationDigest/1';
export const EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN =
  'EarningsAsOfVisibleRawPeriodDigest/1';
export const EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN = 'EarningsFiscalClassificationDigest/1';
export const EARNINGS_AS_OF_MATERIALIZATION_FUNCTIONAL_FINGERPRINT_DOMAIN =
  'EarningsAsOfMaterializationFunctionalFingerprint/1';

/** The 42 K6 fields the functional fingerprint covers, in K6 field order. */
export const EARNINGS_MATERIALIZATION_FINGERPRINT_FIELDS = Object.freeze([
  'earningsAsOfResolutionPolicyId', 'earningsFiscalClassificationPolicyId',
  'transformImplementationManifestId', 'earningsIngestionPolicyId',
  'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
  'datasetSeriesIdentity', 'jurisdictionCode', 'currencyCode', 'sourceSnapshotEmpty',
  'emptyMaterialization', 'visibleEventCount', 'visibleRevisionCount',
  'visibleExtractionReportCount', 'visibleMetricObservationCount', 'visibleRawPeriodCount',
  'fiscalClassificationCount', 'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount',
  'dualRoleRawPeriodCount', 'classificationDiagnosticCount', 'earliestVisiblePublicAvailableAt',
  'latestVisiblePublicAvailableAt', 'countsByFiscalPeriodClass', 'countsByFiscalPeriodFocus',
  'orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
  'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
  'orderedVisibleRawPeriodIds', 'orderedFiscalClassificationIds',
  'orderedFiscalClassificationReportIds', 'orderedVisibleEventIdentityDigest',
  'orderedVisibleRevisionIdentityDigest', 'orderedVisibleExtractionReportDigest',
  'orderedVisibleMetricObservationDigest', 'orderedVisibleRawPeriodDigest',
  'orderedFiscalClassificationDigest', 'orderedClassificationDiagnosticDigest',
  'reportPolicyVersion', 'sourceAttestedClassificationCount', 'policyInferredClassificationCount',
]);

/** The five K6 fields F1 deliberately omits. */
export const EARNINGS_MATERIALIZATION_FINGERPRINT_EXCLUDED_FIELDS = Object.freeze([
  'schemaVersion', 'earningsDatasetBindingId', 'earningsDatasetSnapshotManifestId',
  'knowledgeCutoff', 'materializationFunctionalFingerprint',
]);

/**
 * Domain-separated canonical digest: UTF-8(domain) NUL canonicalJson(value).
 * @param {string} domain @param {unknown} value @returns {string} sha256:<hex>
 */
export function recomputeCanonicalDigestV1(domain, value) {
  const preimage = Buffer.concat([
    Buffer.from(domain, 'utf8'), Buffer.from([0x00]), canonicalJsonBytes(value),
  ]);
  return `sha256:${createHash('sha256').update(preimage).digest('hex')}`;
}

/**
 * F1 over a K6 record: the 42 functional fields, cutoff-free and snapshot-free.
 * @param {Record<string, unknown>} report
 */
export function earningsAsOfMaterializationFunctionalFingerprintV1(report) {
  const projection = {};
  for (const field of EARNINGS_MATERIALIZATION_FINGERPRINT_FIELDS) {
    if (!Object.hasOwn(report, field)) {
      throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_INVALID',
        `functional fingerprint requires ${field}`);
    }
    projection[field] = report[field];
  }
  return recomputeCanonicalDigestV1(
    EARNINGS_AS_OF_MATERIALIZATION_FUNCTIONAL_FINGERPRINT_DOMAIN, projection);
}

function emptyCountRecord(buckets) {
  return Object.fromEntries(buckets.map((bucket) => [bucket, 0]));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * Recompute the whole K6 value from a verified binding.
 *
 * The classification pass is deterministic and content-addressed: re-running it
 * over identical inputs republishes byte-identical K3/K4 objects under the same
 * ids, so recomputation never creates a new CAS object and verification stays a
 * true recomputation rather than a re-read of what the report claims.
 *
 * @param {unknown} store @param {string} bindingId
 * @param {ReturnType<typeof verifyEarningsDatasetBinding>} bindingContext
 */
export function computeEarningsAsOfMaterializationValueV1(store, bindingId, bindingContext) {
  const binding = bindingContext.earningsDatasetBinding;
  if (binding.datasetSeriesIdentity !== EARNINGS_DATASET_SERIES_IDENTITY) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_FOREIGN_DATASET',
      'binding carries a foreign datasetSeriesIdentity');
  }

  const resolution = resolveEarningsAsOfV1({
    store,
    earningsDatasetSnapshotManifestId: binding.earningsDatasetSnapshotManifestId,
    knowledgeCutoff: binding.knowledgeCutoff,
    earningsAsOfResolutionPolicyId: binding.earningsAsOfResolutionPolicyId,
  });

  const classificationIds = [];
  const classificationReportIds = [];
  /** @type {{code: string, rawPeriodIdToken: string}[]} */
  const diagnostics = [];
  const classifiedRawPeriodIds = new Set();
  const countsByFiscalPeriodClass = emptyCountRecord(EARNINGS_FISCAL_PERIOD_CLASSES);
  const countsByFiscalPeriodFocus = emptyCountRecord(EARNINGS_FISCAL_PERIOD_FOCUS_BUCKETS);
  const identityKeys = new Set();
  let dualRoleRawPeriodCount = 0;
  let sourceAttestedClassificationCount = 0;
  let policyInferredClassificationCount = 0;

  for (const entry of resolution.orderedVisibleRevisionEntries) {
    const classified = classifyEarningsFiscalPeriodsForRevisionV1({
      store,
      earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
      sourceFilingDocumentId: entry.sourceFilingDocumentId,
      orderedRawPeriodIds: entry.orderedRawPeriodIds,
      earningsFiscalClassificationPolicyId: binding.earningsFiscalClassificationPolicyId,
      transformImplementationManifestId: binding.transformImplementationManifestId,
    });

    if (classified.earningsFiscalClassificationReportId !== null) {
      classificationReportIds.push(classified.earningsFiscalClassificationReportId);
    }
    dualRoleRawPeriodCount += classified.dualRoleRawPeriodCount;
    // The materialization-wide diagnostic set is a set: the same (code, token)
    // observed through two visible revisions is one diagnostic, once.
    for (const diagnostic of classified.diagnostics) {
      if (!diagnostics.some((known) => known.code === diagnostic.code
        && known.rawPeriodIdToken === diagnostic.rawPeriodIdToken)) {
        diagnostics.push({ code: diagnostic.code, rawPeriodIdToken: diagnostic.rawPeriodIdToken });
      }
    }

    for (const classificationId of classified.orderedFiscalPeriodClassificationIds) {
      const core = verifyEarningsFiscalPeriodClassificationCore({
        store, earningsFiscalPeriodClassificationId: classificationId,
      }).earningsFiscalPeriodClassification;
      const identityKey = [core.earningsRevisionIdentityId, core.financialPeriodIdentityId,
        core.fiscalPeriodClass].join(' ');
      if (identityKeys.has(identityKey)) {
        throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_DUPLICATE',
          'two classifications share (revision, rawPeriod, class)');
      }
      identityKeys.add(identityKey);
      classificationIds.push(classificationId);
      classifiedRawPeriodIds.add(core.financialPeriodIdentityId);
      countsByFiscalPeriodClass[core.fiscalPeriodClass] += 1;
      countsByFiscalPeriodFocus[core.fiscalPeriodFocus ?? 'UNDECLARED'] += 1;
      if (core.classificationBasis === 'SOURCE_ATTESTED') sourceAttestedClassificationCount += 1;
      else policyInferredClassificationCount += 1;
    }
  }

  const orderedFiscalClassificationIds = sortedUnique(classificationIds);
  const orderedFiscalClassificationReportIds = sortedUnique(classificationReportIds);
  const classifiedRawPeriodCount = classifiedRawPeriodIds.size;
  if (classifiedRawPeriodCount > resolution.visibleRawPeriodCount) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_COUNT_MISMATCH',
      'classified raw periods exceed the visible raw period set');
  }

  const value = {
    schemaVersion: EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    earningsDatasetBindingId: bindingId,
    earningsDatasetSnapshotManifestId: binding.earningsDatasetSnapshotManifestId,
    earningsAsOfResolutionPolicyId: binding.earningsAsOfResolutionPolicyId,
    earningsFiscalClassificationPolicyId: binding.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: binding.transformImplementationManifestId,
    earningsIngestionPolicyId: binding.earningsIngestionPolicyId,
    earningsMetricExtractionPolicyId: binding.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: binding.earningsTaxonomyBundleManifestId,
    datasetSeriesIdentity: binding.datasetSeriesIdentity,
    jurisdictionCode: binding.jurisdictionCode,
    currencyCode: binding.currencyCode,
    knowledgeCutoff: binding.knowledgeCutoff,
    sourceSnapshotEmpty: resolution.sourceSnapshotEmpty,
    emptyMaterialization: resolution.emptyMaterialization,
    visibleEventCount: resolution.visibleEventCount,
    visibleRevisionCount: resolution.visibleRevisionCount,
    visibleExtractionReportCount: resolution.visibleExtractionReportCount,
    visibleMetricObservationCount: resolution.visibleMetricObservationCount,
    visibleRawPeriodCount: resolution.visibleRawPeriodCount,
    fiscalClassificationCount: orderedFiscalClassificationIds.length,
    classifiedRawPeriodCount,
    unclassifiedRawPeriodCount: resolution.visibleRawPeriodCount - classifiedRawPeriodCount,
    dualRoleRawPeriodCount,
    classificationDiagnosticCount: diagnostics.length,
    earliestVisiblePublicAvailableAt: resolution.earliestVisiblePublicAvailableAt,
    latestVisiblePublicAvailableAt: resolution.latestVisiblePublicAvailableAt,
    countsByFiscalPeriodClass,
    countsByFiscalPeriodFocus,
    orderedVisibleEventIdentityIds: resolution.orderedVisibleEventIdentityIds,
    orderedVisibleRevisionIdentityIds: resolution.orderedVisibleRevisionIdentityIds,
    orderedVisibleExtractionReportIds: resolution.orderedVisibleExtractionReportIds,
    orderedVisibleMetricObservationIds: resolution.orderedVisibleMetricObservationIds,
    orderedVisibleRawPeriodIds: resolution.orderedVisibleRawPeriodIds,
    orderedFiscalClassificationIds,
    orderedFiscalClassificationReportIds,
    orderedVisibleEventIdentityDigest: recomputeCanonicalDigestV1(
      EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN, resolution.orderedVisibleEventIdentityIds),
    orderedVisibleRevisionIdentityDigest: recomputeCanonicalDigestV1(
      EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN, resolution.orderedVisibleRevisionIdentityIds),
    orderedVisibleExtractionReportDigest: recomputeCanonicalDigestV1(
      EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN,
      resolution.orderedVisibleExtractionReportIds),
    orderedVisibleMetricObservationDigest: recomputeCanonicalDigestV1(
      EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN,
      resolution.orderedVisibleMetricObservationIds),
    orderedVisibleRawPeriodDigest: recomputeCanonicalDigestV1(
      EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN, resolution.orderedVisibleRawPeriodIds),
    orderedFiscalClassificationDigest: recomputeCanonicalDigestV1(
      EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN, orderedFiscalClassificationIds),
    orderedClassificationDiagnosticDigest:
      earningsFiscalClassificationDiagnosticDigestV1(diagnostics),
    reportPolicyVersion: EARNINGS_AS_OF_MATERIALIZATION_REPORT_POLICY_VERSION,
    sourceAttestedClassificationCount,
    policyInferredClassificationCount,
  };
  // F1 is computed over the 42 functional fields only, so it is well defined
  // before the fingerprint field itself exists.
  value.materializationFunctionalFingerprint =
    earningsAsOfMaterializationFunctionalFingerprintV1(value);

  return {
    report: normalizeEarningsAsOfMaterializationReportV1(value),
    resolution,
    diagnostics,
  };
}

/**
 * Build the pinned materialization answer from the binding id alone.
 * @param {{store: unknown, earningsDatasetBindingId: string}} input
 */
export function buildEarningsAsOfMaterializationReport(input) {
  const api = assertApiInput(input, ['earningsDatasetBindingId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsDatasetBindingId, 'earningsDatasetBindingId');
  assertCasId(api.earningsDatasetBindingId, 'earningsDatasetBindingId');

  const bindingContext = verifyEarningsDatasetBinding({
    store: api.store, earningsDatasetBindingId: api.earningsDatasetBindingId,
  });
  const computed = computeEarningsAsOfMaterializationValueV1(
    api.store, api.earningsDatasetBindingId, bindingContext);
  const stored = putCanonicalL3(api.store,
    EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION, computed.report);
  verifyEarningsAsOfMaterializationReport({
    store: api.store, earningsAsOfMaterializationReportId: stored.objectId,
  });
  return {
    earningsAsOfMaterializationReportId: stored.objectId,
    earningsAsOfMaterializationReport: stored.value,
    classificationDiagnostics: computed.diagnostics,
  };
}

/**
 * Verify a stored materialization report by recomputing it end to end.
 * @param {{store: unknown, earningsAsOfMaterializationReportId: string}} input
 */
export function verifyEarningsAsOfMaterializationReport(input) {
  const api = assertApiInput(input, ['earningsAsOfMaterializationReportId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsAsOfMaterializationReportId,
    'earningsAsOfMaterializationReportId');
  assertCasId(api.earningsAsOfMaterializationReportId, 'earningsAsOfMaterializationReportId');

  let report;
  try {
    report = normalizeEarningsAsOfMaterializationReportV1(readTypedReference(api.store,
      api.earningsAsOfMaterializationReportId,
      EARNINGS_AS_OF_MATERIALIZATION_REPORT_SCHEMA_VERSION,
      'earnings as-of materialization report'));
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
      && ['EARNINGS_MATERIALIZATION_INVALID', 'EARNINGS_MATERIALIZATION_ORDER_INVALID',
        'EARNINGS_MATERIALIZATION_COUNT_MISMATCH', 'EARNINGS_MATERIALIZATION_FOREIGN_DATASET',
        'EARNINGS_MATERIALIZATION_SUPERSESSION_FORBIDDEN',
        'EARNINGS_KNOWLEDGE_CUTOFF_INVALID'].includes(cause.code)) {
      throw cause;
    }
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_MISSING',
      'earnings as-of materialization report is missing or corrupt', { cause });
  }

  const bindingContext = verifyEarningsDatasetBinding({
    store: api.store, earningsDatasetBindingId: report.earningsDatasetBindingId,
  });
  const computed = computeEarningsAsOfMaterializationValueV1(
    api.store, report.earningsDatasetBindingId, bindingContext);
  const expected = computed.report;

  // Fail closed on the most specific divergence first so that a mutated counter,
  // a mutated digest and a mutated fingerprint are distinguishable.
  for (const field of ['visibleEventCount', 'visibleRevisionCount', 'visibleExtractionReportCount',
    'visibleMetricObservationCount', 'visibleRawPeriodCount', 'fiscalClassificationCount',
    'classifiedRawPeriodCount', 'unclassifiedRawPeriodCount', 'dualRoleRawPeriodCount',
    'classificationDiagnosticCount', 'sourceAttestedClassificationCount',
    'policyInferredClassificationCount']) {
    if (report[field] !== expected[field]) {
      throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_COUNT_MISMATCH',
        `${field} diverges from recomputation`,
        { written: report[field], recomputed: expected[field] });
    }
  }
  for (const field of ['countsByFiscalPeriodClass', 'countsByFiscalPeriodFocus']) {
    if (!canonicalValuesEqual(report[field], expected[field])) {
      throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_COUNT_MISMATCH',
        `${field} diverges from recomputation`);
    }
  }
  for (const field of ['orderedVisibleEventIdentityIds', 'orderedVisibleRevisionIdentityIds',
    'orderedVisibleExtractionReportIds', 'orderedVisibleMetricObservationIds',
    'orderedVisibleRawPeriodIds', 'orderedFiscalClassificationIds',
    'orderedFiscalClassificationReportIds']) {
    if (!canonicalValuesEqual(report[field], expected[field])) {
      throw new MarketDataL3Error('EARNINGS_AS_OF_FUTURE_REFERENCE',
        `${field} diverges from the visible closure at the pinned cutoff`);
    }
  }
  for (const field of ['orderedVisibleEventIdentityDigest', 'orderedVisibleRevisionIdentityDigest',
    'orderedVisibleExtractionReportDigest', 'orderedVisibleMetricObservationDigest',
    'orderedVisibleRawPeriodDigest', 'orderedFiscalClassificationDigest',
    'orderedClassificationDiagnosticDigest']) {
    if (report[field] !== expected[field]) {
      throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_DIGEST_MISMATCH',
        `${field} diverges from recomputation`);
    }
  }
  if (report.materializationFunctionalFingerprint
    !== earningsAsOfMaterializationFunctionalFingerprintV1(report)) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_FINGERPRINT_MISMATCH',
      'materializationFunctionalFingerprint diverges from recomputation');
  }
  if (!canonicalValuesEqual(report, expected)) {
    throw new MarketDataL3Error('EARNINGS_MATERIALIZATION_INVALID',
      'materialization report diverges from its recomputed canonical value');
  }

  // Every classification the report names must belong to a visible revision.
  const visibleRevisionIds = new Set(report.orderedVisibleRevisionIdentityIds);
  for (const classificationId of report.orderedFiscalClassificationIds) {
    const core = verifyEarningsFiscalPeriodClassificationCore({
      store: api.store, earningsFiscalPeriodClassificationId: classificationId,
    }).earningsFiscalPeriodClassification;
    if (!visibleRevisionIds.has(core.earningsRevisionIdentityId)) {
      throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_ORPHAN',
        'classification references a revision outside the materialized visible set');
    }
  }

  return {
    earningsAsOfMaterializationReportId: api.earningsAsOfMaterializationReportId,
    earningsAsOfMaterializationReport: report,
    earningsDatasetBinding: bindingContext.earningsDatasetBinding,
    classificationDiagnostics: computed.diagnostics,
    resolution: computed.resolution,
  };
}
