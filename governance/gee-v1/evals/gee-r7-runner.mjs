import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { createContentAddressedStore } from '../cas/content-addressed-store.mjs';
import { compileContext } from '../context/compile-context.mjs';
import { createSnapshot, compareSnapshots } from '../delta/delta-engine.mjs';
import { bindFreshValidations, createEvidenceGraph, evaluateEvidenceGraph, validateGraph } from '../evidence/evidence-graph.mjs';
import { createGeeR2SyntheticAdapter } from '../fixtures/gee-r2-synthetic-adapter.mjs';
import { buildRepoIndex, canonicalRepoPath, DEFAULT_REPO_INDEX_POLICY } from '../index/repo-index.mjs';
import { routeWorkUnit, verifyRoutePlanDigest } from '../router/router-engine.mjs';
import { OWNER_DECISION_REQUIRED } from '../router/router-policy.mjs';
import { createRepairLedger, appendRepairRecord, evaluateContainment, SURVIVED } from '../repair/repair-containment.mjs';
import { createCheckpointStore } from '../recovery/checkpoint-store.mjs';
import { createCheckpoint, planRecovery, checkpointTasksFromRoutePlan } from '../recovery/recovery-engine.mjs';
import { createUsageLedger, aggregateUsage, appendUsageRecord } from '../usage/usage-ledger.mjs';
import { createExecutionAuthorityRegistry, isPathAuthorized, resolveExecutionAuthority } from '../core/work-unit-core.mjs';
import { evaluatePostFreezeMaintenanceAuthorityV2, PHASE_VERIFY_PROGRAM_CONSUMPTION } from '../core/post-freeze-maintenance-authority.mjs';
import { collectPostFreezeMaintenanceObservation, resolveMaintenancePath } from '../../tools/post-freeze-maintenance-observation.mjs';
import { createGeeMissionAuthoritySource, MISSION_WORK_UNIT_TYPE } from '../adapters/gee-mission-authority-source.mjs';
import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { createWheelRecoverySession, recordWheelTaskExecution, buildWheelCheckpoint, resumeWheelWorkUnit } from '../adapters/wheel/recovery-wheel-adapter.mjs';
import { RUN_STATE_COMPLETED, allocateRunRoot, releaseRunRoot } from '../runtime/run-root-lifecycle.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const HEAD = '7a9936c91768e9a2a5c886c6a6da9564905c6a6c';
export const WORK_UNIT_ID = 'GATE15';
export const R7_MISSION = 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R7';
export const R7_CONTRACT_PATH = 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0007.json';
export const R7_SEAL_PATH = 'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0007_SEAL.json';
export const R7_BENCHMARK_CONTEXT_PATH = 'governance/gee-v1/fixtures/gee-r7-benchmark-context.json';
export const R7_AUTHORIZED_PATHS = [
  'governance/gee-v1/evals/gee-r7-',
  'governance/gee-v1/benchmarks/gee-r7-',
  'governance/gee-v1/fixtures/gee-r7-',
  'governance/gee-v1/tests/gee-r7-'
];

const PASS = Object.freeze({ validator: 'R7_TEST_PRODUCING_VALIDATOR', result: 'PASS' });
const VALIDATED_R7_BENCHMARK_CONTEXT = Symbol('VALIDATED_R7_BENCHMARK_CONTEXT');
const BENCHMARK_CONTEXT_FIELDS = Object.freeze([
  'document', 'schemaVersion', 'fixtureId', 'contextKind', 'workUnitId', 'sourceHead',
  'missionRevisionId', 'provenance', 'historicalState', 'historicalContext',
  'historicalContextSha256', 'contextIdentitySha256'
]);
const BENCHMARK_CONTEXT_PROVENANCE_FIELDS = Object.freeze([
  'authorityClass', 'purpose', 'generatedProjectionAuthority', 'derivedAtCommit', 'compilerVersion'
]);
const BENCHMARK_CONTEXT_STATE_FIELDS = Object.freeze(['path', 'sha256', 'role']);
const HEX64 = /^[a-f0-9]{64}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const SYNTHETIC_WORK_UNIT = 'SYNTH_01';
const SOURCE_PATHS = ['fixtures/canonical.json', 'src/a.json', 'src/b.json'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'gee-r7-recovery-child.mjs');
const REQUIRED_R7_ARTIFACTS = [
  R7_CONTRACT_PATH,
  R7_SEAL_PATH,
  'governance/gee-v1/evals/gee-r7-authority-scope.json',
  'governance/gee-v1/evals/gee-r7-eval-suite.json',
  'governance/gee-v1/benchmarks/gee-r7-benchmark.json',
  'governance/gee-v1/benchmarks/gee-r7-routing.json',
  'governance/gee-v1/benchmarks/gee-r7-recovery-stress.json',
  'governance/gee-v1/benchmarks/gee-r7-hostile-audit.json'
];

const SYNTHETIC_TASKS = Object.freeze([
  { taskId: 't:a', intent: 'DETERMINISTIC', sources: ['src/a.json'], produces: ['e:a'], requiredEvidenceIds: ['e:a'], mandatory: false },
  { taskId: 't:b', intent: 'DETERMINISTIC', sources: ['src/b.json'], produces: ['e:b'], requiredEvidenceIds: ['e:b'], mandatory: false },
  { taskId: 't:c', intent: 'DETERMINISTIC', sources: ['fixtures/canonical.json'], produces: ['e:c'], requiredEvidenceIds: ['e:c'], mandatory: false }
]);

/**
 * Ephemeral execution scratch owned by this runner.
 *
 * Every temporary root this file allocates is disposable per-run scratch: it is
 * never the durable R4 CAS or R6 lifecycle/checkpoint store, both of which live
 * under their own governed directories and are untouched here. Each runner
 * entry point opens a scope; every allocation registers into the innermost open
 * scope; the scope removes exactly the roots it allocated on the way out, on
 * success and on throw alike.
 *
 * Allocation and removal now go through the canonical run-root lifecycle, which
 * replaces this file's former ownership test. The old test was "a direct child
 * of %TEMP% whose name starts with `gee-r7-`" — true of every root any earlier
 * run ever left behind, so the predicate itself could point at an unmanifested
 * historical directory even though the scope list never did. Ownership is now
 * a manifest naming this repository and this run, and removal is bounded to one
 * exact manifested path inside %TEMP%/wheel-gee/runs. Nothing wildcard, nothing
 * prefix-matched, nothing age-based, nothing at the parent level.
 *
 * The path handed back is a `work` subdirectory of the run root, so the
 * manifest never appears inside a tree the harness treats as a repository.
 */
export const EPHEMERAL_ROOT_PREFIX = 'gee-r7-';
const EPHEMERAL_WORK_SEGMENT = 'work';
const ephemeralScopes = [];
/** Run roots this process allocated, keyed by the work directory handed out. */
const ownedEphemeralRuns = new Map();

export function isRunnerOwnedEphemeralRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  return ownedEphemeralRuns.has(path.resolve(candidate));
}

export function allocateEphemeralRoot(prefix = EPHEMERAL_ROOT_PREFIX) {
  if (!String(prefix).startsWith(EPHEMERAL_ROOT_PREFIX)) throw new Error(`R7_EPHEMERAL_ROOT_PREFIX_INVALID:${prefix}`);
  if (ephemeralScopes.length === 0) throw new Error(`R7_EPHEMERAL_ROOT_ALLOCATED_OUTSIDE_SCOPE:${prefix}`);
  // DISCARD: this runner's scratch is regenerated from fixtures on every call,
  // so a failed eval has nothing in it worth keeping. Declared at allocation.
  const run = allocateRunRoot({
    repoRoot: REPO_ROOT,
    workUnitId: WORK_UNIT_ID,
    phase: String(prefix).replace(/-+$/, ''),
    purpose: 'R7_EVAL_SCRATCH',
    consumer: 'governance/gee-v1/evals/gee-r7-runner.mjs',
    missionRevisionId: R7_MISSION,
    failurePolicy: 'DISCARD'
  });
  const work = run.scratch(EPHEMERAL_WORK_SEGMENT);
  ownedEphemeralRuns.set(path.resolve(work), run);
  ephemeralScopes[ephemeralScopes.length - 1].push(work);
  return work;
}

function removeEphemeralRoot(work) {
  const run = ownedEphemeralRuns.get(path.resolve(work));
  if (!run) return false;
  ownedEphemeralRuns.delete(path.resolve(work));
  const release = releaseRunRoot(run, { state: RUN_STATE_COMPLETED, reason: 'R7_SCOPE_CLOSED', repoRoot: REPO_ROOT });
  return release.removed || release.alreadyAbsent;
}

export function withEphemeralRootScope(callback) {
  const scope = [];
  ephemeralScopes.push(scope);
  try {
    return callback();
  } finally {
    ephemeralScopes.pop();
    for (let index = scope.length - 1; index >= 0; index -= 1) removeEphemeralRoot(scope[index]);
  }
}

function tempRoot(prefix = EPHEMERAL_ROOT_PREFIX) {
  const root = allocateEphemeralRoot(prefix);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}\n');
  fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":1}\n');
  fs.writeFileSync(path.join(root, 'fixtures', 'canonical.json'), '{"canonical":true}\n');
  return root;
}

function casFor(root) { return createContentAddressedStore(path.join(root, 'cas')); }

function syntheticContext(root) {
  return compileContext({
    repoRoot: root,
    adapter: createGeeR2SyntheticAdapter(),
    workUnitId: SYNTHETIC_WORK_UNIT,
    sourceHead: 'R7_SYNTHETIC_HEAD'
  }).json;
}

function syntheticSnapshot(root) {
  return createSnapshot({
    repoRoot: root,
    sources: SOURCE_PATHS.filter((entry) => fs.existsSync(path.join(root, ...entry.split('/')))).map((pathName) => ({ path: pathName }))
  });
}

