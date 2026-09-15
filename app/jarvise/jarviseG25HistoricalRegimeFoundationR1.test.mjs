import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname, relative, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { simpleReturn } from '../../governance/gates/GATE23/implementation/feature-families-v1.mjs';
import { createFeatureWindowSpec, resolveTrailingWindow } from '../../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { createRegimeRecordId } from '../../governance/gates/GATE24/implementation/regime-identity-v1.mjs';
import { emitRegimeRecord } from '../../governance/gates/GATE24/implementation/regime-store-v1.mjs';
import { createMacroContextBinding } from '../../governance/gates/GATE24/implementation/macro-context-binding-v1.mjs';
import { classifyRegimeVector } from '../../governance/gates/GATE24/implementation/regime-classifier-v1.mjs';
import { createRegimeHorizonSpec } from '../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { ACTIVE_DIMENSION_NAMES_V1, isClassifyingValue } from '../../governance/gates/GATE24/implementation/regime-taxonomy-v1.mjs';
import { resolveInstrumentIdentityAsOf } from '../../research/directional-lab/src/data/buildInstrumentIdentity.mjs';
import { produceJarviseEmptyMacroContextR1 } from './jarviseEmptyMacroContextProducerR1.mjs';
import { computeRealizedVolatilityR1 } from './jarviseG25HistoricalRealizedVolatilityR1.mjs';
import {
  coreV1ClassificationR1,
  emitJarviseG25HistoricalRegimeRecordR1,
  foundationD1MembersR1,
  loadJarviseG25HistoricalRegimeFoundationR1,
  projectGate25AnalogueInputsR1,
  readP3hAdmittedBarsR1,
} from './jarviseG25HistoricalRegimeFoundationR1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const V2_BINDING = '3fe7456e03175fc49fb8af810d2050e58f34d2e3d548b27ad071db8957882308';
const V1_BINDING = 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023';
const EXPECTED = Object.freeze({
  v2: { regimeHorizonSpecId: 'e81078bf9d3efc68ed2a355b16ce6cc4253fc9e42bfc06e42c01f161396b1475', classifierVersionId: '5964c13f26ce24bd75b8ab60ed51887a1a105bfbd4397dfe30b24a86e862eeda', parameterSetId: 'cbb582e57b0acd788aa6973ad7c4f4985521825a318b4af1b33af49ecf746868' },
  v1: { regimeHorizonSpecId: 'f9766b932b62c14ccac05753402e26d990b363296e6d399b37bb8586aee68c88', classifierVersionId: '08d4d7e65a831d8cdef25d9f3beb5c800c7f203408079ecb82e379825e121a49', parameterSetId: '52ca49f2d4adbcb70c66b4c9830b311a1eefed783a717a684e551dcc512385b2' },
  /* CPI successor policy V2 (ENDPOINTS_M_AND_M_MINUS_12_REQUIRED) is bound through availableAtPolicyId. */
  macroContextBindingId: 'cf802fa6dee61c578a4615084820d15c3e58d0b27d9347501ae58e162bbed0ef',
  /* The superseded V1-window historical binding (availableAtPolicyId = bare as-of policy); never reused. */
  previousMacroContextBindingId: '92951627733babfc9416802d6ad43961d1adb2a925c0f3439a8b668c1f82ccde',
});
const V1_CPI_POLICY_PATHS = Object.freeze([
  'research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroInflationFeaturesL4BF2V1.mjs',
  'research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroFixedPointRatioL4BF2V1.mjs',
  'research/directional-lab/src/canonical/canonicalSchemaRegistryV1.mjs',
]);
const GATE24_REGIME_RECORD_KEYS = ['schemaVersion', 'regimeRecordId', 'identity', 'identityTuple', 'identityMemberCount', 'InstrumentIdentityId', 'SessionDate', 'KnowledgeCutoff', 'RegimeHorizonSpecId', 'FeatureVectorBindingId', 'MacroContextBindingId', 'RegimeTaxonomyVersionId', 'ClassifierVersionId', 'ParameterSetId', 'DatasetId_feature', 'MissingnessStateId', 'knowledgeCutoffBoundary', 'regimeVector', 'classificationQuality', 'classificationEvidence', 'evidenceSetId', 'missingnessState', 'missingnessStateId', 'missingnessPolicyVersion', 'missingnessModel', 'macroFeatureCompleteness', 'activeDimensions', 'inactiveDimensions'];
const FEATURE_VECTOR_BINDING_KEYS = ['schemaVersion', 'instrumentIdentityId', 'sessionDate', 'knowledgeCutoff', 'datasetIdFeature', 'featureRecordIds', 'featureWindowSpecIds', 'calendarWindowBindingIds', 'featureVectorBindingId'];

