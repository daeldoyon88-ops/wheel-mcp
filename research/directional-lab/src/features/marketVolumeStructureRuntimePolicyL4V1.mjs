/**
 * Pure adapter from a verified canonical L4A-B policy to mandatory runtime
 * calculator configuration. No financial value is defaulted here: every
 * period, window, threshold, ratio, scale and behavior comes from the input.
 */

import {
  MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1,
  extractMarketVolumeStructureFeaturePolicyValuesV1,
} from '../contracts/marketVolumeStructureFeaturePolicyValuesL4V1.mjs';
import {
  FEATURE_CALCULATION_SCALE,
  FEATURE_PRICE_SCALE,
  FEATURE_RATIO_SCALE,
  powerOfTen,
} from './fixedPointFeatureMathL4V1.mjs';

const POLICY_SCHEMA_VERSION = 'MarketVolumeStructureFeatureComputationPolicy/1';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function assertExactFields(value, fields, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} must contain exactly: ${expected.join(', ')}`);
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive safe integer`);
  return value;
}

function positiveIntegerArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  const normalized = value.map((item, index) => positiveInteger(item, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new RangeError(`${label} must not contain duplicates`);
  return normalized;
}

function requiredTrue(value, label) {
  if (value !== true) throw new RangeError(`${label} must be true for closed V1 execution`);
}

function exactRatio(value, label) {
  assertExactFields(value, ['numerator', 'denominator'], label);
  if (typeof value.numerator !== 'bigint' || typeof value.denominator !== 'bigint'
      || value.denominator <= 0n || value.numerator < 0n) {
    throw new RangeError(`${label} must be a non-negative BigInt ratio with a positive denominator`);
  }
  return value;
}

function canonicalFixedToRatio(value, label) {
  assertExactFields(value, ['atoms', 'scale'], label);
  if (typeof value.atoms !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value.atoms)) {
    throw new TypeError(`${label}.atoms must be a canonical non-negative integer string`);
  }
  if (!Number.isSafeInteger(value.scale) || value.scale < 0) {
    throw new RangeError(`${label}.scale must be a non-negative safe integer`);
  }
  return { numerator: BigInt(value.atoms), denominator: powerOfTen(value.scale) };
}

const SCALE_FIELDS = Object.freeze(['internalScale', 'ratioScale', 'priceScale', 'halfEven']);

function assertScales(scales, label) {
  assertExactFields(scales, SCALE_FIELDS, label);
  positiveInteger(scales.internalScale, `${label}.internalScale`);
  positiveInteger(scales.ratioScale, `${label}.ratioScale`);
  positiveInteger(scales.priceScale, `${label}.priceScale`);
  requiredTrue(scales.halfEven, `${label}.halfEven`);
  if (scales.internalScale !== FEATURE_CALCULATION_SCALE
      || scales.ratioScale !== FEATURE_RATIO_SCALE
      || scales.priceScale !== FEATURE_PRICE_SCALE) {
    throw new RangeError('L4A-B policy scales are inconsistent with the fixed-point primitives');
  }
}

const SECTION_FIELDS = Object.freeze({
  barInputs: ['scales'],
  volumeParticipation: [
    'scales', 'baselinePeriods', 'excludeCurrentFromBaselines', 'percentileWindow',
    'obvStartsAtZero', 'obvDeltaPeriods', 'adLineStartsAtZero', 'adLineDeltaPeriod',
    'flatRangeUsesZeroMoneyFlow', 'mfiPeriod', 'cmfPeriod', 'priceVolumeComparisonPeriod',
  ],
  eodVolumeWeightedPrices: [
    'scales', 'rollingPeriods', 'dailyOhlcvApproximationOnly',
    'anchorActivatesAtConfirmationWithKnownPivotBars',
  ],
  pivots: [
    'scales', 'radius', 'confirmationDelay', 'strictNoPlateau', 'swingLowFirst',
    'keepExtremeThenMostRecentlyConfirmed',
  ],
  supportResistance: [
    'scales', 'structureLookback', 'touchLookback', 'mostRecentlyConfirmedTieBreak',
    'priceTolerance', 'atrTolerance', 'useMaximumTolerance',
  ],
  gapsBreakouts: [
    'scales', 'volumeThreshold', 'failedEventWindow', 'openGapLookback',
    'excludeGapsStraddlingClose', 'nearestBoundaryThenMostRecentTieBreak',
  ],
  congestion: [
    'scales', 'window', 'referenceWindow', 'efficiencyThreshold', 'atrMultiplier',
  ],
  fibonacci: ['scales', 'ratios'],
});