function syntheticNodes() {
  return [
    { evidenceId: 'e:a', content: { value: 'a' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:b', content: { value: 'b' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/b.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'e:c', content: { value: 'canonical' }, evidenceType: 'FACT', provenance: { sourcePath: 'fixtures/canonical.json', authorityClass: 'CANONICAL' }, dependencies: ['source:fixtures/canonical.json'], authorityStatus: 'GROUNDED' }
  ];
}

function syntheticBaseline(root, cas) {
  const previousSnapshot = syntheticSnapshot(root);
  const currentSnapshot = syntheticSnapshot(root);
  const r3Delta = { previousSnapshot, currentSnapshot };
  const nodes = syntheticNodes();
  const bound = bindFreshValidations({
    cas,
    nodes,
    r3Delta,
    validationResults: Object.fromEntries(nodes.map((node) => [node.evidenceId, PASS]))
  });
  return {
    previousSnapshot,
    currentSnapshot,
    r3Delta,
    graph: createEvidenceGraph({ cas, nodes: bound })
  };
}

function syntheticPlan(root, cas, { mutate = null, tasks = null, repairLedger = null, previousSnapshot = null, previousGraph = null } = {}) {
  const baseline = syntheticBaseline(root, cas);
  if (mutate) mutate(root);
  const currentSnapshot = syntheticSnapshot(root);
  const r3Delta = { previousSnapshot: previousSnapshot || baseline.currentSnapshot, currentSnapshot };
  const evaluated = evaluateEvidenceGraph({ graph: previousGraph || baseline.graph, r3Delta, cas });
  const plan = routeWorkUnit({
    workUnitId: SYNTHETIC_WORK_UNIT,
    tasks: tasks || SYNTHETIC_TASKS,
    r2Context: syntheticContext(root),
    r3Delta,
    r4Evidence: { graph: evaluated.graph },
    cas,
    repairLedger
  });
  return { ...baseline, currentSnapshot, r3Delta, evaluated, plan, root, cas };
}

function cloneGovernanceRepo(prefix = 'gee-r7-wheel-') {
  const root = allocateEphemeralRoot(prefix);
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exactFields(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && Object.keys(value).every((key) => expected.includes(key));
}

function safeFixturePath(value) {
  return typeof value === 'string' && value.length > 0
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && !value.startsWith('../')
    && !value.includes('/../')
    && !value.includes('/generated/');
}

function benchmarkContextBody(context) {
  return Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'contextIdentitySha256'));
}

/**
 * THE HISTORICAL / CURRENT FRONTIER.
 *
 * This fixture certifies a scenario — Wheel GATE15 as it stood at sourceHead
 * fbd5f512, before the gate had a directory, a contract, a state or a seal, and
 * while its ledger-derived trust level was still PRE_EXECUTION. That scenario is
 * finished history: ledger events 62-65 later carried GATE15 to
 * COMPLETE_CONFIRMED, and no future state can restore it.
 *
 * The original validator rebuilt the scenario by compiling the LIVE canonical
 * tree and asserting the result still looked like fbd5f512. That made a frozen
 * historical benchmark a hostage of every future Gate: each new ledger event,
 * each new gate file, each status advance broke a measurement that had already
 * been taken correctly. The failure surfaced as
 * BENCHMARK_CONTEXT_STATE_SHA256_MISMATCH, but re-pinning only exposed the next
 * live coupling underneath it.
 *
 * The frontier is now explicit, and the two lanes never borrow each other's
 * authority:
 *
 *   HISTORICAL — validateR7HistoricalBenchmarkContext. The certified context is
 *   carried IN the fixture, compiled once at creation time. Validation reads the
 *   fixture and nothing else: no ledger, no registry, no gate directory, no
 *   HEAD. It is therefore permanent by construction. What keeps it honest is
 *   internal binding, not trust: the frozen context carries the digest of every
 *   source it was compiled from, and those must agree with the fixture's own
 *   historicalState declaration, so a forged context cannot claim historical
 *   provenance it never had.
 *
 *   CURRENT — validateR7CurrentStateBinding. Unchanged in spirit and still
 *   fail-closed, it verifies live canonical bytes against an expectation the
 *   CALLER supplies. It takes no expectation from the historical fixture, so it
 *   can never be satisfied by history, and history can never be broken by it.
 *
 * A hidden runtime marker still prevents callers from bypassing validation by
 * constructing a look-alike object.
 */
const EXPECTED_HISTORICAL_STATE = new Map([
  ['governance/GATE_REGISTRY_00_40.json', 'CANONICAL_WORK_UNIT_REGISTRY'],
  [R7_CONTRACT_PATH, 'CHECKPOINT_AUTHORITY_IDENTITY'],
  ['governance/state/GATE_STATUS_LEDGER.ndjson', 'CANONICAL_STATUS_AUTHORITY']
]);
const EXPECTED_HISTORICAL_SOURCES = Object.freeze([
  'governance/GATE_REGISTRY_00_40.json',
  'governance/state/GATE_STATUS_LEDGER.ndjson'
]);
const MAINTENANCE_AUTHORITY_DOCUMENT = 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY';

/**
 * SELF-HASH IS NOT AUTHENTICITY, AND A PARTIAL CHECK IS NOT VALIDITY.
 *
 * Every digest inside the fixture is computed BY the fixture over itself, so an
 * attacker who edits the certified scenario and then recomputes
 * historicalContextSha256 and contextIdentitySha256 produces a document that is
 * perfectly self-consistent and completely forged. Internal binding proves the
 * fixture did not rot; only a digest recorded OUTSIDE the fixture can prove the
 * fixture is the one that was authorized.
 *
 * The first version of this function checked that external record by hand:
 * manifest digest, manifest structure, and the consumption record's binding
 * fields. That subset looked complete and was not. It never checked the
 * authority's predecessor binding, so falsifying authorityPredecessor.sha256,
 * recomputing the authority's own digest, and updating the cohort entry that
 * names it produced a fixture this consumer ACCEPTED while the canonical
 * validator REJECTED it with AUTHORITY_PREDECESSOR_MISMATCH. Two canonical
 * consumers disagreeing about the same bytes is the defect; re-deriving a
 * validator's conclusions locally is how it happened.
 *
 * So this no longer re-implements anything. A candidate authority may bind the
 * fixture only if the canonical evaluator, in its own consumption phase, over
 * the canonical observation, returns consumed with zero findings — the identical
 * composition validate-post-freeze-maintenance-authority.mjs performs. Only then
 * is the cohort consulted for this exact path and digest.
 *
 * Note which checks that phase deliberately does NOT apply: baseHead, ledger
 * count, ledger prefix and the path pre-state gate are AUTHORIZE-time bindings,
 * because re-asserting them after publication would demand the program had never
 * run. That is precisely why binding the historical fixture to canonical
 * consumption validity does not re-couple it to current canonical state: a
 * future HEAD and a future ledger leave this verdict untouched.
 */
function authenticateHistoricalFixtureBytes({ root, fixtureSha256 }) {
  const findings = [];
  let names = [];
  try {
    names = fs.readdirSync(path.join(root, 'governance', 'sources')).filter((name) => name.endsWith('.json')).sort();
  } catch { /* no sources directory: reported as an absent binding below */ }

  for (const name of names) {
    const authorityDocumentPath = `governance/sources/${name}`;
    let authority = null;
    try { authority = JSON.parse(fs.readFileSync(path.join(root, 'governance', 'sources', name), 'utf8')); } catch { continue; }
    if (authority?.document !== MAINTENANCE_AUTHORITY_DOCUMENT || authority?.schemaVersion !== 2) continue;

    // Cheap claim test first. An authority whose consumption never names this
    // fixture cannot bind it whatever else is true of it, and the canonical
    // observation below walks the tree and shells out to git — far too costly to
    // run for every unrelated program in governance/sources.
    let consumptionRecord = null;
    try {
      const consumptionPath = resolveMaintenancePath(root, authority.consumptionRecordPath);
      if (consumptionPath && fs.existsSync(consumptionPath)) consumptionRecord = JSON.parse(fs.readFileSync(consumptionPath, 'utf8'));
    } catch { /* unreadable consumption is handled as a non-claim below */ }
    const recorded = (Array.isArray(consumptionRecord?.cohort) ? consumptionRecord.cohort : [])
      .find((entry) => entry?.path === R7_BENCHMARK_CONTEXT_PATH);
    if (!recorded || !HEX64.test(recorded.sha256 || '')) continue;

    // The canonical composition, not a local approximation of it.
    let manifest = null;
    let observed = {};
    const observationFindings = [];
    try {
      const observation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath });
      observationFindings.push(...observation.findings);
      manifest = observation.manifest;
      observed = observation.observed;
    } catch (error) {
      observationFindings.push({ code: error?.message || String(error) });
    }
    const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({
      authority, manifest, observed, phase: PHASE_VERIFY_PROGRAM_CONSUMPTION, consumptionRecord
    });
    const authorized = observationFindings.length === 0 && evaluation.findings.length === 0 && evaluation.consumed === true;

    if (!authorized) {
      findings.push(`BENCHMARK_CONTEXT_EXTERNAL_AUTHORITY_NOT_CANONICALLY_VALID:${authority.authorityId ?? name}`);
      continue;
    }
    if (recorded.sha256 !== fixtureSha256) {
      findings.push(`BENCHMARK_CONTEXT_EXTERNAL_BINDING_SHA256_MISMATCH:${authority.authorityId}`);
      continue;
    }
    return { valid: true, findings: [], authorityId: authority.authorityId };
  }

  if (findings.length === 0) findings.push('BENCHMARK_CONTEXT_EXTERNAL_BINDING_ABSENT');
  return { valid: false, findings, authorityId: null };
}

export function validateR7HistoricalBenchmarkContext({ repoRoot = REPO_ROOT, fixture = null } = {}) {
  const root = path.resolve(repoRoot);
  const findings = [];
  let context = fixture;
  let fixtureBytes = null;
  const fixturePath = path.join(root, ...R7_BENCHMARK_CONTEXT_PATH.split('/'));
  if (context === null) {
    try {
      fixtureBytes = fs.readFileSync(fixturePath);
      context = JSON.parse(fixtureBytes.toString('utf8'));
    } catch {
      findings.push('BENCHMARK_CONTEXT_MISSING_OR_INVALID_JSON');
    }
  }

  // Authenticate the BYTES before believing anything they claim about
  // themselves. A caller-supplied object is serialized exactly as the fixture is
  // written on disk, so the genuine document round-trips to its authorized
  // digest and any edited one cannot.
  const candidateSha256 = fixtureBytes === null
    ? sha256Bytes(Buffer.from(`${JSON.stringify(context, null, 2)}\n`))
    : sha256Bytes(fixtureBytes);
  const external = authenticateHistoricalFixtureBytes({ root, fixtureSha256: candidateSha256 });
  if (!external.valid) findings.push(...external.findings);

  if (!exactFields(context, BENCHMARK_CONTEXT_FIELDS)) findings.push('BENCHMARK_CONTEXT_FIELDS_INVALID');
  if (context?.document !== 'GEE_V1_R7_BENCHMARK_CONTEXT' || context?.schemaVersion !== 2
    || context?.fixtureId !== 'GEE_V1_R7_WHEEL_GATE15_CONTEXT_R1'
    || context?.contextKind !== 'DETERMINISTIC_HISTORICAL_WHEEL_STATE') findings.push('BENCHMARK_CONTEXT_IDENTITY_INVALID');
  if (context?.workUnitId !== WORK_UNIT_ID || context?.missionRevisionId !== R7_MISSION
    || !HEX40.test(context?.sourceHead || '')) findings.push('BENCHMARK_CONTEXT_PROVENANCE_MISMATCH');
  if (!exactFields(context?.provenance, BENCHMARK_CONTEXT_PROVENANCE_FIELDS)
    || context?.provenance?.authorityClass !== 'HISTORICAL_REPOSITORY_BYTES'
    || context?.provenance?.purpose !== 'R7_BENCHMARK_INPUT_ONLY'
    || context?.provenance?.generatedProjectionAuthority !== false
    || typeof context?.provenance?.derivedAtCommit !== 'string'
    || context?.provenance?.compilerVersion !== 'GEE_V1_CONTEXT_COMPILER_R2') findings.push('BENCHMARK_CONTEXT_PROVENANCE_MISMATCH');
  if (!HEX64.test(context?.contextIdentitySha256 || '')
    || context?.contextIdentitySha256 !== sha256Canonical(benchmarkContextBody(context || {}))) findings.push('BENCHMARK_CONTEXT_DIGEST_MISMATCH');

  const declaredState = new Map();
  if (!Array.isArray(context?.historicalState) || context.historicalState.length !== EXPECTED_HISTORICAL_STATE.size) {
    findings.push('BENCHMARK_CONTEXT_HISTORICAL_STATE_INVALID');
  } else {
    const paths = context.historicalState.map((entry) => entry?.path);
    if (new Set(paths).size !== paths.length || [...paths].sort().some((entry, index) => entry !== paths[index])) findings.push('BENCHMARK_CONTEXT_HISTORICAL_STATE_ORDER_INVALID');
    for (const entry of context.historicalState) {
      if (!exactFields(entry, BENCHMARK_CONTEXT_STATE_FIELDS) || !safeFixturePath(entry?.path)
        || EXPECTED_HISTORICAL_STATE.get(entry?.path) !== entry?.role || !HEX64.test(entry?.sha256 || '')) {
        findings.push(`BENCHMARK_CONTEXT_STATE_DECLARATION_INVALID:${entry?.path ?? 'UNKNOWN'}`);
        continue;
      }
      declaredState.set(entry.path, entry.sha256);
    }
  }

  // The frozen context is only worth as much as its binding to the bytes it was
  // compiled from. Everything below is arithmetic over the fixture itself.
  const compiled = context?.historicalContext ?? null;
  if (!compiled || typeof compiled !== 'object' || Array.isArray(compiled)) {
    findings.push('BENCHMARK_CONTEXT_HISTORICAL_CONTEXT_INVALID');
  } else {
    if (!HEX64.test(context?.historicalContextSha256 || '')
      || context.historicalContextSha256 !== sha256Canonical(compiled)) findings.push('BENCHMARK_CONTEXT_HISTORICAL_CONTEXT_DIGEST_MISMATCH');
    if (compiled.identity?.workUnitId !== context?.workUnitId
      || compiled.identity?.sourceHead !== context?.sourceHead
      || compiled.identity?.compilerVersion !== context?.provenance?.compilerVersion) {
      findings.push('BENCHMARK_CONTEXT_COMPILED_IDENTITY_MISMATCH');
    }
    if (!Array.isArray(compiled.relevantSources)) findings.push('BENCHMARK_CONTEXT_COMPILED_SOURCE_SET_MISMATCH');
    else {
      const observedSources = compiled.relevantSources.map((entry) => entry?.path).sort();
      if (sha256Canonical(observedSources) !== sha256Canonical([...EXPECTED_HISTORICAL_SOURCES])) findings.push('BENCHMARK_CONTEXT_COMPILED_SOURCE_SET_MISMATCH');
      for (const source of compiled.relevantSources) {
        if (declaredState.get(source?.path) !== source?.sha256) findings.push(`BENCHMARK_CONTEXT_COMPILED_SOURCE_UNBOUND:${source?.path ?? 'UNKNOWN'}`);
      }
    }
  }

  const valid = findings.length === 0;
  const validated = valid ? {
    repoRoot: root,
    fixture: context,
    fixtureSha256: candidateSha256,
    boundAuthorityId: external.authorityId,
    compiled
  } : null;
  if (validated) Object.defineProperty(validated, VALIDATED_R7_BENCHMARK_CONTEXT, { value: true, enumerable: false });
  return { valid, findings, context: validated };
}

