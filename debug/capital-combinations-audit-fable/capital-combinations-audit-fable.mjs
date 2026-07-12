/**
 * AUDIT INDÉPENDANT — Combinaisons de capital SAFE / BALANCED / AGGRESSIVE.
 * Harnais lecture seule (audit "fable", rafraîchi post AF-01→AF-18, 2026-07-12).
 *
 * - Importe le moteur RÉEL (wheel-dashboard/src/capitalComboPortfolio.js) sans le modifier.
 * - Construit des fixtures contrôlées au format candidat dashboard (jambes safeStrike/aggressiveStrike).
 * - Rejoue le dernier snapshot IBKR exploitable (debug/phase-a3b-result-scan-7dte-20260710.json).
 * - N'écrit RIEN dans le projet : résultats sur stdout (JSON). Code de sortie 1 si un
 *   constat de gravité CRITICAL est confirmé, 0 sinon.
 *
 * ruleVersion : assertions alignées sur AF-01…AF-18 (clôture c18b744).
 * Ne jamais « corriger » le moteur pour faire passer Fable — seulement les checks.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  gradeLeg,
  getAggressivePriorityGrade,
  getLegSpreadPct,
  normalizeOptionalPopDecimal,
  compareCapitalComboCandidatesStable,
  resolveCompatibleLegForMode,
  BALANCED_PREFERRED_LEG_YIELD_BAND,
  getLegWeeklyNormalizedYieldPct,
} from "../../wheel-dashboard/src/capitalComboPortfolio.js";
import {
  normalizeCapitalOptimizerV2Boolean,
  resolveCapitalOptimizerV2Flags,
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
} from "../../wheel-dashboard/src/capitalComboEngineV2.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/* ────────────────────────────── utilitaires ────────────────────────────── */

const checks = [];
let criticalConfirmed = 0;

function check(id, title, ok, details = {}) {
  checks.push({ id, title, status: ok ? "PASS" : "FAIL", ...details });
  if (!ok && details.severityIfFail === "CRITICAL") criticalConfirmed += 1;
  return ok;
}

function info(id, title, details = {}) {
  checks.push({ id, title, status: "INFO", ...details });
}

function deepFreeze(obj, seen = new Set()) {
  if (obj === null || typeof obj !== "object" || seen.has(obj)) return obj;
  seen.add(obj);
  for (const k of Object.keys(obj)) deepFreeze(obj[k], seen);
  return Object.freeze(obj);
}

function approx(a, b, eps = 1e-9) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
}

/** PRNG déterministe (mulberry32) pour le shuffle contrôlé. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const rnd = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function comboByLabel(combos, label) {
  return (combos || []).find((c) => c?.label === label) ?? null;
}
function pickOf(combo, ticker) {
  return (combo?.picks || []).find((p) => p.ticker === ticker) ?? null;
}
function stripDiag(combos) {
  // Comparaison déterminisme : on ignore capDiagnosticsV2 (contient des timestamps ISO).
  return (combos || []).map((c) => ({
    label: c.label,
    positions: c.positions,
    totalCapital: c.totalCapital,
    freeCapital: c.freeCapital,
    totalPremiumCollected: c.totalPremiumCollected,
    picks: (c.picks || []).map((p) => ({
      ticker: p.ticker, mode: p.mode, grade: p.grade, strike: p.strike,
      premiumUnit: p.premiumUnit, contracts: p.contracts,
      capitalUsed: p.capitalUsed, premiumCollected: p.premiumCollected,
      weeklyReturn: p.weeklyReturn, spreadPct: p.spreadPct, distancePct: p.distancePct,
      popEstimate: p.popEstimate, selectionScore: p.selectionScore,
    })),
  }));
}
function parseGradeComponent(summary) {
  const m = /grade \+(\d+)/.exec(String(summary ?? ""));
  return m ? Number(m[1]) : null;
}

/** Options moteur : flags V2 explicites (Node n'a pas localStorage, mais on fige quand même). */
const OPTS = { optimizerV2: {} };

/* ─────────────────────── fabrique de fixtures moteur ───────────────────── */
/**
 * Jambe au format dashboard consommé par le moteur :
 * getLegPremiumValue (bid→premiumUsed→mid→premium), getLegSpreadPct (liquidity.spreadPct
 * prioritaire, déjà en %), getLegYieldPct (weeklyYield/periodYield en % période),
 * getLegDistancePct, getLegPopPct (≤1 ⇒ décimal ×100), getLegExecutionBreakdown (volume/OI).
 */
function leg({ strike, bid, ask = null, spreadPct, yieldPct, distancePct, popDecimal = null, volume = 300, openInterest = 800 }) {
  return {
    strike,
    bid,
    ask,
    premiumUsed: bid,
    mid: ask != null ? (bid + ask) / 2 : bid,
    weeklyYield: yieldPct,
    distancePct,
    popProfitEstimated: popDecimal,
    // miroir du mapping réel : popEstimate initialisé à null (dashboard.jsx:3999-4001)
    popEstimate: popDecimal === undefined ? undefined : null,
    liquidity: { spreadPct },
    volume,
    openInterest,
    source: "IBKR live",
  };
}

function candidate({
  ticker, price, safe = null, agg = null,
  safeGrade = undefined, aggressiveGrade = undefined,
  finalDisplayMode = undefined, finalDisplayGrade = undefined,
  proFinalScore = 0.5, proExecutionScore = 0.8, proDistanceScore = 1,
}) {
  const c = {
    ticker,
    price,
    safeStrike: safe,
    aggressiveStrike: agg,
    weeklyReturn: safe?.weeklyYield ?? agg?.weeklyYield ?? 0,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
  };
  if (safeGrade !== undefined) c.safeGrade = safeGrade;
  if (aggressiveGrade !== undefined) c.aggressiveGrade = aggressiveGrade;
  if (finalDisplayMode !== undefined) c.finalDisplayMode = finalDisplayMode;
  if (finalDisplayGrade !== undefined) c.finalDisplayGrade = finalDisplayGrade;
  return c;
}

/* ══════════════ T1 — Scénario NFLX : provenance des métadonnées ══════════════
   Candidat classé AGGRESSIVE A par le scanner, jambe SAFE 66 / 0,46 $ / 0,697 % /
   −10,1 % / POP 93,5 / spread 4,3 %. Attendu moteur (code) :
   - combo SAFE : valeurs financières = jambe SAFE, grade = safeGrade (A),
     composante grade = +24 (poids SAFE, ligne 1459) ;
   - pick.mode = "AGGRESSIVE" (finalDisplayMode jamais remplacé au bucket,
     lignes 1588-1612 ; createPick:2196). */

const NFLX_SAFE = leg({ strike: 66, bid: 0.46, ask: 0.48, spreadPct: 4.3, yieldPct: (0.46 / 66) * 100, distancePct: -10.1, popDecimal: 0.935 });
const NFLX_AGG = leg({ strike: 68, bid: 0.82, ask: 0.85, spreadPct: 4.0, yieldPct: (0.82 / 68) * 100, distancePct: -7.4, popDecimal: 0.88 });

function makeNflx(overrides = {}) {
  return candidate({
    ticker: "NFLX", price: 73.4,
    safe: NFLX_SAFE, agg: NFLX_AGG,
    safeGrade: "A", aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A",
    ...overrides,
  });
}
const NOK_C = candidate({
  ticker: "NOK", price: 12.45,
  safe: leg({ strike: 11, bid: 0.07, ask: 0.08, spreadPct: 13.3, yieldPct: (0.07 / 11) * 100, distancePct: -11.6, popDecimal: 0.90 }),
  safeGrade: "B", finalDisplayMode: "SAFE", finalDisplayGrade: "B",
});
const SOFI_C = candidate({
  ticker: "SOFI", price: 18.8,
  safe: leg({ strike: 17, bid: 0.09, ask: 0.1, spreadPct: 10.5, yieldPct: (0.09 / 17) * 100, distancePct: -9.5, popDecimal: 0.92 }),
  safeGrade: "B", finalDisplayMode: "SAFE", finalDisplayGrade: "B",
});

