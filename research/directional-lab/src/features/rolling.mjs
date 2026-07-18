/**
 * Null-aware trailing (causal) rolling helpers.
 * Every output index i depends only on inputs [i-window+1 .. i].
 * A window containing any null yields null (missing stays missing).
 */

/**
 * @param {(number|null)[]} values
 * @param {number} window
 * @param {(slice: number[]) => number} fn
 * @returns {(number|null)[]}
 */
export function rollingApply(values, window, fn) {
  if (!Number.isInteger(window) || window < 1) throw new Error(`window must be a positive integer, got ${window}`);
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let ok = true;
    const slice = new Array(window);
    for (let j = 0; j < window; j++) {
      const v = values[i - window + 1 + j];
      if (v === null || v === undefined) { ok = false; break; }
      slice[j] = v;
    }
    if (ok) {
      const r = fn(slice);
      out[i] = Number.isFinite(r) ? r : null;
    }
  }
  return out;
}

/** @param {(number|null)[]} values @param {number} window @returns {(number|null)[]} */
export function rollingMean(values, window) {
  return rollingApply(values, window, (s) => s.reduce((a, b) => a + b, 0) / s.length);
}

/** @param {(number|null)[]} values @param {number} window @returns {(number|null)[]} */
export function rollingMax(values, window) {
  return rollingApply(values, window, (s) => Math.max(...s));
}

/** @param {(number|null)[]} values @param {number} window @returns {(number|null)[]} */
export function rollingMin(values, window) {
  return rollingApply(values, window, (s) => Math.min(...s));
}

/** Sample standard deviation. @param {(number|null)[]} values @param {number} window @returns {(number|null)[]} */
export function rollingStd(values, window) {
  return rollingApply(values, window, (s) => {
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    const variance = s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (s.length - 1);
    return Math.sqrt(variance);
  });
}

/**
 * Lag a series by n (out[i] = values[i-n]); first n entries are null.
 * @param {(number|null)[]} values @param {number} n @returns {(number|null)[]}
 */
export function shift(values, n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('shift: n must be a non-negative integer');
  const out = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i++) out[i] = values[i - n] ?? null;
  return out;
}

/**
 * Percentile rank (0..100) of the current value within its trailing window
 * (window includes the current value).
 * @param {(number|null)[]} values @param {number} window @returns {(number|null)[]}
 */
export function rollingPercentileRank(values, window) {
  return rollingApply(values, window, (s) => {
    const current = s[s.length - 1];
    let below = 0;
    for (const v of s) if (v <= current) below++;
    return (below / s.length) * 100;
  });
}

/**
 * Expanding (prefix) maximum: out[i] = max(values[0..i]) over non-null values,
 * null until the first non-null value.
 * @param {(number|null)[]} values @returns {(number|null)[]}
 */
export function expandingMax(values) {
  const out = new Array(values.length).fill(null);
  let max = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined && (max === null || v > max)) max = v;
    out[i] = max;
  }
  return out;
}

/**
 * out[i] = values[i] - values[i-lag]; null when either side is null.
 * @param {(number|null)[]} values @param {number} lag @returns {(number|null)[]}
 */
export function diffSeries(values, lag) {
  const lagged = shift(values, lag);
  return values.map((v, i) => (v === null || lagged[i] === null ? null : v - lagged[i]));
}
