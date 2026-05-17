/**
 * Support Scoring V2 — évaluation du strike avec supportNear en DTE court,
 * tout en gardant une garde conservatrice sur cassure structurelle (min wide/near).
 * Pure, aucun IO.
 */
import { round, toNumber } from "../utils/number.js";

/** Alignement wheelScanner / supportDiagnostics V1 (> 2 % = au-dessus du support). */
const STRIKE_ABOVE_SUPPORT_PCT = 2;

export const SUPPORT_SCORING_V2_ENABLED = true;

export const SUPPORT_SCORING_V2_SHORT_DTE_MAX = 7;

export function qualitySupportDeltaForStatus(statusRaw) {
  const s = String(statusRaw ?? "").trim();
  switch (s) {
    case "current_below_support":
      return -35;
    case "strike_above_support":
    case "room_above_support":
      return -12;
    case "strike_near_support":
    case "near_support":
      return 2;
    case "strike_below_support":
    case "below_support":
      return 8;
    default:
      return 0;
  }
}

export function canonSupportStatus(statusRaw) {
  const s = String(statusRaw ?? "").trim();
  if (s === "below_support") return "strike_below_support";
  if (s === "near_support") return "strike_near_support";
  if (s === "room_above_support") return "strike_above_support";
  return s;
}

function pctPriceVsLevel(price, level) {
  const p = toNumber(price);
  const s = toNumber(level);
  if (!(Number.isFinite(p) && p > 0 && s > 0)) return null;
  return ((p - s) / s) * 100;
}

/**
 * Strike seul vs niveau évaluatif (sans recheck spot vs ce niveau quand la garde structurelle a passé).
 */
function classifyStrikeAgainstLevel(strike, supportLevel) {
  const stk = toNumber(strike);
  const s = toNumber(supportLevel);
  if (!(Number.isFinite(stk) && stk > 0 && s > 0)) return "unknown";
  const strikeVsPct = ((stk - s) / s) * 100;
  if (strikeVsPct > STRIKE_ABOVE_SUPPORT_PCT) return "strike_above_support";
  if (strikeVsPct >= 0) return "strike_near_support";
  return "strike_below_support";
}

function computeNotes({
  structuralLevel,
  spotBreakSupportLevelUsed,
  strikeSupportLevelUsed,
  supportWideNum,
  supportNearNum,
  dteDays,
}) {
  const notes = [];
  notes.push(
    `Garde structurelle: niveau utilisé (${spotBreakSupportLevelUsed})${
      structuralLevel != null ? ` = ${round(structuralLevel, 4)}` : ""
    } (min prudent wide/near lorsque les deux sont présents).`
  );
  notes.push(
    `Évaluation strike: niveau (${strikeSupportLevelUsed}) selon DTE ≤ ${SUPPORT_SCORING_V2_SHORT_DTE_MAX} j et présence du near.`
  );
  if (supportNearNum == null && dteDays != null && dteDays <= SUPPORT_SCORING_V2_SHORT_DTE_MAX) {
    notes.push("DTE court mais supportNear indisponible — fallback supportWide comme le legacy.");
  }
  return notes;
}

function buildExplanationFr({
  supportStatusLegacy,
  supportStatusV2,
  changedVsLegacy,
  strikeSupportLevelUsed,
  spotBelowStructural,
}) {
  if (spotBelowStructural) {
    return `Garde structurelle V2 : le cours est sous le support critique (min large/proche). Statut=${supportStatusV2} — plus conservateur qu’un jugement fondé uniquement sur le support large historique (${supportStatusLegacy}).`;
  }
  if (!changedVsLegacy) {
    return `Support V2 : même classification que le legacy wide (${supportStatusV2}), niveau strike=${strikeSupportLevelUsed}.`;
  }
  return `Support V2 : le legacy wide indiquait « ${supportStatusLegacy} » alors qu’avec le niveau proche (${strikeSupportLevelUsed}) en DTE court, le verdict est « ${supportStatusV2} » — le scoring qualité utilise V2 lorsque activé.`;
}

function inferChangeType({ changedVsLegacy, spotBelowStructural }) {
  if (!changedVsLegacy) return null;
  if (spotBelowStructural) return "structural_spot_below_min_near_wide";
  return "near_short_dte_vs_legacy_wide";
}

/**
 * @typedef {object} SupportScoringV2Input
 * @property {number|null|undefined} spot
 * @property {number|null|undefined} strike
 * @property {number|null|undefined} dteDays
 * @property {number|null|undefined} supportWide
 * @property {number|null|undefined} supportNear
 * @property {string} legacySupportStatus
 * @property {boolean} [enabled]
 */

