#!/usr/bin/env node
/**
 * AUDIT READ-ONLY J4-B — Journal POP / observations vs décisions réelles
 * -----------------------------------------------------------------------
 * Distingue les assignations observationnelles (SAFE/AGRESSIF/DTE/scan) des
 * événements d'expiration réellement distincts qu'un trader n'aurait tradé qu'une fois.
 *
 * LECTURE SEULE — n'écrit que les 3 livrables debug/. Ne touche ni le moteur, ni le
 * frontend, ni le schéma DB, ni l'Archive Funnel, ni le scanner / IBKR / Yahoo.
 *
 * Usage:
 *   node debug/journal-pop-j4-observation-vs-decision-audit.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import { classifyAssignmentDepth } from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve("debug", "journal-pop-j4-observation-vs-decision-audit.json");
const OUT_MD = path.resolve("debug", "journal-pop-j4-observation-vs-decision-audit.md");

const FOCUS_TICKERS = ["TQQQ", "APLD", "HOOD", "SOFI", "BAC", "CCL", "HIMS"];
const DTE_BUCKETS = [2, 3, 4, 7];

// ── helpers lecture seule ────────────────────────────────────────────────────
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

function normMode(record) {
  const m = String(record?.strikeMode ?? "").trim().toLowerCase();
  if (m === "safe") return "SAFE";
  if (m === "aggressive" || m === "agressif") return "AGGRESSIVE";
  return "OTHER";
}

function expKey(record) {
  return String(record?.selectedExpiration ?? record?.expiration ?? "").trim().replace(/-/g, "") || null;
}

function getStrike(record) {
  return num(record?.strike?.strike) ?? num(record?.strike) ?? num(record?.assignment_strike);
}

function getCloseAtExpiration(record) {
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

function wouldAvoidAssignment(strike, close) {
  if (strike == null || close == null) return null;
  return close >= strike;
}

function makeStore() {
  const useSqlite = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

function uniqSorted(values) {
  return [...new Set(values.filter((v) => v != null && v !== ""))].sort();
}

function countDistinct(records, keyFn) {
  return new Set(records.map(keyFn)).size;
}

function observationSignature(r) {
  return [
    sym(r?.symbol ?? r?.ticker),
    expKey(r) ?? "na",
    String(r?.scanSessionId ?? "no-session"),
    String(num(r?.dteAtScan) ?? "na"),
    normMode(r),
    String(getStrike(r) ?? "na"),
  ].join("|");
}

function expirationSignature(r) {
  return [sym(r?.symbol ?? r?.ticker), expKey(r) ?? "na"].join("|");
}

function strategyChoiceSignature(r) {
  return [
    sym(r?.symbol ?? r?.ticker),
    expKey(r) ?? "na",
    String(num(r?.dteAtScan) ?? "na"),
    normMode(r),
  ].join("|");
}

function tradeCandidateSignature(r) {
  return [
    sym(r?.symbol ?? r?.ticker),
    expKey(r) ?? "na",
    String(num(r?.dteAtScan) ?? "na"),
    String(getStrike(r) ?? "na"),
  ].join("|");
}

/** Une décision théorique unique = 1 contrat choisi par expiration réelle. */
function selectedTradeSignature(r) {
  return expirationSignature(r);
}

function enrichAssignedRecord(r) {
  const strike = getStrike(r);
  const close = getCloseAtExpiration(r);
  const depth = classifyAssignmentDepth(r);
  return {
    id: r?.id ?? null,
    ticker: sym(r?.symbol ?? r?.ticker),
    selectedExpiration: r?.selectedExpiration ?? null,
    expiration: r?.expiration ?? null,
    expKey: expKey(r),
    scanDate: r?.scanDate ?? null,
    scanSessionId: r?.scanSessionId ?? null,
    dte: num(r?.dteAtScan),
    mode: normMode(r),
    strike: round2(strike),
    closeAtExpiration: round2(close),
    assignmentDepthPct: depth.assignmentDepthPct,
    assignmentDepthClass: depth.assignmentDepthClass,
    assigned: getAssignedFlag(r) === true,
    cspYieldPct: round2(getCspYieldPct(r)),
    wouldAvoidAssignment: wouldAvoidAssignment(strike, close),
    observationSignature: observationSignature(r),
    expirationSignature: expirationSignature(r),
    strategyChoiceSignature: strategyChoiceSignature(r),
    tradeCandidateSignature: tradeCandidateSignature(r),
    selectedTradeSignature: selectedTradeSignature(r),
  };
}

