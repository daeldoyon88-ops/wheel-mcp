import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MACRO_FULL_L4B_F2_ORACLE_VECTORS,
} from './oracles/macroFullFeaturesL4BF2Oracle.mjs';
import {
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  normalizeMarketMacroInstrumentProjectionPolicyV1,
} from '../src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  addMonthsToMonthKey,
  macroNominalDeltaFixed,
  macroRatioChangeFixed,
  macroWindowAverageFixed,
} from '../src/macro/macroFixedPointRatioL4BF2V1.mjs';
import {
  resolveSeriesReferencePeriodAsOf,
} from '../src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';
import { computeClaimsState } from '../src/macro/macroClaimsFeaturesL4BF2V1.mjs';
import { computeFullMacroState } from '../src/macro/macroFullMacroStateL4BF2V1.mjs';
import { projectMacroStateToInstrument } from '../src/macro/marketMacroInstrumentRowsL4BF2V1.mjs';
import { syntheticSeriesIndex, fp } from './helpers/macroSyntheticSeriesIndexL4BF2V1.mjs';

const POLICY = normalizeMarketMacroInstrumentProjectionPolicyV1({
  schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES),
});
const ID = `sha256:${'a'.repeat(64)}`;

function projectionRows(vector) {
  const fullRows = { rows: vector.empty ? [] : [{
    sessionId: ID,
    sessionDate: '2026-01-15',
    fullMacroRegimeState: {
      nominalRateRegime: 'RESTRICTIVE', curveRegime: 'NORMAL',
      inflationRegime: 'MODERATE_AND_FALLING', laborRegime: 'STABLE',
      claimsRegime: 'NORMAL', policyDirection: 'UNCHANGED',
      macroCompositeState: 'DISINFLATIONARY_TIGHT',
      macroDataCompleteness: vector.completeness,
    },
  }] };
  return projectMacroStateToInstrument({
    instrument: {
      instrumentIdentityId: ID, domicileCountry: vector.domicile,
      primaryCurrency: vector.currency, assetClass: 'EQUITY',
      listingIntervals: vector.listed
        ? [{ validFrom: '2020-01-01', validToExclusive: null }]
        : [{ validFrom: '2027-01-01', validToExclusive: null }],
    },
    fullRows,
    fullRowIdentityBySessionId: new Map([[ID, ID]]),
    policy: POLICY,
    projectionPolicyId: ID,
    instrumentRegistryManifestId: ID,
  });
}

function fullStateFor(vector) {
  const f1Row = {
    rateState: { rateRegime: 'RESTRICTIVE', policyDirection: vector.policy },
    curveState: { curveShape: 'NORMAL' },
    availabilityState: { overallF1Completeness: 'COMPLETE' },
  };
  const inflation = {
    inflationState: {
      cpiYoY: fp(30000, 6), inflationDirection: vector.inflation,
    },
    availability: vector.inflation === 'NOT_AVAILABLE' ? 'UNAVAILABLE' : 'COMPLETE',
  };
  const labor = {
    unemploymentState: { unemploymentTrend: vector.labor },
    availability: vector.labor === 'NOT_AVAILABLE' ? 'UNAVAILABLE' : 'COMPLETE',
  };
  const claims = {
    claimsState: { claimsSpikeState: 'NORMAL', claimsTrend: 'STABLE' },
    availability: 'COMPLETE',
  };
  return computeFullMacroState({ f1Row, inflation, labor, claims, policy: POLICY });
}

function executeVector(vector) {
  switch (vector.kind) {
    case 'RATIO':
      assert.deepEqual(macroRatioChangeFixed(vector.numerator, vector.denominator, 'ORACLE'), vector.expected);
      return;
    case 'MONTH':
      assert.equal(addMonthsToMonthKey(vector.monthKey, vector.delta), vector.expected);
      return;
    case 'DELTA':
      assert.deepEqual(macroNominalDeltaFixed(vector.left, vector.right, 'ORACLE'), vector.expected);
      return;
    case 'AVERAGE':
      assert.deepEqual(macroWindowAverageFixed(vector.values, vector.values.length, 0, 'ORACLE'), vector.expected);
      return;
    case 'AS_OF': { // Initial, future revision, after-close and withdrawal boundaries.
      const index = syntheticSeriesIndex('ORACLE-ASOF', [{
        referencePeriod: '2025-12',
        vintages: [
          { availableAt: '2026-01-10T13:30:00.000Z', value: fp(100, 0) },
          { availableAt: '2026-01-20T13:30:00.000Z', sequence: 1, parentSequence: 0, value: fp(105, 0) },
          { availableAt: '2026-01-30T13:30:00.000Z', sequence: 2, parentSequence: 1, revisionKind: 'WITHDRAWAL', value: null },
        ],
      }]);
      const actual = resolveSeriesReferencePeriodAsOf(index, '2025-12', vector.cutoff);
      assert.equal(actual.resolutionStatus, vector.expectedStatus);
      assert.equal(actual.value?.atoms ?? null, vector.expectedAtoms);
      return;
    }
    case 'CLAIMS_BAND': {
      const index = syntheticSeriesIndex('ORACLE-CLAIMS', [{
        referencePeriod: '2026-01-10',
        vintages: [{ availableAt: '2026-01-15T13:30:00.000Z', value: fp(vector.atoms, 0) }],
      }]);
      const actual = computeClaimsState({
        claimsIndex: index, knowledgeCutoff: '2026-01-15T21:00:00.000Z',
        sessionDate: '2026-01-15', policy: POLICY,
      });
      assert.equal(actual.claimsState.claimsSpikeState, vector.expected);
      return;
    }
    case 'COMPOSITE':
      assert.equal(fullStateFor(vector).fullMacroRegimeState.macroCompositeState, vector.expected);
      return;
    case 'PROJECTION': {
      const rows = projectionRows(vector);
      assert.equal(rows.length === 0 ? 'EMPTY' : rows[0].projectionStatus, vector.expected);
      return;
    }
    default:
      assert.fail(`unknown independent oracle vector kind ${vector.kind}`);
  }
}

for (const vector of MACRO_FULL_L4B_F2_ORACLE_VECTORS) {
  test(`independent oracle ${vector.name}`, () => executeVector(vector));
}

test('oracle isolation guard forbids all production and dynamic imports', () => {
  const source = readFileSync(new URL('./oracles/macroFullFeaturesL4BF2Oracle.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(^|\n)\s*import\s/mu);
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(source, /(?:builder|verifier|computer|projection|report).*L4BF2V1/u);
  assert.equal(MACRO_FULL_L4B_F2_ORACLE_VECTORS.length, 80);
});
