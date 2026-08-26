#!/usr/bin/env node
/**
 * FINAL_GATE_INTEGRITY_AUDITOR — the independent final-byte audit, as a program.
 *
 * WHAT THIS EXISTS TO CLOSE. The final audits of GATE16 and GATE17 were done by
 * exporting the repository to a ZIP and re-inspecting it by hand: recomputing
 * SHA-256 values, counting cohort members, replaying the ledger chain, checking
 * that every sealed member still held its sealed bytes. That work found real
 * defects, and it cost most of an audit session each time. None of it required
 * judgement — every one of those checks is a comparison between a declared value
 * and the bytes on disk.
 *
 * WHAT IT REFUSES TO TRUST. The auditor derives truth from the FINAL repository
 * bytes and from Git, and from nothing else. In particular it does not read, and
 * cannot be satisfied by:
 *
 *   - an agent's PASS summary
 *   - a previously generated report claiming the Gate is closed
 *   - a cached or declared test result
 *   - a declared cohort count
 *   - a closure assertion in a checkpoint or matrix
 *
 * Every number it reports is recomputed here. Where a declared value exists it is
 * treated as a CLAIM to be checked against bytes, never as an input.
 *
 * INDEPENDENT FINDINGS STAY INDEPENDENT. A failing audit reports every blocking
 * finding it established, each with its own defectClass, path, expected, actual
 * and affected frontier. Collapsing several unrelated defects behind one generic
 * error is how a second and third defect survive a repair round, so it is not
 * done here.
 *
 * PRESTATE / SUCCESSOR SEMANTICS. The distinction proven during GATE16/GATE17 is
 * preserved: a member sealed BEFORE a transaction is immutable, while an artifact
 * that a transaction produced and its own successor revision sealed is a
 * transaction product, not a mutation of a pre-existing sealed member. The
 * auditor classifies the second case correctly instead of raising it as tampering.
 *
 * READ-ONLY. This program writes nothing inside the repository. It has no repair
 * path, no reseal path and no ledger access beyond reading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import {
  MODE_FULL, TRANSITIONS, NATIVE_STATE_PIN_FIRST_ORDINAL,
  HISTORICAL_RECONCILIATION_TRANSITIONS, CONTRACT_SUCCESSION_TRANSITIONS,
  PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITIONS,
  reconstructLedgerPrefixBytes, validateLedger
} from './validate-status-ledger.mjs';

/**
 * Every table a Gate transition may be admitted by: the closed I2 execution table
 * plus the narrow classes, each with its own table.
 *
 * WHY THIS REPLACED A NAME LIST. Narrow-class transitions used to be admitted by
 * TYPE NAME alone — `['HISTORICAL_RECONCILIATION', 'CONTRACT_SUCCESSION']
 * .includes(event.transitionType)` — which admitted ANY from/to pair carrying one of
 * those names. A reconciliation claiming NOT_STARTED -> COMPLETE_CONFIRMED was
 * admitted here on the strength of its type, even though the ledger validator's own
 * table would refuse it. Admission is now the same exact tuple test the execution
 * table already used, applied to every class: fromStatus, toStatus AND
 * transitionType must all match one declared entry.
 *
 * SCOPE OF THE CLAIM. This closes the type-only bypass for the classes named below,
 * which are all the classes that exist. It is NOT automatic discovery: a future
 * narrow class must be added to this list, exactly as it must be added to
 * TRANSITION_TYPES. That is deliberate — a class nobody declared here is refused
 * rather than silently admitted, so the failure mode of forgetting is fail-closed.
 */
const ADMISSION_TABLES = [
  TRANSITIONS,
  HISTORICAL_RECONCILIATION_TRANSITIONS,
  CONTRACT_SUCCESSION_TRANSITIONS,
  PRECONTRACT_CONSUMPTION_ANCHOR_TRANSITIONS
];

/** True only when some declared table holds this exact from/to/type tuple. */
function isAdmittedTransition(event) {
  return ADMISSION_TABLES.some((table) => table.some(([from, to, type]) =>
    from === event.fromStatus && to === event.toStatus && type === event.transitionType));
}
import { computeSealedMembersDigest, validateStateSeal } from './validate-state-seal.mjs';
import { validateStateRevision } from './validate-state-revision.mjs';
import { collectClosedStateSealMembers } from '../gee-v1/core/sealed-state-evidence.mjs';
import { deriveCanonicalAuthorizedCohort } from '../gee-v1/core/canonical-authorized-cohort.mjs';
import { deriveCurrentByteAuthorizationProofs, STATUS_AUTHORIZED } from '../gee-v1/core/current-byte-authorization.mjs';
import { evaluatePrecontractAnchorEnforcement } from './precontract-anchor-enforcement.mjs';
import { resolveDurableLifecycleRoot } from '../gee-v1/runtime/run-root-lifecycle.mjs';
import { evaluateDeferredCapabilityClosureDeclaration } from './evaluate-deferred-capability-closure-declaration.mjs';

export const AUDITOR_DOCUMENT = 'FINAL_GATE_INTEGRITY_AUDITOR';
export const AUDITOR_VERSION = 'R2';

const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';
const REGISTRY_PATH = 'governance/GATE_REGISTRY_00_40.json';
const ACTIVE_GATE_PATH = 'governance/active/ACTIVE_GATE.json';
const STATUS_SNAPSHOT_PATH = 'governance/state/generated/GATE_STATUS_SNAPSHOT.json';

const GATE_RE = /^GATE[0-9]{2}$/;
const REVISION_RE = /^R[0-9]{4}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

/**
 * The check families. Named so a finding can say which part of final integrity
 * it belongs to, and so a caller can see that a family ran at all rather than
 * inferring it from the absence of findings.
 */
export const CHECK_FAMILIES = Object.freeze([
  'GIT_COHORT', 'LIFECYCLE', 'LEDGER', 'STATE', 'AUTHORITY',
  'EVIDENCE', 'GENERATED', 'TEMP', 'GLOBAL_BOUNDARIES', 'DEFERRED_CAPABILITY'
]);

function repoPath(root, relativePath) { return path.resolve(root, ...relativePath.split('/')); }

function readBytesOrNull(root, relativePath) {
  const resolved = repoPath(root, relativePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved);
}

