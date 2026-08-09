import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileContext } from '../context/compile-context.mjs';
import { buildWheelContextInput, createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { createGeeR2SyntheticAdapter } from '../fixtures/gee-r2-synthetic-adapter.mjs';

function tempAdapter({ defectsOpenKnowledge = 'KNOWN_ZERO', blockers = [], authorityConflicts = [], status = 'AUTHORIZED_NOT_STARTED' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r2-'));
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'fixtures', 'canonical.json'), JSON.stringify({ objective: 'Objective', status }));
  fs.writeFileSync(path.join(root, 'fixtures', 'large-evidence.json'), JSON.stringify({ body: 'large-evidence-body'.repeat(100) }));
  const view = { projectId: 'TEST', workUnitType: 'UNIT', workUnitId: 'U1', objective: 'Objective', state: { value: status, verified: true, identityBinding: 'BOUND', trustLevel: 'ANCHORED_APPEND_ONLY', authority: { ref: 'fixtures/canonical.json' } }, prerequisites: [{ id: 'P1', critical: true }], closure: null, defectsOpenKnowledge, defectsOpenCount: defectsOpenKnowledge === 'KNOWN_NONZERO' ? 1 : 0, evidence: [], sources: { interpreted: ['fixtures/canonical.json'], copiedAuthority: false } };
  const adapter = { getWorkUnitView: (id) => { if (id !== 'U1') throw new Error('UNKNOWN_WORK_UNIT:U2'); return view; }, getContextInput: () => ({ mission: { id: 'TEST_MISSION', objective: 'Objective', sourcePath: 'fixtures/canonical.json', sourceField: 'objective' }, sources: [{ path: 'fixtures/canonical.json', role: 'canonical', relevanceReason: 'test' }], constraints: [{ ruleId: 'MANDATORY_RULE', statement: 'Must remain', sourcePath: 'fixtures/canonical.json' }], blockers, authorityConflicts, evidenceReferences: [{ ref: 'fixtures/large-evidence.json', reason: 'reference only' }], prohibitedActions: ['No authority escalation'], successConditions: ['Output is deterministic'], nextAction: 'Continue.' }) };
  return { root, adapter };
}

function compile(fixture, options = {}) { return compileContext({ repoRoot: fixture.root, adapter: fixture.adapter, workUnitId: 'U1', sourceHead: 'HEAD_TEST', ...options }); }

test('R2-01/R2-15 identical inputs are deterministic and ordered', () => {
  const f = tempAdapter(); const a = compile(f); const b = compile(f);
  assert.deepEqual(a.json, b.json); assert.equal(a.markdown, b.markdown);
  assert.deepEqual(a.json.applicableConstraints.map((x) => x.ruleId), ['MANDATORY_RULE']);
});

test('R2-02 closed defects are excluded; R2-03 active blocker is retained', () => {
  assert.deepEqual(compile(tempAdapter()).json.activeDefectsOrBlockers, []);
  assert.equal(compile(tempAdapter({ defectsOpenKnowledge: 'KNOWN_NONZERO' })).json.activeDefectsOrBlockers[0].code, 'ACTIVE_DEFECTS');
});

