#!/usr/bin/env node
/**
 * AUDIT READ-ONLY J5-A — Journal POP / Top 20 réaliste « 1 décision par ticker×expiration »
 * -----------------------------------------------------------------------------------------
 * Simule l'impact d'une amélioration future du Top 20 actuel vers une base décisionnelle
 * (1 sélection théorique par ticker + selectedExpiration) sans modifier le moteur, l'UI,
 * la DB, ni créer un second classement permanent.
 *
 * Usage:
 *   node debug/journal-pop-j5a-top20-realistic-decision-audit.mjs
 */

import fs from "node:fs";
import path from "node:path";

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createWheelValidationStore } from "../app/journal/wheelValidationStore.js";
import {
  createWheelValidationService,
  classifyAssignmentDepth,
  computeOnePercentWheelProfiles,
  computeDynamicTop20WheelProfiles,
} from "../app/journal/wheelValidationService.js";

const OUT_JSON = path.resolve("debug", "journal-pop-j5a-top20-realistic-decision-audit.json");
const OUT_MD = path.resolve("debug", "journal-pop-j5a-top20-realistic-decision-audit.md");

const FOCUS_TICKERS = ["TQQQ", "APLD", "HOOD", "SOFI", "BAC", "CCL", "HIMS"];
const DTE_BUCKETS = [2, 3, 4, 7];
const DTE_PRIORITY = [7, 4, 3, 2];
const MIN_CSP_YIELD_PCT = 0.5;
const POLICIES = ["SAFE_FIRST", "BALANCED", "YIELD_FIRST", "BEST_OBSERVED"];

