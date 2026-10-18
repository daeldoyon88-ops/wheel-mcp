/**
 * L4C-I2 explicit 68-edge traversal closure over a pinned materialization
 * answer: 35 L4C-I1 edges plus 33 L4C-I2 edges, acyclic.
 *
 * Kept in its own module for the same reason L4C-I1 keeps
 * earningsTraversalVerifyL4CIV1.mjs separate: the traversal verifier imports
 * every sibling verifier, and folding it into the materialization builder would
 * make the builder depend on the whole verifier surface and risk an import
 * cycle with the classification report module.
 *
 * Every object is read by direct id. No directory listing, no glob, no "latest"
 * lookup and no CAS-wide scan is performed - the work is proportional to the
 * ids the pinned closure actually names.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertPlainObject,
  assertStore,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_TRAVERSAL_EDGES_V1,
  verifyEarningsSnapshotTraversalV1,
} from './earningsTraversalVerifyL4CIV1.mjs';
import {
  EARNINGS_STORE_METHODS,
  assertExplicitPinnedEarningsIdV1,
} from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsEventIdentityCore } from './earningsEventIdentityL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifyEarningsMetricExtractionReport } from './earningsMetricExtractionReportL4CIV1.mjs';
import { verifyEarningsMetricObservationCore } from './earningsMetricObservationL4CIV1.mjs';
import { verifyFinancialPeriodIdentityCore } from './earningsFinancialPeriodL4CIV1.mjs';
import { verifySecFilingSourceDocument } from './earningsSecFilingSourceDocumentL4CIV1.mjs';
import { verifyEarningsSecDocumentBytes } from './earningsSecDocumentBytesL4CIV1.mjs';
import { verifyEarningsTaxonomyBundleManifest } from './earningsTaxonomyBundleL4CIV1.mjs';
import { verifyEarningsMetricExtractionPolicy } from './earningsMetricExtractionPolicyL4CIV1.mjs';
import { verifyEarningsIngestionPolicy } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsAsOfResolutionPolicy } from './earningsAsOfResolutionPolicyL4CIIV1.mjs';
import { verifyEarningsFiscalClassificationPolicy } from './earningsFiscalClassificationPolicyL4CIIV1.mjs';
import { verifyEarningsDatasetBinding } from './earningsDatasetBindingL4CIIV1.mjs';
import { verifyEarningsAsOfMaterializationReport } from './earningsAsOfMaterializationL4CIIV1.mjs';
import { verifyEarningsFiscalPeriodClassificationCore } from './earningsFiscalClassificationL4CIIV1.mjs';
import { verifyEarningsFiscalClassificationReport } from './earningsFiscalClassificationReportL4CIIV1.mjs';

/** Edges 36..68 of the combined graph: the L4C-I2 half. */
export const EARNINGS_I2_TRAVERSAL_EDGES_V1 = Object.freeze([
  ['EarningsDatasetBinding/1', 'earningsDatasetSnapshotManifestId', 'EarningsDatasetSnapshotManifest/1'],
  ['EarningsDatasetBinding/1', 'earningsEventSetManifestId', 'EarningsEventSetManifest/1'],
  ['EarningsDatasetBinding/1', 'earningsRevisionSetManifestId', 'EarningsRevisionSetManifest/1'],
  ['EarningsDatasetBinding/1', 'earningsExtractionSetManifestId', 'EarningsExtractionSetManifest/1'],
  ['EarningsDatasetBinding/1', 'earningsIngestionPolicyId', 'EarningsIngestionPolicy/1'],
  ['EarningsDatasetBinding/1', 'earningsMetricExtractionPolicyId', 'EarningsMetricExtractionPolicy/1'],
  ['EarningsDatasetBinding/1', 'earningsTaxonomyBundleManifestId', 'EarningsTaxonomyBundleManifest/1'],
  ['EarningsDatasetBinding/1', 'earningsAsOfResolutionPolicyId', 'EarningsAsOfResolutionPolicy/1'],
  ['EarningsDatasetBinding/1', 'earningsFiscalClassificationPolicyId', 'EarningsFiscalClassificationPolicy/1'],
  ['EarningsDatasetBinding/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsAsOfMaterializationReport/1', 'earningsDatasetBindingId', 'EarningsDatasetBinding/1'],
  ['EarningsAsOfMaterializationReport/1', 'earningsDatasetSnapshotManifestId', 'EarningsDatasetSnapshotManifest/1'],
  ['EarningsAsOfMaterializationReport/1', 'earningsAsOfResolutionPolicyId', 'EarningsAsOfResolutionPolicy/1'],
  ['EarningsAsOfMaterializationReport/1', 'earningsFiscalClassificationPolicyId', 'EarningsFiscalClassificationPolicy/1'],
  ['EarningsAsOfMaterializationReport/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsAsOfMaterializationReport/1', 'earningsIngestionPolicyId', 'EarningsIngestionPolicy/1'],
  ['EarningsAsOfMaterializationReport/1', 'earningsMetricExtractionPolicyId', 'EarningsMetricExtractionPolicy/1'],
  ['EarningsAsOfMaterializationReport/1', 'earningsTaxonomyBundleManifestId', 'EarningsTaxonomyBundleManifest/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedVisibleEventIdentityIds[]', 'EarningsEventIdentityCore/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedVisibleRevisionIdentityIds[]', 'EarningsRevisionIdentityCore/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedVisibleExtractionReportIds[]', 'EarningsMetricExtractionReport/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedVisibleMetricObservationIds[]', 'EarningsMetricObservationCore/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedVisibleRawPeriodIds[]', 'FinancialPeriodIdentityCore/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedFiscalClassificationIds[]', 'EarningsFiscalPeriodClassificationCore/1'],
  ['EarningsAsOfMaterializationReport/1', 'orderedFiscalClassificationReportIds[]', 'EarningsFiscalClassificationReport/1'],
  ['EarningsFiscalClassificationReport/1', 'earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsFiscalClassificationReport/1', 'earningsFiscalClassificationPolicyId', 'EarningsFiscalClassificationPolicy/1'],
  ['EarningsFiscalClassificationReport/1', 'transformImplementationManifestId', 'TransformImplementationManifest/2'],
  ['EarningsFiscalClassificationReport/1', 'sourceFilingDocumentId', 'SecFilingSourceDocumentCore/1'],
  ['EarningsFiscalClassificationReport/1', 'orderedFiscalPeriodClassificationIds[]', 'EarningsFiscalPeriodClassificationCore/1'],
  ['EarningsFiscalPeriodClassificationCore/1', 'earningsRevisionIdentityId', 'EarningsRevisionIdentityCore/1'],
  ['EarningsFiscalPeriodClassificationCore/1', 'financialPeriodIdentityId', 'FinancialPeriodIdentityCore/1'],
  ['EarningsFiscalPeriodClassificationCore/1', 'fiscalMetadataSourceDocumentBytesId', 'SecDocumentBytesCore/1'],
]);

