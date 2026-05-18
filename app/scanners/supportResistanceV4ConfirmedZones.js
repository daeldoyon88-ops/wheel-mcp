/**
 * Support / résistance V4 — zones confirmées par clôtures.
 * Pure, aucun IO, diagnostic-only. N'alimente ni le scoring ni la sélection Wheel.
 */

const VERSION = "support-resistance-v4-confirmed-zones";

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function computeAtr(candles) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const h = typeof c.high === "number" && isFinite(c.high) ? c.high : null;
    const l = typeof c.low === "number" && isFinite(c.low) ? c.low : null;
    const pc = typeof prev.close === "number" && isFinite(prev.close) ? prev.close : null;
    if (h == null || l == null || pc == null) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!trs.length) return null;
  const period = Math.min(14, trs.length);
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / recent.length;
}

function computeTolerance(spot, atr, closes) {
  const minTol = spot * 0.0025;
  const maxTol = spot * 0.03;
  let tol;
  if (atr != null && atr > 0) {
    tol = Math.max(spot * 0.006, atr * 0.45);
  } else if (closes.length >= 3) {
    const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / closes.length;
    tol = Math.max(spot * 0.006, Math.sqrt(variance) * 0.3);
  } else {
    tol = spot * 0.008;
  }
  return Math.max(minTol, Math.min(maxTol, tol));
}

function daysBetweenDates(dateA, dateB) {
  try {
    const a = new Date(dateA);
    const b = new Date(dateB);
    if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
    return Math.round(Math.abs(a - b) / 86400000);
  } catch {
    return null;
  }
}

function detectRole(zoneLow, zoneHigh, zoneMid, sortedCandles, spot) {
  const baseRole = zoneMid < spot ? "support" : "resistance";

  // Find index of first close touch in the zone
  let firstTouchIdx = -1;
  for (let i = 0; i < sortedCandles.length; i++) {
    const cl = sortedCandles[i].close;
    if (typeof cl === "number" && cl >= zoneLow && cl <= zoneHigh) {
      firstTouchIdx = i;
      break;
    }
  }
  if (firstTouchIdx <= 0) return { role: baseRole, breakStrength: null };

  // Median of the 10 closes immediately before the first zone touch
  const preSlice = sortedCandles
    .slice(Math.max(0, firstTouchIdx - 10), firstTouchIdx)
    .map((c) => c.close)
    .filter((v) => typeof v === "number" && isFinite(v));
  if (!preSlice.length) return { role: baseRole, breakStrength: null };

  const preMed = median(preSlice);

  if (baseRole === "support" && preMed > zoneHigh * 1.04) {
    const bs = Math.min(1, (preMed - zoneHigh) / (zoneHigh * 0.05));
    return { role: "broken_resistance_support", breakStrength: Math.round(bs * 100) / 100 };
  }
  if (baseRole === "resistance" && preMed < zoneLow * 0.96) {
    const bs = Math.min(1, (zoneLow - preMed) / (zoneLow * 0.05));
    return { role: "broken_support_resistance", breakStrength: Math.round(bs * 100) / 100 };
  }
  return { role: baseRole, breakStrength: null };
}