// ── helpers lecture seule ────────────────────────────────────────────────────
const sym = (v) => String(v ?? "").trim().toUpperCase();
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function median(values) {
  const arr = values.filter((v) => v != null);
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function average(values) {
  const arr = values.filter((v) => v != null);
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

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

function getCalibrationIsCorrect(record) {
  if (record?.resolution?.popPredictionCorrect === true) return true;
  if (record?.resolution?.popPredictionCorrect === false) return false;
  if (record?.resolution?.expiredWorthless === true) return true;
  if (record?.resolution?.expiredWorthless === false) return false;
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

function toExpirationYmd(value) {
  const raw = String(value ?? "").trim().replace(/-/g, "");
  if (!/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function isProfileEligible(record, todayYmd) {
  if (!getResolvedFlag(record)) return false;
  if (isIntradayRetest(record)) return false;
  const expirationYmd = toExpirationYmd(record?.selectedExpiration ?? record?.expiration ?? record?.expirationCohort);
  if (!expirationYmd || expirationYmd >= todayYmd) return false;
  return true;
}

function getStrike(record) {
  return num(record?.strike?.strike) ?? num(record?.strike) ?? num(record?.assignment_strike);
}

function getPremium(record) {
  return num(record?.strike?.premium) ?? num(record?.premium);
}

function getCspYieldPct(record) {
  const premium = getPremium(record);
  const strike = getStrike(record);
  if (premium != null && strike != null && strike > 0) return (premium / strike) * 100;
  return num(record?.strike?.annualizedYield) ?? num(record?.snapshot?.premium_to_spot_pct) ?? null;
}

function getSpreadPct(record) {
  const raw =
    num(record?.strike?.spreadPct) ??
    num(record?.strike?.liquidity?.spreadPct) ??
    num(record?.ivSnapshot?.option_spread_pct_at_scan);
  if (raw == null) return null;
  return raw > 1 ? raw : raw * 100;
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

function wouldAvoidAssignment(strike, close) {
  if (strike == null || close == null) return null;
  return close >= strike;
}

function dtePriority(dte) {
  const idx = DTE_PRIORITY.indexOf(dte);
  return idx >= 0 ? idx : 99;
}

function compareStable(a, b) {
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

function isAdmissibleYield(record) {
  const y = getCspYieldPct(record);
  return y != null && y >= MIN_CSP_YIELD_PCT;
}

function isYieldDataTrustworthy(record) {
  const premium = getPremium(record);
  const strike = getStrike(record);
  if (premium == null && strike == null) return false;
  const y = getCspYieldPct(record);
  if (y != null && y > 5) return false;
  return true;
}

function makeStore() {
  const useSqlite = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
  return useSqlite ? createWheelValidationStoreSqlite() : createWheelValidationStore();
}

function mdTable(headers, rows) {
  const esc = (v) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (cells) => `| ${cells.map(esc).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map((r) => line(r))].join("\n");
}

function expirationSignature(r) {
  return [sym(r?.symbol ?? r?.ticker), expKey(r) ?? "na"].join("|");
}

function groupByTickerExpiration(records) {
  const groups = new Map();
  for (const r of records) {
    const key = expirationSignature(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

// ── politiques de sélection ───────────────────────────────────────────────────
function selectSafeFirst(candidates) {
  const admissible = candidates.filter(isAdmissibleYield);
  const poolBase = admissible.length > 0 ? admissible : candidates;
  const safe = poolBase.filter((r) => normMode(r) === "SAFE");
  const aggressive = poolBase.filter((r) => normMode(r) === "AGGRESSIVE");
  const pool = safe.length > 0 ? safe : aggressive.length > 0 ? aggressive : poolBase;
  if (pool.length === 0) return candidates.sort(compareStable)[0] ?? null;

  pool.sort((a, b) => {
    const dteA = dtePriority(num(a?.dteAtScan));
    const dteB = dtePriority(num(b?.dteAtScan));
    if (dteA !== dteB) return dteA - dteB;
    const strikeA = getStrike(a) ?? Infinity;
    const strikeB = getStrike(b) ?? Infinity;
    if (strikeA !== strikeB) return strikeA - strikeB;
    const spreadA = getSpreadPct(a) ?? Infinity;
    const spreadB = getSpreadPct(b) ?? Infinity;
    if (spreadA !== spreadB) return spreadA - spreadB;
    return compareStable(a, b);
  });
  return pool[0];
}

function riskTier(record) {
  const assigned = getAssignedFlag(record);
  if (assigned !== true) return 0;
  const depth = classifyAssignmentDepth(record).assignmentDepthClass;
  if (depth === "proche") return 1;
  if (depth === "moderee") return 2;
  if (depth === "profonde") return 3;
  return 2;
}

function selectBalanced(candidates) {
  const admissible = candidates.filter(isAdmissibleYield);
  const pool = admissible.length > 0 ? admissible : candidates;
  if (pool.length === 0) return candidates.sort(compareStable)[0] ?? null;

  const maxYield = Math.max(...admissible.map(getCspYieldPct).filter((y) => y != null), 0);

  pool.sort((a, b) => {
    const tierA = riskTier(a);
    const tierB = riskTier(b);
    if (tierA !== tierB) return tierA - tierB;

    const modeA = normMode(a);
    const modeB = normMode(b);
    const yieldA = getCspYieldPct(a) ?? 0;
    const yieldB = getCspYieldPct(b) ?? 0;
    const safeBonusA = modeA === "SAFE" && yieldA >= maxYield - 0.15 ? 1 : 0;
    const safeBonusB = modeB === "SAFE" && yieldB >= maxYield - 0.15 ? 1 : 0;
    if (safeBonusA !== safeBonusB) return safeBonusB - safeBonusA;

    if (yieldA !== yieldB) return yieldB - yieldA;

    const dteA = num(a?.dteAtScan);
    const dteB = num(b?.dteAtScan);
    const prefA = dteA === 7 || dteA === 4 ? 0 : 1;
    const prefB = dteB === 7 || dteB === 4 ? 0 : 1;
    if (prefA !== prefB) return prefA - prefB;

    return compareStable(a, b);
  });
  return pool[0];
}

function selectYieldFirst(candidates) {
  const admissible = candidates.filter((r) => isAdmissibleYield(r) && isYieldDataTrustworthy(r));
  const fallback = candidates.filter(isAdmissibleYield);
  const pool = admissible.length > 0 ? admissible : fallback.length > 0 ? fallback : candidates;
  if (pool.length === 0) return candidates.sort(compareStable)[0] ?? null;

  pool.sort((a, b) => {
    const yA = getCspYieldPct(a) ?? -1;
    const yB = getCspYieldPct(b) ?? -1;
    if (yA !== yB) return yB - yA;
    return compareStable(a, b);
  });
  return pool[0];
}

function outcomeScore(record) {
  const assigned = getAssignedFlag(record) === true;
  if (!assigned) return 1000 + (getCspYieldPct(record) ?? 0);
  const depth = classifyAssignmentDepth(record).assignmentDepthClass;
  const depthBase =
    depth === "proche" ? 700 : depth === "moderee" ? 400 : depth === "profonde" ? 100 : 200;
  return depthBase + (getCspYieldPct(record) ?? 0);
}

function selectBestObserved(candidates) {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort(
    (a, b) => outcomeScore(b) - outcomeScore(a) || compareStable(a, b),
  );
  return sorted[0];
}

const POLICY_SELECTORS = {
  SAFE_FIRST: selectSafeFirst,
  BALANCED: selectBalanced,
  YIELD_FIRST: selectYieldFirst,
  BEST_OBSERVED: selectBestObserved,
};

function applyPolicy(eligibleRecords, policyName) {
  const selector = POLICY_SELECTORS[policyName];
  const groups = groupByTickerExpiration(eligibleRecords);
  const selected = [];
  let observationsOriginalCount = 0;

  for (const candidates of groups.values()) {
    observationsOriginalCount += candidates.length;
    const pick = selector(candidates);
    if (pick) selected.push(pick);
  }

  return {
    selected,
    observationsOriginalCount,
    distinctExpirationGroups: groups.size,
  };
}

function computeWinRate(records) {
  const outcomes = records.map(getCalibrationIsCorrect).filter((v) => typeof v === "boolean");
  if (outcomes.length > 0) {
    return pct1((outcomes.filter((v) => v).length / outcomes.length) * 100);
  }
  const known = records.filter((r) => getAssignedFlag(r) != null);
  if (known.length === 0) return null;
  return pct1((known.filter((r) => getAssignedFlag(r) !== true).length / known.length) * 100);
}

function computePolicyMetrics(selectedRecords, observationsOriginalCount) {
  const assigned = selectedRecords.filter((r) => getAssignedFlag(r) === true);
  const depth = { proche: 0, moderee: 0, profonde: 0, nd: 0 };
  const depthPcts = [];
  for (const r of assigned) {
    const d = classifyAssignmentDepth(r);
    if (d.assignmentDepthClass === "proche") depth.proche += 1;
    else if (d.assignmentDepthClass === "moderee") depth.moderee += 1;
    else if (d.assignmentDepthClass === "profonde") depth.profonde += 1;
    else depth.nd += 1;
    if (d.assignmentDepthPct != null) depthPcts.push(d.assignmentDepthPct);
  }

  const yields = selectedRecords.map(getCspYieldPct).filter((y) => y != null);
  const modeSplit = { SAFE: 0, AGGRESSIVE: 0, OTHER: 0 };
  const dteSplit = {};
  const tickers = new Set();

  for (const r of selectedRecords) {
    tickers.add(sym(r?.symbol ?? r?.ticker));
    const mode = normMode(r);
    modeSplit[mode] = (modeSplit[mode] ?? 0) + 1;
    const dte = num(r?.dteAtScan);
    if (dte != null) dteSplit[dte] = (dteSplit[dte] ?? 0) + 1;
  }

  const selectedTradeCount = selectedRecords.length;
  const selectedAssignedCount = assigned.length;
  const inflationRatio =
    selectedTradeCount > 0 ? round2(observationsOriginalCount / selectedTradeCount) : null;

  return {
    selectedTradeCount,
    selectedAssignedCount,
    selectedAssignmentRate:
      selectedTradeCount > 0 ? pct1((selectedAssignedCount / selectedTradeCount) * 100) : null,
    selectedNearAssignmentCount: depth.proche,
    selectedModerateAssignmentCount: depth.moderee,
    selectedDeepAssignmentCount: depth.profonde,
    selectedDeepAssignmentRate:
      selectedAssignedCount > 0 ? pct1((depth.profonde / selectedAssignedCount) * 100) : null,
    selectedWinRate: computeWinRate(selectedRecords),
    selectedAvgCspYieldPct: yields.length > 0 ? round2(average(yields)) : null,
    selectedMedianCspYieldPct: yields.length > 0 ? round2(median(yields)) : null,
    selectedAvgDepthPct: depthPcts.length > 0 ? round2(average(depthPcts)) : null,
    selectedModeSplit: modeSplit,
    selectedDteSplit: dteSplit,
    selectedTickerCount: tickers.size,
    observationsOriginalCount,
    duplicationReductionRatio:
      observationsOriginalCount > 0
        ? round2(1 - selectedTradeCount / observationsOriginalCount)
        : null,
    inflationRatio,
  };
}

function buildDteMetrics(records, label) {
  const byDte = {};
  for (const d of DTE_BUCKETS) byDte[d] = [];
  byDte.autres = [];

  for (const r of records) {
    const dte = num(r?.dteAtScan);
    const bucket = DTE_BUCKETS.includes(dte) ? dte : "autres";
    byDte[bucket].push(r);
  }

  const result = {};
  for (const [dte, rows] of Object.entries(byDte)) {
    if (rows.length === 0) {
      result[dte] = {
        label,
        nSelectedTrades: 0,
        assignmentRate: null,
        deepAssignmentRate: null,
        avgYield: null,
        winRate: null,
        verdict: "échantillon insuffisant",
      };
      continue;
    }
    const m = computePolicyMetrics(rows, rows.length);
    let verdict = "prudent";
    if (m.selectedAssignmentRate != null && m.selectedAssignmentRate > 25) verdict = "risque élevé";
    else if (m.selectedDeepAssignmentRate != null && m.selectedDeepAssignmentRate > 40) verdict = "profondeur élevée";
    else if (m.selectedAssignmentRate != null && m.selectedAssignmentRate <= 10) verdict = "prudent";

    result[dte] = {
      label,
      nSelectedTrades: rows.length,
      assignmentRate: m.selectedAssignmentRate,
      deepAssignmentRate: m.selectedDeepAssignmentRate,
      avgYield: m.selectedAvgCspYieldPct,
      winRate: m.selectedWinRate,
      verdict,
    };
  }
  return result;
}

function buildSafeVsAggressiveAnalysis(eligibleRecords) {
  const groups = new Map();
  for (const r of eligibleRecords) {
    const key = [sym(r?.symbol ?? r?.ticker), expKey(r) ?? "na", String(num(r?.dteAtScan) ?? "na")].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        ticker: sym(r?.symbol ?? r?.ticker),
        expKey: expKey(r),
        dte: num(r?.dteAtScan),
        safe: null,
        aggressive: null,
        closeAtExpiration: getCloseAtExpiration(r),
      });
    }
    const g = groups.get(key);
    const close = getCloseAtExpiration(r);
    if (close != null) g.closeAtExpiration = close;
    const mode = normMode(r);
    if (mode === "SAFE") g.safe = r;
    else if (mode === "AGGRESSIVE") g.aggressive = r;
  }

  const stats = {
    pairsWithBothModes: 0,
    safeWouldAvoidAssignment: 0,
    aggressiveWouldAvoidAssignment: 0,
    safeReducedDepth: 0,
    aggressivePaidMoreYield: 0,
    aggressiveWorthRisk: 0,
    aggressiveIncreasedDepth: 0,
    byTicker: {},
  };

  for (const g of groups.values()) {
    const safe = g.safe;
    const agg = g.aggressive;
    if (!safe || !agg) continue;
    stats.pairsWithBothModes += 1;

    const ticker = g.ticker;
    if (!stats.byTicker[ticker]) {
      stats.byTicker[ticker] = {
        pairs: 0,
        safeAvoids: 0,
        safeReducedDepth: 0,
        aggPaidMore: 0,
        aggWorthRisk: 0,
        aggIncreasedDepth: 0,
      };
    }
    const tb = stats.byTicker[ticker];
    tb.pairs += 1;

    const safeStrike = getStrike(safe);
    const aggStrike = getStrike(agg);
    const close = g.closeAtExpiration;
    const safeAvoid = wouldAvoidAssignment(safeStrike, close);
    const aggAvoid = wouldAvoidAssignment(aggStrike, close);

    if (safeAvoid && !aggAvoid) {
      stats.safeWouldAvoidAssignment += 1;
      tb.safeAvoids += 1;
    }

    const safeDepth = classifyAssignmentDepth(safe);
    const aggDepth = classifyAssignmentDepth(agg);
    const safeAssigned = getAssignedFlag(safe) === true;
    const aggAssigned = getAssignedFlag(agg) === true;
    const safeAbs = safeDepth.assignmentDepthPct != null ? Math.abs(safeDepth.assignmentDepthPct) : null;
    const aggAbs = aggDepth.assignmentDepthPct != null ? Math.abs(aggDepth.assignmentDepthPct) : null;

    if (safeAssigned && aggAssigned) {
      if (safeAbs != null && aggAbs != null && safeAbs < aggAbs) {
        stats.safeReducedDepth += 1;
        tb.safeReducedDepth += 1;
      }
      if (aggAbs != null && safeAbs != null && aggAbs > safeAbs) {
        stats.aggressiveIncreasedDepth += 1;
        tb.aggIncreasedDepth += 1;
      }
    }

    const safeYield = getCspYieldPct(safe);
    const aggYield = getCspYieldPct(agg);
    if (safeYield != null && aggYield != null && aggYield > safeYield) {
      stats.aggressivePaidMoreYield += 1;
      tb.aggPaidMore += 1;
      if (!aggAssigned && safeAssigned) {
        stats.aggressiveWorthRisk += 1;
        tb.aggWorthRisk += 1;
      } else if (!aggAssigned && !safeAssigned) {
        stats.aggressiveWorthRisk += 1;
        tb.aggWorthRisk += 1;
      } else if (aggAssigned && safeAssigned && aggAbs != null && safeAbs != null && aggAbs <= safeAbs + 1) {
        stats.aggressiveWorthRisk += 1;
        tb.aggWorthRisk += 1;
      }
    }

    if (aggAvoid && !safeAvoid) stats.aggressiveWouldAvoidAssignment += 1;
  }

  return stats;
}

function buildTickerRow(ticker, eligibleRecords, policyResults, currentRankMap, balancedRankMap) {
  const t = sym(ticker);
  const rows = eligibleRecords.filter((r) => sym(r?.symbol ?? r?.ticker) === t);
  const assignedObs = rows.filter((r) => getAssignedFlag(r) === true);
  const distinctExp = new Set(rows.map(expKey).filter(Boolean)).size;
  const distinctExpAssigned = new Set(assignedObs.map(expKey).filter(Boolean)).size;

  const obsMetrics = computePolicyMetrics(rows, rows.length);
  const perPolicy = {};
  for (const p of POLICIES) {
    const sel = policyResults[p].selected.filter((r) => sym(r?.symbol ?? r?.ticker) === t);
    perPolicy[p] = {
      selectedTradeCount: sel.length,
      selectedAssignedCount: sel.filter((r) => getAssignedFlag(r) === true).length,
      selectedAssignmentRate: computePolicyMetrics(sel, rows.length).selectedAssignmentRate,
      selectedDeepAssignmentRate: computePolicyMetrics(sel, rows.length).selectedDeepAssignmentRate,
      avgYield: computePolicyMetrics(sel, rows.length).selectedAvgCspYieldPct,
      bestDte: (() => {
        const dtes = sel.map((r) => num(r?.dteAtScan)).filter((v) => v != null);
        if (dtes.length === 0) return null;
        const freq = {};
        for (const d of dtes) freq[d] = (freq[d] ?? 0) + 1;
        return Number(Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0]);
      })(),
      bestMode: (() => {
        const modes = sel.map(normMode);
        const freq = {};
        for (const m of modes) freq[m] = (freq[m] ?? 0) + 1;
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      })(),
    };
  }

  const currentRank = currentRankMap.get(t) ?? null;
  const balancedRank = balancedRankMap.get(t) ?? null;
  let verdict = "stable";
  if (rows.length < 5) verdict = "échantillon insuffisant";
  else if (rows.length < 15) verdict = "à confirmer";
  else if (currentRank != null && balancedRank != null) {
    const delta = currentRank - balancedRank;
    if (delta >= 3) verdict = "monte";
    else if (delta <= -3) verdict = "descend";
    else verdict = "stable";
  } else if (currentRank == null && balancedRank != null && balancedRank <= 20) verdict = "monte";
  else if (currentRank != null && currentRank <= 20 && balancedRank == null) verdict = "descend";

  return {
    ticker: t,
    currentTop20Rank: currentRank,
    balancedSimulatedRank: balancedRank,
    observationResolvedCount: rows.length,
    observationAssignedCount: assignedObs.length,
    distinctExpirationCount: distinctExp,
    distinctExpirationAssignedCount: distinctExpAssigned,
    inflationRatio:
      distinctExpAssigned > 0 ? round2(assignedObs.length / distinctExpAssigned) : assignedObs.length > 0 ? assignedObs.length : null,
    observationAssignmentRate: obsMetrics.selectedAssignmentRate,
    observationDeepAssignmentRate: obsMetrics.selectedDeepAssignmentRate,
    perPolicy,
    rankVerdict: verdict,
  };
}

function buildDecisionRecords(allRecords, selectedIds, todayYmd) {
  const idSet = new Set(selectedIds);
  return allRecords.filter((r) => isProfileEligible(r, todayYmd) && idSet.has(r?.id));
}

function rankMapFromTop20(top20Result, useProjection = false) {
  const map = new Map();
  for (const row of top20Result?.top20 ?? []) {
    if (row?.ticker && row?.rank != null) map.set(sym(row.ticker), row.rank);
  }
  if (map.size === 0 || useProjection) {
    const all = [
      ...(top20Result?.top20 ?? []),
      ...(top20Result?.nearEntry ?? []),
      ...(top20Result?.watchValidate ?? []),
      ...(top20Result?.stressed ?? []),
      ...(top20Result?.insufficientSample ?? []),
      ...(top20Result?.excludedHighYield ?? []),
    ]
      .filter((r) => r?.ticker && (r?.dynamicTop20Score ?? r?.competitiveScoreV2) != null)
      .sort(
        (a, b) =>
          (b.dynamicTop20Score ?? b.competitiveScoreV2 ?? 0) -
            (a.dynamicTop20Score ?? a.competitiveScoreV2 ?? 0) ||
          String(a.ticker).localeCompare(String(b.ticker)),
      );
    all.slice(0, 20).forEach((row, i) => map.set(sym(row.ticker), i + 1));
  }
  return map;
}

function summarizeTop20Comparison(current, balanced) {
  const currentList = (current?.top20 ?? []).map((r) => ({
    rank: r.rank,
    ticker: r.ticker,
    score: r.dynamicTop20Score ?? r.competitiveScoreV2 ?? null,
    assignmentRate: r.assignmentRate ?? r.csp?.assignmentRate ?? null,
    deepAssignmentRate: r.deepAssignmentRate ?? null,
    n: r.recordsResolved ?? r.csp?.recordsResolved ?? null,
    status: r.dynamicTop20Status ?? null,
  }));

  const balancedList = (balanced?.top20 ?? []).map((r) => ({
    rank: r.rank,
    ticker: r.ticker,
    score: r.dynamicTop20Score ?? r.competitiveScoreV2 ?? null,
    assignmentRate: r.assignmentRate ?? r.csp?.assignmentRate ?? null,
    deepAssignmentRate: r.deepAssignmentRate ?? null,
    n: r.recordsResolved ?? r.csp?.recordsResolved ?? null,
    status: r.dynamicTop20Status ?? "top20_experimental",
  }));

  const balancedNearEntry = (balanced?.nearEntry ?? []).map((r) => ({
    rank: r.rank,
    ticker: r.ticker,
    score: r.dynamicTop20Score ?? r.competitiveScoreV2 ?? null,
    assignmentRate: r.assignmentRate ?? r.csp?.assignmentRate ?? null,
    deepAssignmentRate: r.deepAssignmentRate ?? null,
    n: r.recordsResolved ?? r.csp?.recordsResolved ?? null,
    status: r.dynamicTop20Status ?? "near_entry",
  }));

  const allBalancedRankable = [
    ...(balanced?.top20 ?? []),
    ...(balanced?.nearEntry ?? []),
    ...(balanced?.watchValidate ?? []),
    ...(balanced?.stressed ?? []),
    ...(balanced?.insufficientSample ?? []),
    ...(balanced?.excludedHighYield ?? []),
  ]
    .filter((r) => r?.ticker && (r?.dynamicTop20Score ?? r?.competitiveScoreV2) != null)
    .sort(
      (a, b) =>
        (b.dynamicTop20Score ?? b.competitiveScoreV2 ?? 0) -
          (a.dynamicTop20Score ?? a.competitiveScoreV2 ?? 0) ||
        (b.recordsResolved ?? b.csp?.recordsResolved ?? 0) -
          (a.recordsResolved ?? a.csp?.recordsResolved ?? 0) ||
        String(a.ticker).localeCompare(String(b.ticker)),
    );

  const balancedProjectedTop20ByScore = allBalancedRankable.slice(0, 20).map((r, i) => ({
    rank: i + 1,
    ticker: r.ticker,
    score: r.dynamicTop20Score ?? r.competitiveScoreV2 ?? null,
    assignmentRate: r.assignmentRate ?? r.csp?.assignmentRate ?? null,
    deepAssignmentRate: r.deepAssignmentRate ?? null,
    n: r.recordsResolved ?? r.csp?.recordsResolved ?? null,
    status: r.dynamicTop20Status ?? null,
    note: "Projection par score E2b post-déduplication — n<10 pour tous les tickers (seuil Top 20 actuel non atteint)",
  }));

  const comparisonList =
    balancedList.length > 0 ? balancedList : balancedProjectedTop20ByScore;

  const currentSet = new Set(currentList.map((r) => sym(r.ticker)));
  const comparisonSet = new Set(comparisonList.map((r) => sym(r.ticker)));

  const entered = comparisonList.filter((r) => !currentSet.has(sym(r.ticker)));
  const dropped = currentList.filter((r) => !comparisonSet.has(sym(r.ticker)));

  const rankChanges = [];
  for (const b of comparisonList) {
    const c = currentList.find((x) => sym(x.ticker) === sym(b.ticker));
    if (c) {
      rankChanges.push({
        ticker: b.ticker,
        currentRank: c.rank,
        balancedRank: b.rank,
        delta: c.rank - b.rank,
        currentScore: c.score,
        balancedScore: b.score,
        balancedN: b.n,
      });
    }
  }
  rankChanges.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    method: "computeDynamicTop20WheelProfiles via createWheelValidationService (E2b si records disponibles)",
    currentTop20: currentList,
    balancedSimulatedTop20: balancedList,
    balancedNearEntry,
    balancedProjectedTop20ByScore,
    comparisonUsed:
      balancedList.length > 0
        ? "top20_experimental strict (n≥10, score≥35)"
        : "projection top 20 par score E2b — Top 20 strict vide car n max ≈ 5 après déduplication (seuil E2b n≥10)",
    balancedMeta: {
      top20Count: balanced?.meta?.top20Count ?? balanced?.summary?.top20Count ?? balancedList.length,
      nearEntryCount: balanced?.meta?.nearEntryCount ?? balanced?.nearEntry?.length ?? 0,
      insufficientSampleCount:
        balanced?.meta?.insufficientSampleCount ?? balanced?.summary?.insufficientSampleCount ?? null,
      exploitableForTop20Count: balanced?.meta?.exploitableForTop20Count ?? null,
    },
    enteredTop20: entered,
    droppedFromTop20: dropped,
    largestRankChanges: rankChanges.slice(0, 15),
    overlapCount: comparisonList.filter((r) => currentSet.has(sym(r.ticker))).length,
    overlapCountStrictTop20: balancedList.filter((r) => currentSet.has(sym(r.ticker))).length,
  };
}

// ── chargement ────────────────────────────────────────────────────────────────
const store = makeStore();
const journal = await store.load();
const records = Array.isArray(journal?.records) ? journal.records : [];
const today = new Date().toISOString().slice(0, 10);

const eligible = records.filter((r) => isProfileEligible(r, today));

// ── politiques ────────────────────────────────────────────────────────────────
const policyResults = {};
for (const policy of POLICIES) {
  const { selected, observationsOriginalCount } = applyPolicy(eligible, policy);
  policyResults[policy] = {
    selected,
    observationsOriginalCount,
    metrics: computePolicyMetrics(selected, observationsOriginalCount),
  };
}

// ── Top 20 actuel vs simulé BALANCED ─────────────────────────────────────────
const service = createWheelValidationService({ store });
const currentTop20 = await service.computeDynamicTop20WheelProfiles({ today });

const balancedSelectedIds = policyResults.BALANCED.selected.map((r) => r.id);
const balancedRecords = buildDecisionRecords(records, balancedSelectedIds, today);
const balancedProfiles = computeOnePercentWheelProfiles(balancedRecords, [], { today });
const balancedTop20 = computeDynamicTop20WheelProfiles(balancedProfiles.profiles ?? [], {
  records: balancedRecords,
  today,
});

const currentRankMap = rankMapFromTop20(currentTop20);
const balancedRankMap = rankMapFromTop20(balancedTop20, true);
const top20Comparison = summarizeTop20Comparison(currentTop20, balancedTop20);

// ── tickers gonflés (duplication) ───────────────────────────────────────────
const duplicationByTicker = [];
const tickerSet = new Set(eligible.map((r) => sym(r?.symbol ?? r?.ticker)));
for (const ticker of tickerSet) {
  const rows = eligible.filter((r) => sym(r?.symbol ?? r?.ticker) === ticker);
  const assigned = rows.filter((r) => getAssignedFlag(r) === true);
  const distinctExp = new Set(rows.map(expKey).filter(Boolean)).size;
  const distinctExpAssigned = new Set(assigned.map(expKey).filter(Boolean)).size;
  if (assigned.length === 0 && rows.length < 3) continue;
  duplicationByTicker.push({
    ticker,
    observationAssignedCount: assigned.length,
    distinctExpirationAssignedCount: distinctExpAssigned,
    observationResolvedCount: rows.length,
    distinctExpirationCount: distinctExp,
    inflationRatio:
      distinctExpAssigned > 0
        ? round2(assigned.length / distinctExpAssigned)
        : assigned.length > 0
          ? assigned.length
          : rows.length > 0
            ? round2(rows.length / Math.max(distinctExp, 1))
            : null,
    currentTop20Rank: currentRankMap.get(ticker) ?? null,
    balancedSimulatedRank: balancedRankMap.get(ticker) ?? null,
    observationAssignmentRate: pct1((assigned.length / Math.max(rows.length, 1)) * 100),
    balancedAssignmentRate: policyResults.BALANCED.metrics.selectedAssignmentRate,
  });
}
duplicationByTicker.sort((a, b) => (b.inflationRatio ?? 0) - (a.inflationRatio ?? 0));

const inflatedTickers = duplicationByTicker.filter(
  (t) => (t.inflationRatio ?? 0) >= 2 || t.observationAssignedCount >= 3,
);

// ── tickers qui montent / descendent ──────────────────────────────────────────
const focusTickerRows = FOCUS_TICKERS.map((t) =>
  buildTickerRow(t, eligible, policyResults, currentRankMap, balancedRankMap),
);

const allTickerRows = [...tickerSet]
  .map((t) => buildTickerRow(t, eligible, policyResults, currentRankMap, balancedRankMap))
  .filter((t) => t.observationResolvedCount >= 5);

const tickersImproving = allTickerRows
  .filter((t) => {
    const obs = t.observationAssignmentRate;
    const bal = t.perPolicy.BALANCED.selectedAssignmentRate;
    if (obs == null || bal == null) return false;
    return bal <= obs - 5 || t.rankVerdict === "monte";
  })
  .sort((a, b) => (a.perPolicy.BALANCED.selectedAssignmentRate ?? 999) - (b.perPolicy.BALANCED.selectedAssignmentRate ?? 999))
  .slice(0, 20);

const tickersWorsening = allTickerRows
  .filter((t) => {
    const obs = t.observationAssignmentRate;
    const bal = t.perPolicy.BALANCED.selectedAssignmentRate;
    if (obs == null || bal == null) return false;
    return bal >= obs + 5 || t.rankVerdict === "descend";
  })
  .sort((a, b) => (b.perPolicy.BALANCED.selectedAssignmentRate ?? 0) - (a.perPolicy.BALANCED.selectedAssignmentRate ?? 0))
  .slice(0, 20);

// ── SAFE vs AGRESSIF ──────────────────────────────────────────────────────────
const safeVsAggressive = buildSafeVsAggressiveAnalysis(eligible);
const safeVsAggressiveFocus = Object.fromEntries(
  FOCUS_TICKERS.map((t) => [t, safeVsAggressive.byTicker[t] ?? { pairs: 0 }]),
);

// ── DTE ───────────────────────────────────────────────────────────────────────
const dteComparison = {
  observationnel: buildDteMetrics(eligible, "observationnel"),
  decisionBalanced: buildDteMetrics(policyResults.BALANCED.selected, "BALANCED"),
  decisionSafeFirst: buildDteMetrics(policyResults.SAFE_FIRST.selected, "SAFE_FIRST"),
  decisionYieldFirst: buildDteMetrics(policyResults.YIELD_FIRST.selected, "YIELD_FIRST"),
};

// ── recommandations J5-B ──────────────────────────────────────────────────────
const obsMetrics = computePolicyMetrics(eligible, eligible.length);
const balMetrics = policyResults.BALANCED.metrics;
const globalInflation = balMetrics.inflationRatio;

const j5bRecommendations = [
  {
    id: "J5-B1",
    title: "Facteur duplication / risk-event dans le score actuel",
    priority: "haute",
    rationale: `${eligible.length} observations éligibles vs ${balMetrics.selectedTradeCount} décisions BALANCED (ratio ${globalInflation}×). Pénaliser assignmentConcentrationPct et confirmedRepeatedRisk existants avec le dénominateur expiration, pas observation.`,
    action:
      "Dans computeE2bTickerEventUniqueness / score E2b : utiliser distinctAssignedExpirationCount comme base d'assignation, garder observation_count en métrique de confiance séparée.",
  },
  {
    id: "J5-B2",
    title: "Remplacer assignmentRate observationnel par selectedAssignmentRate",
    priority: "haute",
    rationale: `Global : assignation obs. ${obsMetrics.selectedAssignmentRate}% → BALANCED ${balMetrics.selectedAssignmentRate}% (${pct1(obsMetrics.selectedAssignmentRate - balMetrics.selectedAssignmentRate)} pts).`,
    action:
      "Avant computeOnePercentWheelProfiles pour Top 20 : réduire à 1 record par ticker×selectedExpiration (politique BALANCED par défaut) puis recalculer csp.assignmentRate.",
  },
  {
    id: "J5-B3",
    title: "deepAssignmentRate sur base décision réelle",
    priority: "haute",
    rationale: `Profonde obs. ${obsMetrics.selectedDeepAssignmentRate}% → BALANCED ${balMetrics.selectedDeepAssignmentRate}%.`,
    action: "Utiliser assignment.profondeRatePct des profils post-déduplication pour les pénalités E2b deepExpsPenalties.",
  },
  {
    id: "J5-B4",
    title: "SAFE vs AGRESSIF risk-adjusted",
    priority: "moyenne",
    rationale: `${safeVsAggressive.pairsWithBothModes} paires SAFE/AGG : SAFE aurait évité ${safeVsAggressive.safeWouldAvoidAssignment} assignations ; AGG payait plus ${safeVsAggressive.aggressivePaidMoreYield} fois.`,
    action:
      "Intégrer un tie-break SAFE quand rendement comparable (±0,15 %) dans la sélection pré-scoring ; exposer safeVsAggressive dans le diagnostic Top 20.",
  },
  {
    id: "J5-B5",
    title: "observation_count = confiance, pas score direct",
    priority: "moyenne",
    rationale: "Le n observationnel gonfle le mérite sample et les pénalités d'assignation sans refléter le risque réel.",
    action:
      "Conserver recordsResolved observationnel en badge « variantes testées » ; utiliser selectedTradeCount (expirations) pour n minimum E2b et crédibilité.",
  },
  {
    id: "J5-B6",
    title: "Recalibrer le seuil n minimum après déduplication",
    priority: "haute",
    rationale: `Après déduplication BALANCED, n max ≈ 5 expirations/ticker — le Top 20 strict E2b (n≥10) devient vide (${top20Comparison.balancedSimulatedTop20.length} ticker).`,
    action:
      "Ajuster E2B_EXPLOITABLE_MIN_N vers distinctExpirationCount (≈5–8) ou exiger n_observation≥30 ET n_decision≥5 ; ne pas bloquer la migration décisionnelle par un seuil observationnel.",
  },
];

const verdict = {
  global:
    globalInflation != null && globalInflation > 1.5
      ? `Le Top 20 actuel s'appuie sur ${eligible.length} observations (${obsMetrics.selectedAssignedCount} assignées) alors qu'une base « 1 décision par expiration » n'en retient ${balMetrics.selectedTradeCount} (${balMetrics.selectedAssignedCount} assignées). Ratio duplication global ≈ ${globalInflation}×. Assignation ${obsMetrics.selectedAssignmentRate}% → BALANCED ${balMetrics.selectedAssignmentRate}%.`
      : `Duplication modérée (${globalInflation}×) mais la base décision BALANCED change assignation (${obsMetrics.selectedAssignmentRate}% → ${balMetrics.selectedAssignmentRate}%) et profondeur (${obsMetrics.selectedDeepAssignmentRate}% → ${balMetrics.selectedDeepAssignmentRate}%).`,
  top20StrictEmpty:
    top20Comparison.balancedSimulatedTop20.length === 0
      ? "Top 20 strict simulé BALANCED = 0 ticker : après déduplication, aucun ticker n'atteint n≥10 (max ≈ 5 expirations/ticker). Comparaison de rang via projection score E2b (nearEntry + classement score)."
      : null,
  top20Overlap: `${top20Comparison.overlapCount}/20 tickers communs (${top20Comparison.comparisonUsed}).`,
  top20OverlapStrict: `${top20Comparison.overlapCountStrictTop20}/20 au seuil strict n≥10.`,
  bestPolicyForRealism: "BALANCED — équilibre rendement/risque sans oracle post-mortem.",
  oracleWarning:
    "BEST_OBSERVED est un plafond théorique post-mortem (oracle) : il choisit après coup la meilleure observation selon le résultat réel. Non tradable en live.",
  duplicationLeaders: inflatedTickers.slice(0, 8).map((t) => `${t.ticker} (${t.inflationRatio}×)`).join(", "),
};

// ── payload JSON ──────────────────────────────────────────────────────────────
const auditPayload = {
  generatedAt: new Date().toISOString(),
  phase: "Journal POP J5-A — audit Top 20 réaliste 1 décision/ticker×expiration (lecture seule)",
  readOnly: true,
  noProductionChanges: true,
  source: {
    journal: store.sqlitePath ?? "JSON wheelValidationStore",
    totalRecords: records.length,
    profileEligibleRecords: eligible.length,
    today,
  },
  definitions: {
    theoreticalDecision: "1 sélection par ticker + selectedExpiration",
    observationBaseline: "Toutes les observations éligibles Top 20 / 1%+ (résolues, expirées, hors intradayRetest)",
    inflationRatio: "observationsOriginalCount / selectedTradeCount",
    duplicationReductionRatio: "1 - selectedTradeCount / observationsOriginalCount",
    bestObservedDisclaimer:
      "BEST_OBSERVED = oracle post-mortem — plafond théorique, pas une stratégie tradable en live.",
  },
  policies: {
    SAFE_FIRST: {
      description:
        "Meilleure observation SAFE admissible ; sinon AGRESSIF. Préférence DTE 7>4>3>2, strike bas, spread propre.",
    },
    BALANCED: {
      description:
        "Équilibre rendement/risque, rendement ≥0,5 %, évite profondeur, préfère SAFE si rendement comparable.",
    },
    YIELD_FIRST: {
      description: "Meilleur rendement CSP admissible — mesure si courir la prime amplifie les profondeurs.",
    },
    BEST_OBSERVED: {
      description: "Oracle post-mortem — meilleure observation selon résultat réel. Non tradable.",
      tradable: false,
    },
  },
  verdict,
  globalPolicyMetrics: Object.fromEntries(
    POLICIES.map((p) => [p, policyResults[p].metrics]),
  ),
  q1_inflatedTickers: inflatedTickers.slice(0, 25),
  q2_tickersImproving: tickersImproving,
  q3_tickersWorsening: tickersWorsening,
  q4_safeVsAggressive: {
    global: {
      pairsWithBothModes: safeVsAggressive.pairsWithBothModes,
      safeWouldAvoidAssignment: safeVsAggressive.safeWouldAvoidAssignment,
      safeReducedDepth: safeVsAggressive.safeReducedDepth,
      aggressivePaidMoreYield: safeVsAggressive.aggressivePaidMoreYield,
      aggressiveWorthRisk: safeVsAggressive.aggressiveWorthRisk,
      aggressiveIncreasedDepth: safeVsAggressive.aggressiveIncreasedDepth,
    },
    focusTickers: safeVsAggressiveFocus,
  },
  q5_dteComparison: dteComparison,
  q6_top20Comparison: top20Comparison,
  focusTickers: focusTickerRows,
  j5bRecommendations,
  limits: [
    "Simulation read-only — aucune modification du moteur E2b, formule ou tri production.",
    "Top 20 simulé BALANCED recalcule profils + score E2b sur records dédupliqués ; le classement peut diverger pour d'autres facteurs (stress, bonus robuste).",
    "BEST_OBSERVED utilise le résultat post-expiration — biais look-ahead.",
    "Politiques appliquées sur le même pool éligible isOnePercentProfileRecord ; DTE hors 2/3/4/7 inclus dans les groupes.",
    "Cycles Wheel théoriques non re-simulés par décision — wheel metrics restent sur cycles existants.",
  ],
};

fs.writeFileSync(OUT_JSON, JSON.stringify(auditPayload, null, 2), "utf8");

// ── Markdown ──────────────────────────────────────────────────────────────────
const md = [];
md.push("# Audit J5-A — Top 20 réaliste « 1 décision par ticker×expiration »");
md.push("");
md.push(
  `> **Lecture seule** — généré le ${auditPayload.generatedAt.slice(0, 19)} · ${records.length} records · ${eligible.length} observations éligibles`,
);
md.push(`> Source : \`${auditPayload.source.journal}\``);
md.push("");

md.push("## Verdict global");
md.push("");
md.push(`**${verdict.global}**`);
md.push("");
md.push(`- Chevauchement Top 20 : ${verdict.top20Overlap}`);
if (verdict.top20StrictEmpty) md.push(`- ⚠️ ${verdict.top20StrictEmpty}`);
md.push(`- Chevauchement strict (n≥10) : ${verdict.top20OverlapStrict}`);
md.push(`- Tickers les plus gonflés : ${verdict.duplicationLeaders}`);
md.push(`- Politique recommandée pour J5-B : **${verdict.bestPolicyForRealism}**`);
md.push(`- ⚠️ ${verdict.oracleWarning}`);
md.push("");

md.push("## Méthodologie");
md.push("");
md.push("1. Charger `wheelValidationJournal.sqlite` via le store existant.");
md.push("2. Filtrer les observations éligibles (résolues, expirées, hors `intradayRetest`) — même base que Top 20 / 1%+.");
md.push("3. Grouper par `ticker + selectedExpiration`.");
md.push("4. Appliquer 4 politiques de sélection → 1 record par groupe.");
md.push("5. Comparer métriques observationnelles vs décision réelle.");
md.push("6. Reconstruire Top 20 actuel via `computeDynamicTop20WheelProfiles` ; simuler Top 20 BALANCED sur records dédupliqués.");
md.push("");

md.push("## Politiques simulées");
md.push("");
for (const [name, def] of Object.entries(auditPayload.policies)) {
  md.push(`### ${name}`);
  md.push("");
  md.push(def.description);
  if (def.tradable === false) md.push("");
  if (def.tradable === false) md.push("*Non tradable — oracle post-mortem uniquement.*");
  md.push("");
}

md.push("## Tableau global des politiques");
md.push("");
md.push(
  mdTable(
    [
      "Politique",
      "Trades",
      "Assign.%",
      "Prof.%",
      "Win%",
      "Rend.moy.%",
      "Rend méd.%",
      "Dup.reduc.",
      "Ratio dup.",
    ],
    POLICIES.map((p) => {
      const m = policyResults[p].metrics;
      return [
        p,
        m.selectedTradeCount,
        m.selectedAssignmentRate,
        m.selectedDeepAssignmentRate,
        m.selectedWinRate,
        m.selectedAvgCspYieldPct,
        m.selectedMedianCspYieldPct,
        m.duplicationReductionRatio,
        m.inflationRatio,
      ];
    }),
  ),
);
md.push("");

md.push("## Comparaison Top 20 actuel vs Top 20 simulé BALANCED");
md.push("");
md.push(`Méthode : ${top20Comparison.method}`);
md.push("");
md.push(`**Chevauchement : ${top20Comparison.overlapCount}/20** (${top20Comparison.comparisonUsed})`);
md.push("");
if (top20Comparison.balancedSimulatedTop20.length === 0) {
  md.push(
    "> **Limite importante** : le Top 20 strict simulé est **vide** (n max ≈ 5 après déduplication vs seuil E2b n≥10). Le tableau ci-dessous utilise la **projection par score E2b** post-déduplication.",
  );
  md.push("");
}
md.push("### Top 20 actuel (observationnel)");
md.push("");
md.push(
  mdTable(
    ["Rang", "Ticker", "Score", "N", "Assign.%", "Prof.%"],
    top20Comparison.currentTop20.map((r) => [r.rank, r.ticker, r.score, r.n, r.assignmentRate, r.deepAssignmentRate]),
  ),
);
md.push("");
md.push("### Top 20 simulé BALANCED (1 décision/expiration)");
md.push("");
const balancedDisplay =
  top20Comparison.balancedSimulatedTop20.length > 0
    ? top20Comparison.balancedSimulatedTop20
    : top20Comparison.balancedProjectedTop20ByScore;
md.push(
  mdTable(
    ["Rang", "Ticker", "Score", "N", "Assign.%", "Prof.%", "Statut"],
    balancedDisplay.map((r) => [
      r.rank,
      r.ticker,
      r.score,
      r.n,
      r.assignmentRate,
      r.deepAssignmentRate,
      r.status ?? r.note ?? "—",
    ]),
  ),
);
md.push("");
if (top20Comparison.balancedNearEntry.length > 0) {
  md.push("### Near entry simulé BALANCED (seuil score≥20, n≥5)");
  md.push("");
  md.push(
    mdTable(
      ["Rang", "Ticker", "Score", "N", "Assign.%"],
      top20Comparison.balancedNearEntry.map((r) => [r.rank, r.ticker, r.score, r.n, r.assignmentRate]),
    ),
  );
  md.push("");
}
if (top20Comparison.enteredTop20.length > 0) {
  md.push("**Entrants simulés :** " + top20Comparison.enteredTop20.map((r) => r.ticker).join(", "));
  md.push("");
}
if (top20Comparison.droppedFromTop20.length > 0) {
  md.push("**Sortants simulés :** " + top20Comparison.droppedFromTop20.map((r) => r.ticker).join(", "));
  md.push("");
}
md.push("### Plus grands changements de rang");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Rang actuel", "Rang BALANCED", "Delta", "Score actuel", "Score BALANCED"],
    top20Comparison.largestRankChanges.map((r) => [
      r.ticker,
      r.currentRank,
      r.balancedRank,
      r.delta,
      r.currentScore,
      r.balancedScore,
    ]),
  ),
);
md.push("");

md.push("## 1. Tickers gonflés par duplication");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Obs.assign.", "Exp.assign.", "Ratio", "Assign.obs.%", "Rang actuel", "Rang BALANCED"],
    inflatedTickers.slice(0, 15).map((t) => [
      t.ticker,
      t.observationAssignedCount,
      t.distinctExpirationAssignedCount,
      t.inflationRatio,
      t.observationAssignmentRate,
      t.currentTop20Rank ?? "—",
      t.balancedSimulatedRank ?? "—",
    ]),
  ),
);
md.push("");

md.push("## 2. Tickers meilleurs en base décision réelle");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Assign.obs.%", "Assign BALANCED%", "Verdict rang", "Rang actuel", "Rang BALANCED"],
    tickersImproving.slice(0, 12).map((t) => [
      t.ticker,
      t.observationAssignmentRate,
      t.perPolicy.BALANCED.selectedAssignmentRate,
      t.rankVerdict,
      t.currentTop20Rank ?? "—",
      t.balancedSimulatedRank ?? "—",
    ]),
  ),
);
md.push("");

md.push("## 3. Tickers moins bons en base décision réelle");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Assign.obs.%", "Assign BALANCED%", "Verdict rang", "Rang actuel", "Rang BALANCED"],
    tickersWorsening.slice(0, 12).map((t) => [
      t.ticker,
      t.observationAssignmentRate,
      t.perPolicy.BALANCED.selectedAssignmentRate,
      t.rankVerdict,
      t.currentTop20Rank ?? "—",
      t.balancedSimulatedRank ?? "—",
    ]),
  ),
);
md.push("");

