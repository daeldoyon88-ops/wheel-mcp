/**
 * Tests for GATE_PREEXECUTION_REUSE_CHECK.
 *
 * The check exists to stop a future Gate from rediscovering work that already
 * exists, so what has to be proven is not "it returns READY" but:
 *   - it recomputes, and would notice, real breakage (no hardcoded PASS);
 *   - it fails closed on unknown or unreadable input;
 *   - it separates "this artifact does not exist yet, which is normal" from
 *     "the mechanism to make it does not exist";
 *   - the GEE liveness checks EXECUTE the engines rather than asserting them.
 *
 * Hostile cases operate on a scratch copy under the OS temp directory. The real
 * repository is never mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreexecutionReuseCheck, resolveGeeReferenceWorkUnit, CHECK_DOCUMENT } from '../tools/gate-preexecution-reuse-check.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const idOf = (report, id) => report.checks.find((entry) => entry.id === id);

/** A scratch repository that shares the real governance tree by copy. */
function scratchRepo(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preexec-check-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  mutate(root);
  return root;
}

test('P01 the real GATE15 is READY with zero preexecution and zero systemic gaps', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  assert.equal(report.document, CHECK_DOCUMENT);
  assert.equal(report.verdict, 'READY');
  assert.equal(report.counts.preexecutionGaps, 0);
  assert.equal(report.counts.systemicGaps, 0);
  assert.deepEqual(report.errors, []);
});

test('P02 a Gate whose dependency is not closed is GATE_LOCAL_EXPECTED, never a gap', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE16' });
  const dependencies = idOf(report, 'DEPENDENCIES_SATISFIABLE');
  assert.equal(dependencies.status, 'FAIL');
  assert.equal(dependencies.class, 'GATE_LOCAL_EXPECTED');
  assert.equal(report.counts.preexecutionGaps, 0);
  assert.equal(report.counts.systemicGaps, 0);
  assert.equal(report.verdict, 'READY_WHEN_SEQUENCED');
});

test('P03 an absent execution contract and state revision are NOT reported as gaps', async () => {
  // GATE15 has no contract and no state on disk, which is exactly correct before START.
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'governance/gates/GATE15')), false);
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  assert.equal(idOf(report, 'CONTRACT_DERIVABLE').status, 'PASS');
  assert.equal(report.counts.preexecutionGaps, 0);
});

test('P04 every lifecycle primitive resolves to a real module', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  for (const id of ['AUTHORITY_PRIMITIVE_EXISTS', 'START_PRIMITIVE_EXISTS', 'STATE_PRIMITIVE_EXISTS',
    'CLOSURE_PRIMITIVE_EXISTS', 'CONTRACT_SUCCESSION_PRIMITIVE_EXISTS', 'EVIDENCE_MODEL_EXISTS',
    'INDEPENDENCE_PATH_EXISTS']) {
    assert.equal(idOf(report, id).status, 'PASS', `${id} must resolve`);
  }
});

test('P05 the GEE checks execute the engines and report measured numbers', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  const r2 = idOf(report, 'GEE_CONTEXT_LIVE');
  assert.equal(r2.status, 'PASS');
  // A measured reduction cannot be produced by asserting liveness; it can only
  // come from having actually compiled a context.
  assert.ok(r2.detail.reductionRatio > 1, 'R2 must report a real reduction ratio');
  assert.ok(r2.detail.compiledJsonBytes > 0 && r2.detail.compiledJsonBytes < r2.detail.sourceBytes);
  assert.match(idOf(report, 'GEE_DELTA_LIVE').detail.snapshotSha256, /^[a-f0-9]{64}$/);
  assert.match(idOf(report, 'GEE_EVIDENCE_REUSE_LIVE').detail.graphSha256, /^[a-f0-9]{64}$/);
  assert.ok(idOf(report, 'GEE_MIN_FRONTIER_LIVE').detail.taskCount >= 0);
});

