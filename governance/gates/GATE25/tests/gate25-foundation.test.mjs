/**
 * GATE25 foundation tests.
 *
 * Binding conformance (D1-D8 against R0003), CORE_V1 dimensions, exact eligibility,
 * min-max normalization, zero range, Manhattan L1, ordering and ties, identity,
 * support states and explainability reconciliation.
 *
 * This file also exports the GATE25 fixture scenario builders shared by the other
 * suites; its assertions run only when it is executed directly. Every fixture
 * RegimeRecord is emitted by the real GATE24 emitRegimeRecord over the GATE24
 * FIXTURE calendar namespace, which production admission refuses by construction.
 * Expected values are recomputed here from first principles, never read back from
 * the engine output they check.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { createFeatureVectorBinding } from '../../GATE24/implementation/regime-identity-v1.mjs';
import { emitRegimeRecord } from '../../GATE24/implementation/regime-store-v1.mjs';
import { resolveMacroSnapshot } from '../../GATE24/implementation/macro-context-binding-v1.mjs';
import { ACTIVE_DIMENSION_NAMES_V1 } from '../../GATE24/implementation/regime-taxonomy-v1.mjs';
import {
  CALENDAR_REGISTRY_MANIFEST_ID,
  EMPTY_MACRO_VINTAGE_STORE,
  FIXTURE_DATASET_ID_FEATURE,
  FIXTURE_INSTRUMENT_IDENTITY_ID,
  SESSION_UNIVERSE,
  buildFeatureSet,
  buildMacroVintageStore,
} from '../../GATE24/fixtures/vintage-causality-fixture.mjs';
import { CURVE_NOT_AVAILABLE_STORE } from '../../GATE24/fixtures/missingness-horizon-fixture.mjs';
import { isClassifyingValue } from '../../GATE24/implementation/regime-taxonomy-v1.mjs';

export { EMPTY_MACRO_VINTAGE_STORE };
import {
  CLASSIFIER_VERSION,
  FIXTURE_ACTIVE_HORIZON_SPEC,
  KNOWLEDGE_CUTOFF_BOUNDARY,
  MACRO_CONTEXT_BINDING,
  PARAMETER_SET,
} from '../../GATE24/fixtures/missingness-horizon-fixture.mjs';

import {
  ANALOGUE_IDENTITY_MEMBERS_V1,
  ANALOGUE_IDENTITY_SCHEMA_V1,
} from '../implementation/analogue-identity-v1.mjs';
import {
  CANDIDATE_SCHEMA_V1,
  CORE_V1_DIMENSIONS_V1,
  ELIGIBILITY_EXCLUSION_REASONS_V1,
  P3H_EXCLUSION_CLASS_REASONS_V1,
  QUERY_SCHEMA_V1,
  REGIME_RECORD_PROOF_INPUT_ID,
} from '../implementation/analogue-eligibility-v1.mjs';
import { DISTANCE_FEATURE_IDS_V1 } from '../implementation/analogue-distance-v1.mjs';
import { INDEX_PAGE_SIZE_V1, rankQueryResults } from '../implementation/analogue-index-v1.mjs';
import { SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 } from '../implementation/analogue-report-v1.mjs';
import {
  BINDING_ARTIFACTS_V1,
  EXECUTION_CONTRACT_PATH,
  EXECUTION_CONTRACT_SHA256,
  MANDATE_PATH,
  buildAnalogueIndexFromCandidates,
  buildSelectionProvenance,
  createSelectionPolicy,
  loadGate25BuildAuthority,
  runAnalogueSelection,
} from '../implementation/historical-analogue-engine-v1.mjs';
import { serializeAnalogueIndex } from '../implementation/analogue-index-v1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const W5 = 'F1_SIMPLE_RETURN@W5';
const W21 = 'F1_SIMPLE_RETURN@W21';

/* ------------------------------------------------------------------- fixtures */

export const FIXTURE_SCOPE = 'GATE25_FIXTURE_ONLY';
export const authority = loadGate25BuildAuthority({ root: ROOT });
export const FIXTURE_DATASET_SHA256 = 'f0'.repeat(32);
export const FIXTURE_DATASET_ID = `sha256:${FIXTURE_DATASET_SHA256}`;
export const KEY_A = 'GATE25_FIXTURE_P3H/INSTRUMENT_A';
export const KEY_B = 'GATE25_FIXTURE_P3H/INSTRUMENT_B';
export const KEY_X_MALFORMED = 'GATE25_FIXTURE_P3H/X_MALFORMED';
export const KEY_X_SCHEMA = 'GATE25_FIXTURE_P3H/X_SCHEMA';
export const KEY_X_SNAPSHOT = 'GATE25_FIXTURE_P3H/X_SNAPSHOT';
export const INSTRUMENT_A = FIXTURE_INSTRUMENT_IDENTITY_ID;
export const INSTRUMENT_B = `sha256:${'c3'.repeat(32)}`;
export const FIXTURE_SOURCE_BINDING_ID = 'GATE25_FIXTURE_SOURCE_BINDING/1';
export const QUERY_INDEX = SESSION_UNIVERSE.length - 1;
export const session = (index) => SESSION_UNIVERSE[index];

