/**
 * GATE23 hostile matrix: H01-H34 and H36-H43. H35 is START_LIFECYCLE and is out of
 * BUILD scope by the frozen mandate, so it is declared excluded rather than faked.
 *
 * H26 is the only place in GATE23 that names marketSession.mjs::sessionCloseUtc: it
 * imports the forbidden primitive purely as a negative control, to prove that K(T)
 * is not equal to it for a half-day session.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sessionCloseUtc } from '../../../../research/directional-lab/src/time/marketSession.mjs';
import {
  createFeatureRecordId,
  FEATURE_RECORD_ID_MEMBERS_V1,
} from '../implementation/feature-identity-v1.mjs';
import {
  refuseOutcomeAsFeature,
  admitObservationInput,
  authorizeGate23FeatureConsumption,
  T_CAUSAL_CLAIMS_V1,
  OUTCOME_PROHIBITION_MODES_V1,
} from '../implementation/causal-admission-v1.mjs';
import {
  createFeatureWindowSpec,
  createCalendarWindowBinding,
  resolvePinnedCanonicalSession,
  resolveTrailingWindow,
  assertNoFutureWindowAccess,
  calendarDaySpan,
  refuseWallClockCutoff,
} from '../implementation/feature-window-v1.mjs';
import {
  declareFeatureVector,
  resolveVectorStatus,
  requestCrossSectional,
  memberKey,
} from '../implementation/feature-families-v1.mjs';
import {
  materializeFeatureRecords,
  assertSplitRatioAdmissible,
} from '../implementation/feature-materializer-v1.mjs';
import { createFeatureStore, appendFeatureRecord } from '../implementation/feature-store-v1.mjs';
import {
  SESSION_UNIVERSE,
  CALENDAR_WINDOW_BINDING,
  REGULAR_ONLY_BINDING,
  REGULAR_ANCHOR,
  HALF_DAY_ANCHOR,
  CALENDAR_AUTHORITY_POLICY_ID,
  CALENDAR_REGISTRY_MANIFEST_ID,
  CALENDAR_NAMESPACE_VERSION,
  withDuplicateSession,
  withCorruptedClose,
  withMarketValidTimeDrift,
} from '../fixtures/calendar-window-fixture.mjs';
import {
  materializeFixture,
  buildFixtureInput,
  withPriceBasis,
  withMixedPriceBasis,
  withImplicitDividendTotalReturn,
  withFutureBar,
  withFutureAvailableAt,
  withMissingClose,
  withMissingVolume,
  withoutBar,
  withSplitRatio,
  DATASET_ID_OBSERVATION,
} from '../fixtures/causal-window-fixture.mjs';
import {
  LEAKAGE_MODE_CASES,
  TAXONOMY_PRIMITIVE_AS_FEATURE,
  FUTURE_PROVENANCE_OBSERVATION,
  UNTRUSTED_PRODUCER_OBSERVATION,
  CLEAN_OBSERVATION,
  FORBIDDEN_FEATURE_NAMES,
  ALLOWED_FEATURE_NAMES,
  KNOWLEDGE_CUTOFF,
} from '../fixtures/outcome-leakage-fixture.mjs';
import { NEW_DATASET_RESTATEMENT, SAME_DATASET_RESTATEMENT } from '../fixtures/provenance-drift-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const results = [];
let assertions = 0;

const assertEq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions += 1; };
const assertOk = (value, message) => { assert.ok(value, message); assertions += 1; };
const assertThrows = (fn, pattern) => { assert.throws(fn, pattern); assertions += 1; };

function hostile(id, name, fn) {
  const proof = fn();
  results.push({ id, name, verdict: proof.verdict, proof: proof.proof });
}

const BASE = materializeFixture();
const BASE_BY_KEY = new Map(BASE.records.map((record) => [memberKey(record), record]));
const identity = {
  InstrumentIdentityId: 'iid-1',
  SessionDate: '2025-03-19',
  KnowledgeCutoff: '2025-03-19T21:00:00.000Z',
  FeatureDefinitionId: 'F1_SIMPLE_RETURN',
  FormulaId: 'GATE23_SIMPLE_RETURN/1',
  FeatureWindowSpecId: 'fws-1',
  CalendarWindowBindingId: 'cwb-1',
  SourceBindingId: 'GATE21_BINDING_V1',
  DatasetId_observation: 'obs-1',
  PriceBasisId: 'SPLIT_ADJUSTED',
  MissingnessStateId: 'GATE23_MissingnessState/1:COMPLETE',
};
const without = (member) => Object.fromEntries(Object.entries(identity).filter(([key]) => key !== member));

/* ---------- Identity closure: H01-H07 ---------- */

