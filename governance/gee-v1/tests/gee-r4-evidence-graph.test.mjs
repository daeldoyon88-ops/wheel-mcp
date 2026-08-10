import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createContentAddressedStore } from '../cas/content-addressed-store.mjs';
import { bindFreshValidations, canonicalEvidenceId, createEvidenceGraph, createFreshValidation, evaluateEvidenceGraph, interpretValidation, validateGraph, REUSABLE, INVALIDATED } from '../evidence/evidence-graph.mjs';
import { sha256Canonical } from '../../tools/canonical-json.mjs';
import { createWheelEvidenceGraph, evaluateWheelEvidenceGraph } from '../adapters/wheel/evidence-wheel-adapter.mjs';
import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { createWheelDeltaSnapshot } from '../adapters/wheel/delta-wheel-adapter.mjs';
import { compileContext } from '../context/compile-context.mjs';
import { compareSnapshots, createSnapshot } from '../delta/delta-engine.mjs';
import { createGeeMissionAuthoritySource, MISSION_WORK_UNIT_TYPE } from '../adapters/gee-mission-authority-source.mjs';
import { createExecutionAuthorityRegistry, resolveExecutionAuthority } from '../core/work-unit-core.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CANONICAL_HEAD = 'df5e7f67e92e0f61126d6ae6b842942238cd9721';

// A producing validation outcome supplied by an external producing process.
// R4 never invents it, so every reusable fixture has to state it explicitly.
const PASS = Object.freeze({ validator: 'TEST_PRODUCING_VALIDATOR', result: 'PASS' });

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r4-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}');
  fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":1}');
  return root;
}

function casFor(root) { return createContentAddressedStore(path.join(root, 'cas')); }

function r3Delta(root, mutate = null, sourcePaths = ['src/a.json', 'src/b.json'], currentSourcePaths = sourcePaths) {
  const previous = createSnapshot({ repoRoot: root, sources: sourcePaths.map((p) => ({ path: p })) });
  if (mutate) mutate();
  const current = createSnapshot({ repoRoot: root, sources: currentSourcePaths.filter((p) => fs.existsSync(path.join(root, ...p.split('/')))).map((p) => ({ path: p })) });
  return { ...compareSnapshots({ previous, current }), previousSnapshot: previous, currentSnapshot: current };
}

function nodes(a = 1, b = 1, state = 'NOT_EVALUATED') {
  return [
    { evidenceId: 'e:a', content: { value: a }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED', state },
    { evidenceId: 'e:b', content: { value: b }, evidenceType: 'FACT', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/b.json'], authorityStatus: 'GROUNDED', state },
    { evidenceId: 'e:summary', content: { summary: `${a}:${b}` }, evidenceType: 'SUMMARY', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['evidence:e:a', 'evidence:e:b'], authorityStatus: 'GROUNDED', state }
  ];
}

/**
 * Runs the producing validation step for a node set. `overrides` supplies a
 * different outcome per evidence id, or `null` to leave a node carrying
 * whatever validation it already had (that is how a stale node is modelled).
 */
function validated(cas, rawNodes, delta, overrides = {}) {
  const validationResults = {};
  for (const node of rawNodes) {
    const outcome = Object.hasOwn(overrides, node.evidenceId) ? overrides[node.evidenceId] : PASS;
    if (outcome !== null) validationResults[node.evidenceId] = outcome;
  }
  return bindFreshValidations({ cas, nodes: rawNodes, r3Delta: delta, validationResults });
}

function evaluate(cas, rawNodes, delta, previousGraph = null) {
  return evaluateEvidenceGraph({ graph: createEvidenceGraph({ cas, nodes: rawNodes }), previousGraph, r3Delta: delta, cas });
}

function baseline(root, cas, rawNodes = nodes(), delta = r3Delta(root)) {
  const validatedNodes = validated(cas, rawNodes, delta);
  return { nodes: validatedNodes, graph: evaluate(cas, validatedNodes, delta).graph, delta };
}

function nodeOf(result, evidenceId) { return result.graph.nodes.find((node) => node.evidenceId === evidenceId); }
function reasonOf(result, evidenceId) { return nodeOf(result, evidenceId).reason; }
function stateOf(result, evidenceId) { return nodeOf(result, evidenceId).state; }
function reusableIds(result) { return result.reusableNodes.map((node) => node.evidenceId); }
function replaceContent(rawNodes, evidenceId, content) {
  return rawNodes.map((node) => node.evidenceId === evidenceId ? { ...node, content } : node);
}

function soloNode(overrides = {}) {
  return {
    evidenceId: 'e:solo',
    content: { value: 1 },
    evidenceType: 'FACT',
    provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' },
    dependencies: ['source:src/a.json'],
    authorityStatus: 'GROUNDED',
    ...overrides
  };
}

// Parent/child fixture whose child has no source dependency of its own and a
// provenance source that never changes, so that any child invalidation is
// attributable to the parent's evidence identity alone.
function lifecycleNodes(parentValue = 1) {
  return [
    { evidenceId: 'lc:parent', content: { value: parentValue }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: 'lc:child', content: { derivedFrom: 'lc:parent' }, evidenceType: 'DERIVED', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['evidence:lc:parent'], authorityStatus: 'GROUNDED' }
  ];
}

test('R4-01 identical evidence content produces a stable identical identity', () => {
  const root = tempRoot();
  const first = casFor(root).identity('{"same":true}');
  const second = casFor(root).identity('{"same":true}');
  assert.deepEqual(first, second);
});

test('R4-02 duplicate evidence bodies are deduplicated by CAS identity', () => {
  const cas = casFor(tempRoot());
  const first = cas.put('duplicate-body');
  const second = cas.put('duplicate-body');
  assert.equal(first.id, second.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(fs.readdirSync(path.dirname(first.path)).length, 1);
});

test('R4-03 tampered CAS content fails closed', () => {
  const cas = casFor(tempRoot());
  const stored = cas.put('original');
  fs.writeFileSync(stored.path, 'tampered');
  assert.throws(() => cas.get(stored.id), /CAS_TAMPER_DETECTED/);
});

test('R4-04 unchanged dependencies make prior evidence reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.deepEqual(reusableIds(result), ['e:a', 'e:b', 'e:summary']);
});

test('R4-05 changed direct source dependency invalidates only its evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 2 }), delta, base.graph);
  assert.equal(stateOf(result, 'e:a'), INVALIDATED);
  assert.equal(stateOf(result, 'e:b'), REUSABLE);
});

test('R4-06 invalidated parent evidence propagates to downstream evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, base.nodes, delta, base.graph);
  assert.equal(reasonOf(result, 'e:summary'), 'PARENT_EVIDENCE_INVALIDATED');
});

test('R4-07 unrelated source change preserves unrelated evidence reuse', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 2 }), delta, base.graph);
  assert.deepEqual(reusableIds(result), ['e:b']);
});

test('R4-08 removed source dependency invalidates its dependent evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.rmSync(path.join(root, 'src', 'b.json')), ['src/a.json', 'src/b.json'], ['src/a.json']);
  const result = evaluate(cas, base.nodes.filter((node) => node.evidenceId !== 'e:summary'), delta, base.graph);
  assert.equal(reasonOf(result, 'e:b'), 'DIRECT_SOURCE_REMOVED');
  // e:b is current evidence needing revalidation; the dropped e:summary is a
  // tombstone and is reported separately rather than as revalidation work.
  assert.equal(result.metrics.REVALIDATION_REQUIRED_NODES, 1);
  assert.equal(result.metrics.REMOVED_EVIDENCE_NODES, 1);
  assert.equal(result.metrics.INVALIDATED_NODES, 2);
  assert.ok(delta.deltas.some((item) => item.path === 'src/b.json' && item.kind === 'REMOVED'));
});

test('R4-09 missing required evidence fails closed', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const result = evaluate(cas, base.nodes.filter((node) => node.evidenceId === 'e:summary'), r3Delta(root), base.graph);
  assert.equal(stateOf(result, 'e:summary'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:summary'), 'MISSING_REQUIRED_EVIDENCE');
});

test('R4-10 forged previous evidence identity is rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  base.graph.nodes[0].contentSha256 = '0'.repeat(64);
  assert.throws(() => evaluate(cas, base.nodes, r3Delta(root), base.graph), /INVALID_PREVIOUS_GRAPH_DIGEST|INVALID_PREVIOUS_CONTENT_IDENTITY/);
});

test('R4-11 provenance is preserved through graph reuse and invalidation', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 2 }), delta, base.graph);
  assert.equal(nodeOf(result, 'e:a').provenance.sourcePath, 'src/a.json');
  assert.equal(nodeOf(result, 'e:b').provenance.authorityClass, 'CANONICAL');
});

test('R4-12 graph ordering and output are deterministic', () => {
  const cas = casFor(tempRoot());
  const one = createEvidenceGraph({ cas, nodes: nodes().reverse() });
  const two = createEvidenceGraph({ cas, nodes: nodes() });
  assert.deepEqual(one, two);
});

test('R4-13 generic graph works with a synthetic non-Wheel fixture', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const synthetic = [{ evidenceId: 'synthetic:fact', content: 'x', evidenceType: 'SYNTHETIC', provenance: { sourcePath: 'src/a.json', authorityClass: 'SYNTHETIC_CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' }];
  const base = baseline(root, cas, synthetic);
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.equal(result.reusableNodes[0].evidenceId, 'synthetic:fact');
});

test('R4-14 Wheel adapter maps R2 facts without copying authority', () => {
  const cas = casFor(tempRoot());
  const context = { authorityDeclaration: 'DERIVED / NON_AUTHORITATIVE', facts: [{ id: 'active-status', value: 'COMPLETE_CONFIRMED', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL_STATUS' } }] };
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot: REPO_ROOT });
  assert.equal(graph.nodes[0].evidenceType, 'WHEEL_CONTEXT_FACT');
  assert.equal(graph.nodes[0].authorityStatus, 'UNKNOWN');
});

test('R4-15 R3 delta results directly drive selective invalidation', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  assert.equal(delta.deltas.find((item) => item.path === 'src/a.json').kind, 'CHANGED');
  const result = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 2 }), delta, base.graph);
  assert.equal(reasonOf(result, 'e:a'), 'DIRECT_SOURCE_CHANGED');
  assert.equal(stateOf(result, 'e:b'), REUSABLE);
});

