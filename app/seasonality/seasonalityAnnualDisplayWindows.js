/**
 * Fenêtres annuelles officielles pour panneau + graphiques principaux.
 * Même logique de clusters haussiers que le dashboard (Printemps/été, Automne/hiver).
 */

import { weekOfMonthToDay } from './seasonalityWindowDisplay.js';
import { buildCalendarCoverageMask } from './seasonalityWindowDistinct.js';

export const BULLISH_SEASON_CLUSTERS = [
  {
    id: 'spring_summer',
    label: 'Printemps / été',
    preferredDisplay: '15 avril → 15 juillet',
    preferredStart: { month: 4, day: 15 },
    preferredEnd: { month: 7, day: 15 },
    sortOrder: 0,
  },
  {
    id: 'autumn_winter',
    label: 'Automne / hiver',
    preferredDisplay: '15 oct. → 8 déc.',
    preferredStart: { month: 10, day: 15 },
    preferredEnd: { month: 12, day: 8 },
    sortOrder: 1,
  },
];

function _dayOfYear(month, day) {
  const DAYS = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = day;
  for (let m = 1; m < month; m++) doy += DAYS[m];
  return doy;
}

function _windowsOverlapFraction(w1, w2) {
  const { mask: mask1 } = buildCalendarCoverageMask(w1);
  const { mask: mask2 } = buildCalendarCoverageMask(w2);
  let overlap = 0;
  let count1 = 0;
  let count2 = 0;
  for (let d = 1; d < mask1.length; d++) {
    if (mask1[d]) count1++;
    if (mask2[d]) count2++;
    if (mask1[d] && mask2[d]) overlap++;
  }
  const minCount = Math.min(count1, count2);
  return minCount > 0 ? overlap / minCount : 0;
}

function _resolveWindowMonthDay(w) {
  if (!w) return null;
  const sm = w.startMonth;
  const em = w.endMonth;
  if (sm == null || em == null) return null;
  const refYear = new Date().getUTCFullYear();
  return {
    startMonth: sm,
    startDay: w.startDay ?? weekOfMonthToDay(sm, w.startWeekOfMonth ?? 1, refYear),
    endMonth: em,
    endDay: w.endDay ?? weekOfMonthToDay(em, w.endWeekOfMonth ?? 1, refYear),
  };
}

function _classifyBullishSeasonCluster(w) {
  const md = _resolveWindowMonthDay(w);
  if (!md) return null;
  const { startMonth, endMonth } = md;
  if (startMonth >= 3 && startMonth <= 5 && endMonth >= 5 && endMonth <= 8) return 'spring_summer';
  if (startMonth >= 9 && startMonth <= 11 && endMonth >= 10 && endMonth <= 12) return 'autumn_winter';
  if (startMonth >= 3 && startMonth <= 6) return 'spring_summer';
  if (startMonth >= 9 && startMonth <= 12) return 'autumn_winter';
  return null;
}

function _pickBestAnnualHorizonKey(annualHorizons) {
  if (!annualHorizons) return null;
  for (const key of ['15y', '10y', '5y', '3y']) {
    const stats = annualHorizons[key];
    if (stats && !stats.insufficient && stats.yearsCount != null) return key;
  }
  return null;
}

function _scoreBullishClusterRepresentative(w, cluster) {
  const md = _resolveWindowMonthDay(w);
  if (!md) return -Infinity;

  const startDOY = _dayOfYear(md.startMonth, md.startDay);
  const endDOY = _dayOfYear(md.endMonth, md.endDay);
  const prefStart = _dayOfYear(cluster.preferredStart.month, cluster.preferredStart.day);
  const prefEnd = _dayOfYear(cluster.preferredEnd.month, cluster.preferredEnd.day);

  let score = 1000;
  score -= Math.abs(startDOY - prefStart) * 2;
  score -= Math.abs(endDOY - prefEnd) * 2;

  if (cluster.id === 'spring_summer') {
    if (md.startMonth === 3) score -= 50;
    if (md.startMonth >= 4) score += 20;
  }

  if (w.strength === 'Forte') score += 40;
  else if (w.strength === 'Confirmée') score += 20;

  const hKey = _pickBestAnnualHorizonKey(w?.annualHorizons);
  const avg = hKey ? w.annualHorizons[hKey]?.avgReturnAnnual : null;
  if (avg != null) score += avg * 100;

  return score;
}

