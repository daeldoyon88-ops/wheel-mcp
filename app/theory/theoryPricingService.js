/**
 * theoryPricingService.js
 *
 * Isolated Black-Scholes pricing engine for theoretical Covered Call premiums.
 * No network calls. No SQLite. No scanner access.
 */

// ─────────────────────────────────────────────
// STEP 1 — normalCdf
// ─────────────────────────────────────────────

/**
 * Cumulative distribution function for the standard normal distribution.
 * Uses Abramowitz & Stegun approximation 26.2.17 (max error < 7.5e-8).
 */
function normalCdf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);

  const p  = 0.2316419;
  const b1 =  0.319381530;
  const b2 = -0.356563782;
  const b3 =  1.781477937;
  const b4 = -1.821255978;
  const b5 =  1.330274429;

  const t = 1 / (1 + p * absX);
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const pdf  = Math.exp(-0.5 * absX * absX) / Math.sqrt(2 * Math.PI);
  const cdf  = 1 - pdf * poly;

  return sign === 1 ? cdf : 1 - cdf;
}

// ─────────────────────────────────────────────
// STEP 2 — blackScholesCall
// ─────────────────────────────────────────────

/**
 * Black-Scholes European call price.
 *
 * @param {object} params
 * @param {number} params.spot           - Current underlying price (S)
 * @param {number} params.strike         - Strike price (K)
 * @param {number} params.dte            - Days to expiration
 * @param {number} params.volatility     - Annualised volatility as decimal (e.g. 0.5 = 50%)
 * @param {number} [params.riskFreeRate] - Annual risk-free rate as decimal (default 0.045)
 * @param {number} [params.dividendYield]- Continuous dividend yield as decimal (default 0)
 * @returns {{ ok: boolean, premium: number|null, d1: number|null, d2: number|null, inputs: object, error?: string }}
 */
function blackScholesCall({
  spot,
  strike,
  dte,
  volatility,
  riskFreeRate = 0.045,
  dividendYield = 0,
}) {
  const inputs = { spot, strike, dte, volatility, riskFreeRate, dividendYield };

  if (!Number.isFinite(spot)       || spot       <= 0) return { ok: false, premium: null, d1: null, d2: null, inputs, error: 'spot must be a positive number' };
  if (!Number.isFinite(strike)     || strike     <= 0) return { ok: false, premium: null, d1: null, d2: null, inputs, error: 'strike must be a positive number' };
  if (!Number.isFinite(dte)        || dte        <= 0) return { ok: false, premium: null, d1: null, d2: null, inputs, error: 'dte must be positive' };
  if (!Number.isFinite(volatility) || volatility <= 0) return { ok: false, premium: null, d1: null, d2: null, inputs, error: 'volatility must be a positive decimal (e.g. 0.5 = 50%)' };

  const T   = dte / 365;
  const S   = spot;
  const K   = strike;
  const r   = riskFreeRate;
  const q   = dividendYield;
  const sig = volatility;

  const sqrtT = Math.sqrt(T);
  const d1    = (Math.log(S / K) + (r - q + 0.5 * sig * sig) * T) / (sig * sqrtT);
  const d2    = d1 - sig * sqrtT;

  const premium =
    S * Math.exp(-q * T) * normalCdf(d1) -
    K * Math.exp(-r * T) * normalCdf(d2);

  return {
    ok: true,
    premium: Math.max(0, premium),
    d1,
    d2,
    inputs,
  };
}

// ─────────────────────────────────────────────
// STEP 3 — chooseVolatilityForCc
// ─────────────────────────────────────────────

/**
 * Pick the best available volatility estimate for CC pricing.
 *
 * Values > 5 (i.e. > 500%) are treated as invalid/garbage.
 * Values <= 0 are ignored.
 *
 * @param {object} params
 * @param {number|null|undefined} params.hv30
 * @param {number|null|undefined} params.atmIv
 * @param {number|null|undefined} params.safeStrikeIv
 * @param {number} [params.fallbackVolatility]
 * @returns {{ volatilityUsed: number, volatilitySource: string, candidates: object }}
 */
