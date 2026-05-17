/**
 * Enveloppe JSON read-only Alternative Composition Recommendation V1 (AGGRESSIVE).
 * Format stable pour exports debug — aucun effet live.
 */

import {
  deltaSummaryVsGreedyBaseline,
  finalPositionsFromPicks,
} from "./aggressiveComboSimulationShared.mjs";

function liteSummary(s) {
  if (!s || typeof s !== "object") return null;
  return {
    simCompositePortfolioScore: s.simCompositePortfolioScore,
    premiumTotalUsd: s.premiumTotalUsd,
    portfolioYieldWeightedPct: s.portfolioYieldWeightedPct,
    capitalUsedUsd: s.capitalUsedUsd,
    capitalFreeUsd: s.capitalFreeUsd,
    diversificationHealthScore: s.diversificationHealthScore,
    concentrationRiskScore: s.concentrationRiskScore,
    highBetaCapitalPct: s.highBetaCapitalPct,
    dominantTickerCapitalPct: s.dominantTickerCapitalPct,
    tickers: s.tickers,
    distinctLines: s.distinctLines,
    penaltiesSimV1: s.penaltiesSimV1 ?? null,
  };
}

/** @param {object[]} scenarios from runAggressiveForcedFirstSimulation */
export function compactForcedFirstRows(scenarios) {
  const rows = scenarios.filter((s) => s.candidate != null);
  return rows.map((s) => ({
    candidate: s.candidate,
    skipped: s.skipped === true,
    scenarioId: s.id ?? null,
    reason: s.reason ?? null,
    verdictFr: s.verdict ?? null,
    forcedFirstApplied: s.forcedFirstApplied === true,
    deltaVsGreedyBaseline: s.deltaVsGreedyBaseline,
    summary: s.skipped ? null : liteSummary(s.summary),
    picksCompact: s.picksCompact ?? null,
    finalPositions: s.finalPositions ?? null,
    penaltiesSimV1: s.skipped ? null : s.penaltiesSimV1 ?? s.summary?.penaltiesSimV1 ?? null,
  }));
}

/**
 * Synthèse risque read-only (FR) sans changer seuils ni logique métier — lecture des métriques sim.
 *
 * @param {object} p
 * @param {object | null} p.baselineLite
 * @param {object | null} p.altLite
 * @param {object | null} p.deltaVsBaseline
 */
export function buildRiskReviewFr({ baselineLite, altLite, deltaVsBaseline }) {
  const bullets = [];
  let severity = "info";

  const pushSev = (text, lev) => {
    bullets.push(text);
    if (lev === "elevated") severity = "elevated";
    else if (lev === "moderate" && severity === "info") severity = "moderate";
  };

  pushSev("Diagnostic hors live : aucun ordre IBKR ; la composition greedy du dashboard demeure inchangée.", "info");

  if (!altLite) {
    return {
      severity,
      bulletsFr: bullets,
      headlineFr:
        "Aucune composition alternative exploitables : comparer baseline uniquement ou réessayer avec --scan-json et une shortlist fraîche.",
    };
  }

  const dh = deltaVsBaseline?.deltaHighBetaCapitalPct;
  if (dh != null && Number.isFinite(dh) && Math.abs(dh) > 3) {
    pushSev(
      dh > 0
        ? `Capital high-beta pondéré monte d’environ ${dh.toFixed(1)} pts vs baseline — prudence sur la cascade de risques.`
        : `Capital high-beta baisse d’environ ${Math.abs(dh).toFixed(1)} pts vs baseline.`,
      dh > 5 ? "elevated" : "moderate",
    );
  }

  const dd = deltaVsBaseline?.deltaDominantTickerCapitalPct;
  if (dd != null && Number.isFinite(dd) && dd > 4) {
    pushSev(
      `Concentration sur le titre dominant ↑ d’environ ${dd.toFixed(1)} pts — la composition alternative peut être moins équilibrée.`,
      dd > 8 ? "elevated" : "moderate",
    );
  }

  const div = deltaVsBaseline?.deltaDiversificationScore;
  if (div != null && Number.isFinite(div) && Math.abs(div) > 0.02) {
    pushSev(
      div > 0
        ? `Indicateur diversification sim amélioré d’environ ${div.toFixed(3)} vs baseline.`
        : `Indicateur diversification sim diminué d’environ ${Math.abs(div).toFixed(3)} vs baseline.`,
      div < -0.05 ? "elevated" : "moderate",
    );
  }

  const cpe = deltaVsBaseline?.deltaPenaltyConcentration;
  if (cpe != null && Number.isFinite(cpe) && Math.abs(cpe) > 0.01) {
    pushSev(
      cpe < 0
        ? `Pénalité concentration sim mieux contenue (${cpe.toFixed(3)}) que le baseline sur cette grille.`
        : `Pénalité concentration sim plus élevée (+${cpe.toFixed(3)}) que le baseline — vérifier thèmes / secteurs.`,
      cpe > 0.05 ? "elevated" : "moderate",
    );
  }

  const pe = deltaVsBaseline?.deltaPenaltyEarnings;
  if (pe != null && Number.isFinite(pe) && Math.abs(pe) > 0.01) {
    pushSev(
      pe > 0
        ? `Pénalité earnings ↑ (+${pe.toFixed(3)}) vs baseline calendar sim.`
        : `Pénalité earnings ↓ (${pe.toFixed(3)}) vs baseline.`,
      Math.abs(pe) > 0.05 ? "moderate" : "info",
    );
  }

  const y = deltaVsBaseline?.deltaYieldWeightedPct;
  if (y != null && Number.isFinite(y) && y > 0.035) {
    pushSev(
      `Rendement pondéré sim monte sensiblement (~+${y.toFixed(3)} pts) ; souvent lié au risque de jambe AGGRESSIVE (distance / POP à relire ligne par ligne).`,
      "elevated",
    );
  }

  return {
    severity,
    baselineLite,
    alternativeLite: altLite,
    bulletsFr: bullets,
    headlineFr:
      severity === "elevated"
        ? "Risques sim non négligeables vs baseline ; relire lignes avant toute intuition de taille réelle."
        : severity === "moderate"
          ? "Variante plausible mais pas sans compromis concentration / risque ; comparaison manuelle conseillée."
          : "Profil risque global proche du baseline sur les métriques sim disponibles.",
  };
}

