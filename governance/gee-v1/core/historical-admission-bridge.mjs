/**
 * HISTORICAL_ADMISSION_BRIDGE — a bounded, owner-issued admission of ONE exact
 * historical publication whose documents no current publisher could produce.
 *
 * THE PROBLEM, AND THE WRONG ANSWER THAT WAS TRIED FIRST.
 *
 * `GATE20_FOUNDATION_PROJECTION_SYNC_R1` is a NORMAL_MAINTENANCE program carrying
 * a schemaVersion-1 manifest. The only publisher that governs that class —
 * apply-path-prestate-program — requires a pre-state-bound V2 manifest, so the
 * program is not publishable today, and `evaluateMaintenanceSourceAdmissibility`
 * correctly refuses it as LEGACY_V1_NOT_CANONICALLY_PUBLISHABLE.
 *
 * The wrong answer was to REWRITE THE HISTORY. An earlier pass edited the V1
 * manifest into a V2 manifest, edited the authority to pin the new manifest digest,
 * and edited the consumption record to cite both — three coherent documents, and an
 * inadmissible program silently became admissible. That is self-ratification: the
 * documents being judged were changed until they passed. Measured on this
 * repository it moved the GATE20 cohort from 89 paths and one refusal to 94 paths
 * and none, purely by editing the evidence.
 *
 * WHAT A BRIDGE IS INSTEAD.
 *
 * The historical bytes are put back exactly as they were and are left alone. A
 * SEPARATE, NEW document — this bridge — states, in machine-readable and fully
 * bounded form:
 *
 *     these three exact digests, for this one programId, on this one Gate, are
 *     admitted as a historical predecessor.
 *
 * The bridge is the modern authority. The old objects remain history. Crucially
 * the bridge is not derivable FROM the old objects: it names their digests, so it
 * can only be written by someone who already has them, and any edit to any of the
 * three breaks the binding. The self-ratification loop is cut because the thing
 * that admits is not the thing being admitted.
 *
 * WHY THIS IS NOT A GENERIC V1 ESCAPE HATCH.
 *
 * A bridge admits an IDENTITY, not a shape. It names one programId, one gateId and
 * three exact SHA-256 values, and `evaluateHistoricalAdmission` refuses on any
 * mismatch of any of them. A second V1 program is not admitted by it. The same
 * program with one byte changed is not admitted by it. The same documents under a
 * different Gate are not admitted by it. `maxUse` is 1 and the admitted identity is
 * singular, so there is nothing to replay: a bridge that has admitted its object
 * cannot admit a second one, because a second object is by definition a different
 * identity.
 *
 * Outside an exact bridge, legacy V1 NORMAL_MAINTENANCE stays refused. That rule is
 * unchanged and is what the hostile battery re-proves.
 *
 * NO PKI, NO SIGNATURES, NO R8. The mechanism is LOCAL_EXPLICIT_AUTHORITY, the same
 * one every other owner document in this project uses, and the binding is a
 * canonical digest over the bridge's own declared identity so the document cannot be
 * widened after the fact without invalidating itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { sha256Canonical } from '../../tools/canonical-json.mjs';

export const HISTORICAL_ADMISSION_BRIDGE_DOCUMENT = 'GEE_V1_HISTORICAL_MAINTENANCE_ADMISSION_BRIDGE';
export const HISTORICAL_ADMISSION_BRIDGE_VERSION = 'R1';

/**
 * THE OWNER RATIFICATION, AND WHY THE BRIDGE ALONE WAS NOT ENOUGH (B05).
 *
 * The first bridge closed "admit a legacy V1 object without rewriting it". It did
 * not close the reverse move, and a hostile proved so: rewrite the V1 manifest into
 * a COHERENT V2 manifest, repoint and reseal the authority and the consumption
 * record at it, keep the same programId — and the source is no longer V1, so it is
 * admitted on ordinary V2 merits and the bridge is never consulted at all. The
 * historical identity was rewritten out of existence rather than bridged.
 *
 * Two things were missing, and they are different things:
 *
 *   AUTHENTICITY  the bridge's own digest proves only that the bridge is internally
 *                 consistent. A self-sealed document is not an authorized one.
 *                 SELF-HASH IS NOT AUTHENTICITY. Admission authority must originate
 *                 OUTSIDE the bridge, from an independently issued Owner decision.
 *
 *   RESERVATION   nothing tied the historical IDENTITY to the historical BYTES. Once
 *                 the Owner ratifies that (projectId, gateId, programId) has a
 *                 specific historical triple, that identity is RESERVED: those exact
 *                 bytes may be recognised through the bounded historical path, and
 *                 no other bytes may be recognised under that identity by ANY route.
 *
 * The reservation is deliberately a DEAD END rather than a redirect. A reserved
 * identity carrying different bytes does not "fall back" to V2 admission, does not
 * fall back to V1 refusal, and is never publishable. It blocks, with a reason that
 * names the identity, because every legitimate way forward is a NEW programId with
 * its own authority, pre-state, candidate, publication and consumption.
 *
 * WHAT THE RATIFICATION IS AND IS NOT. It records that the Owner, NOW, recognises
 * these exact recovered bytes as the historical identity to preserve. It does not
 * claim they were ratified when they were written — the repository cannot prove
 * that, and the recovered Git dangling blobs are EVIDENCE the bytes existed, never
 * a trust root. It grants no publication, execution, START, status-transition or
 * future-byte permission, and no generic V1 permission; those are asserted as
 * explicit false fields and re-checked, so a widened copy invalidates itself.
 */
export const HISTORICAL_IDENTITY_RATIFICATION_DOCUMENT = 'PROJECT_OWNER_HISTORICAL_IDENTITY_RATIFICATION';
export const RATIFICATION_DIRECTORY = 'governance/authority/historical-ratifications';

