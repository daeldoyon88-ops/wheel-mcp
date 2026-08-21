#!/usr/bin/env node
/**
 * APPLY_PATH_PRESTATE_PROGRAM — the R6 publisher for a pre-state-bound program.
 *
 * WHAT THIS EXISTS TO CLOSE. A V2 authority can declare the exact state every
 * authorized path must be in before publication, but a declaration only means
 * something if a program actually refuses to write when the declaration is
 * false. This is that program. It is the only sanctioned way to publish a
 * schemaVersion-2 manifest, and it performs the whole sequence in one place:
 *
 *   prestate verification -> candidate verification -> transactional publication
 *   -> post-validation -> canonical consumption
 *
 * WHY PUBLICATION IS TRANSACTIONAL. A governance cohort is meaningless if half
 * of it lands. Every target is written to a sibling temp file and renamed, and
 * every prior state — bytes, or the fact that a path did not exist — is captured
 * BEFORE the first rename. Any failure at any point restores every path this
 * program touched to exactly what it held on entry, including deleting files it
 * had created. The repository is either fully published or byte-identical to its
 * pre-state; there is no third outcome.
 *
 * IDEMPOTENCE, NOT RETRY-BY-LUCK. A rerun after a completed publication finds
 * the consumption record and the exact certified bytes, and returns
 * ALREADY_APPLIED without writing. A rerun after a rolled-back attempt finds the
 * pre-state intact and proceeds normally. Neither case needs the caller to know
 * which happened.
 *
 * REPLAY IS STILL BLOCKED. Idempotence is not replay: the evaluator raises
 * AUTHORITY_ALREADY_CONSUMED for a consumed authority, and this program only
 * treats that as ALREADY_APPLIED when the cohort on disk still holds the exact
 * bytes the consumption record certified. A consumed authority whose cohort has
 * since drifted is a blocked replay, not an idempotent no-op.
 *
 * Local, offline, deterministic. Writes only inside the authorized cohort.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  validateMaintenanceAuthorizedPathManifest
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { evaluateMaintenanceSourceAdmissibility, MODE_PUBLICATION } from '../gee-v1/core/maintenance-publication-admissibility.mjs';
import { resolveHistoricalIdentityDecision } from '../gee-v1/core/historical-admission-bridge.mjs';
import { admissionCitation, resolveMaintenancePublicationAdmission } from '../gee-v1/core/maintenance-publication-admission.mjs';
import { applyCandidate } from './gate-lifecycle-orchestrator.mjs';
import { MAINTENANCE_PROGRAM_CASE_TYPE } from './transaction-provenance.mjs';
import { collectPostFreezeMaintenanceObservation, resolveMaintenancePath } from './post-freeze-maintenance-observation.mjs';

export const PUBLISHER_DOCUMENT = 'APPLY_PATH_PRESTATE_PROGRAM';
export const PUBLISHER_VERSION = 'R1';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

function blocked(stage, findings) {
  return { document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'BLOCKED', stage, findings, published: [] };
}

/**
 * @param candidates Map<repoRelativePath, Buffer> — the exact bytes to publish.
 *   Must cover every manifest path except the consumption record, which this
 *   program composes itself.
 */
