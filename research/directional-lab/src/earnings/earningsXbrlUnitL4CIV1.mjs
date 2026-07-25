/** Canonicalize the two closed XBRL units used by L4C-I1. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertStore,
  putCanonicalL3,
  readTypedReference,
} from '../contracts/marketDataL3CommonV1.mjs';
import {
  XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
  normalizeXbrlCanonicalUnitCoreV1,
} from '../contracts/earningsContractsL4CIV1.mjs';
import { EARNINGS_STORE_METHODS } from './earningsIngestionPolicyL4CIV1.mjs';

function isUsdMeasure(measure) {
  return measure === 'iso4217:USD'
    || measure === '{http://www.xbrl.org/2003/iso4217}USD';
}

function isSharesMeasure(measure) {
  return measure === 'xbrli:shares'
    || measure === '{http://www.xbrl.org/2003/instance}shares';
}

export function canonicalizeXbrlUnitMeasuresV1(unit) {
  if (unit === null || typeof unit !== 'object' || Array.isArray(unit)) {
    throw new MarketDataL3Error('EARNINGS_UNIT_REJECTED', 'XBRL unit must be a record');
  }
  if (Array.isArray(unit.measures) && unit.measures.length === 1
      && isUsdMeasure(unit.measures[0]) && !Object.hasOwn(unit, 'numeratorMeasures')) {
    return 'USD';
  }
  if (Array.isArray(unit.numeratorMeasures) && unit.numeratorMeasures.length === 1
      && isUsdMeasure(unit.numeratorMeasures[0])
      && Array.isArray(unit.denominatorMeasures) && unit.denominatorMeasures.length === 1
      && isSharesMeasure(unit.denominatorMeasures[0])) {
    return 'USD_PER_SHARE';
  }
  throw new MarketDataL3Error('EARNINGS_UNIT_REJECTED',
    'only USD and USD divided by shares are admitted');
}

export function buildXbrlCanonicalUnitCore(input) {
  const api = assertApiInput(input, ['unitCode']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  const unit = normalizeXbrlCanonicalUnitCoreV1({
    schemaVersion: XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION,
    unitCode: api.unitCode,
  });
  const stored = putCanonicalL3(api.store, XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, unit);
  return { xbrlCanonicalUnitId: stored.objectId, xbrlCanonicalUnitCore: stored.value };
}

export function buildXbrlCanonicalUnitFromMeasures(input) {
  const api = assertApiInput(input, ['unit']);
  return buildXbrlCanonicalUnitCore({
    store: api.store, unitCode: canonicalizeXbrlUnitMeasuresV1(api.unit),
  });
}

export function verifyXbrlCanonicalUnitCore(input) {
  const api = assertApiInput(input, ['xbrlCanonicalUnitId']);
  assertStore(api.store, EARNINGS_STORE_METHODS);
  let unit;
  try {
    unit = normalizeXbrlCanonicalUnitCoreV1(readTypedReference(api.store,
      api.xbrlCanonicalUnitId, XBRL_CANONICAL_UNIT_CORE_SCHEMA_VERSION, 'XBRL unit'));
  } catch (cause) {
    throw new MarketDataL3Error('EARNINGS_UNIT_MISSING', 'XBRL unit is missing or corrupt',
      { cause });
  }
  return { xbrlCanonicalUnitId: api.xbrlCanonicalUnitId, xbrlCanonicalUnitCore: unit };
}