function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells) => `| ${cells.map(esc).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map((r) => line(r))].join("\n");
}

function inflationRatio(obsCount, distinctExpCount) {
  if (!distinctExpCount) return null;
  return round2(obsCount / distinctExpCount);
}

function buildSignatureCounts(records) {
  return {
    observation_signature: countDistinct(records, observationSignature),
    expiration_signature: countDistinct(records, expirationSignature),
    strategy_choice_signature: countDistinct(records, strategyChoiceSignature),
    trade_candidate_signature: countDistinct(records, tradeCandidateSignature),
    selected_trade_count: countDistinct(records, selectedTradeSignature),
    raw_observation_count: records.length,
  };
}

function buildFocusTicker(ticker, allRecords, assignedEnriched) {
  const t = sym(ticker);
  const clean = allRecords.filter((r) => sym(r?.symbol ?? r?.ticker) === t && !isIntradayRetest(r));
  const resolved = clean.filter((r) => getResolvedFlag(r));
  const assigned = assignedEnriched.filter((e) => e.ticker === t);

  const sig = buildSignatureCounts(
    assigned.map((e) => ({
      symbol: e.ticker,
      selectedExpiration: e.selectedExpiration,
      expiration: e.expiration,
      scanSessionId: e.scanSessionId,
      dteAtScan: e.dte,
      strikeMode: e.mode === "SAFE" ? "safe" : e.mode === "AGGRESSIVE" ? "aggressive" : "other",
      strike: { strike: e.strike },
    })),
  );

  return {
    ticker: t,
    available: clean.length > 0,
    resolvedObservations: resolved.length,
    observationAssignedCount: assigned.length,
    distinctExpirationAssignedCount: sig.expiration_signature,
    distinctScanSessions: uniqSorted(assigned.map((e) => e.scanSessionId)).length,
    dtesInvolved: uniqSorted(assigned.map((e) => e.dte)),
    modesInvolved: uniqSorted(assigned.map((e) => e.mode)),
    strikesInvolved: uniqSorted(assigned.map((e) => e.strike)),
    inflationRatio: inflationRatio(assigned.length, sig.expiration_signature),
    signatures: sig,
  };
}

function buildSafeVsAggressive(assignedEnriched) {
  const groups = new Map();

  for (const e of assignedEnriched) {
    const key = `${e.ticker}|${e.expKey ?? "na"}|${e.dte ?? "na"}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ticker: e.ticker,
        selectedExpiration: e.selectedExpiration,
        expKey: e.expKey,
        dte: e.dte,
        closeAtExpiration: e.closeAtExpiration,
        safe: null,
        aggressive: null,
      });
    }
    const g = groups.get(key);
    if (e.closeAtExpiration != null) g.closeAtExpiration = e.closeAtExpiration;
    if (e.mode === "SAFE") g.safe = e;
    else if (e.mode === "AGGRESSIVE") g.aggressive = e;
  }

  const rows = [];
  for (const g of groups.values()) {
    const safe = g.safe;
    const agg = g.aggressive;
    const close = g.closeAtExpiration;

    let saferChoice = null;
    let higherYieldChoice = null;
    if (safe && agg) {
      if (safe.wouldAvoidAssignment && !agg.wouldAvoidAssignment) saferChoice = "SAFE";
      else if (agg.wouldAvoidAssignment && !safe.wouldAvoidAssignment) saferChoice = "AGGRESSIVE";
      else if (safe.wouldAvoidAssignment && agg.wouldAvoidAssignment) saferChoice = "BOTH_AVOID";
      else {
        const safeDepth = safe.strike != null && close != null ? round2(((safe.strike - close) / safe.strike) * 100) : null;
        const aggDepth = agg.strike != null && close != null ? round2(((agg.strike - close) / agg.strike) * 100) : null;
        if (safeDepth != null && aggDepth != null) {
          saferChoice = safeDepth < aggDepth ? "SAFE" : aggDepth < safeDepth ? "AGGRESSIVE" : "TIE";
        }
      }
      if (safe.cspYieldPct != null && agg.cspYieldPct != null) {
        higherYieldChoice =
          safe.cspYieldPct > agg.cspYieldPct ? "SAFE" : agg.cspYieldPct > safe.cspYieldPct ? "AGGRESSIVE" : "TIE";
      }
    } else if (safe) {
      saferChoice = safe.wouldAvoidAssignment ? "SAFE_ONLY_AVOIDS" : "SAFE_ONLY_ASSIGNED";
      higherYieldChoice = "SAFE_ONLY";
    } else if (agg) {
      saferChoice = agg.wouldAvoidAssignment ? "AGGRESSIVE_ONLY_AVOIDS" : "AGGRESSIVE_ONLY_ASSIGNED";
      higherYieldChoice = "AGGRESSIVE_ONLY";
    }

    rows.push({
      ticker: g.ticker,
      selectedExpiration: g.selectedExpiration,
      expKey: g.expKey,
      dte: g.dte,
      closeAtExpiration: close,
      safeAssigned: safe?.assigned ?? null,
      aggressiveAssigned: agg?.assigned ?? null,
      safeStrike: safe?.strike ?? null,
      aggressiveStrike: agg?.strike ?? null,
      safeYieldPct: safe?.cspYieldPct ?? null,
      aggressiveYieldPct: agg?.cspYieldPct ?? null,
      safeWouldAvoid: safe?.wouldAvoidAssignment ?? null,
      aggressiveWouldAvoid: agg?.wouldAvoidAssignment ?? null,
      saferChoice,
      higherYieldChoice,
      safeDepthClass: safe?.assignmentDepthClass ?? null,
      aggressiveDepthClass: agg?.assignmentDepthClass ?? null,
      note:
        safe && agg
          ? `Même expiration : SAFE strike ${safe.strike} vs AGRESSIF ${agg.strike} — rend. ${safe.cspYieldPct}% vs ${agg.cspYieldPct}%`
          : safe
            ? "Seulement SAFE assigné pour ce bucket DTE"
            : agg
              ? "Seulement AGRESSIF assigné pour ce bucket DTE"
              : "—",
    });
  }

  return rows.sort((a, b) => {
    const ta = a.ticker.localeCompare(b.ticker);
    if (ta !== 0) return ta;
    const ea = (a.expKey ?? "").localeCompare(b.expKey ?? "");
    if (ea !== 0) return ea;
    return (a.dte ?? 999) - (b.dte ?? 999);
  });
}