test('P06 the GEE reference work unit is resolved from real seal state, not hardcoded', async () => {
  const { createWheelProjectAdapter } = await import('../gee-v1/adapters/wheel/wheel-project-adapter.mjs');
  const { createProjectSession } = await import('../gee-v1/core/work-unit-core.mjs');
  const session = createProjectSession(createWheelProjectAdapter(REPO_ROOT));
  const { workUnitId, candidates } = resolveGeeReferenceWorkUnit({ root: REPO_ROOT, session });
  assert.ok(candidates.length > 1, 'more than one closed gate exists, so a choice really is being made');
  assert.equal(session.getWorkUnit(workUnitId).authorityState.sealValid, true);
  // The chosen unit is the highest-numbered closed gate whose seal verifies; a
  // closed gate with an invalid seal must be skipped rather than selected.
  const skipped = candidates.filter((gateId) => gateId > workUnitId);
  for (const gateId of skipped) {
    assert.notEqual(session.getWorkUnit(gateId).authorityState.sealValid, true);
  }
});

test('P07 unrelated dirty work is reported, never treated as a blocker', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  const git = idOf(report, 'GIT_CONTAINMENT_AVAILABLE');
  assert.equal(git.status, 'PASS');
  assert.ok(git.detail.totalDirtyPaths >= git.detail.governanceDirtyPaths);
  assert.equal(git.class, 'NONE');
});

test('H01 an unknown gate id fails closed', async () => {
  for (const gateId of [null, undefined, '', 'GATE', 'gate15', 'GATE999', '../../etc']) {
    const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId });
    assert.equal(report.verdict, 'BLOCKED', `${gateId} must be BLOCKED`);
    assert.equal(report.counts.systemicGaps, 1);
  }
});

test('H02 a gate absent from the registry is BLOCKED, not silently READY', async () => {
  const report = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE99' });
  assert.equal(report.verdict, 'BLOCKED');
  assert.equal(idOf(report, 'MANDATE_CANONICAL').status, 'FAIL');
  assert.equal(idOf(report, 'MANDATE_CANONICAL').class, 'PREEXECUTION_GAP');
});

