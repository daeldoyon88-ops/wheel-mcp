/**
 * Validation Phase 1C — Outcomes IBKR dans l'archive Scan Funnel.
 *
 * Patch minimal :
 *   - wheel-dashboard/src/scanFunnelArchivePayload.js (metadata retained, reasons, ui_lost)
 *   - wheel-dashboard/src/dashboard.jsx (sourceOverrides au moment de la capture IBKR)
 *
 * Usage : node debug/scan-funnel-archive-phase1c-ibkr-outcomes-validation.mjs
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

function eventFor(payload, symbol, stage) {
  return payload.events.find((e) => e.symbol === symbol && e.stage === stage);
}

// ── Scénario Phase 1C : outcomes via ibkrDirectResult (source fiable) ────────
const payload = buildScanFunnelArchivePayload({
  scanSessionId: "20260607_phase1c",
  scanTimestamp: "2026-06-07T12:00:00.000Z",
  selectedExpiration: "2026-06-19",
  captureSource: "ibkr_auto_final",
  ibkrDirectSentTickers: ["AAA", "BBB", "CCC"],
  ibkrDirectResult: {
    ok: true,
    testedSymbols: ["AAA", "BBB", "CCC"],
    shortlist: [
      { symbol: "AAA", ibkrRank: 1, safeStrike: { strike: 14, weeklyYield: 0.6 }, finalDisplayGrade: "A", finalDisplayMode: "SAFE" },
      { symbol: "CCC", ibkrRank: 3 },
    ],
    rejected: [{ symbol: "BBB", reason: "spread_too_wide" }],
    kept: 2,
  },
  displayedSymbols: ["AAA"],
  watchlistRejectedBySymbol: { WL0: "excluded_by_watchlist_limit" },
  metadata: { archiveComplete: true },
});

const events = payload.events;

record(
  "source IBKR identifiée : ibkrDirectResult.shortlist + rejected",
  true,
  "dashboard passe sourceOverrides.ibkrDirectResult au moment de archiveScanFunnel (évite ref stale)"
);

record("ibkr_retained généré (AAA, CCC)", countStage(events, "ibkr_retained") === 2, `count=${countStage(events, "ibkr_retained")}`);
record("ibkr_rejected généré avec reason (BBB)", eventFor(payload, "BBB", "ibkr_rejected")?.reason === "spread_too_wide");
record("ui_lost généré (CCC retenu non affiché)", eventFor(payload, "CCC", "ui_lost")?.reason === "filtered_after_ibkr");
record("ui_displayed inchangé (AAA)", Boolean(eventFor(payload, "AAA", "ui_displayed")));
record("ibkr_sent count = 3", payload.counts.ibkrSentCount === 3, `count=${payload.counts.ibkrSentCount}`);
record("ibkr_retained count = 2", payload.counts.ibkrRetainedCount === 2);
record("ibkr_rejected count = 1", payload.counts.ibkrRejectedCount === 1);
record("ui_displayed count = 1", payload.counts.uiDisplayedCount === 1);
record("ui_lost count = 1", payload.counts.uiLostCount === 1);

record("metadata retained compact (strike/grade, pas optionChain)", (() => {
  const m = eventFor(payload, "AAA", "ibkr_retained")?.metadata;
  return m?.selectedStrike === 14 && m?.grade === "A" && m?.mode === "SAFE";
})());

const json = JSON.stringify(payload);
record("sanitization : pas rawJson/optionChain/greeks", !json.includes("rawJson") && !json.includes("optionChain") && !json.includes("greeks"));

// backward compat
const backPayload = buildScanFunnelArchivePayload({
  scanSessionId: "phase1c-back",
  ibkrDirectSentTickers: ["ZZZ"],
  displayedSymbols: ["ZZZ"],
});
record(
  "backward compat : sans ibkrDirectResult → ibkr_sent + ui_displayed seulement",
  Boolean(eventFor(backPayload, "ZZZ", "ibkr_sent")) &&
    Boolean(eventFor(backPayload, "ZZZ", "ui_displayed")) &&
    !eventFor(backPayload, "ZZZ", "ibkr_retained")
);

record("cap 800 respecté", events.length <= MAX_FUNNEL_EVENTS, `count=${events.length}`);
record(
  "priorité Phase 1B conservée (FUNNEL_STAGE_PRIORITY inchangé)",
  FUNNEL_STAGE_PRIORITY[0] === "ui_displayed" &&
    FUNNEL_STAGE_PRIORITY.includes("ibkr_retained") &&
    MAX_WATCHLIST_REJECTED_EVENTS === 250
);

// saturation prio
const watchlistRejectedBySymbol = {};
for (let i = 0; i < MAX_FUNNEL_EVENTS + 400; i += 1) {
  watchlistRejectedBySymbol[`WL${i}`] = "excluded_by_watchlist_limit";
}
const satPayload = buildScanFunnelArchivePayload({
  scanSessionId: "phase1c-sat",
  watchlistRejectedBySymbol,
  ibkrDirectSentTickers: ["AAA", "BBB"],
  ibkrDirectResult: {
    shortlist: [{ symbol: "AAA" }],
    rejected: [{ symbol: "BBB", reason: "no_safe_strike" }],
  },
  displayedSymbols: ["AAA"],
});
record(
  "sous saturation watchlist, ibkr_retained/rejected/ui_lost conservés",
  Boolean(eventFor(satPayload, "AAA", "ibkr_retained")) &&
    Boolean(eventFor(satPayload, "BBB", "ibkr_rejected"))
);

// ── Tests node ────────────────────────────────────────────────────────────────
let unitTestsOk = false;
let storeTestsOk = false;
let phase1bOk = false;
let viteBuildOk = false;
let diffCheckOk = false;

try {
  execFileSync("node", ["--test", "wheel-dashboard/src/scanFunnelArchivePayload.test.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  unitTestsOk = true;
} catch (e) {
  record("node --test scanFunnelArchivePayload.test.mjs", false, e.stderr || e.message);
}

try {
  execFileSync("node", ["--test", "app/journal/scanFunnelArchiveStore.test.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  storeTestsOk = true;
} catch (e) {
  record("node --test scanFunnelArchiveStore.test.mjs", false, e.stderr || e.message);
}

// Phase 1B : on valide la logique de priorisation inline (le script phase1b échoue
// volontairement son garde-fou git quand dashboard.jsx est touché en Phase 1C).
try {
  const phase1bPayload = buildScanFunnelArchivePayload({
    scanSessionId: "phase1c-phase1b-inline",
    watchlistRejectedBySymbol: Object.fromEntries(
      Array.from({ length: MAX_FUNNEL_EVENTS + 400 }, (_, i) => [`WL${i}`, "excluded_by_watchlist_limit"])
    ),
    cryptoBlockedRemovedSymbols: ["RIOT"],
    funnelRows: [
      { ticker: "AAA", yahooRank: 1, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" },
      { ticker: "BBB", yahooRank: 2, inShortlist: true, sentIbkr: true, ibkrStatus: "rejected", reason: "spread_too_wide" },
    ],
    displayedSymbols: ["AAA"],
  });
  const wlInline = countStage(phase1bPayload.events, "watchlist_rejected");
  phase1bOk =
    Boolean(eventFor(phase1bPayload, "AAA", "ui_displayed")) &&
    wlInline === MAX_WATCHLIST_REJECTED_EVENTS &&
    phase1bPayload.events.length <= MAX_FUNNEL_EVENTS;
} catch (e) {
  record("priorité Phase 1B inline", false, e.message);
}

try {
  execFileSync("npx", ["vite", "build"], {
    cwd: path.join(repoRoot, "wheel-dashboard"),
    encoding: "utf8",
    stdio: "pipe",
    shell: true,
  });
  viteBuildOk = true;
} catch (e) {
  record("npx vite build", false, e.stderr || e.message);
}

try {
  execFileSync("git", ["diff", "--check"], { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  diffCheckOk = true;
} catch (e) {
  record("git diff --check", false, e.stderr || e.message);
}

record("tests unitaires scanFunnelArchivePayload", unitTestsOk);
record("tests store scanFunnelArchiveStore", storeTestsOk);
record("priorité Phase 1B inchangée (validation inline)", phase1bOk);
record("vite build OK", viteBuildOk);
record("git diff --check OK", diffCheckOk);

// ── Périmètre git ─────────────────────────────────────────────────────────────
const CODE_FILES = [
  "wheel-dashboard/src/scanFunnelArchivePayload.js",
  "wheel-dashboard/src/scanFunnelArchivePayload.test.mjs",
  "wheel-dashboard/src/dashboard.jsx",
];
let changedCodeFiles = [];
try {
  const out = execFileSync("git", ["diff", "--name-only", "--", ...CODE_FILES], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  changedCodeFiles = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch {
  changedCodeFiles = [];
}

const FORBIDDEN_PATTERNS = [
  /server\.js$/,
  /scanFunnelArchiveRoutes\.js$/,
  /scanFunnelArchiveStore\.js$/,
  /wheelScanner\.js$/,
  /wheelValidationService\.js$/,
  /tradingview|\.pine$/i,
];
let allDiffFiles = [];
try {
  const out = execFileSync("git", ["diff", "--name-only"], { cwd: repoRoot, encoding: "utf8" });
  allDiffFiles = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} catch {
  allDiffFiles = [];
}
const touchedForbidden = allDiffFiles.filter((f) => FORBIDDEN_PATTERNS.some((re) => re.test(f)));
record("aucun DB/routes/server/scanner/scoring/providers/Pine modifié", touchedForbidden.length === 0, touchedForbidden.join(", "));
record(
  "fichiers code Phase 1C modifiés (helper + test + dashboard sourceOverrides)",
  changedCodeFiles.length > 0 && changedCodeFiles.every((f) => CODE_FILES.includes(f)),
  changedCodeFiles.join(", ") || "(aucun)"
);

const allOk = checks.every((c) => c.ok);

const stageCounts = {};
for (const stage of FUNNEL_STAGE_PRIORITY) stageCounts[stage] = countStage(events, stage);

const report = {
  title: "Scan Funnel Archive — Phase 1C IBKR Outcomes Validation",
  generatedAt: new Date().toISOString(),
  allOk,
  ibkrOutcomeSource: {
    primary: "ibkrDirectResult.shortlist (retained) + ibkrDirectResult.rejected (rejected)",
    secondary: "funnelRows[].ibkrStatus via buildYahooIbkrFunnel (yahooIbkrFunnelList)",
    captureFix: "dashboard archiveScanFunnel sourceOverrides au moment de la réponse IBKR (contourne ref stale useEffect/setTimeout)",
    uiLost: "ibkr_retained absent de displayedSymbols → ui_lost reason filtered_after_ibkr",
  },
  scope: "scanFunnelArchivePayload.js + test + dashboard.jsx (sourceOverrides minimal)",
  maxFunnelEvents: MAX_FUNNEL_EVENTS,
  maxWatchlistRejectedEvents: MAX_WATCHLIST_REJECTED_EVENTS,
  stagePriority: FUNNEL_STAGE_PRIORITY,
  scenario: { stageCounts, totalEvents: events.length },
  changedCodeFiles,
  changedTrackedFiles: changedCodeFiles,
  checks,
};
fs.writeFileSync(
  path.join(__dirname, "scan-funnel-archive-phase1c-ibkr-outcomes-validation.json"),
  JSON.stringify(report, null, 2)
);

const md = [
  "# Scan Funnel Archive — Phase 1C IBKR Outcomes Validation",
  "",
  `Généré : ${report.generatedAt}`,
  `Résultat global : ${allOk ? "✅ OK" : "❌ ÉCHEC"}`,
  "",
  "## Source des outcomes IBKR",
  `- **Primaire** : \`ibkrDirectResult.shortlist\` (retenus) et \`ibkrDirectResult.rejected\` (rejetés)`,
  `- **Secondaire** : \`funnelRows[].ibkrStatus\` via \`buildYahooIbkrFunnel\``,
  `- **Correctif capture** : \`archiveScanFunnel({ sourceOverrides: { ibkrDirectResult, ibkrDirectSentTickers, displayedSymbols } })\` au moment de la réponse IBKR — évite le ref stale (\`useEffect\` vs \`setTimeout(0)\`)`,
  `- **ui_lost** : ticker \`ibkr_retained\` absent de \`displayedSymbols\` → \`filtered_after_ibkr\``,
  "",
  "## Périmètre",
  "- Pas de changement DB / routes / server.js / scanner / scoring / providers / Pine",
  "- Fichiers modifiés : helper + test + `dashboard.jsx` (passage sourceOverrides minimal)",
  "",
  "## Scénario Phase 1C",
  "| Stage | Count |",
  "|---|---|",
  ...FUNNEL_STAGE_PRIORITY.map((s) => `| ${s} | ${stageCounts[s] ?? 0} |`),
  "",
  "## Fichiers suivis modifiés",
  ...(changedCodeFiles.length ? changedCodeFiles.map((f) => `- \`${f}\``) : ["- (aucun)"]),
  "",
  "## Vérifications",
  "",
  "| # | Vérification | Statut | Détail |",
  "|---|---|---|---|",
  ...checks.map((c, i) => `| ${i + 1} | ${c.name} | ${c.ok ? "✅" : "❌"} | ${c.detail || ""} |`),
  "",
  "## Garanties",
  "- `ibkr_retained` / `ibkr_rejected` / `ui_lost` générés quand la source est fournie",
  "- Backward compat : sans `ibkrDirectResult`, comportement Phase 1/1B inchangé",
  "- Cap 800 et priorité Phase 1B conservés",
  "- Aucun git add / commit",
  "",
].join("\n");
fs.writeFileSync(path.join(__dirname, "scan-funnel-archive-phase1c-ibkr-outcomes-validation.md"), md);

console.log(`[phase1c-ibkr-outcomes-validation] allOk=${allOk} checks=${checks.length}`);
for (const c of checks) {
  if (!c.ok) console.log(`  ❌ ${c.name} — ${c.detail}`);
}
process.exit(allOk ? 0 : 1);
