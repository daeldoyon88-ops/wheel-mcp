import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { normalizeDailyBars } from '../../research/directional-lab/src/data/normalizeDailyBars.mjs';
import { applyPinnedSessionTimestampsR1 } from './pinnedSessionTimestampsR1.mjs';

const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const quote = (sessionDate) => ({
  date: sessionDate, open: 100, high: 102, low: 99, close: 101, volume: 10,
});

function normalize(rows) {
  return normalizeDailyBars(rows, {
    symbol: 'AAPL', source: 'YAHOO_CHART_EOD', ohlcBasis: 'SPLIT_ADJUSTED',
    timezone: 'America/New_York', loaderVersion: 'pinnedSessionTimestampsR1.test/1',
  });
}

test('T1 regular-session timestamps remain unchanged', () => {
  const session = { sessionDate: '2026-11-25', closeUtc: '2026-11-25T21:00:00.000Z', sessionKind: 'REGULAR_SESSION' };
  const before = normalize([quote(session.sessionDate)]);
  const after = applyPinnedSessionTimestampsR1(before, [session]);
  assert.deepEqual(after, before);
});

test('T2 every canonical V2 half-day uses its pinned closeUtc', () => {
  let halfDayCount = 0;
  let genericCloseDifferenceCount = 0;
  let postRepairDivergenceCount = 0;
  for (const year of years) {
    const calendar = readJson(new URL(`../../data/jarvise/session-calendar-historical/XNYS/${year}/session-calendar-core.json`, import.meta.url));
    for (const session of calendar.sessions.filter((entry) => entry.sessionKind === 'HALF_DAY_SESSION')) {
      const [before] = normalize([quote(session.sessionDate)]);
      const [bar] = applyPinnedSessionTimestampsR1([before], [session]);
      if (before.eventTime !== session.closeUtc || before.availableAt !== session.closeUtc) {
        genericCloseDifferenceCount += 1;
      }
      if (bar.eventTime !== session.closeUtc || bar.availableAt !== session.closeUtc) {
        postRepairDivergenceCount += 1;
      }
      assert.equal(bar.eventTime, session.closeUtc, session.sessionDate);
      assert.equal(bar.availableAt, session.closeUtc, session.sessionDate);
      halfDayCount += 1;
    }
  }
  assert.equal(halfDayCount, 20);
  assert.equal(genericCloseDifferenceCount, halfDayCount);
  assert.equal(postRepairDivergenceCount, 0);
});

test('T3 a half-day bar is available at its real canonical K(T)', () => {
  const session = { sessionDate: '2026-11-27', closeUtc: '2026-11-27T18:00:00.000Z', sessionKind: 'HALF_DAY_SESSION' };
  const [bar] = applyPinnedSessionTimestampsR1(normalize([quote(session.sessionDate)]), [session]);
  assert.equal(Date.parse(bar.eventTime) <= Date.parse(session.closeUtc), true);
  assert.equal(Date.parse(bar.availableAt) <= Date.parse(session.closeUtc), true);
});

test('T4 and T6 field schema is invariant and no forbidden close derivation is imported', () => {
  const session = { sessionDate: '2024-07-03', closeUtc: '2024-07-03T17:00:00.000Z', sessionKind: 'HALF_DAY_SESSION' };
  const [before] = normalize([quote(session.sessionDate)]);
  const [after] = applyPinnedSessionTimestampsR1([before], [session]);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const source = readFileSync(new URL('./pinnedSessionTimestampsR1.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('marketSession.mjs'), false);
  assert.equal(source.includes('sessionCloseUtc'), false);
  for (const literal of ['16:00', '09:30', '20:00', '21:00']) assert.equal(source.includes(literal), false);
});
