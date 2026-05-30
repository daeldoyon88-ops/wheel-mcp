/**
 * Scores décisionnels saisonnalité — Score hebdo 7j, Fenêtre annuelle, CSP, CC, Verdict Wheel.
 * Fonctions pures, traçables. Chaque score retourne reasons[] et warnings[].
 * Aucun score retourné sans raisons détaillées.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function pctFmt(v, signed = true) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  const abs = (Math.abs(v) * 100).toFixed(1);
  if (signed) return v >= 0 ? `+${abs}%` : `-${abs}%`;
  return `${abs}%`;
}

// sampleSize pour fenêtre 7j glissante ≈ (rows - 7) ⟹ years ≈ rows/252
function yearsFromSampleSize7j(sampleSize) {
  if (typeof sampleSize !== "number" || sampleSize <= 0) return 0;
  return Math.round((sampleSize + 7) / 252);
}

function getWeeklyConfidence(sampleSize) {
  const y = yearsFromSampleSize7j(sampleSize);
  if (y < 5)  return "insuffisant";
  if (y < 10) return "préliminaire";
  if (y < 15) return "mesurable";
  return "robuste";
}

function getAnnualConfidence(annualHorizons) {
  if (!annualHorizons) return "insuffisant";
  const h15 = annualHorizons["15y"];
  const h10 = annualHorizons["10y"];
  const h5  = annualHorizons["5y"];
  const h3  = annualHorizons["3y"];
  if (h15 && !h15.insufficient && (h15.yearsCount ?? 0) >= 15) return "robuste";
  if (h10 && !h10.insufficient && (h10.yearsCount ?? 0) >= 10) return "mesurable";
  if (h5  && !h5.insufficient  && (h5.yearsCount  ?? 0) >= 5)  return "préliminaire";
  if (h3  && !h3.insufficient  && (h3.yearsCount  ?? 0) >= 3)  return "faible";
  return "insuffisant";
}

function pickBestAnnualHorizon(annualHorizons) {
  if (!annualHorizons) return null;
  for (const key of ["15y", "10y", "5y", "3y"]) {
    const s = annualHorizons[key];
    if (s && !s.insufficient) return { key, stats: s };
  }
  return null;
}

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const WEEK_TO_DAY   = { 1: 1, 2: 8, 3: 15, 4: 22, 5: 29 };

function doy(month, day) {
  let v = day;
  const m = Math.min(12, Math.max(1, month));
  for (let i = 1; i < m; i++) v += DAYS_IN_MONTH[i];
  return v;
}

function isWindowActiveToday(w, today) {
  if (!w) return false;
  const d = today ?? new Date();
  const month = d.getUTCMonth() + 1;
  const day   = d.getUTCDate();

  const sm = w.startMonth;
  const em = w.endMonth;
  if (typeof sm !== "number" || typeof em !== "number") return false;

  const sd = w.startDay ?? (w.startWeekOfMonth != null ? WEEK_TO_DAY[w.startWeekOfMonth] ?? 1  : 1);
  const ed = w.endDay   ?? (w.endWeekOfMonth   != null ? WEEK_TO_DAY[w.endWeekOfMonth]   ?? 28 : 28);

  const todayDOY = doy(month, day);
  const startDOY = doy(sm, sd);
  const endDOY   = doy(em, ed);

  if (startDOY <= endDOY) return todayDOY >= startDOY && todayDOY <= endDOY;
  // Fenêtre qui enjambe le nouvel an (ex. Nov → Jan)
  return todayDOY >= startDOY || todayDOY <= endDOY;
}

function worstConfidence(a, b) {
  const ORDER = ["robuste", "mesurable", "préliminaire", "faible", "insuffisant"];
  return ORDER[Math.max(ORDER.indexOf(a), ORDER.indexOf(b))] ?? "insuffisant";
}

// ─── Score hebdo 7j (calendrier) ─────────────────────────────────────────────

function _calendarConfidence(n) {
  if (n < 5)  return "insuffisant";
  if (n < 10) return "préliminaire";
  if (n < 15) return "mesurable";
  return "robuste";
}

/**
 * Score de saisonnalité hebdomadaire.
 *
 * Source primaire : calendarWeek (1 observation / an — vraie saisonnalité calendrier).
 * Fallback diagnostic : shortTermWindow7j (fenêtres roulantes — conservé pour compatibilité).
 *
 * @param {{
 *   calendarWeek?: object | null,       // PRIMARY — de computeCalendarWeekFromRows
 *   shortTermWindow7j?: object | null,  // FALLBACK diagnostic
 * }} input
 * @returns {{ score, label, confidence, reasons, warnings, sampleSize, yearsOfData, source }}
 */