test('R4-16 Evidence Graph does not grant execution authority', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const context = { authorityDeclaration: 'DERIVED / NON_AUTHORITATIVE', facts: [{ id: 'fact', value: 1, provenance: { sourcePath: 'src/a.json' } }] };
  const result = evaluateWheelEvidenceGraph({ cas, currentGraph: createWheelEvidenceGraph({ cas, context }), previousGraph: createWheelEvidenceGraph({ cas, context }), r3Delta: r3Delta(root) });
  assert.equal(Object.hasOwn(result, 'executionAuthorized'), false);
  assert.equal(result.graph.nodes[0].authorityStatus, 'UNKNOWN');
});

test('R4-17 no stage beyond the newest sealed revision is authorized', () => {
  // The invariant is that a mission revision never pre-authorizes a later
  // stage. Naming R5 stated that as a fact about one moment in the program, so
  // the case is written against the frontier the missions directory actually
  // declares and keeps holding once a later revision legitimately ships.
  const newest = Math.max(...fs.readdirSync(path.join(REPO_ROOT, 'governance/gee-v1/missions'))
    .map((file) => /^GEE_V1_EXECUTION_CONTRACT_R(\d{4})\.json$/.exec(file))
    .filter(Boolean)
    .map((match) => Number(match[1])));
  const authority = createGeeMissionAuthoritySource(REPO_ROOT, { projectId: 'WHEEL' });
  const registry = createExecutionAuthorityRegistry([authority]);
  for (const stage of [newest + 1, newest + 2, newest + 3]) {
    const revision = `R${stage}`;
    const result = resolveExecutionAuthority({ projectId: 'WHEEL', workUnitType: MISSION_WORK_UNIT_TYPE, workUnitId: `GOVERNANCE_EXECUTION_EFFICIENCY_V1_${revision}`, registry });
    assert.equal(result.executionAuthorized, false, revision);
    assert.ok(result.findings.some((finding) => finding.code === 'UNKNOWN_WORK_UNIT_ID'), revision);
  }
});

test('R4-18 caller-supplied REUSABLE state cannot bootstrap trusted reuse', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const claimed = nodes(1, 1, REUSABLE).map((node) => ({ ...node, producingValidation: { result: 'PASS' } }));
  const callerGraph = createEvidenceGraph({ cas, nodes: claimed });
  const result = evaluate(cas, claimed, r3Delta(root), callerGraph);
  assert.equal(result.reusableNodes.length, 0);
  assert.equal(reasonOf(result, 'e:a'), 'VALIDATION_NOT_BOUND_TO_BASIS');
});

test('R4-19 an evaluated graph is reusable on the next unchanged replay', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const replay = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.deepEqual(reusableIds(replay), ['e:a', 'e:b', 'e:summary']);
});

test('R4-20 same content with changed dependencies is not reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const changed = base.nodes.map((node) => node.evidenceId === 'e:a' ? { ...node, dependencies: ['source:src/b.json'] } : node);
  const result = evaluate(cas, changed, r3Delta(root), base.graph);
  assert.equal(stateOf(result, 'e:a'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:a'), 'VALIDATION_BASIS_STALE');
});

test('R4-21 same content with changed provenance is not reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const changed = base.nodes.map((node) => node.evidenceId === 'e:a' ? { ...node, provenance: { ...node.provenance, sourceField: 'changed' } } : node);
  const result = evaluate(cas, changed, r3Delta(root), base.graph);
  assert.equal(stateOf(result, 'e:a'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:a'), 'VALIDATION_BASIS_STALE');
});

test('R4-22 wrong provenance source hash is not reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const changed = base.nodes.map((node) => node.evidenceId === 'e:a' ? { ...node, provenance: { ...node.provenance, sourceSha256: '0'.repeat(64) } } : node);
  const result = evaluate(cas, changed, r3Delta(root), base.graph);
  assert.equal(reasonOf(result, 'e:a'), 'PROVENANCE_SOURCE_HASH_MISMATCH');
});

test('R4-23 removed prior evidence emits a tombstone while unrelated evidence remains reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const result = evaluate(cas, base.nodes.filter((node) => node.evidenceId === 'e:b'), r3Delta(root), base.graph);
  const tombstone = nodeOf(result, 'e:a');
  assert.equal(tombstone.reason, 'EVIDENCE_REMOVED');
  assert.equal(tombstone.tombstone, true);
  assert.deepEqual(reusableIds(result), ['e:b']);
});

test('R4-24 Wheel arbitrary evidence without explicit authority remains UNKNOWN', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const context = { authorityDeclaration: 'DERIVED / NON_AUTHORITATIVE', facts: [{ id: 'active-status', value: 'COMPLETE_CONFIRMED', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL_STATUS' } }] };
  const graph = createWheelEvidenceGraph({ cas, context, evidenceItems: [{ evidenceId: 'wheel:arbitrary', content: 'unverified', provenance: { sourcePath: 'src/a.json' }, dependencies: ['source:src/a.json'] }] });
  assert.equal(graph.nodes.find((node) => node.evidenceId === 'wheel:arbitrary').authorityStatus, 'UNKNOWN');
  const result = evaluateEvidenceGraph({ graph, r3Delta: r3Delta(root), cas });
  assert.equal(stateOf(result, 'wheel:arbitrary'), INVALIDATED);
});

test('R4-25 evaluated graph survives JSON round-trip and remains reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const persistedGraph = JSON.parse(JSON.stringify(base.graph));
  const persistedNodes = JSON.parse(JSON.stringify(base.nodes));
  const result = evaluate(cas, persistedNodes, r3Delta(root), persistedGraph);
  assert.deepEqual(reusableIds(result), ['e:a', 'e:b', 'e:summary']);
});

test('R4-26 fabricated delta output cannot authorize reuse', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  assert.throws(() => evaluateEvidenceGraph({
    graph: createEvidenceGraph({ cas, nodes: base.nodes }),
    previousGraph: base.graph,
    r3Delta: { deltas: [{ path: 'src/a.json', kind: 'UNCHANGED' }] },
    cas
  }), /R3_SNAPSHOTS_REQUIRED/);
});

test('R4-27 real compiled R2 context produces grounded Wheel evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const before = createWheelDeltaSnapshot({ repoRoot: REPO_ROOT, context });
  const unchanged = { previousSnapshot: before, currentSnapshot: before };
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot: REPO_ROOT, r3Delta: unchanged });
  assert.ok(graph.nodes.length > 0);
  assert.ok(graph.nodes.every((node) => node.authorityStatus === 'GROUNDED'));
  const serializedGraph = createWheelEvidenceGraph({ cas, context: JSON.parse(JSON.stringify(context)), repoRoot: REPO_ROOT, r3Delta: unchanged });
  assert.deepEqual(serializedGraph, graph);
  const result = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, previousGraph: null, r3Delta: unchanged });
  assert.equal(result.reusableNodes.length, graph.nodes.length);
});

test('R4-28 explicitly unverified R2 evidence never becomes grounded', () => {
  const root = tempRoot();
  const source = createSnapshot({ repoRoot: root, sources: [{ path: 'src/a.json' }] }).sources[0];
  const context = {
    authorityDeclaration: 'DERIVED / NON_AUTHORITATIVE',
    bundleKind: 'GEE_CONTEXT_BUNDLE',
    identity: { compilerVersion: 'GEE_V1_CONTEXT_COMPILER_R2' },
    relevantSources: [{ path: source.path, sha256: source.sha256 }],
    reusableEvidenceReferences: [{ ref: 'external:unverified', authorityStatus: 'NON_AUTHORITATIVE_UNVERIFIED' }],
    facts: [{ id: 'fact', value: 1, provenance: { sourcePath: source.path, sourceSha256: source.sha256 } }]
  };
  const graph = createWheelEvidenceGraph({ cas: casFor(root), context });
  assert.equal(graph.nodes[0].authorityStatus, 'UNKNOWN');
  assert.equal(graph.nodes[0].producingValidation, null);
});

test('R4-29 invalidated evidence becomes reusable after genuine fresh revalidation', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changedRaw = replaceContent(replaceContent(base.nodes, 'e:a', { value: 2 }), 'e:summary', { summary: '2:1' });
  assert.equal(stateOf(evaluate(cas, changedRaw, changedDelta, base.graph), 'e:a'), INVALIDATED);
  // Only the affected evidence is genuinely revalidated; e:b keeps its binding.
  const refreshed = validated(cas, changedRaw, changedDelta, { 'e:b': null });
  const revalidated = evaluate(cas, refreshed, changedDelta, base.graph);
  assert.deepEqual(reusableIds(revalidated), ['e:a', 'e:b', 'e:summary']);
  const replay = evaluate(cas, refreshed, r3Delta(root), revalidated.graph);
  assert.deepEqual(reusableIds(replay), ['e:a', 'e:b', 'e:summary']);
});

test('R4-30 newly added evidence establishes a reusable baseline after fresh validation', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root);
  const added = { evidenceId: 'e:new', content: { value: 'new' }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' };
  const current = validated(cas, [...base.nodes, added], delta, Object.fromEntries(base.nodes.map((node) => [node.evidenceId, null])));
  const first = evaluate(cas, current, delta, base.graph);
  assert.ok(reusableIds(first).includes('e:new'));
  const replay = evaluate(cas, current, r3Delta(root), first.graph);
  assert.ok(reusableIds(replay).includes('e:new'));
});

