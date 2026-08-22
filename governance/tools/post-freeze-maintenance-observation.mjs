import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { collectClosedStateSealMembers, collectClosedStateSealMembersAtCommit } from '../gee-v1/core/sealed-state-evidence.mjs';
import { isExactMaintenancePath } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { collectValidatedOwnerPresentByteBootstrapReceipts } from '../gee-v1/core/owner-present-byte-bootstrap.mjs';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

/**
 * Every digest a path may LAWFULLY be holding before a program runs.
 *
 * Two sources, neither of which the running program can author:
 *
 *   - the committed HEAD blob for that path
 *   - any digest a prior consumption record already certified for it
 *
 * The second source matters because a path can be advanced several times inside
 * one uncommitted session: GATE_STATUS_SNAPSHOT.json is written by a closure
 * program and again by a projection-sync program, so the second program's lawful
 * pre-state is the first program's certified output, not HEAD.
 *
 * A consumption record is counted only when it still binds its own authority —
 * the authority file exists and the record cites that authority's manifest
 * digest. A record whose authority has drifted certifies nothing here.
 */
export function collectCanonicalPredecessors(root, relativePaths) {
  const byPath = new Map(relativePaths.map((p) => [p, new Set()]));
  for (const relativePath of relativePaths) {
    try {
      const bytes = execFileSync('git', ['show', `HEAD:${relativePath}`], { cwd: root, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
      byPath.get(relativePath).add(sha256(bytes));
    } catch { /* not tracked at HEAD: no committed predecessor */ }
  }
  const authoritiesById = new Map();
  const sourcesDir = path.join(root, 'governance', 'sources');
  if (fs.existsSync(sourcesDir)) {
    for (const entry of fs.readdirSync(sourcesDir).filter((name) => name.endsWith('.json'))) {
      try {
        const authority = readJson(path.join(sourcesDir, entry));
        if (authority?.authorityId) authoritiesById.set(authority.authorityId, authority);
      } catch { /* unreadable source is simply not an authority here */ }
    }
  }
  const historyDir = path.join(root, 'governance', 'historical-architecture');
  if (fs.existsSync(historyDir)) {
    for (const entry of fs.readdirSync(historyDir).filter((name) => name.endsWith('.json'))) {
      let record;
      try { record = readJson(path.join(historyDir, entry)); } catch { continue; }
      if (record?.documentKind !== 'POST_FREEZE_MAINTENANCE_AUTHORITY_CONSUMPTION' || !Array.isArray(record.cohort)) continue;
      const authority = authoritiesById.get(record.authorityId);
      if (!authority || authority.authorizedPathManifestSha256 !== record.manifestSha256) continue;
      for (const cohortEntry of record.cohort) {
        if (byPath.has(cohortEntry?.path) && typeof cohortEntry.sha256 === 'string') byPath.get(cohortEntry.path).add(cohortEntry.sha256);
      }
    }
  }
  // The only non-POST_FREEZE predecessor source is a bounded, independently
  // validated Owner present-byte recovery receipt.  Its evaluator deliberately
  // does not call this collector or the V2 pre-state evaluator, preventing C'
  // from prospectively authorizing its own repair.
  const bootstrapReceipts = collectValidatedOwnerPresentByteBootstrapReceipts({ root, relativePaths });
  for (const relativePath of relativePaths) {
    for (const digest of bootstrapReceipts.get(relativePath) ?? []) byPath.get(relativePath).add(digest);
  }
  return Object.fromEntries([...byPath].map(([p, set]) => [p, [...set].sort()]));
}

/** What each authorized path actually holds right now, for the pre-state gate. */
export function collectPathPrestates(root, relativePaths) {
  const predecessors = collectCanonicalPredecessors(root, relativePaths);
  const prestates = {};
  for (const relativePath of relativePaths) {
    const file = resolveMaintenancePath(root, relativePath);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      prestates[relativePath] = { state: 'ABSENT', sha256: null, byteLength: null, canonicalPredecessors: predecessors[relativePath] ?? [] };
      continue;
    }
    const bytes = fs.readFileSync(file);
    prestates[relativePath] = {
      state: 'PRESENT', sha256: sha256(bytes), byteLength: bytes.length,
      canonicalPredecessors: predecessors[relativePath] ?? []
    };
  }
  return prestates;
}

/**
 * WHAT THE AUTHORIZED PATHS HELD BEFORE A PUBLICATION THAT HAS ALREADY MOVED THEM.
 *
 * THE DEFECT THIS CLOSES, STATED EXACTLY. `collectPathPrestates` reads the LIVE
 * canonical bytes, and the pre-state gate compares those against what the manifest
 * declared. That is the right question at publication time and the WRONG one at
 * recovery time: publication is precisely the act that destroys the pre-state. A
 * transaction killed after publishing part of its cohort was therefore re-judged
 * against bytes its own publication had written, every published member reported
 * PATH_PRESTATE_SHA_MISMATCH, and the authority came back NOT_AUTHORIZED — so the
 * crash boundaries that most need recovery (a partial cohort, and a full candidate
 * that never reached COMMITTED) were exactly the two that could not recover.
 *
 * WHY THIS IS NOT "TRUST THE JOURNAL". The recorded before-state supplies only
 * ONE thing: what a cohort member held prior to the write. That claim is not taken
 * on faith — `isPermittedProgress` has already proved, from the live filesystem,
 * that every cohort member currently holds EITHER those exact recorded bytes OR
 * its exact recorded candidate bytes, and blocks on any third state. So the
 * reconstruction describes a pre-state the repository demonstrably came from.
 *
 * And the part a forged journal would most want to control is NOT taken from it:
 * `canonicalPredecessors` is recomputed LIVE, from the committed HEAD blob and
 * prior valid consumption records. A declared pre-state digest must still name one
 * of those, exactly as at publication time. A journal that invents a before-state
 * to match a manifest therefore still fails, because the invented digest is not a
 * canonical predecessor of anything.
 *
 * Paths the transaction did not write are observed live, because for those nothing
 * has moved and the live bytes ARE the pre-state.
 *
 * @param recordedBefore Map<repoRelativePath, {present, sha256, byteLength}>
 */
export function reconstructPathPrestates(root, relativePaths, recordedBefore) {
  const predecessors = collectCanonicalPredecessors(root, relativePaths);
  const prestates = {};
  for (const relativePath of relativePaths) {
    const canonicalPredecessors = predecessors[relativePath] ?? [];
    const recorded = recordedBefore instanceof Map ? recordedBefore.get(relativePath) : recordedBefore?.[relativePath];
    if (recorded) {
      prestates[relativePath] = recorded.present
        ? { state: 'PRESENT', sha256: recorded.sha256, byteLength: recorded.byteLength, canonicalPredecessors }
        : { state: 'ABSENT', sha256: null, byteLength: null, canonicalPredecessors };
      continue;
    }
    const file = resolveMaintenancePath(root, relativePath);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      prestates[relativePath] = { state: 'ABSENT', sha256: null, byteLength: null, canonicalPredecessors };
      continue;
    }
    const bytes = fs.readFileSync(file);
    prestates[relativePath] = { state: 'PRESENT', sha256: sha256(bytes), byteLength: bytes.length, canonicalPredecessors };
  }
  return prestates;
}