{
  const pool = [makeNflx(), NOK_C, SOFI_C];
  deepFreeze(pool); // mode strict ESM : toute mutation d'entrée lèverait TypeError
  const combos = buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS);
  const safeCombo = comboByLabel(combos, "SAFE");
  const aggCombo = comboByLabel(combos, "AGGRESSIVE");
  const balCombo = comboByLabel(combos, "BALANCED");
  const p = pickOf(safeCombo, "NFLX");

  // AF-11 : bid/ask prioritaires sur liquidity.spreadPct fourni → spread = (ask−bid)/mid×100
  const nflxSpreadFromBook = ((0.48 - 0.46) / ((0.48 + 0.46) / 2)) * 100;
  check("T1a", "SAFE/NFLX : valeurs financières = jambe SAFE (strike/prime/rendement/spread bid-ask/distance/POP/capital) [AF-11]",
    !!p && p.strike === 66 && approx(p.premiumUnit, 0.46) && approx(p.weeklyReturn, (0.46 / 66) * 100, 1e-9)
    && approx(p.spreadPct, nflxSpreadFromBook) && approx(p.distancePct, -10.1) && approx(p.popEstimate, 93.5)
    && p.capitalRequired === 6600 && approx(p.premiumCollected, 46)
    && p.spreadPct > 0,
    { ruleVersion: "AF-11",
      expected: `strike 66, prime 0.46, yield 0.6970%, spread≈${nflxSpreadFromBook.toFixed(4)} (bid/ask), dist -10.1, POP 93.5, capital 6600, prime tot 46`,
      actual: p ? { strike: p.strike, premiumUnit: p.premiumUnit, weeklyReturn: p.weeklyReturn, spreadPct: p.spreadPct, distancePct: p.distancePct, popEstimate: p.popEstimate, capitalRequired: p.capitalRequired, premiumCollected: p.premiumCollected } : "pick absent",
      proof: "resolveLegSpreadDiagnostics : bid/ask prioritaires ; bucketResolvedPool SAFE→_safeLeg" });

  check("T1b", "SAFE/NFLX : pick.grade = grade de jambe SAFE (safeGrade A)",
    !!p && p.grade === "A",
    { actual: p?.grade, proof: "resolvedGrade = bucketGrade(_safeGrade) ?? finalDisplayGrade — :1586,1603" });

  check("T1c", "SAFE/NFLX : composante grade du score = +24 (poids SAFE, PAS un bonus AGGRESSIVE)",
    !!p && parseGradeComponent(p.selectionSummary) === 24,
    { actual: parseGradeComponent(p?.selectionSummary), expected: 24,
      note: "poids grade : SAFE 24 (:1459), BALANCED 22 (:1415), AGGRESSIVE 20 (:1350) — un +24 observé prouve les poids SAFE",
      proof: "buildCapitalComboScoreBreakdown:943,971-993" });

  // Défaut attendu (mécanisme) : le mode affiché reste celui du candidat principal.
  check("T1d", "DÉFAUT CONFIRMÉ — SAFE/NFLX : pick.mode hérite du candidat principal (AGGRESSIVE)",
    !!p && p.mode === "AGGRESSIVE",
    { actual: p?.mode, expected: "AGGRESSIVE (défaut reproduit) — devrait refléter la jambe utilisée (SAFE)",
      severityIfFail: null,
      proof: "finalDisplayMode absent de la liste des champs remplacés au bucket (:1588-1612) ; createPick.mode=candidate.finalDisplayMode (:2196) ; affiché tel quel dashboard.jsx:10127,10751" });

  const pa = pickOf(aggCombo, "NFLX");
  check("T1e", "AGGRESSIVE/NFLX : jambe AGGRESSIVE utilisée (68 / 0,82 / 1,206 %) et grade composante +20",
    !!pa && pa.strike === 68 && approx(pa.premiumUnit, 0.82) && approx(pa.weeklyReturn, (0.82 / 68) * 100, 1e-9)
    && parseGradeComponent(pa.selectionSummary) === 20,
    { actual: pa ? { strike: pa.strike, premiumUnit: pa.premiumUnit, weeklyReturn: pa.weeklyReturn, gradeComp: parseGradeComponent(pa.selectionSummary) } : "absent" });

  info("T1f", "BALANCED/NFLX : présence informative (safe ~0,697 près bande BALANCED ; AF-07 peut retenir SAFE)",
    { actual: pickOf(balCombo, "NFLX")
      ? { présent: true, selectedLegMode: pickOf(balCombo, "NFLX")?.selectedLegMode, strike: pickOf(balCombo, "NFLX")?.strike, fallbackUsed: pickOf(balCombo, "NFLX")?.fallbackUsed }
      : "absent",
      ruleVersion: "AF-07",
      proof: "resolveCompatibleLegForMode + bande BALANCED ; info seulement" });

  // AF-15 / AF-01 : createPick projette expiration/DTE/bid/ask/mid + modes explicites
  check("T1g", "createPick projette metadata jambe (expiration/DTE/bid/ask/mid) + selectedLegMode/bucketMode/scannerMode [AF-15/AF-01]",
    !!p
    && ("expiration" in p) && ("dte" in p) && ("bid" in p) && ("ask" in p) && ("mid" in p)
    && p.bid === 0.46 && p.ask === 0.48 && approx(p.mid, 0.47)
    && p.selectedLegMode === "SAFE" && p.bucketMode === "SAFE" && p.scannerMode === "AGGRESSIVE"
    && p.fallbackUsed === false,
    { ruleVersion: "AF-15/AF-01",
      expected: "bid/ask/mid présents ; selectedLegMode=SAFE ; bucketMode=SAFE ; scannerMode=AGGRESSIVE ; pas de valeurs inventées hors fixture",
      actual: p ? {
        hasExpiration: "expiration" in p, expiration: p.expiration, dte: p.dte,
        bid: p.bid, ask: p.ask, mid: p.mid,
        selectedLegMode: p.selectedLegMode, bucketMode: p.bucketMode, scannerMode: p.scannerMode,
        fallbackUsed: p.fallbackUsed, modeLegacy: p.mode,
      } : null,
      proof: "projectCapitalComboPickModeFields + createPick enrichi (AF-15)" });

  check("T1h", "Aucune mutation des candidats d'entrée (deep-freeze + exécution sans TypeError)",
    true, { note: "pool gelé récursivement avant l'appel ; toute écriture aurait levé en mode strict" });
}

