/**
 * SAFE spread rescue — recherche locale autour du strike SAFE original
 * quand celui-ci est rejeté pour spread (gradeLeg REJECT).
 *
 * Fenêtre IBKR two-phase par défaut : 10 strikes sous l'agressif (voir TWO_PHASE_PUT_WINDOW).
 * Ce rescue n'élargit pas la fenêtre globale ; il regarde seulement ±2/+4 strikes
 * autour du SAFE choisi, en réutilisant putCandidates ou quotes déjà fetchées.
 */

/** Miroir Python TWO_PHASE_DEFAULT_PUT_WINDOW / IBKR_TWO_PHASE_PUT_WINDOW. */
export const TWO_PHASE_PUT_WINDOW = 10;

export const SAFE_SPREAD_RESCUE_STRIKES_ABOVE = 2;
export const SAFE_SPREAD_RESCUE_STRIKES_BELOW = 4;

/** Seuil gradeLeg REJECT (spread > 35 %). */
export const SAFE_SPREAD_REJECT_PCT = 35;

/** Spread « acceptable » pour le tri (grade B). */
export const SAFE_SPREAD_ACCEPTABLE_PCT = 20;

/** Rendement minimum SAFE (0,5 % par expiration). */
export const SAFE_MIN_YIELD_PCT = 0.5;

export function normalizeSpreadPctPercent(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x)) return null;
  if (x >= 0 && x <= 1.0001) return x * 100;
  return x;
}

export function premiumYieldPctFromPut(put) {
  const strike = Number(put?.strike);
  const prime =
    Number(put?.primeUsed ?? put?.premiumUsed ?? put?.bid ?? put?.conservativePremium);
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(prime) || prime <= 0) {
    return null;
  }
  const fromField = Number(put?.premiumYield ?? put?.weeklyYield);
  if (Number.isFinite(fromField) && fromField > 0) {
    return fromField <= 1 ? fromField * 100 : fromField;
  }
  return (prime / strike) * 100;
}

export function isSafeRejectedForSpread(spreadPctRaw) {
  const spreadPct = normalizeSpreadPctPercent(spreadPctRaw);
  if (spreadPct == null) return false;
  return spreadPct > SAFE_SPREAD_REJECT_PCT;
}

export function isSpreadAcceptable(spreadPctRaw) {
  const spreadPct = normalizeSpreadPctPercent(spreadPctRaw);
  if (spreadPct == null) return false;
  return spreadPct <= SAFE_SPREAD_ACCEPTABLE_PCT;
}

/**
 * Strikes de rescue : jusqu'à 2 au-dessus et 4 en-dessous sur l'échelle triée.
 */
export function buildSafeRescueStrikeWindow(
  originalStrike,
  sortedStrikes,
  strikesAbove = SAFE_SPREAD_RESCUE_STRIKES_ABOVE,
  strikesBelow = SAFE_SPREAD_RESCUE_STRIKES_BELOW
) {
  const strike = Number(originalStrike);
  if (!Number.isFinite(strike)) return [];
  const ladder = [...new Set((sortedStrikes || []).map(Number).filter(Number.isFinite))].sort(
    (a, b) => a - b
  );
  if (!ladder.length) return [];

  let idx = ladder.indexOf(strike);
  if (idx === -1) {
    idx = ladder.findIndex((s) => s >= strike);
    if (idx === -1) idx = ladder.length;
    else if (idx > 0 && Math.abs(ladder[idx - 1] - strike) < Math.abs(ladder[idx] - strike)) {
      idx -= 1;
    }
  }

  const below = ladder.slice(Math.max(0, idx - strikesBelow), idx);
  const above = ladder.slice(idx + 1, idx + 1 + strikesAbove);
  return [...below, ...above].filter((s) => s !== strike);
}

function putSpreadPct(put) {
  return normalizeSpreadPctPercent(put?.spreadPct ?? put?.liquidity?.spreadPct);
}

function isUsableBid(put) {
  const bid = Number(put?.bid ?? put?.primeUsed ?? put?.premiumUsed);
  return Number.isFinite(bid) && bid > 0;
}

