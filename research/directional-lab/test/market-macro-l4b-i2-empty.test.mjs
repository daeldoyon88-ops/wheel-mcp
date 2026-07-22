import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMacroReleaseCalendarAsOf } from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { withEmptyMacroL4BI2Fixture } from './macroMaterializationL4BSyntheticFixture.mjs';

test('empty fixture reports a true empty materialization', () => withEmptyMacroL4BI2Fixture((ctx) => {
  const report = ctx.report.materializationReport;
  assert.equal(report.emptyMaterialization, true);
  assert.equal(report.observationCount, 0);
  assert.equal(report.releaseCalendarEventCount, 0);
}));
test('empty fixture binding remains explicit and complete', () => withEmptyMacroL4BI2Fixture((ctx) => {
  assert.equal(ctx.binding.binding.temporalCapability, 'POINT_IN_TIME_VINTAGE_COMPLETE');
  assert.match(ctx.binding.macroDatasetBindingId, /^sha256:/);
}));
test('empty calendar resolves unknown event as not available', () => withEmptyMacroL4BI2Fixture((ctx) => {
  const result = resolveMacroReleaseCalendarAsOf({ store: ctx.store, releaseEventIdentityId: `sha256:${'e'.repeat(64)}`,
    knowledgeCutoff: '2026-06-01T00:00:00.000Z',
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId });
  assert.equal(result.resolutionStatus, 'NOT_AVAILABLE');
}));
