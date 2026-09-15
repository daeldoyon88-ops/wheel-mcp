/**
 * F2_REALIZED_VOLATILITY production producer for the GATE25 historical regime
 * foundation R1.
 *
 * Implements the Owner-ratified semantic declaration exactly
 * (jarviseG24RatifiedParametersR1.mjs::G24_FEATURE_SEMANTICS_R1, formula
 * WHEEL_JARVISE_REALIZED_VOLATILITY/1):
 *   window      21 trading-session returns from 22 closes anchored at T
 *   return      r_i = ln(close_i / close_{i-1})
 *   mean        sum(r_i) / 21
 *   estimator   sample standard deviation, s = sqrt(sum((r_i - mean)^2) / 20)
 *   annualized  s * sqrt(252)   (FIXED_V1)
 *   unit        ANNUALIZED_DECIMAL_FRACTION, range [0, +infinity)
 *
 * The definition is registered through the unchanged GATE23 defineFeature
 * primitive as a declared NON-CORE member; GATE23 CORE_FEATURE_SET_V1 is not
 * widened. Window resolution, causal admission and missingness stay with the
 * GATE23 materializer: a short calendar window is INSUFFICIENT_DATA, a missing
 * or invalid bar inside a full window is FAIL_CLOSED. This compute function
 * re-checks its own inputs so a direct call can never produce a partial window.
 *
 * Pure: no network, no wall clock, no random source, fixed summation order.
 */

import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { defineFeature } from '../../governance/gates/GATE23/implementation/feature-registry-v1.mjs';
import { G24_FEATURE_SEMANTICS_R1 } from './jarviseG24RatifiedParametersR1.mjs';

export const F2_FEATURE_DEFINITION_ID_R1 = 'F2_REALIZED_VOLATILITY';
export const F2_FAMILY_ID_R1 = 'F2_REALIZED_VOLATILITY';
export const F2_FORMULA_ID_R1 = 'WHEEL_JARVISE_REALIZED_VOLATILITY/1';
export const F2_FORMULA_VERSION_R1 = '1';
export const F2_SESSION_COUNT_R1 = 21;
export const F2_OBSERVED_CLOSE_COUNT_R1 = 22;
export const F2_SAMPLE_VARIANCE_DIVISOR_R1 = 20;
export const F2_ANNUALIZATION_SESSIONS_R1 = 252;
export const F2_PRODUCER_STATUS_R1 = 'IMPLEMENTED_BY_GATE25_HISTORICAL_REGIME_FOUNDATION_R1';

const status = (value, code, result = null) => Object.freeze({ status: value, code, value: result });

/** WHEEL_JARVISE_REALIZED_VOLATILITY/1 over exactly 22 closes. */
export function computeRealizedVolatilityR1({ closes } = {}) {
  if (!Array.isArray(closes) || closes.length < F2_OBSERVED_CLOSE_COUNT_R1) {
    return status('INSUFFICIENT_DATA', 'INSUFFICIENT_SESSIONS_IN_WINDOW');
  }
  if (closes.length !== F2_OBSERVED_CLOSE_COUNT_R1) return status('FAIL_CLOSED', 'WINDOW_CLOSE_COUNT_INVALID');
  if (closes.some((close) => close === null || close === undefined)) return status('FAIL_CLOSED', 'INPUT_MISSING');
  if (closes.some((close) => typeof close !== 'number' || !Number.isFinite(close) || close <= 0)) {
    return status('FAIL_CLOSED', 'INVALID_INPUT');
  }
  const returns = new Array(F2_SESSION_COUNT_R1);
  let sum = 0;
  for (let index = 1; index < F2_OBSERVED_CLOSE_COUNT_R1; index += 1) {
    const value = Math.log(closes[index] / closes[index - 1]);
    returns[index - 1] = value;
    sum += value;
  }
  const mean = sum / F2_SESSION_COUNT_R1;
  let squares = 0;
  for (const value of returns) squares += (value - mean) ** 2;
  const sample = Math.sqrt(squares / F2_SAMPLE_VARIANCE_DIVISOR_R1);
  const annualized = sample * Math.sqrt(F2_ANNUALIZATION_SESSIONS_R1);
  if (!Number.isFinite(annualized) || annualized < 0) return status('FAIL_CLOSED', 'NON_FINITE_RESULT');
  return status('RESOLVED', null, annualized === 0 ? 0 : annualized);
}

export const F2_REALIZED_VOLATILITY_DEFINITION_R1 = defineFeature({
  featureDefinitionId: F2_FEATURE_DEFINITION_ID_R1,
  familyId: F2_FAMILY_ID_R1,
  formulaId: F2_FORMULA_ID_R1,
  formulaVersion: F2_FORMULA_VERSION_R1,
  requiredObservedFields: ['close'],
  compute: ({ closes }) => computeRealizedVolatilityR1({ closes }),
});

/** The ratified semantic declaration this producer implements, looked up, never restated. */
export function ratifiedF2SemanticDeclarationR1() {
  const declaration = G24_FEATURE_SEMANTICS_R1.find((item) => item.featureDefinitionId === F2_FEATURE_DEFINITION_ID_R1);
  if (!declaration) throw new Error('F2_RATIFIED_SEMANTIC_DECLARATION_ABSENT');
  return declaration;
}

/**
 * Producer declaration: byte-for-byte the ratified semantics, with producerStatus
 * advanced from NOT_IMPLEMENTED. Every other semantic field must be identical.
 */
export function describeF2ProducerR1() {
  const ratified = ratifiedF2SemanticDeclarationR1();
  const { producerStatus: ratifiedProducerStatus, ...semantics } = ratified;
  const definitionMatches = semantics.featureDefinitionId === F2_REALIZED_VOLATILITY_DEFINITION_R1.featureDefinitionId
    && semantics.familyId === F2_REALIZED_VOLATILITY_DEFINITION_R1.familyId
    && semantics.formulaId === F2_REALIZED_VOLATILITY_DEFINITION_R1.formulaId
    && semantics.formulaVersion === F2_REALIZED_VOLATILITY_DEFINITION_R1.formulaVersion
    && semantics.sessionCount === F2_SESSION_COUNT_R1
    && semantics.observedSessionCount === F2_OBSERVED_CLOSE_COUNT_R1
    && semantics.divisor === F2_SAMPLE_VARIANCE_DIVISOR_R1
    && semantics.annualizationFactor === `sqrt(${F2_ANNUALIZATION_SESSIONS_R1})`
    && JSON.stringify(semantics.requiredObservedFields) === JSON.stringify(F2_REALIZED_VOLATILITY_DEFINITION_R1.requiredObservedFields);
  if (!definitionMatches) throw new Error('F2_PRODUCER_DIVERGES_FROM_RATIFIED_SEMANTICS');
  return Object.freeze({
    schemaVersion: 'WHEEL_JARVISE_G25_HISTORICAL_F2_PRODUCER_DECLARATION/1',
    ratifiedSemanticDeclarationSha256: sha256Canonical(ratified),
    ratifiedProducerStatus,
    producerStatus: F2_PRODUCER_STATUS_R1,
    semantics: Object.freeze({ ...semantics }),
    gate23Registration: 'defineFeature, declared NON-CORE vector member; CORE_FEATURE_SET_V1 unchanged',
    networkAccess: 'NONE',
    wallClockAsInput: 'NONE',
  });
}
