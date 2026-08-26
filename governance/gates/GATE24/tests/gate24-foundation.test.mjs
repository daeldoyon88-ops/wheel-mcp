/**
 * GATE24 positive foundation tests: G24-POS-01 through G24-POS-04.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  REGIME_RECORD_ID_MEMBERS_V1,
  REGIME_RECORD_ID_MEMBER_COUNT,
  REGIME_RECORD_ID_CLOSURE_RULE,
  FORBIDDEN_IN_IDENTITY_DIGEST,
  createRegimeRecordId,
  regimeRecordIdentityTuple,
  createFeatureVectorBinding,
  describeRegimeRecordIdentity,
} from '../implementation/regime-identity-v1.mjs';
import {
  REGIME_HORIZON_SPEC_VERSION,
  REGIME_HORIZON_UNIT_V1,
  CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS,
  CORE_V1_ACTIVE_HORIZON_COUNT,
  createRegimeHorizonSpec,
  createActiveRegimeHorizonSpec,
  resolveCalendarWindowBindingIdFromFeatureSet,
  bindConsumerHorizon,
} from '../implementation/regime-horizon-v1.mjs';
import {
  computeClassificationQuality,
  CLASSIFICATION_QUALITY_VALUES_V1,
  CLASSIFICATION_QUALITY_EVALUATION_ORDER_V1,
  describeClassificationQualityRule,
  describeClassificationEvidenceSchema,
  EVIDENCE_FAMILIES_V1,
  EVIDENCE_FAMILY_DIMENSIONS_V1,
} from '../implementation/regime-classifier-v1.mjs';
import {
  ACTIVE_DIMENSIONS_V1,
  ACTIVE_DIMENSION_NAMES_V1,
  INACTIVE_DIMENSION_NAMES_V1,
  REGIME_DIMENSION_COUNT,
  isFailClosedValue,
} from '../implementation/regime-taxonomy-v1.mjs';
import { FEATURE_WINDOW_LADDER_V1 } from '../../GATE23/implementation/feature-window-v1.mjs';
import {
  emitFixtureRecord,
  FIXTURE_ACTIVE_HORIZON_SPEC,
  ACTIVE_REGIME_HORIZON_SPEC_IDS,
  PARAMETER_SET,
  CLASSIFIER_VERSION,
} from '../fixtures/missingness-horizon-fixture.mjs';
import { buildFeatureSet, FIXTURE_CALENDAR_WINDOW_BINDING } from '../fixtures/vintage-causality-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

/* G24-POS-01: RegimeRecordId is sha256Canonical of the exact ordered ELEVEN members. */
check(() => assert.equal(REGIME_RECORD_ID_MEMBER_COUNT, 11));
check(() => assert.equal(REGIME_RECORD_ID_CLOSURE_RULE, 'EXACT_ONLY'));
check(() => assert.deepEqual(REGIME_RECORD_ID_MEMBERS_V1, [
  'InstrumentIdentityId', 'SessionDate', 'KnowledgeCutoff', 'RegimeHorizonSpecId',
  'FeatureVectorBindingId', 'MacroContextBindingId', 'RegimeTaxonomyVersionId',
  'ClassifierVersionId', 'ParameterSetId', 'DatasetId_feature', 'MissingnessStateId',
]));

const record = emitFixtureRecord();
check(() => assert.equal(record.identityMemberCount, 11));
check(() => assert.deepEqual(record.identityTuple, REGIME_RECORD_ID_MEMBERS_V1.map((m) => record.identity[m])));
/* The digest is the canonical hash of exactly those members, recomputed independently. */
check(() => assert.equal(
  record.regimeRecordId,
  sha256Canonical(Object.fromEntries(REGIME_RECORD_ID_MEMBERS_V1.map((m) => [m, record.identity[m]]))),
));
check(() => assert.equal(emitFixtureRecord().regimeRecordId, record.regimeRecordId));

