function parseBoolean(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const IBKR_CONFIG = {
  enabled: parseBoolean(process.env.IBKR_ENABLED, true),
  readOnly: parseBoolean(process.env.IBKR_READ_ONLY, true),
  host: process.env.IBKR_HOST || "127.0.0.1",
  port: parseInteger(process.env.IBKR_PORT, 4002),
  clientId: parseInteger(process.env.IBKR_CLIENT_ID, 101),
  connectTimeoutMs: parseInteger(process.env.IBKR_CONNECT_TIMEOUT_MS, 5000),
};

export function assertIbkrReadOnly() {
  if (IBKR_CONFIG.readOnly !== true) {
    throw new Error("IBKR_READ_ONLY=true is required for this provider");
  }
}

export const IBKR_TWO_PHASE_DEFAULT_PUT_WINDOW = 10;

/** TWO_PHASE par défaut ; NORMAL seulement si IBKR_TWO_PHASE_SCAN=0 (ou false/no/off). */
export function resolveIbkrTwoPhaseScanEnabled(rawValue = process.env.IBKR_TWO_PHASE_SCAN) {
  return parseBoolean(rawValue, true);
}

export function resolveIbkrTwoPhasePutWindow(rawValue = process.env.IBKR_TWO_PHASE_PUT_WINDOW) {
  const n = parseInteger(rawValue, IBKR_TWO_PHASE_DEFAULT_PUT_WINDOW);
  return Math.max(1, n);
}

/** Concurrence du scan IBKR : défaut prudent 3, bornée [1, 5]. */
export const IBKR_SCAN_CONCURRENCY_DEFAULT = 3;
export const IBKR_SCAN_CONCURRENCY_MIN = 1;
export const IBKR_SCAN_CONCURRENCY_MAX = 5;

export function resolveIbkrScanConcurrency(rawValue = process.env.IBKR_SCAN_CONCURRENCY) {
  const n = parseInteger(rawValue, IBKR_SCAN_CONCURRENCY_DEFAULT);
  if (!Number.isFinite(n)) return IBKR_SCAN_CONCURRENCY_DEFAULT;
  return Math.max(IBKR_SCAN_CONCURRENCY_MIN, Math.min(IBKR_SCAN_CONCURRENCY_MAX, n));
}

/**
 * Taille de lot du scan IBKR UI/backend (chunk envoyé par requête).
 * Défaut 50 afin qu'un scan Depth 30 parte en 1 lot de 30 et Depth 50 en 1 lot de 50
 * (le moteur Python encaisse 50 titres avec concurrency=3). Bornée [5, 50] :
 * le plafond 50 reflète « Maximum 50 titres par validation IBKR Shadow ».
 * Un opérateur prudent peut forcer IBKR_SCAN_BATCH_SIZE=30 (ou moins, min 5).
 */
export const IBKR_SCAN_BATCH_SIZE_DEFAULT = 50;
export const IBKR_SCAN_BATCH_SIZE_MIN = 5;
export const IBKR_SCAN_BATCH_SIZE_MAX = 50;

export function resolveIbkrScanBatchSize(rawValue = process.env.IBKR_SCAN_BATCH_SIZE) {
  const n = parseInteger(rawValue, IBKR_SCAN_BATCH_SIZE_DEFAULT);
  if (!Number.isFinite(n)) return IBKR_SCAN_BATCH_SIZE_DEFAULT;
  return Math.max(IBKR_SCAN_BATCH_SIZE_MIN, Math.min(IBKR_SCAN_BATCH_SIZE_MAX, n));
}

export function formatIbkrTwoPhaseScanLog(env = process.env) {
  const raw = env.IBKR_TWO_PHASE_SCAN;
  const enabled = resolveIbkrTwoPhaseScanEnabled(raw);
  const putWindow = resolveIbkrTwoPhasePutWindow(env.IBKR_TWO_PHASE_PUT_WINDOW);
  const trimmed = raw == null ? "" : String(raw).trim();
  let source;
  if (trimmed === "") {
    source = "default, disable with IBKR_TWO_PHASE_SCAN=0";
  } else if (trimmed === "0") {
    source = "explicit off, IBKR_TWO_PHASE_SCAN=0";
  } else if (trimmed === "1") {
    source = "explicit, IBKR_TWO_PHASE_SCAN=1";
  } else {
    source = `IBKR_TWO_PHASE_SCAN=${trimmed}`;
  }
  return {
    enabled,
    mode: enabled ? "TWO_PHASE" : "NORMAL",
    source,
    putWindow,
    logLines: [
      `IBKR strike mode: ${enabled ? "TWO_PHASE" : "NORMAL"} (${source})`,
      `IBKR two phase put window: ${putWindow}`,
    ],
  };
}

export function logIbkrTwoPhaseScanConfig(env = process.env) {
  const cfg = formatIbkrTwoPhaseScanLog(env);
  for (const line of cfg.logLines) {
    console.log(line);
  }
  return cfg;
}

/** Quick premium gate : ON par défaut ; actif seulement en TWO_PHASE côté Python. */
export function resolveIbkrQuickPremiumGateEnabled(rawValue = process.env.IBKR_QUICK_PREMIUM_GATE) {
  return parseBoolean(rawValue, true);
}

export function formatIbkrQuickPremiumGateLog(env = process.env) {
  const raw = env.IBKR_QUICK_PREMIUM_GATE;
  const enabled = resolveIbkrQuickPremiumGateEnabled(raw);
  const trimmed = raw == null ? "" : String(raw).trim();
  let source;
  if (trimmed === "") {
    source = "default on, disable with IBKR_QUICK_PREMIUM_GATE=0";
  } else if (trimmed === "0") {
    source = "explicit off, IBKR_QUICK_PREMIUM_GATE=0";
  } else if (trimmed === "1") {
    source = "explicit on, IBKR_QUICK_PREMIUM_GATE=1";
  } else {
    source = `IBKR_QUICK_PREMIUM_GATE=${trimmed}`;
  }
  return {
    enabled,
    state: enabled ? "ON" : "OFF",
    source,
    logLine: `IBKR quick premium gate: ${enabled ? "ON" : "OFF"} (${source})`,
  };
}

export function logIbkrQuickPremiumGateConfig(env = process.env) {
  const cfg = formatIbkrQuickPremiumGateLog(env);
  console.log(cfg.logLine);
  return cfg;
}

export function logIbkrScanConcurrencyConfig(env = process.env) {
  const value = resolveIbkrScanConcurrency(env.IBKR_SCAN_CONCURRENCY);
  console.log(`IBKR scan concurrency: ${value}`);
  return value;
}

export function logIbkrScanBatchSizeConfig(env = process.env) {
  const value = resolveIbkrScanBatchSize(env.IBKR_SCAN_BATCH_SIZE);
  console.log(`IBKR scan batch size: ${value}`);
  return value;
}

/** Diagnostic console IBKR strike window ; actif seulement si IBKR_STRIKE_WINDOW_DEBUG=1. */
export function resolveIbkrStrikeWindowDebugEnabled(rawValue = process.env.IBKR_STRIKE_WINDOW_DEBUG) {
  return parseBoolean(rawValue, false);
}

export function strikeVsLowerBound(strike, lowerBound) {
  if (strike == null || lowerBound == null) {
    return { relation: "unknown", distancePct: null };
  }
  const strikeValue = Number(strike);
  const lowerBoundValue = Number(lowerBound);
  if (
    !Number.isFinite(strikeValue) ||
    !Number.isFinite(lowerBoundValue) ||
    lowerBoundValue <= 0
  ) {
    return { relation: "unknown", distancePct: null };
  }
  const relation = strikeValue < lowerBoundValue ? "below" : "equal_or_above";
  const distancePct = Number((((strikeValue - lowerBoundValue) / lowerBoundValue) * 100).toFixed(2));
  return { relation, distancePct };
}
