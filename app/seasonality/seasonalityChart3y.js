/**
 * Chart 3 ans — saisonnalité swing (Patch 2C-B).
 * Lecture seule — réutilise fetchHistoryRows + swingWindows adaptatives.
 * Aucun appel Yahoo indépendant, aucun impact scanner / IBKR.
 */

import {
  fetchHistoryRows,
  computeSeasonalityWindowsFromRows,
} from './seasonalityEngine.js';
import { selectAdaptiveSwingSeasonalityWindows } from './seasonalitySwingWindows.js';

export const CHART_YEARS = 3;
export const SOURCE_LABEL = 'Yahoo Finance';
export const CACHE_TTL_HOURS = 6;
export const ALGORITHM = 'seasonality-chart-3y';
export const MAX_BULLISH_OVERLAYS = 2;
export const MAX_BEARISH_OVERLAYS = 2;

const _r4 = (n) => Math.round(n * 10_000) / 10_000;
const _r2 = (n) => Math.round(n * 100) / 100;

// ─── Date utilities ───────────────────────────────────────────────────────────

export function toIsoDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isCrossYearWindow(window) {
  const startDOY = window.startDayOfYear;
  const endDOY = window.endDayOfYear;
  if (startDOY != null && endDOY != null) return startDOY > endDOY;
  const sm = window.startMonth ?? 1;
  const em = window.endMonth ?? 12;
  return sm > em;
}

/**
 * Convertit un jour de l'année (1–366) en date ISO UTC pour une année donnée.
 * Utilise le même calendrier simplifié que seasonalityWindowDistinct (fév. = 28 j).
 */