const networkCalls = [];
let foundation;
let aapl;
let aaplBars;
const emit = (sessionDate, overrides = {}) => emitJarviseG25HistoricalRegimeRecordR1({ foundation, entry: aapl, keyBars: aaplBars, sessionDate, ...overrides });

test.before(() => {
  const trap = (name) => () => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();
  foundation = loadJarviseG25HistoricalRegimeFoundationR1();
  aapl = foundation.p3h.admittedEntries.find((entry) => entry.providerSymbol === 'AAPL');
  aaplBars = readP3hAdmittedBarsR1({ p3h: foundation.p3h, entry: aapl });
});

test('Calendar V2 identities differ lawfully from V1 and V1 production identities are unchanged', () => {
  assert.equal(foundation.calendarWindowBinding.calendarWindowBindingId, V2_BINDING);
  assert.deepEqual({ regimeHorizonSpecId: foundation.v2.horizon.regimeHorizonSpecId, classifierVersionId: foundation.v2.classifier.classifierVersionId, parameterSetId: foundation.v2.parameterSet.parameterSetId }, EXPECTED.v2);
  const v1 = foundation.productionFoundation;
  assert.deepEqual({ regimeHorizonSpecId: v1.horizon.regimeHorizonSpecId, classifierVersionId: v1.classifier.classifierVersionId, parameterSetId: v1.parameterSet.parameterSetId }, EXPECTED.v1);
  assert.equal(v1.registry.calendarWindowBindingId, V1_BINDING);
  assert.equal(foundation.v2.horizon.regimeHorizonSpecId, createRegimeHorizonSpec({ sessionCount: 21, calendarWindowBindingId: V2_BINDING }).regimeHorizonSpecId);
  assert.equal(v1.horizon.regimeHorizonSpecId, createRegimeHorizonSpec({ sessionCount: 21, calendarWindowBindingId: V1_BINDING }).regimeHorizonSpecId);
  const strip = (set) => set.parameters.map(({ dimension, parameterName, value }) => ({ dimension, parameterName, value }));
  assert.equal(sha256Canonical(strip(foundation.v2.parameterSet)), sha256Canonical(strip(v1.parameterSet)));
  assert.equal(foundation.v2.classifier.classifierVersionLabel, v1.classifier.classifierVersionLabel);
  assert.equal(foundation.v2.parameterSet.parameterSetLabel, v1.parameterSet.parameterSetLabel);
  assert.deepEqual([...foundation.v2.classifier.activeRegimeHorizonSpecIds], [EXPECTED.v2.regimeHorizonSpecId]);
});

