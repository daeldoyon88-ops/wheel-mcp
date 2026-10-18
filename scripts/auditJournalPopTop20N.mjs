#!/usr/bin/env node
/**
 * AUDIT READ-ONLY — Colonne "n" du Top 20 expérimental (Journal POP)
 * ------------------------------------------------------------------
 * Ne modifie RIEN : ni le dashboard, ni le moteur, ni la base.
 * Lit le même journal SQLite que le serveur (USE_SQLITE_JOURNAL=true par défaut)
 * et réutilise le VRAI moteur `computeDynamicTop20WheelProfiles` pour éviter toute dérive.
 *
 * Objectif : prouver ce que représente "n" et démontrer dans quelles conditions il augmente.
 *
 * Lancement :
 *   node scripts/auditJournalPopTop20N.mjs
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { createWheelValidationService } from "../app/journal/wheelValidationService.js";

// ──────────────────────────────────────────────────────────────────────────
// Helpers — répliques EXACTES de la logique interne du moteur (lecture seule).
// ──────────────────────────────────────────────────────────────────────────
function toBooleanOrNull(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(raw)) return true;
  if (["false", "0", "no", "n"].includes(raw)) return false;
  return null;
}

/** Identique à getResolvedFlag() du service. */
function getResolvedFlag(record) {
  return (
    (toBooleanOrNull(record?.resolution?.resolved) ??
      toBooleanOrNull(record?.resolved) ??
      false) === true
  );
}

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeYmd(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.replace(/-/g, "");
  return /^\d{8}$/.test(compact) ? compact : "";
}

