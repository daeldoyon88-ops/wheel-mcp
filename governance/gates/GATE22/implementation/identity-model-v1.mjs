import { sha256Canonical } from '../../../tools/canonical-json.mjs';

const OBSERVATION_FIELDS = ['InstrumentIdentityId', 'SessionDate', 'KnowledgeCutoff', 'AvailableAt', 'Source', 'DatasetId_observation', 'PriceBasisId', 'MissingnessState'];
const OUTCOME_FIELDS = ['ObservationId', 'HorizonId', 'FormulaId', 'DatasetId_outcome', 'PriceBasisId', 'TaxonomyVersion'];
const FORBIDDEN = new Set(['ticker', 'symbol', 'alias', 'temporaryAlias', 'OutcomeStatus', 'OutcomeMissingReason', 'OutcomeWindowCause']);

function exactDigest(input, fields, name) {
  if (!input || Object.keys(input).length !== fields.length || fields.some((field) => !(field in input)) || Object.keys(input).some((key) => FORBIDDEN.has(key))) throw new Error(`${name}_EXACT_ONLY`);
  if (!input.InstrumentIdentityId && name === 'OBSERVATION_ID') throw new Error('INSTRUMENT_IDENTITY_REQUIRED');
  return sha256Canonical(Object.fromEntries(fields.map((field) => [field, input[field]])));
}
export const createObservationId = (input) => exactDigest(input, OBSERVATION_FIELDS, 'OBSERVATION_ID');
export const createOutcomeId = (input) => exactDigest(input, OUTCOME_FIELDS, 'OUTCOME_ID');