test('R4-31 stale prior PASS cannot reactivate invalidated evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changedRaw = replaceContent(base.nodes, 'e:a', { value: 2 });
  const invalidatedRun = evaluate(cas, changedRaw, changedDelta, base.graph);
  assert.equal(stateOf(invalidatedRun, 'e:a'), INVALIDATED);
  // Next mission: nothing changed since, but the stored PASS is still bound to
  // the pre-change source identity and must not silently reactivate.
  const replay = evaluate(cas, changedRaw, r3Delta(root), invalidatedRun.graph);
  assert.equal(stateOf(replay, 'e:a'), INVALIDATED);
  assert.equal(reasonOf(replay, 'e:a'), 'VALIDATION_BASIS_STALE');
});

test('R4-32 provenance source change invalidates even without direct dependency', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const sourceSha256 = createSnapshot({ repoRoot: root, sources: [{ path: 'src/a.json' }] }).sources[0].sha256;
  const provenanceOnly = [{ ...nodes()[0], dependencies: ['source:src/b.json'], provenance: { ...nodes()[0].provenance, sourceSha256 } }];
  const base = baseline(root, cas, provenanceOnly);
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, base.nodes, changedDelta, base.graph);
  assert.equal(reasonOf(result, 'e:a'), 'PROVENANCE_SOURCE_HASH_MISMATCH');
});

test('R4-33 unchanged provenance source remains reusable without direct dependency', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const sourceSha256 = createSnapshot({ repoRoot: root, sources: [{ path: 'src/a.json' }] }).sources[0].sha256;
  const provenanceOnly = [{ ...nodes()[0], dependencies: ['source:src/b.json'], provenance: { ...nodes()[0].provenance, sourceSha256 } }];
  const base = baseline(root, cas, provenanceOnly);
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.equal(result.reusableNodes[0].evidenceId, 'e:a');
});

test('R4-34 modified fact in a genuine R2 context is not grounded', () => {
  const root = tempRoot();
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const modified = JSON.parse(JSON.stringify(context));
  modified.facts[0].value = 'FABRICATED';
  const graph = createWheelEvidenceGraph({ cas: casFor(root), context: modified, repoRoot: REPO_ROOT });
  assert.equal(graph.nodes[0].authorityStatus, 'UNKNOWN');
  assert.equal(graph.nodes[0].producingValidation, null);
});

test('R4-35 modified provenance in a genuine R2 context is not grounded', () => {
  const root = tempRoot();
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const modified = JSON.parse(JSON.stringify(context));
  modified.facts[0].provenance.sourceField = 'FABRICATED';
  const graph = createWheelEvidenceGraph({ cas: casFor(root), context: modified, repoRoot: REPO_ROOT });
  assert.equal(graph.nodes[0].authorityStatus, 'UNKNOWN');
  assert.equal(graph.nodes[0].producingValidation, null);
});

// ---------------------------------------------------------------------------
// H1 validation semantics: R4 binds a supplied outcome, it never produces one.
// ---------------------------------------------------------------------------

test('R4-H01 missing producing validation cannot become PASS', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const result = evaluate(cas, [soloNode()], delta);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PRODUCING_VALIDATION_MISSING');

  const normalized = createEvidenceGraph({ cas, nodes: [soloNode()] }).nodes[0];
  assert.throws(() => createFreshValidation({ node: normalized, r3Delta: delta }), /PRODUCING_VALIDATION_RESULT_REQUIRED/);
  assert.throws(() => createFreshValidation({ node: normalized, r3Delta: delta, validationResult: null }), /PRODUCING_VALIDATION_RESULT_REQUIRED/);
  assert.throws(() => createFreshValidation({ node: normalized, r3Delta: delta, validationResult: { validator: 'X' } }), /PRODUCING_VALIDATION_OUTCOME_REQUIRED/);
  assert.equal(interpretValidation(null), 'MISSING');
  assert.equal(interpretValidation({}), 'MISSING');
});

test('R4-H02 explicit FAIL cannot become PASS', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const failed = validated(cas, [soloNode()], delta, { 'e:solo': { validator: 'V', result: 'FAIL' } });
  assert.equal(failed[0].producingValidation.validationState, 'CURRENT');
  const result = evaluate(cas, failed, delta);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PRODUCING_VALIDATION_NOT_PASS');
});

test('R4-H03 conflicting PASS/FAIL validation fails closed', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  for (const contradiction of [{ result: 'FAIL', status: 'PASS' }, { result: 'PASS', status: 'FAIL' }, { result: 'PASS', verdict: 'INCONCLUSIVE' }]) {
    assert.equal(interpretValidation(contradiction), 'FAIL');
    const bound = validated(cas, [soloNode()], delta, { 'e:solo': contradiction });
    const result = evaluate(cas, bound, delta);
    assert.equal(stateOf(result, 'e:solo'), INVALIDATED, JSON.stringify(contradiction));
    assert.equal(reasonOf(result, 'e:solo'), 'PRODUCING_VALIDATION_NOT_PASS', JSON.stringify(contradiction));
  }
});

test('R4-H04 genuine fresh PASS is bound to the current basis', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const bound = validated(cas, [soloNode()], delta);
  assert.match(bound[0].producingValidation.validationBasisSha256, /^[a-f0-9]{64}$/);
  assert.equal(bound[0].producingValidation.result, 'PASS');
  assert.equal(stateOf(evaluate(cas, bound, delta), 'e:solo'), REUSABLE);

  // A guessed basis is not a binding.
  const forged = [{ ...bound[0], producingValidation: { ...bound[0].producingValidation, validationBasisSha256: '0'.repeat(64) } }];
  assert.equal(stateOf(evaluate(cas, forged, delta), 'e:solo'), INVALIDATED);
  // Nor is a PASS that merely claims to be current.
  const claimed = [{ ...soloNode(), producingValidation: { result: 'PASS', validationState: 'CURRENT' } }];
  assert.equal(reasonOf(evaluate(cas, claimed, delta), 'e:solo'), 'VALIDATION_BASIS_STALE');
});

test('R4-H05 stale prior PASS cannot reactivate evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const bound = validated(cas, [soloNode()], r3Delta(root));
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const stale = replaceContent(bound, 'e:solo', { value: 2 });
  assert.equal(stateOf(evaluate(cas, stale, changedDelta), 'e:solo'), INVALIDATED);
  // Re-stamping validationState does not re-establish the binding.
  const restamped = [{ ...stale[0], producingValidation: { ...stale[0].producingValidation, validationState: 'CURRENT' } }];
  assert.equal(stateOf(evaluate(cas, restamped, changedDelta), 'e:solo'), INVALIDATED);
});

// ---------------------------------------------------------------------------
// H2 parent evidence identity is part of the child's validation basis.
// ---------------------------------------------------------------------------

test('R4-H06 parent unchanged and child unchanged keeps the child reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.deepEqual(reusableIds(result), ['lc:child', 'lc:parent']);
});

test('R4-H07 parent that changes and stays invalid invalidates the child', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'lc:parent', { value: 2 }), delta, base.graph);
  assert.equal(reasonOf(result, 'lc:parent'), 'DIRECT_SOURCE_CHANGED');
  assert.equal(reasonOf(result, 'lc:child'), 'PARENT_EVIDENCE_INVALIDATED');
});

test('R4-H08 freshly revalidated parent does not revive a stale child', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changed = replaceContent(base.nodes, 'lc:parent', { value: 2 });
  const parentOnly = validated(cas, changed, delta, { 'lc:child': null });
  const result = evaluate(cas, parentOnly, delta, base.graph);
  assert.equal(stateOf(result, 'lc:parent'), REUSABLE);
  assert.equal(stateOf(result, 'lc:child'), INVALIDATED);
  assert.equal(reasonOf(result, 'lc:child'), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
});

test('R4-H09 child revalidated against the current parent establishes a new baseline', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changed = replaceContent(base.nodes, 'lc:parent', { value: 2 });
  const parentOnly = validated(cas, changed, delta, { 'lc:child': null });
  const both = validated(cas, parentOnly, delta, { 'lc:parent': null });
  const result = evaluate(cas, both, delta, base.graph);
  assert.deepEqual(reusableIds(result), ['lc:child', 'lc:parent']);
});

test('R4-H10 the next unchanged replay reuses both parent and child', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changed = replaceContent(base.nodes, 'lc:parent', { value: 2 });
  const both = validated(cas, validated(cas, changed, delta, { 'lc:child': null }), delta, { 'lc:parent': null });
  const established = evaluate(cas, both, delta, base.graph);
  const replay = evaluate(cas, both, r3Delta(root), established.graph);
  assert.deepEqual(reusableIds(replay), ['lc:child', 'lc:parent']);
});

test('R4-H11 parent identity change without content change does not leave the child reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas, lifecycleNodes(1));
  const delta = r3Delta(root);
  // Same parent content and same sources; only trust-relevant metadata moves.
  const retagged = base.nodes.map((node) => node.evidenceId === 'lc:parent'
    ? { ...node, provenance: { ...node.provenance, selectionReason: 'reclassified' } }
    : node);
  assert.equal(reasonOf(evaluate(cas, retagged, delta, base.graph), 'lc:parent'), 'VALIDATION_BASIS_STALE');
  const parentOnly = validated(cas, retagged, delta, { 'lc:child': null });
  const result = evaluate(cas, parentOnly, delta, base.graph);
  assert.equal(stateOf(result, 'lc:parent'), REUSABLE);
  assert.equal(reasonOf(result, 'lc:child'), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
});

// ---------------------------------------------------------------------------
// H3 the provenance source is an implicit dependency of the evidence.
// ---------------------------------------------------------------------------

test('R4-H12 provenance source changed without a declared sha is invalidated', () => {
  const root = tempRoot();
  const cas = casFor(root);
  // Provenance points at src/a.json, the declared dependency is src/b.json,
  // and no provenance sourceSha256 is supplied.
  const node = [soloNode({ dependencies: ['source:src/b.json'] })];
  const base = baseline(root, cas, node);
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  assert.equal(changedDelta.deltas.find((item) => item.path === 'src/b.json').kind, 'UNCHANGED');
  const result = evaluate(cas, base.nodes, changedDelta, base.graph);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PROVENANCE_SOURCE_CHANGED');
});

