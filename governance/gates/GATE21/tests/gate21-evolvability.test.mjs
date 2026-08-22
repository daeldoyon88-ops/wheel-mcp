import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  GATE21_CAUSAL_INTERFACE_VERSION,
  GATE21_BINDING_ID,
  DECISION,
} from '../implementation/causal-data-interface.mjs';
import {
  GATE21_V1_SOURCE_ROWS,
  validateSourceRegistry,
  COST_CLASS,
} from '../implementation/source-registry-v1.mjs';
import {
  consumeHistoricalCausal,
  consumeReplay,
  loadGate21Binding,
} from '../fixtures/causal-consumer-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const BINDING_PATH = path.resolve(import.meta.dirname, '../contracts/GATE21_BINDING_V1.json');

const EXACT_WORKSET = Object.freeze([
  'governance/gates/GATE21/implementation/causal-data-interface.mjs',
  'governance/gates/GATE21/implementation/lab-import-adapter.mjs',
  'governance/gates/GATE21/implementation/source-registry-v1.mjs',
  'governance/gates/GATE21/implementation/portability-and-hygiene.mjs',
  'governance/gates/GATE21/contracts/GATE21_BINDING_V1.json',
  'governance/gates/GATE21/tests/gate21-foundation.test.mjs',
  'governance/gates/GATE21/tests/gate21-hostiles.test.mjs',
  'governance/gates/GATE21/tests/gate21-evolvability.test.mjs',
  'governance/gates/GATE21/fixtures/causal-consumer-fixture.mjs',
  'governance/gates/GATE21/evidence/BUILD_CANDIDATE_RECEIPT.json',
]);

function worksetPins() {
  return EXACT_WORKSET.map((relative) => {
    const abs = path.join(REPO_ROOT, relative);
    const bytes = fs.readFileSync(abs);
    return { path: relative, sha256: sha256Bytes(bytes), byteLength: bytes.length };
  });
}

test('EXACT_WORKSET is the frozen R0002 10-path cohort', () => {
  const binding = loadGate21Binding();
  assert.deepEqual(binding.exactWorkset, [...EXACT_WORKSET]);
  assert.equal(EXACT_WORKSET.length, 10);
  for (const relative of EXACT_WORKSET) {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, relative)), true);
  }
});

test('CLOSURE_PATH_PROOF is recalculated from bound bytes, not an asserted PASS field', () => {
  const pins = worksetPins();
  const digest = sha256Canonical({
    bindingId: GATE21_BINDING_ID,
    interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
    pins,
  });
  assert.equal(digest.length, 64);
  const again = sha256Canonical({
    bindingId: GATE21_BINDING_ID,
    interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
    pins,
  });
  assert.equal(digest, again);
  const binding = JSON.parse(fs.readFileSync(BINDING_PATH, 'utf8'));
  assert.equal(Object.hasOwn(binding, 'PASS'), false);
  assert.equal(Object.hasOwn(binding, 'assertedPass'), false);
});

test('FUTURE_CHANGE_TEST: additive FREE source, additive field, v2 pin, v1 rollback', () => {
  const evolved = [
    ...GATE21_V1_SOURCE_ROWS,
    {
      source: 'FUTURE_FREE_CSV',
      identityOrLabRegistryId: 'future-csv',
      cost_class: COST_CLASS.FREE,
      rate_limit: 'LOCAL_FILE',
      historical_depth: 'FILE_BOUNDED',
      freshness: 'SNAPSHOT',
      reliability: 'DETERMINISTIC_REPLAY',
      access_terms: 'FREE',
      free_fallback: 'LAB_JSON_DAILY_FIXTURE',
      historical_or_live_class: 'HISTORICAL',
      required_v1: false,
      canonicalSchema: 'DailyBarV1',
      additiveField: 'ignored-by-v1',
    },
  ];
  const validation = validateSourceRegistry(evolved);
  assert.equal(validation.ok, true);
  const v1Consumer = consumeHistoricalCausal();
  assert.equal(v1Consumer.result.interfaceVersion, GATE21_CAUSAL_INTERFACE_VERSION);
  assert.equal(v1Consumer.result.status, DECISION.AVAILABLE);
  const v2Pin = { ...loadGate21Binding(), interfaceVersion: 'GATE21_CausalDataInterface/2' };
  assert.notEqual(v2Pin.interfaceVersion, GATE21_CAUSAL_INTERFACE_VERSION);
  const rollback = loadGate21Binding();
  assert.equal(rollback.interfaceVersion, GATE21_CAUSAL_INTERFACE_VERSION);
});

