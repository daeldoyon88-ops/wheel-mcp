#!/usr/bin/env node
/**
 * Directional Lab CLI — research-only, read-only over sources, deterministic.
 *
 * Commands:
 *   validate       --symbol S --input PATH [--ohlc-basis B]
 *   manifest       --symbol S --input PATH [--ohlc-basis B] [--output PATH]
 *   features       --symbol S --input PATH --price-basis B [--date YYYY-MM-DD] [--output PATH]
 *   backtest       --symbol S --input PATH --strategy ID --price-basis B [--output PATH]
 *   pilot          [--output PATH]
 *   universe-check
 *
 * Nothing is written unless --output is given explicitly.
 * No network access. No production import. PILOT_TECHNICAL_ONLY.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadJsonDaily } from './data/jsonDailyAdapter.mjs';
import { loadCsvDaily } from './data/csvDailyAdapter.mjs';
import { validateDailyBars } from './data/validateDailyBars.mjs';
import { buildDatasetManifest } from './data/buildDatasetManifest.mjs';
import { buildQualityReport } from './data/qualityReport.mjs';
import { selectPriceBasis } from './data/selectPriceBasis.mjs';
import { computeFeatureSnapshots } from './features/featureEngine.mjs';
import { runBacktest } from './backtest/backtestEngine.mjs';
import { buyAndHoldBaseline } from './strategy/buyAndHoldBaseline.mjs';
import { ma50Baseline } from './strategy/ma50Baseline.mjs';
import { ema21Ema50Baseline } from './strategy/ema21Ema50Baseline.mjs';
import { trendAtrBaseline } from './strategy/trendAtrBaseline.mjs';
import { backtestConsoleReport, renderTable, fmt } from './reporting/consoleReport.mjs';
import { prettyStableJson, writeJsonReport } from './reporting/jsonReport.mjs';
import { renderQualityReport } from './reporting/dataQualityReport.mjs';

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(LAB_ROOT, '..', '..');

export const STRATEGIES = Object.freeze({
  BUY_HOLD: buyAndHoldBaseline,
  MA50: ma50Baseline,
  EMA21_EMA50: ema21Ema50Baseline,
  TREND_ATR: trendAtrBaseline,
});

/**
 * @param {string[]} argv
 * @returns {{command: string|null, options: Record<string, string>}}
 */
export function parseArgs(argv) {
  const options = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        options[key] = 'true';
      } else {
        options[key] = value;
        i++;
      }
    } else if (command === null) {
      command = a;
    }
  }
  return { command, options };
}

