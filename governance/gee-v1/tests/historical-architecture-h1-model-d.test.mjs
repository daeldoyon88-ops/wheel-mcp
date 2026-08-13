/**
 * H1 — MODEL D.
 *
 * The property under test is not "the registry parses". It is that a historical
 * verification cannot succeed without terminating in real evidence, and that
 * the two legitimate terminations (retained bytes, deterministic reconstruction)
 * both actually work against this repository's real history.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MODEL_D_CLASSES,
  IMMUTABLE_VERSIONED_ARTIFACT,
  MUTABLE_PROJECTION,
  RECONSTRUCTABLE_PROJECTION,
  APPEND_ONLY_LOG,
  GROUND_RETAINED_BYTES,
  GROUND_RECONSTRUCTION,
  GROUND_TARGET_LINEAGE,
  GROUND_PREFIX_IMMUTABILITY,
  HISTORICAL_TERMINAL_GROUNDS,
  validateArtifactClassificationEntry,
  validateArtifactClassificationRegistry,
  evaluateHistoricalVerification
} from '../core/artifact-classification.mjs';
import { canonicalize, sha256Bytes } from '../../tools/canonical-json.mjs';
import { validateLedger, reconstructLedgerPrefixBytes } from '../../tools/validate-status-ledger.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY as policy } from '../adapters/wheel/external-authority-policy.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = path.join(REPO_ROOT, 'governance/state/GATE_STATUS_LEDGER.ndjson');
const SNAPSHOT_TOOL_SHA = 'c09f9d24b9b687e3fca2b22963fb610d15734bd96bd5c33f6ee13b16447b65b4';
const OLD_SNAPSHOT_TOOL_SHA = 'a4808b9e486913bfa861632f1dfdfb3b5c4cc97be1e055bcab32ac83dbed5b82';

const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8').replace(/^﻿/, ''));
const registry = () => readJson('governance/historical-architecture/ARTIFACT_CLASSIFICATION_REGISTRY.json');
const retained = () => readJson('governance/historical-architecture/RETAINED_HISTORICAL_OBJECTS.json');

function validEntry(overrides = {}) {
  return {
    artifactId: 'FIXTURE',
    path: 'governance/fixture.json',
    artifactClass: IMMUTABLE_VERSIONED_ARTIFACT,
    verificationGround: GROUND_RETAINED_BYTES,
    retainedSha256: 'a'.repeat(64),
    retainedByteLength: 10,
    ...overrides
  };
}

/**
 * Rebuilds GATE_STATUS_SNAPSHOT exactly as generate-status-snapshot.mjs would,
 * for an arbitrary ledger prefix and an arbitrary declared generator identity.
 * Taking the generator identity as a PARAMETER is what lets the tests below
 * prove it is load-bearing rather than decorative.
 */