test('R4-H13 removed provenance source is invalidated', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const node = [soloNode({ provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' } })];
  const base = baseline(root, cas, node);
  const removedDelta = r3Delta(root, () => fs.rmSync(path.join(root, 'src', 'b.json')), ['src/a.json', 'src/b.json'], ['src/a.json']);
  const result = evaluate(cas, base.nodes, removedDelta, base.graph);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PROVENANCE_SOURCE_REMOVED');
});

test('R4-H14 provenance source untracked by the R3 comparison is not reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  fs.writeFileSync(path.join(root, 'src', 'c.json'), '{"c":1}');
  const node = [soloNode({ provenance: { sourcePath: 'src/c.json', authorityClass: 'CANONICAL' } })];
  // src/c.json exists on disk but is outside the R3 comparison.
  const trackedDelta = r3Delta(root, null, ['src/a.json', 'src/b.json', 'src/c.json']);
  const base = baseline(root, cas, node, trackedDelta);
  assert.equal(stateOf(evaluate(cas, base.nodes, trackedDelta), 'e:solo'), REUSABLE);
  const untrackedDelta = r3Delta(root);
  const result = evaluate(cas, base.nodes, untrackedDelta, base.graph);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PROVENANCE_SOURCE_UNTRACKED');
});

test('R4-H15 unchanged provenance source stays reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const node = [soloNode({ dependencies: ['source:src/b.json'] })];
  const base = baseline(root, cas, node);
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.equal(stateOf(result, 'e:solo'), REUSABLE);
});

test('R4-H16 a correct provenance sourceSha256 stays reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const sourceSha256 = createSnapshot({ repoRoot: root, sources: [{ path: 'src/a.json' }] }).sources[0].sha256;
  const node = [soloNode({ provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL', sourceSha256 } })];
  const base = baseline(root, cas, node);
  assert.equal(stateOf(evaluate(cas, base.nodes, r3Delta(root), base.graph), 'e:solo'), REUSABLE);
});

test('R4-H17 a wrong provenance sourceSha256 is invalidated', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const node = [soloNode({ provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL', sourceSha256: 'f'.repeat(64) } })];
  const base = baseline(root, cas, node);
  const result = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.equal(stateOf(result, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(result, 'e:solo'), 'PROVENANCE_SOURCE_HASH_MISMATCH');
});

test('R4-H12b fresh revalidation after a provenance-source change binds the new identity', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const node = [soloNode({ dependencies: ['source:src/b.json'] })];
  const base = baseline(root, cas, node);
  const changedDelta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  assert.equal(stateOf(evaluate(cas, base.nodes, changedDelta, base.graph), 'e:solo'), INVALIDATED);
  const refreshed = validated(cas, base.nodes, changedDelta);
  assert.equal(stateOf(evaluate(cas, refreshed, changedDelta, base.graph), 'e:solo'), REUSABLE);
  // The new binding is tied to the new provenance source identity, so it does
  // not validate against the pre-change comparison.
  const rollback = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":1}'));
  assert.equal(stateOf(evaluate(cas, refreshed, rollback, base.graph), 'e:solo'), INVALIDATED);
});

// ---------------------------------------------------------------------------
// H4 grounding is not validation.
// ---------------------------------------------------------------------------

test('R4-H18 GROUNDED without a producing validation is not automatically reusable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  // Initial evaluation, no previous graph at all.
  const initial = evaluate(cas, [soloNode({ authorityStatus: 'GROUNDED', producingValidation: null })], delta);
  assert.equal(stateOf(initial, 'e:solo'), INVALIDATED);
  assert.equal(reasonOf(initial, 'e:solo'), 'PRODUCING_VALIDATION_MISSING');
  assert.equal(initial.metrics.AVOIDED_REVALIDATION_NODES, 0);
  assert.equal(initial.metrics.REVALIDATION_REQUIRED_NODES, 1);
});

test('R4-H19 a Wheel extra with fake GROUNDED metadata cannot bootstrap reuse', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const before = createWheelDeltaSnapshot({ repoRoot: REPO_ROOT, context });
  const forgedItems = [
    { evidenceId: 'wheel:forged-grounded', content: 'forged', provenance: { sourcePath: 'src/a.json' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED', producingValidation: { result: 'PASS' } },
    { evidenceId: 'wheel:forged-basis', content: 'forged', provenance: { sourcePath: 'src/a.json' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED', producingValidation: { result: 'PASS', validationState: 'CURRENT', validationBasisSha256: '0'.repeat(64) } }
  ];
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot: REPO_ROOT, evidenceItems: forgedItems, r3Delta: { previousSnapshot: before, currentSnapshot: before } });
  const result = evaluateEvidenceGraph({ graph, r3Delta: delta, cas });
  for (const item of forgedItems) {
    assert.equal(stateOf(result, item.evidenceId), INVALIDATED, item.evidenceId);
    assert.ok(['VALIDATION_NOT_BOUND_TO_BASIS', 'VALIDATION_BASIS_STALE'].includes(reasonOf(result, item.evidenceId)), reasonOf(result, item.evidenceId));
  }
});

test('R4-H20 a real R2 context stays accepted and reusable', () => {
  const cas = casFor(tempRoot());
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const before = createWheelDeltaSnapshot({ repoRoot: REPO_ROOT, context });
  const unchanged = { previousSnapshot: before, currentSnapshot: before };
  const graph = createWheelEvidenceGraph({ cas, context, repoRoot: REPO_ROOT, r3Delta: unchanged });
  const result = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, r3Delta: unchanged });
  assert.ok(result.reusableNodes.length > 0);
  assert.equal(result.invalidatedNodes.length, 0);
});

test('R4-H21 a modified genuine R2 context stays rejected and unusable', () => {
  const cas = casFor(tempRoot());
  const context = compileContext({ repoRoot: REPO_ROOT, adapter: createWheelContextAdapter(REPO_ROOT), workUnitId: 'GATE13', sourceHead: CANONICAL_HEAD }).json;
  const before = createWheelDeltaSnapshot({ repoRoot: REPO_ROOT, context });
  const unchanged = { previousSnapshot: before, currentSnapshot: before };
  const modified = JSON.parse(JSON.stringify(context));
  modified.facts[0].value = 'FABRICATED';
  const graph = createWheelEvidenceGraph({ cas, context: modified, repoRoot: REPO_ROOT, r3Delta: unchanged });
  assert.ok(graph.nodes.every((node) => node.authorityStatus === 'UNKNOWN'));
  const result = evaluateWheelEvidenceGraph({ cas, currentGraph: graph, r3Delta: unchanged });
  assert.equal(result.reusableNodes.length, 0);
  assert.ok(result.invalidatedNodes.every((node) => node.reason === 'PROVENANCE_NOT_GROUNDED'));
});

test('R4-H22 fabricated R3 delta input stays rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const genuine = r3Delta(root);
  for (const forged of [
    { deltas: [{ path: 'src/a.json', kind: 'UNCHANGED', currentSha256: '0'.repeat(64), bytes: 1 }] },
    { ...genuine, previousSnapshot: null },
    { previousSnapshot: genuine.previousSnapshot, currentSnapshot: { ...genuine.currentSnapshot, snapshotSha256: '0'.repeat(64) } }
  ]) {
    assert.throws(() => evaluate(cas, base.nodes, forged, base.graph), /R3_SNAPSHOTS_REQUIRED|INVALID_R3_INPUT/);
  }
});

test('R4-H23 a real R3 unchanged comparison keeps evidence usable', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root);
  assert.ok(delta.deltas.every((item) => item.kind === 'UNCHANGED'));
  assert.deepEqual(reusableIds(evaluate(cas, base.nodes, delta, base.graph)), ['e:a', 'e:b', 'e:summary']);
});

test('R4-H24 a real R3 mutation invalidates exactly the affected evidence', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'b.json'), '{"b":9}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'e:b', { value: 9 }), delta, base.graph);
  assert.equal(reasonOf(result, 'e:b'), 'DIRECT_SOURCE_CHANGED');
  assert.equal(reasonOf(result, 'e:summary'), 'PARENT_EVIDENCE_INVALIDATED');
  assert.deepEqual(reusableIds(result), ['e:a']);
});

test('R4-H25 evaluation is identical in a separate process from persisted JSON', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root);
  const payload = path.join(root, 'payload.json');
  fs.writeFileSync(payload, JSON.stringify({ casRoot: path.join(root, 'cas'), nodes: base.nodes, previousGraph: base.graph, r3Delta: delta }));
  const runner = path.join(root, 'runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const evidence = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/evidence/evidence-graph.mjs'))}).href);
const cas = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/cas/content-addressed-store.mjs'))}).href);
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));
const store = cas.createContentAddressedStore(payload.casRoot);
const result = evidence.evaluateEvidenceGraph({
  graph: evidence.createEvidenceGraph({ cas: store, nodes: payload.nodes }),
  previousGraph: payload.previousGraph,
  r3Delta: payload.r3Delta,
  cas: store
});
process.stdout.write(JSON.stringify({ graphSha256: result.graph.graphSha256, reusable: result.reusableNodes.map((node) => node.evidenceId) }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  const local = evaluate(cas, base.nodes, delta, base.graph);
  assert.deepEqual(observed.reusable, ['e:a', 'e:b', 'e:summary']);
  assert.equal(observed.graphSha256, local.graph.graphSha256);
});

