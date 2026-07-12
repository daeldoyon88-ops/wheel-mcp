/**
 * Capital Combo Optimizer V2 — helpers purement fonctionnels (hors lifecycle React).
 * AF-18 : parsing strict des flags ; lecture localStorage réservée à la couche runtime (dashboard).
 */

export const CAPITAL_COMBO_OPTIMIZER_DEFAULTS = Object.freeze({
  /** Passe leftover « densité / petits contrats » après filler (BALANCED + AGGRESSIVE seulement). */
  leftoverDensityPassEnabled: true,
  /** Jamais SAFE par défaut (stabilité). Peut être activé explicitement via config persistée. */
  safeLeftoverDensityPassEnabled: false,
  /** Diagnostics enrichis attachés aux objets combo (capDiagnosticsV2). */
  capDiagnosticsEnabled: true,
  maxLeftoverIterations: 22,
  /** Seuil leftover vs capital utilisable avant de tenter une passe densité additionnelle. */
  leftoverMinPctOfUsable: 0.012,
  /** Plancher absolu ($) même portefeuille modeste. */
  leftoverMinAbsoluteUsd: 320,
});

/** Clé localStorage — lecture runtime uniquement (dashboard). */
export const CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY = "wheelCapitalComboOptimizerV2Flags";

/** @deprecated Alias historique — préférer CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY */
const LS_KEY_V2_FLAGS = CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY;

/** Schéma des 6 flags connus (types + bornes conservatrices). */
export const CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA = Object.freeze({
  leftoverDensityPassEnabled: { type: "boolean" },
  safeLeftoverDensityPassEnabled: { type: "boolean" },
  capDiagnosticsEnabled: { type: "boolean" },
  maxLeftoverIterations: { type: "number", min: 1, max: 100, integer: true },
  leftoverMinPctOfUsable: { type: "number", min: 0, max: 1 },
  leftoverMinAbsoluteUsd: { type: "number", min: 0, max: 1_000_000 },
});

const KNOWN_FLAG_KEYS = Object.keys(CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA);

/**
 * Normalise une valeur booléenne stricte (trim + casse pour chaînes).
 * true | "true" | 1 | "1" → true ; false | "false" | 0 | "0" → false ; sinon défaut.
 * @param {unknown} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
export function normalizeCapitalOptimizerV2Boolean(value, defaultValue) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return defaultValue;
}

/**
 * Normalise un nombre fini dans [min, max] ; sinon défaut.
 * @param {unknown} value
 * @param {number} defaultValue
 * @param {{ min?: number, max?: number, integer?: boolean }} bounds
 * @returns {number}
 */
export function normalizeCapitalOptimizerV2Number(value, defaultValue, bounds = {}) {
  const { min = -Infinity, max = Infinity, integer = false } = bounds;
  let n;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const t = value.trim();
    if (t === "") return defaultValue;
    n = Number(t);
  } else {
    return defaultValue;
  }
  if (!Number.isFinite(n) || n < min || n > max) return defaultValue;
  return integer ? Math.floor(n) : n;
}

/**
 * Resolver pur — normalise un objet partiel vers la config effective.
 * N'accepte que les clés connues ; ignore le reste ; ne mute jamais l'input.
 * @param {Record<string, unknown>|null|undefined} rawFlags
 * @returns {Readonly<typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS>}
 */
export function normalizeCapitalOptimizerV2Flags(rawFlags) {
  const out = {
    leftoverDensityPassEnabled: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverDensityPassEnabled,
    safeLeftoverDensityPassEnabled: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.safeLeftoverDensityPassEnabled,
    capDiagnosticsEnabled: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.capDiagnosticsEnabled,
    maxLeftoverIterations: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.maxLeftoverIterations,
    leftoverMinPctOfUsable: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinPctOfUsable,
    leftoverMinAbsoluteUsd: CAPITAL_COMBO_OPTIMIZER_DEFAULTS.leftoverMinAbsoluteUsd,
  };

  if (rawFlags == null || typeof rawFlags !== "object" || Array.isArray(rawFlags)) {
    return Object.freeze(out);
  }

  for (const key of KNOWN_FLAG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rawFlags, key)) continue;
    const schema = CAPITAL_COMBO_OPTIMIZER_FLAG_SCHEMA[key];
    const def = CAPITAL_COMBO_OPTIMIZER_DEFAULTS[key];
    const raw = rawFlags[key];
    if (schema.type === "boolean") {
      out[key] = normalizeCapitalOptimizerV2Boolean(raw, def);
    } else if (schema.type === "number") {
      out[key] = normalizeCapitalOptimizerV2Number(raw, def, {
        min: schema.min,
        max: schema.max,
        integer: schema.integer === true,
      });
    }
  }

  return Object.freeze(out);
}

/**
 * Résolution moteur pure — priorité options explicites, sinon defaults.
 * Objet vide `{}` → defaults ; ne lit jamais localStorage.
 * @param {Record<string, unknown>|null|undefined} overrideFlags
 * @returns {Readonly<typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS>}
 */
