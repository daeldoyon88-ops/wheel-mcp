#!/usr/bin/env node
/**
 * AUDIT READ-ONLY — J6-A / Filtre DTE réel du Top réaliste (Journal POP)
 * ---------------------------------------------------------------------
 * Recalcule le Top réaliste sur chaque horizon DTE (all / 7 / 4 / 3) avec les
 * mêmes données que le service Journal POP, et montre pour IONQ que le risque
 * dépend du DTE : un ticker peut être acceptable en 7 DTE mais dangereux/absent
 * en 4 ou 3 DTE.
 *
 * Ne modifie AUCUN fichier de production. Aucun git add / commit.
 *
 * Usage:
 *   node debug/journal-pop-j6a-dte-filter-audit.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import {
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
} from "../app/journal/wheelValidationService.js";

const TARGET_TICKER = "IONQ";
const DTE_VIEWS = ["all", 7, 4, 3];
const OUT_JSON = path.resolve("debug", "journal-pop-j6a-dte-filter-audit.json");
const OUT_MD = path.resolve("debug", "journal-pop-j6a-dte-filter-audit.md");

const BUCKET_KEYS = [
  "top20",
  "nearEntry",
  "watchValidate",
  "stressed",
  "excludedHighYield",
  "insufficientSample",
  "excludedCrypto",
];

const BUCKET_LABELS = {
  top20: "Top réaliste",
  nearEntry: "Proches d'entrer",
  watchValidate: "À valider",
  stressed: "Stressés",
  excludedHighYield: "À exclure malgré rendement",
  insufficientSample: "Échantillons insuffisants",
  excludedCrypto: "Exclu — crypto/digital asset",
  missing: "Absent du classement",
};

const sym = (v) => String(v ?? "").trim().toUpperCase();

function makeStore() {
  const useSqlite = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

function findRow(payload, ticker) {
  for (const bucket of BUCKET_KEYS) {
    const list = Array.isArray(payload?.[bucket]) ? payload[bucket] : [];
    const row = list.find((r) => sym(r?.ticker) === ticker);
    if (row) return { ...row, bucket };
  }
  return null;
}

function summarizeView(payload, dte, ticker) {
  const row = findRow(payload, ticker);
  const rdm = row?.realisticDecisionMetrics ?? {};
  const ra = row?.realisticActive ?? {};
  const inTop20 = row?.bucket === "top20";
  return {
    dte,
    dteLabel: dte === "all" ? "Tous DTE" : `${dte} DTE`,
    metaDteFilter: payload?.meta?.dteFilter ?? null,
    top20Count: payload?.top20?.length ?? 0,
    found: Boolean(row),
    bucket: row?.bucket ?? "missing",
    bucketLabel: BUCKET_LABELS[row?.bucket ?? "missing"],
    rank: row?.rank ?? null,
    inTop20,
    dynamicTop20Status: row?.dynamicTop20Status ?? null,
    dynamicTop20StatusLabel: row?.dynamicTop20StatusLabel ?? null,
    score: row?.dynamicTop20Score ?? null,
    scoreLegacy: row?.dynamicTop20ScoreLegacy ?? null,
    selectedTradeCount: rdm.selectedTradeCount ?? null,
    observationResolvedCount: rdm.observationResolvedCount ?? null,
    realYieldPct: rdm.selectedAvgCspYieldPct ?? null,
    realAssignmentRatePct: rdm.selectedAssignmentRatePct ?? null,
    realDeepAssignmentRatePct: rdm.selectedDeepAssignmentRatePct ?? null,
    avgCspYieldPct: row?.avgCspYieldPct ?? null,
    assignmentRate: row?.assignmentRate ?? null,
    deepAssignmentRate: row?.deepAssignmentRate ?? null,
    n: row?.n ?? null,
    eligibleForTop20: ra.eligibleForTop20 ?? null,
    realisticEligibilityReason: ra.realisticEligibilityReason ?? null,
    realisticReasonSummary: row?.realisticReasonSummary ?? null,
  };
}

function dteVerdict(s) {
  if (!s.found) return "absent (aucune observation à cet horizon)";
  if (s.inTop20) return "Top réaliste — acceptable à cet horizon";
  if (s.dynamicTop20Status === "insufficient_sample") return "échantillon insuffisant à cet horizon";
  if (s.eligibleForTop20 === false && s.realisticEligibilityReason) {
    return `hors Top réaliste — ${s.realisticEligibilityReason}`;
  }
  return `hors Top réaliste — bucket « ${s.bucketLabel} »`;
}

function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells) => `| ${cells.map(esc).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map((r) => line(r))].join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
const store = makeStore();
const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];
const today = new Date().toISOString().slice(0, 10);

const profileResult = computeOnePercentWheelProfiles(records, [], { today });
const allProfiles = profileResult.profiles ?? [];

const views = {};
for (const dte of DTE_VIEWS) {
  views[String(dte)] = computeDynamicTop20WheelProfiles(allProfiles, {
    today,
    records,
    dteFilter: dte === "all" ? null : dte,
  });
}

// Contrôle de cohérence : la vue "all" doit être identique au calcul sans filtre.
const noFilter = computeDynamicTop20WheelProfiles(allProfiles, { today, records });
const allViewSameAsGlobal =
  JSON.stringify(views.all.top20.map((r) => [r.ticker, r.dynamicTop20Score])) ===
  JSON.stringify(noFilter.top20.map((r) => [r.ticker, r.dynamicTop20Score]));

const ionqByDte = DTE_VIEWS.map((dte) => summarizeView(views[String(dte)], dte, TARGET_TICKER));
for (const s of ionqByDte) s.verdict = dteVerdict(s);

// Tickers acceptables en 7 mais pas en 3 (illustration de l'effet du DTE).
const top7 = new Set(views["7"].top20.map((r) => sym(r.ticker)));
const top3 = new Set(views["3"].top20.map((r) => sym(r.ticker)));
const okIn7NotIn3 = [...top7].filter((t) => !top3.has(t)).sort();
const okIn3NotIn7 = [...top3].filter((t) => !top7.has(t)).sort();

const auditPayload = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  phase: "J6-A — filtre DTE réel du Top réaliste",
  targetTicker: TARGET_TICKER,
  source: {
    journal: store.sqlitePath ?? "JSON wheelValidationStore",
    recordsTotal: records.length,
    today,
  },
  consistency: {
    allViewMetaDteFilter: views.all.meta?.dteFilter ?? null,
    allViewSameAsGlobal,
  },
  top20CountByDte: Object.fromEntries(DTE_VIEWS.map((d) => [String(d), views[String(d)].top20.length])),
  ionqByDte,
  dteEffect: {
    acceptableIn7NotIn3: okIn7NotIn3,
    acceptableIn3NotIn7: okIn3NotIn7,
    ionqDependsOnDte:
      ionqByDte.some((s) => s.inTop20) && ionqByDte.some((s) => !s.inTop20),
  },
};

fs.writeFileSync(OUT_JSON, JSON.stringify(auditPayload, null, 2), "utf8");

// ── Markdown ─────────────────────────────────────────────────────────────────
const md = [];
md.push("# Audit J6-A — Filtre DTE réel du Top réaliste (IONQ)");
md.push("");
md.push(`> Généré le ${auditPayload.generatedAt.slice(0, 19)} · ${records.length} records · source : ${auditPayload.source.journal}`);
md.push("");
md.push("## Cohérence");
md.push("");
md.push(`- Vue \`all\` meta.dteFilter : ${auditPayload.consistency.allViewMetaDteFilter}`);
md.push(`- Vue \`all\` == Top réaliste global (sans filtre) : ${allViewSameAsGlobal ? "oui" : "**NON**"}`);
md.push(`- Top réaliste / horizon : ${DTE_VIEWS.map((d) => `${d === "all" ? "Tous" : d + " DTE"}=${views[String(d)].top20.length}`).join(" · ")}`);
md.push("");

md.push(`## ${TARGET_TICKER} par horizon DTE`);
md.push("");
md.push(
  mdTable(
    [
      "DTE",
      "Bucket",
      "Top réaliste ?",
      "Score",
      "selTrades",
      "Rend. réel %",
      "Assign. réelle %",
      "Profonde réelle %",
      "n",
      "Verdict",
    ],
    ionqByDte.map((s) => [
      s.dteLabel,
      s.bucketLabel,
      s.inTop20 ? "oui" : "non",
      s.score,
      s.selectedTradeCount,
      s.realYieldPct,
      s.realAssignmentRatePct,
      s.realDeepAssignmentRatePct,
      s.n,
      s.verdict,
    ]),
  ),
);
md.push("");

md.push("## Effet du DTE");
md.push("");
md.push(`- Le risque ${TARGET_TICKER} dépend du DTE : ${auditPayload.dteEffect.ionqDependsOnDte ? "**oui**" : "non (même statut sur tous les horizons disponibles)"}`);
md.push(`- Acceptables en 7 DTE mais PAS en 3 DTE : ${okIn7NotIn3.length ? okIn7NotIn3.join(", ") : "—"}`);
md.push(`- Acceptables en 3 DTE mais PAS en 7 DTE : ${okIn3NotIn7.length ? okIn3NotIn7.join(", ") : "—"}`);
md.push("");
md.push("Lecture : chaque vue est un recalcul complet (decisionMetrics, rendement réel, assignation réelle, score, garde-fous) sur les seules observations de l'horizon DTE. Le filtre est appliqué AVANT le scoring, pas après.");
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ──────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  AUDIT J6-A — Filtre DTE réel du Top réaliste (IONQ)");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Source  : ${auditPayload.source.journal}`);
console.log(`  Records : ${records.length}`);
console.log(`  Vue all == global : ${allViewSameAsGlobal ? "oui" : "NON"}`);
console.log("");
console.log(`  ${TARGET_TICKER} par horizon DTE :`);
for (const s of ionqByDte) {
  console.log(
    `    ${s.dteLabel.padEnd(8)} | ${s.inTop20 ? "TOP" : "   "} | score=${String(s.score ?? "—").padStart(5)} | selTrades=${String(s.selectedTradeCount ?? "—").padStart(3)} | rend=${String(s.realYieldPct ?? "—").padStart(5)}% | assign=${String(s.realAssignmentRatePct ?? "—").padStart(5)}% | n=${String(s.n ?? "—").padStart(3)} | ${s.verdict}`,
  );
}
console.log("");
console.log(`  Risque IONQ dépend du DTE : ${auditPayload.dteEffect.ionqDependsOnDte ? "OUI" : "non"}`);
console.log(`  OK en 7 DTE mais pas en 3 DTE : ${okIn7NotIn3.length ? okIn7NotIn3.join(", ") : "—"}`);
console.log("");
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
