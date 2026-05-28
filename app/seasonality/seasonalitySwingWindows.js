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
const HORIZON_YEARS_LIST = [3, 5, 10, 15];
const DEFAULT_START_END_TOLERANCE_DAYS = 14;
const DEFAULT_DURATION_TOLERANCE_DAYS = 21;
const DIRECTION_WIN_THRESHOLD = 0.55;
const CALENDAR_DAYS = 366;

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

function _circularDayDistance(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, CALENDAR_DAYS - d);
}

function _horizonKey(years) {
  return `${years}y`;
}

function _isDirectionConfirmed(stats, direction) {
  if (!stats || stats.sampleSize == null || stats.sampleSize <= 0) return false;
  const ar = stats.avgReturn ?? 0;
  const wr = stats.winRate ?? 0;
  if (direction === 'bullish') {
    return ar > 0 && wr >= DIRECTION_WIN_THRESHOLD;
  }
  return ar < 0 && wr <= (1 - DIRECTION_WIN_THRESHOLD);
}

function _buildHorizonStat(member, direction) {
  if (!member) return null;
  const sampleSize = member.sampleSize ?? 0;
  if (sampleSize <= 0) return null;
  const winRate = member.winRate ?? 0;
  return {
    years: member.horizonYears,
    sampleSize,
    avgReturn: member.avgReturn != null ? _r4(member.avgReturn) : null,
    winRate: member.winRate != null ? _r3(winRate) : null,
    lossRate: member.winRate != null ? _r3(1 - winRate) : null,
    downRate: member.winRate != null ? _r3(1 - winRate) : null,
    worstReturn: member.worstReturn != null ? _r4(member.worstReturn) : null,
    bestReturn: member.bestReturn != null ? _r4(member.bestReturn) : null,
    directionConfirmed: _isDirectionConfirmed(
      { avgReturn: member.avgReturn, winRate, sampleSize },
      direction,
    ),
  };
}

/**
 * Construit horizonStats à partir des membres d'une famille (un membre par horizon).
 */
export function buildHorizonStatsForMembers(members, direction) {
  const byHorizon = new Map();
  for (const m of members ?? []) {
    const hy = m.horizonYears;
    if (hy == null) continue;
    const prev = byHorizon.get(hy);
    if (!prev || (m.score ?? 0) > (prev.score ?? 0)) byHorizon.set(hy, m);
  }

  const horizonStats = {};
  for (const years of HORIZON_YEARS_LIST) {
    const stat = _buildHorizonStat(byHorizon.get(years), direction);
    if (stat) horizonStats[_horizonKey(years)] = stat;
  }
  return horizonStats;
}

function _confirmedHorizonKeys(horizonStats) {
  return HORIZON_YEARS_LIST
    .filter((y) => horizonStats[_horizonKey(y)]?.directionConfirmed)
    .map((y) => _horizonKey(y));
}

// totalOccurrences is a scoring aggregate across overlapping horizons.
// Do not display it as an independent occurrence count.
function _totalOccurrencesFromStats(horizonStats) {
  let total = 0;
  for (const key of Object.keys(horizonStats ?? {})) {
    total += horizonStats[key]?.sampleSize ?? 0;
  }
  return total;
}

/**
 * Champs d'affichage principal — sampleSize / winRate / avgReturn du primaryHorizon uniquement.
 */
function _buildSwingDisplayFields(w, direction) {
  const horizonStats = w.horizonStats ?? {};
  const primary = _primaryHorizonStat(horizonStats);
  const primaryHorizon = primary?.key ?? null;
  const primaryStat = primary?.stat ?? null;

  const displaySampleSize = primaryStat?.sampleSize
    ?? w.sampleSize
    ?? w.occurrences
    ?? null;

  const rawWinRate = primaryStat?.winRate ?? w.winRate ?? null;
  const displayWinRate = direction === 'bullish'
    ? rawWinRate
    : (primaryStat?.downRate ?? (rawWinRate != null ? 1 - rawWinRate : null));

  const displayAvgReturn = primaryStat?.avgReturn ?? w.avgReturn ?? null;
  const displayConfidence = w.multiHorizonConfidence ?? w.confidence ?? null;

  return {
    primaryHorizon,
    primaryHorizonSampleSize: primaryStat?.sampleSize ?? null,
    displaySampleSize,
    displayWinRate: displayWinRate != null ? _r3(displayWinRate) : null,
    displayAvgReturn: displayAvgReturn != null ? _r4(displayAvgReturn) : null,
    displayConfidence,
  };
}