function buildZone(cluster, sorted, spotVal, strikeVal, tolerance) {
  const clMin = Math.min(...cluster);
  const clMax = Math.max(...cluster);
  const padding = tolerance * 0.25;
  const zoneLow = clMin - padding;
  const zoneHigh = clMax + padding;
  const zoneMid = median(cluster);

  let lastTouchIdx = -1;
  let lastTouchCandle = null;
  let closeTouchCount = 0;
  sorted.forEach((c, i) => {
    if (typeof c.close === "number" && c.close >= zoneLow && c.close <= zoneHigh) {
      closeTouchCount++;
      if (i > lastTouchIdx) { lastTouchIdx = i; lastTouchCandle = c; }
    }
  });

  let wickTouchCount = 0;
  sorted.forEach((c) => {
    if (typeof c.close === "number" && c.close >= zoneLow && c.close <= zoneHigh) return;
    const h = typeof c.high === "number" && isFinite(c.high) ? c.high : null;
    const l = typeof c.low === "number" && isFinite(c.low) ? c.low : null;
    if (h != null && l != null && l < zoneLow && h > zoneHigh) { wickTouchCount++; return; }
    if (h != null && h >= zoneLow && h <= zoneHigh) { wickTouchCount++; return; }
    if (l != null && l >= zoneLow && l <= zoneHigh) { wickTouchCount++; }
  });

  const lastCandle = sorted[sorted.length - 1];
  let lastTouchDaysAgo = null;
  if (lastCandle?.date && lastTouchCandle?.date) {
    lastTouchDaysAgo = daysBetweenDates(lastCandle.date, lastTouchCandle.date);
  } else if (lastTouchIdx >= 0) {
    lastTouchDaysAgo = sorted.length - 1 - lastTouchIdx;
  }

  const distanceToSpotPct = ((zoneMid - spotVal) / spotVal) * 100;
  const distanceToStrikePct = strikeVal ? ((zoneMid - strikeVal) / strikeVal) * 100 : null;

  const { role, breakStrength } = detectRole(zoneLow, zoneHigh, zoneMid, sorted, spotVal);

  // Scoring
  const closeTouchScore = Math.min(45, closeTouchCount * 9);

  let recencyScore = 0;
  if (lastTouchDaysAgo != null) {
    if (lastTouchDaysAgo <= 10) recencyScore = 20;
    else if (lastTouchDaysAgo <= 20) recencyScore = 15;
    else if (lastTouchDaysAgo <= 30) recencyScore = 10;
    else if (lastTouchDaysAgo <= 45) recencyScore = 5;
  }

  const wickScore = Math.min(10, wickTouchCount * 2);

  let proximityScore = 0;
  const absDist = Math.abs(distanceToSpotPct);
  if (absDist < 3) proximityScore = 15;
  else if (absDist < 6) proximityScore = 12;
  else if (absDist < 10) proximityScore = 8;
  else if (absDist < 15) proximityScore = 4;

  const roleScore = breakStrength != null ? 10 : 0;
  const zoneWidthPct = (zoneHigh - zoneLow) / spotVal * 100;
  const zonePenalty = zoneWidthPct > 4 ? 10 : 0;

  const score = Math.max(0, Math.min(100,
    closeTouchScore + recencyScore + wickScore + proximityScore + roleScore - zonePenalty
  ));

  let confidence;
  if (score >= 75 && closeTouchCount >= 4) confidence = "high";
  else if (score >= 55 && closeTouchCount >= 3) confidence = "medium";
  else confidence = "low";

  const notes = [];
  if (breakStrength != null) notes.push(`cassure détectée (force=${breakStrength})`);
  if (zoneWidthPct > 4) notes.push("zone large, fiabilité réduite");
  if (lastTouchDaysAgo != null && lastTouchDaysAgo > 45) notes.push("touche ancienne");

  return {
    zoneLow: Math.round(zoneLow * 1000) / 1000,
    zoneHigh: Math.round(zoneHigh * 1000) / 1000,
    zoneMid: Math.round(zoneMid * 1000) / 1000,
    closeTouchCount,
    wickTouchCount,
    lastTouchDaysAgo,
    distanceToSpotPct: Math.round(distanceToSpotPct * 100) / 100,
    distanceToStrikePct: distanceToStrikePct != null ? Math.round(distanceToStrikePct * 100) / 100 : null,
    score,
    confidence,
    role,
    breakStrength,
    notes,
  };
}