test('CPI successor policy: retained horizon/classifier/parameter ids are legitimately invariant; the macro binding id is new', () => {
  /* The governed preimages of the three retained ids carry no macro derivation input at all. */
  const { regimeHorizonSpecId, ...horizonPreimage } = foundation.v2.horizon;
  const { classifierVersionId, closureRule, parameterSetIdIsInput, ...classifierPreimage } = foundation.v2.classifier;
  const { parameterSetId, ...parameterPreimage } = foundation.v2.parameterSet;
  for (const preimage of [horizonPreimage, classifierPreimage, parameterPreimage]) {
    assert.equal(/cpi|inflationFeatures|monthlyWindow|ProjectionPolicy|availableAtPolicy|macroContext/i.test(JSON.stringify(Object.keys(preimage))), false);
  }
  assert.equal(regimeHorizonSpecId, EXPECTED.v2.regimeHorizonSpecId);
  assert.equal(classifierVersionId, EXPECTED.v2.classifierVersionId);
  assert.equal(parameterSetId, EXPECTED.v2.parameterSetId);
  /* The inflationState parameters are the ratified thresholds on the cpiYoY value, unchanged. */
  assert.deepEqual(foundation.v2.parameterSet.parameters.filter((item) => item.dimension === 'inflationState').map(({ parameterName, value }) => [parameterName, value]).sort(), [['disinflationaryMax', 1], ['inflationaryMin', 3], ['seriesCode', 'cpiYoY']]);
  /* The macro binding preimage changed only through availableAtPolicyId, and the id changed with it. */
  const binding = foundation.macro.macroContextBinding;
  const projection = foundation.macroAuthority.projection;
  assert.equal(binding.macroContextBindingId, EXPECTED.macroContextBindingId);
  assert.notEqual(binding.availableAtPolicyId, projection.macroAsOfResolutionPolicyId);
  const previous = createMacroContextBinding({ macroVintageSetManifestId: projection.macroVintageSetManifestId, macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId, availableAtPolicyId: projection.macroAsOfResolutionPolicyId });
  assert.equal(previous.macroContextBindingId, EXPECTED.previousMacroContextBindingId);
  assert.notEqual(previous.macroContextBindingId, binding.macroContextBindingId);
  const { macroContextBindingId: _a, availableAtPolicyId: _b, ...rest } = binding;
  const { macroContextBindingId: _c, availableAtPolicyId: _d, ...previousRest } = previous;
  assert.deepEqual(rest, previousRest);
});

test('closed GATE21-24 canonical bytes, the V1 production foundation and the closed P2 surfaces equal HEAD', () => {
  const paths = execFileSync('git', ['ls-files', '--', 'governance/gates/GATE21', 'governance/gates/GATE22', 'governance/gates/GATE23', 'governance/gates/GATE24', 'data/jarvise/regime-config', 'data/jarvise/macro-context', 'app/jarvise/jarviseG24ProductionFoundationR1.mjs', 'app/jarvise/jarviseG24RatifiedParametersR1.mjs', 'app/jarvise/jarvisePipelineR1.mjs', 'app/jarvise/jarviseHistoricalCalendarBindingR1.mjs', 'app/jarvise/jarviseDatasetIdentityTripleR1.mjs', ...V1_CPI_POLICY_PATHS], { cwd: ROOT }).toString('utf8').split('\n').filter(Boolean);
  assert.ok(paths.length > 100);
  for (const path of V1_CPI_POLICY_PATHS) assert.ok(paths.includes(path), path);
  const committed = new Map(execFileSync('git', ['ls-tree', '-r', 'HEAD', '--', ...new Set(paths.map((path) => path.split('/').slice(0, 4).join('/')))], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean).map((line) => { const [meta, path] = line.split('\t'); return [path, meta.split(' ')[2]]; }));
  const working = execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: ROOT, input: paths.join('\n'), maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\n').filter(Boolean);
  const drift = paths.filter((path, index) => committed.get(path) !== working[index]);
  assert.deepEqual(drift, []);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'governance/gates/GATE21', 'governance/gates/GATE22', 'governance/gates/GATE23', 'governance/gates/GATE24'], { cwd: ROOT }).toString('utf8').trim();
  assert.equal(status, '');
});