export const EARNINGS_I2_TRAVERSAL_EDGE_COUNT_V1 = 33;

/** The full graph the L4C-I2 answer closes: 35 L4C-I1 edges + 33 L4C-I2 edges. */
export const EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1 = Object.freeze([
  ...EARNINGS_TRAVERSAL_EDGES_V1, ...EARNINGS_I2_TRAVERSAL_EDGES_V1,
]);

export const EARNINGS_MATERIALIZATION_TRAVERSAL_EDGE_COUNT_V1 = 68;

/** Re-raise the edge's own fail-closed code instead of a generic wrapper. */
function walkEdge(code, message, walk) {
  try {
    return walk();
  } catch (cause) {
    if (cause instanceof MarketDataL3Error && cause.code === code) throw cause;
    if (cause?.code === 'EARNINGS_CAS_GLOBAL_SCAN_FORBIDDEN') throw cause;
    throw new MarketDataL3Error(code, message, { cause });
  }
}

/**
 * Verify the transitive closure of one pinned materialization report.
 *
 * @param {{
 *   store: unknown,
 *   earningsAsOfMaterializationReportId: string,
 *   labRoot?: string|null
 * }} input
 */
export function verifyEarningsMaterializationTraversalV1(input) {
  // labRoot is optional: supplying it re-verifies the transform module source
  // pins, exactly as the L4C-I1 traversal does.
  const raw = assertPlainObject(input);
  const labRoot = Object.hasOwn(raw, 'labRoot') ? raw.labRoot : null;
  const api = assertApiInput({ ...raw, labRoot },
    ['earningsAsOfMaterializationReportId', 'labRoot']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  assertExplicitPinnedEarningsIdV1(api.earningsAsOfMaterializationReportId,
    'earningsAsOfMaterializationReportId');
  assertCasId(api.earningsAsOfMaterializationReportId, 'earningsAsOfMaterializationReportId');

  const closure = new Set([api.earningsAsOfMaterializationReportId]);
  const store = api.store;

  const report = walkEdge('EARNINGS_MATERIALIZATION_MISSING',
    'materialization report is missing or diverges from its recomputation',
    () => verifyEarningsAsOfMaterializationReport({
      store, earningsAsOfMaterializationReportId: api.earningsAsOfMaterializationReportId,
    }).earningsAsOfMaterializationReport);

  // --- edge 46: report -> binding, then edges 36..45 of the binding ----------
  const bindingContext = walkEdge('EARNINGS_BINDING_MISSING',
    'materialization binding is missing or corrupt',
    () => verifyEarningsDatasetBinding({
      store, earningsDatasetBindingId: report.earningsDatasetBindingId,
    }));
  const binding = bindingContext.earningsDatasetBinding;
  closure.add(report.earningsDatasetBindingId);
  for (const field of ['earningsDatasetSnapshotManifestId', 'earningsEventSetManifestId',
    'earningsRevisionSetManifestId', 'earningsExtractionSetManifestId',
    'earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
    'earningsTaxonomyBundleManifestId', 'earningsAsOfResolutionPolicyId',
    'earningsFiscalClassificationPolicyId', 'transformImplementationManifestId']) {
    closure.add(binding[field]);
  }

  // The L4C-I1 half: 35 edges, including the transform source pins when a
  // labRoot is supplied.
  const snapshotClosure = walkEdge('EARNINGS_CLOSURE_REFERENCE_MISSING',
    'snapshot transitive closure is incomplete or corrupt',
    () => verifyEarningsSnapshotTraversalV1({
      store,
      earningsDatasetSnapshotManifestId: binding.earningsDatasetSnapshotManifestId,
      labRoot,
    }));
  for (const objectId of snapshotClosure.closureObjectIds) closure.add(objectId);

  // --- edges 40..44, 48..53: every pinned policy resolves by direct id ------
  walkEdge('EARNINGS_AS_OF_POLICY_MISSING', 'pinned as-of resolution policy is unreadable',
    () => verifyEarningsAsOfResolutionPolicy({
      store, earningsAsOfResolutionPolicyId: report.earningsAsOfResolutionPolicyId,
    }));
  walkEdge('EARNINGS_FISCAL_POLICY_MISSING', 'pinned fiscal classification policy is unreadable',
    () => verifyEarningsFiscalClassificationPolicy({
      store, earningsFiscalClassificationPolicyId: report.earningsFiscalClassificationPolicyId,
    }));
  walkEdge('EARNINGS_MATERIALIZATION_INVALID', 'pinned ingestion policy is unreadable',
    () => verifyEarningsIngestionPolicy({
      store, earningsIngestionPolicyId: report.earningsIngestionPolicyId,
    }));
  walkEdge('EARNINGS_MATERIALIZATION_INVALID', 'pinned metric extraction policy is unreadable',
    () => verifyEarningsMetricExtractionPolicy({
      store, earningsMetricExtractionPolicyId: report.earningsMetricExtractionPolicyId,
    }));
  walkEdge('EARNINGS_MATERIALIZATION_INVALID', 'pinned taxonomy bundle is unreadable',
    () => verifyEarningsTaxonomyBundleManifest({
      store, earningsTaxonomyBundleManifestId: report.earningsTaxonomyBundleManifestId,
    }));
  for (const field of ['earningsDatasetSnapshotManifestId', 'earningsAsOfResolutionPolicyId',
    'earningsFiscalClassificationPolicyId', 'transformImplementationManifestId',
    'earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
    'earningsTaxonomyBundleManifestId']) {
    closure.add(report[field]);
  }

  // --- edges 54..58: the visible closure, read by direct id ----------------
  for (const eventIdentityId of report.orderedVisibleEventIdentityIds) {
    walkEdge('EARNINGS_CLOSURE_REFERENCE_MISSING', 'visible event identity is unreachable',
      () => verifyEarningsEventIdentityCore({ store, eventIdentityId }));
    closure.add(eventIdentityId);
  }
  const visibleRevisionIds = new Set(report.orderedVisibleRevisionIdentityIds);
  for (const earningsRevisionIdentityId of report.orderedVisibleRevisionIdentityIds) {
    walkEdge('EARNINGS_CLOSURE_REFERENCE_MISSING', 'visible revision identity is unreachable',
      () => verifyEarningsRevisionIdentityCore({ store, earningsRevisionIdentityId }));
    closure.add(earningsRevisionIdentityId);
  }
  for (const earningsMetricExtractionReportId of report.orderedVisibleExtractionReportIds) {
    walkEdge('EARNINGS_CLOSURE_REFERENCE_MISSING', 'visible extraction report is unreachable',
      () => verifyEarningsMetricExtractionReport({ store, earningsMetricExtractionReportId }));
    closure.add(earningsMetricExtractionReportId);
  }
  for (const earningsMetricObservationId of report.orderedVisibleMetricObservationIds) {
    walkEdge('EARNINGS_CLOSURE_REFERENCE_MISSING', 'visible metric observation is unreachable',
      () => verifyEarningsMetricObservationCore({ store, earningsMetricObservationId }));
    closure.add(earningsMetricObservationId);
  }
  for (const financialPeriodIdentityId of report.orderedVisibleRawPeriodIds) {
    walkEdge('EARNINGS_PERIOD_MISSING', 'visible raw period is unreachable',
      () => verifyFinancialPeriodIdentityCore({ store, financialPeriodIdentityId }));
    closure.add(financialPeriodIdentityId);
  }

  // --- edges 59, 66..68: every classification core and its three references --
  const walkClassification = (earningsFiscalPeriodClassificationId) => {
    const core = walkEdge('EARNINGS_FISCAL_CLASSIFICATION_MISSING',
      'fiscal period classification is unreachable',
      () => verifyEarningsFiscalPeriodClassificationCore({
        store, earningsFiscalPeriodClassificationId,
      }).earningsFiscalPeriodClassification);
    closure.add(earningsFiscalPeriodClassificationId);
    if (!visibleRevisionIds.has(core.earningsRevisionIdentityId)) {
      throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_ORPHAN',
        'classification references a revision outside the materialized visible set');
    }
    walkEdge('EARNINGS_REVISION_IDENTITY_MISSING', 'classification revision identity is unreachable',
      () => verifyEarningsRevisionIdentityCore({
        store, earningsRevisionIdentityId: core.earningsRevisionIdentityId,
      }));
    walkEdge('EARNINGS_PERIOD_MISSING', 'classification raw period is unreachable',
      () => verifyFinancialPeriodIdentityCore({
        store, financialPeriodIdentityId: core.financialPeriodIdentityId,
      }));
    walkEdge('EARNINGS_SOURCE_BYTES_MISMATCH', 'classification metadata source bytes are unreachable',
      () => verifyEarningsSecDocumentBytes({
        store, secDocumentBytesId: core.fiscalMetadataSourceDocumentBytesId,
      }));
    closure.add(core.earningsRevisionIdentityId);
    closure.add(core.financialPeriodIdentityId);
    closure.add(core.fiscalMetadataSourceDocumentBytesId);
    return core;
  };
  for (const classificationId of report.orderedFiscalClassificationIds) {
    walkClassification(classificationId);
  }

  // --- edges 60..65: every classification report and its five references ----
  const declaredClassificationIds = new Set(report.orderedFiscalClassificationIds);
  for (const earningsFiscalClassificationReportId of report.orderedFiscalClassificationReportIds) {
    const classificationReport = walkEdge('EARNINGS_FISCAL_REPORT_MISSING',
      'fiscal classification report is unreachable',
      // diagnostics stays undefined on purpose: the per-revision diagnostic set
      // is not part of the traversal, and the report's digest form is already
      // enforced by its normalizer and recomputed by the materialization verifier.
      () => verifyEarningsFiscalClassificationReport({
        store, earningsFiscalClassificationReportId, diagnostics: undefined,
      }).earningsFiscalClassificationReport);
    closure.add(earningsFiscalClassificationReportId);
    walkEdge('EARNINGS_REVISION_IDENTITY_MISSING', 'report revision identity is unreachable',
      () => verifyEarningsRevisionIdentityCore({
        store, earningsRevisionIdentityId: classificationReport.earningsRevisionIdentityId,
      }));
    walkEdge('EARNINGS_FISCAL_POLICY_MISSING', 'report fiscal policy is unreachable',
      () => verifyEarningsFiscalClassificationPolicy({
        store,
        earningsFiscalClassificationPolicyId:
          classificationReport.earningsFiscalClassificationPolicyId,
      }));
    walkEdge('EARNINGS_SOURCE_DOCUMENT_MISSING', 'report source filing document is unreachable',
      () => verifySecFilingSourceDocument({
        store, sourceFilingDocumentId: classificationReport.sourceFilingDocumentId,
      }));
    closure.add(classificationReport.earningsRevisionIdentityId);
    closure.add(classificationReport.earningsFiscalClassificationPolicyId);
    closure.add(classificationReport.transformImplementationManifestId);
    closure.add(classificationReport.sourceFilingDocumentId);
    for (const classificationId of classificationReport.orderedFiscalPeriodClassificationIds) {
      if (!declaredClassificationIds.has(classificationId)) {
        throw new MarketDataL3Error('EARNINGS_FISCAL_CLASSIFICATION_MISSING',
          'report classification is absent from the materialized classification set');
      }
      walkClassification(classificationId);
    }
  }

  return {
    verified: true,
    edgeCount: EARNINGS_MATERIALIZATION_TRAVERSAL_EDGES_V1.length,
    l4cI1EdgeCount: EARNINGS_TRAVERSAL_EDGES_V1.length,
    l4cI2EdgeCount: EARNINGS_I2_TRAVERSAL_EDGES_V1.length,
    closureObjectIds: [...closure].sort(),
  };
}
