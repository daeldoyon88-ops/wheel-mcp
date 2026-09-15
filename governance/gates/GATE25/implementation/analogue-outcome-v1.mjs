/**
 * GATE25 post-selection outcomes: D8 GATE25_POST_SELECTION_OUTCOME_SET_V1.
 *
 * Phase 2 (OUTCOME_ATTACHMENT) only. Attachment requires a frozen selection with
 * selectionComplete true and a recomputing selectionDigest; the digest is checked
 * again after attachment, so outcome visibility can never re-select, re-rank,
 * filter, truncate or expand the analogue set.
 *
 * Records are PER_ANALOGUE_PER_HORIZON over ALL AND ONLY the HorizonId values
 * admissible under GATE22_TEMPORAL_HORIZON_V1. A missing outcome is MISSING with a
 * null value: no substitution, no fabrication, no quantile, probability or
 * confidence. An outcome is AVAILABLE only when it was available at or before the
 * query knowledge cutoff.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { createHorizon, HORIZONS_V1 } from '../../GATE22/implementation/temporal-horizon-v1.mjs';
import {
  assertClosedKeys,
  failClosed,
  instantMs,
  isCanonicalUtcInstant,
  isExactGovernedString,
  isPlainObject,
} from './analogue-identity-v1.mjs';

export const POST_SELECTION_OUTCOME_SET_ID_V1 = 'GATE25_POST_SELECTION_OUTCOME_SET_V1';
export const HORIZON_CONTRACT_ID_V1 = 'GATE22_TEMPORAL_HORIZON_V1';
export const RECORD_GRANULARITY_V1 = 'PER_ANALOGUE_PER_HORIZON';
export const OUTCOME_STATUS_V1 = Object.freeze({ AVAILABLE: 'AVAILABLE', MISSING: 'MISSING' });
export const OUTCOME_RECORD_FIELDS_V1 = Object.freeze([
  'analogueIdentityId', 'horizonId', 'selectionComplete', 'outcomeStatus', 'outcomeValue', 'outcomeAvailableAt', 'sourceBindingId',
]);
export const SELECTION_FREEZE_SCHEMA_V1 = 'GATE25_FrozenAnalogueSelection/1';

const HORIZON_ID_COMPOSITION = 'sessionCount + calendarRegistryManifestId';

/**
 * Reads the admissible session counts from the pinned GATE22 contract bytes and
 * refuses any divergence from the GATE22 implementation constant.
 */
export function readAdmissibleHorizonSessionCounts(horizonContract) {
  if (horizonContract?.contractId !== HORIZON_CONTRACT_ID_V1) failClosed('HORIZON_CONTRACT_INVALID');
  const rules = horizonContract?.mandateProjection?.sessionCountingRules;
  if (rules?.horizonIdComposition !== HORIZON_ID_COMPOSITION) failClosed('HORIZON_ID_COMPOSITION_MISMATCH');
  const counts = rules.horizonsV1;
  if (!Array.isArray(counts) || counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count <= 0)) {
    failClosed('HORIZON_SESSION_COUNTS_INVALID');
  }
  if (counts.length !== HORIZONS_V1.length || counts.some((count, index) => count !== HORIZONS_V1[index])) {
    failClosed('HORIZON_CONTRACT_DIVERGES_FROM_GATE22_IMPLEMENTATION');
  }
  return Object.freeze([...counts]);
}

/** ALL AND ONLY the admissible HorizonId values, composed by GATE22 createHorizon. */
export function admissibleHorizonBindings({ horizonContract, calendarRegistryManifestId }) {
  if (!isExactGovernedString(calendarRegistryManifestId)) failClosed('HORIZON_CALENDAR_REGISTRY_REQUIRED');
  return Object.freeze(readAdmissibleHorizonSessionCounts(horizonContract).map((sessionCount) => {
    const horizon = createHorizon({ sessionCount, calendarRegistryManifestId });
    return Object.freeze({ horizonId: horizon.horizonId, sessionCount: horizon.sessionCount, calendarRegistryManifestId });
  }));
}

/* ----------------------------------------------------------------- selection freeze */

