// Validation READ-ONLY du patch « verdict risque événement unique ».
// Réplique computeTickerEventUniqueness + classifyEventRiskVerdict du panel et
// vérifie les critères d'acceptation sur les données réelles.
// Ne modifie rien. Usage: node scripts/validateEventUniqueVerdictPatch.mjs

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const DTE_TARGETS = [2, 3, 4, 7];
const WEAK = 5;
const DEEP_EVENT = "20260605";
const FOCUS = ["TQQQ", "APLD", "INTC", "AFRM", "IONQ", "CDE", "GDX", "SLV", "SOFI", "SMCI", "OKLO", "AAL", "TTD", "PATH"];

const numberOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const normalizeTicker = (v) => String(v ?? "").trim().toUpperCase();
const resolved = (r) => r?.resolution?.resolved === true;
const assignedFlag = (r) => {
  if (r?.resolution?.assigned_flag === true || r?.resolution?.assigned === true) return true;
  if (r?.resolution?.assigned_flag === false || r?.resolution?.assigned === false) return false;
  if (r?.assigned_flag === true || r?.assigned === true) return true;
  if (r?.assigned_flag === false || r?.assigned === false) return false;
  return null;
};
const winFlag = (r) => {
  if (r?.resolution?.popPredictionCorrect === true) return true;
  if (r?.resolution?.popPredictionCorrect === false) return false;
  if (r?.resolution?.expiredWorthless === true) return true;
  if (r?.resolution?.expiredWorthless === false) return false;
  return null;
};
const lbFlag = (r) => {
  if (r?.resolution?.brokeLowerBound === true || r?.brokeLowerBound === true) return true;
  if (r?.resolution?.brokeLowerBound === false || r?.brokeLowerBound === false) return false;
  return null;
};
const strikeOf = (r) => numberOrNull(r?.strike?.strike) ?? numberOrNull(r?.strike) ?? numberOrNull(r?.assignment_strike) ?? null;
const closeOf = (r) =>
  numberOrNull(r?.resolution?.underlying_close_at_expiration) ??
  numberOrNull(r?.resolution?.expirationClosePrice) ??
  numberOrNull(r?.underlying_close_at_expiration) ??
  numberOrNull(r?.expirationClosePrice) ??
  numberOrNull(r?.assignment_price) ??
  null;
const depthClass = (r) => {
  if (assignedFlag(r) !== true) return "na";
  const s = strikeOf(r), c = closeOf(r);
  if (s == null || c == null || s <= 0) return "na";
  const d = ((c - s) / s) * 100;
  if (d <= 0 && d >= -1.5) return "proche";
  if (d < -4) return "profonde";
  if (d < -1.5) return "moderee";
  return "na";
};
const expKey = (r) => String(r?.selectedExpiration ?? r?.expiration ?? "").trim().replace(/-/g, "") || null;
const fmtPct = (v) => (v == null ? "—" : `${Number(v).toFixed(1)}%`);