/** @param {string} p @returns {string} */
function resolveInput(p) {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

/**
 * @param {{symbol: string, input: string, ohlcBasis?: string}} args
 * @returns {{bars: Array, sourceMeta: Object, format: string, sourcePath: string}}
 */
function loadInput(args) {
  const sourcePath = resolveInput(args.input);
  const ohlcBasis = /** @type {any} */ (args.ohlcBasis ?? 'SPLIT_ADJUSTED');
  if (sourcePath.endsWith('.csv')) {
    const r = loadCsvDaily(sourcePath, { symbol: args.symbol, ohlcBasis: /** @type {any} */ (args.ohlcBasis ?? 'RAW') });
    return { ...r, sourcePath };
  }
  const r = loadJsonDaily(sourcePath, { symbol: args.symbol, ohlcBasis });
  return { ...r, sourcePath };
}

/** @param {Record<string, string>} options @param {string[]} required */
function requireOptions(options, required) {
  const missing = required.filter((r) => !options[r]);
  if (missing.length > 0) throw new Error(`Missing required option(s): ${missing.map((m) => `--${m}`).join(', ')}`);
}

function cmdValidate(options) {
  requireOptions(options, ['symbol', 'input']);
  const loaded = loadInput({ symbol: options.symbol, input: options.input, ohlcBasis: options['ohlc-basis'] });
  const { manifest, validation } = buildDatasetManifest({
    sourcePath: loaded.sourcePath,
    symbol: options.symbol,
    format: loaded.format,
    bars: loaded.bars,
    sourceMeta: loaded.sourceMeta,
  });
  const report = buildQualityReport({ manifest, validation });
  console.log(`config: symbol=${options.symbol} input=${loaded.sourcePath} ohlcBasis=${options['ohlc-basis'] ?? 'SPLIT_ADJUSTED (json default)'}`);
  console.log(renderQualityReport(report));
  if (!report.admissible) process.exitCode = 1;
}

function cmdManifest(options) {
  requireOptions(options, ['symbol', 'input']);
  const loaded = loadInput({ symbol: options.symbol, input: options.input, ohlcBasis: options['ohlc-basis'] });
  const { manifest } = buildDatasetManifest({
    sourcePath: loaded.sourcePath,
    symbol: options.symbol,
    format: loaded.format,
    bars: loaded.bars,
    sourceMeta: loaded.sourceMeta,
  });
  if (options.output) {
    writeJsonReport(resolveInput(options.output), manifest);
    console.log(`manifest written to ${resolveInput(options.output)}`);
  } else {
    console.log(prettyStableJson(manifest));
  }
}

function cmdFeatures(options) {
  requireOptions(options, ['symbol', 'input']);
  const priceBasis = /** @type {any} */ (options['price-basis'] ?? 'SPLIT_ADJUSTED');
  const loaded = loadInput({ symbol: options.symbol, input: options.input, ohlcBasis: options['ohlc-basis'] });
  const { series, warnings } = selectPriceBasis(loaded.bars, priceBasis);
  const benchmarks = {};
  if (options['benchmark-input'] && options['benchmark-symbol']) {
    const bench = loadInput({ symbol: options['benchmark-symbol'], input: options['benchmark-input'] });
    benchmarks[options['benchmark-symbol']] = selectPriceBasis(bench.bars, priceBasis).series;
  }
  const snapshots = computeFeatureSnapshots({ symbol: options.symbol, series, priceBasis, benchmarks });
  console.log(`config: symbol=${options.symbol} priceBasis=${priceBasis} bars=${series.length}`);
  console.log(`coverage: ${series[0].sessionDate} -> ${series[series.length - 1].sessionDate}`);
  for (const w of warnings) console.log(`warning: ${w}`);
  const targetDate = options.date ?? series[series.length - 1].sessionDate;
  const snapshot = snapshots.find((s) => s.sessionDate === targetDate);
  if (!snapshot) throw new Error(`No snapshot for date ${targetDate}`);
  if (options.output) {
    writeJsonReport(resolveInput(options.output), snapshots);
    console.log(`all ${snapshots.length} snapshots written to ${resolveInput(options.output)}`);
  }
  console.log(`snapshot ${targetDate}:`);
  console.log(prettyStableJson(snapshot));
}

function cmdBacktest(options) {
  requireOptions(options, ['symbol', 'input', 'strategy']);
  const strategy = STRATEGIES[options.strategy];
  if (!strategy) throw new Error(`Unknown strategy "${options.strategy}" (available: ${Object.keys(STRATEGIES).join(', ')})`);
  const priceBasis = /** @type {any} */ (options['price-basis'] ?? 'SPLIT_ADJUSTED');
  const costs = loadBaselineConfig();
  const loaded = loadInput({ symbol: options.symbol, input: options.input, ohlcBasis: options['ohlc-basis'] });
  const validation = validateDailyBars(loaded.bars);
  if (validation.problems.length > 0) {
    throw new Error(`Input refused (${validation.problems.length} problems), first: ${validation.problems[0]}`);
  }
  const { series, warnings } = selectPriceBasis(loaded.bars, priceBasis);
  const result = runBacktest({
    symbol: options.symbol,
    series,
    priceBasis,
    strategy,
    initialCapital: costs.initialCapital,
    commission: costs.commission,
    slippage: costs.slippage,
    seriesWarnings: [...warnings, ...validation.warnings.slice(0, 5)],
  });
  console.log(backtestConsoleReport(result));
  if (options.output) {
    writeJsonReport(resolveInput(options.output), result);
    console.log(`full result written to ${resolveInput(options.output)}`);
  }
}

/** @returns {{initialCapital: number, commission: Object, slippage: Object}} */
function loadBaselineConfig() {
  const raw = JSON.parse(readFileSync(resolve(LAB_ROOT, 'config', 'baseline-configs.v1.json'), 'utf8'));
  return { initialCapital: raw.initialCapital, commission: raw.commission, slippage: raw.slippage };
}

function cmdPilot(options) {
  const config = JSON.parse(readFileSync(resolve(LAB_ROOT, 'config', 'pilot-universe.v1.json'), 'utf8'));
  const costs = loadBaselineConfig();
  console.log('=== PILOT_TECHNICAL_ONLY — pipeline verification, NOT a strategy ranking, NOT a recommendation ===');
  console.log(`costs: capital=${costs.initialCapital} commission=${JSON.stringify(costs.commission)} slippage=${JSON.stringify(costs.slippage)}`);
  const headers = ['symbol', 'source', 'firstDate', 'lastDate', 'bars', 'priceBasis', 'strategy', 'grossRet%', 'netRet%', 'maxDD%', 'trades', 'expo%', 'commission', 'slippage', 'warnings'];
  const rows = [];
  const fullResults = [];
  for (const entry of config.entries) {
    if (!entry.admissible) {
      rows.push([entry.symbol, entry.sourcePath ?? 'n/a', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', `refused: ${entry.reason}`]);
      continue;
    }
    let loaded;
    try {
      loaded = loadInput({ symbol: entry.symbol, input: entry.sourcePath, ohlcBasis: entry.ohlcBasis });
    } catch (err) {
      rows.push([entry.symbol, entry.sourcePath, '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', '-', `load failed: ${/** @type {Error} */ (err).message}`]);
      continue;
    }
    const validation = validateDailyBars(loaded.bars);
    if (validation.problems.length > 0) {
      rows.push([entry.symbol, entry.sourcePath, '-', '-', String(loaded.bars.length), '-', '-', '-', '-', '-', '-', '-', '-', '-', `refused: ${validation.problems[0]}`]);
      continue;
    }
    const { series, warnings } = selectPriceBasis(loaded.bars, entry.priceBasis);
    const snapshots = computeFeatureSnapshots({ symbol: entry.symbol, series, priceBasis: entry.priceBasis });
    for (const strategyId of ['BUY_HOLD', 'MA50', 'EMA21_EMA50', 'TREND_ATR']) {
      const result = runBacktest({
        symbol: entry.symbol,
        series,
        priceBasis: entry.priceBasis,
        strategy: STRATEGIES[strategyId],
        initialCapital: costs.initialCapital,
        commission: costs.commission,
        slippage: costs.slippage,
        precomputedSnapshots: snapshots,
        seriesWarnings: warnings,
      });
      fullResults.push(result);
      const m = result.metrics;
      const warnLabel = result.warnings.length > 0 ? `${result.warnings.length} warning(s)` : '';
      rows.push([
        entry.symbol,
        entry.sourceGitStatus,
        result.firstDate,
        result.lastDate,
        String(result.bars),
        entry.priceBasis,
        strategyId,
        fmt(m.totalReturnGrossPct, 1),
        fmt(m.totalReturnNetPct, 1),
        fmt(m.maxDrawdownPct, 1),
        `${m.tradeCount}${m.openTradeCount ? `+${m.openTradeCount}o` : ''}`,
        fmt(m.exposurePct, 0),
        fmt(m.totalCommissions, 0),
        fmt(m.totalSlippage, 0),
        warnLabel,
      ]);
    }
  }
  console.log(renderTable(headers, rows));
  console.log('warnings legend: run backtest command per symbol for details.');
  console.log('PILOT_TECHNICAL_ONLY: results validate the pipeline (dates, causal fills, metrics, reproducibility) and are NOT financial recommendations.');
  if (options.output) {
    writeJsonReport(resolveInput(options.output), fullResults);
    console.log(`full results written to ${resolveInput(options.output)}`);
  }
}

function cmdUniverseCheck() {
  const config = JSON.parse(readFileSync(resolve(LAB_ROOT, 'config', 'research-universe.v1.json'), 'utf8'));
  const entries = config.entries;
  const REQUIRED_FIELDS = ['symbol', 'canonicalSymbol', 'name', 'category', 'sector', 'industry', 'aiExposure', 'aiRole', 'assetType', 'leveraged', 'benchmark', 'sectorBenchmark', 'researchOnly', 'inclusionReason', 'dataStatus'];
  const ALLOWED_EXPOSURES = ['AI_DIRECT', 'AI_INFRASTRUCTURE', 'AI_ENABLER', 'AI_PLATFORM', 'AI_ADOPTER', 'AI_SPECULATIVE', 'AI_ETF', 'NON_AI_CONTROL'];
  const problems = [];
  const seen = new Map();
  for (const e of entries) {
    for (const f of REQUIRED_FIELDS) {
      if (e[f] === undefined) problems.push(`${e.symbol ?? '?'}: missing field ${f}`);
    }
    if (e.aiExposure && !ALLOWED_EXPOSURES.includes(e.aiExposure)) problems.push(`${e.symbol}: invalid aiExposure ${e.aiExposure}`);
    if (e.researchOnly !== true) problems.push(`${e.symbol}: researchOnly must be true`);
    if (seen.has(e.canonicalSymbol)) problems.push(`duplicate canonicalSymbol: ${e.canonicalSymbol}`);
    seen.set(e.canonicalSymbol, e);
  }
  const deduped = seen.size;
  const byCategory = {};
  const byExposure = {};
  for (const e of seen.values()) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    byExposure[e.aiExposure] = (byExposure[e.aiExposure] ?? 0) + 1;
  }
  console.log(`universe: ${config.schemaVersion} (${config.universeVersion})`);
  console.log(`entries listed: ${entries.length}`);
  console.log(`entries after dedup (canonicalSymbol): ${deduped}`);
  console.log('by category:');
  for (const [k, v] of Object.entries(byCategory).sort()) console.log(`  ${k}: ${v}`);
  console.log('by aiExposure:');
  for (const [k, v] of Object.entries(byExposure).sort()) console.log(`  ${k}: ${v}`);
  const chps = entries.find((e) => e.symbol === 'CHPS');
  if (chps) console.log(`CHPS: symbolResolutionRequired=${chps.symbolResolutionRequired} aliases=${(chps.aliases ?? []).join(',')}`);
  for (const p of problems) console.log(`problem: ${p}`);
  if (deduped !== 120) {
    console.log(`FAIL: expected exactly 120 entries after dedup, got ${deduped}`);
    process.exitCode = 1;
    return;
  }
  if (problems.length > 0) {
    console.log(`FAIL: ${problems.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('OK: exactly 120 unique research-only entries, all fields valid.');
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  try {
    switch (command) {
      case 'validate': cmdValidate(options); break;
      case 'manifest': cmdManifest(options); break;
      case 'features': cmdFeatures(options); break;
      case 'backtest': cmdBacktest(options); break;
      case 'pilot': cmdPilot(options); break;
      case 'universe-check': cmdUniverseCheck(); break;
      default:
        console.log('Usage: node research/directional-lab/src/cli.mjs <validate|manifest|features|backtest|pilot|universe-check> [options]');
        console.log('Research-only lab. Nothing is written without --output. No network. No production coupling.');
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`error: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