function _primaryHorizonStat(horizonStats) {
  for (const years of [15, 10, 5, 3]) {
    const stat = horizonStats?.[_horizonKey(years)];
    if (stat?.directionConfirmed) return { years, stat, key: _horizonKey(years) };
  }
  for (const years of [15, 10, 5, 3]) {
    const stat = horizonStats?.[_horizonKey(years)];
    if (stat) return { years, stat, key: _horizonKey(years) };
  }
  return null;
}

function _pickRepresentativeMember(members, horizonStats, direction) {
  const primary = _primaryHorizonStat(horizonStats);
  if (primary) {
    const match = members.find((m) => m.horizonYears === primary.years);
    if (match) return match;
  }
  const confirmed = members
    .filter((m) => {
      const stat = horizonStats?.[_horizonKey(m.horizonYears)];
      return stat?.directionConfirmed;
    })
    .sort((a, b) => (b.horizonYears ?? 0) - (a.horizonYears ?? 0));
  if (confirmed.length) return confirmed[0];
  return [...members].sort((a, b) => (b.horizonYears ?? 0) - (a.horizonYears ?? 0))[0];
}

function _swingFamilyMatch(rep, candidate, startTol, endTol, durTol) {
  const covA = buildCalendarCoverageMask(rep);
  const covB = buildCalendarCoverageMask(candidate);
  if (_circularDayDistance(covA.startDOY, covB.startDOY) > startTol) return false;
  if (_circularDayDistance(covA.endDOY, covB.endDOY) > endTol) return false;
  const durA = _calendarDurationDays(rep);
  const durB = _calendarDurationDays(candidate);
  if (Math.abs(durA - durB) > durTol) return false;
  if (computeCalendarOverlapRatio(rep, candidate) < 0.35) return false;
  return true;
}

/**
 * Score de stabilité multi-horizons — privilégie 15y/10y confirmés, pénalise 3y seul.
 */
export function scoreMultiHorizonSwingFamily(family, direction) {
  const horizonStats = family.horizonStats ?? {};
  const confirmed = _confirmedHorizonKeys(horizonStats);
  const totalOcc = family.totalOccurrences ?? _totalOccurrencesFromStats(horizonStats);
  let score = 0;

  // Horizons confirmés (direction cohérente)
  if (confirmed.includes('15y')) score += 35;
  if (confirmed.includes('10y')) score += 25;
  if (confirmed.includes('5y')) score += 15;
  if (confirmed.includes('3y')) score += 10;

  // Win rate solide par horizon long
  const s15 = horizonStats['15y'];
  const s10 = horizonStats['10y'];
  const s5  = horizonStats['5y'];
  const s3  = horizonStats['3y'];

  if (s15?.directionConfirmed) {
    const wrOk = direction === 'bullish'
      ? (s15.winRate ?? 0) >= 0.7
      : (s15.downRate ?? 0) >= 0.7;
    if (wrOk && (s15.sampleSize ?? 0) >= 12) score += 15;
  }
  if (s10?.directionConfirmed) {
    const wrOk = direction === 'bullish'
      ? (s10.winRate ?? 0) >= 0.65
      : (s10.downRate ?? 0) >= 0.65;
    if (wrOk && (s10.sampleSize ?? 0) >= 8) score += 10;
  }
  if (s5?.directionConfirmed) score += 5;
  if (s3?.directionConfirmed) score += 5;

  // Rendement cohérent sur tous horizons disponibles
  const avail = Object.values(horizonStats).filter((s) => s?.sampleSize > 0);
  const retCoherent = avail.length > 0 && avail.every((s) =>
    direction === 'bullish' ? (s.avgReturn ?? 0) > 0 : (s.avgReturn ?? 0) < 0,
  );
  if (retCoherent && avail.length >= 2) score += 10;

  // Pire occurrence acceptable
  const primary = _primaryHorizonStat(horizonStats)?.stat ?? avail[0];
  if (primary) {
    const worst = primary.worstReturn ?? 0;
    if (direction === 'bullish' && worst >= -0.15) score += 5;
    if (direction === 'bearish' && worst <= 0.15) score += 5;
  }

  // Malus
  const availableKeys = Object.keys(horizonStats);
  if (availableKeys.length === 1 && availableKeys[0] === '3y') score -= 30;
  if (totalOcc < 5) score -= 40;

  const longConfirmed = confirmed.filter((k) => k === '10y' || k === '15y');
  const longContradict = [s10, s15].filter(Boolean).some((s) => !s.directionConfirmed
    && (s.sampleSize ?? 0) >= 5);
  if (longContradict && longConfirmed.length === 0) score -= 50;

  // Rendement moyen long (secondaire)
  const longStat = s15 ?? s10 ?? s5;
  if (longStat?.avgReturn != null) {
    score += Math.min(Math.abs(longStat.avgReturn) * 8, 12);
  }

  return _r3(score);
}

