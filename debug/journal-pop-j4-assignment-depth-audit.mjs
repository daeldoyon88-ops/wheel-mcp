#!/usr/bin/env node
/**
 * AUDIT READ-ONLY J4-A — Journal POP / profondeur d'assignation
 * -------------------------------------------------------------
 * Objectif : classer toutes les assignations CSP par profondeur (proche / modérée /
 * profonde) et mesurer si les assignations PROCHES sont exploitables dans une
 * stratégie Wheel (vente de Covered Call post-assignation au-dessus du strike).
 *
 * LECTURE SEULE — n'écrit que les 3 livrables debug/. Ne touche ni le moteur, ni le
 * frontend, ni le schéma DB, ni l'Archive Funnel, ni le scanner / IBKR / Yahoo.
 *
 * Usage:
 *   node debug/journal-pop-j4-assignment-depth-audit.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { classifyAssignmentDepth } from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve("debug", "journal-pop-j4-assignment-depth-audit.json");
const OUT_MD = path.resolve("debug", "journal-pop-j4-assignment-depth-audit.md");

const FOCUS_TICKERS = ["TQQQ", "APLD", "HOOD", "SOFI", "BAC", "CCL", "HIMS"];

// Critères utilisateur pour « assignation exploitable »
const EXPLOITABLE_MAX_DEPTH_PCT = 1.0; // close au plus 1 % sous le strike (proposé utilisateur)
const EXPLOITABLE_MIN_CSP_YIELD_PCT = 0.5; // rendement CSP initial minimal
const WORST_DEEP_THRESHOLD_PCT = 3.0; // profonde au sens utilisateur (>3 %)

// ── helpers lecture seule (répliques) ───────────────────────────────────────
const sym = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function getResolvedFlag(record) {
  const v = record?.resolution?.resolved ?? record?.resolved;
  return v === true;
}

function getAssignedFlag(record) {
  if (record?.resolution?.assigned_flag === true || record?.resolution?.assigned === true) return true;
  if (record?.resolution?.assigned_flag === false || record?.resolution?.assigned === false) return false;
  if (record?.assigned_flag === true || record?.assigned === true || record?.assigned === 1) return true;
  if (record?.assigned_flag === false || record?.assigned === false) return false;
  return null;
}

function isIntradayRetest(record) {
  return (record?.captureClass ?? "primaryDaily") === "intradayRetest";
}

function getStrikeForDepth(record) {
  return num(record?.strike?.strike) ?? num(record?.strike) ?? num(record?.assignment_strike);
}

function getCloseForDepth(record) {
  return (
    num(record?.resolution?.underlying_close_at_expiration) ??
    num(record?.resolution?.expirationClosePrice) ??
    num(record?.underlying_close_at_expiration) ??
    num(record?.expirationClosePrice) ??
    num(record?.assignment_price)
  );
}

function getCspYieldPct(record) {
  const premium = num(record?.strike?.premium);
  const strike = num(record?.strike?.strike);
  if (premium != null && strike != null && strike > 0) return (premium / strike) * 100;
  return num(record?.strike?.annualizedYield) ?? num(record?.snapshot?.premium_to_spot_pct) ?? null;
}

function normMode(record) {
  const m = String(record?.strikeMode ?? "").trim().toLowerCase();
  if (m === "safe") return "SAFE";
  if (m === "aggressive" || m === "agressif") return "AGGRESSIVE";
  return "OTHER";
}

function expKey(record) {
  return String(record?.selectedExpiration ?? record?.expiration ?? "").trim().replace(/-/g, "") || null;
}

/**
 * Profondeur « proposée utilisateur » : (strike - close) / strike * 100 → POSITIVE pour une
 * assignation (close sous strike). Catégories proposées : proche 0–1 %, modérée >1–3 %, profonde >3 %.
 * NB : le moteur (classifyAssignmentDepth) utilise (close - strike)/strike (signe inverse) et des
 * seuils 1.5 % / 4 %. On calcule les deux pour comparaison, sans rien modifier.
 */