export function computeWeeklySeasonalityScore(input) {
  const cw       = input?.calendarWeek      ?? null;  // calendrier (primaire)
  const w        = input?.shortTermWindow7j ?? null;  // roulant (fallback)
  const warnings = [];
  const reasons  = [];

  // ── Source calendrier disponible ────────────────────────────────────────────
  if (cw) {
    const n          = cw.sampleSize ?? 0;
    const confidence = _calendarConfidence(n);

    if (confidence === "insuffisant") {
      return {
        score: null, label: "Données insuffisantes", confidence: "insuffisant",
        reasons: [],
        warnings: [`Historique calendrier insuffisant — ${n} an(s) (minimum 5 requis).`],
        sampleSize: n, yearsOfData: n, source: "calendrier",
      };
    }

    const winRate      = typeof cw.winRate       === "number" ? cw.winRate       : null;
    const avgReturn    = typeof cw.averageReturn  === "number" ? cw.averageReturn : null;
    const medianReturn = typeof cw.medianReturn   === "number" ? cw.medianReturn  : null;
    const downsideRisk5 = typeof cw.downsideRisk5 === "number" ? cw.downsideRisk5 : null;
    const worstReturn  = typeof cw.worstReturn    === "number" ? cw.worstReturn   : null;

    const useReturn = medianReturn ?? avgReturn;
    if (medianReturn == null && avgReturn != null) {
      warnings.push("Rendement médian non disponible — moyenne utilisée.");
    }

    // 1. Win rate annuel (30 pts)
    let winPts = 0, winExpl = "";
    if (winRate == null) {
      warnings.push("Win rate calendrier non disponible.");
      winExpl = "Données manquantes";
    } else {
      if      (winRate >= 0.75) { winPts = 30; winExpl = "Très favorable (≥75%)"; }
      else if (winRate >= 0.65) { winPts = 24; winExpl = "Favorable (≥65%)"; }
      else if (winRate >= 0.55) { winPts = 18; winExpl = "Modéré (≥55%)"; }
      else if (winRate >= 0.50) { winPts = 12; winExpl = "Légèrement positif (≥50%)"; }
      else if (winRate >= 0.45) { winPts =  6; winExpl = "Légèrement négatif (<50%)"; }
      else                       { winPts =  0; winExpl = "Défavorable (<45%)"; }
    }
    reasons.push({
      label: `${cw.positiveYears ?? "?"} années positives / ${n}`,
      value: winRate != null ? `${Math.round(winRate * 100)}%` : "—",
      contribution: winPts, maxContribution: 30, explanation: winExpl,
    });

    // 2. Rendement médian/moyen (25 pts)
    let retPts = 0, retExpl = "";
    if (useReturn == null) {
      warnings.push("Rendement calendrier non disponible.");
      retExpl = "Données manquantes";
    } else {
      if      (useReturn >= 0.030) { retPts = 25; retExpl = "Excellent (≥+3%)"; }
      else if (useReturn >= 0.015) { retPts = 20; retExpl = "Bon (+1.5% à +3%)"; }
      else if (useReturn >= 0.005) { retPts = 14; retExpl = "Positif (+0.5% à +1.5%)"; }
      else if (useReturn >= 0.000) { retPts =  8; retExpl = "Légèrement positif (0 à +0.5%)"; }
      else if (useReturn >= -0.005){ retPts =  4; retExpl = "Légèrement négatif (−0.5% à 0)"; }
      else                          { retPts =  0; retExpl = "Négatif (<−0.5%)"; }
    }
    reasons.push({
      label: medianReturn != null ? "Rendement médian calendrier" : "Rendement moyen calendrier",
      value: useReturn != null ? pctFmt(useReturn) : "—",
      contribution: retPts, maxContribution: 25, explanation: retExpl,
    });

    // 3. Risque baisse >5% inversé (25 pts)
    let riskPts = 0, riskExpl = "";
    if (downsideRisk5 == null) {
      warnings.push("Risque baisse >5% non disponible — valeur neutre appliquée.");
      riskPts = 12; riskExpl = "Données manquantes — valeur neutre";
    } else {
      if      (downsideRisk5 < 0.10) { riskPts = 25; riskExpl = "Risque faible (<10% des années)"; }
      else if (downsideRisk5 < 0.20) { riskPts = 20; riskExpl = "Risque modéré (10–20%)"; }
      else if (downsideRisk5 < 0.30) { riskPts = 12; riskExpl = "Risque élevé (20–30%)"; }
      else if (downsideRisk5 < 0.40) { riskPts =  5; riskExpl = "Risque très élevé (30–40%)"; }
      else                            { riskPts =  0; riskExpl = "Risque critique (≥40%)"; }
      if (downsideRisk5 > 0.25) warnings.push(`Risque baisse >5% : ${Math.round(downsideRisk5 * 100)}% des années.`);
    }
    reasons.push({
      label: "Risque baisse >5% (années, inversé)",
      value: downsideRisk5 != null ? `${Math.round(downsideRisk5 * 100)}%` : "—",
      contribution: riskPts, maxContribution: 25, explanation: riskExpl,
    });

    // 4. Stabilité / pire année (20 pts)
    let stabPts = 0, stabExpl = "";
    if (worstReturn == null) {
      stabPts = 10; stabExpl = "Données manquantes — valeur neutre";
      warnings.push("Pire retour calendrier non disponible — stabilité supposée neutre.");
    } else {
      if      (worstReturn >= -0.08) { stabPts = 20; stabExpl = "Très stable (pire > −8%)"; }
      else if (worstReturn >= -0.15) { stabPts = 14; stabExpl = "Stable (pire −8% à −15%)"; }
      else if (worstReturn >= -0.25) { stabPts =  7; stabExpl = "Volatile (pire −15% à −25%)"; }
      else                            { stabPts =  0; stabExpl = "Très volatile (pire < −25%)"; }
    }
    reasons.push({
      label: "Pire retour (calendrier)",
      value: worstReturn != null ? pctFmt(worstReturn) : "—",
      contribution: stabPts, maxContribution: 20, explanation: stabExpl,
    });

    const score = clamp(Math.round(winPts + retPts + riskPts + stabPts), 0, 100);
    let label;
    if      (score >= 70) label = "Favorable";
    else if (score >= 50) label = "Modéré";
    else if (score >= 35) label = "Neutre";
    else                  label = "Défavorable";

    return {
      score, label, confidence, reasons, warnings,
      sampleSize: n, yearsOfData: n, source: "calendrier",
      calendarWeek: cw,
    };
  }

  // ── Fallback : fenêtres roulantes (diagnostic) ──────────────────────────────
  if (!w) {
    return {
      score: null, label: "Données insuffisantes", confidence: "insuffisant",
      reasons: [], warnings: ["Aucune donnée 7j disponible."],
      sampleSize: 0, yearsOfData: 0, source: "aucune",
    };
  }

  warnings.push("Saisonnalité calendrier non disponible — fenêtres roulantes utilisées (diagnostic). Données moins précises.");

  const sampleSize  = w.sampleSize ?? 0;
  const yearsOfData = yearsFromSampleSize7j(sampleSize);
  const confidence  = getWeeklyConfidence(sampleSize);

  if (confidence === "insuffisant") {
    return {
      score: null, label: "Données insuffisantes", confidence: "insuffisant",
      reasons: [],
      warnings: [...warnings, `Historique insuffisant — ${yearsOfData} an(s) de données (minimum 5 requis).`],
      sampleSize, yearsOfData, source: "roulant",
    };
  }

  const winRate      = typeof w.winRate      === "number" ? w.winRate      : null;
  const avgReturn    = typeof w.avgReturn    === "number" ? w.avgReturn    : null;
  const medianReturn = typeof w.medianReturn === "number" ? w.medianReturn : null;
  const pctBelow5   = typeof w.pctBelow5    === "number" ? w.pctBelow5    : null;
  const worstReturn  = typeof w.worstReturn  === "number" ? w.worstReturn  : null;
  const useReturn = medianReturn ?? avgReturn;
  if (medianReturn == null && avgReturn != null) warnings.push("Rendement médian non disponible — moyenne utilisée.");

  let winPts = 0, winExpl = "";
  if (winRate == null) { warnings.push("Win rate 7j non disponible."); winExpl = "Données manquantes"; }
  else {
    if      (winRate >= 0.75) { winPts = 30; winExpl = "Très favorable (≥75%)"; }
    else if (winRate >= 0.65) { winPts = 24; winExpl = "Favorable (≥65%)"; }
    else if (winRate >= 0.55) { winPts = 18; winExpl = "Modéré (≥55%)"; }
    else if (winRate >= 0.50) { winPts = 12; winExpl = "Légèrement positif (≥50%)"; }
    else if (winRate >= 0.45) { winPts =  6; winExpl = "Légèrement négatif (<50%)"; }
    else                       { winPts =  0; winExpl = "Défavorable (<45%)"; }
  }
  reasons.push({ label: "7j positif (roulant)", value: winRate != null ? `${Math.round(winRate * 100)}%` : "—", contribution: winPts, maxContribution: 30, explanation: winExpl });

  let retPts = 0, retExpl = "";
  if (useReturn == null) { warnings.push("Rendement 7j non disponible."); retExpl = "Données manquantes"; }
  else {
    if      (useReturn >= 0.030) { retPts = 25; retExpl = "Excellent (≥+3%)"; }
    else if (useReturn >= 0.015) { retPts = 20; retExpl = "Bon (+1.5% à +3%)"; }
    else if (useReturn >= 0.005) { retPts = 14; retExpl = "Positif (+0.5% à +1.5%)"; }
    else if (useReturn >= 0.000) { retPts =  8; retExpl = "Légèrement positif (0 à +0.5%)"; }
    else if (useReturn >= -0.005){ retPts =  4; retExpl = "Légèrement négatif (−0.5% à 0)"; }
    else                          { retPts =  0; retExpl = "Négatif (<−0.5%)"; }
  }
  reasons.push({ label: medianReturn != null ? "Rendement médian 7j" : "Rendement moyen 7j", value: useReturn != null ? pctFmt(useReturn) : "—", contribution: retPts, maxContribution: 25, explanation: retExpl });

  let riskPts = 0, riskExpl = "";
  if (pctBelow5 == null) { warnings.push("Risque baisse >5% non disponible — neutre."); riskPts = 12; riskExpl = "Données manquantes — neutre"; }
  else {
    if      (pctBelow5 < 0.10) { riskPts = 25; riskExpl = "Risque faible (<10%)"; }
    else if (pctBelow5 < 0.20) { riskPts = 20; riskExpl = "Risque modéré (10–20%)"; }
    else if (pctBelow5 < 0.30) { riskPts = 12; riskExpl = "Risque élevé (20–30%)"; }
    else if (pctBelow5 < 0.40) { riskPts =  5; riskExpl = "Risque très élevé (30–40%)"; }
    else                        { riskPts =  0; riskExpl = "Risque critique (≥40%)"; }
    if (pctBelow5 > 0.25) warnings.push(`Risque baisse >5% : ${Math.round(pctBelow5 * 100)}% des périodes.`);
  }
  reasons.push({ label: "Risque baisse >5% (inversé, roulant)", value: pctBelow5 != null ? `${Math.round(pctBelow5 * 100)}%` : "—", contribution: riskPts, maxContribution: 25, explanation: riskExpl });

  let stabPts = 0, stabExpl = "";
  if (worstReturn == null) { stabPts = 10; stabExpl = "Données manquantes — neutre"; warnings.push("Pire retour 7j non disponible."); }
  else {
    if      (worstReturn >= -0.08) { stabPts = 20; stabExpl = "Très stable (pire > −8%)"; }
    else if (worstReturn >= -0.15) { stabPts = 14; stabExpl = "Stable (pire −8% à −15%)"; }
    else if (worstReturn >= -0.25) { stabPts =  7; stabExpl = "Volatile (pire −15% à −25%)"; }
    else                            { stabPts =  0; stabExpl = "Très volatile (pire < −25%)"; }
  }
  reasons.push({ label: "Stabilité / pire retour 7j (roulant)", value: worstReturn != null ? pctFmt(worstReturn) : "—", contribution: stabPts, maxContribution: 20, explanation: stabExpl });

  const score = clamp(Math.round(winPts + retPts + riskPts + stabPts), 0, 100);
  let label;
  if      (score >= 70) label = "Favorable";
  else if (score >= 50) label = "Modéré";
  else if (score >= 35) label = "Neutre";
  else                  label = "Défavorable";

  return { score, label, confidence, reasons, warnings, sampleSize, yearsOfData, source: "roulant" };
}