test('R4-H26 caller-supplied REUSABLE state alone stays rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const claimed = nodes(1, 1, REUSABLE).map((node) => ({ ...node, reusable: true, invalidated: false, reason: 'ALL_REUSE_CONDITIONS_PROVEN' }));
  const result = evaluate(cas, claimed, r3Delta(root));
  assert.equal(result.reusableNodes.length, 0);
  assert.equal(reasonOf(result, 'e:a'), 'PRODUCING_VALIDATION_MISSING');
  assert.equal(reasonOf(result, 'e:b'), 'PRODUCING_VALIDATION_MISSING');
  assert.equal(reasonOf(result, 'e:summary'), 'PARENT_EVIDENCE_INVALIDATED');
});

test('R4-H27 removed evidence still emits a tombstone', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const result = evaluate(cas, base.nodes.filter((node) => node.evidenceId !== 'e:a'), r3Delta(root), base.graph);
  const tombstone = nodeOf(result, 'e:a');
  assert.equal(tombstone.tombstone, true);
  assert.equal(tombstone.state, INVALIDATED);
  assert.equal(tombstone.reason, 'EVIDENCE_REMOVED');
  assert.equal(result.reusableNodes.some((node) => node.evidenceId === 'e:a'), false);
});

test('R4-H28 unrelated evidence stays reusable when another branch changes', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":3}'));
  const result = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 3 }), delta, base.graph);
  assert.deepEqual(reusableIds(result), ['e:b']);
  assert.equal(result.metrics.REUSABLE_NODES, 1);
  assert.equal(result.metrics.REVALIDATION_REQUIRED_NODES, 2);
});

test('R4-H30 identity change propagates down a chain without over-invalidating', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const chain = [
    ...lifecycleNodes(1),
    { evidenceId: 'lc:grandchild', content: { derivedFrom: 'lc:child' }, evidenceType: 'DERIVED', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: ['evidence:lc:child'], authorityStatus: 'GROUNDED' }
  ];
  const base = baseline(root, cas, chain);
  assert.equal(base.graph.nodes.length, 3);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changed = replaceContent(base.nodes, 'lc:parent', { value: 2 });

  // Only the root of the chain is revalidated: everything below stays stale.
  const parentOnly = validated(cas, changed, delta, { 'lc:child': null, 'lc:grandchild': null });
  const afterParent = evaluate(cas, parentOnly, delta, base.graph);
  assert.equal(stateOf(afterParent, 'lc:parent'), REUSABLE);
  assert.equal(reasonOf(afterParent, 'lc:child'), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
  assert.equal(reasonOf(afterParent, 'lc:grandchild'), 'PARENT_EVIDENCE_INVALIDATED');

  // The child is re-established with a bit-identical evidence identity, so the
  // grandchild's binding still describes exactly what it consumed.
  const childToo = validated(cas, parentOnly, delta, { 'lc:parent': null, 'lc:grandchild': null });
  assert.deepEqual(reusableIds(evaluate(cas, childToo, delta, base.graph)), ['lc:child', 'lc:grandchild', 'lc:parent']);

  // But if the child's own content moves, the grandchild must fall.
  const childMoved = validated(cas, replaceContent(childToo, 'lc:child', { derivedFrom: 'lc:parent', revision: 2 }), delta, { 'lc:parent': null, 'lc:grandchild': null });
  const afterMove = evaluate(cas, childMoved, delta, base.graph);
  assert.equal(stateOf(afterMove, 'lc:child'), REUSABLE);
  assert.equal(reasonOf(afterMove, 'lc:grandchild'), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
  const allFresh = validated(cas, childMoved, delta, { 'lc:parent': null, 'lc:child': null });
  assert.deepEqual(reusableIds(evaluate(cas, allFresh, delta, base.graph)), ['lc:child', 'lc:grandchild', 'lc:parent']);
});

test('R4-H31 dependency cycles and self-dependencies fail closed', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const forgedPass = { result: 'PASS', validationState: 'CURRENT', validationBasisSha256: '0'.repeat(64) };
  const cycle = [
    soloNode({ evidenceId: 'e:x', dependencies: ['evidence:e:y'], producingValidation: forgedPass }),
    soloNode({ evidenceId: 'e:y', content: { value: 2 }, dependencies: ['evidence:e:x'], producingValidation: forgedPass })
  ];
  assert.equal(evaluate(cas, cycle, delta).reusableNodes.length, 0);
  const self = [soloNode({ evidenceId: 'e:z', dependencies: ['evidence:e:z'], producingValidation: forgedPass })];
  assert.equal(evaluate(cas, self, delta).reusableNodes.length, 0);
});

// ---------------------------------------------------------------------------
// I1 deterministic, locale-independent, Unicode-canonical logical identity.
// ---------------------------------------------------------------------------

// Escaped deliberately: literal bytes here could be normalized by an editor or
// by git, which would silently turn every test below into a tautology.
const PRECOMPOSED = 'e:caf\u00e9';        // cafe with U+00E9
const DECOMPOSED = 'e:cafe\u0301';       // cafe with combining U+0301
const NON_CANONICAL_PATH = 'src/cafe\u0301.json';

test('R4-I1 fixture guard: the Unicode fixtures are genuinely distinct strings', () => {
  assert.notEqual(PRECOMPOSED, DECOMPOSED);
  assert.equal(PRECOMPOSED.normalize('NFC'), DECOMPOSED.normalize('NFC'));
  assert.notEqual(NON_CANONICAL_PATH, NON_CANONICAL_PATH.normalize('NFC'));
});

test('R4-I1a non-ASCII evidence ids order by code unit, not by runtime locale', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const ids = ['e:z', PRECOMPOSED, 'e:a', 'e:Z'];
  const graph = createEvidenceGraph({ cas, nodes: ids.map((id) => soloNode({ evidenceId: id, content: { id } })) });
  const expected = ids.map((id) => id.normalize('NFC')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(graph.nodes.map((node) => node.evidenceId), expected);
  // Uppercase 'Z' sorting before lowercase 'a' is the code-unit signature; every
  // ICU collation places 'e:Z' last, so this proves no locale collation is used.
  assert.equal(graph.nodes[0].evidenceId, 'e:Z');
  for (const locale of ['en-US', 'sv-SE', 'fr-CA', 'tr-TR', 'de-DE-u-co-phonebk']) {
    const localeOrder = ids.map((id) => id.normalize('NFC')).sort((a, b) => a.localeCompare(b, locale));
    assert.notDeepEqual(graph.nodes.map((node) => node.evidenceId), localeOrder, locale);
  }
  // Shuffling the input cannot change the emitted order or the digest.
  const shuffled = createEvidenceGraph({ cas, nodes: [...ids].reverse().map((id) => soloNode({ evidenceId: id, content: { id } })) });
  assert.equal(shuffled.graphSha256, graph.graphSha256);
});

test('R4-I1a2 graph construction and evaluation never call localeCompare', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const raw = [...nodes(), soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } })];
  const bound = validated(cas, raw, delta);
  const original = String.prototype.localeCompare;
  let graphSha256;
  let reusable;
  try {
    // eslint-disable-next-line no-extend-native
    String.prototype.localeCompare = function localeCompareTrap() {
      throw new Error('LOCALE_DEPENDENT_ORDERING_USED');
    };
    const result = evaluateEvidenceGraph({ graph: createEvidenceGraph({ cas, nodes: bound }), r3Delta: delta, cas });
    graphSha256 = result.graph.graphSha256;
    reusable = result.reusableNodes.map((node) => node.evidenceId);
  } finally {
    String.prototype.localeCompare = original;
  }
  assert.match(graphSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(reusable, ['e:a', 'e:b', PRECOMPOSED, 'e:summary']);
  // And the digest matches the untrapped run exactly.
  assert.equal(evaluate(cas, bound, r3Delta(root)).graph.graphSha256, graphSha256);
});

test('R4-I1b NFC-equivalent evidence ids cannot coexist as two identities', () => {
  const cas = casFor(tempRoot());
  assert.throws(() => createEvidenceGraph({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }), soloNode({ evidenceId: DECOMPOSED, content: { v: 2 } })]
  }), /DUPLICATE_EVIDENCE_ID/);
});

test('R4-I1c a decomposed dependency resolves to the canonical parent', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const raw = [
    soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }),
    soloNode({ evidenceId: 'e:child', content: { v: 2 }, dependencies: [`evidence:${DECOMPOSED}`] })
  ];
  const bound = validated(cas, raw, delta);
  const result = evaluate(cas, bound, delta);
  const child = nodeOf(result, 'e:child');
  assert.equal(child.dependencies[0], `evidence:${PRECOMPOSED}`);
  assert.equal(child.state, REUSABLE);
  assert.notEqual(child.reason, 'MISSING_REQUIRED_EVIDENCE');
});

test('R4-I1d Unicode normalization cannot collide two different dependency semantics', () => {
  const cas = casFor(tempRoot());
  const build = (parentId, dependsOn) => createEvidenceGraph({
    cas,
    nodes: [
      soloNode({ evidenceId: parentId, content: { v: 1 } }),
      soloNode({ evidenceId: 'e:other', content: { v: 2 } }),
      soloNode({ evidenceId: 'e:child', content: { v: 3 }, dependencies: [`evidence:${dependsOn}`] })
    ]
  });
  // Genuinely different parents must never share a digest.
  assert.notEqual(build(PRECOMPOSED, PRECOMPOSED).graphSha256, build(PRECOMPOSED, 'e:other').graphSha256);
  // The same logical graph spelled either way must be one identity.
  const precomposed = build(PRECOMPOSED, PRECOMPOSED);
  const decomposed = build(DECOMPOSED, DECOMPOSED);
  assert.equal(precomposed.graphSha256, decomposed.graphSha256);
  assert.deepEqual(precomposed.nodes.map((node) => node.evidenceId), decomposed.nodes.map((node) => node.evidenceId));
});