function chooseVolatilityForCc({
  hv30,
  atmIv,
  safeStrikeIv,
  fallbackVolatility = 0.4,
} = {}) {
  const isValid = (v) => Number.isFinite(v) && v > 0 && v <= 5;

  const hv30Valid         = isValid(hv30)         ? hv30         : null;
  const atmIvValid        = isValid(atmIv)         ? atmIv        : null;
  const safeStrikeIvValid = isValid(safeStrikeIv)  ? safeStrikeIv : null;

  let volatilityUsed;
  let volatilitySource;

  if (hv30Valid !== null && atmIvValid !== null) {
    volatilityUsed   = Math.max(hv30Valid, atmIvValid);
    volatilitySource = 'max_hv30_atm_iv';
  } else if (hv30Valid !== null) {
    volatilityUsed   = hv30Valid;
    volatilitySource = 'hv30';
  } else if (atmIvValid !== null) {
    volatilityUsed   = atmIvValid;
    volatilitySource = 'atm_iv';
  } else if (safeStrikeIvValid !== null) {
    volatilityUsed   = safeStrikeIvValid;
    volatilitySource = 'safe_strike_iv';
  } else {
    volatilityUsed   = fallbackVolatility;
    volatilitySource = 'fallback';
  }

  return {
    volatilityUsed,
    volatilitySource,
    candidates: { hv30, atmIv, safeStrikeIv, fallbackVolatility },
  };
}

// ─────────────────────────────────────────────
// STEP 4 — computeCcYield
// ─────────────────────────────────────────────

/**
 * CC yield as a percentage of the strike price.
 *
 * @param {{ premium: number, strike: number }} params
 * @returns {number} yield in percent (e.g. 1.25 means 1.25%)
 */
function computeCcYield({ premium, strike }) {
  if (!Number.isFinite(premium) || !Number.isFinite(strike) || strike <= 0) return 0;
  return (premium / strike) * 100;
}

// ─────────────────────────────────────────────
// STEP 5 — computeCcThresholds
// ─────────────────────────────────────────────

const DEFAULT_CC_THRESHOLDS = [0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0];

/**
 * For each threshold, compute the required premium and whether it is reached.
 *
 * @param {object} params
 * @param {number}   params.premium    - Actual estimated premium (dollars)
 * @param {number}   params.strike     - Strike price (dollars)
 * @param {number[]} [params.thresholds] - Array of yield thresholds in percent
 * @returns {Array<{ thresholdPct: number, requiredPremium: number, reached: boolean, premium: number, ccYieldPct: number }>}
 */
function computeCcThresholds({
  premium,
  strike,
  thresholds = DEFAULT_CC_THRESHOLDS,
}) {
  const ccYieldPct = computeCcYield({ premium, strike });

  return thresholds.map((thresholdPct) => {
    const requiredPremium = (strike * thresholdPct) / 100;
    return {
      thresholdPct,
      requiredPremium: Math.round(requiredPremium * 10000) / 10000,
      reached:         premium >= requiredPremium,
      premium,
      ccYieldPct,
    };
  });
}

// ─────────────────────────────────────────────
// STEP 6 — requiredPremiumForThreshold
// ─────────────────────────────────────────────

/**
 * Minimum dollar premium needed to reach a given yield threshold.
 *
 * @param {{ strike: number, thresholdPct: number }} params
 * @returns {number}
 */
function requiredPremiumForThreshold({ strike, thresholdPct }) {
  return (strike * thresholdPct) / 100;
}

// ─────────────────────────────────────────────
// STEP 7 — estimateCoveredCallPremium (top-level)
// ─────────────────────────────────────────────

