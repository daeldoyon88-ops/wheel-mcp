/**
 * Fabricated, offline L4C-I2 fiscal fixtures. No value is real market data.
 *
 * The shipped L4C-I1 fixture emits dei:DocumentPeriodEndDate only and never a
 * fiscal focus, so it cannot exercise a single L4C-I2 classification rule. This
 * fixture adds the DEI focus tags and multi-duration filings the fiscal
 * doctrine is defined over, without touching the L4C-I1 fixture bytes.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
} from '../src/data/transformImplementationManifestV2.mjs';
import { putEarningsSecDocumentBytes } from '../src/earnings/earningsSecDocumentBytesL4CIV1.mjs';
import { buildSecFilingSourceDocument } from '../src/earnings/earningsSecFilingSourceDocumentL4CIV1.mjs';
import { ingestEarningsDatasetL4CIV1 } from '../src/earnings/earningsIngestionPipelineL4CIV1.mjs';
import { buildEarningsAsOfResolutionPolicy } from '../src/earnings/earningsAsOfResolutionPolicyL4CIIV1.mjs';
import { buildEarningsFiscalClassificationPolicy } from '../src/earnings/earningsFiscalClassificationPolicyL4CIIV1.mjs';
import { buildEarningsDatasetBinding } from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import { buildEarningsAsOfMaterializationReport } from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { resolveEarningsAsOfV1 } from '../src/earnings/resolveEarningsAsOfL4CIIV1.mjs';
import {
  classifyEarningsFiscalPeriodsForRevisionV1,
  verifyEarningsFiscalPeriodClassificationCore,
} from '../src/earnings/earningsFiscalClassificationL4CIIV1.mjs';
import { withEarningsStore, pinSyntheticTaxonomyBundle } from './earningsIngestionL4CISyntheticFixture.mjs';

export { withEarningsStore, pinSyntheticTaxonomyBundle };
export { code } from './earningsIngestionL4CISyntheticFixture.mjs';

/**
 * A cutoff strictly after every filing this fixture can pin, including the
 * Q4 and fiscal-year filings whose SEC acceptance times fall in 2027.
 */
export const L4C_I2_CUTOFF_AFTER_ALL = '2027-12-31T00:00:00.000Z';
/** A cutoff strictly before the first fixture filing. */
export const L4C_I2_CUTOFF_BEFORE_ALL = '2020-01-01T00:00:00.000Z';

/**
 * The three publicAvailableAt instants of the three-filing fixture, derived by
 * secAcceptanceDatetimeToUtcV1 from the pinned SEC acceptance times. They are
 * the only admissible cutoff boundaries for the cutoff suite.
 *
 *   fyTenKA   20260301120000 America/New_York -> 2026-03-01T17:00:00.000Z
 *   q1EightK  20260423160530 America/New_York -> 2026-04-23T20:05:30.000Z
 *   q1TenQ    20260507163015 America/New_York -> 2026-05-07T20:30:15.000Z
 */
export const L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT = Object.freeze({
  fyTenKA: '2026-03-01T17:00:00.000Z',
  q1EightK: '2026-04-23T20:05:30.000Z',
  q1TenQ: '2026-05-07T20:30:15.000Z',
});

/** The runtime contract the L4C-I2 transform manifest declares. */
export const L4C_I2_RUNTIME_CONTRACT_VERSION = 'NODE_L4C_I2_V1';

/** The L4C-I2 module set the I2 transform manifest pins. */
export const L4C_I2_TRANSFORM_LOGICAL_PATHS = Object.freeze([
  'src/contracts/earningsContractsL4CIIV1.mjs',
  'src/earnings/earningsAsOfResolutionPolicyL4CIIV1.mjs',
  'src/earnings/earningsFiscalClassificationPolicyL4CIIV1.mjs',
  'src/earnings/earningsFiscalMetadataL4CIIV1.mjs',
  'src/earnings/earningsFiscalClassificationL4CIIV1.mjs',
  'src/earnings/earningsFiscalClassificationReportL4CIIV1.mjs',
  'src/earnings/resolveEarningsAsOfL4CIIV1.mjs',
  'src/earnings/earningsDatasetBindingL4CIIV1.mjs',
  'src/earnings/earningsAsOfMaterializationL4CIIV1.mjs',
  'src/earnings/earningsMaterializationTraversalL4CIIV1.mjs',
]);

