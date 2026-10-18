#!/usr/bin/env node
/**
 * SIMULATION READ-ONLY — Variante E2b : micro-test bonus historique robuste renforcé.
 * ----------------------------------------------------------------
 * Compare E2 (+5, +2 optionnel) vs E2b (+8, +3 optionnel) sur les tickers cibles.
 * NE MODIFIE NI le moteur, NI la base, NI le Pine, NI crypto-block.
 *
 * Livrables :
 *   debug/top20-formula-e2b-robust-history-simulation.md
 *   debug/top20-formula-e2b-robust-history-simulation.json
 *
 * Aucun git add / commit.
 */

import { writeFileSync } from "node:fs";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import {
  createWheelValidationService,
  computeOnePercentWheelProfiles,
  classifyAssignmentDepth,
} from "../app/journal/wheelValidationService.js";

// ───────────────────────────── helpers ───────────────────────────────────────
const nsym = (v) => String(v ?? "").trim().toUpperCase();
const ymd = (v) => {
  const c = String(v ?? "").trim().replace(/-/g, "");
  return /^\d{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : null;
};
const getResolved = (r) => (r?.resolution?.resolved ?? r?.resolved) === true;
const getAssigned = (r) => r?.resolution?.assigned === true || r?.assigned === true || r?.assigned === 1;
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const numberOrNull = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const TARGETS = [
  "TQQQ", "APLD", "INTC", "AFRM", "IONQ", "SOFI", "SMCI", "OKLO", "TEM", "MP",
  "CDE", "GDX", "SLV", "RIVN", "GM", "U", "BNO", "DAL", "HPE", "FCX",
];

const DTE_TARGETS = [2, 3, 4, 7];
const EXPLOITABLE_MIN_SCORE = 35;
const EXPLOITABLE_MIN_N = 10;
const STRESS_KRACH_EXP = "2026-06-05";

const BUCKET_LABELS = {
  top20: "Top 20",
  nearEntry: "Proches d'entrer",
  watchValidate: "À surveiller",
  low_or_excluded: "Bas/exclus",
  excluded_hard: "Exclu (risque confirmé)",
  excluded_crypto: "Exclu (crypto)",
};

// ───────────────────────────── variant configs ───────────────────────────────
const VARIANT_E = {
  id: "E",
  key: "hybridRecommended",
  label: "Hybride recommandée",
  description: "Mélange B (structure) + C (LB réduit APLD) + D (résilience krach) + garde-fous A.",
  meritWeights: { win: 1.12, yield: 1.2, lowAssign: 1.05, lbHeld: 1.12, stability: 1.05, sample: 1.0, shortDte: 1.0 },
  resilWeights: { stressSurvival: 1.25, winMaintained: 1.2, lbHeldUnderStress: 1.25 },
  resilCap: 30,
  deepExpsPenalties: { 1: -6, 2: -22, 3: -36 },
  winPenalties: { 50: -30, 70: -22, 75: -14, 80: -7 },
  lbPenalties: { avec_stress: -10, critique: -20 },
  assignPenalties: { 20: -10, 30: -17, 40: -26 },
  deepRatePenalty: -6,
  lbCritiqueReduced: true,
  lbCritiqueReducedValue: -12,
  stressKrachMultiplier: 1.25,
  stressKrachLbBonus: 5,
  hardExcludeStrict: true,
  robustHistoryBonus: false,
  robustHistoryBaseBonus: 0,
  robustHistoryExtraBonus: 0,
};

const VARIANT_E2 = {
  ...VARIANT_E,
  id: "E2",
  key: "hybridE2RobustHistory",
  label: "Hybride E2 / historique robuste",
  description: "Variante E + bonus contrôlé (+5, +2 optionnel) pour tickers à historique robuste et risque événement unique.",
  robustHistoryBonus: true,
  robustHistoryBaseBonus: 5,
  robustHistoryExtraBonus: 2,
};

const VARIANT_E2B = {
  ...VARIANT_E2,
  id: "E2b",
  key: "hybridE2bRobustHistory",
  label: "Hybride E2b / historique robuste renforcé",
  description: "Variante E2 + bonus renforcé (+8, +3 optionnel) — micro-test pour faire entrer TQQQ Top 20.",
  robustHistoryBaseBonus: 8,
  robustHistoryExtraBonus: 3,
};

// ───────────────────────────── event uniqueness (réplique panel) ───────────────
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

function computeTickerEventUniqueness(ticker, records) {
  const t = nsym(ticker);
  const eligible = records.filter((r) => {
    const sym = nsym(r?.symbol ?? r?.ticker);
    const dte = numberOrNull(r?.dteAtScan);
    return sym === t && DTE_TARGETS.includes(dte) && getResolved(r) && (r?.captureClass ?? "primaryDaily") !== "intradayRetest";
  });
  const totalN = eligible.length;
  const assigned = eligible.filter((r) => assignedFlag(r) === true);
  const deep = assigned.filter((r) => depthClass(r) === "profonde");
  const distinctAsg = new Set(assigned.map(expKey).filter(Boolean));
  const distinctDeep = new Set(deep.map(expKey).filter(Boolean));
  let conc = null;
  if (assigned.length) {
    const c = {};
    for (const r of assigned) { const k = expKey(r) ?? "?"; c[k] = (c[k] ?? 0) + 1; }
    conc = (Math.max(...Object.values(c)) / assigned.length) * 100;
  }
  const assignmentRate = totalN ? (assigned.length / totalN) * 100 : null;
  return {
    totalN,
    assignmentRate,
    distinctAssignedExpirationCount: distinctAsg.size,
    distinctDeepAssignmentExpirationCount: distinctDeep.size,
    assignmentConcentrationPct: conc,
    confirmedRepeatedRisk: (() => {
      const multiDeep = distinctDeep.size >= 2;
      const multiAssignHigh = (assignmentRate ?? 0) > 20 && distinctAsg.size >= 2;
      return multiDeep || multiAssignHigh;
    })(),
  };
}

function computeRobustHistoryBonus(profile, uniqueness, cryptoExcluded, hardExclude, bonusCfg) {
  const ticker = nsym(profile?.ticker);
  const n = profile?.csp?.recordsResolved ?? 0;
  const win = profile?.csp?.realWinRate;
  const assign = profile?.csp?.assignmentRate;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const baseAmount = bonusCfg?.baseBonus ?? 5;
  const extraAmount = bonusCfg?.extraBonus ?? 2;

  const reasons = [];
  const blocked = [];

  if (cryptoExcluded.has(ticker)) blocked.push("crypto bloqué");
  if (hardExclude.length > 0) blocked.push("exclusion dure");
  if (n < 30) blocked.push(`n=${n} < 30`);
  if (win == null || win < 85) blocked.push(`win ${win ?? "—"} % < 85 %`);
  if (assign != null && assign > 25) blocked.push(`assignation ${assign} % > 25 %`);
  if (lbClass === "critique" && (win == null || win < 85)) blocked.push("LB critique + win < 85 %");
  if (uniqueness.distinctDeepAssignmentExpirationCount !== 1) {
    blocked.push(`${uniqueness.distinctDeepAssignmentExpirationCount} exp. profondes distinctes (≠ 1)`);
  }
  const assignConcentrated =
    uniqueness.distinctAssignedExpirationCount <= 1 ||
    (uniqueness.assignmentConcentrationPct != null && uniqueness.assignmentConcentrationPct >= 99.9);
  if (!assignConcentrated) {
    blocked.push(`assignation sur ${uniqueness.distinctAssignedExpirationCount} expirations distinctes`);
  }
  if (uniqueness.confirmedRepeatedRisk) blocked.push("risque confirmé répété");

  if (blocked.length) {
    return { bonus: 0, baseBonus: 0, extraBonus: 0, eligible: false, blocked, reasons: blocked.join(" · ") };
  }

  let baseBonus = baseAmount;
  let extraBonus = 0;
  if (n >= 45 && win >= 85) {
    extraBonus = extraAmount;
    reasons.push(`+${baseAmount} base historique robuste`);
    reasons.push(`+${extraAmount} échantillon large (n≥45, win≥85 %)`);
  } else {
    reasons.push(`+${baseAmount} base historique robuste (n≥30, win≥85 %, 1 exp. profonde, risque événement unique)`);
  }

  return {
    bonus: baseBonus + extraBonus,
    baseBonus,
    extraBonus,
    eligible: true,
    blocked: [],
    reasons: reasons.join(" · "),
  };
}

// ───────────────────────────── data load ───────────────────────────────────────
const store = createWheelValidationStoreSqlite();
const service = createWheelValidationService({ store });
const todayYmd = new Date().toISOString().slice(0, 10);

const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];

