/**
 * Series-level validation of DailyBarV1 arrays.
 * Detects (never silently fixes): unsorted dates, duplicates, impossible OHLC,
 * negative prices/volume, weekend sessions, long gaps, probable undocumented
 * splits, raw/adjusted incoherence.
 */

import { dailyBarProblems } from '../contracts/dailyBarV1.mjs';
import { compareCivilDate, toEpochDay, dayOfWeek, fromEpochDay } from '../time/civilDate.mjs';
import { isWeekday } from '../time/marketSession.mjs';

/**
 * @typedef {Object} SeriesValidation
 * @property {string[]} problems blocking issues
 * @property {string[]} warnings non-blocking issues
 * @property {Object} stats
 */

/**
 * Pick the usable close of a bar for continuity checks (adjusted first,
 * because local caches are natively split-adjusted; falls back to raw).
 * @param {import('../contracts/dailyBarV1.mjs').DailyBarV1} bar
 * @returns {number|null}
 */
export function continuityClose(bar) {
  if (bar.adjusted && typeof bar.adjusted.close === 'number') return bar.adjusted.close;
  if (bar.raw && typeof bar.raw.close === 'number') return bar.raw.close;
  return null;
}

function emptyStats() {
  return {
    bars: 0,
    firstDate: null,
    lastDate: null,
    duplicateDates: 0,
    unsortedPairs: 0,
    weekendSessions: 0,
    missingWeekdays: 0,
    maxConsecutiveMissingWeekdays: 0,
    barsWithNullClose: 0,
    barsWithNullVolume: 0,
    splitSuspects: /** @type {string[]} */ ([]),
  };
}

/**
 * @param {unknown} bars
 * @param {{splitSuspectThreshold?: number, longGapWeekdays?: number}} [options]
 * @returns {SeriesValidation}
 */
export function validateDailyBars(bars, options = {}) {
  const splitSuspectThreshold = options.splitSuspectThreshold ?? 0.5;
  const longGapWeekdays = options.longGapWeekdays ?? 5;
  const problems = [];
  const warnings = [];
  const stats = emptyStats();

  if (!Array.isArray(bars)) {
    const kind = bars === null ? 'null' : bars === undefined ? 'undefined' : typeof bars;
    return {
      problems: [`bars is not an array (got ${kind})`],
      warnings,
      stats,
    };
  }

  stats.bars = bars.length;
  stats.firstDate = bars.length ? bars[0]?.sessionDate ?? null : null;
  stats.lastDate = bars.length ? bars[bars.length - 1]?.sessionDate ?? null : null;

  const seen = new Set();
  let prevBar = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const barProblems = dailyBarProblems(bar);
    for (const p of barProblems) problems.push(`bar[${i}] (${bar && bar.sessionDate}): ${p}`);
    if (barProblems.length > 0) continue;

    if (seen.has(bar.sessionDate)) {
      stats.duplicateDates++;
      problems.push(`bar[${i}]: duplicate sessionDate ${bar.sessionDate}`);
    }
    seen.add(bar.sessionDate);

    if (!isWeekday(bar.sessionDate)) {
      stats.weekendSessions++;
      warnings.push(`bar[${i}]: weekend sessionDate ${bar.sessionDate}`);
    }
    if (continuityClose(bar) === null) stats.barsWithNullClose++;
    const vol = bar.adjusted?.volume ?? bar.raw?.volume ?? null;
    if (vol === null) stats.barsWithNullVolume++;

    if (prevBar) {
      if (compareCivilDate(bar.sessionDate, prevBar.sessionDate) <= 0) {
        stats.unsortedPairs++;
        problems.push(`bar[${i}]: sessionDate ${bar.sessionDate} not after ${prevBar.sessionDate} (unsorted or duplicate)`);
      } else {
        let missing = 0;
        for (let d = toEpochDay(prevBar.sessionDate) + 1; d < toEpochDay(bar.sessionDate); d++) {
          const civil = fromEpochDay(d);
          const dow = dayOfWeek(civil);
          if (dow >= 1 && dow <= 5) missing++;
        }
        stats.missingWeekdays += missing;
        if (missing > stats.maxConsecutiveMissingWeekdays) stats.maxConsecutiveMissingWeekdays = missing;
        if (missing > longGapWeekdays) {
          warnings.push(`gap of ${missing} weekdays between ${prevBar.sessionDate} and ${bar.sessionDate}`);
        }
        const prevClose = continuityClose(prevBar);
        const close = continuityClose(bar);
        if (prevClose !== null && close !== null && prevClose > 0) {
          const change = Math.abs(close / prevClose - 1);
          const documented = bar.corporateActions.splitFactor !== null || prevBar.corporateActions.splitFactor !== null;
          if (change > splitSuspectThreshold && !documented) {
            stats.splitSuspects.push(bar.sessionDate);
            warnings.push(`probable undocumented split/data issue at ${bar.sessionDate} (|change|=${(change * 100).toFixed(1)}%)`);
          }
        }
      }
    }
    prevBar = bar;
  }

  return { problems, warnings, stats };
}
