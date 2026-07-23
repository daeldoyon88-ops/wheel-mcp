import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canonicalJsonText } from '../src/canonical/canonicalJsonV1.mjs';
import { openOfficialMacroL4BF2Live } from './macroFullFeaturesL4BF2SyntheticFixture.mjs';

let first;
let reversed;

const EXPECTED_F2_GOLDEN_IDS = Object.freeze({
  instrumentProjectionPolicyId: 'sha256:20e04ff36e1276a502f4bbd7c3afd0ce63dd595217bde9501c8619112a7e195c',
  fullStateRowsId: 'sha256:7c178d0520a883291135fe86fe77db294def25a24b032ed86c5e06f473e12231',
  instrumentRowsId: 'sha256:1fd8523423f1c3c61f0dfed9c9105211fcd1e5919131819c64d4549eb42396b3',
  fullComputationReportId: 'sha256:dfaf1da62e43234c5dea644d8d0f5dc3d69c80b87d2c34e7f9a99f2a39aadd64',
});

before(() => {
  first = openOfficialMacroL4BF2Live();
  reversed = openOfficialMacroL4BF2Live({ reverseInsertion: true, addCasNoise: true });
});

after(() => {
  reversed?.close();
  first?.close();
});

function f2Ids(ctx) {
  return {
    instrumentProjectionPolicyId: ctx.projectionPolicy.instrumentProjectionPolicyId,
    fullStateRowsId: ctx.fullRows.fullStateRowsId,
    instrumentRowsId: ctx.instrumentRows.instrumentRowsId,
    fullComputationReportId: ctx.fullReport.fullComputationReportId,
  };
}

function f1Ids(ctx) {
  return {
    featureComputationPolicyId: ctx.featurePolicy.featureComputationPolicyId,
    sourceBundleId: ctx.sourceBundle.sourceBundleId,
    macroStateBySessionRowsId: ctx.f1Rows.macroStateBySessionRowsId,
    macroFeatureComputationReportId: ctx.f1Report.macroFeatureComputationReportId,
  };
}

test('multi-store replay reproduces all four F2 object IDs', () => {
  assert.deepEqual(f2Ids(reversed), f2Ids(first));
});

test('reverse insertion reproduces the projection policy bytes', () => {
  assert.equal(canonicalJsonText(reversed.projectionPolicy.instrumentProjectionPolicy),
    canonicalJsonText(first.projectionPolicy.instrumentProjectionPolicy));
});

test('reverse insertion reproduces full-state bytes', () => {
  assert.equal(canonicalJsonText(reversed.fullRows.marketMacroFullStateRows),
    canonicalJsonText(first.fullRows.marketMacroFullStateRows));
});

test('reverse insertion reproduces instrument projection bytes', () => {
  assert.equal(canonicalJsonText(reversed.instrumentRows.marketMacroInstrumentRows),
    canonicalJsonText(first.instrumentRows.marketMacroInstrumentRows));
});

test('reverse insertion and unrelated CAS noise reproduce report bytes', () => {
  assert.equal(canonicalJsonText(reversed.fullReport.fullComputationReport),
    canonicalJsonText(first.fullReport.fullComputationReport));
});

test('expanded fixture F1 quartet is deterministic across stores', () => {
  assert.deepEqual(f1Ids(reversed), f1Ids(first));
});

test('macro binding, vintage set and instrument registry pins are deterministic', () => {
  assert.equal(reversed.binding.macroDatasetBindingId, first.binding.macroDatasetBindingId);
  assert.equal(reversed.vintageSet.macroVintageSetManifestId, first.vintageSet.macroVintageSetManifestId);
  assert.equal(reversed.instrumentRegistry.registryManifestId, first.instrumentRegistry.registryManifestId);
});

test('ordered report digests are insertion-order invariant', () => {
  const a = first.fullReport.fullComputationReport;
  const b = reversed.fullReport.fullComputationReport;
  assert.equal(b.orderedFullStateRowDigest, a.orderedFullStateRowDigest);
  assert.equal(b.orderedInstrumentRowDigest, a.orderedInstrumentRowDigest);
  assert.equal(b.orderedFullProvenanceDigest, a.orderedFullProvenanceDigest);
});

test('multi-store classifications, counters and provenances are identical', () => {
  assert.deepEqual(reversed.fullReport.fullComputationReport, first.fullReport.fullComputationReport);
  assert.deepEqual(reversed.fullRows.marketMacroFullStateRows.rows
    .map((row) => row.fullProvenanceState),
  first.fullRows.marketMacroFullStateRows.rows.map((row) => row.fullProvenanceState));
});

test('F2 golden ID inventory is four valid content addresses', (t) => {
  const ids = f2Ids(first);
  assert.equal(Object.keys(ids).length, 4);
  assert.ok(Object.values(ids).every((id) => /^sha256:[0-9a-f]{64}$/u.test(id)));
  assert.deepEqual(ids, EXPECTED_F2_GOLDEN_IDS);
  t.diagnostic(`L4B-F2-GOLDEN ${JSON.stringify(ids)}`);
});
