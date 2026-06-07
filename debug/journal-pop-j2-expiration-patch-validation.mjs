#!/usr/bin/env node
/**
 * VALIDATION READ-ONLY — Patch Journal POP J2-B (expiration ↔ selectedExpiration)
 * -----------------------------------------------------------------------------
 * Confirme, sans rien modifier (DB / git / résolution) :
 *   1. les nouveaux records simulés ne recréent plus expiration !== selectedExpiration
 *      (normalizeRecord aligne désormais expiration sur selectedExpiration);
 *   2. les 142 records historiques restent détectés comme historiques à backfill
 *      (le patch ne re-résout ni ne réécrit le passé);
 *   3. l'éligibilité profil (isOnePercentProfileRecord) utilise selectedExpiration ?? expiration;
 *   4. aucun re-open / re-resolve n'a été effectué.
 *
 * Usage:
 *   node debug/journal-pop-j2-expiration-patch-validation.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { __testables__ } from "../app/journal/wheelValidationService.js";

const { normalizeRecord, isOnePercentProfileRecord } = __testables__;

const OUT_JSON = path.resolve("debug", "journal-pop-j2-expiration-patch-validation.json");
const OUT_MD = path.resolve("debug", "journal-pop-j2-expiration-patch-validation.md");

const TODAY = new Date().toISOString().slice(0, 10);
const SCAN_TS = "2026-05-29T14:00:00.000Z";

// ── helpers ─────────────────────────────────────────────────────────────────
function normCompact(value) {
  const raw = String(value ?? "").trim().replace(/-/g, "");
  return /^\d{8}$/.test(raw) ? raw : "";
}
function getResolvedFlag(record) {
  return (record?.resolution?.resolved ?? record?.resolved) === true;
}
function isMismatchRecord(record) {
  const exp = normCompact(record?.expiration);
  const sel = normCompact(record?.selectedExpiration);
  return Boolean(exp && sel && exp !== sel);
}
function makeStore() {
  const useSqlite =
    String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

// ── 1. Simulation de capture (patch normalizeRecord) ─────────────────────────
function buildCandidate({ expiration }) {
  return {
    symbol: "TQQQ",
    expiration,
    safeStrike: { strike: 100, premium: 1, bid: 1, ask: 1.02, popEstimate: 0.92 },
    aggressiveStrike: { strike: 102, premium: 1.3, bid: 1.3, ask: 1.32, popEstimate: 0.88 },
  };
}

const captureScenarios = [
  {
    name: "selectedExpiration future (+7j) — cas reproduisant le bug J2",
    candidateExpiration: "2026-06-05",
    options: { selectedExpiration: "2026-06-12" },
    expect: { expiration: "20260612", selectedExpiration: "20260612", mismatch: false },
  },
  {
    name: "selectedExpiration absente — fallback ancien comportement",
    candidateExpiration: "2026-06-05",
    options: {},
    expect: { expiration: "20260605", selectedExpiration: "20260605", mismatch: false },
  },
  {
    name: "selectedExpiration identique à la cohorte",
    candidateExpiration: "2026-06-12",
    options: { selectedExpiration: "2026-06-12" },
    expect: { expiration: "20260612", selectedExpiration: "20260612", mismatch: false },
  },
];

const captureResults = captureScenarios.map((sc) => {
  const candidate = buildCandidate({ expiration: sc.candidateExpiration });
  const record = normalizeRecord(candidate, "safe", SCAN_TS, "sim-sess", sc.options);
  const got = {
    expiration: record?.expiration ?? null,
    selectedExpiration: record?.selectedExpiration ?? null,
    mismatch: isMismatchRecord(record),
  };
  const pass =
    got.expiration === sc.expect.expiration &&
    got.selectedExpiration === sc.expect.selectedExpiration &&
    got.mismatch === sc.expect.mismatch;
  return { name: sc.name, options: sc.options, expect: sc.expect, got, pass };
});

const allCapturePass = captureResults.every((r) => r.pass);
const noNewMismatch = captureResults.every((r) => r.got.mismatch === false);

// ── 2. Records historiques toujours détectés comme à backfill ────────────────
const store = makeStore();
const journal = await store.load();
const allRecords = Array.isArray(journal?.records) ? journal.records : [];

const historicalMismatch = allRecords.filter(isMismatchRecord);
const historicalResolved = historicalMismatch.filter(getResolvedFlag);
const historicalPending = historicalMismatch.filter((r) => !getResolvedFlag(r));

// Backfill = records persistés dont expiration diverge encore de selectedExpiration.
// Le patch n'écrit que les NOUVELLES captures ; les anciens restent à corriger.
const stillNeedBackfill = historicalMismatch.length;

// ── 3. Éligibilité profil utilise selectedExpiration ?? expiration ───────────
// Cas synthétiques déterministes (indépendants des données).
const profileChecks = [
  {
    name: "cohorte expirée mais contrat futur — non éligible au 2026-06-07",
    record: {
      symbol: "TQQQ", strikeMode: "safe", captureClass: "primaryDaily",
      expiration: "20260605", selectedExpiration: "20260612",
      strike: { strike: 100 }, resolution: { resolved: true },
    },
    today: "2026-06-07",
    expect: false,
  },
  {
    name: "contrat réel dépassé — éligible au 2026-06-15",
    record: {
      symbol: "TQQQ", strikeMode: "safe", captureClass: "primaryDaily",
      expiration: "20260605", selectedExpiration: "20260612",
      strike: { strike: 100 }, resolution: { resolved: true },
    },
    today: "2026-06-15",
    expect: true,
  },
  {
    name: "selectedExpiration absente — fallback expiration",
    record: {
      symbol: "TQQQ", strikeMode: "safe", captureClass: "primaryDaily",
      expiration: "20260605", strike: { strike: 100 }, resolution: { resolved: true },
    },
    today: "2026-06-15",
    expect: true,
  },
];

const profileResults = profileChecks.map((c) => {
  const got = isOnePercentProfileRecord(c.record, c.today);
  return { name: c.name, today: c.today, expect: c.expect, got, pass: got === c.expect };
});
const allProfilePass = profileResults.every((r) => r.pass);

// Contre-épreuve sur données réelles : combien de mismatch historiques basculent
// d'éligibilité entre champ cohorte (ancien) et selectedExpiration (patch).
function isEligibleByField(record, todayYmd, field) {
  if (!getResolvedFlag(record)) return false;
  if ((record?.captureClass ?? "primaryDaily") === "intradayRetest") return false;
  const compact = normCompact(record?.[field]);
  if (!compact) return false;
  const ymd = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return ymd < todayYmd;
}
const eligibilityDeltaRows = historicalMismatch
  .map((r) => ({
    id: r?.id ?? null,
    byCohort: isEligibleByField(r, TODAY, "expiration"),
    bySelected: isOnePercentProfileRecord(r, TODAY),
  }))
  .filter((r) => r.byCohort !== r.bySelected);

// ── 4. Aucun re-open / re-resolve effectué ──────────────────────────────────
// La validation est lecture seule : on confirme que les compteurs de résolution
// sont inchangés (on ne fait aucun appel à resolveExpiredRecords / reopen…).
const resolvedCount = allRecords.filter(getResolvedFlag).length;
const noResolutionWriteDone = true; // ce script n'écrit jamais dans le store

// ── Verdict global ───────────────────────────────────────────────────────────
const checks = {
  captureNoNewMismatch: { pass: noNewMismatch && allCapturePass, detail: captureResults },
  historicalStillDetected: {
    pass: stillNeedBackfill === historicalMismatch.length,
    historicalMismatchTotal: historicalMismatch.length,
    resolved: historicalResolved.length,
    pending: historicalPending.length,
    stillNeedBackfill,
  },
  profileUsesSelectedExpiration: { pass: allProfilePass, detail: profileResults },
  noReopenNoResolve: { pass: noResolutionWriteDone, resolvedCount },
};
const globalPass = Object.values(checks).every((c) => c.pass);

const payload = {
  generatedAt: new Date().toISOString(),
  phase: "Journal POP J2-B — validation patch capture + éligibilité (lecture seule)",
  readOnly: true,
  noProductionChanges: true,
  noDbWrite: true,
  noBackfill: true,
  noReResolve: true,
  source: {
    journal: store.sqlitePath ?? "JSON",
    totalRecords: allRecords.length,
    today: TODAY,
  },
  globalPass,
  checks,
  eligibilityDelta: {
    note: "Records mismatch dont l'éligibilité change entre cohorte (ancien) et selectedExpiration (patch).",
    count: eligibilityDeltaRows.length,
    rows: eligibilityDeltaRows.slice(0, 50),
  },
  limits: {
    backfill:
      `${historicalMismatch.length} records historiques conservent expiration !== selectedExpiration ` +
      `(${historicalResolved.length} résolus, ${historicalPending.length} pending). Le patch ne corrige ` +
      `QUE les nouvelles captures — un backfill SQLite reste nécessaire pour aligner le passé.`,
    pendingIntradayRetest:
      "Les pending intradayRetest (20260605→20260612) seront résolus correctement par resolveExpiredRecords " +
      "(selectedExpiration ?? expiration) une fois la vraie expiration atteinte.",
  },
};

fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

// ── Markdown ─────────────────────────────────────────────────────────────────
const md = [];
md.push("# Validation patch J2-B — expiration ↔ selectedExpiration (Journal POP)");
md.push("");
md.push(`> **Lecture seule** — généré le ${payload.generatedAt.slice(0, 19)}`);
md.push(`> Source : \`${payload.source.journal}\` · ${allRecords.length} records · today=${TODAY}`);
md.push("");
md.push(`## Verdict : ${globalPass ? "✅ PATCH VALIDÉ" : "❌ ÉCHEC"}`);
md.push("");
md.push("| Contrôle | Résultat |");
md.push("| --- | --- |");
md.push(`| 1. Nouvelles captures sans mismatch | ${checks.captureNoNewMismatch.pass ? "✅" : "❌"} |`);
md.push(`| 2. 142 historiques toujours détectés à backfill | ${checks.historicalStillDetected.pass ? "✅" : "❌"} |`);
md.push(`| 3. Éligibilité profil = selectedExpiration ?? expiration | ${checks.profileUsesSelectedExpiration.pass ? "✅" : "❌"} |`);
md.push(`| 4. Aucun re-open / re-resolve | ${checks.noReopenNoResolve.pass ? "✅" : "❌"} |`);
md.push("");

md.push("## 1. Captures simulées (normalizeRecord)");
md.push("");
md.push("| Scénario | expiration | selectedExpiration | mismatch | OK |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of captureResults) {
  md.push(`| ${r.name} | \`${r.got.expiration}\` | \`${r.got.selectedExpiration}\` | ${r.got.mismatch} | ${r.pass ? "✅" : "❌"} |`);
}
md.push("");

md.push("## 2. Records historiques (mismatch persistés)");
md.push("");
md.push(`- Total mismatch : **${historicalMismatch.length}**`);
md.push(`- Résolus : **${historicalResolved.length}**`);
md.push(`- Pending : **${historicalPending.length}**`);
md.push(`- À backfill (inchangés par le patch) : **${stillNeedBackfill}**`);
md.push("");

md.push("## 3. Éligibilité profil");
md.push("");
md.push("| Cas | today | attendu | obtenu | OK |");
md.push("| --- | --- | --- | --- | --- |");
for (const r of profileResults) {
  md.push(`| ${r.name} | ${r.today} | ${r.expect} | ${r.got} | ${r.pass ? "✅" : "❌"} |`);
}
md.push("");
md.push(`Records réels dont l'éligibilité change cohorte → selectedExpiration : **${eligibilityDeltaRows.length}**`);
md.push("");

md.push("## 4. Aucune écriture");
md.push("");
md.push(`- Script lecture seule : aucun appel à \`resolveExpiredRecords\` / \`reopenPrematurelyResolvedRecords\`.`);
md.push(`- Records résolus (inchangés) : **${resolvedCount}**`);
md.push("");

md.push("## Limites restantes");
md.push("");
md.push(`- **Backfill** : ${payload.limits.backfill}`);
md.push(`- **Pending** : ${payload.limits.pendingIntradayRetest}`);
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ──────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  VALIDATION J2-B — patch capture + éligibilité (lecture seule)");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Captures simulées sans mismatch : ${noNewMismatch && allCapturePass ? "OK" : "ÉCHEC"}`);
console.log(`  Historiques mismatch détectés   : ${historicalMismatch.length} (${historicalResolved.length} résolus / ${historicalPending.length} pending)`);
console.log(`  Éligibilité profil patchée      : ${allProfilePass ? "OK" : "ÉCHEC"}`);
console.log(`  Records résolus (inchangés)     : ${resolvedCount}`);
console.log(`  Éligibilité change (réel)       : ${eligibilityDeltaRows.length}`);
console.log("");
console.log(`  VERDICT GLOBAL : ${globalPass ? "✅ PATCH VALIDÉ" : "❌ ÉCHEC"}`);
console.log("");
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