test('historical feature binding and macro binding are deterministic on real P3H data', () => {
  const a = emit('2026-06-15');
  const b = emit('2026-06-15');
  assert.equal(a.status, 'EMITTED');
  assert.equal(a.featureVectorBinding.featureVectorBindingId, b.featureVectorBinding.featureVectorBindingId);
  assert.deepEqual(a.featureSet.records.map((record) => record.featureRecordId), b.featureSet.records.map((record) => record.featureRecordId));
  assert.equal(a.datasetIdObservation, b.datasetIdObservation);
  assert.equal(a.datasetIdFeature, b.datasetIdFeature);
  const { featureVectorBindingId, ...payload } = a.featureVectorBinding;
  assert.equal(featureVectorBindingId, sha256Canonical(payload));
  assert.deepEqual([...a.featureVectorBinding.calendarWindowBindingIds], [V2_BINDING]);
  assert.equal(a.featureVectorBinding.featureRecordIds.length, 3);
  assert.deepEqual(a.featureSet.records.map((record) => [record.featureDefinitionId, record.sessionCount, record.formulaId, record.status, record.core]), [
    ['F1_SIMPLE_RETURN', 5, 'GATE23_SIMPLE_RETURN/1', 'RESOLVED', true],
    ['F1_SIMPLE_RETURN', 21, 'GATE23_SIMPLE_RETURN/1', 'RESOLVED', true],
    ['F2_REALIZED_VOLATILITY', 21, 'WHEEL_JARVISE_REALIZED_VOLATILITY/1', 'RESOLVED', false],
  ]);
  assert.equal(a.regimeRecord.MacroContextBindingId, EXPECTED.macroContextBindingId);
  assert.equal(a.regimeRecord.MacroContextBindingId, foundation.macroAuthority.macroContextBinding.macroContextBindingId);
  assert.notEqual(emit('2026-06-16').featureVectorBinding.featureVectorBindingId, a.featureVectorBinding.featureVectorBindingId);
  /* The F2 value is exactly the producer over the 22 real closes of the calendar window. */
  const window = resolveTrailingWindow({ sessionDate: '2026-06-15', featureWindowSpec: createFeatureWindowSpec({ sessionCount: 21, calendarWindowBinding: foundation.calendarWindowBinding }), calendarWindowBinding: foundation.calendarWindowBinding, sessions: foundation.calendarSessions });
  const byDate = new Map(aaplBars.bars.map((bar) => [bar.sessionDate, bar]));
  assert.equal(a.featureSet.records[2].value, computeRealizedVolatilityR1({ closes: window.sessions.map((session) => byDate.get(session.sessionDate).close) }).value);
});

test('RegimeRecordId replays exactly and changes when any governed binding changes', () => {
  const base = emit('2026-07-01');
  assert.equal(base.regimeRecord.regimeRecordId, emit('2026-07-01').regimeRecord.regimeRecordId);
  assert.equal(base.regimeRecord.regimeRecordId, createRegimeRecordId(base.regimeRecord.identity));
  const input = {
    instrumentIdentityId: base.instrumentIdentityId, sessionDate: base.sessionDate, knowledgeCutoff: base.knowledgeCutoff,
    knowledgeCutoffBoundary: base.featureSet.knowledgeCutoffBoundary, regimeHorizonSpec: foundation.v2.horizon, featureVectorBinding: base.featureVectorBinding,
    macroContextBinding: foundation.macro.macroContextBinding, macroSnapshot: base.macroSnapshot, vintageStore: foundation.macro.vintageStore,
    horizonStartKnowledgeCutoff: base.horizonStartKnowledgeCutoff, classifierVersion: foundation.v2.classifier, parameterSet: foundation.v2.parameterSet,
    featureSet: base.featureSet, datasetIdFeature: base.datasetIdFeature, declaredMacroCompleteness: base.macroSnapshot.macroFeatureCompleteness,
  };
  assert.equal(emitRegimeRecord(input).regimeRecordId, base.regimeRecord.regimeRecordId);
  const empty = produceJarviseEmptyMacroContextR1({ knowledgeCutoff: base.knowledgeCutoff });
  const variants = {
    emptyMacroContext: { macroContextBinding: empty.macroContextBinding, macroSnapshot: empty.macroSnapshotResolution.snapshot, vintageStore: empty.vintageStore, declaredMacroCompleteness: empty.macroSnapshotResolution.snapshot.macroFeatureCompleteness },
    v1Horizon: { regimeHorizonSpec: foundation.productionFoundation.horizon },
    v1Classifier: { classifierVersion: foundation.productionFoundation.classifier },
    v1ParameterSet: { parameterSet: foundation.productionFoundation.parameterSet },
    otherFeatureDataset: { datasetIdFeature: 'f'.repeat(64) },
    previousV1WindowMacroBinding: { macroContextBinding: createMacroContextBinding({ macroVintageSetManifestId: foundation.macroAuthority.projection.macroVintageSetManifestId, macroDatasetSnapshotManifestId: foundation.macroAuthority.projection.macroDatasetSnapshotManifestId, availableAtPolicyId: foundation.macroAuthority.projection.macroAsOfResolutionPolicyId }) },
  };
  const ids = new Set([base.regimeRecord.regimeRecordId]);
  for (const [name, change] of Object.entries(variants)) {
    const id = emitRegimeRecord({ ...input, ...change }).regimeRecordId;
    assert.notEqual(id, base.regimeRecord.regimeRecordId, name);
    ids.add(id);
  }
  assert.equal(ids.size, 7);
});

