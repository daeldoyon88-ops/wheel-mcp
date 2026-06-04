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
