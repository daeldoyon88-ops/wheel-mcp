/** One INITIAL revision identity and core per admitted SEC accession. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_REVISION_CORE_SCHEMA_VERSION,
  EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
  normalizeEarningsRevisionCoreV1,
  normalizeEarningsRevisionIdentityCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyEarningsEventIdentityCore } from './earningsEventIdentityL4CIV1.mjs';
import { verifySecFilingSourceDocument } from './earningsSecFilingSourceDocumentL4CIV1.mjs';

export function buildEarningsRevision(input) {
  const api = assertApiInput(input, ['eventIdentityId', 'sourceFilingDocumentId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const event = verifyEarningsEventIdentityCore({
    store: api.store, eventIdentityId: api.eventIdentityId,
  }).earningsEventIdentityCore;
  const filing = verifySecFilingSourceDocument({
    store: api.store, sourceFilingDocumentId: api.sourceFilingDocumentId,
  }).secFilingSourceDocument;
  if (event.filerCik !== filing.filerCik || event.accessionNumber !== filing.accessionNumber) {
    throw new MarketDataL3Error('EARNINGS_REVISION_EVENT_MISMATCH',
      'event identity and source filing identify different accessions');
  }
  const identity = normalizeEarningsRevisionIdentityCoreV1({
    schemaVersion: EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
    eventIdentityId: api.eventIdentityId,
    publicAvailableAt: filing.publicAvailableAt,
    sourceFilingDocumentId: api.sourceFilingDocumentId,
  });
  const identityStored = putCanonicalL3(api.store,
    EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION, identity);
  const revision = normalizeEarningsRevisionCoreV1({
    schemaVersion: EARNINGS_REVISION_CORE_SCHEMA_VERSION,
    earningsRevisionIdentityId: identityStored.objectId,
    eventIdentityId: api.eventIdentityId,
    publicAvailableAt: filing.publicAvailableAt,
    sourceFilingDocumentId: api.sourceFilingDocumentId,
    revisionKind: 'INITIAL',
    parentRevisionIdentityId: null,
  });
  const revisionStored = putCanonicalL3(api.store, EARNINGS_REVISION_CORE_SCHEMA_VERSION, revision);
  return {
    earningsRevisionIdentityId: identityStored.objectId,
    earningsRevisionIdentityCore: identityStored.value,
    earningsRevisionId: revisionStored.objectId,
    earningsRevisionCore: revisionStored.value,
  };
}

export function verifyEarningsRevisionIdentityCore(input) {
  const api = assertApiInput(input, ['earningsRevisionIdentityId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let identity;
  try {
    identity = normalizeEarningsRevisionIdentityCoreV1(readTypedReference(api.store,
      api.earningsRevisionIdentityId, EARNINGS_REVISION_IDENTITY_CORE_SCHEMA_VERSION,
      'earnings revision identity'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_REVISION_IDENTITY_MISSING',
      'earnings revision identity is missing or corrupt', { cause });
  }
  verifyEarningsEventIdentityCore({ store: api.store, eventIdentityId: identity.eventIdentityId });
  const filing = verifySecFilingSourceDocument({
    store: api.store, sourceFilingDocumentId: identity.sourceFilingDocumentId,
  }).secFilingSourceDocument;
  if (identity.publicAvailableAt !== filing.publicAvailableAt) {
    throw new MarketDataL3Error('EARNINGS_REVISION_TIME_MISMATCH',
      'revision identity time diverges from the filing');
  }
  return { earningsRevisionIdentityId: api.earningsRevisionIdentityId,
    earningsRevisionIdentityCore: identity };
}

export function verifyEarningsRevisionCore(input) {
  const api = assertApiInput(input, ['earningsRevisionId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let revision;
  try {
    revision = normalizeEarningsRevisionCoreV1(readTypedReference(api.store,
      api.earningsRevisionId, EARNINGS_REVISION_CORE_SCHEMA_VERSION, 'earnings revision core'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_REVISION_CORE_MISSING',
      'earnings revision core is missing or corrupt', { cause });
  }
  const identity = verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: revision.earningsRevisionIdentityId,
  }).earningsRevisionIdentityCore;
  if (revision.eventIdentityId !== identity.eventIdentityId) {
    throw new MarketDataL3Error('EARNINGS_REVISION_EVENT_MISMATCH',
      'revision event diverges from its identity');
  }
  if (revision.publicAvailableAt !== identity.publicAvailableAt) {
    throw new MarketDataL3Error('EARNINGS_REVISION_TIME_MISMATCH',
      'revision time diverges from its identity');
  }
  if (revision.sourceFilingDocumentId !== identity.sourceFilingDocumentId) {
    throw new MarketDataL3Error('EARNINGS_REVISION_SOURCE_MISMATCH',
      'revision source diverges from its identity');
  }
  return { earningsRevisionId: api.earningsRevisionId, earningsRevisionCore: revision,
    earningsRevisionIdentityCore: identity };
}