export function l4cI2LabRoot() {
  return resolve(fileURLToPath(new URL('../', import.meta.url)));
}

/**
 * Build one XBRL instance with explicit DEI fiscal metadata.
 *
 * @param {{
 *   cik?: string,
 *   documentPeriodEndDate?: string|null,
 *   documentFiscalPeriodFocus?: string|null,
 *   documentFiscalYearFocus?: string|null,
 *   documentType?: string|null,
 *   durations?: {start: string, end: string, eps?: string, revenue?: string}[],
 *   instants?: string[],
 *   repeatedFocusValues?: string[]
 * }} [options]
 */
export function syntheticFiscalXbrlXml({
  cik = '1234567890',
  documentPeriodEndDate = '2026-03-31',
  documentFiscalPeriodFocus = 'Q1',
  documentFiscalYearFocus = '2026',
  documentType = '8-K',
  durations = [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
  instants = [],
  repeatedFocusValues = [],
} = {}) {
  const contexts = [];
  const facts = [];
  durations.forEach((duration, index) => {
    const id = `D${index + 1}`;
    contexts.push(`<context id="${id}"><entity><identifier scheme="http://www.sec.gov/CIK">${cik}</identifier></entity>`
      + `<period><startDate>${duration.start}</startDate><endDate>${duration.end}</endDate></period></context>`);
    if (duration.eps !== null) {
      facts.push(`<us-gaap:EarningsPerShareDiluted contextRef="${id}" unitRef="USDPS" decimals="2">`
        + `${duration.eps ?? '1.25'}</us-gaap:EarningsPerShareDiluted>`);
    }
    if (duration.revenue !== null) {
      facts.push('<us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax '
        + `contextRef="${id}" unitRef="USD" decimals="0">${duration.revenue ?? '125000000'}`
        + '</us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax>');
    }
  });
  instants.forEach((instant, index) => {
    contexts.push(`<context id="I${index + 1}"><entity><identifier scheme="http://www.sec.gov/CIK">${cik}</identifier></entity>`
      + `<period><instant>${instant}</instant></period></context>`);
  });
  const anchor = instants.length > 0 ? 'I1' : 'D1';
  const dei = [];
  if (documentPeriodEndDate !== null) {
    dei.push(`<dei:DocumentPeriodEndDate contextRef="${anchor}">${documentPeriodEndDate}</dei:DocumentPeriodEndDate>`);
  }
  if (documentFiscalPeriodFocus !== null) {
    dei.push(`<dei:DocumentFiscalPeriodFocus contextRef="${anchor}">${documentFiscalPeriodFocus}</dei:DocumentFiscalPeriodFocus>`);
  }
  for (const repeated of repeatedFocusValues) {
    dei.push(`<dei:DocumentFiscalPeriodFocus contextRef="${anchor}">${repeated}</dei:DocumentFiscalPeriodFocus>`);
  }
  if (documentFiscalYearFocus !== null) {
    dei.push(`<dei:DocumentFiscalYearFocus contextRef="${anchor}">${documentFiscalYearFocus}</dei:DocumentFiscalYearFocus>`);
  }
  if (documentType !== null) {
    dei.push(`<dei:DocumentType contextRef="${anchor}">${documentType}</dei:DocumentType>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrl xmlns="http://www.xbrl.org/2003/instance"
 xmlns:xbrli="http://www.xbrl.org/2003/instance"
 xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
 xmlns:us-gaap="http://fasb.org/us-gaap/2025"
 xmlns:dei="http://xbrl.sec.gov/dei/2025">
 ${contexts.join('\n ')}
 <unit id="USD"><measure>iso4217:USD</measure></unit>
 <unit id="USDPS"><divide><unitNumerator><measure>iso4217:USD</measure></unitNumerator>
  <unitDenominator><measure>xbrli:shares</measure></unitDenominator></divide></unit>
 ${dei.join('\n ')}
 ${facts.join('\n ')}
</xbrl>`;
}

/** Pin one XBRL instance document and return its bytes id. */
export function pinFiscalDocumentBytes(store, xml, documentRole = 'PRIMARY_XBRL_INSTANCE') {
  return putEarningsSecDocumentBytes({
    store, bytes: Buffer.from(xml), mediaType: 'application/xml',
    documentFormat: 'XBRL_XML', documentRole,
  }).secDocumentBytesId;
}

/**
 * Pin a complete filing whose structured documents carry DEI fiscal metadata.
 *
 * @param {unknown} store
 * @param {{
 *   filerCik?: string, accessionNumber: string, formType: string, items?: string[],
 *   acceptanceDatetimeRaw: string, amendmentFlag?: boolean,
 *   amendsFilingAccessionNumber?: string|null,
 *   documents: object[]
 * }} definition
 */
export function pinFiscalFiling(store, definition) {
  const orderedDocuments = definition.documents.map((document) => ({
    secDocumentBytesId: pinFiscalDocumentBytes(store, syntheticFiscalXbrlXml(document),
      document.documentRole ?? 'PRIMARY_XBRL_INSTANCE'),
    documentRole: document.documentRole ?? 'PRIMARY_XBRL_INSTANCE',
  }));
  return buildSecFilingSourceDocument({
    store,
    filerCik: definition.filerCik ?? '1234567890',
    accessionNumber: definition.accessionNumber,
    formType: definition.formType,
    items: definition.items ?? (definition.formType.startsWith('8-K') ? ['2.02'] : []),
    acceptanceDatetimeRaw: definition.acceptanceDatetimeRaw,
    amendmentFlag: definition.amendmentFlag ?? false,
    amendsFilingAccessionNumber: definition.amendsFilingAccessionNumber ?? null,
    orderedDocuments,
  });
}

export function pinL4CI2TransformImplementationManifestV2(store) {
  const labRoot = l4cI2LabRoot();
  const manifest = buildTransformImplementationManifestV2({
    labRoot,
    logicalPaths: [...L4C_I2_TRANSFORM_LOGICAL_PATHS],
    runtimeContractVersion: L4C_I2_RUNTIME_CONTRACT_VERSION,
  });
  const stored = store.putCanonicalObject({
    namespace: 'snapshots',
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    value: manifest,
  });
  return { transformImplementationManifestId: stored.objectId, labRoot };
}

/**
 * The three canonical L4C-I2 filings.
 *
 * A  8-K    Q1 focus, one eligible duration -> QUARTER + YEAR_TO_DATE dual role
 * B  10-Q   Q1 focus, the same eligible duration as A: the raw period is shared
 *           by two visible revisions and must be counted exactly once
 * C  10-K/A FY focus, one eligible duration -> FISCAL_YEAR; an amendment is a
 *           separate event with its own publicAvailableAt, here the earliest
 *
 * The L4C-I1 extractor already drops comparative periods whose periodEnd does
 * not equal the filing's DocumentPeriodEndDate, so two filings can only share a
 * raw period when they attest the same DocumentPeriodEndDate. The Q2/Q3
 * span-order case therefore lives in its own single-filing fixture below.
 */
export const L4C_I2_FILING_DEFINITIONS = Object.freeze({
  q1EightK: Object.freeze({
    accessionNumber: '1234567890-26-000101', formType: '8-K',
    acceptanceDatetimeRaw: '20260423160530',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'Q1',
      documentFiscalYearFocus: '2026', documentType: '8-K',
      durations: [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
    }],
  }),
  q1TenQ: Object.freeze({
    accessionNumber: '1234567890-26-000102', formType: '10-Q',
    acceptanceDatetimeRaw: '20260507163015',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'Q1',
      documentFiscalYearFocus: '2026', documentType: '10-Q',
      durations: [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
    }],
  }),
  fyTenKA: Object.freeze({
    accessionNumber: '1234567890-26-000103', formType: '10-K/A',
    acceptanceDatetimeRaw: '20260301120000', amendmentFlag: true,
    amendsFilingAccessionNumber: '1234567890-26-000100',
    documents: [{
      documentPeriodEndDate: '2025-12-31', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2025', documentType: '10-K',
      durations: [{ start: '2025-01-01', end: '2025-12-31', eps: '4.90', revenue: '490000000' }],
    }],
  }),
  /** Q2 with two eligible durations sharing the DocumentPeriodEndDate. */
  q2TenQ: Object.freeze({
    accessionNumber: '1234567890-26-000104', formType: '10-Q',
    acceptanceDatetimeRaw: '20260806163015',
    documents: [{
      documentPeriodEndDate: '2026-06-30', documentFiscalPeriodFocus: 'Q2',
      documentFiscalYearFocus: '2026', documentType: '10-Q',
      durations: [
        { start: '2026-04-01', end: '2026-06-30', eps: '1.30', revenue: '130000000' },
        { start: '2026-01-01', end: '2026-06-30', eps: '2.55', revenue: '255000000' },
      ],
    }],
  }),
  /** Q3 with a single eligible duration: the role is undetermined. */
  q3TenQSingleDuration: Object.freeze({
    accessionNumber: '1234567890-26-000105', formType: '10-Q',
    acceptanceDatetimeRaw: '20261105163015',
    documents: [{
      documentPeriodEndDate: '2026-09-30', documentFiscalPeriodFocus: 'Q3',
      documentFiscalYearFocus: '2026', documentType: '10-Q',
      durations: [{ start: '2026-07-01', end: '2026-09-30', eps: '1.35', revenue: '135000000' }],
    }],
  }),
  /** Q4 declared on an 8-K with a single eligible duration. */
  q4EightK: Object.freeze({
    accessionNumber: '1234567890-26-000106', formType: '8-K',
    acceptanceDatetimeRaw: '20270211160000',
    documents: [{
      documentPeriodEndDate: '2026-12-31', documentFiscalPeriodFocus: 'Q4',
      documentFiscalYearFocus: '2026', documentType: '8-K',
      durations: [{ start: '2026-10-01', end: '2026-12-31', eps: '1.40', revenue: '140000000' }],
    }],
  }),
  /** Q4 declared on an 8-K with two eligible durations: ambiguous by doctrine. */
  q4EightKMultiDuration: Object.freeze({
    accessionNumber: '1234567890-26-000107', formType: '8-K',
    acceptanceDatetimeRaw: '20270211161500',
    documents: [{
      documentPeriodEndDate: '2026-12-31', documentFiscalPeriodFocus: 'Q4',
      documentFiscalYearFocus: '2026', documentType: '8-K',
      durations: [
        { start: '2026-10-01', end: '2026-12-31', eps: '1.40', revenue: '140000000' },
        { start: '2026-01-01', end: '2026-12-31', eps: '5.30', revenue: '530000000' },
      ],
    }],
  }),
  /** FY declared with two eligible durations: the shorter one is unprovable. */
  fyTenKTwoDurations: Object.freeze({
    accessionNumber: '1234567890-26-000108', formType: '10-K',
    acceptanceDatetimeRaw: '20270225160000',
    documents: [{
      documentPeriodEndDate: '2026-12-31', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2026', documentType: '10-K',
      durations: [
        { start: '2026-01-01', end: '2026-12-31', eps: '5.30', revenue: '530000000' },
        { start: '2026-10-01', end: '2026-12-31', eps: '1.40', revenue: '140000000' },
      ],
    }],
  }),
  /** A 53-week fiscal year: source dates are preserved verbatim. */
  fyFiftyThreeWeek: Object.freeze({
    accessionNumber: '1234567890-27-000109', formType: '10-K',
    acceptanceDatetimeRaw: '20270304160000',
    documents: [{
      documentPeriodEndDate: '2027-01-02', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2026', documentType: '10-K',
      durations: [{ start: '2025-12-29', end: '2027-01-02', eps: '5.31', revenue: '531000000' }],
    }],
  }),
  /** A non-calendar fiscal year, without any December anchor. */
  fyNonCalendar: Object.freeze({
    accessionNumber: '1234567890-26-000110', formType: '10-K',
    acceptanceDatetimeRaw: '20260918160000',
    documents: [{
      documentPeriodEndDate: '2026-06-30', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2026', documentType: '10-K',
      durations: [{ start: '2025-07-01', end: '2026-06-30', eps: '4.10', revenue: '410000000' }],
    }],
  }),
  /** A 10-Q declaring FY: the form and the focus are incompatible. */
  focusFormIncompatible: Object.freeze({
    accessionNumber: '1234567890-26-000111', formType: '10-Q',
    acceptanceDatetimeRaw: '20260507170000',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'FY',
      documentFiscalYearFocus: '2026', documentType: '10-Q',
      durations: [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
    }],
  }),
  /** No DEI focus at all: metadata absent, nothing classified. */
  focusAbsent: Object.freeze({
    accessionNumber: '1234567890-26-000112', formType: '8-K',
    acceptanceDatetimeRaw: '20260423170000',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: null,
      documentFiscalYearFocus: '2026', documentType: '8-K',
      durations: [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
    }],
  }),
  /**
   * Focus present, DEI complete, but no metric duration facts: a visible
   * revision with zero metric observations and therefore zero raw periods
   * (GATE-06 CASE-NO-METRIC). Distinct from focusAbsent.
   */
  noMetricObservation: Object.freeze({
    accessionNumber: '1234567890-26-000114', formType: '8-K',
    acceptanceDatetimeRaw: '20260423172000',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'Q1',
      documentFiscalYearFocus: '2026', documentType: '8-K',
      durations: [],
      instants: ['2026-03-31'],
    }],
  }),
  /** Two distinct declared focus values in one document: ambiguous metadata. */
  focusAmbiguous: Object.freeze({
    accessionNumber: '1234567890-26-000113', formType: '8-K',
    acceptanceDatetimeRaw: '20260423171500',
    documents: [{
      documentPeriodEndDate: '2026-03-31', documentFiscalPeriodFocus: 'Q1',
      documentFiscalYearFocus: '2026', documentType: '8-K',
      repeatedFocusValues: ['Q2'],
      durations: [{ start: '2026-01-01', end: '2026-03-31', eps: '1.25', revenue: '125000000' }],
    }],
  }),
});