function meetsMinPremium(put, targetPremium) {
  const prime = Number(put?.primeUsed ?? put?.premiumUsed ?? put?.bid ?? put?.conservativePremium);
  const tgt = Number(targetPremium);
  if (!Number.isFinite(prime) || !Number.isFinite(tgt) || tgt <= 0) return prime > 0;
  return prime >= tgt;
}

function isSafeDistanceOk(put, { lowerBound, aggressiveStrike, spot }) {
  const strike = Number(put?.strike);
  const lb = Number(lowerBound);
  const agg = Number(aggressiveStrike);
  const px = Number(spot);

  if (Number.isFinite(lb) && Number.isFinite(strike) && strike >= lb) return false;
  if (put?.isBelowLowerBound === false) return false;
  if (Number.isFinite(agg) && Number.isFinite(strike) && strike >= agg) return false;

  if (Number.isFinite(px) && px > 0 && Number.isFinite(strike)) {
    const distPct = ((px - strike) / px) * 100;
    if (distPct < 2) return false;
  }
  return true;
}

/**
 * Score de tri — plus petit = meilleur candidat.
 */
export function rankSafeRescueCandidate(put, ctx) {
  const spreadPct = putSpreadPct(put);
  const yieldPct = premiumYieldPctFromPut(put);
  const strike = Number(put?.strike);
  const originalStrike = Number(ctx.originalStrike);
  const spreadAcceptable = isSpreadAcceptable(spreadPct);
  const originalSpread = normalizeSpreadPctPercent(ctx.originalSpreadPct);

  const spreadTier = spreadAcceptable ? 0 : spreadPct != null && spreadPct <= 35 ? 1 : 2;
  const spreadValue = spreadPct ?? 999;
  const yieldOk = yieldPct != null && yieldPct >= SAFE_MIN_YIELD_PCT ? 0 : 1;
  const yieldGap =
    yieldPct != null && Number.isFinite(Number(ctx.targetPremium)) && Number(ctx.targetPremium) > 0
      ? Math.abs(yieldPct - SAFE_MIN_YIELD_PCT)
      : yieldOk ? 10 : 0;
  const bidOk = isUsableBid(put) ? 0 : 1;
  const dist =
    Number.isFinite(Number(ctx.spot)) && Number.isFinite(strike) && Number(ctx.spot) > 0
      ? -((Number(ctx.spot) - strike) / Number(ctx.spot)) * 100
      : strike;
  const proximity = Number.isFinite(originalStrike)
    ? Math.abs(strike - originalStrike)
    : 999;

  return [
    spreadTier,
    spreadValue,
    yieldOk,
    yieldGap,
    bidOk,
    -dist,
    proximity,
    -strike,
  ];
}

export function evaluateSafeRescueCandidates({
  originalSafeStrike,
  originalSpreadPct,
  putCandidates = [],
  rescueStrikeWindow = [],
  lowerBound = null,
  aggressiveStrike = null,
  targetPremium = null,
  spot = null,
}) {
  const originalStrike = Number(originalSafeStrike?.strike ?? originalSafeStrike);
  const originalSpread = normalizeSpreadPctPercent(
    originalSpreadPct ?? originalSafeStrike?.spreadPct ?? originalSafeStrike?.liquidity?.spreadPct
  );

  const byStrike = new Map();
  for (const put of putCandidates || []) {
    const k = Number(put?.strike);
    if (Number.isFinite(k)) byStrike.set(k, put);
  }

  const windowStrikes =
    rescueStrikeWindow.length > 0
      ? rescueStrikeWindow
      : buildSafeRescueStrikeWindow(originalStrike, [...byStrike.keys()]);

  const ctx = {
    originalStrike,
    originalSpreadPct: originalSpread,
    targetPremium,
    spot,
    lowerBound,
    aggressiveStrike: Number(aggressiveStrike?.strike ?? aggressiveStrike),
  };

  const checked = [];
  const eligible = [];

  for (const strike of windowStrikes) {
    const put = byStrike.get(Number(strike));
    checked.push(strike);
    if (!put) continue;

    const spreadPct = putSpreadPct(put);
    if (spreadPct == null || originalSpread == null || !(spreadPct < originalSpread)) continue;
    if (!isUsableBid(put)) continue;
    if (!meetsMinPremium(put, targetPremium)) continue;
    const yieldPct = premiumYieldPctFromPut(put);
    if (yieldPct == null || yieldPct < SAFE_MIN_YIELD_PCT) continue;
    if (!isSafeDistanceOk(put, ctx)) continue;

    eligible.push({ put, spreadPct, yieldPct, rank: rankSafeRescueCandidate(put, ctx) });
  }

  eligible.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
    }
    return 0;
  });

  return { checked, eligible, winner: eligible[0] ?? null };
}