function buildDteBreakdown(assignedEnriched) {
  const byObs = {};
  const byExp = {};
  const otherObs = { count: 0, expirations: new Set() };

  for (const e of assignedEnriched) {
    const dte = e.dte;
    const bucket = DTE_BUCKETS.includes(dte) ? String(dte) : "autres";
    if (bucket === "autres") {
      otherObs.count += 1;
      if (e.expKey) otherObs.expirations.add(`${e.ticker}|${e.expKey}`);
      continue;
    }
    byObs[bucket] = (byObs[bucket] ?? 0) + 1;
    if (!byExp[bucket]) byExp[bucket] = new Set();
    byExp[bucket].add(expirationSignature({ symbol: e.ticker, selectedExpiration: e.selectedExpiration, expiration: e.expiration }));
  }

  const result = {};
  for (const d of [...DTE_BUCKETS.map(String), "autres"]) {
    result[d] = {
      byObservations: d === "autres" ? otherObs.count : (byObs[d] ?? 0),
      byDistinctExpirations: d === "autres" ? otherObs.expirations.size : (byExp[d]?.size ?? 0),
    };
  }
  return result;
}

function buildDteBreakdownByTicker(assignedEnriched, ticker) {
  const t = sym(ticker);
  const subset = assignedEnriched.filter((e) => e.ticker === t);
  return buildDteBreakdown(subset);
}

// ── chargement ──────────────────────────────────────────────────────────────
const store = makeStore();
const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];
const today = new Date().toISOString().slice(0, 10);

