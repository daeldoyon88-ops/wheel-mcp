/**
 * Score V2 Wheel — fonction pure, sans effet secondaire.
 * N'influence pas le tri ni le ranking existant.
 */

export function safeNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampScore(value, max = 100) {
  const n = safeNumber(value, 0);
  return Math.max(0, Math.min(max, Math.round(n)));
}

/** Normalise un rendement en % (ex. 0.5 = 0,5 %). */
export function normalizeYieldPct(value) {
  const n = safeNumber(value);
  if (n == null) return null;
  if (n > 0 && n <= 0.05) return n * 100;
  return n;
}

/** Normalise un POP en % (ex. 85 = 85 %). */
export function normalizePopPct(value) {
  const n = safeNumber(value);
  if (n == null) return null;
  if (n >= 0 && n <= 1) return n * 100;
  return n;
}

/** Normalise un spread en %. */
export function normalizeSpreadPct(value) {
  return safeNumber(value);
}

const BLOCK_META = {
  yield: { max: 18, label: "Rendement défendable" },
  spread: { max: 18, label: "Liquidité / spread" },
  pop: { max: 18, label: "POP" },
  support: { max: 16, label: "Support / résistance" },
  momentum: { max: 16, label: "Momentum technique phase 1" },
  earnings: { max: 8, label: "Earnings corrigé" },
  seasonality: { max: 4, label: "Saisonnalité" },
  conformity: { max: 2, label: "Conformité SAFE/AGRESSIF" },
};

function blockResult(key, pts) {
  const meta = BLOCK_META[key];
  return {
    key,
    label: meta.label,
    pts: clampScore(pts, meta.max),
    max: meta.max,
  };
}

function getRecommendedLeg(item) {
  const mode = String(item?.finalDisplayMode ?? item?.recommendedMode ?? "SAFE").toUpperCase();
  if (mode === "AGGRESSIVE") {
    return item?.aggressiveStrike ?? item?.safeStrike ?? null;
  }
  return item?.safeStrike ?? item?.aggressiveStrike ?? null;
}

function resolveYieldPct(item) {
  const leg = getRecommendedLeg(item);
  return (
    normalizeYieldPct(leg?.weeklyNormalizedYield) ??
    normalizeYieldPct(item?.weeklyReturn) ??
    normalizeYieldPct(leg?.weeklyYield) ??
    null
  );
}

function scoreYieldBlock(item, alerts) {
  const yieldPct = resolveYieldPct(item);
  if (yieldPct == null) return blockResult("yield", 9);

  let pts;
  if (yieldPct < 0.5) {
    pts = (yieldPct / 0.5) * 12;
  } else if (yieldPct <= 1.3) {
    pts = 18;
  } else if (yieldPct <= 2.0) {
    pts = 18 - ((yieldPct - 1.3) / 0.7) * 8;
  } else {
    pts = Math.max(4, 10 - (yieldPct - 2) * 3);
    alerts.push("Prime élevée (>2 %) — risque premium trap");
  }
  return blockResult("yield", pts);
}

function scoreSpreadBlock(item, alerts) {
  const leg = getRecommendedLeg(item);
  const spread = normalizeSpreadPct(leg?.liquidity?.spreadPct ?? leg?.spreadPct);
  if (spread == null) return blockResult("spread", 9);

  let pts;
  if (spread <= 7) pts = 18;
  else if (spread <= 15) pts = 14;
  else if (spread <= 25) pts = 8;
  else if (spread <= 40) pts = 3;
  else pts = 0;

  if (spread > 40) {
    alerts.push(`Spread très large (${spread.toFixed(1)} %) — exécution risquée`);
  } else if (spread > 25) {
    alerts.push(`Spread large (${spread.toFixed(1)} %) — liquidité limitée`);
  }
  return blockResult("spread", pts);
}

function scorePopBlock(item) {
  const leg = getRecommendedLeg(item);
  const pop = normalizePopPct(leg?.popProfitEstimated ?? leg?.popEstimate);
  if (pop == null) return blockResult("pop", 9);

  let pts;
  if (pop >= 90) pts = 18;
  else if (pop >= 85) pts = 15;
  else if (pop >= 80) pts = 12;
  else if (pop >= 70) pts = 8;
  else pts = 3;
  return blockResult("pop", pts);
}

function scoreSupportBlock(item) {
  const v4Data = item?.supportResistanceV4 ?? null;
  const strikeProtection =
    v4Data?.strikeProtectionV4 && typeof v4Data.strikeProtectionV4 === "object"
      ? v4Data.strikeProtectionV4
      : item?.strikeProtectionV4 && typeof item.strikeProtectionV4 === "object"
      ? item.strikeProtectionV4
      : null;
  const status = String(strikeProtection?.status ?? "").toLowerCase();

  if (status === "protected") return blockResult("support", 16);
  if (status === "partially_protected") return blockResult("support", 12);
  if (status === "weakly_protected") return blockResult("support", 8);
  if (status === "unprotected") return blockResult("support", 3);

  const supportStatus = String(item?.supportStatusV2 ?? item?.supportStatus ?? "").toLowerCase();
  if (supportStatus === "strike_below_support" || supportStatus === "below_support") {
    return blockResult("support", 14);
  }
  if (supportStatus === "strike_near_support" || supportStatus === "near_support") {
    return blockResult("support", 11);
  }
  if (supportStatus === "strike_above_support" || supportStatus === "room_above_support") {
    return blockResult("support", 5);
  }
  if (supportStatus === "current_below_support") {
    return blockResult("support", 2);
  }
  return blockResult("support", 8);
}