export const FIXTURE_WINDOW = Object.freeze({
  startSessionInclusive: SESSION_UNIVERSE[0].sessionDate,
  endSessionInclusive: SESSION_UNIVERSE.at(-1).sessionDate,
});

function vintageStoreAt(store, availableAt) {
  return Object.freeze(Object.fromEntries(Object.entries(store).map(([series, items]) => [
    series,
    items.map((item) => ({ ...item, availableAt, vintageAvailableAt: availableAt })),
  ])));
}

/** Classifying CORE_V1 macro vintages available at every fixture session. */
export const CLASSIFYING_MACRO_VINTAGE_STORE = vintageStoreAt(
  buildMacroVintageStore({ includeFutureVintage: false }),
  SESSION_UNIVERSE[0].closeUtc,
);
export const NOT_AVAILABLE_CURVE_VINTAGE_STORE = vintageStoreAt(CURVE_NOT_AVAILABLE_STORE, SESSION_UNIVERSE[0].closeUtc);

export function fixturePolicy() {
  return createSelectionPolicy({
    authority,
    datasetId: FIXTURE_DATASET_ID,
    datasetSha256: FIXTURE_DATASET_SHA256,
    historicalObservationWindow: FIXTURE_WINDOW,
    admittedKeyIds: new Set([KEY_A, KEY_B]),
    exclusionClassByKeyId: new Map([
      [KEY_X_MALFORMED, 'MALFORMED_PROVIDER_RESULT'],
      [KEY_X_SCHEMA, 'SCHEMA_FAILURE'],
      [KEY_X_SNAPSHOT, 'SNAPSHOT_CONTRACT_INVALID'],
    ]),
    outcomeCalendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
  });
}

/**
 * Real GATE24 emission for one fixture session. primaryMarketRegime follows W21
 * (>= 0.05 is BULL); volatilityState follows F2 (0.10 < v <= 0.20 is NORMAL, null
 * omits the member so the dimension resolves to INSUFFICIENT_DATA).
 */
export function emitFixtureRegime({
  index, instrumentIdentityId = INSTRUMENT_A, w5, w21, volatility = 0.15, drawdown = -0.04, relativeVolume = 1.1,
  vintageStore = CLASSIFYING_MACRO_VINTAGE_STORE,
}) {
  const { sessionDate, closeUtc: knowledgeCutoff } = session(index);
  const featureSet = buildFeatureSet({
    sessionDate,
    knowledgeCutoff,
    instrumentIdentityId,
    values: { [W21]: w21, [W5]: w5, 'F2_REALIZED_VOLATILITY@W21': volatility ?? 0, 'F3_MAX_DRAWDOWN@W21': drawdown, 'F4_RELATIVE_VOLUME@W21': relativeVolume },
    missing: volatility === null ? ['F2_REALIZED_VOLATILITY@W21'] : [],
  });
  const featureVectorBinding = createFeatureVectorBinding({ featureSet });
  const snapshot = resolveMacroSnapshot({ macroContextBinding: MACRO_CONTEXT_BINDING, vintageStore, knowledgeCutoff });
  const regimeRecord = emitRegimeRecord({
    instrumentIdentityId,
    sessionDate,
    knowledgeCutoff,
    knowledgeCutoffBoundary: KNOWLEDGE_CUTOFF_BOUNDARY,
    regimeHorizonSpec: FIXTURE_ACTIVE_HORIZON_SPEC,
    featureVectorBinding,
    macroContextBinding: MACRO_CONTEXT_BINDING,
    macroSnapshot: snapshot.snapshot,
    vintageStore,
    horizonStartKnowledgeCutoff: SESSION_UNIVERSE[0].closeUtc,
    classifierVersion: CLASSIFIER_VERSION,
    parameterSet: PARAMETER_SET,
    featureSet,
    datasetIdFeature: FIXTURE_DATASET_ID_FEATURE,
    declaredMacroCompleteness: snapshot.snapshot.macroFeatureCompleteness,
  });
  return { featureSet, featureVectorBinding, regimeRecord };
}

const featureRecordOf = (featureSet, key) => featureSet.records.find((record) => `${record.featureDefinitionId}@W${record.sessionCount}` === key);

