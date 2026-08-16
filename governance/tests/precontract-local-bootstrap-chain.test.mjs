/**
 * END-TO-END ACCEPTANCE FOR THE LOCAL BOOTSTRAP CHAIN, PLUS ITS HOSTILE BATTERY.
 *
 * A unit PASS on the PRECONTRACT primitive proves nothing about the property
 * that actually matters, which is that a Gate sitting at NOT_STARTED with no
 * CURRENT_CONTRACT can travel the whole lawful road:
 *
 *   owner decision -> LOCAL_EXPLICIT_AUTHORITY -> bootstrap -> R0001
 *     -> CURRENT_CONTRACT -> authority consumed -> normal AUTHORIZATION
 *     -> normal START -> ledger accepts -> the Gate has left NOT_STARTED
 *
 * So this runs the real tools against a real Git repository. The fixture is a
 * disposable copy of the governed tree with the Gate under test rewound to
 * genesis, which is what makes the test independent of whichever Gate the live
 * repository happens to be executing.
 *
 * NOTHING IS SIMULATED. The orchestrator, the ledger validator, the state seal
 * validator and the contract validator all run for real, against real bytes, in
 * a real staging root. A test that mocked any of them would be asserting
 * something about a model of the transition rather than the transition.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  computePrecontractLocalRequestDigest,
  evaluatePrecontractAuthority,
  PRECONTRACT_LOCAL_AUTHORITY_MODE
} from '../gee-v1/core/precontract-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { issuePrecontractAuthority } from '../tools/issue-precontract-authority.mjs';
import { applyPrecontractBootstrap } from '../tools/apply-precontract-bootstrap.mjs';
import { buildGateAuthorizationDocuments, buildGateStartDocuments } from '../tools/build-gate-lifecycle-records.mjs';
import { runLifecycleTransition } from '../tools/gate-lifecycle-orchestrator.mjs';
import { sha256Canonical } from '../tools/canonical-json.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const GATE = 'GATE19';
const TEMPLATE_GATE = 'GATE17';
const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const AUTHORITY_RELATIVE = `governance/authority/precontract/${GATE}/PROJECT_OWNER_LOCAL_PRECONTRACT_AUTHORITY.json`;
const CONTRACT_RELATIVE = `governance/gates/${GATE}/contracts/EXECUTION_CONTRACT_R0001.json`;
const POINTER_RELATIVE = `governance/gates/${GATE}/contracts/CURRENT_CONTRACT.json`;
const CONSUMPTION_RELATIVE = `governance/gates/${GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`;
const ISSUED_AT = '2026-08-15T13:10:00.000Z';
const EXPIRES_AT = '2026-12-31T23:59:59.000Z';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
const writeJson = (root, relative, value) => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * A disposable governed tree with `GATE` rewound to genesis: no contract, no
 * authorization documents, no lifecycle events. The truncation only removes the
 * Gate's own tail events, so the append-only hash chain of everything before it
 * is untouched and still replays.
 */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bootstrap-chain-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });

  const ledgerPath = path.join(root, ...LEDGER.split('/'));
  const kept = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => !(event.gateId === GATE && event.transitionType !== 'GENESIS_IMPORT'));
  fs.writeFileSync(ledgerPath, `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`);
  for (const directory of [`governance/gates/${GATE}`, `governance/authority/authorizations/${GATE}`, `governance/authority/precontract/${GATE}`]) {
    fs.rmSync(path.join(root, ...directory.split('/')), { recursive: true, force: true });
  }
  const snapshot = spawnSync(process.execPath, [path.join(root, 'governance/tools/generate-status-snapshot.mjs'), '--root', root], { cwd: root, encoding: 'utf8' });
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@local']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['add', '-A']);
  const commit = git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'bootstrap-chain fixture']);
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  return {
    root,
    head: git(root, ['rev-parse', 'HEAD']).stdout.trim(),
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).stdout.trim()
  };
}

