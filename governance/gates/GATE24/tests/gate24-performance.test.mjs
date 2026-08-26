/**
 * GATE24 performance budget tests.
 *
 * Classification is historical, off-scan work against a prepared macro snapshot.
 * Executable proof: classifier network calls = 0, macro fetch per ticker = 0,
 * snapshot computed once and reused, live-path macro ingestion = 0,
 * latency target delta = ZERO.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  createMacroBudgetMeter,
  createMacroSnapshotCache,
  refuseLiveMacroFetcher,
  refusePerTickerMacroFetch,
  refuseMacroIngestion,
} from '../implementation/macro-context-binding-v1.mjs';
import { describeRegimeHorizonArchitecture } from '../implementation/regime-horizon-v1.mjs';
import { emitFixtureRecord } from '../fixtures/missingness-horizon-fixture.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const IMPLEMENTATION_DIR = path.join(REPO_ROOT, 'governance/gates/GATE24/implementation');

export const PERFORMANCE_BUDGET_V1 = Object.freeze({
  classifierNetworkCalls: 0,
  macroFetchesPerTicker: 0,
  livePathMacroIngestion: 0,
  snapshotComputeOnce: 1,
  latencyTargetDelta: 'ZERO',
  batchTickerCount: 40,
  batchClassificationMs: 8000,
});

let assertions = 0;
const check = (fn) => { fn(); assertions += 1; };
const measure = (fn) => { const started = performance.now(); const value = fn(); return { ms: performance.now() - started, value }; };

emitFixtureRecord();

const meter = createMacroBudgetMeter();
const cache = createMacroSnapshotCache();
const batch = measure(() => {
  for (let index = 0; index < PERFORMANCE_BUDGET_V1.batchTickerCount; index += 1) {
    emitFixtureRecord({ meter, cache });
  }
});

const counters = meter.read();
check(() => assert.equal(counters.networkCalls, PERFORMANCE_BUDGET_V1.classifierNetworkCalls));
check(() => assert.equal(counters.macroFetches, PERFORMANCE_BUDGET_V1.macroFetchesPerTicker));
check(() => assert.equal(counters.ingestionCalls, PERFORMANCE_BUDGET_V1.livePathMacroIngestion));
check(() => assert.equal(counters.snapshotComputes, PERFORMANCE_BUDGET_V1.snapshotComputeOnce));
check(() => assert.equal(counters.snapshotReuses, PERFORMANCE_BUDGET_V1.batchTickerCount - 1));
check(() => assert.equal(cache.size(), 1));
check(() => assert.equal(refuseLiveMacroFetcher().code, 'LIVE_MACRO_FETCHER_FORBIDDEN'));
check(() => assert.equal(refusePerTickerMacroFetch().code, 'PER_TICKER_MACRO_FETCH_FORBIDDEN'));
check(() => assert.equal(refuseMacroIngestion().code, 'MACRO_INGESTION_NOT_IN_GATE24_SCOPE'));
check(() => assert.equal(describeRegimeHorizonArchitecture().createsNewCalendarConcept, false));
check(() => assert.ok(batch.ms < PERFORMANCE_BUDGET_V1.batchClassificationMs, `batch took ${batch.ms}ms`));

for (const file of fs.readdirSync(IMPLEMENTATION_DIR)) {
  const source = fs.readFileSync(path.join(IMPLEMENTATION_DIR, file), 'utf8');
  check(() => assert.ok(!/node:fs|node:http|node:https|node:net|node:child_process/.test(source), `${file} performs I/O`));
  check(() => assert.ok(!/\bfetch\s*\(|XMLHttpRequest/.test(source), `${file} performs network access`));
}

export const MEASUREMENTS = Object.freeze({
  batchTickerCount: PERFORMANCE_BUDGET_V1.batchTickerCount,
  batchMs: Number(batch.ms.toFixed(3)),
  networkCalls: counters.networkCalls,
  macroFetchesPerTicker: counters.macroFetches,
  snapshotComputes: counters.snapshotComputes,
  snapshotReuses: counters.snapshotReuses,
  ingestionCalls: counters.ingestionCalls,
  latencyTargetDelta: PERFORMANCE_BUDGET_V1.latencyTargetDelta,
});

/* The canonical performance evidence is a pinned BUILD output, not a product of
   this run. Independent reinspection requires that executing this test leaves
   repository bytes untouched, so the measurement above is held in memory and
   the artifact on disk is READ and VALIDATED, never rewritten. */
const EVIDENCE_PATH = path.join(REPO_ROOT, 'governance/gates/GATE24/evidence/GATE24_PERFORMANCE_BUDGET_MEASUREMENT.json');
const canonical = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8'));

check(() => assert.equal(canonical.document, 'GATE24_PERFORMANCE_BUDGET_MEASUREMENT'));
check(() => assert.equal(canonical.schemaVersion, 1));
check(() => assert.equal(canonical.gateId, 'GATE24'));
check(() => assert.equal(canonical.generatedBy, 'governance/gates/GATE24/tests/gate24-performance.test.mjs'));
check(() => assert.equal(canonical.verdict, 'PASS'));
check(() => assert.deepEqual(Object.keys(canonical), [
  'document', 'schemaVersion', 'gateId', 'generatedBy', 'verdict', 'budget', 'measurements', 'digest',
]));

/* The pinned budget is exactly the budget this run enforced. */
check(() => assert.deepEqual(canonical.budget, { ...PERFORMANCE_BUDGET_V1 }));
/* The pinned digest is recomputed from this run's live counters: the artifact
   attests the same budget and the same observed counters, independently. */
check(() => assert.equal(canonical.digest, sha256Canonical({ budget: PERFORMANCE_BUDGET_V1, counters })));

/* Every pinned measurement except the wall-clock reading is invariant and must
   equal what this run observed. batchMs is machine-dependent, so the pinned
   value is validated against the budget rather than overwritten with this
   run's timing. */
const { batchMs: pinnedBatchMs, ...pinnedInvariants } = canonical.measurements;
const { batchMs: observedBatchMs, ...observedInvariants } = MEASUREMENTS;
check(() => assert.deepEqual(pinnedInvariants, { ...observedInvariants }));
check(() => assert.equal(typeof pinnedBatchMs, 'number'));
check(() => assert.ok(pinnedBatchMs > 0, `pinned batchMs ${pinnedBatchMs}`));
check(() => assert.ok(pinnedBatchMs < PERFORMANCE_BUDGET_V1.batchClassificationMs, `pinned batchMs ${pinnedBatchMs}`));
check(() => assert.ok(observedBatchMs < PERFORMANCE_BUDGET_V1.batchClassificationMs, `observed batchMs ${observedBatchMs}`));

console.log(`GATE24_PERFORMANCE_PASS ${assertions}`);
console.log(`GATE24_PERFORMANCE_MEASUREMENT_JSON ${JSON.stringify({ budget: PERFORMANCE_BUDGET_V1, measurements: MEASUREMENTS })}`);
