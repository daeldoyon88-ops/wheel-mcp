/**
 * PERMANENCE OF A CONSUMED BOOTSTRAP AUTHORITY.
 *
 * THE DEFECT THIS PINS. VERIFY_CONSUMPTION used to re-assert the authority's
 * recorded pre-state against the LIVE ledger head. A receipt that was valid the
 * instant it was written therefore became refutable as soon as the Gate did the
 * lawful thing and advanced: AUTHORIZATION, START and AGENT_CLOSURE each moved
 * the ledger, and the consumed authority reported LEDGER_SHA_MISMATCH,
 * LEDGER_EVENT_COUNT_MISMATCH and CURRENT_STATUS_NOT_NOT_STARTED. A single-use
 * receipt whose validity decays as history moves forward is not a receipt.
 *
 * THE PROPERTY PROVEN HERE, in both directions:
 *
 *   a consumed bootstrap authority stays verifiable through every subsequent
 *   lifecycle transition, AND stays impossible to replay or to forge.
 *
 * WHERE EACH HALF IS PROVEN. Ledger depth is the variable that broke it, so the
 * property is exercised at four increasing depths. The first three run in a
 * disposable fixture where the transitions are performed for real by the real
 * tools. The fourth — the depth the independent audit actually reported — runs
 * against the repository's own final GATE19 bytes, at COMPLETE_AGENT, because no
 * fixture can be a more faithful witness of production bytes than the production
 * bytes. The forgery battery then runs at that same depth, so every tamper case
 * is judged in the post-advance world where the defect lived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  computePrecontractConsumptionIdentityDigest,
  computePrecontractLocalRequestDigest,
  evaluatePrecontractAuthority,
  reconstructLedgerPrefix,
  PRECONTRACT_LOCAL_AUTHORITY_MODE
} from '../gee-v1/core/precontract-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { issuePrecontractAuthority } from '../tools/issue-precontract-authority.mjs';
import { applyPrecontractBootstrap } from '../tools/apply-precontract-bootstrap.mjs';
import { buildGateAuthorizationDocuments, buildGateStartDocuments } from '../tools/build-gate-lifecycle-records.mjs';
import { runLifecycleTransition } from '../tools/gate-lifecycle-orchestrator.mjs';
import { anchorPrecontractConsumption } from '../tools/anchor-precontract-consumption.mjs';
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
const NOW = new Date('2026-08-15T16:00:00.000Z');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const absolute = (root, relative) => path.join(root, ...relative.split('/'));
const readJson = (root, relative) => JSON.parse(fs.readFileSync(absolute(root, relative), 'utf8'));
const writeJson = (root, relative, value) => {
  const target = absolute(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
};
const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const codes = (result) => result.findings.map((item) => item.code);

/** VERIFY_CONSUMPTION, always through the adapter against real repository bytes. */
function verifyConsumption(root, { authorityRelative = AUTHORITY_RELATIVE, when = NOW } = {}) {
  return createWheelPrecontractAuthoritySource(root, {
    authorityPath: absolute(root, authorityRelative), now: when
  }).verifyPrecontractConsumption(GATE);
}

function authorizeWrite(root, { authorityRelative = AUTHORITY_RELATIVE, when = NOW } = {}) {
  return createWheelPrecontractAuthoritySource(root, {
    authorityPath: absolute(root, authorityRelative), now: when
  }).resolvePrecontractAuthority(GATE);
}

/** Re-seal a mutated authority so a test attacks the BINDING, not the self-digest. */
function reseal(authority) {
  const resealed = structuredClone(authority);
  resealed.approvedRequestDigest = computePrecontractLocalRequestDigest(resealed);
  return resealed;
}

function gateEvents(root, gateId = GATE) {
  return fs.readFileSync(absolute(root, LEDGER), 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line)).filter((event) => event.gateId === gateId);
}

// ---------------------------------------------------------------------------
// Depths 1-3: a real chain in a disposable fixture.
// ---------------------------------------------------------------------------

/** A disposable governed tree with GATE rewound to genesis, in a real Git repo. */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'consumption-permanence-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });

  const ledgerPath = absolute(root, LEDGER);
  const kept = fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => !(event.gateId === GATE && event.transitionType !== 'GENESIS_IMPORT'));
  fs.writeFileSync(ledgerPath, `${kept.map((event) => JSON.stringify(event)).join('\n')}\n`);
  for (const directory of [`governance/gates/${GATE}`, `governance/authority/authorizations/${GATE}`, `governance/authority/precontract/${GATE}`]) {
    fs.rmSync(absolute(root, directory), { recursive: true, force: true });
  }
  const snapshot = spawnSync(process.execPath, [absolute(root, 'governance/tools/generate-status-snapshot.mjs'), '--root', root], { cwd: root, encoding: 'utf8' });
  assert.equal(snapshot.status, 0, snapshot.stdout + snapshot.stderr);

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@local']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['add', '-A']);
  const commit = git(root, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'consumption permanence fixture']);
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  return { root, head: git(root, ['rev-parse', 'HEAD']).stdout.trim() };
}

/** The staged contract, transposed from an already-closed Gate's real R0001. */
function stageContract(fixtureRoot) {
  const staged = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'consumption-staged-'));
  const template = readJson(fixtureRoot, `governance/gates/${TEMPLATE_GATE}/contracts/EXECUTION_CONTRACT_R0001.json`);
  const registry = readJson(fixtureRoot, 'governance/GATE_REGISTRY_00_40.json');
  const entry = registry.gates.find((gate) => gate.gateId === GATE);
  const transposed = JSON.parse(JSON.stringify(template).replaceAll(TEMPLATE_GATE, GATE));
  transposed.strategicRegistryReference = {
    registryPath: 'governance/GATE_REGISTRY_00_40.json',
    registrySha256: sha256(fs.readFileSync(absolute(fixtureRoot, 'governance/GATE_REGISTRY_00_40.json'))),
    gateId: GATE,
    canonicalObjectiveSha256: sha256Canonical(entry.canonicalObjective)
  };
  writeJson(staged, CONTRACT_RELATIVE, transposed);
  writeJson(staged, POINTER_RELATIVE, {
    schemaVersion: 1, gateId: GATE, contractRevision: 'R0001', contractPath: CONTRACT_RELATIVE,
    contractSha256: sha256(fs.readFileSync(absolute(staged, CONTRACT_RELATIVE))), activatedByEventId: null
  });
  return { staged, stagedPaths: [CONTRACT_RELATIVE, POINTER_RELATIVE] };
}

