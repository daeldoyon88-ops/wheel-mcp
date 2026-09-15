/**
 * GATE25 hostile tests.
 *
 * Identity mismatch and alias backdating, P3H exclusions that must never become
 * eligible, missing / malformed / non-finite features, future sessions, the exact
 * cutoff edge, historical identity semantics, wrong dataset binding, outcome
 * leakage in every declared form, and the absence of any network, provider or model
 * surface. Every refusal is asserted by its explicit fail-closed code.
 */

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import { CALENDAR_REGISTRY_MANIFEST_ID } from '../../GATE24/fixtures/vintage-causality-fixture.mjs';

import {
  ANALOGUE_IDENTITY_MEMBERS_V1,
  createAnalogueIdentity,
  identityMemberValue,
  verifyAnalogueIdentity,
} from '../implementation/analogue-identity-v1.mjs';
import {
  evaluateCandidateEligibility,
  readAnalogueQuery,
  readHistoricalCandidate,
  CORE_V1_DIMENSIONS_V1,
  evaluateCoreV1ExactMatch,
} from '../implementation/analogue-eligibility-v1.mjs';
import {
  assertDistanceParameterRequest,
  computeDistanceEvidence,
  computeNormalizationBounds,
} from '../implementation/analogue-distance-v1.mjs';
import {
  appendIndexRecord,
  mergeAnalogueIndexBytes,
  parseAnalogueIndex,
  serializeAnalogueIndex,
  createAnalogueIndex,
} from '../implementation/analogue-index-v1.mjs';
import {
  assertNoForbiddenReportField,
  buildComparisonReport,
  buildSupportReport,
  resolveSupport,
} from '../implementation/analogue-report-v1.mjs';
import {
  admissibleHorizonBindings,
  attachPostSelectionOutcomes,
  freezeSelection,
} from '../implementation/analogue-outcome-v1.mjs';
import {
  buildInputProof,
  buildProvenanceManifest,
  verifyProvenanceIndexBinding,
} from '../implementation/analogue-provenance-v1.mjs';
import {
  bindR0003SelectionPolicy,
  buildAnalogueIndexFromCandidates,
  buildSelectionProvenance,
  createSelectionPolicy,
  loadHistoricalWindowCalendar,
  loadP3hDatasetBinding,
  materializeCanonicalProducts,
  runAnalogueSelection,
} from '../implementation/historical-analogue-engine-v1.mjs';
import {
  CLASSIFYING_MACRO_VINTAGE_STORE,
  EMPTY_MACRO_VINTAGE_STORE,
  NOT_AVAILABLE_CURVE_VINTAGE_STORE,
  FIXTURE_DATASET_ID,
  FIXTURE_DATASET_SHA256,
  FIXTURE_WINDOW,
  INSTRUMENT_A,
  INSTRUMENT_B,
  KEY_A,
  KEY_B,
  KEY_X_MALFORMED,
  KEY_X_SCHEMA,
  KEY_X_SNAPSHOT,
  QUERY_INDEX,
  authority,
  canonicalOrder,
  fail,
  fixtureCandidate,
  fixtureOutcomeSource,
  fixturePolicy,
  fixtureQuery,
  referenceCandidates,
  runFixture,
  session,
} from './gate25-foundation.test.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const W5 = 'F1_SIMPLE_RETURN@W5';
const W21 = 'F1_SIMPLE_RETURN@W21';
const clone = (value) => structuredClone(value);
const plusOneMs = (instant) => new Date(Date.parse(instant) + 1).toISOString();

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };
const refuse = (fn, code) => check(() => fail(fn, code));

/* Decision for one candidate against a query, without running the whole universe. */
function decide(candidate, { query = fixtureQuery(), policy = fixturePolicy() } = {}) {
  const queryContext = readAnalogueQuery(query, policy);
  const context = readHistoricalCandidate(candidate, policy);
  return evaluateCandidateEligibility({ context, query: queryContext, policy }).reasons;
}

/* ------------------------------------------------ T11 identity mismatch / backdating */

check(() => assert.deepEqual(decide(fixtureCandidate({ index: 150, instrumentIdentityId: INSTRUMENT_B, w5: 0.02, w21: 0.10 })), ['INSTRUMENT_IDENTITY_MISMATCH']));
check(() => assert.deepEqual(decide(fixtureCandidate({ index: 150, identity: 'UNRESOLVED', w5: 0.02, w21: 0.10 })), ['INSTRUMENT_IDENTITY_MISMATCH']));
/* A present-day resolution projected onto a historical session is alias backdating, even when the id matches. */
check(() => assert.deepEqual(decide(fixtureCandidate({ index: 150, w5: 0.02, w21: 0.10, resolvedAsOfSessionDate: session(QUERY_INDEX).sessionDate })), ['INSTRUMENT_IDENTITY_MISMATCH']));