/** Fail-closed validation used at every pure calculator boundary. */
export function assertMarketVolumeStructureRuntimeSectionV1(section, name) {
  const fields = SECTION_FIELDS[name];
  if (!fields) throw new TypeError(`unknown L4A-B runtime section: ${String(name)}`);
  assertExactFields(section, fields, `${name} runtime config`);
  assertScales(section.scales, `${name}.scales`);
  if (name === 'barInputs') return section;
  if (name === 'volumeParticipation') {
    positiveIntegerArray(section.baselinePeriods, 'baselinePeriods');
    requiredTrue(section.excludeCurrentFromBaselines, 'excludeCurrentFromBaselines');
    positiveInteger(section.percentileWindow, 'percentileWindow');
    requiredTrue(section.obvStartsAtZero, 'obvStartsAtZero');
    positiveIntegerArray(section.obvDeltaPeriods, 'obvDeltaPeriods');
    requiredTrue(section.adLineStartsAtZero, 'adLineStartsAtZero');
    positiveInteger(section.adLineDeltaPeriod, 'adLineDeltaPeriod');
    requiredTrue(section.flatRangeUsesZeroMoneyFlow, 'flatRangeUsesZeroMoneyFlow');
    positiveInteger(section.mfiPeriod, 'mfiPeriod');
    positiveInteger(section.cmfPeriod, 'cmfPeriod');
    positiveInteger(section.priceVolumeComparisonPeriod, 'priceVolumeComparisonPeriod');
  } else if (name === 'eodVolumeWeightedPrices') {
    positiveIntegerArray(section.rollingPeriods, 'rollingPeriods');
    requiredTrue(section.dailyOhlcvApproximationOnly, 'dailyOhlcvApproximationOnly');
    requiredTrue(
      section.anchorActivatesAtConfirmationWithKnownPivotBars,
      'anchorActivatesAtConfirmationWithKnownPivotBars',
    );
  } else if (name === 'pivots') {
    positiveInteger(section.radius, 'radius');
    positiveInteger(section.confirmationDelay, 'confirmationDelay');
    if (section.confirmationDelay < section.radius) {
      throw new RangeError('confirmationDelay must be at least radius to preserve causality');
    }
    requiredTrue(section.strictNoPlateau, 'strictNoPlateau');
    requiredTrue(section.swingLowFirst, 'swingLowFirst');
    requiredTrue(section.keepExtremeThenMostRecentlyConfirmed, 'keepExtremeThenMostRecentlyConfirmed');
  } else if (name === 'supportResistance') {
    positiveInteger(section.structureLookback, 'structureLookback');
    positiveInteger(section.touchLookback, 'touchLookback');
    requiredTrue(section.mostRecentlyConfirmedTieBreak, 'mostRecentlyConfirmedTieBreak');
    exactRatio(section.priceTolerance, 'priceTolerance');
    exactRatio(section.atrTolerance, 'atrTolerance');
    requiredTrue(section.useMaximumTolerance, 'useMaximumTolerance');
  } else if (name === 'gapsBreakouts') {
    exactRatio(section.volumeThreshold, 'volumeThreshold');
    positiveInteger(section.failedEventWindow, 'failedEventWindow');
    positiveInteger(section.openGapLookback, 'openGapLookback');
    requiredTrue(section.excludeGapsStraddlingClose, 'excludeGapsStraddlingClose');
    requiredTrue(section.nearestBoundaryThenMostRecentTieBreak, 'nearestBoundaryThenMostRecentTieBreak');
  } else if (name === 'congestion') {
    positiveInteger(section.window, 'window');
    positiveInteger(section.referenceWindow, 'referenceWindow');
    exactRatio(section.efficiencyThreshold, 'efficiencyThreshold');
    exactRatio(section.atrMultiplier, 'atrMultiplier');
  } else if (name === 'fibonacci') {
    if (!Array.isArray(section.ratios) || section.ratios.length === 0) {
      throw new TypeError('ratios must be a non-empty array');
    }
    section.ratios.forEach((ratio, index) => {
      assertExactFields(ratio, ['suffix', 'numerator', 'denominator'], `ratios[${index}]`);
      if (typeof ratio.suffix !== 'string' || !/^(?:0|[1-9]\d*)$/.test(ratio.suffix)) {
        throw new TypeError(`ratios[${index}].suffix must be a canonical non-negative integer string`);
      }
      exactRatio({ numerator: ratio.numerator, denominator: ratio.denominator }, `ratios[${index}]`);
    });
  }
  return section;
}