/* EXACT_ONLY: a ten-member or twelve-member digest is refused, not tolerated. */
const tenMembers = { ...record.identity };
delete tenMembers.MissingnessStateId;
check(() => assert.throws(() => createRegimeRecordId(tenMembers), /REGIME_RECORD_ID_EXACT_ONLY/));
check(() => assert.throws(
  () => createRegimeRecordId({ ...record.identity, ExtraMember: 'x' }),
  /REGIME_RECORD_ID_EXACT_ONLY/,
));
for (const forbidden of ['OutcomeId', 'DatasetId_outcome', 'value', 'classificationQuality']) {
  check(() => assert.throws(
    () => createRegimeRecordId({ ...record.identity, [forbidden]: 'x' }),
    /REGIME_RECORD_ID_FORBIDDEN_MEMBER/,
  ));
}
check(() => assert.ok(FORBIDDEN_IN_IDENTITY_DIGEST.includes('OutcomeId')));
check(() => assert.equal(describeRegimeRecordIdentity().memberCount, 11));
check(() => assert.throws(() => regimeRecordIdentityTuple({ ...record.identity, SessionDate: '' }), /MEMBER_INVALID/));

/* G24-POS-02: CORE_V1 activates exactly one 21-session horizon, resolved BY REFERENCE. */
check(() => assert.deepEqual(CORE_V1_ACTIVE_HORIZON_SESSION_COUNTS, [21]));
check(() => assert.equal(CORE_V1_ACTIVE_HORIZON_COUNT, 1));
check(() => assert.ok(FEATURE_WINDOW_LADDER_V1.includes(21)));
check(() => assert.equal(FIXTURE_ACTIVE_HORIZON_SPEC.schemaVersion, REGIME_HORIZON_SPEC_VERSION));
check(() => assert.equal(FIXTURE_ACTIVE_HORIZON_SPEC.sessionCount, 21));
check(() => assert.equal(FIXTURE_ACTIVE_HORIZON_SPEC.unit, REGIME_HORIZON_UNIT_V1));
/* A 21-session horizon anchored at T observes 22 canonical sessions. */
check(() => assert.equal(FIXTURE_ACTIVE_HORIZON_SPEC.observedSessionCount, 22));
/* The payload is exactly the four declared members and nothing else. */
check(() => assert.equal(FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId, sha256Canonical({
  schemaVersion: REGIME_HORIZON_SPEC_VERSION,
  sessionCount: 21,
  unit: REGIME_HORIZON_UNIT_V1,
  calendarWindowBindingId: FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId,
})));

const featureSet = buildFeatureSet();
const byReference = resolveCalendarWindowBindingIdFromFeatureSet(featureSet);
check(() => assert.equal(byReference.status, 'RESOLVED'));
check(() => assert.equal(byReference.observedCount, 1));
check(() => assert.equal(byReference.calendarWindowBindingId, FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId));
/* The horizon binds the id the FeatureSet already carried; GATE24 built no calendar. */
check(() => assert.equal(
  createActiveRegimeHorizonSpec({ calendarWindowBindingId: byReference.calendarWindowBindingId }).regimeHorizonSpecId,
  FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
));
/* A horizon outside the upstream ladder is refused; GATE24 never widens the ladder. */
check(() => assert.throws(
  () => createRegimeHorizonSpec({ sessionCount: 30, calendarWindowBindingId: byReference.calendarWindowBindingId }),
  /REGIME_HORIZON_NOT_ADMITTED/,
));
/* Even with one horizon active, a consumer must bind it explicitly. */
check(() => assert.equal(bindConsumerHorizon({
  consumerId: 'GATE24_FOUNDATION_TEST',
  regimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
  activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
}).status, 'BOUND'));
check(() => assert.equal(bindConsumerHorizon({
  consumerId: 'GATE24_FOUNDATION_TEST',
  regimeHorizonSpecId: undefined,
  activeRegimeHorizonSpecIds: ACTIVE_REGIME_HORIZON_SPEC_IDS,
}).code, 'IMPLICIT_HORIZON_BINDING_FORBIDDEN'));
/* The classifier version pins the horizon by id, never by a bare session count. */
check(() => assert.deepEqual(CLASSIFIER_VERSION.activeRegimeHorizonSpecIds, ACTIVE_REGIME_HORIZON_SPEC_IDS));
check(() => assert.equal(CLASSIFIER_VERSION.parameterSetIdIsInput, false));
check(() => assert.deepEqual(PARAMETER_SET.activeRegimeHorizonSpecIds, ACTIVE_REGIME_HORIZON_SPEC_IDS));