/** Shared inputs of a query or candidate at one fixture session. */
function fixtureInputs({ index, instrumentIdentityId, w5, w21, volatility, drawdown, relativeVolume, sourceArtifactId, vintageStore }) {
  const emitted = emitFixtureRegime({ index, instrumentIdentityId, w5, w21, volatility, drawdown, relativeVolume, vintageStore });
  const { closeUtc } = session(index);
  const w5Record = featureRecordOf(emitted.featureSet, W5);
  const w21Record = featureRecordOf(emitted.featureSet, W21);
  return {
    featureVectorBinding: emitted.featureVectorBinding,
    regimeRecord: emitted.regimeRecord,
    features: {
      [W5]: { featureRecordId: w5Record.featureRecordId, status: 'RESOLVED', code: null, value: w5 },
      [W21]: { featureRecordId: w21Record.featureRecordId, status: 'RESOLVED', code: null, value: w21 },
    },
    inputProofs: [
      { inputId: W5, sourceArtifactId, sourceArtifactSha256: w5Record.featureRecordId, availableAt: closeUtc },
      { inputId: W21, sourceArtifactId, sourceArtifactSha256: w21Record.featureRecordId, availableAt: closeUtc },
      { inputId: REGIME_RECORD_PROOF_INPUT_ID, sourceArtifactId: `GATE24_REGIME_RECORD:${emitted.regimeRecord.regimeRecordId}`, sourceArtifactSha256: emitted.regimeRecord.regimeRecordId, availableAt: closeUtc },
    ],
  };
}

export function fixtureCandidate({
  keyId = KEY_A, index, instrumentIdentityId = INSTRUMENT_A, w5, w21, volatility = 0.15, drawdown, relativeVolume,
  admission = null, identity = 'AT_SESSION', resolvedAsOfSessionDate = null, vintageStore,
}) {
  const inputs = fixtureInputs({ index, instrumentIdentityId, w5, w21, volatility, drawdown, relativeVolume, sourceArtifactId: `GATE25_FIXTURE_BARS:${keyId}`, vintageStore });
  const { sessionDate, closeUtc } = session(index);
  const exclusionClass = fixturePolicy().pinSet.exclusionClassByKeyId.get(keyId);
  return {
    schema: CANDIDATE_SCHEMA_V1,
    candidateKey: `${keyId}|${sessionDate}`,
    p3hKeyId: keyId,
    p3hAdmission: admission ?? (exclusionClass === undefined ? { status: 'ADMITTED' } : { status: 'EXCLUDED', exclusionClass }),
    sessionDate,
    knowledgeCutoff: closeUtc,
    instrumentIdentity: identity === 'UNRESOLVED'
      ? { status: 'UNRESOLVED', code: 'INSTRUMENT_ALIAS_NOT_FOUND', resolvedAsOfSessionDate: sessionDate }
      : { status: 'RESOLVED', instrumentIdentityId, resolvedAsOfSessionDate: resolvedAsOfSessionDate ?? sessionDate },
    priceBasisId: 'SPLIT_ADJUSTED',
    ...inputs,
  };
}

export function fixtureQuery({ index = QUERY_INDEX, instrumentIdentityId = INSTRUMENT_A, w5 = 0.02, w21 = 0.10, volatility = 0.15, vintageStore } = {}) {
  const inputs = fixtureInputs({ index, instrumentIdentityId, w5, w21, volatility, sourceArtifactId: 'GATE25_FIXTURE_BARS:QUERY', vintageStore });
  const { sessionDate, closeUtc } = session(index);
  return {
    schema: QUERY_SCHEMA_V1,
    sessionDate,
    knowledgeCutoff: closeUtc,
    instrumentIdentity: { status: 'RESOLVED', instrumentIdentityId, resolvedAsOfSessionDate: sessionDate },
    priceBasisId: 'SPLIT_ADJUSTED',
    featureVectorBinding: inputs.featureVectorBinding,
    features: inputs.features,
    regimeRecord: inputs.regimeRecord,
    inputProofs: inputs.inputProofs,
    sourceBindingId: FIXTURE_SOURCE_BINDING_ID,
  };
}

/** Candidates must reach the engine in canonical candidateKey order. */
export const canonicalOrder = (candidates) => [...candidates].sort((left, right) => (left.candidateKey < right.candidateKey ? -1 : 1));

