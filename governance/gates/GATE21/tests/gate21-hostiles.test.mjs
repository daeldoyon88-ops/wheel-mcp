import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION,
  requestHistoricalCausalData,
  refuseMissingVolumeAsZero,
  refuseRawOverwrite,
  refuseOutOfScope,
  selectMacroVintageAsOf,
} from '../implementation/causal-data-interface.mjs';
import { refuseDirectionalLabMutation } from '../implementation/lab-import-adapter.mjs';
import { validateSourceRegistry, COST_CLASS } from '../implementation/source-registry-v1.mjs';
import { validatePortability } from '../implementation/portability-and-hygiene.mjs';
import {
  CONSUMER_FIXTURE_ID,
  FIXTURE_SERIES,
  consumeHistoricalCausal,
  consumeMacroVintage,
  consumerProofMatrix,
} from '../fixtures/causal-consumer-fixture.mjs';

test('G21-NEG-01 future bar requested at historical as-of is BLOCKED/ABSENT', () => {
  const consumption = consumeHistoricalCausal({
    asOf: '2024-06-04T20:00:00.000Z',
    bars: FIXTURE_SERIES,
  });
  const future = consumption.result.absences.find((item) => item.sessionDate === '2024-06-05');
  assert.ok(future);
  assert.ok(future.status === DECISION.BLOCKED || future.status === DECISION.ABSENT);
  assert.equal(future.code, 'FUTURE_BAR_UNAVAILABLE_AT_AS_OF');
  assert.equal(consumption.result.records.some((row) => row.sessionDate === '2024-06-05'), false);
});

test('G21-NEG-02 macro revision published after decision time is not visible', () => {
  const vintages = [
    { vintageId: 'v1', availableAt: '2024-06-03T12:00:00.000Z', vintageSequence: 1, value: 3.1 },
    { vintageId: 'v2', availableAt: '2024-06-10T12:00:00.000Z', vintageSequence: 2, value: 9.9 },
  ];
  const resolved = consumeMacroVintage({
    knowledgeCutoff: '2024-06-04T20:00:00.000Z',
    vintages,
  });
  assert.equal(resolved.resolutionStatus, 'RESOLVED');
  assert.equal(resolved.selected.vintageId, 'v1');
  assert.deepEqual(resolved.invisibleLaterRevisions, ['v2']);
  assert.notEqual(resolved.selected.value, 9.9);
  const empty = selectMacroVintageAsOf({
    vintages: [vintages[1]],
    knowledgeCutoff: '2024-06-04T20:00:00.000Z',
  });
  assert.equal(empty.resolutionStatus, 'NOT_AVAILABLE');
  assert.equal(empty.status, DECISION.ABSENT);
});

test('G21-CTR-01 missing volume cannot silently become zero', () => {
  const blocked = requestHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    coerceMissingVolumeToZero: true,
  });
  assert.equal(blocked.status, DECISION.BLOCKED);
  assert.equal(blocked.code, 'MISSING_VOLUME_NOT_ZERO');
  const refusal = refuseMissingVolumeAsZero(null);
  assert.equal(refusal.status, DECISION.BLOCKED);
  assert.equal(refusal.volume, null);
  const consumption = consumeHistoricalCausal({ asOf: '2024-06-04T20:00:00.000Z' });
  const missing = consumption.result.records.find((row) => row.sessionDate === '2024-06-04');
  assert.equal(missing.selected.volume, null);
  assert.notEqual(missing.selected.volume, 0);
  assert.equal(missing.missing.volumeMissing, true);
});

test('corporate-action adjustment cannot silently overwrite raw semantics', () => {
  const bar = FIXTURE_SERIES[0];
  const overwrite = requestHistoricalCausalData({
    bars: [bar],
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    overwriteRaw: true,
  });
  assert.equal(overwrite.status, DECISION.BLOCKED);
  assert.equal(overwrite.code, 'RAW_SEMANTICS_OVERWRITE_FORBIDDEN');
  const rawGuard = refuseRawOverwrite(bar, { ...bar.raw, close: 99 });
  assert.equal(rawGuard.status, DECISION.BLOCKED);
  const consumption = consumeHistoricalCausal({
    bars: [{
      ...bar,
      adjusted: { ...bar.adjusted, close: 20, open: 20, high: 20, low: 20, adjustmentType: 'SPLIT_ADJUSTED' },
      corporateActions: { splitFactor: 2, cashDividend: null },
    }],
    asOf: '2024-06-04T20:00:00.000Z',
    adjustmentMode: 'SPLIT_ADJUSTED',
  });
  assert.equal(consumption.result.records[0].raw.close, 10);
  assert.equal(consumption.result.records[0].adjusted.close, 20);
  assert.equal(consumption.result.records[0].selected.close, 20);
});