test('R4-I1e ASCII behaviour and R3 source-path vocabulary are unchanged', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  assert.deepEqual(base.graph.nodes.map((node) => node.evidenceId), ['e:a', 'e:b', 'e:summary']);
  assert.deepEqual(reusableIds(evaluate(cas, base.nodes, r3Delta(root), base.graph)), ['e:a', 'e:b', 'e:summary']);
  // R4 never rewrites an R3 source path; it refuses an ambiguous one instead.
  assert.throws(() => createEvidenceGraph({ cas, nodes: [soloNode({ dependencies: [`source:${NON_CANONICAL_PATH}`] })] }), /NON_CANONICAL_SOURCE_DEPENDENCY/);
  assert.throws(() => createEvidenceGraph({ cas, nodes: [soloNode({ provenance: { sourcePath: NON_CANONICAL_PATH } })] }), /NON_CANONICAL_PROVENANCE_SOURCE/);
});

// ---------------------------------------------------------------------------
// I2 tombstones are not revalidation work.
// ---------------------------------------------------------------------------

test('R4-I2a a removed 1000-byte evidence does not depress the avoided ratio', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const raw = [
    soloNode({ evidenceId: 'e:big', content: { pad: 'x'.repeat(1000) } }),
    soloNode({ evidenceId: 'e:small', content: { v: 1 } })
  ];
  const base = baseline(root, cas, raw, delta);
  const result = evaluate(cas, base.nodes.filter((node) => node.evidenceId === 'e:small'), r3Delta(root), base.graph);
  const m = result.metrics;
  assert.equal(m.REUSABLE_NODES, 1);
  assert.equal(m.REVALIDATION_REQUIRED_NODES, 0);
  assert.equal(m.REVALIDATE_EVIDENCE_BYTES, 0);
  assert.equal(m.AVOIDED_REVALIDATION_RATIO, 1);
  assert.equal(m.REMOVED_EVIDENCE_NODES, 1);
  assert.ok(m.REMOVED_EVIDENCE_BYTES > 1000);
  // The tombstone is still emitted and still invalidated.
  assert.equal(nodeOf(result, 'e:big').tombstone, true);
  assert.equal(m.INVALIDATED_NODES, 1);
});

test('R4-I2b genuinely invalidated current evidence still counts as revalidation work', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const m = evaluate(cas, replaceContent(base.nodes, 'e:a', { value: 2 }), delta, base.graph).metrics;
  assert.equal(m.REVALIDATION_REQUIRED_NODES, 2);
  assert.equal(m.REMOVED_EVIDENCE_NODES, 0);
  assert.ok(m.REVALIDATE_EVIDENCE_BYTES > 0);
  assert.equal(m.AVOIDED_REVALIDATION_RATIO, 1 / 3);
});

test('R4-I2c reusable, invalidated and removed metrics reconcile exactly', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":4}'));
  // e:a invalidated (its source moved), e:b reusable, e:summary removed.
  const current = replaceContent(base.nodes, 'e:a', { value: 4 }).filter((node) => node.evidenceId !== 'e:summary');
  const m = evaluate(cas, current, delta, base.graph).metrics;
  assert.equal(m.REUSABLE_NODES, 1);
  assert.equal(m.REVALIDATION_REQUIRED_NODES, 1);
  assert.equal(m.REMOVED_EVIDENCE_NODES, 1);
  assert.equal(m.CURRENT_EVIDENCE_NODES, m.REUSABLE_NODES + m.REVALIDATION_REQUIRED_NODES);
  assert.equal(m.TOTAL_EVIDENCE_NODES, m.CURRENT_EVIDENCE_NODES + m.REMOVED_EVIDENCE_NODES);
  assert.equal(m.INVALIDATED_NODES, m.REVALIDATION_REQUIRED_NODES + m.REMOVED_EVIDENCE_NODES);
  assert.equal(m.CURRENT_EVIDENCE_BYTES, m.REUSED_EVIDENCE_BYTES + m.REVALIDATE_EVIDENCE_BYTES);
  assert.equal(m.TOTAL_EVIDENCE_BYTES, m.CURRENT_EVIDENCE_BYTES + m.REMOVED_EVIDENCE_BYTES);
  assert.equal(m.AVOIDED_REVALIDATION_RATIO, 0.5);
  assert.equal(m.AVOIDED_EVIDENCE_BYTES, m.REUSED_EVIDENCE_BYTES);
});

// ---------------------------------------------------------------------------
// I3 evaluation metadata is truthful.
// ---------------------------------------------------------------------------

test('R4-I3 inputGraphSha256 is a real digest of the evaluated graph', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  const delta = r3Delta(root);
  const first = evaluate(cas, base.nodes, delta, base.graph);
  const stamp = first.graph.evaluation.inputGraphSha256;
  assert.match(stamp, /^[a-f0-9]{64}$/);
  // Stable across identical evaluations and across JSON round-trip.
  const second = evaluate(cas, base.nodes, r3Delta(root), base.graph);
  assert.equal(second.graph.evaluation.inputGraphSha256, stamp);
  const persisted = JSON.parse(JSON.stringify(first.graph));
  assert.equal(persisted.evaluation.inputGraphSha256, stamp);
  assert.equal(Object.hasOwn(persisted.evaluation, 'inputGraphSha256'), true);
  // Changing evaluated node content changes it.
  const moved = evaluate(cas, replaceContent(base.nodes, 'e:b', { value: 77 }), delta, base.graph);
  assert.notEqual(moved.graph.evaluation.inputGraphSha256, stamp);
  // It is provenance only: it is not the final digest and grants no reuse.
  assert.notEqual(stamp, first.graph.graphSha256);
  const forged = JSON.parse(JSON.stringify(base.graph));
  forged.evaluation = { ...forged.evaluation, inputGraphSha256: '0'.repeat(64) };
  const unaffected = evaluateEvidenceGraph({ graph: createEvidenceGraph({ cas, nodes: base.nodes }), previousGraph: base.graph, r3Delta: r3Delta(root), cas });
  assert.deepEqual(reusableIds(unaffected), ['e:a', 'e:b', 'e:summary']);
});

// ---------------------------------------------------------------------------
// J one canonical evidence-ID vocabulary at every graph input boundary.
//
// API contract under test:
//   builder APIs (createEvidenceGraph, bindFreshValidations) canonicalize
//   caller logical ids; validateGraph is strict and rejects an already
//   materialized graph that is not canonical.
// ---------------------------------------------------------------------------

// Exactly what a naive external caller would recompute after editing a
// serialized graph, so the digest check cannot be what rejects these.
function recomputeGraphDigest(graph) {
  return {
    ...graph,
    graphSha256: sha256Canonical({
      schemaVersion: graph.schemaVersion,
      graphKind: graph.graphKind,
      engine: graph.engine,
      evaluation: graph.evaluation || null,
      nodes: graph.nodes
    })
  };
}

function canonicalPair(root, cas) {
  const delta = r3Delta(root);
  const raw = [
    soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }),
    soloNode({ evidenceId: 'e:child', content: { v: 2 }, dependencies: [`evidence:${PRECOMPOSED}`] })
  ];
  const bound = validated(cas, raw, delta);
  return { delta, nodes: bound, graph: createEvidenceGraph({ cas, nodes: bound }) };
}

test('R4-J01 an NFC evidenceId is stored unchanged', () => {
  const cas = casFor(tempRoot());
  const graph = createEvidenceGraph({ cas, nodes: [soloNode({ evidenceId: PRECOMPOSED })] });
  assert.equal(graph.nodes[0].evidenceId, PRECOMPOSED);
  assert.equal(canonicalEvidenceId(PRECOMPOSED), PRECOMPOSED);
});

test('R4-J02 a decomposed equivalent evidenceId is stored canonically', () => {
  const cas = casFor(tempRoot());
  const graph = createEvidenceGraph({ cas, nodes: [soloNode({ evidenceId: DECOMPOSED })] });
  assert.equal(graph.nodes[0].evidenceId, PRECOMPOSED);
  assert.notEqual(graph.nodes[0].evidenceId, DECOMPOSED);
  // Same logical graph either way, down to the digest.
  assert.equal(graph.graphSha256, createEvidenceGraph({ cas, nodes: [soloNode({ evidenceId: PRECOMPOSED })] }).graphSha256);
});

test('R4-J03 NFC and decomposed ids in one input are a duplicate', () => {
  const cas = casFor(tempRoot());
  assert.throws(() => createEvidenceGraph({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }), soloNode({ evidenceId: DECOMPOSED, content: { v: 2 } })]
  }), /DUPLICATE_EVIDENCE_ID/);
});

test('R4-J04 a decomposed dependency supplied to the builder is stored canonically', () => {
  const cas = casFor(tempRoot());
  const graph = createEvidenceGraph({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }), soloNode({ evidenceId: 'e:child', content: { v: 2 }, dependencies: [`evidence:${DECOMPOSED}`] })]
  });
  const child = graph.nodes.find((node) => node.evidenceId === 'e:child');
  assert.equal(child.dependencies[0], `evidence:${PRECOMPOSED}`);
});

test('R4-J05 a serialized canonical graph still validates', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { graph } = canonicalPair(root, cas);
  const persisted = JSON.parse(JSON.stringify(graph));
  assert.doesNotThrow(() => validateGraph(persisted, cas, 'CURRENT'));
  assert.equal(persisted.nodes.find((node) => node.evidenceId === PRECOMPOSED).evidenceId, PRECOMPOSED);
});

test('R4-J06 a serialized graph with a non-canonical evidenceId is rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { graph } = canonicalPair(root, cas);
  const forged = JSON.parse(JSON.stringify(graph));
  for (const node of forged.nodes) if (node.evidenceId === PRECOMPOSED) node.evidenceId = DECOMPOSED;
  assert.throws(() => validateGraph(recomputeGraphDigest(forged), cas, 'CURRENT'), /NON_CANONICAL_EVIDENCE_ID/);
});

test('R4-J07 a serialized graph with a non-canonical evidence dependency is rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { graph } = canonicalPair(root, cas);
  const forged = JSON.parse(JSON.stringify(graph));
  for (const node of forged.nodes) {
    node.dependencies = node.dependencies.map((dependency) => dependency === `evidence:${PRECOMPOSED}` ? `evidence:${DECOMPOSED}` : dependency);
  }
  assert.throws(() => validateGraph(recomputeGraphDigest(forged), cas, 'CURRENT'), /NON_CANONICAL_EVIDENCE_DEPENDENCY/);
});