/* G24-POS-03: classificationQuality is total and mutually exclusive over the six
   active dimensions, with no probability or confidence output.

   Proven exhaustively over the full cartesian product of the six declared
   enumerations, not sampled: every combination must yield exactly one declared
   value, and that value must equal the independently restated rule. */
check(() => assert.equal(ACTIVE_DIMENSION_NAMES_V1.length, 6));
check(() => assert.equal(INACTIVE_DIMENSION_NAMES_V1.length, 5));
check(() => assert.equal(REGIME_DIMENSION_COUNT, 11));
check(() => assert.deepEqual(CLASSIFICATION_QUALITY_EVALUATION_ORDER_V1, ['CONFLICTING', 'INSUFFICIENT', 'PARTIAL', 'COMPLETE']));

const expectedQuality = (values) => {
  const primary = values.primaryMarketRegime;
  if (isFailClosedValue('primaryMarketRegime', primary)) return 'INSUFFICIENT';
  return ACTIVE_DIMENSION_NAMES_V1.some((name) => isFailClosedValue(name, values[name])) ? 'PARTIAL' : 'COMPLETE';
};

let combinations = 0;
const observedQualities = new Set();
const walk = (index, accumulator) => {
  if (index === ACTIVE_DIMENSIONS_V1.length) {
    const quality = computeClassificationQuality(accumulator);
    combinations += 1;
    observedQualities.add(quality);
    assert.ok(CLASSIFICATION_QUALITY_VALUES_V1.includes(quality));
    assert.equal(quality, expectedQuality(accumulator));
    return;
  }
  const spec = ACTIVE_DIMENSIONS_V1[index];
  for (const entry of spec.entries) walk(index + 1, { ...accumulator, [spec.name]: entry });
};
walk(0, {});
check(() => assert.equal(combinations, ACTIVE_DIMENSIONS_V1.reduce((total, spec) => total * spec.entries.length, 1)));
check(() => assert.ok(combinations > 10000));
/* Totality: every combination produced a value. Exclusivity: exactly one per input. */
check(() => assert.deepEqual([...observedQualities].sort(), ['COMPLETE', 'INSUFFICIENT', 'PARTIAL']));
/* CONFLICTING stays in the closed enumeration and is unreachable in CORE_V1. */
check(() => assert.ok(CLASSIFICATION_QUALITY_VALUES_V1.includes('CONFLICTING')));
check(() => assert.ok(!observedQualities.has('CONFLICTING')));
check(() => assert.equal(describeClassificationQualityRule().conflictingDisposition, 'NOT_REACHABLE_IN_CORE_V1'));
check(() => assert.equal(describeClassificationQualityRule().probabilityEmitted, false));
check(() => assert.equal(describeClassificationQualityRule().isMacroFeatureCompleteness, false));

/* The evidence schema carries exactly nine families in mandate order, verbatim. */
check(() => assert.deepEqual(EVIDENCE_FAMILIES_V1, [
  'trend evidence', 'volatility evidence', 'drawdown evidence', 'liquidity evidence',
  'inflation evidence', 'rates evidence', 'curve evidence', 'macro coverage', 'parameter set used',
]));
check(() => assert.equal(describeClassificationEvidenceSchema().familyCount, 9));
check(() => assert.deepEqual(record.classificationEvidence.families.map((f) => f.family), EVIDENCE_FAMILIES_V1));
check(() => assert.equal(record.classificationEvidence.containsFutureData, false));
check(() => assert.equal(record.classificationEvidence.schemaVersion, 'GATE24_ClassificationEvidence/1'));
/* Attribution is a complete cover of the six active dimensions. */
const covered = new Set(Object.values(EVIDENCE_FAMILY_DIMENSIONS_V1).flat());
check(() => assert.deepEqual([...covered].sort(), [...ACTIVE_DIMENSION_NAMES_V1].sort()));
/* evidenceSetId is the digest of the ordered structure excluding itself. */
const { evidenceSetId, ...evidenceWithoutId } = record.classificationEvidence;
check(() => assert.equal(evidenceSetId, sha256Canonical(evidenceWithoutId)));

