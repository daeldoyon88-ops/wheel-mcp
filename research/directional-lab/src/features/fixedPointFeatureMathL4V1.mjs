/** Deterministic fixed-point BigInt primitives for L4A-A authoritative math. */

import { MARKET_TECHNICAL_FEATURE_POLICY_VALUES } from '../contracts/marketTechnicalFeatureComputationL4V1.mjs';

export const FEATURE_CALCULATION_SCALE = MARKET_TECHNICAL_FEATURE_POLICY_VALUES.calculationScale;
export const FEATURE_RATIO_SCALE = MARKET_TECHNICAL_FEATURE_POLICY_VALUES.ratioScale;
export const FEATURE_PRICE_SCALE = MARKET_TECHNICAL_FEATURE_POLICY_VALUES.priceFeatureScale;

const POWERS_OF_TEN = [1n];

/** @param {unknown} scale */
function assertScale(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) {
    throw new RangeError('fixed-point scale must be a safe integer between 0 and 100');
  }
}

/** @param {number} scale */
export function powerOfTen(scale) {
  assertScale(scale);
  while (POWERS_OF_TEN.length <= scale) {
    POWERS_OF_TEN.push(POWERS_OF_TEN[POWERS_OF_TEN.length - 1] * 10n);
  }
  return POWERS_OF_TEN[scale];
}

/** Round numerator / denominator to the nearest integer, ties to even. */
export function divideRoundHalfEven(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator === 0n) {
    throw new RangeError('HALF_EVEN division requires BigInt values and a non-zero denominator');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const quotient = n / d;
  const remainder = n % d;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const twice = absoluteRemainder * 2n;
  if (twice < d) return quotient;
  const direction = n < 0n ? -1n : 1n;
  if (twice > d) return quotient + direction;
  const absoluteQuotient = quotient < 0n ? -quotient : quotient;
  return absoluteQuotient % 2n === 0n ? quotient : quotient + direction;
}

/** @param {bigint} atoms @param {number} fromScale @param {number} toScale */
export function rescaleAtoms(atoms, fromScale, toScale) {
  if (typeof atoms !== 'bigint') throw new TypeError('atoms must be BigInt');
  assertScale(fromScale);
  assertScale(toScale);
  if (fromScale === toScale) return atoms;
  if (fromScale < toScale) return atoms * powerOfTen(toScale - fromScale);
  return divideRoundHalfEven(atoms, powerOfTen(fromScale - toScale));
}

/** @param {unknown} value @param {number} [targetScale] */
export function fixedFromCanonical(value, targetScale = FEATURE_CALCULATION_SCALE) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('fixed-point value must be an object');
  }
  if (typeof value.atoms !== 'string' || !/^-?(?:0|[1-9]\d*)$/.test(value.atoms) || value.atoms === '-0') {
    throw new TypeError('fixed-point atoms must be a canonical integer string');
  }
  assertScale(value.scale);
  assertScale(targetScale);
  return { atoms: rescaleAtoms(BigInt(value.atoms), value.scale, targetScale), scale: targetScale };
}

/** Convert verified L3-I5 atom rows into fixed-point bars without IEEE numerics. */
export function toInternalFeatureBars(rows) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  return rows.map((row) => {
    const priceScale = row.priceScale;
    return {
      source: row,
      open: fixedFromCanonical({ atoms: row.openAtoms, scale: priceScale }),
      high: fixedFromCanonical({ atoms: row.highAtoms, scale: priceScale }),
      low: fixedFromCanonical({ atoms: row.lowAtoms, scale: priceScale }),
      close: fixedFromCanonical({ atoms: row.closeAtoms, scale: priceScale }),
    };
  });
}

/** @param {bigint} atoms @param {number} [scale] */
export function fixedFromScaledAtoms(atoms, scale = FEATURE_CALCULATION_SCALE) {
  if (typeof atoms !== 'bigint') throw new TypeError('atoms must be BigInt');
  assertScale(scale);
  return { atoms, scale };
}

/** @param {bigint} integer @param {number} [scale] */
export function fixedFromInteger(integer, scale = FEATURE_CALCULATION_SCALE) {
  if (typeof integer !== 'bigint') throw new TypeError('integer must be BigInt');
  return { atoms: integer * powerOfTen(scale), scale };
}

/** @param {{atoms: bigint, scale: number}} value @param {number} outputScale */
export function fixedToCanonical(value, outputScale) {
  assertInternalFixed(value);
  assertScale(outputScale);
  const atoms = rescaleAtoms(value.atoms, value.scale, outputScale);
  return { atoms: atoms === 0n ? '0' : atoms.toString(), scale: outputScale };
}

