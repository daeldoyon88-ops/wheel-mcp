#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { sha256Canonical } from '../governance/tools/canonical-json.mjs';
import { refuseOutcomeAsFeature } from '../governance/gates/GATE23/implementation/causal-admission-v1.mjs';
import { admitProductionCalendarWindowBinding, createActiveRegimeHorizonSpec } from '../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { createClassifierVersion, createParameterSet, REGIME_VECTOR_VERSION_ID } from '../governance/gates/GATE24/implementation/regime-classifier-v1.mjs';
import { G24_FEATURE_SEMANTICS_R1, G24_FOUNDATION_R1, G24_MACRO_SEMANTICS_R1, G24_PARAMETER_DECLARATIONS_R1 } from '../app/jarvise/jarviseG24RatifiedParametersR1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGIME_CONFIG_RELATIVE_ROOT = 'data/jarvise/regime-config';
const DEFAULT_OUTPUT_ROOT = resolve(REPOSITORY_ROOT, REGIME_CONFIG_RELATIVE_ROOT);
const MP1_PROVENANCE = resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json');
const SHA = /^[0-9a-f]{64}$/;

export class JarviseG24ProductionFoundationError extends Error {
  constructor(code, message, details = {}) { super(`${code}: ${message}`); this.name = 'JarviseG24ProductionFoundationError'; this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new JarviseG24ProductionFoundationError(code, message, details); };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const casId = (payload) => `sha256:${sha256Canonical(payload)}`;
const asIdentityPayload = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key]]));