const assignedAll = records.filter((r) => getAssignedFlag(r) === true);
const assignedClean = assignedAll.filter((r) => !isIntradayRetest(r));
const assignedEnriched = assignedClean.map(enrichAssignedRecord);

// ── Q1 : focus tickers ───────────────────────────────────────────────────────
const focusTickers = FOCUS_TICKERS.map((t) => buildFocusTicker(t, records, assignedEnriched));

// ── Q2 : TQQQ détail ─────────────────────────────────────────────────────────
const tqqqDetail = assignedEnriched
  .filter((e) => e.ticker === "TQQQ")
  .sort((a, b) => {
    const ea = (a.expKey ?? "").localeCompare(b.expKey ?? "");
    if (ea !== 0) return ea;
    const da = (a.dte ?? 999) - (b.dte ?? 999);
    if (da !== 0) return da;
    return (a.mode ?? "").localeCompare(b.mode ?? "");
  });

const tqqqVerdict = (() => {
  const sig = buildSignatureCounts(
    tqqqDetail.map((e) => ({
      symbol: e.ticker,
      selectedExpiration: e.selectedExpiration,
      expiration: e.expiration,
      scanSessionId: e.scanSessionId,
      dteAtScan: e.dte,
      strikeMode: e.mode === "SAFE" ? "safe" : "aggressive",
      strike: { strike: e.strike },
    })),
  );
  return {
    observationAssignedCount: tqqqDetail.length,
    distinctExpirationAssignedCount: sig.expiration_signature,
    distinctStrategyChoices: sig.strategy_choice_signature,
    distinctTradeCandidates: sig.trade_candidate_signature,
    inflationRatio: inflationRatio(tqqqDetail.length, sig.expiration_signature),
    interpretation:
      sig.expiration_signature === 1
        ? `Les ${tqqqDetail.length} assignations observationnelles ne représentent qu'${sig.expiration_signature} expiration réelle distincte — duplication par SAFE/AGRESSIF/DTE/scan.`
        : `Les ${tqqqDetail.length} assignations couvrent ${sig.expiration_signature} expirations distinctes et ${sig.strategy_choice_signature} choix stratégiques (DTE×mode).`,
  };
})();

// ── Q3 : signatures globales ───────────────────────────────────────────────
const globalSignatures = buildSignatureCounts(assignedClean);

// Signatures par ticker (tous tickers avec assignations)
const signaturesByTicker = {};
for (const e of assignedEnriched) {
  signaturesByTicker[e.ticker] ??= [];
}
for (const r of assignedClean) {
  const t = sym(r?.symbol ?? r?.ticker);
  if (!signaturesByTicker[t]) signaturesByTicker[t] = [];
}
const tickerSignatureRows = Object.keys(signaturesByTicker)
  .sort((a, b) => {
    const ca = assignedEnriched.filter((e) => e.ticker === a).length;
    const cb = assignedEnriched.filter((e) => e.ticker === b).length;
    return cb - ca;
  })
  .map((ticker) => {
    const subset = assignedClean.filter((r) => sym(r?.symbol ?? r?.ticker) === ticker);
    const sig = buildSignatureCounts(subset);
    return {
      ticker,
      ...sig,
      inflationRatio: inflationRatio(sig.raw_observation_count, sig.expiration_signature),
    };
  });

// ── Q4 : inflation par focus ticker (déjà dans focusTickers) ────────────────

// ── Q5 : SAFE vs AGRESSIF ────────────────────────────────────────────────────
const safeVsAggressiveAll = buildSafeVsAggressive(assignedEnriched);
const safeVsAggressiveFocus = safeVsAggressiveAll.filter((r) => FOCUS_TICKERS.includes(r.ticker));

// ── Q6 : DTE ─────────────────────────────────────────────────────────────────
const dteGlobal = buildDteBreakdown(assignedEnriched);
const dteByFocusTicker = Object.fromEntries(
  FOCUS_TICKERS.map((t) => [t, buildDteBreakdownByTicker(assignedEnriched, t)]),
);

