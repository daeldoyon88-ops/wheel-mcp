/**
 * GATE23 causal feature store.
 *
 * Append-only and keyed by FeatureRecordId. Replaying an identical materialization
 * is idempotent. A restatement that keeps the same DatasetId_observation but
 * changes the observed window is refused, so a later corporate-action restatement
 * can never rewrite a historical FeatureRecord; a restatement carrying a new
 * DatasetId_observation is a new FeatureRecordId and leaves history intact.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { FEATURE_RECORD_ID_MEMBERS_V1 } from './feature-identity-v1.mjs';
import { refuseOutcomeProduction } from './feature-materializer-v1.mjs';

export const FEATURE_STORE_VERSION = 'GATE23_FeatureStore/1';
export const FEATURE_STORE_POLICY = Object.freeze({
  append: 'APPEND_ONLY',
  key: 'FeatureRecordId',
  identicalReplay: 'IDEMPOTENT',
  divergentReplayUnderSameKey: 'REFUSED',
  restatement: 'REQUIRES_NEW_DATASET_ID_OBSERVATION',
  outcomeRecords: 'FORBIDDEN',
});

const contentDigest = (record) => sha256Canonical({
  featureRecordId: record.featureRecordId,
  identity: record.identity,
  status: record.status,
  code: record.code,
  value: record.value,
  missingnessStateId: record.missingnessStateId,
  observationWindowDigest: record.observationWindowDigest,
  observedSessionCount: record.observedSessionCount,
});

export function createFeatureStore() {
  return Object.freeze({ schemaVersion: FEATURE_STORE_VERSION, records: Object.freeze([]) });
}

function assertStorableRecord(record) {
  if (!record || typeof record.featureRecordId !== 'string' || !/^[0-9a-f]{64}$/.test(record.featureRecordId)) {
    throw new Error('FEATURE_RECORD_ID_INVALID');
  }
  if (!record.identity || FEATURE_RECORD_ID_MEMBERS_V1.some((member) => typeof record.identity[member] !== 'string')) {
    throw new Error('FEATURE_RECORD_IDENTITY_INVALID');
  }
  if (refuseOutcomeProduction(record.featureDefinitionId).status !== 'ALLOWED') {
    throw new Error('GATE23_PRODUCES_NO_OUTCOME');
  }
}

export function appendFeatureRecord(store, record) {
  if (store?.schemaVersion !== FEATURE_STORE_VERSION) throw new Error('FEATURE_STORE_INVALID');
  assertStorableRecord(record);
  const existing = store.records.find((item) => item.featureRecordId === record.featureRecordId);
  if (existing) {
    if (contentDigest(existing) === contentDigest(record)) return store;
    throw new Error('FEATURE_STORE_RESTATEMENT_CONFLICT');
  }
  return Object.freeze({
    schemaVersion: FEATURE_STORE_VERSION,
    records: Object.freeze([...store.records, Object.freeze(record)]),
  });
}

export function appendFeatureRecords(store, records) {
  return records.reduce(appendFeatureRecord, store);
}

export function readFeatureRecord(store, featureRecordId) {
  return store.records.find((item) => item.featureRecordId === featureRecordId) ?? null;
}

export function storeDigest(store) {
  return sha256Canonical(store.records.map(contentDigest));
}

export { contentDigest as featureRecordContentDigest };
