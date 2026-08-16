#!/usr/bin/env node
/**
 * Anchor a precontract consumption receipt in the append-only ledger.
 *
 * WHY THIS TOOL EXISTS. A consumption receipt used to vouch for itself: the
 * digest protecting its `recordedAt` sat in the same file, so anyone able to edit
 * the receipt could recompute the digest and produce something that verified.
 * The only structure in this project that a later edit cannot quietly revise is
 * the hash-chained status ledger, so the receipt's exact digest is stated there
 * and verification consults the ledger instead of the receipt.
 *
 * WHAT IT WRITES. One PRECONTRACT_CONSUMPTION_ANCHOR event — a self-transition
 * that leaves the Gate in precisely the status it was already in. It cannot
 * start, close, confirm or supersede anything; the narrow two-entry table in
 * validate-status-ledger.mjs is what makes that structural rather than a promise.
 *
 * WHEN IT RUNS. Immediately after a bootstrap, before the Gate's first lifecycle
 * event, for any Gate bootstrapped from now on. A Gate whose bootstrap predates
 * the mechanism is anchored retroactively, which is lawful precisely because an
 * append adds a fact rather than editing one: no historical event is touched.
 *
 * This is a transport, not a decision. The anchor authority states what may be
 * anchored; this file refuses to anchor anything else, and the ledger validator
 * re-proves the whole thing independently afterwards.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ledgerLineBytes, LEDGER_PATH, readLedgerEvents, replayGateStatus } from './gate-lifecycle-orchestrator.mjs';
import { sha256Canonical } from './canonical-json.mjs';

export const ANCHOR_TOOL_DOCUMENT = 'PRECONTRACT_CONSUMPTION_ANCHOR_APPLICATION';
export const ANCHOR_TRANSITION_TYPE = 'PRECONTRACT_CONSUMPTION_ANCHOR';
export const ANCHOR_AUTHORITY_KIND = 'GATE_PRECONTRACT_CONSUMPTION_ANCHOR_LOCAL_AUTHORITY';
/** The statuses a Gate may legitimately hold while its receipt is anchored. */
export const ANCHORABLE_STATUSES = Object.freeze(['NOT_STARTED', 'COMPLETE_AGENT']);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const repoFile = (root, relative) => path.join(root, ...relative.split('/'));
const STATE_REVISION_PATTERN = /^R[0-9]{4}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The Gate's most recent PRIOR event carrying a complete, well-formed native state
 * pin — or null if this Gate has never had one.
 *
 * WHY NOT `ownHead`. The pin used to be copied straight off the Gate's own head
 * event, which was right only by accident: every Gate anchored so far happened to
 * have a native-era head. Anchored at the canonical moment — immediately after the
 * bootstrap, before the Gate's first lifecycle event — the Gate's own head is its
 * PRE-NATIVE GENESIS_IMPORT, which carries no pin at all. Copying it produced a
 * native-era ordinal with no state binding, which the ledger validator rightly
 * refuses. What an anchor must restate is the Gate's LATEST pin wherever it sits in
 * that Gate's history; an anchor never mints state, so it can only ever repeat one.
 *
 * Both halves are required: a half-pin is not a pin, and accepting one would let a
 * revision travel forward without the seal that backs it.
 */
function latestGateStatePin(events, gateId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.gateId !== gateId) continue;
    if (!STATE_REVISION_PATTERN.test(String(event.stateRevision))) continue;
    if (!SHA256_PATTERN.test(String(event.stateRevisionSealSha256))) continue;
    return { stateRevision: event.stateRevision, stateRevisionSealSha256: event.stateRevisionSealSha256 };
  }
  return null;
}

/** True when the governed tree already holds a minted state revision for this Gate. */
function gateHasMintedState(root, gateId) {
  const revisions = path.join(root, 'governance', 'gates', gateId, 'state', 'revisions');
  try { return fs.readdirSync(revisions).some((entry) => STATE_REVISION_PATTERN.test(entry)); }
  catch { return false; }
}

/**
 * The event payload digest, computed exactly as the ledger validator recomputes
 * it — sha256(canonicalize(event without eventPayloadSha256)) — so the chain
 * check is satisfied by construction rather than by coincidence.
 */
function eventPayloadDigest(event) {
  const { eventPayloadSha256, ...payload } = event;
  return sha256Canonical(payload);
}