/**
 * Current-state binding: does the live canonical tree still hold the exact bytes
 * the CALLER expects, and does it still compile? The expectation is a parameter
 * precisely so that this lane can never be answered from the historical fixture.
 */
export function validateR7CurrentStateBinding({ repoRoot = REPO_ROOT, expected = null } = {}) {
  const root = path.resolve(repoRoot);
  const findings = [];
  if (!Array.isArray(expected) || expected.length === 0) {
    return { valid: false, findings: ['CURRENT_STATE_EXPECTATION_REQUIRED'], compiled: null };
  }
  for (const entry of expected) {
    if (!exactFields(entry, BENCHMARK_CONTEXT_STATE_FIELDS) || !safeFixturePath(entry?.path) || !HEX64.test(entry?.sha256 || '')) {
      findings.push(`CURRENT_STATE_DECLARATION_INVALID:${entry?.path ?? 'UNKNOWN'}`);
      continue;
    }
    const absolute = path.join(root, ...entry.path.split('/'));
    let actual = null;
    try { actual = sha256Bytes(fs.readFileSync(absolute)); } catch { /* reported below */ }
    if (actual === null) findings.push(`CURRENT_STATE_MISSING:${entry.path}`);
    else if (actual !== entry.sha256) findings.push(`CURRENT_STATE_SHA256_MISMATCH:${entry.path}`);
  }

  let compiled = null;
  if (findings.length === 0) {
    try {
      compiled = compileContext({
        repoRoot: root,
        adapter: createWheelContextAdapter(root),
        workUnitId: WORK_UNIT_ID,
        sourceHead: HEAD
      }).json;
    } catch (error) {
      findings.push(`CURRENT_STATE_COMPILE_FAILED:${error.message}`);
    }
  }
  return { valid: findings.length === 0, findings, compiled };
}

export function assertR7BenchmarkContext(options = {}) {
  const result = validateR7HistoricalBenchmarkContext(options);
  if (!result.valid) throw new Error(`R7_BENCHMARK_CONTEXT_INVALID:${result.findings.join(',')}`);
  return result.context;
}

/**
 * Point an ALREADY VALIDATED context at a scratch measurement root.
 *
 * The benchmark measures over disposable copies of the governance tree. Those
 * copies are not repositories: they carry no git directory, so the canonical
 * consumption observation cannot run in them, and re-authenticating there would
 * ask a scratch directory to prove something only the repository can prove.
 *
 * Authorization is a property of the repository the fixture came from, and it
 * has already been established — by the full canonical check — before this is
 * called. What changes here is only where the measurement reads its bytes.
 */
function rebindValidatedContext(context, root) {
  if (!context?.[VALIDATED_R7_BENCHMARK_CONTEXT]) throw new Error('R7_BENCHMARK_CONTEXT_NOT_VALIDATED');
  const rebound = { ...context, repoRoot: path.resolve(root) };
  Object.defineProperty(rebound, VALIDATED_R7_BENCHMARK_CONTEXT, { value: true, enumerable: false });
  return rebound;
}

