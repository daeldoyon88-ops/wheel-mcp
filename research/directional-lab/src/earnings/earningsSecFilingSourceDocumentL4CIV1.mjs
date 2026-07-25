/** SEC filing manifest construction, verification and closed admission. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_STRUCTURED_DOCUMENT_ROLES,
  SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
  normalizeSecFilingSourceDocumentCoreV1,
  secAcceptanceDatetimeToUtcV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsSecDocumentBytes } from './earningsSecDocumentBytesL4CIV1.mjs';

export function earningsEventTypeForFormV1(formType) {
  if (formType === '8-K' || formType === '8-K/A') return 'EARNINGS_RELEASE';
  if (['10-Q', '10-Q/A', '10-K', '10-K/A'].includes(formType)) return 'EARNINGS_FILING';
  throw new MarketDataL3Error('EARNINGS_EVENT_TYPE_INVALID',
    `form ${String(formType)} has no closed earnings event type`);
}

export function assertEarningsEventTypeV1(eventType) {
  if (!['EARNINGS_RELEASE', 'EARNINGS_FILING'].includes(eventType)) {
    throw new MarketDataL3Error('EARNINGS_EVENT_TYPE_INVALID',
      'event type must be EARNINGS_RELEASE or EARNINGS_FILING');
  }
  return eventType;
}

export function buildSecFilingSourceDocument(input) {
  const api = assertApiInput(input, [
    'filerCik', 'accessionNumber', 'formType', 'items', 'acceptanceDatetimeRaw',
    'amendmentFlag', 'amendsFilingAccessionNumber', 'orderedDocuments',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const filing = normalizeSecFilingSourceDocumentCoreV1({
    schemaVersion: SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
    filerCik: api.filerCik,
    accessionNumber: api.accessionNumber,
    formType: api.formType,
    items: api.items,
    acceptanceDatetimeRaw: api.acceptanceDatetimeRaw,
    publicAvailableAt: secAcceptanceDatetimeToUtcV1(api.acceptanceDatetimeRaw),
    sourceAuthority: 'SEC_EDGAR',
    amendmentFlag: api.amendmentFlag,
    amendsFilingAccessionNumber: api.amendsFilingAccessionNumber,
    orderedDocuments: api.orderedDocuments,
  });
  for (const entry of filing.orderedDocuments) {
    const verified = verifyEarningsSecDocumentBytes({
      store: api.store, secDocumentBytesId: entry.secDocumentBytesId,
    });
    if (verified.secDocumentBytesCore.documentRole !== entry.documentRole) {
      throw new MarketDataL3Error('EARNINGS_DOCUMENT_ROLE_INVALID',
        'filing document role diverges from its bytes core');
    }
  }
  const stored = putCanonicalL3(api.store, SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION, filing);
  return { sourceFilingDocumentId: stored.objectId, secFilingSourceDocument: stored.value };
}

export function verifySecFilingSourceDocument(input) {
  const api = assertApiInput(input, ['sourceFilingDocumentId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let filing;
  try {
    filing = normalizeSecFilingSourceDocumentCoreV1(readTypedReference(api.store,
      api.sourceFilingDocumentId, SEC_FILING_SOURCE_DOCUMENT_CORE_SCHEMA_VERSION,
      'SEC filing source document'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_SOURCE_DOCUMENT_MISSING',
      'SEC filing source document is missing or corrupt', { cause });
  }
  const documents = filing.orderedDocuments.map((entry) => {
    const verified = verifyEarningsSecDocumentBytes({
      store: api.store, secDocumentBytesId: entry.secDocumentBytesId,
    });
    if (verified.secDocumentBytesCore.documentRole !== entry.documentRole) {
      throw new MarketDataL3Error('EARNINGS_DOCUMENT_ROLE_INVALID',
        'filing document role diverges from its bytes core');
    }
    return verified;
  });
  return { sourceFilingDocumentId: api.sourceFilingDocumentId,
    secFilingSourceDocument: filing, documents };
}

export function admitSecFilingForEarningsV1(input) {
  const api = assertApiInput(input, ['sourceFilingDocumentId']);
  const verified = verifySecFilingSourceDocument(api);
  const filing = verified.secFilingSourceDocument;
  if ((filing.formType === '8-K' || filing.formType === '8-K/A')
      && !filing.items.includes('2.02')) {
    throw new MarketDataL3Error('EARNINGS_ITEM_2_02_ABSENT',
      '8-K family filings require Item 2.02');
  }
  const structured = filing.orderedDocuments.some((document) =>
    EARNINGS_STRUCTURED_DOCUMENT_ROLES.includes(document.documentRole));
  if (!structured) {
    throw new MarketDataL3Error('EARNINGS_STRUCTURED_DOCUMENT_ABSENT',
      'an admitted filing requires a structured XBRL or iXBRL document');
  }
  const diagnostics = [];
  if (filing.items.some((item) => item !== '2.02')) {
    diagnostics.push('EARNINGS_NON_EARNINGS_ITEM_PRESENT');
  }
  return {
    ...verified,
    admission: 'ADMIT',
    eventType: earningsEventTypeForFormV1(filing.formType),
    diagnostics,
  };
}

export const admitEarningsFilingV1 = admitSecFilingForEarningsV1;