/**
 * The current commit if this tree has one, and `null` if it does not.
 *
 * Deliberately does not distinguish "no repository" from "git missing" from "no
 * commit yet". All three mean the same thing to every caller: no commit identity
 * is available to record, so none is recorded.
 */
function observeGitHead(root) {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch { return null; }
}

export function resolveMaintenancePath(root, relativePath) {
  if (!isExactMaintenancePath(relativePath)) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

/**
 * The seven fields that describe WHICH repository state an authority was bound
 * to, read from the canonical files rather than from anybody's claim.
 *
 * Extracted so the maintenance observation below and the transaction provenance
 * receipt cannot drift apart: a transaction that recorded a pre-state under one
 * definition and was recovered under another would be comparing two different
 * facts and calling the difference tampering.
 *
 * GIT IS OBSERVED, NEVER REQUIRED. `baseHead` used to be read with a throwing
 * `git rev-parse`, which was harmless while only the maintenance publisher built
 * a provenance receipt — that publisher runs on the canonical repository and has
 * its own, separate, deliberately hard-failing read below. Once the precontract
 * bootstrap, the anchor and the generic lifecycle publishers were given
 * MANDATORY recoverable provenance, that same throw became a hard Git dependency
 * on canonical publication itself: in a tree with no `.git` the observation threw,
 * the builder returned null, and an otherwise perfectly authorized publication was
 * refused as PROVENANCE_ABSENT_OR_INVALID.
 *
 * That inverts the causal direction the whole design rests on. Local authority
 * publishes; Git is the INDEPENDENT COMPARISON afterwards. A publisher that cannot
 * publish without Git has made Git an authority.
 *
 * So an unavailable HEAD is recorded as `null` — an absent observation, not a
 * substituted one — and each authority class decides for itself whether it can
 * live with that. The classes that bind to a commit still cannot: a null baseHead
 * never equals the 40-hex value such an authority declares, so BASE_HEAD_MISMATCH
 * still fires. Nothing is loosened; the check simply moved to the layer that owns
 * the requirement.
 */
export function observeCanonicalPreState(root, gateId) {
  const ledgerBytes = fs.readFileSync(path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson'));
  const events = ledgerBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  const gateRoot = gateId ? path.join(root, 'governance', 'gates', gateId) : null;
  const currentStateFile = gateRoot ? path.join(gateRoot, 'state', 'CURRENT_STATE.json') : null;
  const currentContractFile = gateRoot ? path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json') : null;
  const currentState = currentStateFile && fs.existsSync(currentStateFile) ? readJson(currentStateFile) : null;
  const currentContract = currentContractFile && fs.existsSync(currentContractFile) ? readJson(currentContractFile) : null;
  const activeGate = readJson(path.join(root, 'governance', 'active', 'ACTIVE_GATE.json'));
  return {
    baseHead: observeGitHead(root),
    ledgerEventCount: events.length,
    ledgerPrefixSha256: sha256(ledgerBytes),
    gateId: gateId ?? null,
    gateStatus: events.filter((event) => event.gateId === gateId).at(-1)?.toStatus ?? null,
    stateRevision: currentState?.stateRevision ?? null,
    contractRevision: currentContract?.contractRevision ?? null,
    activeGate: activeGate?.activeGate ?? null
  };
}

/** The one canonical observation projection used by both the CLI validator and lifecycle apply. */
export function collectPostFreezeMaintenanceObservation({
  root, authority, authorityDocumentPath = null, requestedPaths = null,
  requestedOperationClasses = null, candidateWrites = null,
  includeConsumptionCohort = true
}) {
  const findings = [];
  try {
    if (!authority || typeof authority !== 'object') throw new Error('AUTHORITY_ABSENT');
    const manifestPath = resolveMaintenancePath(root, authority.authorizedPathManifestPath);
    if (!manifestPath) throw new Error('MANIFEST_PATH_INVALID');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
    const ledgerBytes = fs.readFileSync(ledgerPath);
    const events = ledgerBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const gateId = authority.preState?.gateId;
    const gateRoot = gateId ? path.join(root, 'governance', 'gates', gateId) : null;
    const currentStateFile = gateRoot ? path.join(gateRoot, 'state', 'CURRENT_STATE.json') : null;
    const currentContractFile = gateRoot ? path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json') : null;
    // A NOT_STARTED gate can legitimately have neither projection yet.  Absence
    // is observed as null; an existing malformed projection still throws and
    // therefore remains a fail-closed observation failure.
    const currentState = currentStateFile && fs.existsSync(currentStateFile) ? readJson(currentStateFile) : null;
    const currentContract = currentContractFile && fs.existsSync(currentContractFile) ? readJson(currentContractFile) : null;
    const activeGate = readJson(path.join(root, 'governance', 'active', 'ACTIVE_GATE.json'));
    const externalReportFile = authority.externalReinspectionReportPath ? resolveMaintenancePath(root, authority.externalReinspectionReportPath) : null;
    const externalReportBytes = externalReportFile && fs.existsSync(externalReportFile) ? fs.readFileSync(externalReportFile) : null;
    let authorityPredecessorSha256 = null;
    if (authority.authorityPredecessor !== null) {
      const sources = path.join(root, 'governance', 'sources');
      const matches = fs.readdirSync(sources).filter((entry) => entry.endsWith('.json'))
        .map((entry) => path.join(sources, entry)).filter((file) => { try { return readJson(file).authorityId === authority.authorityPredecessor.authorityId; } catch { return false; } });
      if (matches.length === 1) authorityPredecessorSha256 = sha256(fs.readFileSync(matches[0]));
    }
    const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const preStateInventory = collectClosedStateSealMembersAtCommit(root, authority.preState?.baseHead);
    const candidateBytesByPath = new Map((candidateWrites ?? []).map((write) => [write.path, write.bytes]));
    const consumptionCohort = includeConsumptionCohort
      ? manifest.paths.filter((entry) => entry.path !== authority.consumptionRecordPath).map((entry) => {
          const candidateBytes = candidateBytesByPath.get(entry.path);
          if (candidateBytes) return { path: entry.path, sha256: sha256(candidateBytes), byteLength: candidateBytes.length };
          const file = resolveMaintenancePath(root, entry.path);
          if (!file || !fs.existsSync(file)) throw new Error(`CONSUMPTION_COHORT_PATH_ABSENT:${entry.path}`);
          const bytes = fs.readFileSync(file);
          return { path: entry.path, sha256: sha256(bytes), byteLength: bytes.length };
        })
      : undefined;
    return {
      valid: true, findings, manifest,
      observed: {
        baseHead, ledgerEventCount: events.length, ledgerPrefixSha256: sha256(ledgerBytes), gateId,
        gateStatus: events.filter((event) => event.gateId === gateId).at(-1)?.toStatus ?? null,
        stateRevision: currentState?.stateRevision ?? null, contractRevision: currentContract?.contractRevision ?? null,
        activeGate: activeGate?.activeGate ?? null,
        R8Absent: !fs.existsSync(path.join(root, 'governance', 'gee-v1', 'missions', 'GEE_V1_EXECUTION_CONTRACT_R0008.json')),
        manifestSha256: sha256(manifestBytes), authorityPredecessorSha256,
        externalReinspectionReportPath: externalReportBytes ? authority.externalReinspectionReportPath : null,
        externalReinspectionReportSha256: externalReportBytes ? sha256(externalReportBytes) : null,
        // Only a V2 manifest binds pre-state; observing it for V1 would invent an
        // expectation the manifest never made, and every V1 path would then read
        // as an undeclared observation.
        pathPrestates: manifest.schemaVersion === 2
          ? collectPathPrestates(root, manifest.paths.map((entry) => entry.path))
          : undefined,
        authorityDocumentPath,
        requestedPaths: requestedPaths ?? manifest.paths.map((entry) => entry.path),
        requestedOperationClasses: requestedOperationClasses ?? manifest.paths.map((entry) => entry.artifactClass),
        closedStateSealMembers: collectClosedStateSealMembers(root).members,
        closedStateSealFindings: collectClosedStateSealMembers(root).findings,
        preStateClosedStateSealMembers: preStateInventory.members,
        preStateClosedStateSealFindings: preStateInventory.findings,
        consumptionCohort
      }
    };
  } catch (error) {
    findings.push({ code: error?.message || String(error) });
    return { valid: false, findings, manifest: null, observed: {} };
  }
}
