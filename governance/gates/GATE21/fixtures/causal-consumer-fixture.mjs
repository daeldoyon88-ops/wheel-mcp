/**
 * Declared GATE21 downstream-style consumer.
 * Schema existence is not proof: this fixture must actually call the facade.
 * If GATE21 v1 bindings disappear or mismatch, consumption fails closed.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  GATE21_CAUSAL_INTERFACE_VERSION,
  GATE21_BINDING_ID,
  GATE21_NORMALIZED_RECORD_VERSION,
  requestHistoricalCausalData,
  replayHistoricalCausalData,
  selectMacroVintageAsOf,
  refuseOutOfScope,
} from '../implementation/causal-data-interface.mjs';
import {
  DAILY_BAR_SCHEMA_VERSION,
  MISSING_REASONS,
  sessionCloseUtc,
  normalizeDailyBars,
} from '../implementation/lab-import-adapter.mjs';
import { GATE21_V1_SOURCE_ROWS, validateRequiredV1Free } from '../implementation/source-registry-v1.mjs';

export const CONSUMER_FIXTURE_ID = 'GATE21_CausalConsumerFixture/1';
export const CONSUMER_FIXTURE_PATH = 'governance/gates/GATE21/fixtures/causal-consumer-fixture.mjs';

const BINDING_PATH = path.resolve(import.meta.dirname, '../contracts/GATE21_BINDING_V1.json');

export function loadGate21Binding() {
  const binding = JSON.parse(fs.readFileSync(BINDING_PATH, 'utf8'));
  if (binding.bindingId !== GATE21_BINDING_ID) {
    throw new Error(`GATE21 v1 binding mismatch: ${binding.bindingId}`);
  }
  if (binding.interfaceVersion !== GATE21_CAUSAL_INTERFACE_VERSION) {
    throw new Error(`GATE21 interface version mismatch: ${binding.interfaceVersion}`);
  }
  if (binding.canonicalBarSchema !== DAILY_BAR_SCHEMA_VERSION) {
    throw new Error(`GATE21 canonical bar schema mismatch: ${binding.canonicalBarSchema}`);
  }
  return binding;
}

export function makeSessionBar({
  symbol = 'FIXT',
  sessionDate = '2024-06-03',
  availableDelayMs = 0,
  rawClose = 10,
  adjustedClose = 10,
  volume = 1000,
  splitFactor = null,
  cashDividend = null,
  timezone = 'America/New_York',
  source = 'LAB_JSON_DAILY_FIXTURE',
} = {}) {
  const eventTime = sessionCloseUtc(sessionDate);
  const availableAt = availableDelayMs === 0
    ? eventTime
    : new Date(Date.parse(eventTime) + availableDelayMs).toISOString();
  const rawVol = volume;
  const adjType = adjustedClose === null ? null : 'SPLIT_ADJUSTED';
  return {
    schemaVersion: DAILY_BAR_SCHEMA_VERSION,
    symbol,
    sessionDate,
    eventTime,
    availableAt,
    timezone,
    source,
    currency: 'USD',
    raw: {
      open: rawClose === null ? null : rawClose,
      high: rawClose === null ? null : rawClose,
      low: rawClose === null ? null : rawClose,
      close: rawClose,
      volume: rawVol,
    },
    adjusted: {
      open: adjustedClose === null ? null : adjustedClose,
      high: adjustedClose === null ? null : adjustedClose,
      low: adjustedClose === null ? null : adjustedClose,
      close: adjustedClose,
      volume: rawVol,
      adjustmentType: adjType,
      adjustmentFactor: null,
    },
    corporateActions: { splitFactor, cashDividend },
    qualityFlags: rawVol === null ? ['VOLUME_MISSING'] : [],
    lineage: { loadedFrom: source, loaderVersion: 'gate21-consumer-fixture/1', rowIndex: 0 },
  };
}

export const FIXTURE_SERIES = Object.freeze([
  makeSessionBar({ sessionDate: '2024-06-03', rawClose: 10, adjustedClose: 10, volume: 1000 }),
  makeSessionBar({ sessionDate: '2024-06-04', rawClose: 11, adjustedClose: 11, volume: null }),
  makeSessionBar({ sessionDate: '2024-06-05', rawClose: 12, adjustedClose: 12, volume: 1500 }),
]);

export function consumeHistoricalCausal({
  asOf = '2024-06-04T20:00:00.000Z',
  adjustmentMode = 'RAW',
  bars = FIXTURE_SERIES,
  timezone = 'America/New_York',
  ...rest
} = {}) {
  loadGate21Binding();
  const result = requestHistoricalCausalData({
    bars,
    asOf,
    adjustmentMode,
    timezone,
    sourceVersion: 'LAB_JSON_DAILY_FIXTURE@jsonDailyAdapter/1',
    manifest: rest.manifest ?? {
      source: 'LAB_JSON_DAILY_FIXTURE',
      contentHash: 'a'.repeat(64),
      version: 'DailyBarV1',
    },
    ...rest,
  });
  if (result.interfaceVersion !== GATE21_CAUSAL_INTERFACE_VERSION) {
    throw new Error('consumer refused: GATE21 interface identity missing');
  }
  return {
    consumerId: CONSUMER_FIXTURE_ID,
    honorsAsOf: result.records.every((row) => Date.parse(row.availableAt) <= Date.parse(asOf)),
    distinguishesMissing: result.records.map((row) => ({
      sessionDate: row.sessionDate,
      volume: row.selected.volume,
      volumeMissing: row.missing.volumeMissing,
      missingReason: row.missing.missingReason,
    })),
    distinguishesRawAdjusted: result.records.map((row) => ({
      sessionDate: row.sessionDate,
      rawClose: row.raw.close,
      adjustedClose: row.adjusted.close,
      selectedClose: row.selected.close,
      basis: row.basis,
    })),
    providerNeutral: result.records.every((row) => row.schemaVersion === GATE21_NORMALIZED_RECORD_VERSION
      && row.dailyBarSchema === DAILY_BAR_SCHEMA_VERSION),
    result,
  };
}

export function consumeReplay(input) {
  loadGate21Binding();
  return replayHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    adjustmentMode: 'RAW',
    timezone: 'America/New_York',
    sourceVersion: 'LAB_JSON_DAILY_FIXTURE@jsonDailyAdapter/1',
    corporateActionPolicyId: 'corporateActionPolicy/1:RAW',
    manifest: {
      source: 'LAB_JSON_DAILY_FIXTURE',
      contentHash: 'a'.repeat(64),
      version: 'DailyBarV1',
    },
    ...input,
  });
}

export function consumeMacroVintage({ knowledgeCutoff, vintages }) {
  loadGate21Binding();
  return selectMacroVintageAsOf({ vintages, knowledgeCutoff });
}

export function consumeFreeRegistry() {
  loadGate21Binding();
  return validateRequiredV1Free(GATE21_V1_SOURCE_ROWS);
}

export function consumeNormalizedFromProviderRows(rows, options) {
  loadGate21Binding();
  const bars = normalizeDailyBars(rows, options);
  return consumeHistoricalCausal({ bars, asOf: options.asOf, timezone: options.timezone ?? 'America/New_York', adjustmentMode: options.ohlcBasis ?? 'RAW' });
}

export function consumerProofMatrix(consumption) {
  return {
    CLAIM: 'downstream-style consumer reads GATE21 v1 causal data',
    REAL_CONSUMER: CONSUMER_FIXTURE_ID,
    TEST: consumption.consumerId === CONSUMER_FIXTURE_ID,
    RESULT: consumption.result.status,
    honorsAsOf: consumption.honorsAsOf,
    providerNeutral: consumption.providerNeutral,
    missingVolumeIsNull: consumption.distinguishesMissing.some((row) => row.volumeMissing === true && row.volume === null && row.missingReason === MISSING_REASONS.VOLUME_MISSING),
  };
}

export { refuseOutOfScope };