hostile('H01', 'FeatureRecordId with ten members', () => {
  assertThrows(() => createFeatureRecordId(without('MissingnessStateId')), /FEATURE_RECORD_ID_EXACT_ONLY/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_EXACT_ONLY' };
});

hostile('H02', 'FeatureRecordId with a twelfth neutral member', () => {
  assertThrows(() => createFeatureRecordId({ ...identity, VenueId: 'XNAS' }), /FEATURE_RECORD_ID_EXACT_ONLY/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_EXACT_ONLY' };
});

hostile('H03', 'FeatureRecordId carrying ticker instead of InstrumentIdentityId', () => {
  assertThrows(() => createFeatureRecordId({ ...without('InstrumentIdentityId'), ticker: 'ACME' }), /FEATURE_RECORD_ID_FORBIDDEN_MEMBER/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_FORBIDDEN_MEMBER' };
});

hostile('H04', 'FeatureRecordId carrying an Outcome member', () => {
  assertThrows(() => createFeatureRecordId({ ...identity, OutcomeId: 'o-1' }), /FEATURE_RECORD_ID_FORBIDDEN_MEMBER/);
  assertThrows(() => createFeatureRecordId({ ...identity, HorizonId: 'h-1' }), /FEATURE_RECORD_ID_FORBIDDEN_MEMBER/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_FORBIDDEN_MEMBER' };
});

hostile('H05', 'FeatureRecordId with an empty member value', () => {
  assertThrows(() => createFeatureRecordId({ ...identity, SourceBindingId: '' }), /FEATURE_RECORD_ID_MEMBER_INVALID/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_MEMBER_INVALID' };
});

hostile('H06', 'FeatureRecordId with a non-string member', () => {
  assertThrows(() => createFeatureRecordId({ ...identity, SessionDate: 20250319 }), /FEATURE_RECORD_ID_MEMBER_INVALID/);
  assertThrows(() => createFeatureRecordId(null), /FEATURE_RECORD_ID_EXACT_ONLY/);
  return { verdict: 'REFUSED', proof: 'FEATURE_RECORD_ID_MEMBER_INVALID' };
});

hostile('H07', 'identity answers may not enter the digest', () => {
  assertThrows(() => createFeatureRecordId({ ...identity, value: '0.1' }), /FEATURE_RECORD_ID_FORBIDDEN_MEMBER/);
  assertThrows(() => createFeatureRecordId({ ...identity, vectorStatus: 'RESOLVED' }), /FEATURE_RECORD_ID_FORBIDDEN_MEMBER/);
  assertEq(FEATURE_RECORD_ID_MEMBERS_V1.length, 11);
  return { verdict: 'REFUSED', proof: 'QUESTION_NOT_ANSWER' };
});

/* ---------- Outcome prohibition and T-CAUSAL-A: H08-H16 ---------- */

for (const [index, testCase] of LEAKAGE_MODE_CASES.entries()) {
  hostile(`H${String(8 + index).padStart(2, '0')}`, `Outcome as a GATE23 feature, mode ${testCase.mode}`, () => {
    const decision = refuseOutcomeAsFeature(testCase.candidate);
    assertEq(decision.status, 'BLOCKED');
    assertEq(decision.code, testCase.code);
    assertEq(decision.mode, testCase.mode);
    return { verdict: 'BLOCKED', proof: testCase.code };
  });
}

hostile('H12', 'GATE22 taxonomy primitive presented as a GATE23 feature', () => {
  const decision = refuseOutcomeAsFeature(TAXONOMY_PRIMITIVE_AS_FEATURE);
  assertEq(decision.status, 'BLOCKED');
  assertEq(decision.code, 'OUTCOME_DIRECT_FORBIDDEN');
  return { verdict: 'BLOCKED', proof: 'OUTCOME_DIRECT_FORBIDDEN' };
});

hostile('H13', 'observation visible only after K(T)', () => {
  const decision = admitObservationInput({ input: FUTURE_PROVENANCE_OBSERVATION, knowledgeCutoff: KNOWLEDGE_CUTOFF });
  assertEq(decision.status, 'BLOCKED');
  assertEq(decision.code, 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN');
  const missingCutoff = admitObservationInput({ input: CLEAN_OBSERVATION, knowledgeCutoff: null });
  assertEq(missingCutoff.code, 'KNOWLEDGE_CUTOFF_REQUIRED');
  return { verdict: 'BLOCKED', proof: 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN' };
});

hostile('H14', 'untrusted producer outside TRUSTED_CANONICAL_PRODUCER_V1', () => {
  const decision = admitObservationInput({ input: UNTRUSTED_PRODUCER_OBSERVATION, knowledgeCutoff: KNOWLEDGE_CUTOFF });
  assertEq(decision.status, 'BLOCKED');
  assertEq(decision.code, 'UNTRUSTED_PRODUCER_FORBIDDEN');
  assertEq(admitObservationInput({ input: CLEAN_OBSERVATION, knowledgeCutoff: KNOWLEDGE_CUTOFF }).status, 'ALLOWED');
  return { verdict: 'BLOCKED', proof: 'UNTRUSTED_PRODUCER_FORBIDDEN' };
});

hostile('H15', 'a third T-CAUSAL claim is asserted', () => {
  assertEq(T_CAUSAL_CLAIMS_V1.length, 2);
  assertEq(OUTCOME_PROHIBITION_MODES_V1.length, 4);
  assertOk(Object.isFrozen(T_CAUSAL_CLAIMS_V1));
  assertThrows(() => { T_CAUSAL_CLAIMS_V1.push('NO_LOOKAHEAD_BIAS'); }, /TypeError/);
  return { verdict: 'REFUSED', proof: 'EXACT_TWO_CLAIMS_NO_THIRD' };
});

hostile('H16', 'Outcome-shaped feature names offered at the consumption boundary', () => {
  for (const name of FORBIDDEN_FEATURE_NAMES) {
    assertEq(authorizeGate23FeatureConsumption([name]).status, 'BLOCKED', name);
  }
  assertEq(authorizeGate23FeatureConsumption([...ALLOWED_FEATURE_NAMES]).status, 'ALLOWED');
  return { verdict: 'BLOCKED', proof: 'GATE23_OUTCOME_FEATURE_FORBIDDEN' };
});

/* ---------- Window ladder and units, OD-1: H17-H23 ---------- */

hostile('H17', 'a window outside the admissible ladder', () => {
  for (const sessionCount of [1, 10, 20, 22, 200, 253]) {
    assertThrows(() => createFeatureWindowSpec({ sessionCount, calendarWindowBinding: CALENDAR_WINDOW_BINDING }), /FEATURE_WINDOW_NOT_ADMITTED/);
  }
  return { verdict: 'REFUSED', proof: 'FEATURE_WINDOW_NOT_ADMITTED' };
});

hostile('H18', 'a degenerate or non-integer window', () => {
  for (const sessionCount of [0, -5, 5.5, '5', null, undefined, NaN]) {
    assertThrows(() => createFeatureWindowSpec({ sessionCount, calendarWindowBinding: CALENDAR_WINDOW_BINDING }), /FEATURE_WINDOW_NOT_ADMITTED/);
  }
  return { verdict: 'REFUSED', proof: 'FEATURE_WINDOW_NOT_ADMITTED' };
});

hostile('H19', 'families crossed with the ladder as a cartesian expansion', () => {
  const request = { featureDefinitionIds: ['F1_SIMPLE_RETURN'], sessionCounts: [5, 21, 63, 126, 252] };
  assertEq(refuseWallClockCutoff('PINNED_CANONICAL_SESSION_CLOSE_UTC').status, 'ALLOWED');
  assertThrows(() => declareFeatureVector(request), /CARTESIAN_EXPANSION_FORBIDDEN/);
  return { verdict: 'BLOCKED', proof: 'CARTESIAN_EXPANSION_FORBIDDEN' };
});

hostile('H20', 'a vector declared without the core feature set', () => {
  assertThrows(() => declareFeatureVector([{ featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 63 }]), /CORE_FEATURE_SET_INCOMPLETE/);
  assertThrows(() => declareFeatureVector([{ featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 }]), /CORE_FEATURE_SET_INCOMPLETE/);
  assertThrows(() => declareFeatureVector([]), /FEATURE_VECTOR_EMPTY/);
  return { verdict: 'REFUSED', proof: 'CORE_FEATURE_SET_INCOMPLETE' };
});

hostile('H21', 'a vector declaring the same member twice', () => {
  assertThrows(() => declareFeatureVector([
    { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 },
    { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21 },
    { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 },
  ]), /FEATURE_VECTOR_DUPLICATE_MEMBER/);
  return { verdict: 'REFUSED', proof: 'FEATURE_VECTOR_DUPLICATE_MEMBER' };
});

hostile('H22', 'window units read as distinct calendar days', () => {
  const spec = createFeatureWindowSpec({ sessionCount: 5, calendarWindowBinding: CALENDAR_WINDOW_BINDING });
  const window = resolveTrailingWindow({
    sessionDate: REGULAR_ANCHOR.sessionDate, featureWindowSpec: spec, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  assertEq(window.status, 'RESOLVED');
  assertEq(window.sessions.length, 6);
  assertOk(calendarDaySpan(window.sessions) > window.sessions.length);
  assertEq(window.unit, 'CANONICAL_DAILY_TRADING_SESSION');
  return { verdict: 'INVARIANT_HELD', proof: `calendarDaySpan=${calendarDaySpan(window.sessions)} > sessions=${window.sessions.length}` };
});

hostile('H23', 'a window reaching past T', () => {
  const spec = createFeatureWindowSpec({ sessionCount: 5, calendarWindowBinding: CALENDAR_WINDOW_BINDING });
  const window = resolveTrailingWindow({
    sessionDate: REGULAR_ANCHOR.sessionDate, featureWindowSpec: spec, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  const future = [...window.sessions, { sessionDate: '2099-01-04' }];
  assertEq(assertNoFutureWindowAccess({ sessionDate: REGULAR_ANCHOR.sessionDate, window: future }).code, 'FUTURE_WINDOW_ACCESS_FORBIDDEN');
  assertEq(assertNoFutureWindowAccess({ sessionDate: REGULAR_ANCHOR.sessionDate, window: window.sessions.slice(0, 3) }).code, 'WINDOW_NOT_ANCHORED_AT_T');
  assertEq(materializeFeatureRecords(withFutureBar()).code, 'FUTURE_WINDOW_ACCESS_FORBIDDEN');
  assertEq(materializeFeatureRecords(withFutureAvailableAt()).records[0].code, 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN');
  return { verdict: 'BLOCKED', proof: 'FUTURE_WINDOW_ACCESS_FORBIDDEN' };
});

/* ---------- KnowledgeCutoff, OD-5: H24-H29 ---------- */

hostile('H24', 'K(T) drifting from the regular canonical session close', () => {
  const pinned = resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  assertEq(pinned.knowledgeCutoff, REGULAR_ANCHOR.closeUtc);
  assertEq(pinned.knowledgeCutoff, REGULAR_ANCHOR.marketValidTime);
  assertEq(pinned.knowledgeCutoffBoundary, 'PINNED_CANONICAL_SESSION_CLOSE_UTC');
  return { verdict: 'INVARIANT_HELD', proof: 'K_EQUALS_REGULAR_SESSION_CLOSE_UTC' };
});

hostile('H25', 'a half-day session forced onto the regular close', () => {
  const half = resolvePinnedCanonicalSession({
    sessionDate: HALF_DAY_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  assertEq(half.knowledgeCutoff, HALF_DAY_ANCHOR.closeUtc);
  assertEq(half.sessionKind, 'HALF_DAY_SESSION');
  assert.notEqual(half.knowledgeCutoff.slice(10), REGULAR_ANCHOR.closeUtc.slice(10));
  assertions += 1;
  return { verdict: 'INVARIANT_HELD', proof: 'HALF_DAY_USES_ITS_OWN_CLOSE_UTC' };
});

hostile('H26', 'K(T) derived from marketSession.mjs::sessionCloseUtc', () => {
  const half = resolvePinnedCanonicalSession({
    sessionDate: HALF_DAY_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  assert.notEqual(half.knowledgeCutoff, sessionCloseUtc(HALF_DAY_ANCHOR.sessionDate));
  assertions += 1;
  const implementationDir = path.join(REPO_ROOT, 'governance/gates/GATE23/implementation');
  const fixtureDir = path.join(REPO_ROOT, 'governance/gates/GATE23/fixtures');
  for (const dir of [implementationDir, fixtureDir]) {
    for (const file of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      assertOk(!/from\s+'[^']*marketSession/.test(source), `${file} imports marketSession`);
      assertOk(!/\bsessionCloseUtc\s*\(/.test(source), `${file} calls sessionCloseUtc`);
      // The forbidden-constant list is a declaration of the prohibition, not a use of it.
      const scrubbed = source.replace(/FORBIDDEN_WALL_CLOCK_CONSTANTS = Object\.freeze\(\[[^\]]*\]\)/, '');
      assertOk(!/['"]\d{2}:\d{2}['"]/.test(scrubbed), `${file} carries a bare wall-clock constant`);
    }
  }
  return { verdict: 'BLOCKED', proof: `K=${half.knowledgeCutoff} != sessionCloseUtc=${sessionCloseUtc(HALF_DAY_ANCHOR.sessionDate)}` };
});

hostile('H27', 'two canonical session records for the same session date', () => {
  const decision = resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: withDuplicateSession(REGULAR_ANCHOR.sessionDate),
  });
  assertEq(decision.status, 'FAIL_CLOSED');
  assertEq(decision.code, 'PINNED_CANONICAL_SESSION_NOT_UNIQUE');
  return { verdict: 'FAIL_CLOSED', proof: 'PINNED_CANONICAL_SESSION_NOT_UNIQUE' };
});

hostile('H28', 'a session date with no admissible canonical session', () => {
  const absent = resolvePinnedCanonicalSession({
    sessionDate: HALF_DAY_ANCHOR.sessionDate, calendarWindowBinding: REGULAR_ONLY_BINDING, sessions: SESSION_UNIVERSE,
  });
  assertEq(absent.code, 'PINNED_CANONICAL_SESSION_ABSENT');
  const weekend = resolvePinnedCanonicalSession({
    sessionDate: '2025-03-16', calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
  });
  assertEq(weekend.code, 'PINNED_CANONICAL_SESSION_ABSENT');
  return { verdict: 'FAIL_CLOSED', proof: 'PINNED_CANONICAL_SESSION_ABSENT' };
});

hostile('H29', 'a wall-clock cutoff constant or the forbidden primitive as derivation', () => {
  assertThrows(() => createCalendarWindowBinding({
    calendarAuthorityPolicyId: CALENDAR_AUTHORITY_POLICY_ID,
    calendarRegistryManifestId: CALENDAR_REGISTRY_MANIFEST_ID,
    allowedSessionKinds: ['REGULAR_SESSION'],
    calendarNamespaceVersion: CALENDAR_NAMESPACE_VERSION,
    cutoffDerivation: 'WALL_CLOCK_16_00',
  }), /WALL_CLOCK_CUTOFF_DERIVATION_FORBIDDEN/);
  const forgedWallClock = { ...CALENDAR_WINDOW_BINDING, cutoffDerivation: '21:00' };
  assertEq(resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: forgedWallClock, sessions: SESSION_UNIVERSE,
  }).code, 'WALL_CLOCK_CUTOFF_CONSTANT_FORBIDDEN');
  const forgedPrimitive = { ...CALENDAR_WINDOW_BINDING, cutoffDerivation: 'marketSession.mjs::sessionCloseUtc' };
  assertEq(resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: forgedPrimitive, sessions: SESSION_UNIVERSE,
  }).code, 'FORBIDDEN_CUTOFF_PRIMITIVE');
  assertEq(resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: withCorruptedClose(REGULAR_ANCHOR.sessionDate),
  }).code, 'PINNED_CANONICAL_SESSION_INVALID');
  assertEq(resolvePinnedCanonicalSession({
    sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: withMarketValidTimeDrift(REGULAR_ANCHOR.sessionDate),
  }).code, 'PINNED_CANONICAL_SESSION_INVALID');
  return { verdict: 'BLOCKED', proof: 'WALL_CLOCK_AND_FORBIDDEN_PRIMITIVE_REFUSED' };
});

/* ---------- Price basis, OD-2: H30-H34 ---------- */

hostile('H30', 'TOTAL_RETURN_ADJUSTED offered as the price basis', () => {
  const decision = materializeFeatureRecords(withPriceBasis('TOTAL_RETURN_ADJUSTED'));
  assertEq(decision.status, 'FAIL_CLOSED');
  assertEq(decision.code, 'PRICE_BASIS_TOTAL_RETURN_FORBIDDEN');
  assertEq(materializeFeatureRecords(withPriceBasis('DERIVED_ADJUSTED')).code, 'PRICE_BASIS_TOTAL_RETURN_FORBIDDEN');
  return { verdict: 'FAIL_CLOSED', proof: 'PRICE_BASIS_TOTAL_RETURN_FORBIDDEN' };
});

hostile('H31', 'a non-admitted price basis offered in place of SPLIT_ADJUSTED', () => {
  assertEq(materializeFeatureRecords(withPriceBasis('RAW')).code, 'PRICE_BASIS_NOT_ADMITTED_V1');
  assertEq(materializeFeatureRecords(withPriceBasis('UNKNOWN_BASIS')).code, 'PRICE_BASIS_UNAVAILABLE_FOR_WINDOW');
  return { verdict: 'FAIL_CLOSED', proof: 'PRICE_BASIS_NOT_ADMITTED_V1' };
});

hostile('H32', 'a price basis that changes inside the window', () => {
  const decision = materializeFeatureRecords(withMixedPriceBasis());
  assertEq(decision.status, 'FAIL_CLOSED');
  assertEq(decision.code, 'PRICE_BASIS_MIXED_IN_WINDOW');
  return { verdict: 'FAIL_CLOSED', proof: 'PRICE_BASIS_MIXED_IN_WINDOW' };
});

hostile('H33', 'implicit dividend total return folded into SPLIT_ADJUSTED closes', () => {
  const decision = materializeFeatureRecords(withImplicitDividendTotalReturn());
  assertEq(decision.status, 'FAIL_CLOSED');
  assertEq(decision.code, 'IMPLICIT_DIVIDEND_TOTAL_RETURN_FORBIDDEN');
  return { verdict: 'FAIL_CLOSED', proof: 'IMPLICIT_DIVIDEND_TOTAL_RETURN_FORBIDDEN' };
});

hostile('H34', 'split ratios assumed integer or >= 1', () => {
  for (const ratio of [2, 11 / 10, 3 / 2, 1 / 10, 0.001, 1234.5]) {
    assertEq(assertSplitRatioAdmissible(ratio), ratio);
  }
  for (const ratio of [0, -1, -0.5, NaN, Infinity, '2', null]) {
    assertThrows(() => assertSplitRatioAdmissible(ratio), /SPLIT_RATIO_INVALID/);
  }
  const base = BASE_BY_KEY.get('F1_SIMPLE_RETURN@W5').value;
  for (const ratio of [2, 11 / 10, 3 / 2, 1 / 10]) {
    const restated = materializeFeatureRecords(withSplitRatio(ratio));
    const value = restated.records.find((record) => record.sessionCount === 5).value;
    assertOk(Math.abs(value - base) < 1e-9, `simple return not invariant under ratio ${ratio}`);
  }
  return { verdict: 'INVARIANT_HELD', proof: 'ARBITRARY_RATIOS_ADMITTED_RETURN_INVARIANT' };
});

/* H35 = START_LIFECYCLE is excluded from the GATE23 BUILD hostile cohort by mandate. */

/* ---------- Missingness, vector status, store and freeze: H36-H43 ---------- */

hostile('H36', 'a missing close silently imputed inside a core window', () => {
  const decision = materializeFeatureRecords(withMissingClose(2));
  const core = decision.records.find((record) => record.sessionCount === 5);
  assertEq(core.status, 'FAIL_CLOSED');
  assertEq(core.missingnessState, 'INPUT_MISSING');
  assertEq(core.value, null);
  assertEq(decision.vectorStatus, 'FAIL_CLOSED');
  const gap = materializeFeatureRecords(withoutBar(REGULAR_ANCHOR.sessionDate));
  assertEq(gap.records.find((record) => record.sessionCount === 5).missingnessState, 'INPUT_MISSING');
  return { verdict: 'FAIL_CLOSED', proof: 'INPUT_MISSING' };
});

hostile('H37', 'a missing volume treated as identity-neutral', () => {
  const decision = materializeFeatureRecords(withMissingVolume(2));
  const core = decision.records.find((record) => record.sessionCount === 5);
  assertEq(core.status, 'RESOLVED');
  assertEq(core.missingnessState, 'VOLUME_MISSING');
  assert.notEqual(core.featureRecordId, BASE_BY_KEY.get('F1_SIMPLE_RETURN@W5').featureRecordId);
  assertions += 1;
  assertEq(core.value, BASE_BY_KEY.get('F1_SIMPLE_RETURN@W5').value);
  return { verdict: 'INVARIANT_HELD', proof: 'MISSINGNESS_STATE_IS_AN_IDENTITY_MEMBER' };
});

hostile('H38', 'forward fill or missing-as-zero requested', () => {
  assertEq(materializeFeatureRecords(buildFixtureInput({ forwardFill: true })).code, 'FORWARD_FILL_FORBIDDEN');
  assertEq(materializeFeatureRecords(buildFixtureInput({ coerceMissingToZero: true })).code, 'MISSING_NOT_ZERO');
  return { verdict: 'BLOCKED', proof: 'FORWARD_FILL_FORBIDDEN' };
});

hostile('H39', 'a declared member omitted from the results', () => {
  const decision = resolveVectorStatus({
    vector: {
      members: [
        { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 },
        { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21 },
        { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 63 },
      ],
    },
    memberResults: [
      { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5, status: 'RESOLVED' },
      { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21, status: 'RESOLVED' },
    ],
  });
  assertEq(decision.vectorStatus, 'FAIL_CLOSED');
  assertEq(decision.code, 'DECLARED_MEMBER_MISSING');
  return { verdict: 'FAIL_CLOSED', proof: 'DECLARED_MEMBER_MISSING' };
});

hostile('H40', 'vectorStatus read as every member usable', () => {
  assertEq(BASE.vectorStatus, 'RESOLVED');
  assertEq(BASE.vectorStatusMeaning, 'CORE_RESOLVED_ONLY');
  assertEq(BASE_BY_KEY.get('F1_SIMPLE_RETURN@W252').status, 'INSUFFICIENT_DATA');
  const coreBroken = resolveVectorStatus({
    vector: { members: [{ featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5 }, { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21 }] },
    memberResults: [
      { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 5, status: 'INSUFFICIENT_DATA' },
      { featureDefinitionId: 'F1_SIMPLE_RETURN', sessionCount: 21, status: 'RESOLVED' },
    ],
  });
  assertEq(coreBroken.vectorStatus, 'INSUFFICIENT_DATA');
  return { verdict: 'INVARIANT_HELD', proof: 'RESOLVED_MEANS_CORE_RESOLVED_ONLY' };
});

hostile('H41', 'a cross-sectional feature requested in V1', () => {
  assertEq(requestCrossSectional().code, 'CROSS_SECTIONAL_DEFERRED_V1');
  assertEq(materializeFeatureRecords(buildFixtureInput({ crossSectional: true })).code, 'CROSS_SECTIONAL_DEFERRED_V1');
  return { verdict: 'BLOCKED', proof: 'CROSS_SECTIONAL_DEFERRED_V1' };
});

hostile('H42', 'a later restatement rewriting a historical FeatureRecord', () => {
  const baseRecord = BASE_BY_KEY.get('F1_SIMPLE_RETURN@W5');
  let store = appendFeatureRecord(createFeatureStore(), baseRecord);
  store = appendFeatureRecord(store, baseRecord);
  assertEq(store.records.length, 1);
  const restated = materializeFeatureRecords(SAME_DATASET_RESTATEMENT()).records.find((record) => record.sessionCount === 5);
  assertEq(restated.featureRecordId, baseRecord.featureRecordId);
  assertEq(restated.identity.DatasetId_observation, DATASET_ID_OBSERVATION);
  assertThrows(() => appendFeatureRecord(store, restated), /FEATURE_STORE_RESTATEMENT_CONFLICT/);
  const republished = materializeFeatureRecords(NEW_DATASET_RESTATEMENT()).records.find((record) => record.sessionCount === 5);
  assert.notEqual(republished.featureRecordId, baseRecord.featureRecordId);
  assertions += 1;
  assertEq(appendFeatureRecord(store, republished).records.length, 2);
  return { verdict: 'REFUSED', proof: 'FEATURE_STORE_RESTATEMENT_CONFLICT' };
});

hostile('H43', 'an Outcome record stored in the feature store, or a 28th BUILD path', () => {
  const baseRecord = BASE_BY_KEY.get('F1_SIMPLE_RETURN@W5');
  assertThrows(() => appendFeatureRecord(createFeatureStore(), { ...baseRecord, featureDefinitionId: 'OutcomeStatus' }), /GATE23_PRODUCES_NO_OUTCOME/);
  assertThrows(() => appendFeatureRecord(createFeatureStore(), { ...baseRecord, featureRecordId: 'not-a-digest' }), /FEATURE_RECORD_ID_INVALID/);
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gates/GATE23/contracts/EXECUTION_CONTRACT_R0002.json'), 'utf8'));
  assertEq(contract.authorizedPaths.length, 27);
  assertEq(contract.authorizedPaths.filter((p) => p.includes('*') || p.includes('buildprep') || p.endsWith('/')).length, 0);
  assertEq(new Set(contract.authorizedPaths).size, 27);
  return { verdict: 'REFUSED', proof: 'WORKSET_FROZEN_AT_27' };
});

const EXPECTED_IDS = [
  ...Array.from({ length: 34 }, (_, index) => `H${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 8 }, (_, index) => `H${36 + index}`),
];
assert.deepEqual(results.map((result) => result.id), EXPECTED_IDS);
assert.equal(results.length, 42);
assertions += 2;

console.log(`GATE23_HOSTILES_PASS ${assertions} cases=${results.length}`);
console.log(`GATE23_HOSTILE_MATRIX_JSON ${JSON.stringify(results)}`);
