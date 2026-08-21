/**
 * CURRENT_BYTE_AUTHORIZATION — whether the bytes a canonical path holds RIGHT NOW
 * were produced by a valid authorized publication that binds those exact bytes.
 *
 * THE DEFECT THIS EXISTS TO CLOSE, STATED EXACTLY.
 *
 * `deriveCanonicalAuthorizedCohort` answers a question about PATHS: which files an
 * authority permitted a program to touch. FINAL_GATE_INTEGRITY then subtracts that
 * path set from the observed Git delta and blocks whatever is left over. Both are
 * correct and neither asks the question that actually matters:
 *
 *     the cohort proves the path was allowed to change.
 *     it does not prove the bytes now sitting there are the bytes anybody authorized.
 *
 * So a path that appeared in ANY authorized cohort acquired permanent authorization
 * for every future byte ever written to it. Publish X as AAA under a real authority,
 * then overwrite X with BBB under no authority at all, and the audit still passed:
 * X is in the cohort, the delta is a subset of the cohort, nothing is left over.
 * A one-time authorization had become a standing licence.
 *
 * THE INVARIANT ESTABLISHED HERE. For every path in the actual delta:
 *
 *     currentSha256 must equal the candidate digest of the APPLICABLE authorized
 *     publication for that path — the terminal element of that path's publication
 *     lineage — and nothing else counts.
 *
 * WHY LINEAGE AND NOT "THE NEWEST RECEIPT".
 *
 * Picking the most recent publication by timestamp would make authorization depend
 * on a field every document author controls, and would leave two publications of
 * the same path with the same timestamp undecidable. Worse, it invites replay: an
 * obsolete receipt re-dated forward would win.
 *
 * The order used instead is CAUSAL and is already recorded in the documents. A
 * pre-state-bound publication declares what each path held BEFORE it ran and
 * certifies what it wrote. Those two digests chain: publication P2 whose declared
 * pre-state for X is exactly P1's certified output for X is P1's successor for X.
 * The APPLICABLE publication is the terminal element of that chain — the one whose
 * output no other publication claims as its input. No clock is consulted, the
 * result is order-independent, and a replayed obsolete receipt is not terminal, so
 * it cannot authorize anything.
 *
 * A path whose lineage has more than one terminal is AMBIGUOUS and BLOCKS. Two
 * unrelated publications both claiming to be the last word on a path is a real
 * governance defect, and guessing between them is exactly how a wrong answer would
 * become a silent one.
 *
 * WHAT IS DELIBERATELY NOT AUTHORIZED HERE.
 *
 * Several authority classes name paths WITHOUT binding their bytes:
 * GATE_START_RECORD's write paths and execution scope, the precontract authority's
 * authorized paths, the execution contract's required outputs, and
 * GATE_AUTHORIZATION_RECORD's DERIVED artifacts. Those documents authorize a path
 * to change and say nothing about what may be written there.
 *
 * They are therefore reported as NO_BYTE_BINDING_AVAILABLE — a BLOCK, not a pass.
 * Treating "the authority did not pin a digest" as "any digest is fine" is the very
 * defect being closed, one level down. The consequence is intended and is the
 * causal direction the repair requires: bytes that need current-byte authorization
 * must be published through a pre-state-bound maintenance program, which does bind
 * them.
 *
 * NO GIT, NO CLOCK. Every input is a document on disk plus the bytes at the path
 * being judged. The derivation must remain an independent judge of what Git
 * shows, so it cannot read Git to decide.
 *
 * ONE LEDGER DEPENDENCY, AND EXACTLY WHERE IT SITS. This header previously also
 * said "no ledger". That was true and it was wrong, and the correction is stated
 * here rather than left for a reader to discover. A STATE_SEAL is the only binding
 * class below whose document can be MANUFACTURED by whoever is being judged: a
 * seal is verified against the bytes on disk, so writing a seal that certifies
 * those bytes takes nothing but write access. Every other binding class descends
 * from an owner authority document that pins digests independently of the file it
 * authorizes. Refusing the ledger therefore did not keep this layer independent —
 * it left the one class with no external anchor holding no anchor at all.
 *
 * The dependency is confined to `collectAuthenticatedClosedStateSealMembers`,
 * which uses the append-only ledger for a single question: which state revisions
 * this repository's governed history actually bound. It is never consulted for
 * ORDER, for RECENCY, or for what any path may contain. Lineage among
 * publications is still decided by the pre-state/output chain alone, and the
 * clock is still not read.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { evaluateMaintenanceSourceAdmissibility, MODE_ADMISSION } from './maintenance-publication-admissibility.mjs';
import {
  collectHistoricalAdmissionBridges,
  collectHistoricalIdentityRatifications,
  resolveHistoricalIdentityDecision
} from './historical-admission-bridge.mjs';
import {
  gateAuthorizationRecordPath,
  gateAuthorizationAuthoritySnapshotPath,
  gateAuthorizationStateCohortRoleClass,
  validateGateAuthorizationRecordShape,
  validateGateAuthorizationAuthorityShape
} from './gate-authorization-authority.mjs';
import { MUTABLE_PROJECTION } from './artifact-classification.mjs';
import { collectAuthenticatedClosedStateSealMembers } from './sealed-state-evidence.mjs';
import {
  collectValidatedOwnerPresentByteBootstrapSuccessorBindings,
  collectValidatedExternalOwnerByteAuthorityBindings
} from './owner-present-byte-bootstrap.mjs';

export const CURRENT_BYTE_AUTHORIZATION_DOCUMENT = 'CURRENT_BYTE_AUTHORIZATION';
export const CURRENT_BYTE_ALGORITHM_VERSION = 'R1';

export const STATUS_AUTHORIZED = 'AUTHORIZED_CURRENT_BYTES';
export const STATUS_BLOCKED = 'BLOCKED';

/** Why a path's current bytes are not authorized. Every BLOCK names exactly one. */
export const REASON_NO_APPLICABLE_AUTHORITY = 'NO_APPLICABLE_AUTHORITY';
export const REASON_NO_BYTE_BINDING = 'NO_BYTE_BINDING_AVAILABLE';
export const REASON_UNAUTHORIZED_BYTES = 'UNAUTHORIZED_CURRENT_BYTES';
export const REASON_LINEAGE_AMBIGUOUS = 'PUBLICATION_LINEAGE_AMBIGUOUS';
export const REASON_ABSENT = 'PATH_ABSENT';