md.push("## 4. SAFE vs AGRESSIF");
md.push("");
const sva = auditPayload.q4_safeVsAggressive.global;
md.push(`- Paires SAFE+AGG (même ticker×expiration×DTE) : **${sva.pairsWithBothModes}**`);
md.push(`- SAFE aurait évité l'assignation : **${sva.safeWouldAvoidAssignment}** fois`);
md.push(`- SAFE réduisait la profondeur : **${sva.safeReducedDepth}** fois`);
md.push(`- AGRESSIF payait plus (rendement) : **${sva.aggressivePaidMoreYield}** fois`);
md.push(`- AGRESSIF valait le risque : **${sva.aggressiveWorthRisk}** fois`);
md.push(`- AGRESSIF augmentait la profondeur : **${sva.aggressiveIncreasedDepth}** fois`);
md.push("");
md.push("### Focus tickers");
md.push("");
md.push(
  mdTable(
    ["Ticker", "Paires", "SAFE évite", "SAFE ↓prof.", "AGG +rend.", "AGG valait", "AGG ↑prof."],
    FOCUS_TICKERS.map((t) => {
      const f = safeVsAggressiveFocus[t] ?? {};
      return [t, f.pairs ?? 0, f.safeAvoids ?? 0, f.safeReducedDepth ?? 0, f.aggPaidMore ?? 0, f.aggWorthRisk ?? 0, f.aggIncreasedDepth ?? 0];
    }),
  ),
);
md.push("");