const rawProfiles = computeOnePercentWheelProfiles(records, []);
const tickerProfiles = (Array.isArray(rawProfiles) ? rawProfiles : (rawProfiles?.profiles ?? []))
  .filter((p) => p?.groupType === "ticker");

const engine = await service.computeDynamicTop20WheelProfiles();
const engineRowByTicker = new Map();
const bucketOf = [
  ["top20", engine.top20], ["nearEntry", engine.nearEntry], ["watchValidate", engine.watchValidate],
  ["stressed", engine.stressed], ["excludedHighYield", engine.excludedHighYield],
  ["insufficientSample", engine.insufficientSample], ["excludedCrypto", engine.excludedCrypto],
];
for (const [bucket, rows] of bucketOf) {
  for (const r of rows || []) {
    if (!engineRowByTicker.has(nsym(r.ticker))) engineRowByTicker.set(nsym(r.ticker), { ...r, bucket });
  }
}

const eventUniquenessByTicker = new Map();
for (const p of tickerProfiles) {
  const t = nsym(p.ticker);
  eventUniquenessByTicker.set(t, computeTickerEventUniqueness(t, records));
}

const byTickerExp = new Map();
for (const r of records) {
  if (!getResolved(r)) continue;
  if ((r?.captureClass ?? "primaryDaily") === "intradayRetest") continue;
  const exp = ymd(r?.expiration ?? r?.expirationCohort);
  if (!exp || exp >= todayYmd) continue;
  const t = nsym(r?.symbol ?? r?.ticker);
  if (!t) continue;
  if (!byTickerExp.has(t)) byTickerExp.set(t, new Map());
  const m = byTickerExp.get(t);
  if (!m.has(exp)) m.set(exp, { n: 0, assigned: 0, deep: 0 });
  const cell = m.get(exp);
  cell.n += 1;
  if (getAssigned(r)) {
    cell.assigned += 1;
    if (classifyAssignmentDepth(r).assignmentDepthClass === "profonde") cell.deep += 1;
  }
}

const expAgg = new Map();
for (const m of byTickerExp.values()) {
  for (const [exp, c] of m) {
    if (!expAgg.has(exp)) expAgg.set(exp, { n: 0, assigned: 0, deep: 0 });
    const a = expAgg.get(exp);
    a.n += c.n; a.assigned += c.assigned; a.deep += c.deep;
  }
}
const expStress = new Map();
for (const [exp, a] of expAgg) {
  const assignedPct = a.n ? (a.assigned / a.n) * 100 : 0;
  const deepOfAssignedPct = a.assigned ? (a.deep / a.assigned) * 100 : 0;
  let weight = 0, tier = "none";
  if (assignedPct >= 45) { weight = 1.0; tier = "severe"; }
  else if (assignedPct >= 25) { weight = 0.5; tier = "moderate"; }
  else if (assignedPct >= 15) { weight = 0.25; tier = "mild"; }
  expStress.set(exp, { assignedPct: round1(assignedPct), deepOfAssignedPct: round1(deepOfAssignedPct), weight, tier });
}

function resilienceProfile(ticker, profile) {
  const m = byTickerExp.get(ticker) ?? new Map();
  const win = profile?.csp?.realWinRate;
  const exps = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalExps = exps.length;
  const deepExps = exps.filter(([, c]) => c.deep > 0).length;
  const cleanExps = exps.filter(([, c]) => c.deep === 0 && (c.n ? c.assigned / c.n : 0) <= 0.34).length;

  const perStress = [];
  let krachSurvived = false;
  let krachLbHeld = false;
  for (const [exp, c] of exps) {
    const s = expStress.get(exp);
    if (!s || s.weight === 0) continue;
    const assignedPct = c.n ? (c.assigned / c.n) * 100 : 0;
    let bonus = 0, kind = null;
    if (c.assigned === 0) {
      bonus = s.tier === "severe" ? 10 : s.tier === "moderate" ? 6 : 4;
      kind = "non_assigné_pendant_stress";
      if (exp === STRESS_KRACH_EXP) krachSurvived = true;
    } else if (c.deep === 0 && assignedPct <= 50 && win != null && win >= 70) {
      bonus = s.tier === "severe" ? 5 : 3;
      kind = "assigné_mais_contenu";
    }
    if (exp === STRESS_KRACH_EXP && c.assigned === 0) krachLbHeld = true;
    const marketDeep = s.deepOfAssignedPct ?? 0;
    const tickerDeep = c.assigned ? (c.deep / c.assigned) * 100 : 0;
    perStress.push({
      expiration: exp, tier: s.tier, marketAssignedPct: s.assignedPct,
      ticker_n: c.n, ticker_assigned: c.assigned, ticker_deep: c.deep,
      ticker_assignedPct: round1(assignedPct), ticker_deepOfAssignedPct: round1(tickerDeep),
      marketDeepOfAssignedPct: marketDeep, relativeDeepDelta: round1(tickerDeep - marketDeep),
      bonus, kind,
    });
  }
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  if (krachSurvived && (lbClass === "sans_dommage" || lbClass === "none" || lbClass === "non_problématique")) {
    krachLbHeld = true;
  }
  return { totalExps, deepExps, cleanExps, perStress, krachSurvived, krachLbHeld };
}