/**
 * Label de confiance multi-horizons.
 */
export function multiHorizonConfidenceFromFamily(family) {
  const horizonStats = family.horizonStats ?? {};
  const confirmed = _confirmedHorizonKeys(horizonStats);
  const totalOcc = family.totalOccurrences ?? _totalOccurrencesFromStats(horizonStats);
  const availableKeys = Object.keys(horizonStats);
  const has15 = Boolean(horizonStats['15y']);
  const has10 = Boolean(horizonStats['10y']);
  const s15 = horizonStats['15y'];
  const s10 = horizonStats['10y'];

  if (availableKeys.length === 1 && availableKeys[0] === '3y') {
    return 'échantillon limité';
  }
  if (totalOcc < 5) return 'échantillon limité';

  if (
    has15 && s15?.directionConfirmed
    && has10 && s10?.directionConfirmed
    && confirmed.length >= 3
    && totalOcc >= 12
  ) {
    return 'robuste multi-horizons';
  }

  if (
    (s15?.directionConfirmed || s10?.directionConfirmed)
    && totalOcc >= 12
    && confirmed.length >= 2
  ) {
    return 'robuste';
  }

  if (totalOcc >= 8 && confirmed.length >= 2) return 'mesurable';
  if (totalOcc >= 5 || confirmed.length >= 1) return 'préliminaire';
  return 'échantillon limité';
}

function _buildSelectionReason(family, direction) {
  const confirmed = family.confirmedHorizons ?? [];
  const primary = _primaryHorizonStat(family.horizonStats);
  if (!confirmed.length) {
    const only = Object.keys(family.horizonStats ?? {});
    if (only.length === 1) {
      return `Seulement ${only[0]} disponible; échantillon limité pour décision long terme.`;
    }
    return 'Direction non confirmée sur les horizons disponibles.';
  }

  const dirWord = direction === 'bullish' ? 'positif' : 'négatif';
  const rateWord = direction === 'bullish' ? 'haussier' : 'baissier';
  const parts = [`Confirmée sur ${confirmed.join(' / ')}`];
  if (primary?.stat) {
    const wr = direction === 'bullish'
      ? Math.round((primary.stat.winRate ?? 0) * 100)
      : Math.round((primary.stat.downRate ?? 0) * 100);
    parts.push(
      `${primary.key} ${dirWord} avec ${wr} % ${rateWord} (n=${primary.stat.sampleSize})`,
    );
  }
  return `${parts.join('; ')}.`;
}

