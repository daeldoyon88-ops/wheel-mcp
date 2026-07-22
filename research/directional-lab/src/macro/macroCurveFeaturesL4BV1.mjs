/**
 * L4B-F1 curve spreads, shape classification and steepening/flattening.
 */

import {
  MarketDataL3Error,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  F1_SPREAD_DEFINITIONS,
} from '../contracts/macroFeatureContractsL4BV1.mjs';
import {
  absoluteFixed,
  compareFixed,
  fixedFromCanonical,
  fixedToCanonical,
  subtractFixed,
} from '../features/fixedPointFeatureMathL4V1.mjs';

function resolutionByCode(orderedResolutions, code) {
  return orderedResolutions.find((row) => row.canonicalSeriesCode === code) ?? null;
}

function spreadComponentUsable(resolution) {
  return resolution
    && resolution.availabilityStatus === 'AVAILABLE'
    && resolution.value !== null
    && resolution.macroSeriesIdentityId !== null
    && resolution.macroVintageIdentityId !== null
    && resolution.availableAt !== null;
}

function componentClass(spreadValue, flatThreshold, inversionThreshold) {
  const value = fixedFromCanonical(spreadValue, spreadValue.scale);
  const flat = fixedFromCanonical(flatThreshold, flatThreshold.scale);
  const inv = fixedFromCanonical(inversionThreshold, inversionThreshold.scale);
  if (compareFixed(absoluteFixed(value), flat) <= 0) return 'FLAT';
  if (compareFixed(value, inv) <= 0) return 'INVERTED';
  if (compareFixed(value, flat) > 0) return 'NORMAL';
  return 'MIXED';
}

function classifyCurveShape(requiredStatuses, partialCurvePolicy) {
  const available = requiredStatuses.filter((status) => status !== null);
  if (available.length === 0) return 'NOT_AVAILABLE';
  if (available.length < requiredStatuses.length
      && partialCurvePolicy !== 'CLASSIFY_FROM_AVAILABLE_REQUIRED_SPREADS') {
    return 'NOT_AVAILABLE';
  }
  const unique = [...new Set(available)];
  if (unique.length === 1) {
    if (unique[0] === 'FLAT') return 'FLAT';
    if (unique[0] === 'NORMAL') return 'NORMAL';
    if (unique[0] === 'INVERTED') return 'INVERTED';
    return 'MIXED';
  }
  if (unique.includes('INVERTED') && unique.includes('NORMAL')) return 'PARTIALLY_INVERTED';
  if (unique.includes('INVERTED') && unique.includes('FLAT')) return 'PARTIALLY_INVERTED';
  if (unique.includes('NORMAL') && unique.includes('FLAT')) return 'MIXED';
  return 'MIXED';
}

function classifyCurveDirection(change10y2y, change10y3m) {
  if (change10y2y === null && change10y3m === null) return 'NOT_AVAILABLE';
  const signs = [];
  for (const change of [change10y2y, change10y3m]) {
    if (change === null) continue;
    const atoms = fixedFromCanonical(change, change.scale).atoms;
    if (atoms > 0n) signs.push('STEEPENING');
    else if (atoms < 0n) signs.push('FLATTENING');
    else signs.push('UNCHANGED');
  }
  if (signs.length === 0) return 'NOT_AVAILABLE';
  const unique = [...new Set(signs)];
  if (unique.length === 1) return unique[0];
  if (unique.includes('STEEPENING') && unique.includes('FLATTENING')) return 'MIXED';
  if (unique.includes('STEEPENING')) return 'STEEPENING';
  if (unique.includes('FLATTENING')) return 'FLATTENING';
  return 'UNCHANGED';
}

/**
 * @param {object} input
 */