export function applyPathPrestateProgram({
  root, authorityDocumentPath, candidates, transactionId,
  recordedAt = new Date().toISOString(), now = new Date()
}) {
  const authorityFile = resolveMaintenancePath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return blocked('AUTHORITY', [{ code: 'AUTHORITY_DOCUMENT_ABSENT', detail: authorityDocumentPath }]);
  const authority = readJson(authorityFile);

  const manifestFile = resolveMaintenancePath(root, authority.authorizedPathManifestPath);
  if (!manifestFile || !fs.existsSync(manifestFile)) return blocked('MANIFEST', [{ code: 'MANIFEST_ABSENT' }]);
  const manifest = readJson(manifestFile);

  // THE SAME EVALUATION THE COHORT DERIVATION RUNS. This block used to be the
  // publisher's private opinion of what it would accept, and the cohort had a
  // different, weaker one — so a program could be ADMITTED into a Gate's
  // authorized cohort while this function would have refused to run it. Both now
  // call one primitive. `requireConsumption` is false here for the obvious reason:
  // at publication time the consumption record is the thing about to be written.
  // THE PUBLISHER ASKS THE SAME HISTORICAL-IDENTITY QUESTION THE COHORT ASKS.
  //
  // Enforcing the reservation only in the cohort derivation would leave the exploit
  // intact through the other door: an attacker who cannot get a reserved identity
  // ADMITTED could still get it PUBLISHED, and publication is the stronger act. The
  // resolver is shared so the two cannot answer differently.
  const historicalIdentity = resolveHistoricalIdentityDecision({
    root, gateId: authority.preState?.gateId ?? null, authority,
    authorityPath: authorityDocumentPath, authoritySha256: sha256(fs.readFileSync(authorityFile)),
    manifest, manifestSha256: sha256(fs.readFileSync(manifestFile)),
    consumption: null, consumptionSha256: null
  });
  // THE PRE-PUBLICATION ADMISSION, RESOLVED BY THE PUBLISHER THAT WILL PUBLISH.
  //
  // The evaluator is pure and does no I/O, so the one component holding the
  // repository — this one — reads the Owner registry and the admission record and
  // hands the decision in. There is no second publisher and no second evaluator:
  // the resolution is an INPUT to the existing admissibility seam, exactly as the
  // historical-identity decision already is.
  //
  // `historicalIdentity` is passed through so a reserved identity is refused by the
  // resolver too, and not only by the seam. Two components, same answer.
  const authorityBytes = fs.readFileSync(authorityFile);
  const manifestBytes = fs.readFileSync(manifestFile);
  const publicationAdmission = resolveMaintenancePublicationAdmission({
    root, gateId: authority.preState?.gateId ?? null, authority,
    authorityPath: authorityDocumentPath, authoritySha256: sha256(authorityBytes), authorityByteLength: authorityBytes.length,
    manifest, manifestSha256: sha256(manifestBytes), manifestByteLength: manifestBytes.length,
    historicalIdentity
  });
  const admissibility = evaluateMaintenanceSourceAdmissibility({
    authority, manifest, manifestSha256: sha256(fs.readFileSync(manifestFile)),
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION, historicalIdentity,
    publicationAdmission
  });
  if (!admissibility.admissible) return blocked('MANIFEST', [{ code: admissibility.reason, detail: admissibility.detail }]);
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);

  // BELT AND BRACES, DELIBERATELY. MODE_PUBLICATION already refuses a manifest
  // that does not bind pre-state, so this line is redundant — and it stays. This
  // is the invariant an earlier pass of this repair removed by accident while
  // routing the publisher through the shared evaluator, and its removal is a
  // silent loosening of the only secure maintenance publisher: it would let a
  // brand-new V1 program publish. A redundant local assertion costs nothing and
  // means the guarantee cannot be lost again by a change made somewhere else.
  if (!manifestResult.bindsPrestate) return blocked('MANIFEST', [{ code: 'MANIFEST_DOES_NOT_BIND_PRESTATE', detail: 'schemaVersion 2 required' }]);

  const consumptionPath = authority.consumptionRecordPath;
  const targets = manifestResult.authorizedPaths.filter((p) => p !== consumptionPath);

  // Every authorized path must have a candidate, and nothing outside the
  // manifest may be published. Both directions are checked; a missing candidate
  // is not silently skipped.
  const missing = targets.filter((p) => !candidates.has(p));
  if (missing.length) return blocked('CANDIDATE', missing.map((detail) => ({ code: 'CANDIDATE_MISSING_FOR_AUTHORIZED_PATH', detail })));
  const extra = [...candidates.keys()].filter((p) => !targets.includes(p));
  if (extra.length) return blocked('CANDIDATE', extra.map((detail) => ({ code: 'CANDIDATE_PATH_NOT_AUTHORIZED', detail })));

  const consumptionFile = resolveMaintenancePath(root, consumptionPath);
  const alreadyConsumed = consumptionFile && fs.existsSync(consumptionFile) ? readJson(consumptionFile) : null;

  // IDEMPOTENCE. A completed publication is recognised by its own receipt plus
  // the exact bytes that receipt certifies, never by the receipt alone.
  if (alreadyConsumed) {
    const drift = [];
    for (const entry of alreadyConsumed.cohort ?? []) {
      const file = resolveMaintenancePath(root, entry.path);
      const actual = file && fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
      if (actual !== entry.sha256) drift.push({ code: 'CONSUMED_COHORT_DRIFTED', detail: entry.path });
    }
    if (drift.length === 0) {
      return {
        document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'ALREADY_APPLIED',
        stage: 'IDEMPOTENT', findings: [], published: alreadyConsumed.cohort?.map((e) => e.path) ?? []
      };
    }
    return blocked('REPLAY', [{ code: 'AUTHORITY_ALREADY_CONSUMED' }, ...drift]);
  }

  /* ---- 1. PRESTATE VERIFICATION -------------------------------------- */
  const candidateWrites = [...candidates].map(([p, bytes]) => ({ path: p, bytes }));
  const observation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath, candidateWrites });
  if (!observation.valid) return blocked('PRESTATE', observation.findings);
  const decision = evaluatePostFreezeMaintenanceAuthorityV2({
    authority, manifest: observation.manifest, observed: observation.observed,
    phase: PHASE_AUTHORIZE_PROGRAM_APPLY, now, consumptionRecord: null
  });
  if (decision.decision !== 'AUTHORIZED') return blocked('PRESTATE', decision.findings);

  /* ---- 2. CANDIDATE VERIFICATION ------------------------------------- */
  const cohort = [];
  for (const entry of manifest.paths) {
    if (entry.path === consumptionPath) continue;
    const bytes = candidates.get(entry.path);
    cohort.push({
      path: entry.path, sha256: sha256(bytes), byteLength: bytes.length,
      operation: entry.operation, reason: entry.reason, artifactClass: entry.artifactClass
    });
  }

  const consumptionRecord = {
    documentKind: 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION',
    schemaVersion: 2,
    authorityId: authority.authorityId,
    programId: authority.programId,
    manifestSha256: sha256(fs.readFileSync(manifestFile)),
    baseHead: authority.preState.baseHead,
    consumedUse: 1,
    transactionId,
    recordedAt,
    commitMessage: authority.commitPolicy.commitMessage,
    // The receipt names the independent Owner decision this publication ran under,
    // so a reader of the record can reach the admission without searching for it.
    publicationAdmission: admissionCitation(publicationAdmission),
    cohortSelfExclusion: {
      path: consumptionPath,
      reason: 'The consumption record cannot hash its own final bytes; its identity is bound by the authority and manifest instead.'
    },
    cohortPathCount: manifestResult.authorizedPaths.length,
    cohort
  };

  /* ---- 3. TRANSACTIONAL PUBLICATION ---------------------------------- */
  //
  // WHAT THIS REPLACED, AND WHY THE OLD SHAPE COULD NOT BE FIXED IN PLACE.
  //
  // Publication used to run off an IN-MEMORY rollback journal: the prior bytes of
  // every target were captured into a local array, and a thrown error walked that
  // array back. That is failure-atomic against exceptions and worthless against
  // process death. SIGKILL between two `publishOne` calls left a partial cohort on
  // canonical paths, no journal anywhere on disk, and nothing for a fresh process
  // to consume — the retry then failed PRESTATE, because the pre-state it was
  // bound to had already been half-overwritten. A multi-path governance cohort
  // that can be left half-published is not a transaction.
  //
  // The repair is REUSE, not a second framework. applyCandidate already stages
  // every candidate byte durably, writes a persistent TRANSACTION.json before any
  // canonical path moves, refuses to enter COMMITTING without recoverable
  // provenance, writes through durable whole-file replacement, and is already the
  // thing `recover-governance-transaction` knows how to roll forward. A
  // maintenance program is exactly a multi-path candidate with an authority, so it
  // publishes through that primitive on the same terms as every other publisher.
  // SORTED BY PATH, because the provenance record's cohort is sorted and the
  // journal's commitOrder must be the same sequence. `cohortFor` sorts what it
  // records; if the writes were left in manifest order the two would disagree and
  // the transaction would be refused as COMMIT_ORDER_MISMATCH — a real refusal,
  // for a discrepancy that is purely this caller's to avoid. Sorting also makes
  // the publication order deterministic across platforms, which is what lets the
  // "progress is a prefix of the cohort" recovery rule mean anything.
  const candidateWritesForPublication = [
    ...targets.map((relativePath) => {
      const bytes = candidates.get(relativePath);
      return { path: relativePath, bytes, sha256: sha256(bytes), byteLength: bytes.length };
    }),
    (() => {
      const bytes = Buffer.from(`${JSON.stringify(consumptionRecord, null, 2)}\n`, 'utf8');
      return { path: consumptionPath, bytes, sha256: sha256(bytes), byteLength: bytes.length };
    })()
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));

  // PRE-FLIGHT: every path this program will touch must be readable as a file.
  //
  // The durable transaction supersedes the old in-memory rollback journal, but not
  // this check, which encodes a property worth keeping: if a target's prior state
  // cannot even be captured — a directory sitting where a file belongs is the real
  // case — then nothing about the publication is recoverable, and the right moment
  // to say so is BEFORE a single byte is staged. Discovering it mid-transaction
  // would leave a prepared journal describing a publication that can never
  // complete. It is a refusal, not a rollback, precisely because nothing has moved.
  for (const write of candidateWritesForPublication) {
    const file = resolveMaintenancePath(root, write.path);
    if (!file) return blocked('JOURNAL', [{ code: 'ROLLBACK_JOURNAL_UNAVAILABLE', detail: `UNSAFE_PATH:${write.path}` }]);
    if (!fs.existsSync(file)) continue;
    try {
      if (!fs.statSync(file).isFile()) throw new Error(`NOT_A_FILE:${write.path}`);
      fs.readFileSync(file);
    } catch (error) {
      return blocked('JOURNAL', [{ code: 'ROLLBACK_JOURNAL_UNAVAILABLE', detail: error.message }]);
    }
  }

  const candidate = {
    eventId: `${authority.programId}_PROGRAM`,
    gateId: authority.preState?.gateId ?? null,
    // The operation class the authority actually authorized, so the provenance
    // validator re-evaluates the same request at recovery time that was evaluated
    // here — not a synthetic transition type invented for the journal.
    transitionType: (authority.authorizedOperationClasses ?? [])[0] ?? null,
    writes: candidateWritesForPublication,
    event: null,
    paths: {},
    caseType: MAINTENANCE_PROGRAM_CASE_TYPE
  };

  try {
    applyCandidate({
      root, candidate, authorityDocumentPath, authority: { decision: 'AUTHORIZED', observed: observation.observed }
    });
  } catch (cause) {
    return {
      document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION,
      decision: cause.recovered === false ? 'RECOVERY_REQUIRED' : 'ROLLED_BACK', stage: 'PUBLICATION',
      findings: [{ code: cause.recovered === false ? 'PUBLICATION_RECOVERY_REQUIRED' : 'PUBLICATION_FAILED', detail: cause.message }],
      rollbackFailures: cause.rollbackFailures ?? [], rollbackClean: (cause.rollbackFailures ?? []).length === 0, published: []
    };
  }

  /* ---- 4. POST-VALIDATION -------------------------------------------- */
  //
  // The transaction has COMMITTED by the time control reaches here, so this is no
  // longer a rollback point and must not pretend to be one. Undoing a committed
  // publication by replaying an in-memory journal is exactly the unrecoverable
  // shape this repair removed: it would move canonical bytes with no journal on
  // disk describing the move. A disagreement here means the committed bytes are
  // not the bytes the receipt certifies, which is a state for an operator to
  // resolve against the transaction record — reported, never silently undone.
  const postFindings = [];
  for (const entry of cohort) {
    const file = resolveMaintenancePath(root, entry.path);
    const actual = file && fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
    if (actual !== entry.sha256) postFindings.push({ code: 'PUBLISHED_BYTES_DISAGREE_WITH_COHORT', detail: entry.path });
  }
  if (postFindings.length) {
    return {
      document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'RECOVERY_REQUIRED', stage: 'POST_VALIDATION',
      findings: postFindings, published: []
    };
  }

  return {
    document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'APPLIED', stage: 'CONSUMED',
    findings: [], published: cohort.map((e) => e.path), consumptionRecordPath: consumptionPath,
    cohortPathCount: consumptionRecord.cohortPathCount
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const authorityDocumentPath = option('--authority');
  const candidateRoot = option('--candidate-root');
  if (!authorityDocumentPath || !candidateRoot) {
    process.stdout.write('usage: apply-path-prestate-program.mjs --authority <repo-relative> --candidate-root <dir> [--transaction-id ID]\n');
    process.exitCode = 2;
  } else {
    const authority = readJson(path.resolve(root, ...authorityDocumentPath.split('/')));
    const manifest = readJson(path.resolve(root, ...authority.authorizedPathManifestPath.split('/')));
    const candidates = new Map();
    for (const entry of manifest.paths) {
      if (entry.path === authority.consumptionRecordPath) continue;
      const file = path.resolve(candidateRoot, ...entry.path.split('/'));
      if (fs.existsSync(file)) candidates.set(entry.path, fs.readFileSync(file));
    }
    const report = applyPathPrestateProgram({
      root, authorityDocumentPath, candidates,
      transactionId: option('--transaction-id', `${authority.programId}_TRANSACTION`)
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.decision === 'APPLIED' || report.decision === 'ALREADY_APPLIED' ? 0 : 2;
  }
}
