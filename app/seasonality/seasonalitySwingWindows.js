/**
 * Fenêtres swing saisonnières adaptatives (5–17 semaines, ~35–119 jours).
 * Sélection depuis horizons bruts, consolidation multi-horizons, anti-chevauchement.
 */

import {
  buildCalendarCoverageMask,
  computeCalendarOverlapRatio,
} from './seasonalityWindowDistinct.js';

const TRADING_DAYS_PER_WEEK = 5;
const DEFAULT_MIN_DURATION_DAYS = 35;
const DEFAULT_MAX_DURATION_DAYS = 119;
const DEFAULT_MAX_BULLISH = 3;
const DEFAULT_MAX_BEARISH = 3;
const DEFAULT_MAX_OVERLAP_RATIO = 0.50;
const DEFAULT_HORIZONS = [3, 5, 10, 15];
const DEFAULT_MIN_SAMPLES = 3;

const MONTH_LABELS = [
  'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin',
  'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc',
];

const SEASON_FAMILIES = [
  {
    id: 'spring_summer',
    label: 'Printemps / été',
    match: (sm, em) => sm >= 3 && sm <= 5 && em >= 6 && em <= 8,
  },
  {
    id: 'autumn_year_end',
    label: 'Automne / fin d\'année',
    match: (sm, em) => sm >= 9 && sm <= 11 && (em >= 9 || em <= 2),
  },
  {
    id: 'winter_spring',
    label: 'Hiver / début d\'année',
    match: (sm, em) => (sm >= 12 || sm <= 2) && em >= 2 && em <= 5,
  },
];

function _r4(n) {
  return Math.round(n * 10_000) / 10_000;
}

function _r3(n) {
  return Math.round(n * 1_000) / 1_000;
}

function _maskDayCount(window) {
  return _maskDayCountFromMask(buildCalendarCoverageMask(window).mask);
}

function _maskDayCountFromMask(mask) {
  let n = 0;
  for (let d = 1; d < mask.length; d++) if (mask[d]) n++;
  return n;
}

function _tradingDurationDays(w) {
  return w.windowDays ?? w.days ?? null;
}

function _calendarDurationDays(w) {
  return _maskDayCount(w);
}

function _durationWeeksFromTradingDays(tradingDays) {
  if (!tradingDays || tradingDays <= 0) return null;
  return Math.max(1, Math.round(tradingDays / TRADING_DAYS_PER_WEEK));
}

function _weekLabel(month, week) {
  return `${MONTH_LABELS[(month ?? 1) - 1] ?? '?'} W${week ?? 1}`;
}

function _inferSeasonFamily(w) {
  const sm = w.startMonth ?? 0;
  const em = w.endMonth ?? 0;
  for (const fam of SEASON_FAMILIES) {
    if (fam.match(sm, em)) return fam;
  }
  return { id: 'other', label: 'Autre saison' };
}

function _inDurationRange(w, minDays, maxDays) {
  const trading = _tradingDurationDays(w);
  const calendar = _calendarDurationDays(w);
  if (trading != null) {
    if (trading < minDays || trading > maxDays) return false;
  }
  if (calendar < minDays || calendar > maxDays) return false;
  return true;
}

function _computeBullishSwingScore(w, horizonsCount) {
  const wr = w.winRate ?? 0;
  const ar = w.avgReturn ?? 0;
  const n  = w.sampleSize ?? 0;
  const worst = w.worstReturn ?? 0;
  const horizonBonus = horizonsCount * 1.2;
  const wrScore = wr * 4;
  const retScore = Math.max(0, ar) * 20;
  const sampleScore = Math.min(n / 10, 1) * 2;
  const worstPenalty = Math.max(0, -worst) * 6;
  return wrScore + retScore + sampleScore + horizonBonus - worstPenalty + (w.score ?? 0) * 0.15;
}

function _computeBearishSwingScore(w, horizonsCount) {
  const wr = w.winRate ?? 0;
  const ar = w.avgReturn ?? 0;
  const n  = w.sampleSize ?? 0;
  const worst = w.worstReturn ?? 0;
  const horizonBonus = horizonsCount * 1.2;
  const lowWr = (1 - wr) * 4;
  const lossScore = Math.max(0, -ar) * 20;
  const worstScore = Math.max(0, -worst) * 8;
  const sampleScore = Math.min(n / 10, 1) * 2;
  return lowWr + lossScore + worstScore + sampleScore + horizonBonus + (w.score ?? 0) * 0.15;
}

