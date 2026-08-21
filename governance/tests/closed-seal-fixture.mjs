/**
 * The CANONICALLY AUTHORIZED synthetic repository both closed-state-seal suites
 * are built on.
 *
 * Not a `*.test.mjs` file and therefore not a suite: the evidence-suite identity
 * guard discovers only `*.test.mjs`, so this module declares no test identities
 * and cannot hide any.
 *
 * WHY IT EXISTS. Two suites need the same fixture for opposite reasons —
 * `closed-state-seal-trust-boundary` proves a seal-shaped document cannot prove
 * bytes, and `closed-state-seal-ledger-authenticity` proves a chain-coherent but
 * UNAUTHORIZED ledger cannot either. Keeping two copies of the builder would let
 * the two halves of one trust boundary drift apart, which is the same failure
 * mode the repair itself exists to remove, one level up.
 *
 * WHAT MAKES THE LEDGER CANONICAL. Every event is a legal transition from the
 * status the replay actually produced, cites an authority whose live bytes hash to
 * the digest it pinned, and belongs to a registered gate with exactly one
 * GENESIS_IMPORT. The earlier fixture emitted 58 filler events with
 * transitionType 'NO_OP' and no authority at all — enough for `verifyLedgerText`,
 * which checks chain integrity, and nowhere near enough for the canonical ledger
 * validator. That gap IS the defect under repair, so a fixture built on it could
 * no longer express a genuine positive control, and every negative case would have
 * begun passing for the wrong reason: a refused trust source rather than the
 * specific seal defect each case exists to prove.
 *
 * No AUTHORIZATION, START, EXTERNAL_CONFIRMATION, anchor or reconciliation event
 * appears here. Those carry heavy proof obligations of their own and belong to
 * their own suites; INTERRUPTION/RESUME are ordinary two-way transitions that
 * carry state pins without dragging in other machinery. (GATE30/GATE31 are
 * "modern" gate ids, so a START event would demand the full gate-start authority
 * chain — deliberately avoided.)
 *
 * Nothing here reads or writes the real repository.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { canonicalize, sha256Canonical } from '../tools/canonical-json.mjs';
import { computeSealedMembersDigest } from '../tools/validate-state-seal.mjs';

export const GATE = 'GATE31';
/** A second registry gate, so the pre-native filler events belong to someone. */
export const FILLER_GATE = 'GATE30';
export const LEDGER = 'governance/state/GATE_STATUS_LEDGER.ndjson';
export const REGISTRY = 'governance/GATE_REGISTRY_00_40.json';
export const SOURCE_MAP = 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json';
export const TRANSITION_AUTHORITY = 'governance/authority/FIXTURE_TRANSITION_AUTHORITY.json';
export const CONTRACT = `governance/gates/${GATE}/contracts/CURRENT_CONTRACT.json`;
export const EVIDENCE = `governance/gates/${GATE}/evidence/CLOSURE_EVIDENCE.json`;
export const UNSEALED = `governance/gates/${GATE}/evidence/UNSEALED_ARTIFACT.json`;
export const R1 = `governance/gates/${GATE}/state/revisions/R0001`;
export const R2 = `governance/gates/${GATE}/state/revisions/R0002`;

/** The legacy era ends at 58, so a natively pinned event must sit above it. */
export const FILLER_EVENTS = 58;

export const absolute = (root, relativePath) => path.join(root, ...relativePath.split('/'));
export const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

export function writeJson(root, relativePath, value) {
  const file = absolute(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(absolute(root, relativePath), 'utf8'));
}

export function identity(root, relativePath) {
  const bytes = fs.readFileSync(absolute(root, relativePath));
  return { repoRelativePath: relativePath, sha256: sha256(bytes), byteLength: bytes.length };
}

/** A seal document with both digests computed from the members it really carries. */
export function sealDocument({ stateRevision, members, previousStateSealSha256, executionStatus, contractSha256, payloadOverride = null, gateId = GATE }) {
  const payload = payloadOverride ?? {
    gateId, stateRevision, executionStatus, contractSha256,
    previousStateSealSha256, sealedMembersDigest: computeSealedMembersDigest(members)
  };
  return {
    schemaVersion: 1, gateId, stateRevision, sealedMembers: members,
    previousStateSealSha256, sealedAt: '2026-08-18T00:00:00.000Z',
    payload, payloadSha256: sha256Canonical(payload)
  };
}