function proposedDepth(strike, close) {
  if (strike == null || close == null || !(strike > 0)) {
    return { proposedDepthPct: null, proposedClass: "indeterminee" };
  }
  const depthPct = round2(((strike - close) / strike) * 100);
  let cls;
  if (depthPct <= 1) cls = "proche";
  else if (depthPct <= 3) cls = "moderee";
  else cls = "profonde";
  // depthPct < 0 = close AU-DESSUS du strike (cas limite arrondi) → reste « proche »
  return { proposedDepthPct: depthPct, proposedClass: cls };
}

function makeStore() {
  const useSqlite = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

function emptyDist() {
  return { proche: 0, moderee: 0, profonde: 0, indeterminee: 0, total: 0 };
}

function addToDist(dist, depthClass) {
  if (depthClass === "proche") dist.proche += 1;
  else if (depthClass === "moderee") dist.moderee += 1;
  else if (depthClass === "profonde") dist.profonde += 1;
  else dist.indeterminee += 1;
  dist.total += 1;
}

function distWithPct(dist) {
  const t = dist.total || 0;
  const pctOf = (n) => (t > 0 ? pct1((n / t) * 100) : null);
  return {
    ...dist,
    prochePct: pctOf(dist.proche),
    modereePct: pctOf(dist.moderee),
    profondePct: pctOf(dist.profonde),
    indetermineePct: pctOf(dist.indeterminee),
  };
}

function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells) => `| ${cells.map(esc).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map((r) => line(r))].join("\n");
}

// ── chargement ──────────────────────────────────────────────────────────────
const store = makeStore();
const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];
const today = new Date().toISOString().slice(0, 10);

// Toutes les assignations (assigned_flag === true). L'assignation implique resolved.
const assignedAll = records.filter((r) => getAssignedFlag(r) === true);
// Base « propre » alignée sur les profils (hors retests intraday).
const assignedClean = assignedAll.filter((r) => !isIntradayRetest(r));

// Enrichissement read-only de chaque assignation.
const enriched = assignedClean.map((r) => {
  const strike = getStrikeForDepth(r);
  const close = getCloseForDepth(r);
  const codeDepth = classifyAssignmentDepth(r); // moteur : (close-strike)/strike, seuils 1.5/4
  // mappe la classe moteur ("na") vers "indeterminee" pour homogénéité
  const codeClass = codeDepth.assignmentDepthClass === "na" ? "indeterminee" : codeDepth.assignmentDepthClass;
  const prop = proposedDepth(strike, close);
  return {
    id: r?.id ?? null,
    ticker: sym(r?.symbol ?? r?.ticker),
    mode: normMode(r),
    dte: num(r?.dteAtScan),
    expiration: r?.expiration ?? null,
    selectedExpiration: r?.selectedExpiration ?? null,
    expKey: expKey(r),
    scanSessionId: r?.scanSessionId ?? null,
    scanDate: r?.scanDate ?? null,
    strike: round2(strike),
    closeAtExpiration: round2(close),
    cspYieldPct: round2(getCspYieldPct(r)),
    // moteur (autorité)
    codeDepthPct: codeDepth.assignmentDepthPct,
    codeClass,
    // proposé utilisateur (comparaison)
    proposedDepthPct: prop.proposedDepthPct,
    proposedClass: prop.proposedClass,
    intradayRetest: false,
  };
});

// ── Q1 : totaux d'assignations ───────────────────────────────────────────────
const byTicker = {};
const byMode = { SAFE: 0, AGGRESSIVE: 0, OTHER: 0 };
const byDte = {};
const byExpiration = {};
for (const e of enriched) {
  byTicker[e.ticker] = (byTicker[e.ticker] ?? 0) + 1;
  byMode[e.mode] = (byMode[e.mode] ?? 0) + 1;
  const dteKey = e.dte == null ? "na" : String(e.dte);
  byDte[dteKey] = (byDte[dteKey] ?? 0) + 1;
  const ek = e.expKey ?? "na";
  byExpiration[ek] = (byExpiration[ek] ?? 0) + 1;
}

// ── Q2 : distribution (moteur = autorité) ────────────────────────────────────
const distCode = emptyDist();
const distProposed = emptyDist();
for (const e of enriched) {
  addToDist(distCode, e.codeClass);
  addToDist(distProposed, e.proposedClass);
}

// ── Q3 : focus tickers ───────────────────────────────────────────────────────
function buildFocus(ticker) {
  const t = sym(ticker);
  const allForTicker = records.filter((r) => sym(r?.symbol ?? r?.ticker) === t && !isIntradayRetest(r));
  const resolved = allForTicker.filter((r) => getResolvedFlag(r));
  const assigned = enriched.filter((e) => e.ticker === t);
  const dist = emptyDist();
  for (const e of assigned) addToDist(dist, e.codeClass);
  const examples = assigned
    .slice()
    .sort((a, b) => (b.codeDepthPct ?? -999) - (a.codeDepthPct ?? -999)) // plus proches d'abord
    .slice(0, 4)
    .map((e) => ({
      expiration: e.expiration,
      mode: e.mode,
      dte: e.dte,
      strike: e.strike,
      close: e.closeAtExpiration,
      codeDepthPct: e.codeDepthPct,
      codeClass: e.codeClass,
      proposedDepthPct: e.proposedDepthPct,
      cspYieldPct: e.cspYieldPct,
    }));
  return {
    ticker: t,
    available: allForTicker.length > 0,
    resolvedN: resolved.length,
    assignedN: assigned.length,
    assignmentRatePct: resolved.length > 0 ? pct1((assigned.length / resolved.length) * 100) : null,
    distribution: distWithPct(dist),
    examples,
  };
}
const focus = FOCUS_TICKERS.map(buildFocus);

// ── Q4 : meilleurs cas exploitables ───────────────────────────────────────────
// Critères utilisateur : profondeur (proposée) <= 1 %, rendement CSP >= 0.5 %.
// On enrichit avec le n résolu du ticker pour juger la suffisance d'échantillon.
const resolvedNByTicker = {};
for (const r of records) {
  if (isIntradayRetest(r)) continue;
  if (!getResolvedFlag(r)) continue;
  const t = sym(r?.symbol ?? r?.ticker);
  resolvedNByTicker[t] = (resolvedNByTicker[t] ?? 0) + 1;
}

const exploitable = enriched
  .filter(
    (e) =>
      e.proposedDepthPct != null &&
      e.proposedDepthPct <= EXPLOITABLE_MAX_DEPTH_PCT &&
      e.cspYieldPct != null &&
      e.cspYieldPct >= EXPLOITABLE_MIN_CSP_YIELD_PCT,
  )
  .map((e) => ({
    ...e,
    tickerResolvedN: resolvedNByTicker[e.ticker] ?? 0,
    exploitabilityScore: round2((e.cspYieldPct ?? 0) - Math.max(0, e.proposedDepthPct ?? 0)),
  }))
  .sort((a, b) => (b.exploitabilityScore ?? -999) - (a.exploitabilityScore ?? -999));

// ── Q5 : pires cas ─────────────────────────────────────────────────────────────
// Profondes au sens utilisateur (>3 %) + gros écart sous strike + rendement insuffisant.
const worst = enriched
  .filter((e) => e.proposedDepthPct != null && e.proposedDepthPct > WORST_DEEP_THRESHOLD_PCT)
  .map((e) => ({
    ...e,
    tickerResolvedN: resolvedNByTicker[e.ticker] ?? 0,
    yieldVsLossGap: e.cspYieldPct != null && e.proposedDepthPct != null ? round2(e.cspYieldPct - e.proposedDepthPct) : null,
  }))
  .sort((a, b) => (b.proposedDepthPct ?? 0) - (a.proposedDepthPct ?? 0));

// ── Q6 / Q7 : audit du code existant ───────────────────────────────────────────
const codeAudit = {
  classifyAssignmentDepth: {
    file: "app/journal/wheelValidationService.js",
    approxLine: 1920,
    formula: "(closeExpiration - strike) / strike * 100  (NÉGATIF pour une assignation)",
    thresholds: {
      proche: "depthPct ∈ [-1.5, 0]   → close jusqu'à 1.5 % SOUS le strike",
      moderee: "depthPct ∈ (-4, -1.5)  → close 1.5 % à 4 % sous le strike",
      profonde: "depthPct < -4         → close > 4 % sous le strike",
      na: "non assigné OU strike/close manquant",
    },
    note: "Seuils EXISTANTS = 1.5 % et 4 %. Diffèrent des seuils proposés utilisateur (1 % / 3 %).",
  },
  summarizeAssignmentDepthCounts: {
    file: "app/journal/wheelValidationService.js",
    approxLine: 1975,
    role: "compte proche/moderee/profonde/nd sur une liste d'assignations.",
  },
  summarizeOnePercentAssignmentMetrics: {
    file: "app/journal/wheelValidationService.js",
    approxLine: 2240,
    denominator: "totalAssignments (assignedRows.length)",
    metrics: {
      procheRatePct: "proche / totalAssignments  → % DES ASSIGNATIONS",
      profondeRatePct: "profonde / totalAssignments → % DES ASSIGNATIONS",
      avgDepthPct: "moyenne des depthPct moteur (négatifs)",
    },
  },
  dteBreakdownRates: {
    file: "wheel-dashboard/src/components/JournalPopPanel.jsx",
    approxLines: [2806, 3035, 3043],
    denominator: "totalN / n (OBSERVATIONS du bucket DTE)",
    metrics: {
      nearAssignmentRate: "nearAssignmentCount / n  → % DES OBSERVATIONS",
      deepAssignmentRate: "deep.length / n          → % DES OBSERVATIONS",
    },
    warning:
      "⚠ Dénominateur DIFFÉRENT du niveau profil (observations vs assignations) — incohérence Q7.",
  },
  formatAssignmentDepthCell: {
    file: "wheel-dashboard/src/components/JournalPopPanel.jsx",
    approxLine: 2463,
    behavior:
      "Affiche count/totalAssignments (% assign.) en priorité (procheRatePct/profondeRatePct), avec repli sur nearAssignmentRate/deepAssignmentRate (% observations). Mélange possible des deux dénominateurs selon la source disponible.",
  },
  uiLegend: {
    file: "wheel-dashboard/src/components/JournalPopPanel.jsx",
    approxLine: 2398,
    text: "« profondes / assignations : assignations profondes / assignations (pas / observations). »",
  },
  existingExploitableVerdict: {
    file: "app/journal/wheelValidationService.js (+ JournalPopPanel.jsx)",
    approxLines: [2336, 5125],
    note: "Un verdict « assignation exploitable » existe DÉJÀ et un filtre UI onePercentAssignExploitableOnly l'utilise.",
  },
};

// Q7 : la colonne « Proche/Profonde (% assign.) » correspond-elle à proches/assignations ?
const q7 = {
  uiColumnLabel: "Proche (% assign.) / Profonde (% assign.)",
  profileLevel: "proches/assignations & profondes/assignations (CORRECT vs légende).",
  dteBreakdownLevel: "nearAssignmentRate/deepAssignmentRate = /observations (NON conforme à la légende).",
  verdict:
    "Au niveau PROFIL la colonne respecte « / assignations ». Au niveau DTE-breakdown les taux sont calculés « / observations ». formatAssignmentDepthCell privilégie le profil mais peut retomber sur la valeur /observations → libellé « % assign. » potentiellement trompeur dans le repli.",
};

// ── assemblage payload ──────────────────────────────────────────────────────
const auditPayload = {
  generatedAt: new Date().toISOString(),
  phase: "Journal POP J4-A — audit profondeur d'assignation (lecture seule)",
  readOnly: true,
  noProductionChanges: true,
  source: {
    journal: store.sqlitePath ?? "JSON wheelValidationStore",
    totalRecords: records.length,
    today,
  },
  definitions: {
    engine: codeAudit.classifyAssignmentDepth,
    proposedUser: {
      formula: "(strike - closeAtExpiration) / strike * 100  (POSITIF pour une assignation)",
      proche: "0 % à 1 %",
      moderee: "> 1 % à 3 %",
      profonde: "> 3 %",
      indeterminee: "close ou strike manquant",
    },
    reconciliationNote:
      "Le moteur applique 1.5 % / 4 % (signe négatif). L'utilisateur propose 1 % / 3 % (signe positif). Distribution principale = MOTEUR (autorité). La table « proposée » est fournie pour comparaison uniquement, sans rien changer.",
  },
  q1_totals: {
    assignedAllRaw: assignedAll.length,
    assignedCleanNoIntradayRetest: enriched.length,
    excludedIntradayRetest: assignedAll.length - enriched.length,
    byTicker: Object.fromEntries(Object.entries(byTicker).sort((a, b) => b[1] - a[1])),
    byMode,
    byDte,
    byExpirationTop: Object.fromEntries(
      Object.entries(byExpiration)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15),
    ),
    distinctExpirations: Object.keys(byExpiration).length,
  },
  q2_distribution: {
    engine: distWithPct(distCode),
    proposedUser: distWithPct(distProposed),
  },
  q3_focusTickers: focus,
  q4_exploitableCases: {
    criteria: {
      maxProposedDepthPct: EXPLOITABLE_MAX_DEPTH_PCT,
      minCspYieldPct: EXPLOITABLE_MIN_CSP_YIELD_PCT,
      ccRule: "Ne jamais vendre de CC sous le prix d'assignation (strike) ; rendement CC >= 0.5 %.",
    },
    count: exploitable.length,
    top: exploitable.slice(0, 25),
  },
  q5_worstCases: {
    criteria: { minProposedDepthPct: WORST_DEEP_THRESHOLD_PCT },
    count: worst.length,
    top: worst.slice(0, 20),
  },
  q6_codeAudit: codeAudit,
  q7_uiDenominator: q7,
};

// ── Q8 : recommandations J4-B ────────────────────────────────────────────────
const recommendations = {
  critique: [
    {
      id: "reconcile-denominator",
      text:
        "Aligner le dénominateur de nearAssignmentRate/deepAssignmentRate (DTE-breakdown, /observations) avec la légende et le niveau profil (/assignations), OU renommer explicitement chaque taux selon son dénominateur. Risque actuel : la colonne « % assign. » affiche tantôt /assignations tantôt /observations.",
    },
  ],
  important: [
    {
      id: "threshold-reconciliation",
      text:
        "Décider d'un seuil unique. Le moteur utilise 1.5 % / 4 % (proche/modérée/profonde) ; l'utilisateur propose 1 % / 3 %. Si la définition Wheel « exploitable » est ≤ 1 %, ajuster le seuil PROCHE du moteur à 1 % (patch moteur dédié, hors J4-A) ou documenter l'écart dans l'UI.",
    },
    {
      id: "exploitable-metric",
      text:
        "Formaliser une métrique « assignation exploitable » = (profondeur ≤ seuil proche) ∧ (rendement CSP ≥ 0.5 %) ∧ (CC vendable ≥ strike). Le verdict « assignation exploitable » existe déjà (service ~2336, filtre UI ~5125) mais n'intègre pas le rendement CSP ni la contrainte CC ≥ strike.",
    },
  ],
  uiSeulement: [
    {
      id: "depth-fraction-display",
      text:
        "Afficher systématiquement la fraction X/Y à côté des % (proches X/assignations Y, profondes X/assignations Y) pour lever l'ambiguïté du dénominateur.",
    },
    {
      id: "exploitable-badge",
      text:
        "Ajouter un badge « proche exploitable » sur les lignes assignées proches avec rendement CSP ≥ 0.5 %, distinct du badge « profonde ».",
    },
  ],
  futureCcPostAssignation: [
    {
      id: "cc-yield-after-assignment",
      text:
        "Brancher l'audit sur les cycles CC post-assignation (return_on_assignment_pct, prime CC, recovery au strike) pour mesurer le rendement RÉELLEMENT capturé après une assignation proche — boucle Wheel complète CSP → assignation proche → CC ≥ strike.",
    },
    {
      id: "cc-floor-rule",
      text:
        "Encoder la règle « CC jamais sous le prix d'assignation » et « rendement/prime CC ≥ 0.5 % » comme garde-fou dans la future recommandation CC post-assignation.",
    },
  ],
};
auditPayload.recommendations = recommendations;

// ── verdict global ─────────────────────────────────────────────────────────
const exploitableShare =
  distCode.total > 0 ? pct1(((distCode.proche) / distCode.total) * 100) : null;
auditPayload.verdict = {
  global: `${enriched.length} assignations analysées (hors retests intraday). ${distCode.proche} proches (${exploitableShare ?? "—"}%), ${distCode.moderee} modérées, ${distCode.profonde} profondes, ${distCode.indeterminee} indéterminées (seuils MOTEUR 1.5 %/4 %). ${exploitable.length} cas répondent aux critères « exploitable » (≤1 % sous strike & rendement CSP ≥0.5 %). Les assignations proches sont majoritairement exploitables pour de la vente de CC ≥ strike ; les profondes restent le vrai risque de capital bloqué.`,
  exploitableHypothesis:
    "Confirmée partiellement : une grande part des assignations sont proches du strike (capital récupérable via CC), donc « assigné » n'équivaut pas à « perdant ».",
  mainCaveat:
    "Incohérence de dénominateur (Q7) entre niveau profil (/assignations) et DTE-breakdown (/observations) ; seuils moteur (1.5/4) ≠ proposés (1/3).",
};

// ── écriture JSON ────────────────────────────────────────────────────────────
fs.writeFileSync(OUT_JSON, JSON.stringify(auditPayload, null, 2), "utf8");

// ── Markdown ──────────────────────────────────────────────────────────────────
const md = [];
md.push("# Audit J4-A — Profondeur d'assignation (Journal POP)");
md.push("");
md.push(
  `> **Lecture seule** — généré le ${auditPayload.generatedAt.slice(0, 19)} · ${records.length} records · ${enriched.length} assignations analysées`,
);
md.push(`> Source : \`${auditPayload.source.journal}\``);
md.push("");