// ─── Score fenêtre annuelle active ────────────────────────────────────────────

/**
 * Retourne le score et la description de la fenêtre annuelle active.
 *
 * @param {{ windowsData: object | null, today?: Date }} input
 * @returns {{ score, label, confidence, reasons, warnings, activeWindow, annualWindowBonus }}
 */
export function computeAnnualWindowScore(input) {
  const windowsData = input?.windowsData ?? null;
  const today       = input?.today ?? new Date();
  const warnings    = [];
  const reasons     = [];

  if (!windowsData) {
    return {
      score: 50, label: "Neutre", confidence: "insuffisant",
      reasons: [{ label: "Fenêtre annuelle", value: "—", contribution: 50, maxContribution: 100,
        explanation: "Données de fenêtres annuelles non disponibles." }],
      warnings: ["Données de fenêtres annuelles non disponibles."],
      activeWindow: null, annualWindowBonus: 0,
    };
  }

  const bullishWindows   = windowsData.annualDisplayWindows?.bullish ?? [];
  const vigilanceWindows = windowsData.recentBearishVigilance        ?? [];
  const bearishWindows   = windowsData.bestBearishAnnualWindows      ?? [];

  let activeWindow = null;
  let windowType   = null;

  for (const w of bullishWindows) {
    if (isWindowActiveToday(w, today)) { activeWindow = w; windowType = "bullish"; break; }
  }
  if (!activeWindow) {
    for (const w of vigilanceWindows) {
      if (isWindowActiveToday(w, today)) { activeWindow = w; windowType = "vigilance"; break; }
    }
  }
  if (!activeWindow) {
    for (const w of bearishWindows) {
      if (isWindowActiveToday(w, today)) { activeWindow = w; windowType = "bearish"; break; }
    }
  }

  const annualConf  = activeWindow ? getAnnualConfidence(activeWindow.annualHorizons) : "insuffisant";
  const bestHorizon = activeWindow ? pickBestAnnualHorizon(activeWindow.annualHorizons) : null;
  const winRateAnnual   = bestHorizon?.stats?.winRateAnnual   ?? null;
  const avgReturnAnnual = bestHorizon?.stats?.avgReturnAnnual ?? null;
  const strength = activeWindow?.strength ?? null;

  let score = 50, label = "Neutre", annualWindowBonus = 0;

  if (!activeWindow) {
    reasons.push({ label: "Fenêtre annuelle", value: "Aucune active", contribution: 50, maxContribution: 100,
      explanation: "Aucune fenêtre annuelle bullish ou bearish active en ce moment." });

  } else if (windowType === "bullish") {
    if (strength === "Forte") {
      if      (annualConf === "robuste")    { score = 87; label = "Haussière forte";         annualWindowBonus = 10; }
      else if (annualConf === "mesurable")  { score = 80; label = "Haussière forte";         annualWindowBonus = 8; }
      else                                  { score = 72; label = "Haussière";               annualWindowBonus = 7; }
    } else if (strength === "Confirmée") {  score = 70; label = "Haussière";               annualWindowBonus = 7; }
    else                                 {  score = 58; label = "Légèrement haussière";    annualWindowBonus = 3; }
    const wrStr  = winRateAnnual   != null ? ` · Win rate ${Math.round(winRateAnnual * 100)}%`   : "";
    const retStr = avgReturnAnnual != null ? ` · Moy. ${pctFmt(avgReturnAnnual)}`                 : "";
    reasons.push({ label: "Fenêtre annuelle haussière active",
      value: activeWindow.displayLabel ?? "Fenêtre active",
      contribution: score, maxContribution: 100,
      explanation: `Strength: ${strength ?? "—"}${wrStr}${retStr} (${bestHorizon?.key ?? "—"})` });

  } else if (windowType === "vigilance") {
    score = 28; label = "Vigilance baissière"; annualWindowBonus = -8;
    warnings.push(`Vigilance baissière active : ${activeWindow.displayLabel ?? "fenêtre récente"}. Prudence recommandée.`);
    reasons.push({ label: "Vigilance baissière récente",
      value: activeWindow.displayLabel ?? "Fenêtre active",
      contribution: score, maxContribution: 100,
      explanation: "Baisse récente significative (5 ans), long terme plus neutre." });

  } else if (windowType === "bearish") {
    score = 15; label = "Baissière confirmée"; annualWindowBonus = -15;
    warnings.push(`Fenêtre baissière confirmée : ${activeWindow.displayLabel ?? ""}. Éviter vente de puts.`);
    reasons.push({ label: "Fenêtre annuelle baissière active",
      value: activeWindow.displayLabel ?? "Fenêtre active",
      contribution: score, maxContribution: 100,
      explanation: "Fenêtre baissière multi-horizons. Risque élevé." });
  }

  return {
    score, label, confidence: activeWindow ? annualConf : "insuffisant",
    reasons, warnings,
    activeWindow: activeWindow ? {
      type: windowType,
      displayLabel:  activeWindow.displayLabel  ?? null,
      strength:      strength                   ?? null,
      winRateAnnual, avgReturnAnnual,
      bestHorizonKey: bestHorizon?.key          ?? null,
    } : null,
    annualWindowBonus,
  };
}