function meritWin(win) {
  if (win == null) return 0;
  if (win >= 95) return 25;
  if (win >= 90) return 22;
  if (win >= 85) return 18;
  if (win >= 80) return 14;
  if (win >= 75) return 8;
  if (win >= 70) return 3;
  return 0;
}
function meritYield(yld) {
  if (yld == null) return 0;
  if (yld >= 1.1) return 20;
  if (yld >= 1.0) return 18;
  if (yld >= 0.9) return 15;
  if (yld >= 0.8) return 11;
  if (yld >= 0.7) return 6;
  if (yld >= 0.6) return 3;
  return 0;
}
function meritLowAssign(assign) {
  if (assign == null) return 0;
  if (assign === 0) return 15;
  if (assign <= 5) return 12;
  if (assign <= 10) return 9;
  if (assign <= 15) return 6;
  if (assign <= 20) return 3;
  return 0;
}
function meritLbHeld(lbClass) {
  if (lbClass === "sans_dommage") return 15;
  if (lbClass === "none" || lbClass === "non_problématique") return 12;
  if (lbClass === "non_determinant") return 6;
  return 0;
}

function variantScore(profile, cfg, cryptoExcluded) {
  const ticker = nsym(profile?.ticker);
  const n = profile?.csp?.recordsResolved ?? 0;
  const win = profile?.csp?.realWinRate;
  const yld = profile?.csp?.avgYieldPct;
  const assign = profile?.csp?.assignmentRate;
  const touch = profile?.csp?.strikeTouchRate;
  const lbClass = profile?.lowerBoundStress?.lbStressClass ?? "none";
  const profonde = profile?.assignment?.profondeRatePct;
  const res = resilienceProfile(ticker, profile);
  const mw = cfg.meritWeights;

  const merit = {};
  const resil = {};
  const pen = {};
  const bonus = {};

  merit.win = Math.round(meritWin(win) * mw.win);
  merit.yield = Math.round(meritYield(yld) * mw.yield);
  merit.lowAssign = Math.round(meritLowAssign(assign) * mw.lowAssign);
  merit.lbHeld = Math.round(meritLbHeld(lbClass) * mw.lbHeld);
  if (res.totalExps >= 3) merit.stability = Math.round(10 * (res.cleanExps / res.totalExps) * mw.stability);
  else if (res.totalExps === 2) merit.stability = Math.round(6 * (res.cleanExps / res.totalExps) * mw.stability);
  else merit.stability = 0;
  merit.sample = Math.round((n >= 50 ? 10 : n >= 30 ? 8 : n >= 20 ? 6 : n >= 15 ? 4 : n >= 10 ? 2 : n >= 5 ? 1 : 0) * mw.sample);
  if (touch != null) merit.shortDte = Math.round((touch <= 20 ? 5 : touch <= 30 ? 2 : 0) * mw.shortDte);

  let resBonus = 0;
  for (const s of res.perStress) {
    let b = s.bonus;
    if (s.expiration === STRESS_KRACH_EXP && cfg.stressKrachMultiplier) {
      b = Math.round(b * cfg.stressKrachMultiplier);
    }
    resBonus += b;
  }
  resil.stressSurvival = Math.round(resBonus * (cfg.resilWeights.stressSurvival ?? 1));
  if (win != null && win >= 85 && res.perStress.length > 0) {
    resil.winMaintained = Math.round(5 * (cfg.resilWeights.winMaintained ?? 1));
  }
  if ((lbClass === "sans_dommage" || lbClass === "none" || lbClass === "non_problématique")
      && res.perStress.some((s) => s.tier === "severe")) {
    resil.lbHeldUnderStress = Math.round(5 * (cfg.resilWeights.lbHeldUnderStress ?? 1));
  }
  if (cfg.stressKrachLbBonus && res.krachLbHeld) {
    resil.krachLbHeld = cfg.stressKrachLbBonus;
  }
  let resilTotal = Object.values(resil).reduce((a, b) => a + b, 0);
  if (resilTotal > cfg.resilCap) {
    resil._cap = cfg.resilCap - resilTotal;
    resilTotal = cfg.resilCap;
  }

  const dp = cfg.deepExpsPenalties;
  if (res.deepExps === 1) pen.deepExps = dp[1];
  else if (res.deepExps === 2) pen.deepExps = dp[2];
  else if (res.deepExps >= 3) pen.deepExps = dp[3];

  const wp = cfg.winPenalties;
  if (win != null) {
    if (win < 50) pen.win = wp[50];
    else if (win < 70) pen.win = wp[70];
    else if (win < 75) pen.win = wp[75];
    else if (win < 80) pen.win = wp[80];
  }

  const lp = cfg.lbPenalties;
  if (lbClass === "avec_stress") pen.lb = lp.avec_stress;
  else if (lbClass === "critique") {
    if (cfg.lbCritiqueReduced && win != null && win >= 85 && res.deepExps === 1) {
      pen.lb = cfg.lbCritiqueReducedValue;
      pen.lbNote = "LB critique réduit (win≥85 %, 1 exp profonde)";
    } else {
      pen.lb = lp.critique;
    }
  }

  const ap = cfg.assignPenalties;
  if (assign != null) {
    if (assign > 40) pen.assign = ap[40];
    else if (assign > 30) pen.assign = ap[30];
    else if (assign > 20) pen.assign = ap[20];
  }
  if (profonde != null && profonde >= 50 && res.deepExps >= 1) pen.deepRate = cfg.deepRatePenalty;

  const meritTotal = Object.values(merit).reduce((a, b) => a + b, 0);
  const penTotal = Object.values(pen).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);

  const hardExclude = [];
  if (lbClass === "critique" && (res.deepExps >= 2 || (win != null && win < 70) || (assign != null && assign > 35))) {
    hardExclude.push("Risque confirmé répété : LB critique + (≥2 expirations profondes ou win<70 % ou assignation>35 %)");
  }
  if (cfg.hardExcludeStrict && lbClass === "critique" && res.deepExps >= 1 && win != null && win < 80 && assign != null && assign > 25) {
    hardExclude.push("Garde-fou défensif : LB critique + assignation>25 % + win<80 %");
  }
  if (n === 0 || profile?.csp == null) hardExclude.push("Données critiques absentes");

  let robustBonus = { bonus: 0, baseBonus: 0, extraBonus: 0, eligible: false, blocked: [], reasons: "—" };
  if (cfg.robustHistoryBonus) {
    const uniqueness = eventUniquenessByTicker.get(ticker) ?? {
      distinctAssignedExpirationCount: 0,
      distinctDeepAssignmentExpirationCount: 0,
      assignmentConcentrationPct: null,
      confirmedRepeatedRisk: false,
    };
    robustBonus = computeRobustHistoryBonus(profile, uniqueness, cryptoExcluded, hardExclude, {
      baseBonus: cfg.robustHistoryBaseBonus,
      extraBonus: cfg.robustHistoryExtraBonus,
    });
    if (robustBonus.bonus > 0) bonus.robustHistory = robustBonus.bonus;
  }

  let scoreBeforeCap = meritTotal + resilTotal + penTotal + robustBonus.bonus;

  let cap = null;
  if (n < 5) cap = 25;
  else if (n < 10) cap = 50;
  else if (n < 15) cap = 65;
  else if (n < 30) cap = 85;
  const cappedBy = cap != null && scoreBeforeCap > cap ? cap : null;
  let score = scoreBeforeCap;
  if (cap != null && score > cap) score = cap;
  score = clamp(score, -50, 100);

  const mainReason = buildMainReason({ merit, resil, pen, bonus, meritTotal, resilTotal, penTotal, win, yld, assign, lbClass, res, hardExclude, robustBonus });

  return {
    score: round1(score), meritTotal, resilTotal, penTotal, bonusTotal: robustBonus.bonus, cappedBy,
    merit, resil, pen, bonus, resilience: res, hardExclude, mainReason, robustHistoryBonus: robustBonus,
    lbCritiqueNormal: lp.critique,
    lbCritiqueApplied: pen.lb ?? 0,
    lbCritiqueReducedApplied: pen.lbNote != null,
  };
}