function _swingVerdictBullish(w) {
  const wr = w.winRate ?? 0;
  const ar = w.avgReturn ?? 0;
  if (wr >= 0.95 && ar >= 0.08) return 'Zone forte';
  if (wr >= 0.75 && ar >= 0.03) return 'Accumuler';
  if (wr >= 0.6 && ar > 0) return 'Maintenir';
  return 'Modéré';
}

function _swingVerdictBearish(w) {
  const ar = w.avgReturn ?? 0;
  const wr = w.winRate ?? 0;
  if (ar <= -0.08 && wr <= 0.35) return 'Éviter';
  if (ar < 0 && wr < 0.5) return 'Alléger';
  return 'CSP prudent';
}

function _swingReason(w, direction, family, horizonsFound) {
  const fam = family?.label ?? 'Saison';
  const h = horizonsFound?.length ? horizonsFound.join('y / ') + 'y' : 'horizon limité';
  if (direction === 'bullish') {
    return `${fam} — historique haussier (${h})`;
  }
  return `${fam} — période défavorable (${h})`;
}

/**
 * Confiance swing basée sur le nombre d'horizons confirmés.
 * 3–4 horizons → robuste · 2 → mesurable · 1 → préliminaire
 * Un échantillon très faible peut réduire la confiance (avec raison explicite).
 */
export function swingConfidenceFromHorizons(horizonsFound, sampleSize) {
  const hN = horizonsFound?.length ?? 0;
  let confidence;
  if (hN >= 3) confidence = 'robuste';
  else if (hN === 2) confidence = 'mesurable';
  else confidence = 'préliminaire';

  let confidenceReason = null;
  const n = sampleSize ?? 0;

  if (n > 0 && n < 3) {
    if (hN >= 3 && confidence === 'robuste') {
      confidence = 'mesurable';
      confidenceReason = `Échantillon limité (n=${n})`;
    } else if (hN === 2 && confidence === 'mesurable') {
      confidence = 'préliminaire';
      confidenceReason = `Échantillon limité (n=${n})`;
    } else if (hN <= 1) {
      confidenceReason = `Échantillon limité (n=${n})`;
    }
  }

  return { confidence, confidenceReason };
}

function _formatSwingRecord(w, direction, options = {}) {
  const family = _inferSeasonFamily(w);
  const horizonsFound = w.horizonsFound ?? (w.horizonYears != null ? [w.horizonYears] : []);
  const tradingDays = _tradingDurationDays(w);
  const calendarDays = _calendarDurationDays(w);
  const durationDays = tradingDays ?? calendarDays;
  const durationWeeks = _durationWeeksFromTradingDays(durationDays);

  const startLabel = w.displayLabel
    ? String(w.displayLabel).split('→')[0]?.trim()
    : null;
  const endLabel = w.displayLabel
    ? String(w.displayLabel).split('→')[1]?.trim()
    : null;

  const { startDOY, endDOY } = buildCalendarCoverageMask(w);
  const { confidence, confidenceReason } = swingConfidenceFromHorizons(
    horizonsFound,
    w.sampleSize ?? w.occurrences,
  );

  const record = {
    direction,
    startLabel: startLabel ?? w.startLabel ?? '—',
    endLabel:   endLabel ?? w.endLabel ?? '—',
    displayLabel: w.displayLabel ?? `${startLabel ?? '?'} → ${endLabel ?? '?'}`,
    startWeekLabel: _weekLabel(w.startMonth, w.startWeekOfMonth),
    endWeekLabel:   _weekLabel(w.endMonth, w.endWeekOfMonth),
    startMonth: w.startMonth,
    endMonth:   w.endMonth,
    startDay:   w.startDay ?? null,
    endDay:     w.endDay ?? null,
    startDayOfYear: startDOY,
    endDayOfYear:   endDOY,
    durationDays,
    durationWeeks,
    calendarDurationDays: calendarDays,
    avgReturn:    w.avgReturn != null ? _r4(w.avgReturn) : null,
    winRate:      w.winRate != null ? _r3(w.winRate) : null,
    worstReturn:  w.worstReturn != null ? _r4(w.worstReturn) : null,
    bestReturn:   w.bestReturn != null ? _r4(w.bestReturn) : null,
    occurrences:  w.sampleSize ?? w.occurrences ?? null,
    horizonsFound: [...horizonsFound].sort((a, b) => a - b),
    horizonsConfirmedLabel: horizonsFound.length
      ? `Confirmé sur ${horizonsFound.map((h) => `${h}y`).join(' / ')}`
      : null,
    seasonFamily: family.id,
    seasonFamilyLabel: family.label,
    confidence,
    confidenceReason,
    verdict: direction === 'bullish' ? _swingVerdictBullish(w) : _swingVerdictBearish(w),
    reason: _swingReason(w, direction, family, horizonsFound),
    score: _r3(w.swingScore ?? 0),
    momentumTriggerHint: direction === 'bullish'
      ? 'Confirmation momentum suggérée : RSI > 50'
      : 'Confirmation momentum suggérée : prudence si RSI > 70',
    reading: direction === 'bullish'
      ? _swingVerdictBullish(w)
      : _swingVerdictBearish(w),
  };

  return record;
}

