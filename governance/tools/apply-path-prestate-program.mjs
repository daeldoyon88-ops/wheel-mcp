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
import { collectPostFreezeMaintenanceObservation, resolveMaintenancePath } from './post-freeze-maintenance-observation.mjs';

export const PUBLISHER_DOCUMENT = 'APPLY_PATH_PRESTATE_PROGRAM';
export const PUBLISHER_VERSION = 'R1';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

function blocked(stage, findings) {
  return { document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'BLOCKED', stage, findings, published: [] };
}

/**
 * Captures what every target path holds before anything is written, so a
 * rollback can restore absence as faithfully as it restores bytes.
 */
function captureRollbackJournal(root, relativePaths) {
  const journal = [];
  for (const relativePath of relativePaths) {
    const file = resolveMaintenancePath(root, relativePath);
    if (!file) throw new Error(`UNSAFE_PATH:${relativePath}`);
    journal.push(fs.existsSync(file)
      ? { relativePath, file, existed: true, bytes: fs.readFileSync(file) }
      : { relativePath, file, existed: false, bytes: null });
  }
  return journal;
}

function rollback(journal) {
  const failures = [];
  for (const entry of journal) {
    try {
      if (entry.existed) {
        fs.mkdirSync(path.dirname(entry.file), { recursive: true });
        fs.writeFileSync(entry.file, entry.bytes);
      } else if (fs.existsSync(entry.file)) {
        fs.rmSync(entry.file, { force: true });
      }
    } catch (error) {
      failures.push({ path: entry.relativePath, error: error.message });
    }
  }
  return failures;
}

/** Write-then-rename, so a partially written file is never visible at the target. */
function publishOne(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.__publish__${process.pid}`;
  fs.writeFileSync(temp, bytes);
  fs.renameSync(temp, file);
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
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
  if (!manifestResult.valid) return blocked('MANIFEST', manifestResult.findings);
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
    cohortSelfExclusion: {
      path: consumptionPath,
      reason: 'The consumption record cannot hash its own final bytes; its identity is bound by the authority and manifest instead.'
    },
    cohortPathCount: manifestResult.authorizedPaths.length,
    cohort
  };

  /* ---- 3. TRANSACTIONAL PUBLICATION ---------------------------------- */
  let journal;
  try {
    journal = captureRollbackJournal(root, [...targets, consumptionPath]);
  } catch (error) {
    return blocked('JOURNAL', [{ code: 'ROLLBACK_JOURNAL_UNAVAILABLE', detail: error.message }]);
  }

  try {
    for (const relativePath of targets) publishOne(resolveMaintenancePath(root, relativePath), candidates.get(relativePath));
    publishOne(consumptionFile, Buffer.from(`${JSON.stringify(consumptionRecord, null, 2)}\n`, 'utf8'));
  } catch (error) {
    const rollbackFailures = rollback(journal);
    return {
      document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'ROLLED_BACK', stage: 'PUBLICATION',
      findings: [{ code: 'PUBLICATION_FAILED', detail: error.message }],
      rollbackFailures, rollbackClean: rollbackFailures.length === 0, published: []
    };
  }

  /* ---- 4. POST-VALIDATION -------------------------------------------- */
  const postFindings = [];
  for (const entry of cohort) {
    const file = resolveMaintenancePath(root, entry.path);
    const actual = file && fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
    if (actual !== entry.sha256) postFindings.push({ code: 'PUBLISHED_BYTES_DISAGREE_WITH_COHORT', detail: entry.path });
  }
  if (postFindings.length) {
    const rollbackFailures = rollback(journal);
    return {
      document: PUBLISHER_DOCUMENT, version: PUBLISHER_VERSION, decision: 'ROLLED_BACK', stage: 'POST_VALIDATION',
      findings: postFindings, rollbackFailures, rollbackClean: rollbackFailures.length === 0, published: []
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