function formatBidAsk(put) {
  const bid = put?.bid ?? null;
  const ask = put?.ask ?? null;
  if (bid == null && ask == null) return null;
  return `${bid ?? "—"}/${ask ?? "—"}`;
}

/**
 * Tente un rescue SAFE local. Retourne le SAFE (original ou remplacé) + diagnostics.
 */
export function attemptSafeSpreadRescue({
  safeStrike,
  aggressiveStrike = null,
  putCandidates = [],
  lowerBound = null,
  targetPremium = null,
  spot = null,
  allStrikes = null,
  skipIfAlreadyRescued = true,
}) {
  const emptyDiagnostics = {
    safeSpreadRescueTriggered: false,
    safeOriginalStrike: null,
    safeOriginalBidAsk: null,
    safeOriginalSpread: null,
    safeRescueCandidatesChecked: [],
    safeRescueStrike: null,
    safeRescueBidAsk: null,
    safeRescueSpread: null,
    safeRescueReason: null,
  };

  if (!safeStrike || typeof safeStrike !== "object") {
    return { safeStrike, diagnostics: emptyDiagnostics };
  }

  if (skipIfAlreadyRescued && safeStrike?.safeSpreadRescueApplied === true) {
    return {
      safeStrike,
      diagnostics: safeStrike.safeSpreadRescueDiagnostics ?? {
        ...emptyDiagnostics,
        safeSpreadRescueTriggered: true,
        safeRescueReason: "already_applied",
      },
    };
  }

  const originalSpread = putSpreadPct(safeStrike);

  if (!isSafeRejectedForSpread(originalSpread)) {
    return {
      safeStrike,
      diagnostics: {
        ...emptyDiagnostics,
        safeOriginalStrike: safeStrike.strike ?? null,
        safeOriginalBidAsk: formatBidAsk(safeStrike),
        safeOriginalSpread: originalSpread,
        safeRescueReason: "safe_not_rejected_for_spread",
      },
    };
  }

  const ladder =
    allStrikes ??
    [...new Set((putCandidates || []).map((p) => Number(p?.strike)).filter(Number.isFinite))].sort(
      (a, b) => a - b
    );

  const rescueWindow = buildSafeRescueStrikeWindow(safeStrike.strike, ladder);
  const evaluation = evaluateSafeRescueCandidates({
    originalSafeStrike: safeStrike,
    originalSpreadPct: originalSpread,
    putCandidates,
    rescueStrikeWindow: rescueWindow,
    lowerBound,
    aggressiveStrike,
    targetPremium,
    spot,
  });

  const diagnostics = {
    safeSpreadRescueTriggered: true,
    safeOriginalStrike: safeStrike.strike ?? null,
    safeOriginalBidAsk: formatBidAsk(safeStrike),
    safeOriginalSpread: originalSpread,
    safeRescueCandidatesChecked: evaluation.checked,
    safeRescueStrike: null,
    safeRescueBidAsk: null,
    safeRescueSpread: null,
    safeRescueReason: evaluation.winner ? null : "no_acceptable_rescue_candidate",
  };

  if (!evaluation.winner) {
    return { safeStrike, diagnostics };
  }

  const winnerPut = evaluation.winner.put;
  const rescuedSpread = evaluation.winner.spreadPct;

  diagnostics.safeRescueStrike = winnerPut.strike ?? null;
  diagnostics.safeRescueBidAsk = formatBidAsk(winnerPut);
  diagnostics.safeRescueSpread = rescuedSpread;
  diagnostics.safeRescueReason = isSpreadAcceptable(rescuedSpread)
    ? "replaced_with_acceptable_spread"
    : "replaced_with_cleaner_spread";

  const rescuedSafe = {
    ...safeStrike,
    ...winnerPut,
    strike: winnerPut.strike,
    bid: winnerPut.bid ?? safeStrike.bid,
    ask: winnerPut.ask ?? safeStrike.ask,
    mid: winnerPut.mid ?? safeStrike.mid,
    spreadPct: winnerPut.spreadPct ?? safeStrike.spreadPct,
    primeUsed: winnerPut.primeUsed ?? winnerPut.bid ?? safeStrike.primeUsed,
    premiumUsed: winnerPut.primeUsed ?? winnerPut.premiumUsed ?? winnerPut.bid ?? safeStrike.premiumUsed,
    selectionReason: "safe_spread_rescue_local",
    safeSpreadRescueApplied: true,
    safeSpreadRescueDiagnostics: diagnostics,
  };

  return { safeStrike: rescuedSafe, diagnostics };
}

