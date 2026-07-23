/**
 * L4B-F2 canonical fixed-point ratio and calendar arithmetic. Authority math is
 * the audited BigInt HALF_EVEN primitive from fixedPointFeatureMathL4V1; this
 * module only pins the F2 output scale, the fail-closed division-by-zero code,
 * the canonical zero/sign representation and the closed month/week arithmetic.
 * No float authority, no Number rounding, no wall clock, no timezone.
 */

import { MarketDataL3Error } from '../contracts/marketDataL3CommonV1.mjs';
import { normalizeMacroFixedPointValueV1 } from '../contracts/macroIngestionContractsL4BV1.mjs';
import {
  addFixed,
  divideRoundHalfEven,
  fixedFromCanonical,
  fixedToCanonical,
  ratioChangeFixed,
  subtractFixed,
} from '../features/fixedPointFeatureMathL4V1.mjs';

/** Closed F2 output scale for every derived ratio (MoM, YoY, their changes). */
export const MACRO_F2_RATIO_SCALE = 6;
/** Closed rounding mode label pinned by the F2 policy. */
export const MACRO_F2_ROUNDING_MODE = 'HALF_EVEN';

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** @param {unknown} value @param {string} label */
function canonical(value, label, code) {
  try {
    return normalizeMacroFixedPointValueV1(value, label);
  } catch (cause) {
    throw new MarketDataL3Error(code, `${label} is not a canonical fixed-point value`, { cause });
  }
}

/**
 * (numerator / denominator) - 1 at the closed F2 ratio scale, HALF_EVEN.
 * Division by zero is fail-closed. Inputs are canonical fixed-point at their own
 * scales; the result carries no -0 and is re-validated as canonical wire.
 * @param {unknown} numeratorCanonical @param {unknown} denominatorCanonical
 * @param {string} code @param {number} [outputScale]
 */
export function macroRatioChangeFixed(numeratorCanonical, denominatorCanonical, code,
  outputScale = MACRO_F2_RATIO_SCALE) {
  if (outputScale !== MACRO_F2_RATIO_SCALE) {
    throw new MarketDataL3Error(code,
      `ratio output scale must equal closed F2 scale ${MACRO_F2_RATIO_SCALE}`);
  }
  const numerator = canonical(numeratorCanonical, 'ratio.numerator', code);
  const denominator = canonical(denominatorCanonical, 'ratio.denominator', code);
  if (denominator.atoms === '0') {
    throw new MarketDataL3Error(code, 'ratio denominator is zero');
  }
  const internal = ratioChangeFixed(
    fixedFromCanonical(numerator, numerator.scale),
    fixedFromCanonical(denominator, denominator.scale),
    outputScale,
  );
  return normalizeMacroFixedPointValueV1(fixedToCanonical(internal, outputScale), 'ratio.result');
}

/**
 * Nominal difference left - right as canonical fixed-point at the wider input
 * scale (percentage points for UNRATE, level for claims). No -0.
 * @param {unknown} leftCanonical @param {unknown} rightCanonical @param {string} code
 */
export function macroNominalDeltaFixed(leftCanonical, rightCanonical, code) {
  const left = canonical(leftCanonical, 'delta.left', code);
  const right = canonical(rightCanonical, 'delta.right', code);
  const internal = subtractFixed(
    fixedFromCanonical(left, left.scale),
    fixedFromCanonical(right, right.scale),
  );
  return normalizeMacroFixedPointValueV1(fixedToCanonical(internal, internal.scale), 'delta.result');
}

/**
 * Deterministic mean of exactly `expectedCount` canonical values at a closed
 * output scale, HALF_EVEN. The caller pins the consecutive window; this never
 * averages a short window.
 * @param {unknown[]} values @param {number} expectedCount @param {number} outputScale @param {string} code
 */
export function macroWindowAverageFixed(values, expectedCount, outputScale, code) {
  if (!Array.isArray(values) || values.length !== expectedCount) {
    throw new MarketDataL3Error(code, `window average requires exactly ${expectedCount} values`);
  }
  let sum = { atoms: 0n, scale: outputScale };
  for (const value of values) {
    const item = canonical(value, 'average.value', code);
    sum = addFixed(sum, fixedFromCanonical(item, item.scale));
  }
  const atScale = fixedFromCanonical(fixedToCanonical(sum, outputScale), outputScale);
  const mean = { atoms: divideRoundHalfEven(atScale.atoms, BigInt(expectedCount)), scale: outputScale };
  return normalizeMacroFixedPointValueV1(fixedToCanonical(mean, outputScale), 'average.result');
}

/** -1, 0 or +1 from a canonical fixed-point value (canonical zero is '0'). */
export function macroFixedSign(canonicalValue) {
  if (canonicalValue === null) return null;
  const value = normalizeMacroFixedPointValueV1(canonicalValue, 'sign.value');
  if (value.atoms === '0') return 0;
  return value.atoms.startsWith('-') ? -1 : 1;
}

/** left < right ? -1 : left > right ? 1 : 0 on canonical fixed-point. */
export function macroCompareCanonical(leftCanonical, rightCanonical) {
  const left = normalizeMacroFixedPointValueV1(leftCanonical, 'compare.left');
  const right = normalizeMacroFixedPointValueV1(rightCanonical, 'compare.right');
  const scale = left.scale > right.scale ? left.scale : right.scale;
  const a = fixedFromCanonical(left, scale).atoms;
  const b = fixedFromCanonical(right, scale).atoms;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {string} monthKey @param {string} label */
export function assertMonthKey(monthKey, label = 'monthKey') {
  if (typeof monthKey !== 'string' || !MONTH_KEY_PATTERN.test(monthKey)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_CPI_PERIOD_GAP',
      `${label} must be a closed YYYY-MM month key`);
  }
}

/** Add a signed month delta to a YYYY-MM key, returning a YYYY-MM key. */
export function addMonthsToMonthKey(monthKey, delta) {
  assertMonthKey(monthKey);
  if (!Number.isSafeInteger(delta)) {
    throw new MarketDataL3Error('MARKET_DATA_MACRO_CPI_PERIOD_GAP', 'month delta must be a safe integer');
  }
  const year = Number(monthKey.slice(0, 4));
  const month = Number(monthKey.slice(5, 7));
  const total = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = total - newYear * 12;
  return `${String(newYear).padStart(4, '0')}-${String(newMonth + 1).padStart(2, '0')}`;
}

/** Signed whole-month distance from `from` to `to` (to - from). */
export function monthsBetweenMonthKeys(from, to) {
  assertMonthKey(from, 'from');
  assertMonthKey(to, 'to');
  const fromIndex = Number(from.slice(0, 4)) * 12 + (Number(from.slice(5, 7)) - 1);
  const toIndex = Number(to.slice(0, 4)) * 12 + (Number(to.slice(5, 7)) - 1);
  return toIndex - fromIndex;
}
