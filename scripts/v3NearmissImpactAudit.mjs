/**
 * Audit read-only : pourquoi les near-miss V3 (OKLO, SHOP, …) ne sont pas dans les combos AGGRESSIVE/BALANCED.
 * Ne modifie aucune logique métier — rejoue watchlist → scan → buildPortfolioCombos et diagnostique les filtres / allocation.
 *
 * Usage :
 *   node scripts/v3NearmissImpactAudit.mjs --ref-audit debug/v3-end-to-end-audit-2026-05-17T11-05-09.json --aggressive-audit debug/v3-aggressive-impact-audit-2026-05-17T11-10-55.json
 *   node scripts/v3NearmissImpactAudit.mjs --symbols OKLO,SHOP,CRM,MP,APLD
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_SCAN_TICKERS } from "../app/config/constants.js";
import { createMarketDataProvider } from "../app/data_providers/createMarketDataProvider.js";
import { createWheelScanner } from "../app/scanners/wheelScanner.js";
import { createWatchlistBuilder } from "../app/watchlist/watchlistBuilder.js";
import { createWatchlistCache } from "../app/watchlist/watchlistCache.js";
import { createMarketService } from "../app/services/marketService.js";

import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  computeTickerQualityOverlay,
  getFinalDisplayRecommendation,
  getLegPremiumValue,
  getLegSpreadPct,
  getLegYieldPct,
  getLegDistancePct,
  getLegPopPct,
} from "../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const DEFAULT_BUILD_CRITERIA = {
  maxPrice: 200,
  minPrice: 10,
  minVolume: 1_000_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  liquidityOtmProbePct: 5,
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
};

/** Extraits de modeConfigs[0] AGGRESSIVE dans capitalComboPortfolio.js (lecture seule, pas de mutation du moteur). */
const AGGRESSIVE_CFG = {
  minWeeklyYield: 0.95,
  maxWeeklyYield: null,
  minExecutionScore: 0.45,
  maxSpreadPct: 25,
  minDistancePct: -5,
  allowedGrades: new Set(["A", "B"]),
  yieldHardCapNote: "Sert au score, pas comme filtre dur maxWeeklyYield (null en AGGRESSIVE).",
};

/** Extraits de modeConfigs[1] BALANCED */
const BALANCED_CFG = {
  minWeeklyYield: 0.7,
  maxWeeklyYield: 1.05,
  minExecutionScore: 0,
  maxSpreadPct: 20,
  yieldBandPreferLo: 0.75,
  yieldBandPreferHi: 1.05,
};

function auditStamp() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

function logLine(msg) {
  console.warn(msg);
}

function nextFridayYmd() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