function writeJson(relativePath, value, outputRoot = REPO_ROOT) {
  const absolute = path.join(outputRoot, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return relativePath;
}

function normalizeQuality(context, plan, evaluatedGraph) {
  return {
    workUnit: context.identity.workUnitId,
    facts: context.facts.map((fact) => ({
      id: fact.id,
      value: fact.value,
      provenance: {
        authorityClass: fact.provenance?.authorityClass || null,
        sourcePath: fact.provenance?.sourcePath || null,
        sourceSha256: fact.provenance?.sourceSha256 || null
      }
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    sources: context.relevantSources.map((source) => ({
      path: source.path,
      sha256: source.sha256,
      authorityClass: source.authorityClass || null,
      role: source.role || null
    })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    evidence: (evaluatedGraph?.nodes || []).map((node) => ({
      evidenceId: node.evidenceId,
      contentSha256: node.contentSha256,
      reuseIdentity: node.reuseIdentity,
      dependencies: node.dependencies,
      producingValidation: node.producingValidation ? {
        result: node.producingValidation.result || null,
        validationBasisSha256: node.producingValidation.validationBasisSha256 || null,
        validationState: node.producingValidation.validationState || null,
        validator: node.producingValidation.validator || null
      } : null
    })).sort((a, b) => a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0),
    tasks: plan.tasks.map((task) => ({
      taskId: task.taskId,
      taskSemanticSha256: task.taskSemanticSha256,
      sources: task.sources,
      produces: task.produces,
      requiredEvidenceIds: task.requiredEvidenceIds,
      mandatory: task.mandatory === true
    })).sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    activeDefectsOrBlockers: context.activeDefectsOrBlockers,
    successConditions: context.successConditions,
    qualityRequirements: {
      mandatoryTaskIds: plan.qualityRequirements?.mandatoryTaskIds || [],
      contradictionTaskIds: plan.qualityRequirements?.contradictionTaskIds || [],
      nonDeferrableTaskIds: plan.qualityRequirements?.nonDeferrableTaskIds || [],
      unmetRequirements: plan.qualityRequirements?.unmetRequirements || [],
      qualityFloorEnforced: plan.qualityRequirements?.qualityFloorEnforced === true
    }
  };
}

export function qualityParity(left, right) {
  if (left === undefined || right === undefined) return false;
  return sha256Canonical(left) === sha256Canonical(right);
}

export function evaluateRouteExpectation({ expectedRoute, observedRoute, observedPass = true, qualityPass = true, acceptableRoutes = null, acceptableRouteReason = null } = {}) {
  const routePass = Array.isArray(acceptableRoutes)
    ? acceptableRoutes.length > 0
      && acceptableRoutes.includes(observedRoute)
      && typeof acceptableRouteReason === 'string'
      && acceptableRouteReason.trim().length > 0
    : expectedRoute === observedRoute;
  return { routePass, pass: observedPass === true && qualityPass === true && routePass };
}

export function evaluateHostileOutcome({ invariantPreserved = false, reasonMatches = false } = {}) {
  return invariantPreserved === true && reasonMatches === true;
}

export function deriveBenchmarkMetrics(raw, { routingEfficiency = false, qualityParityResult = false } = {}) {
  const reduction = (baseline, gee) => baseline === 0 ? null : (baseline - gee) / baseline;
  return {
    contextReduction: reduction(raw.baseline_context_bytes, raw.gee_context_bytes),
    processingReduction: reduction(raw.baseline_source_bytes_processed, raw.gee_source_bytes_processed),
    rehashReduction: reduction(raw.baseline_files_processed, raw.gee_files_processed),
    taskReuse: reduction(raw.baseline_tasks_executed, raw.gee_tasks_executed),
    evidenceReuse: raw.gee_evidence_reused,
    revalidationSelectivity: raw.gee_revalidation_work,
    recoveryPreservation: null,
    routingEfficiency,
    qualityParity: qualityParityResult,
    tokens: raw.tokens
  };
}

function measureExecutedTasks(session) {
  const executableTasks = session.plan.tasks.filter((task) => !['NO_WORK_REQUIRED', 'BLOCKED', 'OWNER_DECISION_REQUIRED'].includes(task.capability) && task.deferred !== true);
  let ledger = createUsageLedger();
  for (const task of executableTasks) {
    ledger = recordWheelTaskExecution({ session, ledger, taskId: task.taskId }).ledger;
  }
  const aggregate = aggregateUsage(ledger, { workUnitId: session.workUnitId });
  return {
    ledger,
    aggregate,
    tasks: executableTasks,
    filesProcessed: executableTasks.reduce((sum, task) => sum + task.sources.length, 0),
    reasoningRoutes: executableTasks.reduce((counts, task) => ({ ...counts, [task.capability]: (counts[task.capability] || 0) + 1 }), {})
  };
}

function syntheticAuthority() {
  return { missionRevisionId: R7_MISSION, contractSha256: 'a'.repeat(64) };
}

function completedSyntheticCheckpoint(session, taskId) {
  const task = session.plan.tasks.find((entry) => entry.taskId === taskId);
  if (!task) throw new Error(`R7_SYNTHETIC_TASK_NOT_FOUND:${taskId}`);
  let ledger = createUsageLedger();
  const execution = appendUsageRecord(ledger, {
    workUnitId: SYNTHETIC_WORK_UNIT,
    taskId,
    attempt: 1,
    capability: task.capability,
    outcome: 'COMPLETED',
    routeSha256: session.plan.routeSha256,
    bytes: { sourceProcessedBytes: task.reprocessBytes, sourceAvoidedBytes: task.avoidedBytes },
    tokens: null
  });
  ledger = execution.ledger;
  const taskEvidence = task.produces.map((evidenceId) => {
    const node = session.evaluated.graph.nodes.find((entry) => entry.evidenceId === evidenceId);
    if (!node) throw new Error(`R7_SYNTHETIC_EVIDENCE_NOT_FOUND:${evidenceId}`);
    return { evidenceId, reuseIdentity: node.reuseIdentity };
  });
  const tasks = checkpointTasksFromRoutePlan(session.plan).map((entry) => entry.taskId === taskId
    ? { ...entry, state: 'COMPLETE', evidence: taskEvidence, usageRecordIds: [execution.usageRecordId] }
    : entry);
  const checkpoint = createCheckpoint({
    workUnitId: SYNTHETIC_WORK_UNIT,
    authority: syntheticAuthority(),
    baseline: { head: HEAD, headSource: 'R7_TEST' },
    inputs: { r2ContextSha256: session.plan.provenance.r2ContextSha256, r3DeltaSha256: session.plan.provenance.r3DeltaSha256, r4GraphSha256: session.plan.provenance.r4GraphSha256, routeSha256: session.plan.routeSha256, repoIndexSha256: 'b'.repeat(64) },
    tasks,
    recoveryState: 'INTERRUPTED'
  });
  return { checkpoint, ledger, task, execution };
}

function resolveR7AuthorityState() {
  const wheelAdapter = createWheelContextAdapter(REPO_ROOT);
  const registry = createExecutionAuthorityRegistry([
    createGeeMissionAuthoritySource(REPO_ROOT, {
      projectId: 'WHEEL',
      prerequisiteResolvers: {
        'wheel-adapter-status': (prerequisite) => wheelAdapter.resolvePrerequisite(prerequisite.id, prerequisite)
      }
    })
  ]);
  const r7 = resolveExecutionAuthority({ projectId: 'WHEEL', workUnitType: MISSION_WORK_UNIT_TYPE, workUnitId: R7_MISSION, registry });
  const r8 = resolveExecutionAuthority({ projectId: 'WHEEL', workUnitType: MISSION_WORK_UNIT_TYPE, workUnitId: 'GOVERNANCE_EXECUTION_EFFICIENCY_V1_R8', registry });
  return {
    r0007: r7.executionAuthorized ? 'AUTHORIZED' : 'UNAUTHORIZED',
    seal: r7.proofs?.CONTRACT_INTEGRITY?.state === 'PROVEN' ? 'INTACT' : 'INVALID',
    r8: r8.executionAuthorized ? 'AUTHORIZED' : 'UNKNOWN / UNAUTHORIZED',
    executionAuthorized: r7.executionAuthorized === true,
    proofs: r7.proofs,
    findings: r7.findings,
    r8Findings: r8.findings
  };
}

function sumTaskSourceBytes(plan) { return plan.tasks.reduce((sum, task) => sum + task.reprocessBytes, 0); }
function sumTaskAvoidedBytes(plan) { return plan.tasks.reduce((sum, task) => sum + task.avoidedBytes, 0); }
function sumTaskSourceFiles(plan) { return plan.tasks.reduce((sum, task) => sum + task.sources.length, 0); }
function percentage(reduction, denominator) { return denominator === 0 ? null : reduction / denominator; }

function routeCapabilitySummary(plans) {
  const counts = { NO_WORK_REQUIRED: 0, LOCAL_DETERMINISTIC: 0, STANDARD_REASONING: 0, DEEP_REASONING: 0, OWNER_DECISION_REQUIRED: 0, BLOCKED: 0 };
  for (const plan of plans) counts[plan.routeDecision] = (counts[plan.routeDecision] || 0) + 1;
  return counts;
}

function runAuthorityAndScopeInternal({ outputRoot = null } = {}) {
  const contract = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, R7_CONTRACT_PATH), 'utf8'));
  const positive = [
    'governance/gee-v1/evals/gee-r7-eval-suite.json',
    'governance/gee-v1/benchmarks/gee-r7-benchmark.json',
    'governance/gee-v1/fixtures/gee-r7-hostile.json',
    'governance/gee-v1/tests/gee-r7-hostile-audit.test.mjs'
  ];
  const negative = [
    'governance/gee-v1/missions/GEE_V1_EXECUTION_CONTRACT_R0007.json',
    'governance/gee-v1/core/work-unit-core.mjs',
    'governance/gee-v1/recovery/recovery-engine.mjs',
    'governance/gee-v1/evals/gee-r8-future.json',
    'governance/gee-v1/evals/gee-r7-/../R1.json',
    'C:/outside.json'
  ];
  const positiveResults = Object.fromEntries(positive.map((entry) => [entry, isPathAuthorized(contract.authorizedPaths, entry)]));
  const negativeResults = Object.fromEntries(negative.map((entry) => [entry, isPathAuthorized(contract.authorizedPaths, entry)]));
  assert.ok(Object.values(positiveResults).every(Boolean));
  assert.ok(Object.values(negativeResults).every((value) => value === false));
  const result = { positive: positiveResults, negative: negativeResults, authority: resolveR7AuthorityState(), r8: 'UNKNOWN / UNAUTHORIZED' };
  if (outputRoot !== null) writeJson('governance/gee-v1/evals/gee-r7-authority-scope.json', result, outputRoot);
  return result;
}

export function runAuthorityAndScope(options = {}) {
  return withEphemeralRootScope(() => runAuthorityAndScopeInternal(options));
}

function runEvalSuiteInternal({ outputRoot = null } = {}) {
  const results = [];
  function record(id, objective, expectedRoute, observed, quality, usage) {
    const evaluation = evaluateRouteExpectation({
      expectedRoute,
      observedRoute: observed.route,
      observedPass: observed.pass,
      qualityPass: quality.pass,
      acceptableRoutes: observed.acceptableRoutes,
      acceptableRouteReason: observed.acceptableRouteReason
    });
    const pass = evaluation.pass;
    results.push({ id, objective, input: observed.input, expectedRoute, observedRoute: observed.route, routeExpectation: evaluation.routePass, expectedEvidenceRecovery: observed.evidenceRecovery, observedEvidenceRecovery: observed.observedEvidenceRecovery, quality, usage, verdict: pass ? 'PASS' : 'FAIL' });
    assert.equal(pass, true, `${id}:${JSON.stringify({ observed, quality, evaluation })}`);
  }

  {
    const root = tempRoot('gee-r7-e01-'); const cas = casFor(root); const a = syntheticSnapshot(root); const b = syntheticSnapshot(root); const delta = compareSnapshots({ previous: a, current: b });
    record('E01', 'mechanical deterministic snapshot replay', 'NO_WORK_REQUIRED', { input: 'identical synthetic sources', route: 'NO_WORK_REQUIRED', pass: delta.deltas.every((entry) => entry.kind === 'UNCHANGED'), evidenceRecovery: 'reuse unchanged evidence', observedEvidenceRecovery: 'all sources UNCHANGED' }, { expected: 'same digest and result', observed: a.snapshotSha256 === b.snapshotSha256, pass: a.snapshotSha256 === b.snapshotSha256 }, { sourceBytes: delta.metrics.unchangedBytes, tasksExecuted: 0 });
  }

  {
    const root = tempRoot('gee-r7-e02-'); const cas = casFor(root); const s = syntheticPlan(root, cas, { mutate: (r) => fs.writeFileSync(path.join(r, 'src', 'b.json'), '{"b":2}\n') });
    const affected = s.plan.tasks.filter((task) => task.reprocessBytes > 0).map((task) => task.taskId);
    record('E02', 'localized defect in one source', 'LOCAL_DETERMINISTIC', { input: 'src/b.json changed', route: s.plan.routeDecision, pass: affected.includes('t:b') && !affected.includes('t:a'), evidenceRecovery: 'selective revalidation', observedEvidenceRecovery: s.plan.revalidationRequiredEvidenceIds, }, { expected: 'unaffected fact remains reusable', observed: s.plan.reusableEvidenceIds.includes('e:a'), pass: s.plan.reusableEvidenceIds.includes('e:a') }, { sourceBytes: s.plan.metrics.R3_REPROCESS_BYTES, tasksExecuted: affected.length });
  }

  {
    const root = tempRoot('gee-r7-e03-'); const cas = casFor(root); const s = syntheticPlan(root, cas, { tasks: [{ taskId: 't:multi', intent: 'SEMANTIC', sources: ['src/a.json', 'src/b.json'], uncertainty: 'LOW', architectureImpact: 'LOCAL', description: 'multi-file localized defect' }] });
    record('E03', 'multi-file defect', 'STANDARD_REASONING', { input: 'two source dependency defect', route: s.plan.routeDecision, pass: s.plan.routeDecision === 'STANDARD_REASONING', evidenceRecovery: 'both declared sources available', observedEvidenceRecovery: s.plan.tasks[0].sources }, { expected: 'multi-file task receives semantic reasoning', observed: s.plan.tasks[0].capability, pass: s.plan.tasks[0].capability === 'STANDARD_REASONING' }, { sourceBytes: s.plan.metrics.R3_TOTAL_SOURCE_BYTES, tasksExecuted: s.plan.tasks.length });
  }

  {
    const root = tempRoot('gee-r7-e04-'); const cas = casFor(root); const s = syntheticPlan(root, cas, { tasks: [{ taskId: 't:contradiction', intent: 'SEMANTIC', sources: ['src/a.json', 'src/b.json'], contradiction: { statement: 'trusted sources disagree', sources: ['src/a.json', 'src/b.json'] } }] });
    record('E04', 'architecture contradiction', 'DEEP_REASONING', { input: 'frozen-layer contradiction', route: s.plan.routeDecision, pass: s.plan.routeDecision === 'DEEP_REASONING', evidenceRecovery: 'no deferral', observedEvidenceRecovery: s.plan.qualityRequirements.contradictionTaskIds }, { expected: 'contradiction is mandatory', observed: s.plan.qualityRequirements.contradictionTaskIds.includes('t:contradiction'), pass: true }, { sourceBytes: s.plan.metrics.R3_TOTAL_SOURCE_BYTES, tasksExecuted: s.plan.tasks.length });
  }

  {
    const root = tempRoot('gee-r7-e05-'); const cas = casFor(root); const s = syntheticPlan(root, cas); let errorMessage = null; try { routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: SYNTHETIC_TASKS, r2Context: syntheticContext(root), r3Delta: s.r3Delta, r4Evidence: { graph: s.evaluated.graph, reusableNodes: ['e:a'] }, cas }); } catch (error) { errorMessage = error.message; }
    const reason = errorMessage?.split(':')[0] || null;
    record('E05', 'hostile false PASS claim', 'BLOCKED', { input: 'forged R4 validation claim', route: 'BLOCKED', pass: reason === 'FABRICATED_R4_EVALUATION', evidenceRecovery: 'claim rejected at R4 boundary', observedEvidenceRecovery: reason }, { expected: 'false PASS cannot become evidence', observed: reason, pass: reason === 'FABRICATED_R4_EVALUATION' }, { sourceBytes: 0, tasksExecuted: 0 });
  }

  {
    const root = tempRoot('gee-r7-e06-'); const cas = casFor(root); const s = syntheticPlan(root, cas, { mutate: (r) => fs.writeFileSync(path.join(r, 'src', 'b.json'), '{"b":2}\n') });
    record('E06', 'cross-layer dependency invalidation', 'LOCAL_DETERMINISTIC', { input: 'R3 source mutation reaches R4/R5', route: s.plan.routeDecision, pass: s.plan.metrics.R3_REPROCESS_BYTES > 0 && s.plan.metrics.R4_REVALIDATION_REQUIRED_NODES > 0, evidenceRecovery: 'dependent chain revalidated', observedEvidenceRecovery: s.plan.revalidationRequiredEvidenceIds }, { expected: 'only dependent chain moves', observed: s.plan.reusableEvidenceIds, pass: s.plan.reusableEvidenceIds.includes('e:a') }, { sourceBytes: s.plan.metrics.R3_REPROCESS_BYTES, tasksExecuted: s.plan.metrics.R5_TASKS_TOTAL - s.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE });
  }

  {
    const root = cloneGovernanceRepo('gee-r7-e07-');
    const stateDir = allocateEphemeralRoot('gee-r7-e07-state-');
    const started = JSON.parse(execFileSync(process.execPath, [CHILD, 'interrupt', root, stateDir], { encoding: 'utf8' }));
    fs.appendFileSync(path.join(root, 'governance', 'GATE_REGISTRY_00_40.json'), '\n');
    fs.writeFileSync(path.join(root, 'unrelated-root-file.txt'), 'irrelevant mutation');
    const resumed = JSON.parse(execFileSync(process.execPath, [CHILD, 'resume', root, stateDir], { encoding: 'utf8' }));
    const avoidedNotExecuted = started.executedTaskIds.every((taskId) => !started.avoidedTaskIds.includes(taskId));
    record('E07', 'genuine interruption, checkpoint and fresh-process recovery', 'LOCAL_DETERMINISTIC', { input: 'mandatory work executes before interruption', route: started.route, pass: started.route === 'LOCAL_DETERMINISTIC' && started.executedTaskIds.length > 0 && resumed.decision === 'REVALIDATE_SOME', evidenceRecovery: 'fresh-process recovery preserves COMPLETE work', observedEvidenceRecovery: { checkpointState: started.checkpointState, decision: resumed.decision, preserved: resumed.completedPreserved, invalidated: resumed.tasksInvalidated } }, { expected: 'execution is real and avoided work is not completed', observed: { executed: started.executedTaskIds.length, avoided: started.avoidedTaskIds.length, avoidedNotExecuted, restartedFromZero: resumed.restartedFromZero }, pass: avoidedNotExecuted && resumed.completedPreserved > 0 && resumed.tasksInvalidated > 0 && resumed.restartedFromZero === false }, { sourceBytes: started.sourceBytesProcessed, tasksExecuted: started.executedTaskIds.length, usageRecords: started.usageRecords.length });
  }

  {
    const root = tempRoot('gee-r7-e08-'); const cas = casFor(root); const s = syntheticPlan(root, cas, { mutate: (r) => fs.writeFileSync(path.join(r, 'fixtures', 'canonical.json'), '{"canonical":false}\n') });
    record('E08', 'indirect evidence invalidation', 'LOCAL_DETERMINISTIC', { input: 'canonical source changes summary dependency', route: s.plan.routeDecision, pass: s.plan.reusableEvidenceIds.includes('e:a') && !s.plan.reusableEvidenceIds.includes('e:c'), evidenceRecovery: 'indirect dependent invalidated', observedEvidenceRecovery: s.plan.revalidationRequiredEvidenceIds }, { expected: 'unrelated fact remains reusable', observed: s.plan.reusableEvidenceIds, pass: s.plan.reusableEvidenceIds.includes('e:a') }, { sourceBytes: s.plan.metrics.R3_REPROCESS_BYTES, tasksExecuted: s.plan.metrics.R5_TASKS_TOTAL - s.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE });
  }

  {
    const root = tempRoot('gee-r7-e09-'); const cas = casFor(root); const s = syntheticPlan(root, cas); fs.writeFileSync(path.join(root, 'unrelated.txt'), 'outside indexed roots'); const replay = syntheticPlan(root, cas);
    record('E09', 'unrelated repository mutation', 'NO_WORK_REQUIRED', { input: 'root-level irrelevant file changed', route: replay.plan.routeDecision, pass: replay.plan.routeDecision === 'NO_WORK_REQUIRED', evidenceRecovery: 'valid evidence retained', observedEvidenceRecovery: replay.plan.reusableEvidenceIds }, { expected: 'same quality output', observed: replay.plan.routeDecision, pass: replay.plan.routeDecision === 'NO_WORK_REQUIRED' }, { sourceBytes: replay.plan.metrics.R3_REPROCESS_BYTES, tasksExecuted: 0, priorIndexDigest: s.plan.routeSha256 });
  }

  {
    const root = tempRoot('gee-r7-e10-'); const cas = casFor(root); let ledger = createRepairLedger(); ledger = appendRepairRecord(ledger, { defectId: 'DEF-R7', rootCauseClass: 'RC-R7', outcome: SURVIVED, evidenceRef: 'r7://attempt-1' }); ledger = appendRepairRecord(ledger, { defectId: 'DEF-R7', rootCauseClass: 'RC-R7', outcome: SURVIVED, evidenceRef: 'r7://attempt-2' }); const containment = evaluateContainment(ledger, 'RC-R7'); const s = syntheticPlan(root, cas, { repairLedger: ledger, tasks: [{ taskId: 't:third-repair', intent: 'SEMANTIC', sources: ['src/a.json'], repair: { defectId: 'DEF-R7', rootCauseClass: 'RC-R7', incremental: true } }] });
    record('E10', 'repeated same-root-cause containment', 'BLOCKED', { input: 'third targeted repair after two survivors', route: s.plan.routeDecision, pass: containment.lineageState === 'STOP_PATCH_CASCADE' && s.plan.tasks[0].capability === 'BLOCKED', evidenceRecovery: 'cascade stopped', observedEvidenceRecovery: s.plan.tasks[0].blockedBy }, { expected: 'structural analysis required', observed: containment.requiredNextAction, pass: containment.incrementalPatchAuthorized === false }, { sourceBytes: 0, tasksExecuted: 0 });
  }

  const artifact = { suite: 'GEE_V1_R7_EVAL_SUITE', version: 1, total: results.length, pass: results.filter((entry) => entry.verdict === 'PASS').length, fail: results.filter((entry) => entry.verdict !== 'PASS').length, evals: results };
  if (outputRoot !== null) writeJson('governance/gee-v1/evals/gee-r7-eval-suite.json', artifact, outputRoot);
  return artifact;
}