/**
 * The staged contract, transposed from an already-closed Gate's real R0001 so
 * the fixture never depends on artifacts this very mission produces.
 */
function stageContract(fixtureRoot) {
  const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bootstrap-staged-'));
  const template = readJson(fixtureRoot, `governance/gates/${TEMPLATE_GATE}/contracts/EXECUTION_CONTRACT_R0001.json`);
  const registry = readJson(fixtureRoot, 'governance/GATE_REGISTRY_00_40.json');
  const entry = registry.gates.find((gate) => gate.gateId === GATE);
  const transposed = JSON.parse(JSON.stringify(template).replaceAll(TEMPLATE_GATE, GATE));
  transposed.strategicRegistryReference = {
    registryPath: 'governance/GATE_REGISTRY_00_40.json',
    registrySha256: sha256(fs.readFileSync(path.join(fixtureRoot, 'governance/GATE_REGISTRY_00_40.json'))),
    gateId: GATE,
    canonicalObjectiveSha256: sha256Canonical(entry.canonicalObjective)
  };
  writeJson(staged, CONTRACT_RELATIVE, transposed);
  const contractBytes = fs.readFileSync(path.join(staged, ...CONTRACT_RELATIVE.split('/')));
  writeJson(staged, POINTER_RELATIVE, {
    schemaVersion: 1, gateId: GATE, contractRevision: 'R0001',
    contractPath: CONTRACT_RELATIVE, contractSha256: sha256(contractBytes), activatedByEventId: null
  });
  return { staged, stagedPaths: [CONTRACT_RELATIVE, POINTER_RELATIVE] };
}

function issue(fixtureRoot, staged, stagedPaths) {
  const result = issuePrecontractAuthority({
    root: fixtureRoot, gateId: GATE, authorityId: `PRECONTRACT_BOOTSTRAP_${GATE}_LOCAL_R1`,
    stagedRoot: staged, stagedPaths, issuedAtUtc: ISSUED_AT, expiresAtUtc: EXPIRES_AT
  });
  assert.equal(result.verdict, 'ISSUED', JSON.stringify(result.findings));
  return result.authority;
}

/** Re-seal a mutated authority so the test attacks the BINDING, not the digest. */
function reseal(authority) {
  const resealed = structuredClone(authority);
  resealed.approvedRequestDigest = computePrecontractLocalRequestDigest(resealed);
  return resealed;
}

function decide(fixtureRoot, authority, { authorityRelative = AUTHORITY_RELATIVE, requestPath = null } = {}) {
  writeJson(fixtureRoot, authorityRelative, authority);
  const source = createWheelPrecontractAuthoritySource(fixtureRoot, {
    authorityPath: path.join(fixtureRoot, ...authorityRelative.split('/')),
    requestPath, now: new Date(ISSUED_AT)
  });
  return source.resolvePrecontractAuthority(GATE);
}

const fixture = buildFixture();
const { staged, stagedPaths } = stageContract(fixture.root);
const validAuthority = issue(fixture.root, staged, stagedPaths);

// --------------------------------------------------------------------------
// PHASE 4 — hostile battery. Every case runs before any byte is bootstrapped,
// and AUTHORIZE_WRITE writes nothing, so one fixture serves them all.
// --------------------------------------------------------------------------

test('H00 the pre-repair world is reproduced: an unsigned legacy-shaped authority is refused', () => {
  // Strip the mode and the local-only bindings and you have exactly the document
  // the primitive accepted before this repair existed: a signature-mode
  // authority with no signature. It must be BLOCKED, or the repair would have
  // widened the legacy branch instead of adding a bounded second mode.
  const legacyShaped = {
    schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY',
    authorityId: validAuthority.authorityId, issuedBy: 'PROJECT_OWNER', issuedAtUtc: ISSUED_AT,
    approvedRequestDigest: validAuthority.approvedRequestDigest, projectId: 'WHEEL', gateId: GATE,
    purpose: validAuthority.purpose, operation: validAuthority.operation,
    authorizedPaths: validAuthority.artifactBindings.map((binding) => binding.path),
    artifactBindings: validAuthority.artifactBindings, expiresAtUtc: EXPIRES_AT, maxUse: 1
  };
  const result = decide(fixture.root, legacyShaped, { authorityRelative: `${AUTHORITY_RELATIVE}.legacy.json` });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'OWNER_SIGNATURE_INVALID'), JSON.stringify(result.findings));
});

