import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMacroAsOfResolutionPolicy } from '../src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { buildMacroDatasetBinding } from '../src/macro/macroDatasetBindingL4BV1.mjs';
import { buildMacroMaterializationReport } from '../src/macro/macroMaterializationReportL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture } from './macroMaterializationL4BSyntheticFixture.mjs';

test('as-of policy replay is byte-identical by CAS identity', () => withOfficialMacroL4BI2Fixture((ctx) =>
  assert.equal(buildMacroAsOfResolutionPolicy({ store: ctx.store }).macroAsOfResolutionPolicyId, ctx.asOf.macroAsOfResolutionPolicyId)));
test('binding replay is identity-identical', () => withOfficialMacroL4BI2Fixture((ctx) =>
  assert.equal(buildMacroDatasetBinding({ store: ctx.store, macroDatasetSnapshotManifestId: ctx.snapshot.macroDatasetSnapshotManifestId,
    macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
    knowledgeCutoff: ctx.knowledgeCutoff }).macroDatasetBindingId, ctx.binding.macroDatasetBindingId)));
test('materialization replay is identity-identical', () => withOfficialMacroL4BI2Fixture((ctx) =>
  assert.equal(buildMacroMaterializationReport({ store: ctx.store,
    macroDatasetBindingId: ctx.binding.macroDatasetBindingId }).macroMaterializationReportId,
  ctx.report.macroMaterializationReportId)));
