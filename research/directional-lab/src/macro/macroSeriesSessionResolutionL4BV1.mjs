/**
 * L4B-F1 per-session macro series resolution with explicit carry-forward age
 * and family staleness. Tip selection mirrors I2 as-of on pinned observation
 * vintages loaded from the verified vintage-set entries (no latest, no CAS
 * scan, no wall clock).
 */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  F1_SERIES_CODES,
  F1_SERIES_FAMILY_BY_CODE,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import { assertMacroMaterializationUtcInstant } from '../contracts/macroMaterializationContractsL4BV1.mjs';
import { MACRO_STORE_METHODS } from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroObservationVintageCore } from './macroObservationVintageL4BV1.mjs';

function emptyResolution(canonicalSeriesCode, availabilityStatus) {
  return {
    canonicalSeriesCode,
    macroSeriesIdentityId: null,
    observationIdentityId: null,
    macroVintageIdentityId: null,
    observationVintageId: null,
    availableAt: null,
    referencePeriod: null,
    revisionKind: null,
    completenessClass: null,
    value: null,
    availabilityStatus,
    carryForwardAgeSessions: 0,
    sourceDocumentId: null,
  };
}

function compareReferencePeriod(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function landingSessionIndex(orderedSessions, availableAt) {
  for (let index = 0; index < orderedSessions.length; index += 1) {
    if (orderedSessions[index].closeUtc >= availableAt) return index;
  }
  return orderedSessions.length - 1;
}

/**
 * Load pinned vintage contents for one observation entry and select the I2 tip
 * at knowledgeCutoff. Entries carry only identity keys; content is verified.
 */
function resolveObservationTipFromPinnedEntry(store, observationEntry, knowledgeCutoff) {
  const vintages = [];
  for (const vintageEntry of observationEntry.orderedVintages) {
    const verified = verifyMacroObservationVintageCore({
      store, observationVintageId: vintageEntry.observationVintageId,
    });
    const vintage = verified.observationVintage;
    if (vintage.observationIdentityId !== observationEntry.observationIdentityId) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_RESOLUTION_MISMATCH',
        'vintage set entry belongs to another observation');
    }
    if (vintage.macroVintageIdentityId !== vintageEntry.macroVintageIdentityId
        || vintage.availableAt !== vintageEntry.availableAt
        || vintage.vintageSequence !== vintageEntry.vintageSequence) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_RESOLUTION_MISMATCH',
        'vintage set entry diverges from verified vintage content');
    }
    vintages.push({ observationVintageId: vintageEntry.observationVintageId, vintage });
  }

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

  const admissible = vintages
    .filter((item) => item.vintage.availableAt <= knowledgeCutoff)
    .sort((left, right) => {
      if (left.vintage.availableAt < right.vintage.availableAt) return -1;
      if (left.vintage.availableAt > right.vintage.availableAt) return 1;
      if (left.vintage.vintageSequence < right.vintage.vintageSequence) return -1;
      if (left.vintage.vintageSequence > right.vintage.vintageSequence) return 1;
      return 0;
    });
  if (admissible.length === 0) {
    return { resolutionStatus: 'NOT_AVAILABLE' };
  }

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
  const expectedTip = admissible[admissible.length - 1];
  if (tip.vintage.macroVintageIdentityId !== expectedTip.vintage.macroVintageIdentityId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
      'admissible vintage ordering diverges from the single causal chain tip');
  }

  if (tip.vintage.revisionKind === 'WITHDRAWAL') {
    return {
      resolutionStatus: 'WITHDRAWN',
      selectedMacroVintageIdentityId: tip.vintage.macroVintageIdentityId,
      selectedMacroObservationVintageId: tip.observationVintageId,
      selectedAvailableAt: tip.vintage.availableAt,
      selectedVintageSequence: tip.vintage.vintageSequence,
      observationVintage: tip.vintage,
    };
  }

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
    resolutionStatus: 'RESOLVED',
    selectedMacroVintageIdentityId: tip.vintage.macroVintageIdentityId,
    selectedMacroObservationVintageId: tip.observationVintageId,
    selectedAvailableAt: tip.vintage.availableAt,
    selectedVintageSequence: tip.vintage.vintageSequence,
    observationVintage: tip.vintage,
  };
}

/**
 * Resolve one F1 series as-of a market session close on a pinned binding.
 * @param {object} input
 */