test('H01 no authority at all is BLOCKED', () => {
  const source = createWheelPrecontractAuthoritySource(fixture.root, { now: new Date(ISSUED_AT) });
  const result = source.resolvePrecontractAuthority(GATE);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'PRECONTRACT_SOURCE_UNCONFIGURED'));
});

const bindingAttacks = [
  ['H02 wrong Gate', (authority) => { authority.gateId = 'GATE20'; }, 'GATE_ID_MISMATCH'],
  ['H03 wrong HEAD', (authority) => { authority.preState.baseCommit = 'a'.repeat(40); }, 'BASE_COMMIT_MISMATCH'],
  ['H04 wrong tree', (authority) => { authority.preState.baseTree = 'b'.repeat(40); }, 'BASE_TREE_MISMATCH'],
  ['H05 wrong ledger prestate', (authority) => { authority.preState.ledgerSha256 = 'c'.repeat(64); }, 'LEDGER_SHA_MISMATCH'],
  ['H05b wrong ledger event count', (authority) => { authority.preState.ledgerEventCount += 1; }, 'LEDGER_EVENT_COUNT_MISMATCH'],
  ['H06 wrong predecessor', (authority) => { authority.dependencyProof = { ...authority.dependencyProof, gateId: 'GATE16' }; }, 'DEPENDENCY_PROOF_MISMATCH'],
  ['H06b forged predecessor authority hash', (authority) => { authority.dependencyProof = { ...authority.dependencyProof, authoritySha256: 'd'.repeat(64) }; }, 'DEPENDENCY_PROOF_MISMATCH'],
  ['H07 path outside the bootstrap cohort', (authority) => {
    authority.authorizedPaths = [...authority.authorizedPaths, 'governance/PROJECT_CONSTITUTION.json'];
    authority.artifactBindings = [...authority.artifactBindings, { path: 'governance/PROJECT_CONSTITUTION.json', sha256: 'e'.repeat(64) }];
  }, 'PRECONTRACT_PATH_OUTSIDE_BOOTSTRAP_SCOPE'],
  ['H08 path traversal', (authority) => {
    authority.authorizedPaths = [...authority.authorizedPaths, '../outside.json'];
    authority.artifactBindings = [...authority.artifactBindings, { path: '../outside.json', sha256: 'f'.repeat(64) }];
  }, 'UNSAFE_AUTHORIZED_PATH'],
  ['H08b wildcard scope', (authority) => {
    authority.authorizedPaths = [...authority.authorizedPaths, `governance/gates/${GATE}/*`];
    authority.artifactBindings = [...authority.artifactBindings, { path: `governance/gates/${GATE}/*`, sha256: '1'.repeat(64) }];
  }, 'UNSAFE_AUTHORIZED_PATH'],
  ['H14 START claimed as the bootstrap operation', (authority) => { authority.operation = 'START'; }, 'PURPOSE_OR_OPERATION_INVALID'],
  ['H15 AGENT_CLOSURE claimed as the bootstrap operation', (authority) => { authority.operation = 'AGENT_CLOSURE'; }, 'PURPOSE_OR_OPERATION_INVALID'],
  ['H16 EXTERNAL_CONFIRMATION claimed as the bootstrap operation', (authority) => { authority.operation = 'EXTERNAL_CONFIRMATION'; }, 'PURPOSE_OR_OPERATION_INVALID'],
  ['H21 prohibition list weakened', (authority) => { authority.prohibitedOperations = authority.prohibitedOperations.filter((item) => item !== 'START'); }, 'PROHIBITED_SCOPE_INCOMPLETE'],
  ['H22 maxUse raised', (authority) => { authority.maxUse = 2; }, 'MAX_USE_INVALID'],
  ['H23 signature material smuggled into local mode', (authority) => { authority.ownerKeyId = 'FORGED'; authority.signature = 'forged'; }, 'SIGNATURE_MATERIAL_NOT_PERMITTED'],
  ['H24 status claimed as already started', (authority) => { authority.preState.currentStatus = 'IN_PROGRESS'; }, 'CURRENT_STATUS_INVALID'],
  ['H25 pre-state claims a contract already exists', (authority) => { authority.preState.currentContractPresent = true; }, 'PRE_STATE_CONTRACT_EXPECTATION_INVALID']
];