/** The binding classes that can supply an exact candidate digest for a path. */
export const BINDING_MAINTENANCE_PUBLICATION = 'MAINTENANCE_PUBLICATION_COHORT';
export const BINDING_CONSUMPTION_SELF_EXCLUDED = 'MAINTENANCE_CONSUMPTION_SELF_EXCLUDED';
export const BINDING_GATE_AUTHORIZATION_STATE_ARTIFACT = 'GATE_AUTHORIZATION_STATE_ARTIFACT';
/**
 * The authorization-time digest of a MUTABLE_PROJECTION state artifact. It binds
 * the projection's INITIAL bytes and is reported under its own name because it is
 * a different KIND of claim from the ones above — see `resolveApplicable`.
 */
export const BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP = 'GATE_AUTHORIZATION_STATE_BOOTSTRAP';

/**
 * The digest a CLOSED state seal records for one of its members.
 *
 * WHY THIS BINDING HAD TO EXIST. A sealed member is the one artifact class this
 * layer could never authorize and could never fix. The maintenance authority
 * evaluator refuses any manifest naming a closed seal member — the
 * SEALED_MEMBER_MUTATION guard, and it is correct — so the remedy this layer
 * demands of an unbound path, publication, is precisely the act the authority
 * layer forbids for this one. A path in that position reported
 * NO_APPLICABLE_AUTHORITY forever, and no authority a project owner could
 * lawfully issue would ever clear it.
 *
 * The resolution is not to exempt the path. It is that a GOVERNED seal already IS
 * the byte binding, and the strongest one in the repository: it names the exact
 * sha256 and byteLength and it is immutable by construction.
 *
 * WHAT "GOVERNED" HAD TO BE ADDED FOR. The first version of this binding read the
 * publisher's REFUSAL inventory — `collectClosedStateSealMembers` — on the
 * reasoning that one source cannot answer two questions differently. That reason
 * was exactly backwards. The refusal inventory is correct to be permissive: for
 * "might this path be sealed?", admitting a doubtful seal REFUSES more, which is
 * safe. Reading it here inverted every one of those checks, because for "may this
 * seal PROVE these bytes?", admitting a doubtful seal AUTHORIZES more.
 *
 * The observable defect: a path reported BLOCKED / NO_APPLICABLE_AUTHORITY became
 * AUTHORIZED_CURRENT_BYTES the moment any file appeared at a seal-shaped location
 * whose payload held a closed-looking string anywhere and whose sealedMembers
 * named the path at its current digest — no payloadSha256, no sealedMembersDigest,
 * no seal chain, no ledger event, no gate that exists. The document restated the
 * bytes and was accepted as proof of them.
 *
 * `collectAuthenticatedClosedStateSealMembers` is the authorization-side view. It
 * admits a seal only where the canonical ledger chain, the canonical lineage
 * resolver and the canonical seal validator all agree that the seal is part of
 * this repository's governed history — see that function for the full argument,
 * in particular why canonical seal validity ALONE is not sufficient. The two
 * layers still read one module and still cannot drift; they no longer share a
 * failure DIRECTION they never had in common.
 *
 * THIS IS A PERMANENT PIN, NOT A BOOTSTRAP. Unlike a MUTABLE_PROJECTION’s
 * authorization-time digest, a seal makes a claim meant to hold forever: the
 * member must hold exactly these bytes. So it is never marked `bootstrapOnly` and
 * never yields to a later publication — a publication that moved a sealed member
 * is the defect, and leaving both candidates standing is what makes it surface as
 * an ambiguity instead of being silently overwritten.
 *
 * SEALS ARE READ REPOSITORY-WIDE, exactly as the publisher’s guard reads them. A
 * seal closed by one Gate binds the bytes of every path it names regardless of
 * which Gate is being audited; scoping this to the audited Gate would reopen the
 * same hole on any path a neighbouring Gate sealed.
 */
