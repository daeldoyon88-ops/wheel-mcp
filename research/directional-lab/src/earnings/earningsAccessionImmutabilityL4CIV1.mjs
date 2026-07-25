/** Explicit-list accession immutability checks; never scans the CAS. */

import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';

export function assertEarningsAccessionImmutabilityV1(records) {
  if (!Array.isArray(records)) {
    throw new MarketDataL3Error('EARNINGS_ACCESSION_IMMUTABILITY_CONFLICT',
      'accession records must be an explicit array');
  }
  const byAccession = new Map();
  for (const record of records) {
    const key = `${record.filerCik}\0${record.accessionNumber}`;
    const contentId = record.sourceFilingDocumentId ?? record.secFilingSourceDocumentId;
    const prior = byAccession.get(key);
    if (prior !== undefined && prior !== contentId) {
      throw new MarketDataL3Error('EARNINGS_ACCESSION_IMMUTABILITY_CONFLICT',
        'one SEC accession cannot identify two filing contents');
    }
    byAccession.set(key, contentId);
  }
  return records;
}

export const detectEarningsAccessionConflictV1 = assertEarningsAccessionImmutabilityV1;