for (const [name, mutate, expectedCode] of bindingAttacks) {
  test(`${name} is BLOCKED`, () => {
    const mutated = structuredClone(validAuthority);
    mutate(mutated);
    const result = decide(fixture.root, reseal(mutated), { authorityRelative: `${AUTHORITY_RELATIVE}.attack.json` });
    assert.equal(result.decision, 'BLOCKED', name);
    assert.ok(result.findings.some((finding) => finding.code === expectedCode), `${name}: ${JSON.stringify(result.findings)}`);
  });
}

test('H09 wrong artifact binding is BLOCKED at consumption, never silently accepted', () => {
  const mutated = reseal({
    ...structuredClone(validAuthority),
    artifactBindings: validAuthority.artifactBindings.map((binding, index) => index === 0 ? { ...binding, sha256: '9'.repeat(64) } : binding)
  });
  // The pre-write decision is about the pre-state, so a wrong OUTPUT hash is
  // legitimately authorized here; what must be impossible is applying it.
  const applied = applyPrecontractBootstrap({
    root: fixture.root, stagedRoot: staged, apply: true, now: new Date(ISSUED_AT),
    authorityPath: (() => { writeJson(fixture.root, `${AUTHORITY_RELATIVE}.badbinding.json`, mutated); return path.join(fixture.root, ...`${AUTHORITY_RELATIVE}.badbinding.json`.split('/')); })()
  });
  assert.equal(applied.verdict, 'BLOCKED');
  assert.ok(applied.findings.some((finding) => finding.code === 'STAGED_ARTIFACT_BYTES_MISMATCH'), JSON.stringify(applied.findings));
  assert.equal(fs.existsSync(path.join(fixture.root, ...POINTER_RELATIVE.split('/'))), false);
});

test('H11 two competing authorities are BLOCKED', () => {
  const authorityPath = path.join(fixture.root, ...AUTHORITY_RELATIVE.split('/'));
  writeJson(fixture.root, AUTHORITY_RELATIVE, validAuthority);
  const source = createWheelPrecontractAuthoritySource(fixture.root, {
    authorityPaths: [authorityPath, authorityPath], now: new Date(ISSUED_AT)
  });
  const result = source.resolvePrecontractAuthority(GATE);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'PRECONTRACT_AUTHORITY_CONFLICT'));
});

test("H12 another Gate's authority cannot bootstrap this Gate", () => {
  const foreign = reseal({ ...structuredClone(validAuthority), gateId: 'GATE20' });
  writeJson(fixture.root, `${AUTHORITY_RELATIVE}.foreign.json`, foreign);
  const source = createWheelPrecontractAuthoritySource(fixture.root, {
    authorityPath: path.join(fixture.root, ...`${AUTHORITY_RELATIVE}.foreign.json`.split('/')), now: new Date(ISSUED_AT)
  });
  const result = source.resolvePrecontractAuthority(GATE);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'GATE_ID_MISMATCH'));
});

