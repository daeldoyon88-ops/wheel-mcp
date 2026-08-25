/**
 * GATE23 evolvability tests.
 *
 * Evolution is additive and versioned: a behavioural change produces a new
 * FormulaId, a registered definition is immutable, deprecation names a successor,
 * and adding a declared non-core member never disturbs an existing identity.
 */

import assert from 'node:assert/strict';
import {
  createFeatureRegistry,
  registerFeatureDefinition,
  resolveFeatureDefinition,
  deprecateFeatureDefinition,
  defineFeature,
  describeRegistry,
  REGISTRY_EVOLUTION_POLICY,
} from '../implementation/feature-registry-v1.mjs';
import {
  F1_DEFINITION,
  CORE_FEATURE_SET_V1,
  declareFeatureVector,
  simpleReturn,
  memberKey,
} from '../implementation/feature-families-v1.mjs';
import { FEATURE_WINDOW_LADDER_V1 } from '../implementation/feature-window-v1.mjs';
import { describeFeatureRecordIdentity, FEATURE_RECORD_ID_MEMBERS_V1 } from '../implementation/feature-identity-v1.mjs';
import { describeCausalAdmission } from '../implementation/causal-admission-v1.mjs';
import { materializeFeatureRecords } from '../implementation/feature-materializer-v1.mjs';
import { materializeFixture, buildFixtureInput } from '../fixtures/causal-window-fixture.mjs';
import { F1_V2_DEFINITION } from '../fixtures/provenance-drift-fixture.mjs';

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

/* A registered definition is immutable and a behavioural change needs a new identity. */
const registry = createFeatureRegistry([F1_DEFINITION]);
check(() => assert.throws(() => registerFeatureDefinition(registry, F1_DEFINITION), /FEATURE_DEFINITION_IMMUTABLE/));
check(() => assert.throws(() => registerFeatureDefinition(registry, F1_V2_DEFINITION), /FORMULA_CHANGE_REQUIRES_NEW_FEATURE_DEFINITION_ID/));
check(() => assert.equal(REGISTRY_EVOLUTION_POLICY.behaviouralChange, 'REQUIRES_NEW_FORMULA_ID'));
check(() => assert.throws(() => defineFeature({
  featureDefinitionId: 'F2_LOG_RETURN',
  familyId: 'F2_LOG_RETURN',
  formulaId: 'GATE23_LOG_RETURN',
  formulaVersion: '1',
  requiredObservedFields: ['close'],
  compute: ({ closes }) => simpleReturn(closes),
}), /FORMULA_ID_MUST_CARRY_BEHAVIOR_VERSION/));

/* An Outcome-shaped definition can never be registered. */
check(() => assert.throws(() => defineFeature({
  featureDefinitionId: 'laggedOutcome',
  familyId: 'F9',
  formulaId: 'GATE23_LAGGED_OUTCOME/1',
  formulaVersion: '1',
  requiredObservedFields: ['close'],
  compute: () => ({ status: 'RESOLVED', value: 0 }),
}), /OUTCOME_DIRECT_FORBIDDEN/));

/* Additive registration leaves existing definitions untouched. */
const F2_DEFINITION = defineFeature({
  featureDefinitionId: 'F2_LOG_RETURN',
  familyId: 'F2_LOG_RETURN',
  formulaId: 'GATE23_LOG_RETURN/1',
  formulaVersion: '1',
  requiredObservedFields: ['close'],
  compute: ({ closes }) => {
    const base = simpleReturn(closes);
    return base.status === 'RESOLVED' ? { ...base, value: Math.log(1 + base.value) } : base;
  },
  experimentalNote: 'unknown fields are carried as extensions and ignored by consumers',
});
const extended = registerFeatureDefinition(registry, F2_DEFINITION);
check(() => assert.equal(extended.definitions.length, 2));
check(() => assert.equal(registry.definitions.length, 1));
check(() => assert.equal(resolveFeatureDefinition(extended, 'F1_SIMPLE_RETURN').formulaId, 'GATE23_SIMPLE_RETURN/1'));
check(() => assert.equal(F2_DEFINITION.extensions.experimentalNote.length > 0, true));
check(() => assert.equal(Object.hasOwn(describeRegistry(extended).definitions[1], 'experimentalNote'), false));
check(() => assert.equal(describeRegistry(extended).policy.unknownFields, 'CONSUMERS_IGNORE'));

/* Deprecation is never silent and always names a registered successor. */
check(() => assert.throws(() => deprecateFeatureDefinition(extended, 'F1_SIMPLE_RETURN', {}), /DEPRECATION_REQUIRES_REGISTERED_SUCCESSOR/));
check(() => assert.throws(() => deprecateFeatureDefinition(extended, 'F1_SIMPLE_RETURN', { supersededBy: 'F9_UNKNOWN' }), /DEPRECATION_REQUIRES_REGISTERED_SUCCESSOR/));
const deprecated = deprecateFeatureDefinition(extended, 'F1_SIMPLE_RETURN', { supersededBy: 'F2_LOG_RETURN' });
check(() => assert.throws(() => resolveFeatureDefinition(deprecated, 'F1_SIMPLE_RETURN'), /FEATURE_DEFINITION_DEPRECATED/));
check(() => assert.equal(resolveFeatureDefinition(extended, 'F1_SIMPLE_RETURN').deprecated, false));

/* Declaring an additional non-core member never disturbs an existing core identity. */
const base = materializeFixture();
const baseCore = new Map(base.records.filter((record) => record.core).map((record) => [memberKey(record), record.featureRecordId]));
const narrowed = materializeFeatureRecords(buildFixtureInput({
  vector: declareFeatureVector([...CORE_FEATURE_SET_V1.map((member) => ({ ...member }))]),
}));
check(() => assert.equal(narrowed.records.length, 2));
check(() => narrowed.records.forEach((record) => assert.equal(record.featureRecordId, baseCore.get(memberKey(record)))));
check(() => assert.equal(narrowed.vectorStatus, 'RESOLVED'));

/* Frozen surfaces: the ladder, the core set and the identity member list. */
check(() => assert.ok(Object.isFrozen(FEATURE_WINDOW_LADDER_V1)));
check(() => assert.ok(Object.isFrozen(CORE_FEATURE_SET_V1)));
check(() => assert.ok(Object.isFrozen(FEATURE_RECORD_ID_MEMBERS_V1)));
check(() => assert.throws(() => { FEATURE_WINDOW_LADDER_V1.push(10); }, /TypeError/));
check(() => assert.throws(() => { CORE_FEATURE_SET_V1.push({ featureDefinitionId: 'F2_LOG_RETURN', sessionCount: 63 }); }, /TypeError/));

/* Disclosure surfaces are stable and self-describing for downstream consumers. */
check(() => assert.equal(describeFeatureRecordIdentity().memberCount, 11));
check(() => assert.equal(describeFeatureRecordIdentity().closureRule, 'EXACT_ONLY'));
check(() => assert.equal(describeCausalAdmission().claimCount, 2));
check(() => assert.equal(describeCausalAdmission().preserved, 'TRUSTED_CANONICAL_PRODUCER_V1'));
check(() => assert.equal(describeCausalAdmission().outcomeProhibition.length, 4));

console.log(`GATE23_EVOLVABILITY_PASS ${assertions}`);
