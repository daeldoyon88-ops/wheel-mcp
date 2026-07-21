/**
 * Independent L4A-B fixed-point oracle.
 *
 * Zero module dependencies. Mathematical reference only — used by adversarial
 * tests to cross-check production HALF_EVEN without sharing its
 * remainder-doubling branch shape.
 *
 * Isolation is enforced by the companion source-policy guard. That guard is
 * conservative for realistic repository loaders; it does not claim that every
 * Turing-complete obfuscation is undetectable.
 */

/** @param {unknown} scale */
export function independentPowerOfTen(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0) {
    throw new RangeError('invalid independent scale');
  }
  let value = 1n;
  for (let index = 0; index < scale; index += 1) value *= 10n;
  return value;
}

/**
 * Absolute nearest-candidate distances + even tie.
 * Structurally distinct from production remainder-doubling comparison.
 * @param {bigint} numerator
 * @param {bigint} denominator
 */
export function referenceNearestEvenQuotient(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator === 0n) {
    throw new RangeError('reference nearest-even quotient requires BigInt and a non-zero denominator');
  }
  const resultIsNegative = (numerator < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const lowerCandidate = absoluteNumerator / absoluteDenominator;
  const upperCandidate = lowerCandidate + 1n;
  const distanceToLower = absoluteNumerator - lowerCandidate * absoluteDenominator;
  const distanceToUpper = upperCandidate * absoluteDenominator - absoluteNumerator;
  let absoluteChosen;
  if (distanceToLower < distanceToUpper) absoluteChosen = lowerCandidate;
  else if (distanceToUpper < distanceToLower) absoluteChosen = upperCandidate;
  else absoluteChosen = (lowerCandidate % 2n === 0n) ? lowerCandidate : upperCandidate;
  return resultIsNegative ? -absoluteChosen : absoluteChosen;
}

/** @param {bigint} atoms @param {number} fromScale @param {number} toScale */
export function independentRescale(atoms, fromScale, toScale) {
  if (fromScale === toScale) return atoms;
  if (fromScale < toScale) return atoms * independentPowerOfTen(toScale - fromScale);
  return referenceNearestEvenQuotient(atoms, independentPowerOfTen(fromScale - toScale));
}

/** @param {{ atoms: bigint, scale: number }} value @param {number} outputScale */
export function independentFixedToCanonical(value, outputScale) {
  const atoms = independentRescale(value.atoms, value.scale, outputScale);
  return { atoms: atoms === 0n ? '0' : atoms.toString(), scale: outputScale };
}

/** @param {bigint} atoms24 */
export function independentTo12(atoms24) {
  return independentFixedToCanonical({ atoms: atoms24, scale: 24 }, 12).atoms;
}

/**
 * 64 manual literal vectors. Expected values are literals, never computed via
 * production helpers or policy constants.
 * @type {ReadonlyArray<readonly [string, () => unknown, unknown]>}
 */
