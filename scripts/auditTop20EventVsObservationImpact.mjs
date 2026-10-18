// Audit READ-ONLY de l'impact d'un passage du comptage "par observation" au
// comptage "par evenement d'expiration distinct" dans le Top 20 experimental.
// Ne modifie rien (scoring, Pine, crypto-block, selectedExpiration, dteAtScan).
//
// Usage: node scripts/auditTop20EventVsObservationImpact.mjs

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const DTE_TARGETS = [2, 3, 4, 7];
const WEAK_SAMPLE = 5; // DYNAMIC_TOP20_WEAK_DTE_SAMPLE
const FOCUS = ["TQQQ", "APLD", "IONQ", "SOFI", "SMCI", "OKLO", "AFRM", "AAL", "TTD", "PATH", "INTC"];
const EVENT_OF_INTEREST = "20260605"; // 2026-06-05

// ── Helpers repliques a l'identique depuis JournalPopPanel.jsx ────────────────
function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function getRecordResolvedFlag(r) {
  return r?.resolution?.resolved === true;
}
function getRecordAssignedFlag(r) {
  if (r?.resolution?.assigned_flag === true || r?.resolution?.assigned === true) return true;
  if (r?.resolution?.assigned_flag === false || r?.resolution?.assigned === false) return false;
  if (r?.assigned_flag === true || r?.assigned === true) return true;
  if (r?.assigned_flag === false || r?.assigned === false) return false;
  return null;
}
function getRecordWinFlag(r) {
  if (r?.resolution?.popPredictionCorrect === true) return true;
  if (r?.resolution?.popPredictionCorrect === false) return false;
  if (r?.resolution?.expiredWorthless === true) return true;
  if (r?.resolution?.expiredWorthless === false) return false;
  return null;
}
function getRecordBrokeLowerBoundFlag(r) {
  if (r?.resolution?.brokeLowerBound === true || r?.brokeLowerBound === true) return true;
  if (r?.resolution?.brokeLowerBound === false || r?.brokeLowerBound === false) return false;
  return null;
}
function getAssignmentStrike(r) {
  return numberOrNull(r?.strike?.strike) ?? numberOrNull(r?.strike) ?? numberOrNull(r?.assignment_strike) ?? null;
}
function getExpirationClose(r) {
  return (
    numberOrNull(r?.resolution?.underlying_close_at_expiration) ??
    numberOrNull(r?.resolution?.expirationClosePrice) ??
    numberOrNull(r?.underlying_close_at_expiration) ??
    numberOrNull(r?.expirationClosePrice) ??
    numberOrNull(r?.assignment_price) ??
    null
  );
}
function classifyDepth(r) {
  if (getRecordAssignedFlag(r) !== true) return "na";
  const strike = getAssignmentStrike(r);
  const close = getExpirationClose(r);
  if (strike == null || close == null || strike <= 0) return "na";
  const depthPct = ((close - strike) / strike) * 100;
  if (depthPct <= 0 && depthPct >= -1.5) return "proche";
  if (depthPct < -4) return "profonde";
  if (depthPct < -1.5) return "moderee";
  return "na";
}
function normalizeExpKey(v) {
  return String(v ?? "").trim().replace(/-/g, "");
}
function expKeyOf(r) {
  return normalizeExpKey(r?.selectedExpiration ?? r?.expiration ?? "") || null;
}

function round(v, d = 1) {
  if (v == null) return null;
  return Math.round(v * 10 ** d) / 10 ** d;
}

// Rappel — getDteBreakdownVerdict (par ligne DTE) classe "assignation élevée" des que
// deepAssignmentRate>0 OU assignmentRate>=25 (n>=5), sinon "préliminaire" si n<5.