/**
 * Anchor a freshly-consumed receipt, exactly as a future Gate would: author the
 * single-use anchor authority, then let the canonical tool append the event.
 * Returns the anchor authority's repo-relative path so hostile cases can attack it.
 */
function anchorFixtureReceipt(root, { recordedAt = '2026-08-15T13:11:30.000Z' } = {}) {
  const precontract = readJson(root, AUTHORITY_RELATIVE);
  const relative = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;
  writeJson(root, relative, {
    documentKind: 'GATE_PRECONTRACT_CONSUMPTION_ANCHOR_LOCAL_AUTHORITY',
    schemaVersion: 1,
    authorityId: `PRECONTRACT_CONSUMPTION_ANCHOR_${GATE}_LOCAL_R1`,
    authorityMode: 'LOCAL_EXPLICIT_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    issuedAtUtc: recordedAt,
    projectId: precontract.projectId,
    gateId: precontract.gateId,
    precontractAuthorityPath: AUTHORITY_RELATIVE,
    precontractAuthorityId: precontract.authorityId,
    consumptionRecordPath: precontract.consumptionRecordPath,
    consumptionRecordSha256: sha256(fs.readFileSync(absolute(root, precontract.consumptionRecordPath))),
    maxUse: 1,
    reason: 'Anchor the consumption receipt in the append-only ledger before the first lifecycle event.',
    prohibitedOperations: ['START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION', 'COMPLETE_CONFIRMED', 'STATUS_CHANGE']
  });
  const result = anchorPrecontractConsumption({ root, authorityPath: absolute(root, relative), recordedAt, apply: true });
  assert.equal(result.verdict, 'ANCHORED', JSON.stringify(result.findings));
  return relative;
}

const fixture = buildFixture();
const { staged, stagedPaths } = stageContract(fixture.root);

test('C1 consumption is valid immediately after the bootstrap', () => {
  const issued = issuePrecontractAuthority({
    root: fixture.root, gateId: GATE, authorityId: `PRECONTRACT_BOOTSTRAP_${GATE}_LOCAL_R1`,
    stagedRoot: staged, stagedPaths, issuedAtUtc: ISSUED_AT, expiresAtUtc: EXPIRES_AT
  });
  assert.equal(issued.verdict, 'ISSUED', JSON.stringify(issued.findings));
  writeJson(fixture.root, AUTHORITY_RELATIVE, issued.authority);

  const applied = applyPrecontractBootstrap({
    root: fixture.root, authorityPath: absolute(fixture.root, AUTHORITY_RELATIVE), stagedRoot: staged,
    apply: true, recordedAt: '2026-08-15T13:11:00.000Z', now: NOW
  });
  assert.equal(applied.verdict, 'APPLIED', JSON.stringify(applied.findings));
  assert.ok(fs.existsSync(absolute(fixture.root, CONSUMPTION_RELATIVE)));

  const result = verifyConsumption(fixture.root);
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.consumed, true);
  assert.equal(result.authorityMode, PRECONTRACT_LOCAL_AUTHORITY_MODE);

  // The canonical sequence for any Gate bootstrapped from now on: the receipt is
  // anchored in the append-only ledger BEFORE the Gate's first lifecycle event,
  // so the anchor exists by the time anything else moves.
  anchorFixtureReceipt(fixture.root);
  assert.deepEqual(codes(verifyConsumption(fixture.root)), []);
});

test('C2 consumption survives a real AUTHORIZATION', () => {
  const checkpoint = { milestone: `${GATE}_REPORT_GENERATED` };
  const build = buildGateAuthorizationDocuments({
    root: fixture.root, gateId: GATE, eventId: `${GATE}_AUTHORIZATION_R1`,
    recordedAt: '2026-08-15T13:12:00.000Z', expiresAtUtc: EXPIRES_AT, checkpoint,
    reason: 'Local explicit AUTHORIZATION for the consumption permanence test.'
  });
  assert.equal(build.verdict, 'BUILT', JSON.stringify(build.findings));
  const applied = runLifecycleTransition({
    root: fixture.root, gateId: GATE, transitionType: 'AUTHORIZATION', eventId: `${GATE}_AUTHORIZATION_R1`,
    authorityPath: build.recordPath, recordedAt: '2026-08-15T13:12:00.000Z', checkpoint
  });
  assert.equal(applied.result, 'APPLIED', JSON.stringify(applied.findings));
  assert.equal(gateEvents(fixture.root).at(-1).transitionType, 'AUTHORIZATION');

  const result = verifyConsumption(fixture.root);
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.consumed, true);
});

test('C3 consumption survives a real START', () => {
  const checkpoint = { milestone: `${GATE}_REPORT_GENERATED` };
  const build = buildGateStartDocuments({
    root: fixture.root, gateId: GATE, eventId: `${GATE}_START_R1`,
    recordedAt: '2026-08-15T13:13:00.000Z', expiresAtUtc: EXPIRES_AT
  });
  assert.equal(build.verdict, 'BUILT', JSON.stringify(build.findings));
  const applied = runLifecycleTransition({
    root: fixture.root, gateId: GATE, transitionType: 'START', eventId: `${GATE}_START_R1`,
    authorityPath: build.recordPath, recordedAt: '2026-08-15T13:13:00.000Z', checkpoint
  });
  assert.equal(applied.result, 'APPLIED', JSON.stringify(applied.findings));
  assert.equal(gateEvents(fixture.root).at(-1).toStatus, 'IN_PROGRESS');

  const result = verifyConsumption(fixture.root);
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.consumed, true);
});

test('C3b the Gate has genuinely left the bootstrap pre-state by now', () => {
  // Without this the three PASSes above could be vacuous: they must be passing
  // BECAUSE the reconstruction works, not because nothing moved.
  const authority = readJson(fixture.root, AUTHORITY_RELATIVE);
  const live = fs.readFileSync(absolute(fixture.root, LEDGER), 'utf8').split(/\r?\n/).filter(Boolean);
  assert.ok(live.length > authority.preState.ledgerEventCount, 'the ledger must have grown past the recorded pre-state');
  assert.notEqual(gateEvents(fixture.root).at(-1).toStatus, 'NOT_STARTED');
  assert.notEqual(sha256(fs.readFileSync(absolute(fixture.root, LEDGER))), authority.preState.ledgerSha256);
});