test('R4-J08 a supplied graph whose ids collapse to one canonical id is rejected', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { graph } = canonicalPair(root, cas);
  const collapsing = JSON.parse(JSON.stringify(graph));
  const parent = collapsing.nodes.find((node) => node.evidenceId === PRECOMPOSED);
  collapsing.nodes = [...collapsing.nodes, { ...parent, evidenceId: DECOMPOSED }];
  assert.throws(() => validateGraph(recomputeGraphDigest(collapsing), cas, 'CURRENT'), /NON_CANONICAL_EVIDENCE_ID/);
  // An exact canonical duplicate is caught too.
  const duplicated = JSON.parse(JSON.stringify(graph));
  duplicated.nodes = [...duplicated.nodes, { ...parent }];
  assert.throws(() => validateGraph(recomputeGraphDigest(duplicated), cas, 'CURRENT'), /DUPLICATE_CURRENT_EVIDENCE_ID/);
});

test('R4-J09 rejection holds even when the recomputed digest is identical', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { graph } = canonicalPair(root, cas);
  const forged = JSON.parse(JSON.stringify(graph));
  for (const node of forged.nodes) if (node.evidenceId === PRECOMPOSED) node.evidenceId = DECOMPOSED;
  const withDigest = recomputeGraphDigest(forged);
  // The hashing layer normalizes, so the digest genuinely still matches.
  assert.equal(withDigest.graphSha256, graph.graphSha256);
  // It is rejected anyway, on canonicality rather than on the digest.
  assert.throws(() => validateGraph(withDigest, cas, 'CURRENT'), /NON_CANONICAL_EVIDENCE_ID/);
});

test('R4-J10 one valid graphSha256 cannot resolve two different runtime parents', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { delta, graph } = canonicalPair(root, cas);
  const canonicalRun = evaluateEvidenceGraph({ graph, r3Delta: delta, cas });
  assert.equal(nodeOf(canonicalRun, 'e:child').state, REUSABLE);
  const forged = recomputeGraphDigest((() => {
    const copy = JSON.parse(JSON.stringify(graph));
    for (const node of copy.nodes) if (node.evidenceId === PRECOMPOSED) node.evidenceId = DECOMPOSED;
    return copy;
  })());
  assert.equal(forged.graphSha256, graph.graphSha256);
  // The variant that resolved a different parent can no longer be evaluated at all.
  assert.throws(() => evaluateEvidenceGraph({ graph: forged, r3Delta: delta, cas }), /NON_CANONICAL_EVIDENCE_ID/);
});

test('R4-J11 fresh-validation binding with a canonical id binds correctly', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const bound = bindFreshValidations({ cas, nodes: [soloNode({ evidenceId: PRECOMPOSED })], r3Delta: delta, validationResults: { [PRECOMPOSED]: PASS } });
  assert.equal(bound[0].producingValidation.validationState, 'CURRENT');
  assert.equal(stateOf(evaluate(cas, bound, delta), PRECOMPOSED), REUSABLE);
});

test('R4-J12 fresh-validation binding canonicalizes a decomposed logical id', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  // Documented contract: builder APIs canonicalize caller logical ids.
  const decomposedKey = bindFreshValidations({ cas, nodes: [soloNode({ evidenceId: PRECOMPOSED })], r3Delta: delta, validationResults: { [DECOMPOSED]: PASS } });
  assert.ok(decomposedKey[0].producingValidation, 'a decomposed results key must bind, not silently no-op');
  assert.equal(stateOf(evaluate(cas, decomposedKey, delta), PRECOMPOSED), REUSABLE);
  // And the mirror case: decomposed node id, canonical results key.
  const decomposedNode = bindFreshValidations({ cas, nodes: [soloNode({ evidenceId: DECOMPOSED })], r3Delta: delta, validationResults: { [PRECOMPOSED]: PASS } });
  assert.ok(decomposedNode[0].producingValidation);
  // Both spellings produce the identical binding, which is the point.
  assert.equal(decomposedNode[0].producingValidation.validationBasisSha256, decomposedKey[0].producingValidation.validationBasisSha256);
  // bindFreshValidations also refuses caller ids that collapse together.
  assert.throws(() => bindFreshValidations({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }), soloNode({ evidenceId: DECOMPOSED, content: { v: 2 } })],
    r3Delta: delta,
    validationResults: {}
  }), /DUPLICATE_EVIDENCE_ID/);
});

test('R4-J13 a full parent/child lifecycle works with non-ASCII canonical ids', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const parentId = 'lc:par\u00eant';
  const childId = 'lc:enfant';
  const build = (parentValue) => [
    { evidenceId: parentId, content: { value: parentValue }, evidenceType: 'FACT', provenance: { sourcePath: 'src/a.json', authorityClass: 'CANONICAL' }, dependencies: ['source:src/a.json'], authorityStatus: 'GROUNDED' },
    { evidenceId: childId, content: { derived: true }, evidenceType: 'DERIVED', provenance: { sourcePath: 'src/b.json', authorityClass: 'CANONICAL' }, dependencies: [`evidence:${parentId.normalize('NFD')}`], authorityStatus: 'GROUNDED' }
  ];
  const base = baseline(root, cas, build(1));
  assert.deepEqual(reusableIds(evaluate(cas, base.nodes, r3Delta(root), base.graph)), [childId, parentId].sort((a, b) => (a < b ? -1 : 1)));
  const delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const changed = replaceContent(base.nodes, parentId, { value: 2 });
  const fell = evaluate(cas, changed, delta, base.graph);
  assert.equal(stateOf(fell, parentId), INVALIDATED);
  assert.equal(reasonOf(fell, childId), 'PARENT_EVIDENCE_INVALIDATED');
  const parentOnly = validated(cas, changed, delta, { [childId]: null });
  assert.equal(reasonOf(evaluate(cas, parentOnly, delta, base.graph), childId), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
  const both = validated(cas, parentOnly, delta, { [parentId]: null });
  assert.equal(evaluate(cas, both, delta, base.graph).reusableNodes.length, 2);
  assert.equal(evaluate(cas, both, r3Delta(root), base.graph).reusableNodes.length, 2);
});

test('R4-J14 a JSON round-trip retains canonical ids', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { delta, graph } = canonicalPair(root, cas);
  const evaluated = evaluateEvidenceGraph({ graph, r3Delta: delta, cas }).graph;
  const persisted = JSON.parse(JSON.stringify(evaluated));
  assert.deepEqual(persisted.nodes.map((node) => node.evidenceId), evaluated.nodes.map((node) => node.evidenceId));
  assert.ok(persisted.nodes.every((node) => node.evidenceId === node.evidenceId.normalize('NFC')));
  assert.equal(persisted.graphSha256, evaluated.graphSha256);
});