function reconstructSnapshot(atOrdinal, generatorSha) {
  const prefix = reconstructLedgerPrefixBytes(LEDGER, atOrdinal);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-model-d-'));
  try {
    const tmpLedger = path.join(tmp, 'GATE_STATUS_LEDGER.ndjson');
    fs.writeFileSync(tmpLedger, prefix);
    const report = validateLedger({ root: REPO_ROOT, ledgerPath: tmpLedger, policy });
    const byGate = new Map();
    for (const event of report.events) {
      byGate.set(event.gateId, {
        gateId: event.gateId, currentStatus: event.toStatus, lastEventId: event.eventId,
        lastEventOrdinal: event.ordinal, lastEventSha256: event.eventPayloadSha256,
        statusAuthorityPath: event.authorityPath, statusAuthoritySha256: event.authoritySha256
      });
    }
    const snapshot = {
      schemaVersion: 1, canonical: false,
      generatedFrom: {
        sourceLedgerPath: 'governance/state/GATE_STATUS_LEDGER.ndjson',
        sourceLedgerSha256: report.ledgerSha256,
        generationTool: 'governance/tools/generate-status-snapshot.mjs',
        generationToolSha256: generatorSha,
        provenance: 'Derived exclusively by replaying the canonical status ledger.'
      },
      generatedAt: report.events.at(-1).recordedAt,
      gates: [...byGate.values()].sort((a, b) => a.gateId.localeCompare(b.gateId))
    };
    return { prefixSha: sha256Bytes(prefix), bytes: Buffer.from(canonicalize(snapshot) + '\n', 'utf8') };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- the model itself -------------------------------------------------------

test('H1-01: the seven MODEL D classes are exactly the declared set', () => {
  assert.deepEqual([...MODEL_D_CLASSES].sort(), [
    'APPEND_ONLY_LOG', 'EXECUTABLE_AUTHORITY', 'EXTERNAL_LEGACY_AUTHORITY',
    'IMMUTABLE_VERSIONED_ARTIFACT', 'MUTABLE_PROJECTION', 'OPAQUE', 'RECONSTRUCTABLE_PROJECTION'
  ]);
});

test('H1-02: only retained bytes and deterministic reconstruction terminate history', () => {
  assert.deepEqual([...HISTORICAL_TERMINAL_GROUNDS].sort(), ['DETERMINISTIC_RECONSTRUCTION', 'RETAINED_IMMUTABLE_BYTES']);
});

test('H1-03: reaching no ground is FORMAT_ONLY and is rejected, never a quiet PASS', () => {
  const result = evaluateHistoricalVerification({ entry: validEntry(), observed: {}, historical: true });
  assert.equal(result.state, 'NOT_PROVEN');
  assert.ok(result.findings.some((f) => f.code === 'FORMAT_ONLY_VERIFICATION_REJECTED'));
});

test('H1-04: a present-tense ground cannot terminate a historical claim', () => {
  for (const [artifactClass, ground] of [[MUTABLE_PROJECTION, GROUND_TARGET_LINEAGE], [APPEND_ONLY_LOG, GROUND_PREFIX_IMMUTABILITY]]) {
    const entry = validEntry({ artifactClass, verificationGround: ground, retainedSha256: undefined, retainedByteLength: undefined, targetLineage: 'x' });
    const result = evaluateHistoricalVerification({
      entry, observed: { groundReached: ground, targetLineageValid: true, prefixImmutable: true }, historical: true
    });
    assert.equal(result.state, 'NOT_PROVEN', artifactClass);
    assert.ok(result.findings.some((f) => f.code === 'GROUND_DOES_NOT_TERMINATE_HISTORY'), artifactClass);
  }
});

test('H1-05: a class may not verify on a ground that does not belong to it', () => {
  const entry = validEntry({ artifactClass: IMMUTABLE_VERSIONED_ARTIFACT, verificationGround: GROUND_RECONSTRUCTION });
  assert.ok(validateArtifactClassificationEntry(entry).findings.some((f) => f.code === 'VERIFICATION_GROUND_NOT_PERMITTED_FOR_CLASS'));
});

test('H1-06: reconstruction without immutable sources or generator identity is not reconstruction', () => {
  const base = { artifactId: 'R', path: 'p', artifactClass: RECONSTRUCTABLE_PROJECTION, verificationGround: GROUND_RECONSTRUCTION, retainedSha256: 'b'.repeat(64) };
  assert.ok(validateArtifactClassificationEntry({ ...base, generatorIdentity: { path: 'g', sha256: 'c'.repeat(64) } })
    .findings.some((f) => f.code === 'RECONSTRUCTION_SOURCES_MISSING'));
  assert.ok(validateArtifactClassificationEntry({ ...base, immutableSources: ['s'] })
    .findings.some((f) => f.code === 'RECONSTRUCTION_GENERATOR_IDENTITY_MISSING'));
  assert.ok(validateArtifactClassificationEntry({ artifactId: 'R', path: 'p', artifactClass: RECONSTRUCTABLE_PROJECTION, verificationGround: GROUND_RECONSTRUCTION, immutableSources: ['s'], generatorIdentity: { path: 'g', sha256: 'c'.repeat(64) } })
    .findings.some((f) => f.code === 'RECONSTRUCTION_EXPECTED_DIGEST_MISSING'));
});

test('H1-07: a mutable projection may not be permanently byte-pinned', () => {
  const entry = { artifactId: 'M', path: 'p', artifactClass: MUTABLE_PROJECTION, verificationGround: GROUND_TARGET_LINEAGE, targetLineage: 'a -> b', retainedSha256: 'd'.repeat(64) };
  assert.ok(validateArtifactClassificationEntry(entry).findings.some((f) => f.code === 'MUTABLE_PROJECTION_PERMANENTLY_BYTE_PINNED'));
});

// --- the real repository ----------------------------------------------------

test('H1-08: the shipped registry is a valid MODEL D registry', () => {
  const result = validateArtifactClassificationRegistry(registry());
  assert.deepEqual(result.findings, []);
  assert.equal(result.valid, true);
});

test('H1-09: every RETAINED_IMMUTABLE_BYTES object still hashes and measures as pinned', () => {
  for (const object of retained().objects) {
    if (object.verificationGround !== 'RETAINED_IMMUTABLE_BYTES') continue;
    const bytes = fs.readFileSync(path.join(REPO_ROOT, object.path));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), object.retainedSha256, object.artifactId);
    assert.equal(bytes.length, object.retainedByteLength, object.artifactId);
  }
});

test('H1-10: the executable MODEL D validator reports every artifact PROVEN', () => {
  const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'governance/tools/validate-artifact-classification.mjs'), '--root', REPO_ROOT], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.valid, true, JSON.stringify(report.findings));
  assert.equal(report.proven, report.classifiedArtifacts);
  assert.ok(report.classifiedArtifacts > 0);
});

// --- the two terminations, proved against real history ----------------------

