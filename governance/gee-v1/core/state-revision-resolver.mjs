/**
 * H2 — where the current state revision actually comes from.
 *
 * THE DEFECT THIS REMOVES. Before this module, "which revision is current" was
 * decided by looking at the filesystem: readdir the revisions directory, sort
 * the names, take the highest Rxxxx. That makes a DIRECTORY NAME an authority.
 * Anyone able to create `state/revisions/R9999/` could change the answer to
 * "which revision is current", turn a correct CURRENT_STATE into a reported
 * CHECKPOINT_ROLLBACK, and change how an older seal is verified — without
 * touching the ledger, any seal, or any authority.
 *
 * THE REPLACEMENT. The append-only ledger is the only thing that says which
 * revision is current. Lineage resolves strictly as:
 *
 *     ledger state-binding event  ->  exact revision  ->  exact state seal
 *                                 ->  previous seal chain  ->  root
 *
 * The filesystem is still READ — seals have to be loaded from somewhere — but
 * it no longer DECIDES. Directory listings are used only to notice revisions
 * that the ledger never bound (orphans), never to choose the current one.
 *
 * TWO ERAS, NO FALLBACK BETWEEN THEM.
 *
 *   Legacy era (ordinal <= legacyEraMaxOrdinal, here 58): events predate native
 *   state pinning, so their revision comes from an explicit legacy binding
 *   record. Those records add interpretation only; they grant no transition and
 *   are valid solely where they agree with already-immutable evidence.
 *
 *   Native era (ordinal >= 59): the event itself carries stateRevision and
 *   stateRevisionSealSha256. There is NO migration fallback here. A native-era
 *   event without its own pin is BLOCKED rather than quietly resolved through a
 *   legacy record, and a legacy record claiming a native-era ordinal is BLOCKED.
 *   Without that rule the legacy path would become a permanent bypass.
 *
 * Pure: no filesystem, no clock. Callers supply parsed events and seals.
 */

export const LEGACY_ERA_MAX_ORDINAL = 58;

export const DECIDED_BY_NATIVE_EVENT_PIN = 'NATIVE_EVENT_PIN';
export const DECIDED_BY_LEGACY_BINDING_RECORD = 'LEGACY_BINDING_RECORD';
/**
 * Gates whose entire lifecycle predates state binding (their events never bound
 * a revision and no legacy record claims them). The ledger genuinely says
 * nothing about their revisions, so claiming a ledger anchor for them would be
 * a lie. Their head is resolved from the SEAL CHAIN instead — still never from
 * a directory name — and the weaker claim is reported as such rather than
 * quietly presented as anchored.
 */
export const DECIDED_BY_SEAL_CHAIN_HEAD = 'SEAL_CHAIN_HEAD';

export const ANCHOR_LEDGER = 'LEDGER_ANCHORED';
export const ANCHOR_PRE_BINDING_ERA = 'PRE_BINDING_ERA';

const REVISION_RE = /^R[0-9]{4}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

export function revisionNumber(value) {
  return REVISION_RE.test(String(value || '')) ? Number.parseInt(String(value).slice(1), 10) : null;
}

/**
 * Every event that binds state for this gate, in ordinal order, each already
 * resolved to the revision and seal digest it binds and to HOW that was decided.
 * An event that binds nothing is not an error — most events do not bind state.
 */