/** @param {unknown} verifiedPolicy normalized output of the CAS policy verifier */
export function deriveMarketVolumeStructureRuntimePolicyV1(verifiedPolicy) {
  assertExactFields(
    verifiedPolicy,
    ['schemaVersion', ...Object.keys(MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1)],
    'verified L4A-B policy',
  );
  if (verifiedPolicy.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new TypeError(`verified L4A-B policy must use ${POLICY_SCHEMA_VERSION}`);
  }
  assertClosedMarketVolumeStructureFeaturePolicyValuesV1(
    extractMarketVolumeStructureFeaturePolicyValuesV1(verifiedPolicy),
  );
  const scales = {
    internalScale: verifiedPolicy.internalScale,
    ratioScale: verifiedPolicy.ratioScale,
    priceScale: verifiedPolicy.priceScale,
    halfEven: verifiedPolicy.roundingMode
      === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.roundingMode,
  };
  assertScales(scales, 'policy scales');

  const baselinePeriods = Object.keys(verifiedPolicy)
    .map((field) => /^volumeBaseline(\d+)$/.exec(field))
    .filter((match) => match !== null)
    .map((match) => parseInt(match[1], 10))
    .sort((left, right) => left - right);
  const runtime = {
    orchestration: {
      sessionDateThenBarIdentity: verifiedPolicy.rowOrdering
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.rowOrdering,
      futureDataForbidden: verifiedPolicy.futureDataPolicy
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.futureDataPolicy,
      nullWithReason: verifiedPolicy.missingHistoryPolicy
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.missingHistoryPolicy,
      fixedPointBigInt: verifiedPolicy.numericRepresentation
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.numericRepresentation,
    },
    barInputs: { scales },
    volumeParticipation: {
      scales,
      baselinePeriods,
      excludeCurrentFromBaselines: baselinePeriods.every((period) => (
        verifiedPolicy[`volumeBaseline${period}`]
          === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1[`volumeBaseline${period}`]
      )),
      percentileWindow: verifiedPolicy.volumePercentileWindow,
      obvStartsAtZero: verifiedPolicy.obvOrigin
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.obvOrigin,
      obvDeltaPeriods: [...verifiedPolicy.obvDeltaPeriods],
      adLineStartsAtZero: verifiedPolicy.adLineOrigin
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.adLineOrigin,
      adLineDeltaPeriod: verifiedPolicy.adLineDeltaPeriod,
      flatRangeUsesZeroMoneyFlow: verifiedPolicy.flatRangeMoneyFlowConvention
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.flatRangeMoneyFlowConvention,
      mfiPeriod: verifiedPolicy.mfiPeriod,
      cmfPeriod: verifiedPolicy.cmfPeriod,
      priceVolumeComparisonPeriod: verifiedPolicy.priceVolumeComparisonPeriod,
    },
    eodVolumeWeightedPrices: {
      scales,
      rollingPeriods: [...verifiedPolicy.rollingEodVwapPeriods],
      dailyOhlcvApproximationOnly: verifiedPolicy.eodVwapBasis
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.eodVwapBasis,
      anchorActivatesAtConfirmationWithKnownPivotBars: verifiedPolicy.anchoredEodVwapActivation
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.anchoredEodVwapActivation,
    },
    pivots: {
      scales,
      radius: verifiedPolicy.pivotRadius,
      confirmationDelay: verifiedPolicy.pivotConfirmationDelay,
      strictNoPlateau: verifiedPolicy.pivotTiePolicy
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.pivotTiePolicy,
      swingLowFirst: verifiedPolicy.pivotSameSessionOrder
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.pivotSameSessionOrder,
      keepExtremeThenMostRecentlyConfirmed: verifiedPolicy.pivotStreamCompression
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.pivotStreamCompression,
    },
    supportResistance: {
      scales,
      structureLookback: verifiedPolicy.structureLookback,
      touchLookback: verifiedPolicy.levelTouchLookback,
      mostRecentlyConfirmedTieBreak: verifiedPolicy.levelTieBreak
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.levelTieBreak,
      priceTolerance: canonicalFixedToRatio(verifiedPolicy.levelTolerancePricePct, 'levelTolerancePricePct'),
      atrTolerance: canonicalFixedToRatio(
        verifiedPolicy.levelToleranceAtrMultiplier, 'levelToleranceAtrMultiplier',
      ),
      useMaximumTolerance: verifiedPolicy.levelToleranceCombination
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.levelToleranceCombination,
    },
    gapsBreakouts: {
      scales,
      volumeThreshold: canonicalFixedToRatio(
        verifiedPolicy.breakoutVolumeThreshold, 'breakoutVolumeThreshold',
      ),
      failedEventWindow: verifiedPolicy.failedBreakoutObservationWindow,
      openGapLookback: verifiedPolicy.openGapLookback,
      excludeGapsStraddlingClose: verifiedPolicy.openGapSidePolicy
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.openGapSidePolicy,
      nearestBoundaryThenMostRecentTieBreak: verifiedPolicy.openGapTieBreak
        === MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1.openGapTieBreak,
    },
    congestion: {
      scales,
      window: verifiedPolicy.congestionWindow,
      referenceWindow: verifiedPolicy.congestionReferenceWindow,
      efficiencyThreshold: canonicalFixedToRatio(
        verifiedPolicy.congestionEfficiencyThreshold, 'congestionEfficiencyThreshold',
      ),
      atrMultiplier: canonicalFixedToRatio(
        verifiedPolicy.congestionAtrMultiplier, 'congestionAtrMultiplier',
      ),
    },
    fibonacci: {
      scales,
      ratios: verifiedPolicy.fibonacciRatios.map((ratio, index) => ({
        suffix: ratio.atoms,
        ...canonicalFixedToRatio(ratio, `fibonacciRatios[${index}]`),
      })),
    },
  };
  for (const [name, section] of Object.entries(runtime)) {
    if (name === 'orchestration') continue;
    assertMarketVolumeStructureRuntimeSectionV1(section, name);
  }
  for (const [name, enabled] of Object.entries(runtime.orchestration)) requiredTrue(enabled, name);
  return deepFreeze(runtime);
}

export const MARKET_VOLUME_STRUCTURE_RUNTIME_POLICY_V1 =
  deriveMarketVolumeStructureRuntimePolicyV1({
    schemaVersion: POLICY_SCHEMA_VERSION,
    ...MARKET_VOLUME_STRUCTURE_FEATURE_POLICY_VALUES_V1,
  });