/**
 * RESERVATION PERMANENCE — why reserved-ness cannot be read off the ratification.
 *
 * THE DEFECT THIS CLOSES. The first reservation derived "is this identity
 * reserved?" from the ratification document itself. That made the reservation
 * exactly as durable as one file, and an independent audit proved five ways to
 * release it: delete the ratification, corrupt its `documentKind` so it is no
 * longer discoverable, alter its `gateId` or its `programId` and legitimately
 * recompute `ratificationDigest`, or simply make it unparseable. In every case the
 * identity became UNRESERVED, the coherent V1->V2 rewrite fell through to ordinary
 * V2 admission, and the exploit contributed its five paths again. Reproduced: five
 * of five.
 *
 * The mistake is structural rather than a missing check. If the document that
 * carries the decision is also the only witness that the decision exists, then
 * destroying it is indistinguishable from the decision never having been made —
 * and the fail-closed direction is unreachable by construction.
 *
 * THE FIX IS AN INDEPENDENT ANCHOR, AND THE PROJECT ALREADY HAS THE IDIOM.
 * `HISTORICAL_RECONCILIATION_OWNER_AUTHORIZATION` is one owner document that
 * ENUMERATES the authorized historical reconciliations, while each per-Gate
 * `HISTORICAL_RECONCILIATION_RECORD` pins that authorization's path and digest.
 * The registry says WHICH items exist; the record carries the detail. This module
 * reuses that shape exactly rather than inventing a second trust framework.
 *
 * Reserved-ness is therefore the UNION of three independent witnesses:
 *
 *   1. the owner reservation registry lists the identity
 *   2. a ratification document in the ratifications directory declares it
 *   3. a bridge exists naming that programId
 *
 * Any ONE of them is enough to make the identity RESERVED. Validity is judged
 * separately and strictly: reserved with a missing, malformed, mismatched or
 * conflicting ratification is RESERVED_BUT_AUTHORITY_INVALID, which BLOCKS. There
 * is no path from "the evidence is damaged" to "ordinary V2 admission".
 *
 * THE HONEST BOUNDARY. This is defence in depth, not indestructibility: an actor
 * with write access to the whole governed tree who removes the registry entry AND
 * the ratification AND the bridge has removed every trace of the decision. What is
 * closed is the class the audit found — losing or corrupting ONE supporting
 * document silently releasing the identity. Three independent owner documents must
 * now be destroyed together, and each of the three is itself a governed path whose
 * disappearance is visible to the cohort and to FINAL_GATE_INTEGRITY.
 *
 * Nothing here consults Git, timestamps, file mtimes, filenames or the FGI delta.
 * Git remains the independent comparator, never the trust root.
 */
export const HISTORICAL_IDENTITY_RESERVATION_REGISTRY_DOCUMENT = 'HISTORICAL_IDENTITY_RESERVATION_OWNER_AUTHORIZATION';
export const RESERVATION_REGISTRY_PATH = 'governance/sources/HISTORICAL_IDENTITY_RESERVATION_OWNER_AUTHORIZATION_R1.json';

/** Reserved, but the authority proving what it reserves is not usable. Always BLOCK. */
export const REASON_RESERVED_BUT_AUTHORITY_INVALID = 'RESERVED_BUT_AUTHORITY_INVALID';

/** Where a reservation witness came from. Reported so a reader can see WHY. */
export const WITNESS_REGISTRY = 'OWNER_RESERVATION_REGISTRY';
export const WITNESS_RATIFICATION = 'RATIFICATION_DOCUMENT';
export const WITNESS_BRIDGE = 'HISTORICAL_ADMISSION_BRIDGE';

/** The reason a reserved identity presenting non-ratified bytes is refused. */
export const REASON_IDENTITY_RESERVED_MISMATCH = 'HISTORICAL_IDENTITY_RESERVED_MISMATCH';
/** The reason a reserved identity may never be used to publish. */
export const REASON_IDENTITY_RESERVED_NOT_PUBLISHABLE = 'HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE';
/** The reason a reserved identity has ratification but no valid bridge. */
export const REASON_IDENTITY_RESERVED_UNBRIDGED = 'HISTORICAL_IDENTITY_RESERVED_UNBRIDGED';

/** The permission fields a ratification MUST deny, every one of them, explicitly. */
export const RATIFICATION_DENIED_PERMISSIONS = Object.freeze([
  'grantsPublicationPermission',
  'grantsExecutionPermission',
  'grantsStartPermission',
  'grantsStatusTransitionPermission',
  'grantsFutureBytePermission',
  'genericV1Admission'
]);

/** The three roles a ratified historical identity binds, in a fixed order. */
export const RATIFIED_OBJECT_ROLES = Object.freeze(['historicalAuthority', 'historicalManifest', 'historicalConsumption']);

/** The one historical publication class a bridge may admit. */
export const HISTORICAL_CLASS_LEGACY_V1_NORMAL_MAINTENANCE = 'LEGACY_V1_NORMAL_MAINTENANCE';
/** What admission means: a predecessor, never a licence to publish now. */
export const ADMISSION_CLASS_HISTORICAL_PREDECESSOR = 'HISTORICAL_PREDECESSOR_ADMITTED';

export const BRIDGE_DIRECTORY = 'governance/authority/historical-bridges';

const SHA256_RE = /^[0-9a-f]{64}$/;
const GATE_RE = /^GATE[0-9]{2}$/;

/**
 * The digest the bridge commits to.
 *
 * Computed over the admitted IDENTITY only — never over the bridge's prose or its
 * issuance metadata — so the fields that decide what is admitted cannot be edited
 * without the document failing its own recomputation.
 */