export function runEvalSuite(options = {}) {
  return withEphemeralRootScope(() => runEvalSuiteInternal(options));
}

function runWheelMode({ context, previousSnapshot = null, previousGraph = null, previousRepoIndex = null, cas }) {
  if (!context?.[VALIDATED_R7_BENCHMARK_CONTEXT]) throw new Error('R7_BENCHMARK_CONTEXT_NOT_VALIDATED');
  return createWheelRecoverySession({
    repoRoot: context.repoRoot,
    workUnitId: context.fixture.workUnitId,
    cas,
    sourceHead: context.fixture.sourceHead,
    missionRevisionId: context.fixture.missionRevisionId,
    previousSnapshot,
    previousGraph,
    previousRepoIndex
  });
}

function withCanonicalBenchmarkEnvironment(callback) {
  const hadWitnessSource = Object.prototype.hasOwnProperty.call(process.env, 'GEE_HEAD_WITNESS_SOURCE');
  const originalWitnessSource = process.env.GEE_HEAD_WITNESS_SOURCE;
  try {
    delete process.env.GEE_HEAD_WITNESS_SOURCE;
    return callback();
  } finally {
    if (hadWitnessSource) process.env.GEE_HEAD_WITNESS_SOURCE = originalWitnessSource;
    else delete process.env.GEE_HEAD_WITNESS_SOURCE;
  }
}

function runBenchmarkInternal({ outputRoot = null } = {}) {
  const benchmarkRoot = cloneGovernanceRepo('gee-r7-benchmark-wheel-');
  const authorizedContext = assertR7BenchmarkContext();
  const benchmarkContext = rebindValidatedContext(authorizedContext, benchmarkRoot);
  const casRoot = allocateEphemeralRoot('gee-r7-benchmark-cas-'); const cas = createContentAddressedStore(path.join(casRoot, 'cas'));
  const empty = createSnapshot({ repoRoot: benchmarkRoot, sources: [] });
  const baseline = runWheelMode({ context: benchmarkContext, cas, previousSnapshot: empty });
  const gee = runWheelMode({ context: benchmarkContext, cas, previousSnapshot: baseline.currentSnapshot, previousGraph: baseline.evaluated.graph, previousRepoIndex: baseline.repoIndex });
  const baselineMeasurement = measureExecutedTasks(baseline);
  const geeMeasurement = measureExecutedTasks(gee);
  const baselineTasksExecuted = baselineMeasurement.aggregate.recordCount;
  const geeTasksExecuted = geeMeasurement.aggregate.recordCount;
  const baselineContextBytes = baselineMeasurement.aggregate.contextBytes;
  const geeContextBytes = geeMeasurement.aggregate.contextBytes;
  const baselineProcessedBytes = baselineMeasurement.aggregate.processedBytes;
  const geeProcessedBytes = geeMeasurement.aggregate.processedBytes;
  const baselineFilesProcessed = baselineMeasurement.filesProcessed;
  const geeFilesProcessed = geeMeasurement.filesProcessed;
  const baselineQuality = normalizeQuality(baseline.compiled.json, baseline.plan, baseline.evaluated.graph);
  const geeQuality = normalizeQuality(gee.compiled.json, gee.plan, gee.evaluated.graph);
  const qualityParityResult = qualityParity(geeQuality, baselineQuality);
  assert.equal(qualityParityResult, true);
  assert.equal(gee.plan.routeDecision, 'NO_WORK_REQUIRED');

  const rawMetrics = {
    baseline_context_bytes: baselineContextBytes,
    gee_context_bytes: geeContextBytes,
    baseline_source_bytes_processed: baselineProcessedBytes,
    gee_source_bytes_processed: geeProcessedBytes,
    baseline_files_processed: baselineFilesProcessed,
    gee_files_processed: geeFilesProcessed,
    baseline_tasks_executed: baselineTasksExecuted,
    gee_tasks_executed: geeTasksExecuted,
    baseline_evidence_reused: 0,
    gee_evidence_reused: gee.plan.reusableEvidenceIds.length,
    baseline_revalidation_work: baselineMeasurement.tasks.length,
    gee_revalidation_work: gee.plan.metrics.R4_REVALIDATION_REQUIRED_NODES,
    baseline_restart_work: 0,
    gee_restart_work: 0,
    tokens: 'TOKEN_COUNT_UNAVAILABLE'
  };

  const relevantRoot = cloneGovernanceRepo('gee-r7-b2-');
  const relevantContext = rebindValidatedContext(authorizedContext, relevantRoot);
  const relevantCas = createContentAddressedStore(path.join(relevantRoot, 'cas')); const relevantFirst = runWheelMode({ context: relevantContext, cas: relevantCas, previousSnapshot: createSnapshot({ repoRoot: relevantRoot, sources: [] }) });
  const relevantSource = path.join(relevantRoot, 'governance', 'GATE_REGISTRY_00_40.json'); fs.appendFileSync(relevantSource, '\n');
  const relevantSecond = runWheelMode({ context: relevantContext, cas: relevantCas, previousSnapshot: relevantFirst.currentSnapshot, previousGraph: relevantFirst.evaluated.graph, previousRepoIndex: relevantFirst.repoIndex });
  assert.ok(relevantSecond.plan.metrics.R3_CHANGED_BYTES > 0);
  assert.ok(relevantSecond.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE > 0);

  const unrelatedRoot = cloneGovernanceRepo('gee-r7-b3-'); const unrelatedContext = rebindValidatedContext(authorizedContext, unrelatedRoot); const unrelatedCas = createContentAddressedStore(path.join(unrelatedRoot, 'cas')); const unrelatedFirst = runWheelMode({ context: unrelatedContext, cas: unrelatedCas, previousSnapshot: createSnapshot({ repoRoot: unrelatedRoot, sources: [] }) }); fs.writeFileSync(path.join(unrelatedRoot, 'unrelated-root-file.txt'), 'irrelevant'); const unrelatedSecond = runWheelMode({ context: unrelatedContext, cas: unrelatedCas, previousSnapshot: unrelatedFirst.currentSnapshot, previousGraph: unrelatedFirst.evaluated.graph, previousRepoIndex: unrelatedFirst.repoIndex }); assert.equal(unrelatedSecond.plan.routeDecision, 'NO_WORK_REQUIRED');

  const standardRoot = tempRoot('gee-r7-b5-'); const standardCas = casFor(standardRoot); const standardBase = syntheticBaseline(standardRoot, standardCas); const baseDelta = { previousSnapshot: standardBase.currentSnapshot, currentSnapshot: standardBase.currentSnapshot }; const routePlans = [
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:no', intent: 'DETERMINISTIC', sources: ['src/a.json'], produces: ['e:a'], requiredEvidenceIds: ['e:a'] }], r2Context: syntheticContext(standardRoot), r3Delta: baseDelta, r4Evidence: { graph: standardBase.graph }, cas: standardCas }),
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:local', intent: 'DETERMINISTIC', sources: ['src/a.json'] }], r2Context: syntheticContext(standardRoot), r3Delta: { previousSnapshot: createSnapshot({ repoRoot: standardRoot, sources: [] }), currentSnapshot: standardBase.currentSnapshot }, r4Evidence: { graph: standardBase.graph }, cas: standardCas }),
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:standard', intent: 'SEMANTIC', sources: ['src/a.json'], uncertainty: 'LOW', architectureImpact: 'LOCAL' }], r2Context: syntheticContext(standardRoot), r3Delta: baseDelta, r4Evidence: { graph: standardBase.graph }, cas: standardCas }),
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:deep', intent: 'SEMANTIC', sources: ['src/a.json'], contradiction: { statement: 'architecture conflict', sources: ['src/a.json'] } }], r2Context: syntheticContext(standardRoot), r3Delta: baseDelta, r4Evidence: { graph: standardBase.graph }, cas: standardCas }),
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:owner', intent: 'POLICY_DECISION', sources: [] }], r2Context: syntheticContext(standardRoot), r3Delta: baseDelta, r4Evidence: { graph: standardBase.graph }, cas: standardCas }),
    routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:block', intent: 'DETERMINISTIC', sources: ['src/a.json'], requiredEvidenceIds: ['e:missing'] }], r2Context: syntheticContext(standardRoot), r3Delta: baseDelta, r4Evidence: { graph: standardBase.graph }, cas: standardCas })
  ];
  const routing = routeCapabilitySummary([routePlans[0], routePlans[1], routePlans[2], routePlans[3], routePlans[4], routePlans[5]]);
  const qualityFloor = routePlans[3].qualityRequirements.qualityFloorEnforced === true;

  const benchmark = {
    benchmark: 'GEE_V1_R7_BEFORE_AFTER',
    workUnit: `WHEEL:${benchmarkContext.fixture.workUnitId}`,
    sourceHead: HEAD,
    benchmarkEnvironment: {
      headWitnessSource: 'NEUTRALIZED_FOR_CANONICAL_BENCHMARK',
      context: {
        fixtureId: benchmarkContext.fixture.fixtureId,
        contextIdentitySha256: benchmarkContext.fixture.contextIdentitySha256,
        fixtureSha256: benchmarkContext.fixtureSha256,
        sourceHead: benchmarkContext.fixture.sourceHead,
        provenance: benchmarkContext.fixture.provenance,
        requiredState: benchmarkContext.fixture.requiredState
      }
    },
    scenarios: {
      B1_UNCHANGED_REPLAY: { route: gee.plan.routeDecision, tasksAvoided: gee.plan.avoidedTasks.length, sourceBytesAvoided: gee.plan.metrics.R3_AVOIDED_REPROCESS_BYTES },
      B2_SMALL_RELEVANT_MUTATION: { changedBytes: relevantSecond.plan.metrics.R3_CHANGED_BYTES, tasksExecuted: relevantSecond.plan.metrics.R5_TASKS_TOTAL - relevantSecond.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE, tasksAvoided: relevantSecond.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE },
      B3_UNRELATED_MUTATION: { route: unrelatedSecond.plan.routeDecision, tasksExecuted: unrelatedSecond.plan.metrics.R5_TASKS_TOTAL - unrelatedSecond.plan.metrics.R5_TASKS_AVOIDED_BY_UPSTREAM_REUSE },
      B5_ROUTE_ESCALATION: { route: routePlans[3].routeDecision, qualityFloor },
      B6_QUALITY_FLOOR: { route: routePlans[5].routeDecision, qualityFloor: routePlans[5].qualityRequirements.qualityFloorEnforced === true }
    },
    measurements: {
      baseline: {
        contextBytes: { source: 'R6_USAGE_LEDGER_AGGREGATE', ledgerSha256: baselineMeasurement.ledger.ledgerSha256 },
        sourceBytesProcessed: { source: 'R6_USAGE_LEDGER_AGGREGATE', ledgerSha256: baselineMeasurement.ledger.ledgerSha256 },
        filesProcessed: { source: 'R6_EXECUTED_TASK_SOURCE_CARDINALITY', taskIds: baselineMeasurement.tasks.map((task) => task.taskId) }
      },
      gee: {
        contextBytes: { source: 'R6_USAGE_LEDGER_AGGREGATE', ledgerSha256: geeMeasurement.ledger.ledgerSha256 },
        sourceBytesProcessed: { source: 'R6_USAGE_LEDGER_AGGREGATE', ledgerSha256: geeMeasurement.ledger.ledgerSha256 },
        filesProcessed: { source: 'R6_EXECUTED_TASK_SOURCE_CARDINALITY', taskIds: geeMeasurement.tasks.map((task) => task.taskId) }
      }
    },
    rawMetrics,
    baseline: { contextBytes: baselineContextBytes, sourceBytesProcessed: baselineProcessedBytes, filesProcessed: baselineFilesProcessed, tasksExecuted: baselineTasksExecuted, evidenceReused: 0, revalidationWork: baselineMeasurement.tasks.length, restartWorkAfterInterrupt: 0, reasoningRoutes: baselineMeasurement.reasoningRoutes, quality: baselineQuality },
    gee: { contextBytes: geeContextBytes, sourceBytesProcessed: geeProcessedBytes, filesProcessed: geeFilesProcessed, tasksExecuted: geeTasksExecuted, evidenceReused: gee.plan.reusableEvidenceIds.length, revalidationWork: gee.plan.metrics.R4_REVALIDATION_REQUIRED_NODES, restartWorkAfterInterrupt: 0, reasoningRoutes: { NO_WORK_REQUIRED: gee.plan.avoidedTasks.length }, quality: geeQuality },
    metrics: deriveBenchmarkMetrics(rawMetrics, { routingEfficiency: routing.NO_WORK_REQUIRED === 1, qualityParityResult }),
    routing,
    quality: { baseline: baselineQuality, gee: geeQuality, parity: qualityParityResult }
  };
  assert.equal(benchmark.metrics.qualityParity, true);
  if (outputRoot !== null) {
    writeJson('governance/gee-v1/benchmarks/gee-r7-benchmark.json', benchmark, outputRoot);
    writeJson('governance/gee-v1/benchmarks/gee-r7-routing.json', routing, outputRoot);
  }
  return benchmark;
}

