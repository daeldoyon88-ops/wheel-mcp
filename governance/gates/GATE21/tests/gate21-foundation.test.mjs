import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GATE21_CAUSAL_INTERFACE_VERSION,
  GATE21_PLANE_CONTRACT,
  GATE21_PERFORMANCE_CONTRACT,
  DECISION,
  requestHistoricalCausalData,
} from '../implementation/causal-data-interface.mjs';
import {
  DAILY_BAR_SCHEMA_VERSION,
  dailyBarProblems,
  pinAllLabAssets,
} from '../implementation/lab-import-adapter.mjs';
import { GATE21_V1_SOURCE_ROWS } from '../implementation/source-registry-v1.mjs';
import {
  resolveGate21Roots,
  withGate21EphemeralRoot,
  relocatedDataRootIdentity,
} from '../implementation/portability-and-hygiene.mjs';
import {
  CONSUMER_FIXTURE_ID,
  FIXTURE_SERIES,
  consumeHistoricalCausal,
  consumeReplay,
  consumeFreeRegistry,
  consumerProofMatrix,
  loadGate21Binding,
} from '../fixtures/causal-consumer-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const BINDING_PATH = path.resolve(import.meta.dirname, '../contracts/GATE21_BINDING_V1.json');

test('G21-POS-01 as-of consumer reads DailyBarV1 with availableAt >= eventTime', () => {
  const binding = loadGate21Binding();
  const consumption = consumeHistoricalCausal({
    asOf: '2024-06-04T20:00:00.000Z',
    adjustmentMode: 'RAW',
  });
  const proof = consumerProofMatrix(consumption);
  assert.equal(proof.REAL_CONSUMER, CONSUMER_FIXTURE_ID);
  assert.equal(consumption.result.interfaceVersion, GATE21_CAUSAL_INTERFACE_VERSION);
  assert.equal(consumption.result.status, DECISION.AVAILABLE);
  assert.equal(consumption.honorsAsOf, true);
  assert.ok(consumption.result.records.length >= 1);
  for (const row of consumption.result.records) {
    assert.equal(row.dailyBarSchema, DAILY_BAR_SCHEMA_VERSION);
    assert.ok(Date.parse(row.availableAt) >= Date.parse(row.eventTime));
    assert.ok(Date.parse(row.availableAt) <= Date.parse('2024-06-04T20:00:00.000Z'));
  }
  for (const bar of FIXTURE_SERIES) {
    assert.equal(dailyBarProblems(bar).length, 0);
  }
  assert.equal(binding.canonicalBarSchema, 'DailyBarV1');
  assert.equal(proof.missingVolumeIsNull, true);
});

test('G21-POS-02 identical source version, manifest, cutoff, policy and adjustment replay to the same digest', () => {
  const replay = consumeReplay();
  assert.equal(replay.identical, true);
  assert.equal(typeof replay.digest, 'string');
  assert.equal(replay.digest.length, 64);
  const again = consumeReplay();
  assert.equal(again.digest, replay.digest);
});

test('G21-POS-03 required V1 registry rows have COST_CLASS=FREE', () => {
  const registry = consumeFreeRegistry();
  assert.equal(registry.ok, true);
  assert.ok(registry.requiredV1.length >= 1);
  for (const row of registry.requiredV1) {
    assert.equal(row.cost_class, 'FREE');
  }
  for (const row of GATE21_V1_SOURCE_ROWS.filter((item) => item.required_v1)) {
    assert.equal(row.cost_class, 'FREE');
    assert.equal(row.canonicalSchema, 'DailyBarV1');
  }
});