/**
 * Aplatit les candidats swing depuis horizons (filtré par horizons demandés).
 */
export function flattenSwingCandidates(windowsData, direction, options = {}) {
  const horizonsFilter = options.horizons ?? DEFAULT_HORIZONS;
  const minDays = options.minDurationDays ?? DEFAULT_MIN_DURATION_DAYS;
  const maxDays = options.maxDurationDays ?? DEFAULT_MAX_DURATION_DAYS;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;

  const key = direction === 'bearish' ? 'worstBearish' : 'bestBullish';
  const out = [];

  for (const h of windowsData?.horizons ?? []) {
    if (!horizonsFilter.includes(h.horizonYears)) continue;
    for (const wBlock of h.windows ?? []) {
      for (const w of wBlock[key] ?? []) {
        const enriched = {
          ...w,
          days: w.days ?? wBlock.windowDays,
          windowDays: w.windowDays ?? wBlock.windowDays,
          horizonYears: h.horizonYears,
        };
        if (!_inDurationRange(enriched, minDays, maxDays)) continue;
        if ((enriched.sampleSize ?? 0) < minSamples) continue;
        if (direction === 'bullish' && (enriched.avgReturn ?? 0) <= 0) continue;
        if (direction === 'bearish' && (enriched.avgReturn ?? 0) >= 0 && (enriched.winRate ?? 1) > 0.55) continue;
        out.push(enriched);
      }
    }
  }

  return out;
}

/**
 * Regroupe des fenêtres proches (même famille saisonnière + chevauchement).
 */