// ── Chargement ────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
const rows = db.prepare("SELECT id, rawJson FROM wheel_validation_records").all();
const allRecords = rows
  .map((row) => {
    try {
      return JSON.parse(String(row.rawJson ?? "{}"));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// Tickers eligibles
const tickerSet = new Set();
for (const r of allRecords) {
  const sym = normalizeTicker(r?.symbol ?? r?.ticker);
  const dte = numberOrNull(r?.dteAtScan);
  if (sym && DTE_TARGETS.includes(dte) && getRecordResolvedFlag(r) && (r?.captureClass ?? "primaryDaily") !== "intradayRetest") {
    tickerSet.add(sym);
  }
}
const tickers = [...tickerSet].sort();

function eligibleFor(ticker) {
  const t = normalizeTicker(ticker);
  return allRecords.filter((r) => {
    const sym = normalizeTicker(r?.symbol ?? r?.ticker);
    const dte = numberOrNull(r?.dteAtScan);
    return (
      sym === t &&
      DTE_TARGETS.includes(dte) &&
      getRecordResolvedFlag(r) &&
      (r?.captureClass ?? "primaryDaily") !== "intradayRetest"
    );
  });
}

function analyzeTicker(ticker) {
  const recs = eligibleFor(ticker);
  const totalN = recs.length;
  const assigned = recs.filter((r) => getRecordAssignedFlag(r) === true);
  const deep = assigned.filter((r) => classifyDepth(r) === "profonde");

  // Niveau evenement (expiration distincte)
  const distinctExp = new Set(recs.map(expKeyOf).filter(Boolean));
  const assignedExp = new Set(assigned.map(expKeyOf).filter(Boolean));
  const deepExp = new Set(deep.map(expKeyOf).filter(Boolean));

  // Taux
  const assignRateObs = totalN > 0 ? (assigned.length / totalN) * 100 : null;
  const deepRateObs = totalN > 0 ? (deep.length / totalN) * 100 : null;
  const assignRateEvent = distinctExp.size > 0 ? (assignedExp.size / distinctExp.size) * 100 : null;
  const deepRateEvent = distinctExp.size > 0 ? (deepExp.size / distinctExp.size) * 100 : null;

  // Win rate
  const winKnown = recs.filter((r) => getRecordWinFlag(r) != null);
  const winCount = winKnown.filter((r) => getRecordWinFlag(r) === true).length;
  const winRate = winKnown.length > 0 ? (winCount / winKnown.length) * 100 : null;

  // LB
  const lbKnown = recs.filter((r) => getRecordBrokeLowerBoundFlag(r) != null);
  const lbBreak = lbKnown.filter((r) => getRecordBrokeLowerBoundFlag(r) === true).length;
  const lbRate = lbKnown.length > 0 ? (lbBreak / lbKnown.length) * 100 : null;
  const lbCritical = (deepRateObs ?? 0) > 0 || (assignRateObs ?? 0) >= 25 ? lbBreak > 0 : false;

  // Concentration sur 2026-06-05
  const assignedFrom0605 = assigned.filter((r) => expKeyOf(r) === EVENT_OF_INTEREST).length;
  const deepFrom0605 = deep.filter((r) => expKeyOf(r) === EVENT_OF_INTEREST).length;
  const concentration0605Obs = assigned.length > 0 ? (assignedFrom0605 / assigned.length) * 100 : null;
  const deepOnly0605 = deepExp.size > 0 && [...deepExp].every((e) => e === EVENT_OF_INTEREST);
  const assignedOnly0605 = assignedExp.size > 0 && [...assignedExp].every((e) => e === EVENT_OF_INTEREST);

  // SAFE/AGGRESSIVE duplication d'une meme assignation
  let safeAggDupAssigned = 0;
  const byExpMode = {};
  for (const r of assigned) {
    const k = expKeyOf(r);
    if (!byExpMode[k]) byExpMode[k] = { safe: 0, aggressive: 0, other: 0 };
    const m = r?.strikeMode;
    if (m === "safe") byExpMode[k].safe++;
    else if (m === "aggressive") byExpMode[k].aggressive++;
    else byExpMode[k].other++;
  }
  for (const c of Object.values(byExpMode)) {
    if (c.safe > 0 && c.aggressive > 0) safeAggDupAssigned += Math.min(c.safe, c.aggressive);
  }

  // Verdict actuel agrege (logique de risque par observation, niveau ticker)
  const currentlyRisky = (deepRateObs ?? 0) > 0 || (assignRateObs ?? 0) >= 25;
  let currentVerdict;
  if (totalN === 0) currentVerdict = "données insuffisantes";
  else if (currentlyRisky) currentVerdict = "assignation élevée (risqué)";
  else if (totalN < WEAK_SAMPLE) currentVerdict = "préliminaire";
  else if ((winRate ?? 0) >= 80 && (assignRateObs ?? 0) <= 10) currentVerdict = "solide";
  else currentVerdict = "préliminaire";

  // Verdict suggere (lecture par evenement distinct)
  // Le risque reel se mesure au nombre d'EXPIRATIONS distinctes assignees profondes.
  let suggestedVerdict;
  if (totalN === 0) suggestedVerdict = "données insuffisantes";
  else if (!currentlyRisky) suggestedVerdict = currentVerdict; // non marque risque -> inchange
  else if (deepExp.size >= 3) suggestedVerdict = "risque confirmé (≥3 expirations profondes)";
  else if (deepExp.size === 2) suggestedVerdict = "risque à nuancer (2 expirations profondes)";
  else if (deepExp.size === 1) {
    // Une seule expiration profonde -> evenement unique
    if (totalN < WEAK_SAMPLE) suggestedVerdict = "événement unique sur échantillon faible";
    else if (assignedExp.size <= 1) suggestedVerdict = "événement d'expiration unique";
    else suggestedVerdict = "événement profond unique (assignations légères ailleurs)";
  } else {
    // Aucune profonde mais assignRateObs>=25
    if (assignedExp.size <= 1) suggestedVerdict = "assignation non profonde, événement unique";
    else if (assignedExp.size === 2) suggestedVerdict = "assignation non profonde, 2 événements";
    else suggestedVerdict = "assignation non profonde répétée";
  }

  // Categorie d'impact.
  // Nuance clef : passer en lecture par evenement REDUIT le taux (moins d'inflation
  // par observation / par mode SAFE+AGGRESSIVE), mais NE FAIT PAS disparaitre un
  // risque profond qui a reellement eu lieu sur >=1 expiration. Le "verdict trop dur"
  // concerne surtout l'AMPLEUR affichee, pas l'existence du risque.
  let category;
  let softeningRationale = [];
  let hardeningRationale = [];
  if (deepExp.size >= 2) hardeningRationale.push(`assignations profondes sur ${deepExp.size} expirations distinctes`);
  if (winRate != null && winRate < 80) hardeningRationale.push(`win ${round(winRate, 0)}% < 80%`);
  if ((assignRateEvent ?? 0) > 20) hardeningRationale.push(`assignation par événement ${round(assignRateEvent, 0)}% > 20%`);
  if (lbCritical && (lbRate ?? 0) >= 50) hardeningRationale.push(`LB critique ${round(lbRate, 0)}% répété`);
  if (safeAggDupAssigned > 0) softeningRationale.push(`${safeAggDupAssigned} assignation(s) dupliquée(s) SAFE+AGGRESSIVE`);
  if (deepExp.size <= 1) softeningRationale.push(`risque profond concentré sur ${deepExp.size} expiration distincte`);
  if (assignedExp.size <= 1 && assigned.length > assignedExp.size)
    softeningRationale.push(`toutes les assignations viennent d'1 seule expiration (${assigned.length} obs)`);
  if (concentration0605Obs != null && concentration0605Obs >= 80)
    softeningRationale.push(`${round(concentration0605Obs, 0)}% des assignations sur 2026-06-05`);
  if (totalN < WEAK_SAMPLE) softeningRationale.push(`échantillon faible (n=${totalN})`);

  if (totalN === 0) category = "Données insuffisantes";
  else if (!currentlyRisky) category = "Aucun impact (non marqué risqué)";
  else if (totalN < WEAK_SAMPLE) category = "Données insuffisantes";
  else if (deepExp.size >= 2) {
    // Profond sur 2+ expirations distinctes = risque structurel, evenement ne sauve pas
    category = "Aucun impact (risque confirmé)";
  } else if (deepExp.size === 1) {
    // Un seul evenement profond : le flag reste (deep>0) mais l'ampleur etait gonflee.
    if ((winRate != null && winRate < 80) || assignedExp.size >= 2) {
      category = "Impact modéré (nuance nécessaire)";
    } else {
      category = "Impact majeur (verdict actuel probablement trop dur)";
    }
  } else {
    // Aucune profonde, mais assignRateObs>=25 : pur effet de taux par observation
    if (assignedExp.size >= 3) category = "Aucun impact (risque confirmé)";
    else if (assignedExp.size === 2 || (winRate != null && winRate < 80))
      category = "Impact modéré (nuance nécessaire)";
    else category = "Impact majeur (verdict actuel probablement trop dur)";
  }

  return {
    ticker,
    totalN,
    assignedObs: assigned.length,
    deepObs: deep.length,
    assignRateObsPct: round(assignRateObs, 1),
    deepRateObsPct: round(deepRateObs, 1),
    distinctExpirations: distinctExp.size,
    distinctAssignedExpirations: assignedExp.size,
    distinctDeepExpirations: deepExp.size,
    assignRateEventPct: round(assignRateEvent, 1),
    deepRateEventPct: round(deepRateEvent, 1),
    distinctExpirationsList: [...distinctExp],
    distinctAssignedExpirationsList: [...assignedExp],
    distinctDeepExpirationsList: [...deepExp],
    winRatePct: round(winRate, 1),
    winKnownN: winKnown.length,
    lbBreak,
    lbKnownN: lbKnown.length,
    lbRatePct: round(lbRate, 1),
    lbCritical,
    assignedFrom2026_06_05: assignedFrom0605,
    deepFrom2026_06_05: deepFrom0605,
    concentration0605ObsPct: round(concentration0605Obs, 1),
    deepEventsOnly2026_06_05: deepOnly0605,
    assignedEventsOnly2026_06_05: assignedOnly0605,
    safeAggressiveDuplicatedAssignments: safeAggDupAssigned,
    currentlyRisky,
    currentVerdict,
    suggestedVerdict,
    category,
    softeningRationale,
    hardeningRationale,
  };
}

const analyses = tickers.map(analyzeTicker);

// Tri: tickers risques d'abord, par nombre d'obs assignees
const risky = analyses.filter((a) => a.currentlyRisky).sort((a, b) => b.assignedObs - a.assignedObs);

const categories = {
  "Impact majeur (verdict actuel probablement trop dur)": [],
  "Impact modéré (nuance nécessaire)": [],
  "Aucun impact (risque confirmé)": [],
  "Données insuffisantes": [],
  "Aucun impact (non marqué risqué)": [],
};
for (const a of analyses) categories[a.category].push(a.ticker);

const out = {
  generatedAt: new Date().toISOString(),
  dbPath: DB_PATH,
  method: {
    eligibility: "symbol + dteAtScan in [2,3,4,7] + resolution.resolved===true + captureClass!==intradayRetest",
    observationRate: "assignedObs / totalN (toutes lignes, SAFE+AGGRESSIVE comptees separement)",
    eventRate: "expirations distinctes assignees / expirations distinctes (selectedExpiration||expiration)",
    note: "AUDIT SEUL — aucun scoring modifie, aucun changement crypto-block/selectedExpiration/dteAtScan",
  },
  totals: {
    tickersAnalyzed: analyses.length,
    currentlyRisky: risky.length,
    byCategory: Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.length])),
  },
  categories,
  focusTickers: FOCUS.map((t) => analyses.find((a) => a.ticker === t) ?? { ticker: t, missing: true }),
  riskyTickers: risky,
  allTickers: analyses,
};