export function fixtureOutcomeSource({ values = new Map(), availableAt = null } = {}) {
  const calls = [];
  return {
    calls,
    sourceBindingId: 'GATE25_FIXTURE_OUTCOME_SOURCE/1',
    lookup({ analogueIdentityId, horizonId }) {
      calls.push(`${analogueIdentityId}|${horizonId}`);
      const key = `${analogueIdentityId}|${horizonId}`;
      if (!values.has(key)) return null;
      return { outcomeValue: values.get(key), outcomeAvailableAt: availableAt ?? SESSION_UNIVERSE[0].closeUtc };
    },
  };
}

export function runFixture({ candidates, query = fixtureQuery(), outcomeSource = fixtureOutcomeSource(), policy = fixturePolicy() }) {
  return runAnalogueSelection({ authority, policy, query, candidates: canonicalOrder(candidates), outcomeSource });
}

/** The five-analogue reference scenario with one excluded candidate of each non-P3H kind. */
export function referenceCandidates() {
  return [
    fixtureCandidate({ index: 150, w5: 0.01, w21: 0.06 }),
    fixtureCandidate({ index: 151, w5: 0.03, w21: 0.14 }),
    fixtureCandidate({ index: 152, w5: 0.05, w21: 0.10 }),
    fixtureCandidate({ index: 153, w5: 0.02, w21: 0.12 }),
    fixtureCandidate({ index: 154, w5: 0.04, w21: 0.08 }),
  ];
}

export const fail = (fn, code) => assert.throws(fn, (error) => error?.code === code, `expected ${code}`);

/* -------------------------------------------------------------------- tests */

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