function readJson(path, code = 'G24_FOUNDATION_ARTIFACT_ABSENT') {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (cause) { fail(code, 'required JSON artifact is absent or unreadable', { path, causeCode: cause?.code }); }
}
function assertMp1() {
  const provenance = readJson(MP1_PROVENANCE, 'G24_FOUNDATION_CALENDAR_BINDING_MISMATCH');
  const p = G24_FOUNDATION_R1;
  if (provenance.calendarWindowBindingId !== p.calendarWindowBindingId || provenance.calendarRegistryManifestId !== p.calendarRegistryManifestId || provenance.calendarNamespaceVersion !== p.calendarNamespaceVersion || provenance.registryVerification?.verified !== true) fail('G24_FOUNDATION_CALENDAR_BINDING_MISMATCH', 'MP-1 persisted calendar identity does not match ratification');
  const admission = admitProductionCalendarWindowBinding(provenance);
  if (admission.status !== 'ADMITTED') fail('G24_FOUNDATION_CALENDAR_BINDING_MISMATCH', 'canonical production calendar admission refused', admission);
  return provenance;
}
function expectedObjects() {
  assertMp1();
  const horizon = createActiveRegimeHorizonSpec({ calendarWindowBindingId: G24_FOUNDATION_R1.calendarWindowBindingId });
  if (horizon.sessionCount !== 21 || horizon.activeInCoreV1 !== true) fail('G24_RATES_HORIZON_RATIFICATION_MISMATCH', 'canonical active horizon does not match W21 ratification');
  const classifier = createClassifierVersion({ classifierVersionLabel: G24_FOUNDATION_R1.classifierVersionLabel, activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId] });
  const parameterSet = createParameterSet({ parameterSetLabel: G24_FOUNDATION_R1.parameterSetLabel, regimeVectorVersionId: REGIME_VECTOR_VERSION_ID, activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId], parameters: G24_PARAMETER_DECLARATIONS_R1 });
  if (parameterSet.parameterPaths.length !== 22) fail('G24_FOUNDATION_PARAMETER_SET_INCOMPLETE', 'ratified ParameterSet does not contain 22 paths');
  for (const semantic of G24_FEATURE_SEMANTICS_R1) if (refuseOutcomeAsFeature(semantic).status !== 'ALLOWED') fail('G24_FOUNDATION_SEMANTIC_CONTRADICTION', 'feature semantic declaration violates G23 outcome discipline', { featureDefinitionId: semantic.featureDefinitionId });
  const native = [
    ['RegimeHorizonSpec', asIdentityPayload(horizon, ['schemaVersion', 'sessionCount', 'unit', 'calendarWindowBindingId']), horizon.regimeHorizonSpecId],
    ['ClassifierVersion', asIdentityPayload(classifier, ['schemaVersion', 'classifierVersionLabel', 'regimeVectorVersionId', 'dimensionTaxonomyVersionIds', 'activeRegimeHorizonSpecIds', 'classificationQualityRuleVersion', 'classificationEvidenceSchemaVersion', 'missingnessPolicyVersion']), classifier.classifierVersionId],
    ['ParameterSet', {
      schemaVersion: parameterSet.schemaVersion,
      parameterSetLabel: parameterSet.parameterSetLabel,
      regimeVectorVersionId: parameterSet.regimeVectorVersionId,
      activeRegimeHorizonSpecIds: parameterSet.activeRegimeHorizonSpecIds,
      parameters: parameterSet.parameters.map(({ dimension, parameterName, value }) => ({ dimension, parameterName, value })),
    }, parameterSet.parameterSetId],
  ];
  const semantic = [...G24_FEATURE_SEMANTICS_R1.map((value) => ['FeatureSemanticDeclaration', value, sha256Canonical(value)]), ...G24_MACRO_SEMANTICS_R1.map((value) => ['MacroSemanticDeclaration', value, sha256Canonical(value)])];
  return { horizon, classifier, parameterSet, objects: [...native, ...semantic].map(([kind, payload, id]) => ({ kind, payload, id, objectId: `sha256:${id}` })) };
}
function casPath(root, id) { const hex = id.replace(/^sha256:/, ''); return join(root, 'cas', 'sha256', hex.slice(0, 2), `${hex}.json`); }
function stableWrite(path, value, check) {
  const bytes = canonicalJsonBytes(value);
  if (existsSync(path)) { const present = readFileSync(path); if (!present.equals(bytes)) fail('G24_FOUNDATION_REGISTRY_CONTRACT_UNSATISFIED', 'identity-bound artifact would be silently replaced', { path }); return { created: false, bytes: present.length }; }
  if (check) fail('G24_FOUNDATION_ARTIFACT_ABSENT', 'expected artifact is absent in --check mode', { path });
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes, { flag: 'wx' }); return { created: true, bytes: bytes.length };
}
function assertOutputRoot(options) { const outputRoot = resolve(options.outputRoot ?? DEFAULT_OUTPUT_ROOT); if (outputRoot !== DEFAULT_OUTPUT_ROOT && options.testOnlyAllowOutputRoot !== true) fail('G24_FOUNDATION_OUTPUT_SCOPE_EXPANSION_REQUIRED', 'non-production output root forbidden'); return outputRoot; }
export function materializeJarviseG24ProductionFoundationR1(options = {}) {
  const outputRoot = assertOutputRoot(options); const check = options.check === true; const expected = expectedObjects();
  const entries = expected.objects.map(({ kind, objectId }) => ({ kind, objectId })).sort((a, b) => a.kind === b.kind ? a.objectId.localeCompare(b.objectId) : a.kind.localeCompare(b.kind));
  const registry = { schemaVersion: 'WHEEL_JARVISE_G24_REGIME_CONFIG_REGISTRY/1', parameterSetLabel: G24_FOUNDATION_R1.parameterSetLabel, classifierVersionLabel: G24_FOUNDATION_R1.classifierVersionLabel, calendarWindowBindingId: G24_FOUNDATION_R1.calendarWindowBindingId, calendarRegistryManifestId: G24_FOUNDATION_R1.calendarRegistryManifestId, orderedEntries: entries, supersedesRegimeConfigRegistryManifestId: null };
  const registryId = `sha256:${sha256Canonical(registry)}`;
  const provenance = { schemaVersion: 'JarviseG24ProductionFoundationProvenance/1', authoritative: false, materializerClassification: 'OWNER_EXPLICIT_R2_LOCAL_BUILD_AUTHORITY', mission: 'WHEEL_JARVISE_G24_PRODUCTION_FOUNDATION_BUILD_R1', ownerRatificationReferences: ['WHEEL_JARVISE_G24_PRODUCTION_FOUNDATION_BUILD_R1'], sourceMp1: { calendarWindowBindingId: G24_FOUNDATION_R1.calendarWindowBindingId, calendarRegistryManifestId: G24_FOUNDATION_R1.calendarRegistryManifestId }, productionIds: { regimeHorizonSpecId: expected.horizon.regimeHorizonSpecId, classifierVersionId: expected.classifier.classifierVersionId, parameterSetId: expected.parameterSet.parameterSetId, regimeConfigRegistryManifestId: registryId }, artifactCounts: { casObjects: 8, registryEntries: 8 }, producerAvailability: { F2_REALIZED_VOLATILITY: 'NOT_IMPLEMENTED', F3_MAX_DRAWDOWN: 'NOT_IMPLEMENTED', F4_RELATIVE_VOLUME: 'NOT_IMPLEMENTED' }, f4Blocker: 'G23_MATERIALIZER_COMPUTE_PROJECTION_GAP', canonicalGateModifications: 0 };
  const writes = expected.objects.map((object) => stableWrite(casPath(outputRoot, object.objectId), object.payload, check));
  const registryWrite = stableWrite(join(outputRoot, 'registry-manifest.json'), registry, check); const provenanceWrite = stableWrite(join(outputRoot, 'PROVENANCE.json'), provenance, check);
  return Object.freeze({ status: check ? 'CHECKED' : 'MATERIALIZED', outputRoot, created: writes.filter((write) => write.created).length + Number(registryWrite.created) + Number(provenanceWrite.created), ids: provenance.productionIds, horizon: expected.horizon, classifier: expected.classifier, parameterSet: expected.parameterSet, registry, objects: expected.objects, writes: Object.freeze([...writes, registryWrite, provenanceWrite]) });
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) { try { const result = materializeJarviseG24ProductionFoundationR1({ check: process.argv.includes('--check') }); process.stdout.write(`${JSON.stringify({ status: result.status, created: result.created, ids: result.ids }, null, 2)}\n`); } catch (error) { process.stderr.write(`${JSON.stringify({ verdict: error.code ?? 'REPAIR_REQUIRED', message: error.message }, null, 2)}\n`); process.exitCode = 1; } }
