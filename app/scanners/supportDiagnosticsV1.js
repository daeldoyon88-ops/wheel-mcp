import { round, toNumber } from "../utils/number.js";

/**
 * Seuil « strike au-dessus du support » aligné sur wheelScanner (strikeVsSupportPct > 2).
 * Diagnostic uniquement — n’alimente pas le scoring.
 */
const STRIKE_ABOVE_SUPPORT_PCT = 2;

function supportStatusForLevel(spot, strike, supportLevel) {
  const s = toNumber(supportLevel);
  if (!(s > 0)) return "unknown";
  const spotNum = toNumber(spot);
  const strikeNum = toNumber(strike);
  const currentVsSupportPct =
    Number.isFinite(spotNum) && spotNum > 0 ? ((spotNum - s) / s) * 100 : null;
  if (currentVsSupportPct != null && currentVsSupportPct < 0) {
    return "current_below_support";
  }
  const strikeVsSupportPct =
    Number.isFinite(strikeNum) && strikeNum > 0 ? ((strikeNum - s) / s) * 100 : null;
  if (strikeVsSupportPct != null) {
    if (strikeVsSupportPct > STRIKE_ABOVE_SUPPORT_PCT) return "strike_above_support";
    if (strikeVsSupportPct >= 0) return "strike_near_support";
    return "strike_below_support";
  }
  return "unknown";
}

function pctStrikeVsSupport(strike, supportLevel) {
  const k = toNumber(strike);
  const s = toNumber(supportLevel);
  if (!(Number.isFinite(k) && k > 0 && s > 0)) return null;
  return ((k - s) / s) * 100;
}

function pctSpotVsSupport(spot, supportLevel) {
  const p = toNumber(spot);
  const s = toNumber(supportLevel);
  if (!(Number.isFinite(p) && p > 0 && s > 0)) return null;
  return ((p - s) / s) * 100;
}

function supportStatusBadness(status) {
  switch (status) {
    case "strike_below_support":
    case "below_support":
      return 0;
    case "strike_near_support":
    case "near_support":
      return 1;
    case "unknown":
      return 2;
    case "strike_above_support":
    case "room_above_support":
      return 3;
    case "current_below_support":
      return 4;
    default:
      return 2;
  }
}

/**
 * Bloc diagnostic versionné : compare support quantile (wide) vs niveau proche sous le spot (near).
 * Ne modifie aucune décision ni score — lecture / export uniquement.
 */
export function buildSupportDiagnosticsV1({
  spot,
  strike,
  supportWide,
  supportNear,
  resistanceWide,
  resistanceNear,
  currentSupportStatusUsedByScoring,
  dteDays,
  /** `near`|`wide`|`unknown` depuis support scoring — si absent, export suppose wide (legacy). */
  qualityStrikeSupportLevel = null,
}) {
  const w = toNumber(supportWide);
  const supportWideNum = w > 0 ? w : null;
  const n = toNumber(supportNear);
  const supportNearNum = n > 0 ? n : null;
  const rw = toNumber(resistanceWide);
  const resistanceWideNum = rw > 0 ? rw : null;
  const rn = toNumber(resistanceNear);
  const resistanceNearNum = rn > 0 ? rn : null;

  const supportStatusWide = supportStatusForLevel(spot, strike, supportWideNum);
  const supportStatusNear =
    supportNearNum != null
      ? supportStatusForLevel(spot, strike, supportNearNum)
      : "unknown";

  const strikeVsSupportWidePct = pctStrikeVsSupport(strike, supportWideNum);
  const strikeVsSupportNearPct = pctStrikeVsSupport(strike, supportNearNum);
  const spotVsSupportWidePct = pctSpotVsSupport(spot, supportWideNum);
  const spotVsSupportNearPct = pctSpotVsSupport(spot, supportNearNum);

  const nearVsWideDisagreement =
    supportNearNum != null && supportStatusWide !== supportStatusNear;

  let disagreementType;
  if (supportNearNum == null) {
    disagreementType = "near_unavailable";
  } else if (supportStatusWide === supportStatusNear) {
    disagreementType = "no_disagreement";
  } else {
    const bw = supportStatusBadness(supportStatusWide);
    const bn = supportStatusBadness(supportStatusNear);
    if (bw > bn) disagreementType = "wide_penalizes_near_support_ok";
    else if (bn > bw) disagreementType = "wide_ok_near_penalizes";
    else disagreementType = "no_disagreement";
  }

  const dte = toNumber(dteDays);
  let supportNearLooksMoreRelevantForShortDte = null;
  if (
    supportNearNum != null &&
    Number.isFinite(dte) &&
    dte > 0 &&
    dte <= 7 &&
    disagreementType !== "near_unavailable"
  ) {
    if (disagreementType === "wide_penalizes_near_support_ok") {
      supportNearLooksMoreRelevantForShortDte = true;
    } else if (disagreementType === "wide_ok_near_penalizes") {
      supportNearLooksMoreRelevantForShortDte = false;
    }
  }

  const qLevel =
    typeof qualityStrikeSupportLevel === "string" && qualityStrikeSupportLevel.trim().length > 0
      ? qualityStrikeSupportLevel.trim()
      : null;
  /** Ancre export : niveau utilisé pour classer le strike dans qualityScore (`wide` legacy, ou `near` avec V2 DTE court). */
  const whichSupportUsedByCurrentScoring =
    qLevel === "near" || qLevel === "wide"
      ? qLevel
      : supportWideNum != null
        ? "wide"
        : "unknown";

  const notes = [];
  if (supportNearNum == null) {
    notes.push(
      "supportNear indisponible: aucun creux sous le spot dans la fenêtre récente (seuils spot±0,1 %)."
    );
  } else if (nearVsWideDisagreement) {
    notes.push(`Écart: supportStatusWide=${supportStatusWide}, supportStatusNear=${supportStatusNear}.`);
  }

  return {
    methodVersion: "quantile_40d_plus_near_levels_diag_v1",
    source: "Yahoo chart OHLC",
    usesHighLowClose: true,
    usesOpen: false,
    supportWide: supportWideNum != null ? round(supportWideNum, 3) : null,
    supportNear: supportNearNum != null ? round(supportNearNum, 3) : null,
    resistanceWide: resistanceWideNum != null ? round(resistanceWideNum, 3) : null,
    resistanceNear: resistanceNearNum != null ? round(resistanceNearNum, 3) : null,
    strikeVsSupportWidePct:
      strikeVsSupportWidePct != null ? round(strikeVsSupportWidePct, 2) : null,
    strikeVsSupportNearPct:
      strikeVsSupportNearPct != null ? round(strikeVsSupportNearPct, 2) : null,
    spotVsSupportWidePct: spotVsSupportWidePct != null ? round(spotVsSupportWidePct, 2) : null,
    spotVsSupportNearPct: spotVsSupportNearPct != null ? round(spotVsSupportNearPct, 2) : null,
    supportStatusWide,
    supportStatusNear,
    currentSupportStatusUsedByScoring:
      typeof currentSupportStatusUsedByScoring === "string" && currentSupportStatusUsedByScoring
        ? currentSupportStatusUsedByScoring
        : "unknown",
    whichSupportUsedByCurrentScoring,
    nearVsWideDisagreement,
    disagreementType,
    supportNearLooksMoreRelevantForShortDte,
    notes,
  };
}