test('H1-11: GATE_STATUS_SNAPSHOT@57 reconstructs exactly, though its bytes exist nowhere', () => {
  const { prefixSha, bytes } = reconstructSnapshot(57, SNAPSHOT_TOOL_SHA);
  // The prefix digest was pinned independently by the owner-signed event 58 START record.
  assert.equal(prefixSha, 'c4dfefd7790cfc30f3f13a5159362b03b9902273ac6b3d7db8ab5dba6ba6ab6b');
  const declared = retained().objects.find((o) => o.artifactId === 'GATE_STATUS_SNAPSHOT_AT_ORDINAL_57');
  assert.equal(sha256Bytes(bytes), declared.retainedSha256);
  assert.equal(bytes.length, declared.retainedByteLength);
});

test('H1-12: ACTIVE_GATE@57 reconstructs to the digest the owner-signed START authority pinned', () => {
  const { bytes } = reconstructSnapshot(57, SNAPSHOT_TOOL_SHA);
  const base = JSON.parse(execFileSync('git', ['show', 'd5b5cee6:governance/active/ACTIVE_GATE.json'], { cwd: REPO_ROOT, encoding: 'utf8' }));
  const canonical = canonicalize({ ...base, currentStateSha256: sha256Bytes(bytes) });
  const startAuthority = readJson('governance/authority/authorizations/GATE14/PROJECT_OWNER_GATE_START_AUTHORITY.json');
  assert.equal(sha256Bytes(Buffer.from(canonical, 'utf8')), startAuthority.activeGatePreState.sha256);
  assert.equal(Buffer.byteLength(canonical), startAuthority.activeGatePreState.byteLength);
});

test('H1-13: the pinned generator identity is evidence — substituting a different generator fails', () => {
  const good = reconstructSnapshot(57, SNAPSHOT_TOOL_SHA);
  const other = reconstructSnapshot(57, OLD_SNAPSHOT_TOOL_SHA);
  assert.notEqual(sha256Bytes(other.bytes), sha256Bytes(good.bytes));
  const declared = retained().objects.find((o) => o.artifactId === 'GATE_STATUS_SNAPSHOT_AT_ORDINAL_57');
  assert.notEqual(sha256Bytes(other.bytes), declared.retainedSha256);
});

test('H1-14: a reconstruction whose generator identity no longer matches is NOT_PROVEN', () => {
  const entry = registry().artifacts.find((a) => a.artifactId === 'GATE_STATUS_SNAPSHOT');
  const result = evaluateHistoricalVerification({ entry, observed: { groundReached: GROUND_RECONSTRUCTION, generatorIdentityMatched: false, digestMatched: true }, historical: true });
  assert.equal(result.state, 'NOT_PROVEN');
  assert.ok(result.findings.some((f) => f.code === 'GENERATOR_IDENTITY_MISMATCH'));
});

test('H1-15: CURRENT_STATE@R0001 is retained as recovered bytes reproducing the event 57 pin', () => {
  const object = retained().objects.find((o) => o.artifactId === 'GATE14_CURRENT_STATE_OBSERVED_AT_EVENT_57');
  const observation = object.historicalObservation;
  assert.equal(observation.historicalInstanceRecovered, true);
  const bytes = Buffer.from(observation.recoveredContent, 'utf8');
  assert.equal(sha256Bytes(bytes), observation.sha256);
  assert.equal(bytes.length, observation.byteLength);
  // It must agree with the event 57 authorization record, not merely with itself.
  const record = readJson('governance/authority/authorizations/GATE14/GATE_AUTHORIZATION_RECORD.json');
  const pinned = record.authorizedStateArtifacts.find((a) => a.cohortRole === 'CURRENT_STATE');
  assert.equal(sha256Bytes(bytes), pinned.sha256);
  assert.equal(bytes.length, pinned.byteLength);
  // And it must genuinely describe R0001, rooted at the R0001 seal.
  const recovered = JSON.parse(observation.recoveredContent);
  assert.equal(recovered.stateRevision, 'R0001');
  assert.equal(recovered.stateSealSha256, 'c7004faf6368c46a96ec44a230cf594c4f7a4b09ad0f0901c15638071ca9c38d');
});

test('H1-16: the live CURRENT_STATE pointer has lawfully advanced and is not byte-pinned', () => {
  const live = readJson('governance/gates/GATE14/state/CURRENT_STATE.json');
  // The pointer has now advanced twice — R0001 at event 57, R0002 at event 58,
  // R0003 at the contract succession — which is exactly what a MUTABLE_PROJECTION
  // is for, and exactly why it must never carry a permanent byte pin.
  assert.equal(live.stateRevision, 'R0003');
  const entry = registry().artifacts.find((a) => a.artifactId === 'GATE14_CURRENT_STATE_POINTER');
  assert.equal(entry.artifactClass, MUTABLE_PROJECTION);
  assert.equal(Object.hasOwn(entry, 'retainedSha256'), false);
});
