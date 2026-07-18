/**
 * Plain-text reporting for stdout. No colors, no external deps.
 */

/** @param {number|null} v @param {number} [digits] @returns {string} */
export function fmt(v, digits = 2) {
  if (v === null || v === undefined) return 'null';
  return v.toFixed(digits);
}

/**
 * One-line summary of a backtest result.
 * @param {Object} result BacktestResultV1
 * @returns {string}
 */
export function backtestSummaryLine(result) {
  const m = result.metrics;
  return [
    result.symbol.padEnd(6),
    result.strategyId.padEnd(12),
    `net ${fmt(m.totalReturnNetPct)}%`,
    `dd ${fmt(m.maxDrawdownPct)}%`,
    `trades ${m.tradeCount}${m.openTradeCount ? `+${m.openTradeCount}open` : ''}`,
    `expo ${fmt(m.exposurePct, 1)}%`,
  ].join('  ');
}

/**
 * Render an aligned table.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

/**
 * Full multi-line report for one backtest result.
 * @param {Object} result
 * @returns {string}
 */
export function backtestConsoleReport(result) {
  const m = result.metrics;
  const lines = [
    `=== ${result.label} — ${result.symbol} / ${result.strategyId} (${result.strategyVersion}) ===`,
    `priceBasis=${result.priceBasis}  bars=${result.bars}  ${result.firstDate} -> ${result.lastDate}`,
    `params=${JSON.stringify(result.parameters)}`,
    `costs: capital=${result.costsConfig.initialCapital} commission=${JSON.stringify(result.costsConfig.commission)} slippage=${JSON.stringify(result.costsConfig.slippage)}`,
    `totalReturn: gross=${fmt(m.totalReturnGrossPct)}% net=${fmt(m.totalReturnNetPct)}%  cagr=${fmt(m.cagrPct)}%`,
    `risk: vol=${fmt(m.annualizedVolPct)}% maxDD=${fmt(m.maxDrawdownPct)}% sharpe=${fmt(m.sharpe)} sortino=${fmt(m.sortino)} calmar=${fmt(m.calmar)}`,
    `trades: n=${m.tradeCount} (+${m.openTradeCount} open) winRate=${fmt(m.winRatePct, 1)}% avgWin=${fmt(m.avgWinPct)}% avgLoss=${fmt(m.avgLossPct)}% expectancy=${fmt(m.expectancyPct)}% pf=${fmt(m.profitFactor)}`,
    `excursions: MFE=${fmt(m.avgMfePct)}% MAE=${fmt(m.avgMaePct)}% capture=${fmt(m.mfeCapturePct, 1)}% giveback=${fmt(m.avgGivebackPct)}% falseExits=${m.falseExits ?? 'null'}`,
    `activity: exposure=${fmt(m.exposurePct, 1)}% cash=${fmt(m.timeInCashPct, 1)}% turnover=${fmt(m.turnover)} commissions=${fmt(m.totalCommissions)} slippage=${fmt(m.totalSlippage)}`,
    `resultHash=${result.resultHash}`,
  ];
  if (Object.keys(result.metricReasons).length > 0) {
    lines.push(`null metrics: ${Object.entries(result.metricReasons).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (result.warnings.length > 0) {
    lines.push('warnings:');
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}
