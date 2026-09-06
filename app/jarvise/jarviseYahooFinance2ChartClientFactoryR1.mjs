/**
 * P3E Yahoo Finance 2 chart-client factory.
 *
 * This module is transport wiring only. It does not import the Yahoo package at
 * module scope, does not contact Yahoo during evaluation, and does not reuse
 * the live market-data cache. Construction of a real client happens lazily
 * inside this factory, and Yahoo contact remains possible only when the
 * returned chart() function is invoked downstream of a durable reservation.
 */

export const JARVISE_YAHOO_FINANCE2_CHART_CLIENT_FACTORY_VERSION = 'jarviseYahooFinance2ChartClientFactoryR1/1';

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Production loader. Invoked only from createJarviseYahooFinance2ChartClientR1,
 * never at module evaluation time.
 * @returns {Promise<unknown>}
 */
async function defaultLoadYahooFinance2() {
  return import('yahoo-finance2');
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function asYahooFinance2HttpStatusR1(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === 'string' && /^(?:[1-5][0-9]{2})$/.test(value)) return Number(value);
  return null;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isYahooFinance2HttpErrorR1(error) {
  if (error === null || error === undefined || typeof error !== 'object') return false;
  const candidate = /** @type {{name?: unknown, constructor?: {name?: unknown}}} */ (error);
  return candidate.name === 'HTTPError' || candidate.constructor?.name === 'HTTPError';
}

/**
 * Project a genuine yahoo-finance2 HTTPError numeric code onto error.status so
 * the existing P3 classifier can see it. Other failures are returned unchanged.
 * @param {unknown} error
 */
export function projectYahooFinance2HttpErrorR1(error) {
  if (!isYahooFinance2HttpErrorR1(error)) return error;
  const candidate = /** @type {{code?: unknown, status?: unknown}} */ (error);
  const projected = asYahooFinance2HttpStatusR1(candidate.code);
  if (projected === null) return error;
  if (asYahooFinance2HttpStatusR1(candidate.status) === null) {
    candidate.status = projected;
  }
  return error;
}

/**
 * @param {unknown} moduleNamespace
 * @returns {new (options?: object) => {chart: Function}}
 */
function resolveYahooFinanceConstructor(moduleNamespace) {
  const candidate = moduleNamespace?.default ?? moduleNamespace;
  if (typeof candidate === 'function') return candidate;
  if (candidate && typeof candidate.default === 'function') return candidate.default;
  const error = new Error('yahoo-finance2 module did not export a constructable YahooFinance');
  error.name = 'JarviseYahooFinance2FactoryError';
  error.code = 'YAHOO_FINANCE2_CONSTRUCTOR_UNAVAILABLE';
  throw error;
}

/**
 * Create the narrowly-scoped chart client P3 needs. Tests inject loadYahooFinance2
 * so the real package is never evaluated offline.
 * @param {{loadYahooFinance2?: () => Promise<unknown>|unknown}} [options]
 * @returns {Promise<{chart: Function}>}
 */
export async function createJarviseYahooFinance2ChartClientR1(options = {}) {
  if (options !== undefined && options !== null && !isPlainObject(options)) {
    const error = new Error('factory options must be a plain object when supplied');
    error.name = 'JarviseYahooFinance2FactoryError';
    error.code = 'YAHOO_FINANCE2_FACTORY_OPTIONS_INVALID';
    throw error;
  }
  const loadYahooFinance2 = options.loadYahooFinance2 ?? defaultLoadYahooFinance2;
  if (typeof loadYahooFinance2 !== 'function') {
    const error = new Error('loadYahooFinance2 must be a function');
    error.name = 'JarviseYahooFinance2FactoryError';
    error.code = 'YAHOO_FINANCE2_LOADER_INVALID';
    throw error;
  }

  const moduleNamespace = await loadYahooFinance2();
  const YahooFinance = resolveYahooFinanceConstructor(moduleNamespace);
  const instance = new YahooFinance({
    suppressNotices: ['yahooSurvey'],
  });
  if (!instance || typeof instance.chart !== 'function') {
    const error = new Error('yahoo-finance2 client must expose a chart function');
    error.name = 'JarviseYahooFinance2FactoryError';
    error.code = 'YAHOO_FINANCE2_CHART_UNAVAILABLE';
    throw error;
  }

  return {
    async chart(symbol, params) {
      try {
        return await instance.chart(symbol, params);
      } catch (error) {
        throw projectYahooFinance2HttpErrorR1(error);
      }
    },
  };
}