function scoreMomentumBlock(item, alerts) {
  let pts = 8;
  const rsiRaw = item?.rsi;
  const rsi = rsiRaw === "—" || rsiRaw == null ? null : safeNumber(rsiRaw);
  const trend = String(item?.trend ?? item?.technicals?.trend ?? "").toLowerCase();
  const momentum = String(item?.momentum ?? item?.technicals?.momentum ?? "").toLowerCase();

  if (rsi != null) {
    if (rsi > 75) {
      pts -= 3;
      alerts.push("RSI élevé (>75) — prudence");
    } else if (rsi > 50) {
      pts += 4;
    } else if (rsi < 35) {
      pts -= 2;
    }
  }
  if (trend === "bullish") pts += 3;
  else if (trend === "bearish") pts -= 4;
  if (momentum === "positive") pts += 2;
  else if (momentum === "negative") pts -= 3;

  return blockResult("momentum", pts);
}

function hasEarningsBeforeExpiration(item) {
  return (
    item?.hasUpcomingEarningsBeforeExpiration === true ||
    item?.hasEarningsBeforeExpiration === true
  );
}

function scoreEarningsBlock(item, alerts) {
  if (item?.earningsMode === true) {
    alerts.push("Earnings mode actif — expected move doublé");
    return blockResult("earnings", 0);
  }

  const hasDate = !!(item?.earningsDate || item?.nextEarningsDate);
  const daysUntil = safeNumber(item?.earningsDaysUntil);
  const beforeExp = hasEarningsBeforeExpiration(item);

  if (!beforeExp) {
    if (!hasDate) return blockResult("earnings", 5);
    return blockResult("earnings", 8);
  }

  if (daysUntil != null && daysUntil >= 0) {
    if (daysUntil >= 1 && daysUntil <= 3) {
      alerts.push(`Earnings dans ${daysUntil} j — forte pénalité`);
      return blockResult("earnings", 1);
    }
    if (daysUntil >= 4 && daysUntil <= 7) {
      alerts.push(`Earnings dans ${daysUntil} j — pénalité`);
      return blockResult("earnings", 4);
    }
    if (daysUntil > 7) {
      return blockResult("earnings", 6);
    }
  }

  if (!hasDate) return blockResult("earnings", 5);
  return blockResult("earnings", 4);
}

function scoreSeasonalityBlock(seasonalityEntry) {
  if (!seasonalityEntry || typeof seasonalityEntry !== "object") {
    return blockResult("seasonality", 2);
  }
  const bias = String(seasonalityEntry.seasonalBias ?? "").toLowerCase();
  if (bias === "favorable") return blockResult("seasonality", 4);
  if (bias === "unfavorable") return blockResult("seasonality", 0);
  return blockResult("seasonality", 2);
}

function scoreConformityBlock(item, alerts) {
  const leg = getRecommendedLeg(item);
  const strike = safeNumber(leg?.strike);
  const lowerBound = safeNumber(item?.lowerBound ?? item?.expectedMoveLow);
  const safeStrike = safeNumber(item?.safeStrike?.strike);
  const aggStrike = safeNumber(item?.aggressiveStrike?.strike);
  const safeEqualsAgg =
    safeStrike != null && aggStrike != null && safeStrike === aggStrike;

  if (strike == null || lowerBound == null) {
    return blockResult("conformity", 1);
  }
  if (strike <= lowerBound) {
    return blockResult("conformity", 2);
  }
  if (safeEqualsAgg) {
    return blockResult("conformity", 1);
  }
  alerts.push("Strike au-dessus de la borne basse — incohérent");
  return blockResult("conformity", 0);
}

/**
 * @param {object} item — candidat Wheel (lecture seule)
 * @param {{ seasonalityEntry?: object|null }} [options]
 * @returns {{ total: number, breakdown: object[], alerts: string[] }}
 */
export function computeScoreV2(item, { seasonalityEntry } = {}) {
  const alerts = [];

  const blocks = [
    scoreYieldBlock(item, alerts),
    scoreSpreadBlock(item, alerts),
    scorePopBlock(item),
    scoreSupportBlock(item),
    scoreMomentumBlock(item, alerts),
    scoreEarningsBlock(item, alerts),
    scoreSeasonalityBlock(seasonalityEntry),
    scoreConformityBlock(item, alerts),
  ];

  const total = clampScore(
    blocks.reduce((sum, b) => sum + b.pts, 0),
    100
  );

  return {
    total,
    breakdown: blocks,
    alerts,
  };
}