// ─── Score CSP ────────────────────────────────────────────────────────────────

/**
 * Score décisionnel CSP — "Est-ce défendable de vendre un put cette semaine ?"
 *
 * @param {{
 *   weeklyScore: object,
 *   annualWindowScore: object,
 *   w7j: object,
 *   pop?: number|null,
 *   strikeRelation?: "below_lower"|"near_lower"|"within"|"too_close"|null,
 *   premiumYield?: number|null,
 *   bidAskSpread?: number|null,
 *   tickerQuality?: "bon"|"moyen"|"faible"|null,
 * }} input
 * @returns {{ score, label, confidence, reasons, warnings }}
 */
export function computeCspSeasonalityDecision(input) {
  const {
    weeklyScore, annualWindowScore, w7j,
    pop            = null,
    strikeRelation = null,
    premiumYield   = null,
    bidAskSpread   = null,
    tickerQuality  = null,
  } = input ?? {};

  const warnings = [], reasons = [];
  let totalScore = 0;

  const pctBelow5   = w7j?.pctBelow5  ?? null;
  const annualBonus = annualWindowScore?.annualWindowBonus ?? 0;

  // 1. POP du put (20 pts)
  let popPts = 0;
  if (pop == null) {
    warnings.push("POP du put non disponible — valeur neutre appliquée.");
    popPts = 10;
    reasons.push({ label: "POP put", value: "—", contribution: 10, maxContribution: 20, explanation: "Non fourni — neutre." });
  } else {
    if      (pop >= 92) popPts = 20;
    else if (pop >= 88) popPts = 16;
    else if (pop >= 84) popPts = 10;
    else                popPts =  4;
    const popExpl = pop >= 92 ? "Excellent (≥92%)" : pop >= 88 ? "Bon (≥88%)" : pop >= 84 ? "Acceptable (≥84%)" : "Faible (<84%)";
    reasons.push({ label: "POP put", value: `${Math.round(pop)}%`, contribution: popPts, maxContribution: 20, explanation: popExpl });
  }
  totalScore += popPts;

  // 2. Distance strike vs mouvement attendu (20 pts)
  let strikePts = 0;
  if (strikeRelation == null) {
    warnings.push("Position du strike vs mouvement attendu non disponible — neutre.");
    strikePts = 10;
    reasons.push({ label: "Strike vs expected move", value: "—", contribution: 10, maxContribution: 20, explanation: "Non disponible — neutre." });
  } else {
    const STRIKE_MAP = {
      below_lower: [20, "Strike sous borne basse attendue"],
      near_lower:  [14, "Strike proche borne basse"],
      within:      [ 8, "Strike dans la plage attendue"],
      too_close:   [ 3, "Strike trop proche du prix"],
    };
    const [pts, expl] = STRIKE_MAP[strikeRelation] ?? [0, "Inconnu"];
    strikePts = pts;
    if (strikeRelation === "within")    warnings.push("Strike dans la plage de mouvement attendu — risque d'assignation plus élevé.");
    if (strikeRelation === "too_close") warnings.push("Strike trop proche du prix courant — risque d'assignation très élevé.");
    reasons.push({ label: "Strike vs expected move", value: strikeRelation, contribution: strikePts, maxContribution: 20, explanation: expl });
  }
  totalScore += strikePts;

  // 3. Risque baisse hebdo (20 pts)
  let riskPts = 0;
  if (pctBelow5 == null) {
    warnings.push("Risque baisse 7j non disponible — neutre.");
    riskPts = 10;
    reasons.push({ label: "Risque baisse >5% (7j)", value: "—", contribution: 10, maxContribution: 20, explanation: "Non disponible." });
  } else {
    if      (pctBelow5 < 0.15) { riskPts = 20; }
    else if (pctBelow5 < 0.25) { riskPts = 12; }
    else if (pctBelow5 < 0.35) { riskPts =  6; }
    else                        { riskPts =  0; }
    const riskExpl = pctBelow5 < 0.15 ? "Risque faible (<15%)" : pctBelow5 < 0.25 ? "Risque modéré (15–25%)" : pctBelow5 < 0.35 ? "Risque élevé (25–35%)" : "Risque très élevé (≥35%)";
    if (pctBelow5 > 0.25) warnings.push(`Risque baisse >5% : ${Math.round(pctBelow5 * 100)}%.`);
    reasons.push({ label: "Risque baisse >5% (7j)", value: `${Math.round(pctBelow5 * 100)}%`, contribution: riskPts, maxContribution: 20, explanation: riskExpl });
  }
  totalScore += riskPts;

  // 4. Prime / rendement (15 pts)
  let premPts = 0;
  if (premiumYield == null) {
    warnings.push("Prime CSP non disponible — neutre.");
    premPts = 7;
    reasons.push({ label: "Prime / rendement", value: "—", contribution: 7, maxContribution: 15, explanation: "Non disponible." });
  } else {
    if      (premiumYield >= 0.01)  { premPts = 15; }
    else if (premiumYield >= 0.007) { premPts = 11; }
    else if (premiumYield >= 0.005) { premPts =  7; }
    else                             { premPts =  0; }
    if (premiumYield < 0.005) warnings.push(`Prime insuffisante : ${(premiumYield * 100).toFixed(2)}% (minimum 0.5%).`);
    const premExpl = premiumYield >= 0.01 ? "Excellent (≥1.0%)" : premiumYield >= 0.007 ? "Bon (0.7–1.0%)" : premiumYield >= 0.005 ? "Acceptable (0.5–0.7%)" : "Insuffisant (<0.5%)";
    reasons.push({ label: "Prime / rendement", value: `${(premiumYield * 100).toFixed(2)}%`, contribution: premPts, maxContribution: 15, explanation: premExpl });
  }
  totalScore += premPts;

  // 5. Spread / liquidité (10 pts)
  let spreadPts = 0;
  if (bidAskSpread == null) {
    warnings.push("Spread bid/ask non disponible — neutre.");
    spreadPts = 5;
    reasons.push({ label: "Spread bid/ask", value: "—", contribution: 5, maxContribution: 10, explanation: "Non disponible." });
  } else {
    if      (bidAskSpread < 0.10) { spreadPts = 10; }
    else if (bidAskSpread < 0.20) { spreadPts =  7; }
    else if (bidAskSpread < 0.35) { spreadPts =  3; }
    else                           { spreadPts =  0; }
    if (bidAskSpread > 0.20) warnings.push(`Spread bid/ask élevé : ${(bidAskSpread * 100).toFixed(1)}%.`);
    const spreadExpl = bidAskSpread < 0.10 ? "Excellent (<10%)" : bidAskSpread < 0.20 ? "Acceptable (10–20%)" : bidAskSpread < 0.35 ? "Élevé (20–35%)" : "Très élevé (≥35%)";
    reasons.push({ label: "Spread bid/ask", value: `${(bidAskSpread * 100).toFixed(1)}%`, contribution: spreadPts, maxContribution: 10, explanation: spreadExpl });
  }
  totalScore += spreadPts;

  // 6. Fenêtre annuelle active (10 pts, peut être négatif)
  const annualDisplay = annualWindowScore?.activeWindow?.displayLabel ?? (annualWindowScore?.label ?? "Neutre");
  reasons.push({
    label: "Fenêtre annuelle", value: annualDisplay,
    contribution: annualBonus, maxContribution: 10,
    explanation: annualBonus > 0 ? `Haussière active (+${annualBonus} pts)` : annualBonus < 0 ? `Défavorable (${annualBonus} pts)` : "Aucune fenêtre active (neutre)",
  });
  totalScore += annualBonus;

  // 7. Qualité ticker (5 pts)
  let qualPts = 2;
  if (tickerQuality == null) {
    reasons.push({ label: "Qualité ticker", value: "—", contribution: 2, maxContribution: 5, explanation: "Non disponible — neutre." });
  } else {
    const Q = { bon: [5, "Bon ticker"], moyen: [2, "Ticker moyen"], faible: [0, "Ticker faible"] };
    const [pts, expl] = Q[tickerQuality] ?? [2, "—"];
    qualPts = pts;
    reasons.push({ label: "Qualité ticker", value: tickerQuality, contribution: qualPts, maxContribution: 5, explanation: expl });
  }
  totalScore += qualPts;

  const score = clamp(Math.round(totalScore), 0, 100);
  let label;
  if      (score >= 80) label = "Très favorable";
  else if (score >= 65) label = "Favorable";
  else if (score >= 50) label = "Neutre+";
  else if (score >= 40) label = "Neutre / prudence";
  else                  label = "Risqué";

  const conf = worstConfidence(weeklyScore?.confidence ?? "insuffisant", annualWindowScore?.confidence ?? "insuffisant");
  return { score, label, confidence: conf, reasons, warnings };
}