/** Ingest an explicit filing list and pin both L4C-I2 policies. */
export function pinL4CI2Dataset(store, definitions) {
  const transform = pinL4CI2TransformImplementationManifestV2(store);
  const taxonomy = pinSyntheticTaxonomyBundle(store);
  const filings = definitions.map((definition) => pinFiscalFiling(store, definition));
  const pipeline = ingestEarningsDatasetL4CIV1({
    store,
    sourceFilingDocumentIds: filings.map((filing) => filing.sourceFilingDocumentId),
    transformImplementationManifestId: transform.transformImplementationManifestId,
    earningsTaxonomyBundleManifestId: taxonomy.earningsTaxonomyBundleManifestId,
    previousSnapshotId: null,
  });
  const asOfPolicy = buildEarningsAsOfResolutionPolicy({ store });
  const fiscalPolicy = buildEarningsFiscalClassificationPolicy({ store });
  return {
    transform,
    taxonomy,
    filings,
    pipeline,
    earningsDatasetSnapshotManifestId: pipeline.snapshot.earningsDatasetSnapshotManifestId,
    earningsAsOfResolutionPolicyId: asOfPolicy.earningsAsOfResolutionPolicyId,
    earningsFiscalClassificationPolicyId: fiscalPolicy.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: transform.transformImplementationManifestId,
  };
}

