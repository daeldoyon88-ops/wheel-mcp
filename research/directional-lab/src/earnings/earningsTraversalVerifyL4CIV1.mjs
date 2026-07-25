/** Explicit 35-edge snapshot closure verification; no directory or CAS scan. */

import { MarketDataL3Error, canonicalValuesEqual, readTypedReference } from '../contracts/marketDataL3CommonV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../data/transformImplementationManifestV2.mjs';
import { verifyEarningsDatasetSnapshotManifest } from './earningsDatasetSnapshotL4CIV1.mjs';
import { verifyEarningsMetricExtractionReport } from './earningsMetricExtractionReportL4CIV1.mjs';
import { verifyEarningsMetricObservationCore } from './earningsMetricObservationL4CIV1.mjs';
import { verifyEarningsRevisionCore, verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifySecFilingSourceDocument } from './earningsSecFilingSourceDocumentL4CIV1.mjs';

export const EARNINGS_TRAVERSAL_EDGE_COUNT_V1 = 35;

export const EARNINGS_TRAVERSAL_EDGES_V1 = Object.freeze([
  ['EarningsDatasetSnapshotManifest/1', 'earningsIngestionPolicyId', 'EarningsIngestionPolicy/1'],
  ['EarningsDatasetSnapshotManifest/1', 'earningsMetricExtractionPolicyId', 'EarningsMetricExtractionPolicy/1'],
  ['EarningsDatasetSnapshotManifest/1', 'earningsEventSetManifestId', 'EarningsEventSetManifest/1'],
  ['EarningsDatasetSnapshotManifest/1', 'earningsRevisionSetManifestId', 'EarningsRevisionSetManifest/1'],
  ['EarningsDatasetSnapshotManifest/1', 'earningsExtractionSetManifestId', 'EarningsExtractionSetManifest/1'],
  ['EarningsDatasetSnapshotManifest/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsDatasetSnapshotManifest/1', 'earningsTaxonomyBundleManifestId', 'EarningsTaxonomyBundleManifest/1'],
  ['EarningsDatasetSnapshotManifest/1', 'supersedesEarningsDatasetSnapshotManifestId', 'EarningsDatasetSnapshotManifest/1|null'],
  ['EarningsEventSetManifest/1', 'orderedEventEntries[].eventIdentityId', 'EarningsEventIdentityCore/1'],
  ['EarningsRevisionSetManifest/1', 'orderedEventChains[].orderedRevisions[].earningsRevisionId', 'EarningsRevisionCore/1'],
  ['EarningsRevisionSetManifest/1', 'orderedEventChains[].orderedRevisions[].earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsRevisionCore/1', 'earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsRevisionCore/1', 'eventIdentityId', 'EarningsEventIdentityCore/1'],
  ['EarningsRevisionCore/1', 'sourceFilingDocumentId', 'SecFilingSourceDocumentCore/1'],
  ['EarningsRevisionIdentityCore/1', 'eventIdentityId', 'EarningsEventIdentityCore/1'],
  ['EarningsRevisionIdentityCore/1', 'sourceFilingDocumentId', 'SecFilingSourceDocumentCore/1'],
  ['SecFilingSourceDocumentCore/1', 'orderedDocuments[].secDocumentBytesId', 'SecDocumentBytesCore/1'],
  ['SecDocumentBytesCore/1', 'documentObjectId', 'raw-bytes-leaf'],
  ['EarningsExtractionSetManifest/1', 'earningsRevisionSetManifestId', 'EarningsRevisionSetManifest/1'],
  ['EarningsExtractionSetManifest/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsExtractionSetManifest/1', 'earningsMetricExtractionPolicyId', 'EarningsMetricExtractionPolicy/1'],
  ['EarningsExtractionSetManifest/1', 'earningsTaxonomyBundleManifestId', 'EarningsTaxonomyBundleManifest/1'],
  ['EarningsExtractionSetManifest/1', 'orderedRevisionExtractionEntries[].earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsExtractionSetManifest/1', 'orderedRevisionExtractionEntries[].earningsMetricExtractionReportId', 'EarningsMetricExtractionReport/1'],
  ['EarningsExtractionSetManifest/1', 'orderedRevisionExtractionEntries[].orderedMetricObservationIds[]', 'EarningsMetricObservationCore/1'],
  ['EarningsMetricExtractionReport/1', 'earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsMetricExtractionReport/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsMetricExtractionReport/1', 'earningsMetricExtractionPolicyId', 'EarningsMetricExtractionPolicy/1'],
  ['EarningsMetricExtractionReport/1', 'earningsTaxonomyBundleManifestId', 'EarningsTaxonomyBundleManifest/1'],
  ['EarningsMetricExtractionReport/1', 'orderedObservationIds[]', 'EarningsMetricObservationCore/1'],
  ['EarningsMetricObservationCore/1', 'earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsMetricObservationCore/1', 'financialPeriodIdentityId', 'FinancialPeriodIdentityCore/1'],
  ['EarningsMetricObservationCore/1', 'xbrlCanonicalUnitId', 'XbrlCanonicalUnitCore/1'],
  ['EarningsTaxonomyBundleManifest/1', 'orderedComponentDocumentIds[]', 'SecDocumentBytesCore/1'],
  ['TransformImplementationManifest/2', 'modules[].logicalPath', 'module-source-text-leaf'],
]);

function verifyTransformSourcePins(store, transformId, labRoot) {
  const manifest = readTypedReference(store, transformId,
    TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, 'transform implementation manifest');
  if (labRoot !== null) {
    const rebuilt = buildTransformImplementationManifestV2({
      labRoot,
      logicalPaths: manifest.modules.map((module) => module.logicalPath),
      runtimeContractVersion: manifest.runtimeContractVersion,
    });
    if (!canonicalValuesEqual(manifest, rebuilt)) {
      throw new MarketDataL3Error('SNAPSHOT_TRANSFORM_MANIFEST_INVALID',
        'transform module bytes diverge from their explicit pins');
    }
  }
  return manifest;
}