test('H26 an external request presented beside a local authority is refused', () => {
  const requestPath = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'precontract-req-')), 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ documentKind: 'PRECONTRACT_AUTHORITY_REQUEST' }));
  const result = decide(fixture.root, validAuthority, { authorityRelative: `${AUTHORITY_RELATIVE}.pair.json`, requestPath });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'LOCAL_AUTHORITY_REQUEST_NOT_PERMITTED'));
});

test('H27 a local authority read from outside the governed tree is refused', () => {
  const outside = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'precontract-out-')), 'authority.json');
  fs.writeFileSync(outside, `${JSON.stringify(validAuthority, null, 2)}\n`);
  const source = createWheelPrecontractAuthoritySource(fixture.root, { authorityPath: outside, now: new Date(ISSUED_AT) });
  const result = source.resolvePrecontractAuthority(GATE);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'LOCAL_AUTHORITY_MUST_BE_GOVERNED'));
});

test('H28 a tampered self-digest is BLOCKED', () => {
  const tampered = structuredClone(validAuthority);
  tampered.expiresAtUtc = '2027-12-31T23:59:59.000Z';
  const result = decide(fixture.root, tampered, { authorityRelative: `${AUTHORITY_RELATIVE}.digest.json` });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'LOCAL_REQUEST_DIGEST_SELF_INCONSISTENT'));
});

test('H29 an expired authority is BLOCKED', () => {
  const expired = reseal({ ...structuredClone(validAuthority), expiresAtUtc: '2026-08-15T13:00:00.000Z' });
  const result = decide(fixture.root, expired, { authorityRelative: `${AUTHORITY_RELATIVE}.expired.json` });
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'AUTHORITY_EXPIRED'));
});

test('H30 the bootstrap operation cannot be spent on another operation class', () => {
  for (const operation of ['START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION']) {
    const result = evaluatePrecontractAuthority({
      authority: validAuthority, request: null, operation, now: new Date(ISSUED_AT),
      observed: {
        projectId: 'WHEEL', gateId: GATE, headCommit: fixture.head, headTree: fixture.tree,
        ledgerSha256: validAuthority.preState.ledgerSha256, ledgerEventCount: validAuthority.preState.ledgerEventCount,
        currentStatus: 'NOT_STARTED', currentContractPresent: false, consumed: false,
        consumptionRecordPresent: false, dependencyProof: validAuthority.dependencyProof
      }
    });
    assert.equal(result.decision, 'BLOCKED', operation);
    assert.ok(result.findings.some((finding) => finding.code === 'OPERATION_NOT_AUTHORIZED'), operation);
  }
});

test('H20 historical Ed25519 fixtures keep their exact legacy behaviour', () => {
  // A legacy document carries no authorityMode and is still routed to the signed
  // branch, where an absent or unverifiable signature is refused under the same
  // historical finding code. Absence never upgrades anything.
  const unsignedLegacy = { schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY', authorityId: 'X', issuedBy: 'PROJECT_OWNER' };
  const result = evaluatePrecontractAuthority({ authority: unsignedLegacy, request: null, now: new Date(ISSUED_AT) });
  assert.equal(result.authorityMode, 'LEGACY_SIGNED_AUTHORITY');
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'OWNER_SIGNATURE_INVALID'));
  // And an explicitly-named legacy mode behaves identically to the unnamed one.
  const named = { ...unsignedLegacy, authorityMode: 'LEGACY_SIGNED_AUTHORITY' };
  const namedResult = evaluatePrecontractAuthority({ authority: named, request: null, now: new Date(ISSUED_AT) });
  assert.equal(namedResult.authorityMode, 'LEGACY_SIGNED_AUTHORITY');
  assert.equal(namedResult.decision, 'BLOCKED');
});

// --------------------------------------------------------------------------
// PHASE 3 — the chain itself, in order, against the real tools.
// --------------------------------------------------------------------------