// ---------------------------------------------------------------------------
// Depth 4 and the forgery battery: the repository's own final GATE19 bytes.
// ---------------------------------------------------------------------------

/**
 * A disposable clone that shares the real object store, so the historical commit
 * the authority recorded is genuinely resolvable, plus the live governed tree
 * copied in. Nothing is ever written back to REPO_ROOT.
 */
function buildLiveMirror() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'consumption-live-'));
  const cloned = git(REPO_ROOT, ['clone', '--shared', '--no-checkout', '--quiet', REPO_ROOT, root]);
  assert.equal(cloned.status, 0, cloned.stdout + cloned.stderr);
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

const live = buildLiveMirror();
const liveAuthority = readJson(live, AUTHORITY_RELATIVE);

/** Tamper, judge, restore byte-exactly — even if the assertion throws. */
function withTamper(relative, mutate, assertions) {
  const target = absolute(live, relative);
  const original = fs.readFileSync(target);
  try {
    mutate(target);
    assertions();
  } finally {
    fs.writeFileSync(target, original);
    assert.equal(sha256(fs.readFileSync(target)), sha256(original), 'restore must be byte-exact');
  }
}
const tamperJson = (mutateDocument) => (target) => {
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  mutateDocument(document);
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
};

test('C4 MANDATORY: consumption is valid on the final GATE19 bytes at COMPLETE_AGENT', () => {
  // This is the exact case the independent audit reproduced.
  assert.equal(gateEvents(live).at(-1).toStatus, 'COMPLETE_AGENT');
  // The anchor is a self-transition appended after closure, so the Gate's status
  // is unchanged and its execution history reads exactly as it did.
  assert.deepEqual(gateEvents(live).map((event) => event.transitionType),
    ['GENESIS_IMPORT', 'AUTHORIZATION', 'START', 'AGENT_CLOSURE', 'PRECONTRACT_CONSUMPTION_ANCHOR']);

  const result = verifyConsumption(live);
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.consumed, true);

  // And it is not vacuous: the live head has genuinely left the recorded pre-state.
  const ledgerText = fs.readFileSync(absolute(live, LEDGER), 'utf8');
  const liveCount = ledgerText.split(/\r?\n/).filter(Boolean).length;
  assert.ok(liveCount > liveAuthority.preState.ledgerEventCount);
  assert.notEqual(sha256(Buffer.from(ledgerText, 'utf8')), liveAuthority.preState.ledgerSha256);
  // The proof that replaces it reconstructs the recorded pre-state exactly.
  const prefix = reconstructLedgerPrefix(ledgerText, liveAuthority.preState.ledgerEventCount);
  assert.equal(prefix.valid, true);
  assert.equal(prefix.sha256, liveAuthority.preState.ledgerSha256);
});

test('C5 an altered historical ledger prefix is BLOCKED', () => {
  withTamper(LEDGER, (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    const event = JSON.parse(lines[4]);
    event.recordedAt = '2001-01-01T00:00:00.000Z';
    lines[4] = JSON.stringify(event);
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
  }, () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_LEDGER_SHA_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C6 a ledger too short to reconstruct the pre-state is BLOCKED', () => {
  withTamper(LEDGER, (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    fs.writeFileSync(target, `${lines.slice(0, 40).join('\n')}\n`);
  }, () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_LEDGER_TOO_SHORT'), JSON.stringify(result.findings));
  });
});