const reference = runFixture({ candidates: referenceCandidates() });
const members = Object.fromEntries(reference.queryIdentity.orderedMembers.map((entry) => [entry.memberId, entry.value]));
check(() => assert.equal(createAnalogueIdentity(members).analogueIdentityId, reference.queryIdentity.analogueIdentityId));
const swapped = reference.queryIdentity.orderedMembers.map((entry) => ({ ...entry }));
[swapped[0], swapped[1]] = [swapped[1], swapped[0]];
refuse(() => verifyAnalogueIdentity({ analogueIdentityId: reference.queryIdentity.analogueIdentityId, orderedMembers: swapped }), 'ANALOGUE_IDENTITY_MEMBER_REORDER_FORBIDDEN');
refuse(() => createAnalogueIdentity({ ...members, CalendarWindowBindingId: 'x' }), 'ANALOGUE_IDENTITY_EXACT_ONLY');
const omitted = { ...members };
delete omitted.MissingnessStateId;
refuse(() => createAnalogueIdentity(omitted), 'ANALOGUE_IDENTITY_EXACT_ONLY');
refuse(() => createAnalogueIdentity({ ...members, MissingnessStateId: undefined }), 'ANALOGUE_IDENTITY_MEMBER_NOT_EXACT');
refuse(() => createAnalogueIdentity({ ...omitted, ticker: 'AAPL' }), 'ANALOGUE_IDENTITY_FORBIDDEN_MEMBER');
refuse(() => createAnalogueIdentity({ ...omitted, OutcomeId: 'o' }), 'ANALOGUE_IDENTITY_FORBIDDEN_MEMBER');
refuse(() => createAnalogueIdentity({ ...omitted, finalDistance: 0 }), 'ANALOGUE_IDENTITY_FORBIDDEN_MEMBER');
refuse(() => createAnalogueIdentity({ ...members, InstrumentIdentityId: ` ${members.InstrumentIdentityId}` }), 'ANALOGUE_IDENTITY_MEMBER_NOT_EXACT');
refuse(() => createAnalogueIdentity({ ...members, SelectionPolicyVersionId: 'café' }), 'ANALOGUE_IDENTITY_MEMBER_NOT_EXACT');
refuse(() => createAnalogueIdentity({ ...members, PriceBasisId: 'TOTAL_RETURN_ADJUSTED' }), 'ANALOGUE_IDENTITY_PRICE_BASIS_NOT_ADMITTED');
refuse(() => createAnalogueIdentity({ ...members, SessionDate: '2025-3-1' }), 'ANALOGUE_IDENTITY_SESSION_DATE_INVALID');
refuse(() => verifyAnalogueIdentity({ analogueIdentityId: '0'.repeat(64), orderedMembers: reference.queryIdentity.orderedMembers }), 'ANALOGUE_IDENTITY_DIGEST_MISMATCH');
/* No fuzzy identity: a case variant is a different identity, never the same one. */
check(() => assert.notEqual(createAnalogueIdentity({ ...members, InstrumentIdentityId: members.InstrumentIdentityId.toUpperCase() }).analogueIdentityId, reference.queryIdentity.analogueIdentityId));
refuse(() => runFixture({
  candidates: referenceCandidates(),
  query: { ...fixtureQuery(), instrumentIdentity: { status: 'RESOLVED', instrumentIdentityId: INSTRUMENT_A, resolvedAsOfSessionDate: session(150).sessionDate } },
}), 'QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE');

/* ------------------------------------------------------------ T12 P3H exclusions */

const perfect = { index: 150, w5: 0.02, w21: 0.10 };
check(() => assert.deepEqual(decide(fixtureCandidate({ ...perfect, keyId: KEY_X_MALFORMED })), ['P3H_EXCLUDED_MALFORMED_PROVIDER_RESULT']));
check(() => assert.deepEqual(decide(fixtureCandidate({ ...perfect, keyId: KEY_X_SCHEMA })), ['P3H_EXCLUDED_SCHEMA_FAILURE']));
check(() => assert.deepEqual(decide(fixtureCandidate({ ...perfect, keyId: KEY_X_SNAPSHOT })), ['P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID']));
refuse(() => decide(fixtureCandidate({ ...perfect, keyId: KEY_X_SCHEMA, admission: { status: 'ADMITTED' } })), 'P3H_EXCLUSION_CANNOT_BE_READMITTED');
refuse(() => decide(fixtureCandidate({ ...perfect, keyId: KEY_X_SCHEMA, admission: { status: 'EXCLUDED', exclusionClass: 'MALFORMED_PROVIDER_RESULT' } })), 'P3H_EXCLUSION_CANNOT_BE_READMITTED');
refuse(() => decide(fixtureCandidate({ ...perfect, admission: { status: 'EXCLUDED', exclusionClass: 'SCHEMA_FAILURE' } })), 'P3H_ADMISSION_STATE_MISMATCH');
refuse(() => decide(fixtureCandidate({ ...perfect, keyId: 'GATE25_FIXTURE_P3H/NOT_PINNED' })), 'CANDIDATE_OUTSIDE_BOUND_PIN_SET');
const withExcluded = runFixture({ candidates: [...referenceCandidates(), ...[KEY_X_MALFORMED, KEY_X_SCHEMA, KEY_X_SNAPSHOT].map((keyId) => fixtureCandidate({ ...perfect, keyId }))] });
check(() => assert.equal(withExcluded.supportReport.eligibleCount, 5));
check(() => assert.ok(withExcluded.comparisonReport.analogues.every((entry) => entry.sessionDate !== session(150).sessionDate || entry.differences[0].candidateRawValue === 0.01)));

/* The nine real P3H exclusions, read from the frozen finalization by dataset identity. */
const p3h = loadP3hDatasetBinding({ authority });
const calendar = loadHistoricalWindowCalendar({ authority, root: ROOT });
const realPolicy = bindR0003SelectionPolicy({ authority, p3h, calendar });
check(() => assert.equal(p3h.exclusions.length, 9));
check(() => assert.deepEqual(p3h.exclusionClassCounts, { MALFORMED_PROVIDER_RESULT: 1, SCHEMA_FAILURE: 6, SNAPSHOT_CONTRACT_INVALID: 2 }));
const expectedRealReason = { MALFORMED_PROVIDER_RESULT: 'P3H_EXCLUDED_MALFORMED_PROVIDER_RESULT', SCHEMA_FAILURE: 'P3H_EXCLUDED_SCHEMA_FAILURE', SNAPSHOT_CONTRACT_INVALID: 'P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID' };
const realExcludedCandidates = p3h.exclusions.map((exclusion) => {
  const candidate = fixtureCandidate({ ...perfect, admission: { status: 'EXCLUDED', exclusionClass: exclusion.reasonCode } });
  return { ...candidate, p3hKeyId: exclusion.acquisitionKey, candidateKey: `${exclusion.acquisitionKey}|${candidate.sessionDate}` };
});
for (const [index, candidate] of realExcludedCandidates.entries()) {
  check(() => assert.deepEqual(decide(candidate, { policy: realPolicy }), [expectedRealReason[p3h.exclusions[index].reasonCode]]));
  refuse(() => decide({ ...candidate, p3hAdmission: { status: 'ADMITTED' } }, { policy: realPolicy }), 'P3H_EXCLUSION_CANNOT_BE_READMITTED');
}
const realExcludedRun = runAnalogueSelection({ authority, policy: realPolicy, query: fixtureQuery(), candidates: canonicalOrder(realExcludedCandidates), outcomeSource: null });
check(() => assert.equal(realExcludedRun.supportReport.universeCount, 9));
check(() => assert.equal(realExcludedRun.supportReport.eligibleCount, 0));
check(() => assert.deepEqual(
  realExcludedRun.supportReport.exclusionCountsByReason.slice(0, 3).map((entry) => entry.count),
  [1, 6, 2],
));
check(() => assert.ok(realExcludedRun.supportReport.exclusionCountsByReason.slice(3).every((entry) => entry.count === 0)));