/** @param {unknown} value */
function assertInternalFixed(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || typeof value.atoms !== 'bigint') {
    throw new TypeError('internal fixed-point value is invalid');
  }
  assertScale(value.scale);
}

/** @param {{atoms: bigint, scale: number}} value @param {number} scale */
function atScale(value, scale) {
  assertInternalFixed(value);
  return rescaleAtoms(value.atoms, value.scale, scale);
}

/** @param {{atoms: bigint, scale: number}} left @param {{atoms: bigint, scale: number}} right */
export function addFixed(left, right) {
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return { atoms: atScale(left, scale) + atScale(right, scale), scale };
}

/** @param {{atoms: bigint, scale: number}} left @param {{atoms: bigint, scale: number}} right */
export function subtractFixed(left, right) {
  const scale = left.scale > right.scale ? left.scale : right.scale;
  return { atoms: atScale(left, scale) - atScale(right, scale), scale };
}

/** @param {{atoms: bigint, scale: number}} value */
export function absoluteFixed(value) {
  assertInternalFixed(value);
  return { atoms: value.atoms < 0n ? -value.atoms : value.atoms, scale: value.scale };
}

/** @param {{atoms: bigint, scale: number}} left @param {{atoms: bigint, scale: number}} right */
export function compareFixed(left, right) {
  const scale = left.scale > right.scale ? left.scale : right.scale;
  const a = atScale(left, scale);
  const b = atScale(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {{atoms: bigint, scale: number}} left @param {{atoms: bigint, scale: number}} right @param {number} [scale] */
export function multiplyFixed(left, right, scale = FEATURE_CALCULATION_SCALE) {
  assertInternalFixed(left);
  assertInternalFixed(right);
  const numerator = left.atoms * right.atoms * powerOfTen(scale);
  const denominator = powerOfTen(left.scale + right.scale);
  return { atoms: divideRoundHalfEven(numerator, denominator), scale };
}

/** @param {{atoms: bigint, scale: number}} numerator @param {{atoms: bigint, scale: number}} denominator @param {number} [scale] */
export function divideFixed(numerator, denominator, scale = FEATURE_CALCULATION_SCALE) {
  assertInternalFixed(numerator);
  assertInternalFixed(denominator);
  if (denominator.atoms === 0n) throw new RangeError('fixed-point division by zero');
  const n = numerator.atoms * powerOfTen(denominator.scale + scale);
  const d = denominator.atoms * powerOfTen(numerator.scale);
  return { atoms: divideRoundHalfEven(n, d), scale };
}

/** @param {{atoms: bigint, scale: number}} value @param {bigint} numerator @param {bigint} denominator */
export function multiplyByRatio(value, numerator, denominator) {
  assertInternalFixed(value);
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator === 0n) {
    throw new RangeError('ratio must use BigInt values and a non-zero denominator');
  }
  return {
    atoms: divideRoundHalfEven(value.atoms * numerator, denominator),
    scale: value.scale,
  };
}

/** @param {Array<{atoms: bigint, scale: number}>} values @param {number} [scale] */
export function averageFixed(values, scale = FEATURE_CALCULATION_SCALE) {
  if (!Array.isArray(values) || values.length === 0) throw new RangeError('average requires values');
  const sum = values.reduce((total, value) => total + atScale(value, scale), 0n);
  return { atoms: divideRoundHalfEven(sum, BigInt(values.length)), scale };
}

/** Deterministic floor square root for a non-negative BigInt. */
export function integerSquareRoot(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new RangeError('integer square root requires non-negative BigInt');
  if (value < 2n) return value;
  let current = 1n << (BigInt(value.toString(2).length) + 1n) / 2n;
  while (true) {
    const next = (current + value / current) / 2n;
    if (next >= current) return current;
    current = next;
  }
}

/** Square root rounded HALF_EVEN at the requested output scale. */
export function squareRootFixed(value, outputScale = FEATURE_CALCULATION_SCALE) {
  assertInternalFixed(value);
  if (value.atoms < 0n) throw new RangeError('fixed-point square root requires a non-negative value');
  assertScale(outputScale);
  const exponent = 2 * outputScale - value.scale;
  let radicand;
  let divisor = 1n;
  if (exponent >= 0) radicand = value.atoms * powerOfTen(exponent);
  else {
    divisor = powerOfTen(-exponent);
    radicand = divideRoundHalfEven(value.atoms, divisor);
  }
  const lower = integerSquareRoot(radicand);
  const upper = lower + 1n;
  const lowerDistance = radicand - lower * lower;
  const upperDistance = upper * upper - radicand;
  let rounded = lower;
  if (upperDistance < lowerDistance || (upperDistance === lowerDistance && lower % 2n !== 0n)) rounded = upper;
  return { atoms: rounded, scale: outputScale };
}

/** close / reference - 1, at calculation scale. */
export function ratioChangeFixed(close, reference, scale = FEATURE_CALCULATION_SCALE) {
  const ratio = divideFixed(close, reference, scale);
  return subtractFixed(ratio, fixedFromInteger(1n, ratio.scale));
}

/** @param {unknown} availability */
export function unavailableCell(availability) {
  return { value: null, availability };
}

/** @param {{atoms: bigint, scale: number}} value @param {number} [scale] */
export function availableFixedCell(value, scale = FEATURE_RATIO_SCALE) {
  return { value: fixedToCanonical(value, scale), availability: 'AVAILABLE' };
}

/** @param {number|boolean} value */
export function availableScalarCell(value) {
  return { value, availability: 'AVAILABLE' };
}

/** @param {{atoms: bigint, scale: number}} previous @param {{atoms: bigint, scale: number}} current @param {number} period */
export function wilderStep(previous, current, period) {
  const scale = previous.scale > current.scale ? previous.scale : current.scale;
  const numerator = atScale(previous, scale) * BigInt(period - 1) + atScale(current, scale);
  return { atoms: divideRoundHalfEven(numerator, BigInt(period)), scale };
}

/** @param {{atoms: bigint, scale: number}} previous @param {{atoms: bigint, scale: number}} current @param {number} period */
export function emaStep(previous, current, period) {
  const scale = previous.scale > current.scale ? previous.scale : current.scale;
  const numerator = atScale(previous, scale) * BigInt(period - 1) + atScale(current, scale) * 2n;
  return { atoms: divideRoundHalfEven(numerator, BigInt(period + 1)), scale };
}

/** Fixed-window SMA; a full admissible window is required. */
export function simpleMovingAverageSeries(values, period) {
  if (!Array.isArray(values) || !Number.isSafeInteger(period) || period <= 0) {
    throw new RangeError('SMA requires an array and a positive period');
  }
  const output = values.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  let sum = 0n;
  let missing = 0;
  for (let index = 0; index < values.length; index += 1) {
    const incoming = values[index];
    if (incoming === null) missing += 1;
    else sum += atScale(incoming, FEATURE_CALCULATION_SCALE);
    if (index >= period) {
      const outgoing = values[index - period];
      if (outgoing === null) missing -= 1;
      else sum -= atScale(outgoing, FEATURE_CALCULATION_SCALE);
    }
    if (index + 1 < period) continue;
    if (missing > 0) output[index] = { value: null, availability: 'MISSING_INPUT' };
    else output[index] = {
      value: {
        atoms: divideRoundHalfEven(sum, BigInt(period)),
        scale: FEATURE_CALCULATION_SCALE,
      },
      availability: 'AVAILABLE',
    };
  }
  return output;
}

/** EMA seeded only by the complete SMA of its first period. */
export function exponentialMovingAverageSeries(values, period) {
  if (!Array.isArray(values) || !Number.isSafeInteger(period) || period <= 0) {
    throw new RangeError('EMA requires an array and a positive period');
  }
  const output = values.map(() => ({ value: null, availability: 'INSUFFICIENT_HISTORY' }));
  if (values.length < period) return output;
  const seedValues = values.slice(0, period);
  if (seedValues.some((value) => value === null)) {
    for (let index = period - 1; index < values.length; index += 1) {
      output[index] = { value: null, availability: 'MISSING_INPUT' };
    }
    return output;
  }
  let previous = averageFixed(seedValues);
  output[period - 1] = { value: previous, availability: 'AVAILABLE' };
  for (let index = period; index < values.length; index += 1) {
    if (values[index] === null) {
      output[index] = { value: null, availability: 'MISSING_INPUT' };
      previous = null;
      continue;
    }
    if (previous === null) {
      output[index] = { value: null, availability: 'MISSING_INPUT' };
      continue;
    }
    previous = emaStep(previous, values[index], period);
    output[index] = { value: previous, availability: 'AVAILABLE' };
  }
  return output;
}
