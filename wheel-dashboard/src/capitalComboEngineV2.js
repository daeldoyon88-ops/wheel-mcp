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
    not_selected_greedy_lower_marginalScore:
      "score marginal inférieur au meilleur candidat de la passe greedy",
  };
  return m[reason] ?? `cause opérationnelle (${reason ?? "?"})`;
}

/** Codes canoniques exposés pour le diagnostic terminal du capital non utilisé. */
export const UNUSED_CAPITAL_TERMINAL_CODES = Object.freeze({
  NO_REMAINING_SCORED_CANDIDATE: "NO_REMAINING_SCORED_CANDIDATE",
  ALL_REMAINING_CONTRACTS_TOO_LARGE: "ALL_REMAINING_CONTRACTS_TOO_LARGE",
  TICKER_CAP_REACHED: "TICKER_CAP_REACHED",
  SECTOR_CAP_REACHED: "SECTOR_CAP_REACHED",
  THEME_CAP_REACHED: "THEME_CAP_REACHED",
  HIGH_BETA_CAP_REACHED: "HIGH_BETA_CAP_REACHED",
  MAX_POSITIONS_REACHED: "MAX_POSITIONS_REACHED",
  CONCENTRATION_LIMIT: "CONCENTRATION_LIMIT",
  NO_BUCKET_ELIGIBLE_CANDIDATE: "NO_BUCKET_ELIGIBLE_CANDIDATE",
  MIXED_ALLOCATION_CONSTRAINTS: "MIXED_ALLOCATION_CONSTRAINTS",
});

const GREEDY_BLOCKER_TO_FINAL_REASON = Object.freeze({
  contract_size_too_large: "CONTRACT_SIZE_TOO_LARGE",
  ticker_cap_reached: "TICKER_CAP_REACHED",
  theme_cap_reached: "THEME_CAP_REACHED",
  sector_cap_reached: "SECTOR_CAP_REACHED",
  high_beta_cap_reached: "HIGH_BETA_CAP_REACHED",
  max_positions_limit: "MAX_POSITIONS_REACHED",
  caps_too_strict: "CONCENTRATION_LIMIT",
  no_clean_incremental_candidate: "CONCENTRATION_LIMIT",
  not_selected_greedy_lower_marginalScore: "NON_SELECTED_LOWER_MARGINAL_SCORE",
});

const TERMINAL_CODE_TO_LEGACY_SHORTFALL = Object.freeze({
  NO_REMAINING_SCORED_CANDIDATE: "not_enough_candidates",
  ALL_REMAINING_CONTRACTS_TOO_LARGE: "contract_size_too_large",
  TICKER_CAP_REACHED: "ticker_cap_reached",
  SECTOR_CAP_REACHED: "sector_cap_reached",
  THEME_CAP_REACHED: "theme_cap_reached",
  HIGH_BETA_CAP_REACHED: "high_beta_cap_reached",
  MAX_POSITIONS_REACHED: "max_positions_limit",
  CONCENTRATION_LIMIT: "caps_too_strict",
  NO_BUCKET_ELIGIBLE_CANDIDATE: "not_enough_candidates",
  MIXED_ALLOCATION_CONSTRAINTS: "caps_too_strict",
});

