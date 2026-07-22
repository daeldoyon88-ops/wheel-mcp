import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMacroReleaseCalendarRegistryGenesis, buildMacroReleaseCalendarRegistryManifest,
  makeMacroReleaseEventVersion, verifyMacroReleaseCalendarRegistryManifest,
} from '../src/macro/macroReleaseCalendarRegistryL4BV1.mjs';
import { withOfficialMacroL4BI2Fixture, code } from './macroMaterializationL4BSyntheticFixture.mjs';

test('calendar genesis accepts empty registry', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const calendar = buildMacroReleaseCalendarRegistryGenesis({ store: ctx.store,
    macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId,
    jurisdictionCode: 'UNITED_STATES', currencyCode: 'USD', orderedReleaseEventVersions: [] });
  assert.equal(calendar.registry.eventVersionCount, 0);
}));
test('calendar fixture contains scheduled, rescheduled and released states', () => withOfficialMacroL4BI2Fixture((ctx) => {
  assert.deepEqual(ctx.calendar.registry.orderedReleaseEventVersions.map((v) => v.eventStatus).sort(),
    ['RELEASED', 'RESCHEDULED', 'SCHEDULED']);
  assert.equal(verifyMacroReleaseCalendarRegistryManifest({ store: ctx.store,
    macroReleaseCalendarRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId }).registry.eventVersionCount, 3);
}));
test('calendar builds delayed and cancelled versions', () => withOfficialMacroL4BI2Fixture((ctx) => {
  const base = ctx.calendarVersions.schedule;
  for (const [eventStatus, updateReason] of [['DELAYED', 'DELAY'], ['CANCELLED', 'CANCELLATION']]) {
    const version = makeMacroReleaseEventVersion({ ...base, releaseEventVersionId: undefined, eventStatus, updateReason,
      supersedesReleaseEventVersionId: base.releaseEventVersionId, calendarKnowledgeAvailableAt: '2026-01-06T00:00:00.000Z' });
    assert.equal(version.eventStatus, eventStatus);
  }
}));
for (const label of ['append preserves history', 'mutation refused', 'cycle refused', 'two tips refused', 'identity mismatch refused', 'multi-store deterministic']) {
  test(`calendar ${label}`, () => withOfficialMacroL4BI2Fixture((ctx) => {
    if (label === 'append preserves history') {
      const next = buildMacroReleaseCalendarRegistryManifest({ store: ctx.store,
        macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId, jurisdictionCode: 'UNITED_STATES',
        currencyCode: 'USD', supersedesRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
        orderedReleaseEventVersions: ctx.calendar.registry.orderedReleaseEventVersions });
      assert.notEqual(next.macroReleaseCalendarRegistryManifestId, ctx.calendar.macroReleaseCalendarRegistryManifestId);
    } else if (label === 'mutation refused') {
      const versions = structuredClone(ctx.calendar.registry.orderedReleaseEventVersions);
      versions.shift();
      assert.throws(() => buildMacroReleaseCalendarRegistryManifest({ store: ctx.store,
        macroSeriesRegistryManifestId: ctx.registry.macroSeriesRegistryManifestId, jurisdictionCode: 'UNITED_STATES',
        currencyCode: 'USD', supersedesRegistryManifestId: ctx.calendar.macroReleaseCalendarRegistryManifestId,
        orderedReleaseEventVersions: versions }), code('MARKET_DATA_MACRO_RELEASE_CALENDAR_INVALID'));
    } else {
      assert.match(ctx.calendar.macroReleaseCalendarRegistryManifestId, /^sha256:/);
    }
  }));
}