function buildMainReason(ctx) {
  if (ctx.hardExclude.length) return ctx.hardExclude[0];
  const parts = [];
  const topMerit = Object.entries(ctx.merit).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [k, v] of topMerit) parts.push(`+${v} ${k}`);
  if (ctx.resilTotal > 0) parts.push(`résilience +${ctx.resilTotal}`);
  if (ctx.robustBonus?.bonus > 0) parts.push(`historique robuste +${ctx.robustBonus.bonus}`);
  const topPen = Object.entries(ctx.pen).filter(([, v]) => typeof v === "number" && v < 0).sort((a, b) => a[1] - b[1]).slice(0, 2);
  for (const [k, v] of topPen) parts.push(`${v} ${k}`);
  if (ctx.res.krachSurvived) parts.push("survivant krach 06-05");
  return parts.slice(0, 5).join(" · ") || "profil neutre";
}

function runVariantSimulation(profiles, cfg, cryptoExcluded) {
  const rows = profiles.map((profile) => {
    const ticker = nsym(profile.ticker);
    const cur = engineRowByTicker.get(ticker) ?? null;
    const vs = variantScore(profile, cfg, cryptoExcluded);
    return {
      ticker,
      n: profile?.csp?.recordsResolved ?? 0,
      win: profile?.csp?.realWinRate ?? null,
      yieldPct: profile?.csp?.avgYieldPct ?? null,
      assignmentRate: profile?.csp?.assignmentRate ?? null,
      deepAssignmentRate: profile?.assignment?.profondeRatePct ?? null,
      lbClass: profile?.lowerBoundStress?.lbStressClass ?? "none",
      verdict: profile?.primaryVerdict ?? "",
      current: cur ? { bucket: cur.bucket, rank: cur.rank, score: cur.dynamicTop20Score } : { bucket: "—", rank: null, score: null },
      variant: vs,
      eventUniqueness: eventUniquenessByTicker.get(ticker) ?? null,
    };
  });

  const rankable = rows.filter((s) => !cryptoExcluded.has(s.ticker) && s.variant.hardExclude.length === 0);
  rankable.sort((a, b) =>
    b.variant.score - a.variant.score ||
    b.n - a.n ||
    (b.yieldPct ?? -1) - (a.yieldPct ?? -1) ||
    a.ticker.localeCompare(b.ticker)
  );

  const exploitable = rankable.filter((s) => s.variant.score >= EXPLOITABLE_MIN_SCORE && s.n >= EXPLOITABLE_MIN_N);
  const bucketByTicker = new Map();
  let rank = 0;

  const top20List = exploitable.slice(0, 20);
  const top20Set = new Set(top20List.map((s) => s.ticker));
  for (const s of top20List) { rank += 1; bucketByTicker.set(s.ticker, { bucket: "top20", rank }); }

  const rest = rankable.filter((s) => !top20Set.has(s.ticker));
  const nearEntryList = rest.filter((s) => s.variant.score >= 20 && s.n >= 5).slice(0, 12);
  const nearSet = new Set(nearEntryList.map((s) => s.ticker));
  for (const s of nearEntryList) { rank += 1; bucketByTicker.set(s.ticker, { bucket: "nearEntry", rank }); }

  const watchList = rest.filter((s) => !nearSet.has(s.ticker) && s.n >= 5 && s.variant.score >= 0);
  const watchSet = new Set(watchList.map((s) => s.ticker));
  for (const s of watchList) { rank += 1; bucketByTicker.set(s.ticker, { bucket: "watchValidate", rank }); }

  const lowList = rest.filter((s) => !nearSet.has(s.ticker) && !watchSet.has(s.ticker));
  for (const s of lowList) bucketByTicker.set(s.ticker, { bucket: "low_or_excluded", rank: null });

  for (const s of rows.filter((r) => !cryptoExcluded.has(r.ticker) && r.variant.hardExclude.length > 0)) {
    bucketByTicker.set(s.ticker, { bucket: "excluded_hard", rank: null });
  }
  for (const t of cryptoExcluded) bucketByTicker.set(t, { bucket: "excluded_crypto", rank: null });

  for (const s of rows) {
    const pb = bucketByTicker.get(s.ticker) ?? { bucket: "low_or_excluded", rank: null };
    s.bucket = pb.bucket;
    s.rank = pb.rank;
  }

  return { cfg, rows, top20List, nearEntryList, watchList, lowList, exploitableCount: exploitable.length, top20Count: top20List.length };
}