/* The FeatureVectorBinding binds the exact FeatureSet consumed. */
const binding = createFeatureVectorBinding({ featureSet });
check(() => assert.equal(binding.featureVectorBindingId, record.FeatureVectorBindingId));
check(() => assert.deepEqual(binding.calendarWindowBindingIds, [FIXTURE_CALENDAR_WINDOW_BINDING.calendarWindowBindingId]));

/* G24-POS-04: the 29 workset paths exist and no additional BUILD path is present. */
const contract = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'governance/gates/GATE24/contracts/EXECUTION_CONTRACT_R0002.json'), 'utf8',
));
const authorized = contract.authorizedPaths;
check(() => assert.equal(authorized.length, 29));
check(() => assert.equal(contract.requiredOutputs.length, 29));
check(() => assert.deepEqual([...authorized].sort(), [...contract.requiredOutputs.map((o) => o.path)].sort()));
for (const authorizedPath of authorized) {
  check(() => assert.ok(fs.existsSync(path.join(REPO_ROOT, authorizedPath)), `missing ${authorizedPath}`));
}

/* The BUILD cohort is R0002.authorizedPaths. The GATE24 tree also carries
   lifecycle surfaces that grow with every successor state: R0004 sealed the
   agent closure, R0005 will seal the external confirmation. Those are
   classified out BY RULE rather than by a frozen tree snapshot, so the
   inventory assertion stays stable across the lifecycle while a real 30th
   BUILD output still fails. Discovery is scoped to BUILD-owned surfaces:
   implementation/, tests/, fixtures/, evidence/, and the GATE24_ domain
   contracts. */
const GATE24_PREFIX = 'governance/gates/GATE24/';
const BUILD_FAMILY_DIRS = Object.freeze(['implementation', 'tests', 'fixtures', 'evidence']);
const BUILD_CONTRACT_PREFIX = 'GATE24_';

const isLifecycleContractFile = (file) => file === 'CURRENT_CONTRACT.json'
  || (file.startsWith('EXECUTION_CONTRACT_R') && file.endsWith('.json'))
  || (file.startsWith('PRECONTRACT_AUTHORITY_CONSUMPTION_R') && file.endsWith('.json'));

/* BUILD = a functional BUILD output surface.
   LIFECYCLE_STATE = state/**, successor-state artifacts, never BUILD.
   LIFECYCLE_CONTRACT = CURRENT_CONTRACT / EXECUTION_CONTRACT_Rnnnn /
   PRECONTRACT_AUTHORITY_CONSUMPTION_Rn, distinguished from the seven
   authorized BUILD domain contracts.
   UNCLASSIFIED = anything else, which is a failure. */
const classifyGate24Path = (relativePath) => {
  const [family, ...tail] = relativePath.slice(GATE24_PREFIX.length).split('/');
  if (family === 'state') return 'LIFECYCLE_STATE';
  if (family === 'contracts') {
    if (tail.length !== 1) return 'UNCLASSIFIED';
    if (isLifecycleContractFile(tail[0])) return 'LIFECYCLE_CONTRACT';
    return tail[0].startsWith(BUILD_CONTRACT_PREFIX) ? 'BUILD' : 'UNCLASSIFIED';
  }
  return BUILD_FAMILY_DIRS.includes(family) ? 'BUILD' : 'UNCLASSIFIED';
};
const buildInventory = (paths) => paths.filter((p) => classifyGate24Path(p) === 'BUILD').sort();

function walkDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walkDir(absolute) : [path.relative(REPO_ROOT, absolute).split(path.sep).join('/')];
  });
}
const present = walkDir(path.join(REPO_ROOT, 'governance/gates/GATE24')).sort();
const expectedBuild = [...authorized].sort();

/* Every authorized path is itself a BUILD-family surface: the seven GATE24_
   domain contracts classify BUILD, the lifecycle contracts never do. */
