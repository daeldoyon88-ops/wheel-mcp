#!/usr/bin/env node
/**
 * PRECONTRACT bootstrap applier.
 *
 * The one place a Gate's first contract may be written. It is deliberately a
 * transport, not a decision: every decision is made by the PRECONTRACT authority
 * primitive through the Wheel adapter, and this file refuses to move a single
 * byte the primitive has not already authorized.
 *
 * NOTHING IS PUBLISHED UNTIL EVERYTHING IS PROVEN.
 *
 * The bootstrap used to write its three artifacts and only then ask whether the
 * result was valid. When the answer was no it reported BLOCKED and left all
 * three files on disk: a refused bootstrap that had nevertheless happened. A
 * verdict that publishes what it rejects is not a verdict.
 *
 * So the receipt is now part of the CANDIDATE rather than a consequence of the
 * write, and the whole candidate — contract, pointer and receipt together — is
 * proven complete before the first byte reaches its canonical path:
 *
 *   1. AUTHORIZE_WRITE            the live repository must still be the exact
 *                                 pre-state the authority was bound to.
 *   2. staged-byte verification   every staged file must reproduce the exact
 *                                 sha256 the authority approved. Authorizing a
 *                                 path without pinning its bytes would authorize
 *                                 arbitrary content at that path.
 *   3. path containment           every write path must be an authorized path,
 *                                 and the consumption receipt is the only
 *                                 authorized path that carries no byte binding.
 *   4. candidate consumption      VERIFY_CONSUMPTION runs against the candidate
 *                                 through the same primitive and the same code
 *                                 path it will use afterwards, by observation
 *                                 substitution rather than by simulation.
 *   5. atomic publication         applyCandidate() from the lifecycle
 *                                 orchestrator: prepared transaction, staged
 *                                 artifacts, commit, guaranteed rollback and a
 *                                 durable record if rollback itself fails. That
 *                                 machinery already exists and is reused rather
 *                                 than re-implemented.
 *   6. post-publication proof     the bytes on disk are re-read and re-compared.
 *   7. replay proof               the authority is re-presented and must now be
 *                                 BLOCKED. A single-use authority that still
 *                                 authorizes after use is not single-use.
 *
 * Steps 6 and 7 can no longer fail for any reason step 4 would have caught, so
 * the remaining failure modes are physical. They are still handled the same way:
 * the publication is undone and the canonical pre-state restored, because the
 * invariant is about what is on disk when a verdict is BLOCKED, not about why.
 *
 * Without --apply this runs steps 1-4 and reports, writing nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildPrecontractConsumptionRecord,
  isLocalPrecontractAuthority,
  reconstructLedgerPrefix
} from '../gee-v1/core/precontract-authority.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';
import { applyCandidate, LEDGER_PATH } from './gate-lifecycle-orchestrator.mjs';
import { durableReplaceFileSync } from './durable-write.mjs';
import { PRECONTRACT_BOOTSTRAP_CASE_TYPE } from './transaction-provenance.mjs';

export const BOOTSTRAP_APPLIER_DOCUMENT = 'PRECONTRACT_BOOTSTRAP_APPLICATION';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function isExactRelativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.normalize('NFC')) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (value.includes('*') || value.includes('?')) return false;
  return !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

/**
 * An absolute path expressed the way the transaction journal names paths, or
 * `null` if it cannot be — because it escapes the root, or because it resolves to
 * the root itself.
 *
 * The result is re-checked with `isExactRelativePath`, the same predicate this
 * tool already applies to authorized paths, so a path this function accepts is a
 * path the journal's own resolver will accept too. Agreeing by construction beats
 * agreeing by coincidence: the alternative is a provenance record written under
 * one notion of "inside the root" and re-resolved at recovery under another.
 */