fs.writeFileSync(
  path.resolve(process.cwd(), "debug", "top20-event-vs-observation-impact-audit.json"),
  JSON.stringify(out, null, 2),
);

// ── Console summary ──────────────────────────────────────────────────────────
console.log(`Tickers analysés: ${analyses.length} | marqués risqués (obs): ${risky.length}`);
console.log("\nPar catégorie:");
for (const [k, v] of Object.entries(categories)) console.log(`  ${k}: ${v.length}`);

console.log("\n=== FOCUS ===");
console.log("Ticker | actuel | obsAssign% | evtAssign% | obsProf% | evtProf% | expProfDist | conc0605 | suggéré | catégorie");
for (const t of FOCUS) {
  const a = analyses.find((x) => x.ticker === t);
  if (!a) { console.log(`${t} | ABSENT`); continue; }
  console.log(
    `${a.ticker} | ${a.currentVerdict} | ${a.assignRateObsPct}% | ${a.assignRateEventPct}% | ${a.deepRateObsPct}% | ${a.deepRateEventPct}% | ${a.distinctDeepExpirations} | ${a.concentration0605ObsPct}% | ${a.suggestedVerdict} | ${a.category}`,
  );
}

console.log("\n=== TOUS LES TICKERS RISQUÉS (par obs assignées) ===");
for (const a of risky) {
  console.log(
    `${a.ticker.padEnd(6)} n=${String(a.totalN).padStart(2)} assign=${a.assignedObs}/${a.distinctAssignedExpirations}exp prof=${a.deepObs}/${a.distinctDeepExpirations}exp obsA=${a.assignRateObsPct}% evtA=${a.assignRateEventPct}% win=${a.winRatePct}% conc0605=${a.concentration0605ObsPct}% [${a.category}]`,
  );
}
db.close();