export function resolveCapitalOptimizerV2Flags(overrideFlags) {
  if (overrideFlags != null && typeof overrideFlags === "object" && !Array.isArray(overrideFlags)) {
    return normalizeCapitalOptimizerV2Flags(overrideFlags);
  }
  return normalizeCapitalOptimizerV2Flags(undefined);
}

/**
 * Parse une chaîne JSON localStorage → config normalisée.
 * JSON invalide ou non-objet → defaults.
 * @param {string|null|undefined} rawString
 * @returns {Readonly<typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS>}
 */
export function parseCapitalOptimizerV2FlagsFromJson(rawString) {
  if (rawString == null || rawString === "") {
    return normalizeCapitalOptimizerV2Flags(undefined);
  }
  try {
    const parsed = JSON.parse(rawString);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return normalizeCapitalOptimizerV2Flags(undefined);
    }
    return normalizeCapitalOptimizerV2Flags(parsed);
  } catch (_) {
    return normalizeCapitalOptimizerV2Flags(undefined);
  }
}

/**
 * Lecture runtime localStorage (dashboard / navigateur).
 * Fonction explicitement couplée au stockage navigateur — pas pour le moteur pur.
 * @param {Storage|null|undefined} [storage]
 * @returns {Readonly<typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS>}
 */
export function readCapitalOptimizerV2FlagsFromLocalStorage(storage) {
  let ls = storage ?? null;
  if (ls == null) {
    try {
      if (typeof globalThis !== "undefined" && globalThis.localStorage?.getItem) {
        ls = globalThis.localStorage;
      }
    } catch (_) {
      ls = null;
    }
  }
  if (!ls || typeof ls.getItem !== "function") {
    return normalizeCapitalOptimizerV2Flags(undefined);
  }
  try {
    const raw = ls.getItem(LS_KEY_V2_FLAGS);
    return parseCapitalOptimizerV2FlagsFromJson(raw);
  } catch (_) {
    return normalizeCapitalOptimizerV2Flags(undefined);
  }
}

/**
 * @deprecated Préférer readCapitalOptimizerV2FlagsFromLocalStorage — alias runtime conservé.
 * @returns {Readonly<typeof CAPITAL_COMBO_OPTIMIZER_DEFAULTS>}
 */
export function getCapitalOptimizerV2Flags() {
  return readCapitalOptimizerV2FlagsFromLocalStorage();
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
 * Diagnostic greedy pour chaque ticker du scoredPool non retenu dans les picks finaux.
 * Lecture seule — ne modifie pas l’allocateur.
 */
export function buildScoredPoolNotSelectedDiagnostics(
  scoredPool,
  pickMap,
  evaluateCandidateStrict,
  ctx = {},
) {
  const bucket = ctx.modeLabel ?? null;
  const usedCapital = Number(ctx.usedCapital ?? 0);
  const usableCapital = Number(ctx.usableCapital ?? 0);
  const freeCapital = Math.max(0, usableCapital - usedCapital);
  const maxPositionLines = Number(ctx.maxPositionLines ?? 0);
  const distinctPositions = pickMap instanceof Map ? pickMap.size : 0;

  const rows = [];
  for (const c of scoredPool || []) {
    const tk = String(c?.ticker ?? "").trim();
    if (!tk || pickMap?.has(c.ticker)) continue;

    const capReq = Number(c.capitalPerContract);
    const canAfford =
      Number.isFinite(capReq) && capReq > 0 && usedCapital + capReq <= usableCapital + 1e-6;

    const evStrict = evaluateCandidateStrict(c);
    const rejectionReason = evStrict.ok
      ? "not_selected_greedy_lower_marginalScore"
      : (evStrict.reason ?? "caps_too_strict");

    rows.push({
      ticker: c.ticker,
      bucket,
      score: c.allocScore ?? c._comboScoreBreakdown?.totalScore ?? null,
      capitalRequired: Number.isFinite(capReq) ? capReq : null,
      selectedLeg:
        c.selectedStrikeValue ??
        c.selectedLeg?.strike ??
        c.selectedStrike?.strike ??
        null,
      canAfford,
      tickerCapOk: rejectionReason !== "ticker_cap_reached",
      sectorCapOk: rejectionReason !== "sector_cap_reached",
      themeCapOk: rejectionReason !== "theme_cap_reached",
      highBetaCapOk: rejectionReason !== "high_beta_cap_reached",
      maxPositionsOk: rejectionReason !== "max_positions_limit",
      rejectionReason,
      passedGreedyEvaluate: !!evStrict.ok,
      marginalScore: evStrict.ok ? (evStrict.marginalScore ?? null) : null,
      distinctPositionsAtDecision: distinctPositions,
      freeCapitalAtDecision: freeCapital,
      maxPositionsLimit: maxPositionLines,
    });
  }
  return rows;
}

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
