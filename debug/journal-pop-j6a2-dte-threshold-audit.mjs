#!/usr/bin/env node
/**
 * AUDIT READ-ONLY — J6-A2 / Seuils du Top réaliste adaptés aux vues DTE
 * --------------------------------------------------------------------
 * Pour chaque horizon DTE (7 / 4 / 3), compare AVANT (seuil strict global :
 * strict ≥5 décisions, confirm 3–4 décisions UNIQUEMENT si observationResolved≥15)
 * et APRÈS (seuil « dte_confirm » adapté : 3–4 décisions réelles + garde-fous OK,
 * sans exiger observationResolved≥15). Montre combien de profils utiles remontent
 * dans le Top DTE, et le statut de IONQ / APLD / TQQQ / HOOD par horizon.
 *
 * La vue « all » (tous DTE) doit rester strictement inchangée.
 *
 * Ne modifie AUCUN fichier de production. Aucun git add / commit.
 *
 * Usage:
 *   node debug/journal-pop-j6a2-dte-threshold-audit.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import {
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
} from "../app/journal/wheelValidationService.js";

const DTE_VIEWS = [7, 4, 3];
const FOCUS_TICKERS = ["IONQ", "APLD", "TQQQ", "HOOD"];
const CONFIRM_MIN_OBS_RESOLVED = 15; // doit refléter REALISTIC_CONFIRM_MIN_OBS_RESOLVED
const OUT_JSON = path.resolve("debug", "journal-pop-j6a2-dte-threshold-audit.json");
const OUT_MD = path.resolve("debug", "journal-pop-j6a2-dte-threshold-audit.md");

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

function allRows(payload) {
  const out = [];
  for (const bucket of BUCKET_KEYS) {
    const list = Array.isArray(payload?.[bucket]) ? payload[bucket] : [];
    for (const row of list) out.push({ ...row, bucket });
  }
  return out;
}

function findRow(payload, ticker) {
  return allRows(payload).find((r) => sym(r?.ticker) === ticker) ?? null;
}

// « Aurait été admissible Top AVANT J6-A2 » : strict (≥5 décisions) OU confirm global
// (3–4 décisions ET observationResolved≥15). Le dte_confirm (obs<15) est la nouveauté.
function wasEligibleBefore(row) {
  const ra = row?.realisticActive ?? {};
  if (ra.eligibleForTop20 === true) return true;
  const obs = row?.realisticDecisionMetrics?.observationResolvedCount ?? 0;
  return ra.eligibleForTop20Confirm === true && obs >= CONFIRM_MIN_OBS_RESOLVED;
}

function compareView(payload) {
  const rows = allRows(payload);
  const top20 = rows.filter((r) => r.bucket === "top20");
  const near = rows.filter((r) => r.bucket === "nearEntry");

  // APRÈS = état réel (dte_confirm actif).
  const afterTopCount = top20.length;
  const afterNearCount = near.length;

  // Profils nouvellement promus dans le Top DTE par le seuil adapté.
  const promotedByDteConfirm = top20.filter(
    (r) =>
      r.realisticActive?.dynamicTop20RealisticBucket === "dte_confirm" &&
      (r.realisticDecisionMetrics?.observationResolvedCount ?? 0) < CONFIRM_MIN_OBS_RESOLVED,
  );

  // AVANT = nombre de profils éligibles sous l'ancien seuil strict/confirm global,
  // plafonné à 20 (les promus dte_confirm seraient retombés en « Proches d'entrer »).
  const beforeEligible = rows.filter(wasEligibleBefore);
  const beforeTopCount = Math.min(20, beforeEligible.length);
  const beforeNearCount = afterNearCount + promotedByDteConfirm.length;

  return {
    metaDteFilter: payload?.meta?.dteFilter ?? null,
    dteConfirmEnabled: payload?.meta?.guardrails?.dteConfirmEnabled ?? null,
    dteConfirmInTop20Count: payload?.meta?.guardrails?.dteConfirmInTop20Count ?? 0,
    before: { top: beforeTopCount, near: beforeNearCount },
    after: { top: afterTopCount, near: afterNearCount },
    promoted: promotedByDteConfirm.map((r) => sym(r.ticker)).sort(),
  };
}

function summarizeTicker(payload, ticker) {
  const row = findRow(payload, ticker);
  if (!row) return { found: false, bucket: "missing", bucketLabel: BUCKET_LABELS.missing };
  const rdm = row.realisticDecisionMetrics ?? {};
  const ra = row.realisticActive ?? {};
  return {
    found: true,
    bucket: row.bucket,
    bucketLabel: BUCKET_LABELS[row.bucket],
    inTop20: row.bucket === "top20",
    realisticBucket: ra.dynamicTop20RealisticBucket ?? null,
    rank: row.rank ?? null,
    score: row.dynamicTop20Score ?? null,
    selectedTradeCount: rdm.selectedTradeCount ?? null,
    observationResolvedCount: rdm.observationResolvedCount ?? null,
    realYieldPct: rdm.selectedAvgCspYieldPct ?? null,
    realAssignmentRatePct: rdm.selectedAssignmentRatePct ?? null,
    realDeepAssignmentRatePct: rdm.selectedDeepAssignmentRatePct ?? null,
    n: row.n ?? null,
    promotedByDteConfirm:
      ra.dynamicTop20RealisticBucket === "dte_confirm" &&
      (rdm.observationResolvedCount ?? 0) < CONFIRM_MIN_OBS_RESOLVED &&
      row.bucket === "top20",
    realisticEligibilityReason: ra.realisticEligibilityReason ?? null,
  };
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

const buildView = (dteFilter) =>
  computeDynamicTop20WheelProfiles(allProfiles, { today, records, dteFilter });

const viewAll = buildView(null);
const noFilter = buildView(undefined);
const allViewSameAsGlobal =
  JSON.stringify(viewAll.top20.map((r) => [r.ticker, r.dynamicTop20Score])) ===
  JSON.stringify(noFilter.top20.map((r) => [r.ticker, r.dynamicTop20Score]));
const allViewHasDteConfirm = allRows(viewAll).some(
  (r) => r.realisticActive?.dynamicTop20RealisticBucket === "dte_confirm",
);

const byDte = {};
for (const dte of DTE_VIEWS) {
  const view = buildView(dte);
  byDte[String(dte)] = {
    comparison: compareView(view),
    tickers: Object.fromEntries(FOCUS_TICKERS.map((t) => [t, summarizeTicker(view, t)])),
  };
}

const auditPayload = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  phase: "J6-A2 — seuils du Top réaliste adaptés aux vues DTE",
  focusTickers: FOCUS_TICKERS,
  source: {
    journal: store.sqlitePath ?? "JSON wheelValidationStore",
    recordsTotal: records.length,
    today,
  },
  consistency: {
    allViewMetaDteFilter: viewAll.meta?.dteFilter ?? null,
    allViewSameAsGlobal,
    allViewHasDteConfirm,
    allViewTop20Count: viewAll.top20.length,
  },
  byDte,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(auditPayload, null, 2), "utf8");

// ── Markdown ─────────────────────────────────────────────────────────────────
const md = [];
md.push("# Audit J6-A2 — Seuils du Top réaliste adaptés aux vues DTE");
md.push("");
md.push(`> Généré le ${auditPayload.generatedAt.slice(0, 19)} · ${records.length} records · source : ${auditPayload.source.journal}`);
md.push("");
md.push("## Cohérence (vue Tous DTE inchangée)");
md.push("");
md.push(`- Vue \`all\` meta.dteFilter : ${auditPayload.consistency.allViewMetaDteFilter}`);
md.push(`- Vue \`all\` == Top réaliste global (sans filtre) : ${allViewSameAsGlobal ? "oui" : "**NON**"}`);
md.push(`- Vue \`all\` contient un bucket dte_confirm : ${allViewHasDteConfirm ? "**OUI (anomalie)**" : "non"}`);
md.push(`- Top réaliste « Tous DTE » : ${viewAll.top20.length} profils`);
md.push("");

md.push("## Avant / Après par horizon DTE");
md.push("");
md.push(
  mdTable(
    ["DTE", "Top AVANT", "Top APRÈS", "Proches AVANT", "Proches APRÈS", "Promus (dte_confirm)"],
    DTE_VIEWS.map((dte) => {
      const c = byDte[String(dte)].comparison;
      return [
        `${dte} DTE`,
        c.before.top,
        c.after.top,
        c.before.near,
        c.after.near,
        c.promoted.length ? c.promoted.join(", ") : "—",
      ];
    }),
  ),
);
md.push("");

for (const ticker of FOCUS_TICKERS) {
  md.push(`## ${ticker} par horizon DTE`);
  md.push("");
  md.push(
    mdTable(
      ["DTE", "Bucket", "Top ?", "Realistic bucket", "Score", "selTrades", "Rend. réel %", "Assign. %", "Profonde %", "n", "Promu DTE ?"],
      DTE_VIEWS.map((dte) => {
        const s = byDte[String(dte)].tickers[ticker];
        return [
          `${dte} DTE`,
          s.bucketLabel,
          s.found && s.inTop20 ? "oui" : "non",
          s.realisticBucket ?? "—",
          s.score,
          s.selectedTradeCount,
          s.realYieldPct,
          s.realAssignmentRatePct,
          s.realDeepAssignmentRatePct,
          s.n,
          s.promotedByDteConfirm ? "oui" : "non",
        ];
      }),
    ),
  );
  md.push("");
}

md.push("Lecture : « AVANT » = seuil strict global (strict ≥5 décisions, confirm 3–4 décisions seulement si observations≥15). « APRÈS » = seuil DTE adapté (dte_confirm : 3–4 décisions + garde-fous qualité OK + score ≥35, plancher observationnel abaissé à n≥5 sur l'horizon, sans exiger observations≥15). Les profils dangereux (rendement <0,5 %, profondeur >50 %) ou à échantillon insuffisant (<3 décisions, n<5 obs sur l'horizon) restent exclus.");
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ──────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  AUDIT J6-A2 — Seuils du Top réaliste adaptés aux vues DTE");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Source  : ${auditPayload.source.journal}`);
console.log(`  Records : ${records.length}`);
console.log(`  Vue all == global : ${allViewSameAsGlobal ? "oui" : "NON"} · dte_confirm en all : ${allViewHasDteConfirm ? "OUI (anomalie)" : "non"}`);
console.log("");
console.log("  Avant / Après par horizon :");
for (const dte of DTE_VIEWS) {
  const c = byDte[String(dte)].comparison;
  console.log(
    `    ${dte} DTE | Top ${String(c.before.top).padStart(2)} → ${String(c.after.top).padStart(2)} | Proches ${String(c.before.near).padStart(2)} → ${String(c.after.near).padStart(2)} | promus: ${c.promoted.length ? c.promoted.join(", ") : "—"}`,
  );
}
console.log("");
for (const ticker of FOCUS_TICKERS) {
  console.log(`  ${ticker} :`);
  for (const dte of DTE_VIEWS) {
    const s = byDte[String(dte)].tickers[ticker];
    console.log(
      `    ${dte} DTE | ${s.found && s.inTop20 ? "TOP" : "   "} | ${(s.realisticBucket ?? "—").padEnd(11)} | score=${String(s.score ?? "—").padStart(5)} | selTrades=${String(s.selectedTradeCount ?? "—").padStart(3)} | rend=${String(s.realYieldPct ?? "—").padStart(5)}% | deep=${String(s.realDeepAssignmentRatePct ?? "—").padStart(5)}% | n=${String(s.n ?? "—").padStart(3)}${s.promotedByDteConfirm ? " | PROMU" : ""}`,
    );
  }
  console.log("");
}
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