/* ══════════════ T2 — Fallback de grade quand safeGrade est absent ══════════════
   safeGrade=null ⇒ resolvedGrade retombe sur finalDisplayGrade (grade du candidat
   principal, ici AGGRESSIVE A) alors que la jambe SAFE vaut B selon gradeLeg.
   Démonstration d'un changement de PORTEFEUILLE (maxPositions=1). */
{
  const mkP = (safeGradeVal) => candidate({
    ticker: "CRM", price: 270,
    safe: leg({ strike: 250, bid: 1.5, ask: 1.56, spreadPct: 12, yieldPct: 0.60, distancePct: -6.4, popDecimal: 0.92 }),
    agg: leg({ strike: 260, bid: 3.2, ask: 3.3, spreadPct: 8, yieldPct: 1.23, distancePct: -3.7, popDecimal: 0.85 }),
    safeGrade: safeGradeVal, aggressiveGrade: "A",
    finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A",
  });
  const Z = candidate({
    ticker: "ORCL", price: 245,
    safe: leg({ strike: 225, bid: 1.35, ask: 1.41, spreadPct: 12, yieldPct: 0.60, distancePct: -8.0, popDecimal: 0.92 }),
    safeGrade: "B", finalDisplayMode: "SAFE", finalDisplayGrade: "B",
  });
  // gradeLeg(jambe SAFE de P) = B (spread 12 > 10, ≤ 20, yield ≥ 0,5, pop ≥ 75)
  const derived = gradeLeg({ spreadPct: 12, weeklyYieldPct: 0.60, popDecimal: 0.92 });
  check("T2a", "gradeLeg(jambe SAFE de P) = B — le vrai grade de la jambe est B",
    derived === "B", { actual: derived, proof: "gradeLeg:526-538" });

  // capital 100 000 : contrats 25 000/22 500 sous le cap ticker 30 % (30 000)
  const run = (pool) => buildPortfolioCombos(pool, 100000, 100, 1, new Set(), OPTS);
  const withNull = comboByLabel(run([mkP(null), Z]), "SAFE");
  const withTrue = comboByLabel(run([mkP("B"), Z]), "SAFE");
  const tickNull = withNull?.picks?.map((p) => p.ticker).join(",");
  const tickTrue = withTrue?.picks?.map((p) => p.ticker).join(",");
  const gNull = pickOf(withNull, "CRM")?.grade ?? null;

  check("T2b", "DÉFAUT CONFIRMÉ — safeGrade absent ⇒ le bucket SAFE score la jambe avec le grade A du candidat principal (au lieu de B)",
    gNull === "A" && tickNull === "CRM",
    { actual: { safeComboPicks: tickNull, gradeCRM: gNull },
      proof: "resolvedGrade = bucketGrade ?? candidate.finalDisplayGrade (:1586) ; gradeNorm A=1 vs B=0.72 (:943) × poids 24" });

  check("T2c", "DÉMONTRÉ — le portefeuille SAFE change quand seul safeGrade (présence/absence) change : CRM ↔ ORCL",
    tickNull === "CRM" && tickTrue === "ORCL",
    { actual: { safeGradeNull: tickNull, safeGradeB: tickTrue },
      severityIfFail: null,
      note: "impact réel conditionné à l'absence de safeGrade en amont (le merge IBKR le renseigne via computeModeRecommendation, dashboard.jsx:4277) — mécanisme prouvé, occurrence live non démontrée" });
}

/* ══════════════ T3 — Tie-break _comboGradeScore = grade SOURCE ══════════════
   Deux candidats aux jambes SAFE strictement identiques (score bucket identique) ;
   seule la classification SOURCE diffère (AGGRESSIVE A vs SAFE B).
   Le tri scoredStaging (:1714-1720) départage par _comboGradeScore, calculé sur le
   grade du candidat PRINCIPAL (:1229,1252) et jamais recalculé au bucket. */
{
  const mk = (ticker, srcMode, srcGrade, withAgg) => candidate({
    ticker, price: 33,
    safe: leg({ strike: 30, bid: 0.18, ask: 0.19, spreadPct: 6, yieldPct: 0.60, distancePct: -8, popDecimal: 0.92 }),
    agg: withAgg ? leg({ strike: 31.5, bid: 0.32, ask: 0.34, spreadPct: 6, yieldPct: 1.02, distancePct: -4.5, popDecimal: 0.86 }) : null,
    safeGrade: "B", aggressiveGrade: withAgg ? "A" : undefined,
    finalDisplayMode: srcMode, finalDisplayGrade: srcGrade,
  });
  const run = (pool) => comboByLabel(buildPortfolioCombos(pool, 12000, 100, 1, new Set(), OPTS), "SAFE");
  // AAPL source AGGRESSIVE A, MSFT source SAFE B — jambes SAFE identiques
  const r1 = run([mk("AAPL", "AGGRESSIVE", "A", true), mk("MSFT", "SAFE", "B", false)]);
  const r2 = run([mk("AAPL", "SAFE", "B", false), mk("MSFT", "AGGRESSIVE", "A", true)]);
  const w1 = r1?.picks?.map((p) => p.ticker).join(",");
  const w2 = r2?.picks?.map((p) => p.ticker).join(",");
  const s1 = r1?.picks?.[0]?.selectionScore;

  // AF-04/AF-05 : grade de jambe + tie-break stable (ticker) — le grade SOURCE ne décide plus
  check("T3a", "AF-04/AF-05 — à score bucket égal, le grade SOURCE ne bascule plus le gagnant (tie-break stable → AAPL)",
    w1 === "AAPL" && w2 === "AAPL" && w1 === w2,
    { ruleVersion: "AF-04/AF-05",
      expected: "run1=AAPL et run2=AAPL (indépendant du grade/mode SOURCE)",
      actual: { run1Winner: w1, run2Winner: w2, scoreEgal: s1 },
      note: "régression si le grade scanner SOURCE redevient le tie-break n°2",
      proof: "_comboGradeScore recalculé sur grade de jambe ; compareCapitalComboCandidatesStable (ticker)" });
}

/* ══════════════ T4 — Égalité parfaite ⇒ dépendance à l'ordre d'entrée ══════════════ */
{
  const mk = (ticker) => candidate({
    ticker, price: 33,
    safe: leg({ strike: 30, bid: 0.18, ask: 0.19, spreadPct: 6, yieldPct: 0.60, distancePct: -8, popDecimal: 0.92 }),
    safeGrade: "B", finalDisplayMode: "SAFE", finalDisplayGrade: "B",
  });
  const run = (pool) => comboByLabel(buildPortfolioCombos(pool, 12000, 100, 1, new Set(), OPTS), "SAFE")
    ?.picks?.map((p) => p.ticker).join(",");
  const ab = run([mk("AAPL"), mk("MSFT")]);
  const ba = run([mk("MSFT"), mk("AAPL")]);
  // AF-05 : ordre d'entrée n'inverse plus le gagnant — départage canonique alphabétique
  check("T4a", "AF-05 — candidats ex æquo : ordre d'entrée inversé ⇒ même gagnant (AAPL, tie-break ticker)",
    ab === "AAPL" && ba === "AAPL" && ab === ba,
    { ruleVersion: "AF-05",
      expected: "ordreAB=AAPL et ordreBA=AAPL (indépendant de l'ordre d'entrée / tri UI)",
      actual: { ordreAB: ab, ordreBA: ba },
      note: "régression si le tri d'affichage ou l'index d'entrée redevient décisif",
      proof: "compareCapitalComboCandidatesStable (ticker alphabétique)" });
}

/* ══════════════ T5 — Isolation des trois modes + déterminisme ══════════════ */
{
  const pool = [makeNflx(), NOK_C, SOFI_C];
  const combos1 = buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS);
  const combos2 = buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS);
  check("T5a", "Même input ⇒ même output (2 exécutions, comparaison profonde hors diagnostics)",
    JSON.stringify(stripDiag(combos1)) === JSON.stringify(stripDiag(combos2)), {});

  const safe1 = comboByLabel(combos1, "SAFE");
  const agg1 = comboByLabel(combos1, "AGGRESSIVE");
  const shared = (safe1?.picks || []).some((p) => (agg1?.picks || []).includes(p));
  check("T5b", "Aucun objet pick partagé par référence entre SAFE et AGGRESSIVE",
    !shared, { proof: "picks/pickMap/used locaux à chaque makeCombo (:1735-1737) ; createPick crée un objet neuf (:2193)" });

  // Ordre inversé sans égalité parfaite ⇒ mêmes portefeuilles (tri complet re-trie)
  const combos3 = buildPortfolioCombos([...pool].reverse(), 25500, 100, 10, new Set(), OPTS);
  check("T5c", "Ordre d'entrée inversé (scores tous distincts) ⇒ portefeuilles identiques",
    JSON.stringify(stripDiag(combos1)) === JSON.stringify(stripDiag(combos3)), {});
}