/* --------------------------------------------------- T17 / T18 / T19 feature hostiles */

const withFeature = (featureId, input, base = fixtureCandidate(perfect)) => ({ ...base, features: { ...base.features, [featureId]: input } });
const recordId = fixtureCandidate(perfect).features[W5].featureRecordId;
check(() => assert.deepEqual(decide(withFeature(W5, null)), ['REQUIRED_DISTANCE_FEATURE_MISSING']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW', value: null })), ['REQUIRED_DISTANCE_FEATURE_MISSING']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'FAIL_CLOSED', code: 'INPUT_MISSING', value: null })), ['REQUIRED_DISTANCE_FEATURE_MISSING']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: null })), ['REQUIRED_DISTANCE_FEATURE_MISSING']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'FAIL_CLOSED', code: 'INVALID_INPUT', value: null })), ['REQUIRED_DISTANCE_FEATURE_MALFORMED']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: '0.02' })), ['REQUIRED_DISTANCE_FEATURE_MALFORMED']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'ESTIMATED', code: null, value: 0.02 })), ['REQUIRED_DISTANCE_FEATURE_MALFORMED']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: Number.NaN })), ['REQUIRED_DISTANCE_FEATURE_NON_FINITE']));
check(() => assert.deepEqual(decide(withFeature(W5, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: Number.POSITIVE_INFINITY })), ['REQUIRED_DISTANCE_FEATURE_NON_FINITE']));
check(() => assert.deepEqual(
  decide(withFeature(W21, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: Number.NEGATIVE_INFINITY }, withFeature(W5, null))),
  ['REQUIRED_DISTANCE_FEATURE_MISSING', 'REQUIRED_DISTANCE_FEATURE_NON_FINITE'],
));
refuse(() => decide(withFeature(W5, { featureRecordId: recordId, status: 'RESOLVED', code: null, value: 0.02, extra: 1 })), 'DISTANCE_FEATURE_INPUT_NOT_CLOSED');
refuse(() => decide(withFeature(W5, { featureRecordId: 'f'.repeat(64), status: 'RESOLVED', code: null, value: 0.02 })), 'DISTANCE_FEATURE_NOT_IN_FEATURE_VECTOR_BINDING');
/* Query side: incomplete features never yield a distance. */
const queryWith = (featureId, input) => ({ ...fixtureQuery(), features: { ...fixtureQuery().features, [featureId]: input } });
refuse(() => runFixture({ candidates: referenceCandidates().slice(0, 1), query: queryWith(W5, null) }), 'QUERY_DISTANCE_FEATURE_INCOMPLETE');
refuse(() => runFixture({ candidates: referenceCandidates(), query: queryWith(W21, { ...fixtureQuery().features[W21], value: Number.NaN }) }), 'SUFFICIENT_SUPPORT_WITH_STRUCTURAL_GATES_FAILED_REFUSED');
const noEligibleQueryMissing = runFixture({ candidates: [fixtureCandidate({ index: 150, w5: 0.02, w21: -0.08 })], query: queryWith(W5, null) });
check(() => assert.equal(noEligibleQueryMissing.supportReport.structuralGatesPass, false));
check(() => assert.equal(noEligibleQueryMissing.supportReport.decision, 'ABSTAIN'));
check(() => assert.equal(identityMemberValue(noEligibleQueryMissing.queryIdentity.orderedMembers, 'MissingnessStateId'), 'GATE25_MissingnessState/1:DISTANCE_FEATURE_INCOMPLETE'));

/* Multiple reasons are emitted together in precedence order. */
const early = createSelectionPolicy({
  authority,
  datasetId: FIXTURE_DATASET_ID,
  datasetSha256: FIXTURE_DATASET_SHA256,
  historicalObservationWindow: { startSessionInclusive: session(100).sessionDate, endSessionInclusive: FIXTURE_WINDOW.endSessionInclusive },
  admittedKeyIds: new Set([KEY_A, KEY_B]),
  exclusionClassByKeyId: new Map([[KEY_X_MALFORMED, 'MALFORMED_PROVIDER_RESULT'], [KEY_X_SCHEMA, 'SCHEMA_FAILURE'], [KEY_X_SNAPSHOT, 'SNAPSHOT_CONTRACT_INVALID']]),
  outcomeCalendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
});
const worstBase = fixtureCandidate({ keyId: KEY_X_SNAPSHOT, index: 50, instrumentIdentityId: INSTRUMENT_B, w5: 0.02, w21: -0.08, volatility: null });
const everything = withFeature(W21, { ...worstBase.features[W21], value: Number.NaN }, withFeature(W5, null, worstBase));
check(() => assert.deepEqual(decide(everything, { policy: early }), [
  'P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID', 'OUTSIDE_HISTORICAL_WINDOW', 'INSTRUMENT_IDENTITY_MISMATCH',
  'CORE_V1_REGIME_MISMATCH', 'VOLATILITY_STATE_UNAVAILABLE', 'REQUIRED_DISTANCE_FEATURE_MISSING', 'REQUIRED_DISTANCE_FEATURE_NON_FINITE',
]));

