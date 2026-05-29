/**
 * Validation du payload bundle saisonnalité (calendar + short-term + windows + chart-3y).
 * Règle INVALID : les 4 sources vides / chart3y ok=false.
 */

export function analyzeBundlePayload(payload) {
  const calendarData  = payload?.calendarData  ?? null;
  const shortTermData = payload?.shortTermData ?? null;
  const windowsData   = payload?.windowsData   ?? null;
  const chart3yData   = payload?.chart3yData   ?? null;

  const hasCalendarData  = calendarData  != null;
  const hasShortTermData = shortTermData != null;
  const hasWindowsData   = windowsData   != null;
  const hasChart3yData   = chart3yData   != null;
  const chart3yOk        = chart3yData?.ok === true;

  const validBundle = hasCalendarData || hasShortTermData || hasWindowsData || chart3yOk;

  return {
    hasCalendarData,
    hasShortTermData,
    hasWindowsData,
    hasChart3yData,
    chart3yOk,
    validBundle,
  };
}

export function isValidBundlePayload(payload) {
  return analyzeBundlePayload(payload).validBundle;
}

/**
 * Recommandation d'action pour un ticker audité.
 */
export function getBundleRecommendation(ctx) {
  const {
    validBundle = false,
    cacheHit    = false,
    fresh       = false,
    error       = null,
  } = ctx ?? {};

  if (error) return `ERREUR — ${error}`;
  if (cacheHit && !validBundle) return "CACHE_CORROMPU — purger et recalculer";
  if (!validBundle) return "INVALID — ne pas mettre en cache";
  if (cacheHit && fresh) return "OK";
  if (cacheHit && !fresh) return "STALE_OK — refresh en cours ou force=1";
  return "OK_FRESH — calcul direct";
}
