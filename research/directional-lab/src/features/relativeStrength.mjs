/**
 * Relative strength versus a benchmark, aligned by civil session date.
 * When the benchmark has no bar for a date, the feature is null with reason
 * BENCHMARK_UNAVAILABLE — never an artificial neutral value.
 */

import { rocSeries } from './momentum.mjs';
import { slopeSeries } from './movingAverages.mjs';

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
 * @returns {{ratio: (number|null)[], relReturn20: (number|null)[], relReturn60: (number|null)[], ratioSlope20: (number|null)[], benchmarkMissing: boolean[]}}
 */
export function relativeStrengthSeries(tickerSeries, benchmarkSeries) {
  const n = tickerSeries.length;
  const benchmarkMissing = new Array(n).fill(true);
  const ratio = new Array(n).fill(null);
  /** @type {(number|null)[]} */
  const benchClose = new Array(n).fill(null);

  if (benchmarkSeries && benchmarkSeries.length > 0) {
    const byDate = benchmarkCloseByDate(benchmarkSeries);
    for (let i = 0; i < n; i++) {
      const t = tickerSeries[i];
      const b = byDate.get(t.sessionDate);
      if (b !== undefined && b !== null) {
        benchmarkMissing[i] = false;
        benchClose[i] = b;
        if (t.close !== null && b !== 0) ratio[i] = t.close / b;
      }
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

  return { ratio, relReturn20, relReturn60, ratioSlope20, benchmarkMissing };
}