/** Identique à toExpirationYmd() du service. */
function toExpirationYmd(value) {
  const compact = normalizeYmd(value);
  if (!compact) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * Réplique EXACTE de isOnePercentProfileRecord() — c'est ce prédicat qui
 * détermine quels records alimentent csp.recordsResolved (= la colonne "n").
 */
function isOnePercentProfileRecord(record, todayYmd) {
  if (!getResolvedFlag(record)) return false;
  if ((record?.captureClass ?? "primaryDaily") === "intradayRetest") return false;
  const expirationYmd = toExpirationYmd(record?.expiration ?? record?.expirationCohort);
  if (!expirationYmd || expirationYmd >= todayYmd) return false;
  return true;
}

function pad(str, len) {
  const s = String(str ?? "");
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
function padNum(n, len) {
  const s = String(n ?? "");
  return " ".repeat(Math.max(0, len - s.length)) + s;
}

// ──────────────────────────────────────────────────────────────────────────
async function main() {
  const useSqlite =
    String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  const store = useSqlite
    ? createWheelValidationStoreSqlite()
    : createWheelValidationStore();
  const service = createWheelValidationService({ store });

  const todayYmd = new Date().toISOString().slice(0, 10);

  const journal = await store.load();
  const records = Array.isArray(journal?.records) ? journal.records : [];

  // ── 1. Totaux globaux ──────────────────────────────────────────────────
  const total = records.length;
  const resolved = records.filter((r) => getResolvedFlag(r));
  const pending = records.filter((r) => !getResolvedFlag(r));

  // Sous-catégories utiles pour comprendre la dynamique de n.
  const retest = records.filter((r) => (r?.captureClass ?? "primaryDaily") === "intradayRetest");
  // Pending DÉJÀ expirés → seront résolus au prochain resolve-expired → augmenteront n.
  const pendingExpiredReadyToResolve = pending.filter((r) => {
    const exp = toExpirationYmd(r?.expiration ?? r?.expirationCohort);
    return exp && exp < todayYmd;
  });
  // Pending pas encore expirés (positions en cours).
  const pendingNotYetExpired = pending.filter((r) => {
    const exp = toExpirationYmd(r?.expiration ?? r?.expirationCohort);
    return exp && exp >= todayYmd;
  });
  // Records éligibles au calcul de n (= profileRecords du moteur).
  const profileRecords = records.filter((r) => isOnePercentProfileRecord(r, todayYmd));
  // Résolus mais EXCLUS de n (retest, ou expiration non passée) — la "perte" entre résolus et n.
  const resolvedExcludedFromN = resolved.filter((r) => !isOnePercentProfileRecord(r, todayYmd));

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  AUDIT READ-ONLY — Colonne « n » du Top 20 expérimental (Journal POP)");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  Date de référence (today)     : ${todayYmd}`);
  console.log(`  Source journal                : ${store.sqlitePath ?? "JSON (wheelValidationStore)"}`);
  console.log("");
  console.log("── 1. TOTAUX JOURNAL POP ─────────────────────────────────────────────");
  console.log(`  Total observations capturées          : ${total}`);
  console.log(`  À résoudre (resolved=false)           : ${pending.length}`);
  console.log(`      · dont déjà expirées (prêtes)     : ${pendingExpiredReadyToResolve.length}  ← augmenteront n au prochain resolve-expired`);
  console.log(`      · dont pas encore expirées        : ${pendingNotYetExpired.length}  ← positions en cours`);
  console.log(`  Résolues (resolved=true)              : ${resolved.length}`);
  console.log(`      · dont retests intraday (exclus)  : ${resolved.filter((r) => (r?.captureClass ?? "primaryDaily") === "intradayRetest").length}`);
  console.log(`  Observations retests intraday (tous) : ${retest.length}`);
  console.log("");
  console.log("── 2. DÉFINITION EXACTE DE n ─────────────────────────────────────────");
  console.log("  n (colonne Top 20) = profile.csp.recordsResolved");
  console.log("  = nombre de records, PAR TICKER (safe + aggressive confondus), tels que :");
  console.log("      (a) resolved === true                       (résolu après expiration)");
  console.log("      (b) captureClass !== 'intradayRetest'       (pas un retest intraday)");
  console.log("      (c) expiration < today                      (expiration déjà passée)");
  console.log("  → n N'EST PAS un nombre de scans, ni d'observations capturées,");
  console.log("    ni filtré par DTE/POP/yield. C'est le total résolu+expiré par ticker.");
  console.log("");
  console.log(`  Records éligibles à n (tous tickers)  : ${profileRecords.length}`);
  console.log(`  Résolus EXCLUS de n (retest/non-exp)  : ${resolvedExcludedFromN.length}`);
  console.log("");

  // ── 3. n par ticker — observations brutes (réplique du moteur) ──────────
  const nByTickerRaw = new Map();
  for (const r of profileRecords) {
    const t = normalizeSymbol(r?.symbol ?? r?.ticker);
    if (!t) continue;
    nByTickerRaw.set(t, (nByTickerRaw.get(t) ?? 0) + 1);
  }

  // ── 4. Top 20 réel via le VRAI moteur ───────────────────────────────────
  const top20Payload = await service.computeDynamicTop20WheelProfiles();
  const top20Rows = Array.isArray(top20Payload?.top20) ? top20Payload.top20 : [];

  console.log("── 3. n PAR TICKER DANS LE TOP 20 (moteur réel) ──────────────────────");
  console.log(`  ${pad("Rang", 5)}${pad("Ticker", 10)}${pad("n (Top20)", 11)}${pad("n (brut)", 10)}${pad("Statut n", 14)}Score`);
  console.log("  " + "-".repeat(64));
  for (const row of top20Rows) {
    const t = normalizeSymbol(row.ticker);
    const nRaw = nByTickerRaw.get(t) ?? 0;
    const match = nRaw === row.n ? "" : "  ⚠ écart";
    const tier = row.n >= 30 ? "mesurable" : row.n >= 15 ? "préliminaire" : "faible";
    console.log(
      `  ${pad(row.rank, 5)}${pad(t, 10)}${padNum(row.n, 9)}  ${padNum(nRaw, 8)}  ${pad(tier, 14)}${padNum(row.dynamicTop20Score, 5)}${match}`,
    );
  }
  if (top20Rows.length === 0) console.log("  (aucune ligne Top 20 — échantillon insuffisant)");
  console.log("");
  console.log(`  Seuil d'affichage : n >= 30 → « mesurable » · 15 <= n < 30 → « préliminaire »`);
  console.log(`  (cf. mapDynamicTop20ProfileRow : sampleDisplayLabel)`);
  console.log("");

  // ── 5. Différence capturé vs utilisé par le Top 20 ──────────────────────
  const top20Tickers = new Set(top20Rows.map((r) => normalizeSymbol(r.ticker)));
  let capturedForTop20Tickers = 0;
  let usedByTop20 = 0;
  for (const row of top20Rows) usedByTop20 += row.n ?? 0;
  const capturedByTicker = new Map();
  for (const r of records) {
    const t = normalizeSymbol(r?.symbol ?? r?.ticker);
    if (!t) continue;
    capturedByTicker.set(t, (capturedByTicker.get(t) ?? 0) + 1);
  }
  for (const t of top20Tickers) capturedForTop20Tickers += capturedByTicker.get(t) ?? 0;

  console.log("── 4. CAPTURÉ vs UTILISÉ PAR LE TOP 20 ───────────────────────────────");
  console.log(`  Observations capturées (tickers Top20): ${capturedForTop20Tickers}`);
  console.log(`  Somme des n utilisés par le Top 20    : ${usedByTop20}`);
  console.log(`  Écart (capturé non encore compté)     : ${capturedForTop20Tickers - usedByTop20}`);
  console.log("  → l'écart = records non résolus / non expirés / retests pour ces tickers.");
  console.log("");

  // ── 6. Tickers dont n va augmenter bientôt ──────────────────────────────
  // (a) déjà expirés non résolus → prochaine résolution. (b) expirent < 10 j.
  const soonByTicker = new Map(); // ticker -> { ready, soon }
  const horizon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
  for (const r of pending) {
    const t = normalizeSymbol(r?.symbol ?? r?.ticker);
    if (!t) continue;
    const exp = toExpirationYmd(r?.expiration ?? r?.expirationCohort);
    if (!exp) continue;
    if (!soonByTicker.has(t)) soonByTicker.set(t, { ready: 0, soon: 0 });
    if (exp < todayYmd) soonByTicker.get(t).ready += 1;
    else if (exp <= horizon) soonByTicker.get(t).soon += 1;
  }
  const soonRows = [...soonByTicker.entries()]
    .map(([t, v]) => ({ ticker: t, ready: v.ready, soon: v.soon, current: nByTickerRaw.get(t) ?? 0 }))
    .filter((r) => r.ready > 0 || r.soon > 0)
    .sort((a, b) => b.ready + b.soon - (a.ready + a.soon))
    .slice(0, 25);

  console.log("── 5. TICKERS DONT n VA AUGMENTER BIENTÔT ────────────────────────────");
  console.log(`  ${pad("Ticker", 10)}${pad("n actuel", 10)}${pad("prêts*", 9)}${pad("≤10j**", 9)}n projeté (après résolution prêts)`);
  console.log("  " + "-".repeat(64));
  for (const r of soonRows) {
    console.log(
      `  ${pad(r.ticker, 10)}${padNum(r.current, 8)}  ${padNum(r.ready, 7)}  ${padNum(r.soon, 7)}  ${padNum(r.current + r.ready, 6)}`,
    );
  }
  if (soonRows.length === 0) console.log("  (aucun record en attente de résolution)");
  console.log("");
  console.log("  * prêts  = pending déjà expirés → comptés dès le prochain resolve-expired");
  console.log("  ** ≤10j  = pending qui expirent dans 10 jours → comptés après expiration+résolution");
  console.log("");

  // ── 7. Verdict pipeline ─────────────────────────────────────────────────
  console.log("── 6. PREUVE DE LA DYNAMIQUE DE n ────────────────────────────────────");
  console.log("  Pipeline : scan live → Auto Journal POP (capture, resolved=false)");
  console.log("             → 'à résoudre' (pending) → expiration passée");
  console.log("             → POST /resolve-expired (resolved=true) → compté dans n");
  console.log("");
  console.log("  • Un NOUVEAU SCAN augmente 'à résoudre' (pending), PAS n immédiatement.");
  console.log(`    (actuellement ${pendingNotYetExpired.length} pending non expirés en file d'attente)`);
  console.log("  • n augmente UNIQUEMENT après résolution post-expiration.");
  console.log(`    (${pendingExpiredReadyToResolve.length} records déjà expirés attendent resolve-expired → +n potentiel)`);
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  Audit terminé — AUCUNE écriture effectuée (lecture seule).");
  console.log("══════════════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Erreur audit :", err?.stack || err);
  process.exit(1);
});