// ── Q7 / Q8 : recommandations ────────────────────────────────────────────────
const recommendations = {
  futureMetrics: [
    {
      id: "observation_count",
      label: "observation_count",
      use: "Comparer les variantes SAFE/AGRESSIF/DTE sur le même scan — utile pour la recherche de formule.",
      denominator: "Chaque record résolu (mode × DTE × strike × scanSession).",
    },
    {
      id: "expiration_count",
      label: "expiration_count",
      use: "Mesurer le risque réel par événement d'expiration — 1 ticker × 1 selectedExpiration.",
      denominator: "Événements d'expiration distincts assignés.",
    },
    {
      id: "strategy_choice_count",
      label: "strategy_choice_count",
      use: "Comparer quel DTE/mode performe — ticker × expiration × DTE × mode.",
      denominator: "Choix stratégiques distincts (sans distinguer le strike si mode fixe le strike).",
    },
    {
      id: "trade_candidate_count",
      label: "trade_candidate_count",
      use: "Comparer les strikes candidats pour un DTE donné — ticker × expiration × DTE × strike.",
      denominator: "Candidats de trade distincts.",
    },
    {
      id: "selected_trade_count",
      label: "selected_trade_count",
      use: "Simulation réaliste : 1 contrat choisi par expiration — le dénominateur le plus proche d'une décision humaine.",
      denominator: "1 par ticker × selectedExpiration (choix unique implicite).",
    },
  ],
  recommendedPrimaryMetric:
    "Pour le Journal POP orienté décision : afficher selected_trade_count (expirations assignées) comme métrique principale, et observation_count comme métrique secondaire « variantes testées ».",
  j4cUi: [
    {
      id: "obs-assignations",
      label: "Assignations observationnelles",
      priority: "haute",
      text: "Afficher explicitement le nombre de records assignés (SAFE + AGRESSIF + DTE) avec libellé « observationnel » pour éviter la confusion avec des trades réels.",
    },
    {
      id: "exp-assignees",
      label: "Expirations assignées",
      priority: "haute",
      text: "Ajouter le compteur distinct ticker×selectedExpiration — c'est le vrai nombre d'événements de risque.",
    },
    {
      id: "ratio-duplication",
      label: "Ratio de duplication",
      priority: "haute",
      text: "Montrer inflationRatio = observations / expirations (ex. TQQQ 6/1 = 6.0×) pour signaler le double-comptage stratégique.",
    },
    {
      id: "safe-aurait-evite",
      label: "SAFE aurait évité ?",
      priority: "moyenne",
      text: "Pour chaque expiration assignée en AGRESSIF, indiquer si le strike SAFE du même DTE/scan aurait évité l'assignation (close ≥ strike SAFE).",
    },
    {
      id: "agressif-valait-risque",
      label: "AGRESSIF valait le risque ?",
      priority: "moyenne",
      text: "Comparer rendement CSP AGRESSIF vs profondeur d'assignation — badge si prime plus élevée mais assignation plus profonde que SAFE.",
    },
    {
      id: "dte-dual-view",
      label: "DTE : observations vs expirations",
      priority: "moyenne",
      text: "Dans le breakdown DTE, afficher deux colonnes : par observations ET par expirations distinctes (corrige l'ambiguïté J4-A/Q7).",
    },
  ],
};

const globalInflation = inflationRatio(assignedEnriched.length, globalSignatures.expiration_signature);

const verdict = {
  global: `${assignedEnriched.length} assignations observationnelles (hors retests intraday) ne représentent que ${globalSignatures.expiration_signature} expirations distinctes assignées (ratio ${globalInflation}×). Le Journal POP additionne actuellement des variantes SAFE/AGRESSIF/DTE/scan comme si chacune était un trade distinct — ce qui gonfle artificiellement les taux d'assignation par ticker.`,
  tqqq:
    tqqqVerdict.interpretation +
    ` Ratio duplication TQQQ : ${tqqqVerdict.inflationRatio}× (${tqqqVerdict.observationAssignedCount} obs / ${tqqqVerdict.distinctExpirationAssignedCount} exp).`,
  implication:
    "Pour juger si SAFE > AGRESSIF ou quel DTE est meilleur, utiliser strategy_choice_count. Pour simuler un trader qui ne vend qu'un put par expiration, utiliser selected_trade_count (= expiration_count).",
};