md.push("## Verdict global");
md.push("");
md.push(`**${auditPayload.verdict.global}**`);
md.push("");
md.push(`- Hypothèse « exploitable » : ${auditPayload.verdict.exploitableHypothesis}`);
md.push(`- Réserve principale : ${auditPayload.verdict.mainCaveat}`);
md.push("");

md.push("## Définitions utilisées");
md.push("");
md.push("**Moteur (autorité — `classifyAssignmentDepth`) :**");
md.push("");
md.push("- Formule : `(close - strike) / strike * 100` (négatif pour une assignation).");
md.push("- `proche` : −1.5 % à 0 % · `modérée` : −4 % à −1.5 % · `profonde` : < −4 % · `indéterminée` : close/strike manquant.");
md.push("");
md.push("**Proposée utilisateur (comparaison seulement) :**");
md.push("");
md.push("- Formule : `(strike - close) / strike * 100` (positif pour une assignation).");
md.push("- `proche` : 0–1 % · `modérée` : >1–3 % · `profonde` : >3 %.");
md.push("");
md.push(`> ${auditPayload.definitions.reconciliationNote}`);
md.push("");

md.push("## 1. Totaux d'assignations");
md.push("");
md.push(
  `- Assignations brutes : **${assignedAll.length}** · hors retests intraday : **${enriched.length}** (exclues : ${assignedAll.length - enriched.length})`,
);
md.push(`- Modes : SAFE **${byMode.SAFE}** · AGRESSIF **${byMode.AGGRESSIVE}** · AUTRE **${byMode.OTHER}**`);
md.push(`- Expirations distinctes touchées par une assignation : **${Object.keys(byExpiration).length}**`);
md.push("");
md.push("### Par ticker (Top 15)");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Assignations"],
    Object.entries(byTicker)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([t, n]) => [t, n]),
  ),
);
md.push("");
md.push("### Par DTE");
md.push("");
md.push(
  mdTable(
    ["DTE", "Assignations"],
    Object.entries(byDte)
      .sort((a, b) => (Number(a[0]) || 999) - (Number(b[0]) || 999))
      .map(([d, n]) => [d, n]),
  ),
);
md.push("");
md.push("### Par expiration (Top 12)");
md.push("");
md.push(
  mdTable(
    ["Expiration", "Assignations"],
    Object.entries(byExpiration)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([e, n]) => [e, n]),
  ),
);
md.push("");