function readJsonOrNull(root, relativePath) {
  const bytes = readBytesOrNull(root, relativePath);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch { return null; }
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Historical-authority migrations, indexed by the exact bytes they retired.
 *
 * A mutable governed file — the Gate registry above all — is legitimately edited
 * after events have already cited it. The canonical answer to that is
 * REGISTRY_AUTHORITY_MIGRATIONS.ndjson: it pins the retired bytes into an
 * immutable snapshot, so an old event keeps naming exactly what it authorized
 * while the live file moves on.
 *
 * An auditor that compared every event against the LIVE file would report each of
 * those events as tampering. This resolves them instead — and does so by
 * VERIFYING the snapshot really holds the cited bytes, which is a stricter check
 * than the live comparison it replaces, not an exemption from it.
 */
export function loadAuthorityMigrations(root) {
  const bytes = readBytesOrNull(root, 'governance/authority/REGISTRY_AUTHORITY_MIGRATIONS.ndjson');
  const byOriginal = new Map();
  if (!bytes) return byOriginal;
  for (const line of bytes.toString('utf8').split('\n').filter((entry) => entry.trim())) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    byOriginal.set(`${record.originalAuthorityPath}|${record.originalAuthoritySha256}`, record);
  }
  return byOriginal;
}

/** Identity of a path as it actually is on disk, never as something declared it. */
export function actualIdentity(root, relativePath) {
  const bytes = readBytesOrNull(root, relativePath);
  if (!bytes) return { path: relativePath, present: false, sha256: null, byteLength: null };
  return { path: relativePath, present: true, sha256: sha256Bytes(bytes), byteLength: bytes.length };
}