// ── payload ─────────────────────────────────────────────────────────────────
const auditPayload = {
  generatedAt: new Date().toISOString(),
  phase: "Journal POP J4-B — audit observations vs décisions (lecture seule)",
  readOnly: true,
  noProductionChanges: true,
  source: {
    journal: store.sqlitePath ?? "JSON wheelValidationStore",
    totalRecords: records.length,
    assignedAllRaw: assignedAll.length,
    assignedCleanNoIntradayRetest: assignedEnriched.length,
    excludedIntradayRetest: assignedAll.length - assignedEnriched.length,
    today,
  },
  definitions: {
    observation_signature: "ticker + selectedExpiration + scanSessionId + DTE + mode + strike",
    expiration_signature: "ticker + selectedExpiration",
    strategy_choice_signature: "ticker + selectedExpiration + DTE + mode",
    trade_candidate_signature: "ticker + selectedExpiration + DTE + strike",
    selected_trade_count: "alias expiration_signature — 1 contrat choisi par expiration",
    inflationRatio: "observationAssignedCount / distinctExpirationAssignedCount",
    filter: "assignations avec assigned_flag=true, hors captureClass=intradayRetest",
  },
  q1_focusTickers: focusTickers,
  q2_tqqqDetail: {
    rows: tqqqDetail,
    verdict: tqqqVerdict,
  },
  q3_signatureComparison: {
    global: globalSignatures,
    byTickerTop20: tickerSignatureRows.slice(0, 20),
    focusTickers: focusTickers.map((f) => ({
      ticker: f.ticker,
      signatures: f.signatures,
      inflationRatio: f.inflationRatio,
    })),
  },
  q4_inflationByFocusTicker: focusTickers.map((f) => ({
    ticker: f.ticker,
    observationAssignedCount: f.observationAssignedCount,
    distinctExpirationAssignedCount: f.distinctExpirationAssignedCount,
    inflationRatio: f.inflationRatio,
  })),
  q5_safeVsAggressive: {
    focus: safeVsAggressiveFocus,
    allCount: safeVsAggressiveAll.length,
  },
  q6_dteBreakdown: {
    global: dteGlobal,
    byFocusTicker: dteByFocusTicker,
  },
  q7_recommendedMetrics: recommendations.futureMetrics,
  q8_j4cRecommendations: recommendations.j4cUi,
  recommendations,
  verdict,
};

fs.writeFileSync(OUT_JSON, JSON.stringify(auditPayload, null, 2), "utf8");

// ── Markdown ─────────────────────────────────────────────────────────────────
const md = [];
md.push("# Audit J4-B — Observations vs décisions réelles (Journal POP)");
md.push("");
md.push(
  `> **Lecture seule** — généré le ${auditPayload.generatedAt.slice(0, 19)} · ${records.length} records · ${assignedEnriched.length} assignations observationnelles`,
);
md.push(`> Source : \`${auditPayload.source.journal}\``);
md.push("");

md.push("## Verdict global");
md.push("");
md.push(`**${verdict.global}**`);
md.push("");
md.push(`- TQQQ : ${verdict.tqqq}`);
md.push(`- Implication : ${verdict.implication}`);
md.push("");

md.push("## Définitions des signatures");
md.push("");
md.push("| Signature | Clé | Usage |");
md.push("| --- | --- | --- |");
md.push("| A. observation_signature | ticker + selExp + scanSessionId + DTE + mode + strike | Variante complète d'observation |");
md.push("| B. expiration_signature | ticker + selectedExpiration | Événement d'expiration réel |");
md.push("| C. strategy_choice_signature | ticker + selExp + DTE + mode | Choix stratégique DTE/mode |");
md.push("| D. trade_candidate_signature | ticker + selExp + DTE + strike | Candidat de trade concret |");
md.push("| selected_trade_count | = expiration_signature | 1 contrat par expiration (simulation réaliste) |");
md.push("");

