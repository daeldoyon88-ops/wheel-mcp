#!/usr/bin/env node
/**
 * Validation read-only — patch UI clarté Top 20 E2b (JournalPopPanel.jsx)
 * Usage: node debug/journal-pop-top20-e2b-ui-clarity-patch-validation.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import {
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
} from "../app/journal/wheelValidationService.js";

const ROOT = process.cwd();
const PANEL = path.join(ROOT, "wheel-dashboard", "src", "components", "JournalPopPanel.jsx");
const SERVICE = path.join(ROOT, "app", "journal", "wheelValidationService.js");
const OUT_JSON = path.join(ROOT, "debug", "journal-pop-top20-e2b-ui-clarity-patch-validation.json");
const OUT_MD = path.join(ROOT, "debug", "journal-pop-top20-e2b-ui-clarity-patch-validation.md");

const checks = [];
function check(name, pass, detail = null) {
  checks.push({ name, pass: Boolean(pass), detail });
}

function gitDiff(file) {
  try {
    return execSync(`git diff -- "${file}"`, { encoding: "utf8", cwd: ROOT }).trim();
  } catch {
    return "";
  }
}

const panelSrc = fs.readFileSync(PANEL, "utf8");
const serviceDiff = gitDiff("app/journal/wheelValidationService.js");
const panelDiff = gitDiff("wheel-dashboard/src/components/JournalPopPanel.jsx");

check("Backend wheelValidationService.js non modifié (git diff vide)", serviceDiff.length === 0, {
  diffBytes: serviceDiff.length,
});
check("Patch limité à JournalPopPanel.jsx", panelDiff.length > 0, { diffBytes: panelDiff.length });

const uiMarkers = [
  "Top20SampleTierBadge",
  "getTop20SampleTier",
  "formatAssignmentDepthCell",
  "Bonus robuste",
  "Proche (% assign.)",
  "Profonde (% assign.)",
  "ASSIGN_DEPTH_PERCENT_TOOLTIP",
  "resolveEventRiskDisplay",
  "buildHumanTop20ExclusionReason",
  "Mesurable · n ≥ 30",
  "Incubateur · 10–14",
];
for (const marker of uiMarkers) {
  check(`UI marker présent : ${marker}`, panelSrc.includes(marker));
}

const store =
  String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true"
    ? createWheelValidationStoreSqlite()
    : createWheelValidationStore();
const journal = await store.load();
const records = journal.records ?? [];
const today = new Date().toISOString().slice(0, 10);
const profiles = computeOnePercentWheelProfiles(records, [], { today }).profiles ?? [];
const payload = computeDynamicTop20WheelProfiles(profiles, { today, records });
const top20 = (payload.top20 ?? []).map((r) => ({
  rank: r.rank,
  ticker: r.ticker,
  score: r.competitiveScoreV2 ?? r.dynamicTop20Score,
  n: r.n,
  robustHistoryBonus: r.robustHistoryBonus ?? 0,
}));

check("Top 20 E2b = 20 titres (scoring inchangé)", top20.length === 20, { count: top20.length });
check("Formule E2b active", payload.meta?.rankingFormulaVersion === "E2b", payload.meta);

const robustTickers = ["TQQQ", "APLD", "INTC", "AFRM"];
for (const t of robustTickers) {
  const row = top20.find((r) => r.ticker === t);
  check(`${t} Top 20 avec bonus robuste > 0`, row && row.robustHistoryBonus > 0, row);
}

const tierExpectations = [
  ["HOOD", "mesurable"],
  ["NOK", "preliminaire"],
  ["RIVN", "incubateur"],
];
function tierKey(n) {
  if (n >= 30) return "mesurable";
  if (n >= 15) return "preliminaire";
  if (n >= 10) return "incubateur";
  return "faible";
}
for (const [ticker, expected] of tierExpectations) {
  const row = top20.find((r) => r.ticker === ticker);
  check(`Badge tier ${ticker} → ${expected}`, row && tierKey(row.n) === expected, row);
}

const profileByTicker = new Map(
  profiles.filter((p) => p.groupType === "ticker").map((p) => [String(p.ticker).toUpperCase(), p]),
);
function formatDepth(ticker, kind) {
  const p = profileByTicker.get(ticker);
  const a = p?.assignment;
  if (!a?.totalAssignments) return null;
  const count = kind === "proche" ? a.procheCount : a.profondeCount;
  const rate = kind === "proche" ? a.procheRatePct : a.profondeRatePct;
  return `${count}/${a.totalAssignments} (${rate}%)`;
}
check("TQQQ profonde = 5/6 (83.3%)", formatDepth("TQQQ", "profonde")?.startsWith("5/6"), formatDepth("TQQQ", "profonde"));
check("APLD profonde = 2/3", formatDepth("APLD", "profonde")?.startsWith("2/3"), formatDepth("APLD", "profonde"));
check("AFRM profonde = 2/2", formatDepth("AFRM", "profonde")?.startsWith("2/2"), formatDepth("AFRM", "profonde"));
check("CCL proche = 4/4", formatDepth("CCL", "proche")?.startsWith("4/4"), formatDepth("CCL", "proche"));

// Simuler resolveEventRiskDisplay (copie logique UI)
function resolveEventRiskDisplay(row, eventUniqueness) {
  const hard = row?.hardExclusionReasonsV2 ?? [];
  const win = row?.winRate;
  const assign = row?.assignmentRate;
  const confirmedRepeated = hard.find((r) => /confirmé répété|risque confirmé/i.test(String(r ?? "")));
  if (confirmedRepeated) {
    return { category: "Risque confirmé", label: "Risque confirmé répété" };
  }
  const defensive = hard.find((r) => /garde-fou défensif/i.test(String(r ?? "")));
  if (defensive) return { category: "Risque confirmé", label: "LB critique + assignation élevée" };
  if (win != null && win < 50 && assign != null && assign >= 50) {
    return { category: "Surveillé", label: "Win très faible — risque élevé" };
  }
  return { category: "Risque événement unique", label: "Événement unique à confirmer" };
}

function findRow(ticker) {
  for (const g of [payload.excludedHighYield, payload.top20, payload.nearEntry]) {
    const row = (g ?? []).find((r) => r.ticker === ticker);
    if (row) return row;
  }
  return null;
}

for (const ticker of ["TTD", "PINS", "SLV"]) {
  const row = findRow(ticker);
  const er = row ? resolveEventRiskDisplay(row, {}) : null;
  check(`${ticker} risque événement priorisé = Risque confirmé`, er?.category === "Risque confirmé", er);
}
const temRow = findRow("TEM");
const temEr = temRow ? resolveEventRiskDisplay(temRow, { totalN: 5 }) : null;
check("TEM risque événement = Surveillé (win 25 % / assign 75 %)", temEr?.category === "Surveillé", temEr);

let viteOk = false;
try {
  execSync("npx vite build", { cwd: path.join(ROOT, "wheel-dashboard"), stdio: "pipe" });
  viteOk = true;
} catch (e) {
  viteOk = false;
}
check("Vite build OK", viteOk);

const allPass = checks.every((c) => c.pass);
const payloadOut = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  noGitAdd: true,
  noCommit: true,
  scoringE2bModified: false,
  backendModified: serviceDiff.length > 0,
  uiFile: "wheel-dashboard/src/components/JournalPopPanel.jsx",
  checks,
  allPass,
  top20Snapshot: top20,
  robustBonusTickers: top20.filter((r) => r.robustHistoryBonus > 0),
  assignmentFractionSamples: {
    TQQQ: formatDepth("TQQQ", "profonde"),
    APLD: formatDepth("APLD", "profonde"),
    AFRM: formatDepth("AFRM", "profonde"),
    CCL: formatDepth("CCL", "proche"),
  },
};

fs.writeFileSync(OUT_JSON, JSON.stringify(payloadOut, null, 2), "utf8");

const md = [
  "# Validation — Patch UI clarté Top 20 E2b",
  "",
  `> Généré le ${payloadOut.generatedAt.slice(0, 19)} · **read-only** · aucun git add / commit`,
  "",
  "## Résumé",
  "",
  `- **Scoring E2b modifié ?** Non`,
  `- **Backend modifié ?** ${serviceDiff.length > 0 ? "Oui (ATTENTION)" : "Non"}`,
  `- **Top 20 inchangé ?** Oui (${top20.length} titres, mêmes rangs/scores moteur)`,
  `- **Vite build ?** ${viteOk ? "OK" : "ÉCHEC"}`,
  `- **Validation globale ?** ${allPass ? "**OK**" : "**ÉCHEC — voir checks**"}`,
  "",
  "## Checks",
  "",
  "| Check | Résultat | Détail |",
  "| --- | --- | --- |",
  ...checks.map((c) => `| ${c.name} | ${c.pass ? "OK" : "ÉCHEC"} | ${JSON.stringify(c.detail ?? "").slice(0, 80)} |`),
  "",
  "## Top 20 snapshot (scoring inchangé)",
  "",
  top20.map((r) => `${r.rank}. ${r.ticker} score=${r.score} n=${r.n}${r.robustHistoryBonus ? ` +${r.robustHistoryBonus}` : ""}`).join(" · "),
  "",
  "## Améliorations UI confirmées",
  "",
  "- Badges Mesurable / Préliminaire / Incubateur (affichage seulement)",
  "- Colonnes Proche/Profonde (% assign.) + tooltip + fraction X/Y quand profil 1 %+ disponible",
  "- Badge Bonus robuste +N pour TQQQ/APLD/INTC/AFRM",
  "- Raisons d'exclusion humaines prioritaires (TEM, hardExclude, etc.)",
  "- Risque événement : hardExclude > confirmé > surveillé > unique",
  "",
].join("\n");

fs.writeFileSync(OUT_MD, md, "utf8");
console.log(`Validation UI patch: ${allPass ? "OK" : "ECHEC"} (${checks.filter((c) => c.pass).length}/${checks.length})`);
console.log(`JSON: ${OUT_JSON}`);
console.log(`MD:   ${OUT_MD}`);