function _finalizeSwingFamily(group, direction) {
  const members = group.members ?? [];
  const horizonStats = buildHorizonStatsForMembers(members, direction);
  const confirmedHorizons = _confirmedHorizonKeys(horizonStats);
  const totalOccurrences = _totalOccurrencesFromStats(horizonStats);
  const representative = _pickRepresentativeMember(members, horizonStats, direction);
  const primary = _primaryHorizonStat(horizonStats);
  const shortTerm = horizonStats['3y'];

  const family = {
    members,
    representativeStartDayOfYear: buildCalendarCoverageMask(representative).startDOY,
    representativeEndDayOfYear: buildCalendarCoverageMask(representative).endDOY,
    representativeStartLabel: representative.displayLabel
      ? String(representative.displayLabel).split('→')[0]?.trim()
      : null,
    representativeEndLabel: representative.displayLabel
      ? String(representative.displayLabel).split('→')[1]?.trim()
      : null,
    direction,
    horizonStats,
    bestMember: representative,
    confirmedHorizons,
    totalOccurrences,
    longHorizonAvailable: Boolean(horizonStats['10y'] || horizonStats['15y']),
    longHorizonConfirmed: confirmedHorizons.some((k) => k === '10y' || k === '15y'),
  };

  family.multiHorizonScore = scoreMultiHorizonSwingFamily(family, direction);
  family.multiHorizonConfidence = multiHorizonConfidenceFromFamily(family);
  family.selectionReason = _buildSelectionReason(family, direction);

  const rep = {
    ...representative,
    horizonStats,
    confirmedHorizons,
    totalOccurrences,
    longHorizonAvailable: family.longHorizonAvailable,
    longHorizonConfirmed: family.longHorizonConfirmed,
    multiHorizonScore: family.multiHorizonScore,
    multiHorizonConfidence: family.multiHorizonConfidence,
    selectionReason: family.selectionReason,
    horizonsFound: Object.keys(horizonStats)
      .map((k) => parseInt(k, 10))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b),
    occurrences: primary?.stat?.sampleSize ?? representative.sampleSize,
    avgReturn: primary?.stat?.avgReturn ?? representative.avgReturn,
    winRate: primary?.stat?.winRate ?? representative.winRate,
    worstReturn: primary?.stat?.worstReturn ?? representative.worstReturn,
    bestReturn: primary?.stat?.bestReturn ?? representative.bestReturn,
    sampleSize: primary?.stat?.sampleSize ?? representative.sampleSize,
    shortTermReturn: shortTerm?.avgReturn ?? null,
    recentReturn: shortTerm?.avgReturn ?? null,
    expectedReturnSource: primary?.key ?? null,
    consolidatedCount: members.length,
    seasonFamily: _inferSeasonFamily(representative).id,
    seasonFamilyLabel: _inferSeasonFamily(representative).label,
  };

  return { ...rep, ..._buildSwingDisplayFields(rep, direction) };
}

/**
 * Regroupe les candidats proches en familles calendaires multi-horizons.
 */
