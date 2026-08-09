/**
 * Produces a RELEASE_REQUEST — a factual, NON-AUTHORITATIVE description of the
 * exact delta an agent wants persisted in one local commit.
 *
 * This tool grants nothing. Running it does not make any Git write legal. Its
 * only product is a digest the PROJECT OWNER may choose to sign.
 *
 * Paths are ENUMERATED EXPLICITLY by the caller. There is deliberately no
 * "everything dirty" mode: a request that says `git add .` cannot be expressed,
 * so it cannot be approved.
 *
 * Usage:
 *   node governance/tools/generate-release-request.mjs \
 *     --out <absolute-path-to-request.json> \
 *     --paths-from <file with one repo-relative path per line> \
 *     --work-unit GATE:GATE13:COMPLETE_CONFIRMED \
 *     --work-unit REVISION:GEE_V1_R1:COMPLETE_CONFIRMED \
 *     --message-file <file> \
 *     [--witness <absolute path to external witness>]
 *
 * Deterministic and local: no network, no repository writes, no Git writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  RELEASE_SCHEMA_VERSION, REQUEST_DOCUMENT_KIND, RELEASE_PURPOSE,
  computeManifestDigest, computeRequestDigest, sha256Hex
} from '../gee-v1/core/release-authority.mjs';
import { WHEEL_RELEASE_POLICY, sha256File } from '../gee-v1/adapters/wheel/release-policy.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const all = (name) => args.reduce((acc, a, i) => (a === name ? [...acc, args[i + 1]] : acc), []);

const repoRoot = process.cwd();
const git = (...a) => {
  const r = spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`GIT_READ_FAILED:${a.join(' ')}`);
  return r.stdout.trimEnd();
};

const outPath = opt('--out');
const pathsFrom = opt('--paths-from');
const messageFile = opt('--message-file');
const witnessPath = opt('--witness') || process.env.GEE_HEAD_WITNESS_SOURCE || null;
if (!outPath || !pathsFrom || !messageFile) {
  console.error(JSON.stringify({ error: 'MISSING_REQUIRED_ARGUMENT', required: ['--out', '--paths-from', '--message-file'] }));
  process.exit(2);
}

// A request may never be authored into the governed set: the owner must be able
// to distinguish the artifact they approve from the repository it acts on.
if (path.resolve(outPath).startsWith(path.resolve(repoRoot) + path.sep)) {
  console.error(JSON.stringify({ error: 'REQUEST_OUTPUT_INSIDE_GOVERNED_SET', outPath }));
  process.exit(2);
}

const requestedPaths = fs.readFileSync(pathsFrom, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const commitMessage = fs.readFileSync(messageFile, 'utf8').replace(/\s+$/, '');

// Status is READ to classify each explicitly requested path — never to discover
// paths the caller did not name.
const statusByPath = new Map();
for (const line of git('status', '--porcelain=v1', '-z').split('\0')) {
  if (!line) continue;
  const code = line.slice(0, 2);
  const p = line.slice(3);
  statusByPath.set(p, code);
}

const manifest = [];
const problems = [];
for (const p of requestedPaths.slice().sort()) {
  const absolute = path.join(repoRoot, p);
  const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  const code = statusByPath.get(p) || '';
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', p], { cwd: repoRoot, encoding: 'utf8' }).status === 0;
  if (!exists && !tracked) { problems.push({ path: p, reason: 'PATH_ABSENT_AND_UNTRACKED' }); continue; }
  if (!exists) {
    manifest.push({ path: p, status: 'DELETED', workingTreeSha256: null, stageAction: 'STAGE_DELETION' });
  } else {
    manifest.push({
      path: p,
      status: tracked ? 'MODIFIED' : 'ADDED',
      workingTreeSha256: sha256File(absolute),
      stageAction: 'STAGE_CONTENT'
    });
  }
  if (!code && exists && tracked) problems.push({ path: p, reason: 'PATH_HAS_NO_PENDING_CHANGE' });
}

const workUnits = all('--work-unit').map((spec) => {
  const [workUnitType, workUnitId, closureVerdict] = String(spec).split(':');
  return { workUnitType, workUnitId, closureVerdict };
});

const governedStateBindings = WHEEL_RELEASE_POLICY.governedStateBindings.map((b) => ({
  bindingId: b.bindingId,
  path: b.path,
  sha256: sha256File(path.join(repoRoot, b.path))
}));

const request = {
  schemaVersion: RELEASE_SCHEMA_VERSION,
  documentKind: REQUEST_DOCUMENT_KIND,
  requestId: `RR-${sha256Hex(`${git('rev-parse', 'HEAD')}:${computeManifestDigest(manifest)}`).slice(0, 24)}`,
  projectId: WHEEL_RELEASE_POLICY.projectId,
  repositoryOriginUrl: git('config', '--get', 'remote.origin.url'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  baseCommit: git('rev-parse', 'HEAD'),
  purpose: RELEASE_PURPOSE,
  workUnits,
  governedStateBindings,
  ...(witnessPath ? { externalWitness: { path: witnessPath, sha256: sha256File(witnessPath) } } : {}),
  requestedOperations: ['GIT_ADD_PATHSPEC', 'GIT_COMMIT'],
  pushRequested: false,
  maxCommitCount: 1,
  commitMessage,
  manifest,
  manifestDigest: computeManifestDigest(manifest)
};
request.requestDigest = computeRequestDigest(request);

fs.writeFileSync(outPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  document: 'RELEASE_REQUEST_GENERATED',
  authoritative: false,
  grantsGitWrite: false,
  outPath,
  requestId: request.requestId,
  baseCommit: request.baseCommit,
  manifestEntries: manifest.length,
  manifestDigest: request.manifestDigest,
  requestDigest: request.requestDigest,
  problems,
  nextStep: 'PROJECT_OWNER_MUST_SIGN_requestDigest_OUTSIDE_THIS_REPOSITORY'
}, null, 2));
process.exitCode = problems.length ? 2 : 0;