test('the full lawful chain: NOT_STARTED -> bootstrap -> AUTHORIZATION -> START', () => {
  for (const stale of fs.readdirSync(path.dirname(path.join(fixture.root, ...AUTHORITY_RELATIVE.split('/'))))) {
    if (stale !== path.basename(AUTHORITY_RELATIVE)) fs.rmSync(path.join(path.dirname(path.join(fixture.root, ...AUTHORITY_RELATIVE.split('/'))), stale), { force: true });
  }

  // 1/2. the owner decision, materialized and bound to the exact live pre-state
  writeJson(fixture.root, AUTHORITY_RELATIVE, validAuthority);
  const authorityPath = path.join(fixture.root, ...AUTHORITY_RELATIVE.split('/'));
  assert.equal(validAuthority.authorityMode, PRECONTRACT_LOCAL_AUTHORITY_MODE);
  assert.equal(validAuthority.preState.baseCommit, fixture.head);
  assert.equal(validAuthority.preState.baseTree, fixture.tree);
  assert.equal(validAuthority.dependencyProof.status, 'SUPERSEDED');
  const source = createWheelPrecontractAuthoritySource(fixture.root, { authorityPath, now: new Date(ISSUED_AT) });
  const authorized = source.resolvePrecontractAuthority(GATE);
  assert.equal(authorized.decision, 'AUTHORIZED', JSON.stringify(authorized.findings));
  assert.equal(authorized.bootstrapAuthorized, true);
  assert.equal(authorized.executionAuthorized, false);

  // 3/4. R0001 and CURRENT_CONTRACT created under that authority
  const applied = applyPrecontractBootstrap({
    root: fixture.root, authorityPath, stagedRoot: staged, apply: true,
    recordedAt: '2026-08-15T13:11:00.000Z', now: new Date(ISSUED_AT)
  });
  assert.equal(applied.verdict, 'APPLIED', JSON.stringify(applied.findings));
  assert.ok(fs.existsSync(path.join(fixture.root, ...CONTRACT_RELATIVE.split('/'))));
  assert.ok(fs.existsSync(path.join(fixture.root, ...POINTER_RELATIVE.split('/'))));

  const contractCheck = spawnSync(process.execPath, [
    path.join(fixture.root, 'governance/tools/validate-gate-contract.mjs'), '--root', fixture.root,
    '--contract', CONTRACT_RELATIVE, '--pointer', POINTER_RELATIVE
  ], { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(contractCheck.status, 0, contractCheck.stdout + contractCheck.stderr);

  // 5. the authority is spent: receipt written, consumption proven, replay refused
  assert.ok(fs.existsSync(path.join(fixture.root, ...CONSUMPTION_RELATIVE.split('/'))));
  assert.equal(applied.consumption.verified, true);
  assert.equal(applied.replay.blocked, true);
  const replay = createWheelPrecontractAuthoritySource(fixture.root, { authorityPath, now: new Date(ISSUED_AT) }).resolvePrecontractAuthority(GATE);
  assert.equal(replay.decision, 'BLOCKED');
  assert.ok(replay.findings.some((finding) => finding.code === 'AUTHORITY_ALREADY_CONSUMED' || finding.code === 'CURRENT_CONTRACT_PRESENT'));

  // 6. normal AUTHORIZATION, with its own authority and its own record
  // The milestone must be one the transposed contract's checkpointPolicy admits;
  // the builder and the apply are given the same one, or they would derive two
  // different candidates.
  const checkpoint = { milestone: `${GATE}_REPORT_GENERATED` };
  const authorizationBuild = buildGateAuthorizationDocuments({
    root: fixture.root, gateId: GATE, eventId: `${GATE}_AUTHORIZATION_R1`,
    recordedAt: '2026-08-15T13:12:00.000Z', expiresAtUtc: EXPIRES_AT, checkpoint,
    reason: 'Local explicit AUTHORIZATION for the bootstrap chain acceptance test.'
  });
  assert.equal(authorizationBuild.verdict, 'BUILT', JSON.stringify(authorizationBuild.findings));
  const authorizationRecord = readJson(fixture.root, authorizationBuild.recordPath);
  assert.equal(authorizationRecord.authorityMode, PRECONTRACT_LOCAL_AUTHORITY_MODE);
  assert.equal(authorizationRecord.dependencyProof.status, 'SUPERSEDED');

  const authorizationApply = runLifecycleTransition({
    root: fixture.root, gateId: GATE, transitionType: 'AUTHORIZATION',
    eventId: `${GATE}_AUTHORIZATION_R1`, authorityPath: authorizationBuild.recordPath,
    recordedAt: '2026-08-15T13:12:00.000Z', checkpoint
  });
  assert.equal(authorizationApply.result, 'APPLIED', JSON.stringify(authorizationApply.findings));

  // 7/8/9. normal START, accepted by the ledger, and the Gate leaves NOT_STARTED
  const startBuild = buildGateStartDocuments({
    root: fixture.root, gateId: GATE, eventId: `${GATE}_START_R1`,
    recordedAt: '2026-08-15T13:13:00.000Z', expiresAtUtc: EXPIRES_AT
  });
  assert.equal(startBuild.verdict, 'BUILT', JSON.stringify(startBuild.findings));
  const startApply = runLifecycleTransition({
    root: fixture.root, gateId: GATE, transitionType: 'START',
    eventId: `${GATE}_START_R1`, authorityPath: startBuild.recordPath,
    recordedAt: '2026-08-15T13:13:00.000Z', checkpoint
  });
  assert.equal(startApply.result, 'APPLIED', JSON.stringify(startApply.findings));

  const events = fs.readFileSync(path.join(fixture.root, ...LEDGER.split('/')), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).filter((event) => event.gateId === GATE);
  assert.deepEqual(events.map((event) => event.transitionType), ['GENESIS_IMPORT', 'AUTHORIZATION', 'START']);
  assert.equal(events.at(-1).toStatus, 'IN_PROGRESS');

  // 10. and the generic fast path can take over from here
  const readiness = spawnSync(process.execPath, [
    path.join(fixture.root, 'governance/tools/gate-preexecution-reuse-check.mjs'), '--root', fixture.root, '--gate', GATE
  ], { cwd: fixture.root, encoding: 'utf8' });
  const report = JSON.parse(readiness.stdout);
  const dependencyCheck = report.checks.find((entry) => entry.id === 'DEPENDENCIES_SATISFIABLE');
  assert.equal(dependencyCheck?.status, 'PASS', JSON.stringify(dependencyCheck ?? report.checks.map((entry) => entry.id)));
});

test('H13 a second bootstrap of the same Gate is BLOCKED once the contract exists', () => {
  const authorityPath = path.join(fixture.root, ...AUTHORITY_RELATIVE.split('/'));
  const again = createWheelPrecontractAuthoritySource(fixture.root, { authorityPath, now: new Date(ISSUED_AT) }).resolvePrecontractAuthority(GATE);
  assert.equal(again.decision, 'BLOCKED');
  assert.ok(again.findings.some((finding) => finding.code === 'CURRENT_CONTRACT_PRESENT'));
  const reissue = issuePrecontractAuthority({
    root: fixture.root, gateId: GATE, authorityId: 'REISSUE', stagedRoot: staged, stagedPaths,
    issuedAtUtc: ISSUED_AT, expiresAtUtc: EXPIRES_AT
  });
  assert.equal(reissue.verdict, 'BLOCKED');
  assert.ok(reissue.findings.some((finding) => finding.code === 'CURRENT_CONTRACT_PRESENT' || finding.code === 'GATE_NOT_NOT_STARTED'));
});

test.after(() => {
  fs.rmSync(fixture.root, { recursive: true, force: true });
  fs.rmSync(staged, { recursive: true, force: true });
});