export function doyToIsoDate(year, doy) {
  const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let remaining = Math.max(1, Math.min(366, doy));
  for (let m = 1; m <= 12; m++) {
    const dim = DAYS_IN_MONTH[m];
    if (remaining <= dim) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${year}-${pad(m)}-${pad(remaining)}`;
    }
    remaining -= dim;
  }
  return `${year}-12-31`;
}

/**
 * Dates réelles d'une occurrence swing pour une année d'ancrage.
 * Cross-year : start en anchorYear, end en anchorYear + 1.
 */
export function resolveOccurrenceDates(window, anchorYear) {
  const startDOY = window.startDayOfYear;
  const endDOY = window.endDayOfYear;

  if (startDOY != null && endDOY != null) {
    const cross = startDOY > endDOY;
    return {
      startDate: doyToIsoDate(anchorYear, startDOY),
      endDate: doyToIsoDate(cross ? anchorYear + 1 : anchorYear, endDOY),
    };
  }

  const sm = window.startMonth ?? 1;
  const sd = window.startDay ?? 1;
  const em = window.endMonth ?? 12;
  const ed = window.endDay ?? 28;
  const cross = sm > em || (sm === em && sd > ed);

  const pad = (n) => String(n).padStart(2, '0');
  return {
    startDate: `${anchorYear}-${pad(sm)}-${pad(sd)}`,
    endDate: `${cross ? anchorYear + 1 : anchorYear}-${pad(em)}-${pad(ed)}`,
  };
}

export function isDateInRange(isoDate, startIso, endIso) {
  return isoDate >= startIso && isoDate <= endIso;
}

// ─── Bar lookup (rows triés par date asc) ─────────────────────────────────────

export function findBarOnOrAfter(rows, isoDate) {
  if (!rows?.length) return null;
  for (const row of rows) {
    const d = toIsoDate(row.date);
    if (d >= isoDate) return row;
  }
  return null;
}

export function findBarOnOrBefore(rows, isoDate) {
  if (!rows?.length) return null;
  let last = null;
  for (const row of rows) {
    const d = toIsoDate(row.date);
    if (d > isoDate) break;
    last = row;
  }
  return last;
}

// ─── Filtrage 3 ans ───────────────────────────────────────────────────────────

export function filterPriceSeries3y(rows, asOfDate = new Date(), years = CHART_YEARS) {
  if (!rows?.length) return [];

  const end = asOfDate instanceof Date ? asOfDate : new Date(asOfDate);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const startIso = toIsoDate(start);

  return rows.filter((r) => toIsoDate(r.date) >= startIso);
}

export function formatPriceRow(row) {
  return {
    date: toIsoDate(row.date),
    open:  _r2(row.open),
    high:  _r2(row.high),
    low:   _r2(row.low),
    close: _r2(row.close),
  };
}

// ─── Occurrences ──────────────────────────────────────────────────────────────

export function computeOccurrence(window, rows, anchorYear, asOfDate) {
  const { startDate, endDate } = resolveOccurrenceDates(window, anchorYear);
  const asOfIso = toIsoDate(asOfDate);

  const startBar = findBarOnOrAfter(rows, startDate);
  if (!startBar) {
    return {
      year: anchorYear,
      startDate,
      endDate,
      status: 'insufficient_data',
      startClose: null,
      endClose: null,
      realizedReturn: null,
    };
  }

  const windowEnded = asOfIso > endDate;
  const effectiveEndIso = windowEnded ? endDate : asOfIso;
  const endBar = findBarOnOrBefore(rows, effectiveEndIso);

  if (!endBar || toIsoDate(endBar.date) < toIsoDate(startBar.date)) {
    return {
      year: anchorYear,
      startDate,
      endDate,
      status: 'insufficient_data',
      startClose: _r2(startBar.close),
      endClose: null,
      realizedReturn: null,
    };
  }

  const startClose = startBar.close;
  const endClose = endBar.close;
  let status;

  if (!windowEnded && asOfIso < endDate) {
    status = 'in_progress';
  } else {
    status = 'complete';
  }

  const realizedReturn = startClose > 0
    ? _r4((endClose / startClose) - 1)
    : null;

  return {
    year: anchorYear,
    startDate,
    endDate,
    status,
    startClose: _r2(startClose),
    endClose: _r2(endClose),
    realizedReturn,
  };
}

export function listOccurrenceAnchorYears(rangeStartIso, rangeEndIso) {
  const startYear = parseIsoDate(rangeStartIso).getUTCFullYear();
  const endYear = parseIsoDate(rangeEndIso).getUTCFullYear();
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  return years;
}

export function computeOccurrencesForWindow(window, rows, rangeStartIso, rangeEndIso, asOfDate) {
  const anchorYears = listOccurrenceAnchorYears(rangeStartIso, rangeEndIso);
  const occurrences = [];

  for (const y of anchorYears) {
    const occ = computeOccurrence(window, rows, y, asOfDate);
    const occEnd = occ.endDate;
    const occStart = occ.startDate;
    if (occEnd < rangeStartIso || occStart > rangeEndIso) continue;
    occurrences.push(occ);
  }

  return occurrences;
}

// ─── Pace / fenêtre active ────────────────────────────────────────────────────

export function computePaceStatus(progressTimePct, progressReturnPct) {
  if (progressReturnPct >= 0.90 && progressTimePct < 0.70) {
    return 'too_advanced';
  }
  if (progressReturnPct > progressTimePct + 0.20) {
    return 'ahead';
  }
  if (progressReturnPct < progressTimePct - 0.20) {
    return 'behind';
  }
  return 'on_track';
}

export function computeProgressTimePct(startIso, endIso, asOfIso) {
  const startMs = parseIsoDate(startIso).getTime();
  const endMs = parseIsoDate(endIso).getTime();
  const asOfMs = parseIsoDate(asOfIso).getTime();

  if (endMs <= startMs) return 0;
  if (asOfMs <= startMs) return 0;
  if (asOfMs >= endMs) return 1;

  return _r4((asOfMs - startMs) / (endMs - startMs));
}

function _formatConfidence(confidence) {
  if (!confidence) return null;
  const s = String(confidence);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function computeActiveWindowProgress(swingOverlays, rows, asOfDate) {
  const asOfIso = toIsoDate(asOfDate);
  const asOfYear = parseIsoDate(asOfIso).getUTCFullYear();

  for (const overlay of swingOverlays) {
    const yearsToCheck = isCrossYearWindow(overlay)
      ? [asOfYear, asOfYear - 1]
      : [asOfYear];

    for (const anchorYear of yearsToCheck) {
      const { startDate, endDate } = resolveOccurrenceDates(overlay, anchorYear);
      if (!isDateInRange(asOfIso, startDate, endDate)) continue;

      const startBar = findBarOnOrAfter(rows, startDate);
      const currentBar = findBarOnOrBefore(rows, asOfIso);

      if (!startBar || !currentBar) continue;

      const startClose = startBar.close;
      const currentClose = currentBar.close;
      const expectedReturn = overlay.expectedReturn ?? 0;
      const realizedReturn = startClose > 0
        ? _r4((currentClose / startClose) - 1)
        : null;

      const progressTimePct = computeProgressTimePct(startDate, endDate, asOfIso);
      const progressReturnPct = expectedReturn !== 0 && realizedReturn != null
        ? _r4(realizedReturn / expectedReturn)
        : null;

      const paceStatus = progressReturnPct != null
        ? computePaceStatus(progressTimePct, progressReturnPct)
        : 'on_track';

      return {
        isActive: true,
        type: overlay.type,
        rank: overlay.rank,
        displayLabel: overlay.displayLabel,
        startDate,
        endDate,
        asOfDate: asOfIso,
        startClose: _r2(startClose),
        currentClose: _r2(currentClose),
        expectedReturn: overlay.expectedReturn,
        realizedReturn,
        progressTimePct,
        progressReturnPct,
        paceStatus,
      };
    }
  }

  return { isActive: false };
}

function buildActiveCandidates(swingWindows) {
  const candidates = [];

  for (let i = 0; i < (swingWindows.bullish?.length ?? 0); i++) {
    const w = swingWindows.bullish[i];
    candidates.push({
      ...w,
      type: 'bullish',
      rank: i + 1,
      expectedReturn: w.avgReturn ?? null,
    });
  }

  for (let i = 0; i < (swingWindows.bearish?.length ?? 0); i++) {
    const w = swingWindows.bearish[i];
    candidates.push({
      ...w,
      type: 'bearish',
      rank: i + 1,
      expectedReturn: w.avgReturn ?? null,
    });
  }

  return candidates;
}

// ─── Swing overlays ───────────────────────────────────────────────────────────

export function buildSwingOverlay(window, type, rank, rows, rangeStartIso, rangeEndIso, asOfDate) {
  const expectedReturn = window.avgReturn ?? null;

  return {
    id: `${type}-${rank}`,
    type,
    rank,
    displayLabel: window.displayLabel ?? '—',
    expectedReturn,
    winRate: window.winRate ?? null,
    worstReturn: window.worstReturn ?? null,
    confidence: _formatConfidence(window.confidence),
    occurrences: computeOccurrencesForWindow(window, rows, rangeStartIso, rangeEndIso, asOfDate),
  };
}

export function buildSwingOverlays(swingWindows, rows, rangeStartIso, rangeEndIso, asOfDate) {
  const overlays = [];

  for (let i = 0; i < (swingWindows.bullish?.length ?? 0); i++) {
    overlays.push(buildSwingOverlay(
      swingWindows.bullish[i],
      'bullish',
      i + 1,
      rows,
      rangeStartIso,
      rangeEndIso,
      asOfDate,
    ));
  }

  for (let i = 0; i < (swingWindows.bearish?.length ?? 0); i++) {
    overlays.push(buildSwingOverlay(
      swingWindows.bearish[i],
      'bearish',
      i + 1,
      rows,
      rangeStartIso,
      rangeEndIso,
      asOfDate,
    ));
  }

  return overlays;
}

// ─── Construction réponse ─────────────────────────────────────────────────────

/**
 * Calcul pur (testable) — pas d'appel réseau.
 */
export function buildSeasonalityChart3yFromRows(rows, swingWindows, options = {}) {
  if (!rows?.length) return null;

  const asOfDate = options.asOfDate ?? new Date();
  const years = options.years ?? CHART_YEARS;
  const filtered = filterPriceSeries3y(rows, asOfDate, years);

  if (!filtered.length) return null;

  const rangeStartIso = toIsoDate(filtered[0].date);
  const rangeEndIso = toIsoDate(filtered[filtered.length - 1].date);

  const swingOverlays = buildSwingOverlays(
    swingWindows ?? { bullish: [], bearish: [] },
    rows,
    rangeStartIso,
    rangeEndIso,
    asOfDate,
  );

  const activeWindowProgress = computeActiveWindowProgress(
    buildActiveCandidates(swingWindows ?? { bullish: [], bearish: [] }),
    rows,
    asOfDate,
  );

  return {
    symbol: options.symbol ?? null,
    source: SOURCE_LABEL,
    range: {
      years,
      startDate: rangeStartIso,
      endDate: rangeEndIso,
      points: filtered.length,
    },
    priceSeries: filtered.map(formatPriceRow),
    swingOverlays,
    activeWindowProgress,
    meta: {
      generatedAt: new Date().toISOString(),
      cacheTtlHours: CACHE_TTL_HOURS,
      algorithm: ALGORITHM,
      // TODO Patch 2C-E : rsiSeries via computeRsi (technicalSnapshot.js)
    },
  };
}

/**
 * Endpoint principal — fetchHistoryRows + swingWindows adaptatives (max 2/2).
 */
export async function computeSeasonalityChart3y(symbol, options = {}) {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) return null;

  const rows = await fetchHistoryRows(sym);
  if (!rows?.length) return null;

  const windowsData = computeSeasonalityWindowsFromRows(rows, options.windowsOptions);
  if (!windowsData) return null;

  const swingWindows = selectAdaptiveSwingSeasonalityWindows(windowsData, {
    maxBullish: options.maxBullish ?? MAX_BULLISH_OVERLAYS,
    maxBearish: options.maxBearish ?? MAX_BEARISH_OVERLAYS,
    ...(options.swingOptions ?? {}),
  });

  const chart = buildSeasonalityChart3yFromRows(rows, swingWindows, {
    ...options,
    symbol: sym,
  });

  return chart;
}

export function buildChart3yApiResponse(chart) {
  if (!chart) return { ok: false, error: 'no chart data available' };
  return { ok: true, ...chart };
}
