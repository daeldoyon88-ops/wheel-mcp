/** Closed US-GAAP/DEI taxonomy bundle pinned through document-bytes cores. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  canonicalValuesEqual,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_TAXONOMY_AUTHORITY,
  EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION,
  earningsOrderedTaxonomyComponentDigestV1,
  normalizeEarningsTaxonomyBundleManifestV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsSecDocumentBytes } from './earningsSecDocumentBytesL4CIV1.mjs';

function expected(ids) {
  return normalizeEarningsTaxonomyBundleManifestV1({
    schemaVersion: EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION,
    taxonomyAuthority: EARNINGS_TAXONOMY_AUTHORITY,
    orderedComponentDocumentIds: ids,
    orderedComponentDigest: earningsOrderedTaxonomyComponentDigestV1(ids),
  });
}

export function buildEarningsTaxonomyBundleManifest(input) {
  const api = assertApiInput(input, ['orderedComponentDocumentIds']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  for (const id of api.orderedComponentDocumentIds) {
    verifyEarningsSecDocumentBytes({ store: api.store, secDocumentBytesId: id });
  }
  const stored = putCanonicalL3(api.store, EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION,
    expected(api.orderedComponentDocumentIds));
  return { earningsTaxonomyBundleManifestId: stored.objectId,
    earningsTaxonomyBundleManifest: stored.value };
}

export function verifyEarningsTaxonomyBundleManifest(input) {
  const api = assertApiInput(input, ['earningsTaxonomyBundleManifestId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let bundle;
  try {
    bundle = normalizeEarningsTaxonomyBundleManifestV1(readTypedReference(api.store,
      api.earningsTaxonomyBundleManifestId,
      EARNINGS_TAXONOMY_BUNDLE_MANIFEST_SCHEMA_VERSION, 'earnings taxonomy bundle'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_TAXONOMY_BUNDLE_MISSING',
      'taxonomy bundle is missing or corrupt', { cause });
  }
  for (const id of bundle.orderedComponentDocumentIds) {
    verifyEarningsSecDocumentBytes({ store: api.store, secDocumentBytesId: id });
  }
  if (!canonicalValuesEqual(bundle, expected(bundle.orderedComponentDocumentIds))) {
    throw new MarketDataL3Error('EARNINGS_TAXONOMY_DIGEST_MISMATCH',
      'taxonomy component digest diverges');
  }
  return { earningsTaxonomyBundleManifestId: api.earningsTaxonomyBundleManifestId,
    earningsTaxonomyBundleManifest: bundle };
}