test('six CORE_V1 dimensions: real supported sessions classify all six under the CPI successor policy', () => {
  for (const sessionDate of ['2026-05-04', '2026-06-15', '2026-08-03', '2026-09-04']) {
    const emitted = emit(sessionDate);
    const core = coreV1ClassificationR1(emitted.regimeRecord);
    assert.deepEqual(ACTIVE_DIMENSION_NAMES_V1.filter((dimension) => !core[dimension].classifying), [], sessionDate);
    const value = emitted.macroSnapshot.derived.cpiYoY.value;
    assert.equal(typeof value, 'number');
    assert.equal(core.inflationState.value, value >= 3 ? 'INFLATIONARY' : value <= 1 ? 'DISINFLATIONARY' : 'INFLATION_STABLE');
    const family = emitted.regimeRecord.classificationEvidence.families.find((item) => item.family === 'inflation evidence');
    assert.notEqual(family.status, 'ABSENT');
    /* The consumed value is exactly the endpoint pair (m, m-12) of the causal state at this session. */
    const state = foundation.macro.statesByDate.get(sessionDate).inflation;
    const [current, base] = state.cpiYoYEndpointEvidence.endpoints;
    assert.ok(current.availableAt <= emitted.knowledgeCutoff && base.availableAt <= emitted.knowledgeCutoff);
    assert.notEqual(current.referencePeriod, '2025-10');
    assert.notEqual(base.referencePeriod, '2025-10');
  }
  assert.equal(emit('2026-09-04').macroSnapshot.derived.cpiYoY.value, 3.3039);
  /* Real pre-gap history (identity-free classification; no RegimeRecord can exist before 2026-05-04): all six classify. */
  const session = foundation.calendarSessions.find((item) => item.sessionDate === '2025-06-02');
  const byDate = new Map(aaplBars.bars.map((bar) => [bar.sessionDate, bar]));
  const closes = (count) => resolveTrailingWindow({ sessionDate: session.sessionDate, featureWindowSpec: createFeatureWindowSpec({ sessionCount: count, calendarWindowBinding: foundation.calendarWindowBinding }), calendarWindowBinding: foundation.calendarWindowBinding, sessions: foundation.calendarSessions }).sessions.map((item) => byDate.get(item.sessionDate).close);
  const record = (id, count, outcome) => ({ featureDefinitionId: id, sessionCount: count, status: outcome.status, value: outcome.value });
  const snapshot = foundation.macro.snapshotAt({ sessionDate: session.sessionDate, knowledgeCutoff: session.closeUtc }).snapshot;
  const horizon = resolveTrailingWindow({ sessionDate: session.sessionDate, featureWindowSpec: foundation.horizonWindowSpec, calendarWindowBinding: foundation.calendarWindowBinding, sessions: foundation.calendarSessions });
  const vector = classifyRegimeVector({
    featureSet: { records: [record('F1_SIMPLE_RETURN', 5, simpleReturn(closes(5))), record('F1_SIMPLE_RETURN', 21, simpleReturn(closes(21))), record('F2_REALIZED_VOLATILITY', 21, computeRealizedVolatilityR1({ closes: closes(21) }))] },
    macroSnapshot: snapshot, vintageStore: foundation.macro.vintageStore, horizonStartKnowledgeCutoff: horizon.sessions[0].closeUtc,
    parameterSet: foundation.v2.parameterSet, declaredMacroCompleteness: snapshot.macroFeatureCompleteness,
  });
  assert.deepEqual(ACTIVE_DIMENSION_NAMES_V1.filter((dimension) => !isClassifyingValue(dimension, vector.regimeVector[dimension])), []);
  assert.equal(vector.regimeVector.inflationState, 'INFLATION_STABLE');
  assert.equal(snapshot.derived.cpiYoY.value, 2.3337);
});