// ── Répliques exactes du panel ────────────────────────────────────────────────
function computeTickerEventUniqueness(ticker, records) {
  const t = normalizeTicker(ticker);
  const eligible = records.filter((r) => {
    const sym = normalizeTicker(r?.symbol ?? r?.ticker);
    const dte = numberOrNull(r?.dteAtScan);
    return sym === t && DTE_TARGETS.includes(dte) && resolved(r) && (r?.captureClass ?? "primaryDaily") !== "intradayRetest";
  });
  const totalN = eligible.length;
  const assigned = eligible.filter((r) => assignedFlag(r) === true);
  const deep = assigned.filter((r) => depthClass(r) === "profonde");
  const distinctExp = new Set(eligible.map(expKey).filter(Boolean));
  const distinctAsg = new Set(assigned.map(expKey).filter(Boolean));
  const distinctDeep = new Set(deep.map(expKey).filter(Boolean));
  const deepSorted = [...distinctDeep].sort();
  const lastDeep = deepSorted.length ? deepSorted[deepSorted.length - 1] : null;
  let conc = null;
  if (deep.length) {
    const c = {};
    for (const r of deep) { const k = expKey(r) ?? "?"; c[k] = (c[k] ?? 0) + 1; }
    conc = (Math.max(...Object.values(c)) / deep.length) * 100;
  }
  const byExp = {};
  for (const r of assigned) {
    const k = expKey(r) ?? "?";
    if (!byExp[k]) byExp[k] = { safe: 0, aggressive: 0 };
    if (r?.strikeMode === "safe") byExp[k].safe++;
    else if (r?.strikeMode === "aggressive") byExp[k].aggressive++;
  }
  let dup = 0;
  for (const c of Object.values(byExp)) dup += Math.min(c.safe, c.aggressive);
  const winKnown = eligible.filter((r) => winFlag(r) != null);
  const winRate = winKnown.length ? (winKnown.filter((r) => winFlag(r) === true).length / winKnown.length) * 100 : null;
  const lbKnown = eligible.filter((r) => lbFlag(r) != null);
  const lbBreak = lbKnown.filter((r) => lbFlag(r) === true).length;
  const lbRate = lbKnown.length ? (lbBreak / lbKnown.length) * 100 : null;
  return {
    totalN,
    assignedCount: assigned.length,
    deepAssignedCount: deep.length,
    assignmentRate: totalN ? (assigned.length / totalN) * 100 : null,
    deepAssignmentRate: totalN ? (deep.length / totalN) * 100 : null,
    distinctExpirationCount: distinctExp.size,
    distinctAssignedExpirationCount: distinctAsg.size,
    distinctDeepAssignmentExpirationCount: distinctDeep.size,
    lastDeepAssignmentExpiration: lastDeep,
    deepAssignmentEventConcentration: conc,
    safeAggressiveDuplicateAssignmentCount: dup,
    deepAssignmentConcentratedOn20260605: distinctDeep.size > 0 && [...distinctDeep].every((e) => e === DEEP_EVENT),
    winRate,
    lbBreakRate: lbRate,
    lbBreakCount: lbBreak,
    lbKnownCount: lbKnown.length,
  };
}

function classifyEventRiskVerdict(u) {
  if (!u || u.totalN === 0) return { category: "Échantillon insuffisant", label: "Échantillon insuffisant", hard: false, reasons: [] };
  if (u.totalN < WEAK) return { category: "Échantillon insuffisant", label: "Échantillon insuffisant", hard: false, reasons: [`n=${u.totalN} < ${WEAK}`] };
  const isRisky = (u.deepAssignmentRate ?? 0) > 0 || (u.assignmentRate ?? 0) >= 25;
  if (!isRisky) return { category: "Non risqué", label: null, hard: false, reasons: [] };
  const multiDeep = u.distinctDeepAssignmentExpirationCount >= 2;
  const multiAssignHigh = (u.assignmentRate ?? 0) > 20 && u.distinctAssignedExpirationCount >= 2;
  if (multiDeep || multiAssignHigh) {
    const reasons = [];
    if (multiDeep) reasons.push(`assignations profondes sur ${u.distinctDeepAssignmentExpirationCount} expirations distinctes`);
    if (multiAssignHigh) reasons.push(`assignation ${fmtPct(u.assignmentRate)} sur ${u.distinctAssignedExpirationCount} expirations`);
    return { category: "Risque confirmé", label: "Assignation élevée confirmée", hard: true, reasons };
  }
  const deepLabel = (u.deepAssignmentRate ?? 0) > 0 ? "Alerte — 1 expiration profonde / à confirmer" : "Événement unique à confirmer";
  const watch = [];
  if (u.winRate != null && u.winRate < 80) watch.push(`win ${fmtPct(u.winRate)} < 80%`);
  if (u.lbBreakRate != null && u.lbBreakRate >= 50) watch.push(`LB cassé ${fmtPct(u.lbBreakRate)}`);
  if (watch.length) return { category: "Surveillé", label: deepLabel, hard: false, reasons: watch };
  const reasons = [`risque concentré sur 1 expiration${u.deepAssignmentConcentratedOn20260605 ? " (2026-06-05)" : ""}`];
  if (u.safeAggressiveDuplicateAssignmentCount > 0) reasons.push(`${u.safeAggressiveDuplicateAssignmentCount} doublon(s) SAFE/AGGRESSIVE`);
  return { category: "Risque événement unique", label: deepLabel, hard: false, reasons };
}

// ── Chargement ────────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
const records = db
  .prepare("SELECT rawJson FROM wheel_validation_records")
  .all()
  .map((row) => { try { return JSON.parse(String(row.rawJson ?? "{}")); } catch { return null; } })
  .filter(Boolean);