export function computeHistoricalAdmissionBridgeDigest(bridge) {
  return sha256Canonical({
    document: HISTORICAL_ADMISSION_BRIDGE_DOCUMENT,
    projectId: bridge?.projectId ?? null,
    gateId: bridge?.gateId ?? null,
    programId: bridge?.programId ?? null,
    historicalPublicationClass: bridge?.historicalPublicationClass ?? null,
    admissionClass: bridge?.admissionClass ?? null,
    maxUse: bridge?.maxUse ?? null,
    historicalAuthority: {
      path: bridge?.historicalAuthority?.path ?? null,
      sha256: bridge?.historicalAuthority?.sha256 ?? null,
      schemaVersion: bridge?.historicalAuthority?.schemaVersion ?? null
    },
    historicalManifest: {
      path: bridge?.historicalManifest?.path ?? null,
      sha256: bridge?.historicalManifest?.sha256 ?? null,
      schemaVersion: bridge?.historicalManifest?.schemaVersion ?? null
    },
    historicalConsumption: {
      path: bridge?.historicalConsumption?.path ?? null,
      sha256: bridge?.historicalConsumption?.sha256 ?? null,
      schemaVersion: bridge?.historicalConsumption?.schemaVersion ?? null
    },
    // The Owner ratification this bridge derives its authority from. Inside the
    // digest so a bridge cannot be silently repointed at a different — or absent —
    // ratification while keeping its seal intact.
    ratification: {
      path: bridge?.ratification?.path ?? null,
      sha256: bridge?.ratification?.sha256 ?? null
    }
  });
}

function shapeFinding(code, detail = null) { return { valid: false, findings: [{ code, detail }] }; }

