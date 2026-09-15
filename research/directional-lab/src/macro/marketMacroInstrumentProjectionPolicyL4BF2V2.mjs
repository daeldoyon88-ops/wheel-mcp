/**
 * L4B-F2 closed MarketMacroInstrumentProjectionPolicy/2 singleton builder and
 * verifier: the additive CPI YoY successor of marketMacroInstrumentProjectionPolicyL4BF2V1.mjs,
 * which is unchanged.
 *
 * The identity is the same content address the lab CAS uses (sha256 over the
 * canonical JSON bytes of the schema-bound value), so the distinct schema version
 * gives V2 a distinct id. The object is persisted by its consumer as exact
 * canonical bytes rather than in a lab CAS snapshots namespace: registering a new
 * snapshot schema would change the closed, count-pinned lab schema registry.
 */

import { canonicalHash, canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import { MarketDataL3Error, sha256Digest } from '../contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES,
  normalizeMarketMacroInstrumentProjectionPolicyV2,
} from '../contracts/macroFullFeatureContractsL4BF2V2.mjs';
import { assertExplicitPinnedMacroId } from './macroIngestionPolicyL4BV1.mjs';

const expectedPolicy = () => normalizeMarketMacroInstrumentProjectionPolicyV2({
  schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION,
  ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES),
});

export function buildMarketMacroInstrumentProjectionPolicyV2() {
  const policy = expectedPolicy();
  return {
    instrumentProjectionPolicyId: canonicalHash(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION, policy),
    instrumentProjectionPolicy: policy,
    canonicalBytes: canonicalJsonBytes(policy),
  };
}

/** @param {{policyBytes: Buffer|Uint8Array, instrumentProjectionPolicyId: string}} input */
export function verifyMarketMacroInstrumentProjectionPolicyV2(input) {
  const code = 'MARKET_DATA_MACRO_INSTRUMENT_POLICY_MISMATCH';
  assertExplicitPinnedMacroId(input?.instrumentProjectionPolicyId, 'instrumentProjectionPolicyId');
  const bytes = Buffer.from(input.policyBytes ?? []);
  if (sha256Digest(bytes) !== input.instrumentProjectionPolicyId) {
    throw new MarketDataL3Error(code, 'macro instrument projection policy V2 bytes do not match their id');
  }
  const expected = buildMarketMacroInstrumentProjectionPolicyV2();
  if (!bytes.equals(expected.canonicalBytes) || expected.instrumentProjectionPolicyId !== input.instrumentProjectionPolicyId) {
    throw new MarketDataL3Error(code, 'stored macro instrument projection policy diverges from the closed V2 singleton');
  }
  const policy = normalizeMarketMacroInstrumentProjectionPolicyV2(JSON.parse(bytes.toString('utf8')));
  return {
    instrumentProjectionPolicyId: input.instrumentProjectionPolicyId,
    instrumentProjectionPolicy: policy,
  };
}