export function writeSeal(root, revisionDir, seal) {
  writeJson(root, `${revisionDir}/STATE_SEAL.json`, seal);
  return sha256(fs.readFileSync(absolute(root, `${revisionDir}/STATE_SEAL.json`)));
}

/**
 * The registry, source map and transition authority a canonically authorized
 * ledger needs. Written once per fixture, before any ledger.
 */
export function writeLedgerPrerequisites(root) {
  writeJson(root, TRANSITION_AUTHORITY, {
    documentKind: 'FIXTURE_TRANSITION_AUTHORITY',
    issuedBy: 'PROJECT_OWNER',
    purpose: 'Synthetic transition authority for the closed-seal fixture.'
  });
  writeJson(root, REGISTRY, {
    gates: [
      { gateId: FILLER_GATE, officialName: 'Filler', canonicalObjective: 'filler' },
      { gateId: GATE, officialName: 'Subject', canonicalObjective: 'subject' }
    ]
  });
  writeJson(root, SOURCE_MAP, {
    gates: [
      { gateId: FILLER_GATE, importedStatus: 'IN_PROGRESS', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 },
      { gateId: GATE, importedStatus: 'IN_PROGRESS', historicalDetailCompleteness: 'PARTIAL', fabricatedTransitionCount: 0 }
    ],
    externalAuthorities: []
  });
}

/** Serialize an already-built event list as canonical NDJSON. */
export function writeLedgerEvents(root, events) {
  const file = absolute(root, LEDGER);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((event) => canonicalize(event)).join('\n') + '\n');
}

/** Parse the fixture ledger back into events. */
export function readLedgerEvents(root) {
  return fs.readFileSync(absolute(root, LEDGER), 'utf8')
    .split('\n').filter((line) => line !== '').map((line) => JSON.parse(line));
}

/**
 * Re-chain an arbitrary event list so ordinals, `previousEventSha256` and
 * `eventPayloadSha256` are all internally correct.
 *
 * This is the hostile's own tool: it is what turns a crude edit into a
 * chain-coherent forgery, and it is exactly why chain integrity alone cannot be
 * the trust source.
 */
export function rechain(events) {
  let previous = null;
  return events.map((event, index) => {
    const body = { ...event };
    delete body.eventPayloadSha256;
    body.ordinal = index + 1;
    body.previousEventSha256 = previous;
    const digest = sha256Canonical(body);
    previous = digest;
    return { ...body, eventPayloadSha256: digest };
  });
}

/** Build the canonical event list for this fixture. */
export function buildLedgerEvents(root, stateBindings) {
  const events = [];
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const authoritySha256 = sha256(fs.readFileSync(absolute(root, TRANSITION_AUTHORITY)));
  const append = (partial, pins = null) => {
    events.push({
      schemaVersion: 1,
      ordinal: events.length + 1,
      eventId: partial.eventId,
      gateId: partial.gateId,
      fromStatus: partial.fromStatus,
      toStatus: partial.toStatus,
      transitionType: partial.transitionType,
      authorityPath: partial.authorityPath ?? TRANSITION_AUTHORITY,
      authoritySha256: partial.authoritySha256 ?? authoritySha256,
      previousEventSha256: null,
      recordedAt: new Date(clock).toISOString(),
      ...(pins ? { stateRevision: pins.stateRevision, stateRevisionSealSha256: pins.stateRevisionSealSha256 } : {}),
      eventPayloadSha256: null
    });
    clock += 60_000;
  };

  // Exactly one GENESIS_IMPORT per registered gate; both land in IN_PROGRESS.
  append({ eventId: `GENESIS_${FILLER_GATE}`, gateId: FILLER_GATE, fromStatus: null, toStatus: 'IN_PROGRESS', transitionType: 'GENESIS_IMPORT' });
  append({ eventId: `GENESIS_${GATE}`, gateId: GATE, fromStatus: null, toStatus: 'IN_PROGRESS', transitionType: 'GENESIS_IMPORT' });
  let fillerStatus = 'IN_PROGRESS';
  for (let ordinal = events.length + 1; ordinal <= FILLER_EVENTS; ordinal += 1) {
    const interrupting = fillerStatus === 'IN_PROGRESS';
    append({
      eventId: `FILLER_${ordinal}`, gateId: FILLER_GATE, fromStatus: fillerStatus,
      toStatus: interrupting ? 'INTERRUPTED_RESUMABLE' : 'IN_PROGRESS',
      transitionType: interrupting ? 'INTERRUPTION' : 'RESUME'
    });
    fillerStatus = interrupting ? 'INTERRUPTED_RESUMABLE' : 'IN_PROGRESS';
  }
  for (const binding of stateBindings) append({ ...binding, gateId: GATE }, binding);
  return rechain(events);
}