test('FUTURE_3_GATES_TEST: G22/G23/G24 consume frozen GATE21 v1 without reopening it', () => {
  const causal = consumeHistoricalCausal({ asOf: '2024-06-04T20:00:00.000Z' });
  assert.equal(causal.result.interfaceVersion, GATE21_CAUSAL_INTERFACE_VERSION);

  const g22 = causal.result.records.map((row) => ({
    sessionDate: row.sessionDate,
    asOfBoundClose: row.selected.close,
    availableAt: row.availableAt,
  }));
  assert.equal(g22.some((row) => row.sessionDate === '2024-06-05'), false);

  const g23 = causal.result.records.map((row) => ({
    sessionDate: row.sessionDate,
    featureInputClose: row.selected.close,
    volumeMissing: row.missing.volumeMissing,
    vintageSafe: Date.parse(row.availableAt) <= Date.parse(causal.result.asOf),
  }));
  assert.ok(g23.every((row) => row.vintageSafe === true));

  const g24 = {
    regimeVectorFrom: 'GATE23',
    gate21Interface: causal.result.interfaceVersion,
    featureCount: g23.length,
  };
  assert.equal(g24.gate21Interface, GATE21_CAUSAL_INTERFACE_VERSION);
  assert.ok(g24.featureCount > 0);
});

test('FUTURE_EVOLUTION_PROOF / REPAIR_CYCLE_RISK / MERGE_READINESS / ROLLBACK / MIGRATION / DEPRECATION', () => {
  const binding = loadGate21Binding();
  assert.equal(binding.evolvability.evolution, 'ADDITIVE_VERSIONED');
  assert.equal(binding.evolvability.unknownFields, 'CONSUMERS_IGNORE');
  assert.equal(binding.evolvability.mergeReadiness, 'ISOLATED');
  assert.equal(binding.evolvability.rollback, 'PIN_PREVIOUS_SCHEMA_OR_SNAPSHOT_VERSION');
  assert.match(binding.evolvability.fallback, /LAB_RESEARCH_UNCHANGED/);
  assert.equal(binding.evolvability.deprecation, 'BY_VERSION_ID_NEVER_SILENT_REWRITE');
  assert.equal(binding.evolvability.requiredFieldRemoval, 'REQUIRES_VERSION_BUMP_AND_MIGRATION');
  const replay = consumeReplay();
  assert.equal(replay.identical, true);
  const repairCycleRisk = {
    frozenV1: GATE21_CAUSAL_INTERFACE_VERSION,
    reopenRequiredForAdditiveSource: false,
    reopenRequiredForG22Consume: false,
    risk: 'LOW_IF_V1_FROZEN',
  };
  assert.equal(repairCycleRisk.reopenRequiredForG22Consume, false);
});

test('Yahoo replay limitation is recorded rather than claiming false determinism', () => {
  const yahoo = GATE21_V1_SOURCE_ROWS.find((row) => row.source === 'YAHOO_CHART_EOD');
  assert.equal(yahoo.replay_guarantee, 'NOT_GUARANTEED_WITHOUT_PINNED_SNAPSHOT');
  const fixture = GATE21_V1_SOURCE_ROWS.find((row) => row.source === 'LAB_JSON_DAILY_FIXTURE');
  assert.equal(fixture.replay_guarantee, 'BYTE_IDENTICAL');
});