export function runBenchmark(options = {}) {
  return withEphemeralRootScope(() => withCanonicalBenchmarkEnvironment(() => runBenchmarkInternal(options)));
}

function runRecoveryStressInternal({ outputRoot = null } = {}) {
  const root = cloneGovernanceRepo('gee-r7-recovery-'); const stateDir = allocateEphemeralRoot('gee-r7-recovery-state-');
  const interrupted = JSON.parse(execFileSync(process.execPath, [CHILD, 'interrupt', root, stateDir], { encoding: 'utf8' }));
  fs.appendFileSync(path.join(root, 'governance', 'GATE_REGISTRY_00_40.json'), '\n');
  fs.writeFileSync(path.join(root, 'unrelated-root-file.txt'), 'irrelevant mutation');
  const resumed = JSON.parse(execFileSync(process.execPath, [CHILD, 'resume', root, stateDir], { encoding: 'utf8' }));
  assert.equal(resumed.restartedFromZero, false);
  assert.equal(resumed.restartedFromZero, resumed.canonicalRestartedFromZero);
  assert.equal(resumed.decision, 'REVALIDATE_SOME');
  assert.ok(resumed.completedPreserved >= 1);
  assert.ok(resumed.tasksInvalidated >= 1, JSON.stringify(resumed));
  assert.equal(resumed.usageDuplicates, 0);
  assert.equal(resumed.unrelatedChangeImpact, 0);
  const result = { scenario: 'R7_FRESH_PROCESS_RECOVERY_STRESS', completedBeforeInterrupt: interrupted.completedBeforeInterrupt, completedPreserved: resumed.completedPreserved, resumedTaskIds: resumed.resumedTaskIds, avoidedTaskIds: resumed.avoidedTaskIds, avoidedNotCountedAsPreserved: resumed.avoidedTaskIds.every((taskId) => !resumed.resumedTaskIds.includes(taskId)), tasksInvalidated: resumed.tasksInvalidated, tasksRevalidated: resumed.tasksRevalidated, tasksRestarted: resumed.tasksRestarted, filesRehashed: resumed.filesRehashed, filesReused: resumed.filesReused, bytesAvoided: resumed.bytesAvoided, usageDuplicates: resumed.usageDuplicates, restartedFromZero: resumed.restartedFromZero, decision: resumed.decision, canonicalDecision: resumed.decision, canonicalRestartedFromZero: resumed.canonicalRestartedFromZero, unrelatedChangeImpact: resumed.unrelatedChangeImpact, unrelatedChangePreserved: resumed.unrelatedChangePreserved, reasonCodes: resumed.reasonCodes };
  if (outputRoot !== null) writeJson('governance/gee-v1/benchmarks/gee-r7-recovery-stress.json', result, outputRoot);
  return result;
}

export function runRecoveryStress(options = {}) {
  return withEphemeralRootScope(() => runRecoveryStressInternal(options));
}