/**
 * Objet recommendation structuré (FR lisible).
 */
export function buildRecommendationObject({
  headlineFr,
  bestTicker,
  deltaVsBaseline,
  anyExecutableForcedFirst,
}) {
  return {
    readOnlyDisclaimerFr:
      "Recommandation alternative purement indicative : même moteur que la simulation forced-first ; ne remplace pas le greedy live Capital Combo.",
    headlineFr,
    bestForcedFirstTicker: bestTicker,
    deltasVsGreedyBaseline: deltaVsBaseline,
    suggestedActionFr:
      anyExecutableForcedFirst && bestTicker
        ? `Si exploration manuelle : comparer ligne par ligne le scénario ${bestTicker} first vs le greedy baseline (JSON picksCompact). Aucune exécution automatique prévue dans ce projet.`
        : "Rien à pousser côté live ; affiner les entrées (--scan-json) ou élargir la shortlist hors watchlist vide.",
    liveChangeIntended: false,
  };
}

/**
 * Payload complet pour debug/aggressive-alternative-recommendation-*.json
 */
export function buildAggressiveAlternativeRecommendationV1Envelope(coreResult) {
  const baselineSummary = coreResult.baselineSummary;
  const scenarios = coreResult.scenarios ?? [];
  const bestForced = coreResult.bestForced;
  const missingData = [...(coreResult.missingData ?? [])];

  const baselineGreedy = {
    summary: baselineSummary,
    finalPositions: finalPositionsFromPicks(coreResult.baselinePicks ?? []),
    tickersOrdered: baselineSummary?.tickers ?? null,
    engineNoteFr:
      "buildPortfolioCombos AGGRESSIVE (greedy replay) — identique au chemin utilisé dans la simulation forced-first baseline.",
  };

  const forcedFirstCandidates = compactForcedFirstRows(scenarios);

  let bestAlternative = null;
  let deltaVsBaseline = null;

  if (bestForced?.summary && baselineSummary) {
    deltaVsBaseline = deltaSummaryVsGreedyBaseline(baselineSummary, bestForced.summary);
    bestAlternative = {
      scenarioId: bestForced.id ?? null,
      forcedFirstTicker: bestForced.candidate,
      verdictFr: bestForced.verdict ?? null,
      summary: liteSummary(bestForced.summary),
      fullSummary: bestForced.summary,
      deltaVsGreedyBaseline: deltaVsBaseline,
      picksCompact: bestForced.picksCompact ?? null,
      finalPositions: bestForced.finalPositions ?? null,
    };
  }

  const altLite = bestAlternative?.summary ?? null;
  const baseLite = liteSummary(baselineSummary);
  const riskReview = buildRiskReviewFr({
    baselineLite: baseLite,
    altLite,
    deltaVsBaseline,
  });

  const anyExecutableForcedFirst = scenarios.some((s) => s.candidate && !s.skipped);

  const recommendation = buildRecommendationObject({
    headlineFr: coreResult.recommendationFr ?? "",
    bestTicker: bestForced?.candidate ?? null,
    deltaVsBaseline,
    anyExecutableForcedFirst,
  });

  return {
    simulationOnly: true,
    exportedAt: coreResult.exportedAtIso,
    kind: "aggressive_alternative_composition_recommendation_v1",
    expiration: coreResult.expiration,
    args: coreResult.args,
    stagingMeta: coreResult.stagingMeta ?? null,
    scanDiagnosticsV1: coreResult.scanDiagnosticsV1 ?? null,
    inputSource: coreResult.inputSource,
    baselineGreedy,
    forcedFirstCandidates,
    bestAlternative,
    deltaVsBaseline,
    recommendation,
    riskReview,
    missingData,
    forcedFirstCandidatesOrdered: coreResult.forcedFirstCandidatesOrdered ?? null,
    limitsFr:
      "Heuristique greedy + VirtualAllocator read-only ; aucun seuil Wheel / Capital Combo / V3 modifié. Ne reflète pas un audit IBKR temps réel.",
  };
}
