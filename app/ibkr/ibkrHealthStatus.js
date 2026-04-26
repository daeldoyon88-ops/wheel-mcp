import { IBKR_CONFIG } from "../config/ibkr.js";

function baseStatus() {
  return {
    ok: false,
    provider: "IBKR",
    mode: "readonly",
    readOnly: true,
    canTrade: false,
    connected: false,
    host: IBKR_CONFIG.host,
    port: IBKR_CONFIG.port,
    clientId: IBKR_CONFIG.clientId,
    enabled: IBKR_CONFIG.enabled,
  };
}

/**
 * Lazy IBKR probe for GET /ibkr/health only: loads ib-tws-api via dynamic import
 * when IBKR is enabled; never called at server startup.
 */
export async function getIbkrHealthStatus() {
  const base = baseStatus();

  if (IBKR_CONFIG.enabled !== true) {
    return {
      ...base,
      ok: false,
      error:
        "IBKR is disabled (IBKR_ENABLED=false or unset; set IBKR_ENABLED=true to probe TWS/Gateway).",
    };
  }

  if (IBKR_CONFIG.readOnly !== true) {
    return { ...base, ok: false, error: "IBKR_READ_ONLY must be true" };
  }

  const { IbkrReadOnlyProvider } = await import("../data_providers/ibkrReadOnlyProvider.js");
  let client;
  try {
    client = new IbkrReadOnlyProvider();
  } catch (err) {
    return { ...base, ok: false, error: err?.message || String(err) };
  }

  try {
    await client.connect();
    return { ...base, ok: true, connected: true };
  } catch (err) {
    return {
      ...base,
      ok: false,
      connected: false,
      error: err?.message || String(err),
    };
  } finally {
    try {
      await client.disconnect();
    } catch (_e) {
      // ignore
    }
  }
}
