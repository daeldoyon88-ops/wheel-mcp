import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  SOURCE_BASIS_DECLARATION_SHA256_R1,
  deriveJarviseSourceBindingIdR1,
  deriveJarviseObservationDatasetIdR1,
  deriveJarviseFeatureDatasetIdR1,
  deriveJarviseDatasetIdentityTripleR1,
  verifyJarviseFeatureDatasetCohortR1,
} from './jarviseDatasetIdentityTripleR1.mjs';
import { canonicalize } from '../../governance/tools/canonical-json.mjs';
import { CALENDAR_WINDOW_BINDING } from '../../governance/gates/GATE23/fixtures/calendar-window-fixture.mjs';

const sha = (value) => createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
const bytes = readFileSync(new URL('./yahooSourceBasisDeclarationR1.json', import.meta.url));
const sourcePreimage = {
  schemaVersion: 'R2SourceBinding/1', sourceId: 'YAHOO_CHART_EOD', plane: 'HISTORICAL',
  sourceBasisDeclarationPath: 'app/jarvise/yahooSourceBasisDeclarationR1.json',
  sourceBasisDeclarationSha256: SOURCE_BASIS_DECLARATION_SHA256_R1,
};
const K = '2025-03-07T21:00:00.000Z';
const instrumentIdentityId = 'a'.repeat(64);
const bar = (sessionDate, close, eventTime = `${sessionDate}T21:00:00.000Z`) => ({
  schemaVersion: 'DailyBarV1/1', sessionDate, eventTime, availableAt: eventTime,
  adjusted: { open: close - 1, high: close + 1, low: close - 2, close, volume: 1000, adjustmentType: 'SPLIT_ADJUSTED' },
});
const bridge = (records = [bar('2025-03-05', 100), bar('2025-03-06', 101), bar('2025-03-07', 102)]) => ({
  status: 'AVAILABLE', sourceId: 'YAHOO_CHART_EOD', historicalPlaneStatus: 'HISTORICAL',
  priceBasis: 'SPLIT_ADJUSTED', effectiveKnowledgeCutoff: K, records,
});
const observation = () => deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: bridge(), instrumentIdentityId });
const feature = () => deriveJarviseFeatureDatasetIdR1({ datasetIdObservation: observation().datasetIdObservation, calendarWindowBinding: CALENDAR_WINDOW_BINDING });
const throws = (fn, code) => assert.throws(fn, (error) => error?.code === code);

assert.equal(createHash('sha256').update(bytes).digest('hex'), SOURCE_BASIS_DECLARATION_SHA256_R1); // T1
const source = deriveJarviseSourceBindingIdR1();
assert.equal(source.sourceBindingId, sha(sourcePreimage)); // T2
throws(() => deriveJarviseSourceBindingIdR1({ sourceBasisDeclarationBytes: Buffer.concat([bytes, Buffer.from(' ')]) }), 'SOURCE_BINDING_DECLARATION_DRIFT'); // T3

const obsA = observation();
const obsB = observation();
assert.equal(obsA.datasetIdObservation, obsB.datasetIdObservation); // T4
const reversed = deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: bridge([...bridge().records].reverse()), instrumentIdentityId });
assert.equal(obsA.datasetIdObservation, reversed.datasetIdObservation); // T5
assert.notEqual(obsA.datasetIdObservation, deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: bridge([bar('2025-03-05', 100), bar('2025-03-06', 999), bar('2025-03-07', 102)]), instrumentIdentityId }).datasetIdObservation); // T6
assert.notEqual(obsA.datasetIdObservation, deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: { ...bridge(), effectiveKnowledgeCutoff: '2025-03-08T21:00:00.000Z', records: [bar('2025-03-05', 100), bar('2025-03-06', 101), bar('2025-03-07', 102)] }, instrumentIdentityId }).datasetIdObservation); // T7
assert.notEqual(obsA.datasetIdObservation, sha({ ...obsA.observationDatasetPreimage, sourceBindingId: 'b'.repeat(64) })); // T8 independent preimage sensitivity
assert.notEqual(obsA.datasetIdObservation, deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: bridge(), instrumentIdentityId: 'b'.repeat(64) }).datasetIdObservation); // T9
assert.notEqual(obsA.datasetIdObservation, sha({ ...obsA.observationDatasetPreimage, priceBasisId: 'RAW' })); // T10 identity sensitivity
throws(() => deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: bridge(), instrumentIdentityId, priceBasisId: 'RAW' }), 'PRICE_BASIS_ID_PRODUCTION_GAP'); // production basis is fail-closed
assert.equal(obsA.datasetIdObservation, deriveJarviseObservationDatasetIdR1({ g21BridgeOutput: { ...bridge(), requestedKnowledgeCutoff: '1999-01-01T00:00:00.000Z', capturedAt: '2030-01-01T00:00:00.000Z' }, instrumentIdentityId }).datasetIdObservation); // T11/T12

