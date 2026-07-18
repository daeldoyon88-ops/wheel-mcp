/**
 * StopFillModelV1 — gap-aware protective stop resolution for LONG positions.
 *
 * Rules (never pretends a stop protects against an overnight gap):
 *  - open <= stop      -> GAP_STOP: fill at open minus gap slippage;
 *  - low  <= stop      -> STOP:     fill at stop minus normal slippage;
 *  - otherwise         -> no fill this session.
 * The stop must have been decided at a PREVIOUS close (engine enforces the
 * next-session activation).
 */

/**
 * @param {{stopLevel: number, open: number, low: number, slippageModel: {adversePrice: (p: number, s: 'BUY'|'SELL', g?: boolean) => number, perShareCost: (p: number, g?: boolean) => number}}} input
 * @returns {{kind: 'GAP_STOP'|'STOP', referencePrice: number, fillPrice: number, slippagePerShare: number}|null}
 */
export function resolveLongStopFill(input) {
  const { stopLevel, open, low, slippageModel } = input;
  for (const [name, v] of [['stopLevel', stopLevel], ['open', open], ['low', low]]) {
    if (!Number.isFinite(v)) throw new Error(`resolveLongStopFill: ${name} must be finite, got ${v}`);
  }
  if (open <= stopLevel) {
    return {
      kind: 'GAP_STOP',
      referencePrice: open,
      fillPrice: slippageModel.adversePrice(open, 'SELL', true),
      slippagePerShare: slippageModel.perShareCost(open, true),
    };
  }
  if (low <= stopLevel) {
    return {
      kind: 'STOP',
      referencePrice: stopLevel,
      fillPrice: slippageModel.adversePrice(stopLevel, 'SELL', false),
      slippagePerShare: slippageModel.perShareCost(stopLevel, false),
    };
  }
  return null;
}
