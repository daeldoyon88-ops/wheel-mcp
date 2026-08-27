/**
 * O(1) R2-local handoff for an already-fetched Yahoo chart result.
 * This module neither fetches, normalizes, persists, nor calls G21.
 */

const MAX_CAPTURED_SYMBOLS = 128;
const captures = new Map();
let forceCaptureFailureForTest = false;

function isStrictUtcIso(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

export function captureYahooChartResult(symbol, chartResult, { capturedAt = new Date().toISOString() } = {}) {
  if (forceCaptureFailureForTest) throw new Error('G21_CAPTURE_FORCED_TEST_FAILURE');
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (!normalizedSymbol || !chartResult || typeof chartResult !== 'object' || !isStrictUtcIso(capturedAt)) return false;
  if (!captures.has(normalizedSymbol) && captures.size >= MAX_CAPTURED_SYMBOLS) {
    captures.delete(captures.keys().next().value);
  }
  captures.set(normalizedSymbol, { chartResult, capturedAt });
  return true;
}

export function getCapturedYahooChartResult(symbol) {
  return captures.get(String(symbol ?? '').trim().toUpperCase()) ?? null;
}

export function clearCapturedYahooChartResultsForTest() {
  captures.clear();
  forceCaptureFailureForTest = false;
}

export function setCaptureFailureForTest(value) {
  forceCaptureFailureForTest = value === true;
}
