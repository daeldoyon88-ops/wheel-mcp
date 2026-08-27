import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { admitProductionCalendarWindowBinding, createActiveRegimeHorizonSpec, resolveProductionCalendarWindowBinding } from '../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { createClassifierVersion, createParameterSet, REGIME_VECTOR_VERSION_ID } from '../../governance/gates/GATE24/implementation/regime-classifier-v1.mjs';
import { G24_FEATURE_SEMANTICS_R1, G24_MACRO_SEMANTICS_R1 } from './jarviseG24RatifiedParametersR1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_DATA_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/regime-config');
const MP1_PROVENANCE = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json');
const SHA = /^sha256:[0-9a-f]{64}$/;
const freeze = (value) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

export class JarviseG24ProductionFoundationLoadError extends Error {
  constructor(code, message, details = {}) { super(`${code}: ${message}`); this.name = 'JarviseG24ProductionFoundationLoadError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new JarviseG24ProductionFoundationLoadError(code, message, details); };
function readJson(path, absentCode = 'G24_FOUNDATION_ARTIFACT_ABSENT') { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (cause) { fail(absentCode, 'required persisted artifact is absent or unreadable', { path, causeCode: cause?.code }); } }
function objectPath(dataRoot, objectId) { if (!SHA.test(objectId)) fail('G24_FOUNDATION_REGISTRY_CORRUPT', 'registry entry object ID is invalid'); const hex = objectId.slice(7); return join(dataRoot, 'cas', 'sha256', hex.slice(0, 2), `${hex}.json`); }
function exactKeys(value, keys, code) { const actual = Object.keys(value ?? {}).sort(); const expected = [...keys].sort(); if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(code, 'identity payload has an invalid member set', { actual, expected }); }
function verifyEntry(dataRoot, entry) { const payload = readJson(objectPath(dataRoot, entry.objectId)); if (`sha256:${sha256Canonical(payload)}` !== entry.objectId) fail('G24_FOUNDATION_IDENTITY_MISMATCH', 'CAS payload digest differs from registry reference', { kind: entry.kind }); return payload; }
function asMap(parameterSet) { return Object.fromEntries(parameterSet.parameters.map((item) => [item.parameterPath, item.value])); }
function verifyParameterSet(payload, horizonId) {
  exactKeys(payload, ['schemaVersion', 'parameterSetLabel', 'regimeVectorVersionId', 'activeRegimeHorizonSpecIds', 'parameters'], 'G24_FOUNDATION_IDENTITY_MISMATCH');
  const rebuilt = createParameterSet(payload);
  if (rebuilt.parameterSetId !== sha256Canonical(payload)) fail('G24_FOUNDATION_IDENTITY_MISMATCH', 'canonical ParameterSet reconstruction disagrees');
  if (rebuilt.parameterSetLabel !== 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET' || rebuilt.regimeVectorVersionId !== REGIME_VECTOR_VERSION_ID || JSON.stringify(rebuilt.activeRegimeHorizonSpecIds) !== JSON.stringify([horizonId]) || rebuilt.parameterPaths.length !== 22) fail('G24_FOUNDATION_PARAMETER_SET_INCOMPLETE', 'ParameterSet is incomplete or bound to a different horizon');
  const values = asMap(rebuilt);
  const numeric = { 'primaryMarketRegime.bullReturnMin': 0.05, 'primaryMarketRegime.bearReturnMax': -0.05, 'primaryMarketRegime.rangeAbsReturnMax': 0.02, 'primaryMarketRegime.crisisDrawdownMax': -0.20, 'primaryMarketRegime.liquidityStressRatioMin': 3.0, 'primaryMarketRegime.recoveryShortReturnMin': 0.03, 'volatilityState.calmMax': 0.10, 'volatilityState.normalMax': 0.20, 'volatilityState.volatileMax': 0.35, 'inflationState.inflationaryMin': 3.0, 'inflationState.disinflationaryMax': 1.0, 'ratesState.risingDeltaMin': 0.25, 'ratesState.fallingDeltaMax': -0.25 };
  for (const [path, value] of Object.entries(numeric)) if (values[path] !== value || typeof values[path] !== 'number') fail(typeof values[path] === 'string' ? 'G24_FOUNDATION_PARAMETER_TYPE_INVALID' : 'G24_FOUNDATION_PARAMETER_SET_INCOMPLETE', 'ratified numeric parameter is absent, changed, or incorrectly typed', { path });
  const config = { 'primaryMarketRegime.trendMemberKey': 'F1_SIMPLE_RETURN@W21', 'primaryMarketRegime.trendShortMemberKey': 'F1_SIMPLE_RETURN@W5', 'primaryMarketRegime.drawdownMemberKey': 'F3_MAX_DRAWDOWN@W21', 'primaryMarketRegime.liquidityMemberKey': 'F4_RELATIVE_VOLUME@W21', 'volatilityState.volatilityMemberKey': 'F2_REALIZED_VOLATILITY@W21', 'inflationState.seriesCode': 'cpiYoY', 'ratesState.seriesCode': 'US.TREAS.DGS10', 'yieldCurveShape.producerFeatureCode': 'curveShape', 'yieldCurveDirection.producerFeatureCode': 'curveDirection' };
  for (const [path, value] of Object.entries(config)) if (values[path] !== value) fail('G24_FOUNDATION_PARAMETER_SET_INCOMPLETE', 'ratified configuration parameter is absent or changed', { path });
  return rebuilt;
}
function verifySemantics(entries) {
  const features = entries.filter((entry) => entry.kind === 'FeatureSemanticDeclaration').map((entry) => entry.payload);
  const macros = entries.filter((entry) => entry.kind === 'MacroSemanticDeclaration').map((entry) => entry.payload);
  if (features.length !== 3 || macros.length !== 2) fail('G24_FOUNDATION_REGISTRY_CORRUPT', 'registry semantic declaration counts differ from the closed foundation');
  for (const feature of features) { const expected = G24_FEATURE_SEMANTICS_R1.find((item) => item.featureDefinitionId === feature.featureDefinitionId); if (!expected || sha256Canonical(feature) !== sha256Canonical(expected)) fail('G24_FOUNDATION_IDENTITY_MISMATCH', 'feature semantic declaration differs from owner ratification', { featureDefinitionId: feature.featureDefinitionId }); }
  for (const macro of macros) { const expected = G24_MACRO_SEMANTICS_R1.find((item) => item.code === macro.code); if (!expected || sha256Canonical(macro) !== sha256Canonical(expected)) fail('MACRO_SEMANTIC_REPRESENTATION_MISMATCH', 'macro semantic declaration differs from owner ratification', { code: macro.code }); }
  const cpi = macros.find((macro) => macro.code === 'cpiYoY'); const dgs10 = macros.find((macro) => macro.code === 'US.TREAS.DGS10');
  if (!cpi || cpi.storageScale !== 4 || !dgs10 || dgs10.storageScale !== 2 || dgs10.deltaUnit !== 'PERCENTAGE_POINTS') fail('MACRO_SEMANTIC_REPRESENTATION_MISMATCH', 'macro declaration identities differ from ratification');
  return { features, macros };
}
export function loadJarviseG24ProductionFoundationR1({ dataRoot } = {}) {
  const root = resolve(dataRoot ?? DEFAULT_DATA_ROOT); const registry = readJson(join(root, 'registry-manifest.json'));
  exactKeys(registry, ['schemaVersion', 'parameterSetLabel', 'classifierVersionLabel', 'calendarWindowBindingId', 'calendarRegistryManifestId', 'orderedEntries', 'supersedesRegimeConfigRegistryManifestId'], 'G24_FOUNDATION_REGISTRY_CORRUPT');
  const registryId = `sha256:${sha256Canonical(registry)}`;
  if (registry.schemaVersion !== 'WHEEL_JARVISE_G24_REGIME_CONFIG_REGISTRY/1' || registry.parameterSetLabel !== 'WHEEL_JARVISE_G24_CORE_V1_PARAMETER_SET' || registry.classifierVersionLabel !== 'WHEEL_JARVISE_G24_CORE_V1_CLASSIFIER' || registry.calendarWindowBindingId !== 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023' || registry.calendarRegistryManifestId !== 'sha256:37c793ae00853944a2e3c4330a3aa2e7444f7ad72f2b7df857bcb4186c298232' || registry.supersedesRegimeConfigRegistryManifestId !== null || !Array.isArray(registry.orderedEntries) || registry.orderedEntries.length !== 8) fail('G24_FOUNDATION_REGISTRY_CORRUPT', 'registry head is invalid');
  const unique = new Set(registry.orderedEntries.map((entry) => `${entry.kind}:${entry.objectId}`)); if (unique.size !== 8) fail('G24_FOUNDATION_REGISTRY_CORRUPT', 'registry has duplicate entries');
  const mp1 = readJson(MP1_PROVENANCE, 'G24_FOUNDATION_CALENDAR_BINDING_MISMATCH');
  if (mp1.calendarWindowBindingId !== registry.calendarWindowBindingId || mp1.calendarRegistryManifestId !== registry.calendarRegistryManifestId || mp1.calendarNamespaceVersion !== 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/1' || mp1.registryVerification?.verified !== true || admitProductionCalendarWindowBinding(mp1).status !== 'ADMITTED') fail('G24_FOUNDATION_CALENDAR_BINDING_MISMATCH', 'MP-1 calendar provenance cannot admit the registry binding');
  const entries = registry.orderedEntries.map((entry) => ({ ...entry, payload: verifyEntry(root, entry) }));
  const horizonEntry = entries.find((entry) => entry.kind === 'RegimeHorizonSpec'); const classifierEntry = entries.find((entry) => entry.kind === 'ClassifierVersion'); const parameterEntry = entries.find((entry) => entry.kind === 'ParameterSet');
  if (!horizonEntry || !classifierEntry || !parameterEntry) fail('G24_FOUNDATION_REGISTRY_CORRUPT', 'registry lacks a required native G24 identity');
  exactKeys(horizonEntry.payload, ['schemaVersion', 'sessionCount', 'unit', 'calendarWindowBindingId'], 'G24_FOUNDATION_IDENTITY_MISMATCH'); const horizon = createActiveRegimeHorizonSpec({ calendarWindowBindingId: registry.calendarWindowBindingId });
  if (horizon.sessionCount !== 21 || horizon.regimeHorizonSpecId !== horizonEntry.objectId.slice(7) || sha256Canonical(horizonEntry.payload) !== horizon.regimeHorizonSpecId) fail('G24_RATES_HORIZON_RATIFICATION_MISMATCH', 'persisted horizon does not reconstruct as ratified W21');
  exactKeys(classifierEntry.payload, ['schemaVersion', 'classifierVersionLabel', 'regimeVectorVersionId', 'dimensionTaxonomyVersionIds', 'activeRegimeHorizonSpecIds', 'classificationQualityRuleVersion', 'classificationEvidenceSchemaVersion', 'missingnessPolicyVersion'], 'G24_FOUNDATION_IDENTITY_MISMATCH'); const classifier = createClassifierVersion(classifierEntry.payload);
  if (classifier.classifierVersionId !== classifierEntry.objectId.slice(7) || classifier.parameterSetIdIsInput !== false || JSON.stringify(classifier.activeRegimeHorizonSpecIds) !== JSON.stringify([horizon.regimeHorizonSpecId])) fail('G24_FOUNDATION_IDENTITY_MISMATCH', 'ClassifierVersion identity does not reconstruct');
  const parameterSet = verifyParameterSet(parameterEntry.payload, horizon.regimeHorizonSpecId); if (parameterSet.parameterSetId !== parameterEntry.objectId.slice(7)) fail('G24_FOUNDATION_IDENTITY_MISMATCH', 'ParameterSet ID does not reconstruct');
  const semantic = verifySemantics(entries);
  const verifyFeatureSetHorizonBinding = (featureSet) => { const result = resolveProductionCalendarWindowBinding({ featureSet, calendarWindowBinding: mp1 }); if (result.status !== 'RESOLVED' || result.calendarWindowBindingId !== registry.calendarWindowBindingId) fail('G24_FOUNDATION_CALENDAR_BINDING_MISMATCH', 'FeatureSet does not resolve to the loaded production calendar binding', result); return freeze(result); };
  return freeze({ dataRoot: root, regimeConfigRegistryManifestId: registryId, registry, horizon, classifier, parameterSet, featureSemantics: semantic.features, macroSemantics: semantic.macros, verifyFeatureSetHorizonBinding });
}