export function collectStateBindingEvents({ gateId, events = [], legacyBindings = [], legacyEraMaxOrdinal = LEGACY_ERA_MAX_ORDINAL }) {
  const findings = [];
  const byOrdinal = new Map();
  for (const binding of legacyBindings) {
    if (binding?.gateId !== gateId) continue;
    if (!Number.isInteger(binding.eventOrdinal)) { finding(findings, 'LEGACY_BINDING_ORDINAL_INVALID', binding?.eventId); continue; }
    // The whole point of the era split: a legacy record may never reach forward.
    if (binding.eventOrdinal > legacyEraMaxOrdinal) {
      finding(findings, 'NATIVE_ERA_MIGRATION_FORBIDDEN', binding.eventOrdinal);
      continue;
    }
    if (byOrdinal.has(binding.eventOrdinal)) { finding(findings, 'LEGACY_BINDING_DUPLICATE', binding.eventOrdinal); continue; }
    byOrdinal.set(binding.eventOrdinal, binding);
  }

  const bindings = [];
  for (const event of events) {
    if (event?.gateId !== gateId) continue;
    const legacy = byOrdinal.get(event.ordinal);
    const nativePinned = REVISION_RE.test(event.stateRevision || '') && SHA256_RE.test(event.stateRevisionSealSha256 || '');

    if (event.ordinal > legacyEraMaxOrdinal) {
      if (legacy) { finding(findings, 'NATIVE_ERA_MIGRATION_FORBIDDEN', event.ordinal); continue; }
      if (!nativePinned) {
        // Only events that CLAIM to bind state are faulted; ordinary events do not.
        if (Object.hasOwn(event, 'stateRevision') || Object.hasOwn(event, 'stateRevisionSealSha256')) {
          finding(findings, 'NATIVE_STATE_PIN_INVALID', event.ordinal);
        }
        continue;
      }
      bindings.push({
        eventOrdinal: event.ordinal, eventId: event.eventId, toStatus: event.toStatus,
        stateRevision: event.stateRevision, stateRevisionSealSha256: event.stateRevisionSealSha256,
        decidedBy: DECIDED_BY_NATIVE_EVENT_PIN
      });
      continue;
    }

    if (!legacy) continue;
    if (nativePinned) { finding(findings, 'LEGACY_ERA_NATIVE_PIN_UNEXPECTED', event.ordinal); continue; }
    // The legacy record must describe the event it claims, not merely exist.
    if (legacy.eventId !== event.eventId || legacy.eventPayloadSha256 !== event.eventPayloadSha256) {
      finding(findings, 'LEGACY_BINDING_EVENT_MISMATCH', event.ordinal);
      continue;
    }
    if (legacy.toStatus !== event.toStatus) { finding(findings, 'LEGACY_BINDING_STATUS_MISMATCH', event.ordinal); continue; }
    if (legacy.originalAuthorityPath !== event.authorityPath || legacy.originalAuthoritySha256 !== event.authoritySha256) {
      finding(findings, 'LEGACY_BINDING_AUTHORITY_MISMATCH', event.ordinal);
      continue;
    }
    if (!REVISION_RE.test(legacy.stateRevision || '') || !SHA256_RE.test(legacy.stateRevisionSealSha256 || '')) {
      finding(findings, 'LEGACY_BINDING_REVISION_INVALID', event.ordinal);
      continue;
    }
    bindings.push({
      eventOrdinal: event.ordinal, eventId: event.eventId, toStatus: event.toStatus,
      stateRevision: legacy.stateRevision, stateRevisionSealSha256: legacy.stateRevisionSealSha256,
      decidedBy: DECIDED_BY_LEGACY_BINDING_RECORD
    });
  }
  bindings.sort((a, b) => a.eventOrdinal - b.eventOrdinal);
  return { bindings, findings };
}

/**
 * Resolve the authoritative lineage.
 *
 * `seals` maps revision name -> { sha256, gateId, stateRevision, previousStateSealSha256 }.
 * `presentRevisions` is what the filesystem happens to contain; it is used ONLY
 * to report orphans and can never change which revision resolves.
 */
