#!/usr/bin/env node
/**
 * Audit décisionnel saisonnalité — affiche les 4 scores + verdict Wheel pour un ticker.
 * Usage :
 *   node scripts/auditSeasonalityDecisionHeader.mjs TQQQ
 *   node scripts/auditSeasonalityDecisionHeader.mjs APLD
 *   node scripts/auditSeasonalityDecisionHeader.mjs TQQQ --port 3001
 *
 * Requiert que le backend tourne (node server.js) ou utilise le cache SQLite local.
 */

import { buildSeasonalityDecisionHeader } from "../app/seasonality/seasonalityDecisionScores.js";

const ticker = (process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) ?? "TQQQ").trim().toUpperCase();

function resolveApiBaseUrl() {
  if (process.env.SEASONALITY_API_URL) {
    return process.env.SEASONALITY_API_URL.replace(/\/$/, "");
  }

  // --port=3001 ou --port 3001 en ligne de commande
  const portFlagEq  = process.argv.find((a) => a.startsWith("--port="))?.split("=")[1];
  const portFlagIdx = process.argv.indexOf("--port");
  const portFlagSep = portFlagIdx !== -1 ? process.argv[portFlagIdx + 1] : undefined;
  const cliPort     = portFlagEq ?? portFlagSep;

  const rawPort =
    cliPort                          ||
    process.env.SEASONALITY_API_PORT ||
    process.env.API_PORT             ||
    process.env.PORT                 ||
    "3001";

  const apiPort = Number(rawPort);
  if (!Number.isFinite(apiPort) || apiPort <= 0 || !Number.isInteger(apiPort)) {
    console.error(`\x1b[31mPort API invalide : "${rawPort}"\x1b[0m`);
    console.error("Définir SEASONALITY_API_PORT=3001 ou SEASONALITY_API_URL=http://localhost:3001");
    process.exit(1);
  }

  return `http://localhost:${apiPort}`;
}

const apiBaseUrl = resolveApiBaseUrl();
const API        = `${apiBaseUrl}/seasonality/${ticker}/bundle`;

const CONF_EMOJI = { robuste:"✅", mesurable:"🟡", préliminaire:"⚠️", faible:"❌", insuffisant:"❌" };
const RESET = "\x1b[0m", BOLD = "\x1b[1m", FAINT = "\x1b[2m", CYAN = "\x1b[36m", AMBER = "\x1b[33m";
function green(s)  { return `\x1b[32m${s}${RESET}`; }
function yellow(s) { return `\x1b[33m${s}${RESET}`; }
function red(s)    { return `\x1b[31m${s}${RESET}`; }
function scoreColor(v) { return v == null ? FAINT : v >= 65 ? "\x1b[32m" : v >= 45 ? "\x1b[33m" : "\x1b[31m"; }

function bar20(score) {
  if (score == null) return "—";
  const filled = Math.round((Math.max(0, Math.min(100, score)) / 100) * 20);
  return "█".repeat(filled) + "░".repeat(20 - filled) + ` ${score}/100`;
}