/**
 * High-level function that estimates the theoretical CC premium after assignment.
 *
 * @param {object} params
 * @param {number}  params.spot               - Current underlying price
 * @param {number}  params.assignmentStrike   - Strike at which shares were assigned (cost basis floor)
 * @param {number}  params.ccStrike           - Proposed CC strike (must be >= assignmentStrike)
 * @param {number}  params.dte                - Days to expiration
 * @param {number|null} [params.hv30]         - 30-day historical volatility (decimal)
 * @param {number|null} [params.atmIv]        - ATM implied volatility (decimal)
 * @param {number|null} [params.safeStrikeIv] - IV at the safe strike (decimal)
 * @param {number}  [params.riskFreeRate]     - Annual risk-free rate (default 0.045)
 * @param {number}  [params.dividendYield]    - Continuous dividend yield (default 0)
 * @param {number}  [params.conservativeFactor] - Haircut on BS price (default 0.8)
 * @param {number[]} [params.thresholds]      - Yield thresholds in percent
 */
function estimateCoveredCallPremium({
  spot,
  assignmentStrike,
  ccStrike,
  dte,
  hv30              = null,
  atmIv             = null,
  safeStrikeIv      = null,
  riskFreeRate      = 0.045,
  dividendYield     = 0,
  conservativeFactor = 0.8,
  thresholds        = DEFAULT_CC_THRESHOLDS,
}) {
  const inputs = {
    spot, assignmentStrike, ccStrike, dte,
    hv30, atmIv, safeStrikeIv,
    riskFreeRate, dividendYield, conservativeFactor,
  };

  // Guard: CC strike must be at or above assignment strike
  if (!Number.isFinite(ccStrike) || !Number.isFinite(assignmentStrike)) {
    return {
      ok: false, premium: null, error: 'ccStrike and assignmentStrike must be finite numbers', inputs,
    };
  }
  if (ccStrike < assignmentStrike) {
    return {
      ok: false,
      premium: null,
      error: `CC strike (${ccStrike}) cannot be below assignment strike (${assignmentStrike}). Selling a CC below assignment price would realise a loss on the shares.`,
      inputs,
    };
  }

  // Choose volatility
  const { volatilityUsed, volatilitySource, candidates } =
    chooseVolatilityForCc({ hv30, atmIv, safeStrikeIv });

  // Black-Scholes call priced at the CC strike
  const bsResult = blackScholesCall({
    spot,
    strike:       ccStrike,
    dte,
    volatility:   volatilityUsed,
    riskFreeRate,
    dividendYield,
  });

  if (!bsResult.ok) {
    return {
      ok: false, premium: null, error: bsResult.error,
      volatilityUsed, volatilitySource, candidates, inputs,
    };
  }

  const bsPremium          = bsResult.premium;
  const premiumEstimated   = bsPremium;
  const premiumConservative = bsPremium * conservativeFactor;

  const ccYieldPct             = computeCcYield({ premium: premiumEstimated,    strike: ccStrike });
  const ccYieldConservativePct = computeCcYield({ premium: premiumConservative, strike: ccStrike });

  const thresholdsResult = computeCcThresholds({
    premium: premiumConservative,
    strike:  ccStrike,
    thresholds,
  });

  return {
    ok:                    true,
    source:                'black_scholes_estimated',
    volatilityUsed,
    volatilitySource,
    bsPremium,
    premiumEstimated,
    premiumConservative,
    conservativeFactor,
    ccYieldPct,
    ccYieldConservativePct,
    thresholds:            thresholdsResult,
    bsDetail:              { d1: bsResult.d1, d2: bsResult.d2 },
    inputs,
  };
}

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

export {
  normalCdf,
  blackScholesCall,
  estimateCoveredCallPremium,
  computeCcYield,
  computeCcThresholds,
  requiredPremiumForThreshold,
  chooseVolatilityForCc,
  DEFAULT_CC_THRESHOLDS,
};