function runFoundation() {
  const contractBytes = readFileSync(resolve(ROOT, EXECUTION_CONTRACT_PATH));
  const contract = JSON.parse(contractBytes.toString('utf8'));
  const mandate = JSON.parse(readFileSync(resolve(ROOT, MANDATE_PATH), 'utf8'));
  const requirement = (id) => contract.canonicalRequirements.find((item) => item.requirementId === id);

  /* ---- R0003 and binding artifacts */
  check(() => assert.equal(sha256Bytes(contractBytes), EXECUTION_CONTRACT_SHA256));
  check(() => assert.equal(contract.authorizedPaths.length, 22));
  check(() => assert.ok(contract.authorizedPaths.every((path) => !/[*?[\]]/.test(path))));
  check(() => assert.equal(requirement('G25-BUILD-03').deferredToContractResolution.resolvedCount, 8));
  for (const { bindingId, requirementId } of BINDING_ARTIFACTS_V1) {
    const bound = requirement(requirementId);
    const artifact = JSON.parse(readFileSync(resolve(ROOT, bound.bindingArtifactPath), 'utf8'));
    check(() => assert.ok(contract.authorizedPaths.includes(bound.bindingArtifactPath)));
    check(() => assert.equal(artifact.bindingId, bindingId));
    check(() => assert.equal(artifact.decisionId, bound.decisionId));
    check(() => assert.deepEqual(artifact.binding, bound.binding));
    check(() => assert.equal(artifact.authority.bindingSha256Canonical, sha256Canonical(bound.binding)));
    check(() => assert.equal(artifact.authority.executionContractSha256, EXECUTION_CONTRACT_SHA256));
    check(() => assert.ok(artifact.implementationPaths.every((path) => contract.authorizedPaths.includes(path))));
    check(() => assert.equal(artifact.implementationReading.normative, false));
  }

  /* ---- T3: exactly the six CORE_V1 dimensions, in canonical order */
  const icTwelve = mandate.inheritedConstraints.find((item) => item.id === 'IC-12').rule;
  const orderInRule = [...CORE_V1_DIMENSIONS_V1].sort((left, right) => icTwelve.indexOf(left) - icTwelve.indexOf(right));
  check(() => assert.ok(CORE_V1_DIMENSIONS_V1.every((name) => icTwelve.indexOf(name) >= 0)));
  check(() => assert.deepEqual(CORE_V1_DIMENSIONS_V1, mandate.regimeConsumptionPolicy.activeDimensionsAvailable));
  check(() => assert.deepEqual([...CORE_V1_DIMENSIONS_V1], orderInRule));
  check(() => assert.deepEqual([...CORE_V1_DIMENSIONS_V1], [...ACTIVE_DIMENSION_NAMES_V1]));
  check(() => assert.equal(CORE_V1_DIMENSIONS_V1.length, 6));
  check(() => assert.ok(mandate.regimeConsumptionPolicy.registeredNotActiveDimensions.every((name) => !CORE_V1_DIMENSIONS_V1.includes(name))));
  const classifyingQueryVector = fixtureQuery().regimeRecord.regimeVector;
  for (const dimension of CORE_V1_DIMENSIONS_V1) {
    check(() => assert.equal(isClassifyingValue(dimension, classifyingQueryVector[dimension]), true, dimension));
  }

  /* ---- T4: distance uses exactly F1@W5 and F1@W21 */
  check(() => assert.deepEqual([...DISTANCE_FEATURE_IDS_V1], requirement('G25-BUILD-09').binding.distanceFeatureIds));
  check(() => assert.deepEqual([...DISTANCE_FEATURE_IDS_V1], requirement('G25-BUILD-05').binding.distanceFeatureIds));
  const reference = runFixture({ candidates: referenceCandidates() });
  check(() => assert.ok(reference.comparisonReport.analogues.every((entry) => entry.differences.map((item) => item.featureId).join('|') === DISTANCE_FEATURE_IDS_V1.join('|'))));
  /* Same W5/W21, very different non-distance features inside the same regime: identical distance. */
  const twinA = fixtureCandidate({ index: 160, w5: 0.03, w21: 0.09, volatility: 0.11, drawdown: -0.01, relativeVolume: 0.5 });
  const twinB = fixtureCandidate({ index: 161, w5: 0.03, w21: 0.09, volatility: 0.19, drawdown: -0.19, relativeVolume: 2.9 });
  const twins = runFixture({ candidates: [...referenceCandidates(), twinA, twinB] });
  const twinEntries = twins.comparisonReport.analogues.filter((entry) => [session(160).sessionDate, session(161).sessionDate].includes(entry.sessionDate));
  check(() => assert.equal(twinEntries.length, 2));
  check(() => assert.equal(twinEntries[0].finalDistance, twinEntries[1].finalDistance));

  /* ---- T2: exact eligibility filtering */
  const mixed = runFixture({
    candidates: [
      ...referenceCandidates(),
      fixtureCandidate({ index: 155, w5: 0.02, w21: -0.08 }), /* BEAR: CORE_V1 mismatch */
      fixtureCandidate({ index: 156, w5: 0.02, w21: 0.10, volatility: 0.30 }), /* VOLATILE: CORE_V1 mismatch */
      fixtureCandidate({ index: 157, w5: 0.02, w21: 0.10, volatility: null }), /* volatility unavailable */
      fixtureCandidate({ keyId: KEY_B, index: 150, instrumentIdentityId: INSTRUMENT_B, w5: 0.02, w21: 0.10 }), /* other instrument */
      fixtureCandidate({ keyId: KEY_X_SCHEMA, index: 150, w5: 0.02, w21: 0.10 }), /* P3H excluded */
    ],
  });
  const reasonCount = (report, reasonId) => report.exclusionCountsByReason.find((entry) => entry.reasonId === reasonId).count;
  check(() => assert.equal(mixed.supportReport.universeCount, 10));
  check(() => assert.equal(mixed.supportReport.eligibleCount, 5));
  check(() => assert.equal(mixed.supportReport.excludedCount, 5));
  check(() => assert.deepEqual(mixed.supportReport.exclusionCountsByReason.map((entry) => entry.reasonId), [...ELIGIBILITY_EXCLUSION_REASONS_V1]));
  check(() => assert.equal(reasonCount(mixed.supportReport, 'CORE_V1_REGIME_MISMATCH'), 3));
  check(() => assert.equal(reasonCount(mixed.supportReport, 'VOLATILITY_STATE_UNAVAILABLE'), 1));
  check(() => assert.equal(reasonCount(mixed.supportReport, 'INSTRUMENT_IDENTITY_MISMATCH'), 1));
  check(() => assert.equal(reasonCount(mixed.supportReport, 'P3H_EXCLUDED_SCHEMA_FAILURE'), 1));
  check(() => assert.deepEqual(
    mixed.comparisonReport.analogues.map((entry) => entry.sessionDate).sort(),
    [150, 151, 152, 153, 154].map((index) => session(index).sessionDate),
  ));
  check(() => assert.equal(ELIGIBILITY_EXCLUSION_REASONS_V1.length, 12));
  check(() => assert.deepEqual([...ELIGIBILITY_EXCLUSION_REASONS_V1], requirement('G25-BUILD-10').binding.precedence.map((item) => item.reasonId)));
  check(() => assert.deepEqual(P3H_EXCLUSION_CLASS_REASONS_V1, Object.fromEntries(requirement('G25-BUILD-10').binding.p3hClassMapping.map((item) => [item.p3hExclusionClass, item.reasonId]))));

  /* ---- T5 / T7: exact min-max normalization and exact Manhattan L1 */
  const candidateValues = [[0.01, 0.06], [0.03, 0.14], [0.05, 0.10], [0.02, 0.12], [0.04, 0.08]];
  const queryValues = [0.02, 0.10];
  const bounds = [0, 1].map((dimension) => ({ min: Math.min(...candidateValues.map((row) => row[dimension])), max: Math.max(...candidateValues.map((row) => row[dimension])) }));
  check(() => assert.deepEqual(reference.normalizationBounds.map(({ min, max }) => ({ min, max })), bounds));
  for (const entry of reference.comparisonReport.analogues) {
    const row = candidateValues.find((values) => values[0] === entry.differences[0].candidateRawValue && values[1] === entry.differences[1].candidateRawValue);
    check(() => assert.ok(row !== undefined));
    let expectedDistance = 0;
    entry.differences.forEach((difference, dimension) => {
      const { min, max } = bounds[dimension];
      const queryNormalized = (queryValues[dimension] - min) / (max - min);
      const candidateNormalized = (row[dimension] - min) / (max - min);
      const delta = Math.abs(queryNormalized - candidateNormalized);
      expectedDistance += delta;
      check(() => assert.equal(difference.queryRawValue, queryValues[dimension]));
      check(() => assert.equal(difference.min, min));
      check(() => assert.equal(difference.max, max));
      check(() => assert.equal(difference.queryNormalizedValue, queryNormalized));
      check(() => assert.equal(difference.candidateNormalizedValue, candidateNormalized));
      check(() => assert.equal(difference.absoluteNormalizedDelta, delta));
      check(() => assert.equal(entry.distanceComponents[dimension].componentDistance, delta));
    });
    check(() => assert.equal(entry.finalDistance, expectedDistance));
  }
  /* The query is not part of the population: moving it outside [min, max] leaves the bounds unchanged and is not clamped. */
  const outside = runFixture({ candidates: referenceCandidates(), query: fixtureQuery({ w5: 0.20, w21: 0.40 }) });
  check(() => assert.deepEqual(outside.normalizationBounds, reference.normalizationBounds));
  check(() => assert.equal(outside.comparisonReport.analogues[0].differences[0].queryNormalizedValue, (0.20 - 0.01) / (0.05 - 0.01)));
  check(() => assert.ok(outside.comparisonReport.analogues[0].differences[1].queryNormalizedValue > 1));

  /* ---- T6: zero range keeps the dimension with zeros */
  const flat = runFixture({
    candidates: [
      fixtureCandidate({ index: 140, w5: 0.03, w21: 0.06 }),
      fixtureCandidate({ index: 141, w5: 0.03, w21: 0.12 }),
      fixtureCandidate({ index: 142, w5: 0.03, w21: 0.09 }),
    ],
  });
  for (const entry of flat.comparisonReport.analogues) {
    const zero = entry.differences[0];
    check(() => assert.equal(zero.featureId, W5));
    check(() => assert.equal(zero.min, zero.max));
    check(() => assert.equal(zero.queryNormalizedValue, 0));
    check(() => assert.equal(zero.candidateNormalizedValue, 0));
    check(() => assert.equal(zero.absoluteNormalizedDelta, 0));
    check(() => assert.equal(entry.distanceComponents[0].zeroRange, true));
    check(() => assert.equal(entry.distanceComponents[0].componentDistance, 0));
    check(() => assert.equal(entry.finalDistance, entry.differences[1].absoluteNormalizedDelta));
  }

  /* ---- T8: deterministic ordering (finalDistance ASC, sessionDate ASC, id code-unit ASC) */
  const ranked = reference.comparisonReport.analogues;
  check(() => assert.deepEqual(ranked.map((entry) => entry.rank), [1, 2, 3, 4, 5]));
  ranked.forEach((entry, index) => {
    if (index === 0) return;
    const previous = ranked[index - 1];
    check(() => assert.ok(previous.finalDistance < entry.finalDistance
      || (previous.finalDistance === entry.finalDistance && (previous.sessionDate < entry.sessionDate
        || (previous.sessionDate === entry.sessionDate && previous.analogueIdentityId < entry.analogueIdentityId)))));
  });

  /* ---- T9: deterministic tie handling */
  const tied = runFixture({
    candidates: [
      fixtureCandidate({ index: 170, w5: 0.03, w21: 0.09 }),
      fixtureCandidate({ index: 120, w5: 0.03, w21: 0.09 }),
      fixtureCandidate({ index: 130, w5: 0.01, w21: 0.13 }),
    ],
  });
  const tiedPair = tied.comparisonReport.analogues.filter((entry) => entry.differences[0].candidateRawValue === 0.03);
  check(() => assert.equal(tiedPair[0].finalDistance, tiedPair[1].finalDistance));
  check(() => assert.equal(tiedPair[0].sessionDate, session(120).sessionDate));
  check(() => assert.ok(tiedPair[0].rank < tiedPair[1].rank));
  const sameDay = rankQueryResults([
    { analogueIdentityId: 'b'.repeat(64), sessionDate: '2024-06-03', finalDistance: 0.5 },
    { analogueIdentityId: 'a'.repeat(64), sessionDate: '2024-06-03', finalDistance: 0.5 },
    { analogueIdentityId: 'A'.repeat(64), sessionDate: '2024-06-03', finalDistance: 0.5 },
  ]);
  /* Code-unit order: 'A' (0x41) precedes 'a' (0x61); a locale collation would not guarantee this. */
  check(() => assert.deepEqual(sameDay.map((entry) => entry.analogueIdentityId[0]), ['A', 'a', 'b']));

  /* ---- T10: EXACT_ONLY identity, positive case, recomputed independently */
  const expectedQueryMembers = {
    InstrumentIdentityId: INSTRUMENT_A,
    SessionDate: session(QUERY_INDEX).sessionDate,
    KnowledgeCutoff: session(QUERY_INDEX).closeUtc,
    FeatureVectorBindingId: fixtureQuery().featureVectorBinding.featureVectorBindingId,
    RegimeRecordId: fixtureQuery().regimeRecord.regimeRecordId,
    RegimeHorizonSpecId: FIXTURE_ACTIVE_HORIZON_SPEC.regimeHorizonSpecId,
    MacroContextBindingId: MACRO_CONTEXT_BINDING.macroContextBindingId,
    SelectionPolicyVersionId: fixturePolicy().selectionPolicyVersionId,
    EligibleHistoryPinSetId: FIXTURE_DATASET_ID,
    PriceBasisId: 'SPLIT_ADJUSTED',
    MissingnessStateId: 'GATE25_MissingnessState/1:COMPLETE',
  };
  const expectedQueryIdentityId = sha256Canonical({
    schema: 'GATE25_ANALOGUE_IDENTITY_V1',
    orderedMembers: requirement('G25-BUILD-04').binding.orderedMemberIds.map((memberId) => ({ memberId, value: expectedQueryMembers[memberId] })),
  });
  check(() => assert.equal(ANALOGUE_IDENTITY_SCHEMA_V1, requirement('G25-BUILD-04').binding.schema));
  check(() => assert.deepEqual([...ANALOGUE_IDENTITY_MEMBERS_V1], requirement('G25-BUILD-04').binding.orderedMemberIds));
  const odThree = mandate.closedOwnerDecisions.find((item) => item.id === 'OD-3').resolution;
  check(() => assert.ok(ANALOGUE_IDENTITY_MEMBERS_V1.every((member, index) => odThree.includes(`(${index + 1}) ${member}`))));
  check(() => assert.deepEqual([...ANALOGUE_IDENTITY_MEMBERS_V1], [...ANALOGUE_IDENTITY_MEMBERS_V1].sort((left, right) => odThree.indexOf(`) ${left}`) - odThree.indexOf(`) ${right}`))));
  check(() => assert.equal(reference.queryIdentity.analogueIdentityId, expectedQueryIdentityId));
  check(() => assert.equal(reference.comparisonReport.queryIdentityId, expectedQueryIdentityId));
  check(() => assert.deepEqual(reference.queryIdentity.orderedMembers.map((entry) => entry.memberId), [...ANALOGUE_IDENTITY_MEMBERS_V1]));

  /* ---- T13 / T14 / T15 / T16: support states */
  const zero = runFixture({ candidates: [fixtureCandidate({ index: 150, w5: 0.02, w21: -0.08 })] });
  check(() => assert.equal(zero.supportReport.eligibleCount, 0));
  check(() => assert.equal(zero.supportReport.supportStatus, 'INSUFFICIENT_SUPPORT'));
  check(() => assert.equal(zero.supportReport.decision, 'ABSTAIN'));
  check(() => assert.equal(zero.supportReport.abstainReason, 'INSUFFICIENT_SUPPORT'));
  check(() => assert.equal(zero.comparisonReport.analogues.length, 0));
  check(() => assert.equal(zero.outcomeSet.records.length, 0));
  const one = runFixture({ candidates: [fixtureCandidate({ index: 150, w5: 0.01, w21: 0.06 })] });
  check(() => assert.equal(one.supportReport.eligibleCount, 1));
  check(() => assert.equal(one.supportReport.decision, 'ABSTAIN'));
  check(() => assert.equal(one.supportReport.abstainReason, 'INSUFFICIENT_SUPPORT'));
  check(() => assert.equal(one.comparisonReport.analogues.length, 1));
  check(() => assert.equal(one.comparisonReport.analogues[0].finalDistance, 0));
  const two = runFixture({ candidates: referenceCandidates().slice(0, 2) });
  check(() => assert.equal(SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1, 2));
  check(() => assert.equal(two.supportReport.eligibleCount, 2));
  check(() => assert.equal(two.supportReport.supportStatus, 'SUFFICIENT_SUPPORT'));
  check(() => assert.equal(two.supportReport.decision, 'PROCEED'));
  check(() => assert.equal(two.supportReport.abstainReason, null));
  check(() => assert.equal(two.supportReport.structuralGatesPass, true));
  const fiveAgain = runFixture({ candidates: referenceCandidates() });
  check(() => assert.equal(reference.supportReport.supportStatus, 'SUFFICIENT_SUPPORT'));
  check(() => assert.deepEqual(fiveAgain.comparisonReport, reference.comparisonReport));
  check(() => assert.equal(fiveAgain.supportReportId, reference.supportReportId));
  /* Adding excluded candidates never re-ranks or narrows the eligible set. */
  check(() => assert.deepEqual(mixed.comparisonReport.analogues, reference.comparisonReport.analogues));
  check(() => assert.equal(INDEX_PAGE_SIZE_V1, requirement('G25-BUILD-07').binding.pagination.pageSize));

  /* ---- T25: deterministic explainability reconciliation (independent recomputation) */
  const report = mixed.comparisonReport;
  const rawBy = (dimension) => report.analogues.map((entry) => entry.differences[dimension].candidateRawValue);
  const queryRegime = fixtureQuery().regimeRecord.regimeVector;
  for (const entry of report.analogues) {
    let sum = 0;
    entry.differences.forEach((difference, dimension) => {
      const min = Math.min(...rawBy(dimension));
      const max = Math.max(...rawBy(dimension));
      const normalize = (value) => (max === min ? 0 : (value - min) / (max - min));
      check(() => assert.equal(difference.min, min));
      check(() => assert.equal(difference.max, max));
      check(() => assert.equal(difference.queryNormalizedValue, normalize(difference.queryRawValue)));
      check(() => assert.equal(difference.candidateNormalizedValue, normalize(difference.candidateRawValue)));
      check(() => assert.equal(difference.absoluteNormalizedDelta, Math.abs(difference.queryNormalizedValue - difference.candidateNormalizedValue)));
      sum += difference.absoluteNormalizedDelta;
    });
    check(() => assert.equal(entry.finalDistance, sum));
    check(() => assert.deepEqual(entry.commonFactors, CORE_V1_DIMENSIONS_V1.map((dimensionId) => ({ dimensionId, value: queryRegime[dimensionId] }))));
  }
  const reconciledOrder = [...report.analogues].sort((left, right) => left.finalDistance - right.finalDistance
    || (left.sessionDate < right.sessionDate ? -1 : left.sessionDate > right.sessionDate ? 1 : 0)
    || (left.analogueIdentityId < right.analogueIdentityId ? -1 : 1));
  check(() => assert.deepEqual(reconciledOrder.map((entry) => entry.rank), report.analogues.map((entry) => entry.rank)));
  check(() => assert.equal(report.analogues.length, report.eligibleCount));
  check(() => assert.equal(mixed.supportReport.universeCount, mixed.supportReport.eligibleCount + mixed.supportReport.excludedCount));
  /* Provenance distance evidence is the same evidence as the report. */
  const built = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder(referenceCandidates()) });
  const provenance = buildSelectionProvenance({ selection: reference, policy: fixturePolicy(), indexText: serializeAnalogueIndex(built.index) });
  check(() => assert.deepEqual(provenance.manifest.distanceEvidence.analogues.map((entry) => entry.finalDistance), reference.comparisonReport.analogues.map((entry) => entry.finalDistance)));
  check(() => assert.deepEqual(provenance.manifest.selectedAnalogueIdentityIds, reference.comparisonReport.analogues.map((entry) => entry.analogueIdentityId)));
  check(() => assert.ok(provenance.manifest.inputProofs.every((proof) => proof.availableByCutoff === true)));

  /* ---- D8 basics: all and only admissible horizons, per analogue per horizon */
  const horizons = requirement('G25-BUILD-11').binding.admissibleSessionCountsAtBinding;
  check(() => assert.deepEqual(reference.horizonBindings.map((binding) => binding.horizonId), horizons.map((count) => `${count}:${CALENDAR_REGISTRY_MANIFEST_ID}`)));
  check(() => assert.equal(reference.outcomeSet.records.length, reference.comparisonReport.analogues.length * horizons.length));
  check(() => assert.ok(reference.outcomeSet.records.every((record) => record.selectionComplete === true && record.outcomeStatus === 'MISSING' && record.outcomeValue === null)));

  console.log(`GATE25_FOUNDATION_PASS ${assertions}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runFoundation();
