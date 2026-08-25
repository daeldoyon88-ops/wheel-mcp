/**
 * GATE23 versioned feature-definition registry.
 *
 * Evolution is ADDITIVE_VERSIONED. A FormulaId is behavior: a behavioural change
 * produces a new FormulaId and therefore a new FeatureRecordId. A registered
 * definition is immutable; removal is never silent and always names a successor.
 */

import { refuseOutcomeAsFeature } from './causal-admission-v1.mjs';

export const FEATURE_REGISTRY_VERSION = 'GATE23_FeatureRegistry/1';
export const FEATURE_DEFINITION_VERSION = 'GATE23_FeatureDefinition/1';
export const REGISTRY_EVOLUTION_POLICY = Object.freeze({
  evolution: 'ADDITIVE_VERSIONED',
  unknownFields: 'CONSUMERS_IGNORE',
  behaviouralChange: 'REQUIRES_NEW_FORMULA_ID',
  requiredFieldRemoval: 'REQUIRES_VERSION_BUMP_AND_NAMED_SUCCESSOR',
  deprecation: 'BY_VERSION_ID_NEVER_SILENT_REWRITE',
});

const KNOWN_FIELDS = Object.freeze([
  'featureDefinitionId', 'familyId', 'formulaId', 'formulaVersion', 'requiredObservedFields', 'compute',
]);

export function defineFeature(input) {
  const { featureDefinitionId, familyId, formulaId, formulaVersion, requiredObservedFields, compute } = input ?? {};
  if (typeof featureDefinitionId !== 'string' || featureDefinitionId.length === 0
    || typeof familyId !== 'string' || familyId.length === 0
    || typeof formulaId !== 'string' || formulaId.length === 0
    || typeof formulaVersion !== 'string' || formulaVersion.length === 0
    || !Array.isArray(requiredObservedFields) || requiredObservedFields.length === 0
    || typeof compute !== 'function') {
    throw new Error('FEATURE_DEFINITION_INVALID');
  }
  if (!formulaId.endsWith(`/${formulaVersion}`)) throw new Error('FORMULA_ID_MUST_CARRY_BEHAVIOR_VERSION');
  const causal = refuseOutcomeAsFeature({ name: featureDefinitionId, recordType: 'FeatureDefinition' });
  if (causal.status !== 'ALLOWED') throw new Error(causal.code);
  const extensions = Object.fromEntries(Object.entries(input).filter(([key]) => !KNOWN_FIELDS.includes(key)));
  return Object.freeze({
    schemaVersion: FEATURE_DEFINITION_VERSION,
    featureDefinitionId,
    familyId,
    formulaId,
    formulaVersion,
    requiredObservedFields: Object.freeze([...requiredObservedFields]),
    compute,
    extensions: Object.freeze(extensions),
    deprecated: false,
    supersededBy: null,
  });
}

export function createFeatureRegistry(definitions = []) {
  const registry = Object.freeze({ schemaVersion: FEATURE_REGISTRY_VERSION, definitions: Object.freeze([]) });
  return definitions.reduce(registerFeatureDefinition, registry);
}

export function registerFeatureDefinition(registry, definition) {
  if (registry?.schemaVersion !== FEATURE_REGISTRY_VERSION) throw new Error('FEATURE_REGISTRY_INVALID');
  if (definition?.schemaVersion !== FEATURE_DEFINITION_VERSION) throw new Error('FEATURE_DEFINITION_INVALID');
  const existing = registry.definitions.find((item) => item.featureDefinitionId === definition.featureDefinitionId);
  if (existing) {
    throw new Error(existing.formulaId === definition.formulaId
      ? 'FEATURE_DEFINITION_IMMUTABLE'
      : 'FORMULA_CHANGE_REQUIRES_NEW_FEATURE_DEFINITION_ID');
  }
  return Object.freeze({
    schemaVersion: FEATURE_REGISTRY_VERSION,
    definitions: Object.freeze([...registry.definitions, definition]),
  });
}

export function resolveFeatureDefinition(registry, featureDefinitionId) {
  const definition = registry?.definitions?.find((item) => item.featureDefinitionId === featureDefinitionId);
  if (!definition) throw new Error('FEATURE_DEFINITION_UNKNOWN');
  if (definition.deprecated) throw new Error('FEATURE_DEFINITION_DEPRECATED');
  return definition;
}

/** Deprecation is never a silent rewrite: the successor must be registered and named. */
export function deprecateFeatureDefinition(registry, featureDefinitionId, { supersededBy } = {}) {
  const definition = registry.definitions.find((item) => item.featureDefinitionId === featureDefinitionId);
  if (!definition) throw new Error('FEATURE_DEFINITION_UNKNOWN');
  if (typeof supersededBy !== 'string' || supersededBy.length === 0
    || supersededBy === featureDefinitionId
    || !registry.definitions.some((item) => item.featureDefinitionId === supersededBy)) {
    throw new Error('DEPRECATION_REQUIRES_REGISTERED_SUCCESSOR');
  }
  return Object.freeze({
    schemaVersion: FEATURE_REGISTRY_VERSION,
    definitions: Object.freeze(registry.definitions.map((item) => (item.featureDefinitionId === featureDefinitionId
      ? Object.freeze({ ...item, deprecated: true, supersededBy })
      : item))),
  });
}

/** Disclosure projection; consumers read this and ignore unknown extension fields. */
export function describeRegistry(registry) {
  return Object.freeze({
    schemaVersion: FEATURE_REGISTRY_VERSION,
    policy: REGISTRY_EVOLUTION_POLICY,
    definitions: Object.freeze(registry.definitions.map((item) => Object.freeze({
      featureDefinitionId: item.featureDefinitionId,
      familyId: item.familyId,
      formulaId: item.formulaId,
      formulaVersion: item.formulaVersion,
      requiredObservedFields: item.requiredObservedFields,
      deprecated: item.deprecated,
      supersededBy: item.supersededBy,
    }))),
  });
}