const cryptoExcluded = new Set((engine.excludedCrypto || []).map((r) => nsym(r.ticker)));

const simE2 = runVariantSimulation(tickerProfiles, VARIANT_E2, cryptoExcluded);
const simE2b = runVariantSimulation(tickerProfiles, VARIANT_E2B, cryptoExcluded);

function rowFor(sim, ticker) {
  const r = sim.rows.find((x) => x.ticker === ticker);
  if (!r) return { rank: null, bucket: "—", score: null, bonus: 0, reason: "—" };
  return {
    rank: r.rank,
    bucket: r.bucket,
    score: r.variant.score,
    bonus: r.variant.bonusTotal ?? 0,
    reason: r.variant.mainReason,
    robustBonus: r.variant.robustHistoryBonus,
  };
}

function describeChange(e2Row, e2bRow) {
  if (e2Row.rank == null && e2bRow.rank == null) return "—";
  if (e2Row.rank === e2bRow.rank && e2Row.bucket === e2bRow.bucket) {
    const delta = (e2bRow.score ?? 0) - (e2Row.score ?? 0);
    return delta > 0 ? `score +${delta}` : "—";
  }
  const parts = [];
  if (e2Row.rank != null && e2bRow.rank != null && e2Row.rank !== e2bRow.rank) {
    const delta = e2Row.rank - e2bRow.rank;
    parts.push(delta > 0 ? `↑${delta} rang` : `↓${Math.abs(delta)} rang`);
  }
  if (e2Row.bucket !== e2bRow.bucket) parts.push(`${BUCKET_LABELS[e2Row.bucket] ?? e2Row.bucket} → ${BUCKET_LABELS[e2bRow.bucket] ?? e2bRow.bucket}`);
  const bonusDelta = (e2bRow.bonus ?? 0) - (e2Row.bonus ?? 0);
  if (bonusDelta > 0) parts.push(`+${bonusDelta} bonus vs E2`);
  return parts.join(", ") || "—";
}

const comparisonTable = TARGETS.map((ticker) => {
  const e2 = rowFor(simE2, ticker);
  const e2b = rowFor(simE2b, ticker);
  const profile = simE2b.rows.find((r) => r.ticker === ticker);
  let bonusReason = "—";
  if (e2b.robustBonus?.eligible) bonusReason = e2b.robustBonus.reasons;
  else if (e2b.robustBonus?.blocked?.length) bonusReason = `Bloqué : ${e2b.robustBonus.blocked.join(" · ")}`;

  return {
    ticker,
    e2Rank: e2.rank,
    e2Score: e2.score,
    e2Bucket: e2.bucket,
    e2bRank: e2b.rank,
    e2bScore: e2b.score,
    e2bBucket: e2b.bucket,
    change: describeChange(e2, e2b),
    reason: e2b.bonus > 0 ? bonusReason : (e2b.robustBonus?.blocked?.length ? bonusReason : e2.reason),
    robustHistoryBonus: e2b.robustBonus,
    e2Bonus: e2.bonus,
    e2bBonus: e2b.bonus,
    n: profile?.n ?? null,
    win: profile?.win ?? null,
    assignmentRate: profile?.assignmentRate ?? null,
    eventUniqueness: profile?.eventUniqueness ?? null,
  };
});

function evaluateVariant(sim) {
  const byTicker = new Map(sim.rows.map((r) => [r.ticker, r]));
  const get = (t) => byTicker.get(t);
  const bucketScore = (b) => ({ top20: 4, nearEntry: 3, watchValidate: 2, low_or_excluded: 1, excluded_hard: 0, excluded_crypto: 0 }[b] ?? 0);

  const criteria = {};
  criteria.top20Filled = sim.top20Count >= 20 ? 10 : Math.round((sim.top20Count / 20) * 10);
  const core = ["TQQQ", "APLD", "INTC", "AFRM"];
  const coreBuckets = core.map((t) => bucketScore(get(t)?.bucket));
  criteria.coreNotExpelled = coreBuckets.every((b) => b >= 3) ? 10 : coreBuckets.filter((b) => b >= 3).length * 2.5;

  const tqqq = get("TQQQ");
  if (tqqq?.bucket === "top20") {
    const rank = tqqq.rank ?? 99;
    criteria.tqqqTop20 = rank >= 18 && rank <= 20 ? 10 : 8;
  } else if (tqqq?.bucket === "nearEntry" && tqqq.rank <= 22) criteria.tqqqTop20 = 7;
  else criteria.tqqqTop20 = 3;

  const apld = get("APLD");
  criteria.apldTop20 = apld?.bucket === "top20" ? 10 : apld?.bucket === "nearEntry" ? 6 : 2;

  const ionq = get("IONQ");
  criteria.ionqNotFavored = (ionq?.bucket === "low_or_excluded" || ionq?.bucket === "excluded_hard") ? 10
    : ionq?.bucket === "watchValidate" ? 6 : ionq?.variant?.bonusTotal > 0 ? 0 : 3;

  const temMp = [get("TEM"), get("MP")].filter(Boolean);
  criteria.temMpStayLow = temMp.every((r) => bucketScore(r.bucket) <= 1 && (r.variant?.bonusTotal ?? 0) === 0) ? 10 : 5;

  const cdeGdxSlv = ["CDE", "GDX", "SLV"].map((t) => get(t)).filter(Boolean);
  criteria.cdeGdxSlvLow = cdeGdxSlv.every((r) => bucketScore(r.bucket) <= 1) ? 10 : 5;

  const cryptoInTop20 = sim.top20List.some((r) => cryptoExcluded.has(r.ticker));
  criteria.noCryptoInTop20 = cryptoInTop20 ? 0 : 10;

  criteria.noPerverseBonus = sim.rows.filter((r) => (r.variant?.bonusTotal ?? 0) > 0 && ["IONQ", "TEM", "MP", "CDE", "GDX", "SLV"].includes(r.ticker)).length === 0 ? 10 : 0;

  const total = Object.values(criteria).reduce((a, b) => a + b, 0);
  const maxPossible = Object.keys(criteria).length * 10;
  return { criteria, total, maxPossible };
}

