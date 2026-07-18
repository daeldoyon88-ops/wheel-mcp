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
 *  - corporate actions are handled before the open of their effective
 *    session, per the canonical per-basis policy (corporateActionPolicy.mjs):
 *    RAW splits adjust the position, cash dividends are credited causally on
 *    the quantity held at the previous close, embedded actions are never
 *    applied twice;
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
import { openPosition, updatePositionOnClose, applySplitToPosition, scaleWholeQuantity } from './positionState.mjs';
import { createPortfolio, markEquity } from './portfolioState.mjs';
import {
  corporateActionPolicyFor,
  ERROR_CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED,
  ERROR_CORPORATE_ACTION_ORDER_AMBIGUOUS,
} from '../data/corporateActionPolicy.mjs';
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
  const caPolicy = corporateActionPolicyFor(input.priceBasis);

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

    // 0. Corporate actions effective before this session's open, before any
    //    order or stop is processed (policy: corporateActionPolicy.mjs).
    //    Dividend entitlement is causal: the eligible quantity is the
    //    position held at close t-1 (nothing of session t has executed yet
    //    at this point in the loop), so a sell filling at this open keeps
    //    the dividend and a buy filling at this open does not receive it.
    {
      const declaredSplit = bar.splitFactor ?? null;
      const declaredDividend = bar.cashDividend ?? null;
      if (declaredSplit !== null && !(Number.isFinite(declaredSplit) && declaredSplit > 0)) {
        throw new Error(`${bar.sessionDate}: splitFactor must be finite and > 0, got ${declaredSplit}`);
      }
      if (declaredDividend !== null && !(Number.isFinite(declaredDividend) && declaredDividend >= 0)) {
        throw new Error(`${bar.sessionDate}: cashDividend must be finite and >= 0, got ${declaredDividend}`);
      }
      // splitFactor 1 and cashDividend 0 are economic no-ops.
      const splitFactor = declaredSplit !== null && declaredSplit !== 1 ? declaredSplit : null;
      const cashDividend = declaredDividend !== null && declaredDividend > 0 ? declaredDividend : null;
      if (caPolicy.refusesCorporateActions && (splitFactor !== null || cashDividend !== null)) {
        throw new Error(
          `${ERROR_CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED}: ${input.symbol} ${bar.sessionDate} carries a corporate ` +
          `action on a ${input.priceBasis} series; the embedded treatment cannot be proven, refusing to guess`
        );
      }
      if (splitFactor !== null && cashDividend !== null && (caPolicy.engineAppliesSplit || caPolicy.creditsCashDividend)) {
        throw new Error(
          `${ERROR_CORPORATE_ACTION_ORDER_AMBIGUOUS}: ${input.symbol} ${bar.sessionDate} has a split and a cash dividend ` +
          'on the same session; the source does not prove their order, refusing to pick one arbitrarily'
        );
      }
      if (splitFactor !== null) {
        if (caPolicy.engineAppliesSplit) {
          if (portfolio.position !== null) {
            const activeStopBefore = activeStop;
            const adjusted = applySplitToPosition(portfolio.position, splitFactor);
            if (activeStop !== null) activeStop = activeStop / splitFactor;
            if (pendingStop !== null) pendingStop = pendingStop / splitFactor;
            if (openTrade !== null) {
              openTrade.entryPrice = openTrade.entryPrice / splitFactor;
              openTrade.maxQuantity = scaleWholeQuantity(openTrade.maxQuantity, splitFactor, 'openTrade.maxQuantity');
              openTrade.entryCommissionShare = openTrade.entryCommissionShare / splitFactor;
            }
            portfolio.corporateActionEvents.push({
              type: 'SPLIT',
              sessionDate: bar.sessionDate,
              symbol: input.symbol,
              priceBasis: input.priceBasis,
              splitFactor,
              quantityBefore: adjusted.quantityBefore,
              quantityAfter: adjusted.quantityAfter,
              averageCostBefore: adjusted.averageCostBefore,
              averageCostAfter: adjusted.averageCostAfter,
              activeStopBefore,
              activeStopAfter: activeStop,
              source: bar.source ?? null,
            });
          } else {
            portfolio.corporateActionEvents.push({
              type: 'SPLIT',
              sessionDate: bar.sessionDate,
              symbol: input.symbol,
              priceBasis: input.priceBasis,
              splitFactor,
              quantityBefore: 0,
              quantityAfter: 0,
              averageCostBefore: null,
              averageCostAfter: null,
              activeStopBefore: null,
              activeStopAfter: null,
              source: bar.source ?? null,
            });
          }
        } else {
          // Split already embedded in the price series: informational only,
          // the position is never adjusted a second time.
          portfolio.corporateActionEvents.push({
            type: 'SPLIT_ALREADY_EMBEDDED',
            sessionDate: bar.sessionDate,
            symbol: input.symbol,
            priceBasis: input.priceBasis,
            splitFactor,
            source: bar.source ?? null,
          });
        }
      }
      if (cashDividend !== null) {
        if (caPolicy.creditsCashDividend) {
          const eligibleQuantity = portfolio.position !== null ? portfolio.position.quantity : 0;
          if (eligibleQuantity > 0) {
            const cashImpact = eligibleQuantity * cashDividend;
            portfolio.cash += cashImpact;
            portfolio.totalDividendsCash += cashImpact;
            portfolio.corporateActionEvents.push({
              type: 'CASH_DIVIDEND',
              sessionDate: bar.sessionDate,
              symbol: input.symbol,
              priceBasis: input.priceBasis,
              cashDividendPerShare: cashDividend,
              eligibleQuantity,
              cashImpact,
              source: bar.source ?? null,
            });
          }
        } else {
          // Dividend already embedded in total-return prices: informational
          // only, never credited a second time.
          portfolio.corporateActionEvents.push({
            type: 'CASH_DIVIDEND_ALREADY_EMBEDDED',
            sessionDate: bar.sessionDate,
            symbol: input.symbol,
            priceBasis: input.priceBasis,
            cashDividendPerShare: cashDividend,
            source: bar.source ?? null,
          });
        }
      }
    }

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
    totalDividendsCash: portfolio.totalDividendsCash,
    corporateActionEvents: portfolio.corporateActionEvents,
    metrics,
    metricReasons,
    warnings: [...warnings, ...portfolio.warnings],
  };
  return withResultHash(result);
}