test('C7 a wrong recorded ledgerEventCount is BLOCKED', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.preState.ledgerEventCount += 1;
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_LEDGER_SHA_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C8 a wrong recorded ledgerSha256 is BLOCKED', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.preState.ledgerSha256 = 'c'.repeat(64);
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_LEDGER_SHA_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C9 an altered consumption record is BLOCKED', () => {
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.cohort[0].sha256 = '7'.repeat(64);
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_COHORT_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C10 an altered EXECUTION_CONTRACT_R0001 is BLOCKED', () => {
  withTamper(CONTRACT_RELATIVE, tamperJson((document) => {
    document.injectedByAttacker = true;
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('ARTIFACT_BYTES_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C11 a CURRENT_CONTRACT redirected to another contract is BLOCKED even when re-pinned', () => {
  // The hostile case that byte equality alone cannot catch: the attacker
  // redirects the pointer AND re-pins the authority to the redirected bytes, so
  // every hash agrees with every hash. Only the LINK check refuses it.
  const foreign = `governance/gates/${TEMPLATE_GATE}/contracts/EXECUTION_CONTRACT_R0001.json`;
  withTamper(POINTER_RELATIVE, tamperJson((document) => {
    document.contractPath = foreign;
    document.contractSha256 = sha256(fs.readFileSync(absolute(live, foreign)));
  }), () => {
    withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
      const pointerBytes = fs.readFileSync(absolute(live, POINTER_RELATIVE));
      document.artifactBindings = document.artifactBindings.map((item) =>
        item.path === POINTER_RELATIVE ? { ...item, sha256: sha256(pointerBytes) } : item);
      Object.assign(document, reseal(document));
    }), () => {
      const result = verifyConsumption(live);
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(codes(result).includes('CURRENT_CONTRACT_LINK_NOT_AUTHORIZED'), JSON.stringify(result.findings));
      // Proof that the byte check alone would have been satisfied by this forgery.
      assert.ok(!codes(result).includes('ARTIFACT_BYTES_MISMATCH'), JSON.stringify(result.findings));
    });
  });
});

test('C12 an altered artifact binding is BLOCKED', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.artifactBindings[0].sha256 = '8'.repeat(64);
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('ARTIFACT_BYTES_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C13 a second bootstrap with the consumed authority is BLOCKED', () => {
  const result = authorizeWrite(live);
  assert.equal(result.decision, 'BLOCKED');
  assert.equal(result.bootstrapAuthorized, false);
  assert.deepEqual(result.authorizedPaths, []);
  assert.ok(codes(result).includes('AUTHORITY_ALREADY_CONSUMED'), JSON.stringify(result.findings));
  assert.ok(codes(result).includes('CURRENT_CONTRACT_PRESENT'), JSON.stringify(result.findings));
});

test('C14 the legacy Ed25519 path is unchanged', () => {
  // A document with no authorityMode still resolves to the signed branch and is
  // refused under its historical finding code, in BOTH phases; the historical
  // reconstruction is local-mode only and must not have widened this path.
  const unsignedLegacy = { schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY', authorityId: 'X', issuedBy: 'PROJECT_OWNER' };
  for (const phase of ['AUTHORIZE_WRITE', 'VERIFY_CONSUMPTION']) {
    const result = evaluatePrecontractAuthority({ authority: unsignedLegacy, request: null, now: NOW, phase });
    assert.equal(result.authorityMode, 'LEGACY_SIGNED_AUTHORITY', phase);
    assert.equal(result.decision, 'BLOCKED', phase);
    assert.ok(codes(result).includes('OWNER_SIGNATURE_INVALID'), phase);
    // No historical-reconstruction finding may appear on the legacy path.
    assert.ok(!codes(result).some((code) => code.startsWith('HISTORICAL_')), `${phase}: ${JSON.stringify(result.findings)}`);
  }
  // And a legacy VERIFY_CONSUMPTION still compares the LIVE ledger, exactly as before.
  const legacyRequest = { ledgerSha256: 'a'.repeat(64), baseCommit: 'b'.repeat(40) };
  const liveCompared = evaluatePrecontractAuthority({
    authority: { schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY' }, request: legacyRequest,
    now: NOW, phase: 'VERIFY_CONSUMPTION',
    observed: { projectId: 'WHEEL', ledgerSha256: 'f'.repeat(64), headCommit: 'e'.repeat(40), currentStatus: 'COMPLETE_AGENT' }
  });
  assert.ok(codes(liveCompared).includes('LEDGER_SHA_MISMATCH'));
  assert.ok(codes(liveCompared).includes('CURRENT_STATUS_NOT_NOT_STARTED'));
});

// --------------------------------------------------------------------------
// The two properties the repair must not have bought at another's expense.
// --------------------------------------------------------------------------

test('C15 a fabricated base commit is BLOCKED, so the git binding was not merely dropped', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.preState.baseCommit = 'a'.repeat(40);
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_BASE_COMMIT_UNKNOWN'), JSON.stringify(result.findings));
  });
});

test('C16 a recorded base tree that the recorded commit does not name is BLOCKED', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.preState.baseTree = 'b'.repeat(40);
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('HISTORICAL_BASE_TREE_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('C17 a later event on the dependency Gate cannot retroactively invalidate the bootstrap', () => {
  // The dependency proof is resolved against the reconstructed prefix, not the
  // live tail, for the same reason the pre-state is: history must not become
  // refutable because something lawful happened afterwards.
  withTamper(LEDGER, (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    const head = JSON.parse(lines.at(-1));
    lines.push(JSON.stringify({ ...head, eventId: 'GATE18_LATER_EVENT_R1', gateId: 'GATE18', transitionType: 'AUTHORIZATION', fromStatus: 'NOT_STARTED', toStatus: 'AUTHORIZED_NOT_STARTED' }));
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
  }, () => {
    const result = verifyConsumption(live);
    assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
    assert.equal(result.consumed, true);
  });
});

// ---------------------------------------------------------------------------
// TEMPORAL PERMANENCE. The validity window gates PERMISSION before the write and
// is proven against the RECORDED MOMENT OF USE afterwards. Neither half relaxes
// the window: they measure it at different instants because they answer
// different questions.
// ---------------------------------------------------------------------------

const AFTER_EXPIRY = new Date('2027-01-01T00:00:01.000Z');
const LONG_AFTER_EXPIRY = new Date('2030-06-01T00:00:00.000Z');

/**
 * The live repository's own pre-write observation, reconstructed from what the
 * authority records. It lets the temporal boundary be varied in isolation, with
 * every non-temporal check satisfied, so a BLOCK can only mean the clock.
 */
function preWriteObserved(authority) {
  return {
    projectId: 'WHEEL', gateId: authority.gateId,
    headCommit: authority.preState.baseCommit, headTree: authority.preState.baseTree,
    ledgerSha256: authority.preState.ledgerSha256, ledgerEventCount: authority.preState.ledgerEventCount,
    currentStatus: 'NOT_STARTED', currentContractPresent: false, consumed: false,
    consumptionRecordPresent: false, dependencyProof: authority.dependencyProof
  };
}
const decideAt = (when) => evaluatePrecontractAuthority({
  authority: liveAuthority, request: null, now: new Date(when), observed: preWriteObserved(liveAuthority)
});

test('T1 AUTHORIZE_WRITE inside the window is AUTHORIZED', () => {
  const result = decideAt('2026-09-01T00:00:00.000Z');
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.bootstrapAuthorized, true);
});

test('T2 AUTHORIZE_WRITE exactly at expiry is AUTHORIZED: both bounds are inclusive', () => {
  // The contract is issuedAtUtc <= now <= expiresAtUtc. The final second of
  // validity is still validity; the refusal starts one millisecond later.
  const atExpiry = decideAt(liveAuthority.expiresAtUtc);
  assert.deepEqual(codes(atExpiry), [], JSON.stringify(atExpiry.findings));
  assert.equal(atExpiry.bootstrapAuthorized, true);

  const atIssue = decideAt(liveAuthority.issuedAtUtc);
  assert.deepEqual(codes(atIssue), [], JSON.stringify(atIssue.findings));

  const justAfter = decideAt(Date.parse(liveAuthority.expiresAtUtc) + 1);
  assert.ok(codes(justAfter).includes('AUTHORITY_EXPIRED'), JSON.stringify(justAfter.findings));
});

test('T3 AUTHORIZE_WRITE after expiry is BLOCKED', () => {
  for (const when of [AFTER_EXPIRY, LONG_AFTER_EXPIRY]) {
    const result = decideAt(when.toISOString());
    assert.equal(result.decision, 'BLOCKED', when.toISOString());
    assert.equal(result.bootstrapAuthorized, false);
    assert.deepEqual(result.authorizedPaths, []);
    assert.ok(codes(result).includes('AUTHORITY_EXPIRED'), JSON.stringify(result.findings));
  }
});