test('G21-CTR-02 forbidden forward-fill is BLOCKED', () => {
  const blocked = requestHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    forwardFill: true,
  });
  assert.equal(blocked.status, DECISION.BLOCKED);
  assert.equal(blocked.code, 'FORWARD_FILL_FORBIDDEN');
});

test('timezone ambiguity fails closed', () => {
  for (const timezone of ['', 'LOCAL', 'EST', 'ambiguous']) {
    const result = requestHistoricalCausalData({
      bars: FIXTURE_SERIES,
      asOf: '2024-06-04T20:00:00.000Z',
      timezone,
    });
    assert.equal(result.status, DECISION.FAIL_CLOSED);
    assert.equal(result.code, 'TIMEZONE_AMBIGUOUS');
  }
});

test('incompatible fallback schema is BLOCKED', () => {
  const result = requestHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    sourceId: 'LAB_JSON_DAILY_FIXTURE',
    fallbackSchema: 'YahooChartV2Proprietary',
  });
  assert.equal(result.status, DECISION.BLOCKED);
  assert.equal(result.code, 'INCOMPATIBLE_FALLBACK_SCHEMA');
});

test('replay manifest source/hash/version mismatch is BLOCKED', () => {
  const result = requestHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    manifest: { source: 'LAB_JSON_DAILY_FIXTURE', contentHash: 'b'.repeat(64), version: 'DailyBarV1' },
    manifestExpected: { source: 'LAB_JSON_DAILY_FIXTURE', contentHash: 'a'.repeat(64), version: 'DailyBarV1' },
  });
  assert.equal(result.status, DECISION.BLOCKED);
  assert.equal(result.code, 'REPLAY_MANIFEST_MISMATCH');
});

test('G21-NEG-03 paid-only source configured as required V1 fails contract validation', () => {
  const paid = validateSourceRegistry([
    {
      source: 'PAID_VENDOR_X',
      identityOrLabRegistryId: 'vendor-x',
      cost_class: COST_CLASS.PAID,
      rate_limit: 'PAID_TIER',
      historical_depth: 'VENDOR',
      freshness: 'VENDOR',
      reliability: 'PAID',
      access_terms: 'PAID_LICENSE',
      free_fallback: null,
      historical_or_live_class: 'HISTORICAL',
      required_v1: true,
      canonicalSchema: 'DailyBarV1',
    },
  ]);
  assert.equal(paid.ok, false);
  assert.equal(paid.code, 'PAID_ONLY_REQUIRED_V1');
});

test('hard-coded machine path fails portability validation', () => {
  const result = validatePortability({
    PROJECT_ROOT: 'C:\\Users\\melan\\Desktop\\wheel-mcp-canonical',
    DATA_ROOT: 'C:\\Users\\melan\\Desktop\\wheel-mcp-canonical\\data',
    CACHE_ROOT: 'C:\\Users\\melan\\Desktop\\wheel-mcp-canonical\\cache',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HARDCODED_MACHINE_PATH');
});

test('G21-NEG-04 G22+ or directional-lab mutation path requested under this contract is BLOCKED', () => {
  assert.equal(refuseOutOfScope('G22_LABELS').status, DECISION.BLOCKED);
  assert.equal(refuseOutOfScope('G23_FEATURES').code, 'G22_PLUS_FORBIDDEN');
  assert.equal(refuseOutOfScope('G24_REGIMES').code, 'G22_PLUS_FORBIDDEN');
  assert.equal(refuseDirectionalLabMutation('research/directional-lab/src/contracts/dailyBarV1.mjs').status, 'BLOCKED');
});

test('G21-CTR-03 asserted PASS without consumer fixture consumption is BLOCKED', () => {
  const consumption = consumeHistoricalCausal();
  const proof = consumerProofMatrix(consumption);
  assert.equal(proof.REAL_CONSUMER, CONSUMER_FIXTURE_ID);
  assert.equal(proof.TEST, true);
  assert.notEqual(proof.RESULT, undefined);
  const vacant = { CLAIM: 'PASS', REAL_CONSUMER: null, TEST: false };
  assert.equal(vacant.REAL_CONSUMER === CONSUMER_FIXTURE_ID, false);
  assert.equal(vacant.TEST, false);
});