export const BINDING_CLOSED_STATE_SEAL_MEMBER = 'CLOSED_STATE_SEAL_MEMBER';
export const BINDING_OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR = 'OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR';
export const BINDING_OWNER_PREEXISTING_BYTE_RATIFICATION = 'OWNER_PREEXISTING_BYTE_RATIFICATION';
export const BINDING_EXTERNAL_OWNER_BYTE_AUTHORITY = 'EXTERNAL_OWNER_BYTE_AUTHORITY';

const GATE_RE = /^GATE[0-9]{2}$/;

function readJsonOrNull(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

function sha256File(root, relativePath) {
  try {
    const file = path.resolve(root, ...relativePath.split('/'));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    const bytes = fs.readFileSync(file);
    return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length };
  } catch { return null; }
}

/**
 * Every byte binding this Gate's authority documents make, keyed by path.
 *
 * A binding is a claim of the form "publication P certifies that path X holds
 * exactly this digest", optionally paired with the digest X held before P ran.
 * The pre-state half is what makes the lineage computable; a binding without one
 * is a lineage ROOT rather than a successor.
 */
export function collectCurrentByteBindings({ root, gateId }) {
  const bindings = new Map();
  const refused = [];
  const add = (relativePath, binding) => {
    if (!bindings.has(relativePath)) bindings.set(relativePath, []);
    bindings.get(relativePath).push(binding);
  };

  /* ---- Pre-state-bound maintenance programs ---------------------------- */
  //
  // The SAME admissibility evaluation the cohort derivation and the publisher run.
  // Asking a third time with a third opinion is the contradiction class this
  // project has already paid for twice.
  // The SAME historical-identity inputs the cohort and the publisher use. A
  // reserved identity whose bytes were rewritten must not contribute byte bindings
  // here either — otherwise the current-byte layer would authorize bytes the
  // admissibility boundary refuses, which is the contradiction class this whole
  // repair exists to remove.
  const bridges = collectHistoricalAdmissionBridges({ root, gateId });
  const ratifications = collectHistoricalIdentityRatifications({ root, gateId });

  const sourcesDir = path.resolve(root, 'governance', 'sources');
  const sourceFiles = fs.existsSync(sourcesDir)
    ? fs.readdirSync(sourcesDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  for (const name of sourceFiles) {
    const relativePath = `governance/sources/${name}`;
    const authority = readJsonOrNull(root, relativePath);
    if (authority?.document !== 'GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY') continue;
    if (authority?.preState?.gateId !== gateId) continue;

    const manifestPath = authority.authorizedPathManifestPath;
    const manifest = typeof manifestPath === 'string' ? readJsonOrNull(root, manifestPath) : null;
    const consumption = typeof authority.consumptionRecordPath === 'string' ? readJsonOrNull(root, authority.consumptionRecordPath) : null;
    const manifestIdentity = typeof manifestPath === 'string' ? sha256File(root, manifestPath) : null;
    const consumptionIdentity = typeof authority.consumptionRecordPath === 'string' ? sha256File(root, authority.consumptionRecordPath) : null;
    const historicalIdentity = resolveHistoricalIdentityDecision({
      root, gateId, authority, authorityPath: relativePath,
      authoritySha256: sha256File(root, relativePath)?.sha256 ?? null,
      manifest, manifestSha256: manifestIdentity?.sha256 ?? null,
      consumption, consumptionSha256: consumptionIdentity?.sha256 ?? null,
      ratifications, bridges
    });
    const admissibility = evaluateMaintenanceSourceAdmissibility({
      authority, manifest, manifestSha256: manifestIdentity?.sha256 ?? null,
      consumption, requireConsumption: true, mode: MODE_ADMISSION, historicalIdentity
    });
    if (!admissibility.admissible) { refused.push({ sourcePath: relativePath, reason: admissibility.reason }); continue; }

    // The manifest's declared pre-state supplies the lineage input for each path;
    // the consumption record's cohort supplies the certified output.
    const declaredPrestate = admissibility.prestateByPath ?? new Map();
    for (const entry of consumption.cohort ?? []) {
      if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string') continue;
      const declared = declaredPrestate.get(entry.path) ?? null;
      add(entry.path, {
        bindingClass: BINDING_MAINTENANCE_PUBLICATION,
        candidateSha256: entry.sha256,
        candidateByteLength: typeof entry.byteLength === 'number' ? entry.byteLength : null,
        prestateSha256: declared?.state === 'PRESENT' ? declared.sha256 : null,
        prestateAbsent: declared?.state === 'ABSENT',
        programId: authority.programId ?? null,
        authorityId: authority.authorityId ?? null,
        authorityPath: relativePath,
        manifestPath: manifestPath ?? null,
        manifestSha256: manifestIdentity?.sha256 ?? null,
        consumptionPath: authority.consumptionRecordPath ?? null
      });
    }

    // THE RECEIPT'S OWN BYTES. A consumption record is excluded from its own
    // cohort because it cannot hash its own final bytes, so no document certifies
    // its digest. Its identity is instead bound by the authority and the manifest,
    // and `evaluateMaintenanceSourceAdmissibility` has just re-proved that binding
    // over these exact bytes — authorityId, programId, the pinned manifest digest
    // and every cohort entry's metadata must agree with the manifest.
    //
    // This is recorded as a DISTINCT binding class rather than folded in with the
    // certified ones, because it is a weaker proof and a reader is entitled to see
    // which one carried a given path.
    const receiptIdentity = sha256File(root, authority.consumptionRecordPath);
    if (receiptIdentity) {
      add(authority.consumptionRecordPath, {
        bindingClass: BINDING_CONSUMPTION_SELF_EXCLUDED,
        candidateSha256: receiptIdentity.sha256,
        candidateByteLength: receiptIdentity.byteLength,
        prestateSha256: null,
        prestateAbsent: (declaredPrestate.get(authority.consumptionRecordPath)?.state ?? null) === 'ABSENT',
        programId: authority.programId ?? null,
        authorityId: authority.authorityId ?? null,
        authorityPath: relativePath,
        manifestPath: manifestPath ?? null,
        manifestSha256: manifestIdentity?.sha256 ?? null,
        consumptionPath: authority.consumptionRecordPath ?? null
      });
    }
  }

  /* ---- Consumed owner-present bootstrap C -> C' successor ------------- */
  const bootstrapSuccessor = collectValidatedOwnerPresentByteBootstrapSuccessorBindings({ root, gateId });
  for (const item of bootstrapSuccessor.refused) refused.push({ sourcePath: 'OWNER_PRESENT_BYTE_BOOTSTRAP', reason: item.code });
  for (const item of bootstrapSuccessor.bindings) add(item.path, { ...item, bindingClass: item.bindingClass === BINDING_OWNER_PREEXISTING_BYTE_RATIFICATION ? BINDING_OWNER_PREEXISTING_BYTE_RATIFICATION : BINDING_OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR });

  /* ---- External Owner byte authority for bootstrap CREATE paths -------- */
  const externalOwnerBytes = collectValidatedExternalOwnerByteAuthorityBindings({ root, gateId });
  for (const item of externalOwnerBytes.refused) refused.push({ sourcePath: 'EXTERNAL_OWNER_BYTE_AUTHORITY', reason: item.code });
  for (const item of externalOwnerBytes.bindings) add(item.path, { ...item, bindingClass: BINDING_EXTERNAL_OWNER_BYTE_AUTHORITY });

  /* ---- The Gate's own AUTHORIZATION record, for its STATE artifacts ----- */
  //
  // Only `authorizedStateArtifacts` carries digests. `authorizedDerivedArtifacts`
  // names paths and nothing else, so it contributes no binding and those paths
  // fall through to NO_BYTE_BINDING_AVAILABLE rather than being waved through.
  const authorizationPath = gateAuthorizationRecordPath(gateId);
  const authorization = readJsonOrNull(root, authorizationPath);
  if (authorization && validateGateAuthorizationRecordShape(authorization).valid && authorization.gateId === gateId) {
    const snapshotPath = gateAuthorizationAuthoritySnapshotPath(gateId);
    const snapshot = readJsonOrNull(root, snapshotPath);
    const ownerValid = snapshot === null
      || validateGateAuthorizationAuthorityShape(snapshot, { recordedAt: authorization.recordedAt }).valid;
    if (ownerValid) {
      for (const artifact of authorization.authorizedStateArtifacts ?? []) {
        if (typeof artifact?.repoRelativePath !== 'string' || typeof artifact.sha256 !== 'string') continue;
        // WHICH KIND OF CLAIM THIS DIGEST IS, decided by the role's MODEL D class
        // and by nothing else. A MUTABLE_PROJECTION's pin binds the projection's
        // INITIAL bytes; every other role's pin is a permanent obligation.
        //
        // The classification is positive-only: a role the authority module does
        // not classify is treated as permanently pinned, so a role added later
        // without a stated class keeps the strict behaviour instead of silently
        // acquiring the relaxed one. `validateGateAuthorizationRecordShape` has
        // already rejected any cohortRole outside the canonical four, and pinned
        // each to its exact path template, so the role read here is not free text.
        const bootstrapOnly = gateAuthorizationStateCohortRoleClass(artifact.cohortRole) === MUTABLE_PROJECTION;
        add(artifact.repoRelativePath, {
          bindingClass: bootstrapOnly ? BINDING_GATE_AUTHORIZATION_STATE_BOOTSTRAP : BINDING_GATE_AUTHORIZATION_STATE_ARTIFACT,
          bootstrapOnly,
          cohortRole: artifact.cohortRole ?? null,
          candidateSha256: artifact.sha256,
          candidateByteLength: typeof artifact.byteLength === 'number' ? artifact.byteLength : null,
          prestateSha256: null,
          prestateAbsent: false,
          programId: null,
          authorityId: authorization.authorizationId ?? null,
          authorityPath: authorizationPath,
          manifestPath: null,
          manifestSha256: null,
          consumptionPath: null
        });
      }
    } else {
      refused.push({ sourcePath: snapshotPath, reason: 'AUTHORITY_DOCUMENT_INVALID' });
    }
  }

  /* ---- Closed state seals, repository-wide ----------------------------- */
  //
  // Deduplicated by (path, digest): one artifact is routinely carried forward
  // across several revisions’ seals at the same bytes, and that is one claim
  // repeated, not several competing ones. Two AUTHENTICATED seals naming one path
  // at DIFFERENT digests is a contradiction between two governed records; the
  // collector drops that path entirely and reports the conflict, so the loop below
  // never has to choose between them and can never pick the first one found.
  //
  // FINDINGS FROM THE TRUST SOURCE ARE NOT ADVISORY. `authenticated === false`
  // means the ledger, the legacy binding record or the gate inventory could not be
  // established at all; there is then no such thing as a proven seal member, and
  // falling back to the refusal inventory would restore the exact defect. Every
  // finding and refusal is carried into `refusedSources` so a reader sees which
  // seals were rejected and why, rather than seeing a path silently lose a binding.
  const sealed = collectAuthenticatedClosedStateSealMembers(root);
  for (const entry of sealed.findings) refused.push({ sourcePath: BINDING_CLOSED_STATE_SEAL_MEMBER, reason: entry.code, detail: entry.detail ?? null });
  for (const entry of sealed.refusals) refused.push({ sourcePath: BINDING_CLOSED_STATE_SEAL_MEMBER, reason: entry.code, detail: entry.detail ?? null });
  const seenSealBindings = new Set();
  for (const member of sealed.authenticated ? sealed.members : []) {
    if (typeof member?.repoRelativePath !== 'string' || typeof member.sha256 !== 'string') continue;
    const key = `${member.repoRelativePath}\u0000${member.sha256}`;
    if (seenSealBindings.has(key)) continue;
    seenSealBindings.add(key);
    add(member.repoRelativePath, {
      bindingClass: BINDING_CLOSED_STATE_SEAL_MEMBER,
      cohortRole: null,
      candidateSha256: member.sha256,
      candidateByteLength: typeof member.byteLength === 'number' ? member.byteLength : null,
      prestateSha256: null,
      prestateAbsent: false,
      programId: null,
      authorityId: null,
      authorityPath: member.sealPath ?? null,
      manifestPath: null,
      manifestSha256: null,
      consumptionPath: null
    });
  }

  return { bindings, refused };
}

/**
 * The terminal element of a path's publication lineage.
 *
 * A binding is SUPERSEDED when another binding for the same path declares that
 * binding's certified output as its own pre-state. Whatever is left is terminal.
 * One terminal is an answer; several is an ambiguity that must block.
 *
 * BOOTSTRAP BINDINGS ARE NOT PUBLICATION CANDIDATES.
 *
 * A MUTABLE_PROJECTION's authorization-time digest answers a different question
 * from a publication's: it says what the projection held AT the authorization
 * boundary, not what the last governed write to it produced. Leaving it in the
 * candidate set made it a permanent competing terminal — the pointer had to
 * either never move, or be forever AMBIGUOUS the moment it did. Both readings
 * contradict the lifecycle validator, which skips the exact-byte comparison for
 * this role entirely and re-imposes the pin ONLY while the pointer still names
 * the authorization-time revision.
 *
 * So a bootstrap binding is consulted only when NOTHING published the path. That
 * is the initial state, and there the pin is the whole proof and is enforced
 * exactly. As soon as a governed publication for the path exists, the lineage is
 * decided among publications alone.
 *
 * NO CLOCK IS INTRODUCED BY THIS. "Later" is structural, not temporal: a gate's
 * AUTHORIZATION record pins its FIRST revision, and a post-freeze maintenance
 * publication is by construction a governed write performed after it. Only
 * ADMISSIBLE publications reach this function at all — a refused, tampered or
 * unratified source contributes no binding — so a path whose only publication
 * fails admissibility falls back to the bootstrap pin and is judged against it,
 * rather than escaping into "unbound".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not make the projection's current
 * bytes free. Once publications exist, the current bytes must equal the terminal
 * publication's certified digest, so arbitrary content, a third state, and a
 * replay of the obsolete bootstrap bytes all still BLOCK — the last of these
 * precisely because the bootstrap digest is no longer a candidate anyone can
 * match against. And two genuinely competing publications remain AMBIGUOUS: the
 * bootstrap rule removes one non-answer, never a real conflict.
 */
function resolveApplicable(candidates) {
  const published = candidates.filter((entry) => entry.bootstrapOnly !== true);
  const effective = published.length > 0 ? published : candidates;
  if (effective.length === 1) return { applicable: effective[0], ambiguous: false };
  const consumedAsPrestate = new Set(
    effective.map((entry) => entry.prestateSha256).filter((value) => typeof value === 'string')
  );
  const terminal = effective.filter((entry) => !consumedAsPrestate.has(entry.candidateSha256));
  if (terminal.length === 1) return { applicable: terminal[0], ambiguous: false };
  // Distinct documents can certify IDENTICAL bytes for a path — republishing a
  // file to the digest it already holds is ordinary. That is one answer, not an
  // ambiguity, so terminals are collapsed by digest before the count is judged.
  const digests = new Set(terminal.map((entry) => entry.candidateSha256));
  if (digests.size === 1) return { applicable: terminal[0], ambiguous: false };
  return { applicable: null, ambiguous: true, terminalCount: terminal.length };
}

/**
 * @returns {{
 *   document: string, algorithmVersion: string, path: string,
 *   currentSha256: string|null, currentByteLength: number|null,
 *   status: string, reason: string|null, bindingClass: string|null,
 *   authorityPath: string|null, authorityId: string|null, programId: string|null,
 *   manifestPath: string|null, manifestSha256: string|null, consumptionPath: string|null,
 *   candidateSha256: string|null, prestateSha256: string|null, candidateCount: number
 * }}
 */
export function deriveCurrentByteAuthorizationProof({ root, gateId, path: relativePath, bindings = null, currentIdentity = null }) {
  const resolved = bindings ?? collectCurrentByteBindings({ root, gateId }).bindings;
  const identity = currentIdentity ?? sha256File(root, relativePath);
  const base = {
    document: CURRENT_BYTE_AUTHORIZATION_DOCUMENT,
    algorithmVersion: CURRENT_BYTE_ALGORITHM_VERSION,
    path: relativePath,
    currentSha256: identity?.sha256 ?? null,
    currentByteLength: identity?.byteLength ?? null,
    bindingClass: null, authorityPath: null, authorityId: null, programId: null,
    manifestPath: null, manifestSha256: null, consumptionPath: null,
    candidateSha256: null, prestateSha256: null, candidateCount: 0
  };

  // A DELETED path has no current bytes to authorize. It is reported rather than
  // silently passed: a deletion is a real change and needs its own authority.
  if (!identity) return { ...base, status: STATUS_BLOCKED, reason: REASON_ABSENT };

  const candidates = resolved.get(relativePath) ?? [];
  base.candidateCount = candidates.length;
  if (candidates.length === 0) {
    // Distinguishing these two matters to whoever has to fix it: one needs an
    // authority, the other needs an authority that BINDS BYTES.
    return { ...base, status: STATUS_BLOCKED, reason: REASON_NO_APPLICABLE_AUTHORITY };
  }

  const { applicable, ambiguous, terminalCount } = resolveApplicable(candidates);
  if (ambiguous) return { ...base, status: STATUS_BLOCKED, reason: REASON_LINEAGE_AMBIGUOUS, terminalCount };

  const proof = {
    ...base,
    bindingClass: applicable.bindingClass,
    authorityPath: applicable.authorityPath,
    authorityId: applicable.authorityId,
    programId: applicable.programId,
    manifestPath: applicable.manifestPath,
    manifestSha256: applicable.manifestSha256,
    consumptionPath: applicable.consumptionPath,
    candidateSha256: applicable.candidateSha256,
    prestateSha256: applicable.prestateSha256
  };
  if (typeof applicable.candidateSha256 !== 'string') {
    return { ...proof, status: STATUS_BLOCKED, reason: REASON_NO_BYTE_BINDING };
  }
  if (applicable.candidateSha256 !== identity.sha256
      || (applicable.candidateByteLength !== null && applicable.candidateByteLength !== identity.byteLength)) {
    return { ...proof, status: STATUS_BLOCKED, reason: REASON_UNAUTHORIZED_BYTES };
  }
  return { ...proof, status: STATUS_AUTHORIZED, reason: null };
}

/** Current-byte proofs for a whole path set, sharing one binding collection. */
export function deriveCurrentByteAuthorizationProofs({ root, gateId, paths }) {
  if (!GATE_RE.test(gateId || '')) {
    return { document: CURRENT_BYTE_AUTHORIZATION_DOCUMENT, gateId, valid: false, proofs: [], blocked: [], refusedSources: [], findings: [{ code: 'GATE_ID_INVALID', detail: gateId }] };
  }
  const { bindings, refused } = collectCurrentByteBindings({ root, gateId });
  const proofs = [...paths].sort().map((relativePath) => deriveCurrentByteAuthorizationProof({ root, gateId, path: relativePath, bindings }));
  const blocked = proofs.filter((proof) => proof.status !== STATUS_AUTHORIZED);
  return {
    document: CURRENT_BYTE_AUTHORIZATION_DOCUMENT,
    algorithmVersion: CURRENT_BYTE_ALGORITHM_VERSION,
    gateId,
    valid: blocked.length === 0,
    proofs, blocked,
    refusedSources: refused,
    findings: blocked.map((proof) => ({ code: proof.reason, detail: proof.path }))
  };
}