// ─── Score CC ────────────────────────────────────────────────────────────────

/**
 * Score décisionnel CC — "Est-ce défendable de vendre un covered call cette semaine ?"
 *
 * @param {{
 *   weeklyScore: object,
 *   annualWindowScore: object,
 *   w7j: object,
 *   ccStrike?: number|null,
 *   currentPrice?: number|null,
 *   assignmentStrike?: number|null,
 *   expectedMoveHigh?: number|null,
 *   premiumYield?: number|null,
 *   bidAskSpread?: number|null,
 * }} input
 * @returns {{ score, label, confidence, reasons, warnings }}
 */
export function computeCcSeasonalityDecision(input) {
  const {
    weeklyScore, annualWindowScore, w7j,
    ccStrike        = null,
    currentPrice    = null,
    assignmentStrike = null,
    expectedMoveHigh = null,
    premiumYield    = null,
    bidAskSpread    = null,
  } = input ?? {};

  const warnings = [], reasons = [];

  // Règle absolue : CC sous prix d'assignation interdit
  if (assignmentStrike != null && ccStrike != null && ccStrike < assignmentStrike) {
    warnings.push(`CC sous prix d'assignation interdit (CC ${ccStrike} < assignation ${assignmentStrike}).`);
    return {
      score: 0, label: "À éviter", confidence: weeklyScore?.confidence ?? "insuffisant",
      reasons: [{ label: "CC sous prix d'assignation", value: `CC ${ccStrike} < assignation ${assignmentStrike}`,
        contribution: 0, maxContribution: 100,
        explanation: "Interdit — vendre un CC sous le prix d'assignation garantit une perte." }],
      warnings,
    };
  }

  let totalScore = 0;
  const pctAbove5  = w7j?.pctAbove5 ?? null;
  const annualType = annualWindowScore?.activeWindow?.type ?? null;

  // 1. Risque hausse 7j inversé (30 pts)
  let upsidePts = 0;
  if (pctAbove5 == null) {
    warnings.push("Risque hausse >5% non disponible — neutre.");
    upsidePts = 15;
    reasons.push({ label: "Risque hausse >5% (7j)", value: "—", contribution: 15, maxContribution: 30, explanation: "Non disponible — neutre." });
  } else {
    if      (pctAbove5 <= 0.15) { upsidePts = 30; }
    else if (pctAbove5 <= 0.25) { upsidePts = 20; }
    else if (pctAbove5 <= 0.35) { upsidePts = 10; }
    else                         { upsidePts =  0; }
    if (pctAbove5 > 0.30) warnings.push(`Risque hausse >5% : ${Math.round(pctAbove5 * 100)}% — CC peut être assigné.`);
    const upsideExpl = upsidePts >= 30 ? "Risque faible (≤15%)" : upsidePts >= 20 ? "Risque modéré (15–25%)" : upsidePts >= 10 ? "Risque élevé (25–35%)" : "Risque très élevé (>35%)";
    reasons.push({ label: "Risque hausse >5% (7j)", value: `${Math.round(pctAbove5 * 100)}%`, contribution: upsidePts, maxContribution: 30, explanation: upsideExpl });
  }
  totalScore += upsidePts;

  // 2. Strike CC vs borne haute attendue (25 pts)
  let strikePts = 12; // neutral default
  if (ccStrike == null || expectedMoveHigh == null) {
    warnings.push("Strike CC ou borne haute attendue non disponible — neutre.");
    reasons.push({ label: "Strike CC vs borne haute", value: "—", contribution: 12, maxContribution: 25, explanation: "Non disponible — neutre." });
  } else {
    const ratio = ccStrike / expectedMoveHigh;
    if      (ratio > 1.05) { strikePts = 25; }
    else if (ratio > 1.01) { strikePts = 18; }
    else if (ratio > 0.98) { strikePts = 10; }
    else                    { strikePts =  4; }
    if (strikePts < 10) warnings.push("Strike CC proche ou sous la borne haute de mouvement attendu.");
    const strikeExpl = strikePts >= 25 ? "Strike bien au-dessus borne haute" : strikePts >= 18 ? "Légèrement au-dessus" : strikePts >= 10 ? "Proche borne haute" : "Sous borne haute — risque assignation";
    reasons.push({ label: "Strike CC vs borne haute attendue", value: `${ccStrike}`, contribution: strikePts, maxContribution: 25, explanation: strikeExpl });
  }
  totalScore += strikePts;

  // 3. Prime / rendement CC (15 pts)
  let premPts = 7;
  if (premiumYield == null) {
    reasons.push({ label: "Prime CC", value: "—", contribution: 7, maxContribution: 15, explanation: "Non disponible — neutre." });
  } else {
    if      (premiumYield >= 0.01)  { premPts = 15; }
    else if (premiumYield >= 0.007) { premPts = 11; }
    else if (premiumYield >= 0.005) { premPts =  7; }
    else                             { premPts =  0; }
    if (premiumYield < 0.005) warnings.push(`Prime CC insuffisante : ${(premiumYield * 100).toFixed(2)}%.`);
    const premExpl = premPts >= 15 ? "Excellent (≥1.0%)" : premPts >= 11 ? "Bon (0.7–1.0%)" : premPts >= 7 ? "Acceptable (0.5–0.7%)" : "Insuffisant (<0.5%)";
    reasons.push({ label: "Prime CC", value: `${(premiumYield * 100).toFixed(2)}%`, contribution: premPts, maxContribution: 15, explanation: premExpl });
  }
  totalScore += premPts;

  // 4. Spread (10 pts)
  let spreadPts = 5;
  if (bidAskSpread == null) {
    reasons.push({ label: "Spread bid/ask", value: "—", contribution: 5, maxContribution: 10, explanation: "Non disponible — neutre." });
  } else {
    if      (bidAskSpread < 0.10) { spreadPts = 10; }
    else if (bidAskSpread < 0.20) { spreadPts =  7; }
    else if (bidAskSpread < 0.35) { spreadPts =  3; }
    else                           { spreadPts =  0; }
    if (bidAskSpread > 0.20) warnings.push(`Spread bid/ask CC élevé : ${(bidAskSpread * 100).toFixed(1)}%.`);
    reasons.push({ label: "Spread bid/ask", value: `${(bidAskSpread * 100).toFixed(1)}%`, contribution: spreadPts, maxContribution: 10, explanation: "Spread bid/ask" });
  }
  totalScore += spreadPts;

  // 5. Contexte annuel pour CC (20 pts) — haussière = risque, baissière = avantage
  let annualPts = 10; // neutre par défaut
  if (annualType === "bullish") {
    // Fenêtre haussière = risque d'assignation si CC trop proche
    const tooClose = ccStrike != null && currentPrice != null && (ccStrike - currentPrice) / currentPrice < 0.05;
    annualPts = tooClose ? 0 : 5;
    if (tooClose) warnings.push("Fenêtre haussière + CC trop proche du prix — risque d'assignation élevé.");
    const annExpl = tooClose ? "Fenêtre haussière + CC trop proche — pénalité forte" : "Fenêtre haussière — CC doit être éloigné du prix";
    reasons.push({ label: "Contexte annuel (CC)", value: annualWindowScore?.activeWindow?.displayLabel ?? "Haussière", contribution: annualPts, maxContribution: 20, explanation: annExpl });
  } else if (annualType === "vigilance") {
    annualPts = 12;
    reasons.push({ label: "Contexte annuel (CC)", value: "Vigilance baissière", contribution: 12, maxContribution: 20, explanation: "Contexte légèrement favorable au CC (risque hausse réduit)." });
  } else if (annualType === "bearish") {
    annualPts = 18;
    reasons.push({ label: "Contexte annuel (CC)", value: "Baissière confirmée", contribution: 18, maxContribution: 20, explanation: "Fenêtre baissière — hausse improbable, très favorable au CC." });
  } else {
    reasons.push({ label: "Contexte annuel (CC)", value: "Neutre", contribution: 10, maxContribution: 20, explanation: "Aucune fenêtre active — neutre." });
  }
  totalScore += annualPts;

  const score = clamp(Math.round(totalScore), 0, 100);
  let label;
  if      (score >= 80) label = "Très favorable";
  else if (score >= 65) label = "Favorable";
  else if (score >= 50) label = "Neutre";
  else if (score >= 40) label = "Risque hausse";
  else                  label = "À éviter";

  const conf = worstConfidence(weeklyScore?.confidence ?? "insuffisant", annualWindowScore?.confidence ?? "insuffisant");
  return { score, label, confidence: conf, reasons, warnings };
}

