/**
 * L4B-F2 CPI successor policy V2 (OWNER_DECIDE_GATE25_CPI_SUCCESSOR_POLICY_R1,
 * OPTION A). Additive and versioned: macroFullFeatureContractsL4BF2V1.mjs and
 * its closed MarketMacroInstrumentProjectionPolicy/1 singleton are unchanged and
 * remain fully reproducible.
 *
 * The only semantic delta is the CPI YoY historical window/admission rule. V1
 * requires every intervening reference month of the YoY window to be causally
 * available (ALL_INTERMEDIATE_MONTHS_REQUIRED, 13 observations). V2 requires
 * exactly the two endpoint observations CPI(m) and CPI(m - 12 reference months),
 * both genuinely present and admissible at K(T)
 * (ENDPOINTS_M_AND_M_MINUS_12_REQUIRED, 2 observations). A month that was never
 * published stays absent; nothing is fabricated, interpolated or forward filled.
 * Economic quantity, series, vintage model, availableAt rules, unit, scale,
 * fixed-point, rounding, staleness and every other value are inherited from V1.
 */

import { MarketDataL3Error, assertSchemaVersion } from './marketDataL3CommonV1.mjs';
import { closedFeatureRecord, copyClosed, sameClosedValue } from './macroFeatureContractsL4BV1.mjs';
import {
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VERSION,
} from './macroFullFeatureContractsL4BF2V1.mjs';

export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION =
  'MarketMacroInstrumentProjectionPolicy/2';
export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VERSION =
  'MARKET_MACRO_INSTRUMENT_PROJECTION_L4B_F2_V2';

/** Owner-authorized successor token and its closed endpoint lag. */
export const CPI_YOY_ENDPOINT_WINDOW_POLICY_V2 = 'ENDPOINTS_M_AND_M_MINUS_12_REQUIRED';
export const CPI_YOY_ENDPOINT_LAG_MONTHS_V2 = 12;
export const CPI_YOY_V1_WINDOW_POLICY = 'ALL_INTERMEDIATE_MONTHS_REQUIRED';

export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES = Object.freeze({
  ...MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
  policyVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VERSION,
  cpiMinObservationsForYoY: 2,
  monthlyWindowPolicy: CPI_YOY_ENDPOINT_WINDOW_POLICY_V2,
});

/** The exact, closed V1 -> V2 semantic delta. Any other difference is a defect. */
export const MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V1_TO_V2_DELTA = Object.freeze([
  Object.freeze({ field: 'schemaVersion', v1: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION, v2: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION }),
  Object.freeze({ field: 'policyVersion', v1: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VERSION, v2: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VERSION }),
  Object.freeze({ field: 'cpiMinObservationsForYoY', v1: 13, v2: 2 }),
  Object.freeze({ field: 'monthlyWindowPolicy', v1: CPI_YOY_V1_WINDOW_POLICY, v2: CPI_YOY_ENDPOINT_WINDOW_POLICY_V2 }),
]);

const V2_FIELDS = Object.freeze(['schemaVersion', ...Object.keys(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES)]);

/* Module-load self check: V2 carries exactly the V1 field set and differs only by the declared delta. */
{
  const v1Keys = Object.keys(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES);
  const v2Keys = Object.keys(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES);
  const declared = new Set(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V1_TO_V2_DELTA.map((item) => item.field));
  const differing = v1Keys.filter((key) => !sameClosedValue(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES[key],
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES[key]));
  if (v1Keys.join('|') !== v2Keys.join('|') || differing.some((key) => !declared.has(key))
    || MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES.monthlyWindowPolicy !== CPI_YOY_V1_WINDOW_POLICY
    || MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES.cpiMinObservationsForYoY !== 13) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_INSTRUMENT_POLICY_V2_DELTA_INVALID',
      'V2 successor policy diverges from V1 beyond the declared CPI YoY window delta');
  }
}

export function normalizeMarketMacroInstrumentProjectionPolicyV2(value) {
  const code = 'MARKET_DATA_MACRO_INSTRUMENT_POLICY_INVALID';
  const policy = closedFeatureRecord(value, V2_FIELDS,
    MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION, code);
  assertSchemaVersion(policy, MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION);
  for (const [field, expected] of Object.entries(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES)) {
    if (!sameClosedValue(policy[field], expected)) {
      throw new MarketDataL3Error(code, `policy field ${field} diverges from closed V2`);
    }
  }
  return {
    schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION,
    ...copyClosed(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES),
  };
}