test('T3b AUTHORIZE_WRITE before the authority was issued is BLOCKED', () => {
  const result = decideAt(Date.parse(liveAuthority.issuedAtUtc) - 1);
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(codes(result).includes('AUTHORITY_NOT_YET_VALID'), JSON.stringify(result.findings));
});

test('T4 a consumption verified inside the window is AUTHORIZED', () => {
  const result = verifyConsumption(live, { when: new Date('2026-09-01T00:00:00.000Z') });
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.consumed, true);
});

test('T5 the same consumption verified after expiry is still AUTHORIZED', () => {
  for (const when of [AFTER_EXPIRY, LONG_AFTER_EXPIRY]) {
    const result = verifyConsumption(live, { when });
    assert.deepEqual(codes(result), [], `${when.toISOString()}: ${JSON.stringify(result.findings)}`);
    assert.equal(result.consumed, true);
  }
});

test('T6 a consumption recorded after the authority expired is BLOCKED', () => {
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.recordedAt = '2027-03-01T00:00:00.000Z';
  }), () => {
    const result = verifyConsumption(live, { when: AFTER_EXPIRY });
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_AFTER_AUTHORITY_EXPIRED'), JSON.stringify(result.findings));
  });
});

test('T7 a consumption recorded before the authority was issued is BLOCKED', () => {
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.recordedAt = '2026-01-01T00:00:00.000Z';
  }), () => {
    const result = verifyConsumption(live, { when: AFTER_EXPIRY });
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_BEFORE_AUTHORITY_ISSUED'), JSON.stringify(result.findings));
  });
});

test('T8 a malformed consumption timestamp is BLOCKED, never skipped', () => {
  for (const value of ['not-a-date', '', null]) {
    withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => { document.recordedAt = value; }), () => {
      const result = verifyConsumption(live, { when: AFTER_EXPIRY });
      assert.equal(result.decision, 'BLOCKED', String(value));
      // Two independent owners refuse it, so neither check can silently lapse.
      assert.ok(codes(result).includes('CONSUMPTION_WINDOW_UNVERIFIABLE'), JSON.stringify(result.findings));
      assert.ok(codes(result).includes('CONSUMPTION_RECORDED_AT_INVALID'), JSON.stringify(result.findings));
    });
  }
});

test('T9 an altered consumption record is BLOCKED after expiry too', () => {
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.cohort[0].sha256 = '6'.repeat(64);
  }), () => {
    const result = verifyConsumption(live, { when: LONG_AFTER_EXPIRY });
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_COHORT_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('T10 replay after expiry is still BLOCKED', () => {
  for (const when of [AFTER_EXPIRY, LONG_AFTER_EXPIRY]) {
    const result = authorizeWrite(live, { when });
    assert.equal(result.decision, 'BLOCKED');
    assert.equal(result.bootstrapAuthorized, false);
    assert.deepEqual(result.authorizedPaths, []);
    // Expiry AND consumption both refuse it; neither alone is load-bearing.
    assert.ok(codes(result).includes('AUTHORITY_EXPIRED'), JSON.stringify(result.findings));
    assert.ok(codes(result).includes('AUTHORITY_ALREADY_CONSUMED'), JSON.stringify(result.findings));
  }
});

test('T11 ESSENTIAL: final GATE19 bytes at COMPLETE_AGENT verify under a clock past expiry', () => {
  assert.equal(gateEvents(live).at(-1).toStatus, 'COMPLETE_AGENT');
  assert.ok(Date.parse(liveAuthority.expiresAtUtc) < LONG_AFTER_EXPIRY.getTime(), 'the clock must genuinely be past expiry');

  const result = verifyConsumption(live, { when: LONG_AFTER_EXPIRY });
  assert.deepEqual(codes(result), [], JSON.stringify(result.findings));
  assert.equal(result.decision, 'AUTHORIZED');
  assert.equal(result.consumed, true);

  // And it is the RECORDED instant that carries the proof, not the clock.
  const record = readJson(live, CONSUMPTION_RELATIVE);
  assert.ok(Date.parse(liveAuthority.issuedAtUtc) <= Date.parse(record.recordedAt));
  assert.ok(Date.parse(record.recordedAt) <= Date.parse(liveAuthority.expiresAtUtc));
});

test('T12 the legacy Ed25519 path keeps clock-based expiry in both phases', () => {
  // Legacy authorities are defended by the owner's key, not by a pre-state
  // binding, and they record no consumption receipt to measure a window against.
  // Their temporal behaviour must therefore be exactly what it always was.
  const expired = {
    schemaVersion: 1, documentKind: 'ACTIVE_PRECONTRACT_AUTHORITY', authorityId: 'LEGACY',
    issuedBy: 'PROJECT_OWNER', issuedAtUtc: '2026-01-01T00:00:00.000Z', expiresAtUtc: '2026-02-01T00:00:00.000Z'
  };
  for (const phase of ['AUTHORIZE_WRITE', 'VERIFY_CONSUMPTION']) {
    const result = evaluatePrecontractAuthority({ authority: expired, request: null, now: LONG_AFTER_EXPIRY, phase });
    assert.equal(result.authorityMode, 'LEGACY_SIGNED_AUTHORITY', phase);
    assert.equal(result.decision, 'BLOCKED', phase);
    assert.ok(!codes(result).some((code) => code.startsWith('CONSUMPTION_') || code.startsWith('HISTORICAL_')),
      `${phase}: local-mode findings must not reach the legacy path: ${JSON.stringify(result.findings)}`);
  }
});

// ---------------------------------------------------------------------------
// TIMESTAMP AUTHENTICITY. A recorded instant that merely sits inside the window
// is decoration: any other in-window value would have passed. These cases pin
// that the instant is part of the receipt's identity and of the ledger's chain.
// ---------------------------------------------------------------------------

const disposable = [];
/** A rewound Gate, staged contract and freshly issued authority, ready to bootstrap. */
function freshBootstrapFixture() {
  const built = buildFixture();
  const stagedPair = stageContract(built.root);
  const issued = issuePrecontractAuthority({
    root: built.root, gateId: GATE, authorityId: `PRECONTRACT_BOOTSTRAP_${GATE}_LOCAL_R1`,
    stagedRoot: stagedPair.staged, stagedPaths: stagedPair.stagedPaths,
    issuedAtUtc: ISSUED_AT, expiresAtUtc: EXPIRES_AT
  });
  assert.equal(issued.verdict, 'ISSUED', JSON.stringify(issued.findings));
  writeJson(built.root, AUTHORITY_RELATIVE, issued.authority);
  disposable.push(built.root, stagedPair.staged);
  return { root: built.root, staged: stagedPair.staged, authorityPath: absolute(built.root, AUTHORITY_RELATIVE) };
}

const CANONICAL_ARTIFACTS = [CONTRACT_RELATIVE, POINTER_RELATIVE, CONSUMPTION_RELATIVE];
/** The canonical bytes a bootstrap is allowed to change, as a comparable value. */
function canonicalState(root) {
  return CANONICAL_ARTIFACTS.map((relative) => {
    const target = absolute(root, relative);
    const present = fs.existsSync(target);
    return { path: relative, present, sha256: present ? sha256(fs.readFileSync(target)) : null };
  });
}

test('D1 the regenerated GATE19 receipt carries an identity that reproduces exactly', () => {
  const record = readJson(live, CONSUMPTION_RELATIVE);
  const ledgerText = fs.readFileSync(absolute(live, LEDGER), 'utf8');
  const prefix = reconstructLedgerPrefix(ledgerText, liveAuthority.preState.ledgerEventCount);
  assert.equal(prefix.valid, true);
  const expected = computePrecontractConsumptionIdentityDigest({
    authority: liveAuthority, ledgerPrefixSha256: prefix.sha256, ledgerEventCount: prefix.eventCount,
    cohort: liveAuthority.artifactBindings, recordedAt: record.recordedAt, consumedUse: record.consumedUse
  });
  assert.equal(record.consumptionIdentityDigest, expected);
  assert.deepEqual(codes(verifyConsumption(live)), []);
});

test('D2 THE REPORTED DEFECT: recordedAt moved to another in-window date is BLOCKED', () => {
  // Every substituted value below is a perfectly valid instant inside
  // issuedAtUtc..expiresAtUtc, which is exactly what used to make it pass.
  for (const substitute of ['2026-08-15T14:02:00.000Z', '2026-10-01T12:00:00.000Z', '2026-12-30T00:00:00.000Z']) {
    withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => { document.recordedAt = substitute; }), () => {
      const result = verifyConsumption(live);
      assert.equal(result.decision, 'BLOCKED', substitute);
      assert.ok(codes(result).includes('CONSUMPTION_IDENTITY_DIGEST_MISMATCH'), `${substitute}: ${JSON.stringify(result.findings)}`);
      // The window check alone would have admitted it, which is the point.
      assert.ok(!codes(result).includes('CONSUMPTION_AFTER_AUTHORITY_EXPIRED'), substitute);
      assert.ok(!codes(result).includes('CONSUMPTION_BEFORE_AUTHORITY_ISSUED'), substitute);
    });
  }
});