function toRootRelativePosix(absoluteRoot, candidatePath) {
  if (typeof candidatePath !== 'string' || !candidatePath) return null;
  const relative = path.relative(absoluteRoot, path.resolve(absoluteRoot, candidatePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const posix = relative.split(path.sep).join('/');
  return isExactRelativePath(posix) ? posix : null;
}

/**
 * @param {string} options.stagedRoot  Directory holding the candidate bytes at
 *   the same relative paths they will occupy in the repository.
 */
export function applyPrecontractBootstrap({
  root, authorityPath, stagedRoot, apply = false, recordedAt = new Date().toISOString(), now = new Date(),
  // Durable by default for the same reason the orchestrator is: this publisher
  // hands its writer straight to applyCandidate, so a plain truncate-and-stream
  // default here silently disabled the durable primitive underneath it. The
  // parameter stays injectable because the permanence suite needs to fail a write
  // mid-cohort on purpose, but a caller that says nothing now gets the safe one.
  writeFile = durableReplaceFileSync, rollbackWriteFile = durableReplaceFileSync, rollbackRemoveFile = fs.rmSync
}) {
  const findings = [];
  const absoluteRoot = path.resolve(root);
  let authority = null;
  try { authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8')); } catch { findings.push({ code: 'AUTHORITY_UNREADABLE', detail: authorityPath }); }
  if (!isLocalPrecontractAuthority(authority)) findings.push({ code: 'LOCAL_AUTHORITY_REQUIRED' });
  if (findings.length) return { document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', findings, written: [] };

  const gateId = authority.gateId;
  const source = createWheelPrecontractAuthoritySource(absoluteRoot, { authorityPath, now });

  // THE PROVENANCE RECORD NAMES THE AUTHORITY THE WAY RECOVERY WILL LOOK FOR IT.
  //
  // This entry point takes an ABSOLUTE authority path — it reads the document with
  // it above, and every caller, live and fixture alike, passes one. The transaction
  // journal cannot store that. A journal is re-read by a DIFFERENT process, on a
  // repository that may sit at a different absolute location, so it records paths
  // relative to the governed root, and its resolver rejects anything absolute,
  // drive-lettered or backslashed rather than guessing what it meant.
  //
  // Handing the absolute path straight through therefore did not produce a wrong
  // provenance record — it produced NO provenance record, and with recoverable
  // provenance now mandatory the whole bootstrap was refused as
  // PROVENANCE_ABSENT_OR_INVALID. The conversion belongs here, at the boundary
  // between an absolute-path API and a root-relative journal.
  //
  // An authority outside the root is refused outright instead of being recorded
  // under some approximation of its location: recovery would have to re-prove it
  // from bytes it cannot name, and an authority a fresh process cannot find again
  // is not an authority a durable transaction may rely on.
  const authorityDocumentPath = toRootRelativePosix(absoluteRoot, authorityPath);
  if (!authorityDocumentPath) {
    return {
      document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', phase: 'AUTHORITY_LOCATION', gateId,
      written: [], findings: [{ code: 'AUTHORITY_OUTSIDE_GOVERNED_ROOT', detail: String(authorityPath) }]
    };
  }

  // ---- 1. the live repository must still be the bound pre-state -----------
  const authorize = source.resolvePrecontractAuthority(gateId);
  if (authorize.decision !== 'AUTHORIZED') {
    return { document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', phase: 'AUTHORIZE_WRITE', gateId, findings: authorize.findings, written: [] };
  }

  // ---- 2/3. staged bytes and path containment -----------------------------
  const authorizedPaths = new Set(authorize.authorizedPaths);
  const plan = [];
  for (const binding of authority.artifactBindings) {
    if (!isExactRelativePath(binding.path)) { findings.push({ code: 'UNSAFE_ARTIFACT_PATH', detail: binding.path }); continue; }
    if (!authorizedPaths.has(binding.path)) { findings.push({ code: 'PATH_NOT_AUTHORIZED', detail: binding.path }); continue; }
    const staged = path.join(path.resolve(stagedRoot), ...binding.path.split('/'));
    let bytes = null;
    try { bytes = fs.readFileSync(staged); } catch { findings.push({ code: 'STAGED_ARTIFACT_ABSENT', detail: binding.path }); continue; }
    const digest = sha256(bytes);
    if (digest !== binding.sha256) { findings.push({ code: 'STAGED_ARTIFACT_BYTES_MISMATCH', detail: `${binding.path}:${digest}` }); continue; }
    plan.push({ path: binding.path, sha256: digest, byteLength: bytes.length, bytes });
  }
  if (!isExactRelativePath(authority.consumptionRecordPath) || !authorizedPaths.has(authority.consumptionRecordPath)) {
    findings.push({ code: 'CONSUMPTION_RECORD_PATH_NOT_AUTHORIZED', detail: authority.consumptionRecordPath });
  }
  for (const target of plan) {
    if (fs.existsSync(path.join(absoluteRoot, ...target.path.split('/')))) findings.push({ code: 'BOOTSTRAP_TARGET_ALREADY_PRESENT', detail: target.path });
  }
  if (findings.length) return { document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', phase: 'STAGED_VERIFICATION', gateId, findings, written: [] };

  // ---- 4. the receipt is part of the candidate, not a consequence of writing --
  // Its identity digest binds the recorded instant to the authority, the
  // reconstructed ledger pre-state and the exact cohort, so the timestamp is
  // evidence rather than a claim. The prefix is rebuilt with the core's own
  // reconstruction so the applier and the validator agree by construction.
  const ledgerText = fs.readFileSync(path.join(absoluteRoot, ...LEDGER_PATH.split('/')), 'utf8');
  const prefix = reconstructLedgerPrefix(ledgerText, authority.preState.ledgerEventCount);
  if (!prefix.valid) {
    return { document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', phase: 'CANDIDATE_CONSTRUCTION', gateId, findings: [{ code: prefix.code, detail: prefix.detail }], written: [] };
  }
  const consumptionBytes = Buffer.from(`${JSON.stringify(buildPrecontractConsumptionRecord({
    authority, ledgerPrefixSha256: prefix.sha256, ledgerEventCount: prefix.eventCount, recordedAt
  }), null, 2)}\n`, 'utf8');
  // Sorted by path, because the journal's commit order is: `prepareLifecycleTransaction`
  // sorts what it commits, and the provenance records the cohort in the order the
  // candidate supplied it. Two orderings of the same set are not a disagreement about
  // WHAT is published, but the validator cannot tell that from a journal alone and
  // correctly refuses the mismatch. Sorting at the source removes the divergence
  // instead of teaching the validator to tolerate it — a tolerance that would also
  // accept a journal whose commit order really had been rewritten.
  const candidateWrites = [
    ...plan.map((target) => ({ path: target.path, bytes: target.bytes, sha256: target.sha256, byteLength: target.byteLength })),
    { path: authority.consumptionRecordPath, bytes: consumptionBytes, sha256: sha256(consumptionBytes), byteLength: consumptionBytes.length }
  ].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const candidateOverlay = Object.fromEntries(candidateWrites.map((write) => [write.path, write.bytes]));

  // The consumption proof, on the candidate, through the same primitive that
  // will judge it once published.
  const candidateConsumption = createWheelPrecontractAuthoritySource(absoluteRoot, { authorityPath, now, candidateOverlay })
    .verifyPrecontractConsumption(gateId);
  if (candidateConsumption.decision !== 'AUTHORIZED' || candidateConsumption.consumed !== true) {
    return {
      document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'BLOCKED', phase: 'CANDIDATE_CONSUMPTION', gateId,
      findings: [{ code: 'CANDIDATE_CONSUMPTION_NOT_PROVEN', detail: candidateConsumption.findings }], written: []
    };
  }

  const planned = candidateWrites.map(({ bytes, ...rest }) => rest);
  if (!apply) {
    return {
      document: BOOTSTRAP_APPLIER_DOCUMENT, verdict: 'CANDIDATE_VALID', phase: 'CANDIDATE_CONSUMPTION', gateId,
      authorityId: authority.authorityId, authorizedPaths: [...authorizedPaths], planned, findings: [], written: []
    };
  }

  // ---- 5. atomic publication, on the existing durable transaction ----------
  // `transitionType` is what binds this transaction to the PRECONTRACT_LOCAL
  // evaluator: the validator refuses a precontract binding claimed by any other
  // transition, so leaving it undefined here did not select a weaker check — it
  // selected none, and the publication was refused. It is stated rather than
  // defaulted, so a future case type cannot inherit this one's evaluator by
  // forgetting to declare its own.
  const candidate = {
    eventId: `${gateId}_PRECONTRACT_BOOTSTRAP`, gateId, writes: candidateWrites,
    event: null, paths: {}, caseType: PRECONTRACT_BOOTSTRAP_CASE_TYPE, transitionType: PRECONTRACT_BOOTSTRAP_CASE_TYPE
  };
  let written;
  try {
    // `authorization` is the EVALUATED result from step 1, not the authority
    // document. applyCandidate builds the provenance from it, because only the
    // primitive knows the exact pre-state cohort the journal has to pin. Passing
    // the raw document here — which is what this call used to do — silently
    // produced `provenance: null`, and the publication armed COMMITTING anyway.
    written = applyCandidate({
      root: absoluteRoot, candidate, authorityDocumentPath, authority,
      authorization: authorize, writeFile, rollbackWriteFile, rollbackRemoveFile
    });
  } catch (cause) {
    return {
      document: BOOTSTRAP_APPLIER_DOCUMENT,
      verdict: 'BLOCKED', phase: 'ATOMIC_PUBLICATION', gateId, authorityId: authority.authorityId,
      written: [], rolledBack: cause.recovered === true,
      findings: [{
        code: cause.recovered === true ? 'PUBLICATION_FAILED_ROLLED_BACK' : 'PUBLICATION_RECOVERY_REQUIRED',
        detail: cause.message
      }]
    };
  }

  // ---- 6/7. post-publication proof and replay ------------------------------
  const consumed = source.verifyPrecontractConsumption(gateId);
  const replay = source.resolvePrecontractAuthority(gateId);
  const replayBlocked = replay.decision === 'BLOCKED'
    && replay.findings.some((item) => item.code === 'AUTHORITY_ALREADY_CONSUMED' || item.code === 'CURRENT_CONTRACT_PRESENT');
  if (consumed.decision !== 'AUTHORIZED' || consumed.consumed !== true) findings.push({ code: 'CONSUMPTION_NOT_PROVEN', detail: consumed.findings });
  if (!replayBlocked) findings.push({ code: 'REPLAY_NOT_BLOCKED', detail: replay.findings });

  if (findings.length > 0) {
    // A refused bootstrap must not remain published. The candidate created every
    // one of these paths, so unpublishing is removal, and the pre-state is
    // restored exactly.
    const residue = [];
    for (const write of [...candidateWrites].reverse()) {
      const target = path.join(absoluteRoot, ...write.path.split('/'));
      try { fs.rmSync(target, { force: true }); } catch (error) { residue.push({ path: write.path, error: error.message }); }
      if (fs.existsSync(target)) residue.push({ path: write.path, error: 'STILL_PRESENT' });
    }
    return {
      document: BOOTSTRAP_APPLIER_DOCUMENT,
      verdict: 'BLOCKED', phase: 'POST_PUBLICATION_VERIFICATION', gateId, authorityId: authority.authorityId,
      written: [], rolledBack: residue.length === 0,
      findings: residue.length === 0 ? findings : [...findings, { code: 'ROLLBACK_INCOMPLETE', detail: residue }]
    };
  }

  return {
    document: BOOTSTRAP_APPLIER_DOCUMENT,
    verdict: 'APPLIED',
    phase: 'APPLIED', gateId, authorityId: authority.authorityId,
    authorizedPaths: [...authorizedPaths], written,
    consumption: { path: authority.consumptionRecordPath, verified: consumed.consumed === true },
    replay: { decision: replay.decision, blocked: replayBlocked },
    findings
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const option = (name, fallback = null) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; };
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const report = applyPrecontractBootstrap({
    root: path.resolve(option('--root', path.resolve(toolsDir, '..', '..'))),
    authorityPath: option('--authority'),
    stagedRoot: option('--staged'),
    recordedAt: option('--recorded-at', new Date().toISOString()),
    apply: process.argv.includes('--apply')
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.verdict === 'BLOCKED' ? 2 : 0;
}
