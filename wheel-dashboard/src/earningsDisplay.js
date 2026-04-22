/**
 * UI labels for earnings publication moment (backend: morning | evening | unknown).
 */
const LABEL_FR = {
  morning: "Matin",
  evening: "Soir",
  unknown: "Inconnu",
};

/**
 * @param {string|null|undefined} earningsMoment
 * @returns {string} e.g. "Earnings: Matin"
 */
export function formatEarningsMomentWarning(earningsMoment) {
  const key =
    earningsMoment === "morning" || earningsMoment === "evening" ? earningsMoment : "unknown";
  return `Earnings: ${LABEL_FR[key]}`;
}