md.push("## 5. DTE — observationnel vs décision réelle");
md.push("");
md.push(
  mdTable(
    ["DTE", "Base", "N", "Assign.%", "Prof.%", "Rend.%", "Win%", "Verdict"],
    DTE_BUCKETS.flatMap((d) => {
      const obs = dteComparison.observationnel[d];
      const bal = dteComparison.decisionBalanced[d];
      return [
        [d, "observationnel", obs.nSelectedTrades, obs.assignmentRate, obs.deepAssignmentRate, obs.avgYield, obs.winRate, obs.verdict],
        [d, "BALANCED", bal.nSelectedTrades, bal.assignmentRate, bal.deepAssignmentRate, bal.avgYield, bal.winRate, bal.verdict],
      ];
    }),
  ),
);
md.push("");

md.push("## 6. Tableau par ticker focus");
md.push("");
md.push(
  mdTable(
    [
      "Ticker",
      "Obs.rés.",
      "Obs.assign.",
      "Exp.dist.",
      "Ratio dup.",
      "Rang actuel",
      "Rang BALANCED",
      "Assign BAL.%",
      "Prof BAL.%",
      "Mode BAL.",
      "DTE BAL.",
      "Verdict",
    ],
    focusTickerRows.map((t) => [
      t.ticker,
      t.observationResolvedCount,
      t.observationAssignedCount,
      t.distinctExpirationCount,
      t.inflationRatio,
      t.currentTop20Rank ?? "—",
      t.balancedSimulatedRank ?? "—",
      t.perPolicy.BALANCED.selectedAssignmentRate,
      t.perPolicy.BALANCED.selectedDeepAssignmentRate,
      t.perPolicy.BALANCED.bestMode,
      t.perPolicy.BALANCED.bestDte,
      t.rankVerdict,
    ]),
  ),
);
md.push("");

