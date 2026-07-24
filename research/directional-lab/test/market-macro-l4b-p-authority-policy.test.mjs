import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKET_MACRO_AUTHORITY_POLICY_VALUES,
  normalizeMarketMacroFeatureAuthorityPolicyV1,
} from '../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import { samplePolicy } from './helpers/marketMacroFeaturePublicationSamplesL4BPV1.mjs';

test('closed L4B-P authority policy round-trips', () => {
  assert.deepEqual(normalizeMarketMacroFeatureAuthorityPolicyV1(samplePolicy()),
    MARKET_MACRO_AUTHORITY_POLICY_VALUES);
});

for (const field of Object.keys(MARKET_MACRO_AUTHORITY_POLICY_VALUES)) {
  if (field === 'schemaVersion') continue;
  test(`authority policy rejects divergence: ${field}`, () => {
    const value = samplePolicy();
    value[field] = typeof value[field] === 'boolean' ? !value[field] : `${value[field]}_FORGED`;
    assert.throws(() => normalizeMarketMacroFeatureAuthorityPolicyV1(value));
  });
}

for (const field of Object.keys(MARKET_MACRO_AUTHORITY_POLICY_VALUES)) {
  test(`authority policy rejects missing field: ${field}`, () => {
    const value = samplePolicy();
    delete value[field];
    assert.throws(() => normalizeMarketMacroFeatureAuthorityPolicyV1(value));
  });
}