export function writeLedger(root, stateBindings) {
  writeLedgerEvents(root, buildLedgerEvents(root, stateBindings));
}

/** The two canonical state-binding events this fixture's seals are pinned by. */
export function stateBindingsFor(r1Sha, r2Sha) {
  return [
    { eventId: `${GATE}_BIND_R0001`, fromStatus: 'IN_PROGRESS', toStatus: 'INTERRUPTED_RESUMABLE', transitionType: 'INTERRUPTION', stateRevision: 'R0001', stateRevisionSealSha256: r1Sha },
    { eventId: `${GATE}_BIND_R0002`, fromStatus: 'INTERRUPTED_RESUMABLE', toStatus: 'IN_PROGRESS', transitionType: 'RESUME', stateRevision: 'R0002', stateRevisionSealSha256: r2Sha }
  ];
}

/**
 * A gate whose R0002 is CLOSED, ledger-anchored, and seals EVIDENCE at its exact
 * current bytes. UNSEALED is a real file no authority names at all.
 */
export function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-seal-'));
  writeLedgerPrerequisites(root);
  writeJson(root, CONTRACT, { gateId: GATE, contractRevision: 'R0001' });
  writeJson(root, EVIDENCE, { gateId: GATE, verdict: 'CLOSED', evidence: 'sealed at R0002' });
  writeJson(root, UNSEALED, { gateId: GATE, note: 'named by no authority' });
  writeJson(root, `${R1}/CHECKPOINT.json`, { gateId: GATE, stateRevision: 'R0001', resumePoint: 'START' });
  writeJson(root, `${R1}/OPEN_DEFECTS.json`, { gateId: GATE, stateRevision: 'R0001', defects: [] });
  writeJson(root, `${R2}/CHECKPOINT.json`, { gateId: GATE, stateRevision: 'R0002', resumePoint: 'CLOSED' });
  writeJson(root, `${R2}/OPEN_DEFECTS.json`, { gateId: GATE, stateRevision: 'R0002', defects: [] });

  const contract = identity(root, CONTRACT);
  const r1Members = [identity(root, `${R1}/CHECKPOINT.json`), identity(root, `${R1}/OPEN_DEFECTS.json`), contract];
  const r1Sha = writeSeal(root, R1, sealDocument({
    stateRevision: 'R0001', members: r1Members, previousStateSealSha256: null,
    executionStatus: 'IN_PROGRESS', contractSha256: contract.sha256
  }));
  const r2Members = [identity(root, `${R2}/CHECKPOINT.json`), identity(root, `${R2}/OPEN_DEFECTS.json`), contract, identity(root, EVIDENCE)];
  const r2Sha = writeSeal(root, R2, sealDocument({
    stateRevision: 'R0002', members: r2Members, previousStateSealSha256: r1Sha,
    executionStatus: 'COMPLETE_AGENT', contractSha256: contract.sha256
  }));

  writeLedger(root, stateBindingsFor(r1Sha, r2Sha));
  return { root, r1Sha, r2Sha, contract };
}

/** Build a fixture, run the body against it, and always remove the temp root. */
export function run(body) {
  const fixture = makeFixture();
  try { body(fixture); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}
