/** Per-revision extraction reports pin observations and technical authorities. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
  earningsOrderedDiagnosticDigestV1,
  normalizeEarningsMetricExtractionReportV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION } from '../data/transformImplementationManifestV2.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsMetricExtractionPolicy } from './earningsMetricExtractionPolicyL4CIV1.mjs';
import { verifyEarningsMetricObservationCore } from './earningsMetricObservationL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifyEarningsTaxonomyBundleManifest } from './earningsTaxonomyBundleL4CIV1.mjs';

function expected(input) {
  return normalizeEarningsMetricExtractionReportV1({
    schemaVersion: EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
    earningsRevisionIdentityId: input.earningsRevisionIdentityId,
    transformImplementationManifestId: input.transformImplementationManifestId,
    earningsMetricExtractionPolicyId: input.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: input.earningsTaxonomyBundleManifestId,
    orderedObservationIds: input.orderedObservationIds,
    diagnosticCount: input.diagnostics.length,
    orderedDiagnosticDigest: earningsOrderedDiagnosticDigestV1(input.diagnostics),
  });
}

function verifyTechnicalReferences(store, value) {
  try {
    readTypedReference(store, value.transformImplementationManifestId,
      TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'transform implementation manifest');
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
      'transform implementation manifest is missing or invalid', { cause });
  }
  verifyEarningsMetricExtractionPolicy({
    store, earningsMetricExtractionPolicyId: value.earningsMetricExtractionPolicyId,
  });
  verifyEarningsTaxonomyBundleManifest({
    store, earningsTaxonomyBundleManifestId: value.earningsTaxonomyBundleManifestId,
  });
}

export function buildEarningsMetricExtractionReport(input) {
  const api = assertApiInput(input, [
    'earningsRevisionIdentityId', 'transformImplementationManifestId',
    'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
    'observationIds', 'diagnostics',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  if (!Array.isArray(api.observationIds) || !Array.isArray(api.diagnostics)
      || api.diagnostics.some((item) => typeof item !== 'string')) {
    throw new MarketDataL3Error('EARNINGS_REPORT_INVALID',
      'observationIds and diagnostics must be arrays');
  }
  verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: api.earningsRevisionIdentityId,
  });
  const ids = [...api.observationIds].sort();
  if (new Set(ids).size !== ids.length) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_OBSERVATION_DUPLICATE',
      'report cannot contain duplicate observations');
  }
  for (const id of ids) {
    const observation = verifyEarningsMetricObservationCore({
      store: api.store, earningsMetricObservationId: id,
    }).earningsMetricObservationCore;
    if (observation.earningsRevisionIdentityId !== api.earningsRevisionIdentityId) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION',
        'report observation belongs to another revision');
    }
  }
  verifyTechnicalReferences(api.store, api);
  const report = expected({ ...api, orderedObservationIds: ids });
  const stored = putCanonicalL3(api.store, EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION,
    report);
  return { earningsMetricExtractionReportId: stored.objectId,
    earningsMetricExtractionReport: stored.value, diagnostics: [...api.diagnostics] };
}

export function verifyEarningsMetricExtractionReport(input) {
  const api = assertApiInput(input, ['earningsMetricExtractionReportId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let report;
  try {
    report = normalizeEarningsMetricExtractionReportV1(readTypedReference(api.store,
      api.earningsMetricExtractionReportId,
      EARNINGS_METRIC_EXTRACTION_REPORT_SCHEMA_VERSION, 'earnings extraction report'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_REPORT_MISSING',
      'extraction report is missing or corrupt', { cause });
  }
  verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: report.earningsRevisionIdentityId,
  });
  verifyTechnicalReferences(api.store, report);
  for (const id of report.orderedObservationIds) {
    const observation = verifyEarningsMetricObservationCore({
      store: api.store, earningsMetricObservationId: id,
    }).earningsMetricObservationCore;
    if (observation.earningsRevisionIdentityId !== report.earningsRevisionIdentityId) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH',
        'report observation belongs to another revision');
    }
  }
  // Diagnostics are intentionally represented by a count+digest only.  Their
  // original strings are not recoverable; structural normalization is the
  // authoritative verification for those two committed fields.
  if (!canonicalValuesEqual(report, normalizeEarningsMetricExtractionReportV1(report))) {
    throw new MarketDataL3Error('EARNINGS_REPORT_INVALID', 'report is not canonical');
  }
  return { earningsMetricExtractionReportId: api.earningsMetricExtractionReportId,
    earningsMetricExtractionReport: report };
}