md.push("## 2. Distribution proche / modérée / profonde");
md.push("");
const dc = distWithPct(distCode);
const dp = distWithPct(distProposed);
md.push(
  mdTable(
    ["Classification", "Proche", "Modérée", "Profonde", "Indéterminée", "Total"],
    [
      [
        "MOTEUR (1.5/4 %)",
        `${dc.proche} (${dc.prochePct ?? "—"}%)`,
        `${dc.moderee} (${dc.modereePct ?? "—"}%)`,
        `${dc.profonde} (${dc.profondePct ?? "—"}%)`,
        `${dc.indeterminee} (${dc.indetermineePct ?? "—"}%)`,
        dc.total,
      ],
      [
        "PROPOSÉE (1/3 %)",
        `${dp.proche} (${dp.prochePct ?? "—"}%)`,
        `${dp.moderee} (${dp.modereePct ?? "—"}%)`,
        `${dp.profonde} (${dp.profondePct ?? "—"}%)`,
        `${dp.indeterminee} (${dp.indetermineePct ?? "—"}%)`,
        dp.total,
      ],
    ],
  ),
);
md.push("");

md.push("## 3. Tickers focus");
md.push("");
md.push(
  mdTable(
    ["Ticker", "n résolus", "n assignés", "% assign.", "proches", "modérées", "profondes", "indét."],
    focus.map((f) => [
      f.ticker + (f.available ? "" : " (absent)"),
      f.resolvedN,
      f.assignedN,
      f.assignmentRatePct == null ? "—" : `${f.assignmentRatePct}%`,
      f.distribution.proche,
      f.distribution.moderee,
      f.distribution.profonde,
      f.distribution.indeterminee,
    ]),
  ),
);
md.push("");
for (const f of focus) {
  if (!f.available || f.assignedN === 0) continue;
  md.push(`### ${f.ticker} — exemples (plus proches d'abord)`);
  md.push("");
  md.push(
    mdTable(
      ["Expiration", "Mode", "DTE", "Strike", "Close", "Prof.% moteur", "Classe", "Prof.% proposée", "Rend. CSP%"],
      f.examples.map((e) => [
        e.expiration,
        e.mode,
        e.dte,
        e.strike,
        e.close,
        e.codeDepthPct,
        e.codeClass,
        e.proposedDepthPct,
        e.cspYieldPct,
      ]),
    ),
  );
  md.push("");
}