function contractProjectionGenerators(root, gateId) {
  const current = readJsonOrNull(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`);
  const contractPath = current?.contractPath;
  if (typeof contractPath !== 'string' || !contractPath.startsWith('governance/') || contractPath.includes('..')) return [];
  const contract = readJsonOrNull(root, contractPath);
  return (Array.isArray(contract?.requiredOutputs) ? contract.requiredOutputs : [])
    .filter((output) => typeof output?.path === 'string' && output.path.startsWith('governance/')
      && output.path.startsWith('governance/tools/')
      && output.path.endsWith('.mjs') && /deterministic.*generator/i.test(output.role ?? ''))
    .map((output) => output.path);
}

function checkProjectionGenerator(root, generatorPath) {
  try {
    const stdout = execFileSync(process.execPath, [repoPath(root, generatorPath), '--root', root, '--check'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    });
    return { generatorPath, valid: true, report: stdout.trim() || null };
  } catch (error) {
    return { generatorPath, valid: false, detail: error.stdout?.toString('utf8') || error.stderr?.toString('utf8') || error.message };
  }
}

/* -------------------------------------------------------------------------
 * The audit
 * ---------------------------------------------------------------------- */

/**
 * Runs the audit for one Gate against the FINAL bytes of `root`.
 *
 * THE COHORT IS DERIVED HERE, NEVER SUPPLIED.
 *
 * This used to take `authorizedCohort` as an argument. That made a PASS
 * meaningless: a caller could pass the observed Git delta and "delta minus
 * cohort is empty" became true by construction. The historical GATE19 PASS was
 * produced exactly that way, and it could not have failed.
 *
 * The cohort is now derived from canonical authority documents — authority to
 * manifest to consumption record — by `deriveCanonicalAuthorizedCohort`, which
 * cannot read Git at all. There is no fallback, no union with the observed
 * delta, and no way to top up a thin cohort from what happens to be on disk.
 *
 * `authorizedCohort` survives only as a CROSS-CHECK. When supplied it must equal
 * the derived cohort exactly; any disagreement is blocking, in both directions.
 * Setting it equal to the Git delta therefore no longer manufactures a PASS — it
 * manufactures a mismatch against the derivation.
 */
export function auditFinalGateIntegrity({
  root,
  gateId,
  authorizedCohort = null,
  baselineCommit = null,
  expectNotStartedFrom = null,
  externalReinspectionReport = null,
  requiredEvidencePaths = [],
  now = new Date()
} = {}) {
  const findings = [];
  const familiesRun = new Set();

  /**
   * Records one blocking finding. `affectedFrontier` names what a repair would
   * have to revalidate, so a repair round knows its own scope instead of
   * rerunning everything or guessing.
   */
  const blocking = (family, defectClass, detail) => {
    familiesRun.add(family);
    findings.push({
      family,
      defectClass,
      path: detail.path ?? null,
      expected: detail.expected ?? null,
      actual: detail.actual ?? null,
      affectedFrontier: detail.affectedFrontier ?? family,
      message: detail.message ?? null
    });
  };
  const ran = (family) => { familiesRun.add(family); };

  if (!GATE_RE.test(gateId || '')) {
    return finalize({ root, gateId, findings: [{
      family: 'LIFECYCLE', defectClass: 'GATE_ID_INVALID', path: null,
      expected: 'GATEnn', actual: gateId, affectedFrontier: 'LIFECYCLE', message: null
    }], familiesRun: new Set(['LIFECYCLE']), observations: {}, now });
  }

  /* ---- LEDGER: replay from the real bytes ------------------------------ */
  ran('LEDGER');
  const ledgerBytes = readBytesOrNull(root, LEDGER_PATH);
  if (!ledgerBytes) {
    blocking('LEDGER', 'LEDGER_ABSENT', { path: LEDGER_PATH, expected: 'existing NDJSON ledger', actual: 'ABSENT' });
    return finalize({ root, gateId, findings, familiesRun, observations: {}, now });
  }
  const ledgerText = ledgerBytes.toString('utf8');
  const ledgerLines = ledgerText.split('\n');
  if (ledgerLines.at(-1) === '') ledgerLines.pop();

  const events = [];
  for (const [index, line] of ledgerLines.entries()) {
    const lineNumber = index + 1;
    if (line.endsWith('\r')) {
      blocking('LEDGER', 'LEDGER_LINE_NOT_LF', { path: LEDGER_PATH, expected: 'LF line ending', actual: `CRLF at line ${lineNumber}` });
    }
    let event;
    try { event = JSON.parse(line); } catch {
      blocking('LEDGER', 'LEDGER_LINE_NOT_JSON', { path: LEDGER_PATH, expected: 'one JSON object per line', actual: `line ${lineNumber}` });
      continue;
    }
    // Canonical bytes: the line must BE the canonical serialization, not merely
    // parse to an equivalent object. Anything else means the bytes were edited.
    if (canonicalize(event) !== line) {
      blocking('LEDGER', 'LEDGER_EVENT_NOT_CANONICAL', {
        path: LEDGER_PATH, expected: 'canonical JSON serialization', actual: `line ${lineNumber} (${event.eventId ?? 'unknown'})`
      });
    }
    // Ordinal must equal line position.
    if (event.ordinal !== lineNumber) {
      blocking('LEDGER', 'LEDGER_ORDINAL_MISPLACED', {
        path: LEDGER_PATH, expected: `ordinal ${lineNumber}`, actual: event.ordinal
      });
    }
    // previousEventSha256 must chain the preceding line's payload digest.
    const expectedPrevious = index === 0 ? null : events[index - 1]?.eventPayloadSha256 ?? null;
    if (event.previousEventSha256 !== expectedPrevious) {
      blocking('LEDGER', 'LEDGER_CHAIN_BREAK', {
        path: LEDGER_PATH, expected: expectedPrevious, actual: event.previousEventSha256,
        message: `event ${event.eventId ?? lineNumber} does not chain its predecessor`
      });
    }
    // The payload digest must be recomputable from the event's own bytes.
    const payload = { ...event };
    delete payload.eventPayloadSha256;
    const recomputed = sha256Canonical(payload);
    if (event.eventPayloadSha256 !== recomputed) {
      blocking('LEDGER', 'LEDGER_EVENT_PAYLOAD_HASH_MISMATCH', {
        path: LEDGER_PATH, expected: recomputed, actual: event.eventPayloadSha256,
        message: `event ${event.eventId ?? lineNumber}`
      });
    }
    // The native state pin boundary is enforced in both directions.
    const hasPin = Object.hasOwn(event, 'stateRevision') || Object.hasOwn(event, 'stateRevisionSealSha256');
    if (event.ordinal >= NATIVE_STATE_PIN_FIRST_ORDINAL && !hasPin) {
      blocking('LEDGER', 'NATIVE_STATE_PIN_MISSING', {
        path: LEDGER_PATH, expected: 'stateRevision + stateRevisionSealSha256', actual: 'ABSENT',
        message: `ordinal ${event.ordinal}`
      });
    }
    if (event.ordinal < NATIVE_STATE_PIN_FIRST_ORDINAL && hasPin) {
      blocking('LEDGER', 'NATIVE_STATE_PIN_RETROFITTED', {
        path: LEDGER_PATH, expected: 'no state pin before the native era', actual: 'PRESENT',
        message: `ordinal ${event.ordinal}`
      });
    }
    events.push(event);
  }

  const duplicateIds = new Set();
  const seenIds = new Set();
  for (const event of events) {
    if (seenIds.has(event.eventId)) duplicateIds.add(event.eventId);
    seenIds.add(event.eventId);
  }
  for (const duplicate of duplicateIds) {
    blocking('LEDGER', 'LEDGER_DUPLICATE_EVENT_ID', { path: LEDGER_PATH, expected: 'unique eventId', actual: duplicate });
  }

  /* ---- LEDGER: historical prefix N reconstructs inside N+k -------------- */
  //
  // The property that mattered most on GATE16/GATE17: an immutable historical
  // prefix must still validate INSIDE the current, longer ledger. Any prefix
  // whose reconstruction changed means history was rewritten under a later event.
  const prefixProbes = [];
  for (const throughOrdinal of [1, Math.floor(events.length / 2), events.length - 1, events.length].filter((value, index, list) =>
    value >= 1 && value <= events.length && list.indexOf(value) === index)) {
    try {
      const prefixBytes = reconstructLedgerPrefixBytes(repoPath(root, LEDGER_PATH), throughOrdinal);
      const expectedBytes = Buffer.from(`${ledgerLines.slice(0, throughOrdinal).join('\n')}\n`, 'utf8');
      const agrees = Buffer.compare(Buffer.from(prefixBytes), expectedBytes) === 0;
      prefixProbes.push({ throughOrdinal, sha256: sha256Bytes(Buffer.from(prefixBytes)), agrees });
      if (!agrees) {
        blocking('LEDGER', 'HISTORICAL_PREFIX_NOT_RECONSTRUCTIBLE', {
          path: LEDGER_PATH,
          expected: `prefix through ordinal ${throughOrdinal} reconstructs byte-identically`,
          actual: 'MISMATCH',
          affectedFrontier: 'LEDGER'
        });
      }
    } catch (error) {
      blocking('LEDGER', 'HISTORICAL_PREFIX_UNRECONSTRUCTIBLE', {
        path: LEDGER_PATH, expected: `prefix through ordinal ${throughOrdinal}`, actual: error.message
      });
    }
  }

  /* ---- LIFECYCLE: status derived from the ledger ------------------------ */
  ran('LIFECYCLE');
  const statusByGate = new Map();
  for (const event of events) if (GATE_RE.test(event.gateId || '')) statusByGate.set(event.gateId, event.toStatus);
  const gateEvents = events.filter((event) => event.gateId === gateId);
  const derivedStatus = statusByGate.get(gateId) ?? 'ABSENT';

  // Transition order must be admitted by a canonical table, walked forward. Every
  // class is judged on the full tuple; no transition type is admitted by name.
  let walked = null;
  for (const event of gateEvents) {
    const admitted = isAdmittedTransition(event);
    if (!admitted) {
      blocking('LIFECYCLE', 'TRANSITION_NOT_ADMITTED', {
        path: LEDGER_PATH,
        expected: 'an exact from/to/type tuple present in a canonical transition table',
        actual: `${event.fromStatus}>${event.toStatus}:${event.transitionType}`,
        message: event.eventId
      });
    }
    if (walked !== null && event.fromStatus !== walked) {
      blocking('LIFECYCLE', 'TRANSITION_FROM_STATUS_DISAGREES_WITH_REPLAY', {
        path: LEDGER_PATH, expected: walked, actual: event.fromStatus, message: event.eventId
      });
    }
    walked = event.toStatus;
  }

  // Duplicate lifecycle transitions for this Gate.
  const transitionCounts = new Map();
  for (const event of gateEvents) {
    transitionCounts.set(event.transitionType, (transitionCounts.get(event.transitionType) || 0) + 1);
  }
  for (const [transitionType, count] of transitionCounts) {
    if (count > 1 && ['AUTHORIZATION', 'START', 'AGENT_CLOSURE', 'EXTERNAL_CONFIRMATION'].includes(transitionType)) {
      blocking('LIFECYCLE', 'DUPLICATE_LIFECYCLE_TRANSITION', {
        path: LEDGER_PATH, expected: `exactly one ${transitionType} for ${gateId}`, actual: count
      });
    }
  }

  /* ---- STATE: CURRENT_STATE, lineage, and every seal -------------------- */
  ran('STATE');
  const currentStatePath = `governance/gates/${gateId}/state/CURRENT_STATE.json`;
  const currentState = readJsonOrNull(root, currentStatePath);
  const revisionsRoot = `governance/gates/${gateId}/state/revisions`;
  const revisionNames = fs.existsSync(repoPath(root, revisionsRoot))
    ? fs.readdirSync(repoPath(root, revisionsRoot), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && REVISION_RE.test(entry.name))
        .map((entry) => entry.name).sort()
    : [];

  if (!currentState) {
    blocking('STATE', 'CURRENT_STATE_ABSENT', { path: currentStatePath, expected: 'existing CURRENT_STATE.json', actual: 'ABSENT' });
  } else {
    // The ledger's own pin is the authority on which revision is current.
    const pinned = [...gateEvents].reverse().find((event) => typeof event.stateRevision === 'string') ?? null;
    if (pinned && currentState.stateRevision !== pinned.stateRevision) {
      blocking('STATE', 'CURRENT_STATE_DISAGREES_WITH_LEDGER_PIN', {
        path: currentStatePath, expected: pinned.stateRevision, actual: currentState.stateRevision
      });
    }
    if (pinned && currentState.stateSealSha256 !== pinned.stateRevisionSealSha256) {
      blocking('STATE', 'CURRENT_STATE_SEAL_DISAGREES_WITH_LEDGER_PIN', {
        path: currentStatePath, expected: pinned.stateRevisionSealSha256, actual: currentState.stateSealSha256
      });
    }
    // And the seal digest must match the seal file's ACTUAL bytes.
    const sealIdentity = actualIdentity(root, `${revisionsRoot}/${currentState.stateRevision}/STATE_SEAL.json`);
    if (!sealIdentity.present) {
      blocking('STATE', 'CURRENT_STATE_SEAL_FILE_ABSENT', {
        path: `${revisionsRoot}/${currentState.stateRevision}/STATE_SEAL.json`, expected: 'existing seal', actual: 'ABSENT'
      });
    } else if (sealIdentity.sha256 !== currentState.stateSealSha256) {
      blocking('STATE', 'CURRENT_STATE_SEAL_SHA_MISMATCH', {
        path: currentStatePath, expected: sealIdentity.sha256, actual: currentState.stateSealSha256
      });
    }
  }

  // Revision numbering must be contiguous from R0001.
  for (const [index, name] of revisionNames.entries()) {
    if (name !== `R${String(index + 1).padStart(4, '0')}`) {
      blocking('STATE', 'REVISION_SEQUENCE_GAP', {
        path: revisionsRoot, expected: `R${String(index + 1).padStart(4, '0')}`, actual: name
      });
    }
  }

  // Every seal: schema, chain, payload digest, member set digest, and every
  // sealed member's ACTUAL sha256 and byteLength.
  const sealAudits = [];
  for (const revision of revisionNames) {
    const sealRelative = `${revisionsRoot}/${revision}/STATE_SEAL.json`;
    const sealBytes = readBytesOrNull(root, sealRelative);
    if (!sealBytes) {
      blocking('STATE', 'STATE_SEAL_ABSENT', { path: sealRelative, expected: 'existing STATE_SEAL.json', actual: 'ABSENT' });
      continue;
    }
    const seal = JSON.parse(sealBytes.toString('utf8'));
    const report = validateStateSeal({ root, sealPath: repoPath(root, sealRelative) });
    if (!report.valid) {
      for (const item of report.findings) {
        blocking('STATE', 'STATE_SEAL_INVALID', {
          path: sealRelative, expected: item.expectedRule ?? null, actual: item.actualValue ?? null,
          message: `${item.detectorId}: ${item.message}`
        });
      }
    }
    // Recomputed here as well as by the validator: the audit's own arithmetic,
    // not a second reading of the validator's answer.
    const recomputedPayload = sha256Canonical(seal.payload);
    if (seal.payloadSha256 !== recomputedPayload) {
      blocking('STATE', 'SEAL_PAYLOAD_HASH_MISMATCH', {
        path: sealRelative, expected: recomputedPayload, actual: seal.payloadSha256
      });
    }
    if (Object.hasOwn(seal.payload ?? {}, 'sealedMembersDigest')) {
      const recomputedMembers = computeSealedMembersDigest(seal.sealedMembers);
      if (seal.payload.sealedMembersDigest !== recomputedMembers) {
        blocking('STATE', 'SEALED_MEMBERS_DIGEST_MISMATCH', {
          path: sealRelative, expected: recomputedMembers, actual: seal.payload.sealedMembersDigest
        });
      }
    }
    // Seal chain.
    const ordinal = Number.parseInt(revision.slice(1), 10);
    if (ordinal === 1 && seal.previousStateSealSha256 !== null) {
      blocking('STATE', 'SEAL_CHAIN_ROOT_NOT_NULL', {
        path: sealRelative, expected: null, actual: seal.previousStateSealSha256
      });
    }
    if (ordinal > 1) {
      const previousRelative = `${revisionsRoot}/R${String(ordinal - 1).padStart(4, '0')}/STATE_SEAL.json`;
      const previousIdentity = actualIdentity(root, previousRelative);
      if (previousIdentity.sha256 !== seal.previousStateSealSha256) {
        blocking('STATE', 'SEAL_CHAIN_BREAK', {
          path: sealRelative, expected: previousIdentity.sha256, actual: seal.previousStateSealSha256
        });
      }
    }

    // Sealed members, against real bytes. A member of a SUPERSEDED revision that
    // is a mutable projection (CURRENT_STATE / CURRENT_CONTRACT) legitimately no
    // longer holds its sealed bytes; every immutable member always must.
    const isCurrentRevision = currentState?.stateRevision === revision;
    const memberResults = [];
    for (const member of seal.sealedMembers ?? []) {
      const identity = actualIdentity(root, member.repoRelativePath);
      const isMutableProjection = member.repoRelativePath.endsWith('/CURRENT_STATE.json')
        || member.repoRelativePath.endsWith('/CURRENT_CONTRACT.json');
      const historicalProjection = !isCurrentRevision && isMutableProjection;
      const matches = identity.present
        && identity.sha256 === member.sha256
        && identity.byteLength === member.byteLength;
      memberResults.push({
        path: member.repoRelativePath, sealedSha256: member.sha256, actualSha256: identity.sha256,
        sealedByteLength: member.byteLength, actualByteLength: identity.byteLength,
        matches, historicalProjection
      });
      if (!identity.present && !historicalProjection) {
        blocking('STATE', 'SEALED_MEMBER_ABSENT', {
          path: member.repoRelativePath, expected: 'existing regular file', actual: 'ABSENT',
          message: `sealed by ${sealRelative}`
        });
        continue;
      }
      if (!matches && !historicalProjection) {
        blocking('STATE', 'SEALED_MEMBER_BYTES_CHANGED', {
          path: member.repoRelativePath,
          expected: { sha256: member.sha256, byteLength: member.byteLength },
          actual: { sha256: identity.sha256, byteLength: identity.byteLength },
          message: `sealed by ${sealRelative}`,
          affectedFrontier: 'STATE'
        });
      }
    }
    sealAudits.push({
      revision, sealPath: sealRelative, sealSha256: sha256Bytes(sealBytes),
      executionStatus: seal.payload?.executionStatus ?? null,
      memberCount: memberResults.length,
      members: memberResults
    });
  }

  // The gate-level revision validator, consumed rather than reimplemented.
  let revisionReportValid = null;
  try {
    const revisionReport = validateStateRevision({
      root, gateId,
      currentStatePath: repoPath(root, currentStatePath),
      contractPath: repoPath(root, `governance/gates/${gateId}/contracts/CURRENT_CONTRACT.json`)
    });
    revisionReportValid = revisionReport.valid;
    if (!revisionReport.valid) {
      for (const item of revisionReport.findings ?? []) {
        blocking('STATE', 'STATE_REVISION_INVALID', {
          path: currentStatePath, expected: item.expectedRule ?? null, actual: item.actualValue ?? null,
          message: `${item.detectorId ?? ''}: ${item.message ?? ''}`.trim()
        });
      }
    }
  } catch (error) {
    blocking('STATE', 'STATE_REVISION_UNVALIDATABLE', { path: currentStatePath, expected: 'validator completes', actual: error.message });
  }


  /* ---- DEFERRED_CAPABILITY: prospective structured closure registration -- */
  ran('DEFERRED_CAPABILITY');
  const deferredCapability = evaluateDeferredCapabilityClosureDeclaration({
    root,
    gateId,
    derivedStatus,
    stateRevision: currentState?.stateRevision ?? null
  });
  for (const item of deferredCapability.findings ?? []) {
    blocking('DEFERRED_CAPABILITY', item.code, {
      path: item.path ?? null,
      expected: item.expected ?? null,
      actual: item.actual ?? null,
      message: item.message ?? null,
      affectedFrontier: 'DEFERRED_CAPABILITY'
    });
  }

  /* ---- AUTHORITY: shape, binding, consumption --------------------------- */
  ran('AUTHORITY');
  const migrations = loadAuthorityMigrations(root);
  const authorityAudits = [];
  for (const event of gateEvents) {
    const identity = actualIdentity(root, event.authorityPath);
    // An authorityPath that names no file is a LOGICAL id resolved through the
    // ledger's source map. That is legitimate, and is reported as such rather
    // than being scored as a missing file.
    if (!identity.present) {
      authorityAudits.push({ eventId: event.eventId, authorityPath: event.authorityPath, kind: 'LOGICAL_IDENTIFIER', matches: null });
      continue;
    }
    if (identity.sha256 === event.authoritySha256) {
      authorityAudits.push({ eventId: event.eventId, authorityPath: event.authorityPath, kind: 'REPOSITORY_FILE', matches: true, actualSha256: identity.sha256 });
      continue;
    }

    // The live file disagrees. Before calling that tampering, ask whether the
    // cited bytes were lawfully retired into an immutable snapshot — and if so,
    // prove the snapshot actually holds them.
    const migration = migrations.get(`${event.authorityPath}|${event.authoritySha256}`);
    if (!migration) {
      authorityAudits.push({ eventId: event.eventId, authorityPath: event.authorityPath, kind: 'REPOSITORY_FILE', matches: false, actualSha256: identity.sha256 });
      blocking('AUTHORITY', 'AUTHORITY_BYTES_DISAGREE_WITH_EVENT', {
        path: event.authorityPath, expected: event.authoritySha256, actual: identity.sha256,
        message: `cited by ${event.eventId}, and no migration record retires those bytes`,
        affectedFrontier: 'AUTHORITY'
      });
      continue;
    }
    const snapshotIdentity = actualIdentity(root, migration.snapshotPath);
    const snapshotHoldsCitedBytes = snapshotIdentity.present
      && snapshotIdentity.sha256 === event.authoritySha256
      && migration.snapshotSha256 === event.authoritySha256;
    authorityAudits.push({
      eventId: event.eventId, authorityPath: event.authorityPath, kind: 'MIGRATED_HISTORICAL_AUTHORITY',
      migrationId: migration.migrationId, snapshotPath: migration.snapshotPath,
      matches: snapshotHoldsCitedBytes, actualSha256: snapshotIdentity.sha256
    });
    if (!snapshotHoldsCitedBytes) {
      blocking('AUTHORITY', 'MIGRATED_AUTHORITY_SNAPSHOT_DOES_NOT_HOLD_CITED_BYTES', {
        path: migration.snapshotPath, expected: event.authoritySha256, actual: snapshotIdentity.sha256 ?? 'ABSENT',
        message: `${event.eventId} cites bytes retired by ${migration.migrationId}`,
        affectedFrontier: 'AUTHORITY'
      });
    }
  }

  // The external reinspection report, when the caller declares one.
  if (externalReinspectionReport) {
    const identity = actualIdentity(root, externalReinspectionReport.path);
    if (!identity.present) {
      blocking('AUTHORITY', 'EXTERNAL_REINSPECTION_REPORT_ABSENT', {
        path: externalReinspectionReport.path, expected: 'existing report', actual: 'ABSENT'
      });
    } else if (externalReinspectionReport.sha256 && identity.sha256 !== externalReinspectionReport.sha256) {
      blocking('AUTHORITY', 'EXTERNAL_REINSPECTION_REPORT_SHA_MISMATCH', {
        path: externalReinspectionReport.path, expected: externalReinspectionReport.sha256, actual: identity.sha256
      });
    }
  }

  /* ---- AUTHORITY: precontract consumption must still be anchored --------- */
  //
  // WHY A FINAL AUDIT HAS TO ASK THIS. Every other authority obligation in this
  // family is checked against bytes that stand still. A precontract receipt is
  // different: it was proven against the pre-state its bootstrap ran at, and the
  // Gate's own lifecycle then moves that pre-state. Anchoring the receipt in the
  // append-only ledger is what makes the proof survive its own Gate; without the
  // anchor the receipt silently stops verifying while every stationary check
  // still passes. That is exactly the state this repository was in — FGI PASS
  // over a Gate whose VERIFY_CONSUMPTION said BLOCKED — and a final audit that
  // can hold that combination is reporting the wrong answer, not a lenient one.
  //
  // The verdict is NOT recomputed here. It is delegated to the same canonical
  // consumer the standalone validator uses, so this auditor cannot drift into a
  // second, more forgiving definition of "anchored" than the one that blocks.
  const precontractAnchor = evaluatePrecontractAnchorEnforcement({ root, gateId });
  if (precontractAnchor.applicable && !precontractAnchor.anchored) {
    blocking('AUTHORITY', precontractAnchor.findings[0]?.code ?? 'PRECONTRACT_CONSUMPTION_NOT_ANCHORED', {
      path: precontractAnchor.authorityPath,
      expected: 'VERIFY_CONSUMPTION reports CONSUMED for the anchored receipt',
      actual: JSON.stringify(precontractAnchor.findings[0]?.detail ?? []),
      message: `${gateId} consumed a precontract receipt that is not anchored in the append-only ledger; remediate with ${precontractAnchor.remediation}`,
      affectedFrontier: 'AUTHORITY'
    });
  }

  /* ---- PRESTATE / SUCCESSOR sealed-member classification ---------------- */
  const closedInventory = collectClosedStateSealMembers(root);
  const closedByPath = new Map();
  for (const member of closedInventory.members ?? []) {
    if (!closedByPath.has(member.repoRelativePath)) closedByPath.set(member.repoRelativePath, []);
    closedByPath.get(member.repoRelativePath).push(member);
  }
  for (const inventoryFinding of closedInventory.findings ?? []) {
    blocking('STATE', 'CLOSED_SEAL_INVENTORY_INVALID', {
      path: null, expected: 'consistent closed-seal inventory', actual: JSON.stringify(inventoryFinding)
    });
  }

  /* ---- EVIDENCE: existence, provenance, honest reusability -------------- */
  ran('EVIDENCE');
  const evidenceAudits = [];
  for (const relativePath of requiredEvidencePaths) {
    const identity = actualIdentity(root, relativePath);
    evidenceAudits.push(identity);
    if (!identity.present) {
      blocking('EVIDENCE', 'REQUIRED_EVIDENCE_ABSENT', {
        path: relativePath, expected: 'existing evidence artifact', actual: 'ABSENT', affectedFrontier: 'EVIDENCE'
      });
    }
  }

  // Reusability claims inside every revision checkpoint are checked against the
  // bytes they name. A claim whose declared input has moved is STALE, and must
  // not still be advertised as currently reusable.
  const staleReuseClaims = [];
  for (const revision of revisionNames) {
    const checkpointRelative = `${revisionsRoot}/${revision}/CHECKPOINT.json`;
    const checkpoint = readJsonOrNull(root, checkpointRelative);
    if (!checkpoint) continue;
    for (const claim of Array.isArray(checkpoint.reusableEvidence) ? checkpoint.reusableEvidence : []) {
      // Historical checkpoints record reusable evidence as bare identifiers;
      // only a claim that names a PATH and a digest can be checked against bytes.
      if (typeof claim !== 'object' || claim === null || typeof claim.path !== 'string') continue;
      const identity = actualIdentity(root, claim.path);
      const stillTrue = identity.present && (!claim.sha256 || identity.sha256 === claim.sha256);
      if (!stillTrue) {
        staleReuseClaims.push({ revision, path: claim.path, declared: claim.sha256 ?? null, actual: identity.sha256 });
        blocking('EVIDENCE', 'STALE_EVIDENCE_ADVERTISED_AS_REUSABLE', {
          path: claim.path, expected: claim.sha256 ?? 'present', actual: identity.sha256 ?? 'ABSENT',
          message: `declared reusable by ${checkpointRelative}`, affectedFrontier: 'EVIDENCE'
        });
      }
    }
    // The mirror-image obligation: historical sealed evidence must NOT have been
    // rewritten merely because it went stale. An entry listed as invalidated
    // must still hold the exact bytes its own record names.
    for (const claim of Array.isArray(checkpoint.invalidatedEvidence) ? checkpoint.invalidatedEvidence : []) {
      if (typeof claim !== 'object' || claim === null || typeof claim.path !== 'string' || !SHA256_RE.test(claim.sha256 ?? '')) continue;
      const identity = actualIdentity(root, claim.path);
      if (identity.present && identity.sha256 !== claim.sha256) {
        blocking('EVIDENCE', 'HISTORICAL_EVIDENCE_REWRITTEN_AFTER_INVALIDATION', {
          path: claim.path, expected: claim.sha256, actual: identity.sha256,
          message: `preserved-invalidated evidence recorded by ${checkpointRelative}`, affectedFrontier: 'EVIDENCE'
        });
      }
    }
    // protectedHashes are explicit byte claims and are checked directly.
    for (const claim of Array.isArray(checkpoint.protectedHashes) ? checkpoint.protectedHashes : []) {
      if (typeof claim !== 'object' || claim === null || typeof claim.path !== 'string') continue;
      const identity = actualIdentity(root, claim.path);
      if (!identity.present) {
        blocking('EVIDENCE', 'PROTECTED_HASH_TARGET_ABSENT', {
          path: claim.path, expected: claim.sha256, actual: 'ABSENT', message: `protected by ${checkpointRelative}`
        });
      } else if (identity.sha256 !== claim.sha256) {
        blocking('EVIDENCE', 'PROTECTED_HASH_MISMATCH', {
          path: claim.path, expected: claim.sha256, actual: identity.sha256,
          message: `protected by ${checkpointRelative}`, affectedFrontier: 'EVIDENCE'
        });
      }
    }
  }

  /* ---- GENERATED: projections must reflect the final ledger ------------- */
  ran('GENERATED');
  const snapshot = readJsonOrNull(root, STATUS_SNAPSHOT_PATH);
  const generatedAudit = { snapshotPresent: snapshot !== null, declaredLedgerEventCount: null, actualLedgerEventCount: events.length, generatorChecks: [] };
  if (snapshot) {
    const declaredCount = snapshot.ledgerEventCount ?? snapshot.eventCount ?? null;
    generatedAudit.declaredLedgerEventCount = declaredCount;
    if (declaredCount !== null && declaredCount !== events.length) {
      blocking('GENERATED', 'GENERATED_PROJECTION_STALE', {
        path: STATUS_SNAPSHOT_PATH, expected: events.length, actual: declaredCount,
        message: 'status snapshot was not regenerated after the final ledger mutation',
        affectedFrontier: 'GENERATED'
      });
    }
    const declaredStatus = snapshot.gates?.[gateId]?.status
      ?? (Array.isArray(snapshot.gates) ? snapshot.gates.find((entry) => entry.gateId === gateId)?.status : undefined);
    if (declaredStatus !== undefined && declaredStatus !== derivedStatus) {
      blocking('GENERATED', 'GENERATED_PROJECTION_STATUS_STALE', {
        path: STATUS_SNAPSHOT_PATH, expected: derivedStatus, actual: declaredStatus, affectedFrontier: 'GENERATED'
      });
    }
  }
  const projectionGenerators = ['governance/tools/generate-status-snapshot.mjs', ...contractProjectionGenerators(root, gateId)];
  for (const generatorPath of [...new Set(projectionGenerators)]) {
    const check = checkProjectionGenerator(root, generatorPath);
    generatedAudit.generatorChecks.push(check);
    if (!check.valid) {
      blocking('GENERATED', 'GENERATED_PROJECTION_DRIFT', {
        path: generatorPath,
        expected: 'deterministic generator --check returns current output bytes',
        actual: check.detail,
        affectedFrontier: 'GENERATED'
      });
    }
  }

  /* ---- GIT / COHORT ----------------------------------------------------- */
  ran('GIT_COHORT');
  // The cohort, derived from authority documents before Git is consulted at all.
  const derivedCohort = deriveCanonicalAuthorizedCohort({ root, gateId });
  const canonicalCohort = derivedCohort.cohort;
  if (!derivedCohort.valid) {
    for (const item of derivedCohort.findings) {
      blocking('GIT_COHORT', 'CANONICAL_COHORT_DERIVATION_INVALID', {
        path: null, expected: 'every authority source resolves to a valid manifest and consumption record',
        actual: item.detail ?? item.code, affectedFrontier: 'GIT_COHORT'
      });
    }
  }
  if (canonicalCohort.length === 0) {
    blocking('GIT_COHORT', 'CANONICAL_COHORT_EMPTY', {
      path: null, expected: 'a non-empty authority-derived cohort', actual: 0, affectedFrontier: 'GIT_COHORT'
    });
  }
  // The supplied list is a claim about the derivation, not a source of authority.
  if (authorizedCohort) {
    const supplied = [...new Set(authorizedCohort)].sort();
    const derivedSet = new Set(canonicalCohort);
    const suppliedSet = new Set(supplied);
    for (const relativePath of supplied.filter((entry) => !derivedSet.has(entry))) {
      blocking('GIT_COHORT', 'SUPPLIED_COHORT_PATH_NOT_CANONICALLY_AUTHORIZED', {
        path: relativePath, expected: 'present in the authority-derived cohort',
        actual: 'supplied by caller only', affectedFrontier: 'GIT_COHORT'
      });
    }
    for (const relativePath of canonicalCohort.filter((entry) => !suppliedSet.has(entry))) {
      blocking('GIT_COHORT', 'SUPPLIED_COHORT_OMITS_CANONICAL_PATH', {
        path: relativePath, expected: 'present in the supplied cohort',
        actual: 'ABSENT', affectedFrontier: 'GIT_COHORT'
      });
    }
  }

  const gitAudit = {
    headResolved: false, head: null,
    cohortSource: 'CANONICAL_AUTHORITY_DERIVATION',
    cohortCrossCheckRequested: authorizedCohort !== null,
    canonicalCohort: {
      algorithmVersion: derivedCohort.algorithmVersion,
      digest: derivedCohort.cohortDigest,
      pathCount: canonicalCohort.length,
      refusedSources: derivedCohort.refusedSources,
      sources: derivedCohort.sources
    }
  };
  try {
    gitAudit.head = git(root, ['rev-parse', 'HEAD']).trim();
    gitAudit.headResolved = true;
    // -uall, not the default. Plain `--porcelain` collapses an untracked
    // directory into a single trailing-slash entry, so a cohort that names the
    // files inside a NEW directory can never be compared file by file: each
    // authorized file reads as absent from the delta while the directory reads
    // as one unauthorized path. That reduces the exact-cohort proof to
    // directory granularity in exactly the place a Gate's own new artifacts
    // live. Listing every untracked file makes the comparison exact, and it can
    // only ever report MORE paths than before, never fewer.
    gitAudit.status = git(root, ['status', '--porcelain', '-uall'])
      .split(/\r?\n/).filter(Boolean)
      .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
    if (baselineCommit) {
      const delta = git(root, ['diff', '--name-only', `${baselineCommit}..HEAD`]).split(/\r?\n/).filter(Boolean);
      gitAudit.committedDelta = delta;
    }
  } catch (error) {
    blocking('GIT_COHORT', 'GIT_UNAVAILABLE', { path: null, expected: 'git repository', actual: error.message });
  }

  // The comparison runs unconditionally now. It used to be gated on a supplied
  // cohort, so omitting `--cohort` silently skipped the exact-cohort proof
  // entirely; the derivation is always available, so there is nothing to skip.
  if (gitAudit.headResolved) {
    const tracked = new Set(gitAudit.status.filter((entry) => entry.code !== '??').map((entry) => entry.path));
    const untracked = new Set(gitAudit.status.filter((entry) => entry.code === '??').map((entry) => entry.path));
    const actuallyChanged = new Set([...tracked, ...untracked, ...(gitAudit.committedDelta ?? [])]);
    const byteIdenticalAuthorized = [];
    const missing = [];
    for (const relativePath of canonicalCohort) {
      if (actuallyChanged.has(relativePath)) continue;
      // AUTHORIZED BUT NOT IN THE GIT DELTA IS NOT AUTOMATICALLY A DEFECT.
      // A path can be authorized and end up byte-identical to what is already
      // committed, which produces no delta at all. That case is reported as
      // byte-identical rather than blocked; a path that does not exist at all is
      // a real gap.
      if (actualIdentity(root, relativePath).present) byteIdenticalAuthorized.push(relativePath);
      else missing.push(relativePath);
    }
    for (const relativePath of missing) {
      blocking('GIT_COHORT', 'AUTHORIZED_PATH_ABSENT', {
        path: relativePath, expected: 'present in the working tree', actual: 'ABSENT', affectedFrontier: 'GIT_COHORT'
      });
    }
    gitAudit.authorizedCount = canonicalCohort.length;
    gitAudit.actualChanged = [...actuallyChanged].sort();
    gitAudit.byteIdenticalAuthorized = byteIdenticalAuthorized;
    gitAudit.cohortIdentities = canonicalCohort.map((relativePath) => actualIdentity(root, relativePath));
    for (const relativePath of [...actuallyChanged].filter((entry) => !canonicalCohort.includes(entry)).sort()) {
      blocking('GIT_COHORT', 'UNEXPECTED_GIT_DELTA', {
        path: relativePath,
        expected: 'path listed in the authorized cohort',
        actual: 'changed outside authorized cohort',
        affectedFrontier: 'GIT_COHORT'
      });
    }

    // A PATH BEING AUTHORIZED IS NOT THE SAME AS ITS CURRENT BYTES BEING AUTHORIZED.
    //
    // Everything above proves set membership: the delta is a subset of the paths
    // some authority permitted a program to touch. That was the whole proof, and it
    // silently granted every previously-authorized path a PERMANENT licence — write
    // anything to it afterwards, under no authority at all, and the audit still
    // passed because the path was still in the cohort.
    //
    // The second half of the proof is asked here: for each path that actually
    // changed, do the bytes it holds RIGHT NOW correspond to the applicable
    // authorized publication that binds exactly those bytes? The two questions are
    // kept separate on purpose — the cohort remains a useful bounded path set, and
    // this adds the byte-level obligation on top of it rather than replacing it.
    //
    // Only paths inside the cohort are asked. One outside it has already blocked as
    // UNEXPECTED_GIT_DELTA, and reporting it twice would say nothing new.
    const changedInsideCohort = [...actuallyChanged].filter((entry) => canonicalCohort.includes(entry)).sort();
    const currentByte = deriveCurrentByteAuthorizationProofs({ root, gateId, paths: changedInsideCohort });
    gitAudit.currentByteAuthorization = {
      algorithmVersion: currentByte.algorithmVersion,
      examined: changedInsideCohort.length,
      authorized: currentByte.proofs.filter((proof) => proof.status === STATUS_AUTHORIZED).length,
      blocked: currentByte.blocked.length
    };
    for (const proof of currentByte.blocked) {
      blocking('GIT_COHORT', 'UNAUTHORIZED_CURRENT_BYTES', {
        path: proof.path,
        expected: proof.candidateSha256
          ? `bytes certified by the applicable authorized publication (${proof.candidateSha256})`
          : 'an authorized publication binding these exact bytes',
        actual: `${proof.reason}${proof.currentSha256 ? ` (${proof.currentSha256})` : ''}`,
        affectedFrontier: 'GIT_COHORT'
      });
    }
  }

  /* ---- TEMP: no durable dependency on ephemeral run roots --------------- */
  ran('TEMP');
  let tempAudit = { durableRootResolved: false };
  try {
    const durable = resolveDurableLifecycleRoot({});
    tempAudit = {
      durableRootResolved: true,
      root: durable.root,
      source: durable.source,
      insideEphemeralTemp: durable.ephemeral === true,
      reasonCodes: durable.reasonCodes ?? []
    };
    if (durable.ephemeral === true) {
      blocking('TEMP', 'DURABLE_LIFECYCLE_ROOT_IS_EPHEMERAL', {
        path: durable.root, expected: 'a durable location outside the OS temp directory', actual: 'INSIDE_TEMP',
        affectedFrontier: 'TEMP'
      });
    }
  } catch (error) {
    blocking('TEMP', 'DURABLE_LIFECYCLE_ROOT_UNRESOLVABLE', { path: null, expected: 'resolvable durable root', actual: error.message });
  }

  /* ---- GLOBAL BOUNDARIES ------------------------------------------------ */
  ran('GLOBAL_BOUNDARIES');
  const r8Present = fs.existsSync(repoPath(root, 'governance/gee-v1/r8'))
    || fs.existsSync(repoPath(root, 'governance/gee-v1/R8'));
  if (r8Present) {
    blocking('GLOBAL_BOUNDARIES', 'R8_PRESENT', { path: 'governance/gee-v1/r8', expected: 'ABSENT', actual: 'PRESENT' });
  }

  const notStartedFrom = expectNotStartedFrom === null ? null : Number.parseInt(String(expectNotStartedFrom).replace('GATE', ''), 10);
  const successorViolations = [];
  if (notStartedFrom !== null) {
    for (const [otherGateId, status] of statusByGate) {
      const number = Number.parseInt(otherGateId.replace('GATE', ''), 10);
      if (number < notStartedFrom) continue;
      if (status !== 'NOT_STARTED') {
        successorViolations.push({ gateId: otherGateId, status });
        blocking('GLOBAL_BOUNDARIES', 'SUCCESSOR_GATE_STARTED', {
          path: LEDGER_PATH, expected: 'NOT_STARTED', actual: status, message: otherGateId,
          affectedFrontier: 'GLOBAL_BOUNDARIES'
        });
      }
    }
  }

  const activeGate = readJsonOrNull(root, ACTIVE_GATE_PATH);

  const observations = {
    ledger: {
      path: LEDGER_PATH,
      sha256: sha256Bytes(ledgerBytes),
      byteLength: ledgerBytes.length,
      eventCount: events.length,
      prefixProbes
    },
    lifecycle: {
      gateId,
      derivedStatus,
      transitionCounts: Object.fromEntries(transitionCounts),
      gateEventOrdinals: gateEvents.map((event) => event.ordinal)
    },
    state: {
      currentStateRevision: currentState?.stateRevision ?? null,
      revisionCount: revisionNames.length,
      revisions: revisionNames,
      revisionValidatorValid: revisionReportValid,
      seals: sealAudits
    },
    authority: authorityAudits,
    precontractAnchor,
    evidence: { required: evidenceAudits, staleReuseClaims },
    generated: generatedAudit,
    git: gitAudit,
    temp: tempAudit,
    globalBoundaries: {
      r8Present,
      activeGate: activeGate?.activeGate ?? null,
      successorViolations,
      statusByGate: Object.fromEntries(statusByGate)
    },
    closedSealInventory: { memberCount: closedByPath.size }
  };

  return finalize({ root, gateId, findings, familiesRun, observations, now });
}

function finalize({ root, gateId, findings, familiesRun, observations, now }) {
  const verdict = findings.length === 0 ? 'PASS' : 'FAIL';
  return {
    document: AUDITOR_DOCUMENT,
    version: AUDITOR_VERSION,
    FINAL_GATE_INTEGRITY: verdict,
    gateId,
    auditedAt: now.toISOString(),
    root,
    familiesRun: CHECK_FAMILIES.filter((family) => familiesRun.has(family)),
    familiesNotRun: CHECK_FAMILIES.filter((family) => !familiesRun.has(family)),
    findingCount: findings.length,
    // Grouped so a reader can see how many INDEPENDENT problems exist, which is
    // the number that decides whether one repair round is enough.
    defectClasses: [...new Set(findings.map((item) => item.defectClass))].sort(),
    findings,
    observations
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const list = (name) => (option(name, '') || '').split(',').map((value) => value.trim()).filter(Boolean);
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const reportPath = option('--external-report');
  const report = auditFinalGateIntegrity({
    root,
    gateId: option('--gate'),
    authorizedCohort: option('--cohort') ? list('--cohort') : null,
    baselineCommit: option('--baseline-commit'),
    expectNotStartedFrom: option('--expect-not-started-from'),
    requiredEvidencePaths: list('--required-evidence'),
    externalReinspectionReport: reportPath ? { path: reportPath, sha256: option('--external-report-sha') } : null
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.FINAL_GATE_INTEGRITY === 'PASS' ? 0 : 2;
}
