/**
 * Wheel adapter — dependency satisfaction for a Gate.
 *
 * WHY THIS EXISTS. Every consumer in the lifecycle used to answer "is my
 * predecessor closed?" by reading the last ledger event for that Gate. That is
 * correct for a Gate that was executed, and wrong for a Gate the Project Owner
 * explicitly declared NON_EXECUTABLE: such a Gate never receives a lifecycle
 * event, so its last ledger event stays the GENESIS_IMPORT with status
 * NOT_STARTED, and its successor can never satisfy its dependency. The registry
 * and the owner-ratified source already carry the disposition; nothing read it.
 *
 * The disposition is NOT a status. It is an owner decision, and it is only
 * usable while the Gate has no lifecycle of its own:
 *
 *   - the disposition must be SUPERSEDED + NON_EXECUTABLE, stated in a canonical
 *     PROJECT_OWNER source that the registry independently projects;
 *   - the registry's binding must not be a one-off rewrite — every registry
 *     reference to that sourceId must agree on a single sourcePath;
 *   - the Gate must still be genesis-only in the ledger. One real transition and
 *     the disposition stops applying, permanently.
 *
 * Fail-closed: an unreadable ledger, an unresolvable source, a partial
 * disposition or a Gate that has already moved all return unsatisfied.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { satisfiesSuccessorClosure } from '../../core/successor-closure.mjs';
import { verifyLedgerEventChain, verifyLedgerText } from '../../core/verified-ledger-evidence.mjs';
import { proveCanonicalTerminalStatus } from '../../core/canonical-terminal-proof.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from './external-authority-policy.mjs';

/**
 * Statuses that mean a Gate has reached a closed status of SOME kind.
 *
 * This is NOT the successor-admission rule. It answers "is this Gate finished
 * enough to be used as a sealed reference", which is why COMPLETE_AGENT belongs
 * here and does not belong in successor closure. Keeping the two predicates
 * separate is deliberate: they were the same set once, and that is exactly how a
 * Gate with no external confirmation came to satisfy its successor's dependency.
 */
export const CLOSED_LEDGER_STATUSES = new Set(['COMPLETE_AGENT', 'COMPLETE_CONFIRMED', 'SUPERSEDED']);

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function repoFile(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.includes('..')) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

function readRegistry(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'governance/GATE_REGISTRY_00_40.json'), 'utf8')); } catch { return null; }
}

