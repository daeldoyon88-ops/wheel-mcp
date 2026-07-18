/**
 * Causal daily backtest engine (V1, long-only, single symbol, whole shares,
 * cash account, no margin).
 *
 * Temporal invariants enforced here:
 *  - a decision uses only the feature snapshot of close t;
 *  - a decision at close t is executed at the earliest at open t+1
 *    (createOrder/createFill throw on any same-session fill);
 *  - a stop decided at close t is active from session t+1 only;
 *  - a gap through the stop fills at the open (with gap slippage), never at
 *    the stop level;
 *  - results contain no wall-clock timestamps and hash deterministically.
 */

import { createOrder } from '../contracts/orderV1.mjs';
import { createFill } from '../contracts/fillV1.mjs';
import { TRADE_SCHEMA_VERSION } from '../contracts/tradeV1.mjs';
import { withResultHash, BACKTEST_RESULT_SCHEMA_VERSION } from '../contracts/backtestResultV1.mjs';
import { strategyProblems } from '../strategy/strategyInterface.mjs';
import { createCommissionModel } from '../execution/commissionModel.mjs';
import { createSlippageModel } from '../execution/slippageModel.mjs';
import { sizeAllInBuy, marketOpenFill } from '../execution/fillModel.mjs';
import { resolveLongStopFill } from '../execution/stopFillModel.mjs';
import { openPosition, updatePositionOnClose } from './positionState.mjs';
import { createPortfolio, markEquity } from './portfolioState.mjs';
import { computeFeatureSnapshots } from '../features/featureEngine.mjs';
import { computeAllMetrics } from '../metrics/aggregateMetrics.mjs';

export const ENGINE_VERSION = 'backtestEngine/1';

/**
 * @typedef {Object} BacktestInput
 * @property {string} symbol
 * @property {import('../data/selectPriceBasis.mjs').BasisBar[]} series coherent price basis series
 * @property {string} priceBasis
 * @property {import('../strategy/strategyInterface.mjs').StrategyV1} strategy
 * @property {Object} [params]
 * @property {number} [initialCapital]
 * @property {Object} [commission] CommissionModel config
 * @property {Object} [slippage] SlippageModel config
 * @property {Record<string, import('../data/selectPriceBasis.mjs').BasisBar[]>} [benchmarks]
 * @property {Map<string, Object>} [regimeByDate]
 * @property {import('../contracts/featureSnapshotV1.mjs').FeatureSnapshotV1[]} [precomputedSnapshots]
 * @property {string[]} [seriesWarnings]
 */

/**
 * Run one deterministic backtest.
 * @param {BacktestInput} input
 * @returns {Object} BacktestResultV1
 */