/* ------------------------------------------------------- T20 / T21 time hostiles */

const queryAt180 = fixtureQuery({ index: 180 });
check(() => assert.deepEqual(decide(fixtureCandidate({ index: 190, w5: 0.02, w21: 0.10 }), { query: queryAt180 }), ['OUTSIDE_HISTORICAL_WINDOW', 'AVAILABLE_AFTER_KNOWLEDGE_CUTOFF']));
/* The query observation itself is never part of its own population. */
check(() => assert.deepEqual(decide(fixtureCandidate({ index: 180, w5: 0.02, w21: 0.10 }), { query: queryAt180 }), ['OUTSIDE_HISTORICAL_WINDOW']));
check(() => assert.deepEqual(decide(fixtureCandidate({ index: 50, w5: 0.02, w21: 0.10 }), { policy: early }), ['OUTSIDE_HISTORICAL_WINDOW']));
refuse(() => runFixture({ candidates: [], query: fixtureQuery({ index: 50 }), policy: early }), 'QUERY_OUTSIDE_HISTORICAL_OBSERVATION_WINDOW');

const edge = fixtureCandidate(perfect);
check(() => assert.ok(edge.inputProofs.every((proof) => proof.availableAt === edge.knowledgeCutoff)));
check(() => assert.deepEqual(decide(edge), []));
const lateProof = { ...edge, inputProofs: edge.inputProofs.map((proof) => (proof.inputId === W21 ? { ...proof, availableAt: plusOneMs(proof.availableAt) } : proof)) };
check(() => assert.deepEqual(decide(lateProof), ['AVAILABLE_AFTER_KNOWLEDGE_CUTOFF']));
check(() => assert.deepEqual(decide({ ...edge, inputProofs: edge.inputProofs.filter((proof) => proof.inputId !== 'GATE24_REGIME_RECORD') }), ['AVAILABLE_AFTER_KNOWLEDGE_CUTOFF']));
check(() => assert.deepEqual(decide({ ...edge, inputProofs: edge.inputProofs.map((proof) => ({ ...proof, availableAt: 'yesterday' })) }), ['AVAILABLE_AFTER_KNOWLEDGE_CUTOFF']));
const edgeQuery = fixtureQuery();
check(() => assert.equal(readAnalogueQuery(edgeQuery, fixturePolicy()).knowledgeCutoff, edgeQuery.inputProofs[0].availableAt));
refuse(() => readAnalogueQuery({ ...edgeQuery, inputProofs: edgeQuery.inputProofs.map((proof) => ({ ...proof, availableAt: plusOneMs(proof.availableAt) })) }, fixturePolicy()), 'QUERY_INPUT_AFTER_KNOWLEDGE_CUTOFF');
refuse(() => readAnalogueQuery({ ...edgeQuery, inputProofs: edgeQuery.inputProofs.slice(0, 2) }, fixturePolicy()), 'QUERY_INPUT_AVAILABILITY_UNPROVEN');

/* Outcomes: available exactly at K(T), missing one millisecond later. */
const outcomeKey = (analogueIdentityId, horizonId) => `${analogueIdentityId}|${horizonId}`;
const firstId = reference.comparisonReport.analogues[0].analogueIdentityId;
const firstHorizon = reference.horizonBindings[0].horizonId;
const atCutoff = runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource({ values: new Map([[outcomeKey(firstId, firstHorizon), 0.12]]), availableAt: session(QUERY_INDEX).closeUtc }) });
const afterCutoff = runFixture({ candidates: referenceCandidates(), outcomeSource: fixtureOutcomeSource({ values: new Map([[outcomeKey(firstId, firstHorizon), 0.12]]), availableAt: plusOneMs(session(QUERY_INDEX).closeUtc) }) });
check(() => assert.deepEqual(atCutoff.outcomeSet.records[0], { analogueIdentityId: firstId, horizonId: firstHorizon, selectionComplete: true, outcomeStatus: 'AVAILABLE', outcomeValue: 0.12, outcomeAvailableAt: session(QUERY_INDEX).closeUtc, sourceBindingId: 'GATE25_FIXTURE_OUTCOME_SOURCE/1' }));
check(() => assert.deepEqual(afterCutoff.outcomeSet.records[0], { analogueIdentityId: firstId, horizonId: firstHorizon, selectionComplete: true, outcomeStatus: 'MISSING', outcomeValue: null, outcomeAvailableAt: null, sourceBindingId: 'GATE25_FIXTURE_OUTCOME_SOURCE/1' }));

/* ------------------------------------------------- T22 historical session semantics */

const built = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder(referenceCandidates()) });
for (const record of built.index.records.values()) {
  const sessionDate = identityMemberValue(record.orderedMembers, 'SessionDate');
  const candidate = referenceCandidates().find((item) => item.sessionDate === sessionDate);
  check(() => assert.equal(identityMemberValue(record.orderedMembers, 'KnowledgeCutoff'), candidate.knowledgeCutoff));
  check(() => assert.notEqual(identityMemberValue(record.orderedMembers, 'KnowledgeCutoff'), fixtureQuery().knowledgeCutoff));
  check(() => assert.equal(identityMemberValue(record.orderedMembers, 'RegimeRecordId'), candidate.regimeRecord.regimeRecordId));
}
const backdatedIndex = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: [fixtureCandidate({ ...perfect, resolvedAsOfSessionDate: session(QUERY_INDEX).sessionDate })] });
check(() => assert.deepEqual(backdatedIndex.accounting, { candidateCount: 1, indexedCount: 0, notFormableCount: 1 }));

/* ------------------------------------------------------- T23 wrong dataset binding */