/** Bind a pinned dataset at one cutoff. */
export function bindL4CI2Dataset(store, dataset, knowledgeCutoff = L4C_I2_CUTOFF_AFTER_ALL) {
  return buildEarningsDatasetBinding({
    store,
    earningsDatasetSnapshotManifestId: dataset.earningsDatasetSnapshotManifestId,
    earningsAsOfResolutionPolicyId: dataset.earningsAsOfResolutionPolicyId,
    earningsFiscalClassificationPolicyId: dataset.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: dataset.transformImplementationManifestId,
    knowledgeCutoff,
  });
}

/** Bind and materialize a pinned dataset at one cutoff. */
export function materializeL4CI2Dataset(store, dataset, knowledgeCutoff = L4C_I2_CUTOFF_AFTER_ALL) {
  const binding = bindL4CI2Dataset(store, dataset, knowledgeCutoff);
  const materialization = buildEarningsAsOfMaterializationReport({
    store, earningsDatasetBindingId: binding.earningsDatasetBindingId,
  });
  return { binding, materialization };
}

/** The canonical three-filing L4C-I2 fixture. */
export function withL4CI2ThreeFilingFixture(callback) {
  return withEarningsStore((store, root) => {
    const dataset = pinL4CI2Dataset(store, [
      L4C_I2_FILING_DEFINITIONS.q1EightK,
      L4C_I2_FILING_DEFINITIONS.q1TenQ,
      L4C_I2_FILING_DEFINITIONS.fyTenKA,
    ]);
    return callback({ store, root, ...dataset });
  });
}