function _pickBullishClusterRepresentative(group, cluster) {
  let candidates = group;
  if (cluster.id === 'spring_summer') {
    const laterSpring = group.filter((w) => (_resolveWindowMonthDay(w)?.startMonth ?? 0) >= 4);
    if (laterSpring.length > 0) candidates = laterSpring;
  }

  const sorted = [...candidates].sort(
    (a, b) => _scoreBullishClusterRepresentative(b, cluster) - _scoreBullishClusterRepresentative(a, cluster),
  );
  const best = sorted[0];
  if (!best) return null;

  return {
    ...best,
    clusterId: cluster.id,
    clusterLabel: cluster.label,
    displayLabel: cluster.preferredDisplay,
    startMonth: cluster.preferredStart.month,
    startDay: cluster.preferredStart.day,
    endMonth: cluster.preferredEnd.month,
    endDay: cluster.preferredEnd.day,
    representativeSourceLabel: best.displayLabel ?? best.label ?? null,
  };
}

function _getWindowDisplayLabel(w) {
  return w?.displayLabel ?? w?.label ?? null;
}

/**
 * Regroupe bestBullishAnnualWindows par cluster saisonnier (1 représentant par cluster).
 */
export function groupBullishAnnualWindowsForDisplay(rawWindows) {
  const windows = rawWindows ?? [];
  if (!windows.length) return { primaryWindows: [], variantWindows: [] };

  const groups = new Map(BULLISH_SEASON_CLUSTERS.map((c) => [c.id, []]));
  const unassigned = [];

  for (const w of windows) {
    let clusterId = _classifyBullishSeasonCluster(w);
    if (!clusterId) {
      let bestOverlap = 0;
      let bestCluster = null;
      for (const cluster of BULLISH_SEASON_CLUSTERS) {
        for (const existing of groups.get(cluster.id) ?? []) {
          const ov = _windowsOverlapFraction(w, existing);
          if (ov > bestOverlap) {
            bestOverlap = ov;
            bestCluster = cluster.id;
          }
        }
      }
      clusterId = bestOverlap >= 0.45 ? bestCluster : null;
    }

    if (clusterId && groups.has(clusterId)) {
      const group = groups.get(clusterId);
      const overlapsExisting = group.some((g) => _windowsOverlapFraction(w, g) >= 0.45);
      const sameCluster = _classifyBullishSeasonCluster(w) === clusterId;
      if (sameCluster || overlapsExisting || group.length === 0) {
        group.push(w);
        continue;
      }
    }
    unassigned.push(w);
  }

  for (const w of [...unassigned]) {
    let bestCluster = null;
    let bestOverlap = 0;
    for (const cluster of BULLISH_SEASON_CLUSTERS) {
      for (const existing of groups.get(cluster.id) ?? []) {
        const ov = _windowsOverlapFraction(w, existing);
        if (ov > bestOverlap) {
          bestOverlap = ov;
          bestCluster = cluster.id;
        }
      }
    }
    if (bestCluster && bestOverlap >= 0.45) {
      groups.get(bestCluster).push(w);
      unassigned.splice(unassigned.indexOf(w), 1);
    }
  }

  const primaryWindows = [];
  const variantWindows = [...unassigned];

  for (const cluster of BULLISH_SEASON_CLUSTERS) {
    const group = groups.get(cluster.id) ?? [];
    if (!group.length) continue;
    const rep = _pickBullishClusterRepresentative(group, cluster);
    if (!rep) continue;
    primaryWindows.push(rep);
    for (const gw of group) {
      if (_getWindowDisplayLabel(gw) !== rep.representativeSourceLabel) {
        variantWindows.push(gw);
      }
    }
  }

  primaryWindows.sort(
    (a, b) => (BULLISH_SEASON_CLUSTERS.find((c) => c.id === a.clusterId)?.sortOrder ?? 9)
      - (BULLISH_SEASON_CLUSTERS.find((c) => c.id === b.clusterId)?.sortOrder ?? 9),
  );

  return { primaryWindows, variantWindows };
}

/**
 * Fenêtres officielles pour panneau + graphiques principaux.
 */
export function collectOfficialAnnualDisplayWindows(windowsData) {
  const { primaryWindows, variantWindows } = groupBullishAnnualWindowsForDisplay(
    windowsData?.bestBullishAnnualWindows,
  );

  return {
    bullish: primaryWindows,
    bullishVariants: variantWindows,
    bearishConfirmed: windowsData?.bestBearishAnnualWindows ?? [],
    vigilance: windowsData?.recentBearishVigilance ?? [],
  };
}

/** Normalise start/end pour tracé calendaire (occurrences annuelles). */
export function normalizeWindowChartDates(window) {
  if (!window) return window;
  if (window.startMonth != null && window.startDay != null && window.endMonth != null && window.endDay != null) {
    return window;
  }
  const md = _resolveWindowMonthDay(window);
  return md ? { ...window, ...md } : window;
}
