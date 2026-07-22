import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORACLE_VECTORS,
  oracleSelectAtClose,
  oracleCarryForwardAge,
  oracleStaleness,
  oracleSpread,
  oracleSpreadClass,
  oracleCurveShape,
  oracleCurveDirection,
  oraclePolicyDirection,
  oracleFomcDecision,
  oracleCalendarTip,
  oracleCompleteness,
  oracleDigest,
  oracleSessionOrder,
} from './helpers/independentMacroFeaturesOracleL4BV1.mjs';

test('oracle static isolation guard permits only crypto and canonical JSON imports', () => {
  const source = readFileSync(new URL('./helpers/independentMacroFeaturesOracleL4BV1.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    'src/macro/', 'buildMacro', 'verifyMacro', 'computeMacro', 'computeRate',
    'computeCurve', 'computeFomc', 'macroFeaturesL4B',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.deepEqual((source.match(/from '[^']+'/g) ?? []).sort(), [
    "from '../../src/canonical/canonicalJsonV1.mjs'", "from 'node:crypto'",
  ]);
});

test('oracle supplies at least seventy independent vectors', () => {
  assert.ok(ORACLE_VECTORS.length >= 70, `expected >=70, got ${ORACLE_VECTORS.length}`);
});

for (const vector of ORACLE_VECTORS) {
  test(`oracle vector ${vector.id}`, () => {
    let actual;
    if (vector.kind === 'atClose') {
      actual = oracleSelectAtClose(vector.input.vintages, vector.input.sessionCloseUtc);
      assert.equal(actual.status, vector.expected);
      if (vector.selected !== undefined) assert.equal(actual.selected?.id, vector.selected);
    } else if (vector.kind === 'carryAge') {
      actual = oracleCarryForwardAge(
        vector.input.landingCloseUtc,
        vector.input.sessionCloseUtc,
        vector.input.orderedSessionCloses,
      );
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'staleness') {
      actual = oracleStaleness(vector.input.age, vector.input.limit);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'spread') {
      actual = oracleSpread(vector.input.leftAtoms, vector.input.rightAtoms);
      assert.deepEqual(actual, vector.expected);
    } else if (vector.kind === 'spreadClass') {
      actual = oracleSpreadClass(vector.input.spreadAtoms);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'curveShape') {
      actual = oracleCurveShape(vector.input.requiredClasses);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'curveDirection') {
      actual = oracleCurveDirection(vector.input.change10y2y, vector.input.change10y3m);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'policyDirection') {
      actual = oraclePolicyDirection(vector.input.midpointChange);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'fomc') {
      actual = oracleFomcDecision(
        vector.input.lowerChange, vector.input.upperChange,
        vector.input.midpointChange, vector.input.withdrawn,
      );
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'calendar') {
      actual = oracleCalendarTip(vector.input.versions, vector.input.knowledgeCutoff);
      assert.equal(actual.status, vector.expected);
      if (vector.selected !== undefined) assert.equal(actual.selected?.id, vector.selected);
    } else if (vector.kind === 'completeness') {
      actual = oracleCompleteness(vector.input.available, vector.input.required);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'digest') {
      actual = oracleDigest(vector.input);
      assert.equal(actual, vector.expected);
    } else if (vector.kind === 'digestPrefix') {
      const a = oracleDigest(vector.input.base);
      const b = oracleDigest(vector.input.extended);
      assert.notEqual(a, b);
    } else if (vector.kind === 'sessionOrder') {
      actual = oracleSessionOrder(vector.input.left, vector.input.right);
      assert.equal(actual, vector.expected);
    } else {
      throw new Error(`unknown vector kind ${vector.kind}`);
    }
  });
}
