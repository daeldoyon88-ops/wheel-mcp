/** Canonical EPS/revenue observations with exact fixed-point values. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
  normalizeEarningsMetricObservationCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';
import { verifyFinancialPeriodIdentityCore } from './earningsFinancialPeriodL4CIV1.mjs';
import { verifyEarningsRevisionIdentityCore } from './earningsRevisionL4CIV1.mjs';
import { verifyXbrlCanonicalUnitCore } from './earningsXbrlUnitL4CIV1.mjs';

export function fixedPointFromXbrlLexicalV1(value, maxScale) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
      || value === '-0' || /^-0(?:\.0+)?$/.test(value)) {
    throw new MarketDataL3Error('EARNINGS_FIXED_POINT_INVALID',
      'XBRL fact must use a finite canonical decimal lexical form');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const scale = trimmedFraction.length;
  if (scale > maxScale) {
    throw new MarketDataL3Error('EARNINGS_FIXED_POINT_SCALE_INVALID',
      `fact scale exceeds ${maxScale}`);
  }
  const digits = `${whole}${trimmedFraction}`.replace(/^0+(?=\d)/, '') || '0';
  return { atoms: `${negative && digits !== '0' ? '-' : ''}${digits}`, scale };
}

export function buildEarningsMetricObservationCore(input) {
  const api = assertApiInput(input, [
    'earningsRevisionIdentityId', 'financialPeriodIdentityId', 'xbrlCanonicalUnitId',
    'metricCode', 'atoms', 'scale', 'shareBasis', 'accountingBasis',
  ]);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const revision = verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: api.earningsRevisionIdentityId,
  });
  const period = verifyFinancialPeriodIdentityCore({
    store: api.store, financialPeriodIdentityId: api.financialPeriodIdentityId,
  });
  const unit = verifyXbrlCanonicalUnitCore({
    store: api.store, xbrlCanonicalUnitId: api.xbrlCanonicalUnitId,
  }).xbrlCanonicalUnitCore;
  const expectedUnit = api.metricCode === 'EPS_DILUTED' ? 'USD_PER_SHARE' : 'USD';
  if (unit.unitCode !== expectedUnit) {
    throw new MarketDataL3Error('EARNINGS_UNIT_REJECTED',
      `${api.metricCode} requires ${expectedUnit}`);
  }
  const observation = normalizeEarningsMetricObservationCoreV1({
    schemaVersion: EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
    earningsRevisionIdentityId: api.earningsRevisionIdentityId,
    financialPeriodIdentityId: api.financialPeriodIdentityId,
    xbrlCanonicalUnitId: api.xbrlCanonicalUnitId,
    metricCode: api.metricCode,
    atoms: api.atoms,
    scale: api.scale,
    shareBasis: api.shareBasis,
    accountingBasis: api.accountingBasis,
  });
  const stored = putCanonicalL3(api.store, EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
    observation);
  return { earningsMetricObservationId: stored.objectId,
    earningsMetricObservationCore: stored.value, revision, period };
}

export function verifyEarningsMetricObservationCore(input) {
  const api = assertApiInput(input, ['earningsMetricObservationId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let observation;
  try {
    observation = normalizeEarningsMetricObservationCoreV1(readTypedReference(api.store,
      api.earningsMetricObservationId, EARNINGS_METRIC_OBSERVATION_CORE_SCHEMA_VERSION,
      'earnings metric observation'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_METRIC_ORPHAN',
      'metric observation is missing or corrupt', { cause });
  }
  verifyEarningsRevisionIdentityCore({
    store: api.store, earningsRevisionIdentityId: observation.earningsRevisionIdentityId,
  });
  verifyFinancialPeriodIdentityCore({
    store: api.store, financialPeriodIdentityId: observation.financialPeriodIdentityId,
  });
  const unit = verifyXbrlCanonicalUnitCore({
    store: api.store, xbrlCanonicalUnitId: observation.xbrlCanonicalUnitId,
  }).xbrlCanonicalUnitCore;
  const expectedUnit = observation.metricCode === 'EPS_DILUTED' ? 'USD_PER_SHARE' : 'USD';
  if (unit.unitCode !== expectedUnit) {
    throw new MarketDataL3Error('EARNINGS_UNIT_REJECTED',
      'observation metric and unit are incompatible');
  }
  return { earningsMetricObservationId: api.earningsMetricObservationId,
    earningsMetricObservationCore: observation };
}
