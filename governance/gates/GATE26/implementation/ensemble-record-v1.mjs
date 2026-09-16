/**
 * GATE26 multi-horizon ensemble record V1.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { failClosed, assertClosedKeys } from './ensemble-identity-v1.mjs';
import { refuseProbabilityClaim } from './combination-policy-v1.mjs';

export const MULTI_HORIZON_OUTPUT_SCHEMA_V1 = 'GATE26_MULTI_HORIZON_OUTPUT_V1';
export const ENSEMBLE_RECORD_FIELDS_V1 = Object.freeze([
  'schema',
  'ensembleIdentityId',
  'horizonId',
  'sessionCount',
  'outcomeAvailability',
  'analogueOutcomeSummary',
  'supportDerivedConfidence',
  'uncertainty',
  'abstention',
  'combinationTrace',
  'provenanceBinding',
]);
export const ADMISSIBLE_SESSION_COUNTS_V1 = Object.freeze([30, 90, 180, 252]);

export function assertAdmissibleHorizon(sessionCount) {
  if (!ADMISSIBLE_SESSION_COUNTS_V1.includes(sessionCount)) failClosed('HORIZON_NOT_ADMISSIBLE', { sessionCount });
  return sessionCount;
}

export function buildHorizonRecord(record) {
  assertClosedKeys(record, ENSEMBLE_RECORD_FIELDS_V1, 'ENSEMBLE_RECORD_NOT_CLOSED');
  if (record.schema !== MULTI_HORIZON_OUTPUT_SCHEMA_V1) failClosed('ENSEMBLE_RECORD_SCHEMA_INVALID');
  assertAdmissibleHorizon(record.sessionCount);
  if (record.supportDerivedConfidence?.kind !== 'SUPPORT_DERIVED_NOT_PROBABILITY') {
    failClosed('CONFIDENCE_KIND_INVALID');
  }
  if (record.supportDerivedConfidence?.calibratedProbability !== null) failClosed('PROBABILITY_CLAIM_FORBIDDEN');
  refuseProbabilityClaim(record);
  return Object.freeze({
    ...record,
    analogueOutcomeSummary: Object.freeze({ ...record.analogueOutcomeSummary }),
    supportDerivedConfidence: Object.freeze({ ...record.supportDerivedConfidence }),
    uncertainty: Object.freeze({ ...record.uncertainty }),
    abstention: Object.freeze({ ...record.abstention }),
    combinationTrace: Object.freeze([...record.combinationTrace]),
    provenanceBinding: Object.freeze({ ...record.provenanceBinding }),
    recordId: sha256Canonical(record),
  });
}
