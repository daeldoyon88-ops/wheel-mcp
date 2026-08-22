/**
 * GATE21 V1 FREE source registry and fallback binding.
 * Wraps lab source identities. Does not invent a parallel schema for bars.
 * Required V1 sources are COST_CLASS=FREE. Paid-only mandatory → FAIL.
 */

export const SOURCE_REGISTRY_VERSION = 'GATE21_SourceRegistry/1';

export const REQUIRED_SOURCE_FIELDS = Object.freeze([
  'source',
  'identityOrLabRegistryId',
  'cost_class',
  'rate_limit',
  'historical_depth',
  'freshness',
  'reliability',
  'access_terms',
  'free_fallback',
  'historical_or_live_class',
]);

export const COST_CLASS = Object.freeze({
  FREE: 'FREE',
  UNAVAILABLE: 'UNAVAILABLE',
  OPTIONAL_FUTURE: 'OPTIONAL_FUTURE',
  MACHINE_SPECIFIC: 'MACHINE_SPECIFIC',
  PAID: 'PAID',
});

export const GATE21_CANONICAL_BAR_SCHEMA = 'DailyBarV1';

/**
 * Provider-neutral V1 cohort. Yahoo is FREE historical off-scan with an
 * explicit replay limitation unless a snapshot is pinned. IBKR is not required.
 */
export const GATE21_V1_SOURCE_ROWS = Object.freeze([
  Object.freeze({
    source: 'LAB_JSON_DAILY_FIXTURE',
    identityOrLabRegistryId: 'research/directional-lab/src/data/jsonDailyAdapter.mjs',
    labSchemas: Object.freeze(['jsonDailyAdapter/1', 'DailyBarV1']),
    cost_class: COST_CLASS.FREE,
    rate_limit: 'LOCAL_FILE',
    historical_depth: 'FIXTURE_BOUNDED',
    freshness: 'SNAPSHOT',
    reliability: 'DETERMINISTIC_REPLAY',
    access_terms: 'IN_REPO_RESEARCH_FIXTURE',
    free_fallback: null,
    historical_or_live_class: 'HISTORICAL',
    required_v1: true,
    replay_guarantee: 'BYTE_IDENTICAL',
    canonicalSchema: GATE21_CANONICAL_BAR_SCHEMA,
    providerLockIn: false,
  }),
  Object.freeze({
    source: 'YAHOO_CHART_EOD',
    identityOrLabRegistryId: 'app/data_providers/yahooMarketDataProvider.js',
    labSchemas: Object.freeze(['DailyBarV1']),
    cost_class: COST_CLASS.FREE,
    rate_limit: 'PROVIDER_UNSPECIFIED',
    historical_depth: 'PROVIDER_BOUNDED',
    freshness: 'DELAYED_EOD',
    reliability: 'BEST_EFFORT',
    access_terms: 'YAHOO_PUBLIC_CHART_FREE',
    free_fallback: 'LAB_JSON_DAILY_FIXTURE',
    historical_or_live_class: 'HISTORICAL_OFF_SCAN',
    required_v1: true,
    replay_guarantee: 'NOT_GUARANTEED_WITHOUT_PINNED_SNAPSHOT',
    replay_limitation: 'Live Yahoo fetch is not claimed deterministic; replay requires a pinned GATE21 snapshot/manifest.',
    canonicalSchema: GATE21_CANONICAL_BAR_SCHEMA,
    providerLockIn: false,
  }),
  Object.freeze({
    source: 'IBKR_TWS_READONLY',
    identityOrLabRegistryId: 'app/data_providers/ibkrReadOnlyProvider.js',
    labSchemas: Object.freeze([]),
    cost_class: COST_CLASS.MACHINE_SPECIFIC,
    rate_limit: 'LOCAL_TWS',
    historical_depth: 'EXISTING_READ_ONLY_PATH',
    freshness: 'LIVE_EXISTING',
    reliability: 'MACHINE_SPECIFIC',
    access_terms: 'EXISTING_READ_ONLY_NOT_GATE21_REQUIRED',
    free_fallback: 'LAB_JSON_DAILY_FIXTURE',
    historical_or_live_class: 'LIVE_EXISTING_NOT_GATE21',
    required_v1: false,
    availability: COST_CLASS.OPTIONAL_FUTURE,
    replay_guarantee: 'NOT_IN_GATE21_V1',
    canonicalSchema: GATE21_CANONICAL_BAR_SCHEMA,
    providerLockIn: false,
  }),
]);