test('missing or unlawful real inputs fail closed with explicit codes', () => {
  assert.deepEqual([emit('2026-05-01').code, emit('2026-05-01').identityCode], ['INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE', 'INSTRUMENT_ALIAS_NOT_FOUND']);
  assert.equal(emit('2026-09-08').code, 'SESSION_OUTSIDE_GATE25_HISTORICAL_WINDOW');
  assert.equal(emit('2026-06-15', { keyBars: { ...aaplBars, sourceBindingId: 'sha256:' + '0'.repeat(64) } }).code, 'P3H_SOURCE_BINDING_MISMATCH');
  const leaked = { ...aaplBars, bars: aaplBars.bars.map((bar) => (bar.sessionDate === '2026-06-10' ? { ...bar, availableAt: '2026-06-16T20:00:00.000Z' } : bar)) };
  assert.equal(emit('2026-06-15', { keyBars: leaked }).code, 'OBSERVATION_AVAILABLE_AFTER_KNOWLEDGE_CUTOFF');
  const gapped = { ...aaplBars, bars: aaplBars.bars.filter((bar) => bar.sessionDate !== '2026-06-12') };
  const refusal = emit('2026-06-15', { keyBars: gapped });
  assert.deepEqual([refusal.code, refusal.featureSetStatus], ['FEATURE_SET_CORE_NOT_RESOLVED', 'FAIL_CLOSED']);
  const noMacro = { ...foundation, macro: { ...foundation.macro, snapshotAt: () => ({ status: 'OUTSIDE_HISTORICAL_MACRO_COVERAGE', snapshot: null }) } };
  assert.equal(emitJarviseG25HistoricalRegimeRecordR1({ foundation: noMacro, entry: aapl, keyBars: aaplBars, sessionDate: '2026-06-15' }).code, 'HISTORICAL_MACRO_CONTEXT_NOT_RESOLVED');
});

