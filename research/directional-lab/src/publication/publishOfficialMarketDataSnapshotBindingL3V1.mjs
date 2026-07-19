/**
 * L3-I6 — official publication orchestration for MarketDataDatasetSnapshotBinding.
 *
 * Single closed entrypoint that verifies the pinned binding registry, the I5
 * materialization report, the L1 snapshot and the L2A quality assessment, then
 * appends exactly one binding. No tip-of-CAS search, no network, no scanner.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
  MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
} from '../contracts/marketDataSnapshotMaterializationL3V1.mjs';
import {
  appendMarketDataDatasetSnapshotBindingRegistry,
  bindingPublicationKeysEqual,
  buildMarketDataDatasetSnapshotBinding,
  deriveBindingPublicationKey,
  tipForBindingPublicationKey,
  verifyMarketDataDatasetSnapshotBinding,
  verifyMarketDataDatasetSnapshotBindingAuthorityPolicy,
  verifyMarketDataDatasetSnapshotBindingRegistry,
} from '../contracts/marketDataDatasetSnapshotBindingL3V1.mjs';
import { verifyMaterializedMarketDataSnapshot } from '../materialization/materializeMarketDataSnapshotL3V1.mjs';
import { verifyDatasetQualityAssessment } from '../data/assessDatasetSnapshotQuality.mjs';
import { verifySnapshotDatasetManifest } from '../data/buildSnapshotDatasetManifest.mjs';

const STORE_METHODS = Object.freeze([
  'putCanonicalObject', 'readCanonicalObject', 'uriForObject', 'readObject', 'putSourceBytes',
]);

/**
 * Publish one official snapshot binding under an explicitly pinned registry.
 *
 * Preferred idempotence: when the tip under the base pin already closes the
 * exact same materialization report and quality assessment, return that tip
 * and the base registry without creating an artificial new version.
 *
 * @param {unknown} input
 */