export function sourceRowProblems(row) {
  const problems = [];
  if (row === null || typeof row !== 'object') return ['source row is not an object'];
  for (const field of REQUIRED_SOURCE_FIELDS) {
    if (!(field in row)) problems.push(`missing field ${field}`);
    else if (field === 'free_fallback') {
      if (row.free_fallback !== null && typeof row.free_fallback !== 'string') {
        problems.push('free_fallback must be null or a source id');
      }
    } else if (typeof row[field] !== 'string' || row[field].length === 0) {
      problems.push(`${field} must be a non-empty string`);
    }
  }
  return problems;
}

export function validateSourceRegistry(rows) {
  const problems = [];
  if (!Array.isArray(rows)) return { ok: false, code: 'REGISTRY_NOT_ARRAY', problems: ['registry must be an array'], requiredV1: [] };
  const seen = new Set();
  const requiredV1 = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    problems.push(...sourceRowProblems(row).map((p) => `rows[${i}]: ${p}`));
    if (row && typeof row === 'object') {
      if (seen.has(row.source)) problems.push(`rows[${i}]: duplicate source ${row.source}`);
      seen.add(row.source);
      if (row.required_v1 === true) requiredV1.push(row);
    }
  }
  for (const row of requiredV1) {
    if (row.cost_class !== COST_CLASS.FREE) {
      problems.push(`required V1 source ${row.source} has cost_class=${row.cost_class}; paid-only/non-FREE mandatory is forbidden`);
    }
    if (row.canonicalSchema !== GATE21_CANONICAL_BAR_SCHEMA) {
      problems.push(`required V1 source ${row.source} must normalize to ${GATE21_CANONICAL_BAR_SCHEMA}`);
    }
  }
  const paidMandatory = requiredV1.some((row) => row.cost_class === COST_CLASS.PAID);
  return {
    ok: problems.length === 0,
    code: paidMandatory ? 'PAID_ONLY_REQUIRED_V1' : (problems.length ? 'REGISTRY_INVALID' : null),
    problems,
    requiredV1,
  };
}

export function validateRequiredV1Free(rows = GATE21_V1_SOURCE_ROWS) {
  return validateSourceRegistry(rows);
}

export function resolveFallback(rows, primarySourceId, candidateSchema) {
  const registry = Array.isArray(rows) ? rows : [];
  const primary = registry.find((row) => row.source === primarySourceId);
  if (!primary) {
    return { status: 'BLOCKED', code: 'UNKNOWN_SOURCE', selected: null };
  }
  if (candidateSchema && candidateSchema !== primary.canonicalSchema) {
    return { status: 'BLOCKED', code: 'INCOMPATIBLE_FALLBACK_SCHEMA', selected: null, expected: primary.canonicalSchema, actual: candidateSchema };
  }
  if (primary.required_v1 && primary.cost_class !== COST_CLASS.FREE) {
    return { status: 'BLOCKED', code: 'PAID_ONLY_REQUIRED_V1', selected: null };
  }
  return { status: 'RESOLVED', code: null, selected: primary, fallback: primary.free_fallback };
}

export function refusePaidMandatory(row) {
  if (row?.required_v1 === true && row?.cost_class !== COST_CLASS.FREE) {
    return { status: 'BLOCKED', code: 'PAID_ONLY_REQUIRED_V1', ok: false };
  }
  return { status: 'OK', code: null, ok: true };
}