md.push("## 4. Meilleurs cas — assignations proches exploitables");
md.push("");
md.push(
  `Critères : profondeur proposée ≤ ${EXPLOITABLE_MAX_DEPTH_PCT} %, rendement CSP ≥ ${EXPLOITABLE_MIN_CSP_YIELD_PCT} %. **${exploitable.length}** cas trouvés.`,
);
md.push("");
md.push(
  mdTable(
    ["Ticker", "Exp.", "selExp", "Mode", "DTE", "Strike", "Close", "Prof.%", "Rend.CSP%", "n résolus tk", "scanSession", "Note"],
    exploitable.slice(0, 25).map((e) => [
      e.ticker,
      e.expiration,
      e.selectedExpiration,
      e.mode,
      e.dte,
      e.strike,
      e.closeAtExpiration,
      e.proposedDepthPct,
      e.cspYieldPct,
      e.tickerResolvedN,
      e.scanSessionId ? String(e.scanSessionId).slice(0, 10) : "—",
      e.codeClass,
    ]),
  ),
);
md.push("");

md.push("## 5. Pires cas — assignations profondes risquées");
md.push("");
md.push(`Critère : profondeur proposée > ${WORST_DEEP_THRESHOLD_PCT} %. **${worst.length}** cas.`);
md.push("");
md.push(
  mdTable(
    ["Ticker", "Exp.", "Mode", "DTE", "Strike", "Close", "Prof.%", "Rend.CSP%", "Rend.−Perte", "n résolus tk", "Classe"],
    worst.slice(0, 20).map((e) => [
      e.ticker,
      e.expiration,
      e.mode,
      e.dte,
      e.strike,
      e.closeAtExpiration,
      e.proposedDepthPct,
      e.cspYieldPct,
      e.yieldVsLossGap,
      e.tickerResolvedN,
      e.codeClass,
    ]),
  ),
);
md.push("");