md.push("## Recommandation J5-B");
md.push("");
for (const r of j5bRecommendations) {
  md.push(`### ${r.id} — ${r.title} (${r.priority})`);
  md.push("");
  md.push(r.rationale);
  md.push("");
  md.push(`**Action :** ${r.action}`);
  md.push("");
}

md.push("## Limites");
md.push("");
for (const l of auditPayload.limits) md.push(`- ${l}`);
md.push("");

fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

// ── Console ───────────────────────────────────────────────────────────────────
console.log("══════════════════════════════════════════════════════════════════════");
console.log("  AUDIT J5-A READ-ONLY — Top 20 réaliste 1 décision/ticker×expiration");
console.log("══════════════════════════════════════════════════════════════════════");
console.log(`  Source : ${auditPayload.source.journal}`);
console.log(`  Observations éligibles : ${eligible.length} → décisions BALANCED : ${balMetrics.selectedTradeCount}`);
console.log(`  Ratio duplication : ${globalInflation}× · réduction : ${balMetrics.duplicationReductionRatio}`);
console.log(`  Top 20 strict simulé : ${top20Comparison.balancedSimulatedTop20.length} · projection score : ${top20Comparison.balancedProjectedTop20ByScore.length}`);
console.log("");
console.log("── POLITIQUES (assign.% / prof.% / rend.moy.%) ───────────────────────");
for (const p of POLICIES) {
  const m = policyResults[p].metrics;
  console.log(
    `  ${p.padEnd(14)} trades=${String(m.selectedTradeCount).padStart(4)} assign=${String(m.selectedAssignmentRate ?? "—").padStart(5)}% prof=${String(m.selectedDeepAssignmentRate ?? "—").padStart(5)}% yield=${m.selectedAvgCspYieldPct ?? "—"}%`,
  );
}
console.log("");
console.log("── TOP 20 chevauchement BALANCED ──────────────────────────────────────");
console.log(`  ${top20Comparison.overlapCount}/20 communs (${top20Comparison.comparisonUsed.slice(0, 60)}…)`);
console.log(`  sortants: ${top20Comparison.droppedFromTop20.map((r) => r.ticker).join(", ") || "—"}`);
console.log("");
console.log("── FOCUS (dup. / rang) ────────────────────────────────────────────────");
for (const t of focusTickerRows) {
  console.log(
    `  ${t.ticker.padEnd(6)} obs=${String(t.observationResolvedCount).padStart(3)} assign=${String(t.observationAssignedCount).padStart(2)} dup=${t.inflationRatio ?? "—"}× rang ${t.currentTop20Rank ?? "—"} → ${t.balancedSimulatedRank ?? "—"} (${t.rankVerdict})`,
  );
}
console.log("");
console.log(`JSON : ${OUT_JSON}`);
console.log(`MD   : ${OUT_MD}`);