test('R4-J15 cross-process replay with non-ASCII ids is byte-identical', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { delta, nodes: boundNodes, graph } = canonicalPair(root, cas);
  const local = evaluateEvidenceGraph({ graph, r3Delta: delta, cas });
  const payload = path.join(root, 'j15-payload.json');
  fs.writeFileSync(payload, JSON.stringify({ casRoot: path.join(root, 'cas'), nodes: boundNodes, r3Delta: delta }));
  const runner = path.join(root, 'j15-runner.mjs');
  fs.writeFileSync(runner, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const evidence = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/evidence/evidence-graph.mjs'))}).href);
const cas = await import(pathToFileURL(${JSON.stringify(path.join(REPO_ROOT, 'governance/gee-v1/cas/content-addressed-store.mjs'))}).href);
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(payload)}, 'utf8'));
const store = cas.createContentAddressedStore(payload.casRoot);
const result = evidence.evaluateEvidenceGraph({
  graph: evidence.createEvidenceGraph({ cas: store, nodes: payload.nodes }),
  r3Delta: payload.r3Delta,
  cas: store
});
process.stdout.write(JSON.stringify({ graphSha256: result.graph.graphSha256, ids: result.graph.nodes.map((n) => n.evidenceId), reusable: result.reusableNodes.map((n) => n.evidenceId) }));
`);
  const observed = JSON.parse(execFileSync(process.execPath, [runner], { encoding: 'utf8' }));
  assert.equal(observed.graphSha256, local.graph.graphSha256);
  assert.deepEqual(observed.ids, local.graph.nodes.map((node) => node.evidenceId));
  assert.deepEqual(observed.reusable, reusableIds(local));
  assert.ok(observed.ids.includes(PRECOMPOSED));
});

test('R4-J16 ASCII graphs and their digests are unchanged', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const base = baseline(root, cas);
  assert.deepEqual(base.graph.nodes.map((node) => node.evidenceId), ['e:a', 'e:b', 'e:summary']);
  assert.deepEqual(reusableIds(evaluate(cas, base.nodes, r3Delta(root), base.graph)), ['e:a', 'e:b', 'e:summary']);
  // An ASCII graph is byte-identical whether or not canonicalization is involved.
  const rebuilt = createEvidenceGraph({ cas, nodes: base.nodes });
  assert.equal(rebuilt.graphSha256, createEvidenceGraph({ cas, nodes: [...base.nodes].reverse() }).graphSha256);
  assert.doesNotThrow(() => validateGraph(JSON.parse(JSON.stringify(base.graph)), cas, 'CURRENT'));
});

test('R4-J17 source-path fail-closed behaviour is unchanged', () => {
  const root = tempRoot();
  const cas = casFor(root);
  assert.throws(() => createEvidenceGraph({ cas, nodes: [soloNode({ dependencies: [`source:${NON_CANONICAL_PATH}`] })] }), /NON_CANONICAL_SOURCE_DEPENDENCY/);
  assert.throws(() => createEvidenceGraph({ cas, nodes: [soloNode({ provenance: { sourcePath: NON_CANONICAL_PATH } })] }), /NON_CANONICAL_PROVENANCE_SOURCE/);
  // And a serialized graph carrying one is rejected at validation too.
  const base = baseline(root, cas);
  const forged = JSON.parse(JSON.stringify(base.graph));
  forged.nodes[0].provenance = { ...forged.nodes[0].provenance, sourcePath: NON_CANONICAL_PATH };
  assert.throws(() => validateGraph(recomputeGraphDigest(forged), cas, 'CURRENT'), /NON_CANONICAL_PROVENANCE_SOURCE/);
});

test('R4-J18 hostile serialized-graph mutations never reach trust evaluation', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const { delta, graph } = canonicalPair(root, cas);
  const parent = graph.nodes.find((node) => node.evidenceId === PRECOMPOSED);
  const attacks = {
    NON_CANONICAL_ID: (g) => { for (const n of g.nodes) if (n.evidenceId === PRECOMPOSED) n.evidenceId = DECOMPOSED; },
    NON_CANONICAL_DEPENDENCY: (g) => { for (const n of g.nodes) n.dependencies = n.dependencies.map((d) => d === `evidence:${PRECOMPOSED}` ? `evidence:${DECOMPOSED}` : d); },
    COLLAPSING_DUPLICATE: (g) => { g.nodes = [...g.nodes, { ...parent, evidenceId: DECOMPOSED }]; },
    NON_CANONICAL_PROVENANCE: (g) => { g.nodes[0].provenance = { ...g.nodes[0].provenance, sourcePath: NON_CANONICAL_PATH }; },
    EXACT_DUPLICATE: (g) => { g.nodes = [...g.nodes, { ...parent }]; }
  };
  for (const [name, mutate] of Object.entries(attacks)) {
    const forged = JSON.parse(JSON.stringify(graph));
    mutate(forged);
    const supplied = recomputeGraphDigest(forged);
    assert.throws(() => validateGraph(supplied, cas, 'CURRENT'), /NON_CANONICAL_|DUPLICATE_/, name);
    assert.throws(() => evaluateEvidenceGraph({ graph: supplied, r3Delta: delta, cas }), /NON_CANONICAL_|DUPLICATE_/, name);
    // Also rejected when supplied as the previous graph.
    assert.throws(() => evaluateEvidenceGraph({ graph, previousGraph: supplied, r3Delta: delta, cas }), /NON_CANONICAL_|DUPLICATE_/, name);
  }
  // Positive control: the untouched serialized graph is still accepted.
  assert.equal(evaluateEvidenceGraph({ graph: JSON.parse(JSON.stringify(graph)), r3Delta: delta, cas }).reusableNodes.length, 2);
});

// ---------------------------------------------------------------------------
// K a canonical validation-result key collision is ambiguous caller input.
// ---------------------------------------------------------------------------

const FAIL_RESULT = Object.freeze({ validator: 'TEST_PRODUCING_VALIDATOR', result: 'FAIL' });

function bindWith(cas, delta, validationResults) {
  return bindFreshValidations({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } })],
    r3Delta: delta,
    validationResults
  });
}

test('R4-K01 two caller keys for one canonical id are rejected even when they agree', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  assert.throws(
    () => bindWith(cas, delta, { [PRECOMPOSED]: PASS, [DECOMPOSED]: PASS }),
    /DUPLICATE_VALIDATION_RESULT_EVIDENCE_ID/
  );
});

test('R4-K02 FAIL then PASS for one canonical id is rejected, not resolved to PASS', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  assert.throws(
    () => bindWith(cas, delta, { [PRECOMPOSED]: FAIL_RESULT, [DECOMPOSED]: PASS }),
    /DUPLICATE_VALIDATION_RESULT_EVIDENCE_ID/
  );
});

test('R4-K03 PASS then FAIL for one canonical id is rejected, not resolved to FAIL', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  assert.throws(
    () => bindWith(cas, delta, { [PRECOMPOSED]: PASS, [DECOMPOSED]: FAIL_RESULT }),
    /DUPLICATE_VALIDATION_RESULT_EVIDENCE_ID/
  );
});

test('R4-K03b insertion order cannot decide validation state', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const outcomes = [
    { [PRECOMPOSED]: FAIL_RESULT, [DECOMPOSED]: PASS },
    { [DECOMPOSED]: PASS, [PRECOMPOSED]: FAIL_RESULT },
    { [PRECOMPOSED]: PASS, [DECOMPOSED]: FAIL_RESULT },
    { [DECOMPOSED]: FAIL_RESULT, [PRECOMPOSED]: PASS }
  ].map((validationResults) => {
    try {
      const bound = bindWith(cas, delta, validationResults);
      return `BOUND:${bound[0].producingValidation?.result}`;
    } catch (error) {
      return error.message.split(':').slice(0, 1).join(':');
    }
  });
  // Every ordering produces the identical outcome; none binds anything.
  assert.deepEqual(new Set(outcomes), new Set(['DUPLICATE_VALIDATION_RESULT_EVIDENCE_ID']));
});

test('R4-K04 a single canonical validation-result key still binds', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const bound = bindWith(cas, delta, { [PRECOMPOSED]: PASS });
  assert.equal(bound[0].producingValidation.validationState, 'CURRENT');
  assert.equal(stateOf(evaluate(cas, bound, delta), PRECOMPOSED), REUSABLE);
});

test('R4-K05 a single decomposed validation-result key still canonicalizes and binds', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  const bound = bindWith(cas, delta, { [DECOMPOSED]: PASS });
  assert.equal(bound[0].producingValidation.validationState, 'CURRENT');
  assert.equal(stateOf(evaluate(cas, bound, delta), PRECOMPOSED), REUSABLE);
  // Identical to the canonical-key binding, so the two spellings are one identity.
  assert.equal(
    bound[0].producingValidation.validationBasisSha256,
    bindWith(cas, delta, { [PRECOMPOSED]: PASS })[0].producingValidation.validationBasisSha256
  );
});

test('R4-K06 node-id duplicate detection is unaffected by the result-key check', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const delta = r3Delta(root);
  assert.throws(() => bindFreshValidations({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } }), soloNode({ evidenceId: DECOMPOSED, content: { v: 2 } })],
    r3Delta: delta,
    validationResults: { [PRECOMPOSED]: PASS }
  }), /DUPLICATE_EVIDENCE_ID/);
  // A results key naming a node that is not present is still simply ignored.
  const bound = bindFreshValidations({
    cas,
    nodes: [soloNode({ evidenceId: PRECOMPOSED, content: { v: 1 } })],
    r3Delta: delta,
    validationResults: { [PRECOMPOSED]: PASS, 'e:absent': PASS }
  });
  assert.equal(bound.length, 1);
  assert.equal(stateOf(evaluate(cas, bound, delta), PRECOMPOSED), REUSABLE);
});

// ---------------------------------------------------------------------------
// Multi-mission lifecycle, persisted as JSON between every mission.
// ---------------------------------------------------------------------------

test('R4-H29 five-mission parent/child lifecycle survives serialization', () => {
  const root = tempRoot();
  const cas = casFor(root);
  const persist = (value) => JSON.parse(JSON.stringify(value));

  // T0 - both genuinely validated, baseline established.
  const t0Delta = r3Delta(root);
  const t0Nodes = persist(validated(cas, lifecycleNodes(1), t0Delta));
  const t0 = evaluate(cas, t0Nodes, t0Delta);
  assert.deepEqual(reusableIds(t0), ['lc:child', 'lc:parent']);

  // T1 - nothing changes, both reused.
  const t1Delta = r3Delta(root);
  const t1 = evaluate(cas, persist(t0Nodes), t1Delta, persist(t0.graph));
  assert.deepEqual(reusableIds(t1), ['lc:child', 'lc:parent']);
  assert.equal(t1.metrics.AVOIDED_REVALIDATION_RATIO, 1);

  // T2a - the parent source changes; parent and child both fall.
  const t2Delta = r3Delta(root, () => fs.writeFileSync(path.join(root, 'src', 'a.json'), '{"a":2}'));
  const t2Nodes = persist(replaceContent(t0Nodes, 'lc:parent', { value: 2 }));
  const t2a = evaluate(cas, t2Nodes, t2Delta, persist(t1.graph));
  assert.equal(stateOf(t2a, 'lc:parent'), INVALIDATED);
  assert.equal(stateOf(t2a, 'lc:child'), INVALIDATED);
  assert.equal(t2a.metrics.REVALIDATION_REQUIRED_NODES, 2);

  // T2b - only the parent is genuinely revalidated.
  const t2bNodes = persist(validated(cas, t2Nodes, t2Delta, { 'lc:child': null }));
  const t2b = evaluate(cas, t2bNodes, t2Delta, persist(t2a.graph));
  assert.equal(stateOf(t2b, 'lc:parent'), REUSABLE);
  assert.equal(stateOf(t2b, 'lc:child'), INVALIDATED);
  assert.equal(reasonOf(t2b, 'lc:child'), 'PARENT_EVIDENCE_IDENTITY_CHANGED');
  assert.equal(t2b.metrics.AVOIDED_REVALIDATION_NODES, 1);

  // T3 - the child is revalidated against the current parent identity.
  const t3Delta = r3Delta(root);
  const t3Nodes = persist(validated(cas, t2bNodes, t3Delta, { 'lc:parent': null }));
  const t3 = evaluate(cas, t3Nodes, t3Delta, persist(t2b.graph));
  assert.deepEqual(reusableIds(t3), ['lc:child', 'lc:parent']);

  // T4 - unchanged replay reuses everything again.
  const t4 = evaluate(cas, persist(t3Nodes), r3Delta(root), persist(t3.graph));
  assert.deepEqual(reusableIds(t4), ['lc:child', 'lc:parent']);
  assert.equal(t4.metrics.AVOIDED_REVALIDATION_RATIO, 1);
});
