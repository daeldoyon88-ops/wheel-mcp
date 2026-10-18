// Audit READ-ONLY du comptage des assignations par DTE dans le détail Journal POP.
// Réplique EXACTEMENT les helpers de wheel-dashboard/src/components/JournalPopPanel.jsx
// (buildDynamicTop20DteBreakdown + classifyDteBreakdownAssignmentDepth + flags).
// Ne modifie rien. Ne change pas le scoring.
//
// Usage: node scripts/auditTop20DteAssignmentCounting.mjs

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const TICKERS = ["TQQQ", "APLD", "IONQ"];
const DYNAMIC_TOP20_DTE_TARGETS = [2, 3, 4, 7];
const DYNAMIC_TOP20_WEAK_DTE_SAMPLE = 5;

// ── Helpers répliqués à l'identique depuis JournalPopPanel.jsx ────────────────
function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function getRecordResolvedFlag(record) {
  return record?.resolution?.resolved === true;
}
function getRecordAssignedFlag(record) {
  if (record?.resolution?.assigned_flag === true || record?.resolution?.assigned === true) return true;
  if (record?.resolution?.assigned_flag === false || record?.resolution?.assigned === false) return false;
  if (record?.assigned_flag === true || record?.assigned === true) return true;
  if (record?.assigned_flag === false || record?.assigned === false) return false;
  return null;
}
function getAssignmentStrikeForDteBreakdown(record) {
  return (
    numberOrNull(record?.strike?.strike) ??
    numberOrNull(record?.strike) ??
    numberOrNull(record?.assignment_strike) ??
    null
  );
}
function getExpirationCloseForDteBreakdown(record) {
  return (
    numberOrNull(record?.resolution?.underlying_close_at_expiration) ??
    numberOrNull(record?.resolution?.expirationClosePrice) ??
    numberOrNull(record?.underlying_close_at_expiration) ??
    numberOrNull(record?.expirationClosePrice) ??
    numberOrNull(record?.assignment_price) ??
    null
  );
}
function classifyDteBreakdownAssignmentDepth(record) {
  if (getRecordAssignedFlag(record) !== true) return "na";
  const strike = getAssignmentStrikeForDteBreakdown(record);
  const close = getExpirationCloseForDteBreakdown(record);
  if (strike == null || close == null || strike <= 0) return "na";
  const depthPct = ((close - strike) / strike) * 100;
  if (depthPct <= 0 && depthPct >= -1.5) return "proche";
  if (depthPct < -4) return "profonde";
  if (depthPct < -1.5) return "moderee";
  return "na";
}

// ── Chargement des records depuis SQLite (rawJson = record complet) ───────────
const db = new DatabaseSync(DB_PATH);
const allRows = db
  .prepare("SELECT id, rawJson FROM wheel_validation_records WHERE symbol IN ('TQQQ','APLD','IONQ')")
  .all();
const records = allRows
  .map((row) => {
    try {
      return JSON.parse(String(row.rawJson ?? "{}"));
    } catch {
      return null;
    }
  })
  .filter(Boolean);

function round(v, d = 2) {
  if (v == null) return null;
  return Math.round(v * 10 ** d) / 10 ** d;
}

// Reproduit l'éligibilité du panel
function eligibleForTicker(ticker) {
  const t = normalizeTicker(ticker);
  return records.filter((record) => {
    const symbol = normalizeTicker(record?.symbol ?? record?.ticker);
    const dte = numberOrNull(record?.dteAtScan);
    return (
      symbol === t &&
      DYNAMIC_TOP20_DTE_TARGETS.includes(dte) &&
      getRecordResolvedFlag(record) &&
      (record?.captureClass ?? "primaryDaily") !== "intradayRetest"
    );
  });
}

function expKeyOf(record) {
  return record?.selectedExpiration ?? record?.expiration ?? null;
}

const auditOut = { generatedAt: new Date().toISOString(), dbPath: DB_PATH, countingModel: {}, tickers: {} };

// ── Vérif structurelle: les buckets sont-ils cumulatifs ? ─────────────────────
// Le panel fait: eligibleRecords.filter(r => numberOrNull(r.dteAtScan) === dte)
// => groupement par dteAtScan EXACT, buckets indépendants, NON cumulatifs.
auditOut.countingModel = {
  grouping: "dteAtScan EXACT (numberOrNull(record.dteAtScan) === dte)",
  cumulative: false,
  dte7_counts_in_dte4: false,
  dte4_counts_in_dte3: false,
  buckets_independent: true,
  assignmentRate_basis: "PAR OBSERVATION (assignedRows.length / n), pas par expiration distincte",
  strikeMode_separation: "AUCUN filtre strikeMode -> SAFE et AGGRESSIVE comptés séparément dans n",
  eligibility: "symbol match + dteAtScan in [2,3,4,7] + resolution.resolved===true + captureClass!=='intradayRetest'",
};

