/**
 * P3E/P3H Yahoo Finance 2 chart-client factory.
 *
 * This module is transport wiring only. It does not import the Yahoo package at
 * module scope, does not contact Yahoo during evaluation, and does not reuse
 * the live market-data cache. Construction of a real client happens lazily
 * inside this factory, and Yahoo contact remains possible only when the
 * returned chart() function is invoked downstream of a durable reservation.
 *
 * P3H: each chart() call owns a lexical fetch cell. Fetch is never installed
 * on the YahooFinance constructor. Frozen query identity is the caller's
 * problem; this factory does not freeze or thaw params.
 */

export const JARVISE_YAHOO_FINANCE2_CHART_CLIENT_FACTORY_VERSION = 'jarviseYahooFinance2ChartClientFactoryR1/1';

export const P3E_PER_CALL_FETCH_SOURCE = 'P3E_PER_CALL_FETCH';

export const P3E_RETRYABLE_TRANSPORT_CODES = Object.freeze([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'EAI_AGAIN',
]);

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
 * Strict unanimous AggregateError child-code extraction.
 * Never trusts AggregateError.code. No recursion, majority, or first-child.
 * @param {unknown} aggregate
 * @returns {string|null}
 */
export function unanimousAggregateErrorCodeR1(aggregate) {
  if (!(aggregate instanceof AggregateError)) return null;
  const errors = /** @type {{errors?: unknown}} */ (aggregate).errors;
  if (!Array.isArray(errors) || errors.length < 1) return null;
  let expected = null;
  for (const child of errors) {
    const code = child !== null && child !== undefined && typeof child === 'object'
      ? /** @type {{code?: unknown}} */ (child).code
      : undefined;
    if (typeof code !== 'string') return null;
    if (expected === null) expected = code;
    else if (code !== expected) return null;
  }
  return expected;
}

/**
 * R4A transport extraction at the p3ePerCallFetch catch boundary only.
 * @param {unknown} error
 * @returns {string|null}
 */
export function extractP3ePerCallFetchTransportCodeR1(error) {
  if (error instanceof AggregateError) {
    return unanimousAggregateErrorCodeR1(error);
  }
  const candidate = /** @type {{code?: unknown, cause?: unknown}} */ (error);
  if (typeof candidate?.code === 'string') return candidate.code;
  if (candidate?.cause instanceof AggregateError) {
    return unanimousAggregateErrorCodeR1(candidate.cause);
  }
  const causeCode = candidate?.cause !== null && candidate?.cause !== undefined && typeof candidate.cause === 'object'
    ? /** @type {{code?: unknown}} */ (candidate.cause).code
    : undefined;
  if (typeof causeCode === 'string') return causeCode;
  return null;
}

/**
 * @param {unknown} error
 * @param {Record<string, unknown>} extra
 */
function attachOwnedProjection(error, extra) {
  if (error === null || error === undefined || typeof error !== 'object') return error;
  const target = /** @type {Record<string, unknown>} */ (error);
  for (const [key, value] of Object.entries(extra)) {
    try {
      Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
    } catch {
      try {
        target[key] = value;
      } catch {
        /* frozen/sealed hostiles stay fail-closed downstream */
      }
    }
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
 * so the real package is never evaluated offline. Underlying fetch is wrapped
 * lexically per chart() call; it is never installed on the constructor.
 * @param {{
 *   loadYahooFinance2?: () => Promise<unknown>|unknown,
 *   fetch?: Function,
 * }} [options]
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
  if (options.fetch !== undefined && typeof options.fetch !== 'function') {
    const error = new Error('fetch must be a function when supplied');
    error.name = 'JarviseYahooFinance2FactoryError';
    error.code = 'YAHOO_FINANCE2_FETCH_INVALID';
    throw error;
  }

  const moduleNamespace = await loadYahooFinance2();
  const YahooFinance = resolveYahooFinanceConstructor(moduleNamespace);
  const instance = new YahooFinance({
    suppressNotices: ['yahooSurvey'],
    versionCheck: false,
  });
  if (!instance || typeof instance.chart !== 'function') {
    const error = new Error('yahoo-finance2 client must expose a chart function');
    error.name = 'JarviseYahooFinance2FactoryError';
    error.code = 'YAHOO_FINANCE2_CHART_UNAVAILABLE';
    throw error;
  }

  const underlyingFetch = typeof options.fetch === 'function' ? options.fetch : globalThis.fetch;

  return {
    async chart(symbol, params, moduleOptions) {
      const cell = {
        responseSeen: false,
        responseStatus: null,
        p3eTransportFailure: null,
        p3eOwnedTimeoutAbort: false,
      };

      async function p3ePerCallFetch(url, fetchOptions) {
        try {
          const response = await underlyingFetch(url, fetchOptions);
          cell.responseSeen = true;
          const status = asYahooFinance2HttpStatusR1(response?.status);
          if (status !== null) cell.responseStatus = status;
          return response;
        } catch (error) {
          const transportCode = extractP3ePerCallFetchTransportCodeR1(error);
          cell.p3eTransportFailure = Object.freeze({
            source: P3E_PER_CALL_FETCH_SOURCE,
            code: transportCode,
          });
          attachOwnedProjection(error, {
            p3eTransportFailure: cell.p3eTransportFailure,
            p3eOwnedTimeoutAbort: cell.p3eOwnedTimeoutAbort,
            p3eHttpCapture: Object.freeze({
              responseSeen: cell.responseSeen,
              responseStatus: cell.responseStatus,
            }),
          });
          throw error;
        }
      }

      const callerModuleOptions = isPlainObject(moduleOptions) ? moduleOptions : {};
      try {
        return await instance.chart(symbol, params, { ...callerModuleOptions, fetch: p3ePerCallFetch });
      } catch (error) {
        const projected = projectYahooFinance2HttpErrorR1(error);
        attachOwnedProjection(projected, {
          p3eHttpCapture: Object.freeze({
            responseSeen: cell.responseSeen,
            responseStatus: cell.responseStatus,
          }),
          p3eOwnedTimeoutAbort: cell.p3eOwnedTimeoutAbort,
          ...(cell.p3eTransportFailure ? { p3eTransportFailure: cell.p3eTransportFailure } : {}),
        });
        throw projected;
      }
    },
  };
}
