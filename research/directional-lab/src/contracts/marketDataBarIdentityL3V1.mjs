/** Provider-, basis-, registry- and calendar-independent daily bar identity. */

import {
  MarketDataL3Error,
  assertApiInput,
  assertCasId,
  assertCivilDate,
  assertExactFields,
  assertPlainObject,
  assertSchemaVersion,
  putCanonicalL3,
  readTypedReference,
} from './marketDataL3CommonV1.mjs';

export const MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION = 'MarketDataBarIdentityCore/1';
export const MARKET_DATA_BAR_IDENTITY_L3_SCHEMA_VERSIONS = Object.freeze([
  MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION,
]);

const FIELDS = Object.freeze([
  'schemaVersion', 'instrumentIdentityId', 'frequency', 'venueId', 'sessionDate', 'sessionKind',
]);

export function normalizeMarketDataBarIdentityCoreV1(value) {
  try {
    const identity = assertPlainObject(value, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION);
    assertSchemaVersion(identity, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION);
    assertExactFields(identity, FIELDS);
    assertCasId(identity.instrumentIdentityId, 'instrumentIdentityId');
    if (identity.frequency !== 'DAILY_REGULAR_SESSION') throw new Error('frequency');
    if (typeof identity.venueId !== 'string' || !['ARCX', 'XNAS', 'XNYS'].includes(identity.venueId)) throw new Error('venueId');
    assertCivilDate(identity.sessionDate, 'sessionDate');
    if (identity.sessionKind !== 'DAILY_REGULAR_SESSION') throw new Error('sessionKind');
    return { ...identity };
  } catch (cause) {
    if (cause instanceof MarketDataL3Error
        && ['MARKET_DATA_UNKNOWN_FIELD', 'MARKET_DATA_SCHEMA_VERSION_UNSUPPORTED'].includes(cause.code)) throw cause;
    throw new MarketDataL3Error('MARKET_DATA_BAR_IDENTITY_INVALID', 'bar identity is invalid', { cause });
  }
}

/** @param {unknown} input */
export function buildMarketDataBarIdentity(input) {
  const api = assertApiInput(input, ['identity']);
  const identity = normalizeMarketDataBarIdentityCoreV1(api.identity);
  const stored = putCanonicalL3(api.store, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION, identity);
  return { barIdentityId: stored.objectId, barIdentity: stored.value, object: stored };
}

/** @param {unknown} input */
export function verifyMarketDataBarIdentity(input) {
  const api = assertApiInput(input, ['barIdentityId']);
  const identity = readTypedReference(api.store, api.barIdentityId, MARKET_DATA_BAR_IDENTITY_CORE_SCHEMA_VERSION, 'bar identity');
  return { barIdentityId: api.barIdentityId, barIdentity: identity };
}
