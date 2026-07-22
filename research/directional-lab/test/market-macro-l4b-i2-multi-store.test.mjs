import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import { withOfficialMacroL4BI2Fixture } from './macroMaterializationL4BSyntheticFixture.mjs';

export const GOLDEN_L4B_I2 = Object.freeze({
  macroAsOfResolutionPolicyId: 'sha256:f482d0ce1c4271189bfddb5342663282dfa645fb6582241c96d06d069fe91842',
  calendar: 'sha256:fd0f3e962167cd519d7943d8c61062e6b10d11c5616cd4f078fa8e750e9212ce',
  binding: 'sha256:5323f7b00a4b19daa80e88bcb80aae172f8bcfabf0337175af8891af7e6b1d54',
  report: 'sha256:ee1b34d8a2265c7df7b0852d9ef72fc6e7b874f0e3dcc5debcb77d1d85a62af7',
});
function fingerprint(ctx) {
  return { macroAsOfResolutionPolicyId: ctx.asOf.macroAsOfResolutionPolicyId,
    calendar: ctx.calendar.macroReleaseCalendarRegistryManifestId, binding: ctx.binding.macroDatasetBindingId,
    report: ctx.report.macroMaterializationReportId,
    bytes: [ctx.asOf.macroAsOfResolutionPolicy, ctx.calendar.registry, ctx.binding.binding, ctx.report.materializationReport]
      .map((value) => canonicalJsonBytes(value).toString('hex')) };
}
test('store A and B produce identical I2 IDs and bytes', () => {
  assert.deepEqual(withOfficialMacroL4BI2Fixture(fingerprint), withOfficialMacroL4BI2Fixture(fingerprint));
});
test('official I2 fixture reproduces pinned golden IDs', () => {
  const actual = withOfficialMacroL4BI2Fixture((ctx) => {
    const { bytes, ...ids } = fingerprint(ctx); return ids;
  });
  assert.deepEqual(actual, GOLDEN_L4B_I2);
});
test('I1 golden IDs remain unchanged after I2 construction', () => withOfficialMacroL4BI2Fixture((ctx) => {
  assert.equal(ctx.macroIngestionPolicyId, 'sha256:ff11152134d49f95c1bc8b7a152aea7833d0bb4094103944ee1214f0cc43f1b2');
  assert.equal(ctx.registry.macroSeriesRegistryManifestId, 'sha256:d7a47060b96a49f2971e89d173b7c75d6a5d639f493204d19cd3f6a3583863f6');
  assert.equal(ctx.vintageSet.macroVintageSetManifestId, 'sha256:8d8651c2db49a87e86975b3b9e637121b369ea0ae29100bb250a871ca970fa95');
  assert.equal(ctx.snapshot.macroDatasetSnapshotManifestId, 'sha256:b74883aba3a7dc7301363227826c46010e7d8953a50dbdba2d8e8503a573cd83');
}));