/* ══════════════ T6 — BALANCED : AF-07 — jambe AGG hors bande n'exclut plus SAFE conforme ══════════════
   Jambe SAFE à 0,70 % (conforme bande effective BALANCED) + AGG à 2,0 % (hors max) :
   resolveCompatibleLegForMode doit retenir SAFE ; ticker INCLUS dans les deux cas. */
{
  const safeL = leg({ strike: 40, bid: 0.28, ask: 0.30, spreadPct: 8, yieldPct: 0.70, distancePct: -9, popDecimal: 0.91 });
  const aggL = leg({ strike: 43, bid: 0.86, ask: 0.90, spreadPct: 8, yieldPct: 2.0, distancePct: -3, popDecimal: 0.80 });
  const withAgg = candidate({ ticker: "CRM", price: 47.3, safe: safeL, agg: aggL, safeGrade: "A", aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A" });
  const withoutAgg = candidate({ ticker: "ORCL", price: 47.3, safe: safeL, safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" });
  const run = (pool) => comboByLabel(buildPortfolioCombos(pool, 25500, 100, 10, new Set(), OPTS), "BALANCED");
  const bal1 = run([withAgg]);
  const bal2 = run([withoutAgg]);
  const p1 = pickOf(bal1, "CRM");
  const p2 = pickOf(bal2, "ORCL");
  check("T6a", "AF-07 — BALANCED : AGG 2,0 % hors bande ⇒ jambe SAFE 0,70 % retenue (strike 40) ; sans AGG aussi SAFE",
    !!p1 && p1.strike === 40 && p1.selectedLegMode === "SAFE"
    && !!p2 && p2.strike === 40 && p2.selectedLegMode === "SAFE",
    { ruleVersion: "AF-07",
      expected: "CRM et ORCL présents, strike 40, selectedLegMode=SAFE",
      actual: {
        avecJambeAgg: p1 ? { ticker: p1.ticker, strike: p1.strike, selectedLegMode: p1.selectedLegMode, fallbackUsed: p1.fallbackUsed, weeklyReturn: p1.weeklyReturn } : "absent",
        sansJambeAgg: p2 ? { ticker: p2.ticker, strike: p2.strike, selectedLegMode: p2.selectedLegMode, fallbackUsed: p2.fallbackUsed } : "absent",
      },
      note: "régression = paradoxe AF-07 : posséder une AGG hors bande exclurait le ticker",
      proof: "resolveCompatibleLegForMode — jambe AGG invalide n'empêche pas d'essayer SAFE" });
}

/* ══════════════ T7 — Quote croisée (bid > ask ⇒ spread négatif) — AF-11 rejet ══════════════ */
{
  const crossed = candidate({
    ticker: "AAPL", price: 210,
    safe: leg({ strike: 190, bid: 1.2, ask: 0.9, spreadPct: -22, yieldPct: 0.63, distancePct: -9.5, popDecimal: 0.93 }),
    safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A",
  });
  // Spread valide serré (bid/ask → ~4,3 %) pour passer maxSpreadPct SAFE 15 %
  const validBook = candidate({
    ticker: "MSFT", price: 210,
    safe: leg({ strike: 190, bid: 1.15, ask: 1.20, spreadPct: 4.3, yieldPct: 0.605, distancePct: -9.5, popDecimal: 0.93 }),
    safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A",
  });
  // capital 100 000 : contrat 19 000 sous le cap ticker 30 % (30 000)
  const combos = buildPortfolioCombos([crossed], 100000, 100, 10, new Set(), OPTS);
  const combosOk = buildPortfolioCombos([validBook], 100000, 100, 10, new Set(), OPTS);
  const p = pickOf(comboByLabel(combos, "SAFE"), "AAPL");
  const pOk = pickOf(comboByLabel(combosOk, "SAFE"), "MSFT");
  const crossedSpread = getLegSpreadPct(crossed.safeStrike);
  check("T7a", "AF-11 — marché croisé / spread négatif rejeté (pick absent) ; spread valide accepté",
    p == null && crossedSpread == null && !!pOk && Number.isFinite(pOk.spreadPct) && pOk.spreadPct >= 0,
    { ruleVersion: "AF-11",
      expected: "AAPL (bid>ask) absent ; MSFT (bid<ask) présent avec spreadPct ≥ 0",
      actual: {
        crossedPick: p ? { spreadPct: p.spreadPct, score: p.selectionScore, grade: p.grade } : "absent",
        crossedHelperSpread: crossedSpread,
        validPick: pOk ? { spreadPct: pOk.spreadPct, grade: pOk.grade } : "absent",
      },
      note: "régression = acceptation d'un spread négatif / grade+score sur marché invalide",
      proof: "computeSpreadPctFromBidAsk → CROSSED_MARKET ; hasSafeLegValid échoue" });
}

/* ══════════════ T8 — Soft-cap ×1,1 incohérent (re-check strict :2089) ══════════════
   Contrat = 32 % du déployable (> cap ticker 30 %, ≤ 33 % soft). La passe soft
   (:2040-2043) le laisse passer au 1er contrôle (:2058) mais le re-check cluster
   (:2089) réapplique le cap STRICT ⇒ rejeté quand même. */
{
  const single = candidate({
    ticker: "AAPL", price: 35,
    safe: leg({ strike: 32, bid: 0.20, ask: 0.21, spreadPct: 6, yieldPct: 0.625, distancePct: -8.6, popDecimal: 0.92 }),
    safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A",
  });
  const combos = buildPortfolioCombos([single], 10000, 100, 5, new Set(), OPTS);
  const safeC = comboByLabel(combos, "SAFE");
  const rej = safeC?.capDiagnosticsV2?.rejectionTotalsAcrossCycles ?? {};
  check("T8a", "DÉFAUT CONFIRMÉ — la passe soft-cap ne peut jamais dépasser le cap ticker strict (re-check :2089 sans ×1,1) : portefeuille vide",
    (safeC?.picks || []).length === 0 && (rej.ticker_cap_reached ?? 0) > 0,
    { actual: { positions: safeC?.picks?.length ?? null, rejets: rej },
      note: "contrat 3 200 $ ≤ limite soft 3 300 $ (:2042) mais > cap strict 3 000 $ re-vérifié (:2089) ⇒ la tolérance ×1,1 est morte pour les nouvelles lignes",
      severityIfFail: null });
}

/* ══════════════ T9 — freeCapital = usableCapital − used (AF-09) ══════════════ */
{
  const two = [
    candidate({ ticker: "AAPL", price: 55, safe: leg({ strike: 50, bid: 0.30, ask: 0.32, spreadPct: 6, yieldPct: 0.60, distancePct: -9, popDecimal: 0.92 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" }),
    candidate({ ticker: "MSFT", price: 55, safe: leg({ strike: 50, bid: 0.29, ask: 0.31, spreadPct: 6, yieldPct: 0.58, distancePct: -9, popDecimal: 0.92 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" }),
  ];
  const capitalBrut = 40000;
  const maxCapitalPct = 50;
  const usableCapital = capitalBrut * (maxCapitalPct / 100); // 20 000
  const combos = buildPortfolioCombos(two, capitalBrut, maxCapitalPct, 10, new Set(), OPTS);
  const safeC = comboByLabel(combos, "SAFE");
  const used = safeC?.totalCapital ?? 0;
  const expectedFree = usableCapital - used;
  check("T9a", "AF-09 — combo.freeCapital = usableCapital − capitalUsed (pas capital brut − used)",
    !!safeC && used > 0 && approx(safeC.freeCapital, expectedFree) && safeC.freeCapital !== capitalBrut - used,
    { ruleVersion: "AF-09",
      expected: `freeCapital = ${usableCapital} − ${used} = ${expectedFree} (≠ brut ${capitalBrut} − used)`,
      actual: { used, freeCapital: safeC?.freeCapital, usableCapital, brutMinusUsed: capitalBrut - used },
      note: "régression = ancienne formule freeCapital = capital − used (réserve non déployable comptée libre)",
      proof: "buildPortfolioCombos retour : freeCapital = max(0, usableCapital - used)" });
}

/* ══════════════ T10 — Multi-contrats : formule « ticker dominant » UI vs moteur ══════════════ */
{
  const two = [
    candidate({ ticker: "NOK", price: 12.45, safe: leg({ strike: 11, bid: 0.07, ask: 0.08, spreadPct: 9, yieldPct: 0.636, distancePct: -11.6, popDecimal: 0.93 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" }),
    // SOFI 40 : un 2e contrat (8 000 $) dépasserait le cap ticker 7 500 $ ⇒ contrats inégaux (NOK×3, SOFI×1)
    candidate({ ticker: "SOFI", price: 44, safe: leg({ strike: 40, bid: 0.22, ask: 0.24, spreadPct: 9, yieldPct: 0.55, distancePct: -9.1, popDecimal: 0.92 }), safeGrade: "B", finalDisplayMode: "SAFE", finalDisplayGrade: "B" }),
  ];
  const combos = buildPortfolioCombos(two, 25000, 100, 10, new Set(), OPTS);
  const safeC = comboByLabel(combos, "SAFE");
  const picks = safeC?.picks || [];
  const hasMulti = picks.some((p) => p.contracts > 1);
  // Formule moteur (capitalUsed / used) — capitalComboPortfolio.js:2716-2735
  const engineDominantPct = safeC?.largestTickerCapitalPct ?? null;
  // Formule UI carte RISQUE (capitalRequired, 1 lot) — dashboard.jsx:10301-10310
  const totalReq = picks.reduce((s, p) => s + p.capitalRequired, 0);
  const byT = {};
  picks.forEach((p) => { byT[p.ticker] = (byT[p.ticker] || 0) + p.capitalRequired; });
  const uiDominantPct = totalReq > 0 ? (Math.max(...Object.values(byT)) / totalReq) * 100 : null;
  check("T10a", "DÉFAUT CONFIRMÉ — avec contrats > 1, la carte RISQUE (capitalRequired) diverge du moteur (capitalUsed)",
    hasMulti && engineDominantPct != null && uiDominantPct != null && Math.abs(engineDominantPct - uiDominantPct) > 1,
    { actual: { picks: picks.map((p) => `${p.ticker}×${p.contracts}`), moteurPct: engineDominantPct?.toFixed(2), uiRisquePct: uiDominantPct?.toFixed(2) },
      note: "même biais pour la colonne Capital des tableaux (capitalRequired affiché, ×N séparé) — dashboard.jsx:10140,10779 ; totaux moteur corrects",
      severityIfFail: null });
}

/* ══════════════ T11 — Recalculs indépendants du portefeuille SAFE observé ══════════════
   (données fournies par l'utilisateur — AUCUN snapshot du dépôt ne contient NFLX/CRWV/NOK :
   validation arithmétique des formules codées, pas rejeu exact.) */
{
  const obs = [
    { t: "NFLX", strike: 66, prime: 0.46, dist: -10.1 },
    { t: "TQQQ", strike: 68, prime: 0.40, dist: -12.0 },
    { t: "CRWV", strike: 76, prime: 0.45, dist: -14.4 },
    { t: "NOK", strike: 11, prime: 0.07, dist: -11.6 },
    { t: "SOFI", strike: 17, prime: 0.09, dist: -9.5 },
    { t: "RIVN", strike: 16, prime: 0.09, dist: -8.5 },
  ];
  const capitals = obs.map((o) => o.strike * 100);
  const totalCap = capitals.reduce((a, b) => a + b, 0);
  const premiums = obs.map((o) => o.prime * 100);
  const totalPrem = premiums.reduce((a, b) => a + b, 0);
  const fill = (totalCap / 25500) * 100;
  const portfolioReturn = (totalPrem / 25500) * 100;
  const yields = obs.map((o) => (o.prime / o.strike) * 100);
  const wDist = obs.reduce((s, o, i) => s + o.dist * capitals[i], 0) / totalCap;
  const crwvConcUsed = (7600 / totalCap) * 100;
  const crwvConcDeployable = (7600 / 25500) * 100;

  check("T11a", "Capital utilisé recalculé = 25 400 $ (Σ strike×100), libre 100 $, remplissage 99,6078 %",
    totalCap === 25400 && approx(fill, 99.60784313725489, 1e-9),
    { actual: { totalCap, libre: 25500 - totalCap, fillPct: fill } });

  check("T11b", "Rendement portefeuille = Σ primes / capital déployable = 156/25500 = 0,6118 % (≈ 0,61 % affiché)",
    approx(totalPrem, 156, 1e-9) && approx(portfolioReturn, 0.611764705882353, 1e-9),
    { actual: { totalPrem, portfolioReturnPct: portfolioReturn }, proof: "formule UI summaryFor — dashboard.jsx:10290-10296" });

  check("T11c", "Rendements par jambe = prime/strike×100 cohérents avec l'affichage (0,70/0,59/0,59/0,64/0,53/0,56)",
    approx(yields[0], 0.696969696969697, 1e-9) && Math.abs(yields[1] - 0.588) < 0.001 && Math.abs(yields[2] - 0.592) < 0.001
    && Math.abs(yields[3] - 0.636) < 0.001 && Math.abs(yields[4] - 0.529) < 0.001 && Math.abs(yields[5] - 0.5625) < 0.0001,
    { actual: yields.map((y) => y.toFixed(4)) });

  check("T11d", "Toutes les jambes SAFE observées ∈ bande SAFE codée [0,45 ; 0,80) et spreads ≤ 15 % (4,3/7,2/8,5/13,3/10,5/10,5)",
    yields.every((y) => y >= 0.45 && y < 0.80),
    { actual: yields.map((y) => y.toFixed(3)), proof: "minWeeklyYield 0,45 :1449 ; maxWeeklyYield 0,80 :1450 ; maxSpreadPct 15 :1452" });

  check("T11e", "Distance OTM moyenne pondérée par capital = −300210/25400 = −11,8193 % ≈ −12 % affiché (moyenne simple = −11,02 %)",
    approx(wDist, -300210 / 25400, 1e-9),
    { actual: { pondereeCapital: wDist, simple: obs.reduce((s, o) => s + o.dist, 0) / 6 },
      proof: "weightedMetricByCapital — dashboard.jsx:9976-9987,10540" });

  check("T11f", "Concentration CRWV : 7600/25400 (capital UTILISÉ) = 29,92 % → affiché « 30 % » ; seuil > 25 %",
    approx(crwvConcUsed, 29.92125984251969, 1e-9) && crwvConcUsed > 25,
    { actual: { surUtilise: crwvConcUsed, surDeployable: crwvConcDeployable },
      note: "les deux dénominateurs arrondissent à 30 % ici — le code utilise le capital utilisé (:2728-2729) ; libellé « du capital » ambigu (:2746)" });

  info("T11g", "POP moyen ~97 % : NON VÉRIFIABLE — un seul POP fourni (NFLX 93,5) ; formule codée = Σ(POP×capitalUsed)/Σ(capitalUsed)",
    { proof: "dashboard.jsx:9976-9987 (weightedMetricByCapital), 10293" });
}

/* ══════════════ T12 — Rejeu du dernier snapshot exploitable (a3b, 7 DTE) ══════════════ */
{
  const snapPath = path.join(REPO_ROOT, "debug", "phase-a3b-result-scan-7dte-20260710.json");
  let replay = null;
  try {
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    const rows = Array.isArray(snap?.shortlist) ? snap.shortlist : [];
    /** Mapper minimal — miroir documenté de ibkrStrikeToDashboardStrike (dashboard.jsx:3935-4024) :
     *  spreadPct fraction ×100, weeklyYield = premiumYield ×100, distance = (strike−spot)/spot×100.
     *  Grades recalculés via les fonctions EXPORTÉES du moteur (gradeLeg / getAggressivePriorityGrade)
     *  — approximation de computeModeRecommendation (dashboard.jsx:467+), POP absent (frozen). */
    const mapLeg = (raw, spot) => {
      if (!raw || !Number.isFinite(Number(raw.strike))) return null;
      const bid = Number(raw.primeUsed ?? raw.bid);
      if (!Number.isFinite(bid) || bid <= 0) return null;
      const spreadPct = Number.isFinite(Number(raw.spreadPct)) ? Number(raw.spreadPct) * 100 : null;
      const y = Number(raw.premiumYield);
      return {
        strike: Number(raw.strike), bid, ask: Number(raw.ask) || null,
        premiumUsed: bid, mid: Number(raw.mid) || bid,
        weeklyYield: Number.isFinite(y) ? y * 100 : (bid / Number(raw.strike)) * 100,
        distancePct: spot > 0 ? ((Number(raw.strike) - spot) / spot) * 100 : 0,
        popProfitEstimated: null,
        liquidity: { spreadPct },
        volume: Number(raw.volume) || 0, openInterest: Number(raw.openInterest) || 0,
        source: "IBKR live",
      };
    };
    const cands = rows.map((row) => {
      const spot = Number(row.currentPrice ?? row.underlyingPrice) || 0;
      const s = mapLeg(row.safeStrike, spot);
      const a = mapLeg(row.aggressiveStrike, spot);
      // popDecimal: undefined (et non null !) — Number(null)=0 ferait passer gradeLeg en « POP 0 % » ⇒ WATCH (voir T15)
      const sg = s ? gradeLeg({ spreadPct: s.liquidity.spreadPct, weeklyYieldPct: s.weeklyYield, popDecimal: undefined }) : null;
      const agPrio = a ? getAggressivePriorityGrade({ spreadPct: a.liquidity.spreadPct, weeklyYieldPct: a.weeklyYield, popDecimal: undefined, distancePct: a.distancePct }) : null;
      const ag = a ? (agPrio ?? gradeLeg({ spreadPct: a.liquidity.spreadPct, weeklyYieldPct: a.weeklyYield, popDecimal: undefined })) : null;
      return candidate({
        ticker: String(row.symbol).toUpperCase(), price: spot, safe: s, agg: a,
        safeGrade: sg && sg !== "REJECT" ? sg : null,
        aggressiveGrade: ag && ag !== "REJECT" ? ag : null,
        proFinalScore: 0, proExecutionScore: 0, proDistanceScore: 0,
      });
    });

    const combos1 = buildPortfolioCombos(cands, 25500, 100, 10, new Set(), OPTS);
    const combos2 = buildPortfolioCombos(cands, 25500, 100, 10, new Set(), OPTS);
    const combosShuffled = buildPortfolioCombos(seededShuffle(cands, 20260711), 25500, 100, 10, new Set(), OPTS);

    check("T12a", "Rejeu a3b : déterminisme strict (2 runs identiques)",
      JSON.stringify(stripDiag(combos1)) === JSON.stringify(stripDiag(combos2)), {});

    const sameShuffled = JSON.stringify(stripDiag(combos1)) === JSON.stringify(stripDiag(combosShuffled));
    info("T12b", "Rejeu a3b : ordre d'entrée mélangé (seed 20260711)",
      { actual: sameShuffled ? "portefeuilles identiques (aucune égalité parfaite dans ce pool)" : "PORTEFEUILLES DIFFÉRENTS — égalités présentes dans ce pool réel" });

    // Diagnostic : pourquoi SAFE/BALANCED peuvent être vides sur ce pool réel 7 DTE
    const enriched = cands.map((c) => buildCapitalComboCandidate(c, 25500));
    const safeBand = enriched.filter((c) => c._hasSafeLegValid && c._safeYieldPct >= 0.45 && c._safeYieldPct < 0.80 && (c._safeSpreadPct ?? 99) <= 15);
    info("T12e", "Rejeu a3b — pool SAFE : jambes SAFE valides / dans la bande [0,45;0,80) avec spread ≤ 15 %", {
      actual: {
        candidats: enriched.length,
        jambesSafeValides: enriched.filter((c) => c._hasSafeLegValid).length,
        dansBandeEtSpread: safeBand.map((c) => c.ticker),
        yieldsSafePct: enriched.filter((c) => c._hasSafeLegValid).map((c) => `${c.ticker}:${c._safeYieldPct?.toFixed(2)}`),
      },
      note: "bande maxWeeklyYield 0,80 % appliquée au rendement PÉRIODE (7 DTE) sans normalisation DTE — cause structurelle d'un SAFE clairsemé à 7 DTE",
    });

    replay = {};
    for (const label of ["SAFE", "BALANCED", "AGGRESSIVE"]) {
      const c = comboByLabel(combos1, label);
      if (!c) { replay[label] = null; continue; }
      const sumUsed = c.picks.reduce((s, p) => s + p.capitalUsed, 0);
      const sumPrem = c.picks.reduce((s, p) => s + p.premiumCollected, 0);
      const badgeMismatch = c.picks.filter((p) => String(p.mode).toUpperCase() !== label).map((p) => `${p.ticker}:${p.mode}`);
      // isolation de jambe : strike du pick ∈ {strike jambe du bucket}
      const legOk = c.picks.every((p) => {
        const cand = cands.find((x) => x.ticker === p.ticker);
        if (label === "SAFE") return cand?.safeStrike?.strike === p.strike;
        if (label === "AGGRESSIVE") return cand?.aggressiveStrike?.strike === p.strike;
        return cand?.safeStrike?.strike === p.strike || cand?.aggressiveStrike?.strike === p.strike;
      });
      check(`T12c-${label}`, `Rejeu a3b ${label} : Σ capitalUsed = totalCapital ; freeCapital = 25500 − utilisé ; strikes = jambe du bucket`,
        approx(sumUsed, c.totalCapital, 1e-6) && approx(c.freeCapital, 25500 - c.totalCapital, 1e-6) && legOk,
        { actual: { positions: c.positions, totalCapital: c.totalCapital, freeCapital: c.freeCapital, fillPct: ((c.totalCapital / 25500) * 100).toFixed(2) } });
      replay[label] = {
        positions: c.positions,
        totalCapital: c.totalCapital,
        freeCapital: c.freeCapital,
        totalPremium: Number(sumPrem.toFixed(2)),
        largestTickerCapitalPct: Number((c.largestTickerCapitalPct ?? 0).toFixed(2)),
        clusterWarnings: c.clusterWarnings,
        picks: c.picks.map((p) => `${p.ticker} ${p.strike}×${p.contracts} mode=${p.mode} grade=${p.grade} y=${Number(p.weeklyReturn).toFixed(2)}%`),
        badgeModeDifferentDuBucket: badgeMismatch,
      };
    }
    info("T12d", "Rejeu a3b — portefeuilles reconstruits (25 500 $, 100 %, 10 pos., POP indisponible/frozen)", { replay });
  } catch (e) {
    info("T12x", "Rejeu a3b impossible", { error: String(e?.message ?? e) });
  }
}

/* ══════════════ T13 — Jambes absentes / prime nulle / spread invalide ══════════════ */
{
  const noSafe = candidate({ ticker: "AAPL", price: 100, agg: leg({ strike: 95, bid: 1.0, ask: 1.05, spreadPct: 6, yieldPct: 1.05, distancePct: -5, popDecimal: 0.86 }), aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A" });
  const combosNoSafe = buildPortfolioCombos([noSafe], 60000, 100, 10, new Set(), OPTS);
  check("T13a", "Jambe SAFE absente ⇒ aucun pick SAFE (pas de substitution par la jambe AGGRESSIVE)",
    (comboByLabel(combosNoSafe, "SAFE")?.picks ?? []).length === 0
    && (comboByLabel(combosNoSafe, "AGGRESSIVE")?.picks ?? []).length === 1,
    { proof: "SAFE ⇒ exclusivement _safeLeg (:1529-1536) ; _hasBucketLeg=false ⇒ NO_BUCKET_LEG_FOR_MODE (:1616-1621)" });

  const zeroPrem = candidate({ ticker: "MSFT", price: 100, safe: leg({ strike: 90, bid: 0, ask: 0.02, spreadPct: 6, yieldPct: 0, distancePct: -10, popDecimal: 0.95 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" });
  check("T13b", "Prime nulle ⇒ jambe invalide, candidat exclu de tous les buckets",
    buildPortfolioCombos([zeroPrem], 60000, 100, 10, new Set(), OPTS).every((c) => (c.picks ?? []).length === 0)
    || buildPortfolioCombos([zeroPrem], 60000, 100, 10, new Set(), OPTS).length === 0,
    { proof: "getLegPremiumValue exige > 0 (:775-784) ; hasSafeLegValid (:1202-1206)" });

  const noSpread = candidate({ ticker: "GOOGL", price: 100, safe: leg({ strike: 90, bid: 0.5, ask: null, spreadPct: null, yieldPct: 0.55, distancePct: -10, popDecimal: 0.95 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" });
  check("T13c", "Spread absent (null) ⇒ jambe invalide au combo (spread requis fini ≤ 35)",
    buildPortfolioCombos([noSpread], 60000, 100, 10, new Set(), OPTS).every((c) => (c.picks ?? []).length === 0)
    || buildPortfolioCombos([noSpread], 60000, 100, 10, new Set(), OPTS).length === 0,
    { proof: "Number.isFinite(safeSpreadPct) exigé (:1205)" });

  const pop0 = candidate({ ticker: "ORCL", price: 100, safe: leg({ strike: 90, bid: 0.5, ask: 0.53, spreadPct: 6, yieldPct: 0.556, distancePct: -10, popDecimal: 0 }), safeGrade: "A", finalDisplayMode: "SAFE", finalDisplayGrade: "A" });
  const p0 = pickOf(comboByLabel(buildPortfolioCombos([pop0], 60000, 100, 10, new Set(), OPTS), "SAFE"), "ORCL");
  check("T13d", "POP absent/nul : non bloquant structurellement (pick possible, POP null|0 conservé)",
    !!p0, { actual: { popEstimate: p0?.popEstimate }, proof: "POP non exigé par hasSafeLegValid (:1202-1206)" });
}

/* ══════════════ T14 — Le mode source ne filtre PAS les buckets (allowedModes mort) ══════════════ */
{
  const asAgg = makeNflx(); // finalDisplayMode AGGRESSIVE
  const asSafe = makeNflx({ finalDisplayMode: "SAFE", finalDisplayGrade: "A" });
  const run = (c) => {
    const combos = buildPortfolioCombos([c, NOK_C, SOFI_C], 25500, 100, 10, new Set(), OPTS);
    const p = pickOf(comboByLabel(combos, "SAFE"), "NFLX");
    return p ? { strike: p.strike, premiumUnit: p.premiumUnit, score: p.selectionScore, mode: p.mode } : null;
  };
  const r1 = run(asAgg);
  const r2 = run(asSafe);
  check("T14a", "finalDisplayMode inversé (AGGRESSIVE→SAFE) : financier et score SAFE identiques ; seul pick.mode change",
    !!r1 && !!r2 && r1.strike === r2.strike && r1.premiumUnit === r2.premiumUnit && r1.score === r2.score
    && r1.mode === "AGGRESSIVE" && r2.mode === "SAFE",
    { actual: { sourceAggressive: r1, sourceSafe: r2 },
      note: "confirme que `allowedModes` (:1331,1396,1453) n'est consommé nulle part — la sélection de bucket est purement par jambe ; le mode source ne sert qu'au badge (et au tie-break T3)" });
}

/* ══════════════ T15 — POP null : politique AF-02 / grade jambe AF-03 ══════════════
   normalizeOptionalPopPct : null/undefined restent absents (pas coercés en 0 %).
   gradeLeg traite pop absent comme non bloquant (A/B selon spread/yield).
   Grade stocké / dérivé de jambe : SAFE et AGGRESSIVE séparés, pas de WATCH artificiel. */
{
  const gNull = gradeLeg({ spreadPct: 6, weeklyYieldPct: 0.556, popDecimal: null });
  const gUndef = gradeLeg({ spreadPct: 6, weeklyYieldPct: 0.556, popDecimal: undefined });
  const popNormNull = normalizeOptionalPopDecimal(null);
  const popNormUndef = normalizeOptionalPopDecimal(undefined);
  check("T15a", "AF-02 — gradeLeg : popDecimal null et undefined ⇒ A (mêmes spread/yield) ; null non coercé en 0",
    gNull === "A" && gUndef === "A" && popNormNull === null && popNormUndef === null,
    { ruleVersion: "AF-02",
      expected: "grade A / A ; normalizeOptionalPopDecimal(null|undefined)=null",
      actual: { avecNull: gNull, avecUndefined: gUndef, popNormNull, popNormUndef },
      note: "régression = Number(null)===0 ⇒ WATCH",
      proof: "normalizeOptionalPopPct / gradeLeg (pop == null || pop >= seuil)" });

  const mkNoGrades = (popDecimal) => candidate({
    ticker: "AAPL", price: 100,
    safe: leg({ strike: 90, bid: 0.5, ask: 0.53, spreadPct: 6, yieldPct: 0.556, distancePct: -10, popDecimal }),
    safeGrade: undefined, finalDisplayMode: undefined, finalDisplayGrade: undefined,
  });
  const run = (c) => comboByLabel(buildPortfolioCombos([c], 40000, 100, 10, new Set(), OPTS), "SAFE");
  const withPop = run(mkNoGrades(0.92));
  const noPop = run(mkNoGrades(null));
  const pPop = withPop?.picks?.[0];
  const pNo = noPop?.picks?.[0];
  check("T15b", "AF-02/AF-03 — sans grades stockés : POP présent ou null ⇒ pick SAFE grade A ; popEstimate null si POP absent (pas 0)",
    !!pPop && pPop.grade === "A"
    && !!pNo && pNo.grade === "A" && pNo.popEstimate == null,
    { ruleVersion: "AF-02/AF-03",
      expected: "avecPop et sansPop : 1 pick grade A ; sansPop.popEstimate === null",
      actual: {
        avecPop: withPop?.picks?.map((p) => `${p.ticker}:${p.grade}:pop=${p.popEstimate}`),
        sansPop: noPop?.picks?.map((p) => `${p.ticker}:${p.grade}:pop=${p.popEstimate}`) ?? "(combo null)",
      },
      note: "régression = exclusion SAFE quand POP null (WATCH coercé)",
      proof: "resolveSelectedLegGrade + normalizeOptionalPop" });

  const aggNoPop = candidate({
    ticker: "MSFT", price: 100,
    agg: leg({ strike: 95, bid: 1.05, ask: 1.10, spreadPct: 6, yieldPct: (1.05 / 95) * 100, distancePct: -5, popDecimal: null }),
    aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A",
  });
  const aggWithPop = candidate({
    ticker: "MSFT", price: 100,
    agg: leg({ strike: 95, bid: 1.05, ask: 1.10, spreadPct: 6, yieldPct: (1.05 / 95) * 100, distancePct: -5, popDecimal: 0.86 }),
    aggressiveGrade: "A", finalDisplayMode: "AGGRESSIVE", finalDisplayGrade: "A",
  });
  const runA = (c) => comboByLabel(buildPortfolioCombos([c], 40000, 100, 10, new Set(), OPTS), "AGGRESSIVE");
  const a1 = runA(aggWithPop);
  const a2 = runA(aggNoPop);
  const ap1 = a1?.picks?.[0];
  const ap2 = a2?.picks?.[0];
  check("T15c", "AF-02/AF-03 — AGGRESSIVE : POP null conserve grade stocké A (pas WATCH écrasant) ; pick inclus",
    !!ap1 && ap1.grade === "A"
    && !!ap2 && ap2.grade === "A" && ap2.popEstimate == null,
    { ruleVersion: "AF-02/AF-03",
      expected: "avecPop et sansPop : 1 pick grade A ; sansPop.popEstimate === null",
      actual: {
        avecPop: a1?.picks?.map((p) => `${p.ticker}:${p.grade}:pop=${p.popEstimate}`),
        sansPop: a2?.picks?.map((p) => `${p.ticker}:${p.grade}:pop=${p.popEstimate}`) ?? "(combo null)",
      },
      note: "régression = grade dérivé WATCH écrase aggressiveGrade stocké A",
      proof: "resolveSelectedLegGrade(explicitGrade) prioritaire ; POP null non bloquant" });
}

/* ══════════════ T16 — Robustesse / contrats AF-17 / AF-18 (helpers purs) ══════════════ */
{
  // Tie-break stable direct (AF-05) — indépendant de l'ordre
  const cmp = compareCapitalComboCandidatesStable({ ticker: "AAPL", selectedStrikeValue: 100 }, { ticker: "MSFT", selectedStrikeValue: 100 });
  const cmpRev = compareCapitalComboCandidatesStable({ ticker: "MSFT", selectedStrikeValue: 100 }, { ticker: "AAPL", selectedStrikeValue: 100 });
  check("T16a", "AF-05 — compareCapitalComboCandidatesStable : AAPL avant MSFT (alphabétique), symétrique",
    cmp < 0 && cmpRev > 0,
    { ruleVersion: "AF-05", expected: "cmp(AAPL,MSFT)<0 et cmp(MSFT,AAPL)>0", actual: { cmp, cmpRev } });

  // AF-18 : "false" localStorage ne doit PAS être truthy
  const falseStr = normalizeCapitalOptimizerV2Boolean("false", true);
  const flagsFromFalse = resolveCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "false" });
  check("T16b", "AF-18 — normalizeCapitalOptimizerV2Boolean(\"false\") === false ; flag override respecté",
    falseStr === false && flagsFromFalse.leftoverDensityPassEnabled === false
    && resolveCapitalOptimizerV2Flags({}).leftoverDensityPassEnabled === CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverDensityPassEnabled,
    { ruleVersion: "AF-18",
      expected: "\"false\" → false ; défauts purs sans localStorage",
      actual: { falseStr, leftoverDensityPassEnabled: flagsFromFalse.leftoverDensityPassEnabled } });

  // AF-17 : rendement période → hebdo normalisé (DTE 14 ⇒ ×7/14)
  const leg14 = {
    strike: 50, bid: 0.40, ask: 0.42, premiumUsed: 0.40,
    weeklyYield: 1.40, // période 14 DTE = 1,40 %
    dteDays: 14,
    liquidity: { spreadPct: 5 },
  };
  const weeklyNorm = getLegWeeklyNormalizedYieldPct(leg14, null);
  check("T16c", "AF-17 — periodYield 1,40 % @ 14 DTE ⇒ weeklyNormalized ≈ 0,70 % (×7/DTE)",
    approx(weeklyNorm, 1.40 * 7 / 14, 1e-9),
    { ruleVersion: "AF-17",
      expected: 0.7,
      actual: weeklyNorm,
      note: "régression = bande appliquée sur rendement période brut sans normalisation" });

  // AF-07 helper : AGG hors bande n'empêche pas SAFE conforme
  const resolved = resolveCompatibleLegForMode({
    legCandidates: [
      { mode: "AGGRESSIVE", priority: 1, valid: true, leg: { x: 1 }, yieldPct: 2.0, strikeValue: 43 },
      { mode: "SAFE", priority: 1, valid: true, leg: { x: 2 }, yieldPct: 0.70, strikeValue: 40 },
    ],
    minYieldPctInclusive: 0.675,
    maxYieldPctExclusive: 1.05,
    preferredBand: BALANCED_PREFERRED_LEG_YIELD_BAND,
  });
  check("T16d", "AF-07 — resolveCompatibleLegForMode : AGG 2,0 % hors bande ⇒ SAFE 0,70 % retenue",
    resolved?.mode === "SAFE" && resolved?.yieldPct === 0.70,
    { ruleVersion: "AF-07", expected: "mode SAFE yield 0.70", actual: resolved ? { mode: resolved.mode, yieldPct: resolved.yieldPct } : null });

  // Garde négative : POP 0 explicite ≠ POP null (null reste null)
  check("T16e", "AF-02 garde — normalizeOptionalPopDecimal(0) = 0 ; null reste null (pas de conversion artificielle)",
    normalizeOptionalPopDecimal(0) === 0 && normalizeOptionalPopDecimal(null) === null,
    { ruleVersion: "AF-02", actual: { zero: normalizeOptionalPopDecimal(0), nil: normalizeOptionalPopDecimal(null) } });
}

/* ────────────────────────────── sortie ────────────────────────────── */

const failed = checks.filter((c) => c.status === "FAIL");
const result = {
  audit: "capital-combinations-audit-fable",
  generatedAt: new Date().toISOString(),
  engine: "wheel-dashboard/src/capitalComboPortfolio.js (import direct, lecture seule)",
  optimizerV2Flags: "override explicite {} ⇒ défauts CAPITAL_COMBO_OPTIMIZER_DEFAULTS (pas de localStorage sous Node)",
  totals: {
    checks: checks.length,
    pass: checks.filter((c) => c.status === "PASS").length,
    fail: failed.length,
    info: checks.filter((c) => c.status === "INFO").length,
    criticalConfirmed,
  },
  checks,
};
console.log(JSON.stringify(result, null, 2));
process.exit(criticalConfirmed > 0 ? 1 : 0);
