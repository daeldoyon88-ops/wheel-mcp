import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORACLE_VECTORS, oracleSelectVintageAsOf, oracleSelectCalendarAsOf, oracleDigest,
  oracleHasCycle, oracleHasConflict,
} from './helpers/independentMacroMaterializationOracleL4BV1.mjs';

test('oracle static isolation guard permits only crypto and canonical JSON imports', () => {
  const source = readFileSync(new URL('./helpers/independentMacroMaterializationOracleL4BV1.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['src/macro/', 'resolveMacro', 'buildMacro', 'verifyMacro', 'macroMaterializationL4B']) assert.equal(source.includes(forbidden), false);
  assert.deepEqual((source.match(/from '[^']+'/g) ?? []).sort(), [
    "from '../../src/canonical/canonicalJsonV1.mjs'", "from 'node:crypto'",
  ]);
});
test('oracle supplies at least fifty independent vectors', () => assert.equal(ORACLE_VECTORS.length >= 50, true));
for (const vector of ORACLE_VECTORS) {
  test(`oracle vector ${vector.id}`, () => {
    let actual;
    if (vector.kind === 'vintage') actual = oracleSelectVintageAsOf(vector.input.vintages, vector.input.knowledgeCutoff);
    else if (vector.kind === 'calendar') actual = oracleSelectCalendarAsOf(vector.input.versions, vector.input.knowledgeCutoff);
    else if (vector.kind === 'digest') actual = oracleDigest(vector.input);
    else if (vector.kind === 'cycle') actual = oracleHasCycle(vector.input);
    else actual = oracleHasConflict(vector.input);
    if (typeof actual === 'object') {
      assert.equal(actual.status, vector.expected);
      if (vector.selected !== undefined) assert.equal(actual.selected?.id, vector.selected);
    } else assert.equal(actual, vector.expected);
  });
}