// ─── Verdict Wheel ───────────────────────────────────────────────────────────

function buildWheelVerdict(cspScore, ccScore, annualWindowScore) {
  const csp = cspScore?.score  ?? null;
  const cc  = ccScore?.score   ?? null;
  const annualType  = annualWindowScore?.activeWindow?.type ?? null;
  const annualLabel = annualWindowScore?.activeWindow?.displayLabel ?? null;

  if (csp == null && cc == null) {
    return { label: "Données insuffisantes", explanation: "Aucune donnée court terme disponible.", confidence: "insuffisant" };
  }

  let label, explanation;
  const cspOk = csp != null && csp >= 65;
  const ccOk  = cc  != null && cc  >= 65;
  const cspRisky = csp == null || csp < 50;
  const ccRisky  = cc  == null || cc  < 50;

  if      (cspOk && ccRisky)  { label = "CSP recommandé · CC à éviter";    explanation = "Saisonnalité favorable pour vendre un put, mais trop risquée pour un covered call."; }
  else if (cspOk && ccOk)     { label = "CSP et CC favorables";            explanation = "Semaine favorable pour les deux stratégies. Vérifier strikes et primes individuellement."; }
  else if (cspRisky && ccOk)  { label = "CC possible · CSP risqué";        explanation = "Risque baissier court terme — le covered call est plus adapté que le put nu."; }
  else if (!cspRisky && !cspOk){ label = "CSP acceptable avec prudence";   explanation = "Score modéré — vérifier niveaux de strikes et de prime avant de vendre un put."; }
  else if (cspRisky && ccRisky){ label = "Semaine défavorable — Wheel à éviter"; explanation = "Saisonnalité défavorable pour les deux stratégies cette semaine."; }
  else                         { label = "Neutre — analyser les conditions"; explanation = "Score moyen. Vérifier strikes, primes et spread avant d'agir."; }

  if (annualType === "bullish" && annualLabel) {
    explanation += ` Fenêtre annuelle haussière active (${annualLabel}) — favorable pour la vente de puts.`;
  } else if (annualType === "vigilance") {
    explanation += " Vigilance baissière annuelle — rester prudent même si court terme favorable.";
  } else if (annualType === "bearish") {
    explanation += " Fenêtre annuelle baissière — réduire la taille des positions CSP.";
  }

  const conf = worstConfidence(cspScore?.confidence ?? "insuffisant", ccScore?.confidence ?? "insuffisant");
  return { label, explanation, confidence: conf };
}