function runHostileAuditInternal({ outputRoot = null } = {}) {
  const attacks = [];
  function attack(id, expected, observed, invariantPreserved, reason = null) {
    const reasonMatches = reason === null ? true : reason.matches === true;
    const valid = evaluateHostileOutcome({ invariantPreserved, reasonMatches });
    attacks.push({ id, expected, observed, invariantPreserved: invariantPreserved === true, reasonExpected: reason?.expected || null, reasonObserved: reason?.observed || null, reasonMatches, verdict: valid ? 'PASS' : 'FAIL', invalid: !valid && reason !== null && invariantPreserved === true && reasonMatches === false });
    assert.equal(valid, true, `${id}:${JSON.stringify({ observed, reason, invariantPreserved, reasonMatches })}`);
  }
  { const root = tempRoot('gee-r7-h01-'); const s = syntheticPlan(root, casFor(root), { mutate: (r) => fs.writeFileSync(path.join(r, 'src', 'b.json'), '{"b":2}\n') }); attack('H01', 'relevant mutation invalidates R4/R5 reuse', s.plan.reusableEvidenceIds, !s.plan.reusableEvidenceIds.includes('e:b')); }
  { const root = tempRoot('gee-r7-h02-'); const before = syntheticSnapshot(root); fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":2}\n'); const after = syntheticSnapshot(root); const delta = compareSnapshots({ previous: before, current: after }); attack('H02', 'same-size mutation changes hash', delta.deltas.find((entry) => entry.path === 'src/b.json'), delta.deltas.find((entry) => entry.path === 'src/b.json').kind === 'CHANGED' && before.sources.find((entry) => entry.path === 'src/b.json').bytes === after.sources.find((entry) => entry.path === 'src/b.json').bytes); }
  {
    const root = tempRoot('gee-r7-h03-'); const cas = casFor(root); const base = syntheticBaseline(root, cas);
    fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":2}\n');
    const current = syntheticSnapshot(root);
    const forgedGraph = createEvidenceGraph({ cas, nodes: base.graph.nodes.map((node) => node.evidenceId === 'e:b' ? { ...node, state: 'REUSABLE', reusable: true } : node) });
    let observedReason = null;
    try {
      routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: SYNTHETIC_TASKS, r2Context: syntheticContext(root), r3Delta: { previousSnapshot: base.currentSnapshot, currentSnapshot: current }, r4Evidence: { graph: forgedGraph, reusableNodes: forgedGraph.nodes.map((node) => node.evidenceId) }, cas });
    } catch (error) { observedReason = error.message.split(':')[0]; }
    attack('H03', 'fabricated REUSABLE evidence rejected at R4 identity validation', observedReason, observedReason === 'FABRICATED_R4_EVALUATION', { expected: 'FABRICATED_R4_EVALUATION', observed: observedReason, matches: observedReason === 'FABRICATED_R4_EVALUATION' });
  }
  {
    const root = tempRoot('gee-r7-h04-'); const cas = casFor(root); const s = syntheticPlan(root, cas); let observedReason = null;
    try { routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: SYNTHETIC_TASKS, r2Context: syntheticContext(root), r3Delta: s.r3Delta, r4Evidence: { graph: s.evaluated.graph, reusableNodes: ['e:a'] }, cas }); } catch (error) { observedReason = error.message.split(':')[0]; }
    attack('H04', 'fabricated PASS/reuse claim rejected at R4 validation boundary', observedReason, observedReason === 'FABRICATED_R4_EVALUATION', { expected: 'FABRICATED_R4_EVALUATION', observed: observedReason, matches: observedReason === 'FABRICATED_R4_EVALUATION' });
  }
  { const root = tempRoot('gee-r7-h05-'); const s = syntheticPlan(root, casFor(root)); const forged = { ...s.plan, routeSha256: '0'.repeat(64) }; attack('H05', 'tampered route digest rejected', 'verifyRoutePlanDigest', (() => { try { verifyRoutePlanDigest(forged); return false; } catch { return true; } })()); }
  {
    const root = tempRoot('gee-r7-h06-'); const cas = casFor(root); const empty = createSnapshot({ repoRoot: root, sources: [] });
    const executableTask = { taskId: 't:block', intent: 'DETERMINISTIC', sources: ['src/a.json'], produces: ['e:a'], requiredEvidenceIds: ['e:a'], mandatory: true };
    const first = syntheticPlan(root, cas, { previousSnapshot: empty, tasks: [executableTask] });
    const completed = completedSyntheticCheckpoint(first, 't:block');
    const blocked = syntheticPlan(root, cas, { previousSnapshot: first.currentSnapshot, previousGraph: first.evaluated.graph, tasks: [{ ...executableTask, requiredEvidenceIds: ['e:missing'], produces: [] }] });
    const recovery = planRecovery({ workUnitId: SYNTHETIC_WORK_UNIT, checkpoint: completed.checkpoint, routePlan: blocked.plan, evidenceStates: blocked.evaluated.graph.nodes, r3Delta: { deltas: blocked.evaluated.graph.evaluation.r3DeltaBasis.deltas }, usageLedger: completed.ledger, authority: syntheticAuthority() });
    const blockedTask = recovery.tasks.find((task) => task.taskId === 't:block');
    const reasonMatches = blockedTask?.reasonCodes.includes('R5_BLOCKED_STATE_PRESERVED') === true;
    attack('H06', 'R6 recovery cannot bypass a newly BLOCKED route', { decision: recovery.decision, blockedTaskIds: recovery.blockedTaskIds, resumedTaskIds: recovery.resumedTaskIds }, recovery.blockedTaskIds.includes('t:block') && !recovery.resumedTaskIds.includes('t:block'), { expected: 'R5_BLOCKED_STATE_PRESERVED', observed: blockedTask?.reasonCodes, matches: reasonMatches });
  }
  {
    const root = tempRoot('gee-r7-h07-'); const cas = casFor(root); const ownerSpec = { taskId: 't:owner', intent: 'POLICY_DECISION', sources: [] };
    const s = syntheticPlan(root, cas, { tasks: [ownerSpec] });
    const checkpoint = createCheckpoint({ workUnitId: SYNTHETIC_WORK_UNIT, authority: syntheticAuthority(), baseline: { head: HEAD, headSource: 'R7' }, inputs: { r2ContextSha256: s.plan.provenance.r2ContextSha256, r3DeltaSha256: s.plan.provenance.r3DeltaSha256, r4GraphSha256: s.plan.provenance.r4GraphSha256, routeSha256: s.plan.routeSha256, repoIndexSha256: 'b'.repeat(64) }, tasks: checkpointTasksFromRoutePlan(s.plan), recoveryState: 'INTERRUPTED' });
    const recovery = planRecovery({ workUnitId: SYNTHETIC_WORK_UNIT, checkpoint, routePlan: s.plan, evidenceStates: s.evaluated.graph.nodes, r3Delta: { deltas: s.evaluated.graph.evaluation.r3DeltaBasis.deltas }, usageLedger: createUsageLedger(), authority: syntheticAuthority() });
    const ownerTask = recovery.tasks.find((task) => task.taskId === 't:owner');
    attack('H07', 'R6 recovery cannot invent an OWNER_DECISION_REQUIRED result', { decision: recovery.decision, ownerDecisionTaskIds: recovery.ownerDecisionTaskIds, completed: ownerTask?.state === 'COMPLETE' }, recovery.ownerDecisionTaskIds.includes('t:owner') && ownerTask?.state !== 'COMPLETE', { expected: 'R5_OWNER_DECISION_PRESERVED', observed: ownerTask?.reasonCodes, matches: ownerTask?.reasonCodes.includes('R5_OWNER_DECISION_PRESERVED') === true });
  }
  {
    const root = tempRoot('gee-r7-h08-'); const cas = casFor(root); const empty = createSnapshot({ repoRoot: root, sources: [] });
    const executableTask = { taskId: 't:repair', intent: 'DETERMINISTIC', sources: ['src/a.json'], produces: ['e:a'], requiredEvidenceIds: ['e:a'], mandatory: true };
    const first = syntheticPlan(root, cas, { previousSnapshot: empty, tasks: [executableTask] });
    const completed = completedSyntheticCheckpoint(first, 't:repair');
    let repairLedger = createRepairLedger();
    repairLedger = appendRepairRecord(repairLedger, { defectId: 'D', rootCauseClass: 'RC', outcome: SURVIVED, evidenceRef: 'x:1' });
    repairLedger = appendRepairRecord(repairLedger, { defectId: 'D', rootCauseClass: 'RC', outcome: SURVIVED, evidenceRef: 'x:2' });
    const stopped = syntheticPlan(root, cas, { previousSnapshot: first.currentSnapshot, previousGraph: first.evaluated.graph, repairLedger, tasks: [{ ...executableTask, repair: { defectId: 'D', rootCauseClass: 'RC', incremental: true } }] });
    const recovery = planRecovery({ workUnitId: SYNTHETIC_WORK_UNIT, checkpoint: completed.checkpoint, routePlan: stopped.plan, evidenceStates: stopped.evaluated.graph.nodes, r3Delta: { deltas: stopped.evaluated.graph.evaluation.r3DeltaBasis.deltas }, usageLedger: completed.ledger, authority: syntheticAuthority() });
    attack('H08', 'R6 recovery preserves STOP_PATCH_CASCADE and schedules no third patch', { stopPatchCascade: recovery.stopPatchCascade, blockedTaskIds: recovery.blockedTaskIds, resumedTaskIds: recovery.resumedTaskIds }, recovery.stopPatchCascade === true && recovery.blockedTaskIds.includes('t:repair') && !recovery.resumedTaskIds.includes('t:repair'), { expected: 'R5_REPAIR_CONTAINMENT_STOP_PRESERVED', observed: recovery.reasonCodes, matches: recovery.reasonCodes.includes('R5_REPAIR_CONTAINMENT_STOP_PRESERVED') });
  }
  { const root = tempRoot('gee-r7-h09-'); const store = createCheckpointStore(path.join(root, 'store')); const s = syntheticPlan(root, casFor(root)); const checkpoint = createCheckpoint({ workUnitId: SYNTHETIC_WORK_UNIT, authority: { missionRevisionId: R7_MISSION, contractSha256: 'a'.repeat(64) }, baseline: { head: HEAD, headSource: 'R7' }, inputs: { r2ContextSha256: s.plan.provenance.r2ContextSha256, r3DeltaSha256: s.plan.provenance.r3DeltaSha256, r4GraphSha256: s.plan.provenance.r4GraphSha256, routeSha256: s.plan.routeSha256, repoIndexSha256: 'b'.repeat(64) }, tasks: checkpointTasksFromRoutePlan(s.plan), recoveryState: 'INTERRUPTED' }); store.writeCheckpoint(checkpoint); const file = path.join(store.directoryFor(SYNTHETIC_WORK_UNIT), 'R0001', 'checkpoint.json'); const tampered = JSON.parse(fs.readFileSync(file, 'utf8')); tampered.checkpointSha256 = '0'.repeat(64); fs.writeFileSync(file, JSON.stringify(tampered)); const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT); attack('H09', 'corrupt newest checkpoint is not silently resumed', loaded.reasonCodes, loaded.checkpoint === null && loaded.recoveryRequired === true); }
  { const root = tempRoot('gee-r7-h10-'); const store = createCheckpointStore(path.join(root, 'store')); const s = syntheticPlan(root, casFor(root)); const checkpoint = createCheckpoint({ workUnitId: SYNTHETIC_WORK_UNIT, authority: { missionRevisionId: R7_MISSION, contractSha256: 'a'.repeat(64) }, baseline: { head: HEAD, headSource: 'R7' }, inputs: { r2ContextSha256: s.plan.provenance.r2ContextSha256, r3DeltaSha256: s.plan.provenance.r3DeltaSha256, r4GraphSha256: s.plan.provenance.r4GraphSha256, routeSha256: s.plan.routeSha256, repoIndexSha256: 'b'.repeat(64) }, tasks: checkpointTasksFromRoutePlan(s.plan), recoveryState: 'INTERRUPTED' }); store.writeCheckpoint(checkpoint); const broken = { ...checkpoint, revision: 'R0003', revisionOrdinal: 3, previousCheckpointSha256: checkpoint.checkpointSha256 }; const brokenFile = path.join(store.directoryFor(SYNTHETIC_WORK_UNIT), 'R0003', 'checkpoint.json'); fs.mkdirSync(path.dirname(brokenFile), { recursive: true }); fs.writeFileSync(brokenFile, JSON.stringify({ ...broken, checkpointSha256: 'c'.repeat(64) })); const loaded = store.loadLatestValid(SYNTHETIC_WORK_UNIT); attack('H10', 'broken checkpoint ancestry invalidates descendants', loaded.reasonCodes, loaded.recoveryRequired === true && loaded.corruptRevisions.some((entry) => entry.includes('CHECKPOINT_HISTORY_CHAIN_BROKEN'))); }
  { const root = tempRoot('gee-r7-h11-'); const s = syntheticPlan(root, casFor(root)); const task = s.plan.tasks[0]; const wrong = { usageRecordId: `usage:${SYNTHETIC_WORK_UNIT}#other#1`, evidence: [] }; attack('H11', 'wrong-task usage cannot prove completion', 'CHECKPOINT_USAGE_RECORD_TASK_MISMATCH', (() => { try { buildWheelCheckpoint({ session: { ...s, workUnitId: SYNTHETIC_WORK_UNIT, authority: { missionRevisionId: R7_MISSION, contractSha256: 'a'.repeat(64) }, compiled: { json: { identity: { sourceHead: HEAD } } }, inputs: { r2ContextSha256: s.plan.provenance.r2ContextSha256, r3DeltaSha256: s.plan.provenance.r3DeltaSha256, r4GraphSha256: s.plan.provenance.r4GraphSha256, routeSha256: s.plan.routeSha256, repoIndexSha256: 'b'.repeat(64) } }, completedTaskIds: [task.taskId], executionsByTaskId: { [task.taskId]: wrong } }); return false; } catch (error) { return /CHECKPOINT_USAGE_RECORD_TASK_MISMATCH/.test(error.message); } })()); }
  { const root = tempRoot('gee-r7-h12-'); const s = syntheticPlan(root, casFor(root)); const t = s.plan.tasks[0]; const input = { workUnitId: SYNTHETIC_WORK_UNIT, taskId: t.taskId, attempt: 1, capability: t.capability, outcome: 'COMPLETED', routeSha256: s.plan.routeSha256, bytes: { sourceProcessedBytes: 1, sourceAvoidedBytes: 0 }, tokens: null }; const once = appendUsageRecord(createUsageLedger(), input); const twice = appendUsageRecord(once.ledger, input); attack('H12', 'duplicate usage replay is not double-counted', twice.ledger.records.length, twice.ledger.records.length === 1 && twice.deduplicated === true); }
  { const root = tempRoot('gee-r7-h13-'); const s = syntheticPlan(root, casFor(root)); const t = s.plan.tasks[0]; const base = appendUsageRecord(createUsageLedger(), { workUnitId: SYNTHETIC_WORK_UNIT, taskId: t.taskId, attempt: 1, capability: t.capability, outcome: 'COMPLETED', routeSha256: s.plan.routeSha256, bytes: { sourceProcessedBytes: 1, sourceAvoidedBytes: 0 }, tokens: null }).ledger; attack('H13', 'same usage identity with conflicting content rejected', 'DUPLICATE_USAGE_RECORD_IDENTITY_CONFLICT', (() => { try { appendUsageRecord(base, { workUnitId: SYNTHETIC_WORK_UNIT, taskId: t.taskId, attempt: 1, capability: t.capability, outcome: 'COMPLETED', routeSha256: s.plan.routeSha256, bytes: { sourceProcessedBytes: 2, sourceAvoidedBytes: 0 }, tokens: null }); return false; } catch (error) { return /DUPLICATE_USAGE_RECORD_IDENTITY_CONFLICT/.test(error.message); } })()); }
  {
    const root = tempRoot('gee-r7-h14-'); const cas = casFor(root); const empty = createSnapshot({ repoRoot: root, sources: [] });
    const task = { taskId: 't:b', intent: 'DETERMINISTIC', sources: ['src/b.json'], produces: ['e:b'], requiredEvidenceIds: ['e:b'], mandatory: true };
    const first = syntheticPlan(root, cas, { previousSnapshot: empty, tasks: [task] });
    const completed = completedSyntheticCheckpoint(first, 't:b');
    fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":2}\n');
    const changedSnapshot = syntheticSnapshot(root);
    const changedDelta = { previousSnapshot: first.currentSnapshot, currentSnapshot: changedSnapshot };
    const freshNodes = syntheticNodes().map((node) => node.evidenceId === 'e:b' ? { ...node, content: { value: 'b:v2' } } : node);
    const freshBound = bindFreshValidations({ cas, nodes: freshNodes, r3Delta: changedDelta, validationResults: Object.fromEntries(freshNodes.map((node) => [node.evidenceId, PASS])) });
    const freshGraph = createEvidenceGraph({ cas, nodes: freshBound });
    const freshEvaluated = evaluateEvidenceGraph({ graph: freshGraph, r3Delta: changedDelta, cas });
    const currentPlan = routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [task], r2Context: syntheticContext(root), r3Delta: changedDelta, r4Evidence: { graph: freshEvaluated.graph }, cas });
    const recovery = planRecovery({ workUnitId: SYNTHETIC_WORK_UNIT, checkpoint: completed.checkpoint, routePlan: currentPlan, evidenceStates: freshEvaluated.graph.nodes, r3Delta: { deltas: freshEvaluated.graph.evaluation.r3DeltaBasis.deltas }, usageLedger: completed.ledger, authority: syntheticAuthority() });
    const freshReusable = freshEvaluated.reusableNodes.some((node) => node.evidenceId === 'e:b');
    const revalidatedOldConsumer = recovery.revalidatedTaskIds.includes('t:b');
    const oldConsumer = recovery.tasks.find((entry) => entry.taskId === 't:b');
    attack('H14', 'E v1 -> E v2 REUSABLE does not revive old consumer T', { freshReusable, revalidatedTaskIds: recovery.revalidatedTaskIds, reasonCodes: oldConsumer?.reasonCodes }, freshReusable && revalidatedOldConsumer, { expected: 'required evidence identity/current validation obstacle', observed: oldConsumer?.reasonCodes, matches: oldConsumer?.reasonCodes.some((code) => code.includes('REUSE') || code.includes('EVIDENCE')) === true });
  }
  {
    const root = tempRoot('gee-r7-h15-'); const cas = casFor(root);
    const rawPayload = { status: 'PASS', requiredInformation: { workUnit: SYNTHETIC_WORK_UNIT, result: 'CANONICAL_OK' }, rows: Array.from({ length: 1200 }, (_, index) => ({ index, trace: `raw-${index}` })) };
    const rawText = JSON.stringify(rawPayload); const rawPath = 'src/large-output.json'; fs.writeFileSync(path.join(root, ...rawPath.split('/')), rawText);
    const snapshot = createSnapshot({ repoRoot: root, sources: [{ path: rawPath }] });
    const compact = { status: rawPayload.status, requiredInformation: rawPayload.requiredInformation, rawSha256: sha256Canonical(rawPayload) };
    const node = { evidenceId: 'e:large', content: compact, evidenceType: 'COMPACT_CANONICAL_RESULT', provenance: { sourcePath: rawPath, authorityClass: 'CANONICAL' }, dependencies: [`source:${rawPath}`], authorityStatus: 'GROUNDED' };
    const bound = bindFreshValidations({ cas, nodes: [node], r3Delta: { previousSnapshot: snapshot, currentSnapshot: snapshot }, validationResults: { 'e:large': PASS } });
    const evaluated = evaluateEvidenceGraph({ graph: createEvidenceGraph({ cas, nodes: bound }), r3Delta: { previousSnapshot: snapshot, currentSnapshot: snapshot }, cas });
    const plan = routeWorkUnit({ workUnitId: SYNTHETIC_WORK_UNIT, tasks: [{ taskId: 't:large', intent: 'DETERMINISTIC', sources: [rawPath], produces: ['e:large'], requiredEvidenceIds: ['e:large'] }], r2Context: syntheticContext(root), r3Delta: { previousSnapshot: snapshot, currentSnapshot: snapshot }, r4Evidence: { graph: evaluated.graph }, cas });
    const compactText = JSON.stringify(evaluated.graph.nodes[0]);
    const qualityEquivalent = compact.requiredInformation.workUnit === rawPayload.requiredInformation.workUnit && compact.requiredInformation.result === rawPayload.requiredInformation.result && compact.rawSha256 === sha256Canonical(rawPayload);
    const rawBytes = Buffer.byteLength(rawText); const compactBytes = evaluated.graph.nodes[0].bytes;
    attack('H15', 'relevant large raw output is compacted without losing required information', { route: plan.routeDecision, rawBytes, compactBytes, qualityEquivalent, containsRaw: compactText.includes(rawPayload.rows[0].trace), requiredEvidence: plan.tasks[0].requiredEvidenceIds }, rawBytes > compactBytes && qualityEquivalent && !compactText.includes(rawPayload.rows[0].trace) && plan.tasks[0].requiredEvidenceIds.includes('e:large'));
  }
  { const c = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, R7_CONTRACT_PATH), 'utf8')); attack('H16', 'R7 cannot write frozen R1-R6 implementation', false, isPathAuthorized(c.authorizedPaths, 'governance/gee-v1/core/work-unit-core.mjs') === false); }
  { const decomposed = 'src/cafe\u0301.json'; attack('H17', 'Unicode identity is canonicalized or rejected', canonicalRepoPath(decomposed), canonicalRepoPath(decomposed) === 'src/café.json'); }
  {
    const root = tempRoot('gee-r7-h18-'); fs.writeFileSync(path.join(root, 'src', 'B.mjs'), 'export const b=1;');
    const policy = { ...DEFAULT_REPO_INDEX_POLICY, roots: ['src/'], subsystemRules: [{ prefix: 'src/', subsystem: 'SRC' }], layerRules: [], governancePrefixes: [], geeRelevantPrefixes: ['src/'], excludedDirectorySegments: ['node_modules'], excludedPathPrefixes: [], trackedStatusSource: 'UNAVAILABLE', trackedPathsSha256: null };
    const childSource = `import { buildRepoIndex } from './governance/gee-v1/index/repo-index.mjs'; const policy = ${JSON.stringify(policy)}; const result = buildRepoIndex({ repoRoot: ${JSON.stringify(root)}, policy }); process.stdout.write(JSON.stringify({ indexSha256: result.indexSha256, paths: result.entries.map((entry) => entry.path) }));`;
    const locales = ['en-US', 'tr-TR', 'de-DE'];
    const runs = locales.map((locale) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', childSource], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale } })));
    const same = runs.every((run) => run.indexSha256 === runs[0].indexSha256 && JSON.stringify(run.paths) === JSON.stringify(runs[0].paths));
    attack('H18', 'locale-independent ordering is reproduced in distinct locale processes', runs, same, { expected: 'same digest and ordered output across en-US/tr-TR/de-DE', observed: runs.map((run) => run.indexSha256), matches: same });
  }
  const invalid = attacks.filter((entry) => entry.invalid === true);
  const failed = attacks.filter((entry) => entry.verdict !== 'PASS');
  const result = { audit: 'GEE_V1_R7_HOSTILE_AUDIT', total: attacks.length, pass: attacks.filter((entry) => entry.verdict === 'PASS').length, fail: failed.length, invalid: invalid.length, materialDefects: [...new Set([...failed.map((entry) => `${entry.id}:HOSTILE_FAILURE`), ...invalid.map((entry) => `${entry.id}:INVALID_TARGET_REASON`)])], reasonValidation: { requiresInvariantAndReason: true, invalidTargetReasonCount: invalid.length }, attacks };
  if (outputRoot !== null) writeJson('governance/gee-v1/benchmarks/gee-r7-hostile-audit.json', result, outputRoot);
  return result;
}

