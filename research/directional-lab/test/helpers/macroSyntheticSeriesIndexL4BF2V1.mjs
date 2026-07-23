/**
 * Test-only synthetic series index builder for the L4B-F2 feature computers. It
 * reuses the production buildChainFromVintages so the causal selection is
 * identical to the store-backed path, without any CAS. Lets CPI/UNRATE/claims
 * edge cases (missing period, revision, withdrawal, spike) be exercised
 * exhaustively.
 */

import { sha256Digest } from '../../src/contracts/marketDataL3CommonV1.mjs';
import { buildChainFromVintages } from '../../src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';

function fakeId(label) {
  return sha256Digest(`SYNTHETIC_L4BF2 ${label}`);
}

/**
 * @param {string} seriesLabel
 * @param {Array<{referencePeriod: string, periodStart?: string, periodEnd?: string,
 *   vintages: Array<{availableAt: string, sequence?: number, value: object|null,
 *     revisionKind?: string, parentSequence?: number|null, completeness?: string}>}>} observations
 */
export function syntheticSeriesIndex(seriesLabel, observations) {
  const byReferencePeriod = new Map();
  for (const obs of observations) {
    const observationIdentityId = fakeId(`${seriesLabel} obs ${obs.referencePeriod}`);
    const vintageIdBySequence = new Map();
    for (const v of obs.vintages) {
      const sequence = v.sequence ?? 0;
      vintageIdBySequence.set(sequence, fakeId(`${seriesLabel} ${obs.referencePeriod} seq ${sequence}`));
    }
    const vintages = obs.vintages.map((v) => {
      const sequence = v.sequence ?? 0;
      const parentSequence = v.parentSequence ?? null;
      return {
        observationVintageId: fakeId(`${seriesLabel} ${obs.referencePeriod} content ${sequence}`),
        vintage: {
          availableAt: v.availableAt,
          vintageSequence: sequence,
          macroVintageIdentityId: vintageIdBySequence.get(sequence),
          parentVintageId: parentSequence === null ? null : vintageIdBySequence.get(parentSequence),
          revisionKind: v.revisionKind ?? (sequence === 0 ? 'INITIAL' : 'REVISION'),
          vintageCompletenessClass: v.completeness ?? 'VINTAGE_PARTIAL',
          value: v.value,
        },
      };
    });
    byReferencePeriod.set(obs.referencePeriod, {
      referencePeriod: obs.referencePeriod,
      observationIdentityId,
      observationPeriodStart: obs.periodStart ?? obs.referencePeriod,
      observationPeriodEnd: obs.periodEnd ?? obs.referencePeriod,
      chain: buildChainFromVintages(vintages),
    });
  }
  return {
    status: 'INDEXED',
    macroSeriesIdentityId: fakeId(`${seriesLabel} series`),
    byReferencePeriod,
    orderedReferencePeriods: [...byReferencePeriod.keys()].sort(),
  };
}

/** A convenience canonical fixed-point value. */
export function fp(atoms, scale) {
  return { atoms: String(atoms), scale };
}