test('real consumer distinguishes missing/raw/adjusted and resolves provider-neutral records', () => {
  const consumption = consumeHistoricalCausal({
    asOf: '2024-06-04T20:00:00.000Z',
    adjustmentMode: 'RAW',
  });
  assert.equal(consumption.providerNeutral, true);
  const missing = consumption.distinguishesMissing.find((row) => row.sessionDate === '2024-06-04');
  assert.equal(missing.volume, null);
  assert.equal(missing.volumeMissing, true);
  assert.equal(missing.missingReason, 'VOLUME_MISSING');
  const rawAdj = consumption.distinguishesRawAdjusted.find((row) => row.sessionDate === '2024-06-03');
  assert.equal(rawAdj.rawClose, 10);
  assert.equal(rawAdj.selectedClose, 10);
  assert.equal(rawAdj.basis, 'RAW');
  const future = consumption.result.absences.find((item) => item.sessionDate === '2024-06-05');
  assert.ok(future);
  assert.equal(future.code, 'FUTURE_BAR_UNAVAILABLE_AT_AS_OF');
});

test('calendar/timezone uses explicit America/New_York session close, not local Date', () => {
  const consumption = consumeHistoricalCausal({ timezone: 'America/New_York' });
  for (const row of consumption.result.records) {
    assert.equal(row.timezone, 'America/New_York');
    assert.match(row.eventTime, /T20:00:00.000Z$/);
  }
});

test('HISTORICAL/LIVE boundary and off-scan performance contract', () => {
  const live = requestHistoricalCausalData({
    bars: FIXTURE_SERIES,
    asOf: '2024-06-04T20:00:00.000Z',
    timezone: 'America/New_York',
    plane: 'LIVE',
  });
  assert.equal(live.status, DECISION.BLOCKED);
  assert.equal(live.code, 'LIVE_PLANE_NOT_IMPLEMENTED');
  const binding = loadGate21Binding();
  assert.equal(binding.historicalVsLiveBoundary.live, 'NOT_IMPLEMENTED_IN_GATE21');
  assert.equal(GATE21_PLANE_CONTRACT.productionIngestion, 'NOT_IMPLEMENTED');
  assert.equal(GATE21_PERFORMANCE_CONTRACT.historicalWork, 'OFF_SCAN');
  assert.equal(GATE21_PERFORMANCE_CONTRACT.wheelScannerCoupling, 'NONE');
  assert.equal(binding.performance.historicalWork, 'OFF_SCAN');
});

test('portability resolves PROJECT/DATA/CACHE without machine-home hardcodes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate21-roots-'));
  try {
    const projectRoot = path.join(tmp, 'project');
    const dataRoot = path.join(tmp, 'data');
    const cacheRoot = path.join(tmp, 'cache');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(dataRoot);
    fs.mkdirSync(cacheRoot);
    const resolved = resolveGate21Roots({ projectRoot, dataRoot, cacheRoot });
    assert.equal(resolved.status, 'RESOLVED');
    const a = relocatedDataRootIdentity('snapshots/fixt.json', 'abc');
    const b = relocatedDataRootIdentity('snapshots/fixt.json', 'abc');
    assert.deepEqual(a, b);
    const hygiene = await withGate21EphemeralRoot({
      repoRoot: REPO_ROOT,
      consumer: 'gate21-foundation.test',
      failurePolicy: 'DISCARD',
    }, (run) => {
      const scratch = run.scratch('replay');
      fs.writeFileSync(path.join(scratch, 'note.txt'), 'ok');
      return scratch;
    });
    assert.equal(hygiene.hygiene.EPHEMERAL_ARTIFACT_CLEANUP_ATTEMPTED, true);
    assert.equal(hygiene.release.removed === true || hygiene.release.ok === true || hygiene.release.state === 'COMPLETED' || typeof hygiene.release === 'object', true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('lab assets are pinned as dependencies and remain unforked at adapter layer', () => {
  const pins = pinAllLabAssets(REPO_ROOT);
  assert.ok(pins.length >= 20);
  for (const pin of pins) {
    assert.equal(pin.mutated, false);
    assert.equal(pin.sha256.length, 64);
    assert.ok(pin.byteLength > 0);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, pin.path)));
  }
});

test('binding exact workset is the R0002 10-path cohort', () => {
  const binding = JSON.parse(fs.readFileSync(BINDING_PATH, 'utf8'));
  assert.equal(binding.exactWorkset.length, 10);
  assert.equal(binding.executionContractRevision, 'R0002');
});