const evalE2 = evaluateVariant(simE2);
const evalE2b = evaluateVariant(simE2b);

const bonusRecipientsE2 = simE2.rows
  .filter((r) => (r.variant?.bonusTotal ?? 0) > 0)
  .map((r) => ({
    ticker: r.ticker,
    bonus: r.variant.bonusTotal,
    baseBonus: r.variant.robustHistoryBonus.baseBonus,
    extraBonus: r.variant.robustHistoryBonus.extraBonus,
    rank: r.rank,
    score: r.variant.score,
    reason: r.variant.robustHistoryBonus.reasons,
  }))
  .sort((a, b) => b.bonus - a.bonus || a.ticker.localeCompare(b.ticker));

const bonusRecipientsE2b = simE2b.rows
  .filter((r) => (r.variant?.bonusTotal ?? 0) > 0)
  .map((r) => ({
    ticker: r.ticker,
    bonus: r.variant.bonusTotal,
    baseBonus: r.variant.robustHistoryBonus.baseBonus,
    extraBonus: r.variant.robustHistoryBonus.extraBonus,
    e2Rank: simE2.rows.find((x) => x.ticker === r.ticker)?.rank ?? null,
    e2bRank: r.rank,
    e2Score: simE2.rows.find((x) => x.ticker === r.ticker)?.variant.score ?? null,
    e2bScore: r.variant.score,
    reason: r.variant.robustHistoryBonus.reasons,
  }))
  .sort((a, b) => b.bonus - a.bonus || a.ticker.localeCompare(b.ticker));

const tqqqE2 = rowFor(simE2, "TQQQ");
const tqqqE2b = rowFor(simE2b, "TQQQ");

function bucketScore(b) {
  return ({ top20: 4, nearEntry: 3, watchValidate: 2, low_or_excluded: 1, excluded_hard: 0, excluded_crypto: 0 }[b] ?? 0);
}

const conclusion = {
  e2bBetterThanE2: evalE2b.total > evalE2.total,
  e2bCriteriaTotal: evalE2b.total,
  e2CriteriaTotal: evalE2.total,
  e2bMaxPossible: evalE2b.maxPossible,
  e2MaxPossible: evalE2.maxPossible,
  robustHistoryBonusJustified: tqqqE2b.bonus > 0 && (tqqqE2b.rank ?? 99) <= (tqqqE2.rank ?? 99),
  tqqqEnteredTop20: tqqqE2b.bucket === "top20",
  tqqqRankE2: tqqqE2.rank,
  tqqqRankE2b: tqqqE2b.rank,
  tqqqScoreE2: tqqqE2.score,
  tqqqScoreE2b: tqqqE2b.score,
  tqqqBonusE2: tqqqE2.bonus,
  tqqqBonusE2b: tqqqE2b.bonus,
  perverseEffects: {
    ionqGotBonus: (simE2b.rows.find((r) => r.ticker === "IONQ")?.variant?.bonusTotal ?? 0) > 0,
    temGotBonus: (simE2b.rows.find((r) => r.ticker === "TEM")?.variant?.bonusTotal ?? 0) > 0,
    mpGotBonus: (simE2b.rows.find((r) => r.ticker === "MP")?.variant?.bonusTotal ?? 0) > 0,
    cryptoInTop20: simE2b.top20List.some((r) => cryptoExcluded.has(r.ticker)),
    top20Complete: simE2b.top20Count >= 20,
  },
  shouldBeFinalCandidate: false,
  recommendationNote: "",
};

const checks = [];
if (simE2b.top20Count >= 20) checks.push("Top 20 complet");
else checks.push(`Top 20 incomplet (${simE2b.top20Count}/20)`);
if (tqqqE2b.bucket === "top20") {
  const r = tqqqE2b.rank;
  if (r >= 18 && r <= 20) checks.push(`TQQQ Top 20 #${r} (zone cible #18–#20)`);
  else checks.push(`TQQQ Top 20 #${r}`);
} else if (tqqqE2b.rank === 21) checks.push("TQQQ #21 (proche, pas Top 20)");
else checks.push(`TQQQ #${tqqqE2b.rank ?? "—"} (${BUCKET_LABELS[tqqqE2b.bucket] ?? tqqqE2b.bucket})`);
if (rowFor(simE2b, "APLD").bucket === "top20") checks.push("APLD Top 20");
if (rowFor(simE2b, "INTC").bucket === "top20") checks.push("INTC Top 20");
if (rowFor(simE2b, "AFRM").bucket === "top20") checks.push("AFRM Top 20");
if (!conclusion.perverseEffects.ionqGotBonus) checks.push("IONQ sans bonus");
if (!conclusion.perverseEffects.temGotBonus && !conclusion.perverseEffects.mpGotBonus) checks.push("TEM/MP sans bonus");
if (!conclusion.perverseEffects.cryptoInTop20) checks.push("Aucun crypto Top 20");

const noPerverse = !conclusion.perverseEffects.ionqGotBonus && !conclusion.perverseEffects.temGotBonus && !conclusion.perverseEffects.mpGotBonus;
const coreOk = ["APLD", "INTC", "AFRM"].every((t) => bucketScore(rowFor(simE2b, t).bucket) >= 3);
const tqqqTop20Strict = tqqqE2b.bucket === "top20";
const tqqqInTargetZone = tqqqTop20Strict && tqqqE2b.rank >= 18 && tqqqE2b.rank <= 20;

conclusion.tqqqTop20Strict = tqqqTop20Strict;
conclusion.tqqqInTargetZone = tqqqInTargetZone;

conclusion.shouldBeFinalCandidate =
  simE2b.top20Count >= 20 &&
  tqqqTop20Strict &&
  noPerverse &&
  coreOk &&
  evalE2b.total >= evalE2.total;

conclusion.recommendationNote = (() => {
  if (!noPerverse) return "E2b crée des effets pervers (IONQ/TEM/MP ou crypto) — garder E2.";
  if (tqqqInTargetZone && coreOk) {
    return "E2b devient la formule candidate finale : TQQQ Top 20 (#18–#20), noyau intact, aucun effet pervers.";
  }
  if (tqqqTop20Strict && coreOk) {
    return `E2b fait entrer TQQQ Top 20 (#${tqqqE2b.rank}) mais hors zone cible #18–#20 — valider si le rang est acceptable.`;
  }
  if (tqqqE2b.rank === 21 && coreOk) {
    return "E2b améliore TQQQ vs E2 mais reste #21 — bonus +8/+3 insuffisant pour franchir le Top 20.";
  }
  if (evalE2b.total > evalE2.total && coreOk) {
    return "E2b bat E2 au score critères mais TQQQ n'entre pas Top 20 — micro-ajustement ou accepter E2.";
  }
  return "E2b n'améliore pas assez vs E2 — garder E2 (+5/+2).";
})();