function selectionCore(selection) {
  return {
    schema: SELECTION_FREEZE_SCHEMA_V1,
    queryIdentityId: selection.queryIdentityId,
    analogues: selection.analogues.map((entry) => ({ rank: entry.rank, analogueIdentityId: entry.analogueIdentityId, finalDistance: entry.finalDistance })),
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** selectionComplete: the analogue set and every per-analogue distance are content-addressed and frozen. */
export function freezeSelection({ queryIdentityId, rankedAnalogues }) {
  if (!isExactGovernedString(queryIdentityId)) failClosed('SELECTION_QUERY_IDENTITY_REQUIRED');
  if (!Array.isArray(rankedAnalogues)) failClosed('SELECTION_ANALOGUES_REQUIRED');
  const core = selectionCore({ queryIdentityId, analogues: rankedAnalogues });
  return deepFreeze({ ...core, selectionComplete: true, selectionDigest: sha256Canonical(core) });
}

export function assertFrozenSelection(selection) {
  if (!isPlainObject(selection) || selection.selectionComplete !== true) failClosed('OUTCOME_ATTACHMENT_BEFORE_SELECTION_COMPLETE');
  if (!Object.isFrozen(selection) || !Object.isFrozen(selection.analogues)) failClosed('SELECTION_NOT_FROZEN');
  if (sha256Canonical(selectionCore(selection)) !== selection.selectionDigest) failClosed('SELECTION_DIGEST_MISMATCH');
  return selection.selectionDigest;
}

/* ---------------------------------------------------------------------- attachment */

function readOutcome(found, { analogueIdentityId, horizonId }) {
  assertClosedKeys(found, ['outcomeValue', 'outcomeAvailableAt'], 'OUTCOME_SOURCE_RECORD_NOT_CLOSED', { analogueIdentityId, horizonId });
  if (typeof found.outcomeValue !== 'number' || !Number.isFinite(found.outcomeValue)) {
    failClosed('OUTCOME_SOURCE_VALUE_MALFORMED', { analogueIdentityId, horizonId });
  }
  if (!isCanonicalUtcInstant(found.outcomeAvailableAt)) failClosed('OUTCOME_SOURCE_AVAILABLE_AT_INVALID', { analogueIdentityId, horizonId });
  return found;
}

/**
 * outcomeSource: { sourceBindingId, lookup({ analogueIdentityId, horizonId }) }.
 * lookup returns null when no outcome exists, or { outcomeValue, outcomeAvailableAt }.
 */
export function attachPostSelectionOutcomes({ frozenSelection, horizonBindings, outcomeSource, queryKnowledgeCutoff }) {
  const selectionDigest = assertFrozenSelection(frozenSelection);
  const cutoffMs = instantMs(queryKnowledgeCutoff, 'OUTCOME_QUERY_KNOWLEDGE_CUTOFF_INVALID');
  if (!Array.isArray(horizonBindings) || horizonBindings.length === 0) failClosed('OUTCOME_HORIZON_BINDINGS_REQUIRED');
  const horizonIds = horizonBindings.map((binding) => binding.horizonId);
  if (new Set(horizonIds).size !== horizonIds.length) failClosed('OUTCOME_HORIZON_DUPLICATE');
  if (frozenSelection.analogues.length > 0
    && (!isPlainObject(outcomeSource) || typeof outcomeSource.lookup !== 'function' || !isExactGovernedString(outcomeSource.sourceBindingId))) {
    failClosed('OUTCOME_SOURCE_REQUIRED');
  }
  const records = [];
  for (const analogue of frozenSelection.analogues) {
    for (const horizonId of horizonIds) {
      const found = outcomeSource.lookup({ analogueIdentityId: analogue.analogueIdentityId, horizonId });
      const outcome = found === null || found === undefined ? null : readOutcome(found, { analogueIdentityId: analogue.analogueIdentityId, horizonId });
      const available = outcome !== null && Date.parse(outcome.outcomeAvailableAt) <= cutoffMs;
      records.push({
        analogueIdentityId: analogue.analogueIdentityId,
        horizonId,
        selectionComplete: true,
        outcomeStatus: available ? OUTCOME_STATUS_V1.AVAILABLE : OUTCOME_STATUS_V1.MISSING,
        outcomeValue: available ? (outcome.outcomeValue === 0 ? 0 : outcome.outcomeValue) : null,
        outcomeAvailableAt: available ? outcome.outcomeAvailableAt : null,
        sourceBindingId: outcomeSource.sourceBindingId,
      });
    }
  }
  if (assertFrozenSelection(frozenSelection) !== selectionDigest) failClosed('ANALOGUE_SET_MUTATED_AFTER_OUTCOME_VISIBILITY');
  const outcomeSet = {
    artifactId: POST_SELECTION_OUTCOME_SET_ID_V1,
    recordGranularity: RECORD_GRANULARITY_V1,
    selectionDigest,
    horizonIds,
    records,
  };
  return deepFreeze({ ...outcomeSet, outcomeSetId: sha256Canonical(outcomeSet) });
}

export function describeOutcomeSet() {
  return Object.freeze({
    artifactId: POST_SELECTION_OUTCOME_SET_ID_V1,
    recordGranularity: RECORD_GRANULARITY_V1,
    horizonSource: HORIZON_CONTRACT_ID_V1,
    horizonCoverage: 'ALL_AND_ONLY',
    recordFields: OUTCOME_RECORD_FIELDS_V1,
    missingRule: { outcomeStatus: OUTCOME_STATUS_V1.MISSING, outcomeValue: null },
    postSelectionOnly: true,
    mustNeverInfluence: ['eligibility', 'normalization', 'distance', 'ordering', 'support count', 'selection'],
  });
}