export function computeCurveState(input) {
  const { orderedResolutions, policy, previousCurveState = null, scale } = input;
  const rateScale = scale ?? policy.rateFeatureScale;
  const orderedSpreads = [];

  for (const definition of policy.orderedSpreadDefinitions) {
    const left = resolutionByCode(orderedResolutions, definition.left);
    const right = resolutionByCode(orderedResolutions, definition.right);
    if (!spreadComponentUsable(left) || !spreadComponentUsable(right)) {
      if ((left && left.availabilityStatus === 'STALE')
          || (right && right.availabilityStatus === 'STALE')) {
        // Explicit refusal of STALE components for spreads.
      }
      orderedSpreads.push({
        spreadCode: definition.spreadCode,
        value: null,
        availabilityStatus: (!left || left.availabilityStatus === 'SERIES_NOT_IN_BINDING'
          || !right || right.availabilityStatus === 'SERIES_NOT_IN_BINDING')
          ? 'SERIES_NOT_IN_BINDING'
          : (!left || left.availabilityStatus === 'WITHDRAWN'
            || !right || right.availabilityStatus === 'WITHDRAWN')
            ? 'WITHDRAWN'
            : (!left || left.availabilityStatus === 'STALE'
              || !right || right.availabilityStatus === 'STALE')
              ? 'STALE'
              : 'NOT_AVAILABLE',
        sourceLeftSeriesIdentityId: left?.macroSeriesIdentityId ?? null,
        sourceRightSeriesIdentityId: right?.macroSeriesIdentityId ?? null,
        leftVintageIdentityId: left?.macroVintageIdentityId ?? null,
        rightVintageIdentityId: right?.macroVintageIdentityId ?? null,
        effectiveAvailableAt: null,
        ageSessions: Math.max(left?.carryForwardAgeSessions ?? 0, right?.carryForwardAgeSessions ?? 0),
      });
      continue;
    }
    if (left.value.scale !== right.value.scale && left.value.scale !== rateScale
        && right.value.scale !== rateScale) {
      // Align via policy scale.
    }
    const leftFixed = fixedFromCanonical(left.value, rateScale);
    const rightFixed = fixedFromCanonical(right.value, rateScale);
    const value = fixedToCanonical(subtractFixed(leftFixed, rightFixed), rateScale);
    const effectiveAvailableAt = left.availableAt >= right.availableAt
      ? left.availableAt
      : right.availableAt;
    orderedSpreads.push({
      spreadCode: definition.spreadCode,
      value,
      availabilityStatus: 'AVAILABLE',
      sourceLeftSeriesIdentityId: left.macroSeriesIdentityId,
      sourceRightSeriesIdentityId: right.macroSeriesIdentityId,
      leftVintageIdentityId: left.macroVintageIdentityId,
      rightVintageIdentityId: right.macroVintageIdentityId,
      effectiveAvailableAt,
      ageSessions: Math.max(left.carryForwardAgeSessions, right.carryForwardAgeSessions),
    });
  }

  // Ensure policy order matches closed definitions.
  for (let index = 0; index < F1_SPREAD_DEFINITIONS.length; index += 1) {
    if (orderedSpreads[index].spreadCode !== F1_SPREAD_DEFINITIONS[index].spreadCode) {
      throw new MarketDataL3Error('MARKET_DATA_MACRO_CURVE_CLASSIFICATION_INVALID',
        'spread order diverges from closed policy definitions');
    }
  }

  const byCode = new Map(orderedSpreads.map((spread) => [spread.spreadCode, spread]));
  const requiredStatuses = policy.curveShapePolicy.requiredSpreadCodes.map((spreadCode) => {
    const spread = byCode.get(spreadCode);
    if (!spread || spread.availabilityStatus !== 'AVAILABLE' || spread.value === null) return null;
    return componentClass(
      spread.value,
      policy.curveShapePolicy.flatThreshold,
      policy.curveShapePolicy.inversionThreshold,
    );
  });
  const curveShape = classifyCurveShape(
    requiredStatuses, policy.curveShapePolicy.partialCurvePolicy,
  );

  const spread10y2y = byCode.get('SPREAD_10Y_2Y');
  const spread10y3m = byCode.get('SPREAD_10Y_3M');
  const prev10y2y = previousCurveState?.orderedSpreads
    ?.find((spread) => spread.spreadCode === 'SPREAD_10Y_2Y') ?? null;
  const prev10y3m = previousCurveState?.orderedSpreads
    ?.find((spread) => spread.spreadCode === 'SPREAD_10Y_3M') ?? null;

  const curveChange10y2y = (spread10y2y?.availabilityStatus === 'AVAILABLE'
    && prev10y2y?.availabilityStatus === 'AVAILABLE'
    && spread10y2y.value && prev10y2y.value)
    ? fixedToCanonical(
      subtractFixed(
        fixedFromCanonical(spread10y2y.value, rateScale),
        fixedFromCanonical(prev10y2y.value, rateScale),
      ),
      rateScale,
    )
    : null;
  const curveChange10y3m = (spread10y3m?.availabilityStatus === 'AVAILABLE'
    && prev10y3m?.availabilityStatus === 'AVAILABLE'
    && spread10y3m.value && prev10y3m.value)
    ? fixedToCanonical(
      subtractFixed(
        fixedFromCanonical(spread10y3m.value, rateScale),
        fixedFromCanonical(prev10y3m.value, rateScale),
      ),
      rateScale,
    )
    : null;

  const curveDirection = previousCurveState === null
    ? 'NOT_AVAILABLE'
    : classifyCurveDirection(curveChange10y2y, curveChange10y3m);

  let sessionsSinceCurveDirectionChange = null;
  if (previousCurveState === null) {
    sessionsSinceCurveDirectionChange = curveDirection === 'NOT_AVAILABLE' ? null : 0;
  } else if (curveDirection === 'NOT_AVAILABLE') {
    sessionsSinceCurveDirectionChange = null;
  } else if (curveDirection === previousCurveState.curveDirection
      || previousCurveState.curveDirection === 'NOT_AVAILABLE') {
    sessionsSinceCurveDirectionChange = previousCurveState.sessionsSinceCurveDirectionChange === null
      ? 0
      : previousCurveState.sessionsSinceCurveDirectionChange + (
        curveDirection === previousCurveState.curveDirection ? 1 : 0
      );
    if (curveDirection !== previousCurveState.curveDirection
        && previousCurveState.curveDirection !== 'NOT_AVAILABLE') {
      sessionsSinceCurveDirectionChange = 0;
    }
  } else {
    sessionsSinceCurveDirectionChange = 0;
  }

  return {
    orderedSpreads,
    curveShape,
    curveDirection,
    curveChange10y2y,
    curveChange10y3m,
    sessionsSinceCurveDirectionChange,
    curveRegime: curveShape,
  };
}