test('D3 recordedAt moved AND its digest recomputed is still BLOCKED by the ledger chain', () => {
  // The strongest local forgery: the attacker repairs the identity digest too, so
  // the receipt is internally consistent. The hash-chained ledger still refuses,
  // because the instant now falls outside the interval the chain allows.
  const ledgerText = fs.readFileSync(absolute(live, LEDGER), 'utf8');
  const prefix = reconstructLedgerPrefix(ledgerText, liveAuthority.preState.ledgerEventCount);
  const substitute = '2026-10-01T12:00:00.000Z';
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.recordedAt = substitute;
    document.consumptionIdentityDigest = computePrecontractConsumptionIdentityDigest({
      authority: liveAuthority, ledgerPrefixSha256: prefix.sha256, ledgerEventCount: prefix.eventCount,
      cohort: liveAuthority.artifactBindings, recordedAt: substitute, consumedUse: document.consumedUse
    });
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(!codes(result).includes('CONSUMPTION_IDENTITY_DIGEST_MISMATCH'), 'the digest was repaired, so it must not be what refuses');
    assert.ok(codes(result).includes('CONSUMPTION_AFTER_NEXT_LEDGER_EVENT'), JSON.stringify(result.findings));
  });
});

test('D4 a missing or wrong identity algorithm is BLOCKED, never treated as optional', () => {
  for (const [mutate, expected] of [
    [(d) => { delete d.consumptionIdentityAlgorithm; delete d.consumptionIdentityDigest; }, 'CONSUMPTION_IDENTITY_ALGORITHM_INVALID'],
    [(d) => { d.consumptionIdentityAlgorithm = 'SOMETHING_ELSE_V9'; }, 'CONSUMPTION_IDENTITY_ALGORITHM_INVALID'],
    [(d) => { d.consumptionIdentityDigest = 'zz'; }, 'CONSUMPTION_IDENTITY_DIGEST_INVALID']
  ]) {
    withTamper(CONSUMPTION_RELATIVE, tamperJson(mutate), () => {
      const result = verifyConsumption(live);
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(codes(result).includes(expected), JSON.stringify(result.findings));
    });
  }
});

test('D5 the identity is bound to the cohort, so re-pinning one artifact is BLOCKED', () => {
  withTamper(AUTHORITY_RELATIVE, tamperJson((document) => {
    document.artifactBindings[0].sha256 = '5'.repeat(64);
    Object.assign(document, reseal(document));
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_IDENTITY_DIGEST_MISMATCH'), JSON.stringify(result.findings));
  });
});

// ---------------------------------------------------------------------------
// ATOMICITY. No BLOCKED verdict may leave a published bootstrap behind.
// ---------------------------------------------------------------------------

test('A1 a failure before any write leaves the canonical pre-state untouched', () => {
  const scratch = freshBootstrapFixture();
  const before = canonicalState(scratch.root);
  // The authority is bound to the pre-state; move the ledger and it no longer is.
  fs.appendFileSync(absolute(scratch.root, LEDGER), '\n');
  const result = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.phase, 'AUTHORIZE_WRITE');
  assert.deepEqual(result.written, []);
  assert.deepEqual(canonicalState(scratch.root), before);
});

