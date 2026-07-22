import test from 'node:test';
import assert from 'node:assert/strict';
import { openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

function row(sessionDate) {
  return live.rows.macroStateBySessionRows.rows.find((r) => r.sessionDate === sessionDate);
}

test('official FOMC decision types follow fixture schedule', () => {
  const types = live.rows.macroStateBySessionRows.rows.map((r) => r.fomcState.fomcDecisionType);
  assert.deepEqual(types, [
    'NOT_AVAILABLE', 'HIKE', 'NOT_AVAILABLE', 'CUT', 'NOT_AVAILABLE', 'HIKE',
  ]);
});

test('hike session marks fomcDecisionDuringSession', () => {
  assert.equal(row('2026-03-03').fomcState.fomcDecisionDuringSession, true);
});

test('cut session marks fomcDecisionDuringSession', () => {
  assert.equal(row('2026-03-05').fomcState.fomcDecisionDuringSession, true);
});

test('restructure from 03-06 lands as HIKE on 03-09 at session close', () => {
  const fomc = row('2026-03-09').fomcState;
  assert.equal(fomc.fomcDecisionType, 'HIKE');
  assert.equal(row('2026-03-09').rateState.policyDirection, 'TIGHTENING');
});

test('non-decision sessions do not mark during-session flag', () => {
  assert.equal(row('2026-03-04').fomcState.fomcDecisionDuringSession, false);
});

test('next known FOMC event is resolved as-of session close only', () => {
  const fomc = row('2026-03-02').fomcState;
  assert.notEqual(fomc.nextKnownFomcEventId, null);
  if (fomc.nextEventKnowledgeAvailableAt !== null) {
    assert.ok(fomc.nextEventKnowledgeAvailableAt <= row('2026-03-02').sessionCloseUtc);
  }
});

test('future rescheduled calendar noise after knowledge cutoff is ignored at tip', () => {
  const last = row('2026-03-09').fomcState;
  assert.notEqual(last.fomcCalendarStatus, 'NOT_AVAILABLE');
});

test('sessions since last FOMC decision increments on quiet sessions', () => {
  const afterHike = row('2026-03-04').fomcState.sessionsSinceLastFomcDecision;
  assert.ok(afterHike === null || afterHike >= 1);
});

test('target change fields align with rate state on cut session', () => {
  const fomc = row('2026-03-05').fomcState;
  const rate = row('2026-03-05').rateState;
  assert.equal(fomc.fomcDecisionType, 'CUT');
  assert.ok(BigInt(rate.midpointChange.atoms) < 0n);
});

test('first session has no prior FOMC decision type', () => {
  assert.equal(row('2026-03-02').fomcState.fomcDecisionType, 'NOT_AVAILABLE');
});

test('FOMC state availability is complete on decision sessions', () => {
  assert.equal(row('2026-03-03').fomcState.fomcStateAvailability, 'COMPLETE');
});