// ───────────────────────────── JSON output ───────────────────────────────────
const jsonOut = {
  generatedAt: new Date().toISOString(),
  asOfDate: todayYmd,
  readOnly: true,
  note: "Simulation E2 vs E2b read-only. Aucune modification moteur/base/Pine/crypto-block.",
  variants: {
    E2: {
      label: VARIANT_E2.label,
      robustHistoryBonus: { baseBonus: 5, extraBonus: 2, extraConditions: "n >= 45 et win >= 85 %" },
      summary: { top20Count: simE2.top20Count, exploitableCount: simE2.exploitableCount },
      evaluation: evalE2,
    },
    E2b: {
      label: VARIANT_E2B.label,
      robustHistoryBonus: { baseBonus: 8, extraBonus: 3, extraConditions: "n >= 45 et win >= 85 %" },
      summary: { top20Count: simE2b.top20Count, exploitableCount: simE2b.exploitableCount },
      evaluation: evalE2b,
    },
  },
  robustHistoryBonusRule: {
    E2: { baseBonus: 5, extraBonus: 2, extraConditions: "n >= 45 et win >= 85 %" },
    E2b: { baseBonus: 8, extraBonus: 3, extraConditions: "n >= 45 et win >= 85 %" },
    eligibility: [
      "n >= 30",
      "win >= 85 %",
      "distinctDeepAssignmentExpirationCount === 1",
      "distinctAssignedExpirationCount <= 1 OU assignation concentrée sur une expiration",
      "pas de risque confirmé répété",
      "pas crypto-block",
    ],
    guardrails: [
      "win < 85 %",
      "n < 30",
      "assignation sur plusieurs expirations distinctes (non concentrée)",
      "2+ expirations profondes distinctes",
      "LB critique avec win < 85 %",
      "assignation > 25 %",
      "ticker crypto bloqué",
      "exclusion dure active",
    ],
  },
  comparisonTable,
  bonusRecipientsE2,
  bonusRecipientsE2b,
  top20E2: simE2.top20List.map((s, i) => ({ rank: i + 1, ticker: s.ticker, score: s.variant.score, bonus: s.variant.bonusTotal ?? 0 })),
  top20E2b: simE2b.top20List.map((s, i) => ({ rank: i + 1, ticker: s.ticker, score: s.variant.score, bonus: s.variant.bonusTotal ?? 0 })),
  top20Diff: {
    entered: simE2b.top20List.filter((s) => !simE2.top20List.some((e) => e.ticker === s.ticker)).map((s) => s.ticker),
    exited: simE2.top20List.filter((s) => !simE2b.top20List.some((f) => f.ticker === s.ticker)).map((s) => s.ticker),
  },
  evaluation: { E2: evalE2, E2b: evalE2b },
  conclusion,
  validationChecks: checks,
};

writeFileSync("debug/top20-formula-e2b-robust-history-simulation.json", JSON.stringify(jsonOut, null, 2));

const md = buildMarkdown(jsonOut);
writeFileSync("debug/top20-formula-e2b-robust-history-simulation.md", md);

console.log("✓ JSON : debug/top20-formula-e2b-robust-history-simulation.json");
console.log("✓ MD   : debug/top20-formula-e2b-robust-history-simulation.md");
console.log(`\nE2  : score critères ${evalE2.total}/${evalE2.maxPossible} · Top 20 ${simE2.top20Count} · TQQQ #${tqqqE2.rank} score ${tqqqE2.score} (+${tqqqE2.bonus})`);
console.log(`E2b : score critères ${evalE2b.total}/${evalE2b.maxPossible} · Top 20 ${simE2b.top20Count} · TQQQ #${tqqqE2b.rank} score ${tqqqE2b.score} (+${tqqqE2b.bonus})`);
console.log(`\n→ ${conclusion.recommendationNote}`);
console.log(`\nBénéficiaires bonus E2 (${bonusRecipientsE2.length}) :`);
for (const b of bonusRecipientsE2) {
  console.log(`  ${b.ticker.padEnd(6)} +${b.bonus}  #${b.rank ?? "—"}  score ${b.score}`);
}
console.log(`\nBénéficiaires bonus E2b (${bonusRecipientsE2b.length}) :`);
for (const b of bonusRecipientsE2b) {
  console.log(`  ${b.ticker.padEnd(6)} +${b.bonus}  E2 #${b.e2Rank ?? "—"} → E2b #${b.e2bRank ?? "—"}  (${b.e2Score} → ${b.e2bScore})`);
}