function moneyUsd(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function resolveFinalAllocationReason(rejectionReason, canAfford, capitalRequired, freeCapital) {
  if (!canAfford || rejectionReason === "contract_size_too_large") {
    const gap =
      Number.isFinite(capitalRequired) && Number.isFinite(freeCapital)
        ? Math.max(0, capitalRequired - freeCapital)
        : null;
    return {
      allocationDecision: "rejected_greedy_contract_too_large",
      allocationBlocker: "contract_size_too_large",
      finalAllocationReason: "CONTRACT_SIZE_TOO_LARGE",
      capitalGapUsd: gap,
    };
  }
  if (rejectionReason === "not_selected_greedy_lower_marginalScore") {
    return {
      allocationDecision: "in_pool_lower_marginal_score",
      allocationBlocker: null,
      finalAllocationReason: "NON_SELECTED_LOWER_MARGINAL_SCORE",
      capitalGapUsd: null,
    };
  }
  return {
    allocationDecision: "in_pool_rejected_terminal_constraint",
    allocationBlocker: rejectionReason ?? "caps_too_strict",
    finalAllocationReason:
      GREEDY_BLOCKER_TO_FINAL_REASON[rejectionReason] ??
      String(rejectionReason ?? "UNKNOWN").toUpperCase(),
    capitalGapUsd: null,
  };
}

function summarizePrePoolRejections(rejectedBeforeAllocation, { minPeriodYieldPct = null, modeLabel = null } = {}) {
  const rows = Array.isArray(rejectedBeforeAllocation) ? rejectedBeforeAllocation : [];
  const byBlocker = new Map();
  for (const row of rows) {
    const blocker = row?.primaryBlocker ?? "UNKNOWN";
    if (!byBlocker.has(blocker)) byBlocker.set(blocker, []);
    byBlocker.get(blocker).push(row);
  }
  const yieldBelow = byBlocker.get("PERIOD_YIELD_BELOW_BUCKET_MIN") ?? [];
  const noteFr =
    yieldBelow.length > 0
      ? `Les petits contrats visibles ${yieldBelow.map((r) => r.ticker).join(", ")} ont été rejetés avant l'allocation parce que leur rendement jusqu'à expiration était inférieur au minimum${modeLabel ? ` ${modeLabel}` : ""} de ${Number.isFinite(Number(minPeriodYieldPct)) ? `${Number(minPeriodYieldPct).toFixed(2)} %` : "bucket"}.`
      : null;
  return {
    totalCount: rows.length,
    byBlocker: Object.fromEntries(
      [...byBlocker.entries()].map(([blocker, list]) => [blocker, list.map((r) => r.ticker)]),
    ),
    periodYieldBelowBucketMin: yieldBelow.map((r) => ({
      ticker: r.ticker,
      periodYieldPct: r.periodYieldPct ?? null,
      minPeriodYieldPct: r.minPeriodYieldPct ?? minPeriodYieldPct ?? null,
    })),
    noteFr,
  };
}

/**
 * Diagnostic terminal du capital non utilisé — lecture seule, déterministe.
 * Ne modifie jamais l'allocation.
 */
export function buildTerminalUnusedCapitalDiagnostic({
  freeCapitalUsd,
  usableCapitalUsd,
  usedCapitalUsd,
  scoredPool,
  pickMap,
  evaluateCandidateStrict,
  picksCount = 0,
  maxPositionLines = 0,
  rejectedBeforeAllocation = [],
  modeLabel = null,
  minPeriodYieldPct = null,
  usedPct = 0,
  targetMinPct = 90,
} = {}) {
  const freeCapital = moneyUsd(freeCapitalUsd);
  const prePoolSummary = summarizePrePoolRejections(rejectedBeforeAllocation, {
    minPeriodYieldPct,
    modeLabel,
  });
  const remaining = (scoredPool || []).filter((c) => c?.ticker && !pickMap?.has(c.ticker));
  const remainingTickers = remaining.map((c) => c.ticker);
  const remainingCollateral = remaining
    .map((c) => Number(c.capitalPerContract))
    .filter((n) => Number.isFinite(n) && n > 0);

  const blockerTally = {
    contract_size_too_large: 0,
    ticker_cap_reached: 0,
    theme_cap_reached: 0,
    sector_cap_reached: 0,
    high_beta_cap_reached: 0,
    max_positions_limit: 0,
    not_selected_greedy_lower_marginalScore: 0,
    other: 0,
  };
  let affordableCount = 0;

  for (const candidate of remaining) {
    const capReq = Number(candidate.capitalPerContract);
    const canAfford = Number.isFinite(capReq) && capReq > 0 && capReq <= freeCapital + 1e-6;
    const ev = typeof evaluateCandidateStrict === "function"
      ? evaluateCandidateStrict(candidate)
      : { ok: false, reason: "caps_too_strict" };
    const reason = ev.ok ? "not_selected_greedy_lower_marginalScore" : (ev.reason ?? "caps_too_strict");

    if (canAfford && reason !== "contract_size_too_large") {
      affordableCount += 1;
    }

    if (reason === "contract_size_too_large" || !canAfford) {
      blockerTally.contract_size_too_large += 1;
    } else if (reason in blockerTally) {
      blockerTally[reason] += 1;
    } else {
      blockerTally.other += 1;
    }
  }

  const capOnlyBlockers = [
    ["sector_cap_reached", UNUSED_CAPITAL_TERMINAL_CODES.SECTOR_CAP_REACHED],
    ["theme_cap_reached", UNUSED_CAPITAL_TERMINAL_CODES.THEME_CAP_REACHED],
    ["high_beta_cap_reached", UNUSED_CAPITAL_TERMINAL_CODES.HIGH_BETA_CAP_REACHED],
    ["ticker_cap_reached", UNUSED_CAPITAL_TERMINAL_CODES.TICKER_CAP_REACHED],
    ["max_positions_limit", UNUSED_CAPITAL_TERMINAL_CODES.MAX_POSITIONS_REACHED],
  ];
  const activeCapBlockers = capOnlyBlockers.filter(([legacy]) => (blockerTally[legacy] ?? 0) > 0);
  const tooLargeOnly =
    remaining.length > 0 &&
    affordableCount === 0 &&
    blockerTally.contract_size_too_large === remaining.length;

  let terminalReasonCode = null;
  if (usedPct >= targetMinPct || freeCapital <= 0.01) {
    terminalReasonCode = null;
  } else if (!scoredPool?.length) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.NO_BUCKET_ELIGIBLE_CANDIDATE;
  } else if (picksCount >= maxPositionLines && freeCapital > 0.01) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.MAX_POSITIONS_REACHED;
  } else if (
    !remaining.length &&
    freeCapital > 0.01 &&
    picksCount > 0 &&
    (scoredPool?.length ?? 0) > 0
  ) {
    // Tous les candidats du scoredPool ont été sélectionnés ; reliquat sans autre admissible.
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE;
  } else if (!remaining.length) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.NO_REMAINING_SCORED_CANDIDATE;
  } else if (tooLargeOnly) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE;
  } else if (activeCapBlockers.length === 1 && blockerTally.contract_size_too_large === 0) {
    terminalReasonCode = activeCapBlockers[0][1];
  } else if (activeCapBlockers.length > 0 && blockerTally.contract_size_too_large > 0) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.MIXED_ALLOCATION_CONSTRAINTS;
  } else if (activeCapBlockers.length > 1) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.MIXED_ALLOCATION_CONSTRAINTS;
  } else if (blockerTally.contract_size_too_large > 0 && affordableCount === 0) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE;
  } else if (blockerTally.not_selected_greedy_lower_marginalScore > 0) {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.NO_REMAINING_SCORED_CANDIDATE;
  } else {
    terminalReasonCode = UNUSED_CAPITAL_TERMINAL_CODES.MIXED_ALLOCATION_CONSTRAINTS;
  }

  const legacyShortfallReason = terminalReasonCode
    ? (TERMINAL_CODE_TO_LEGACY_SHORTFALL[terminalReasonCode] ?? "caps_too_strict")
    : null;

  const minRemainingCollateral =
    remainingCollateral.length > 0 ? Math.min(...remainingCollateral) : null;

  let messageFr = null;
  if (terminalReasonCode && freeCapital > 0.01) {
    const freeTxt = `${freeCapital.toFixed(0)} $`;
    if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE) {
      messageFr = `Capital restant : ${freeTxt}. Aucun contrat encore admissible dans le scoredPool ne coûte ${freeCapital.toFixed(0)} $ ou moins.`;
      if (prePoolSummary.noteFr) messageFr += ` ${prePoolSummary.noteFr}`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.SECTOR_CAP_REACHED) {
      messageFr = `Capital restant : ${freeTxt}. Des contrats sont finançables, mais la limite de secteur empêche leur ajout.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.THEME_CAP_REACHED) {
      messageFr = `Capital restant : ${freeTxt}. Des contrats sont finançables, mais la limite de thème empêche leur ajout.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.HIGH_BETA_CAP_REACHED) {
      messageFr = `Capital restant : ${freeTxt}. Des contrats sont finançables, mais la limite du thème high-beta est atteinte.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.TICKER_CAP_REACHED) {
      messageFr = `Capital restant : ${freeTxt}. Des contrats sont finançables, mais le cap ticker empêche leur ajout.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.MAX_POSITIONS_REACHED) {
      messageFr = `Capital restant : ${freeTxt}. Le nombre maximal de positions est atteint.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.NO_BUCKET_ELIGIBLE_CANDIDATE) {
      messageFr = `Capital restant : ${freeTxt}. Aucun autre candidat ne respecte les règles du bucket${modeLabel ? ` ${modeLabel}` : ""}.`;
      if (prePoolSummary.noteFr) messageFr += ` ${prePoolSummary.noteFr}`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.MIXED_ALLOCATION_CONSTRAINTS) {
      messageFr = `Capital restant : ${freeTxt}. Aucun ajout possible : contrats trop grands et/ou contraintes de concentration.`;
    } else if (terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.NO_REMAINING_SCORED_CANDIDATE) {
      messageFr = `Capital restant : ${freeTxt}. Aucun autre candidat admissible ne reste dans le scoredPool.`;
    }
    if (messageFr && remainingTickers.length > 0 && terminalReasonCode === UNUSED_CAPITAL_TERMINAL_CODES.ALL_REMAINING_CONTRACTS_TOO_LARGE) {
      messageFr += ` Contrats encore présents : ${remainingTickers.join(", ")}${minRemainingCollateral != null ? ` (min. ${minRemainingCollateral.toFixed(0)} $)` : ""}.`;
    }
  }

  return {
    terminalReasonCode,
    legacyShortfallReason,
    messageFr,
    freeCapitalUsd: freeCapital,
    usableCapitalUsd: moneyUsd(usableCapitalUsd),
    usedCapitalUsd: moneyUsd(usedCapitalUsd),
    remainingScoredPoolCount: remaining.length,
    remainingScoredPoolTickers: remainingTickers,
    minRemainingContractCollateralUsd: minRemainingCollateral,
    affordableRemainingCount: affordableCount,
    blockerTally,
    prePoolRejections: prePoolSummary,
  };
}

/**
 * Statut inspecteur pour un candidat non sélectionné — n'affirme jamais
 * l'appartenance au scoredPool moteur sans preuve (capDiagnosticsV2).
 * Corrige l'étiquette « dans scoredPool — non retenu greedy » attribuée à tort
 * aux candidats absents du scoredPool moteur (incohérence avec le message
 * « capital restant insuffisant pour le prochain contrat admissible »).
 */
export function resolveInspectorNotSelectedStatus({
  diagnosticsAvailable,
  inEngineScoredPool,
  greedyRejectionReason,
  residualBlocker,
} = {}) {
  if (!diagnosticsAvailable) {
    return {
      statusProbable: "statut moteur inconnu — non sélectionné",
      raisonProbable:
        "diagnostics moteur indisponibles (capDiagnosticsV2 désactivé) — appartenance au scoredPool non confirmée : caps diversification, ordre de tri, ou capital restant",
      allocationDecision: "unknown_engine_diagnostics_unavailable",
      allocationBlocker: null,
    };
  }
  if (!inEngineScoredPool) {
    return {
      statusProbable: "hors scoredPool moteur — écarté avant allocation",
      raisonProbable:
        "absent du scoredPool moteur : jambe bucket écartée avant l'allocation (bande rendement expiration, grade, spread, executionScore ou filtre qualité) — le miroir inspecteur peut diverger de la jambe moteur ; le message « capital restant insuffisant » ne porte que sur les candidats réellement admis au scoredPool",
      allocationDecision: "not_in_engine_scored_pool",
      allocationBlocker: residualBlocker ?? null,
    };
  }
  if (greedyRejectionReason && greedyRejectionReason !== "not_selected_greedy_lower_marginalScore") {
    return {
      statusProbable: `dans scoredPool — non retenu : ${greedyRejectionReason}`,
      raisonProbable: `présent dans scoredPool — non retenu : ${greedyRejectionReason} (${formatCapBlockerReason(greedyRejectionReason)})`,
      allocationDecision: "in_pool_rejected_terminal_constraint",
      allocationBlocker: greedyRejectionReason,
    };
  }
  return {
    statusProbable: "dans scoredPool — non retenu greedy",
    raisonProbable:
      "présent dans scoredPool — non retenu : marginalScore inférieur au meilleur candidat de la passe",
    allocationDecision: "in_pool_lower_marginal_score",
    allocationBlocker: null,
  };
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
  const sweepIndexByTicker = ctx.candidateSweepIndexByTicker ?? {};
  const lastEvaluatedPhase = ctx.lastEvaluatedPhase ?? "post_allocation_residual";

  const rows = [];
  let evaluatedOrder = 0;
  for (const c of scoredPool || []) {
    const tk = String(c?.ticker ?? "").trim();
    if (!tk || pickMap?.has(c.ticker)) continue;
    evaluatedOrder += 1;

    const capReq = Number(c.capitalPerContract);
    const canAfford =
      Number.isFinite(capReq) && capReq > 0 && capReq <= freeCapital + 1e-6;

    const evStrict = evaluateCandidateStrict(c);
    const rejectionReason = evStrict.ok
      ? "not_selected_greedy_lower_marginalScore"
      : (evStrict.reason ?? "caps_too_strict");
    const resolved = resolveFinalAllocationReason(
      rejectionReason,
      canAfford,
      capReq,
      freeCapital,
    );

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
      evaluatedOrder,
      evaluatedSweepIndex: sweepIndexByTicker[tk] ?? sweepIndexByTicker[c.ticker] ?? null,
      lastEvaluatedPhase,
      allocationDecision: resolved.allocationDecision,
      allocationBlocker: resolved.allocationBlocker,
      finalAllocationReason: resolved.finalAllocationReason,
      capitalGapUsd: resolved.capitalGapUsd,
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
