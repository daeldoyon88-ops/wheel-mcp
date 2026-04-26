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
  enabled: parseBoolean(process.env.IBKR_ENABLED, false),
  readOnly: parseBoolean(process.env.IBKR_READ_ONLY, true),
  host: process.env.IBKR_HOST || "127.0.0.1",
  port: parseInteger(process.env.IBKR_PORT, 7497),
  clientId: parseInteger(process.env.IBKR_CLIENT_ID, 101),
  connectTimeoutMs: parseInteger(process.env.IBKR_CONNECT_TIMEOUT_MS, 5000),
};

export function assertIbkrReadOnly() {
  if (IBKR_CONFIG.readOnly !== true) {
    throw new Error("IBKR_READ_ONLY=true is required for this provider");
  }
}