export function resolveMacroSeriesForSession(input) {
  const api = assertApiInput(input, [
    'binding', 'policy', 'canonicalSeriesCode', 'session', 'orderedSessions',
    'vintageSet', 'seriesRegistry',
  ]);
  assertStore(api.store, MACRO_STORE_METHODS);
  const code = api.canonicalSeriesCode;
  if (!F1_SERIES_CODES.includes(code)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_RESOLUTION_MISMATCH',
      'canonicalSeriesCode is outside the closed F1 series set');
  }
  assertMacroMaterializationUtcInstant(api.session.closeUtc, 'session.closeUtc');
  if (api.session.closeUtc > api.binding.knowledgeCutoff) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_FUTURE_DATA',
      'session closeUtc exceeds binding knowledgeCutoff');
  }
  if (api.policy.latestPolicy !== 'FORBIDDEN' || api.policy.networkPolicy !== 'FORBIDDEN') {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_LATEST_FORBIDDEN',
      'feature policy refuses latest or network');
  }

  const seriesEntry = api.seriesRegistry.orderedSeriesEntries
    .find((entry) => entry.canonicalSeriesCode === code);
  if (!seriesEntry) {
    return emptyResolution(code, 'SERIES_NOT_IN_BINDING');
  }

  const observations = api.vintageSet.orderedObservationEntries
    .filter((entry) => entry.macroSeriesIdentityId === seriesEntry.macroSeriesIdentityId);
  if (observations.length === 0) {
    return {
      ...emptyResolution(code, 'NOT_AVAILABLE'),
      macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
    };
  }

  const knowledgeCutoff = api.session.closeUtc;
  const candidates = [];
  for (const observation of observations) {
    const resolution = resolveObservationTipFromPinnedEntry(
      api.store, observation, knowledgeCutoff,
    );
    if (resolution.resolutionStatus === 'NOT_AVAILABLE') continue;
    candidates.push({ observation, resolution });
  }

  if (candidates.length === 0) {
    return {
      ...emptyResolution(code, 'NOT_AVAILABLE'),
      macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
    };
  }

  candidates.sort((left, right) => {
    const leftPeriod = left.observation.observationPeriodEnd;
    const rightPeriod = right.observation.observationPeriodEnd;
    const periodCmp = compareReferencePeriod(leftPeriod, rightPeriod);
    if (periodCmp !== 0) return -periodCmp;
    if (left.resolution.selectedAvailableAt < right.resolution.selectedAvailableAt) return 1;
    if (left.resolution.selectedAvailableAt > right.resolution.selectedAvailableAt) return -1;
    return 0;
  });

  const tip = candidates[0];
  const observationVintage = tip.resolution.observationVintage;
  if (observationVintage.availableAt > knowledgeCutoff) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_FEATURE_FUTURE_DATA',
      'resolved vintage availableAt exceeds session close');
  }

  const observationIdentity = verifyMacroObservationVintageCore({
    store: api.store,
    observationVintageId: tip.resolution.selectedMacroObservationVintageId,
  }).observationIdentity;

  const currentIndex = api.orderedSessions.findIndex((session) => (
    session.sessionDate === api.session.sessionDate
    && session.openUtc === api.session.openUtc
    && session.closeUtc === api.session.closeUtc
  ));
  if (currentIndex < 0) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_SESSION_REGISTRY_MISMATCH',
      'current session is absent from the ordered session list');
  }
  const landIndex = landingSessionIndex(api.orderedSessions, tip.resolution.selectedAvailableAt);
  const age = currentIndex >= landIndex ? currentIndex - landIndex : 0;

  if (tip.resolution.resolutionStatus === 'WITHDRAWN'
      || observationVintage.revisionKind === 'WITHDRAWAL') {
    return {
      canonicalSeriesCode: code,
      macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
      observationIdentityId: tip.observation.observationIdentityId,
      macroVintageIdentityId: tip.resolution.selectedMacroVintageIdentityId,
      observationVintageId: tip.resolution.selectedMacroObservationVintageId,
      availableAt: tip.resolution.selectedAvailableAt,
      referencePeriod: observationIdentity.referencePeriod,
      revisionKind: observationVintage.revisionKind,
      completenessClass: observationVintage.vintageCompletenessClass,
      value: null,
      availabilityStatus: 'WITHDRAWN',
      carryForwardAgeSessions: age,
      sourceDocumentId: observationVintage.sourceDocumentId,
    };
  }

  const family = F1_SERIES_FAMILY_BY_CODE[code];
  const stalenessLimit = Object.hasOwn(api.policy.stalenessPolicySessionsByFamily, family)
    ? api.policy.stalenessPolicySessionsByFamily[family]
    : null;
  let availabilityStatus = 'AVAILABLE';
  if (stalenessLimit !== null && age > stalenessLimit) {
    availabilityStatus = 'STALE';
  }

  return {
    canonicalSeriesCode: code,
    macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
    observationIdentityId: tip.observation.observationIdentityId,
    macroVintageIdentityId: tip.resolution.selectedMacroVintageIdentityId,
    observationVintageId: tip.resolution.selectedMacroObservationVintageId,
    availableAt: tip.resolution.selectedAvailableAt,
    referencePeriod: observationIdentity.referencePeriod,
    revisionKind: observationVintage.revisionKind,
    completenessClass: observationVintage.vintageCompletenessClass,
    value: observationVintage.value === null ? null : {
      atoms: observationVintage.value.atoms,
      scale: observationVintage.value.scale,
    },
    availabilityStatus,
    carryForwardAgeSessions: age,
    sourceDocumentId: observationVintage.sourceDocumentId,
  };
}
