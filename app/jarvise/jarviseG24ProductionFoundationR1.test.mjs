import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createParameterSet, createClassifierVersion, REGIME_VECTOR_VERSION_ID } from '../../governance/gates/GATE24/implementation/regime-classifier-v1.mjs';
import { createActiveRegimeHorizonSpec } from '../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { materializeJarviseG24ProductionFoundationR1 } from '../../scripts/materializeJarviseG24ProductionFoundationR1.mjs';
import { JarviseG24ProductionFoundationLoadError, loadJarviseG24ProductionFoundationR1 } from './jarviseG24ProductionFoundationR1.mjs';

const BINDING = 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023';
const numeric = { 'primaryMarketRegime.bullReturnMin': 0.05, 'primaryMarketRegime.bearReturnMax': -0.05, 'primaryMarketRegime.rangeAbsReturnMax': 0.02, 'primaryMarketRegime.crisisDrawdownMax': -0.20, 'primaryMarketRegime.liquidityStressRatioMin': 3, 'primaryMarketRegime.recoveryShortReturnMin': 0.03, 'volatilityState.calmMax': 0.1, 'volatilityState.normalMax': 0.2, 'volatilityState.volatileMax': 0.35, 'inflationState.inflationaryMin': 3, 'inflationState.disinflationaryMax': 1, 'ratesState.risingDeltaMin': 0.25, 'ratesState.fallingDeltaMax': -0.25 };
const config = { 'primaryMarketRegime.trendMemberKey': 'F1_SIMPLE_RETURN@W21', 'primaryMarketRegime.trendShortMemberKey': 'F1_SIMPLE_RETURN@W5', 'primaryMarketRegime.drawdownMemberKey': 'F3_MAX_DRAWDOWN@W21', 'primaryMarketRegime.liquidityMemberKey': 'F4_RELATIVE_VOLUME@W21', 'volatilityState.volatilityMemberKey': 'F2_REALIZED_VOLATILITY@W21', 'inflationState.seriesCode': 'cpiYoY', 'ratesState.seriesCode': 'US.TREAS.DGS10', 'yieldCurveShape.producerFeatureCode': 'curveShape', 'yieldCurveDirection.producerFeatureCode': 'curveDirection' };
const declarations = Object.entries({ ...numeric, ...config }).map(([path, value]) => { const dot = path.indexOf('.'); return { dimension: path.slice(0, dot), parameterName: path.slice(dot + 1), value }; });
const root = () => mkdtempSync(join(tmpdir(), 'jarvise-g24-foundation-'));
const refusal = (error) => error instanceof JarviseG24ProductionFoundationLoadError;

test('materializes the exact eight CAS identities, W21 horizon, and deterministic registry', () => {
  const temp = root(); try {
    const first = materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true });
    const second = materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true });
    const check = materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true, check: true });
    assert.equal(first.created, 10); assert.equal(second.created, 0); assert.equal(check.created, 0); assert.equal(first.horizon.sessionCount, 21); assert.equal(first.objects.length, 8); assert.equal(first.registry.orderedEntries.length, 8); assert.equal(first.registry.supersedesRegimeConfigRegistryManifestId, null);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('ParameterSet is exact, typed, and shuffle deterministic while ClassifierVersion excludes it', () => {
  const horizon = createActiveRegimeHorizonSpec({ calendarWindowBindingId: BINDING });
  const a = createParameterSet({ parameterSetLabel: 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET', regimeVectorVersionId: REGIME_VECTOR_VERSION_ID, activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId], parameters: declarations });
  const b = createParameterSet({ parameterSetLabel: 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET', regimeVectorVersionId: REGIME_VECTOR_VERSION_ID, activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId], parameters: [...declarations].reverse() });
  const changed = createParameterSet({ parameterSetLabel: 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET', regimeVectorVersionId: REGIME_VECTOR_VERSION_ID, activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId], parameters: declarations.map((item) => item.parameterName === 'calmMax' ? { ...item, value: 0.11 } : item) });
  const classifier = createClassifierVersion({ classifierVersionLabel: 'WHEEL_JARVISE_G24_CORE_V1_CLASSIFIER', activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId] });
  assert.equal(a.parameterPaths.length, 22); assert.equal(a.parameterSetId, b.parameterSetId); assert.notEqual(a.parameterSetId, changed.parameterSetId); assert.equal(classifier.parameterSetIdIsInput, false); assert.equal(Object.hasOwn(classifier, 'parameterSetId'), false); for (const [path, value] of Object.entries(numeric)) { const got = a.parameters.find((item) => item.parameterPath === path)?.value; assert.equal(got, value); assert.equal(typeof got, 'number'); } for (const [path, value] of Object.entries(config)) assert.equal(a.parameters.find((item) => item.parameterPath === path)?.value, value);
});

test('loader is read-only, recomputes every native identity, and refuses corrupt or arbitrary artifacts', () => {
  const temp = root(); try {
    materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true });
    const before = readFileSync(join(temp, 'registry-manifest.json'));
    const loaded = loadJarviseG24ProductionFoundationR1({ dataRoot: temp });
    assert.equal(loaded.horizon.sessionCount, 21); assert.equal(loaded.parameterSet.parameterPaths.length, 22); assert.equal(Object.isFrozen(loaded), true); assert.deepEqual(readFileSync(join(temp, 'registry-manifest.json')), before);
    const registry = JSON.parse(before); registry.orderedEntries[0].objectId = `sha256:${'ab'.repeat(32)}`; writeFileSync(join(temp, 'registry-manifest.json'), JSON.stringify(registry));
    assert.throws(() => loadJarviseG24ProductionFoundationR1({ dataRoot: temp }), refusal);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('semantic declarations stay producer-free and FeatureSet binding is resolved canonically', () => {
  const temp = root(); try {
    materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true }); const loaded = loadJarviseG24ProductionFoundationR1({ dataRoot: temp });
    assert.deepEqual(loaded.featureSemantics.map((item) => item.featureDefinitionId).sort(), ['F2_REALIZED_VOLATILITY', 'F3_MAX_DRAWDOWN', 'F4_RELATIVE_VOLUME']); assert.ok(loaded.featureSemantics.every((item) => item.producerStatus === 'NOT_IMPLEMENTED'));
    const featureSet = { records: [{ identity: { CalendarWindowBindingId: BINDING } }, { identity: { CalendarWindowBindingId: BINDING } }] }; assert.equal(loaded.verifyFeatureSetHorizonBinding(featureSet).status, 'RESOLVED');
    assert.throws(() => loaded.verifyFeatureSetHorizonBinding({ records: [{ identity: { CalendarWindowBindingId: 'a'.repeat(64) } }] }), refusal);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('production artifacts pass a zero-write check and identity-bound replacement is refused', () => {
  const production = materializeJarviseG24ProductionFoundationR1({ check: true });
  const loaded = loadJarviseG24ProductionFoundationR1();
  assert.equal(production.created, 0); assert.equal(loaded.regimeConfigRegistryManifestId, production.ids.regimeConfigRegistryManifestId);
  const temp = root(); try {
    materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true });
    const path = join(temp, 'registry-manifest.json'); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(' ')]));
    assert.throws(() => materializeJarviseG24ProductionFoundationR1({ outputRoot: temp, testOnlyAllowOutputRoot: true }), /G24_FOUNDATION_REGISTRY_CONTRACT_UNSATISFIED/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