export function anchorPrecontractConsumption({ root, authorityPath, recordedAt, apply = false }) {
  const findings = [];
  const absoluteRoot = path.resolve(root);
  const push = (code, detail) => findings.push(detail === undefined ? { code } : { code, detail });
  const blocked = (phase) => ({ document: ANCHOR_TOOL_DOCUMENT, verdict: 'BLOCKED', phase, findings, appended: null });

  let authority = null;
  const authorityRelative = path.relative(absoluteRoot, path.resolve(authorityPath)).split(path.sep).join('/');
  try { authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8')); } catch { push('ANCHOR_AUTHORITY_UNREADABLE', authorityPath); }
  if (!authority) return blocked('AUTHORITY');
  if (authority.documentKind !== ANCHOR_AUTHORITY_KIND) push('ANCHOR_AUTHORITY_KIND_INVALID', authority.documentKind);
  if (authority.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') push('ANCHOR_AUTHORITY_MODE_INVALID', authority.authorityMode);
  if (authority.maxUse !== 1) push('ANCHOR_AUTHORITY_MAX_USE_INVALID', authority.maxUse);
  if (findings.length) return blocked('AUTHORITY');

  const gateId = authority.gateId;

  // The receipt must exist and reproduce exactly the digest the authority names.
  let receiptSha = null;
  try { receiptSha = sha256(fs.readFileSync(repoFile(absoluteRoot, authority.consumptionRecordPath))); }
  catch { push('ANCHOR_RECEIPT_UNREADABLE', authority.consumptionRecordPath); }
  if (receiptSha && receiptSha !== authority.consumptionRecordSha256) {
    push('ANCHOR_RECEIPT_DIGEST_MISMATCH', `${authority.consumptionRecordSha256} != ${receiptSha}`);
  }

  // The receipt must be the one this Gate's precontract authority designated.
  let precontract = null;
  try { precontract = JSON.parse(fs.readFileSync(repoFile(absoluteRoot, authority.precontractAuthorityPath), 'utf8')); }
  catch { push('ANCHOR_PRECONTRACT_AUTHORITY_UNREADABLE', authority.precontractAuthorityPath); }
  if (precontract) {
    if (precontract.gateId !== gateId) push('ANCHOR_PRECONTRACT_GATE_MISMATCH', precontract.gateId);
    if (precontract.authorityId !== authority.precontractAuthorityId) push('ANCHOR_PRECONTRACT_AUTHORITY_MISMATCH', precontract.authorityId);
    if (precontract.consumptionRecordPath !== authority.consumptionRecordPath) push('ANCHOR_PRECONTRACT_PATH_MISMATCH', precontract.consumptionRecordPath);
  }
  if (findings.length) return blocked('BINDING');

  const events = readLedgerEvents(absoluteRoot);
  if (events.some((event) => event.gateId === gateId && event.transitionType === ANCHOR_TRANSITION_TYPE)) {
    push('ANCHOR_ALREADY_PRESENT', gateId);
    return blocked('LEDGER');
  }
  // replayGateStatus returns the whole gate->status map, so the Gate's own status
  // is read from it rather than assumed from the last event.
  const status = replayGateStatus(events).get(gateId) ?? null;
  if (!ANCHORABLE_STATUSES.includes(status)) { push('ANCHOR_STATUS_NOT_ANCHORABLE', status); return blocked('LEDGER'); }
  const head = events.at(-1);
  const ownHead = events.filter((event) => event.gateId === gateId).at(-1) || null;
  if (!ownHead) { push('ANCHOR_GATE_ABSENT_FROM_LEDGER', gateId); return blocked('LEDGER'); }
  if (recordedAt && Date.parse(recordedAt) < Date.parse(head.recordedAt)) {
    push('ANCHOR_TIMESTAMP_REGRESSION', `${recordedAt} < ${head.recordedAt}`);
    return blocked('LEDGER');
  }

  // An anchor RESTATES the Gate's state binding; it never mints one. With a pin in
  // the Gate's history the anchor must carry exactly that pin. With none, the Gate
  // is still in its bootstrap pre-state and the anchor carries no pin — inventing
  // R0001, or any seal, would be a state claim no sealed revision backs. Absence is
  // only admissible from that pre-state, so anything else is refused here rather
  // than appended for the validator to reject.
  const priorPin = latestGateStatePin(events, gateId);
  if (!priorPin && status !== 'NOT_STARTED') {
    push('ANCHOR_STATE_PIN_UNRESOLVED', status);
    return blocked('LEDGER');
  }
  if (!priorPin && gateHasMintedState(absoluteRoot, gateId)) {
    push('ANCHOR_STATE_PIN_UNPINNED_REVISION_PRESENT', gateId);
    return blocked('LEDGER');
  }

  const event = {
    schemaVersion: 1,
    ordinal: head.ordinal + 1,
    eventId: `${gateId}_PRECONTRACT_CONSUMPTION_ANCHOR_R1`,
    gateId,
    fromStatus: status,
    toStatus: status,
    transitionType: ANCHOR_TRANSITION_TYPE,
    authorityPath: authorityRelative,
    authoritySha256: sha256(fs.readFileSync(authorityPath)),
    previousEventSha256: head.eventPayloadSha256,
    recordedAt: recordedAt || new Date().toISOString(),
    ...(priorPin ?? {}),
    precontractConsumption: { path: authority.consumptionRecordPath, sha256: receiptSha }
  };
  event.eventPayloadSha256 = eventPayloadDigest(event);

  if (!apply) {
    return { document: ANCHOR_TOOL_DOCUMENT, verdict: 'CANDIDATE_VALID', phase: 'CANDIDATE', gateId, findings: [], appended: event };
  }
  fs.appendFileSync(repoFile(absoluteRoot, LEDGER_PATH), ledgerLineBytes(event));
  return { document: ANCHOR_TOOL_DOCUMENT, verdict: 'ANCHORED', phase: 'APPLIED', gateId, findings: [], appended: event };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const report = anchorPrecontractConsumption({
    root: path.resolve(option('--root', path.resolve(toolsDir, '..', '..'))),
    authorityPath: option('--authority'),
    recordedAt: option('--recorded-at'),
    apply: process.argv.includes('--apply')
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === 'BLOCKED' ? 2 : 0;
}
