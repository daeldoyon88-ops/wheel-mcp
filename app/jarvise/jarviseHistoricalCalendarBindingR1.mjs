import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCalendarWindowBinding } from '../../governance/gates/GATE23/implementation/feature-window-v1.mjs';

export const HISTORICAL_CALENDAR_NAMESPACE = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/2';
export const HISTORICAL_CALENDAR_BINDING_ID = '3fe7456e03175fc49fb8af810d2050e58f34d2e3d548b27ad071db8957882308';
export const GATE24_V1_CALENDAR_BINDING_ID = 'ac801193ad4ca02b7f0343ebaa4af93a8bdb118d3219edc12f80a9ef1046b023';
export const HISTORICAL_PROCESSING_BOUNDARY = 'OBSERVATION_FEATURE';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const YEARS = Object.freeze([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`);
  error.code = code;
  throw error;
}

export function computeJarviseHistoricalCalendarBindingR1({ root = REPOSITORY_ROOT } = {}) {
  const provenance = readJson(resolve(root, 'data/jarvise/session-calendar-historical/XNYS/registry/R0001/PROVENANCE.json'));
  if (provenance.calendarNamespaceVersion !== HISTORICAL_CALENDAR_NAMESPACE) {
    fail('HISTORICAL_CALENDAR_NAMESPACE_MISMATCH', provenance.calendarNamespaceVersion);
  }
  const calendarWindowBinding = createCalendarWindowBinding({
    calendarAuthorityPolicyId: provenance.calendarAuthorityPolicyId,
    calendarRegistryManifestId: provenance.calendarRegistryManifestId,
    allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
    calendarNamespaceVersion: provenance.calendarNamespaceVersion,
  });
  if (calendarWindowBinding.calendarWindowBindingId !== HISTORICAL_CALENDAR_BINDING_ID) {
    fail('HISTORICAL_CALENDAR_BINDING_ID_MISMATCH', calendarWindowBinding.calendarWindowBindingId);
  }
  return calendarWindowBinding;
}

export function loadJarviseHistoricalCalendarR1({ root = REPOSITORY_ROOT } = {}) {
  const sessions = [];
  for (const year of YEARS) {
    const calendar = readJson(resolve(root, `data/jarvise/session-calendar-historical/XNYS/${year}/session-calendar-core.json`));
    if (calendar.schemaVersion !== 'MarketSessionCalendarCore/2') fail('HISTORICAL_CALENDAR_SCHEMA_MISMATCH', String(year));
    sessions.push(...calendar.sessions);
  }
  sessions.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate, 'en'));
  if (new Set(sessions.map((session) => session.sessionDate)).size !== sessions.length) {
    fail('HISTORICAL_CALENDAR_DUPLICATE_SESSION', 'sessionDate');
  }
  return {
    schemaVersion: HISTORICAL_CALENDAR_NAMESPACE,
    venueId: 'XNYS',
    coverageFromDate: '2018-01-01',
    coverageToDateExclusive: '2027-01-01',
    sessions,
  };
}

export function buildJarviseHistoricalCalendarBindingDocumentR1({ root = REPOSITORY_ROOT } = {}) {
  return {
    schemaVersion: 'WHEEL_JARVISE_HISTORICAL_CALENDAR_BINDING/1',
    calendarWindowBinding: computeJarviseHistoricalCalendarBindingR1({ root }),
    historicalProcessingBoundary: HISTORICAL_PROCESSING_BOUNDARY,
    gate24RegimeRecordEmission: 'FORBIDDEN_UNDER_CALENDAR_V2',
    retrospectiveSemantics: 'RETROSPECTIVE_RECONSTRUCTION',
    mutatesGate24V1Binding: false,
    gate24V1CalendarWindowBindingId: GATE24_V1_CALENDAR_BINDING_ID,
  };
}
