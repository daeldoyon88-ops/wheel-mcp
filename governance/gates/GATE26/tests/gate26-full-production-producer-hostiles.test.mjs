/**
 * GATE26 PHASE D — hostile contract tests for the real production producer surfaces.
 *
 * SCOPE, AND WHY IT IS THE SCOPE IT IS. This file covers the surfaces that can be
 * attacked without first completing the real producer's six-minute preparation: the
 * execution intent binding, the fail-closed resource budget guard and its startup
 * precondition, the disk measurement target, the producer identity binding and the
 * FULL code identity set. Every case here is cheap and deterministic, driven by an
 * injected sampler wherever a real host reading would make the outcome depend on the
 * machine.
 *
 * The positive counterparts that must run THROUGH a prepared real producer — bounded
 * slow-oracle equivalence, the absence of per-query universe rescan, and the measured
 * preparation peaks — live in gate26-full-production-producer.test.mjs, which pays the
 * preparation cost once. Splitting them that way keeps this file fast enough to run on
 * every change without weakening either proof.
 *
 * Every attack must fail closed with its exact code, and none may create a FULL
 * product byte. Products are written under the OS temp directory; repository files are
 * only read. The guard is driven by an injected deterministic sampler wherever a real
 * host reading would make the outcome depend on the machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sha256Bytes } from '../../../tools/canonical-json.mjs';
import { installNetworkTrap } from '../implementation/mini-fixture-v1.mjs';
import { CURRENT_CONTRACT_POINTER_PATH, R0003_CONTRACT_PATH, R0006_CONTRACT_PATH } from '../implementation/full-query-cohort-v1.mjs';
import { FULL_CODE_IDENTITY_PATHS_V1, computeCodeIdentity } from '../implementation/full-checkpoint-v1.mjs';
import {
  CANONICAL_FULL_INTENT_V1, EXECUTION_INTENTS_V1, PREBUILD_REHEARSAL_INTENT_V1, REAL_PILOT_INTENT_V1,
  prepareRehearsalCohort, runPagedMaterialization,
} from '../implementation/full-paged-materializer-v1.mjs';
import {
  PRODUCER_BINDING_PATH_V1, PRODUCER_BINDING_PATH_V2, RESOURCE_BUDGET_PATH_V1, RESOURCE_BUDGET_PATH_V2, REAL_PRODUCER_ID_V1,
  createResourceBudgetGuard, fullStartRamPreconditionState, loadResourceBudget,
  resetFullStartRamPrecondition, verifyProducerIdentity,
} from '../implementation/full-production-producer-v1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTRACT = JSON.parse(fs.readFileSync(path.resolve(ROOT, R0003_CONTRACT_PATH), 'utf8'));
const FULL_ROOT = path.resolve(ROOT, CONTRACT.packagingRequirements.fullProductRoot);
// R0006: the FULL root may hold only the exact enumerated canonical pathset; nothing a test runs may add to it.
const CANONICAL_FULL_NAMES = new Set(CONTRACT.authorizedPaths
  .filter((file) => file.startsWith(`${CONTRACT.packagingRequirements.fullProductRoot}/`))
  .map((file) => file.slice(CONTRACT.packagingRequirements.fullProductRoot.length + 1)));
const assertNoNonCanonicalFullBytes = () => {
  if (!fs.existsSync(FULL_ROOT)) return;
  for (const entry of fs.readdirSync(FULL_ROOT, { withFileTypes: true })) {
    assert.ok(entry.isFile() && CANONICAL_FULL_NAMES.has(entry.name), `no non-canonical FULL product path may exist: ${entry.name}`);
  }
};
const networkCalls = installNetworkTrap();
const WORK = path.join(os.tmpdir(), 'wheel-gee', `gate26-real-producer-hostiles-${process.pid}`);

const refusesWith = (fn, code) => assert.throws(fn, (error) => error?.code === code, `expected ${code}`);
const noFullRoot = assertNoNonCanonicalFullBytes;
const readJson = (relative) => JSON.parse(fs.readFileSync(path.resolve(ROOT, relative), 'utf8'));
const sha256OfFile = (relative) => createHash('sha256').update(fs.readFileSync(path.resolve(ROOT, relative))).digest('hex');

/**
 * R0007 consumed the single R0006 canonical FULL build authority. The unchanged, audited production code
 * pins R0006 and therefore refuses the live repository (CURRENT_CONTRACT_NOT_R0006): that refusal is the
 * expected post-build behaviour. The historical R0006 behaviour is still exercised, on a read-only view of
 * the repository that differs only by its CURRENT_CONTRACT pointer. That pointer is rebuilt from the R0006
 * contract and ledger event 117 and accepted only if it equals the pointer sealed in state R0007. The FULL
 * product root and .git are never linked into the view, so nothing run against it can reach the audited
 * product or the index; links are removed one by one before the view directory itself is deleted.
 */