/**
 * Spread actif pour le rejet global « Rejetés pour spread » selon le mode sélectionné.
 */
export function getActiveSpreadPctForSelectedMode({
  safeSpreadPct = null,
  aggressiveSpreadPct = null,
  selectedMode = null,
  card = null,
}) {
  const safe = normalizeSpreadPctPercent(
    safeSpreadPct ??
      card?.safeStrike?.liquidity?.spreadPct ??
      card?.safeStrike?.spreadPct ??
      card?.safeSpreadPct
  );
  const agg = normalizeSpreadPctPercent(
    aggressiveSpreadPct ??
      card?.aggressiveStrike?.liquidity?.spreadPct ??
      card?.aggressiveStrike?.spreadPct
  );

  let mode = String(selectedMode || "").trim().toUpperCase();
  if (!mode && card) {
    mode = String(
      card.finalDisplayMode ?? card.selectedMode ?? card.recommendedMode ?? ""
    ).toUpperCase();
  }

  if (mode === "AGGRESSIVE") return agg;
  if (mode === "SAFE") return safe;

  if (mode === "BALANCED" && card) {
    const safeLeg = card.safeStrike ?? card._safeLeg ?? null;
    const aggLeg = card.aggressiveStrike ?? card._aggLeg ?? card.selectedLeg ?? null;
    const safeY = Number(safeLeg?.weeklyYield ?? card._safeYieldPct);
    const aggY = Number(aggLeg?.weeklyYield ?? card._aggYieldPct);
    const hasSafe = safeLeg != null;
    const hasAgg = aggLeg != null;
    const safeInRange = hasSafe && Number.isFinite(safeY) && safeY >= 0.75 && safeY < 1.05;
    const aggInRange = hasAgg && Number.isFinite(aggY) && aggY >= 0.75 && aggY < 1.05;
    const mid = 0.875;
    if (safeInRange && aggInRange) {
      return Math.abs(safeY - mid) <= Math.abs(aggY - mid) ? safe : agg;
    }
    if (safeInRange) return safe;
    if (aggInRange) return agg;
    if (hasAgg) return agg;
    if (hasSafe) return safe;
  }

  if (card?.finalDisplayMode === "AGGRESSIVE") return agg;
  if (card?.finalDisplayMode === "SAFE") return safe;

  const values = [safe, agg].filter((v) => Number.isFinite(v));
  return values.length ? Math.max(...values) : null;
}

export function shouldGlobalSpreadReject(card, { extremeThresholdPct = 80 } = {}) {
  const safe = normalizeSpreadPctPercent(
    card?.safeStrike?.liquidity?.spreadPct ??
      card?.safeStrike?.spreadPct ??
      card?.safeSpreadPct
  );
  const agg = normalizeSpreadPctPercent(
    card?.aggressiveStrike?.liquidity?.spreadPct ?? card?.aggressiveStrike?.spreadPct
  );
  const active = getActiveSpreadPctForSelectedMode({
    safeSpreadPct: safe,
    aggressiveSpreadPct: agg,
    card,
  });
  return active != null && active > extremeThresholdPct;
}
