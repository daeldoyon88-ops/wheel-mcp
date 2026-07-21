/** Independent L4A-C1 oracle: no imports from seasonality or fixed-point modules. */

import { createHash } from 'node:crypto';

function pow10(scale) {
  let value = 1n;
  for (let index = 0; index < scale; index += 1) value *= 10n;
  return value;
}

export function oracleHalfEven(numerator, denominator) {
  if (denominator === 0n) throw new RangeError('zero denominator');
  let n = numerator;
  let d = denominator;
  if (d < 0n) { n = -n; d = -d; }
  const quotient = n / d;
  const remainder = n % d;
  const magnitude = remainder < 0n ? -remainder : remainder;
  if (magnitude * 2n < d) return quotient;
  const direction = n < 0n ? -1n : 1n;
  if (magnitude * 2n > d) return quotient + direction;
  const absolute = quotient < 0n ? -quotient : quotient;
  return absolute % 2n === 0n ? quotient : quotient + direction;
}

export function oracleReturnAtoms(closeStart, closeEnd, scale = 12) {
  if (closeStart === 0n) throw new RangeError('zero denominator');
  return oracleHalfEven(closeEnd * pow10(scale), closeStart) - pow10(scale);
}

export function oracleMeanAtoms(values) {
  if (values.length === 0) return null;
  return oracleHalfEven(values.reduce((sum, value) => sum + value, 0n), BigInt(values.length));
}

export function oracleMedianAtoms(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : oracleHalfEven(sorted[middle - 1] + sorted[middle], 2n);
}

export function oracleQuantileAtoms(values, numerator, denominator) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const position = BigInt(sorted.length - 1) * numerator;
  const lower = Number(position / denominator);
  const remainder = position % denominator;
  if (remainder === 0n) return sorted[lower];
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + oracleHalfEven((sorted[upper] - sorted[lower]) * remainder, denominator);
}

function floorRoot(value) {
  if (value < 0n) throw new RangeError('negative root');
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (middle * middle <= value) low = middle;
    else high = middle;
  }
  return low;
}

export function oracleSampleStdAtoms(values) {
  if (values.length < 2) return null;
  const mean = oracleMeanAtoms(values);
  const squares = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0n);
  const variance = oracleHalfEven(squares, BigInt(values.length - 1));
  const lower = floorRoot(variance);
  const upper = lower + 1n;
  const below = variance - lower * lower;
  const above = upper * upper - variance;
  if (above < below || (above === below && lower % 2n !== 0n)) return upper;
  return lower;
}

export function oracleAlignOnOrAfter(sessionDates, civilDate) {
  return sessionDates.find((date) => date >= civilDate) ?? null;
}