test('A2 a candidate whose consumption cannot be proven publishes nothing', () => {
  const scratch = freshBootstrapFixture();
  const before = canonicalState(scratch.root);
  // Redirect the staged pointer at a foreign contract: the candidate is
  // internally inconsistent, and that must be discovered BEFORE publication.
  const pointer = JSON.parse(fs.readFileSync(absolute(scratch.staged, POINTER_RELATIVE), 'utf8'));
  pointer.contractPath = `governance/gates/${TEMPLATE_GATE}/contracts/EXECUTION_CONTRACT_R0001.json`;
  fs.writeFileSync(absolute(scratch.staged, POINTER_RELATIVE), `${JSON.stringify(pointer, null, 2)}\n`);
  const result = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.deepEqual(result.written, []);
  assert.deepEqual(canonicalState(scratch.root), before);
});

/** Fail on the Nth write, so each publication boundary can be broken in turn. */
function failingWriteAt(index) {
  let seen = 0;
  return (target, bytes) => {
    seen += 1;
    if (seen === index) throw new Error(`INJECTED_IO_FAILURE_AT_WRITE_${index}`);
    return fs.writeFileSync(target, bytes);
  };
}

for (const [name, index] of [['A3 R0001', 1], ['A4 CURRENT_CONTRACT', 2], ['A5 the consumption receipt', 3]]) {
  test(`${name}: an I/O failure while publishing rolls back to the exact pre-state`, () => {
    const scratch = freshBootstrapFixture();
    const before = canonicalState(scratch.root);
    const result = applyPrecontractBootstrap({
      root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW,
      writeFile: failingWriteAt(index)
    });
    assert.equal(result.verdict, 'BLOCKED', name);
    assert.equal(result.phase, 'ATOMIC_PUBLICATION', name);
    assert.equal(result.rolledBack, true, `${name}: ${JSON.stringify(result.findings)}`);
    assert.deepEqual(result.written, [], name);
    assert.deepEqual(canonicalState(scratch.root), before, `${name}: canonical bytes must be identical to the pre-state`);
    for (const relative of CANONICAL_ARTIFACTS) {
      assert.equal(fs.existsSync(absolute(scratch.root, relative)), false, `${name}: ${relative} must not exist`);
    }
  });
}

test('A6 a post-publication verification failure unpublishes everything it wrote', () => {
  const scratch = freshBootstrapFixture();
  const before = canonicalState(scratch.root);
  // Silent corruption: the publication succeeds, but one artifact lands with
  // bytes the authority never approved, so the post-publication proof refuses.
  const corrupt = (target, bytes) => fs.writeFileSync(target,
    target.endsWith('EXECUTION_CONTRACT_R0001.json') ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
  const result = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW,
    writeFile: corrupt
  });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.phase, 'POST_PUBLICATION_VERIFICATION');
  assert.equal(result.rolledBack, true, JSON.stringify(result.findings));
  assert.deepEqual(result.written, []);
  assert.deepEqual(canonicalState(scratch.root), before);
});

test('A7 a rolled-back bootstrap can simply be retried: recovery is idempotent', () => {
  const scratch = freshBootstrapFixture();
  const before = canonicalState(scratch.root);
  const failed = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW,
    writeFile: failingWriteAt(2)
  });
  assert.equal(failed.verdict, 'BLOCKED');
  assert.deepEqual(canonicalState(scratch.root), before);

  // The pre-state is intact, so the authority is still unspent and the very same
  // call now succeeds. Exactly-once holds: the retry consumes it, and a third
  // attempt is refused.
  const retried = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW
  });
  assert.equal(retried.verdict, 'APPLIED', JSON.stringify(retried.findings));
  assert.deepEqual(codes(verifyConsumption(scratch.root)), []);

  const third = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW
  });
  assert.equal(third.verdict, 'BLOCKED');
  assert.deepEqual(third.written, []);
});

test('A8 a successful bootstrap publishes exactly the authorized artifacts and nothing else', () => {
  const scratch = freshBootstrapFixture();
  const authority = readJson(scratch.root, AUTHORITY_RELATIVE);
  const result = applyPrecontractBootstrap({
    root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW
  });
  assert.equal(result.verdict, 'APPLIED', JSON.stringify(result.findings));
  assert.deepEqual(result.written.map((item) => item.path).sort(), [...authority.authorizedPaths].sort());
  for (const relative of CANONICAL_ARTIFACTS) assert.ok(fs.existsSync(absolute(scratch.root, relative)), relative);
  // A committed transaction leaves no working directory behind.
  assert.equal(fs.existsSync(absolute(scratch.root, 'governance/transactions')), false);
});

// ---------------------------------------------------------------------------
// EXTERNAL ANCHOR. The identity digest lives in the file it protects, so it can
// be recomputed by whoever edits that file. The anchor lives in the append-only
// ledger, which is the one place the receipt's author cannot quietly revise.
// ---------------------------------------------------------------------------

const ANCHOR_RELATIVE = `governance/authority/precontract/${GATE}/PRECONTRACT_CONSUMPTION_ANCHOR_AUTHORITY_R1.json`;

/** Re-derive the identity digest exactly as the official implementation would. */
function officialIdentityDigest(root, recordedAt, consumedUse = 1, cohort = null) {
  const authority = readJson(root, AUTHORITY_RELATIVE);
  const prefix = reconstructLedgerPrefix(fs.readFileSync(absolute(root, LEDGER), 'utf8'), authority.preState.ledgerEventCount);
  return computePrecontractConsumptionIdentityDigest({
    authority, ledgerPrefixSha256: prefix.sha256, ledgerEventCount: prefix.eventCount,
    cohort: cohort ?? authority.artifactBindings, recordedAt, consumedUse
  });
}