export function publishOfficialMarketDataSnapshotBinding(input) {
  const api = assertApiInput(input, [
    'baseBindingRegistryManifestId',
    'expectedParentBindingId',
    'materializationReportId',
    'qualityAssessmentId',
  ]);
  assertStore(api.store, STORE_METHODS);
  assertCasId(api.baseBindingRegistryManifestId, 'baseBindingRegistryManifestId');
  assertCasId(api.expectedParentBindingId, 'expectedParentBindingId', true);
  assertCasId(api.materializationReportId, 'materializationReportId');
  if (api.qualityAssessmentId === null || api.qualityAssessmentId === undefined) {
    throw new MarketDataL3Error(
      'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED',
      'official snapshot binding requires a verifiable L2A quality assessment',
    );
  }
  assertCasId(api.qualityAssessmentId, 'qualityAssessmentId');

  // 1. verify the base registry
  const { bindingRegistryManifest: base } = verifyMarketDataDatasetSnapshotBindingRegistry({
    store: api.store,
    bindingRegistryManifestId: api.baseBindingRegistryManifestId,
  });

  // 2. verify the authority policy
  verifyMarketDataDatasetSnapshotBindingAuthorityPolicy({
    store: api.store,
    bindingAuthorityPolicyId: base.bindingAuthorityPolicyId,
  });

  // 4–6 first derive report/quality targets needed for the publication key
  // (parent check needs the key; key comes only from referenced objects).
  const report = readTypedReference(
    api.store,
    api.materializationReportId,
    MARKET_DATA_SNAPSHOT_MATERIALIZATION_REPORT_SCHEMA_VERSION,
    'materialization report',
  );
  const sourceBundle = readTypedReference(
    api.store,
    report.snapshotSourceBundleId,
    MARKET_DATA_SNAPSHOT_SOURCE_BUNDLE_SCHEMA_VERSION,
    'snapshot source bundle',
  );
  const publicationKey = deriveBindingPublicationKey(sourceBundle, report.materializationPolicyId);

  // Preferred idempotence before stale-parent refusal.
  const tipId = tipForBindingPublicationKey(base, publicationKey);
  if (tipId !== null) {
    const { binding: tipBinding } = verifyMarketDataDatasetSnapshotBinding({
      store: api.store,
      bindingId: tipId,
    });
    if (tipBinding.materializationReportId === api.materializationReportId
        && tipBinding.qualityAssessmentId === api.qualityAssessmentId
        && bindingPublicationKeysEqual(tipBinding.bindingPublicationKey, publicationKey)) {
      if (api.expectedParentBindingId !== tipBinding.supersedesBindingId) {
        throw new MarketDataL3Error(
          'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
          'idempotent replay expectedParentBindingId diverges from the tip supersedes chain',
        );
      }
      return {
        bindingId: tipId,
        bindingRegistryManifestId: api.baseBindingRegistryManifestId,
        noop: true,
      };
    }
  }

  // 3. verify the expected parent for the publication key
  if (tipId !== api.expectedParentBindingId) {
    if (api.expectedParentBindingId === null && tipId !== null) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'publication key already has a tip; expectedParentBindingId is required',
      );
    }
    if (api.expectedParentBindingId !== null && tipId === null) {
      throw new MarketDataL3Error(
        'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
        'expected parent but publication key has no tip under the pinned registry',
      );
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_CONFLICT',
      'expectedParentBindingId is not the tip under the pinned registry',
    );
  }

  // 4. verify the materialization report I5 completely
  verifyMaterializedMarketDataSnapshot({
    store: api.store,
    ingestionRegistryManifestId: sourceBundle.contributingRegistryPrefixId,
    materializationReportId: api.materializationReportId,
  });

  // 5. verify the L1 snapshot completely (via report → dataset manifest)
  const datasetManifest = verifySnapshotDatasetManifest({
    store: api.store,
    snapshotDatasetManifestId: report.datasetSnapshotManifestId,
  });

  // 6. verify the L2A quality assessment completely
  let quality;
  try {
    quality = verifyDatasetQualityAssessment({
      store: api.store,
      qualityAssessmentRecordId: api.qualityAssessmentId,
    });
  } catch (cause) {
    const code = /** @type {{code?: string}} */ (cause)?.code ?? '';
    if (code.includes('MISSING') || code === 'QUALITY_ASSESSMENT_INVALID') {
      throw new MarketDataL3Error(
        'MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED',
        'quality assessment is missing or not a verifiable L2A record',
        { cause },
      );
    }
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'quality assessment failed L2A verification',
      { cause },
    );
  }
  if (quality.qualityCore.snapshotCoreId !== datasetManifest.manifest.snapshotCoreId) {
    throw new MarketDataL3Error(
      'MARKET_DATA_SNAPSHOT_BINDING_INVALID',
      'quality assessment targets another snapshot',
    );
  }

  // 7–9. derive publication key (already done), build + verify binding
  const built = buildMarketDataDatasetSnapshotBinding({
    store: api.store,
    baseBindingRegistryManifestId: api.baseBindingRegistryManifestId,
    expectedParentBindingId: api.expectedParentBindingId,
    materializationReportId: api.materializationReportId,
    qualityAssessmentId: api.qualityAssessmentId,
  });
  verifyMarketDataDatasetSnapshotBinding({
    store: api.store,
    bindingId: built.bindingId,
  });

  // 10–11. append exactly this binding and re-verify the new registry
  const appended = appendMarketDataDatasetSnapshotBindingRegistry({
    store: api.store,
    baseBindingRegistryManifestId: api.baseBindingRegistryManifestId,
    expectedParentBindingId: api.expectedParentBindingId,
    bindingId: built.bindingId,
  });
  const registryId = appended.bindingRegistryManifestId;
  verifyMarketDataDatasetSnapshotBindingRegistry({
    store: api.store,
    bindingRegistryManifestId: registryId,
  });

  // 12. return both IDs
  return {
    bindingId: built.bindingId,
    bindingRegistryManifestId: registryId,
    noop: appended.noop === true,
  };
}