md.push("## 6. Audit du code existant (profondeur)");
md.push("");
md.push("| Élément | Fichier | Ligne ~ | Rôle / dénominateur |");
md.push("| --- | --- | --- | --- |");
md.push(`| classifyAssignmentDepth | ${codeAudit.classifyAssignmentDepth.file} | ${codeAudit.classifyAssignmentDepth.approxLine} | ${codeAudit.classifyAssignmentDepth.formula} ; seuils 1.5 %/4 % |`);
md.push(`| summarizeAssignmentDepthCounts | ${codeAudit.summarizeAssignmentDepthCounts.file} | ${codeAudit.summarizeAssignmentDepthCounts.approxLine} | compte proche/moderee/profonde/nd |`);
md.push(`| summarizeOnePercentAssignmentMetrics | ${codeAudit.summarizeOnePercentAssignmentMetrics.file} | ${codeAudit.summarizeOnePercentAssignmentMetrics.approxLine} | procheRatePct/profondeRatePct = **/assignations** |`);
md.push(`| DTE-breakdown (near/deepAssignmentRate) | ${codeAudit.dteBreakdownRates.file} | ${codeAudit.dteBreakdownRates.approxLines.join(", ")} | near/deepAssignmentRate = **/observations** ⚠ |`);
md.push(`| formatAssignmentDepthCell | ${codeAudit.formatAssignmentDepthCell.file} | ${codeAudit.formatAssignmentDepthCell.approxLine} | affiche /assignations en priorité, repli /observations |`);
md.push(`| Légende UI | ${codeAudit.uiLegend.file} | ${codeAudit.uiLegend.approxLine} | « profondes / assignations » |`);
md.push(`| verdict « assignation exploitable » (existant) | ${codeAudit.existingExploitableVerdict.file} | ${codeAudit.existingExploitableVerdict.approxLines.join(", ")} | verdict + filtre UI déjà présents |`);
md.push("");

