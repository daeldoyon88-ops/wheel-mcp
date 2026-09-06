import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  GATE24_V1_CALENDAR_BINDING_ID,
  HISTORICAL_CALENDAR_BINDING_ID,
  buildJarviseHistoricalCalendarBindingDocumentR1,
  computeJarviseHistoricalCalendarBindingR1,
} from './jarviseHistoricalCalendarBindingR1.mjs';

const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));

test('T7 V2 binding is recomputed from published calendar bytes', () => {
  const binding = computeJarviseHistoricalCalendarBindingR1();
  assert.equal(binding.calendarWindowBindingId, HISTORICAL_CALENDAR_BINDING_ID);
  const persisted = readJson(new URL('./jarviseHistoricalCalendarBindingR1.json', import.meta.url));
  assert.deepEqual(buildJarviseHistoricalCalendarBindingDocumentR1(), persisted);
});

test('historical V2 terminates at observation plus feature', () => {
  const declaration = buildJarviseHistoricalCalendarBindingDocumentR1();
  assert.equal(declaration.historicalProcessingBoundary, 'OBSERVATION_FEATURE');
  assert.equal(declaration.gate24RegimeRecordEmission, 'FORBIDDEN_UNDER_CALENDAR_V2');
  assert.equal(declaration.retrospectiveSemantics, 'RETROSPECTIVE_RECONSTRUCTION');
});

test('GATE24 V1 binding remains distinct and unchanged', () => {
  const v1 = readJson(new URL('../../data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json', import.meta.url));
  assert.equal(v1.calendarWindowBindingId, GATE24_V1_CALENDAR_BINDING_ID);
  assert.notEqual(v1.calendarWindowBindingId, HISTORICAL_CALENDAR_BINDING_ID);
});