refuse(() => bindR0003SelectionPolicy({ authority, p3h: { ...p3h, datasetId: `sha256:${'00'.repeat(32)}` }, calendar }), 'DATASET_BINDING_NOT_R0003_SCOPE');
refuse(() => bindR0003SelectionPolicy({ authority, p3h: { ...p3h, datasetSha256: '00'.repeat(32) }, calendar }), 'DATASET_BINDING_NOT_R0003_SCOPE');
refuse(() => bindR0003SelectionPolicy({ authority, p3h: { ...p3h, pinSet: { admittedKeyIds: new Set([...p3h.pinSet.admittedKeyIds].slice(1)), exclusionClassByKeyId: p3h.pinSet.exclusionClassByKeyId } }, calendar }), 'DATASET_BINDING_NOT_R0003_SCOPE');
refuse(() => bindR0003SelectionPolicy({ authority, p3h, calendar: { ...calendar, calendarWindowBindingId: fixtureQuery().featureVectorBinding.calendarWindowBindingIds[0] } }), 'HISTORICAL_CALENDAR_BINDING_NOT_BOUND');
const finalizationBytes = readFileSync(authority.p3hFinalizationPath);
refuse(() => loadP3hDatasetBinding({ authority, finalizationBytes: Buffer.concat([finalizationBytes, Buffer.from('\n')]) }), 'P3H_DATASET_IDENTITY_MISMATCH');
const splitBinding = clone(fixtureCandidate(perfect).featureVectorBinding);
splitBinding.calendarWindowBindingIds = [...splitBinding.calendarWindowBindingIds, 'e'.repeat(64)].sort();
delete splitBinding.featureVectorBindingId;
splitBinding.featureVectorBindingId = sha256Canonical(splitBinding);
refuse(() => decide({ ...fixtureCandidate(perfect), featureVectorBinding: splitBinding }), 'CALENDAR_WINDOW_BINDING_NOT_SINGLE_VALUED');
const tamperedRegime = clone(fixtureCandidate(perfect).regimeRecord);
tamperedRegime.identity.ParameterSetId = 'a'.repeat(64);
refuse(() => decide({ ...fixtureCandidate(perfect), regimeRecord: tamperedRegime }), 'REGIME_RECORD_IDENTITY_MISMATCH');
const relabelledRegime = clone(fixtureCandidate(perfect).regimeRecord);
relabelledRegime.regimeVector.primaryMarketRegime = 'BULLISH';
refuse(() => decide({ ...fixtureCandidate(perfect), regimeRecord: relabelledRegime }), 'REGIME_VECTOR_VALUE_OUT_OF_TAXONOMY');
refuse(() => decide({ ...fixtureCandidate(perfect), regimeRecord: fixtureCandidate({ index: 151, w5: 0.02, w21: 0.10 }).regimeRecord }), 'REGIME_RECORD_SESSION_BINDING_MISMATCH');

/* ------------------------------------------------------------ outcome leakage (V-2, V-3) */

refuse(() => decide({ ...fixtureCandidate(perfect), OutcomeId: 'o-1' }), 'CANDIDATE_INPUT_NOT_CLOSED');
refuse(() => decide({ ...fixtureCandidate(perfect), forwardReturn30: 0.4 }), 'CANDIDATE_INPUT_NOT_CLOSED');
refuse(() => decide(withFeature('F1_SIMPLE_RETURN@W30_FORWARD', { featureRecordId: null, status: 'RESOLVED', code: null, value: 0.4 })), 'DISTANCE_FEATURES_NOT_CLOSED');
const regimeWithOutcome = { ...clone(fixtureCandidate(perfect).regimeRecord), OutcomeStatus: 'RESOLVED' };
refuse(() => decide({ ...fixtureCandidate(perfect), regimeRecord: regimeWithOutcome }), 'REGIME_RECORD_NOT_CLOSED');
refuse(() => readAnalogueQuery({ ...fixtureQuery(), HorizonId: '30:x' }, fixturePolicy()), 'QUERY_INPUT_NOT_CLOSED');
refuse(() => decide({ ...fixtureCandidate(perfect), inputProofs: [...fixtureCandidate(perfect).inputProofs.map((proof) => ({ ...proof, outcomeValue: 1 }))] }), 'INPUT_PROOF_NOT_CLOSED');