md.push("## 1. Tickers focus");
md.push("");
md.push(
  mdTable(
    [
      "Ticker",
      "Obs. résolues",
      "Obs. assignées",
      "Exp. distinctes",
      "Sessions scan",
      "DTE",
      "Modes",
      "Strikes",
      "Ratio dup.",
    ],
    focusTickers.map((f) => [
      f.ticker + (f.available ? "" : " (absent)"),
      f.resolvedObservations,
      f.observationAssignedCount,
      f.distinctExpirationAssignedCount,
      f.distinctScanSessions,
      f.dtesInvolved.join(", ") || "—",
      f.modesInvolved.join(", ") || "—",
      f.strikesInvolved.join(", ") || "—",
      f.inflationRatio ?? "—",
    ]),
  ),
);
md.push("");

md.push("## 2. TQQQ — détail des assignations observationnelles");
md.push("");
md.push(`**${tqqqVerdict.interpretation}**`);
md.push("");
md.push(`- Observations assignées : **${tqqqVerdict.observationAssignedCount}**`);
md.push(`- Expirations distinctes : **${tqqqVerdict.distinctExpirationAssignedCount}**`);
md.push(`- Choix stratégiques (DTE×mode) : **${tqqqVerdict.distinctStrategyChoices}**`);
md.push(`- Candidats trade (DTE×strike) : **${tqqqVerdict.distinctTradeCandidates}**`);
md.push(`- Ratio duplication : **${tqqqVerdict.inflationRatio}×**`);
md.push("");
md.push(
  mdTable(
    [
      "selExp",
      "expiration",
      "scanDate",
      "scanSessionId",
      "DTE",
      "mode",
      "strike",
      "close",
      "depth%",
      "depth",
      "assigned",
      "rend.%",
    ],
    tqqqDetail.map((e) => [
      e.selectedExpiration,
      e.expiration,
      e.scanDate,
      e.scanSessionId ? String(e.scanSessionId).slice(0, 12) : "—",
      e.dte,
      e.mode,
      e.strike,
      e.closeAtExpiration,
      e.assignmentDepthPct,
      e.assignmentDepthClass,
      e.assigned ? "oui" : "non",
      e.cspYieldPct,
    ]),
  ),
);
md.push("");

md.push("## 3. Comparaison des signatures");
md.push("");
md.push("### Global");
md.push("");
md.push(
  mdTable(
    ["Métrique", "Count"],
    [
      ["observation_signature (A)", globalSignatures.observation_signature],
      ["expiration_signature (B)", globalSignatures.expiration_signature],
      ["strategy_choice_signature (C)", globalSignatures.strategy_choice_signature],
      ["trade_candidate_signature (D)", globalSignatures.trade_candidate_signature],
      ["selected_trade_count", globalSignatures.selected_trade_count],
      ["raw observation count", globalSignatures.raw_observation_count],
    ],
  ),
);
md.push("");
md.push("### Focus tickers");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Obs (A)", "Exp (B)", "Stratégie (C)", "Candidat (D)", "Trade choisi", "Ratio"],
    focusTickers.map((f) => [
      f.ticker,
      f.signatures.observation_signature,
      f.signatures.expiration_signature,
      f.signatures.strategy_choice_signature,
      f.signatures.trade_candidate_signature,
      f.signatures.selected_trade_count,
      f.inflationRatio,
    ]),
  ),
);
md.push("");

md.push("## 4. Ratio de duplication (inflationRatio)");
md.push("");
md.push(
  mdTable(
    ["Ticker", "observationAssignedCount", "distinctExpirationAssignedCount", "inflationRatio"],
    focusTickers.map((f) => [
      f.ticker,
      f.observationAssignedCount,
      f.distinctExpirationAssignedCount,
      f.inflationRatio,
    ]),
  ),
);
md.push("");
md.push(`**Global** : ${assignedEnriched.length} / ${globalSignatures.expiration_signature} = **${globalInflation}×**`);
md.push("");