export function buildSwingHorizonFamilies(candidates, options = {}) {
  const startTol = options.startEndToleranceDays ?? DEFAULT_START_END_TOLERANCE_DAYS;
  const endTol = options.startEndToleranceDays ?? DEFAULT_START_END_TOLERANCE_DAYS;
  const durTol = options.durationToleranceDays ?? DEFAULT_DURATION_TOLERANCE_DAYS;
  const direction = options.direction === 'bearish' ? 'bearish' : 'bullish';
  const groups = [];

  for (const w of candidates ?? []) {
    let placed = false;
    for (const group of groups) {
      if (_swingFamilyMatch(group.representative, w, startTol, endTol, durTol)) {
        group.members.push(w);
        placed = true;
        break;
      }
    }
    if (!placed) {
      groups.push({ members: [w], representative: w });
    }
  }

  return groups.map((g) => _finalizeSwingFamily(g, direction));
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
  const horizonsFound = w.horizonsFound
    ?? (w.horizonYears != null ? [w.horizonYears] : []);
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
  const display = _buildSwingDisplayFields(w, direction);
  const sampleForConf = display.displaySampleSize ?? w.sampleSize ?? w.occurrences;
  const { confidence, confidenceReason } = swingConfidenceFromHorizons(
    horizonsFound,
    sampleForConf,
  );
  const multiConf = display.displayConfidence ?? w.multiHorizonConfidence ?? confidence;
  const confirmedHorizons = w.confirmedHorizons
    ?? horizonsFound.map((h) => `${h}y`);

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
    primaryHorizon: display.primaryHorizon,
    primaryHorizonSampleSize: display.primaryHorizonSampleSize,
    displaySampleSize: display.displaySampleSize,
    displayWinRate: display.displayWinRate,
    displayAvgReturn: display.displayAvgReturn,
    displayConfidence: display.displayConfidence,
    avgReturn:    display.displayAvgReturn,
    expectedReturn: display.displayAvgReturn,
    winRate:      display.displayWinRate,
    worstReturn:  w.worstReturn != null ? _r4(w.worstReturn) : null,
    bestReturn:   w.bestReturn != null ? _r4(w.bestReturn) : null,
    occurrences:  display.displaySampleSize,
    sampleSize:   display.displaySampleSize,
    totalOccurrences: w.totalOccurrences ?? null,
    shortTermReturn: w.shortTermReturn != null ? _r4(w.shortTermReturn) : null,
    recentReturn: w.recentReturn != null ? _r4(w.recentReturn) : null,
    expectedReturnSource: w.expectedReturnSource ?? null,
    horizonsFound: [...horizonsFound].sort((a, b) => a - b),
    confirmedHorizons,
    horizonStats: w.horizonStats ?? null,
    multiHorizonScore: w.multiHorizonScore ?? null,
    multiHorizonConfidence: multiConf,
    longHorizonAvailable: w.longHorizonAvailable ?? false,
    longHorizonConfirmed: w.longHorizonConfirmed ?? false,
    selectionReason: w.selectionReason ?? null,
    horizonsConfirmedLabel: confirmedHorizons.length
      ? `Confirmée ${confirmedHorizons.join(' / ')}`
      : (horizonsFound.length
        ? `Confirmé sur ${horizonsFound.map((h) => `${h}y`).join(' / ')}`
        : null),
    seasonFamily: family.id,
    seasonFamilyLabel: family.label,
    confidence,
    confidenceReason,
    verdict: direction === 'bullish' ? _swingVerdictBullish(w) : _swingVerdictBearish(w),
    reason: _swingReason(w, direction, family, horizonsFound),
    score: _r3(w.multiHorizonScore ?? w.swingScore ?? 0),
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
 * Regroupe des fenêtres proches (famille calendaire multi-horizons).
 * Alias rétrocompatible — délègue à buildSwingHorizonFamilies.
 */
export function consolidateSwingFamilies(candidates, options = {}) {
  const direction = options.direction ?? 'bullish';
  return buildSwingHorizonFamilies(candidates, { ...options, direction });
}

function _confidenceRank(conf) {
  const v = String(conf ?? '').toLowerCase();
  if (v.includes('multi')) return 5;
  if (v === 'robuste') return 4;
  if (v === 'mesurable') return 3;
  if (v === 'préliminaire' || v === 'preliminaire') return 2;
  if (v.includes('limité') || v.includes('limite')) return 1;
  return 0;
}

function _selectNonOverlapping(candidates, direction, options) {
  const maxPick = direction === 'bearish'
    ? (options.maxBearish ?? DEFAULT_MAX_BEARISH)
    : (options.maxBullish ?? DEFAULT_MAX_BULLISH);
  const maxOverlap = options.maxOverlapRatio ?? DEFAULT_MAX_OVERLAP_RATIO;

  const scored = candidates.map((w) => ({
    ...w,
    swingScore: w.multiHorizonScore ?? scoreMultiHorizonSwingFamily(
      { horizonStats: w.horizonStats, totalOccurrences: w.totalOccurrences },
      direction,
    ),
  })).sort((a, b) => {
    const confDiff = _confidenceRank(b.multiHorizonConfidence)
      - _confidenceRank(a.multiHorizonConfidence);
    if (confDiff !== 0) return confDiff;
    const scoreDiff = (b.swingScore ?? 0) - (a.swingScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.totalOccurrences ?? 0) - (a.totalOccurrences ?? 0);
  });

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

  const bullConsolidated = buildSwingHorizonFamilies(bullRaw, { ...opts, direction: 'bullish' });
  const bearConsolidated = buildSwingHorizonFamilies(bearRaw, { ...opts, direction: 'bearish' });

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
    algorithm: 'multi-horizon-adaptive-seasonality-swing-windows',
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