function openSealedR0006AuthorityView(liveRoot, viewRoot) {
  const fullProductRoot = 'data/jarvise/predictive-ensemble/GATE26/V1/FULL';
  const read = (relative) => fs.readFileSync(path.resolve(liveRoot, relative));
  const sealed = JSON.parse(read('governance/gates/GATE26/state/revisions/R0007/STATE_SEAL.json').toString('utf8'))
    .sealedMembers.find((member) => member.repoRelativePath === CURRENT_CONTRACT_POINTER_PATH);
  const event117 = read('governance/state/GATE_STATUS_LEDGER.ndjson').toString('utf8').trimEnd().split('\n')
    .map((line) => JSON.parse(line)).find((event) => event.eventId === 'GATE26_CONTRACT_SUCCESSION_R0006_R1');
  assert.equal(event117.ordinal, 117);
  const pointerBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1, gateId: 'GATE26', contractRevision: 'R0006', contractPath: R0006_CONTRACT_PATH,
    contractSha256: sha256Bytes(read(R0006_CONTRACT_PATH)), activatedByEventId: event117.eventId,
  }, null, 2)}\n`, 'utf8');
  assert.equal(sha256Bytes(pointerBytes), sealed.sha256, 'the view pointer is exactly the CURRENT_CONTRACT sealed in state R0007');
  const links = [];
  const onPath = (relative) => [CURRENT_CONTRACT_POINTER_PATH, fullProductRoot].some((target) => target.startsWith(`${relative}/`));
  const mirror = (relative) => {
    fs.mkdirSync(path.join(viewRoot, relative), { recursive: true });
    for (const entry of fs.readdirSync(path.join(liveRoot, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (child === '.git' || child === CURRENT_CONTRACT_POINTER_PATH || child === fullProductRoot) continue;
      const source = path.join(liveRoot, child);
      const target = path.join(viewRoot, child);
      if (entry.isDirectory() && onPath(child)) mirror(child);
      else if (entry.isDirectory()) { fs.symlinkSync(source, target, 'junction'); links.push(target); }
      else if (entry.isFile()) fs.copyFileSync(source, target);
    }
  };
  mirror('');
  fs.writeFileSync(path.join(viewRoot, CURRENT_CONTRACT_POINTER_PATH), pointerBytes);
  const close = () => {
    for (const link of links) { try { fs.unlinkSync(link); } catch { fs.rmdirSync(link); } }
    if (links.every((link) => !fs.existsSync(link))) fs.rmSync(viewRoot, { recursive: true, force: true });
  };
  return { root: viewRoot, close };
}
const R0006_VIEW = openSealedR0006AuthorityView(ROOT, path.join(os.tmpdir(), 'wheel-gee', `gate26-r0006-authority-view-producer-hostiles-${process.pid}`));
const R0006_ROOT = R0006_VIEW.root;

test.after(() => { fs.rmSync(WORK, { recursive: true, force: true }); R0006_VIEW.close(); });

/* ------------------------------------------------------------------ fixtures */

let cohortCache = null;
const cohort = () => {
  cohortCache ??= prepareRehearsalCohort({
    root: R0006_ROOT, workRoot: path.join(WORK, 'cohort'), queryCount: 300, maxPrefixGroupSize: 16, retainUnits: true,
  });
  return cohortCache;
};

const materialize = (runName, extra = {}) => {
  const prepared = cohort();
  return runPagedMaterialization({
    root: R0006_ROOT, sourcePath: prepared.sourcePath, cohort: prepared.cohort, producer: prepared.producer,
    inputBinding: prepared.seed.inputBinding,
    outputRoot: path.join(WORK, runName, 'product'), checkpointRoot: path.join(WORK, runName, 'checkpoint'),
    ...extra,
  });
};

/** A producer that merely CLAIMS to be the real one. Its outputs are the synthetic ones. */
const impersonatingProducer = () => ({ ...cohort().producer, synthetic: false, productionClass: 'REAL_PRODUCTION' });

/** Deterministic guard sampler, so a threshold test never depends on the host. */
const sampler = (overrides = {}) => () => ({
  atMs: 0,
  rssBytes: 1024,
  heapUsedBytes: 1024,
  externalBytes: 1024,
  cacheEntries: 0,
  ramFreeBytes: 8 * 1024 ** 3,
  diskFreeBytes: 64 * 1024 ** 3,
  ...overrides,
});

const guardWith = (overrides, started = true) => {
  const guard = createResourceBudgetGuard({ root: ROOT, sample: sampler(overrides) });
  if (started) guard.start({ outputRoot: WORK });
  return guard;
};

/* ------------------------------------------- H1: execution intent cannot be bluffed */

test('H1: a synthetic producer under a real execution intent fails closed', () => {
  refusesWith(() => materialize('h1', { executionIntent: REAL_PILOT_INTENT_V1, resourceGuard: guardWith({}) }),
    'REAL_EXECUTION_REQUIRES_REAL_PRODUCER');
  noFullRoot();
});

test('H2: a producer declaring itself real under a rehearsal intent fails closed', () => {
  refusesWith(() => materialize('h2', { producer: impersonatingProducer() }),
    'REAL_PRODUCER_REQUIRES_REAL_EXECUTION_INTENT');
  noFullRoot();
});

test('H3: an unknown or absent execution intent fails closed and is never defaulted to real', () => {
  for (const intent of ['REAL', 'real_pilot', '', null, 'FULL_PRODUCTION']) {
    refusesWith(() => materialize('h3', { executionIntent: intent }), 'EXECUTION_INTENT_INVALID');
  }
  assert.deepEqual([...EXECUTION_INTENTS_V1], [PREBUILD_REHEARSAL_INTENT_V1, REAL_PILOT_INTENT_V1, CANONICAL_FULL_INTENT_V1]);
  noFullRoot();
});

test('H4: the default intent stays PREBUILD_REHEARSAL, so an omitted intent cannot become real', () => {
  const run = materialize('h4');
  assert.equal(run.executionIntent, PREBUILD_REHEARSAL_INTENT_V1);
  assert.equal(run.resourceSnapshot, null);
  noFullRoot();
});

test('H4b: CANONICAL_FULL cannot be bluffed by a synthetic producer or pointed at a non-canonical cohort', () => {
  refusesWith(() => materialize('h4b-synthetic', { executionIntent: CANONICAL_FULL_INTENT_V1, resourceGuard: guardWith({}) }),
    'REAL_EXECUTION_REQUIRES_REAL_PRODUCER');
  refusesWith(() => materialize('h4b-cohort', { executionIntent: CANONICAL_FULL_INTENT_V1, producer: impersonatingProducer(), resourceGuard: guardWith({}) }),
    'CANONICAL_FULL_REQUIRES_CANONICAL_COHORT');
  for (const runName of ['h4b-synthetic', 'h4b-cohort']) assert.equal(fs.existsSync(path.join(WORK, runName, 'product')), false);
  noFullRoot();
});

/* --------------------------------------- H5..H6: a real run cannot run unmeasured */

test('H5: a real execution intent without a resource guard fails closed', () => {
  refusesWith(() => materialize('h5', { executionIntent: REAL_PILOT_INTENT_V1, producer: impersonatingProducer() }),
    'REAL_EXECUTION_REQUIRES_RESOURCE_GUARD');
  noFullRoot();
});

test('H6: a partial guard object is refused rather than silently half-driven', () => {
  const complete = guardWith({});
  for (const missing of ['start', 'beforePair', 'afterPair', 'finalize', 'snapshot']) {
    const partial = { ...complete };
    delete partial[missing];
    refusesWith(() => materialize('h6', { resourceGuard: partial }), 'RESOURCE_GUARD_INCOMPLETE');
  }
  noFullRoot();
});

/* ------------------------------------------- H7..H12: every budget limit fails closed */

test('H7: RSS, heap, external and engine-cache breaches each fail closed with their own code', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  const cases = [
    [{ rssBytes: limits.maximumRssBeforeNextPairBytes + 1 }, 'RESOURCE_RSS_LIMIT_BREACH'],
    [{ heapUsedBytes: limits.maximumHeapUsedBytes + 1 }, 'RESOURCE_HEAP_LIMIT_BREACH'],
    [{ externalBytes: limits.maximumExternalBytes + 1 }, 'RESOURCE_EXTERNAL_LIMIT_BREACH'],
    [{ cacheEntries: limits.maximumEngineCacheEntries + 1 }, 'RESOURCE_ENGINE_CACHE_LIMIT_BREACH'],
  ];
  for (const [overrides, code] of cases) {
    refusesWith(() => guardWith(overrides), code);
  }
  assert.equal(limits.maximumEngineCacheEntries, 128);
});

test('H8: a NEW process below the RAM or disk floor cannot start a run at all', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  // resetFullStartRamPrecondition stands in for a fresh process: a recovery worker, a
  // restart after a kill or a reboot each ask the startup question again.
  resetFullStartRamPrecondition();
  refusesWith(() => guardWith({ ramFreeBytes: limits.minimumRamFreeAtFullStartBytes - 1 }), 'RESOURCE_RAM_FREE_BELOW_MINIMUM');
  assert.equal(fullStartRamPreconditionState(), null, 'a refused startup must not record a passing precondition');
  resetFullStartRamPrecondition();
  refusesWith(() => guardWith({ diskFreeBytes: limits.minimumDiskFreeAtFullStartBytes - 1 }), 'RESOURCE_DISK_FREE_BELOW_MINIMUM');
});

test('H8b: the startup RAM floor is asked once per process and never re-applied mid-run', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  resetFullStartRamPrecondition();

  // The startup question, answered once, on a host that qualifies.
  const first = guardWith({ ramFreeBytes: limits.minimumRamFreeAtFullStartBytes + 1 });
  const startup = first.snapshot().fullStartRamPrecondition;
  assert.equal(startup.appliedAsStartupPrecondition, true);
  assert.equal(startup.observedBytes, limits.minimumRamFreeAtFullStartBytes + 1);

  // A later guard in the SAME process, on a reading far below the floor because this
  // process has since allocated its own working set. This must NOT fail: the floor is
  // a startup precondition, and re-applying it here would fail a run for having
  // allocated exactly what it was budgeted to allocate.
  const later = guardWith({ ramFreeBytes: 1024 });
  const context = later.snapshot().fullStartRamPrecondition;
  assert.equal(context.appliedAsStartupPrecondition, false);
  assert.equal(context.hostContextBytes, 1024);
  assert.equal(context.startupObservedBytes, limits.minimumRamFreeAtFullStartBytes + 1);
  assert.deepEqual(fullStartRamPreconditionState().laterHostContextBytes, [1024]);

  // The continuous limits are untouched by any of this and still bind.
  refusesWith(() => guardWith({ rssBytes: limits.maximumRssBeforeNextPairBytes + 1 }), 'RESOURCE_RSS_LIMIT_BREACH');
  refusesWith(() => guardWith({ heapUsedBytes: limits.maximumHeapUsedBytes + 1 }), 'RESOURCE_HEAP_LIMIT_BREACH');

  // And a genuinely new process asks again.
  resetFullStartRamPrecondition();
  assert.equal(fullStartRamPreconditionState(), null);
  refusesWith(() => guardWith({ ramFreeBytes: limits.minimumRamFreeAtFullStartBytes - 1 }), 'RESOURCE_RAM_FREE_BELOW_MINIMUM');
});

test('H9: an oversized serialized page pair fails closed before the pair is committed', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  const guard = guardWith({});
  refusesWith(() => guard.beforePair({
    pageNumber: 1, pairSerializedBytes: limits.maximumSerializedPagePairBytes + 1, pageElapsedMs: 1,
  }), 'RESOURCE_PAIR_BYTES_LIMIT_BREACH');
});

test('H10: a page pair that exceeds its time budget fails closed', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  const guard = guardWith({});
  refusesWith(() => guard.beforePair({
    pageNumber: 1, pairSerializedBytes: 1024, pageElapsedMs: limits.maximumSinglePagePairMs + 1,
  }), 'RESOURCE_PAGE_TIMEOUT');
  refusesWith(() => guard.afterPair({
    pairSerializedBytes: 1024, pagePairMs: limits.maximumSinglePagePairMs + 1,
  }), 'RESOURCE_PAGE_TIMEOUT');
});

test('H11: a projected FULL runtime or product size over budget fails closed on the projection', () => {
  const limits = loadResourceBudget({ root: ROOT }).limits;
  const budget = loadResourceBudget({ root: ROOT });
  const pages = budget.projection.fullPageCount;

  const slow = guardWith({});
  slow.observePreparation({ elapsedMs: 0 });
  refusesWith(() => slow.afterPair({
    pairSerializedBytes: 1024,
    pagePairMs: Math.ceil(limits.maximumProjectedRuntimeAfterPilotMs / pages) + 1,
  }), 'RESOURCE_PROJECTED_RUNTIME_LIMIT_BREACH');

  const fat = guardWith({});
  fat.observePreparation({ elapsedMs: 0 });
  refusesWith(() => fat.afterPair({
    pairSerializedBytes: Math.ceil(limits.maximumProjectedTotalProductBytes / pages) + 1,
    pagePairMs: 1,
  }), 'RESOURCE_PROJECTED_PRODUCT_BYTES_LIMIT_BREACH');
});

test('H12: an unavailable or malformed measurement is refused, never treated as zero', () => {
  const broken = createResourceBudgetGuard({ root: ROOT, sample: () => { throw new Error('no reading'); } });
  refusesWith(() => broken.start({ outputRoot: WORK }), 'RESOURCE_MEASUREMENT_UNAVAILABLE');
  for (const field of ['rssBytes', 'heapUsedBytes', 'externalBytes', 'cacheEntries', 'ramFreeBytes', 'diskFreeBytes']) {
    refusesWith(() => guardWith({ [field]: null }), 'RESOURCE_MEASUREMENT_INVALID');
    refusesWith(() => guardWith({ [field]: -1 }), 'RESOURCE_MEASUREMENT_INVALID');
  }
  refusesWith(() => createResourceBudgetGuard({ root: ROOT, sample: sampler({}) })
    .beforePair({ pageNumber: 1, pairSerializedBytes: 1, pageElapsedMs: 0 }), 'RESOURCE_GUARD_NOT_STARTED');
});

/* ------------------------------- H13: the accepted budget document cannot be softened */

test('H13: a loosened, reshaped or re-sourced resource budget fails closed', () => {
  const budget = readJson(RESOURCE_BUDGET_PATH_V2);
  const withBinding = (mutate) => {
    const copy = JSON.parse(JSON.stringify(budget));
    mutate(copy);
    const file = path.join(WORK, 'budget', 'GATE26_FULL_RESOURCE_BUDGET_V2.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(copy, null, 2));
    return () => {
      // loadResourceBudget resolves the path under `root`, so a fake root whose only
      // content is the mutated document exercises the loader on those bytes alone.
      // The byte-immutable V1 predecessor rides along unchanged, so the no-loosening proof is exercised too.
      const fakeRoot = path.join(WORK, 'fakeroot');
      const target = path.resolve(fakeRoot, RESOURCE_BUDGET_PATH_V2);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file, target);
      fs.copyFileSync(path.resolve(ROOT, RESOURCE_BUDGET_PATH_V1), path.resolve(fakeRoot, RESOURCE_BUDGET_PATH_V1));
      return loadResourceBudget({ root: fakeRoot });
    };
  };

  assert.equal(withBinding(() => {})().fullGenerationAuthorized, true);
  refusesWith(withBinding((b) => { b.fullGenerationAuthorized = false; }), 'RESOURCE_BUDGET_BINDING_INVALID');
  refusesWith(withBinding((b) => { b.bindingId = 'GATE26_FULL_RESOURCE_BUDGET_V1'; }), 'RESOURCE_BUDGET_BINDING_INVALID');
  refusesWith(withBinding((b) => { b.supersedes.sha256 = 'e'.repeat(64); }), 'RESOURCE_BUDGET_BINDING_INVALID');
  refusesWith(withBinding((b) => { b.limits.maximumRssBeforeNextPairBytes *= 2; }), 'RESOURCE_BUDGET_THRESHOLD_LOOSENING_FORBIDDEN');
  refusesWith(withBinding((b) => { b.limits.minimumRamFreeAtFullStartBytes -= 1; }), 'RESOURCE_BUDGET_THRESHOLD_LOOSENING_FORBIDDEN');
  refusesWith(withBinding((b) => { b.limits.absoluteMaximumRuntimeMs += 1; }), 'RESOURCE_BUDGET_THRESHOLD_LOOSENING_FORBIDDEN');
  refusesWith(withBinding((b) => { b.source = 'HOST_OBSERVATION'; }), 'RESOURCE_BUDGET_BINDING_INVALID');
  refusesWith(withBinding((b) => { b.measurementPolicy.hostObservationsAreAuthority = true; }), 'RESOURCE_BUDGET_MEASUREMENT_POLICY_INVALID');
  refusesWith(withBinding((b) => { b.measurementPolicy.thresholdLooseningInThisMission = 'ALLOWED'; }), 'RESOURCE_BUDGET_MEASUREMENT_POLICY_INVALID');
  refusesWith(withBinding((b) => { b.measurementPolicy.stopBeforeNextPair = false; }), 'RESOURCE_BUDGET_MEASUREMENT_POLICY_INVALID');
  refusesWith(withBinding((b) => { delete b.limits.maximumUniverseFullScanCount; }), 'RESOURCE_BUDGET_LIMITS_NOT_CLOSED');
  refusesWith(withBinding((b) => { b.limits.extraHeadroomBytes = 1; }), 'RESOURCE_BUDGET_LIMITS_NOT_CLOSED');
  refusesWith(withBinding((b) => { b.limits.maximumRssBeforeNextPairBytes = 0; }), 'RESOURCE_BUDGET_LIMIT_INVALID');
  refusesWith(withBinding((b) => { b.projection.fullPageCount = 537; }), 'RESOURCE_BUDGET_PROJECTION_INVALID');
  refusesWith(withBinding((b) => { b.projection.horizonSessionCounts = [30, 90, 180]; }), 'RESOURCE_BUDGET_PROJECTION_INVALID');
});

/* ----------------------- H14..H16: the producer identity binding cannot be substituted */

test('H14: the published producer binding verifies against the bytes actually on disk', () => {
  const verified = verifyProducerIdentity({ root: ROOT });
  assert.equal(verified.verified, true);
  const binding = readJson(PRODUCER_BINDING_PATH_V2);
  assert.equal(binding.producerId, REAL_PRODUCER_ID_V1);
  assert.equal(binding.synthetic, false);
  assert.equal(binding.productionClass, 'REAL_PRODUCTION');
  assert.equal(binding.bindingId, 'GATE26_FULL_PRODUCTION_PRODUCER_V2');
  assert.equal(binding.bindings.fullGenerationAuthorized, true);
  assert.equal(binding.bindings.executionIntent, 'CANONICAL_FULL');
  assert.equal(binding.bindings.resourceBudgetPath, RESOURCE_BUDGET_PATH_V2);
  // The pilot-era V1 binding stays byte-immutable, pilot-only, and is no longer what the producer loads.
  assert.equal(readJson(PRODUCER_BINDING_PATH_V1).bindings.fullGenerationAuthorized, false);
  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: readJson(PRODUCER_BINDING_PATH_V1) }), 'REAL_PRODUCER_BINDING_INVALID');
  assert.equal(binding.bindings.networkAuthorized, false);
  assert.equal(binding.bindings.yahooAuthorized, false);
  assert.ok(binding.dependencies.length > 0 && binding.frozenInputs.length > 0);
});

test('H15: a substituted dependency digest or a tampered identity digest fails closed', () => {
  const binding = readJson(PRODUCER_BINDING_PATH_V2);
  const mutated = (mutate) => { const copy = JSON.parse(JSON.stringify(binding)); mutate(copy); return copy; };

  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.dependencies[0].sha256 = 'f'.repeat(64); }),
  }), 'REAL_PRODUCER_DEPENDENCY_IDENTITY_MISMATCH');

  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.frozenInputs[0].sha256 = '0'.repeat(64); }),
  }), 'REAL_PRODUCER_DEPENDENCY_IDENTITY_MISMATCH');

  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.dependencies[0].byteLength += 1; }),
  }), 'REAL_PRODUCER_DEPENDENCY_IDENTITY_MISMATCH');

  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.producerIdentitySha256 = 'a'.repeat(64); }),
  }), 'REAL_PRODUCER_IDENTITY_DIGEST_MISMATCH');

  // Rewriting a binding field WITHOUT recomputing the digest must not pass either:
  // the digest covers the bindings block, not only the file lists.
  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.bindings.networkAuthorized = true; }),
  }), 'REAL_PRODUCER_IDENTITY_DIGEST_MISMATCH');
  // A V2 binding stripped of its FULL authorization is refused outright, digest or not.
  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.bindings.fullGenerationAuthorized = false; }),
  }), 'REAL_PRODUCER_BINDING_INVALID');

  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.dependencies.push({ path: 'nope.mjs', sha256: 'b'.repeat(64), byteLength: 1, role: 'X' }); }),
  }), 'REAL_PRODUCER_DEPENDENCY_ABSENT');
});

test('H16: a producer binding that declares itself synthetic, foreign or non-closed fails closed', () => {
  const binding = readJson(PRODUCER_BINDING_PATH_V2);
  const mutated = (mutate) => { const copy = JSON.parse(JSON.stringify(binding)); mutate(copy); return copy; };

  for (const mutate of [
    (b) => { b.synthetic = true; },
    (b) => { b.productionClass = 'PREBUILD_SYNTHETIC'; },
    (b) => { b.producerId = 'GATE26_PREBUILD_SYNTHETIC_SELECTION_PRODUCER_V1'; },
    (b) => { b.identityAlgorithm = 'NONE'; },
    (b) => { b.gateId = 'GATE25'; },
    (b) => { b.document = 'SOMETHING_ELSE'; },
  ]) {
    refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: mutated(mutate) }), 'REAL_PRODUCER_BINDING_INVALID');
  }

  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: mutated((b) => { b.extra = 1; }) }), 'REAL_PRODUCER_BINDING_NOT_CLOSED');
  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: mutated((b) => { delete b.bindings; }) }), 'REAL_PRODUCER_BINDING_NOT_CLOSED');
  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: mutated((b) => { b.dependencies = []; }) }), 'REAL_PRODUCER_DEPENDENCIES_INVALID');
  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: mutated((b) => { b.frozenInputs = []; }) }), 'REAL_PRODUCER_FROZEN_INPUTS_INVALID');
  refusesWith(() => verifyProducerIdentity({
    root: ROOT,
    binding: mutated((b) => { b.dependencies[1] = { ...b.dependencies[1], path: b.dependencies[0].path }; }),
  }), 'REAL_PRODUCER_DEPENDENCIES_INVALID');
});

/* ------------------------- H17: the run's code identity binds the real producer set */

test('H17: the FULL code identity binds the real producer and its two documents, and refuses a missing member', () => {
  for (const required of [
    'governance/gates/GATE26/implementation/full-production-producer-v1.mjs',
    'governance/gates/GATE26/contracts/GATE26_FULL_PRODUCTION_PRODUCER_V2.json',
    'governance/gates/GATE26/contracts/GATE26_FULL_RESOURCE_BUDGET_V2.json',
  ]) {
    assert.ok(FULL_CODE_IDENTITY_PATHS_V1.includes(required), `code identity must bind ${required}`);
  }
  const identity = computeCodeIdentity({ root: ROOT });
  assert.equal(identity.files.length, FULL_CODE_IDENTITY_PATHS_V1.length);

  // A root missing one member cannot produce a code identity at all.
  const emptyRoot = path.join(WORK, 'emptyroot');
  fs.mkdirSync(emptyRoot, { recursive: true });
  refusesWith(() => computeCodeIdentity({ root: emptyRoot }), 'FULL_CODE_IDENTITY_MEMBER_ABSENT');
});

/* ------------------------------------ H18: no FULL bytes, no network, no Yahoo, ever */

test('H18: a real execution intent still cannot write into the canonical FULL root', () => {
  // Historical R0006 authority: root and FULL target are both taken from the sealed view.
  refusesWith(() => runPagedMaterialization({
    root: R0006_ROOT, sourcePath: cohort().sourcePath, cohort: cohort().cohort, producer: impersonatingProducer(),
    inputBinding: cohort().seed.inputBinding,
    outputRoot: path.join(R0006_ROOT, CONTRACT.packagingRequirements.fullProductRoot, 'attack'), checkpointRoot: path.join(WORK, 'h18', 'checkpoint'),
    executionIntent: REAL_PILOT_INTENT_V1, resourceGuard: guardWith({}),
  }), 'R0003_FULL_PRODUCT_WRITE_FORBIDDEN');
  // R0007: against the live repository the consumed authority refuses the attempt before anything else.
  refusesWith(() => runPagedMaterialization({
    root: ROOT, sourcePath: cohort().sourcePath, cohort: cohort().cohort, producer: impersonatingProducer(),
    inputBinding: cohort().seed.inputBinding,
    outputRoot: path.join(FULL_ROOT, 'attack'), checkpointRoot: path.join(WORK, 'h18-live', 'checkpoint'),
    executionIntent: CANONICAL_FULL_INTENT_V1, resourceGuard: guardWith({}),
  }), 'CURRENT_CONTRACT_NOT_R0006');
  assert.ok(!fs.existsSync(path.join(FULL_ROOT, 'attack')) && !fs.existsSync(path.join(WORK, 'h18-live')));
  noFullRoot();
});

test('H20: disk free is measured on the volume that will host the target, and never by creating it', () => {
  // These cases use the REAL sampler, so they exercise the actual disk measurement
  // rather than the deterministic stub. The startup RAM question is already answered
  // for this process by the tests above, so a real reading here is host context and
  // cannot make these cases pass or fail for the wrong reason.
  const realGuard = (outputRoot) => createResourceBudgetGuard({ root: ROOT }).start({ outputRoot });
  const startedOnQualifiedHost = () => {
    resetFullStartRamPrecondition();
    guardWith({});
  };
  startedOnQualifiedHost();

  // 1. The intended output root already exists: measure that volume.
  const existing = path.join(WORK, 'disk', 'exists');
  fs.mkdirSync(existing, { recursive: true });
  const onExisting = realGuard(existing);
  assert.ok(onExisting.diskFreeAtStartBytes > 0);

  // 2. Absent target, parent exists: resolve the nearest existing ancestor.
  const absentChild = path.join(existing, 'not-created-yet');
  assert.equal(fs.existsSync(absentChild), false);
  const onAbsentChild = realGuard(absentChild);
  assert.equal(onAbsentChild.diskFreeAtStartBytes, onExisting.diskFreeAtStartBytes,
    'the nearest existing ancestor is on the same volume, so the reading must match');

  // 3. Several absent descendants: walk upward deterministically to the same answer.
  const deeplyAbsent = path.join(existing, 'a', 'b', 'c', 'd');
  assert.equal(fs.existsSync(deeplyAbsent), false);
  const onDeep = realGuard(deeplyAbsent);
  assert.equal(onDeep.diskFreeAtStartBytes, onExisting.diskFreeAtStartBytes);

  // 5. Measuring must never create the future output directory.
  assert.equal(fs.existsSync(absentChild), false, 'measurement created the target');
  assert.equal(fs.existsSync(deeplyAbsent), false, 'measurement created the target');
  assert.equal(fs.existsSync(path.join(existing, 'a')), false, 'measurement created an intermediate directory');

  // 4. No valid existing ancestor at all: fail closed rather than guess a volume.
  refusesWith(() => realGuard('Z:/no-such-volume/deeper'), 'RESOURCE_MEASUREMENT_UNAVAILABLE');
  assert.equal(fs.existsSync('Z:/no-such-volume'), false);

  // 6. None of this may bring the canonical FULL root into existence.
  noFullRoot();
});

test('H21: the product ceiling is the Owner-decided one, the projection method is unchanged, and the boundary is exact', () => {
  const budget = loadResourceBudget({ root: ROOT });
  const limits = budget.limits;

  // The exact ceiling this candidate now runs under, and the superseded one.
  const SUPERSEDED_CEILING = 1115720698;
  const OWNER_CEILING = 1200000000;
  assert.equal(limits.maximumProjectedTotalProductBytes, OWNER_CEILING);
  assert.notEqual(limits.maximumProjectedTotalProductBytes, SUPERSEDED_CEILING,
    'the superseded ceiling must not still be live candidate truth');

  // The method is the conservative maximum-observed one. Raising the ceiling was the
  // Owner's decision; quietly swapping in an average or a percentile would not have
  // been, and this pins that it did not happen.
  assert.equal(budget.projection.productBytesMethod, 'MAX_OBSERVED_PAGE_PAIR_BYTES_TIMES_536_PLUS_SCALED_MANIFEST_BYTES');
  assert.equal(budget.projection.fullPageCount, 536);
  assert.equal(budget.projection.runtimeMethod, 'PREPARATION_ONCE_PLUS_MAX_OBSERVED_PAGE_PAIR_MS_TIMES_536');

  // Every other threshold is byte-for-byte what it was. Only one number moved.
  assert.deepEqual(
    Object.fromEntries(Object.entries(limits).filter(([k]) => k !== 'maximumProjectedTotalProductBytes')),
    {
      minimumRamFreeAtFullStartBytes: 4294967296,
      maximumRssBeforeNextPairBytes: 1610612736,
      maximumHeapUsedBytes: 1073741824,
      maximumExternalBytes: 268435456,
      maximumEngineCacheEntries: 128,
      maximumSerializedPagePairBytes: 3145728,
      minimumDiskFreeAtFullStartBytes: 8589934592,
      maximumProjectedRuntimeAfterPilotMs: 5400000,
      absoluteMaximumRuntimeMs: 10800000,
      maximumSinglePagePairMs: 60000,
      maximumUniverseFullScanCount: 3,
    },
  );

  // The boundary, driven through the real guard rather than asserted arithmetically.
  const pages = budget.projection.fullPageCount;
  const largestFittingPair = Math.floor(OWNER_CEILING / pages);      // 2238805 -> 1199999480
  const firstBreachingPair = largestFittingPair + 1;                  // 2238806 -> 1200000016
  assert.ok(largestFittingPair * pages <= OWNER_CEILING);
  assert.ok(firstBreachingPair * pages > OWNER_CEILING);
  // Both sit under the per-pair limit, so it is the product ceiling being tested here.
  assert.ok(firstBreachingPair <= limits.maximumSerializedPagePairBytes);

  const project = (pairBytes) => {
    const guard = guardWith({});
    guard.observePreparation({ elapsedMs: 0 });
    return guard.afterPair({ pairSerializedBytes: pairBytes, pagePairMs: 1 });
  };
  assert.equal(project(largestFittingPair).projectedTotalProductBytes, largestFittingPair * pages);
  refusesWith(() => project(firstBreachingPair), 'RESOURCE_PROJECTED_PRODUCT_BYTES_LIMIT_BREACH');

  // The measurement that breached the superseded ceiling now fits, which is exactly
  // what the Owner decided and nothing more.
  const PREVIOUSLY_BREACHING_PAIR = 2115839;
  assert.ok(PREVIOUSLY_BREACHING_PAIR * pages > SUPERSEDED_CEILING);
  assert.ok(PREVIOUSLY_BREACHING_PAIR * pages <= OWNER_CEILING);
  assert.equal(project(PREVIOUSLY_BREACHING_PAIR).projectedTotalProductBytes, 1134089704);
});

test('H22: raising the ceiling in the binding without recomputing identity fails closed', () => {
  // A budget edited on disk must break the producer identity that pins its bytes, so
  // a silent loosening cannot ride along inside a candidate that still claims to be
  // the audited one.
  const binding = readJson(PRODUCER_BINDING_PATH_V2);
  const budgetEntry = binding.frozenInputs.find((e) => e.path === RESOURCE_BUDGET_PATH_V2);
  assert.ok(budgetEntry, 'the resource budget must be a pinned frozen input');

  const tampered = JSON.parse(JSON.stringify(binding));
  tampered.frozenInputs.find((e) => e.path === RESOURCE_BUDGET_PATH_V2).sha256 = 'c'.repeat(64);
  refusesWith(() => verifyProducerIdentity({ root: ROOT, binding: tampered }), 'REAL_PRODUCER_DEPENDENCY_IDENTITY_MISMATCH');

  // And the binding as published does verify against the budget bytes now on disk.
  assert.equal(verifyProducerIdentity({ root: ROOT }).verified, true);
  assert.equal(budgetEntry.sha256, sha256OfFile(RESOURCE_BUDGET_PATH_V2));
});

test('H19: no network call and no Yahoo access was attempted by any of these tests', () => {
  assert.deepEqual(networkCalls, []);
  noFullRoot();
});

/* ------------- H23: the canonical FULL process runs under a V8 heap bounded below the budget */

/**
 * GATE26_FULL_BUILD_HEAP_GROWTH_DIAGNOSIS_AND_REPAIR_R1. Canonical build R1 stopped with
 * RESOURCE_HEAP_LIMIT_BREACH at pair 163. Measured over 220 real pairs, the retained live set
 * after a full GC is flat (~312 MB); what crossed 1 GiB was collectable garbage, because the
 * default V8 ceiling on the host (~4.5 GB) lets V8 defer full collections far past the budget's
 * heapUsed limit, and the guard samples heapUsed without forcing a GC. The repair is the launch
 * contract below, not code: every FULL code-identity member stays byte-identical, so the R1
 * checkpoint run identity and its committed pairs remain resumable. Under these flags V8's hard
 * ceiling sits below maximumHeapUsedBytes, so a sampled heapUsed cannot reach the limit; V8
 * collects first, and a genuine live-set overflow aborts the process instead (resumable).
 */
export const GOVERNED_CANONICAL_FULL_NODE_FLAGS = Object.freeze(['--max-old-space-size=960', '--max-semi-space-size=16']);

const runChild = (flags, source) => {
  const child = spawnSync(process.execPath, [...flags, '-e', source], { encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
};
const runBoundedChild = (source) => runChild(GOVERNED_CANONICAL_FULL_NODE_FLAGS, source);

test('H23: the governed launch flags put the V8 hard heap ceiling below the budget heapUsed limit', () => {
  const { maximumHeapUsedBytes } = loadResourceBudget({ root: ROOT }).limits;
  const { heapSizeLimit } = runBoundedChild("process.stdout.write(JSON.stringify({ heapSizeLimit: require('v8').getHeapStatistics().heap_size_limit }))");
  assert.ok(heapSizeLimit < maximumHeapUsedBytes, `V8 ceiling ${heapSizeLimit} must stay below ${maximumHeapUsedBytes}`);
  // The flags only bound the process; they are not a code-identity member and change no page byte.
  for (const member of FULL_CODE_IDENTITY_PATHS_V1) assert.ok(!member.includes('flags'), member);
});

test('H23b: under the governed flags, a garbage-heavy workload over a stable live set never samples heapUsed at the limit', () => {
  const { maximumHeapUsedBytes } = loadResourceBudget({ root: ROOT }).limits;
  // ~312 MB retained (the measured canonical live set), plus page-lifetime garbage: each page's
  // objects outlive a few pages (so they are promoted to old space, as page records are) and then
  // die. heapUsed is sampled without any forced GC, exactly as the resource guard samples.
  const workload = `
    const live = []; for (let i = 0; i < 312; i += 1) live.push(new Array(131072).fill(i));
    const ring = new Array(4).fill(null); let maxHeapUsed = 0;
    for (let page = 0; page < 300; page += 1) {
      const block = []; for (let j = 0; j < 8; j += 1) block.push(Array.from({ length: 16384 }, (_, k) => ({ page, j, k })));
      ring[page % 4] = block;
      maxHeapUsed = Math.max(maxHeapUsed, process.memoryUsage().heapUsed);
    }
    process.stdout.write(JSON.stringify({ maxHeapUsed, liveBlocks: live.length }));
  `;
  const bounded = runBoundedChild(workload);
  assert.equal(bounded.liveBlocks, 312);
  assert.ok(bounded.maxHeapUsed < maximumHeapUsedBytes, `sampled heapUsed ${bounded.maxHeapUsed} must stay below ${maximumHeapUsedBytes}`);
  // Non-vacuity: under a wide ceiling like the host default, the SAME workload samples past the
  // limit with no retention at all. That is the R1 failure shape the governed flags remove.
  const unbounded = runChild(['--max-old-space-size=4096'], workload);
  assert.ok(unbounded.maxHeapUsed >= maximumHeapUsedBytes, `control must cross the limit, observed ${unbounded.maxHeapUsed}`);
});