export function consolidateSwingFamilies(candidates, options = {}) {
  const familyOverlap = options.familyOverlapRatio ?? 0.45;
  const groups = [];

  for (const w of candidates) {
    const fam = _inferSeasonFamily(w);
    let placed = false;

    for (const group of groups) {
      if (group.familyId !== fam.id) continue;
      const rep = group.representative;
      if (computeCalendarOverlapRatio(rep, w) >= familyOverlap) {
        group.members.push(w);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push({
        familyId: fam.id,
        familyLabel: fam.label,
        members: [w],
        representative: w,
      });
    }
  }

  const consolidated = [];

  for (const group of groups) {
    const horizonsSet = new Set();
    let best = group.members[0];

    for (const m of group.members) {
      if (m.horizonYears != null) horizonsSet.add(m.horizonYears);
      const hCount = horizonsSet.size;
      const scoreM = (m.score ?? 0) + hCount * 0.01;
      const scoreB = (best.score ?? 0) + horizonsSet.size * 0.01;
      if (scoreM > scoreB) best = m;
    }

    for (const m of group.members) {
      if (m.horizonYears != null) horizonsSet.add(m.horizonYears);
    }

    const horizonsFound = [...horizonsSet].sort((a, b) => a - b);
    const maxSample = Math.max(...group.members.map((m) => m.sampleSize ?? 0));

    consolidated.push({
      ...best,
      horizonsFound,
      occurrences: maxSample,
      seasonFamily: group.familyId,
      seasonFamilyLabel: group.familyLabel,
      consolidatedCount: group.members.length,
    });
  }

  return consolidated;
}

function _selectNonOverlapping(candidates, direction, options) {
  const maxPick = direction === 'bearish'
    ? (options.maxBearish ?? DEFAULT_MAX_BEARISH)
    : (options.maxBullish ?? DEFAULT_MAX_BULLISH);
  const maxOverlap = options.maxOverlapRatio ?? DEFAULT_MAX_OVERLAP_RATIO;

  const scored = candidates.map((w) => {
    const hN = w.horizonsFound?.length ?? 1;
    const swingScore = direction === 'bearish'
      ? _computeBearishSwingScore(w, hN)
      : _computeBullishSwingScore(w, hN);
    return { ...w, swingScore };
  }).sort((a, b) => b.swingScore - a.swingScore);

  const selected = [];

  for (const c of scored) {
    if (selected.length >= maxPick) break;
    const conflicts = selected.some((s) =>
      computeCalendarOverlapRatio(s, c) >= maxOverlap,
    );
    if (conflicts) continue;
    selected.push(c);
  }

  return selected.map((w) => _formatSwingRecord(w, direction));
}

/**
 * Sélectionne les fenêtres swing adaptatives (API principale).
 */
export function selectAdaptiveSwingSeasonalityWindows(windowsData, options = {}) {
  if (!windowsData?.horizons?.length) {
    return {
      bullish: [],
      bearish: [],
      meta: _buildSwingMeta(options),
    };
  }

  const opts = {
    minDurationDays:    options.minDurationDays ?? DEFAULT_MIN_DURATION_DAYS,
    maxDurationDays:    options.maxDurationDays ?? DEFAULT_MAX_DURATION_DAYS,
    maxBullish:         options.maxBullish ?? DEFAULT_MAX_BULLISH,
    maxBearish:         options.maxBearish ?? DEFAULT_MAX_BEARISH,
    maxOverlapRatio:    options.maxOverlapRatio ?? DEFAULT_MAX_OVERLAP_RATIO,
    horizons:           options.horizons ?? DEFAULT_HORIZONS,
    minSamples:         options.minSamples ?? DEFAULT_MIN_SAMPLES,
    familyOverlapRatio: options.familyOverlapRatio ?? 0.45,
  };

  const bullRaw = flattenSwingCandidates(windowsData, 'bullish', opts);
  const bearRaw = flattenSwingCandidates(windowsData, 'bearish', opts);

  const bullConsolidated = consolidateSwingFamilies(bullRaw, opts);
  const bearConsolidated = consolidateSwingFamilies(bearRaw, opts);

  return {
    bullish: _selectNonOverlapping(bullConsolidated, 'bullish', opts),
    bearish: _selectNonOverlapping(bearConsolidated, 'bearish', opts),
    meta: _buildSwingMeta(opts),
  };
}

function _buildSwingMeta(options) {
  return {
    minDurationDays: options.minDurationDays ?? DEFAULT_MIN_DURATION_DAYS,
    maxDurationDays: options.maxDurationDays ?? DEFAULT_MAX_DURATION_DAYS,
    minDurationWeeks: Math.ceil((options.minDurationDays ?? DEFAULT_MIN_DURATION_DAYS) / TRADING_DAYS_PER_WEEK),
    maxDurationWeeks: Math.floor((options.maxDurationDays ?? DEFAULT_MAX_DURATION_DAYS) / TRADING_DAYS_PER_WEEK),
    algorithm: 'adaptive-ranked-seasonality-swing-windows',
    horizons: options.horizons ?? DEFAULT_HORIZONS,
    maxOverlapRatio: options.maxOverlapRatio ?? DEFAULT_MAX_OVERLAP_RATIO,
  };
}

/**
 * Ajoute swingWindows à la réponse /windows sans retirer clusters ni distinct.
 */
export function attachSwingSeasonalityWindows(windowsData, options = {}) {
  if (!windowsData?.horizons) return windowsData;

  const swingWindows = selectAdaptiveSwingSeasonalityWindows(windowsData, options);

  return {
    ...windowsData,
    swingWindows,
  };
}