const tickerSet = new Set();
for (const r of records) {
  const sym = normalizeTicker(r?.symbol ?? r?.ticker);
  const dte = numberOrNull(r?.dteAtScan);
  if (sym && DTE_TARGETS.includes(dte) && resolved(r) && (r?.captureClass ?? "primaryDaily") !== "intradayRetest") tickerSet.add(sym);
}
const allTickers = [...tickerSet].sort();

const results = {};
for (const t of allTickers) {
  const u = computeTickerEventUniqueness(t, records);
  results[t] = { uniqueness: u, verdict: classifyEventRiskVerdict(u) };
}

// ── Critères d'acceptation ────────────────────────────────────────────────────
const checks = [];
const expect = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

for (const t of ["TQQQ", "APLD", "INTC", "AFRM"]) {
  const v = results[t]?.verdict;
  expect(`${t} n'est PAS « assignation élevée confirmée »`, v && v.label !== "Assignation élevée confirmée" && v.category !== "Risque confirmé", `→ ${v?.category} / ${v?.label}`);
  expect(`${t} affiche « Alerte — 1 expiration profonde / à confirmer »`, v && v.label === "Alerte — 1 expiration profonde / à confirmer", `→ ${v?.label}`);
}
{
  // IONQ « peut rester plus surveillé » : doit rester DUR (jamais adouci en
  // « Risque événement unique » ni « Non risqué ») car win 65% < 80%, LB 70% et
  // assignation 35% répartie sur 2 expirations distinctes (règles dures #2 et #3).
  const v = results["IONQ"]?.verdict;
  expect(
    "IONQ reste plus surveillé que TQQQ/APLD/INTC/AFRM (Surveillé ou Risque confirmé)",
    v && (v.category === "Surveillé" || v.category === "Risque confirmé"),
    `→ ${v?.category} / ${v?.label}`,
  );
  expect(
    "IONQ n'est PAS adouci en « Risque événement unique »",
    v && v.category !== "Risque événement unique" && v.category !== "Non risqué",
    `→ ${v?.category}`,
  );
}
for (const t of ["CDE", "GDX", "SLV"]) {
  const v = results[t]?.verdict;
  expect(`${t} reste « Risque confirmé »`, v && v.category === "Risque confirmé", `→ ${v?.category} / ${v?.label}`);
}

const allPass = checks.every((c) => c.pass);

const out = {
  generatedAt: new Date().toISOString(),
  dbPath: DB_PATH,
  scope: "Couche affichage client (JournalPopPanel.jsx) — scoring backend inchangé",
  buildStatus: "vite build OK (vérifié séparément)",
  acceptanceChecks: checks,
  allChecksPass: allPass,
  focus: Object.fromEntries(FOCUS.map((t) => [t, results[t] ?? { missing: true }])),
  categoryCounts: (() => {
    const c = {};
    for (const t of allTickers) { const cat = results[t].verdict.category; c[cat] = (c[cat] ?? 0) + 1; }
    return c;
  })(),
  allTickers: results,
};
fs.writeFileSync(path.resolve(process.cwd(), "debug", "top20-event-unique-verdict-patch-validation.json"), JSON.stringify(out, null, 2));

console.log("Tickers:", allTickers.length, "| checks:", checks.length, "| ALL PASS:", allPass);
console.log("\nCatégories:", JSON.stringify(out.categoryCounts));
console.log("\n=== FOCUS ===");
for (const t of FOCUS) {
  const r = results[t];
  if (!r) { console.log(`${t}: ABSENT`); continue; }
  const u = r.uniqueness, v = r.verdict;
  console.log(`${t.padEnd(5)} n=${String(u.totalN).padStart(2)} win=${fmtPct(u.winRate).padStart(6)} asgP=${fmtPct(u.assignmentRate).padStart(6)} profP=${fmtPct(u.deepAssignmentRate).padStart(6)} expProf=${u.distinctDeepAssignmentExpirationCount} dernProf=${u.lastDeepAssignmentExpiration ?? "—"} conc0605=${u.deepAssignmentConcentratedOn20260605} dup=${u.safeAggressiveDuplicateAssignmentCount} => [${v.category}] ${v.label ?? ""}`);
}
console.log("\n=== CHECKS ===");
for (const c of checks) console.log(`${c.pass ? "✅" : "❌"} ${c.name}  ${c.detail}`);
db.close();
process.exit(allPass ? 0 : 1);
