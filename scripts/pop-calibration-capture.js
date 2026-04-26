import { createPopCalibrationService } from "../app/journal/popCalibrationService.js";

const API_BASE = process.env.POP_CAPTURE_API_BASE || "http://127.0.0.1:3001";
const EXPIRATION = process.env.POP_CAPTURE_EXPIRATION || process.argv[2] || "2026-05-01";
const TOP_N = Number(process.env.POP_CAPTURE_TOP_N || 57);
const SORT = process.env.POP_CAPTURE_SORT || "score";

const DEFAULT_BUILD_WATCHLIST_BODY = {
  maxPrice: 125,
  minVolume: 500000,
  requireLiquidOptions: false,
  requireWeeklyOptions: true,
  categories: ["core", "growth"],
};

async function postJson(path, payload) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data?.ok === false) {
    throw new Error(data?.error || `HTTP ${response.status} on ${path}`);
  }
  return data;
}

async function main() {
  const service = createPopCalibrationService();
  console.log("[POP_CAPTURE] starting", {
    apiBase: API_BASE,
    expiration: EXPIRATION,
    topN: TOP_N,
    sort: SORT,
  });

  const buildPayload = await postJson("/universe/build", DEFAULT_BUILD_WATCHLIST_BODY);
  const tickers = Array.isArray(buildPayload?.watchlist) ? buildPayload.watchlist : [];
  if (tickers.length === 0) {
    throw new Error("No watchlist tickers returned by /universe/build");
  }

  const scanPayload = await postJson("/scan_shortlist", {
    expiration: EXPIRATION,
    tickers,
    topN: TOP_N,
    sort: SORT,
  });

  const shortlist = Array.isArray(scanPayload?.shortlist) ? scanPayload.shortlist : [];
  const captureResult = await service.captureFromShortlist(shortlist);

  console.log("[POP_CAPTURE] done", {
    scanned: scanPayload?.scanned ?? tickers.length,
    kept: scanPayload?.kept ?? shortlist.length,
    returned: scanPayload?.returned ?? shortlist.length,
    capturedRecords: captureResult.captured,
    journalPath: service.store.journalPath,
  });
}

main().catch((error) => {
  console.error("[POP_CAPTURE] failed:", error?.message || error);
  process.exit(1);
});