test('R2-04 mandatory rule cannot be budget-dropped', () => assert.throws(() => compile(tempAdapter(), { budget: { maxBytes: 20 } }), /CONTEXT_BUDGET_INSUFFICIENT/));
test('R2-05 applicable reduction excludes unspecified rules', () => assert.equal(compile(tempAdapter()).json.applicableConstraints.length, 1));
test('R2-06 execution facts have source provenance and hashes', () => {
  const result = compile(tempAdapter({ blockers: [{ code: 'B1', detail: 'active' }] })).json;
  const facts = result.facts;
  assert.ok(facts.every((fact) => fact.provenance.sourcePath && fact.provenance.sourceSha256 && fact.provenance.authorityClass));
  assert.ok(result.activeState.prerequisites.every((item) => item.provenance?.sourcePath));
  assert.ok(result.activeState.blockers.every((item) => item.provenance?.sourcePath));
});
test('R2-07 missing critical authority fails closed', () => { const f = tempAdapter(); fs.unlinkSync(path.join(f.root, 'fixtures', 'canonical.json')); assert.throws(() => compile(f), /MISSING_CANONICAL_SOURCE/); });
test('R2-08 conflicting authority fails closed', () => assert.throws(() => compile(tempAdapter({ authorityConflicts: ['status'] }), {}), /CONFLICTING_AUTHORITY/));
test('R2-09 unknown work unit fails explicitly', () => { const f = tempAdapter(); assert.throws(() => compileContext({ repoRoot: f.root, adapter: f.adapter, workUnitId: 'U2' }), /UNKNOWN_WORK_UNIT/); });
test('R2-10 Wheel adapter compiles real GATE13', () => { const result = compileContext({ repoRoot: process.cwd(), adapter: createWheelContextAdapter(process.cwd()), workUnitId: 'GATE13', sourceHead: '9d9054a71faa43872416fb3616daf54cca9b1cd1' }); assert.equal(result.json.activeState.canonicalStatus, 'COMPLETE_CONFIRMED'); });
test('R2-11 synthetic non-Wheel adapter uses the same generic core', () => { const f = tempAdapter(); const source = path.join(f.root, 'fixtures', 'canonical.json'); const result = compileContext({ repoRoot: f.root, adapter: createGeeR2SyntheticAdapter(), workUnitId: 'SYNTH_01', sourceHead: 'HEAD_TEST' }); assert.equal(result.json.identity.project, 'SYNTHETIC_LAB'); assert.ok(result.json.facts.length); fs.unlinkSync(source); });
test('R2-12 Markdown has mandatory operational information', () => { const md = compile(tempAdapter()).markdown; for (const token of ['Objective', 'Applicable constraints', 'Next action', 'NON_AUTHORITATIVE']) assert.match(md, new RegExp(token)); });
test('R2-13 insufficient budget is explicit, never truncation', () => assert.throws(() => compile(tempAdapter(), { budget: { maxFacts: 1 } }), /CONTEXT_BUDGET_INSUFFICIENT/));
test('R2-14 large evidence is referenced, not embedded', () => { const result = compile(tempAdapter()); assert.equal(result.json.reusableEvidenceReferences[0].ref, 'fixtures/large-evidence.json'); assert.equal(JSON.stringify(result.json).includes('large-evidence-body'), false); });
test('R2-R2 unknown authority class fails closed', () => { const f = tempAdapter(); const original = f.adapter.getContextInput; f.adapter.getContextInput = (...args) => { const input = original(...args); input.sources[0].authorityClass = 'TOTALLY_UNKNOWN'; return input; }; assert.throws(() => compile(f), /UNKNOWN_AUTHORITY_CLASS:TOTALLY_UNKNOWN/); });
test('R2-R4 nonexistent trusted evidence fails closed', () => { const f = tempAdapter(); const original = f.adapter.getContextInput; f.adapter.getContextInput = (...args) => ({ ...original(...args), evidenceReferences: [{ ref: 'fixtures/DOES_NOT_EXIST.json', trusted: true }] }); assert.throws(() => compile(f), /MISSING_TRUSTED_EVIDENCE/); });
test('R2-R6 Wheel authority inconsistency fails closed with deterministic reason', () => { const f = tempAdapter(); const view = f.adapter.getWorkUnitView('U1'); const conflicted = { ...view, authorityState: { consistent: false, reason: 'SEAL_AND_LEDGER_DISAGREE_LEDGER_WINS' } }; const adapter = { getWorkUnitView: () => conflicted, getContextInput: () => buildWheelContextInput(conflicted) }; assert.throws(() => compileContext({ repoRoot: f.root, adapter, workUnitId: 'U1' }), /CONFLICTING_AUTHORITY:SEAL_AND_LEDGER_DISAGREE_LEDGER_WINS/); });
test('R2-R7 existing verified=false evidence is never canonical', () => { const f = tempAdapter(); const original = f.adapter.getContextInput; f.adapter.getContextInput = (...args) => ({ ...original(...args), evidenceReferences: [{ ref: 'fixtures/large-evidence.json', verified: false, trusted: true }] }); const result = compile(f).json.reusableEvidenceReferences[0]; assert.equal(result.authorityStatus, 'NON_AUTHORITATIVE_UNVERIFIED'); assert.equal(result.provenance, null); });
test('R2-R7 existing verified=true evidence is grounded', () => { const f = tempAdapter(); const original = f.adapter.getContextInput; f.adapter.getContextInput = (...args) => ({ ...original(...args), evidenceReferences: [{ ref: 'fixtures/large-evidence.json', verified: true, trusted: true }] }); const result = compile(f).json.reusableEvidenceReferences[0]; assert.equal(result.authorityStatus, 'GROUNDED'); assert.equal(result.provenance.authorityClass, 'CANONICAL_EVIDENCE'); });
test('R2-R1 completed GATE13 does not inherit R2 execution scope', () => { const result = compileContext({ repoRoot: process.cwd(), adapter: createWheelContextAdapter(process.cwd()), workUnitId: 'GATE13', sourceHead: '9d9054a71faa43872416fb3616daf54cca9b1cd1' }); const text = JSON.stringify(result.json); assert.equal(text.includes('GEE_V1_EXECUTION_CONTRACT_R0002'), false); assert.equal(text.includes('authorized R2 prefixes'), false); assert.equal(result.json.applicableConstraints.some((item) => item.ruleId === 'AUTHORIZED_PATHS_ONLY'), false); });
test('R2-16 output does not falsely claim R3/R4 freshness capabilities', () => { const text = JSON.stringify(compile(tempAdapter()).json); assert.equal(/R3|R4|freshness engine|evidence graph/i.test(text), false); });
test('R2-17/R2-18 compiled context declares no authority', () => { const result = compile(tempAdapter()); assert.equal(result.json.authorityDeclaration, 'DERIVED / NON_AUTHORITATIVE'); });
test('R2-19 canonical state cannot be overridden by an untrusted summary', () => { const f = tempAdapter({ status: 'COMPLETE_CONFIRMED' }); assert.equal(compile(f).json.activeState.canonicalStatus, 'COMPLETE_CONFIRMED'); });
test('R2-20 compiler has no conversation-history input', () => { assert.equal(Object.prototype.hasOwnProperty.call(compile(tempAdapter()).json, 'conversationHistory'), false); });
test('hostile generated source and unknown authority are rejected', () => { const f = tempAdapter(); f.adapter.getContextInput = () => ({ mission: { objective: 'x', sourcePath: 'fixtures/canonical.json' }, sources: [{ path: 'generated/fake.json' }] }); fs.mkdirSync(path.join(f.root, 'generated')); fs.writeFileSync(path.join(f.root, 'generated', 'fake.json'), '{}'); assert.throws(() => compile(f), /GENERATED_SOURCE_NOT_AUTHORITY/); });