/** Shape and self-binding validation. Nothing here reads the objects being admitted. */
export function validateHistoricalAdmissionBridgeShape(bridge) {
  if (!bridge || typeof bridge !== 'object' || Array.isArray(bridge)) return shapeFinding('BRIDGE_ABSENT_OR_UNREADABLE');
  if (bridge.document !== HISTORICAL_ADMISSION_BRIDGE_DOCUMENT) return shapeFinding('BRIDGE_DOCUMENT_KIND_INVALID', bridge.document ?? null);
  if (bridge.schemaVersion !== 1) return shapeFinding('BRIDGE_SCHEMA_VERSION_UNSUPPORTED', bridge.schemaVersion ?? null);
  if (bridge.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') return shapeFinding('BRIDGE_AUTHORITY_MODE_INVALID', bridge.authorityMode ?? null);
  if (bridge.issuedBy !== 'PROJECT_OWNER') return shapeFinding('BRIDGE_ISSUER_INVALID', bridge.issuedBy ?? null);
  if (!GATE_RE.test(bridge.gateId ?? '')) return shapeFinding('BRIDGE_GATE_ID_INVALID', bridge.gateId ?? null);
  if (typeof bridge.programId !== 'string' || !bridge.programId) return shapeFinding('BRIDGE_PROGRAM_ID_INVALID');
  if (bridge.historicalPublicationClass !== HISTORICAL_CLASS_LEGACY_V1_NORMAL_MAINTENANCE) {
    return shapeFinding('BRIDGE_HISTORICAL_CLASS_UNSUPPORTED', bridge.historicalPublicationClass ?? null);
  }
  if (bridge.admissionClass !== ADMISSION_CLASS_HISTORICAL_PREDECESSOR) {
    return shapeFinding('BRIDGE_ADMISSION_CLASS_UNSUPPORTED', bridge.admissionClass ?? null);
  }
  // ONE USE, AND ONE OBJECT. A bridge that could admit repeatedly, or that left the
  // count open, would be a standing exception rather than a bounded one.
  if (bridge.maxUse !== 1) return shapeFinding('BRIDGE_MAX_USE_INVALID', bridge.maxUse ?? null);

  for (const role of ['historicalAuthority', 'historicalManifest', 'historicalConsumption']) {
    const entry = bridge[role];
    if (!entry || typeof entry !== 'object') return shapeFinding('BRIDGE_BOUND_OBJECT_MISSING', role);
    if (typeof entry.path !== 'string' || !entry.path.startsWith('governance/') || entry.path.includes('..')) {
      return shapeFinding('BRIDGE_BOUND_PATH_INVALID', role);
    }
    if (!SHA256_RE.test(entry.sha256 ?? '')) return shapeFinding('BRIDGE_BOUND_SHA_INVALID', role);
  }
  // The whole point of the bridge is that the manifest it admits is the V1 one. A
  // bridge naming a V2 manifest would be admitting something that needs no bridge.
  if (bridge.historicalManifest.schemaVersion !== 1) return shapeFinding('BRIDGE_MANIFEST_SCHEMA_NOT_LEGACY', bridge.historicalManifest.schemaVersion ?? null);

  // A BRIDGE WITHOUT A RATIFICATION IS AN UNSIGNED CLAIM. Its own seal proves it is
  // internally consistent and nothing more; the authority to admit has to come from
  // the independently issued Owner decision it names here.
  if (!bridge.ratification || typeof bridge.ratification !== 'object') return shapeFinding('BRIDGE_RATIFICATION_ABSENT');
  if (typeof bridge.ratification.path !== 'string' || !bridge.ratification.path.startsWith('governance/') || bridge.ratification.path.includes('..')) {
    return shapeFinding('BRIDGE_RATIFICATION_PATH_INVALID', bridge.ratification.path ?? null);
  }
  if (!SHA256_RE.test(bridge.ratification.sha256 ?? '')) return shapeFinding('BRIDGE_RATIFICATION_SHA_INVALID');
  // A bridge may never assert a live permission. The ratification denies them all,
  // and a bridge that claimed one would be widening a decision it does not own.
  for (const field of RATIFICATION_DENIED_PERMISSIONS) {
    if (Object.hasOwn(bridge, field) && bridge[field] !== false) return shapeFinding('BRIDGE_PERMISSION_NOT_DENIED', field);
  }

  const expected = computeHistoricalAdmissionBridgeDigest(bridge);
  if (bridge.bridgeDigest !== expected) return shapeFinding('BRIDGE_DIGEST_MISMATCH', expected);
  return { valid: true, findings: [] };
}

/**
 * Does `bridge` admit THESE exact objects?
 *
 * Pure: every input is bytes the caller already read. Each clause is checked
 * separately so a refusal names the precise thing that did not match.
 */
export function evaluateHistoricalAdmission({
  bridge, gateId, authority, authoritySha256, authorityPath,
  manifest, manifestSha256, consumption, consumptionSha256
}) {
  const shape = validateHistoricalAdmissionBridgeShape(bridge);
  if (!shape.valid) return { admitted: false, reason: shape.findings[0].code, detail: shape.findings[0].detail ?? null };

  if (bridge.gateId !== gateId) return { admitted: false, reason: 'BRIDGE_GATE_MISMATCH', detail: bridge.gateId };
  if (bridge.programId !== authority?.programId) return { admitted: false, reason: 'BRIDGE_PROGRAM_MISMATCH', detail: authority?.programId ?? null };

  if (bridge.historicalAuthority.path !== authorityPath) return { admitted: false, reason: 'BRIDGE_AUTHORITY_PATH_MISMATCH', detail: authorityPath ?? null };
  if (bridge.historicalAuthority.sha256 !== authoritySha256) return { admitted: false, reason: 'BRIDGE_AUTHORITY_SHA_MISMATCH', detail: authorityPath ?? null };

  if (bridge.historicalManifest.path !== authority?.authorizedPathManifestPath) return { admitted: false, reason: 'BRIDGE_MANIFEST_PATH_MISMATCH', detail: authority?.authorizedPathManifestPath ?? null };
  if (bridge.historicalManifest.sha256 !== manifestSha256) return { admitted: false, reason: 'BRIDGE_MANIFEST_SHA_MISMATCH', detail: authority?.authorizedPathManifestPath ?? null };
  if (manifest?.schemaVersion !== bridge.historicalManifest.schemaVersion) return { admitted: false, reason: 'BRIDGE_MANIFEST_SCHEMA_MISMATCH', detail: String(manifest?.schemaVersion ?? null) };

  if (bridge.historicalConsumption.path !== authority?.consumptionRecordPath) return { admitted: false, reason: 'BRIDGE_CONSUMPTION_PATH_MISMATCH', detail: authority?.consumptionRecordPath ?? null };
  if (bridge.historicalConsumption.sha256 !== consumptionSha256) return { admitted: false, reason: 'BRIDGE_CONSUMPTION_SHA_MISMATCH', detail: authority?.consumptionRecordPath ?? null };

  // THE RECEIPT MUST NOT BE ITS OWN PREDECESSOR. A consumption record that cited
  // the bridge as the authority it was published under would close the loop the
  // bridge exists to open, so the bridge refuses to admit anything that names it.
  if (consumption?.authorityId === bridge.bridgeId) return { admitted: false, reason: 'BRIDGE_SELF_PREDECESSOR_REFUSED', detail: bridge.bridgeId ?? null };
  if (consumption?.programId !== bridge.programId) return { admitted: false, reason: 'BRIDGE_CONSUMPTION_PROGRAM_MISMATCH', detail: consumption?.programId ?? null };

  return { admitted: true, reason: null, detail: null, bridgeId: bridge.bridgeId ?? null, bridgePath: bridge.__path ?? null };
}

/**
 * The digest an Owner ratification commits to.
 *
 * Over the RESERVED IDENTITY, the three exact bound objects, and every denied
 * permission — so a copy that quietly flips `grantsPublicationPermission` to true,
 * or widens the identity, or repoints one digest, fails its own recomputation
 * rather than becoming a broader authority.
 */
export function computeHistoricalIdentityRatificationDigest(ratification) {
  const bound = {};
  for (const role of RATIFIED_OBJECT_ROLES) {
    bound[role] = {
      path: ratification?.[role]?.path ?? null,
      sha256: ratification?.[role]?.sha256 ?? null,
      byteLength: ratification?.[role]?.byteLength ?? null,
      schemaVersion: ratification?.[role]?.schemaVersion ?? null
    };
  }
  const denied = {};
  for (const field of RATIFICATION_DENIED_PERMISSIONS) denied[field] = ratification?.[field] ?? null;
  return sha256Canonical({
    documentKind: HISTORICAL_IDENTITY_RATIFICATION_DOCUMENT,
    decisionId: ratification?.decisionId ?? null,
    projectId: ratification?.projectId ?? null,
    gateId: ratification?.gateId ?? null,
    programId: ratification?.programId ?? null,
    purpose: ratification?.purpose ?? null,
    ratificationOnly: ratification?.ratificationOnly ?? null,
    reservesHistoricalIdentity: ratification?.reservesHistoricalIdentity ?? null,
    maxUse: ratification?.maxUse ?? null,
    ...denied,
    ...bound
  });
}

/**
 * Shape, permission and self-binding validation of an Owner ratification.
 *
 * Reads nothing. A ratification that fails here reserves nothing and admits
 * nothing — but the CALLER still treats its declared identity as reserved when it
 * is merely invalid rather than absent, because a broken ratification must not be
 * a way to un-reserve an identity.
 */
export function validateHistoricalIdentityRatificationShape(ratification) {
  if (!ratification || typeof ratification !== 'object' || Array.isArray(ratification)) return shapeFinding('RATIFICATION_ABSENT_OR_UNREADABLE');
  if (ratification.documentKind !== HISTORICAL_IDENTITY_RATIFICATION_DOCUMENT) return shapeFinding('RATIFICATION_DOCUMENT_KIND_INVALID', ratification.documentKind ?? null);
  if (ratification.schemaVersion !== 1) return shapeFinding('RATIFICATION_SCHEMA_VERSION_UNSUPPORTED', ratification.schemaVersion ?? null);
  if (ratification.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') return shapeFinding('RATIFICATION_AUTHORITY_MODE_INVALID', ratification.authorityMode ?? null);
  if (ratification.issuedBy !== 'PROJECT_OWNER') return shapeFinding('RATIFICATION_ISSUER_INVALID', ratification.issuedBy ?? null);
  if (typeof ratification.projectId !== 'string' || !ratification.projectId) return shapeFinding('RATIFICATION_PROJECT_ID_INVALID');
  if (!GATE_RE.test(ratification.gateId ?? '')) return shapeFinding('RATIFICATION_GATE_ID_INVALID', ratification.gateId ?? null);
  if (typeof ratification.programId !== 'string' || !ratification.programId) return shapeFinding('RATIFICATION_PROGRAM_ID_INVALID');
  if (ratification.ratificationOnly !== true) return shapeFinding('RATIFICATION_NOT_RATIFICATION_ONLY');
  if (ratification.reservesHistoricalIdentity !== true) return shapeFinding('RATIFICATION_DOES_NOT_RESERVE_IDENTITY');
  if (ratification.maxUse !== 1) return shapeFinding('RATIFICATION_MAX_USE_INVALID', ratification.maxUse ?? null);

  // EVERY permission is denied EXPLICITLY. An omitted field is a refusal, not a
  // default: a ratification that simply forgot to mention publication must not be
  // read as one that permits it, and must not be read as one that denies it either.
  for (const field of RATIFICATION_DENIED_PERMISSIONS) {
    if (ratification[field] !== false) return shapeFinding('RATIFICATION_PERMISSION_NOT_DENIED', field);
  }

  for (const role of RATIFIED_OBJECT_ROLES) {
    const entry = ratification[role];
    if (!entry || typeof entry !== 'object') return shapeFinding('RATIFICATION_BOUND_OBJECT_MISSING', role);
    if (typeof entry.path !== 'string' || !entry.path.startsWith('governance/') || entry.path.includes('..')) {
      return shapeFinding('RATIFICATION_BOUND_PATH_INVALID', role);
    }
    if (!SHA256_RE.test(entry.sha256 ?? '')) return shapeFinding('RATIFICATION_BOUND_SHA_INVALID', role);
    if (!Number.isInteger(entry.byteLength) || entry.byteLength < 0) return shapeFinding('RATIFICATION_BOUND_BYTE_LENGTH_INVALID', role);
    if (!Number.isInteger(entry.schemaVersion)) return shapeFinding('RATIFICATION_BOUND_SCHEMA_VERSION_INVALID', role);
  }

  const expected = computeHistoricalIdentityRatificationDigest(ratification);
  if (ratification.ratificationDigest !== expected) return shapeFinding('RATIFICATION_DIGEST_MISMATCH', expected);
  return { valid: true, findings: [] };
}

/** The identity a ratification or bridge reserves, as a single comparable key. */
export function reservedIdentityKey({ projectId, gateId, programId }) {
  return `${projectId ?? ''}::${gateId ?? ''}::${programId ?? ''}`;
}

function readJsonOrNull(file) {
  try {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

/**
 * Every bridge issued for `gateId`, keyed by the programId it admits.
 *
 * A duplicate programId is a refusal for BOTH, never a silent first-wins: two
 * bridges claiming the same identity is a governance defect, and picking one would
 * make the outcome depend on directory order.
 */
export function collectHistoricalAdmissionBridges({ root, gateId }) {
  const byProgram = new Map();
  const findings = [];
  const directory = path.resolve(root, ...BRIDGE_DIRECTORY.split('/'), gateId);
  if (!fs.existsSync(directory)) return { byProgram, findings };
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const relativePath = `${BRIDGE_DIRECTORY}/${gateId}/${name}`;
    const bridge = readJsonOrNull(path.join(directory, name));
    if (bridge?.document !== HISTORICAL_ADMISSION_BRIDGE_DOCUMENT) continue;
    const shape = validateHistoricalAdmissionBridgeShape(bridge);
    if (!shape.valid) { findings.push({ code: 'BRIDGE_INVALID', detail: `${relativePath}:${shape.findings[0].code}` }); continue; }
    if (bridge.gateId !== gateId) { findings.push({ code: 'BRIDGE_GATE_MISMATCH', detail: relativePath }); continue; }
    if (byProgram.has(bridge.programId)) {
      findings.push({ code: 'BRIDGE_DUPLICATE_PROGRAM', detail: bridge.programId });
      byProgram.set(bridge.programId, null);
      continue;
    }
    byProgram.set(bridge.programId, { ...bridge, __path: relativePath });
  }
  return { byProgram, findings };
}

/**
 * Every Owner ratification issued for `gateId`, keyed by reserved identity.
 *
 * An INVALID ratification still reserves. That is the fail-closed direction and it
 * matters: if a broken ratification simply vanished, corrupting one would be a way
 * to release a reserved identity back into ordinary V2 admission, which is the B05
 * exploit with an extra step. A duplicate reservation refuses both, never
 * first-wins, so the outcome cannot depend on directory order.
 */
export function collectHistoricalIdentityRatifications({ root, gateId }) {
  const byIdentity = new Map();
  const findings = [];
  const directory = path.resolve(root, ...RATIFICATION_DIRECTORY.split('/'), gateId);
  if (!fs.existsSync(directory)) return { byIdentity, findings };
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const relativePath = `${RATIFICATION_DIRECTORY}/${gateId}/${name}`;
    const ratification = readJsonOrNull(path.join(directory, name));
    if (ratification?.documentKind !== HISTORICAL_IDENTITY_RATIFICATION_DOCUMENT) continue;
    const shape = validateHistoricalIdentityRatificationShape(ratification);
    const key = reservedIdentityKey(ratification);
    if (byIdentity.has(key)) {
      findings.push({ code: 'RATIFICATION_DUPLICATE_IDENTITY', detail: key });
      byIdentity.set(key, { reserved: true, valid: false, reason: 'RATIFICATION_DUPLICATE_IDENTITY', path: relativePath, ratification: null, sha256: null });
      continue;
    }
    if (!shape.valid) {
      findings.push({ code: 'RATIFICATION_INVALID', detail: `${relativePath}:${shape.findings[0].code}` });
      byIdentity.set(key, { reserved: true, valid: false, reason: shape.findings[0].code, path: relativePath, ratification: null, sha256: null });
      continue;
    }
    if (ratification.gateId !== gateId) { findings.push({ code: 'RATIFICATION_GATE_MISMATCH', detail: relativePath }); continue; }
    byIdentity.set(key, {
      reserved: true, valid: true, reason: null, path: relativePath,
      ratification, sha256: sha256Of(root, relativePath)
    });
  }
  return { byIdentity, findings };
}

/**
 * The digest the owner reservation registry commits to.
 *
 * Over the reserved identities only, so the list of WHAT is reserved cannot be
 * shortened without the registry failing its own recomputation.
 */
export function computeReservationRegistryDigest(registry) {
  return sha256Canonical({
    document: HISTORICAL_IDENTITY_RESERVATION_REGISTRY_DOCUMENT,
    authorityId: registry?.authorityId ?? null,
    reservedHistoricalIdentities: (registry?.reservedHistoricalIdentities ?? []).map((entry) => ({
      reservationId: entry?.reservationId ?? null,
      projectId: entry?.projectId ?? null,
      gateId: entry?.gateId ?? null,
      programId: entry?.programId ?? null,
      ratificationPath: entry?.ratificationPath ?? null,
      // The ratification's own IDENTITY digest, never its file hash.
      //
      // A file hash here would be circular: the ratification pins the registry's
      // file hash as its back-reference, so each document's hash would depend on
      // the other's and neither could be sealed. `HISTORICAL_RECONCILIATION_OWNER_
      // AUTHORIZATION` solves this the same way — it pins `evidenceCohortDigest`,
      // a content digest, while the record pins the authorization's file hash. The
      // identity digest excludes the back-reference by construction, so the binding
      // is mutual without being recursive.
      ratificationDigest: entry?.ratificationDigest ?? null
    }))
  });
}

export function validateReservationRegistryShape(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) return shapeFinding('RESERVATION_REGISTRY_ABSENT_OR_UNREADABLE');
  if (registry.document !== HISTORICAL_IDENTITY_RESERVATION_REGISTRY_DOCUMENT) return shapeFinding('RESERVATION_REGISTRY_DOCUMENT_KIND_INVALID', registry.document ?? null);
  if (registry.schemaVersion !== 1) return shapeFinding('RESERVATION_REGISTRY_SCHEMA_VERSION_UNSUPPORTED', registry.schemaVersion ?? null);
  if (registry.issuedBy !== 'PROJECT_OWNER') return shapeFinding('RESERVATION_REGISTRY_ISSUER_INVALID', registry.issuedBy ?? null);
  if (registry.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY') return shapeFinding('RESERVATION_REGISTRY_AUTHORITY_MODE_INVALID', registry.authorityMode ?? null);
  if (!Array.isArray(registry.reservedHistoricalIdentities)) return shapeFinding('RESERVATION_REGISTRY_ENTRIES_INVALID');
  for (const entry of registry.reservedHistoricalIdentities) {
    if (!entry || typeof entry !== 'object') return shapeFinding('RESERVATION_REGISTRY_ENTRY_MALFORMED');
    if (!GATE_RE.test(entry.gateId ?? '')) return shapeFinding('RESERVATION_REGISTRY_ENTRY_GATE_INVALID', entry.gateId ?? null);
    if (typeof entry.programId !== 'string' || !entry.programId) return shapeFinding('RESERVATION_REGISTRY_ENTRY_PROGRAM_INVALID');
    if (typeof entry.ratificationPath !== 'string' || !entry.ratificationPath.startsWith('governance/')) return shapeFinding('RESERVATION_REGISTRY_ENTRY_PATH_INVALID', entry.programId);
    if (!SHA256_RE.test(entry.ratificationDigest ?? '')) return shapeFinding('RESERVATION_REGISTRY_ENTRY_DIGEST_INVALID', entry.programId);
  }
  const expected = computeReservationRegistryDigest(registry);
  if (registry.registryDigest !== expected) return shapeFinding('RESERVATION_REGISTRY_DIGEST_MISMATCH', expected);
  return { valid: true, findings: [] };
}

/**
 * EVERY IDENTITY THAT IS RESERVED FOR `gateId`, from all three witnesses.
 *
 * A witness only ever ADDS a reservation; none of them can remove one. That
 * asymmetry is the whole permanence property: destroying evidence can never be a
 * way to make an identity free, only a way to make it unusable.
 *
 * A ratification whose own identity fields were altered still witnesses the
 * identity it NOW claims — and the registry and the bridge still witness the
 * ORIGINAL one, which is why P1-C and P1-D fail closed rather than migrating the
 * reservation to wherever the attacker pointed it.
 */
export function collectReservedHistoricalIdentities({ root, gateId, ratifications = null, bridges = null }) {
  const reserved = new Map();
  const findings = [];
  const witness = (key, source, detail = null) => {
    if (!reserved.has(key)) reserved.set(key, { key, witnesses: [], registryEntry: null });
    const entry = reserved.get(key);
    if (!entry.witnesses.includes(source)) entry.witnesses.push(source);
    if (source === WITNESS_REGISTRY) entry.registryEntry = detail;
  };

  /* ---- 1. the owner reservation registry ------------------------------- */
  const registryFile = path.resolve(root, ...RESERVATION_REGISTRY_PATH.split('/'));
  const registry = readJsonOrNull(registryFile);
  if (registry !== null) {
    const shape = validateReservationRegistryShape(registry);
    if (!shape.valid) {
      // An invalid registry cannot be trusted to say what is reserved, but it is
      // proof that reservations EXIST. Its declared entries are still honoured as
      // witnesses and the defect is reported, because discarding them would make
      // corrupting the registry the sixth bypass.
      findings.push({ code: 'RESERVATION_REGISTRY_INVALID', detail: shape.findings[0].code });
    }
    for (const entry of Array.isArray(registry.reservedHistoricalIdentities) ? registry.reservedHistoricalIdentities : []) {
      if (entry?.gateId !== gateId) continue;
      witness(reservedIdentityKey(entry), WITNESS_REGISTRY, { ...entry, registryValid: shape.valid });
    }
  }

  /* ---- 2. any ratification document that declares a reservation --------- */
  //
  // Matched on the CONTENT of the directory rather than on `documentKind` alone.
  // Corrupting the kind was bypass P1-B: the file stopped being discoverable as a
  // ratification and the identity silently became free. A parseable file sitting in
  // the ratifications directory that names a Gate and a program is treated as a
  // reservation witness whatever it calls itself.
  const resolvedRatifications = ratifications ?? collectHistoricalIdentityRatifications({ root, gateId });
  for (const [key] of resolvedRatifications.byIdentity) witness(key, WITNESS_RATIFICATION);
  const directory = path.resolve(root, ...RATIFICATION_DIRECTORY.split('/'), gateId);
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
      const document = readJsonOrNull(path.join(directory, name));
      if (document === null) {
        // Unparseable: it cannot say which identity it reserves, so it adds no
        // witness of its own — the registry and the bridge carry that case — but it
        // is a defect and is reported rather than stepped over.
        findings.push({ code: 'RATIFICATION_UNREADABLE', detail: `${RATIFICATION_DIRECTORY}/${gateId}/${name}` });
        continue;
      }
      if (typeof document.programId !== 'string' || !document.programId) continue;
      if (document.gateId !== gateId) continue;
      witness(reservedIdentityKey(document), WITNESS_RATIFICATION);
    }
  }

  /* ---- 3. any bridge naming a program ---------------------------------- */
  const resolvedBridges = bridges ?? collectHistoricalAdmissionBridges({ root, gateId });
  for (const [programId, bridge] of resolvedBridges.byProgram) {
    if (typeof programId !== 'string' || !programId) continue;
    witness(reservedIdentityKey({ projectId: bridge?.projectId ?? null, gateId, programId }), WITNESS_BRIDGE);
  }

  return { reserved, findings, registryPresent: registry !== null };
}