export function resolveStateRevisionLineage({
  gateId,
  events = [],
  legacyBindings = [],
  seals = new Map(),
  presentRevisions = [],
  legacyEraMaxOrdinal = LEGACY_ERA_MAX_ORDINAL
} = {}) {
  const collected = collectStateBindingEvents({ gateId, events, legacyBindings, legacyEraMaxOrdinal });
  const findings = [...collected.findings];
  const bindings = collected.bindings;

  let head;
  let anchorState;
  if (bindings.length === 0) {
    // Pre-binding era. Resolve the head as the seal of this gate that no other
    // seal of this gate names as its predecessor. Ambiguity blocks; it is never
    // broken by preferring the highest name.
    anchorState = ANCHOR_PRE_BINDING_ERA;
    const named = new Set();
    for (const [, seal] of seals) {
      if (seal.gateId !== gateId) continue;
      if (seal.previousStateSealSha256) named.add(seal.previousStateSealSha256);
    }
    const heads = [...seals.entries()]
      .filter(([, seal]) => seal.gateId === gateId && !named.has(seal.sha256))
      .map(([name]) => name)
      .sort();
    if (heads.length === 0) {
      finding(findings, 'NO_LEDGER_STATE_BINDING', gateId);
      return { resolved: null, decidedBy: null, anchorState, bindings, sealChain: [], orphans: [], findings };
    }
    if (heads.length > 1) {
      finding(findings, 'REVISION_CHAIN_AMBIGUOUS_HEAD', heads.join(','));
      return { resolved: null, decidedBy: null, anchorState, bindings, sealChain: [], orphans: [], findings };
    }
    head = { stateRevision: heads[0], stateRevisionSealSha256: seals.get(heads[0]).sha256, decidedBy: DECIDED_BY_SEAL_CHAIN_HEAD };
  } else {
    anchorState = ANCHOR_LEDGER;
  }

  // Rollback is a LEDGER fact: a later binding naming an earlier revision.
  for (let index = 1; index < bindings.length; index += 1) {
    const previous = revisionNumber(bindings[index - 1].stateRevision);
    const current = revisionNumber(bindings[index].stateRevision);
    if (current === null || previous === null || current < previous) {
      finding(findings, 'REVISION_ROLLBACK', `${bindings[index - 1].stateRevision}->${bindings[index].stateRevision}`);
    }
  }

  if (anchorState === ANCHOR_LEDGER) head = bindings.at(-1);
  const resolved = head.stateRevision;
  const headSeal = seals.get(resolved);
  if (!headSeal) {
    finding(findings, 'RESOLVED_REVISION_SEAL_ABSENT', resolved);
    return { resolved, decidedBy: head.decidedBy, anchorState, bindings, sealChain: [], orphans: [], findings };
  }
  if (headSeal.sha256 !== head.stateRevisionSealSha256) {
    finding(findings, 'RESOLVED_REVISION_SEAL_DIGEST_MISMATCH', resolved);
  }

  // Walk back to the root through previousStateSealSha256 only. Directory names
  // are never consulted to decide what the predecessor is.
  const byDigest = new Map();
  for (const [name, seal] of seals) byDigest.set(seal.sha256, { name, seal });
  const sealChain = [];
  const visited = new Set();
  let cursor = { name: resolved, seal: headSeal };
  while (cursor) {
    if (visited.has(cursor.name)) { finding(findings, 'REVISION_CHAIN_CYCLE', cursor.name); break; }
    visited.add(cursor.name);
    if (cursor.seal.gateId !== gateId) finding(findings, 'REVISION_CHAIN_CROSS_GATE', cursor.name);
    if (cursor.seal.stateRevision !== cursor.name) finding(findings, 'REVISION_CHAIN_IDENTITY_MISMATCH', cursor.name);
    sealChain.unshift(cursor.name);
    const previousDigest = cursor.seal.previousStateSealSha256;
    if (previousDigest === null || previousDigest === undefined) break;
    const previous = byDigest.get(previousDigest);
    if (!previous) { finding(findings, 'REVISION_CHAIN_BROKEN', `${cursor.name}->${previousDigest}`); break; }
    cursor = previous;
  }
  if (sealChain.length && revisionNumber(sealChain[0]) !== 1) {
    finding(findings, 'REVISION_CHAIN_NOT_ROOTED', sealChain[0]);
  }

  // A fork is two revisions claiming the same predecessor. That is ambiguity,
  // and ambiguity in lineage is never resolved by preferring one — it blocks.
  const predecessors = new Map();
  for (const [name, seal] of seals) {
    if (seal.gateId !== gateId) continue;
    const key = seal.previousStateSealSha256 ?? 'ROOT';
    if (!predecessors.has(key)) predecessors.set(key, []);
    predecessors.get(key).push(name);
  }
  for (const [key, names] of predecessors) {
    if (names.length > 1) finding(findings, 'REVISION_FORK', `${key}:${[...names].sort().join(',')}`);
  }

  // Anything on disk the ledger never bound and the chain never reached.
  // R9999 lands here: it is reported, and it changes nothing above.
  const onChain = new Set(sealChain);
  const orphans = [...presentRevisions].filter((name) => !onChain.has(name)).sort();
  for (const orphan of orphans) finding(findings, 'ORPHAN_REVISION', orphan);

  return { resolved, decidedBy: head.decidedBy, anchorState, bindings, sealChain, orphans, findings };
}