const horizonBindings = admissibleHorizonBindings({ horizonContract: authority.horizonContract, calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID });
const openSelection = { queryIdentityId: reference.queryIdentity.analogueIdentityId, analogues: [], selectionComplete: false, selectionDigest: 'x' };
refuse(() => attachPostSelectionOutcomes({ frozenSelection: openSelection, horizonBindings, outcomeSource: fixtureOutcomeSource(), queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'OUTCOME_ATTACHMENT_BEFORE_SELECTION_COMPLETE');
refuse(() => attachPostSelectionOutcomes({ frozenSelection: { ...reference.frozenSelection }, horizonBindings, outcomeSource: fixtureOutcomeSource(), queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'SELECTION_NOT_FROZEN');
const forgedDigest = Object.freeze({ ...reference.frozenSelection, selectionDigest: '0'.repeat(64) });
refuse(() => attachPostSelectionOutcomes({ frozenSelection: forgedDigest, horizonBindings, outcomeSource: fixtureOutcomeSource(), queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'SELECTION_DIGEST_MISMATCH');
refuse(() => attachPostSelectionOutcomes({ frozenSelection: reference.frozenSelection, horizonBindings, outcomeSource: null, queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'OUTCOME_SOURCE_REQUIRED');
const malformedSource = { sourceBindingId: 'S', lookup: () => ({ outcomeValue: 'high', outcomeAvailableAt: session(0).closeUtc }) };
refuse(() => attachPostSelectionOutcomes({ frozenSelection: reference.frozenSelection, horizonBindings, outcomeSource: malformedSource, queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'OUTCOME_SOURCE_VALUE_MALFORMED');
const probabilitySource = { sourceBindingId: 'S', lookup: () => ({ outcomeValue: 0.1, outcomeAvailableAt: session(0).closeUtc, probability: 0.7 }) };
refuse(() => attachPostSelectionOutcomes({ frozenSelection: reference.frozenSelection, horizonBindings, outcomeSource: probabilitySource, queryKnowledgeCutoff: fixtureQuery().knowledgeCutoff }), 'OUTCOME_SOURCE_RECORD_NOT_CLOSED');
check(() => assert.throws(() => { reference.frozenSelection.analogues.pop(); }, TypeError));
check(() => assert.throws(() => { reference.frozenSelection.analogues[0].finalDistance = 99; }, TypeError));
const subsetContract = clone(authority.horizonContract);
subsetContract.mandateProjection.sessionCountingRules.horizonsV1 = [30, 90];
refuse(() => admissibleHorizonBindings({ horizonContract: subsetContract, calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID }), 'HORIZON_CONTRACT_DIVERGES_FROM_GATE22_IMPLEMENTATION');
const inventedContract = clone(authority.horizonContract);
inventedContract.mandateProjection.sessionCountingRules.horizonsV1 = [30, 90, 180, 252, 504];
refuse(() => admissibleHorizonBindings({ horizonContract: inventedContract, calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID }), 'HORIZON_CONTRACT_DIVERGES_FROM_GATE22_IMPLEMENTATION');

/* ------------------------------------------------------------- distance hostiles */

for (const key of ['weights', 'epsilon', 'tolerance', 'rounding', 'threshold', 'k']) {
  refuse(() => assertDistanceParameterRequest({ [key]: 1 }), 'DISTANCE_PARAMETER_FORBIDDEN');
}
refuse(() => assertDistanceParameterRequest({ distanceFeatureIds: [W5, W21, 'F2_REALIZED_VOLATILITY@W21'] }), 'DISTANCE_FEATURE_SET_NOT_OD2');
refuse(() => assertDistanceParameterRequest({ distanceFeatureIds: [W21, W5] }), 'DISTANCE_FEATURE_SET_NOT_OD2');
check(() => assert.equal(assertDistanceParameterRequest({ distanceFeatureIds: [W5, W21] }), true));
refuse(() => computeNormalizationBounds([]), 'NORMALIZATION_POPULATION_EMPTY');
const overflowBounds = computeNormalizationBounds([{ [W5]: -1e308, [W21]: 0 }, { [W5]: 1e308, [W21]: 1 }]);
refuse(() => computeDistanceEvidence({ queryFeatureValues: { [W5]: 0, [W21]: 0 }, candidateFeatureValues: { [W5]: 1, [W21]: 1 }, bounds: overflowBounds }), 'NORMALIZED_VALUE_NOT_FINITE');
refuse(() => computeDistanceEvidence({ queryFeatureValues: { [W5]: 0, [W21]: 0 }, candidateFeatureValues: { [W5]: 1, [W21]: 1 }, bounds: [...reference.normalizationBounds].reverse() }), 'NORMALIZATION_BOUNDS_ORDER_INVALID');

/* ------------------------------------------------- index, support, provenance hostiles */

const indexText = serializeAnalogueIndex(built.index);
const someRecord = [...built.index.records.values()][0];
refuse(() => appendIndexRecord(built.index, { ...clone(someRecord), p3hKeyId: KEY_B }), 'INDEX_DIVERGENT_REPLACEMENT_REFUSED');
check(() => assert.equal(appendIndexRecord(built.index, clone(someRecord)), built.index));
refuse(() => parseAnalogueIndex(JSON.stringify(JSON.parse(indexText), null, 2)), 'ANALOGUE_INDEX_NOT_CANONICAL');
const reordered = JSON.parse(indexText);
reordered.records.reverse();
refuse(() => parseAnalogueIndex(JSON.stringify(reordered)), 'ANALOGUE_INDEX_STORAGE_ORDER_INVALID');
const miscounted = JSON.parse(indexText);
miscounted.recordCount += 1;
refuse(() => parseAnalogueIndex(JSON.stringify(miscounted)), 'ANALOGUE_INDEX_RECORD_COUNT_MISMATCH');
refuse(() => mergeAnalogueIndexBytes({ existingText: indexText, index: createAnalogueIndex({ datasetId: FIXTURE_DATASET_ID, selectionPolicyVersionId: 'b'.repeat(64) }) }), 'ANALOGUE_INDEX_BINDING_CHANGE_REFUSED');
const partialIndex = appendIndexRecord(createAnalogueIndex({ datasetId: FIXTURE_DATASET_ID, selectionPolicyVersionId: fixturePolicy().selectionPolicyVersionId }), someRecord);
refuse(() => runAnalogueSelection({ authority, policy: fixturePolicy(), query: fixtureQuery(), candidates: canonicalOrder(referenceCandidates()), outcomeSource: fixtureOutcomeSource(), analogueIndex: partialIndex }), 'SELECTED_ANALOGUE_NOT_IN_INDEX');

refuse(() => resolveSupport({ eligibleCount: 2, structuralGatesPass: false }), 'SUFFICIENT_SUPPORT_WITH_STRUCTURAL_GATES_FAILED_REFUSED');
refuse(() => buildSupportReport({ ...reference.supportReport, universeCount: reference.supportReport.universeCount + 1 }), 'SUPPORT_UNIVERSE_ARITHMETIC_INCONSISTENT');
refuse(() => buildSupportReport({ ...reference.supportReport, exclusionCountsByReason: [...reference.supportReport.exclusionCountsByReason].reverse() }), 'EXCLUSION_COUNTS_ORDER_INVALID');
refuse(() => assertNoForbiddenReportField({ analogues: [{ confidence: 0.9 }] }), 'REPORT_FORBIDDEN_FIELD');
refuse(() => assertNoForbiddenReportField({ narrative: 'looks bullish' }), 'REPORT_FORBIDDEN_FIELD');
refuse(() => buildComparisonReport({
  queryIdentityId: reference.queryIdentity.analogueIdentityId, datasetId: FIXTURE_DATASET_ID, selectionPolicyVersionId: fixturePolicy().selectionPolicyVersionId,
  knowledgeCutoff: fixtureQuery().knowledgeCutoff, supportReport: reference.supportReport, rankedAnalogues: reference.comparisonReport.analogues.slice(0, 3),
}), 'ANALOGUE_SET_TRUNCATED_OR_EXPANDED');

const provenance = buildSelectionProvenance({ selection: reference, policy: fixturePolicy(), indexText });
check(() => assert.equal(verifyProvenanceIndexBinding({ provenanceText: provenance.text, indexText }).manifest.analogueIndexSha256, provenance.manifest.analogueIndexSha256));
const lateInputProof = buildInputProof({ inputId: 'QUERY:late', sourceArtifactId: 'x', sourceArtifactSha256: 'a'.repeat(64), availableAt: plusOneMs(fixtureQuery().knowledgeCutoff), knowledgeCutoff: fixtureQuery().knowledgeCutoff });
check(() => assert.equal(lateInputProof.availableByCutoff, false));
refuse(() => buildProvenanceManifest({ ...provenance.manifest, inputProofs: [...provenance.manifest.inputProofs, lateInputProof] }), 'INPUT_NOT_AVAILABLE_BY_CUTOFF');
refuse(() => buildProvenanceManifest({ ...provenance.manifest, inputProofs: [...provenance.manifest.inputProofs, { ...lateInputProof, availableByCutoff: true }] }), 'PROVENANCE_AVAILABLE_BY_CUTOFF_NOT_RECOMPUTED');
refuse(() => buildProvenanceManifest({ ...provenance.manifest, supportReportId: null }), 'PROVENANCE_REQUIRED_FIELD_ABSENT');
const extendedIndex = serializeAnalogueIndex(buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder([...referenceCandidates(), fixtureCandidate({ index: 120, w5: 0.03, w21: 0.07 })]) }).index);
refuse(() => verifyProvenanceIndexBinding({ provenanceText: provenance.text, indexText: extendedIndex }), 'PROVENANCE_INDEX_SHA256_MISMATCH');
const memoryStore = (seed = {}) => {
  const files = new Map(Object.entries(seed));
  return { files, read: (path) => files.get(path) ?? null, write: (path, text) => files.set(path, text) };
};
const store = memoryStore();
materializeCanonicalProducts({ store, index: built.index, selection: reference, policy: fixturePolicy() });
refuse(() => materializeCanonicalProducts({ store, index: built.index, selection: runFixture({ candidates: referenceCandidates().slice(0, 4) }), policy: fixturePolicy() }), 'PROVENANCE_DIVERGENT_REPLACEMENT_REFUSED');

const orderedTwo = canonicalOrder(referenceCandidates().slice(0, 2));
refuse(() => runAnalogueSelection({ authority, policy: fixturePolicy(), query: fixtureQuery(), candidates: [orderedTwo[1], orderedTwo[0]], outcomeSource: fixtureOutcomeSource() }), 'CANDIDATE_ORDER_NOT_CANONICAL_OR_DUPLICATE');
refuse(() => runAnalogueSelection({ authority, policy: fixturePolicy(), query: fixtureQuery(), candidates: [orderedTwo[0], orderedTwo[0]], outcomeSource: fixtureOutcomeSource() }), 'CANDIDATE_ORDER_NOT_CANONICAL_OR_DUPLICATE');

/* ------------------------------------------------- T24 no network, provider or model */

const MODULES = [
  'analogue-identity-v1.mjs', 'analogue-eligibility-v1.mjs', 'analogue-distance-v1.mjs', 'analogue-index-v1.mjs',
  'analogue-report-v1.mjs', 'analogue-outcome-v1.mjs', 'analogue-provenance-v1.mjs', 'historical-analogue-engine-v1.mjs',
].map((name) => resolve(ROOT, 'governance/gates/GATE25/implementation', name));
/* Network-capable or process-spawning builtins; any non-builtin package is refused outright. */
const NETWORK_CAPABLE_BUILTINS = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process', 'cluster', 'worker_threads', 'inspector']);
const bareSpecifiers = new Set();
const visited = new Set();
const pending = [...MODULES];
while (pending.length > 0) {
  const file = pending.pop();
  if (visited.has(file)) continue;
  visited.add(file);
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
    else bareSpecifiers.add(specifier);
  }
  /* JSDoc type annotations such as {import('./x.mjs').T} are comments, not runtime loads. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
  check(() => assert.doesNotMatch(code, /\bimport\s*\(|\brequire\s*\(/, file));
}
check(() => assert.ok(visited.size > MODULES.length));
check(() => assert.deepEqual([...bareSpecifiers].filter((specifier) => !specifier.startsWith('node:')), []));
check(() => assert.deepEqual([...bareSpecifiers].filter((specifier) => NETWORK_CAPABLE_BUILTINS.has(specifier.slice(5).split('/')[0])), []));
for (const file of MODULES) {
  const source = readFileSync(file, 'utf8');
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /Math\.random/, /Date\.now\s*\(/, /new\s+Date\(\s*\)/, /performance\.now/, /process\.hrtime/, /yahoo-finance2/, /\bopenai\b/i, /\bollama\b/i]) {
    check(() => assert.doesNotMatch(source, pattern, `${file} ${pattern}`));
  }
}

const networkCalls = [];
const trap = (name) => (...args) => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
const originals = [];
const patch = (target, key, name) => { originals.push([target, key, target[key]]); target[key] = trap(name); };
patch(globalThis, 'fetch', 'fetch');
patch(http, 'request', 'http.request');
patch(http, 'get', 'http.get');
patch(https, 'request', 'https.request');
patch(https, 'get', 'https.get');
patch(net, 'connect', 'net.connect');
patch(net, 'createConnection', 'net.createConnection');
patch(tls, 'connect', 'tls.connect');
patch(dns, 'lookup', 'dns.lookup');
patch(dgram, 'createSocket', 'dgram.createSocket');
syncBuiltinESMExports();
try {
  const guarded = runFixture({ candidates: [...referenceCandidates(), fixtureCandidate({ ...perfect, keyId: KEY_X_MALFORMED })] });
  const guardedIndex = buildAnalogueIndexFromCandidates({ policy: fixturePolicy(), candidates: canonicalOrder(referenceCandidates()) });
  const guardedProducts = materializeCanonicalProducts({ store: memoryStore(), index: guardedIndex.index, selection: guarded, policy: fixturePolicy() });
  check(() => assert.equal(guarded.supportReport.decision, 'PROCEED'));
  check(() => assert.match(guardedProducts.analogueIndexSha256, /^[0-9a-f]{64}$/));
  loadP3hDatasetBinding({ authority });
} finally {
  for (const [target, key, value] of originals.reverse()) target[key] = value;
  syncBuiltinESMExports();
}
check(() => assert.deepEqual(networkCalls, []));

/* ------------------------------------------------- B-2 missingness is never a positive CORE_V1 match */

const missingInflationQuery = fixtureQuery({ vintageStore: EMPTY_MACRO_VINTAGE_STORE });
const missingInflationCandidate = fixtureCandidate({ ...perfect, vintageStore: EMPTY_MACRO_VINTAGE_STORE });
check(() => assert.equal(missingInflationQuery.regimeRecord.regimeVector.inflationState, 'INFLATION_INSUFFICIENT_DATA'));
check(() => assert.equal(missingInflationCandidate.regimeRecord.regimeVector.inflationState, 'INFLATION_INSUFFICIENT_DATA'));
check(() => assert.ok(decide(missingInflationCandidate, { query: missingInflationQuery }).includes('CORE_V1_REGIME_MISMATCH')));
const inflationEvidence = evaluateCoreV1ExactMatch({
  queryRegime: readAnalogueQuery(missingInflationQuery, fixturePolicy()).regime,
  candidateRegime: readHistoricalCandidate(missingInflationCandidate, fixturePolicy()).regime,
}).evidence.find((item) => item.dimension === 'inflationState');
check(() => assert.deepEqual(inflationEvidence, {
  dimension: 'inflationState',
  queryClassifying: false,
  candidateClassifying: false,
  queryValue: 'INFLATION_INSUFFICIENT_DATA',
  candidateValue: 'INFLATION_INSUFFICIENT_DATA',
}));
check(() => assert.equal(evaluateCoreV1ExactMatch({
  queryRegime: readAnalogueQuery(missingInflationQuery, fixturePolicy()).regime,
  candidateRegime: readHistoricalCandidate(missingInflationCandidate, fixturePolicy()).regime,
}).match, false));

const notAvailableQuery = fixtureQuery({ vintageStore: NOT_AVAILABLE_CURVE_VINTAGE_STORE });
const notAvailableCandidate = fixtureCandidate({ ...perfect, vintageStore: NOT_AVAILABLE_CURVE_VINTAGE_STORE });
const notAvailableMatch = evaluateCoreV1ExactMatch({
  queryRegime: readAnalogueQuery(notAvailableQuery, fixturePolicy()).regime,
  candidateRegime: readHistoricalCandidate(notAvailableCandidate, fixturePolicy()).regime,
});
check(() => assert.equal(notAvailableMatch.match, false));
check(() => assert.ok(decide(notAvailableCandidate, { query: notAvailableQuery }).includes('CORE_V1_REGIME_MISMATCH')));
const notAvailableEvidence = notAvailableMatch.evidence.find((item) => item.dimension === 'yieldCurveShape');
check(() => assert.equal(notAvailableEvidence.queryClassifying, false));
check(() => assert.equal(notAvailableEvidence.candidateClassifying, false));
check(() => assert.equal(notAvailableEvidence.queryValue, notAvailableEvidence.candidateValue));
check(() => assert.ok(notAvailableEvidence.queryValue === 'UNKNOWN' || notAvailableEvidence.queryValue === 'INSUFFICIENT_DATA' || notAvailableEvidence.queryValue === 'NOT_AVAILABLE'));

const oneNonClassifying = fixtureCandidate({ ...perfect, volatility: null });
check(() => assert.ok(decide(oneNonClassifying).includes('CORE_V1_REGIME_MISMATCH')));
check(() => assert.ok(decide(oneNonClassifying).includes('VOLATILITY_STATE_UNAVAILABLE')));
const oneEvidence = evaluateCoreV1ExactMatch({
  queryRegime: readAnalogueQuery(fixtureQuery(), fixturePolicy()).regime,
  candidateRegime: readHistoricalCandidate(oneNonClassifying, fixturePolicy()).regime,
}).evidence.find((item) => item.dimension === 'volatilityState');
check(() => assert.equal(oneEvidence.queryClassifying, true));
check(() => assert.equal(oneEvidence.candidateClassifying, false));

const missingQueryRun = runFixture({
  candidates: [missingInflationCandidate, fixtureCandidate({ index: 151, w5: 0.02, w21: 0.10, vintageStore: EMPTY_MACRO_VINTAGE_STORE })],
  query: missingInflationQuery,
});
check(() => assert.equal(missingQueryRun.supportReport.structuralGatesPass, false));
check(() => assert.equal(missingQueryRun.supportReport.decision, 'ABSTAIN'));
check(() => assert.equal(missingQueryRun.supportReport.eligibleCount, 0));
check(() => assert.equal(missingQueryRun.supportReport.abstainReason, 'INSUFFICIENT_SUPPORT'));

const allSixClassifyingQuery = readAnalogueQuery(fixtureQuery(), fixturePolicy());
check(() => assert.equal(allSixClassifyingQuery.allCoreV1Classifying, true));
check(() => assert.equal(allSixClassifyingQuery.structuralGatesPass, true));
check(() => assert.ok(CORE_V1_DIMENSIONS_V1.every((dimension) => allSixClassifyingQuery.regime.coreV1Classifying[dimension])));
check(() => assert.deepEqual(decide(fixtureCandidate(perfect)), []));
check(() => assert.equal(CLASSIFYING_MACRO_VINTAGE_STORE !== EMPTY_MACRO_VINTAGE_STORE, true));

console.log(`GATE25_HOSTILES_PASS ${assertions}`);
