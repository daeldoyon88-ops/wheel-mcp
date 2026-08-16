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

function readLedger(root) {
  try {
    return fs.readFileSync(path.join(root, 'governance/state/GATE_STATUS_LEDGER.ndjson'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return null; }
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
export function resolveGateDependencyProofFromEvents({ root, gateId, events } = {}) {
  if (!Array.isArray(events)) return { satisfied: false, status: 'UNKNOWN', observedStatus: 'UNKNOWN', proof: null, reason: 'LEDGER_UNREADABLE' };
  const ownEvents = events.filter((event) => event.gateId === gateId);
  const latest = ownEvents.at(-1) || null;
  const observedStatus = latest?.toStatus || 'ABSENT';
  if (latest && CLOSED_LEDGER_STATUSES.has(latest.toStatus)) {
    return { satisfied: true, status: latest.toStatus, observedStatus, proof: { gateId, status: latest.toStatus, authorityPath: latest.authorityPath, authoritySha256: latest.authoritySha256 }, reason: 'LEDGER_TERMINAL_STATUS' };
  }
  const disposition = resolveCanonicalGateDisposition({ root, gateId });
  const genesisOnly = ownEvents.length > 0 && ownEvents.every((event) => event.transitionType === 'GENESIS_IMPORT');
  if (disposition && observedStatus === 'NOT_STARTED' && genesisOnly) {
    return { satisfied: true, status: 'SUPERSEDED', observedStatus, disposition, proof: { gateId, status: 'SUPERSEDED', authorityPath: disposition.authorityPath, authoritySha256: disposition.authoritySha256 }, reason: 'CANONICAL_OWNER_DISPOSITION_SUPERSEDED' };
  }
  return { satisfied: false, status: observedStatus, observedStatus, proof: latest ? { gateId, status: latest.toStatus, authorityPath: latest.authorityPath, authoritySha256: latest.authoritySha256 } : null, reason: disposition && !genesisOnly ? 'DISPOSITION_BLOCKED_BY_NON_GENESIS_LIFECYCLE' : 'DEPENDENCY_NOT_TERMINAL' };
}

/** Present-tense question: is this dependency satisfied by the ledger as it stands now? */
export function resolveGateDependencyProof({ root, gateId } = {}) {
  const events = readLedger(root);
  if (!events) return { satisfied: false, status: 'UNKNOWN', observedStatus: 'UNKNOWN', proof: null, reason: 'LEDGER_UNREADABLE' };
  return resolveGateDependencyProofFromEvents({ root, gateId, events });
}