function roundPct(value) {
  return typeof value === "number" && isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

function confidenceRank(value) {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function sortInsideZonesByPriority(a, b, strikeVal) {
  const scoreDiff = (b?.score ?? 0) - (a?.score ?? 0);
  if (scoreDiff !== 0) return scoreDiff;
  const aMid = typeof a?.zoneMid === "number" ? Math.abs(a.zoneMid - strikeVal) : Infinity;
  const bMid = typeof b?.zoneMid === "number" ? Math.abs(b.zoneMid - strikeVal) : Infinity;
  return aMid - bMid;
}

function buildUnavailableStrikeProtectionV4({ strikeVal, spotVal, notes = [] } = {}) {
  return {
    status: "unavailable",
    diagnosticOnly: true,
    strike: strikeVal,
    spot: spotVal,
    selectedSupportZone: null,
    nearestSupportBelowStrike: null,
    nearestSupportAboveStrike: null,
    supportDistanceBelowStrikePct: null,
    supportDistanceAboveStrikePct: null,
    strikeInsideConfirmedSupportZone: false,
    strikeAboveConfirmedSupportZone: false,
    strikeBelowConfirmedSupportZone: false,
    confidence: "low",
    score: 0,
    summaryFr: "Protection V4 indisponible.",
    notes: Array.isArray(notes) ? notes.filter(Boolean) : [],
  };
}

function clampScore(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function computeStrikeProtectionScore({
  status,
  selectedSupportZone,
  supportDistanceBelowStrikePct,
  supportDistanceAboveStrikePct,
}) {
  if (status === "unavailable") return 0;

  const zone = selectedSupportZone && typeof selectedSupportZone === "object" ? selectedSupportZone : null;
  const zoneScore = Number.isFinite(Number(zone?.score)) ? Number(zone.score) : 0;
  const closeTouchCount = Number.isFinite(Number(zone?.closeTouchCount)) ? Number(zone.closeTouchCount) : 0;
  const confidenceBoost = zone ? ({ low: 0, medium: 6, high: 12 }[zone.confidence] ?? 0) : 0;
  const touchBoost = Math.max(0, Math.min(8, (closeTouchCount - 3) * 2));
  const zoneBoost = Math.round(zoneScore * 0.06);

  if (status === "protected") {
    return clampScore(82 + confidenceBoost + touchBoost + zoneBoost, 80, 100);
  }

  if (status === "partially_protected") {
    const threshold = supportDistanceAboveStrikePct != null ? 2.5 : 3.5;
    const distance = supportDistanceAboveStrikePct != null
      ? supportDistanceAboveStrikePct
      : supportDistanceBelowStrikePct;
    const proximityBoost = distance != null
      ? Math.max(0, Math.round(((threshold - distance) / threshold) * 12))
      : 0;
    return clampScore(60 + confidenceBoost + touchBoost + zoneBoost + proximityBoost, 60, 79);
  }

  if (status === "weakly_protected") {
    const distance = supportDistanceBelowStrikePct;
    const proximityBoost = distance != null
      ? Math.max(0, Math.round(((8 - distance) / 8) * 10))
      : 0;
    return clampScore(35 + Math.min(confidenceBoost, 8) + Math.min(touchBoost, 6) + zoneBoost + proximityBoost, 35, 59);
  }

  const fallbackDistance = supportDistanceBelowStrikePct ?? supportDistanceAboveStrikePct;
  const distancePenalty = fallbackDistance != null ? Math.min(18, Math.round(fallbackDistance)) : 20;
  return clampScore(30 + Math.round(zoneScore * 0.03) - distancePenalty, 0, 34);
}

function buildStrikeProtectionV4({ supports, strikeVal, spotVal } = {}) {
  if (!spotVal) {
    return buildUnavailableStrikeProtectionV4({
      strikeVal,
      spotVal,
      notes: ["spot invalide"],
    });
  }
  if (!strikeVal) {
    return buildUnavailableStrikeProtectionV4({
      strikeVal,
      spotVal,
      notes: ["strike invalide"],
    });
  }
  if (!Array.isArray(supports) || supports.length === 0) {
    return buildUnavailableStrikeProtectionV4({
      strikeVal,
      spotVal,
      notes: ["aucun support confirme V4 disponible"],
    });
  }

  const insideZones = supports
    .filter((zone) => typeof zone?.zoneLow === "number" && typeof zone?.zoneHigh === "number" && zone.zoneLow <= strikeVal && zone.zoneHigh >= strikeVal)
    .sort((a, b) => sortInsideZonesByPriority(a, b, strikeVal));
  const belowZones = supports
    .filter((zone) => typeof zone?.zoneHigh === "number" && zone.zoneHigh <= strikeVal)
    .sort((a, b) => {
      const distanceDiff = (strikeVal - a.zoneHigh) - (strikeVal - b.zoneHigh);
      if (distanceDiff !== 0) return distanceDiff;
      return (b?.score ?? 0) - (a?.score ?? 0);
    });
  const aboveZones = supports
    .filter((zone) => typeof zone?.zoneLow === "number" && zone.zoneLow > strikeVal)
    .sort((a, b) => {
      const distanceDiff = (a.zoneLow - strikeVal) - (b.zoneLow - strikeVal);
      if (distanceDiff !== 0) return distanceDiff;
      return (b?.score ?? 0) - (a?.score ?? 0);
    });

  const insideZone = insideZones[0] ?? null;
  const nearestBelowStrike = belowZones[0] ?? null;
  const nearestAboveStrike = aboveZones[0] ?? null;
  const supportDistanceBelowStrikePct = nearestBelowStrike
    ? roundPct(((strikeVal - nearestBelowStrike.zoneHigh) / strikeVal) * 100)
    : null;
  const supportDistanceAboveStrikePct = nearestAboveStrike
    ? roundPct(((nearestAboveStrike.zoneLow - strikeVal) / strikeVal) * 100)
    : null;

  let status = "unprotected";
  let selectedSupportZone = null;
  let summaryFr = "Aucun support V4 confirme proche du strike.";
  const notes = [];

  if (insideZone && insideZone.closeTouchCount >= 3 && confidenceRank(insideZone.confidence) >= 2) {
    status = "protected";
    selectedSupportZone = insideZone;
    summaryFr = "Strike dans une zone support V4 confirmee.";
  } else if (
    nearestBelowStrike &&
    supportDistanceBelowStrikePct != null &&
    supportDistanceBelowStrikePct <= 3.5 &&
    confidenceRank(nearestBelowStrike.confidence) >= 2
  ) {
    status = "partially_protected";
    selectedSupportZone = nearestBelowStrike;
    summaryFr = "Strike au-dessus d'un support V4 confirme proche.";
  } else if (
    nearestAboveStrike &&
    supportDistanceAboveStrikePct != null &&
    supportDistanceAboveStrikePct <= 2.5 &&
    confidenceRank(nearestAboveStrike.confidence) >= 2
  ) {
    status = "partially_protected";
    selectedSupportZone = nearestAboveStrike;
    summaryFr = "Support V4 confirme legerement au-dessus du strike.";
  } else if (
    nearestBelowStrike &&
    supportDistanceBelowStrikePct != null &&
    supportDistanceBelowStrikePct <= 8
  ) {
    status = "weakly_protected";
    selectedSupportZone = nearestBelowStrike;
    summaryFr = "Support V4 confirme present, mais eloigne du strike.";
  } else if (nearestBelowStrike) {
    selectedSupportZone = nearestBelowStrike;
    summaryFr = "Support V4 confirme present, mais trop eloigne du strike.";
  } else if (nearestAboveStrike) {
    selectedSupportZone = nearestAboveStrike;
    summaryFr = "Aucun support V4 confirme proche du strike.";
  }

  if (supportDistanceBelowStrikePct != null) {
    notes.push(`support sous strike a ${supportDistanceBelowStrikePct}%`);
  }
  if (supportDistanceAboveStrikePct != null) {
    notes.push(`support au-dessus du strike a ${supportDistanceAboveStrikePct}%`);
  }
  if (selectedSupportZone?.confidence) {
    notes.push(`confiance ${selectedSupportZone.confidence}`);
  }
  if (Number.isFinite(Number(selectedSupportZone?.closeTouchCount))) {
    notes.push(`${Number(selectedSupportZone.closeTouchCount)} clotures confirmees`);
  }

  const strikeInsideConfirmedSupportZone = Boolean(insideZone);
  const strikeAboveConfirmedSupportZone = !strikeInsideConfirmedSupportZone && Boolean(selectedSupportZone && selectedSupportZone.zoneHigh <= strikeVal);
  const strikeBelowConfirmedSupportZone = !strikeInsideConfirmedSupportZone && Boolean(selectedSupportZone && selectedSupportZone.zoneLow > strikeVal);
  const confidence = selectedSupportZone?.confidence || "low";
  const score = computeStrikeProtectionScore({
    status,
    selectedSupportZone,
    supportDistanceBelowStrikePct,
    supportDistanceAboveStrikePct,
  });

  return {
    status,
    diagnosticOnly: true,
    strike: strikeVal,
    spot: spotVal,
    selectedSupportZone,
    nearestSupportBelowStrike: nearestBelowStrike,
    nearestSupportAboveStrike: nearestAboveStrike,
    supportDistanceBelowStrikePct,
    supportDistanceAboveStrikePct,
    strikeInsideConfirmedSupportZone,
    strikeAboveConfirmedSupportZone,
    strikeBelowConfirmedSupportZone,
    confidence,
    score,
    summaryFr,
    notes,
  };
}

export function buildSupportResistanceV4ConfirmedZones({ ohlcCandles, spot, strike, dteDays } = {}) {
  const spotVal = typeof spot === "number" && isFinite(spot) && spot > 0 ? spot : null;
  const strikeVal = typeof strike === "number" && isFinite(strike) && strike > 0 ? strike : null;

  const empty = {
    version: VERSION,
    available: false,
    diagnosticOnly: true,
    spot: spotVal,
    strike: strikeVal,
    tolerance: null,
    atr: null,
    zonesCount: 0,
    supports: [],
    resistances: [],
    bestSupportZone: null,
    bestResistanceZone: null,
    strikeProtectionV4: buildUnavailableStrikeProtectionV4({
      strikeVal,
      spotVal,
      notes: ["donnees OHLC insuffisantes"],
    }),
    summaryFr: "V4 diagnostic: données OHLC insuffisantes pour confirmer des zones par 3 clôtures.",
  };

  if (!Array.isArray(ohlcCandles) || ohlcCandles.length === 0) return empty;
  if (!spotVal) return empty;

  const valid = ohlcCandles.filter(
    (c) => c && typeof c.close === "number" && isFinite(c.close) && c.close > 0
  );
  if (valid.length < 3) return empty;

  // Sort chronologically; candles with no valid date go last
  const sorted = [...valid].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : Infinity;
    const db = b.date ? new Date(b.date).getTime() : Infinity;
    return da - db;
  });

  const closes = sorted.map((c) => c.close);
  const atr = computeAtr(sorted);
  const tolerance = computeTolerance(spotVal, atr, closes);

  // Greedy clustering on sorted closes: new cluster when gap > 2 * tolerance
  const sortedCloses = [...closes].sort((a, b) => a - b);
  const clusters = [];
  for (const cl of sortedCloses) {
    if (!clusters.length) { clusters.push([cl]); continue; }
    const last = clusters[clusters.length - 1];
    if (cl - last[0] <= 2 * tolerance) {
      last.push(cl);
    } else {
      clusters.push([cl]);
    }
  }

  const confirmed = clusters.filter((c) => c.length >= 3);

  const atrRounded = atr != null ? Math.round(atr * 1000) / 1000 : null;
  const toleranceRounded = Math.round(tolerance * 1000) / 1000;

  if (!confirmed.length) {
    return {
      ...empty,
      available: false,
      tolerance: toleranceRounded,
      atr: atrRounded,
      strikeProtectionV4: buildUnavailableStrikeProtectionV4({
        strikeVal,
        spotVal,
        notes: ["aucune zone confirmee disponible"],
      }),
      summaryFr: "V4 diagnostic: aucun support/résistance confirmé par 3 clôtures.",
    };
  }

  const zones = confirmed.map((cl) => buildZone(cl, sorted, spotVal, strikeVal, tolerance));

  const sortFn = (a, b) => {
    const d = b.score - a.score;
    if (d !== 0) return d;
    return (Math.abs(a.distanceToSpotPct) ?? Infinity) - (Math.abs(b.distanceToSpotPct) ?? Infinity);
  };

  const supports = zones
    .filter((z) => z.role === "support" || z.role === "broken_resistance_support")
    .sort(sortFn);
  const resistances = zones
    .filter((z) => z.role === "resistance" || z.role === "broken_support_resistance")
    .sort(sortFn);
  const strikeProtectionV4 = buildStrikeProtectionV4({ supports, strikeVal, spotVal });

  const supCount = supports.length;
  const resCount = resistances.length;
  let summaryFr;
  if (supCount === 0 && resCount === 0) {
    summaryFr = "V4 diagnostic: aucun support/résistance confirmé par 3 clôtures.";
  } else {
    const parts = [];
    if (supCount > 0) parts.push(`${supCount} support${supCount > 1 ? "s" : ""} confirmé${supCount > 1 ? "s" : ""}`);
    if (resCount > 0) parts.push(`${resCount} résistance${resCount > 1 ? "s" : ""} confirmée${resCount > 1 ? "s" : ""}`);
    summaryFr = `V4 diagnostic: ${parts.join(" et ")} par clôtures.`;
  }

  return {
    version: VERSION,
    available: true,
    diagnosticOnly: true,
    spot: spotVal,
    strike: strikeVal,
    tolerance: toleranceRounded,
    atr: atrRounded,
    zonesCount: zones.length,
    supports,
    resistances,
    bestSupportZone: supports[0] ?? null,
    bestResistanceZone: resistances[0] ?? null,
    strikeProtectionV4,
    summaryFr,
  };
}
