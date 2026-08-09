/**
 * Decides whether an owner-issued PROJECT_OWNER_RELEASE_AUTHORIZATION currently
 * authorizes one targeted local release commit in THIS repository.
 *
 * This is the only tool whose PASS may satisfy the constitutional override
 * OWNER_AUTHORIZED_RELEASE_COMMIT. It recomputes every verdict; it reads no
 * verdict from a field. Absence of an authorization is BLOCKED, never PASS.
 *
 * It must be run TWICE by a release mission:
 *   --phase PRE_STAGE   before any `git add`
 *   --phase PRE_COMMIT  after staging, before `git commit` (re-checks that the
 *                       staged set is exactly the approved manifest)
 *
 * This tool performs NO Git writes. It prints the exact command lines the
 * mission is permitted to run and nothing else is permitted.
 *
 * Usage:
 *   node governance/tools/validate-release-authorization.mjs \
 *     --request <path to RELEASE_REQUEST.json> \
 *     [--authorization <path>]        # else GEE_RELEASE_AUTHORIZATION_SOURCE
 *     [--phase PRE_STAGE|PRE_COMMIT]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateReleaseAuthorization, PHASE_PRE_STAGE, PHASE_PRE_COMMIT
} from '../gee-v1/core/release-authority.mjs';
import {
  loadConfiguredReleaseAuthorization, loadOwnerReleaseKey
} from '../gee-v1/core/release-authorization-source.mjs';
import { WHEEL_RELEASE_POLICY, buildObservedState } from '../gee-v1/adapters/wheel/release-policy.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

const repoRoot = process.cwd();
const phase = opt('--phase', PHASE_PRE_STAGE);
const requestPath = opt('--request');

const git = (...a) => {
  const r = spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

function emit(report) {
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.RELEASE_VERDICT === 'AUTHORIZED' ? 0 : 2;
}

let request = null;
let requestLoadFinding = null;
try {
  request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
} catch {
  requestLoadFinding = 'REQUEST_ABSENT';
}

// A request that lives inside the governed set is indistinguishable from one the
// agent rewrote after approval; the digest check would still catch it, but the
// boundary is stated explicitly rather than relied upon implicitly.
if (requestPath && path.resolve(requestPath).startsWith(path.resolve(repoRoot) + path.sep)) {
  requestLoadFinding = 'REQUEST_INSIDE_GOVERNED_SET';
  request = null;
}

const loaded = loadConfiguredReleaseAuthorization({
  explicitPath: opt('--authorization'),
  governedRoots: [repoRoot]
});
const ownerKeyResult = loadOwnerReleaseKey(path.join(repoRoot, WHEEL_RELEASE_POLICY.ownerPublicKeyPath));

const headCommit = git('rev-parse', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const stagedPaths = phase === PHASE_PRE_COMMIT
  ? (git('diff', '--cached', '--name-only') || '').split(/\r?\n/).filter(Boolean)
  : null;

const observed = buildObservedState({ repoRoot, headCommit, branch, request, stagedPaths });

const result = evaluateReleaseAuthorization({
  request,
  authorization: loaded.authorization,
  authorizationLoadFinding: loaded.finding || requestLoadFinding || ownerKeyResult.finding,
  ownerKey: ownerKeyResult.ownerKey,
  observed,
  phase
});

// A second, independent stop: even a fully valid authorization may never grant
// push or any destructive Git command, whatever it claims.
const pushAuthority = 'FORBIDDEN_SEPARATE_AUTHORITY_REQUIRED';

emit({
  document: 'POST_CLOSURE_RELEASE_AUTHORIZATION_VALIDATION',
  RELEASE_VERDICT: result.decision,
  phase: result.phase,
  recomputed: true,
  projectId: WHEEL_RELEASE_POLICY.projectId,
  baseHeadObserved: headCommit,
  branchObserved: branch,
  authorizationSource: loaded.sourcePath,
  authorizationLoadFinding: loaded.finding,
  ownerKeyId: ownerKeyResult.ownerKey?.keyId ?? null,
  blockingFindings: result.findings,
  blockingFindingCount: result.findings.length,
  permittedOperations: result.permittedOperations,
  permittedCommands: result.commitPlan?.commands ?? [],
  pushAuthority,
  maxCommitCount: 1,
  consumptionRule: 'BASE_HEAD_BINDING__AUTHORIZATION_BECOMES_STALE_ONCE_HEAD_MOVES'
});
