/**
 * Capital Combo Optimizer V2 — helpers purement fonctionnels (hors lifecycle React).
 * Ne touche pas au scanner, backend ni IPC. Réversible via flags + stockage optionnel localStorage.
 */

export const CAPITAL_COMBO_OPTIMIZER_DEFAULTS = Object.freeze({
  /** Passe leftover « densité / petits contrats » après filler (BALANCED + AGGRESSIVE seulement). */
  leftoverDensityPassEnabled: true,
  /** Jamais SAFE par défaut (stabilité). localStorage peut activer explicitement. */
  safeLeftoverDensityPassEnabled: false,
  /** Diagnostics enrichis attachés aux objets combo (capDiagnosticsV2). */
  capDiagnosticsEnabled: true,
  maxLeftoverIterations: 22,
  /** Seuil leftover vs capital utilisable avant de tenter une passe densité additionnelle. */
  leftoverMinPctOfUsable: 0.012,
  /** Plancher absolu ($) même portefeuille modeste. */
  leftoverMinAbsoluteUsd: 320,
});

const LS_KEY_V2_FLAGS = "wheelCapitalComboOptimizerV2Flags";

/** Flags runtime : défaut sécuritaire + surcharge JSON léger depuis localStorage. */
export function getCapitalOptimizerV2Flags() {
  let extra = {};
  if (typeof globalThis !== "undefined" && typeof globalThis.localStorage?.getItem === "function") {
    try {
      const raw = globalThis.localStorage.getItem(LS_KEY_V2_FLAGS);
      extra = raw ? JSON.parse(raw) : {};
    } catch (_) {
      extra = {};
    }
  }
  return { ...CAPITAL_COMBO_OPTIMIZER_DEFAULTS, ...extra };
}

export function mergeRejectionDiagnostics(target, rejectionMap) {
  if (!(target instanceof Map)) return target;
  if (!rejectionMap) return target;
  for (const [k, v] of rejectionMap.entries()) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    target.set(k, (target.get(k) ?? 0) + n);
  }
  return target;
}

/** Prime $ / dollar de capital garanti pour prioriser leftover (sans changer le scorer principal). */
export function premiumYieldPerCollateralDollar(candidate) {
  const cap = Number(candidate?.capitalPerContract);
  const prem = Number(candidate?.premiumPerContract);
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  if (!Number.isFinite(prem) || prem < 0) return 0;
  return prem / cap;
}

export function premiumDensityScore(candidate) {
  const y = Number(candidate?.weeklyReturn ?? candidate?.selectedYieldPct);
  const base = premiumYieldPerCollateralDollar(candidate);
  const yieldBump = Number.isFinite(y) && y > 0 ? Math.sqrt(y) : 1;
  return base * yieldBump;
}

/** Seuil leftover : utile tant qu'il reste assez de capital pour peut-être glisser un contrat marginal. */
export function computeLeftoverActionThresholdUsd(usableCapital, scoredPoolMinContract, overrides = {}) {
  const pct = overrides.leftoverMinPctOfUsable ?? CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinPctOfUsable;
  const floor = overrides.leftoverMinAbsoluteUsd ?? CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinAbsoluteUsd;
  const dyn = Number.isFinite(Number(scoredPoolMinContract))
    ? Math.max(240, scoredPoolMinContract * 0.28)
    : floor;
  return Math.max(usableCapital * pct, floor, dyn);
}

export function formatCapBlockerReason(reason) {
  const m = {
    ticker_cap_reached: "cap ticker — position déjà forte ou diversification priorisée max contrats ticker",
    theme_cap_reached: "cap thème — exposition thématique plafonnée pour ce sous-groupe",
    sector_cap_reached: "cap secteur — exposition sectorielle plafonnée",
    high_beta_cap_reached: "cap high beta — thème croissance forte / beta déjà max",
    max_positions_limit: "limite nombre de lignes distinctes du portefeuille",
    contract_size_too_large: "capital restant trop petit pour ce contrat (taille garantie CSP)",
    no_clean_incremental_candidate: "aucune marge incremental propre après garde-fous diversification",
    caps_too_strict: "composition / garde-fous (crypto-miner ou spéculatif) bloque l’ajout",
    not_enough_candidates: "pool admissible épuisé ou vide",
    min_yield_or_execution_filter: "filtre rendement bucket ou execution score hors plage",
  };
  return m[reason] ?? `cause opérationnelle (${reason ?? "?"})`;
}

/** Tri pour la passe leftover : forte densité puis petits garanties pour combler trous. */
export function compareLeftoverDensityOrder(a, b) {
  const da = premiumDensityScore(a);
  const db = premiumDensityScore(b);
  const diff = db - da;
  if (Math.abs(diff) > 1e-9) return diff;
  const ca = Number(a?.capitalPerContract);
  const cb = Number(b?.capitalPerContract);
  if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
  return (Number(b?.allocScore) || 0) - (Number(a?.allocScore) || 0);
}

/**
 * Après coup : meilleurs ticker hors picks avec première raison d’échec evaluate(strict).
 */
export function buildNextBestResidualRows(scoredPoolSorted, pickMap, evaluateCandidateStrict, opts = {}) {
  const lim = opts.limit ?? 28;
  const rows = [];
  for (const c of scoredPoolSorted) {
    if (!c?.ticker) continue;
    if (pickMap.has(c.ticker)) continue;
    const ev = evaluateCandidateStrict(c);
    if (ev.ok) continue;
    rows.push({
      ticker: c.ticker,
      allocScore: c.allocScore ?? null,
      capitalPerContract: c.capitalPerContract ?? null,
      premiumPerContract: c.premiumPerContract ?? null,
      wedgeDensity: premiumDensityScore(c),
      primaryBlocker: ev.reason ?? "caps_too_strict",
    });
    if (rows.length >= lim) break;
  }
  return rows;
}

export function summarizeBlockerHits(rejectionTotalsMap, residualRows) {
  const fromLoop = rejectionTotalsMap instanceof Map
    ? [...rejectionTotalsMap.entries()].map(([reason, count]) => ({
        reason,
        count,
        source: "greedy_cycles",
      }))
    : [];
  const fromResidual = new Map();
  for (const row of residualRows || []) {
    const r = row.primaryBlocker;
    fromResidual.set(r, (fromResidual.get(r) ?? 0) + 1);
  }
  const merged = [...fromLoop];
  for (const [reason, count] of fromResidual) {
    merged.push({ reason, count, source: "final_residual_explainer" });
  }
  merged.sort((a, b) => (b.count || 0) - (a.count || 0));
  return merged;
}
