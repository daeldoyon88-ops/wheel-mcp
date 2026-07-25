/** Exhaustive RevisionSet→Report→Observation extraction closure. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
  earningsGroupedMetricObservationDigestV1,
  earningsOrderedExtractionReportDigestV1,
  normalizeEarningsExtractionSetManifestV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsMetricExtractionReport } from './earningsMetricExtractionReportL4CIV1.mjs';
import { verifyEarningsMetricObservationCore } from './earningsMetricObservationL4CIV1.mjs';
import { verifyEarningsRevisionSetManifest } from './earningsRevisionSetL4CIV1.mjs';

function revisionIds(revisionSet) {
  return revisionSet.orderedEventChains
    .map((chain) => chain.orderedRevisions[0].earningsRevisionIdentityId);
}

function manifestValue(input, entries) {
  return normalizeEarningsExtractionSetManifestV1({
    schemaVersion: EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
    earningsRevisionSetManifestId: input.earningsRevisionSetManifestId,
    transformImplementationManifestId: input.transformImplementationManifestId,
    earningsMetricExtractionPolicyId: input.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: input.earningsTaxonomyBundleManifestId,
    orderedRevisionExtractionEntries: entries,
    extractionReportCount: entries.length,
    metricObservationCount: entries.reduce(
      (count, entry) => count + entry.orderedMetricObservationIds.length, 0),
    orderedExtractionReportDigest: earningsOrderedExtractionReportDigestV1(
      entries.map((entry) => entry.earningsMetricExtractionReportId)),
    orderedMetricObservationDigest: earningsGroupedMetricObservationDigestV1(entries),
  });
}

function verifyEntries(store, revisionSet, manifest) {
  const expectedRevisionIds = revisionIds(revisionSet);
  const entries = manifest.orderedRevisionExtractionEntries;
  if (entries.length !== expectedRevisionIds.length) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_MISSING',
      'every revision requires exactly one extraction entry');
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.earningsRevisionIdentityId !== expectedRevisionIds[index]) {
      const code = expectedRevisionIds.includes(entry.earningsRevisionIdentityId)
        ? 'EARNINGS_EXTRACTION_ENTRY_ORDER_INVALID'
        : 'EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION';
      throw new MarketDataL3Error(code, 'extraction entry order diverges from RevisionSet');
    }
    const report = verifyEarningsMetricExtractionReport({
      store, earningsMetricExtractionReportId: entry.earningsMetricExtractionReportId,
    }).earningsMetricExtractionReport;
    if (report.earningsRevisionIdentityId !== entry.earningsRevisionIdentityId) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION',
        'report belongs to a foreign revision');
    }
    if (report.transformImplementationManifestId !== manifest.transformImplementationManifestId) {
      throw new MarketDataL3Error('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH',
        'report and extraction set transform pins differ');
    }
    if (report.earningsMetricExtractionPolicyId !== manifest.earningsMetricExtractionPolicyId) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_POLICY_ID_MISMATCH',
        'report and extraction set policy pins differ');
    }
    if (report.earningsTaxonomyBundleManifestId !== manifest.earningsTaxonomyBundleManifestId) {
      throw new MarketDataL3Error('EARNINGS_TAXONOMY_BUNDLE_ID_MISMATCH',
        'report and extraction set taxonomy pins differ');
    }
    if (report.orderedObservationIds.length !== entry.orderedMetricObservationIds.length
        || report.orderedObservationIds.some(
          (id, observationIndex) => id !== entry.orderedMetricObservationIds[observationIndex])) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH',
        'report and extraction entry observation lists differ');
    }
    for (const id of entry.orderedMetricObservationIds) {
      const observation = verifyEarningsMetricObservationCore({
        store, earningsMetricObservationId: id,
      }).earningsMetricObservationCore;
      if (observation.earningsRevisionIdentityId !== entry.earningsRevisionIdentityId) {
        throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION',
          'observation belongs to a foreign revision');
      }
    }
  }
}

export function buildEarningsExtractionSetManifest(input) {
  const api = assertApiInput(input, [
    'earningsRevisionSetManifestId', 'transformImplementationManifestId',
    'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
    'earningsMetricExtractionReportIds',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const revisionSet = verifyEarningsRevisionSetManifest({
    store: api.store, earningsRevisionSetManifestId: api.earningsRevisionSetManifestId,
  }).earningsRevisionSetManifest;
  if (!Array.isArray(api.earningsMetricExtractionReportIds)
      || api.earningsMetricExtractionReportIds.length !== revisionSet.revisionCount) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_MISSING',
      'one extraction report is required per revision');
  }
  const byRevision = new Map();
  for (const reportId of api.earningsMetricExtractionReportIds) {
    const report = verifyEarningsMetricExtractionReport({
      store: api.store, earningsMetricExtractionReportId: reportId,
    }).earningsMetricExtractionReport;
    if (byRevision.has(report.earningsRevisionIdentityId)) {
      throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_DUPLICATE',
        'duplicate extraction entry for a revision');
    }
    byRevision.set(report.earningsRevisionIdentityId, { reportId, report });
  }
  const entries = revisionIds(revisionSet).map((id) => {
    const item = byRevision.get(id);
    if (!item) throw new MarketDataL3Error('EARNINGS_EXTRACTION_ENTRY_MISSING',
      'revision lacks an extraction report');
    return {
      earningsRevisionIdentityId: id,
      earningsMetricExtractionReportId: item.reportId,
      orderedMetricObservationIds: item.report.orderedObservationIds,
    };
  });
  const manifest = manifestValue(api, entries);
  verifyEntries(api.store, revisionSet, manifest);
  const stored = putCanonicalL3(api.store, EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
    manifest);
  return { earningsExtractionSetManifestId: stored.objectId,
    earningsExtractionSetManifest: stored.value };
}

export function verifyEarningsExtractionSetManifest(input) {
  const api = assertApiInput(input, ['earningsExtractionSetManifestId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let manifest;
  try {
    manifest = normalizeEarningsExtractionSetManifestV1(readTypedReference(api.store,
      api.earningsExtractionSetManifestId, EARNINGS_EXTRACTION_SET_MANIFEST_SCHEMA_VERSION,
      'earnings extraction set'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_SET_MISSING',
      'earnings extraction set is missing or corrupt', { cause });
  }
  const revisionSet = verifyEarningsRevisionSetManifest({
    store: api.store, earningsRevisionSetManifestId: manifest.earningsRevisionSetManifestId,
  }).earningsRevisionSetManifest;
  verifyEntries(api.store, revisionSet, manifest);
  const expected = manifestValue(manifest, manifest.orderedRevisionExtractionEntries);
  if (!canonicalValuesEqual(manifest, expected)) {
    throw new MarketDataL3Error('EARNINGS_EXTRACTION_SET_INVALID',
      'extraction set diverges from recomputed canonical content');
  }
  return { earningsExtractionSetManifestId: api.earningsExtractionSetManifestId,
    earningsExtractionSetManifest: manifest, earningsRevisionSetManifest: revisionSet };
}