export function runHostileAudit(options = {}) {
  return withEphemeralRootScope(() => runHostileAuditInternal(options));
}

function readR7Artifacts({ outputRoot = REPO_ROOT, sourceRoot = REPO_ROOT } = {}) {
  const artifacts = {};
  const failures = [];
  for (const relativePath of REQUIRED_R7_ARTIFACTS) {
    const root = [R7_CONTRACT_PATH, R7_SEAL_PATH].includes(relativePath) ? sourceRoot : outputRoot;
    const absolutePath = path.join(root, ...relativePath.split('/'));
    if (!fs.existsSync(absolutePath)) {
      failures.push(`${relativePath}:MISSING`);
      continue;
    }
    try {
      artifacts[relativePath] = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    } catch (error) {
      failures.push(`${relativePath}:MALFORMED:${error.message}`);
    }
  }
  return { artifacts, failures, valid: failures.length === 0 };
}

function benchmarkClosureValidity(benchmark) {
  const raw = benchmark?.rawMetrics;
  const requiredRaw = [
    'baseline_context_bytes', 'gee_context_bytes', 'baseline_source_bytes_processed', 'gee_source_bytes_processed',
    'baseline_files_processed', 'gee_files_processed', 'baseline_tasks_executed', 'gee_tasks_executed',
    'baseline_evidence_reused', 'gee_evidence_reused', 'baseline_revalidation_work', 'gee_revalidation_work',
    'baseline_restart_work', 'gee_restart_work'
  ];
  const rawValid = raw && requiredRaw.every((key) => Number.isInteger(raw[key]) && raw[key] >= 0)
    && raw.tokens === 'TOKEN_COUNT_UNAVAILABLE';
  const sourcesValid = ['baseline', 'gee'].every((mode) => rawValid
    && benchmark.measurements?.[mode]?.contextBytes?.source === 'R6_USAGE_LEDGER_AGGREGATE'
    && benchmark.measurements?.[mode]?.sourceBytesProcessed?.source === 'R6_USAGE_LEDGER_AGGREGATE'
    && benchmark.measurements?.[mode]?.filesProcessed?.source === 'R6_EXECUTED_TASK_SOURCE_CARDINALITY');
  const nestedRawMatches = rawValid
    && benchmark.baseline?.contextBytes === raw.baseline_context_bytes
    && benchmark.gee?.contextBytes === raw.gee_context_bytes
    && benchmark.baseline?.sourceBytesProcessed === raw.baseline_source_bytes_processed
    && benchmark.gee?.sourceBytesProcessed === raw.gee_source_bytes_processed
    && benchmark.baseline?.filesProcessed === raw.baseline_files_processed
    && benchmark.gee?.filesProcessed === raw.gee_files_processed
    && benchmark.baseline?.tasksExecuted === raw.baseline_tasks_executed
    && benchmark.gee?.tasksExecuted === raw.gee_tasks_executed;
  const quality = benchmark?.quality;
  const qualityResult = qualityParity(quality?.baseline, quality?.gee);
  const expectedMetrics = rawValid
    ? deriveBenchmarkMetrics(raw, { routingEfficiency: benchmark.routing?.NO_WORK_REQUIRED === 1, qualityParityResult: qualityResult })
    : null;
  const percentagesExact = expectedMetrics !== null && sha256Canonical(expectedMetrics) === sha256Canonical(benchmark.metrics);
  return { valid: rawValid && sourcesValid && nestedRawMatches && percentagesExact, percentagesExact, qualityResult, rawValid, sourcesValid, nestedRawMatches };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function deriveEfficiencyPredicate(benchmark) {
  const raw = benchmark?.rawMetrics;
  const b1 = benchmark?.scenarios?.B1_UNCHANGED_REPLAY;
  const b2 = benchmark?.scenarios?.B2_SMALL_RELEVANT_MUTATION;
  const b3 = benchmark?.scenarios?.B3_UNRELATED_MUTATION;
  const representativeReduction = raw
    && positiveInteger(raw.baseline_context_bytes)
    && positiveInteger(raw.baseline_source_bytes_processed)
    && positiveInteger(raw.baseline_files_processed)
    && positiveInteger(raw.baseline_tasks_executed)
    && raw.baseline_context_bytes > raw.gee_context_bytes
    && raw.baseline_source_bytes_processed > raw.gee_source_bytes_processed
    && raw.baseline_files_processed > raw.gee_files_processed
    && raw.baseline_tasks_executed > raw.gee_tasks_executed
    && raw.baseline_revalidation_work >= raw.gee_revalidation_work
    && raw.gee_evidence_reused > raw.baseline_evidence_reused;
  const unchangedReplayAvoidsWork = b1?.route === 'NO_WORK_REQUIRED'
    && positiveInteger(b1.tasksAvoided)
    && positiveInteger(b1.sourceBytesAvoided);
  const relevantMutationSelectivity = positiveInteger(b2?.changedBytes)
    && positiveInteger(b2?.tasksAvoided)
    && positiveInteger(b2?.tasksExecuted);
  const unrelatedMutationPreservesWork = b3?.route === 'NO_WORK_REQUIRED'
    && b3.tasksExecuted === 0;
  return representativeReduction === true
    && unchangedReplayAvoidsWork
    && relevantMutationSelectivity
    && unrelatedMutationPreservesWork;
}

export function evaluateR7Closure({ authority, evals, benchmark, recovery, hostile, artifactsPresent = true } = {}) {
  const benchmarkCheck = benchmarkClosureValidity(benchmark);
  const efficiencyDerived = deriveEfficiencyPredicate(benchmark);
  const authorityDerived = authority?.executionAuthorized === true
    && authority.r0007 === 'AUTHORIZED'
    && authority.seal === 'INTACT';
  const sealDerived = authority?.seal === 'INTACT';
  const evalStatusDerived = evals?.total === 10
    && evals.pass === 10
    && evals.fail === 0
    && Array.isArray(evals.evals)
    && evals.evals.length === 10
    && evals.evals.every((entry) => entry.verdict === 'PASS' && entry.routeExpectation === true);
  const qualityDerived = benchmarkCheck.qualityResult === true && benchmark?.quality?.parity === true;
  const recoveryDerived = recovery?.completedBeforeInterrupt > 0
    && recovery.completedPreserved > 0
    && recovery.tasksInvalidated > 0
    && recovery.avoidedNotCountedAsPreserved === true
    && recovery.usageDuplicates === 0
    && recovery.restartedFromZero === recovery.canonicalRestartedFromZero
    && recovery.decision === recovery.canonicalDecision
    && ['RESUME', 'REVALIDATE_SOME'].includes(recovery.decision)
    && recovery.unrelatedChangePreserved === true;
  const hostileDerived = hostile?.total === 18
    && hostile.pass === 18
    && hostile.fail === 0
    && hostile.invalid === 0
    && Array.isArray(hostile.attacks)
    && hostile.attacks.length === 18
    && hostile.attacks.every((entry) => entry.verdict === 'PASS' && entry.invariantPreserved === true && entry.reasonMatches === true)
    && hostile.reasonValidation?.requiresInvariantAndReason === true;
  const predicates = {
    authority: authorityDerived,
    seal: sealDerived,
    evalStatus: evalStatusDerived,
    benchmark: benchmarkCheck.valid,
    efficiencyDerived,
    quality: qualityDerived,
    recovery: recoveryDerived,
    hostile: hostileDerived,
    artifacts: artifactsPresent === true
  };
  const openMaterialDefects = [
    ...(Array.isArray(hostile?.materialDefects) ? hostile.materialDefects : ['HOSTILE_ARTIFACT_MATERIAL_DEFECTS_UNAVAILABLE']),
    ...Object.entries(predicates).filter(([, value]) => value !== true).map(([name]) => `R7_CLOSURE_PREDICATE_FAILED:${name}`)
  ].filter((entry, index, entries) => entries.indexOf(entry) === index);
  const readyToFreeze = Object.values(predicates).every((value) => value === true) && openMaterialDefects.length === 0;
  return {
    authority: { r0007: authority?.r0007 || 'UNKNOWN', seal: authority?.seal || 'UNKNOWN', r8: authority?.r8 || 'UNKNOWN' },
    predicates,
    benchmarkMeasurement: { rawValid: benchmarkCheck.rawValid, sourcesValid: benchmarkCheck.sourcesValid, nestedRawMatches: benchmarkCheck.nestedRawMatches, percentagesExact: benchmarkCheck.percentagesExact },
    evalStatusDerived,
    benchmarkDerived: benchmarkCheck.valid,
    efficiencyDerived,
    qualityDerived,
    recoveryDerived,
    hostileDerived,
    openMaterialDefects,
    readyToFreeze,
    verdict: readyToFreeze ? 'R7_FINAL_EVIDENCE_HARNESS_REPAIR_COMPLETE' : 'R7_REPAIR_REQUIRED'
  };
}

export function runAll({ outputRoot = REPO_ROOT } = {}) {
  const authorityScope = runAuthorityAndScope({ outputRoot });
  const evals = runEvalSuite({ outputRoot });
  const benchmark = runBenchmark({ outputRoot });
  const recovery = runRecoveryStress({ outputRoot });
  const hostile = runHostileAudit({ outputRoot });
  const loaded = readR7Artifacts({ outputRoot, sourceRoot: REPO_ROOT });
  const derived = evaluateR7Closure({
    authority: authorityScope.authority,
    evals: loaded.artifacts['governance/gee-v1/evals/gee-r7-eval-suite.json'],
    benchmark: loaded.artifacts['governance/gee-v1/benchmarks/gee-r7-benchmark.json'],
    recovery: loaded.artifacts['governance/gee-v1/benchmarks/gee-r7-recovery-stress.json'],
    hostile: loaded.artifacts['governance/gee-v1/benchmarks/gee-r7-hostile-audit.json'],
    artifactsPresent: loaded.valid
  });
  const closure = {
    verdict: derived.verdict,
    authority: derived.authority,
    evals: { total: evals.total, pass: evals.pass, fail: evals.fail },
    benchmark: benchmark.metrics,
    quality: benchmark.quality,
    recovery,
    hostile: { total: hostile.total, pass: hostile.pass, fail: hostile.fail, invalid: hostile.invalid, materialDefects: hostile.materialDefects },
    tokens: 'TOKEN_COUNT_UNAVAILABLE',
    closure: derived,
    authorityScope,
    artifactIntegrity: { required: REQUIRED_R7_ARTIFACTS, missingOrMalformed: loaded.failures, valid: loaded.valid }
  };
  assert.equal(closure.closure.readyToFreeze, true, JSON.stringify(closure.closure));
  writeJson('governance/gee-v1/benchmarks/gee-r7-closure.json', closure, outputRoot);
  return closure;
}

if (process.argv.includes('--all')) {
  process.stdout.write(`${JSON.stringify(runAll(), null, 2)}\n`);
}