test('H03 an incomplete mandate is detected — the check reads real bytes', async () => {
  const root = scratchRepo((scratch) => {
    const file = path.join(scratch, 'governance/GATE_REGISTRY_00_40.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gate = registry.gates.find((entry) => entry.gateId === 'GATE15');
    gate.definitionCompleteness = 'PARTIAL';
    gate.missingCanonicalFields = ['closureConditions'];
    fs.writeFileSync(file, JSON.stringify(registry, null, 2));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE15' });
    assert.equal(idOf(report, 'MANDATE_CANONICAL').status, 'FAIL');
    assert.equal(report.verdict, 'BLOCKED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H04 a vanished prior-research source is caught — this is the anti-amnesia check', async () => {
  const root = scratchRepo((scratch) => {
    fs.rmSync(path.join(scratch, 'governance/sources/GATE15_CANONICAL_MANDATE_R0.json'));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE15' });
    const reused = idOf(report, 'PRIOR_RESEARCH_REUSED');
    assert.equal(reused.status, 'FAIL');
    assert.equal(reused.class, 'PREEXECUTION_GAP');
    assert.equal(reused.detail.unresolved[0].reason, 'ABSENT');
    assert.equal(idOf(report, 'UNKNOWN_PREWORK').status, 'FAIL');
    assert.equal(report.verdict, 'BLOCKED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H05 a prior-research source whose pinned digest drifted is caught', async () => {
  const root = scratchRepo((scratch) => {
    const file = path.join(scratch, 'governance/GATE_REGISTRY_00_40.json');
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const gate = registry.gates.find((entry) => entry.gateId === 'GATE21');
    // GATE21 pins the roadmap digest; break the roadmap bytes, not the pin.
    fs.appendFileSync(path.join(scratch, 'governance/sources/WHEEL_JARVISE_MASTER_ROADMAP_00_40.txt'), '\nDRIFT\n');
    assert.ok(gate.sourceReferences.some((ref) => ref.sourceSha256));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE21' });
    const reused = idOf(report, 'PRIOR_RESEARCH_REUSED');
    assert.equal(reused.status, 'FAIL');
    assert.equal(reused.detail.unresolved[0].reason, 'DIGEST_DRIFT');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H06 a missing lifecycle primitive is SYSTEMIC, not gate-local', async () => {
  const root = scratchRepo((scratch) => {
    fs.rmSync(path.join(scratch, 'governance/gee-v1/core/gate-start-authority.mjs'));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE15' });
    const start = idOf(report, 'START_PRIMITIVE_EXISTS');
    assert.equal(start.status, 'FAIL');
    assert.equal(start.class, 'SYSTEMIC_GAP');
    assert.equal(report.verdict, 'BLOCKED');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H07 an absent regression baseline is a PREEXECUTION_GAP, never a silent pass', async () => {
  const root = scratchRepo((scratch) => {
    fs.rmSync(path.join(scratch, 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json'));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE15' });
    const baseline = idOf(report, 'REGRESSION_BASELINE_KNOWN');
    assert.equal(baseline.status, 'FAIL');
    assert.equal(baseline.class, 'PREEXECUTION_GAP');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H08 a self-inconsistent regression baseline does not pass', async () => {
  const root = scratchRepo((scratch) => {
    const file = path.join(scratch, 'governance/master-matrix/REGRESSION_IDENTITY_BASELINE_V1.json');
    const baseline = JSON.parse(fs.readFileSync(file, 'utf8'));
    baseline.failureIdentityCount = baseline.failureIdentityCount + 1;
    fs.writeFileSync(file, JSON.stringify(baseline, null, 2));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root, gateId: 'GATE15' });
    assert.equal(idOf(report, 'REGRESSION_BASELINE_KNOWN').status, 'FAIL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('H09 an open P0/P1 in the gap register blocks, and an absent register does not pass silently', async () => {
  const openRoot = scratchRepo((scratch) => {
    const file = path.join(scratch, 'governance/master-matrix/MASTER_GAP_REGISTER_V1.json');
    const register = JSON.parse(fs.readFileSync(file, 'utf8'));
    register.findings.push({ id: 'TEST-P0', severity: 'P0', status: 'OPEN', title: 'synthetic' });
    fs.writeFileSync(file, JSON.stringify(register, null, 2));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root: openRoot, gateId: 'GATE15' });
    const systemic = idOf(report, 'SYSTEMIC_GAPS');
    assert.equal(systemic.status, 'FAIL');
    assert.equal(systemic.detail.openP0P1, 1);
    assert.equal(report.verdict, 'BLOCKED');
  } finally {
    fs.rmSync(openRoot, { recursive: true, force: true });
  }

  const absentRoot = scratchRepo((scratch) => {
    fs.rmSync(path.join(scratch, 'governance/master-matrix/MASTER_GAP_REGISTER_V1.json'));
  });
  try {
    const report = await runPreexecutionReuseCheck({ root: absentRoot, gateId: 'GATE15' });
    assert.equal(idOf(report, 'SYSTEMIC_GAPS').status, 'FAIL');
    assert.equal(idOf(report, 'SYSTEMIC_GAPS').detail.openP0P1, null);
  } finally {
    fs.rmSync(absentRoot, { recursive: true, force: true });
  }
});

test('H10 the check writes nothing inside the repository', async () => {
  const before = fs.readdirSync(path.join(REPO_ROOT, 'governance')).sort();
  await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  assert.deepEqual(fs.readdirSync(path.join(REPO_ROOT, 'governance')).sort(), before);
});

test('H11 the verdict is recomputed, never read from a field', async () => {
  const first = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  const second = await runPreexecutionReuseCheck({ root: REPO_ROOT, gateId: 'GATE15' });
  assert.deepEqual(
    first.checks.map((entry) => [entry.id, entry.status, entry.class]),
    second.checks.map((entry) => [entry.id, entry.status, entry.class])
  );
  // Nothing in the report is copied from a stored verdict field.
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes('"hardcodedVerdict"'), false);
});
