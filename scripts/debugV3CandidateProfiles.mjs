/**
 * Debug read-only — GET /journal/wheel-validation/v3-candidate-profiles
 * Usage: node scripts/debugV3CandidateProfiles.mjs [ticker] [mode]
 */
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3001";
const ticker = process.argv[2] ?? "";
const mode = process.argv[3] ?? "";

function buildUrl() {
  const params = new URLSearchParams({ limit: "20" });
  if (ticker) params.set("ticker", ticker.toUpperCase());
  if (mode) params.set("mode", mode.toUpperCase());
  return `${API_BASE}/journal/wheel-validation/v3-candidate-profiles?${params}`;
}

const url = buildUrl();
console.log("GET", url);

const response = await fetch(url);
const body = await response.json();

if (!response.ok || !body.ok) {
  console.error("FAILED", response.status, body);
  process.exit(1);
}

console.log(JSON.stringify(body, null, 2));