export function verifyEarningsSnapshotTraversalV1(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || !Object.hasOwn(input, 'store')
      || !Object.hasOwn(input, 'earningsDatasetSnapshotManifestId')) {
    throw new MarketDataL3Error('EARNINGS_CLOSURE_REFERENCE_MISSING',
      'store and earningsDatasetSnapshotManifestId are required');
  }
  const labRoot = Object.hasOwn(input, 'labRoot') ? input.labRoot : null;
  const closure = new Set([input.earningsDatasetSnapshotManifestId]);
  try {
    const verified = verifyEarningsDatasetSnapshotManifest({
      store: input.store,
      earningsDatasetSnapshotManifestId: input.earningsDatasetSnapshotManifestId,
    });
    const snapshot = verified.earningsDatasetSnapshotManifest;
    for (const field of ['earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
      'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
      'earningsExtractionSetManifestId', 'transformImplementationManifestId',
      'earningsTaxonomyBundleManifestId']) closure.add(snapshot[field]);
    let parent = snapshot.supersedesEarningsDatasetSnapshotManifestId;
    while (parent !== null) {
      closure.add(parent);
      const parentVerified = verifyEarningsDatasetSnapshotManifest({
        store: input.store, earningsDatasetSnapshotManifestId: parent,
      });
      parent = parentVerified.earningsDatasetSnapshotManifest
        .supersedesEarningsDatasetSnapshotManifestId;
    }
    const composition = verified.composition;
    for (const entry of composition.eventSet.orderedEventEntries) closure.add(entry.eventIdentityId);
    for (const chain of composition.revisionSet.orderedEventChains) {
      const revisionEntry = chain.orderedRevisions[0];
      closure.add(revisionEntry.earningsRevisionIdentityId);
      closure.add(revisionEntry.earningsRevisionId);
      const revision = verifyEarningsRevisionCore({
        store: input.store, earningsRevisionId: revisionEntry.earningsRevisionId,
      }).earningsRevisionCore;
      closure.add(revision.eventIdentityId);
      closure.add(revision.sourceFilingDocumentId);
      const identity = verifyEarningsRevisionIdentityCore({
        store: input.store,
        earningsRevisionIdentityId: revisionEntry.earningsRevisionIdentityId,
      }).earningsRevisionIdentityCore;
      closure.add(identity.sourceFilingDocumentId);
      const filing = verifySecFilingSourceDocument({
        store: input.store, sourceFilingDocumentId: identity.sourceFilingDocumentId,
      });
      for (const document of filing.documents) {
        closure.add(document.secDocumentBytesId);
        closure.add(document.secDocumentBytesCore.documentObjectId);
      }
    }
    for (const entry of composition.extractionSet.orderedRevisionExtractionEntries) {
      closure.add(entry.earningsRevisionIdentityId);
      closure.add(entry.earningsMetricExtractionReportId);
      const report = verifyEarningsMetricExtractionReport({
        store: input.store,
        earningsMetricExtractionReportId: entry.earningsMetricExtractionReportId,
      }).earningsMetricExtractionReport;
      closure.add(report.transformImplementationManifestId);
      closure.add(report.earningsMetricExtractionPolicyId);
      closure.add(report.earningsTaxonomyBundleManifestId);
      for (const id of entry.orderedMetricObservationIds) {
        closure.add(id);
        const observation = verifyEarningsMetricObservationCore({
          store: input.store, earningsMetricObservationId: id,
        }).earningsMetricObservationCore;
        closure.add(observation.earningsRevisionIdentityId);
        closure.add(observation.financialPeriodIdentityId);
        closure.add(observation.xbrlCanonicalUnitId);
      }
    }
    for (const id of composition.taxonomy.orderedComponentDocumentIds) closure.add(id);
    verifyTransformSourcePins(input.store, snapshot.transformImplementationManifestId, labRoot);
    return {
      verified: true,
      edgeCount: EARNINGS_TRAVERSAL_EDGES_V1.length,
      closureObjectIds: [...closure].sort(),
    };
  } catch (cause) {
    if (cause?.code === 'EARNINGS_CAS_GLOBAL_SCAN_FORBIDDEN') throw cause;
    if (cause instanceof MarketDataL3Error
        && ['EARNINGS_SNAPSHOT_SUPERSESSION_CYCLE',
          'EARNINGS_SNAPSHOT_SUPERSESSION_FOREIGN_DATASET'].includes(cause.code)) throw cause;
    if (cause instanceof MarketDataL3Error
        && ['EARNINGS_EXTRACTION_ENTRY_FOREIGN_REVISION',
          'EARNINGS_EXTRACTION_ENTRY_DUPLICATE',
          'EARNINGS_EXTRACTION_REPORT_OBS_MISMATCH'].includes(cause.code)) {
      throw new MarketDataL3Error('EARNINGS_CLOSURE_UNEXPECTED_ID',
        'snapshot closed lists contain an unexpected identity', { cause });
    }
    throw new MarketDataL3Error('EARNINGS_CLOSURE_REFERENCE_MISSING',
      'snapshot transitive closure is incomplete or corrupt', { cause });
  }
}

export const verifyEarningsTraversalL4CIV1 = verifyEarningsSnapshotTraversalV1;

export function rejectEarningsCasGlobalScanV1() {
  throw new MarketDataL3Error('EARNINGS_CAS_GLOBAL_SCAN_FORBIDDEN',
    'readdir, glob, latest and CAS-wide tip discovery are forbidden');
}