for (const authorizedPath of authorized) {
  check(() => assert.equal(classifyGate24Path(authorizedPath), 'BUILD', `not a BUILD surface: ${authorizedPath}`));
}
check(() => assert.equal(authorized.filter((p) => p.startsWith(`${GATE24_PREFIX}contracts/`)).length, 7));
for (const lifecycleContract of [
  'CURRENT_CONTRACT.json',
  'EXECUTION_CONTRACT_R0001.json',
  'EXECUTION_CONTRACT_R0002.json',
  'PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json',
]) {
  const relative = `${GATE24_PREFIX}contracts/${lifecycleContract}`;
  check(() => assert.equal(classifyGate24Path(relative), 'LIFECYCLE_CONTRACT'));
  check(() => assert.ok(!authorized.includes(relative)));
}

/* The 29-path freeze, evaluated over the BUILD cohort only. */
check(() => assert.deepEqual(buildInventory(present), expectedBuild));
check(() => assert.equal(buildInventory(present).length, 29));
check(() => assert.equal(present.filter((p) => p.includes('/buildprep/')).length, 0));
/* Nothing in the tree escapes classification: an unauthorized surface in an
   undeclared directory is not silently tolerated. */
check(() => assert.deepEqual(present.filter((p) => classifyGate24Path(p) === 'UNCLASSIFIED'), []));

/* R0004 lifecycle artifacts are present, classify as LIFECYCLE_STATE, and are
   absent from the BUILD inventory. This is the defect this test previously had. */
const r0004Lifecycle = present.filter((p) => p.startsWith(`${GATE24_PREFIX}state/revisions/R0004/`));
check(() => assert.deepEqual(r0004Lifecycle.map((p) => p.split('/').pop()).sort(), ['CHECKPOINT.json', 'OPEN_DEFECTS.json', 'STATE_SEAL.json']));
for (const lifecyclePath of present.filter((p) => p.startsWith(`${GATE24_PREFIX}state/`))) {
  check(() => assert.equal(classifyGate24Path(lifecyclePath), 'LIFECYCLE_STATE'));
  check(() => assert.ok(!buildInventory(present).includes(lifecyclePath)));
}

/* Lifecycle stability, proven forward: a synthetic R0005 external-confirmation
   revision and its successor execution contract perturb the BUILD inventory by
   nothing at all. */
const syntheticR0005 = ['CHECKPOINT.json', 'OPEN_DEFECTS.json', 'STATE_SEAL.json']
  .map((name) => `${GATE24_PREFIX}state/revisions/R0005/${name}`);
check(() => assert.deepEqual(
  buildInventory([...present, ...syntheticR0005, `${GATE24_PREFIX}contracts/EXECUTION_CONTRACT_R0003.json`]),
  expectedBuild,
));

/* NEGATIVE CONTROL: a synthetic 30th BUILD output is still rejected, in every
   BUILD family. Held in memory only; nothing is written to the repository. */
for (const synthetic30th of [
  `${GATE24_PREFIX}evidence/GATE24_UNAUTHORIZED_THIRTIETH_OUTPUT.json`,
  `${GATE24_PREFIX}implementation/regime-unauthorized-v1.mjs`,
  `${GATE24_PREFIX}tests/gate24-unauthorized.test.mjs`,
  `${GATE24_PREFIX}fixtures/unauthorized-fixture.mjs`,
  `${GATE24_PREFIX}contracts/GATE24_UNAUTHORIZED_V1.json`,
]) {
  check(() => assert.equal(classifyGate24Path(synthetic30th), 'BUILD'));
  const hostile = buildInventory([...present, synthetic30th]);
  check(() => assert.equal(hostile.length, 30));
  check(() => assert.throws(() => assert.deepEqual(hostile, expectedBuild)));
}
/* And an unauthorized path in an undeclared directory is refused as well. */
check(() => assert.equal(classifyGate24Path(`${GATE24_PREFIX}tools/smuggled.mjs`), 'UNCLASSIFIED'));

console.log(`GATE24_FOUNDATION_PASS ${assertions}`);
