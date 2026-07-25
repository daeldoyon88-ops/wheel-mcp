/** End-to-end offline admit→extract→sets→snapshot orchestration. */

import { MarketDataL3Error, assertStore } from '../contracts/marketDataL3CommonV1.mjs';
import { assertEarningsAccessionImmutabilityV1 } from './earningsAccessionImmutabilityL4CIV1.mjs';
import { buildEarningsDatasetSnapshotManifest } from './earningsDatasetSnapshotL4CIV1.mjs';
import { buildEarningsEventIdentityCore } from './earningsEventIdentityL4CIV1.mjs';
import { buildEarningsEventSetManifest } from './earningsEventSetL4CIV1.mjs';
import { buildEarningsExtractionSetManifest } from './earningsExtractionSetL4CIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  buildEarningsIngestionPolicy,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { buildEarningsMetricExtractionPolicy } from './earningsMetricExtractionPolicyL4CIV1.mjs';
import { buildEarningsMetricExtractionReport } from './earningsMetricExtractionReportL4CIV1.mjs';
import { buildEarningsRevision } from './earningsRevisionL4CIV1.mjs';
import { buildEarningsRevisionSetManifest } from './earningsRevisionSetL4CIV1.mjs';
import { admitSecFilingForEarningsV1 } from './earningsSecFilingSourceDocumentL4CIV1.mjs';
import { extractEarningsXbrlV1 } from './earningsXbrlExtractionL4CIV1.mjs';

export function ingestEarningsDatasetL4CIV1(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new MarketDataL3Error('EARNINGS_PIPELINE_INVALID', 'pipeline input must be a record');
  }
  const allowed = new Set(['store', 'sourceFilingDocumentIds',
    'transformImplementationManifestId', 'earningsTaxonomyBundleManifestId',
    'previousSnapshotId']);
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new MarketDataL3Error('MARKET_DATA_UNKNOWN_FIELD',
      `unknown field: ${field}`);
  }
  for (const field of allowed) {
    if (!Object.hasOwn(input, field)) {
      throw new MarketDataL3Error('EARNINGS_PIPELINE_INVALID', `${field} is required`);
    }
  }
  assertStore(input.store, EARNINGS_STORE_METHODS);
  if (!Array.isArray(input.sourceFilingDocumentIds)
      || new Set(input.sourceFilingDocumentIds).size !== input.sourceFilingDocumentIds.length) {
    throw new MarketDataL3Error('EARNINGS_PIPELINE_INVALID',
      'sourceFilingDocumentIds must be a unique explicit array');
  }
  const ingestionPolicy = buildEarningsIngestionPolicy({ store: input.store });
  const extractionPolicy = buildEarningsMetricExtractionPolicy({ store: input.store });
  const admitted = input.sourceFilingDocumentIds.map((sourceFilingDocumentId) =>
    admitSecFilingForEarningsV1({ store: input.store, sourceFilingDocumentId }));
  assertEarningsAccessionImmutabilityV1(admitted.map((item) => ({
    filerCik: item.secFilingSourceDocument.filerCik,
    accessionNumber: item.secFilingSourceDocument.accessionNumber,
    sourceFilingDocumentId: item.sourceFilingDocumentId,
  })));
  admitted.sort((left, right) => {
    const a = `${left.secFilingSourceDocument.filerCik}\0${left.secFilingSourceDocument.accessionNumber}`;
    const b = `${right.secFilingSourceDocument.filerCik}\0${right.secFilingSourceDocument.accessionNumber}`;
    return a.localeCompare(b);
  });
  const items = admitted.map((admission) => {
    const filing = admission.secFilingSourceDocument;
    const event = buildEarningsEventIdentityCore({
      store: input.store, filerCik: filing.filerCik, accessionNumber: filing.accessionNumber,
    });
    const revision = buildEarningsRevision({
      store: input.store, eventIdentityId: event.eventIdentityId,
      sourceFilingDocumentId: admission.sourceFilingDocumentId,
    });
    const extraction = extractEarningsXbrlV1({
      store: input.store, sourceFilingDocumentId: admission.sourceFilingDocumentId,
      earningsRevisionIdentityId: revision.earningsRevisionIdentityId,
      earningsMetricExtractionPolicyId: extractionPolicy.earningsMetricExtractionPolicyId,
    });
    const report = buildEarningsMetricExtractionReport({
      store: input.store,
      earningsRevisionIdentityId: revision.earningsRevisionIdentityId,
      transformImplementationManifestId: input.transformImplementationManifestId,
      earningsMetricExtractionPolicyId: extractionPolicy.earningsMetricExtractionPolicyId,
      earningsTaxonomyBundleManifestId: input.earningsTaxonomyBundleManifestId,
      observationIds: extraction.orderedObservationIds,
      diagnostics: [...admission.diagnostics, ...extraction.diagnostics],
    });
    return { admission, event, revision, extraction, report };
  });
  const eventSet = buildEarningsEventSetManifest({
    store: input.store, eventIdentityIds: items.map((item) => item.event.eventIdentityId),
  });
  const revisionSet = buildEarningsRevisionSetManifest({
    store: input.store,
    earningsRevisionIds: items.map((item) => item.revision.earningsRevisionId),
  });
  const extractionSet = buildEarningsExtractionSetManifest({
    store: input.store,
    earningsRevisionSetManifestId: revisionSet.earningsRevisionSetManifestId,
    transformImplementationManifestId: input.transformImplementationManifestId,
    earningsMetricExtractionPolicyId: extractionPolicy.earningsMetricExtractionPolicyId,
    earningsTaxonomyBundleManifestId: input.earningsTaxonomyBundleManifestId,
    earningsMetricExtractionReportIds:
      items.map((item) => item.report.earningsMetricExtractionReportId),
  });
  const snapshot = buildEarningsDatasetSnapshotManifest({
    store: input.store,
    earningsIngestionPolicyId: ingestionPolicy.earningsIngestionPolicyId,
    earningsMetricExtractionPolicyId: extractionPolicy.earningsMetricExtractionPolicyId,
    earningsEventSetManifestId: eventSet.earningsEventSetManifestId,
    earningsRevisionSetManifestId: revisionSet.earningsRevisionSetManifestId,
    earningsExtractionSetManifestId: extractionSet.earningsExtractionSetManifestId,
    transformImplementationManifestId: input.transformImplementationManifestId,
    earningsTaxonomyBundleManifestId: input.earningsTaxonomyBundleManifestId,
    previousSnapshotId: input.previousSnapshotId,
  });
  return { ingestionPolicy, extractionPolicy, items, eventSet, revisionSet, extractionSet,
    snapshot };
}

export const runEarningsIngestionPipelineL4CIV1 = ingestEarningsDatasetL4CIV1;
