/**
 * Relative strength versus a benchmark, aligned by civil session date.
 * Missing reasons are precise:
 *  - BENCHMARK_UNAVAILABLE when no benchmark series was provided/loaded;
 *  - BENCHMARK_DATE_MISSING when a series exists but the needed date is absent.
 * Never invent a neutral substitute value.
 */

import { rocSeries } from './momentum.mjs';
import { slopeSeries } from './movingAverages.mjs';
import { MISSING_REASONS } from '../contracts/missingReasonsV1.mjs';

/**
 * Map benchmark closes by sessionDate.
 * @param {{sessionDate: string, close: number|null}[]} benchmarkSeries
 * @returns {Map<string, number|null>}
 */
export function benchmarkCloseByDate(benchmarkSeries) {
  const map = new Map();
  for (const b of benchmarkSeries) map.set(b.sessionDate, b.close);
  return map;
}

/**
 * Compute relative-strength series for a ticker against one benchmark.
 * Outputs are aligned to the ticker's own dates.
 * @param {{sessionDate: string, close: number|null}[]} tickerSeries
 * @param {{sessionDate: string, close: number|null}[]|null} benchmarkSeries
 * @returns {{
 *   ratio: (number|null)[],
 *   relReturn20: (number|null)[],
 *   relReturn60: (number|null)[],
 *   ratioSlope20: (number|null)[],
 *   benchmarkMissing: boolean[],
 *   benchmarkMissingReason: (string|null)[],
 * }}
 */
export function relativeStrengthSeries(tickerSeries, benchmarkSeries) {
  const n = tickerSeries.length;
  const benchmarkMissing = new Array(n).fill(true);
  /** @type {(string|null)[]} */
  const benchmarkMissingReason = new Array(n).fill(MISSING_REASONS.BENCHMARK_UNAVAILABLE);
  const ratio = new Array(n).fill(null);
  /** @type {(number|null)[]} */
  const benchClose = new Array(n).fill(null);

  const seriesProvided = Array.isArray(benchmarkSeries) && benchmarkSeries.length > 0;
  if (!seriesProvided) {
    // Keep defaults: every index BENCHMARK_UNAVAILABLE.
  } else {
    const byDate = benchmarkCloseByDate(benchmarkSeries);
    for (let i = 0; i < n; i++) {
      const t = tickerSeries[i];
      if (!byDate.has(t.sessionDate)) {
        benchmarkMissing[i] = true;
        benchmarkMissingReason[i] = MISSING_REASONS.BENCHMARK_DATE_MISSING;
        continue;
      }
      const b = byDate.get(t.sessionDate);
      if (b === null || b === undefined) {
        benchmarkMissing[i] = true;
        benchmarkMissingReason[i] = MISSING_REASONS.BENCHMARK_DATE_MISSING;
        continue;
      }
      benchmarkMissing[i] = false;
      benchmarkMissingReason[i] = null;
      benchClose[i] = b;
      if (t.close !== null && b !== 0) ratio[i] = t.close / b;
    }
  }

  const tickerClose = tickerSeries.map((t) => t.close);
  const tickerRoc20 = rocSeries(tickerClose, 20);
  const tickerRoc60 = rocSeries(tickerClose, 60);
  const benchRoc20 = rocSeries(benchClose, 20);
  const benchRoc60 = rocSeries(benchClose, 60);
  const relReturn20 = tickerRoc20.map((r, i) => (r === null || benchRoc20[i] === null ? null : r - /** @type {number} */ (benchRoc20[i])));
  const relReturn60 = tickerRoc60.map((r, i) => (r === null || benchRoc60[i] === null ? null : r - /** @type {number} */ (benchRoc60[i])));
  const ratioSlope20 = slopeSeries(ratio, 20);

  return { ratio, relReturn20, relReturn60, ratioSlope20, benchmarkMissing, benchmarkMissingReason };
}
