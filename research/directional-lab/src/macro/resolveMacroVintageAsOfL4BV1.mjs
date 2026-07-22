/**
 * L4B-I2 explicit macro vintage as-of resolver. Authority is always relative
 * to one pinned MacroVintageSetManifest and one explicit UTC knowledgeCutoff.
 * No latest-wins rule, no CAS scan, no insertion order, no wall clock.
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertStore,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  assertMacroMaterializationUtcInstant,
} from '../contracts/macroMaterializationContractsL4BV1.mjs';
import {
  MACRO_STORE_METHODS,
  assertExplicitPinnedMacroId,
} from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroAsOfResolutionPolicy } from './macroAsOfResolutionPolicyL4BV1.mjs';
import { verifyMacroVintageSetManifest } from './macroVintageSetL4BV1.mjs';
import { verifyMacroObservationVintageCore } from './macroObservationVintageL4BV1.mjs';

/**
 * Resolve the single admissible vintage for one observation at an explicit
 * knowledge cutoff on a pinned vintage set. Runtime result only — no fifth
 * canonical schema.
 */
export function resolveMacroVintageAsOf(input) {
  const api = assertApiInput(input, [
    'observationIdentityId', 'knowledgeCutoff',
    'macroVintageSetManifestId', 'macroAsOfResolutionPolicyId',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  assertExplicitPinnedMacroId(api.observationIdentityId, 'observationIdentityId');
  assertExplicitPinnedMacroId(api.macroVintageSetManifestId, 'macroVintageSetManifestId');
  assertExplicitPinnedMacroId(api.macroAsOfResolutionPolicyId, 'macroAsOfResolutionPolicyId');
  assertCasId(api.observationIdentityId, 'observationIdentityId');
  assertCasId(api.macroVintageSetManifestId, 'macroVintageSetManifestId');
  assertCasId(api.macroAsOfResolutionPolicyId, 'macroAsOfResolutionPolicyId');
  assertMacroMaterializationUtcInstant(api.knowledgeCutoff, 'knowledgeCutoff');

  const { macroAsOfResolutionPolicy } = verifyMacroAsOfResolutionPolicy({
    store: api.store, macroAsOfResolutionPolicyId: api.macroAsOfResolutionPolicyId,
  });
  if (macroAsOfResolutionPolicy.latestReferencePolicy !== 'FORBIDDEN'
      || macroAsOfResolutionPolicy.registrySelectionPolicy !== 'EXPLICIT_PIN_ONLY') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_LATEST_FORBIDDEN',
      'as-of resolution refuses latest or unpinned registry selection');
  }

  const verifiedSet = verifyMacroVintageSetManifest({
    store: api.store, macroVintageSetManifestId: api.macroVintageSetManifestId,
  });
  const observationEntry = verifiedSet.vintageSet.orderedObservationEntries
    .find((entry) => entry.observationIdentityId === api.observationIdentityId);
  if (!observationEntry) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_REFERENCE_MISMATCH',
      'observation is absent from the pinned vintage set');
  }

  const vintages = [];
  for (const vintageEntry of observationEntry.orderedVintages) {
    const verified = verifyMacroObservationVintageCore({
      store: api.store, observationVintageId: vintageEntry.observationVintageId,
    });
    const vintage = verified.observationVintage;
    if (vintage.observationIdentityId !== api.observationIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_REFERENCE_MISMATCH',
        'vintage set entry belongs to another observation');
    }
    if (vintage.macroVintageIdentityId !== vintageEntry.macroVintageIdentityId
        || vintage.availableAt !== vintageEntry.availableAt
        || vintage.vintageSequence !== vintageEntry.vintageSequence) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_REFERENCE_MISMATCH',
        'vintage set entry diverges from verified vintage content');
    }
    vintages.push({
      observationVintageId: vintageEntry.observationVintageId,
      vintage,
    });
  }

  // Causal graph over the pinned observation vintages only.
  const byIdentityId = new Map();
  for (const item of vintages) {
    if (byIdentityId.has(item.vintage.macroVintageIdentityId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
        'duplicate vintage temporal identity inside the pinned observation');
    }
    byIdentityId.set(item.vintage.macroVintageIdentityId, item);
  }
  const childByParent = new Map();
  for (const item of vintages) {
    const parentId = item.vintage.parentVintageId;
    if (parentId === null) continue;
    if (parentId === item.vintage.macroVintageIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'vintage causal graph contains a self-cycle');
    }
    if (!byIdentityId.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_PARENT_MISMATCH',
        'parent vintage is absent from the pinned observation chain');
    }
    if (childByParent.has(parentId)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
        'concurrent vintage branches refuse as-of resolution');
    }
    childByParent.set(parentId, item.vintage.macroVintageIdentityId);
  }
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_VINTAGE_CYCLE',
        'vintage causal graph contains a cycle');
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    const parentId = byIdentityId.get(id).vintage.parentVintageId;
    if (parentId !== null) visit(parentId);
    state.set(id, 2);
  };
  for (const id of [...byIdentityId.keys()].sort()) visit(id);

  // availableAt <= knowledgeCutoff (exact boundary admissible).
  const admissible = vintages
    .filter((item) => item.vintage.availableAt <= api.knowledgeCutoff)
    .sort((left, right) => {
      if (left.vintage.availableAt < right.vintage.availableAt) return -1;
      if (left.vintage.availableAt > right.vintage.availableAt) return 1;
      if (left.vintage.vintageSequence < right.vintage.vintageSequence) return -1;
      if (left.vintage.vintageSequence > right.vintage.vintageSequence) return 1;
      return 0;
    });

  if (admissible.length === 0) {
    return {
      observationIdentityId: api.observationIdentityId,
      knowledgeCutoff: api.knowledgeCutoff,
      macroVintageSetManifestId: api.macroVintageSetManifestId,
      selectedMacroVintageIdentityId: null,
      selectedMacroObservationVintageId: null,
      selectedAvailableAt: null,
      selectedVintageSequence: null,
      resolutionStatus: 'NOT_AVAILABLE',
    };
  }

  // Walk the single causal chain among admissible vintages; tip is last.
  const admissibleIds = new Set(admissible.map((item) => item.vintage.macroVintageIdentityId));
  const initials = admissible.filter((item) => item.vintage.parentVintageId === null
    || !admissibleIds.has(item.vintage.parentVintageId));
  if (initials.length !== 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
      'admissible vintages do not form a single causal chain tip');
  }
  let tip = initials[0];
  while (childByParent.has(tip.vintage.macroVintageIdentityId)) {
    const childId = childByParent.get(tip.vintage.macroVintageIdentityId);
    if (!admissibleIds.has(childId)) break;
    tip = byIdentityId.get(childId);
  }

  // Same-timestamp / sequence: tip must be the max sequence among admissible
  // on that chain; any other admissible tip is ambiguity.
  const expectedTip = admissible[admissible.length - 1];
  if (tip.vintage.macroVintageIdentityId !== expectedTip.vintage.macroVintageIdentityId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
      'admissible vintage ordering diverges from the single causal chain tip');
  }

  if (tip.vintage.revisionKind === 'WITHDRAWAL') {
    return {
      observationIdentityId: api.observationIdentityId,
      knowledgeCutoff: api.knowledgeCutoff,
      macroVintageSetManifestId: api.macroVintageSetManifestId,
      selectedMacroVintageIdentityId: tip.vintage.macroVintageIdentityId,
      selectedMacroObservationVintageId: tip.observationVintageId,
      selectedAvailableAt: tip.vintage.availableAt,
      selectedVintageSequence: tip.vintage.vintageSequence,
      resolutionStatus: 'WITHDRAWN',
    };
  }

  // V1: restoration after withdrawal is forbidden. If any earlier withdrawal
  // exists on the admissible chain and a later non-withdrawal tip appears,
  // refuse — that would be a V2 restoration policy.
  for (const item of admissible) {
    if (item.vintage.revisionKind !== 'WITHDRAWAL') continue;
    if (item.vintage.availableAt < tip.vintage.availableAt
        || (item.vintage.availableAt === tip.vintage.availableAt
          && item.vintage.vintageSequence < tip.vintage.vintageSequence)) {
      if (tip.vintage.revisionKind !== 'WITHDRAWAL') {
        throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
          'restoration after withdrawal is forbidden in V1');
      }
    }
  }

  return {
    observationIdentityId: api.observationIdentityId,
    knowledgeCutoff: api.knowledgeCutoff,
    macroVintageSetManifestId: api.macroVintageSetManifestId,
    selectedMacroVintageIdentityId: tip.vintage.macroVintageIdentityId,
    selectedMacroObservationVintageId: tip.observationVintageId,
    selectedAvailableAt: tip.vintage.availableAt,
    selectedVintageSequence: tip.vintage.vintageSequence,
    resolutionStatus: 'RESOLVED',
    selectedRevisionKind: tip.vintage.revisionKind,
    selectedCompletenessClass: tip.vintage.vintageCompletenessClass,
  };
}