test('GATE25 D1 members and closed phase-1 input shapes are formable on real supported sessions', () => {
  const contract = JSON.parse(readFileSync(resolve(ROOT, 'governance/gates/GATE25/contracts/EXECUTION_CONTRACT_R0003.json'), 'utf8'));
  const d1 = contract.canonicalRequirements.find((item) => item.bindingId === 'GATE25_ANALOGUE_IDENTITY_V1').binding.orderedMemberIds;
  for (const sessionDate of ['2026-05-04', '2026-07-15', '2026-09-04']) {
    const emitted = emit(sessionDate);
    const members = foundationD1MembersR1({ foundation, emitted });
    assert.ok(Object.values(members).every((value) => typeof value === 'string' && value.length > 0 && value === value.trim()));
    assert.deepEqual([...Object.keys(members), 'SelectionPolicyVersionId', 'MissingnessStateId'].sort(), [...d1].sort());
    assert.equal(members.RegimeHorizonSpecId, EXPECTED.v2.regimeHorizonSpecId);
    assert.equal(members.MacroContextBindingId, EXPECTED.macroContextBindingId);
    assert.equal(members.EligibleHistoryPinSetId, 'sha256:cc7bb76f37a97a5673a32c5a8f357088ee94230fefcbef1c19ad16227476488e');
    const inputs = projectGate25AnalogueInputsR1({ foundation, emitted });
    assert.deepEqual(Object.keys(inputs.featureVectorBinding), FEATURE_VECTOR_BINDING_KEYS);
    assert.deepEqual(Object.keys(inputs.regimeRecord), GATE24_REGIME_RECORD_KEYS);
    assert.deepEqual(Object.keys(inputs.features), ['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);
    for (const feature of Object.values(inputs.features)) assert.ok(inputs.featureVectorBinding.featureRecordIds.includes(feature.featureRecordId));
    assert.deepEqual(inputs.inputProofs.map((proof) => proof.inputId), ['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21', 'GATE24_REGIME_RECORD']);
    assert.ok(inputs.inputProofs.every((proof) => proof.availableAt <= emitted.knowledgeCutoff && /^[0-9a-f]{64}$/.test(proof.sourceArtifactSha256)));
    assert.equal(inputs.regimeRecord.identity.FeatureVectorBindingId, inputs.featureVectorBinding.featureVectorBindingId);
  }
});

test('the verified-once identity resolver equals the official as-of resolver', () => {
  const official = (symbol, asOfDate) => {
    try {
      const resolved = resolveInstrumentIdentityAsOf({ ...foundation.identityResolver.officialResolverInput, symbol, asOfDate });
      return { status: 'RESOLVED', instrumentIdentityId: resolved.instrumentIdentityId, resolvedAsOfSessionDate: asOfDate };
    } catch (error) {
      return { status: 'UNRESOLVED', code: error.code, resolvedAsOfSessionDate: asOfDate };
    }
  };
  for (const [symbol, date] of [['AAPL', '2026-05-01'], ['AAPL', '2026-05-04'], [foundation.p3h.exclusions[0].providerSymbol, '2026-09-04']]) {
    assert.deepEqual({ ...foundation.identityResolver.resolveAsOf(symbol, date) }, official(symbol, date), `${symbol}@${date}`);
  }
});

test('no network, no Yahoo, no broker, no model and no live Wheel scan coupling', () => {
  assert.deepEqual(networkCalls, []);
  const visited = new Set();
  const forbidden = [];
  const walk = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) { if (/^node:(https?|net|tls|dgram|dns)$/.test(specifier)) forbidden.push(`${relative(ROOT, file)} -> ${specifier}`); continue; }
      if (!specifier.startsWith('.')) { forbidden.push(`${relative(ROOT, file)} -> ${specifier}`); continue; }
      const target = resolve(dirname(file), specifier);
      if (/yahoo|ibkr|ollama|openai|anthropic|jarviseRoutes|jarvisePipelineR1|scanner|server\.js|wheel-dashboard|g21BridgeCapture/i.test(relative(ROOT, target))) forbidden.push(`${relative(ROOT, file)} -> ${relative(ROOT, target)}`);
      if (target.endsWith('.mjs') || target.endsWith('.js')) walk(target);
    }
  };
  for (const module of ['jarviseG25HistoricalRegimeFoundationR1.mjs', 'jarviseG25HistoricalMacroContextR1.mjs', 'jarviseG25HistoricalRealizedVolatilityR1.mjs']) walk(resolve(ROOT, 'app/jarvise', module));
  assert.ok(visited.size > 30);
  assert.deepEqual(forbidden, []);
});
