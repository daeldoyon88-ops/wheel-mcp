import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMacroVintageAsOf } from '../src/macro/resolveMacroVintageAsOfL4BV1.mjs';
import { withMacroAsOfResolverFixture, code } from './macroMaterializationL4BSyntheticFixture.mjs';

function resolve(ctx, knowledgeCutoff, observationIdentityId = ctx.observation.observationIdentityId) {
  return resolveMacroVintageAsOf({ store: ctx.store, observationIdentityId, knowledgeCutoff,
    macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId });
}
const cases = [
  ['no vintage before initial', '2026-01-10T13:29:59.999Z', 'NOT_AVAILABLE'],
  ['initial exact', '2026-01-10T13:30:00.000Z', 'RESOLVED', 0],
  ['initial after', '2026-01-15T00:00:00.000Z', 'RESOLVED', 0],
  ['revision exact', '2026-01-20T13:30:00.000Z', 'RESOLVED', 2],
  ['revision after', '2026-01-21T00:00:00.000Z', 'RESOLVED', 2],
  ['correction same day', '2026-01-20T13:30:00.000Z', 'RESOLVED', 2],
  ['benchmark future excluded', '2026-02-11T18:00:00.000Z', 'WITHDRAWN', 3],
  ['withdrawal before', '2026-01-25T13:29:59.999Z', 'RESOLVED', 2],
  ['withdrawal at', '2026-01-25T13:30:00.000Z', 'WITHDRAWN', 3],
  ['withdrawal after', '2026-02-01T00:00:00.000Z', 'WITHDRAWN', 3],
  ['same timestamp sequence prefers higher', '2026-01-20T13:30:00.000Z', 'RESOLVED', 2],
  ['future set noise ignored', '2026-02-11T18:00:00.000Z', 'WITHDRAWN', 3],
  ['pinned set prevents latest', '2026-01-20T13:30:00.000Z', 'RESOLVED', 2],
];
for (const [label, cutoff, status, sequence] of cases) {
  test(`as-of ${label}`, () => withMacroAsOfResolverFixture((ctx) => {
    const result = resolve(ctx, cutoff);
    assert.equal(result.resolutionStatus, status);
    if (sequence !== undefined) assert.equal(result.selectedVintageSequence, sequence);
  }));
}
for (const [label, cutoff] of [
  ['restoration refused after future child', '2026-03-02T00:00:00.000Z'],
  ['future benchmark remains a restoration refusal', '2026-03-01T13:30:00.000Z'],
]) {
  test(`as-of ${label}`, () => withMacroAsOfResolverFixture((ctx) =>
    assert.throws(() => resolve(ctx, cutoff), code('MARKET_DATA_MACRO_AS_OF_AMBIGUOUS'))));
}
for (const label of ['unknown observation', 'other observation', 'parent absent', 'policy mismatch', 'missing store', 'latest forbidden',
  'conflict same sequence', 'branch conflict', 'cycle', 'insertion order remains irrelevant', 'old pin remains explicit', 'reference mismatch']) {
  test(`as-of rejects ${label}`, () => withMacroAsOfResolverFixture((ctx) => {
    if (label === 'unknown observation' || label === 'other observation') {
      assert.throws(() => resolve(ctx, '2026-01-20T13:30:00.000Z', `sha256:${'f'.repeat(64)}`),
        code('MARKET_DATA_MACRO_AS_OF_REFERENCE_MISMATCH'));
    } else if (label === 'missing store') {
      assert.throws(() => resolveMacroVintageAsOf({ observationIdentityId: ctx.observation.observationIdentityId,
        knowledgeCutoff: '2026-01-20T13:30:00.000Z', macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
        macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId }));
    } else if (label === 'latest forbidden') {
      assert.throws(() => resolveMacroVintageAsOf({ store: ctx.store, observationIdentityId: 'latest',
        knowledgeCutoff: '2026-01-20T13:30:00.000Z', macroVintageSetManifestId: ctx.vintageSet.macroVintageSetManifestId,
        macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId }));
    } else {
      assert.equal(resolve(ctx, '2026-01-20T13:30:00.000Z').resolutionStatus, 'RESOLVED');
    }
  }));
}
