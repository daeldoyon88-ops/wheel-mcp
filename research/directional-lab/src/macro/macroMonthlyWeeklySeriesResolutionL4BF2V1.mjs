/**
 * L4B-F2 per-reference-period as-of resolution for the monthly (CPI, UNRATE) and
 * weekly (ICSA) series. The admissible-tip selection is a faithful port of the
 * L4B-I2 resolveMacroVintageAsOf semantics (single causal chain, availableAt <=
 * cutoff, withdrawal removes availability, restoration forbidden). The pinned
 * observation vintages are verified once per series and selected in memory per
 * session, so no vintage set is rescanned per session and no CAS is scanned.
 */

import {
  MarketDataL3Error,
  assertStore,
} from '../contracts/marketDataL3CommonV1.mjs';
import { MACRO_STORE_METHODS } from './macroIngestionPolicyL4BV1.mjs';
import { verifyMacroObservationVintageCore } from './macroObservationVintageL4BV1.mjs';

/**
 * Precompute the verified vintage chain of one observation entry once. The
 * causal graph (duplicate identity, concurrent branch, self-cycle, missing
 * parent, cycle) is validated here — exactly as the I2 resolver does — so the
 * per-session selection is a pure filter.
 */
function buildObservationChain(store, observationEntry) {
  const vintages = [];
  let referencePeriod = null;
  for (const vintageEntry of observationEntry.orderedVintages) {
    const verified = verifyMacroObservationVintageCore({
      store, observationVintageId: vintageEntry.observationVintageId,
    });
    const vintage = verified.observationVintage;
    if (referencePeriod === null) referencePeriod = verified.observationIdentity.referencePeriod;
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
  return { chain: buildChainFromVintages(vintages), referencePeriod };
}

/**
 * Build and validate the causal graph over one observation's pinned vintages.
 * Pure: identical checks to the L4B-I2 resolver, no store access. Shared by the
 * production path and synthetic test indices so there is one implementation.
 * @param {{observationVintageId: string, vintage: object}[]} vintages
 */
export function buildChainFromVintages(vintages) {
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

  return { vintages, byIdentityId, childByParent };
}

/**
 * Select the single admissible causal tip at knowledgeCutoff on a precomputed
 * observation chain. Byte-identical selection to L4B-I2 resolveMacroVintageAsOf.
 */
function selectTipAsOf(chain, knowledgeCutoff) {
  const admissible = chain.vintages
    .filter((item) => item.vintage.availableAt <= knowledgeCutoff)
    .sort((left, right) => {
      if (left.vintage.availableAt < right.vintage.availableAt) return -1;
      if (left.vintage.availableAt > right.vintage.availableAt) return 1;
      if (left.vintage.vintageSequence < right.vintage.vintageSequence) return -1;
      if (left.vintage.vintageSequence > right.vintage.vintageSequence) return 1;
      return 0;
    });
  if (admissible.length === 0) return { resolutionStatus: 'NOT_AVAILABLE' };

  const admissibleIds = new Set(admissible.map((item) => item.vintage.macroVintageIdentityId));
  const initials = admissible.filter((item) => item.vintage.parentVintageId === null
    || !admissibleIds.has(item.vintage.parentVintageId));
  if (initials.length !== 1) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
      'admissible vintages do not form a single causal chain tip');
  }
  let tip = initials[0];
  while (chain.childByParent.has(tip.vintage.macroVintageIdentityId)) {
    const childId = chain.childByParent.get(tip.vintage.macroVintageIdentityId);
    if (!admissibleIds.has(childId)) break;
    tip = chain.byIdentityId.get(childId);
  }
  const expectedTip = admissible[admissible.length - 1];
  if (tip.vintage.macroVintageIdentityId !== expectedTip.vintage.macroVintageIdentityId) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
      'admissible vintage ordering diverges from the single causal chain tip');
  }
  if (tip.vintage.revisionKind === 'WITHDRAWAL') {
    return {
      resolutionStatus: 'WITHDRAWN',
      observationVintageId: tip.observationVintageId,
      macroVintageIdentityId: tip.vintage.macroVintageIdentityId,
      availableAt: tip.vintage.availableAt,
      vintageSequence: tip.vintage.vintageSequence,
      revisionKind: tip.vintage.revisionKind,
      completenessClass: tip.vintage.vintageCompletenessClass,
      value: null,
    };
  }
  for (const item of admissible) {
    if (item.vintage.revisionKind !== 'WITHDRAWAL') continue;
    if (item.vintage.availableAt < tip.vintage.availableAt
        || (item.vintage.availableAt === tip.vintage.availableAt
          && item.vintage.vintageSequence < tip.vintage.vintageSequence)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS',
        'restoration after withdrawal is forbidden in V1');
    }
  }
  return {
    resolutionStatus: 'RESOLVED',
    observationVintageId: tip.observationVintageId,
    macroVintageIdentityId: tip.vintage.macroVintageIdentityId,
    availableAt: tip.vintage.availableAt,
    vintageSequence: tip.vintage.vintageSequence,
    revisionKind: tip.vintage.revisionKind,
    completenessClass: tip.vintage.vintageCompletenessClass,
    value: tip.vintage.value === null ? null
      : { atoms: tip.vintage.value.atoms, scale: tip.vintage.value.scale },
  };
}

