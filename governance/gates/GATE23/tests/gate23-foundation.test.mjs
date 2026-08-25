/**
 * GATE23 positive foundation tests: G23-POS-01 through G23-POS-04.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  FEATURE_RECORD_ID_MEMBERS_V1,
  FEATURE_RECORD_ID_CLOSURE_RULE,
  createFeatureRecordId,
  featureRecordIdentityTuple,
} from '../implementation/feature-identity-v1.mjs';
import { resolvePinnedCanonicalSession, FEATURE_WINDOW_LADDER_V1 } from '../implementation/feature-window-v1.mjs';
import { CORE_FEATURE_SET_V1, memberKey } from '../implementation/feature-families-v1.mjs';
import { T_CAUSAL_CLAIMS_V1 } from '../implementation/causal-admission-v1.mjs';
import { materializeFixture, FIXTURE_INPUT, HALF_DAY_FIXTURE_INPUT } from '../fixtures/causal-window-fixture.mjs';
import {
  SESSION_UNIVERSE,
  CALENDAR_WINDOW_BINDING,
  REGULAR_ANCHOR,
  HALF_DAY_ANCHOR,
} from '../fixtures/calendar-window-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };

/* G23-POS-01: FeatureRecordId is sha256Canonical of the exact 11 ordered members and replays identically. */
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
check(() => assert.equal(FEATURE_RECORD_ID_MEMBERS_V1.length, 11));
check(() => assert.equal(FEATURE_RECORD_ID_CLOSURE_RULE, 'EXACT_ONLY'));
check(() => assert.equal(createFeatureRecordId(identity), sha256Canonical(identity)));
check(() => assert.match(createFeatureRecordId(identity), /^[0-9a-f]{64}$/));
check(() => assert.equal(createFeatureRecordId(identity), createFeatureRecordId({ ...identity })));
check(() => assert.deepEqual([...featureRecordIdentityTuple(identity)], FEATURE_RECORD_ID_MEMBERS_V1.map((m) => identity[m])));

/* G23-POS-02: the core resolves while a declared non-core member is INSUFFICIENT_DATA. */
const materialized = materializeFixture();
const byKey = new Map(materialized.records.map((record) => [memberKey(record), record]));
check(() => assert.equal(materialized.vectorStatus, 'RESOLVED'));
check(() => assert.equal(materialized.vectorStatusMeaning, 'CORE_RESOLVED_ONLY'));
check(() => CORE_FEATURE_SET_V1.forEach((member) => assert.equal(byKey.get(memberKey(member)).status, 'RESOLVED')));
check(() => assert.equal(byKey.get('F1_SIMPLE_RETURN@W252').status, 'INSUFFICIENT_DATA'));
check(() => assert.equal(byKey.get('F1_SIMPLE_RETURN@W252').core, false));
check(() => assert.equal(byKey.get('F1_SIMPLE_RETURN@W252').value, null));
check(() => assert.equal(materialized.records.length, FIXTURE_INPUT.vector.members.length));
check(() => assert.equal(new Set(materialized.records.map((r) => r.featureRecordId)).size, materialized.records.length));
check(() => assert.equal(byKey.get('F1_SIMPLE_RETURN@W5').observedSessionCount, 6));
check(() => assert.equal(byKey.get('F1_SIMPLE_RETURN@W21').observedSessionCount, 22));
check(() => assert.deepEqual([...FEATURE_WINDOW_LADDER_V1], [5, 21, 63, 126, 252]));

/* G23-POS-03: K(T) = PinnedCanonicalSession(T).closeUtc for each session kind independently. */
const regular = resolvePinnedCanonicalSession({
  sessionDate: REGULAR_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
});
const halfDay = resolvePinnedCanonicalSession({
  sessionDate: HALF_DAY_ANCHOR.sessionDate, calendarWindowBinding: CALENDAR_WINDOW_BINDING, sessions: SESSION_UNIVERSE,
});
check(() => assert.equal(regular.status, 'RESOLVED'));
check(() => assert.equal(regular.sessionKind, 'REGULAR_SESSION'));
check(() => assert.equal(regular.knowledgeCutoff, REGULAR_ANCHOR.closeUtc));
check(() => assert.equal(halfDay.status, 'RESOLVED'));
check(() => assert.equal(halfDay.sessionKind, 'HALF_DAY_SESSION'));
check(() => assert.equal(halfDay.knowledgeCutoff, HALF_DAY_ANCHOR.closeUtc));
check(() => assert.notEqual(regular.knowledgeCutoff.slice(10), halfDay.knowledgeCutoff.slice(10)));
check(() => assert.equal(materialized.knowledgeCutoff, REGULAR_ANCHOR.closeUtc));
const halfDayMaterialized = materializeFixture({ sessionDate: HALF_DAY_FIXTURE_INPUT.sessionDate });
check(() => assert.equal(halfDayMaterialized.knowledgeCutoff, HALF_DAY_ANCHOR.closeUtc));
check(() => assert.equal(halfDayMaterialized.sessionKind, 'HALF_DAY_SESSION'));
check(() => assert.equal(halfDayMaterialized.vectorStatus, 'RESOLVED'));
check(() => assert.deepEqual([...T_CAUSAL_CLAIMS_V1].length, 2));

/* G23-POS-04: the 27 workset paths exist and no additional BUILD path is present. */
const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'governance/gates/GATE23/contracts/EXECUTION_CONTRACT_R0002.json'), 'utf8'));
const authorized = contract.authorizedPaths;
check(() => assert.equal(authorized.length, 27));
check(() => authorized.forEach((relative) => assert.ok(fs.existsSync(path.join(REPO_ROOT, relative)), relative)));
check(() => assert.equal(authorized.filter((p) => p.includes('*') || p.includes('buildprep')).length, 0));

const PREEXISTING_GATE23_PATHS = Object.freeze([
  'governance/gates/GATE23/contracts/CURRENT_CONTRACT.json',
  'governance/gates/GATE23/contracts/EXECUTION_CONTRACT_R0001.json',
  'governance/gates/GATE23/contracts/EXECUTION_CONTRACT_R0002.json',
  'governance/gates/GATE23/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json',
  'governance/gates/GATE23/state/CURRENT_STATE.json',
  'governance/gates/GATE23/state/revisions/R0001/CHECKPOINT.json',
  'governance/gates/GATE23/state/revisions/R0001/OPEN_DEFECTS.json',
  'governance/gates/GATE23/state/revisions/R0001/STATE_SEAL.json',
  'governance/gates/GATE23/state/revisions/R0002/CHECKPOINT.json',
  'governance/gates/GATE23/state/revisions/R0002/OPEN_DEFECTS.json',
  'governance/gates/GATE23/state/revisions/R0002/STATE_SEAL.json',
  'governance/gates/GATE23/state/revisions/R0003/CHECKPOINT.json',
  'governance/gates/GATE23/state/revisions/R0003/OPEN_DEFECTS.json',
  'governance/gates/GATE23/state/revisions/R0003/STATE_SEAL.json',
]);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(absolute) : [path.relative(REPO_ROOT, absolute).split(path.sep).join('/')];
  });
}
const present = walk(path.join(REPO_ROOT, 'governance/gates/GATE23')).sort();
const expected = [...authorized, ...PREEXISTING_GATE23_PATHS].sort();
check(() => assert.deepEqual(present, expected));
check(() => assert.equal(present.filter((p) => p.includes('/buildprep/')).length, 0));

console.log(`GATE23_FOUNDATION_PASS ${assertions}`);