export function buildSupportScoringV2(params) {
  const {
    spot,
    strike,
    dteDays,
    supportWide,
    supportNear,
    legacySupportStatus,
    enabled = SUPPORT_SCORING_V2_ENABLED,
  } = params || {};

  const wRaw = toNumber(supportWide);
  const supportWideNum = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : null;
  const nRaw = toNumber(supportNear);
  const supportNearNum = Number.isFinite(nRaw) && nRaw > 0 ? nRaw : null;

  /** Niveau structurel prudent : minimum des deux quand ils existent — spot en dessous = cassure forte. */
  let structuralLevel = null;
  let spotBreakSupportLevelUsed = "unknown";
  if (supportWideNum != null && supportNearNum != null) {
    structuralLevel = Math.min(supportWideNum, supportNearNum);
    spotBreakSupportLevelUsed = "min_near_wide";
  } else if (supportWideNum != null) {
    structuralLevel = supportWideNum;
    spotBreakSupportLevelUsed = "wide";
  } else if (supportNearNum != null) {
    structuralLevel = supportNearNum;
    spotBreakSupportLevelUsed = "unknown";
  }

  const spotVsStructuralPct = pctPriceVsLevel(spot, structuralLevel);
  const spotBelowStructural =
    structuralLevel != null && spotVsStructuralPct != null && spotVsStructuralPct < 0;

  const shortDte =
    dteDays != null && Number.isFinite(Number(dteDays)) && Number(dteDays) <= SUPPORT_SCORING_V2_SHORT_DTE_MAX;
  let strikeEvalLevel = null;
  let strikeSupportLevelUsed = "unknown";

  if (shortDte && supportNearNum != null) {
    strikeEvalLevel = supportNearNum;
    strikeSupportLevelUsed = "near";
  } else if (supportWideNum != null) {
    strikeEvalLevel = supportWideNum;
    strikeSupportLevelUsed = "wide";
  } else if (supportNearNum != null) {
    strikeEvalLevel = supportNearNum;
    strikeSupportLevelUsed = "near";
  }

  const strikeHypoPct = pctPriceVsLevel(strike, strikeEvalLevel);

  let hypoV2SupportStatus = "unknown";
  if (spotBelowStructural) {
    hypoV2SupportStatus = "current_below_support";
  } else if (strikeEvalLevel != null) {
    hypoV2SupportStatus = classifyStrikeAgainstLevel(strike, strikeEvalLevel);
  }

  const legacy = String(legacySupportStatus ?? "unknown").trim() || "unknown";
  const supportStatusLegacyCanon = canonSupportStatus(legacy);

  let supportStatusV2 = hypoV2SupportStatus;
  let strikeSupportLevelOut = strikeSupportLevelUsed;
  let strikePctOut = strikeHypoPct;

  if (!enabled) {
    supportStatusV2 = legacy;
    strikeSupportLevelOut = "wide";
    strikePctOut = pctPriceVsLevel(strike, supportWideNum);
  }

  const supportStatusV2Canon = canonSupportStatus(supportStatusV2);
  const changedVsLegacy = enabled && supportStatusV2Canon !== supportStatusLegacyCanon;

  let supportStatusUsedByQualityScore = "legacy_wide_fallback";
  if (!enabled) {
    supportStatusUsedByQualityScore = "legacy_wide_disabled";
  } else if (spotBelowStructural && structuralLevel != null) {
    supportStatusUsedByQualityScore = "v2_structural_min_level";
  } else if (shortDte && supportNearNum != null) {
    supportStatusUsedByQualityScore = "v2_near_short_dte";
  } else if (strikeSupportLevelUsed === "wide" || strikeSupportLevelUsed === "near") {
    supportStatusUsedByQualityScore = "legacy_wide_fallback";
  }

  const legacyQualitySupportDelta = qualitySupportDeltaForStatus(legacy);
  const v2QualitySupportDelta = enabled
    ? qualitySupportDeltaForStatus(hypoV2SupportStatus)
    : legacyQualitySupportDelta;
  const qualityScoreDeltaLegacyVsV2 = round(v2QualitySupportDelta - legacyQualitySupportDelta, 3);

  const shouldApplyQualityScoreV2 =
    enabled && legacyQualitySupportDelta !== v2QualitySupportDelta;

  const notes = computeNotes({
    structuralLevel,
    spotBreakSupportLevelUsed,
    strikeSupportLevelUsed,
    supportWideNum,
    supportNearNum,
    dteDays: dteDays != null ? Number(dteDays) : null,
  });
  if (!enabled) notes.push("V2 désactivé : aucune application qualité hors legacy.");

  const changeType = !enabled ? null : inferChangeType({
    changedVsLegacy,
    spotBelowStructural,
  });

  const explanationFr = !enabled
    ? "Support scoring V2 désactivé — même statut legacy (support wide) pour la qualité."
    : buildExplanationFr({
        supportStatusLegacy: legacy,
        supportStatusV2: hypoV2SupportStatus,
        changedVsLegacy,
        strikeSupportLevelUsed,
        spotBelowStructural,
      });

  return {
    version: "support_scoring_v2_near_for_short_dte",
    enabled,

    dteDays: dteDays != null && Number.isFinite(Number(dteDays)) ? Number(dteDays) : null,
    shortDteMax: SUPPORT_SCORING_V2_SHORT_DTE_MAX,

    supportWide: supportWideNum,
    supportNear: supportNearNum,

    legacySupportStatus: legacy,
    legacySupportLevelUsed: "wide",

    strikeSupportLevelUsed: strikeSupportLevelOut,
    spotBreakSupportLevelUsed,

    strikeVsSupportEffectivePct:
      strikePctOut != null ? round(strikePctOut, 4) : null,
    spotVsStructuralSupportPct:
      spotVsStructuralPct != null ? round(spotVsStructuralPct, 4) : null,

    supportStatusV2,
    supportStatusLegacy: legacy,

    changedVsLegacy,
    changeType,

    shouldApplyQualityScoreV2,

    qualityScoreDeltaLegacyVsV2,
    legacyQualitySupportDelta,
    v2QualitySupportDelta,

    supportStatusUsedByQualityScore,

    explanationFr,
    notes,
  };
}