/** A snapshot with no filing at all: emptySnapshot true. */
export function withL4CI2EmptyFixture(callback) {
  return withEarningsStore((store, root) => {
    const dataset = pinL4CI2Dataset(store, []);
    return callback({ store, root, ...dataset });
  });
}

/** A single-filing fixture, for the focus-by-focus fiscal cases. */
export function withL4CI2SingleFilingFixture(definition, callback) {
  return withEarningsStore((store, root) => {
    const dataset = pinL4CI2Dataset(store, [definition]);
    return callback({ store, root, ...dataset });
  });
}

/**
 * A read-only overlay that serves divergent values for chosen object ids.
 *
 * The canonical store refuses to write an object that violates its contract, so
 * a verifier can only be shown a divergent stored value through an overlay.
 * This mirrors the L4C-I1 test harness technique exactly.
 *
 * @param {any} store @param {Map<string, unknown>} valuesById
 */
export function overlayL4CI2Store(store, valuesById) {
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
      return { objectId: input.expectedObjectId, uri: input.uri, sizeBytes: bytes.length, bytes };
    }
    return store.readObject(input);
  };
  return Object.freeze(wrapped);
}

/**
 * Resolve a pinned dataset at a cutoff and classify one visible revision.
 * @param {any} store @param {any} dataset @param {number} [index]
 */