for (const ticker of TICKERS) {
  const eligible = eligibleForTicker(ticker);
  const perDte = [];

  for (const dte of DYNAMIC_TOP20_DTE_TARGETS) {
    const dteRecords = eligible.filter((r) => numberOrNull(r?.dteAtScan) === dte);
    const n = dteRecords.length;
    const assignedRows = dteRecords.filter((r) => getRecordAssignedFlag(r) === true);
    const deepRows = assignedRows.filter((r) => classifyDteBreakdownAssignmentDepth(r) === "profonde");

    // Expirations distinctes
    const allExpSet = new Set(dteRecords.map(expKeyOf).filter(Boolean));
    const assignedExpSet = new Set(assignedRows.map(expKeyOf).filter(Boolean));
    const deepExpSet = new Set(deepRows.map(expKeyOf).filter(Boolean));

    // Détail par observation
    const observations = dteRecords.map((r) => {
      const strike = getAssignmentStrikeForDteBreakdown(r);
      const close = getExpirationCloseForDteBreakdown(r);
      const distPct = strike != null && close != null && strike > 0 ? ((close - strike) / strike) * 100 : null;
      return {
        id: r?.id ?? null,
        scanDate: r?.scanDate ?? null,
        expirationKey: expKeyOf(r),
        selectedExpiration: r?.selectedExpiration ?? null,
        expiration: r?.expiration ?? null,
        strikeMode: r?.strikeMode ?? null,
        assigned: getRecordAssignedFlag(r),
        depth: classifyDteBreakdownAssignmentDepth(r),
        strike: round(strike, 2),
        closeAtExpiration: round(close, 2),
        distanceCloseVsStrikePct: round(distPct, 2),
      };
    });

    // Taux par observation vs par événement
    const assignmentRateObs = n > 0 ? (assignedRows.length / n) * 100 : null;
    const deepRateObs = n > 0 ? (deepRows.length / n) * 100 : null;
    const assignmentRateEvent = allExpSet.size > 0 ? (assignedExpSet.size / allExpSet.size) * 100 : null;
    const deepRateEvent = allExpSet.size > 0 ? (deepExpSet.size / allExpSet.size) * 100 : null;

    perDte.push({
      dte,
      n,
      assignedObservations: assignedRows.length,
      assignmentRateByObservationPct: round(assignmentRateObs, 1),
      deepAssignedObservations: deepRows.length,
      deepAssignmentRateByObservationPct: round(deepRateObs, 1),
      distinctExpirations: allExpSet.size,
      distinctExpirationsList: [...allExpSet],
      distinctAssignedExpirations: assignedExpSet.size,
      distinctAssignedExpirationsList: [...assignedExpSet],
      distinctDeepAssignedExpirations: deepExpSet.size,
      distinctDeepAssignedExpirationsList: [...deepExpSet],
      assignmentRateByEventPct: round(assignmentRateEvent, 1),
      deepAssignmentRateByEventPct: round(deepRateEvent, 1),
      sampleLabel: n === 0 ? "aucune donnée" : n < DYNAMIC_TOP20_WEAK_DTE_SAMPLE ? "échantillon faible" : "échantillon utilisable",
      observations,
    });
  }

  // SAFE/AGGRESSIVE: doublons même ticker/DTE/expiration ?
  const dupCheck = [];
  for (const dte of DYNAMIC_TOP20_DTE_TARGETS) {
    const dteRecords = eligible.filter((r) => numberOrNull(r?.dteAtScan) === dte);
    const byExp = {};
    for (const r of dteRecords) {
      const k = expKeyOf(r);
      if (!byExp[k]) byExp[k] = { safe: 0, aggressive: 0, other: 0 };
      const m = r?.strikeMode;
      if (m === "safe") byExp[k].safe++;
      else if (m === "aggressive") byExp[k].aggressive++;
      else byExp[k].other++;
    }
    for (const [exp, c] of Object.entries(byExp)) {
      if (c.safe > 0 && c.aggressive > 0) {
        dupCheck.push({ dte, expiration: exp, safe: c.safe, aggressive: c.aggressive, other: c.other });
      }
    }
  }

  auditOut.tickers[ticker] = {
    eligibleCount: eligible.length,
    perDte,
    safeAggressiveDuplicateExpirations: dupCheck,
  };
}

const debugDir = path.resolve(process.cwd(), "debug");
fs.writeFileSync(
  path.join(debugDir, "top20-dte-assignment-counting-audit.json"),
  JSON.stringify(auditOut, null, 2),
);
console.log("JSON écrit. Résumé:");
for (const ticker of TICKERS) {
  console.log(`\n=== ${ticker} (éligibles=${auditOut.tickers[ticker].eligibleCount}) ===`);
  for (const r of auditOut.tickers[ticker].perDte) {
    console.log(
      `DTE ${r.dte}: n=${r.n} assignées=${r.assignedObservations} (${r.assignmentRateByObservationPct}% obs) | ` +
        `exp distinctes=${r.distinctExpirations} assignées=${r.distinctAssignedExpirations} (${r.assignmentRateByEventPct}% évt) | ` +
        `profondes obs=${r.deepAssignedObservations} exp=${r.distinctDeepAssignedExpirations}`,
    );
  }
  const dups = auditOut.tickers[ticker].safeAggressiveDuplicateExpirations;
  if (dups.length) {
    console.log(`  SAFE+AGGRESSIVE doublons: ${dups.map((d) => `${d.dte}DTE/${d.expiration}(S${d.safe}/A${d.aggressive})`).join(", ")}`);
  }
}
db.close();