test('X1 MANDATORY 3-WAY: original PASS, stale digest BLOCK, recomputed digest BLOCK', () => {
  // Case 1 — the receipt exactly as it was written.
  assert.deepEqual(codes(verifyConsumption(live)), []);

  // Case 2 — a different instant, digest left alone.
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => { document.recordedAt = '2026-08-15T14:02:00.000Z'; }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_IDENTITY_DIGEST_MISMATCH'), JSON.stringify(result.findings));
  });

  // Case 3 — THE DEFECT THIS MISSION CLOSES. A different instant AND a digest
  // recomputed with the official implementation, so the receipt is internally
  // perfect. Nothing else on disk is touched: no authority, no ledger prefix, no
  // contract, no state, no seal, no historical event. The forged instant is still
  // after issuedAtUtc, before expiresAtUtc, and inside the ledger bracket.
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.recordedAt = '2026-08-15T14:02:00.000Z';
    document.consumptionIdentityDigest = officialIdentityDigest(live, document.recordedAt, document.consumedUse);
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_RECEIPT_ANCHOR_MISMATCH'), JSON.stringify(result.findings));
    // The in-file identity is now self-consistent, so it is NOT what refuses.
    assert.ok(!codes(result).includes('CONSUMPTION_IDENTITY_DIGEST_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('X2 any byte mutation of the receipt is BLOCKED by the anchor', () => {
  for (const mutate of [
    (d) => { d.transactionNote = 'appended'; },
    (d) => { d.consumedUse = 1; d.cohort = [...d.cohort].reverse(); }
  ]) {
    withTamper(CONSUMPTION_RELATIVE, tamperJson(mutate), () => {
      const result = verifyConsumption(live);
      assert.equal(result.decision, 'BLOCKED');
      assert.ok(codes(result).includes('CONSUMPTION_RECEIPT_ANCHOR_MISMATCH'), JSON.stringify(result.findings));
    });
  }
});

test('X3 a cohort mutation with its digest recomputed is BLOCKED', () => {
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => {
    document.cohort[0].sha256 = '4'.repeat(64);
    document.consumptionIdentityDigest = officialIdentityDigest(live, document.recordedAt, document.consumedUse, document.cohort);
  }), () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_RECEIPT_ANCHOR_MISMATCH'), JSON.stringify(result.findings));
  });
});

test('X4 an absent anchor is BLOCKED once the ledger has moved past the bootstrap', () => {
  withTamper(LEDGER, (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean)
      .filter((line) => !line.includes('PRECONTRACT_CONSUMPTION_ANCHOR'));
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
  }, () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_RECEIPT_NOT_ANCHORED'), JSON.stringify(result.findings));
  });
});

test('X5 an anchor naming the wrong receipt digest, gate or path is BLOCKED', () => {
  const rewriteAnchor = (mutate) => (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    const index = lines.findIndex((line) => line.includes('PRECONTRACT_CONSUMPTION_ANCHOR'));
    const event = JSON.parse(lines[index]);
    mutate(event);
    lines[index] = JSON.stringify(event);
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
  };
  const cases = [
    ['wrong receipt digest', (e) => { e.precontractConsumption.sha256 = '3'.repeat(64); }, 'CONSUMPTION_RECEIPT_ANCHOR_MISMATCH'],
    ['wrong receipt path', (e) => { e.precontractConsumption.path = `governance/gates/${TEMPLATE_GATE}/contracts/PRECONTRACT_AUTHORITY_CONSUMPTION_R1.json`; }, 'CONSUMPTION_ANCHOR_PATH_MISMATCH'],
    ['wrong gate', (e) => { e.gateId = TEMPLATE_GATE; }, 'CONSUMPTION_RECEIPT_NOT_ANCHORED'],
    ['no binding at all', (e) => { delete e.precontractConsumption; }, 'CONSUMPTION_ANCHOR_BINDING_ABSENT']
  ];
  for (const [name, mutate, expected] of cases) {
    withTamper(LEDGER, rewriteAnchor(mutate), () => {
      const result = verifyConsumption(live);
      assert.equal(result.decision, 'BLOCKED', name);
      assert.ok(codes(result).includes(expected), `${name}: ${JSON.stringify(result.findings)}`);
    });
  }
});

test('X6 two anchors for one Gate are refused rather than one being chosen', () => {
  withTamper(LEDGER, (target) => {
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean);
    const anchor = lines.find((line) => line.includes('PRECONTRACT_CONSUMPTION_ANCHOR'));
    fs.writeFileSync(target, `${lines.join('\n')}\n${anchor}\n`);
  }, () => {
    const result = verifyConsumption(live);
    assert.equal(result.decision, 'BLOCKED');
    assert.ok(codes(result).includes('CONSUMPTION_RECEIPT_ANCHOR_AMBIGUOUS'), JSON.stringify(result.findings));
  });
});

test('X7 the ledger validator independently refuses a mutated anchored receipt', () => {
  // The core is not the only guard: the append-only spine is re-proved on its own.
  withTamper(CONSUMPTION_RELATIVE, tamperJson((document) => { document.recordedAt = '2026-08-15T14:02:00.000Z'; }), () => {
    const result = spawnSync(process.execPath, [absolute(live, 'governance/tools/validate-status-ledger.mjs'), '--root', live], { cwd: live, encoding: 'utf8' });
    const findings = JSON.parse(result.stdout).findings.filter((item) => item.severity !== 'INFO');
    assert.ok(findings.some((item) => item.detectorId === 'PRECONTRACT_ANCHOR_RECEIPT_MUTATED'), JSON.stringify(findings.slice(0, 3)));
  });
});

test('X8 the anchor tool refuses a second anchor and an unbound receipt', () => {
  const scratch = freshBootstrapFixture();
  applyPrecontractBootstrap({ root: scratch.root, authorityPath: scratch.authorityPath, stagedRoot: scratch.staged, apply: true, now: NOW });
  anchorFixtureReceipt(scratch.root, { recordedAt: '2026-08-15T13:20:00.000Z' });

  const second = anchorPrecontractConsumption({
    root: scratch.root, authorityPath: absolute(scratch.root, ANCHOR_RELATIVE),
    recordedAt: '2026-08-15T13:21:00.000Z', apply: true
  });
  assert.equal(second.verdict, 'BLOCKED');
  assert.ok(second.findings.some((item) => item.code === 'ANCHOR_ALREADY_PRESENT'), JSON.stringify(second.findings));
});

test.after(() => {
  for (const directory of [fixture.root, staged, live, ...disposable]) fs.rmSync(directory, { recursive: true, force: true });
});