export function classifyVisibleRevision(store, dataset, index = 0,
  knowledgeCutoff = L4C_I2_CUTOFF_AFTER_ALL) {
  const resolution = resolveEarningsAsOfV1({
    store,
    earningsDatasetSnapshotManifestId: dataset.earningsDatasetSnapshotManifestId,
    knowledgeCutoff,
    earningsAsOfResolutionPolicyId: dataset.earningsAsOfResolutionPolicyId,
  });
  const entry = resolution.orderedVisibleRevisionEntries[index];
  const classified = classifyEarningsFiscalPeriodsForRevisionV1({
    store,
    earningsRevisionIdentityId: entry.earningsRevisionIdentityId,
    sourceFilingDocumentId: entry.sourceFilingDocumentId,
    orderedRawPeriodIds: entry.orderedRawPeriodIds,
    earningsFiscalClassificationPolicyId: dataset.earningsFiscalClassificationPolicyId,
    transformImplementationManifestId: dataset.transformImplementationManifestId,
  });
  const classifications = classified.orderedFiscalPeriodClassificationIds.map(
    (earningsFiscalPeriodClassificationId) => verifyEarningsFiscalPeriodClassificationCore({
      store, earningsFiscalPeriodClassificationId,
    }).earningsFiscalPeriodClassification);
  return { resolution, entry, classified, classifications };
}

/** Classify the single revision of a one-filing fixture. */
export function withClassifiedSingleFiling(definition, callback) {
  return withL4CI2SingleFilingFixture(definition, (ctx) =>
    callback({ ...ctx, ...classifyVisibleRevision(ctx.store, ctx) }));
}

/** Overlay one object id with a shallow-patched copy of its stored value. */
export function withMutatedObject(store, objectId, value, patch) {
  return overlayL4CI2Store(store, new Map([[objectId, { ...structuredClone(value), ...patch }]]));
}