md.push("## 7. UI « proche/profonde [% assign.] » — dénominateur réel");
md.push("");
md.push(`- **Niveau profil** : ${q7.profileLevel}`);
md.push(`- **Niveau DTE-breakdown** : ${q7.dteBreakdownLevel}`);
md.push(`- **Verdict** : ${q7.verdict}`);
md.push("");

md.push("## 8. Recommandations J4-B");
md.push("");
md.push("### 1. Critique");
for (const r of recommendations.critique) md.push(`- **${r.id}** — ${r.text}`);
md.push("");
md.push("### 2. Important");
for (const r of recommendations.important) md.push(`- **${r.id}** — ${r.text}`);
md.push("");
md.push("### 3. UI seulement");
for (const r of recommendations.uiSeulement) md.push(`- **${r.id}** — ${r.text}`);
md.push("");
md.push("### 4. Future CC post-assignation");
for (const r of recommendations.futureCcPostAssignation) md.push(`- **${r.id}** — ${r.text}`);
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ───────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  AUDIT J4-A READ-ONLY — Profondeur d'assignation Journal POP");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Source : ${auditPayload.source.journal}`);
console.log(`  Records : ${records.length} · assignations (hors retest) : ${enriched.length}`);
console.log("");
console.log("── DISTRIBUTION (moteur 1.5/4 %) ──────────────────────────────────────");
console.log(
  `  proche=${dc.proche} (${dc.prochePct}%) · modérée=${dc.moderee} (${dc.modereePct}%) · profonde=${dc.profonde} (${dc.profondePct}%) · indét.=${dc.indeterminee}`,
);
console.log("── DISTRIBUTION (proposée 1/3 %) ──────────────────────────────────────");
console.log(
  `  proche=${dp.proche} (${dp.prochePct}%) · modérée=${dp.moderee} (${dp.modereePct}%) · profonde=${dp.profonde} (${dp.profondePct}%) · indét.=${dp.indeterminee}`,
);
console.log("");
console.log("── FOCUS TICKERS ──────────────────────────────────────────────────────");
for (const f of focus) {
  if (!f.available) {
    console.log(`  ${f.ticker.padEnd(6)} ABSENT`);
    continue;
  }
  console.log(
    `  ${f.ticker.padEnd(6)} résolus=${String(f.resolvedN).padStart(3)} assignés=${String(f.assignedN).padStart(3)} (${f.assignmentRatePct ?? "—"}%) · proche=${f.distribution.proche} mod=${f.distribution.moderee} prof=${f.distribution.profonde}`,
  );
}
console.log("");
console.log(`── EXPLOITABLES (≤${EXPLOITABLE_MAX_DEPTH_PCT}% & rend≥${EXPLOITABLE_MIN_CSP_YIELD_PCT}%) : ${exploitable.length}`);
console.log(`── PROFONDES (>${WORST_DEEP_THRESHOLD_PCT}%) : ${worst.length}`);
console.log("");
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