export function oracleLeapDate(year, month, day) {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const resolvedDay = month === 2 && day === 29 && !leap ? 28 : day;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(resolvedDay).padStart(2, '0')}`;
}

function sortedCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(sortedCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${sortedCanonical(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function oracleOccurrenceIdentityId(value) {
  const canonical = sortedCanonical({
    schemaVersion: 'MarketSeasonalityOccurrenceIdentity/1',
    ...value,
  });
  return `sha256:${createHash('sha256').update(Buffer.from(`${canonical}\n`)).digest('hex')}`;
}

export function oracleDistinctYearCount(occurrences) {
  return new Set(occurrences.map((occurrence) => occurrence.historicalYear)).size;
}

export function oracleOccurrenceSetIsClosed(occurrences) {
  const ids = new Set();
  const years = new Set();
  for (const occurrence of occurrences) {
    if (ids.has(occurrence.occurrenceIdentityId) || years.has(occurrence.historicalYear)) return false;
    ids.add(occurrence.occurrenceIdentityId);
    years.add(occurrence.historicalYear);
  }
  return true;
}

export function oracleExcursions(startClose, highs, lows, scale = 12) {
  if (startClose === 0n) throw new RangeError('zero denominator');
  if (highs.length !== lows.length || highs.length === 0) throw new RangeError('invalid excursion');
  const favorable = highs.map((high) => oracleReturnAtoms(startClose, high, scale))
    .reduce((best, value) => value > best ? value : best);
  const adverse = lows.map((low) => oracleReturnAtoms(startClose, low, scale))
    .reduce((worst, value) => value < worst ? value : worst);
  return { adverse, favorable };
}

export const INDEPENDENT_SEASONALITY_MANUAL_VECTORS_L4V1 = Object.freeze([
  ['return_positive', () => oracleReturnAtoms(100n, 110n, 2), 10n],
  ['return_negative', () => oracleReturnAtoms(100n, 90n, 2), -10n],
  ['return_flat', () => oracleReturnAtoms(100n, 100n, 2), 0n],
  ['return_repeat', () => oracleReturnAtoms(3n, 4n, 4), 3333n],
  ['half_even_down', () => oracleHalfEven(5n, 2n), 2n],
  ['half_even_up', () => oracleHalfEven(7n, 2n), 4n],
  ['half_even_negative_down', () => oracleHalfEven(-5n, 2n), -2n],
  ['half_even_negative_up', () => oracleHalfEven(-7n, 2n), -4n],
  ['mean_one', () => oracleMeanAtoms([7n]), 7n],
  ['mean_even_tie', () => oracleMeanAtoms([1n, 2n]), 2n],
  ['mean_negative', () => oracleMeanAtoms([-3n, -1n]), -2n],
  ['median_odd', () => oracleMedianAtoms([9n, 1n, 5n]), 5n],
  ['median_even_down', () => oracleMedianAtoms([1n, 4n]), 2n],
  ['median_even_up', () => oracleMedianAtoms([2n, 5n]), 4n],
  ['q25_n1', () => oracleQuantileAtoms([8n], 1n, 4n), 8n],
  ['q25_n2', () => oracleQuantileAtoms([0n, 4n], 1n, 4n), 1n],
  ['q75_n2', () => oracleQuantileAtoms([0n, 4n], 3n, 4n), 3n],
  ['q25_n3', () => oracleQuantileAtoms([0n, 4n, 8n], 1n, 4n), 2n],
  ['q75_n3', () => oracleQuantileAtoms([0n, 4n, 8n], 3n, 4n), 6n],
  ['q25_n4', () => oracleQuantileAtoms([0n, 4n, 8n, 12n], 1n, 4n), 3n],
  ['q75_n4', () => oracleQuantileAtoms([0n, 4n, 8n, 12n], 3n, 4n), 9n],
  ['q25_n5', () => oracleQuantileAtoms([0n, 4n, 8n, 12n, 16n], 1n, 4n), 4n],
  ['q75_negative', () => oracleQuantileAtoms([-8n, -4n, 0n], 3n, 4n), -2n],
  ['std_n1', () => oracleSampleStdAtoms([1n]), null],
  ['std_two', () => oracleSampleStdAtoms([0n, 2n]), 1n],
  ['align_exact', () => oracleAlignOnOrAfter(['2024-01-02'], '2024-01-02'), '2024-01-02'],
  ['align_weekend', () => oracleAlignOnOrAfter(['2024-01-08'], '2024-01-06'), '2024-01-08'],
  ['align_missing', () => oracleAlignOnOrAfter([], '2024-01-01'), null],
  ['leap_2024', () => oracleLeapDate(2024, 2, 29), '2024-02-29'],
  ['leap_2023', () => oracleLeapDate(2023, 2, 29), '2023-02-28'],
  ['leap_century', () => oracleLeapDate(2100, 2, 29), '2100-02-28'],
  ['leap_400', () => oracleLeapDate(2000, 2, 29), '2000-02-29'],
  ['distinct_years', () => oracleDistinctYearCount([{ historicalYear: 2020 }, { historicalYear: 2021 }]), 2],
  ['closed_set', () => oracleOccurrenceSetIsClosed([{ historicalYear: 2020, occurrenceIdentityId: 'a' }]), true],
  ['duplicate_year', () => oracleOccurrenceSetIsClosed([{ historicalYear: 2020, occurrenceIdentityId: 'a' }, { historicalYear: 2020, occurrenceIdentityId: 'b' }]), false],
  ['duplicate_id', () => oracleOccurrenceSetIsClosed([{ historicalYear: 2020, occurrenceIdentityId: 'a' }, { historicalYear: 2021, occurrenceIdentityId: 'a' }]), false],
  ['mae_mfe', () => oracleExcursions(100n, [110n, 105n], [90n, 95n], 2), { adverse: -10n, favorable: 10n }],
  ['mae_positive', () => oracleExcursions(100n, [110n], [101n], 2), { adverse: 1n, favorable: 10n }],
  ['mfe_negative', () => oracleExcursions(100n, [99n], [90n], 2), { adverse: -10n, favorable: -1n }],
  ['current_return', () => oracleReturnAtoms(80n, 100n, 4), 2500n],
]);