// ─── Header complet ──────────────────────────────────────────────────────────

/**
 * Construit le header décisionnel complet à partir du bundle saisonnalité.
 * Peut être appelé sans contexte d'options (POP, strike, prime, spread) —
 * dans ce cas les critères optionnels reçoivent une valeur neutre.
 *
 * @param {{
 *   shortTermData: object | null,
 *   windowsData: object | null,
 *   cspContext?: object,
 *   ccContext?: object,
 *   today?: Date,
 * }} input
 * @returns {{ weeklyScore, annualWindowScore, cspScore, ccScore, wheelVerdict }}
 */
export function buildSeasonalityDecisionHeader(input) {
  const { shortTermData, windowsData, cspContext, ccContext, today } = input ?? {};

  const w7j          = shortTermData?.windows?.find((w) => w.days === 7) ?? null;
  const calendarWeek = shortTermData?.calendarWeek ?? null;

  const weeklyScore       = computeWeeklySeasonalityScore({ calendarWeek, shortTermWindow7j: w7j });
  const annualWindowScore = computeAnnualWindowScore({ windowsData, today });

  const cspScore = computeCspSeasonalityDecision({ weeklyScore, annualWindowScore, w7j, ...cspContext });
  const ccScore  = computeCcSeasonalityDecision({  weeklyScore, annualWindowScore, w7j, ...ccContext });

  const wheelVerdict = buildWheelVerdict(cspScore, ccScore, annualWindowScore);

  return { weeklyScore, annualWindowScore, cspScore, ccScore, wheelVerdict };
}