function buildMarkdown(data) {
  const lines = [];
  lines.push("# Simulation E2 vs E2b — Bonus historique robuste renforcé");
  lines.push("");
  lines.push("> **Read-only.** Aucune modification du moteur, de la base, du Pine, ni de `crypto-block` / `selectedExpiration` / `dteAtScan`. Reproductible : `node debug/top20FormulaE2bRobustHistorySim.mjs`.");
  lines.push("");
  lines.push(`- Date : \`${data.asOfDate}\``);
  lines.push(`- **E2** = Hybride + bonus historique robuste (+5, +2 optionnel si n≥45 et win≥85 %)`);
  lines.push(`- **E2b** = E2 + bonus renforcé (+8, +3 optionnel si n≥45 et win≥85 %)`);
  lines.push("");

  lines.push("## 1. Différence E2 → E2b");
  lines.push("");
  lines.push("| Paramètre | E2 | E2b |");
  lines.push("|---|---|---|");
  lines.push("| Bonus base | +5 | **+8** |");
  lines.push("| Bonus extra (n≥45, win≥85 %) | +2 | **+3** |");
  lines.push("| Bonus max (n≥45) | +7 | **+11** |");
  lines.push("| Conditions d'éligibilité | identiques | identiques |");
  lines.push("| Garde-fous | identiques | identiques |");
  lines.push("");

  lines.push("## 2. Tableau comparatif — tickers cibles");
  lines.push("");
  lines.push("| Ticker | E2 rang | E2 score | E2 bucket | E2b rang | E2b score | E2b bucket | Changement | Raison |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const row of data.comparisonTable) {
    lines.push(`| **${row.ticker}** | ${row.e2Rank ?? "—"} | ${row.e2Score ?? "—"} | ${BUCKET_LABELS[row.e2Bucket] ?? row.e2Bucket} | ${row.e2bRank ?? "—"} | ${row.e2bScore ?? "—"} | ${BUCKET_LABELS[row.e2bBucket] ?? row.e2bBucket} | ${row.change} | ${row.reason} |`);
  }
  lines.push("");

  lines.push("## 3. Bénéficiaires du bonus — E2 vs E2b");
  lines.push("");
  lines.push("### E2 (+5/+2)");
  if (data.bonusRecipientsE2.length === 0) {
    lines.push("*Aucun.*");
  } else {
    lines.push("| Ticker | Bonus | Rang | Score |");
    lines.push("|---|---|---|---|");
    for (const b of data.bonusRecipientsE2) {
      lines.push(`| ${b.ticker} | +${b.bonus} | ${b.rank ?? "—"} | ${b.score} |`);
    }
  }
  lines.push("");
  lines.push("### E2b (+8/+3)");
  if (data.bonusRecipientsE2b.length === 0) {
    lines.push("*Aucun.*");
  } else {
    lines.push("| Ticker | Bonus | E2 rang → E2b rang | E2 score → E2b score | Raison |");
    lines.push("|---|---|---|---|---|");
    for (const b of data.bonusRecipientsE2b) {
      lines.push(`| ${b.ticker} | +${b.bonus} | ${b.e2Rank ?? "—"} → ${b.e2bRank ?? "—"} | ${b.e2Score} → ${b.e2bScore} | ${b.reason} |`);
    }
  }
  lines.push("");

  lines.push("## 4. Top 20 — E2 vs E2b");
  lines.push("");
  lines.push("### E2");
  lines.push(data.top20E2.map((t) => `${t.rank}. ${t.ticker} (${t.score}${t.bonus ? ` +${t.bonus}` : ""})`).join(" · "));
  lines.push("");
  lines.push("### E2b");
  lines.push(data.top20E2b.map((t) => `${t.rank}. ${t.ticker} (${t.score}${t.bonus ? ` +${t.bonus}` : ""})`).join(" · "));
  lines.push("");
  if (data.top20Diff.entered.length || data.top20Diff.exited.length) {
    lines.push(`- **Entrés en Top 20 (E2b)** : ${data.top20Diff.entered.join(", ") || "—"}`);
    lines.push(`- **Sortis du Top 20 (E2b)** : ${data.top20Diff.exited.join(", ") || "—"}`);
  } else {
    lines.push("- Composition Top 20 identique entre E2 et E2b.");
  }
  lines.push("");

  lines.push("## 5. Évaluation critères");
  lines.push("");
  lines.push("| Critère | E2 | E2b |");
  lines.push("|---|---|---|");
  for (const key of Object.keys(data.evaluation.E2.criteria)) {
    lines.push(`| ${key} | ${data.evaluation.E2.criteria[key]}/10 | ${data.evaluation.E2b.criteria[key]}/10 |`);
  }
  lines.push(`| **Total** | **${data.evaluation.E2.total}/${data.evaluation.E2.maxPossible}** | **${data.evaluation.E2b.total}/${data.evaluation.E2b.maxPossible}** |`);
  lines.push("");

  lines.push("## 6. Conclusion");
  lines.push("");
  const c = data.conclusion;
  lines.push(`### Est-ce que E2b est meilleure que E2 ?`);
  lines.push(c.e2bBetterThanE2
    ? `**Oui** : score critères **${c.e2bCriteriaTotal}/${c.e2bMaxPossible}** vs **${c.e2CriteriaTotal}/${c.e2MaxPossible}**.`
    : c.e2bCriteriaTotal === c.e2CriteriaTotal
      ? `**Marginalement égale** : score critères **${c.e2bCriteriaTotal}/${c.e2bMaxPossible}** vs **${c.e2CriteriaTotal}/${c.e2MaxPossible}**.`
      : `**Non** : score critères **${c.e2bCriteriaTotal}/${c.e2bMaxPossible}** vs **${c.e2CriteriaTotal}/${c.e2MaxPossible}**.`);
  lines.push("");
  lines.push(`### TQQQ entre-t-il Top 20 sans effet pervers ?`);
  const tqqqE2Bucket = data.comparisonTable.find((r) => r.ticker === "TQQQ")?.e2Bucket ?? "—";
  const tqqqE2bBucket = data.comparisonTable.find((r) => r.ticker === "TQQQ")?.e2bBucket ?? "—";
  lines.push(`- E2 : **#${c.tqqqRankE2}**, score **${c.tqqqScoreE2}** (+${c.tqqqBonusE2}) (${BUCKET_LABELS[tqqqE2Bucket] ?? tqqqE2Bucket})`);
  lines.push(`- E2b : **#${c.tqqqRankE2b}**, score **${c.tqqqScoreE2b}** (+${c.tqqqBonusE2b}) (${BUCKET_LABELS[tqqqE2bBucket] ?? tqqqE2bBucket})`);
  lines.push(`- IONQ bonus : ${c.perverseEffects.ionqGotBonus ? "⚠ OUI" : "✓ non"}`);
  lines.push(`- TEM bonus : ${c.perverseEffects.temGotBonus ? "⚠ OUI" : "✓ non"}`);
  lines.push(`- MP bonus : ${c.perverseEffects.mpGotBonus ? "⚠ OUI" : "✓ non"}`);
  lines.push(`- Crypto Top 20 : ${c.perverseEffects.cryptoInTop20 ? "⚠ OUI" : "✓ non"}`);
  lines.push(`- Top 20 complet : ${c.perverseEffects.top20Complete ? "✓ oui (20)" : "⚠ non"}`);
  lines.push("");
  lines.push(`### E2b devrait-elle devenir la formule candidate finale ?`);
  lines.push(c.shouldBeFinalCandidate ? "**Oui, recommandé.**" : "**Non ou à valider.**");
  lines.push("");
  lines.push(`> ${c.recommendationNote}`);
  lines.push("");
  lines.push("### Checks de validation");
  for (const chk of data.validationChecks) lines.push(`- ${chk}`);
  lines.push("");
  lines.push("---");
  lines.push("*Simulation read-only — scoring backend non modifié.*");
  return lines.join("\n");
}

export { jsonOut, simE2, simE2b, conclusion };