export function runBacktest(input) {
  const problems = strategyProblems(input.strategy);
  if (problems.length > 0) throw new Error(`Invalid strategy: ${problems.join('; ')}`);
  const series = input.series;
  if (!Array.isArray(series) || series.length === 0) throw new Error('runBacktest: empty series');
  const strategy = input.strategy;
  const params = { ...strategy.defaultParams, ...(input.params ?? {}) };
  const initialCapital = input.initialCapital ?? 100000;
  const commissionModel = createCommissionModel(input.commission ?? {});
  const slippageModel = createSlippageModel(input.slippage ?? {});
  const portfolio = createPortfolio(initialCapital);
  const warnings = [...(input.seriesWarnings ?? [])];

  const snapshots = input.precomputedSnapshots ?? computeFeatureSnapshots({
    symbol: input.symbol,
    series,
    priceBasis: input.priceBasis,
    benchmarks: input.benchmarks,
  });
  if (snapshots.length !== series.length) throw new Error('snapshots/series length mismatch');

  /** @type {Object|null} */
  let pendingOrder = null;
  /** @type {number|null} */
  let pendingStop = null;
  /** @type {number|null} */
  let activeStop = null;
  /** @type {Object|null} */
  let openTrade = null;
  const signalCounts = {};

  /**
   * @param {Object} fillInput
   * @param {number} t
   */
  function executeExit(fillInput, t) {
    const position = portfolio.position;
    const quantity = fillInput.quantity;
    const fill = createFill(fillInput.fill);
    portfolio.fills.push(fill);
    portfolio.cash += quantity * fill.fillPrice - fill.commission;
    portfolio.totalCommissions += fill.commission;
    portfolio.totalSlippage += fill.slippageCost;
    portfolio.totalTradedNotional += quantity * fill.fillPrice;
    position.realizedPnl += quantity * (fill.fillPrice - position.averageCost) - fill.commission;
    position.commissions += fill.commission;
    position.slippage += fill.slippageCost;

    if (quantity >= position.quantity) {
      // Full exit -> close the trade.
      position.state = 'CLOSED';
      position.exitReasons = fillInput.reasons;
      const entryNotional = openTrade.entryPrice * openTrade.maxQuantity;
      const realized = openTrade.partialRealized + quantity * (fill.fillPrice - openTrade.entryPrice)
        - openTrade.entryCommissionShare * quantity - fill.commission;
      const trade = {
        schemaVersion: TRADE_SCHEMA_VERSION,
        symbol: input.symbol,
        entryDate: openTrade.entryDate,
        entryIndex: openTrade.entryIndex,
        exitDate: fill.fillDate,
        exitIndex: t,
        entryPrice: openTrade.entryPrice,
        exitPrice: fill.fillPrice,
        maxQuantity: openTrade.maxQuantity,
        realizedPnl: realized,
        commissions: position.commissions,
        slippage: position.slippage,
        returnPct: entryNotional > 0 ? (realized / entryNotional) * 100 : null,
        mfePct: position.mfePct,
        maePct: position.maePct,
        barsHeld: position.barsHeld,
        open: false,
        entryReasons: position.entryReasons,
        exitReasons: fillInput.reasons,
        exitKind: fill.kind,
      };
      portfolio.trades.push(trade);
      portfolio.position = null;
      openTrade = null;
      activeStop = null;
      pendingStop = null;
    } else {
      position.quantity -= quantity;
      position.partialExits.push({ date: fill.fillDate, quantity, price: fill.fillPrice });
      openTrade.partialRealized += quantity * (fill.fillPrice - openTrade.entryPrice)
        - openTrade.entryCommissionShare * quantity - fill.commission;
    }
  }

  for (let t = 0; t < series.length; t++) {
    const bar = series[t];

    // 1. Stop decided at close t-1 becomes active for this session.
    if (pendingStop !== null) {
      activeStop = pendingStop;
      pendingStop = null;
    }

    // 2. Pending market-on-open order decided at close t-1.
    if (pendingOrder !== null) {
      const order = pendingOrder;
      pendingOrder = null;
      if (order.type === 'MARKET_OPEN_BUY' && portfolio.position === null) {
        const { referencePrice, fillPrice, slippagePerShare } = marketOpenFill({ open: bar.open, side: 'BUY', slippageModel });
        const sized = sizeAllInBuy({ cash: portfolio.cash, fillPrice, commissionModel });
        if (sized === null) {
          portfolio.warnings.push(`${bar.sessionDate}: cash ${portfolio.cash.toFixed(2)} cannot afford 1 share at ${fillPrice.toFixed(4)}; entry skipped`);
        } else {
          const fill = createFill({
            symbol: input.symbol,
            kind: 'OPEN_BUY',
            decisionDate: order.decisionDate,
            fillDate: bar.sessionDate,
            quantity: sized.quantity,
            referencePrice,
            fillPrice,
            slippageCost: slippagePerShare * sized.quantity,
            commission: sized.commission,
            notes: order.reasons,
          });
          portfolio.fills.push(fill);
          portfolio.cash -= sized.quantity * fillPrice + sized.commission;
          portfolio.totalCommissions += sized.commission;
          portfolio.totalSlippage += fill.slippageCost;
          portfolio.totalTradedNotional += sized.quantity * fillPrice;
          portfolio.position = openPosition({
            symbol: input.symbol,
            quantity: sized.quantity,
            entryDate: bar.sessionDate,
            entryPrice: fillPrice,
            commission: sized.commission,
            slippagePerShare,
            entryReasons: order.reasons,
          });
          portfolio.everEntered = true;
          openTrade = {
            entryDate: bar.sessionDate,
            entryIndex: t,
            entryPrice: fillPrice,
            maxQuantity: sized.quantity,
            entryCommissionShare: sized.commission / sized.quantity,
            partialRealized: 0,
          };
        }
      } else if (order.type === 'MARKET_OPEN_SELL' && portfolio.position !== null) {
        const position = portfolio.position;
        const quantity = order.fraction !== null
          ? Math.max(1, Math.floor(position.quantity * order.fraction))
          : position.quantity;
        const { referencePrice, fillPrice, slippagePerShare } = marketOpenFill({ open: bar.open, side: 'SELL', slippageModel });
        executeExit({
          quantity,
          reasons: order.reasons,
          fill: {
            symbol: input.symbol,
            kind: 'OPEN_SELL',
            decisionDate: order.decisionDate,
            fillDate: bar.sessionDate,
            quantity: -quantity,
            referencePrice,
            fillPrice,
            slippageCost: slippagePerShare * quantity,
            commission: commissionModel.compute(quantity),
            notes: order.reasons,
          },
        }, t);
      }
    }

    // 3. Active protective stop (decided at a previous close only).
    if (portfolio.position !== null && activeStop !== null) {
      const stopFill = resolveLongStopFill({ stopLevel: activeStop, open: bar.open, low: bar.low, slippageModel });
      if (stopFill !== null) {
        const position = portfolio.position;
        const quantity = position.quantity;
        executeExit({
          quantity,
          reasons: [`${stopFill.kind} at ${activeStop}`],
          fill: {
            symbol: input.symbol,
            kind: stopFill.kind,
            decisionDate: position.lastStopDecisionDate ?? series[Math.max(0, t - 1)].sessionDate,
            fillDate: bar.sessionDate,
            quantity: -quantity,
            referencePrice: stopFill.referencePrice,
            fillPrice: stopFill.fillPrice,
            slippageCost: stopFill.slippagePerShare * quantity,
            commission: commissionModel.compute(quantity),
            notes: [`stop level ${activeStop}`, `session open ${bar.open}`],
          },
        }, t);
      }
    }

    // 4. Close of session t: update position, then decide for t+1.
    if (portfolio.position !== null) {
      updatePositionOnClose(portfolio.position, bar);
      portfolio.position.lastStop = activeStop;
    }

    const snapshot = snapshots[t];
    const regime = input.regimeByDate ? input.regimeByDate.get(bar.sessionDate) ?? null : null;
    const decision = strategy.decide({
      symbol: input.symbol,
      index: t,
      sessionDate: bar.sessionDate,
      decisionTime: bar.eventTime,
      close: bar.close,
      features: snapshot.features,
      regime,
      position: portfolio.position,
      everEntered: portfolio.everEntered,
      params,
    });
    signalCounts[decision.intent] = (signalCounts[decision.intent] ?? 0) + 1;

    const hasNext = t + 1 < series.length;
    const nextDate = hasNext ? series[t + 1].sessionDate : null;
    if (decision.intent === 'ENTER_LONG' && portfolio.position === null) {
      if (hasNext) {
        pendingOrder = createOrder({
          symbol: input.symbol,
          type: 'MARKET_OPEN_BUY',
          decisionDate: bar.sessionDate,
          earliestFillDate: nextDate,
          reasons: decision.reasons,
          strategyId: strategy.id,
        });
      } else {
        portfolio.warnings.push(`${bar.sessionDate}: ENTER_LONG at final bar cannot be executed (no next session)`);
      }
    } else if (decision.intent === 'EXIT' && portfolio.position !== null) {
      if (hasNext) {
        pendingOrder = createOrder({
          symbol: input.symbol,
          type: 'MARKET_OPEN_SELL',
          decisionDate: bar.sessionDate,
          earliestFillDate: nextDate,
          reasons: decision.reasons,
          strategyId: strategy.id,
        });
      } else {
        portfolio.warnings.push(`${bar.sessionDate}: EXIT at final bar cannot be executed (position stays open)`);
      }
    } else if ((decision.intent === 'REDUCE_25' || decision.intent === 'REDUCE_50') && portfolio.position !== null) {
      if (hasNext) {
        pendingOrder = createOrder({
          symbol: input.symbol,
          type: 'MARKET_OPEN_SELL',
          decisionDate: bar.sessionDate,
          earliestFillDate: nextDate,
          fraction: decision.intent === 'REDUCE_25' ? 0.25 : 0.5,
          reasons: decision.reasons,
          strategyId: strategy.id,
        });
      }
    }

    if (decision.stopLevel !== null && portfolio.position !== null) {
      // Active from next session (never triggers on this session's own range).
      pendingStop = decision.stopLevel;
      portfolio.position.lastStop = decision.stopLevel;
      portfolio.position.lastStopDecisionDate = bar.sessionDate;
    }

    markEquity(portfolio, bar);
  }

  // End of data: an open position is flagged, never silently closed.
  if (portfolio.position !== null && openTrade !== null) {
    const position = portfolio.position;
    portfolio.trades.push({
      schemaVersion: TRADE_SCHEMA_VERSION,
      symbol: input.symbol,
      entryDate: openTrade.entryDate,
      entryIndex: openTrade.entryIndex,
      exitDate: null,
      exitIndex: null,
      entryPrice: openTrade.entryPrice,
      exitPrice: null,
      maxQuantity: openTrade.maxQuantity,
      realizedPnl: openTrade.partialRealized,
      commissions: position.commissions,
      slippage: position.slippage,
      returnPct: null,
      mfePct: position.mfePct,
      maePct: position.maePct,
      barsHeld: position.barsHeld,
      open: true,
      entryReasons: position.entryReasons,
      exitReasons: ['end of data (position still open, marked to market in equity)'],
      exitKind: 'END_OF_DATA_OPEN',
    });
    portfolio.warnings.push('position open at end of data; equity metrics include mark-to-market, trade stats exclude it');
  }

  const closes = series.map((b) => b.close);
  const { metrics, metricReasons } = computeAllMetrics({
    equityCurve: portfolio.equityCurve,
    initialCapital,
    trades: portfolio.trades,
    closes,
    firstDate: series[0].sessionDate,
    lastDate: series[series.length - 1].sessionDate,
    totalCommissions: portfolio.totalCommissions,
    totalSlippage: portfolio.totalSlippage,
    totalTradedNotional: portfolio.totalTradedNotional,
  });

  const result = {
    schemaVersion: BACKTEST_RESULT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    label: 'PILOT_TECHNICAL_ONLY',
    symbol: input.symbol,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    parameters: params,
    priceBasis: input.priceBasis,
    costsConfig: {
      initialCapital,
      commission: commissionModel.config,
      slippage: slippageModel.config,
    },
    firstDate: series[0].sessionDate,
    lastDate: series[series.length - 1].sessionDate,
    bars: series.length,
    signalCounts,
    trades: portfolio.trades,
    fills: portfolio.fills,
    equityCurve: portfolio.equityCurve,
    metrics,
    metricReasons,
    warnings: [...warnings, ...portfolio.warnings],
  };
  return withResultHash(result);
}