md.push("## 5. SAFE vs AGRESSIF (focus tickers)");
md.push("");
md.push(
  "Pour chaque ticker × selectedExpiration × DTE : comparer si SAFE ou AGRESSIF aurait évité l'assignation et lequel payait plus.",
);
md.push("");
md.push(
  mdTable(
    [
      "Ticker",
      "selExp",
      "DTE",
      "close",
      "SAFE?",
      "AGG?",
      "strike SAFE",
      "strike AGG",
      "rend SAFE%",
      "rend AGG%",
      "SAFE évite?",
      "AGG évite?",
      "plus sûr",
      "plus payant",
    ],
    safeVsAggressiveFocus.map((r) => [
      r.ticker,
      r.selectedExpiration ?? r.expKey,
      r.dte,
      r.closeAtExpiration,
      r.safeAssigned == null ? "—" : r.safeAssigned ? "oui" : "non",
      r.aggressiveAssigned == null ? "—" : r.aggressiveAssigned ? "oui" : "non",
      r.safeStrike,
      r.aggressiveStrike,
      r.safeYieldPct,
      r.aggressiveYieldPct,
      r.safeWouldAvoid == null ? "—" : r.safeWouldAvoid ? "oui" : "non",
      r.aggressiveWouldAvoid == null ? "—" : r.aggressiveWouldAvoid ? "oui" : "non",
      r.saferChoice,
      r.higherYieldChoice,
    ]),
  ),
);
md.push("");

md.push("## 6. DTE — observations vs expirations distinctes");
md.push("");
md.push("### Global");
md.push("");
md.push(
  mdTable(
    ["DTE", "Par observations", "Par expirations distinctes"],
    Object.entries(dteGlobal).map(([dte, v]) => [dte, v.byObservations, v.byDistinctExpirations]),
  ),
);
md.push("");
md.push("### Par ticker focus");
md.push("");
for (const t of FOCUS_TICKERS) {
  const d = dteByFocusTicker[t];
  const hasData = Object.values(d).some((v) => v.byObservations > 0);
  if (!hasData) continue;
  md.push(`#### ${t}`);
  md.push("");
  md.push(
    mdTable(
      ["DTE", "Observations", "Expirations distinctes"],
      Object.entries(d).map(([dte, v]) => [dte, v.byObservations, v.byDistinctExpirations]),
    ),
  );
  md.push("");
}

md.push("## 7. Métriques futures recommandées");
md.push("");
for (const m of recommendations.futureMetrics) {
  md.push(`- **${m.label}** — ${m.use} (${m.denominator})`);
}
md.push("");
md.push(`> **Recommandation principale** : ${recommendations.recommendedPrimaryMetric}`);
md.push("");

md.push("## 8. Recommandations J4-C (UI)");
md.push("");
md.push("| Élément UI | Priorité | Description |");
md.push("| --- | --- | --- |");
for (const r of recommendations.j4cUi) {
  md.push(`| ${r.label} | ${r.priority} | ${r.text} |`);
}
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ───────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  AUDIT J4-B READ-ONLY — Observations vs décisions Journal POP");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Source : ${auditPayload.source.journal}`);
console.log(`  Records : ${records.length} · assignations obs. : ${assignedEnriched.length}`);
console.log(`  Expirations distinctes : ${globalSignatures.expiration_signature} · ratio global : ${globalInflation}×`);
console.log("");
console.log("── SIGNATURES GLOBALES ────────────────────────────────────────────────");
console.log(`  A observation    : ${globalSignatures.observation_signature}`);
console.log(`  B expiration     : ${globalSignatures.expiration_signature}`);
console.log(`  C strategy choice: ${globalSignatures.strategy_choice_signature}`);
console.log(`  D trade candidate: ${globalSignatures.trade_candidate_signature}`);
console.log("");
console.log("── FOCUS TICKERS ──────────────────────────────────────────────────────");
for (const f of focusTickers) {
  if (!f.available) {
    console.log(`  ${f.ticker.padEnd(6)} ABSENT`);
    continue;
  }
  console.log(
    `  ${f.ticker.padEnd(6)} résolus=${String(f.resolvedObservations).padStart(3)} obs.assign=${String(f.observationAssignedCount).padStart(2)} exp.dist=${String(f.distinctExpirationAssignedCount).padStart(2)} ratio=${f.inflationRatio ?? "—"}×`,
  );
}
console.log("");
console.log("── TQQQ ───────────────────────────────────────────────────────────────");
console.log(`  ${tqqqVerdict.interpretation}`);
console.log(`  ${tqqqDetail.length} lignes détaillées dans le rapport`);
console.log("");
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
