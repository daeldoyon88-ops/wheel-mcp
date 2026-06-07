/**
 * Validation Phase 1B — Priorisation de l'archive Scan Funnel.
 *
 * Micro-patch frontend (wheel-dashboard/src/scanFunnelArchivePayload.js) :
 *   - priorisation des stages avant le cap 800 (UI/IBKR proches de la décision finale d'abord) ;
 *   - plafonnement de watchlist_rejected (MAX_WATCHLIST_REJECTED_EVENTS = 250) ;
 *   - crypto_blocked conservé (priorité avant watchlist_rejected, après UI/IBKR/Yahoo) ;
 *   - crypto exclusif inchangé ; structure du payload inchangée.
 *
 * Read-only : ne touche ni backend, ni DB, ni routes, ni server, ni dashboard, ni scanner.
 * Écrit deux rapports :
 *   debug/scan-funnel-archive-phase1b-priority-validation.json
 *   debug/scan-funnel-archive-phase1b-priority-validation.md
 *
 * Usage : node debug/scan-funnel-archive-phase1b-priority-validation.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  buildScanFunnelArchivePayload,
  MAX_FUNNEL_EVENTS,
  MAX_WATCHLIST_REJECTED_EVENTS,
  FUNNEL_STAGE_PRIORITY,
} from "../wheel-dashboard/src/scanFunnelArchivePayload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
}

function countStage(events, stage) {
  return events.filter((e) => e.stage === stage).length;
}

// ── Scénario de saturation : beaucoup de watchlist_rejected + crypto + UI/IBKR ──
const watchlistRejectedBySymbol = {};
for (let i = 0; i < MAX_FUNNEL_EVENTS + 400; i += 1) {
  watchlistRejectedBySymbol[`WL${i}`] = "excluded_by_watchlist_limit";
}
const cryptoBlockedRemovedSymbols = [];
for (let i = 0; i < 40; i += 1) cryptoBlockedRemovedSymbols.push(`CRX${i}`);

const payload = buildScanFunnelArchivePayload({
  scanSessionId: "20260607_phase1b",
  scanTimestamp: "2026-06-07T12:00:00.000Z",
  selectedExpiration: "2026-06-19",
  watchlistRejectedBySymbol,
  cryptoBlockedRemovedSymbols,
  yahooRejectedBySymbol: { YHR1: "low_liquidity", YHR2: "no_options" },
  funnelRows: [
    { ticker: "AAA", yahooRank: 1, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" },
    { ticker: "BBB", yahooRank: 2, inShortlist: true, sentIbkr: true, ibkrStatus: "rejected", reason: "spread_too_wide" },
    { ticker: "CCC", yahooRank: 3, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" }, // retenu non affiché → ui_lost
  ],
  displayedSymbols: ["AAA"],
  metadata: { archiveComplete: true },
});

const events = payload.events;

// ── Vérifications fonctionnelles ──────────────────────────────────────────────
record("patch frontend helper seulement (constantes Phase 1B exportées)",
  MAX_FUNNEL_EVENTS === 800 && MAX_WATCHLIST_REJECTED_EVENTS === 250 && Array.isArray(FUNNEL_STAGE_PRIORITY),
  `MAX=${MAX_FUNNEL_EVENTS} WL=${MAX_WATCHLIST_REJECTED_EVENTS} order=${FUNNEL_STAGE_PRIORITY.join(">")}`);

record("ui_displayed conservé", events.some((e) => e.symbol === "AAA" && e.stage === "ui_displayed"));
record("ui_lost conservé", events.some((e) => e.symbol === "CCC" && e.stage === "ui_lost"));
record("ibkr_retained conservé", events.some((e) => e.symbol === "AAA" && e.stage === "ibkr_retained"));
record("ibkr_rejected conservé", events.some((e) => e.symbol === "BBB" && e.stage === "ibkr_rejected"));
record("ibkr_sent conservé", events.some((e) => e.symbol === "AAA" && e.stage === "ibkr_sent"));
record("yahoo_returned conservé", events.some((e) => e.symbol === "AAA" && e.stage === "yahoo_returned"));
record("yahoo_rejected conservé", countStage(events, "yahoo_rejected") === 2, `count=${countStage(events, "yahoo_rejected")}`);

const wlCount = countStage(events, "watchlist_rejected");
record("watchlist_rejected limité (<= 250)", wlCount <= MAX_WATCHLIST_REJECTED_EVENTS, `count=${wlCount}`);
record("watchlist_rejected exactement plafonné à 250 sous saturation", wlCount === MAX_WATCHLIST_REJECTED_EVENTS, `count=${wlCount}`);

record("cap 800 respecté", events.length <= MAX_FUNNEL_EVENTS, `count=${events.length}`);

const cryptoCount = countStage(events, "crypto_blocked");
record("crypto_blocked présent (tous conservés)", cryptoCount === 40, `count=${cryptoCount}`);

// crypto exclusif inchangé : un ticker crypto n'émet que crypto_blocked
const cryptoExclusivePayload = buildScanFunnelArchivePayload({
  scanSessionId: "phase1b-crypto-exclusif",
  cryptoBlockedRemovedSymbols: ["RIOT"],
  displayedSymbols: ["RIOT"],
  yahooRejectedBySymbol: { RIOT: "ignored" },
  ibkrDirectSentTickers: ["RIOT"],
});
const riot = cryptoExclusivePayload.events.filter((e) => e.symbol === "RIOT");
record("crypto exclusif conservé (RIOT n'émet que crypto_blocked)", riot.length === 1 && riot[0].stage === "crypto_blocked");

// BITX non bloqué s'il n'est pas crypto
const bitxPayload = buildScanFunnelArchivePayload({
  scanSessionId: "phase1b-bitx",
  displayedSymbols: ["BITX"],
  cryptoBlockedRemovedSymbols: ["RIOT"],
});
record("BITX non bloqué (ui_displayed)", bitxPayload.events.some((e) => e.symbol === "BITX" && e.stage === "ui_displayed"));

// Structure du payload inchangée
const PAYLOAD_KEYS = [
  "scanSessionId", "scanTimestamp", "selectedExpiration", "dteAtScan",
  "poolSource", "captureSource", "counts", "metadata", "events",
];
record("structure du payload inchangée", PAYLOAD_KEYS.every((k) => k in payload), Object.keys(payload).join(","));

const json = JSON.stringify(payload);
record("payload compact (pas de rawJson/optionChain/greeks)",
  !json.includes("rawJson") && !json.includes("optionChain") && !json.includes("greeks"));

// ── Garde-fous périmètre : seul le helper (+ son test) modifié ────────────────
let changedFiles = [];
try {
  const out = execFileSync("git", ["diff", "--name-only"], { cwd: repoRoot, encoding: "utf8" });
  changedFiles = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch {
  changedFiles = [];
}
const ALLOWED = new Set([
  "wheel-dashboard/src/scanFunnelArchivePayload.js",
  "wheel-dashboard/src/scanFunnelArchivePayload.test.mjs",
]);
const FORBIDDEN_PATTERNS = [
  /server\.js$/,
  /dashboard\.jsx$/,
  /scanFunnelArchiveRoutes\.js$/,
  /scanFunnelArchiveStore\.js$/,
  /wheelScanner\.js$/,
  /wheelValidationService\.js$/,
  /tradingview|\.pine$/i,
];
const touchedForbidden = changedFiles.filter((f) => FORBIDDEN_PATTERNS.some((re) => re.test(f)));
record("aucun fichier backend/server/routes/DB/dashboard/scanner/scoring/Pine modifié",
  touchedForbidden.length === 0, touchedForbidden.join(", "));
record("seuls le helper et son test (suivis) modifiés",
  changedFiles.every((f) => ALLOWED.has(f)), changedFiles.join(", ") || "(aucun fichier suivi modifié)");

const allOk = checks.every((c) => c.ok);

const stageCounts = {};
for (const stage of FUNNEL_STAGE_PRIORITY) stageCounts[stage] = countStage(events, stage);

const report = {
  title: "Scan Funnel Archive — Phase 1B Priority Validation",
  generatedAt: new Date().toISOString(),
  allOk,
  scope: "frontend helper only (scanFunnelArchivePayload.js + test)",
  maxFunnelEvents: MAX_FUNNEL_EVENTS,
  maxWatchlistRejectedEvents: MAX_WATCHLIST_REJECTED_EVENTS,
  stagePriority: FUNNEL_STAGE_PRIORITY,
  saturationScenario: {
    totalEventsAfterPriority: events.length,
    stageCounts,
  },
  changedTrackedFiles: changedFiles,
  checks,
};
fs.writeFileSync(
  path.join(__dirname, "scan-funnel-archive-phase1b-priority-validation.json"),
  JSON.stringify(report, null, 2)
);

const md = [
  "# Scan Funnel Archive — Phase 1B Priority Validation",
  "",
  `Généré : ${report.generatedAt}`,
  `Résultat global : ${allOk ? "✅ OK" : "❌ ÉCHEC"}`,
  `Périmètre : ${report.scope}`,
  "",
  "## Constantes",
  `- \`MAX_FUNNEL_EVENTS\` = ${MAX_FUNNEL_EVENTS}`,
  `- \`MAX_WATCHLIST_REJECTED_EVENTS\` = ${MAX_WATCHLIST_REJECTED_EVENTS}`,
  `- Ordre de priorité : \`${FUNNEL_STAGE_PRIORITY.join(" > ")}\``,
  "",
  "## Scénario de saturation (watchlist_rejected massif + crypto + UI/IBKR)",
  `- Events finaux après priorisation : **${events.length}** (cap ${MAX_FUNNEL_EVENTS})`,
  "",
  "| Stage | Count conservé |",
  "|---|---|",
  ...FUNNEL_STAGE_PRIORITY.map((s) => `| ${s} | ${stageCounts[s]} |`),
  "",
  "## Fichiers suivis modifiés",
  ...(changedFiles.length ? changedFiles.map((f) => `- \`${f}\``) : ["- (aucun)"]),
  "",
  "## Vérifications",
  "",
  "| # | Vérification | Statut | Détail |",
  "|---|---|---|---|",
  ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? "✅" : "❌"} | ${c.detail || ""} |`),
  "",
  "## Garanties Phase 1B",
  "- Patch frontend helper seulement (`scanFunnelArchivePayload.js` + son test).",
  "- Aucune modification backend / server.js / routes / DB / dashboard.jsx / scanner / scoring E2b / IBKR-Yahoo providers / Pine.",
  "- Events UI/IBKR priorisés (proches de la décision finale).",
  "- `watchlist_rejected` plafonné à 250 (n'écrase plus l'archive).",
  "- Cap 800 respecté.",
  "- Crypto exclusif conservé (un ticker crypto bloqué n'émet que `crypto_blocked`).",
  "- Structure / contrat du payload inchangés.",
  "",
].join("\n");
fs.writeFileSync(path.join(__dirname, "scan-funnel-archive-phase1b-priority-validation.md"), md);

console.log(`[phase1b-priority-validation] allOk=${allOk} checks=${checks.length} events=${events.length} wl=${wlCount} crypto=${cryptoCount}`);
for (const c of checks) {
  if (!c.ok) console.log(`  ❌ ${c.name} — ${c.detail}`);
}
process.exit(allOk ? 0 : 1);