export const INDEPENDENT_FIXED_POINT_MANUAL_VECTORS_L4V1 = Object.freeze([
  ['tie_even_positive', () => referenceNearestEvenQuotient(5n, 2n), 2n],
  ['tie_odd_positive', () => referenceNearestEvenQuotient(3n, 2n), 2n],
  ['tie_even_negative', () => referenceNearestEvenQuotient(-5n, 2n), -2n],
  ['tie_odd_negative', () => referenceNearestEvenQuotient(-3n, 2n), -2n],
  ['zero', () => referenceNearestEvenQuotient(0n, 7n), 0n],
  ['exact_positive', () => referenceNearestEvenQuotient(12n, 3n), 4n],
  ['exact_negative', () => referenceNearestEvenQuotient(-12n, 3n), -4n],
  ['below_half_positive', () => referenceNearestEvenQuotient(7n, 3n), 2n],
  ['above_half_positive', () => referenceNearestEvenQuotient(8n, 3n), 3n],
  ['below_half_negative', () => referenceNearestEvenQuotient(-7n, 3n), -2n],
  ['above_half_negative', () => referenceNearestEvenQuotient(-8n, 3n), -3n],
  ['negative_denominator', () => referenceNearestEvenQuotient(3n, -2n), -2n],
  ['both_negative', () => referenceNearestEvenQuotient(-3n, -2n), 2n],
  ['scale_up', () => independentRescale(123n, 2, 5), 123000n],
  ['scale_down_exact', () => independentRescale(123000n, 5, 2), 123n],
  ['scale_down_tie_even', () => independentRescale(1250n, 3, 1), 12n],
  ['scale_down_tie_odd', () => independentRescale(1350n, 3, 1), 14n],
  ['scale_down_negative_tie_even', () => independentRescale(-1250n, 3, 1), -12n],
  ['scale_down_negative_tie_odd', () => independentRescale(-1350n, 3, 1), -14n],
  ['power_zero', () => independentPowerOfTen(0), 1n],
  ['power_twelve', () => independentPowerOfTen(12), 1000000000000n],
  ['power_twenty_four', () => independentPowerOfTen(24), 1000000000000000000000000n],
  ['large_exact', () => referenceNearestEvenQuotient(999999999999999999999999999999n, 3n), 333333333333333333333333333333n],
  ['large_above_half', () => referenceNearestEvenQuotient(1000000000000000000000000000001n, 3n), 333333333333333333333333333334n],
  ['fib_236', () => referenceNearestEvenQuotient(1000n * 236n, 1000n), 236n],
  ['fib_382', () => referenceNearestEvenQuotient(1000n * 382n, 1000n), 382n],
  ['fib_500', () => referenceNearestEvenQuotient(1000n * 500n, 1000n), 500n],
  ['fib_618', () => referenceNearestEvenQuotient(1000n * 618n, 1000n), 618n],
  ['fib_786', () => referenceNearestEvenQuotient(1000n * 786n, 1000n), 786n],
  ['threshold_5_1000', () => referenceNearestEvenQuotient(1000n * 5n, 1000n), 5n],
  ['threshold_25_100', () => referenceNearestEvenQuotient(100n * 25n, 100n), 25n],
  ['threshold_15_10', () => referenceNearestEvenQuotient(10n * 15n, 10n), 15n],
  ['threshold_30_100', () => referenceNearestEvenQuotient(100n * 30n, 100n), 30n],
  ['ratio_4_1', () => referenceNearestEvenQuotient(4n, 1n), 4n],
  ['ratio_236_1000', () => referenceNearestEvenQuotient(236n, 1000n), 0n],
  ['ratio_382_1000', () => referenceNearestEvenQuotient(382n, 1000n), 0n],
  ['ratio_500_1000', () => referenceNearestEvenQuotient(500n, 1000n), 0n],
  ['ratio_618_1000', () => referenceNearestEvenQuotient(618n, 1000n), 1n],
  ['ratio_786_1000', () => referenceNearestEvenQuotient(786n, 1000n), 1n],
  ['exact_one', () => referenceNearestEvenQuotient(100n, 100n), 1n],
  ['below_half_small', () => referenceNearestEvenQuotient(1n, 4n), 0n],
  ['above_half_small', () => referenceNearestEvenQuotient(3n, 4n), 1n],
  ['tie_to_even_zero', () => referenceNearestEvenQuotient(1n, 2n), 0n],
  ['tie_to_even_two', () => referenceNearestEvenQuotient(5n, 2n), 2n],
  ['tie_to_even_neg_zero', () => referenceNearestEvenQuotient(-1n, 2n), 0n],
  ['large_below_half', () => referenceNearestEvenQuotient(1000000000000000000000000000000n, 3n), 333333333333333333333333333333n],
  ['scale_preserve', () => independentRescale(42n, 7, 7), 42n],
  ['scale_up_zero', () => independentRescale(0n, 0, 12), 0n],
  ['scale_down_below_half', () => independentRescale(1249n, 3, 1), 12n],
  ['scale_down_above_half', () => independentRescale(1260n, 3, 1), 13n],
  ['canonical_zero', () => independentFixedToCanonical({ atoms: 0n, scale: 24 }, 12).atoms, '0'],
  ['canonical_positive', () => independentFixedToCanonical({ atoms: 1234500000000000n, scale: 15 }, 12).atoms, '1234500000000'],
  ['canonical_negative', () => independentFixedToCanonical({ atoms: -1234500000000000n, scale: 15 }, 12).atoms, '-1234500000000'],
  ['to12_exact', () => independentTo12(123456789012n * independentPowerOfTen(12)), '123456789012'],
  ['to12_tie_even', () => independentTo12(125n * independentPowerOfTen(11)), '12'],
  ['to12_tie_odd', () => independentTo12(135n * independentPowerOfTen(11)), '14'],
  ['denom_neg_exact', () => referenceNearestEvenQuotient(9n, -3n), -3n],
  ['num_zero_neg_den', () => referenceNearestEvenQuotient(0n, -5n), 0n],
  ['near_half_pos', () => referenceNearestEvenQuotient(10n, 6n), 2n],
  ['near_half_neg', () => referenceNearestEvenQuotient(-10n, 6n), -2n],
  ['big_tie_even', () => referenceNearestEvenQuotient(1000000000000000000000000000005n, 2n), 500000000000000000000000000002n],
  ['big_tie_odd', () => referenceNearestEvenQuotient(1000000000000000000000000000003n, 2n), 500000000000000000000000000002n],
  ['fib_scale_236', () => independentRescale(236n, 3, 3), 236n],
  ['fib_scale_786', () => independentRescale(786n, 3, 0), 1n],
]);
