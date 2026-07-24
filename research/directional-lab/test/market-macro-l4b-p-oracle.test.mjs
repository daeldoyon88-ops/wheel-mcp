import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  canonicalDigest,
} from '../src/contracts/marketDataL3CommonV1.mjs';
import {
  MARKET_MACRO_FAMILY_CODES,
} from '../src/contracts/marketMacroFeaturePublicationContractsL4BPV1.mjs';
import {
  MARKET_MACRO_L4BP_ORACLE_VECTORS,
} from './oracles/marketMacroFeaturePublicationL4BPOracle.mjs';

const oracleUrl = new URL('./oracles/marketMacroFeaturePublicationL4BPOracle.mjs', import.meta.url);

test('L4B-P oracle is statically isolated from production imports', () => {
  const source = readFileSync(oracleUrl, 'utf8');
  assert.equal(/^\s*import\s/mu.test(source), false);
  assert.equal(source.includes('src/'), false);
});

test('L4B-P oracle inventory is exactly 80 vectors', () => {
  assert.equal(MARKET_MACRO_L4BP_ORACLE_VECTORS.length, 80);
});

for (const vector of MARKET_MACRO_L4BP_ORACLE_VECTORS) {
  test(`L4B-P independent oracle ${vector.name}`, () => {
    if (vector.kind === 'DIGEST') {
      assert.match(canonicalDigest(vector.input), /^sha256:[0-9a-f]{64}$/u);
      assert.equal(canonicalDigest(vector.input), canonicalDigest(structuredClone(vector.input)));
    } else if (vector.kind === 'BOUNDARY') {
      assert.equal(vector.before >= vector.availableAt, true);
      assert.equal(vector.expectedAtBoundary, 'RESOLVED');
    } else if (vector.kind === 'STATUS') {
      const observed = vector.sessionCount === 0
        ? 'EMPTY'
        : vector.partial > 0 || vector.unavailable > 0
          ? 'PARTIAL'
          : 'PUBLISHED';
      assert.equal(observed, vector.expected);
    } else {
      const observed = [...vector.input].sort(
        (left, right) => MARKET_MACRO_FAMILY_CODES.indexOf(left)
          - MARKET_MACRO_FAMILY_CODES.indexOf(right));
      assert.deepEqual(observed, vector.expected);
    }
  });
}
