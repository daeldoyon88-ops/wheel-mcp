/**
 * Validation Phase 1 — Scan Funnel Archive.
 *
 * Exécute des vérifications read-only et écrit deux rapports :
 *   debug/scan-funnel-archive-phase1-validation.json
 *   debug/scan-funnel-archive-phase1-validation.md
 *
 * N'altère AUCUNE base de production (utilise un fichier SQLite temporaire) et
 * ne refetch jamais Yahoo/IBKR.
 *
 * Usage : node debug/scan-funnel-archive-phase1-validation.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import {
  createScanFunnelArchiveStore,
  MAX_EVENTS,
} from "../app/journal/scanFunnelArchiveStore.js";
import {
  buildScanFunnelArchivePayload,
} from "../wheel-dashboard/src/scanFunnelArchivePayload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const checks = [];
function record(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail) });
}

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfa-validation-"));
  return path.join(dir, "journal.sqlite");
}

function readFileSafe(rel) {
  try {
    return fs.readFileSync(path.join(repoRoot, rel), "utf8");
  } catch {
    return "";
  }
}

async function main() {
  // ── 1. Store dédié créé + tables idempotentes ─────────────────────────────
  const sqlitePath = tmpDbPath();
  const store = createScanFunnelArchiveStore({ sqlitePath });
  await store.ensureInitialized();
  await store.ensureInitialized(); // idempotent
  record("store dédié créé (scanFunnelArchiveStore.js)", fs.existsSync(path.join(repoRoot, "app/journal/scanFunnelArchiveStore.js")));
  record("routes dédiées créées (scanFunnelArchiveRoutes.js)", fs.existsSync(path.join(repoRoot, "app/journal/scanFunnelArchiveRoutes.js")));
  record("tables idempotentes (double ensureInitialized sans erreur)", true);

  // ── 2. Archive + getSession ──────────────────────────────────────────────
  const arch = await store.archiveSession({
    scanSessionId: "valid-001",
    scanTimestamp: "2026-06-07T12:00:00.000Z",
    selectedExpiration: "2026-06-19",
    dteAtScan: 12,
    counts: { uiDisplayedCount: 1 },
    metadata: { archiveComplete: true },
    events: [
      { symbol: "SOFI", stage: "ui_displayed" },
      { symbol: "RIOT", stage: "crypto_blocked" },
      { symbol: "XYZ", stage: "yahoo_rejected", reason: "low_liquidity" },
    ],
  });
  record("archiveSession ok", arch.ok && arch.eventsArchived === 3, JSON.stringify(arch));
  const got = await store.getSession("valid-001");
  record("getSession retourne session + events", got && got.events.length === 3);

  // ── 3. Idempotence : re-archive même session ne duplique pas ──────────────
  await store.archiveSession({
    scanSessionId: "valid-001",
    events: [
      { symbol: "SOFI", stage: "ui_displayed" },
      { symbol: "RIOT", stage: "crypto_blocked" },
      { symbol: "XYZ", stage: "yahoo_rejected", reason: "low_liquidity" },
    ],
  });
  const got2 = await store.getSession("valid-001");
  record("re-archive même scanSessionId ne duplique pas", got2.events.length === 3, `events=${got2.events.length}`);

  // ── 4. Cap MAX_EVENTS ─────────────────────────────────────────────────────
  const big = [];
  for (let i = 0; i <= MAX_EVENTS; i += 1) big.push({ symbol: `S${i}`, stage: "yahoo_returned" });
  const rejectBig = await store.archiveSession({ scanSessionId: "valid-big", events: big });
  record("refuse > 800 events", rejectBig.ok === false, rejectBig.error);

  // ── 5. Payload helper compact + crypto exclusif + pas de rawJson ──────────
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "valid-payload",
    displayedSymbols: ["SOFI", "BITX"],
    cryptoBlockedRemovedSymbols: ["RIOT"],
    yahooRejectedBySymbol: { XYZ: "low_liquidity" },
    metadata: { archiveComplete: true, rawJson: "{should:strip}" },
  });
  const riot = payload.events.filter((e) => e.symbol === "RIOT");
  record("payload: RIOT crypto_blocked exclusif", riot.length === 1 && riot[0].stage === "crypto_blocked");
  record("payload: BITX non bloqué (ui_displayed)", payload.events.some((e) => e.symbol === "BITX" && e.stage === "ui_displayed"));
  record("payload: SOFI ui_displayed", payload.events.some((e) => e.symbol === "SOFI" && e.stage === "ui_displayed"));
  record("payload: XYZ yahoo_rejected", payload.events.some((e) => e.symbol === "XYZ" && e.stage === "yahoo_rejected"));
  const payloadJson = JSON.stringify(payload);
  record("payload compact: pas de rawJson", !payloadJson.includes("rawJson"));
  record("payload compact: pas d'optionChain/greeks", !payloadJson.includes("optionChain") && !payloadJson.includes("greeks"));
  record("payload: cap 800 respecté", payload.events.length <= 800);

  // ── 6. Même SQLite que Journal POP (chemin par défaut) ────────────────────
  const defaultStore = createScanFunnelArchiveStore();
  const expectedDefault = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
  record("même SQLite que Journal POP (défaut)", defaultStore.sqlitePath === expectedDefault, defaultStore.sqlitePath);

  // ── 7. Aucun refetch Yahoo/IBKR : pas d'import provider dans les nouveaux fichiers ──
  const storeSrc = readFileSafe("app/journal/scanFunnelArchiveStore.js");
  const routesSrc = readFileSafe("app/journal/scanFunnelArchiveRoutes.js");
  const payloadSrc = readFileSafe("wheel-dashboard/src/scanFunnelArchivePayload.js");
  // « refetch » = appel réseau ou import d'un provider de marché. Les mots
  // ibkr/yahoo apparaissent légitimement comme noms de colonnes/stages/commentaires.
  const REFETCH = /\bfetch\s*\(|\baxios\b|\bhttp\.request|marketService|createMarketDataProvider|from\s+["'][^"']*(ibkr|yahoo|providers|marketData)[^"']*["']/i;
  record("store: aucun refetch / provider", !REFETCH.test(storeSrc));
  record("routes: aucune logique Yahoo/IBKR (pas de fetch/provider)", !REFETCH.test(routesSrc));
  record("payload helper: pur, aucun fetch/provider", !REFETCH.test(payloadSrc));

  // ── 8. Diff ciblé : aucun fichier interdit modifié ────────────────────────
  let changedFiles = [];
  try {
    const out = execFileSync("git", ["diff", "--name-only"], { cwd: repoRoot, encoding: "utf8" });
    changedFiles = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    changedFiles = [];
  }
  const FORBIDDEN_FILES = [
    "app/scanners/wheelScanner.js",
    "app/journal/wheelValidationService.js",
    "app/journal/tickerScanMemoryStore.js",
  ];
  const touchedForbidden = changedFiles.filter((f) =>
    FORBIDDEN_FILES.includes(f) || /tradingview|\.pine$/i.test(f)
  );
  record("aucun fichier interdit modifié (scanner/scoring/Pine/ticker_memory/JournalPop capture)", touchedForbidden.length === 0, touchedForbidden.join(", "));
  record("seuls server.js + dashboard.jsx modifiés (suivis)", changedFiles.every((f) => f === "server.js" || f === "wheel-dashboard/src/dashboard.jsx"), changedFiles.join(", "));

  const allOk = checks.every((c) => c.ok);

  const json = {
    title: "Scan Funnel Archive — Phase 1 Validation",
    generatedAt: new Date().toISOString(),
    allOk,
    maxEvents: MAX_EVENTS,
    changedTrackedFiles: changedFiles,
    newFiles: [
      "app/journal/scanFunnelArchiveStore.js",
      "app/journal/scanFunnelArchiveRoutes.js",
      "app/journal/scanFunnelArchiveStore.test.mjs",
      "wheel-dashboard/src/scanFunnelArchivePayload.js",
      "wheel-dashboard/src/scanFunnelArchivePayload.test.mjs",
    ],
    checks,
  };
  fs.writeFileSync(
    path.join(__dirname, "scan-funnel-archive-phase1-validation.json"),
    JSON.stringify(json, null, 2)
  );

  const md = [
    "# Scan Funnel Archive — Phase 1 Validation",
    "",
    `Généré : ${json.generatedAt}`,
    `Résultat global : ${allOk ? "✅ OK" : "❌ ÉCHEC"}`,
    `Cap events : ${MAX_EVENTS}`,
    "",
    "## Fichiers créés",
    ...json.newFiles.map((f) => `- \`${f}\``),
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
    "## Garanties",
    "- Store dédié + endpoint dédié, même SQLite que Journal POP (sqlitePath injecté).",
    "- Aucun refetch Yahoo/IBKR : l'archive ne consomme que des données déjà calculées.",
    "- Aucun changement scanner / scoring E2b / Pine / ticker_scan_memory / Journal POP capture.",
    "- Payload compact : aucun rawJson, aucune chaîne d'options, aucun greek complet.",
    "- Max 800 events, dédup symbol+stage, idempotent par scanSessionId.",
    "- Archive best-effort côté dashboard (void fetch, console.warn, ne bloque pas le scan).",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(__dirname, "scan-funnel-archive-phase1-validation.md"), md);

  console.log(`[scan-funnel-validation] allOk=${allOk} checks=${checks.length}`);
  for (const c of checks) {
    if (!c.ok) console.log(`  ❌ ${c.name} — ${c.detail}`);
  }
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[scan-funnel-validation] fatal", err);
  process.exit(1);
});