function printScore(title, result) {
  if (!result) { console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}\n  Données non disponibles`); return; }
  const c = scoreColor(result.score);
  console.log(`\n${BOLD}${CYAN}── ${title} ──${RESET}`);
  console.log(`  Score    : ${c}${bar20(result.score)}${RESET}`);
  console.log(`  Label    : ${c}${result.label}${RESET}`);
  console.log(`  Confiance: ${CONF_EMOJI[result.confidence] ?? "?"} ${result.confidence}`);
  if (result.sampleSize != null) {
    if (result.source === "calendrier") {
      console.log(`  Échantillon : ${result.sampleSize} année(s) · source calendrier`);
    } else if (result.source === "roulant") {
      console.log(`  Échantillon : ≈ ${result.yearsOfData} an(s) de données · source roulante (${result.sampleSize} fenêtres)`);
    } else {
      console.log(`  Échantillon : ${result.sampleSize}`);
    }
  }
  if (result.calendarWeek?.yearlyReturns?.length) {
    console.log(`\n  ${FAINT}Détail par année (calendrier) :${RESET}`);
    for (const r of result.calendarWeek.yearlyReturns) {
      const pct = (r.returnPct * 100).toFixed(2);
      const col = r.returnPct >= 0 ? "\x1b[32m" : "\x1b[31m";
      console.log(`  ${FAINT}${r.year}  ${r.startDate} → ${r.endDate}${RESET}  ${col}${pct >= 0 ? "+" : ""}${pct}%${RESET}`);
    }
  }
  if (result.activeWindow?.displayLabel) {
    console.log(`  Fenêtre  : ${result.activeWindow.displayLabel} [${result.activeWindow.type}]`);
    if (result.activeWindow.winRateAnnual  != null) console.log(`  Win rate annuel  : ${Math.round(result.activeWindow.winRateAnnual * 100)}%`);
    if (result.activeWindow.avgReturnAnnual != null) console.log(`  Rendement annuel : ${(result.activeWindow.avgReturnAnnual * 100).toFixed(1)}%`);
  }
  if (result.reasons?.length) {
    console.log(`\n  ${BOLD}Contributions :${RESET}`);
    for (const r of result.reasons) {
      const pts = r.contribution != null ? `${r.contribution >= 0 ? "+" : ""}${r.contribution}/${r.maxContribution ?? "?"}` : "—";
      const w = Math.round(Math.max(0, (r.contribution ?? 0) / (r.maxContribution || 1)) * 10);
      const bar10 = "█".repeat(w).padEnd(10, "░");
      console.log(`  ${FAINT}${bar10}${RESET}  ${pts.padStart(7)}  ${r.label}: ${BOLD}${r.value}${RESET}  ${FAINT}(${r.explanation})${RESET}`);
    }
  }
  if (result.warnings?.length) {
    console.log(`\n  ${AMBER}${BOLD}⚠ Warnings :${RESET}`);
    for (const w of result.warnings) console.log(`  ${AMBER}· ${w}${RESET}`);
  }
}

async function fetchBundle() {
  const res  = await fetch(API, { signal: AbortSignal.timeout(8000) });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "bundle invalide");
  return json;
}

async function main() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════╗`);
  console.log(`║  Audit Décisionnel Saisonnalité — ${ticker.padEnd(12)}     ║`);
  console.log(`╚══════════════════════════════════════════════════╝${RESET}\n`);

  let bundle = null;
  try {
    console.log(`Appel API : ${API} …`);
    bundle = await fetchBundle();
    console.log(`Cache : ${bundle.cacheMeta?.hit ? "HIT" : "FRESH"} · valide : ${bundle.cacheMeta?.validBundle ?? "?"}`);
  } catch (err) {
    console.error(`\n${red("Impossible d'appeler l'API :" + err.message)}`);
    console.error(`Vérifiez que le backend tourne sur ${apiBaseUrl} (node server.js)\n`);
    process.exit(1);
  }

  const { shortTermData, windowsData } = bundle;
  const w7j = shortTermData?.windows?.find((w) => w.days === 7) ?? null;

  if (w7j) {
    console.log(`\n${FAINT}Données brutes 7j :${RESET}`);
    console.log(`  Win rate           : ${w7j.winRate  != null ? Math.round(w7j.winRate * 100) + "%" : "—"}`);
    console.log(`  Rendement moyen    : ${w7j.avgReturn != null ? (w7j.avgReturn * 100).toFixed(2) + "%" : "—"}`);
    console.log(`  Rendement médian   : ${w7j.medianReturn != null ? (w7j.medianReturn * 100).toFixed(2) + "%" : "—"}`);
    console.log(`  Risque baisse >5%  : ${w7j.pctBelow5 != null ? Math.round(w7j.pctBelow5 * 100) + "%" : "—"}`);
    console.log(`  Risque hausse >5%  : ${w7j.pctAbove5 != null ? Math.round(w7j.pctAbove5 * 100) + "%" : "—"}`);
    console.log(`  Pire retour        : ${w7j.worstReturn != null ? (w7j.worstReturn * 100).toFixed(1) + "%" : "—"}`);
    console.log(`  Échantillon        : ${w7j.sampleSize} fenêtres`);
  } else {
    console.log(`${AMBER}Aucune donnée 7j disponible pour ce ticker.${RESET}`);
  }

  // Si le backend retourne déjà decisionHeader, on l'affiche directement
  // Sinon on le calcule localement (fallback)
  const header = bundle.decisionHeader ?? buildSeasonalityDecisionHeader({ shortTermData, windowsData });

  printScore("Score hebdo 7j",         header.weeklyScore);
  printScore("Fenêtre annuelle",        header.annualWindowScore);
  printScore("Score CSP (saisonnier)",  header.cspScore);
  printScore("Score CC  (saisonnier)",  header.ccScore);

  console.log(`\n${BOLD}${CYAN}── Verdict Wheel ──${RESET}`);
  const wv = header.wheelVerdict;
  if (wv) {
    const c = scoreColor(header.cspScore?.score);
    console.log(`  ${BOLD}${c}${wv.label}${RESET}`);
    console.log(`  ${FAINT}${wv.explanation}${RESET}`);
    console.log(`  Confiance : ${CONF_EMOJI[wv.confidence] ?? "?"} ${wv.confidence}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(`${red("Erreur fatale :" + err.message)}`);
  process.exit(1);
});
