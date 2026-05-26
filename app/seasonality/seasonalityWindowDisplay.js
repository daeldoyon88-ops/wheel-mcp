/**
 * Libellés d'affichage pour fenêtres saisonnières (mois + semaine du mois).
 * Réutilisable par /seasonality/:ticker/windows et futur /seasonality/backtest.
 * N'altère pas la logique métier — conversion W→jour approximative seulement.
 */

/** W1–W5 → jour du mois (approximation acceptée par le produit). */
export const WEEK_TO_DAY = { 1: 1, 2: 8, 3: 15, 4: 22, 5: 29 };

const MONTH_DISPLAY_FR = [
  'jan.', 'fév.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sep.', 'oct.', 'nov.', 'déc.',
];

function _daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Jour du mois pour une semaine du mois (W1–W5).
 * W5 = min(29, dernier jour du mois).
 */
export function weekOfMonthToDay(month, week, year) {
  const m = Math.min(12, Math.max(1, Number(month) || 1));
  const w = Math.min(5, Math.max(1, Number(week) || 1));
  const y = Number(year) || new Date().getUTCFullYear();
  if (w < 5) return WEEK_TO_DAY[w];
  return Math.min(29, _daysInMonth(y, m));
}

function _formatDayMonth(day, month) {
  const label = MONTH_DISPLAY_FR[month - 1] ?? `m${month}`;
  return `${day} ${label}`;
}

function _padIso(n) {
  return String(n).padStart(2, '0');
}

function _toIsoDate(year, month, day) {
  return `${year}-${_padIso(month)}-${_padIso(day)}`;
}

/**
 * Année de fin si la fenêtre traverse le nouvel an calendaire (ex. déc. → mars).
 */
export function resolveEndYear(startMonth, startDay, endMonth, endDay, referenceYear) {
  const y = Number(referenceYear) || new Date().getUTCFullYear();
  if (endMonth < startMonth) return y + 1;
  if (endMonth > startMonth) return y;
  if (endDay < startDay) return y + 1;
  return y;
}

/**
 * Champs d'affichage à partir de mois/semaine (sans modifier label existant).
 *
 * @param {object} params
 * @param {number} params.startMonth
 * @param {number} params.startWeekOfMonth
 * @param {number} params.endMonth
 * @param {number} params.endWeekOfMonth
 * @param {string} [params.label]
 * @param {number} [params.windowDays]
 * @param {number} [params.referenceYear]
 */
export function buildSeasonalWindowDisplayFields({
  startMonth,
  startWeekOfMonth,
  endMonth,
  endWeekOfMonth,
  label,
  windowDays,
  referenceYear,
}) {
  const refYear = referenceYear ?? new Date().getUTCFullYear();
  const startDay = weekOfMonthToDay(startMonth, startWeekOfMonth, refYear);
  const endYear  = resolveEndYear(
    startMonth, startDay, endMonth,
    weekOfMonthToDay(endMonth, endWeekOfMonth, refYear),
    refYear,
  );
  const endDay = weekOfMonthToDay(endMonth, endWeekOfMonth, endYear);

  const displayLabel = `${_formatDayMonth(startDay, startMonth)} → ${_formatDayMonth(endDay, endMonth)}`;
  const displayLabelWithYear =
    endYear === refYear
      ? `${_formatDayMonth(startDay, startMonth)} ${refYear} → ${_formatDayMonth(endDay, endMonth)} ${endYear}`
      : `${_formatDayMonth(startDay, startMonth)} ${refYear} → ${_formatDayMonth(endDay, endMonth)} ${endYear}`;

  return {
    label: label ?? null,
    displayLabel,
    displayLabelWithYear,
    startMonth,
    startDay,
    endMonth,
    endDay,
    startDateCurrentYear: _toIsoDate(refYear, startMonth, startDay),
    endDateCurrentYear: _toIsoDate(endYear, endMonth, endDay),
    windowDays: windowDays ?? null,
  };
}

/**
 * Enrichit un objet fenêtre (bestBullish, activeNow, etc.) avec les champs d'affichage.
 */
export function enrichSeasonalityWindowDisplay(window, options = {}) {
  if (!window || typeof window !== 'object') return window;

  const hasWeeks =
    window.startMonth != null &&
    window.startWeekOfMonth != null &&
    window.endMonth != null &&
    window.endWeekOfMonth != null;

  if (!hasWeeks) return window;

  const display = buildSeasonalWindowDisplayFields({
    startMonth: window.startMonth,
    startWeekOfMonth: window.startWeekOfMonth,
    endMonth: window.endMonth,
    endWeekOfMonth: window.endWeekOfMonth,
    label: window.label,
    windowDays: window.windowDays,
    referenceYear: options.referenceYear,
  });

  return {
    ...window,
    ...display,
    label: window.label,
    windowDays: window.windowDays ?? display.windowDays,
  };
}

/**
 * Enrichit toutes les fenêtres d'un résultat computeSeasonalityWindowsFromRows.
 */
export function enrichSeasonalityWindowsResult(result, options = {}) {
  if (!result?.horizons) return result;

  const enrich = (w) => enrichSeasonalityWindowDisplay(w, options);

  const horizons = result.horizons.map((h) => ({
    ...h,
    windows: (h.windows ?? []).map((block) => ({
      ...block,
      bestBullish: (block.bestBullish ?? []).map(enrich),
      worstBearish: (block.worstBearish ?? []).map(enrich),
    })),
  }));

  const summary = { ...result.summary };
  if (summary.bestOverallBullish) {
    summary.bestOverallBullish = enrich(summary.bestOverallBullish);
  }
  if (summary.worstOverallBearish) {
    summary.worstOverallBearish = enrich(summary.worstOverallBearish);
  }
  if (summary.activeNow) {
    summary.activeNow = summary.activeNow.map(enrich);
  }

  return { ...result, horizons, summary };
}
