/** Fabricated, offline L4C-I1 SEC/XBRL fixtures. No value is real market data. */

import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createContentAddressedStore } from '../src/storage/contentAddressedStoreV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../src/data/transformImplementationManifestV2.mjs';
import { putEarningsSecDocumentBytes } from '../src/earnings/earningsSecDocumentBytesL4CIV1.mjs';
import { buildSecFilingSourceDocument } from '../src/earnings/earningsSecFilingSourceDocumentL4CIV1.mjs';
import { buildEarningsTaxonomyBundleManifest } from '../src/earnings/earningsTaxonomyBundleL4CIV1.mjs';
import { ingestEarningsDatasetL4CIV1 } from '../src/earnings/earningsIngestionPipelineL4CIV1.mjs';

export function code(expected) {
  return (error) => error?.code === expected;
}

export function withEarningsStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-l4c-i1-'));
  try { return fn(createContentAddressedStore({ root }), root); } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const withStore = withEarningsStore;

export function syntheticXbrlXml({
  cik = '1234567890',
  periodStart = '2026-01-01',
  periodEnd = '2026-03-31',
  eps = '1.25',
  revenue = '125000000',
  includeMetrics = true,
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
 xmlns:xbrli="http://www.xbrl.org/2003/instance"
 xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
 xmlns:us-gaap="http://fasb.org/us-gaap/2025"
 xmlns:dei="http://xbrl.sec.gov/dei/2025">
 <context id="D1"><entity><identifier scheme="http://www.sec.gov/CIK">${cik}</identifier></entity>
  <period><startDate>${periodStart}</startDate><endDate>${periodEnd}</endDate></period></context>
 <context id="I1"><entity><identifier scheme="http://www.sec.gov/CIK">${cik}</identifier></entity>
  <period><instant>${periodEnd}</instant></period></context>
 <unit id="USD"><measure>iso4217:USD</measure></unit>
 <unit id="USDPS"><divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator>
  <unitDenominator><measure>xbrli:shares</measure></unitDenominator></divide></unit>
 <dei:DocumentPeriodEndDate contextRef="I1">${periodEnd}</dei:DocumentPeriodEndDate>
 ${includeMetrics ? `<us-gaap:EarningsPerShareDiluted contextRef="D1" unitRef="USDPS" decimals="2">${eps}</us-gaap:EarningsPerShareDiluted>
 <us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax contextRef="D1" unitRef="USD" decimals="0">${revenue}</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>` : ''}
</xbrl>`;
}

const FILINGS = Object.freeze({
  '8-K': Object.freeze({
    filerCik: '1234567890', accessionNumber: '1234567890-26-000001',
    formType: '8-K', items: ['2.02'], acceptanceDatetimeRaw: '20260423160530',
    amendmentFlag: false, amendsFilingAccessionNumber: null,
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
  }),
  '10-Q': Object.freeze({
    filerCik: '1234567890', accessionNumber: '1234567890-26-000002',
    formType: '10-Q', items: [], acceptanceDatetimeRaw: '20260507163015',
    amendmentFlag: false, amendsFilingAccessionNumber: null,
    periodStart: '2026-01-01', periodEnd: '2026-03-31',
  }),
  '10-K/A': Object.freeze({
    filerCik: '1234567890', accessionNumber: '1234567890-26-000003',
    formType: '10-K/A', items: [], acceptanceDatetimeRaw: '20260301120000',
    amendmentFlag: true, amendsFilingAccessionNumber: '1234567890-26-000000',
    periodStart: '2025-01-01', periodEnd: '2025-12-31',
  }),
});

export function syntheticFilingDefinition(formType = '8-K', overrides = {}) {
  if (!FILINGS[formType]) throw new Error(`unknown synthetic form ${formType}`);
  return { ...structuredClone(FILINGS[formType]), ...overrides };
}

export const synthetic8KFiling = (overrides = {}) => syntheticFilingDefinition('8-K', overrides);
export const synthetic10QFiling = (overrides = {}) => syntheticFilingDefinition('10-Q', overrides);
export const synthetic10KAFiling = (overrides = {}) => syntheticFilingDefinition('10-K/A', overrides);

export function pinSyntheticEarningsFiling(store, definition) {
  const xml = syntheticXbrlXml(definition);
  const document = putEarningsSecDocumentBytes({
    store, bytes: Buffer.from(xml), mediaType: 'application/xml',
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

export function pinEarningsTransformImplementationManifestV2(store) {
  const labRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const manifest = buildTransformImplementationManifestV2({
    labRoot,
    logicalPaths: [
      'src/contracts/earningsContractsL4CIV1.mjs',
      'src/earnings/earningsXbrlExtractionL4CIV1.mjs',
      'src/earnings/earningsIngestionPipelineL4CIV1.mjs',
    ],
    runtimeContractVersion: 'NODE_L4C_I1_V1',
  });
  const stored = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    value: manifest,
  });
  return { transformImplementationManifestId: stored.objectId,
    transformImplementationManifest: stored.value, labRoot };
}

export function pinSyntheticTaxonomyBundle(store) {
  const component = putEarningsSecDocumentBytes({
    store,
    bytes: Buffer.from('<schema xmlns="http://www.w3.org/2001/XMLSchema"/>'),
    mediaType: 'application/xml', documentFormat: 'XML', documentRole: 'TAXONOMY_SCHEMA',
  });
  return buildEarningsTaxonomyBundleManifest({
    store, orderedComponentDocumentIds: [component.secDocumentBytesId],
  });
}

export function withOfficialEarningsL4CI1Fixture(callback) {
  return withEarningsStore((store, root) => {
    const transform = pinEarningsTransformImplementationManifestV2(store);
    const taxonomy = pinSyntheticTaxonomyBundle(store);
    const filings = [
      pinSyntheticEarningsFiling(store, synthetic8KFiling()),
      pinSyntheticEarningsFiling(store, synthetic10QFiling()),
      pinSyntheticEarningsFiling(store, synthetic10KAFiling()),
    ];
    const pipeline = ingestEarningsDatasetL4CIV1({
      store,
      sourceFilingDocumentIds: filings.map((item) => item.sourceFilingDocumentId),
      transformImplementationManifestId: transform.transformImplementationManifestId,
      earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
      previousSnapshotId: null,
    });
    return callback({ store, root, transform, taxonomy, filings, pipeline });
  });
}

export function withEmptyEarningsL4CI1Fixture(callback) {
  return withEarningsStore((store, root) => {
    const transform = pinEarningsTransformImplementationManifestV2(store);
    const taxonomy = pinSyntheticTaxonomyBundle(store);
    const pipeline = ingestEarningsDatasetL4CIV1({
      store, sourceFilingDocumentIds: [],
      transformImplementationManifestId: transform.transformImplementationManifestId,
      earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
      previousSnapshotId: null,
    });
    return callback({ store, root, transform, taxonomy, pipeline });
  });
}
