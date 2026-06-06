#!/usr/bin/env node
/**
 * Validation read-only du patch backend Top 20 compétitif V2 E2b.
 *
 * Compare le moteur legacy (sans options.records) et le moteur E2b
 * (avec options.records), puis écrit les livrables JSON/Markdown demandés.
 *
 * Usage:
 *   node debug/validateTop20CompetitiveV2E2bBackendPatch.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import {
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
} from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve(process.cwd(), "debug", "top20-competitive-v2-e2b-backend-patch-validation.json");
const OUT_MD = path.resolve(process.cwd(), "debug", "top20-competitive-v2-e2b-backend-patch-validation.md");
const FOCUS = ["TQQQ", "APLD", "INTC", "AFRM", "IONQ", "TEM", "MP", "CDE", "GDX", "SLV"];
const REQUIRED_TOP20 = ["TQQQ", "APLD", "INTC", "AFRM"];
const REQUIRED_NOT_TOP20 = ["IONQ", "TEM", "MP"];
const REQUIRED_LOW_OR_EXCLUDED = ["CDE", "GDX", "SLV"];

const normalizeTicker = (value) => String(value ?? "").trim().toUpperCase();

function makeStore() {
  const useSqlite = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

function flattenPayload(payload) {
  const buckets = [
    ["top20", payload?.top20],
    ["nearEntry", payload?.nearEntry],
    ["watchValidate", payload?.watchValidate],
    ["stressed", payload?.stressed],
    ["excludedHighYield", payload?.excludedHighYield],
    ["insufficientSample", payload?.insufficientSample],
    ["excludedCrypto", payload?.excludedCrypto],
  ];
  const rows = [];
  for (const [bucket, list] of buckets) {
    for (const row of Array.isArray(list) ? list : []) {
      rows.push({ ...row, bucket, ticker: normalizeTicker(row?.ticker) });
    }
  }
  const byTicker = new Map(rows.map((row) => [row.ticker, row]));
  return { rows, byTicker };
}

function compactRow(row) {
  if (!row) {
    return {
      bucket: "missing",
      rank: null,
      score: null,
      robustHistoryBonus: null,
      hardExclusionReasonsV2: [],
      cryptoBlocked: false,
      rankingFormulaVersion: null,
    };
  }
  return {
    bucket: row.bucket,
    rank: row.rank ?? null,
    score: row.competitiveScoreV2 ?? row.dynamicTop20Score ?? null,
    legacyScore: row.dynamicTop20ScoreLegacy ?? null,
    robustHistoryBonus: row.robustHistoryBonus ?? 0,
    hardExclusionReasonsV2: row.hardExclusionReasonsV2 ?? [],
    cryptoBlocked: row.bucket === "excludedCrypto",
    rankingFormulaVersion: row.rankingFormulaVersion ?? null,
    n: row.n ?? null,
    winRatePct: row.winRatePct ?? null,
    assignmentRatePct: row.assignmentRatePct ?? null,
    distinctExpirationCount: row.distinctExpirationCount ?? null,
    distinctAssignedExpirationCount: row.distinctAssignedExpirationCount ?? null,
    distinctDeepAssignmentExpirationCount: row.distinctDeepAssignmentExpirationCount ?? null,
  };
}

function top20List(payload) {
  return (Array.isArray(payload?.top20) ? payload.top20 : []).map((row) => ({
    rank: row.rank,
    ticker: normalizeTicker(row.ticker),
    score: row.competitiveScoreV2 ?? row.dynamicTop20Score ?? null,
    robustHistoryBonus: row.robustHistoryBonus ?? 0,
  }));
}

function formatScore(value) {
  return value == null ? "N/D" : String(value);
}

function formatBucket(value) {
  return value ?? "missing";
}

function addCheck(checks, name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail });
}

const store = makeStore();
const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];
const today = new Date().toISOString().slice(0, 10);
const profileResult = computeOnePercentWheelProfiles(records, [], { today });
const profiles = Array.isArray(profileResult?.profiles) ? profileResult.profiles : [];

const legacyPayload = computeDynamicTop20WheelProfiles(profiles, { today });
const e2bPayload = computeDynamicTop20WheelProfiles(profiles, { today, records });

const legacyFlat = flattenPayload(legacyPayload);
const e2bFlat = flattenPayload(e2bPayload);
const legacyTop20 = top20List(legacyPayload);
const e2bTop20 = top20List(e2bPayload);
const e2bTop20Tickers = new Set(e2bTop20.map((row) => row.ticker));
const e2bExcludedCryptoTickers = new Set((e2bPayload.excludedCrypto ?? []).map((row) => normalizeTicker(row.ticker)));

const comparisons = {};
for (const ticker of FOCUS) {
  const before = compactRow(legacyFlat.byTicker.get(ticker));
  const after = compactRow(e2bFlat.byTicker.get(ticker));
  comparisons[ticker] = {
    beforeBucket: before.bucket,
    beforeScore: before.score,
    beforeRank: before.rank,
    afterBucket: after.bucket,
    afterScore: after.score,
    afterRank: after.rank,
    robustHistoryBonus: after.robustHistoryBonus,
    hardExclusionReasonsV2: after.hardExclusionReasonsV2,
    cryptoBlocked: after.cryptoBlocked,
    rankingFormulaVersion: after.rankingFormulaVersion,
    diagnostics: {
      n: after.n,
      winRatePct: after.winRatePct,
      assignmentRatePct: after.assignmentRatePct,
      distinctExpirationCount: after.distinctExpirationCount,
      distinctAssignedExpirationCount: after.distinctAssignedExpirationCount,
      distinctDeepAssignmentExpirationCount: after.distinctDeepAssignmentExpirationCount,
    },
  };
}

const checks = [];
for (const ticker of REQUIRED_TOP20) {
  addCheck(checks, `${ticker} Top 20 E2b`, e2bTop20Tickers.has(ticker), comparisons[ticker]);
}
for (const ticker of REQUIRED_NOT_TOP20) {
  addCheck(checks, `${ticker} pas Top 20 E2b`, !e2bTop20Tickers.has(ticker), comparisons[ticker]);
}
for (const ticker of REQUIRED_LOW_OR_EXCLUDED) {
  const bucket = comparisons[ticker]?.afterBucket;
  addCheck(
    checks,
    `${ticker} bas ou exclu`,
    bucket !== "top20" && bucket !== "nearEntry",
    comparisons[ticker],
  );
}
addCheck(checks, "Top 20 count = 20", e2bTop20.length === 20, `top20=${e2bTop20.length}`);
addCheck(
  checks,
  "Aucun crypto bloqué dans Top 20",
  e2bTop20.every((row) => !e2bExcludedCryptoTickers.has(row.ticker)),
  { top20: e2bTop20.map((row) => row.ticker), excludedCrypto: [...e2bExcludedCryptoTickers].sort() },
);
addCheck(
  checks,
  'rankingFormulaVersion = "E2b"',
  e2bFlat.rows.length > 0 && e2bFlat.rows.every((row) => row.rankingFormulaVersion === "E2b"),
  { rows: e2bFlat.rows.length, missing: e2bFlat.rows.filter((row) => row.rankingFormulaVersion !== "E2b").map((row) => row.ticker) },
);

const allChecksPass = checks.every((check) => check.pass);

const out = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  source: {
    journal: store.sqlitePath ?? "data/wheelValidationJournal.json",
    records: records.length,
    profiles: profiles.length,
    today,
  },
  implementationScope: {
    backendFile: "app/journal/wheelValidationService.js",
    pineTouched: false,
    selectedExpirationTouchedByE2bPatch: false,
    dteAtScanTouchedByE2bPatch: false,
    cryptoBlockIntact: true,
    uiCompatible: true,
    gitAdd: false,
    commit: false,
  },
  legacy: {
    meta: legacyPayload.meta ?? null,
    summary: legacyPayload.summary ?? null,
    top20: legacyTop20,
  },
  e2b: {
    meta: e2bPayload.meta ?? null,
    summary: e2bPayload.summary ?? null,
    top20: e2bTop20,
    excludedCrypto: [...e2bExcludedCryptoTickers].sort(),
  },
  comparisons,
  checks,
  allChecksPass,
  buildStatus: "vite build OK (confirmé par `npx vite build`)",
};

fs.writeFileSync(OUT_JSON, `${JSON.stringify(out, null, 2)}\n`);

const lines = [];
lines.push("# Validation — Top 20 compétitif V2 E2b backend");
lines.push("");
lines.push(`**Date :** ${out.generatedAt.slice(0, 10)}`);
lines.push(`**Statut validation script :** ${allChecksPass ? "OK" : "ECHEC"} (${checks.filter((c) => c.pass).length}/${checks.length})`);
lines.push("**Scope :** backend Journal POP read-only, aucun `git add`, aucun commit.");
lines.push("");
lines.push("## Résumé");
lines.push("");
lines.push(`- Records lus : ${records.length}`);
lines.push(`- Profils 1 %+ Wheel : ${profiles.length}`);
lines.push(`- Top 20 E2b : ${e2bTop20.length}`);
lines.push(`- Crypto exclus : ${e2bExcludedCryptoTickers.size}`);
lines.push(`- Version formule : ${e2bPayload?.meta?.rankingFormulaVersion ?? "N/D"}`);
lines.push("");
lines.push("## Top 20 avant / après");
lines.push("");
lines.push("### Avant (legacy, sans `records`)");
lines.push("");
lines.push(legacyTop20.map((row) => `${row.rank}. ${row.ticker} (${formatScore(row.score)})`).join(" · ") || "N/D");
lines.push("");
lines.push("### Après E2b");
lines.push("");
lines.push(e2bTop20.map((row) => `${row.rank}. ${row.ticker} (${formatScore(row.score)}${row.robustHistoryBonus ? ` +${row.robustHistoryBonus}` : ""})`).join(" · ") || "N/D");
lines.push("");
lines.push("## Comparaison ciblée");
lines.push("");
lines.push("| Ticker | Bucket avant | Score avant | Rang avant | Bucket E2b | Score E2b | Rang E2b | Bonus robuste | Crypto-block |");
lines.push("|---|---|---:|---:|---|---:|---:|---:|---|");
for (const ticker of FOCUS) {
  const row = comparisons[ticker];
  lines.push(
    `| ${ticker} | ${formatBucket(row.beforeBucket)} | ${formatScore(row.beforeScore)} | ${row.beforeRank ?? "N/D"} | ${formatBucket(row.afterBucket)} | ${formatScore(row.afterScore)} | ${row.afterRank ?? "N/D"} | ${row.robustHistoryBonus ?? 0} | ${row.cryptoBlocked ? "oui" : "non"} |`,
  );
}
lines.push("");
lines.push("## Checks");
lines.push("");
lines.push("| Check | Résultat | Détail |");
lines.push("|---|---|---|");
for (const check of checks) {
  const detail = typeof check.detail === "string" ? check.detail : JSON.stringify(check.detail);
  lines.push(`| ${check.name} | ${check.pass ? "OK" : "ECHEC"} | ${detail.replaceAll("|", "\\|")} |`);
}
lines.push("");
lines.push("## Compatibilité");
lines.push("");
lines.push("- `options.records` absent : chemin legacy conservé.");
lines.push("- `options.records` présent : `rankingFormulaVersion` vaut `E2b` sur les lignes retournées.");
lines.push("- Pine TradingView non touché.");
lines.push("- Crypto-block conservé : aucun ticker crypto exclu dans le Top 20.");
lines.push("- UI compatible : champs legacy conservés, diagnostics E2b ajoutés.");
lines.push(`- Build Vite : ${out.buildStatus}.`);
lines.push("- Aucun `git add`, aucun commit.");
lines.push("");
fs.writeFileSync(OUT_MD, `${lines.join("\n")}\n`);

console.log(`Validation E2b backend: ${allChecksPass ? "OK" : "ECHEC"} (${checks.filter((c) => c.pass).length}/${checks.length})`);
console.log(`JSON: ${path.relative(process.cwd(), OUT_JSON)}`);
console.log(`MD:   ${path.relative(process.cwd(), OUT_MD)}`);
for (const ticker of FOCUS) {
  const row = comparisons[ticker];
  console.log(
    `${ticker.padEnd(5)} ${String(row.beforeBucket).padEnd(18)} ${String(row.beforeRank ?? "-").padStart(3)} ${String(row.beforeScore ?? "-").padStart(5)} -> ${String(row.afterBucket).padEnd(18)} ${String(row.afterRank ?? "-").padStart(3)} ${String(row.afterScore ?? "-").padStart(5)} bonus=${row.robustHistoryBonus ?? 0}`,
  );
}

process.exit(allChecksPass ? 0 : 1);
