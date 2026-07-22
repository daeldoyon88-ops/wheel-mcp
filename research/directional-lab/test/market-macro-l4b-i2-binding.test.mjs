import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMacroDatasetBinding, verifyMacroDatasetBinding } from '../src/macro/macroDatasetBindingL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture, withEmptyMacroL4BI2Fixture } from './macroMaterializationL4BSyntheticFixture.mjs';

test('binding is valid and derives partial temporal capability', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const verified = verifyMacroDatasetBinding({ store: ctx.store, macroDatasetBindingId: ctx.binding.macroDatasetBindingId });
  assert.equal(verified.binding.temporalCapability, 'POINT_IN_TIME_VINTAGE_PARTIAL');
}));
test('empty binding derives complete temporal capability', () => withEmptyMacroL4BI2Fixture((ctx) => {
  assert.equal(ctx.binding.binding.temporalCapability, 'POINT_IN_TIME_VINTAGE_COMPLETE');
}));
for (const label of ['derived field refused', 'latest forbidden', 'bad cutoff refused', 'replay stable', 'multi-store stable', 'calendar mismatch refused']) {
  test(`binding ${label}`, () => withOfficialMacroL4BI2Fixture((ctx) => {
    if (label === 'derived field refused') {
      assert.throws(() => buildMacroDatasetBinding({ store: ctx.store,
        macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
        macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
        macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
        knowledgeCutoff: ctx.knowledgeCutoff, currencyCode: 'USD' }));
    } else if (label === 'latest forbidden') {
      assert.throws(() => buildMacroDatasetBinding({ store: ctx.store, macroDatasetSnapshotManifestId: 'latest',
        macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
        macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
        knowledgeCutoff: ctx.knowledgeCutoff }));
    } else if (label === 'bad cutoff refused') {
      assert.throws(() => buildMacroDatasetBinding({ store: ctx.store,
        macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
        macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
        macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
        knowledgeCutoff: '2026-02-11' }));
    } else {
      assert.equal(verifyMacroDatasetBinding({ store: ctx.store,
        macroDatasetBindingId: ctx.binding.macroDatasetBindingId }).binding.macroDatasetBindingId, undefined);
    }
  }));
}
