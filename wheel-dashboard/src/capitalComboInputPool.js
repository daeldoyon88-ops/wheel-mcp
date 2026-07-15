/**
 * AF-06 — Séparation du pool canonique du moteur de combinaisons et des lignes
 * visibles du tableau.
 *
 * Règle fondamentale :
 * - `buildComboCandidatePool` applique UNIQUEMENT les filtres métier de niveau
 *   affichage→moteur (expiration sélectionnée). Il est indépendant de la
 *   recherche, du filtre Mode (UI) et du tri. Les autres règles métier
 *   (exclusions IBKR, éligibilité, caps, tie-break AF-05) restent internes à
 *   buildPortfolioCombos et ne sont pas dupliquées ici.
 * - `buildVisibleTableRows` applique les filtres purement visuels (recherche
 *   texte, filtre Mode UI, tri) au-dessus du pool canonique. Son résultat
 *   alimente le tableau, jamais le moteur.
 *
 * Les deux fonctions sont pures : aucune mutation des tableaux d'entrée
 * (le tri travaille toujours sur une copie).
 */

import { candidateRowMatchesSelectedExpiration } from "./expirationKey.js";
import { resolveDashboardModeForFilter } from "./balancedModeUi.js";

/**
 * Recherche visuelle : ticker ou nom, insensible à la casse, espaces de bord
 * ignorés (aligné sur le compteur `removedBySearch` du diagnostic pipeline).
 */
export function rowMatchesSearchQuery(item, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return (
    String(item?.ticker ?? "").toLowerCase().includes(q) ||
    String(item?.name ?? "").toLowerCase().includes(q)
  );
}

/**
 * Filtre Mode (UI seulement) : compare le mode réellement retenu/affiché par la
 * ligne (SAFE / BALANCED / AGGRESSIVE). Ne participe jamais au pool du moteur.
 */
export function rowMatchesModeFilter(item, modeFilter) {
  if (!modeFilter || modeFilter === "all") return true;
  return resolveDashboardModeForFilter(item) === modeFilter;
}

/**
 * Pool canonique transmis à buildPortfolioCombos.
 * Seul filtre appliqué : l'expiration sélectionnée (règle métier).
 * Retourne toujours un nouveau tableau (ordre source préservé).
 */
export function buildComboCandidatePool(enrichedCandidates, { selectedExpiration = null } = {}) {
  const rows = Array.isArray(enrichedCandidates) ? enrichedCandidates : [];
  return rows.filter((item) => candidateRowMatchesSelectedExpiration(item, selectedExpiration));
}

/**
 * Lignes visibles du tableau : recherche + filtre Mode UI + tri, appliqués sur
 * le pool canonique. `getSpreadPct` est injecté par le dashboard (getSafeSpreadPct)
 * pour le tri « spread » sans importer de code JSX ici.
 */
export function buildVisibleTableRows(
  comboCandidateRows,
  {
    query = "",
    modeFilter = "all",
    sortBy = "quality",
    sortOrder = "desc",
    dataSource = "snapshot",
    getSpreadPct = null,
  } = {}
) {
  const rows = Array.isArray(comboCandidateRows) ? comboCandidateRows : [];
  const filteredItems = rows.filter(
    (item) => rowMatchesSearchQuery(item, query) && rowMatchesModeFilter(item, modeFilter)
  );

  // ibkr_direct : ordre de base ibkrRank (tie-breaker stable pour valeurs de tri égales)
  let baseItems;
  if (dataSource === "ibkr_direct") {
    const hasBackendIbkrOrder = filteredItems.every((item) => Number.isFinite(Number(item?.ibkrRank)));
    const ibkrFallbackScore = (item) =>
      Number(item?.ibkrEliteScore ?? item?.eliteScore ?? item?.actionabilityScore ?? item?.score ?? Number.NEGATIVE_INFINITY);
    baseItems = hasBackendIbkrOrder
      ? filteredItems.slice()
      : filteredItems.slice().sort((a, b) => ibkrFallbackScore(b) - ibkrFallbackScore(a));
  } else {
    baseItems = filteredItems.slice();
  }

  const spreadOf = typeof getSpreadPct === "function" ? getSpreadPct : () => null;
  const getSortValue = (item) => {
    if (sortBy === "quality")
      return Number(item.qualityScore ?? item.eliteScore ?? Number.NEGATIVE_INFINITY);
    if (sortBy === "weeklyReturn") return Number(item.weeklyReturn ?? 0);
    if (sortBy === "spread") {
      const spread = spreadOf(item);
      return spread ?? Number.POSITIVE_INFINITY;
    }
    return Number(item.strikeDistance ?? 0);
  };

  return baseItems.sort((a, b) => {
    if (sortBy === "spread") {
      const aSpread = spreadOf(a);
      const bSpread = spreadOf(b);
      const aMissing = aSpread == null;
      const bMissing = bSpread == null;
      if (aMissing && bMissing) return Number(a.ibkrRank ?? a.rank ?? 0) - Number(b.ibkrRank ?? b.rank ?? 0);
      if (aMissing) return 1;
      if (bMissing) return -1;
    }
    const aValue = getSortValue(a);
    const bValue = getSortValue(b);
    if (aValue === bValue) return Number(a.ibkrRank ?? a.rank ?? 0) - Number(b.ibkrRank ?? b.rank ?? 0);
    return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
  });
}