/**
 * THE ONE HISTORICAL-IDENTITY DECISION, consumed by every caller.
 *
 * The cohort derivation, the canonical publisher and the current-byte proof all ask
 * this function rather than each forming an opinion. That is not tidiness — three
 * components asking the same question over the same bytes and answering differently
 * is the exact defect class this repository has already paid for twice, and a
 * reservation enforced in only one of them would be a reservation an attacker
 * routes around by choosing a different consumer.
 *
 * Returns, for the source described by `authority`:
 *
 *   reserved  whether this (projectId, gateId, programId) is an Owner-reserved
 *             historical identity at all. Almost every source is not.
 *   decision  when reserved: ADMIT_HISTORICAL, or a BLOCK with a precise reason.
 *
 * The ratified triple is compared BYTE FOR BYTE — path, digest, length and schema
 * version of all three objects — and the bridge is then required to be bound to
 * that same ratification, so admission authority originates from the Owner document
 * rather than from the bridge's own seal.
 */
export function resolveHistoricalIdentityDecision({
  root, gateId, authority, authorityPath, authoritySha256,
  manifest, manifestSha256, consumption, consumptionSha256,
  ratifications = null, bridges = null
}) {
  const resolvedRatifications = ratifications ?? collectHistoricalIdentityRatifications({ root, gateId });
  const resolvedBridges = bridges ?? collectHistoricalAdmissionBridges({ root, gateId });

  // RESERVED-NESS COMES FROM THE WITNESSES, NOT FROM THE RATIFICATION.
  //
  // This is the permanence repair. Asking the ratification whether it exists is
  // what made deleting it a release; the question is now asked of the owner
  // registry, the ratifications directory and the bridges together, and no witness
  // can subtract a reservation.
  const reservation = collectReservedHistoricalIdentities({
    root, gateId, ratifications: resolvedRatifications, bridges: resolvedBridges
  });
  const programId = authority?.programId ?? null;
  // Matched on Gate + program, never on a field the judged source controls: a
  // maintenance authority carries no projectId, and letting it supply one would let
  // a source dodge its own reservation by naming a different project.
  let witnessed = null;
  for (const [candidateKey, candidate] of reservation.reserved) {
    const [, candidateGate, candidateProgram] = candidateKey.split('::');
    if (candidateGate === gateId && candidateProgram === programId) { witnessed = candidate; break; }
  }
  if (!witnessed) return { reserved: false, decision: null, reason: null };

  // From here the identity IS reserved. Every remaining outcome is either an
  // admission of the exact ratified bytes or a BLOCK; there is no route back to
  // ordinary V2 admission, which is the property the five bypasses each defeated.
  const reservedBase = { reserved: true, witnesses: witnessed.witnesses, reservationSource: witnessed.witnesses.join('+') };

  let entry = null;
  for (const [candidateKey, candidate] of resolvedRatifications.byIdentity) {
    const [, candidateGate, candidateProgram] = candidateKey.split('::');
    if (candidateGate === gateId && candidateProgram === programId) { entry = candidate; break; }
  }
  if (!entry) {
    // Reserved, but the document that says WHAT was ratified is gone or no longer
    // discoverable. Fail closed: the decision stands, the evidence for its detail
    // does not.
    return { ...reservedBase, decision: 'BLOCK', reason: REASON_RESERVED_BUT_AUTHORITY_INVALID, detail: 'RATIFICATION_ABSENT_OR_UNDISCOVERABLE' };
  }
  if (!entry.valid) {
    return { ...reservedBase, decision: 'BLOCK', reason: REASON_RESERVED_BUT_AUTHORITY_INVALID, detail: entry.reason, ratificationPath: entry.path };
  }
  const ratification = entry.ratification;

  // The ratification must be the one the OWNER REGISTRY names for this identity,
  // by path and by digest. Without this a valid-looking ratification substituted
  // for the registered one would be honoured on its own say-so.
  const registryEntry = witnessed.registryEntry;
  if (registryEntry) {
    if (registryEntry.registryValid !== true) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_RESERVED_BUT_AUTHORITY_INVALID, detail: 'RESERVATION_REGISTRY_INVALID', ratificationPath: entry.path };
    }
    if (registryEntry.ratificationPath !== entry.path || registryEntry.ratificationDigest !== ratification.ratificationDigest) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_RESERVED_BUT_AUTHORITY_INVALID, detail: 'REGISTRY_RATIFICATION_BINDING_INVALID', ratificationPath: entry.path };
    }
    // And the ratification must point back, exactly as a reconciliation record
    // pins its owner authorization. A one-way reference is half a binding.
    if (ratification.ownerAuthorizationPath !== RESERVATION_REGISTRY_PATH
        || ratification.ownerAuthorizationSha256 !== sha256Of(root, RESERVATION_REGISTRY_PATH)) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_RESERVED_BUT_AUTHORITY_INVALID, detail: 'RATIFICATION_REGISTRY_BACKREFERENCE_INVALID', ratificationPath: entry.path };
    }
  }

  // The exact ratified triple, byte for byte, all four facets of each object.
  const presented = {
    historicalAuthority: { path: authorityPath, sha256: authoritySha256, byteLength: null, schemaVersion: authority?.schemaVersion ?? null },
    historicalManifest: { path: authority?.authorizedPathManifestPath ?? null, sha256: manifestSha256, byteLength: null, schemaVersion: manifest?.schemaVersion ?? null },
    historicalConsumption: { path: authority?.consumptionRecordPath ?? null, sha256: consumptionSha256, byteLength: null, schemaVersion: consumption?.schemaVersion ?? null }
  };
  for (const role of RATIFIED_OBJECT_ROLES) {
    const ratified = ratification[role];
    const actual = presented[role];
    if (ratified.path !== actual.path) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_IDENTITY_RESERVED_MISMATCH, detail: `${role}:PATH`, ratificationPath: entry.path };
    }
    if (ratified.sha256 !== actual.sha256) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_IDENTITY_RESERVED_MISMATCH, detail: `${role}:SHA256`, ratificationPath: entry.path };
    }
    if (actual.schemaVersion !== null && ratified.schemaVersion !== actual.schemaVersion) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_IDENTITY_RESERVED_MISMATCH, detail: `${role}:SCHEMA_VERSION`, ratificationPath: entry.path };
    }
    // The declared length must match the bytes actually on disk, so a ratification
    // cannot bind a digest to a length the file does not have.
    const observed = byteLengthOf(root, ratified.path);
    if (observed !== null && ratified.byteLength !== observed) {
      return { ...reservedBase, decision: 'BLOCK', reason: REASON_IDENTITY_RESERVED_MISMATCH, detail: `${role}:BYTE_LENGTH`, ratificationPath: entry.path };
    }
  }

  // The bridge must exist, be valid, admit THESE bytes, and be bound to THIS
  // ratification. Its own seal proves consistency, never authority.
  const bridge = resolvedBridges.byProgram.get(authority?.programId) ?? null;
  if (!bridge) {
    return { ...reservedBase, decision: 'BLOCK', reason: REASON_IDENTITY_RESERVED_UNBRIDGED, detail: authority?.programId ?? null, ratificationPath: entry.path };
  }
  if (bridge.ratification?.path !== entry.path || bridge.ratification?.sha256 !== entry.sha256) {
    return { ...reservedBase, decision: 'BLOCK', reason: 'BRIDGE_RATIFICATION_BINDING_INVALID', detail: bridge.ratification?.path ?? null, ratificationPath: entry.path };
  }
  const admission = evaluateHistoricalAdmission({
    bridge, gateId, authority, authorityPath, authoritySha256,
    manifest, manifestSha256, consumption, consumptionSha256
  });
  if (!admission.admitted) {
    return { ...reservedBase, decision: 'BLOCK', reason: admission.reason, detail: admission.detail, ratificationPath: entry.path };
  }
  return {
    ...reservedBase, decision: 'ADMIT_HISTORICAL', reason: null, detail: null,
    ratificationPath: entry.path, ratificationSha256: entry.sha256,
    bridgeId: bridge.bridgeId ?? null, bridgePath: bridge.__path ?? null,
    decisionId: ratification.decisionId ?? null
  };
}

/** Byte length of a repo-relative file, or null. */
export function byteLengthOf(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return fs.statSync(file).size;
  } catch { return null; }
}

/** SHA-256 of a repo-relative file, or null. */
export function sha256Of(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch { return null; }
}