const featureA = feature();
assert.equal(featureA.datasetIdFeature, feature().datasetIdFeature); // T13
assert.equal(featureA.datasetIdFeature, sha({ schemaVersion: 'R2FeatureDataset/1', datasetIdObservation: obsA.datasetIdObservation, featureDefinitionSet: [...featureA.featureDefinitionSet].reverse().sort((a, b) => a.featureDefinitionId.localeCompare(b.featureDefinitionId) || a.featureWindowSpecId.localeCompare(b.featureWindowSpecId)), materializerModuleVersion: 'GATE23_FeatureMaterializer/1' })); // T14
assert.notEqual(featureA.datasetIdFeature, deriveJarviseFeatureDatasetIdR1({ datasetIdObservation: 'b'.repeat(64), calendarWindowBinding: CALENDAR_WINDOW_BINDING }).datasetIdFeature); // T15
assert.notEqual(featureA.datasetIdFeature, sha({ ...featureA.featureDatasetPreimage, featureDefinitionSet: [...featureA.featureDefinitionSet, { featureDefinitionId: 'F2', formulaId: 'F2/1', featureWindowSpecId: 'c'.repeat(64) }] })); // T16
assert.notEqual(featureA.datasetIdFeature, sha({ ...featureA.featureDatasetPreimage, featureDefinitionSet: featureA.featureDefinitionSet.map((item) => ({ ...item, formulaId: 'changed/1' })) })); // T17
assert.notEqual(featureA.datasetIdFeature, sha({ ...featureA.featureDatasetPreimage, materializerModuleVersion: 'changed/1' })); // T18

const records = featureA.featureDefinitionSet.map((item, index) => ({
  featureRecordId: String(index + 1).repeat(64),
  identity: {
    InstrumentIdentityId: instrumentIdentityId, SessionDate: '2025-03-07', KnowledgeCutoff: K,
    FeatureDefinitionId: item.featureDefinitionId, FormulaId: item.formulaId, FeatureWindowSpecId: item.featureWindowSpecId,
    SourceBindingId: source.sourceBindingId, DatasetId_observation: obsA.datasetIdObservation, PriceBasisId: 'SPLIT_ADJUSTED', MissingnessStateId: 'GATE23_MissingnessState/1:COMPLETE',
  },
}));
assert.equal(verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records, calendarWindowBinding: CALENDAR_WINDOW_BINDING }).status, 'VERIFIED'); // T19/T29/T30
assert.equal(verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r) => ({ ...r, identity: { ...r.identity, SessionDate: '2025-03-06' } })), calendarWindowBinding: CALENDAR_WINDOW_BINDING }).status, 'VERIFIED'); // T19: session rows do not enter DatasetId_feature
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: 'd'.repeat(64), featureRecords: records, calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_ID_MISMATCH'); // T20
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: obsA.datasetIdObservation, featureRecords: records, calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_FIXTURE_ALIAS_FORBIDDEN'); // T21
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: 'e'.repeat(64), datasetIdFeature: featureA.datasetIdFeature, featureRecords: records, calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_ID_MISMATCH'); // T22
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r, i) => i ? r : { ...r, identity: { ...r.identity, SourceBindingId: 'f'.repeat(64) } }), calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_SOURCE_BINDING_MISMATCH'); // T23
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r, i) => i ? r : { ...r, identity: { ...r.identity, InstrumentIdentityId: 'b'.repeat(64) } }), calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_INSTRUMENT_MIXED'); // T24
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r, i) => i ? r : { ...r, identity: { ...r.identity, KnowledgeCutoff: '2025-03-07T22:00:00.000Z' } }), calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_KNOWLEDGE_CUTOFF_MIXED'); // T25
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r, i) => i ? r : { ...r, identity: { ...r.identity, FeatureDefinitionId: 'F2', FormulaId: 'F2/1' } }), calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_FEATURE_COHORT_MISMATCH'); // T26
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: [...records, records[0]], calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_DUPLICATE_RECORD'); // T27
throws(() => verifyJarviseFeatureDatasetCohortR1({ datasetIdObservation: obsA.datasetIdObservation, datasetIdFeature: featureA.datasetIdFeature, featureRecords: records.map((r, i) => i ? r : { ...r, OutcomeId: 'forbidden' }), calendarWindowBinding: CALENDAR_WINDOW_BINDING }), 'FEATURE_DATASET_OUTCOME_FORBIDDEN'); // T28

const triple = deriveJarviseDatasetIdentityTripleR1({ g21BridgeOutput: bridge(), instrumentIdentityId, calendarWindowBinding: CALENDAR_WINDOW_BINDING });
assert.equal(triple.datasetIdFeature, featureA.datasetIdFeature);
assert.ok(Object.isFrozen(triple) && Object.isFrozen(triple.admittedBars) && Object.isFrozen(triple.featureDefinitionSet));
console.log('WHEEL_JARVISE_DATASET_IDENTITY_TRIPLE_R2_BUILD_R1_TEST_PASS');