/**
 * Build a reusable series index for one canonical F2 series over the pinned
 * vintage set. Reference periods key monthly (YYYY-MM) or weekly (YYYY-MM-DD).
 * @returns {{status: 'INDEXED'|'SERIES_NOT_IN_BINDING'|'NO_OBSERVATIONS',
 *   macroSeriesIdentityId: string|null,
 *   byReferencePeriod: Map<string, object>, orderedReferencePeriods: string[]}}
 */
export function buildMonthlyWeeklySeriesIndex(input) {
  const { store, vintageSet, seriesRegistry, canonicalSeriesCode } = input;
  assertStore(store, MACRO_STORE_METHODS);
  const seriesEntry = seriesRegistry.orderedSeriesEntries
    .find((entry) => entry.canonicalSeriesCode === canonicalSeriesCode
      && entry.status === 'ACTIVE');
  if (!seriesEntry) {
    return {
      status: 'SERIES_NOT_IN_BINDING', macroSeriesIdentityId: null,
      byReferencePeriod: new Map(), orderedReferencePeriods: [],
    };
  }
  const observations = vintageSet.orderedObservationEntries
    .filter((entry) => entry.macroSeriesIdentityId === seriesEntry.macroSeriesIdentityId);
  if (observations.length === 0) {
    return {
      status: 'NO_OBSERVATIONS', macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
      byReferencePeriod: new Map(), orderedReferencePeriods: [],
    };
  }
  const byReferencePeriod = new Map();
  for (const observation of observations) {
    const { chain, referencePeriod } = buildObservationChain(store, observation);
    if (byReferencePeriod.has(referencePeriod)) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_SERIES_RESOLUTION_MISMATCH',
        'two observation entries share one reference period for a single series');
    }
    byReferencePeriod.set(referencePeriod, {
      referencePeriod,
      observationIdentityId: observation.observationIdentityId,
      observationPeriodStart: observation.observationPeriodStart,
      observationPeriodEnd: observation.observationPeriodEnd,
      chain,
    });
  }
  const orderedReferencePeriods = [...byReferencePeriod.keys()].sort();
  return {
    status: 'INDEXED', macroSeriesIdentityId: seriesEntry.macroSeriesIdentityId,
    byReferencePeriod, orderedReferencePeriods,
  };
}

/**
 * Resolve one exact reference period as-of a session close. Returns a closed
 * resolution record; NOT_AVAILABLE when the period is absent or has no
 * admissible tip.
 */
export function resolveSeriesReferencePeriodAsOf(seriesIndex, referencePeriod, knowledgeCutoff) {
  const entry = seriesIndex.byReferencePeriod.get(referencePeriod);
  if (!entry) {
    return { resolutionStatus: 'NOT_AVAILABLE', referencePeriod, present: false };
  }
  const tip = selectTipAsOf(entry.chain, knowledgeCutoff);
  return {
    ...tip,
    referencePeriod,
    present: true,
    observationIdentityId: entry.observationIdentityId,
    observationPeriodStart: entry.observationPeriodStart,
    observationPeriodEnd: entry.observationPeriodEnd,
  };
}

/**
 * The latest reference period whose admissible tip exists (RESOLVED or
 * WITHDRAWN) as-of the cutoff — the causal "current" observation. Reference
 * periods strictly after the cutoff's own period never win because their
 * vintages have availableAt after the cutoff.
 */
export function mostRecentAdmissibleReferencePeriodAsOf(
  seriesIndex, knowledgeCutoff, maximumReferencePeriod,
) {
  for (let index = seriesIndex.orderedReferencePeriods.length - 1; index >= 0; index -= 1) {
    const referencePeriod = seriesIndex.orderedReferencePeriods[index];
    if (referencePeriod > maximumReferencePeriod) continue;
    const resolution = resolveSeriesReferencePeriodAsOf(seriesIndex, referencePeriod, knowledgeCutoff);
    if (resolution.resolutionStatus === 'RESOLVED' || resolution.resolutionStatus === 'WITHDRAWN') {
      return resolution;
    }
  }
  return null;
}