function readJsonSafe(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {
    expiration: null,
    capital: 25_500,
    maxCapitalPct: 95,
    maxPositions: 8,
    topN: 150,
    sort: "quality",
    refAuditPath: null,
    aggressiveAuditPath: null,
    symbols: ["OKLO", "SHOP", "CRM", "MP", "APLD"],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--expiration" && argv[i + 1]) out.expiration = String(argv[++i]).trim();
    else if (a === "--capital" && argv[i + 1]) out.capital = Number(argv[++i]) || out.capital;
    else if (a === "--max-capital-pct" && argv[i + 1]) out.maxCapitalPct = Number(argv[++i]) || out.maxCapitalPct;
    else if (a === "--max-positions" && argv[i + 1]) out.maxPositions = Number(argv[++i]) || out.maxPositions;
    else if (a === "--topN" && argv[i + 1]) out.topN = Number(argv[++i]) || out.topN;
    else if (a === "--ref-audit" && argv[i + 1]) out.refAuditPath = String(argv[++i]).trim();
    else if (a === "--aggressive-audit" && argv[i + 1]) out.aggressiveAuditPath = String(argv[++i]).trim();
    else if (a === "--symbols" && argv[i + 1]) {
      out.symbols = String(argv[++i])
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} item
 */
function mapScanItemToComboCandidate(item) {
  const spot = Number(item.currentPrice) || 0;
  const hasBackendScores =
    Number.isFinite(Number(item?.finalScore)) &&
    Number.isFinite(Number(item?.executionScore)) &&
    Number.isFinite(Number(item?.distanceScore));
  const fallbackExecutionScore = 0;
  const proExecutionScore = hasBackendScores ? Number(item.executionScore) : fallbackExecutionScore;

  /** @param {Record<string, unknown> | null | undefined} leg */
  const mapLeg = (leg) => {
    if (!leg || typeof leg !== "object") return null;
    const wy = Number(leg.weeklyYield);
    const weeklyYieldPct = Number.isFinite(wy) && wy > 0 ? wy * 100 : null;
    const strike = Number(leg.strike);
    const dist =
      spot > 0 && Number.isFinite(strike)
        ? ((strike - spot) / spot) * 100
        : Number(leg.distancePct) || 0;
    const popRaw = leg.popEstimate;
    return {
      strike: leg.strike,
      bid: leg.bid,
      ask: leg.ask,
      premium: leg.premium,
      conservativePremium: leg.conservativePremium,
      premiumUsed: leg.premiumUsed ?? leg.conservativePremium ?? leg.bid,
      primeUsed: leg.primeUsed,
      mid: leg.premium ?? leg.mid,
      liquidity: leg.liquidity,
      weeklyYield: weeklyYieldPct,
      periodYield: weeklyYieldPct,
      distancePct: dist,
      popEstimate: popRaw,
      popProfitEstimated: popRaw,
      impliedVolatility: leg.impliedVolatility,
    };
  };

  const safeStrike = mapLeg(item.safeStrike);
  const aggressiveStrike = mapLeg(item.aggressiveStrike);
  const rec = getFinalDisplayRecommendation({
    safeStrike,
    aggressiveStrike,
    safeGrade: item.safeGrade ?? null,
    aggressiveGrade: item.aggressiveGrade ?? null,
    recommendationDiagnostics: item.recommendationDiagnostics ?? null,
  });

  return {
    ticker: String(item.symbol || "").trim().toUpperCase(),
    symbol: item.symbol,
    currentPrice: spot,
    safeStrike,
    aggressiveStrike,
    finalDisplayMode: rec.finalDisplayMode,
    finalDisplayGrade: rec.finalDisplayGrade,
    qualityScore: item.qualityScore ?? null,
    finalScore: item.finalScore ?? null,
    executionScore: item.executionScore ?? null,
    proExecutionScore,
    distanceScore: item.distanceScore ?? null,
    dteDays: item.dteDays ?? null,
    passesFilter: item.passesFilter === true,
    optionsSource: item.liquiditySource ? "yahoo_strict" : "Yahoo fallback",
  };
}

function aggressiveWatchPremiumAllows(c) {
  const pop = c._popForCombo;
  const spread = c.selectedSpreadPct;
  const yld = c.selectedYieldPct;
  const dist = c.selectedDistancePct;
  return (
    pop != null &&
    pop >= 85 &&
    (spread == null || spread <= 20) &&
    yld != null &&
    yld >= 0.9 &&
    dist != null &&
    dist <= -6
  );
}

function aggressiveFilterCandidate(c) {
  const ov = c._qualityOverlay;
  if (!ov) return { ok: true };
  if (ov.qualityTier === "avoid") return { ok: false, reason: "qualityOverlay.tier=avoid" };
  if (ov.premiumTrapPenalty >= 0.4 && (c._popForCombo == null || c._popForCombo < 82)) {
    return { ok: false, reason: "premium_trap_fort_et_POP<82" };
  }
  if (ov.qualityTier === "speculative" && c.selectedSpreadPct != null && c.selectedSpreadPct > 20) {
    return { ok: false, reason: "tier_speculative_et_spread>20pct" };
  }
  return { ok: true };
}

function balancedFilterCandidate(c) {
  const ov = c._qualityOverlay;
  if (!ov) return { ok: true };
  if (ov.qualityTier === "avoid") return { ok: false, reason: "qualityOverlay.tier=avoid" };
  if (ov.qualityTier === "speculative") {
    if (c._popForCombo == null || c._popForCombo < 82) return { ok: false, reason: "speculative_POP<82" };
    if (c.selectedSpreadPct != null && c.selectedSpreadPct > 20) return { ok: false, reason: "speculative_spread>20" };
    if ((c.selectedYieldPct ?? 0) < 0.75) return { ok: false, reason: "speculative_yield<0.75pct" };
  }
  return { ok: true };
}

/**
 * Reproduit la résolution de jambe AGGRESSIVE (extrait de makeCombo mode aggressive).
 * @param {ReturnType<typeof buildCapitalComboCandidate>} base
 */
function applyAggressiveBucketOverlay(base) {
  if (!base._hasAggLegValid) return { ok: false, reason: "_hasAggLegValid=false", candidate: null };
  const bucketLeg = base._aggLeg;
  const bucketStrikeValue = base._aggStrikeValue;
  const bucketCapital = base._aggCapital;
  const bucketGrade = base._aggGrade;
  const bucketPremium = getLegPremiumValue(bucketLeg);
  const bucketSpread = getLegSpreadPct(bucketLeg);
  const bucketYield = getLegYieldPct(bucketLeg, base);
  const bucketDistance = getLegDistancePct(bucketLeg);
  const bucketPop = getLegPopPct(bucketLeg);
  const resolvedCapital =
    Number.isFinite(bucketStrikeValue) && bucketStrikeValue > 0 ? bucketStrikeValue * 100 : bucketCapital;
  const resolvedGrade = String(bucketGrade ?? base.finalDisplayGrade ?? "").toUpperCase();

  const c = {
    ...base,
    selectedLeg: bucketLeg,
    selectedStrikeValue: bucketStrikeValue,
    selectedPremiumUnit: bucketPremium,
    selectedSpreadPct: bucketSpread,
    selectedYieldPct: bucketYield,
    selectedDistancePct: bucketDistance,
    _popForCombo: bucketPop,
    capitalPerContract: resolvedCapital,
    premiumPerContract: Number.isFinite(bucketPremium) && bucketPremium > 0 ? bucketPremium * 100 : 0,
    finalDisplayGrade: resolvedGrade || base.finalDisplayGrade,
    weeklyReturn: bucketYield ?? base.weeklyReturn,
    spreadPct: bucketSpread ?? base.spreadPct,
    _qualityOverlay: computeTickerQualityOverlay({
      ...base,
      spreadPct: bucketSpread,
      weeklyReturn: bucketYield,
      _popForCombo: bucketPop,
    }),
  };
  return { ok: true, candidate: c };
}

/**
 * Résolution jambe BALANCED simplifiée (même branchement que makeCombo mode balanced, lignes ~994-1023).
 * @param {ReturnType<typeof buildCapitalComboCandidate>} base
 */
function applyBalancedBucketOverlay(base) {
  const safeY = base._safeYieldPct;
  const aggY = base._aggYieldPct;
  const safeInRange = base._hasSafeLegValid && safeY >= 0.75 && safeY < 1.05;
  const aggInRange = base._hasAggLegValid && aggY >= 0.75 && aggY < 1.05;
  const MID = 0.875;
  let bucketLeg = null;
  let bucketStrikeValue = null;
  let bucketCapital = 0;
  let bucketGrade = null;

  if (safeInRange && aggInRange) {
    if (Math.abs(safeY - MID) <= Math.abs(aggY - MID)) {
      bucketLeg = base._safeLeg;
      bucketStrikeValue = base._safeStrikeValue;
      bucketCapital = base._safeCapital;
      bucketGrade = base._safeGrade;
    } else {
      bucketLeg = base._aggLeg;
      bucketStrikeValue = base._aggStrikeValue;
      bucketCapital = base._aggCapital;
      bucketGrade = base._aggGrade;
    }
  } else if (safeInRange) {
    bucketLeg = base._safeLeg;
    bucketStrikeValue = base._safeStrikeValue;
    bucketCapital = base._safeCapital;
    bucketGrade = base._safeGrade;
  } else if (aggInRange) {
    bucketLeg = base._aggLeg;
    bucketStrikeValue = base._aggStrikeValue;
    bucketCapital = base._aggCapital;
    bucketGrade = base._aggGrade;
  } else if (base._hasAggLegValid) {
    bucketLeg = base._aggLeg;
    bucketStrikeValue = base._aggStrikeValue;
    bucketCapital = base._aggCapital;
    bucketGrade = base._aggGrade;
  } else if (base._hasSafeLegValid) {
    bucketLeg = base._safeLeg;
    bucketStrikeValue = base._safeStrikeValue;
    bucketCapital = base._safeCapital;
    bucketGrade = base._safeGrade;
  }

  if (!bucketLeg) return { ok: false, reason: "aucune_jambe_balanced_resolue", candidate: null };

  const bucketPremium = getLegPremiumValue(bucketLeg);
  const bucketSpread = getLegSpreadPct(bucketLeg);
  const bucketYield = getLegYieldPct(bucketLeg, base);
  const bucketDistance = getLegDistancePct(bucketLeg);
  const bucketPop = getLegPopPct(bucketLeg);
  const resolvedCapital =
    Number.isFinite(bucketStrikeValue) && bucketStrikeValue > 0 ? bucketStrikeValue * 100 : bucketCapital;
  const resolvedGrade = String(bucketGrade ?? base.finalDisplayGrade ?? "").toUpperCase();

  const c = {
    ...base,
    selectedLeg: bucketLeg,
    selectedStrikeValue: bucketStrikeValue,
    selectedPremiumUnit: bucketPremium,
    selectedSpreadPct: bucketSpread,
    selectedYieldPct: bucketYield,
    selectedDistancePct: bucketDistance,
    _popForCombo: bucketPop,
    capitalPerContract: resolvedCapital,
    premiumPerContract: Number.isFinite(bucketPremium) && bucketPremium > 0 ? bucketPremium * 100 : 0,
    finalDisplayGrade: resolvedGrade || base.finalDisplayGrade,
    weeklyReturn: bucketYield ?? base.weeklyReturn,
    spreadPct: bucketSpread ?? base.spreadPct,
    _qualityOverlay: computeTickerQualityOverlay({
      ...base,
      spreadPct: bucketSpread,
      weeklyReturn: bucketYield,
      _popForCombo: bucketPop,
    }),
    _balancedLegChoice:
      bucketLeg === base._safeLeg ? "SAFE" : bucketLeg === base._aggLeg ? "AGGRESSIVE" : "unknown",
  };
  return { ok: true, candidate: c };
}

function diagnoseModePipeline(modeLabel, c, cfg, filterCandidateFn, watchPremiumFn) {
  /** @type {{ stage: string, ok: boolean, detail?: string }[]} */
  const stages = [];

  if (!(c.capitalPerContract > 0 && c.capitalPerContract <= cfg.usableCapital && c.weeklyReturn > 0)) {
    stages.push({
      stage: "capital_or_yield_positive",
      ok: false,
      detail: `capitalPerContract=${c.capitalPerContract} usable=${cfg.usableCapital} weeklyReturn=${c.weeklyReturn}`,
    });
    return { passedPool: false, stages, poolFailReason: stages[stages.length - 1].detail };
  }
  stages.push({ stage: "capital_or_yield_positive", ok: true });

  const grade = String(c.finalDisplayGrade ?? "").toUpperCase();
  const gradeOk =
    cfg.allowedGrades.has(grade) || (grade === "WATCH" && watchPremiumFn(c));
  stages.push({
    stage: "grade_or_watch_premium",
    ok: gradeOk,
    detail: `grade=${grade} watchPremium=${grade === "WATCH" ? watchPremiumFn(c) : "n/a"}`,
  });
  if (!gradeOk) {
    return { passedPool: false, stages, poolFailReason: `grade_${grade}_hors_A_B_et_watch_non_qualifie` };
  }

  if (c.weeklyReturn < cfg.minWeeklyYield) {
    stages.push({ stage: "minWeeklyYield", ok: false, detail: `${c.weeklyReturn} < ${cfg.minWeeklyYield}` });
    return { passedPool: false, stages, poolFailReason: "yield_sous_min_weekly" };
  }
  stages.push({ stage: "minWeeklyYield", ok: true });

  if (cfg.maxWeeklyYield != null && !(c.weeklyReturn < cfg.maxWeeklyYield)) {
    stages.push({
      stage: "maxWeeklyYield",
      ok: false,
      detail: `${c.weeklyReturn} >= ${cfg.maxWeeklyYield}`,
    });
    return { passedPool: false, stages, poolFailReason: "yield_au_dessus_max_weekly_balanced" };
  }
  stages.push({ stage: "maxWeeklyYield", ok: true });

  const exec = c.proExecutionScore;
  const execOk = !Number.isFinite(exec) || exec >= cfg.minExecutionScore;
  stages.push({
    stage: "minExecutionScore",
    ok: execOk,
    detail: `proExecutionScore=${exec} min=${cfg.minExecutionScore}`,
  });
  if (!execOk) return { passedPool: false, stages, poolFailReason: "execution_score_sous_min_aggressive" };

  const spreadOk = c.spreadPct == null || c.spreadPct <= cfg.maxSpreadPct;
  stages.push({
    stage: "maxSpreadPct",
    ok: spreadOk,
    detail: `spread=${c.spreadPct} max=${cfg.maxSpreadPct}`,
  });
  if (!spreadOk) return { passedPool: false, stages, poolFailReason: "spread_au_dessus_max" };

  const distOk =
    cfg.minDistancePct == null ||
    c.selectedDistancePct == null ||
    c.selectedDistancePct <= cfg.minDistancePct;
  stages.push({
    stage: "minDistancePct_OTM",
    ok: distOk,
    detail: `distance=${c.selectedDistancePct} min_otm=${cfg.minDistancePct}`,
  });
  if (!distOk) return { passedPool: false, stages, poolFailReason: "distance_insuffisante_OTM_pour_aggressive" };

  const fc = filterCandidateFn(c);
  stages.push({ stage: "filterCandidate_quality", ok: fc.ok, detail: fc.reason ?? "ok" });
  if (!fc.ok) return { passedPool: false, stages, poolFailReason: fc.reason ?? "filter_quality" };

  return { passedPool: true, stages, poolFailReason: null };
}

function findResidualHit(combo, ticker) {
  const trace = combo?.capDiagnosticsV2?.allocationTraceV1;
  const residual = trace?.residualAnalysis?.nextBestCandidates ?? [];
  return residual.find((r) => String(r.ticker || "").trim().toUpperCase() === ticker) ?? null;
}

/**
 * Questions 1–10 à partir des audits JSON figés (sans shortlist brute ni replay marché).
 * @param {string} sym
 * @param {Record<string, unknown> | null} refAudit
 * @param {Record<string, unknown> | null} aggressiveAudit
 */
function buildReferenceAuditAnswers(sym, refAudit, aggressiveAudit) {
  if (!refAudit || typeof refAudit !== "object") {
    return {
      missingData: ["ref-audit absent"],
      consoleStatus: "NO_REF_AUDIT",
      consoleReason: "Ajouter --ref-audit debug/v3-end-to-end-audit-....json",
    };
  }
  const md = [];
  const recovered = Array.isArray(refAudit?.watchlistImpact?.v3RecoveredSymbols)
    ? refAudit.watchlistImpact.v3RecoveredSymbols.map((s) => String(s).trim().toUpperCase())
    : [];
  const v3Short = Array.isArray(refAudit?.shortlistImpact?.v3SymbolsInShortlist)
    ? refAudit.shortlistImpact.v3SymbolsInShortlist.map((s) => String(s).trim().toUpperCase())
    : [];
  const row = Array.isArray(refAudit?.shortlistImpact?.v3Rows)
    ? refAudit.shortlistImpact.v3Rows.find((r) => String(r?.symbol || "").trim().toUpperCase() === sym)
    : null;

  const aggBook = Array.isArray(refAudit?.bucketImpact?.aggressive?.v3SymbolsInBook)
    ? refAudit.bucketImpact.aggressive.v3SymbolsInBook.map((s) => String(s).trim().toUpperCase())
    : [];
  const balBook = Array.isArray(refAudit?.bucketImpact?.balanced?.v3SymbolsInBook)
    ? refAudit.bucketImpact.balanced.v3SymbolsInBook.map((s) => String(s).trim().toUpperCase())
    : [];
  const safeBook = Array.isArray(refAudit?.bucketImpact?.safe?.v3SymbolsInBook)
    ? refAudit.bucketImpact.safe.v3SymbolsInBook.map((s) => String(s).trim().toUpperCase())
    : [];

  if (!row) md.push("Pas de ligne shortlistImpact.v3Rows pour ce symbole dans ref-audit.");

  md.push(
    "expectedMove, lowerBound, POP jambe agressive, rendement hebdo agressif, strike ×100 : absents de l’export E2E analysé — besoin shortlist complète ou replay avec données marché.",
  );

  const passesRef = row?.passesFilter === true;
  const inAggRef = aggBook.includes(sym);
  const inBalRef = balBook.includes(sym);
  const inSafeRef = safeBook.includes(sym);

  const nearList = Array.isArray(aggressiveAudit?.nearMissV3Candidates)
    ? aggressiveAudit.nearMissV3Candidates.map((n) => String(n?.symbol || "").trim().toUpperCase())
    : [];
  const isNearListed = nearList.includes(sym);

  let consoleStatus = "REF_UNKNOWN";
  let consoleReason = "Audit ref incomplet.";
  if (!recovered.includes(sym)) {
    consoleStatus = "REF_NOT_V3_RECOVERED";
    consoleReason = "Pas dans watchlistImpact.v3RecoveredSymbols (session ref).";
  } else if (!v3Short.includes(sym)) {
    consoleStatus = "REF_NOT_V3_SHORTLIST_SLICE";
    consoleReason = "Recovered V3 mais absent de v3SymbolsInShortlist (ref).";
  } else if (!passesRef) {
    consoleStatus = "REF_FAILS_YAHOO_FILTER";
    consoleReason = "passesFilter=false dans ref (shortlist Yahoo).";
  } else if (inAggRef) {
    consoleStatus = "REF_IN_AGGRESSIVE_BOOK";
    consoleReason = "Présent dans bucketImpact.aggressive.v3SymbolsInBook (ref).";
  } else {
    consoleStatus = "REF_NEAR_MISS_COMBO_ALLOCATION";
    consoleReason =
      "Passés Yahoo (ref) mais non dans livre AGGRESSIVE figé : compétition sous positions limitées + score combo (rendement, grade jambe, spread, distance, qualité, capital fit, diversification) — pas un échec passesFilter. BALANCED ref : 0 ligne V3 (yield bande / jambe choisie safe vs agressive).";
    if (isNearListed) {
      consoleReason +=
        " Confirmé comme near-miss dans aggressive-impact audit (liste nearMissV3Candidates).";
    }
  }

  let q10 = "Voir consoleReason.";
  if (!passesRef) q10 = "Données / filtre Yahoo (passesFilter).";
  else if (!inAggRef && !inBalRef)
    q10 =
      "Surtout scoring + allocation Capital Combo (knapsack greedy, caps ticker/secteur/thème, diversification), avec qualité Yahoo backend faible pour plusieurs symboles malgré finalScore élevé ; BALANCED exclut souvent les grosses jambes agressives hors bande [0,75–1,05) % hebdo.";

  return {
    q1_dansWatchlistV3_ref: recovered.includes(sym),
    q2_dansShortlistV3Segment_ref: v3Short.includes(sym),
    q3_passesFilter_refAudit: row?.passesFilter ?? null,
    q4_scoreFinal_refAudit: row?.finalScore ?? null,
    q5_yieldPrimeCapital: {
      qualityScoreYahoo_ref: row?.qualityScore ?? null,
      safeAnnualizedYieldPct_ref: row?.safeAnnualizedYieldPct ?? null,
      v3Bucket_ref: row?.v3Bucket ?? null,
      missingDataAggressiveLegFr:
        "Rendement % hebdomadaire jambe AGGRESSIVE, prime utilisée (bid), capital strike×100 : non exportés dans ce JSON E2E.",
    },
    q6_popAggressive: { missingData: "POP jambe agressive non présent dans v3Rows / export E2E." },
    q7_expectedMove: { missingData: "Non présent dans shortlistImpact.v3Rows de cet export." },
    q8_lowerBound: { missingData: "Non présent dans shortlistImpact.v3Rows de cet export." },
    q9_raisonExclusionCombo_ref: passesRef
      ? !inAggRef
        ? "Hors top sélection AGGRESSIVE après filtres mode + tri score + allocation sous contraintes (positions max, capital 95 %, caps diversification)."
        : "Symbole dans livre AGGRESSIVE ref."
      : "Exclus avant combo par passesFilter Yahoo.",
    q10_typeProbleme_principal: q10,
    refCombos: {
      inAggressiveBook_ref: inAggRef,
      inBalancedBook_ref: inBalRef,
      inSafeBook_ref: inSafeRef,
      aggressivePositions_ref: refAudit?.bucketImpact?.aggressive?.positions ?? null,
      balancedV3LineCount_ref: refAudit?.bucketImpact?.balanced?.v3LineCount ?? null,
    },
    missingData: md,
    consoleStatus,
    consoleReason,
  };
}

async function run() {
  const args = parseArgs(process.argv);
  const expiration = args.expiration || nextFridayYmd();
  const usableCapital = args.capital * (args.maxCapitalPct / 100);

  const refPath = args.refAuditPath ? join(REPO_ROOT, args.refAuditPath) : null;
  const refAudit = refPath ? readJsonSafe(refPath) : null;
  const aggAuditPath = args.aggressiveAuditPath ? join(REPO_ROOT, args.aggressiveAuditPath) : null;
  const aggressiveAudit = aggAuditPath ? readJsonSafe(aggAuditPath) : null;

  const missingData = [];
  if (!refAudit) missingData.push("ref-audit JSON introuvable ou illisible — snapshot E2E croisé partiel.");
  if (!aggressiveAudit) missingData.push("aggressive-audit JSON introuvable — livre AGGRESSIVE figé croisé partiel.");

  const provider = createMarketDataProvider();
  const marketService = createMarketService(provider);
  const watchlistCache = createWatchlistCache();
  const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
  const wheelScanner = createWheelScanner(marketService);

  const v3Wl = await watchlistBuilder.buildWatchlist({ ...DEFAULT_BUILD_CRITERIA });
  const watchlistArr = v3Wl.watchlist || [];
  const v3Meta = v3Wl.yahooLiquidityV3LiveSafe || {};
  const recoveredArr = Array.isArray(v3Meta.recoveredSymbols) ? v3Meta.recoveredSymbols : [];
  const v3RecoveredSet = new Set(recoveredArr.map((s) => String(s).trim().toUpperCase()));

  const tickersForScan = watchlistArr
    .map((t) => String(t).trim().toUpperCase())
    .filter(Boolean)
    .slice(0, MAX_SCAN_TICKERS);

  const scanResult = await wheelScanner.scanShortlist({
    expiration,
    tickers: tickersForScan,
    topN: args.topN,
    sort: args.sort,
  });

  if (scanResult.status !== 200 || !scanResult.payload?.ok) {
    missingData.push(`scan_shortlist status=${scanResult.status} — données live incomplètes.`);
  }

  const payload = scanResult.payload || {};
  const shortlistFull = Array.isArray(payload.shortlist) ? payload.shortlist : [];
  const comboCandidates = shortlistFull.filter((it) => it.passesFilter === true).map(mapScanItemToComboCandidate);

  const combosFull = buildPortfolioCombos(
    comboCandidates,
    args.capital,
    args.maxCapitalPct,
    args.maxPositions,
    new Set(),
  );

  const aggCombo = combosFull.find((c) => String(c?.label || "").toUpperCase() === "AGGRESSIVE");
  const balCombo = combosFull.find((c) => String(c?.label || "").toUpperCase() === "BALANCED");
  const safeCombo = combosFull.find((c) => String(c?.label || "").toUpperCase() === "SAFE");

  const aggPickSet = new Set((aggCombo?.picks ?? []).map((p) => String(p.ticker).trim().toUpperCase()));
  const balPickSet = new Set((balCombo?.picks ?? []).map((p) => String(p.ticker).trim().toUpperCase()));
  const safePickSet = new Set((safeCombo?.picks ?? []).map((p) => String(p.ticker).trim().toUpperCase()));

  const refRows = Array.isArray(refAudit?.shortlistImpact?.v3Rows) ? refAudit.shortlistImpact.v3Rows : [];
  const refAggSyms = Array.isArray(refAudit?.bucketImpact?.aggressive?.v3SymbolsInBook)
    ? refAudit.bucketImpact.aggressive.v3SymbolsInBook.map((s) => String(s).trim().toUpperCase())
    : [];

  /** @type {Record<string, unknown>[]} */
  const focusReports = [];

  for (const rawSym of args.symbols) {
    const sym = String(rawSym || "").trim().toUpperCase();
    const row = shortlistFull.find((r) => String(r?.symbol || "").trim().toUpperCase() === sym) ?? null;
    const refRow = refRows.find((r) => r.symbol === sym) ?? null;

    const inV3Watchlist = v3RecoveredSet.has(sym);
    const inShortlist = !!row;
    const passesFilter = row?.passesFilter === true;

    const snap = refRow
      ? {
          source: "refAudit_v3Rows",
          yahooRankInShortlistSorted: refRow.yahooRankInShortlistSorted ?? null,
          passesFilter: refRow.passesFilter ?? null,
          finalScore: refRow.finalScore ?? null,
          qualityScore: refRow.qualityScore ?? null,
          safeAnnualizedYieldPct: refRow.safeAnnualizedYieldPct ?? null,
          v3Bucket: refRow.v3Bucket ?? null,
          preIbkrConfidenceBucket: refRow.preIbkrConfidenceBucket ?? null,
        }
      : { source: null, missingData: "Pas de ligne v3Rows dans ref-audit pour ce symbole." };

    let metrics = {
      finalScore: row?.finalScore ?? refRow?.finalScore ?? null,
      qualityScoreYahoo: row?.qualityScore ?? refRow?.qualityScore ?? null,
      executionScore: row?.executionScore ?? null,
      proExecutionScoreDerived: null,
      expectedMove: row?.expectedMove ?? row?.adjustedMove ?? null,
      expectedMovePercent: row?.expectedMovePercent ?? null,
      lowerBound: row?.lowerBound ?? null,
      currentPrice: row?.currentPrice ?? null,
      aggressiveWeeklyYieldPct: null,
      aggressivePopPct: null,
      aggressiveStrike: row?.aggressiveStrike?.strike ?? null,
      capitalRequiredUsd: null,
      conservativePremiumPerShare: row?.aggressiveStrike?.premiumUsed ?? row?.aggressiveStrike?.bid ?? null,
      safeAnnualizedYieldPct: row?.safeAnnualizedYieldPct ?? refRow?.safeAnnualizedYieldPct ?? null,
    };

    let comboDiagAggressive = null;
    let comboDiagBalanced = null;
    let exclusionCategory = null;
    let statusLine = "UNKNOWN";

    if (!row) {
      metrics.missingDataLive = "Absent du segment shortlist renvoyé par scan_shortlist (replay).";
      exclusionCategory = "donnees_shortlist";
      statusLine = `absent_shortlist_live ref_rank=${refRow?.yahooRankInShortlistSorted ?? "n/a"}`;
    } else {
      const mapped = mapScanItemToComboCandidate(row);
      metrics.proExecutionScoreDerived = mapped.proExecutionScore;
      const wy = Number(row.aggressiveStrike?.weeklyYield);
      metrics.aggressiveWeeklyYieldPct =
        Number.isFinite(wy) && wy > 0 ? Number((wy * 100).toFixed(6)) : null;
      const popR = row.aggressiveStrike?.popEstimate ?? row.aggressiveStrike?.popProfitEstimated;
      metrics.aggressivePopPct =
        popR != null ? (Number(popR) <= 1 ? Number(popR) * 100 : Number(popR)) : null;
      const strike = Number(row.aggressiveStrike?.strike);
      metrics.capitalRequiredUsd =
        Number.isFinite(strike) && strike > 0 ? Math.round(strike * 100 * 10000) / 10000 : null;

      const base = buildCapitalComboCandidate(mapped, usableCapital);
      const aggOv = applyAggressiveBucketOverlay(base);
      const balOv = applyBalancedBucketOverlay(base);

      const aggPipe =
        aggOv.ok && aggOv.candidate
          ? diagnoseModePipeline(
              "AGGRESSIVE",
              aggOv.candidate,
              { ...AGGRESSIVE_CFG, usableCapital },
              aggressiveFilterCandidate,
              aggressiveWatchPremiumAllows,
            )
          : { passedPool: false, stages: [], poolFailReason: aggOv.reason ?? "overlay_agg_failed" };

      const balPipe =
        balOv.ok && balOv.candidate
          ? diagnoseModePipeline(
              "BALANCED",
              balOv.candidate,
              {
                usableCapital,
                minWeeklyYield: BALANCED_CFG.minWeeklyYield,
                maxWeeklyYield: BALANCED_CFG.maxWeeklyYield,
                minExecutionScore: BALANCED_CFG.minExecutionScore,
                maxSpreadPct: BALANCED_CFG.maxSpreadPct,
                minDistancePct: null,
                allowedGrades: new Set(["A", "B"]),
              },
              balancedFilterCandidate,
              () => {
                const pop = balOv.candidate._popForCombo;
                const spread = balOv.candidate.selectedSpreadPct;
                const yld = balOv.candidate.selectedYieldPct;
                const dist = balOv.candidate.selectedDistancePct;
                return (
                  pop != null &&
                  pop >= 88 &&
                  (spread == null || spread <= 15) &&
                  yld != null &&
                  yld >= 0.75 &&
                  yld <= 1.05 &&
                  dist != null &&
                  dist <= -6
                );
              },
            )
          : { passedPool: false, stages: [], poolFailReason: balOv.reason ?? "overlay_bal_failed" };

      const inAgg = aggPickSet.has(sym);
      const inBal = balPickSet.has(sym);
      const inSafe = safePickSet.has(sym);

      const resAgg = findResidualHit(aggCombo, sym);
      const resBal = findResidualHit(balCombo, sym);

      comboDiagAggressive = {
        inBook: inAgg,
        passedPrefilterPool: aggPipe.passedPool,
        poolFailReason: aggPipe.poolFailReason,
        pipelineStages: aggPipe.stages,
        residualDiagnostic: resAgg,
      };
      comboDiagBalanced = {
        inBook: inBal,
        passedPrefilterPool: balPipe.passedPool,
        poolFailReason: balPipe.poolFailReason,
        pipelineStages: balPipe.stages,
        balancedLegChoice: balOv.candidate?._balancedLegChoice ?? null,
        residualDiagnostic: resBal,
      };

      if (!passesFilter) {
        exclusionCategory = "yahoo_passesFilter";
        statusLine = "rejete_shortlist passesFilter=false";
      } else if (!aggPipe.passedPool) {
        exclusionCategory = "filtre_combo_aggressive";
        statusLine = `hors_pool_AGGRESSIVE:${aggPipe.poolFailReason}`;
      } else if (!inAgg) {
        exclusionCategory = "allocation_ou_scoring_knapsack";
        statusLine = `pool_OK_mais_pas_alloue_AGGRESSIVE residual=${resAgg?.blockerTypeDiagnostic ?? resAgg?.reasonNotAdded ?? "voir_allocationTrace"}`;
      } else {
        statusLine = "dans_livre_AGGRESSIVE";
      }

      if (!inBal && passesFilter && balPipe.passedPool && exclusionCategory === "allocation_ou_scoring_knapsack") {
        // keep primary aggressive explanation; balanced often fails earlier on yield band
      }
    }

    const refFrozenNear =
      aggressiveAudit?.nearMissV3Candidates?.some((n) => n.symbol === sym) === true ||
      (refRow?.v3Recovered === true && refRow?.passesFilter === true && !refAggSyms.includes(sym));

    focusReports.push({
      symbol: sym,
      inV3Watchlist,
      inShortlistReturned: inShortlist,
      passesFilter,
      refAuditSnapshot: snap,
      metricsLiveWhenPresent: metrics,
      combos: {
        inAggressiveBook: aggPickSet.has(sym),
        inBalancedBook: balPickSet.has(sym),
        inSafeBook: safePickSet.has(sym),
        refAggressiveBookFromE2E: refAggSyms.includes(sym),
      },
      aggressivePrefilter: comboDiagAggressive,
      balancedPrefilter: comboDiagBalanced,
      exclusionCategoryFr:
        exclusionCategory === "yahoo_passesFilter"
          ? "Rejet scanner Yahoo (passesFilter) — pas candidat combo."
          : exclusionCategory === "filtre_combo_aggressive"
            ? "Filtré avant allocation par règles du mode AGGRESSIVE (grade, yield min, spread max, distance OTM, executionScore, quality overlay)."
            : exclusionCategory === "allocation_ou_scoring_knapsack"
              ? "Dans le pool filtré mais non choisi par l’allocateur greedy (capital, caps ticker/secteur/thème, diversification, rendement marginal)."
              : exclusionCategory === "donnees_shortlist"
                ? "Données live manquantes dans shortlist — impossible de rejouer jambe/prime/POP."
                : exclusionCategory == null && row?.passesFilter && aggPickSet.has(sym)
                  ? "Présent dans le livre AGGRESSIVE sur ce replay live."
                  : exclusionCategory ?? "Voir aggressivePrefilter et combos.",
      refFrozenNearMissNote: refFrozenNear
        ? "Étiqueté near-miss dans aggressive-audit ou E2E (V3+passesFilter mais pas dans livre AGGRESSIVE figé)."
        : null,
      answersFromReferenceAudit: buildReferenceAuditAnswers(sym, refAudit, aggressiveAudit),
    });
  }

  const liveReplayDead = watchlistArr.length === 0 || shortlistFull.length === 0;
  if (liveReplayDead) {
    missingData.push(
      "Replay live : watchlist ou shortlist vide — diagnostic combo live non disponible ; priorité aux champs answersFromReferenceAudit.",
    );
  }

  const verdictParts = [];
  const refNearMissCount = focusReports.filter(
    (r) => r.answersFromReferenceAudit?.consoleStatus === "REF_NEAR_MISS_COMBO_ALLOCATION",
  ).length;
  if (refAudit && refNearMissCount > 0) {
    verdictParts.push(
      `Figé E2E : ${refNearMissCount} symbole(s) focal(aux) OK Yahoo (ref) mais hors livre AGGRESSIVE → concurrence allocation/scoring (capitalComboPortfolio), pas un défaut V3 passesFilter.`,
    );
  }
  const anyLiveMiss = focusReports.some(
    (r) =>
      r.passesFilter &&
      r.aggressivePrefilter?.passedPrefilterPool &&
      !r.combos.inAggressiveBook,
  );
  const anyFiltered = focusReports.some((r) => r.exclusionCategoryFr?.includes("Filtré avant allocation"));
  if (anyLiveMiss) {
    verdictParts.push(
      "Au moins un symbole focal passe le préfiltre AGGRESSIVE mais n’est pas dans le livre → contraintes d’allocation / ordre greedy dominent.",
    );
  }
  if (anyFiltered) {
    verdictParts.push(
      "Au moins un symbole est exclu par les filtres du mode (yield, grade, spread, distance OTM, executionScore, tier quality) — pas seulement la diversification.",
    );
  }
  if (!anyLiveMiss && !anyFiltered && focusReports.every((r) => r.combos.inAggressiveBook || !r.inShortlistReturned)) {
    verdictParts.push(
      liveReplayDead && refNearMissCount > 0
        ? "Replay live inutilisable ; cause principale documentée via audits JSON (allocation combo)."
        : "Sur ce replay live, les exclusions observées viennent surtout du hors-shortlist ou du filtre combo ; sinon les titres sont dans le livre.",
    );
  }

  const exportedAt = new Date().toISOString();
  const out = {
    exportedAt,
    summary: {
      expiration,
      refAuditFile: args.refAuditPath,
      aggressiveAuditFile: args.aggressiveAuditPath,
      watchlistTotalLive: watchlistArr.length,
      v3RecoveredLive: v3RecoveredSet.size,
      scanShortlistCount: shortlistFull.length,
      comboEligiblePassesFilter: comboCandidates.length,
      aggressivePositionsLive: aggCombo?.positions ?? null,
      balancedPositionsLive: balCombo?.positions ?? null,
      verdictFr: verdictParts.join(" ") || "Voir answersFromReferenceAudit et aggressivePrefilter par symbole.",
      liveReplayDead,
      refNearMissCount,
    },
    focusSymbols: args.symbols,
    reports: focusReports,
    engineNoteFr:
      "Diagnostic préfiltre calqué sur capitalComboPortfolio.js (AGGRESSIVE/BALANCED). L’allocation finale utilise un score composite + greedy ; consulter capDiagnosticsV2.allocationTraceV1 pour le détail.",
    missingData,
  };

  const debugDir = join(REPO_ROOT, "debug");
  mkdirSync(debugDir, { recursive: true });
  const filename = `v3-nearmiss-impact-audit-${auditStamp()}.json`;
  const outPath = join(debugDir, filename);
  writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  for (const r of focusReports) {
    const a = r.answersFromReferenceAudit || {};
    logLine(`[v3-nearmiss] ${r.symbol} status=${a.consoleStatus ?? "n/a"} reason=${a.consoleReason ?? r.exclusionCategoryFr ?? ""}`);
  }
  logLine(`[v3-nearmiss] verdict=${out.summary.verdictFr}`);
  logLine(`[v3-nearmiss] wrote ${outPath}`);

  process.exitCode = 0;
}

run().catch((e) => {
  console.error("[v3-nearmiss] fatal", e);
  process.exitCode = 1;
});