function readLedgerText(root) {
  try { return fs.readFileSync(path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8'); } catch { return null; }
}

/**
 * Every external authority declaration a transition may lawfully cite.
 *
 * TWO SOURCES, AND OMITTING EITHER REWRITES HISTORY. An `authorityPath` is not
 * always a repository path: a genesis-imported or externally-reinspected
 * transition cites an authority ID that a declaration maps to real bytes. Those
 * declarations live in TWO places — the frozen GENESIS_IMPORT_SOURCE_MAP and the
 * adapter policy — and the canonical ledger validator consults both.
 *
 * Consulting only the policy is what an earlier pass of this repair did, and it
 * broke GATE12: its EXTERNAL_CONFIRMATION cites `SRC-R1-EXTERNAL-PASS`, declared
 * only in the source map. The terminal proof could not resolve it, GATE12 stopped
 * satisfying the dependency it had lawfully satisfied for GATE13's recorded
 * START, and a tightening intended to reject forgeries began rejecting real
 * history instead. A rule that invalidates recorded history is not a stricter
 * rule; it is a wrong one.
 *
 * Neither list is trusted structurally: a declaration only names a candidate
 * file, and the digest still has to match the bytes the event pinned.
 */
function declaredExternalAuthorities(root) {
  const declarations = [...(WHEEL_EXTERNAL_AUTHORITY_POLICY.extraExternalAuthorities ?? [])];
  try {
    const sourceMap = JSON.parse(fs.readFileSync(path.join(root, 'governance/authority/GENESIS_IMPORT_SOURCE_MAP.json'), 'utf8'));
    if (Array.isArray(sourceMap?.externalAuthorities)) declarations.push(...sourceMap.externalAuthorities);
  } catch { /* absent map contributes nothing; repository-path authorities still resolve */ }
  return declarations;
}

function isCanonicalDispositionBinding(registry, entry, reference, source, sourceGate, gateId) {
  if (typeof reference?.sourceId !== 'string' || !reference.sourceId || typeof reference?.sourcePath !== 'string') return false;
  if (source?.authorityId !== reference.sourceId || source?.canonical !== true || source?.issuedBy !== 'PROJECT_OWNER') return false;
  if (reference.sourceLocation !== `/gates/${gateId}` || sourceGate?.gateId !== gateId) return false;
  if (sourceGate?.canonicalObjective !== entry?.canonicalObjective || sourceGate?.canonicalName !== entry?.officialName) return false;

  // A one-off registry rewrite must not redirect a canonical source.  The
  // registry's other projections of the same authority form the current
  // model's independent path binding; no Gate-specific path is hard-coded.
  const pathsForSourceId = new Set((registry?.gates || []).flatMap((candidate) =>
    (candidate?.sourceReferences || [])
      .filter((candidateReference) => candidateReference?.sourceId === reference.sourceId)
      .map((candidateReference) => candidateReference?.sourcePath)
  ));
  return pathsForSourceId.size === 1 && pathsForSourceId.has(reference.sourcePath);
}

/** The disposition is distinct from the ledger status and is source-bound. */
export function resolveCanonicalGateDisposition({ root, gateId } = {}) {
  const registry = readRegistry(root);
  const entry = Array.isArray(registry?.gates) ? registry.gates.find((gate) => gate.gateId === gateId) : null;
  if (!entry) return null;
  for (const reference of Array.isArray(entry.sourceReferences) ? entry.sourceReferences : []) {
    const sourcePath = reference?.sourcePath;
    const sourceFile = repoFile(root, sourcePath);
    if (!sourceFile) continue;
    let source;
    try { source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); } catch { continue; }
    const sourceGate = Array.isArray(source.gates) ? source.gates.find((gate) => gate.gateId === gateId) : null;
    const disposition = sourceGate?.ownerDisposition;
    if (!isCanonicalDispositionBinding(registry, entry, reference, source, sourceGate, gateId)) continue;
    if (disposition?.status !== 'SUPERSEDED' || disposition?.execution !== 'NON_EXECUTABLE') continue;
    if (typeof disposition.futureLifecycle !== 'string' || !disposition.futureLifecycle.includes('SUPERSEDED')) continue;
    const bytes = fs.readFileSync(sourceFile);
    return { gateId, status: 'SUPERSEDED', execution: 'NON_EXECUTABLE', authorityPath: sourcePath, authoritySha256: sha256(bytes), sourceId: reference.sourceId || source.authorityId || null };
  }
  return null;
}

/**
 * A disposition is usable only while the Gate remains genesis-only.
 *
 * REPLAY SCOPE IS A PARAMETER, NOT AN ASSUMPTION. `events` is the ledger the
 * question is being asked about. Pre-write decisions pass the live ledger.
 * Permanent re-validation of a historical event must instead pass the events
 * that preceded THAT event, or a lawfully-recorded authorization would stop
 * validating the day some later event lands on the dependency Gate — history
 * would become retroactively invalid, which is precisely what an append-only
 * ledger exists to prevent.
 */
export function resolveGateDependencyProofFromEvents({ root, gateId, events, evidence = null } = {}) {
  if (!Array.isArray(events)) return { satisfied: false, status: 'UNKNOWN', observedStatus: 'UNKNOWN', proof: null, evidence: null, reason: 'LEDGER_UNREADABLE' };

  // THE PROOF OBLIGATION. Nothing below may read a status scalar until the chain
  // those scalars live in has been re-derived. A caller that already verified the
  // exact same events (the text path below) passes its result through rather than
  // paying for the chain twice; a caller that did not gets it computed here. What
  // no caller can do is skip it.
  const verified = evidence ?? verifyLedgerEventChain(events);
  if (!verified.verified) {
    return {
      satisfied: false, status: 'UNVERIFIED', observedStatus: 'UNVERIFIED', proof: null,
      evidence: { verified: false, findings: verified.findings },
      reason: 'LEDGER_EVIDENCE_UNVERIFIED'
    };
  }
  const evidenceProof = { verified: true, eventCount: verified.eventCount, headPayloadSha256: verified.headPayloadSha256 ?? null };

  const ownEvents = events.filter((event) => event.gateId === gateId);
  const latest = ownEvents.at(-1) || null;
  const observedStatus = latest?.toStatus || 'ABSENT';

  // THE SCALAR IS READ LAST, NOT FIRST.
  //
  // Reading `latest.toStatus` and testing it against the closure set is what the
  // competent forgery defeated: recomputing eventPayloadSha256 kept the chain
  // self-consistent, so a relabelled event satisfied a chain-only check. The
  // status is therefore taken from the canonical PROOF — a replay that checks
  // every transition against the table that owns it, from the status the replay
  // itself produced, ending in an authority whose live bytes still hash to what
  // the event pinned — and the proof's status is the only one considered here.
  const terminal = proveCanonicalTerminalStatus({
    root, gateId, events,
    externalAuthorities: declaredExternalAuthorities(root)
  });
  if (terminal.proven && satisfiesSuccessorClosure(terminal.status)) {
    return {
      satisfied: true, status: terminal.status, observedStatus,
      proof: { gateId, status: terminal.status, authorityPath: terminal.terminalAuthorityPath, authoritySha256: terminal.terminalAuthoritySha256 },
      evidence: evidenceProof, terminalProof: { proven: true, ordinal: terminal.terminalOrdinal, transitionType: terminal.terminalTransitionType },
      reason: 'CANONICAL_TERMINAL_STATUS_PROVEN'
    };
  }
  // A ledger whose chain is intact but whose terminal status is NOT canonically
  // produced is refused outright, rather than falling through to the disposition
  // path: the disposition is only usable while the Gate is genesis-only, and
  // "genesis-only" would itself be read from the history just shown to be unsound.
  if (!terminal.proven && satisfiesSuccessorClosure(observedStatus)) {
    return {
      satisfied: false, status: 'UNVERIFIED', observedStatus, proof: null,
      evidence: evidenceProof, terminalProof: { proven: false, findings: terminal.findings },
      reason: 'CANONICAL_TERMINAL_PROOF_FAILED'
    };
  }
  // The owner disposition is an independent authority, but it is only USABLE
  // while the Gate is still genesis-only — and "still genesis-only" is itself a
  // reading of the ledger. Admitting SUPERSEDED off an unverified chain would let
  // a forged ledger erase the very lifecycle events that revoke the disposition,
  // which is why this path sits behind the same verification as the one above.
  const disposition = resolveCanonicalGateDisposition({ root, gateId });
  const genesisOnly = ownEvents.length > 0 && ownEvents.every((event) => event.transitionType === 'GENESIS_IMPORT');
  if (disposition && observedStatus === 'NOT_STARTED' && genesisOnly) {
    return { satisfied: true, status: 'SUPERSEDED', observedStatus, disposition, proof: { gateId, status: 'SUPERSEDED', authorityPath: disposition.authorityPath, authoritySha256: disposition.authoritySha256 }, evidence: evidenceProof, reason: 'CANONICAL_OWNER_DISPOSITION_SUPERSEDED' };
  }
  return { satisfied: false, status: observedStatus, observedStatus, proof: latest ? { gateId, status: latest.toStatus, authorityPath: latest.authorityPath, authoritySha256: latest.authoritySha256 } : null, evidence: evidenceProof, reason: disposition && !genesisOnly ? 'DISPOSITION_BLOCKED_BY_NON_GENESIS_LIFECYCLE' : 'DEPENDENCY_NOT_TERMINAL' };
}

/**
 * Present-tense question: is this dependency satisfied by the ledger as it stands now?
 *
 * The live path verifies the ledger TEXT, not merely the parsed events, because
 * the file on disk is what every other consumer will read. A ledger whose bytes
 * are no longer the canonical serialization of its own events is refused here
 * even though the digests it carries would chain: the digests would be describing
 * an artifact that no longer exists.
 */
export function resolveGateDependencyProof({ root, gateId } = {}) {
  const text = readLedgerText(root);
  if (text === null) return { satisfied: false, status: 'UNKNOWN', observedStatus: 'UNKNOWN', proof: null, evidence: null, reason: 'LEDGER_UNREADABLE' };
  const verified = verifyLedgerText(text);
  if (!verified.verified) {
    return {
      satisfied: false, status: 'UNVERIFIED', observedStatus: 'UNVERIFIED', proof: null,
      evidence: { verified: false, findings: verified.findings },
      reason: 'LEDGER_EVIDENCE_UNVERIFIED'
    };
  }
  return resolveGateDependencyProofFromEvents({ root, gateId, events: verified.events, evidence: verified });
}
