import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMacroReleaseCalendarAsOf } from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture } from './macroMaterializationL4BSyntheticFixture.mjs';

function resolve(ctx, cutoff) {
  return resolveMacroReleaseCalendarAsOf({ store: ctx.store,
    releaseEventIdentityId: ctx.calendarVersions.schedule.releaseEventIdentityId, knowledgeCutoff: cutoff,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId });
}
const cases = [
  ['before calendar knowledge', '2025-12-15T14:59:59.999Z', 'NOT_AVAILABLE', null],
  ['exact calendar knowledge', '2025-12-15T15:00:00.000Z', 'RESOLVED', 'SCHEDULED'],
  ['after schedule', '2026-01-01T00:00:00.000Z', 'RESOLVED', 'SCHEDULED'],
  ['between schedule and reschedule', '2026-01-04T23:59:59.999Z', 'RESOLVED', 'SCHEDULED'],
  ['exact reschedule', '2026-01-05T15:00:00.000Z', 'RESOLVED', 'RESCHEDULED'],
  ['after reschedule', '2026-01-10T00:00:00.000Z', 'RESOLVED', 'RESCHEDULED'],
  ['after release', '2026-01-14T13:30:00.000Z', 'RESOLVED', 'RELEASED'],
  ['newer future version ignored', '2026-02-11T18:00:00.000Z', 'RESOLVED', 'RELEASED'],
];
for (const [label, cutoff, resolutionStatus, eventStatus] of cases) {
  test(`calendar as-of ${label}`, () => withOfficialMacroL4BI2Fixture((ctx) => {
    const result = resolve(ctx, cutoff);
    assert.equal(result.resolutionStatus, resolutionStatus);
    assert.equal(result.eventStatus, eventStatus);
  }));
}
test('calendar resolver remains bound to the old explicit registry pin', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const result = resolve(ctx, '2026-01-10T00:00:00.000Z');
  assert.equal(result.macroReleaseCalendarRegistryManifestId, ctx.calendar.macroReleaseCalendarRegistryManifestId);
}));
