/**
 * P3H recovery-authorization coverage. Offline only. Zero Yahoo/network.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  ADMITTED_UNTRACKED_PATHS,
  assertGitCanonicalTrackedWorktreeEquivalenceR1,
  buildP3hLoadBearingCohortAuditIdentityR1,
  CANONICAL_COHORT_802_KEY_DIGEST,
  CANONICAL_INCIDENT_EVIDENCE_DIGEST,
  CANONICAL_PREPARED_AUTHORITY_SHA256,
  CANONICAL_PROVIDER_LIBRARY_VERSION,
  CANONICAL_RESERVATIONS_ONLY_DIGEST,
  CANONICAL_TERMINALS_ONLY_DIGEST,
  DIGEST_ALGORITHM_IDS,
  GIT_BINDING_NAME,
  INCIDENT_RECOVERY_ID,
  JarviseRecoveryAuthorizationError,
  loadOwnerIncidentRecoveryGrantR1,
  parseOwnerIncidentRecoveryGrantObjectR1,
  P3H_LOAD_BEARING_LOGICAL_PATHS,
  posixRelPathFromMaybeWindowsR1,
  RECOVERY_GRANT_SCHEMA_VERSION,
  stripSha256PrefixOnceR1,
} from './jarviseYahooIncidentRecoveryAuthorizationR1.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function validRecoveryGrantFields(acquisitionRoot, extra = {}) {
  return {
    schemaVersion: RECOVERY_GRANT_SCHEMA_VERSION,
    mechanism: 'OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
    recoveryMechanismVersion: 'jarviseYahooIncidentRecoveryR1/1',
    incidentRecoveryId: INCIDENT_RECOVERY_ID,
    grantId: 'P3H-TEST-GRANT-1',
    issuedAt: '2026-09-07T00:00:00.000Z',
    issuedBy: 'PROJECT_OWNER',
    decisionType: 'PROJECT_OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
    preparedAuthoritySha256: CANONICAL_PREPARED_AUTHORITY_SHA256,
    providerLibraryVersion: CANONICAL_PROVIDER_LIBRARY_VERSION,
    acquisitionRoot,
    digestAlgorithmIds: { ...DIGEST_ALGORITHM_IDS },
    incidentEvidenceDigest: CANONICAL_INCIDENT_EVIDENCE_DIGEST,
    reservationsOnlyDigest: CANONICAL_RESERVATIONS_ONLY_DIGEST,
    terminalsOnlyDigest: CANONICAL_TERMINALS_ONLY_DIGEST,
    cohort802KeyDigest: CANONICAL_COHORT_802_KEY_DIGEST,
    expectedReservationCount: 802,
    expectedTerminalCount: 802,
    expectedIncidentOrdinal: 1,
    expectedCondition: 'MALFORMED_PROVIDER_RESULT',
    expectedRetryEligible: false,
    expectedJournalStage: 'EMPTY',
    expectedRawPinnedCount: 0,
    expectedOrdinal2Count: 0,
    expectedBudgetConsumed: 802,
    permittedNextOrdinal: 2,
    recoveryImplementationManifestSchemaVersion: 'TransformImplementationManifest/1',
    recoveryImplementationManifestDigest: 'a'.repeat(64),
    implementationCommit: 'b'.repeat(40),
    implementationTree: 'c'.repeat(40),
    ...extra,
  };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'p3h-recovery-auth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeGrant(t, extra = {}) {
  const root = tempRoot(t);
  const acquisitionRoot = mkdtempSync(join(tmpdir(), 'p3h-acq-'));
  t.after(() => rmSync(acquisitionRoot, { recursive: true, force: true }));
  const grantPath = join(root, 'recovery-grant.json');
  const grant = validRecoveryGrantFields(acquisitionRoot, extra);
  writeFileSync(grantPath, `${JSON.stringify(grant, null, 2)}\n`);
  return { grantPath, grant, acquisitionRoot };
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
}

test('P3H-T29 unknown recovery field is RECOVERY_GRANT_UNKNOWN_FIELD', () => {
  const grant = validRecoveryGrantFields('C:\\\\abs\\\\root');
  grant.unexpected = true;
  assert.throws(
    () => parseOwnerIncidentRecoveryGrantObjectR1(grant),
    (error) => error instanceof JarviseRecoveryAuthorizationError && error.code === 'RECOVERY_GRANT_UNKNOWN_FIELD',
  );
});

test('P3H-T30 EXPLICIT_MISSION_GRANT does not activate recovery', () => {
  const grant = validRecoveryGrantFields('C:\\\\abs\\\\root');
  grant.mechanism = 'EXPLICIT_MISSION_GRANT';
  assert.throws(
    () => parseOwnerIncidentRecoveryGrantObjectR1(grant),
    (error) => error.code === 'RECOVERY_GRANT_WRONG_VALUE',
  );
});

test('P3H-T43 unknown / missing / wrong-type / wrong-value codes and priority', () => {
  const unknown = validRecoveryGrantFields('C:\\\\abs\\\\root');
  unknown.incidentEvidnceDigest = unknown.incidentEvidenceDigest;
  delete unknown.incidentEvidenceDigest;
  assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(unknown), (error) => error.code === 'RECOVERY_GRANT_UNKNOWN_FIELD');

  const missing = validRecoveryGrantFields('C:\\\\abs\\\\root');
  delete missing.grantId;
  assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(missing), (error) => error.code === 'RECOVERY_GRANT_MISSING_REQUIRED_FIELD');

  const wrongType = validRecoveryGrantFields('C:\\\\abs\\\\root');
  wrongType.expectedReservationCount = '802';
  assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(wrongType), (error) => error.code === 'RECOVERY_GRANT_WRONG_TYPE');

  const wrongValue = validRecoveryGrantFields('C:\\\\abs\\\\root');
  wrongValue.permittedNextOrdinal = 3;
  assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(wrongValue), (error) => error.code === 'RECOVERY_GRANT_WRONG_VALUE');
});

test('P3H-T48 providerLibraryVersion mismatch fail closed', () => {
  const grant = validRecoveryGrantFields('C:\\\\abs\\\\root', { providerLibraryVersion: '0.0.0' });
  assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(grant), (error) => error.code === 'RECOVERY_GRANT_WRONG_VALUE');
});

test('P3H-T54 malformed recovery grant fails before any ordinal2 access', (t) => {
  const { grantPath } = writeGrant(t);
  writeFileSync(grantPath, 'not-json');
  assert.throws(
    () => loadOwnerIncidentRecoveryGrantR1({ grantPath }),
    (error) => error.code === 'RECOVERY_GRANT_WRONG_TYPE',
  );
  assert.throws(
    () => loadOwnerIncidentRecoveryGrantR1({ grantPath: 'relative.json' }),
    (error) => error.code === 'RECOVERY_GRANT_PATH_UNSAFE',
  );
});

test('P3H-T55 canonicalHash two-argument contract and one-time sha256 prefix strip', () => {
  const hashed = canonicalHash('JarviseYahooIncidentCohort802KeyDigest/1', {
    schemaVersion: 'JarviseYahooIncidentCohort802KeyDigest/1',
    digestAlgorithmId: DIGEST_ALGORITHM_IDS.cohort802KeyDigest,
    expectedKeyCount: 1,
    acquisitionKeys: ['k'],
  });
  assert.match(hashed, /^sha256:[0-9a-f]{64}$/);
  const stripped = stripSha256PrefixOnceR1(hashed);
  assert.match(stripped, /^[0-9a-f]{64}$/);
  assert.equal(stripSha256PrefixOnceR1(stripped), stripped);
  assert.equal(posixRelPathFromMaybeWindowsR1('reservations\\abc\\1.json'), 'reservations/abc/1.json');
});

test('P3H-T59 seven-path audit manifest includes hasher module', () => {
  const identity = buildP3hLoadBearingCohortAuditIdentityR1({ labRoot: REPOSITORY_ROOT });
  const paths = identity.manifest.modules.map((module) => module.logicalPath);
  assert.equal(identity.role, 'P3H_LOAD_BEARING_COHORT_AUDIT_IDENTITY');
  assert.deepEqual([...identity.logicalPaths].sort(), [...P3H_LOAD_BEARING_LOGICAL_PATHS].sort());
  assert.equal(paths.includes('research/directional-lab/src/data/transformImplementationManifestV1.mjs'), true);
  assert.equal(paths.length, 7);
  assert.match(identity.recoveryImplementationManifestDigest, /^[0-9a-f]{64}$/);
});

test('P3H-T28 preparedAuthoritySha256 remains 4c997ff5…398cae', () => {
  const bytes = readFileSync(new URL('./jarviseFetchOnceExecutionAuthorityR1.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), CANONICAL_PREPARED_AUTHORITY_SHA256);
});

test('P3H-T60 GIT_CANONICAL_TRACKED_WORKTREE_EQUIVALENCE isolated repo', (t) => {
  const gitRoot = mkdtempSync(join(tmpdir(), 'p3h-t60-git-'));
  t.after(() => rmSync(gitRoot, { recursive: true, force: true }));
  git(gitRoot, ['-c', 'init.defaultBranch=main', 'init']);
  git(gitRoot, ['config', 'user.email', 't60@local']);
  git(gitRoot, ['config', 'user.name', 'T60']);
  git(gitRoot, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(gitRoot, 'app'), { recursive: true });
  writeFileSync(join(gitRoot, 'app', 'tracked.txt'), 'ok\n');
  git(gitRoot, ['add', '--', 'app/tracked.txt']);
  git(gitRoot, ['commit', '-m', 'seed']);
  const head = git(gitRoot, ['rev-parse', 'HEAD']).trim();
  const tree = git(gitRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  const grant = validRecoveryGrantFields(join(gitRoot, 'acq'), {
    implementationCommit: head,
    implementationTree: tree,
  });

  assert.equal(assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }).name, GIT_BINDING_NAME);

  writeFileSync(join(gitRoot, 'app', 'tracked.txt'), 'dirty\n');
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }),
    (error) => error.code === 'GIT_BINDING_WORKTREE_DIRTY',
  );
  git(gitRoot, ['checkout', '--', 'app/tracked.txt']);

  writeFileSync(join(gitRoot, 'app', 'tracked.txt'), 'staged\n');
  git(gitRoot, ['add', '--', 'app/tracked.txt']);
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }),
    (error) => error.code === 'GIT_BINDING_INDEX_DIRTY',
  );
  git(gitRoot, ['reset', '-q', 'HEAD', '--', 'app/tracked.txt']);
  git(gitRoot, ['checkout', '--', 'app/tracked.txt']);

  git(gitRoot, ['update-index', '--assume-unchanged', '--', 'app/tracked.txt']);
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }),
    (error) => error.code === 'GIT_BINDING_MASKED_INDEX',
  );
  git(gitRoot, ['update-index', '--no-assume-unchanged', '--', 'app/tracked.txt']);

  git(gitRoot, ['update-index', '--skip-worktree', '--', 'app/tracked.txt']);
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }),
    (error) => error.code === 'GIT_BINDING_MASKED_INDEX',
  );
  git(gitRoot, ['update-index', '--no-skip-worktree', '--', 'app/tracked.txt']);

  writeFileSync(join(gitRoot, 'unexpected.txt'), 'nope\n');
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }),
    (error) => error.code === 'GIT_BINDING_UNEXPECTED_UNTRACKED',
  );
  rmSync(join(gitRoot, 'unexpected.txt'));

  mkdirSync(join(gitRoot, ...ADMITTED_UNTRACKED_PATHS[0].split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(gitRoot, ...ADMITTED_UNTRACKED_PATHS[0].split('/')), '{}\n');
  assert.equal(assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant }).passed, true);

  const mismatch = { ...grant, implementationCommit: 'd'.repeat(40) };
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant: mismatch }),
    (error) => error.code === 'GIT_BINDING_COMMIT_MISMATCH',
  );
  const treeMismatch = { ...grant, implementationTree: 'e'.repeat(40) };
  assert.throws(
    () => assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot, grant: treeMismatch }),
    (error) => error.code === 'GIT_BINDING_TREE_MISMATCH',
  );
});

test('P3H recovery grant loader has no default path and no autodiscovery', () => {
  assert.throws(
    () => loadOwnerIncidentRecoveryGrantR1({}),
    (error) => error.code === 'RECOVERY_GRANT_PATH_REQUIRED',
  );
});

test('P3H recovery grant forbids executionAuthorized/networkAuthorized/self-SHA', () => {
  for (const field of ['executionAuthorized', 'networkAuthorized', 'recoveryGrantSha256', 'acquirerModuleSha256']) {
    const grant = validRecoveryGrantFields('C:\\\\abs\\\\root');
    grant[field] = field === 'executionAuthorized' || field === 'networkAuthorized' ? true : 'a'.repeat(64);
    assert.throws(() => parseOwnerIncidentRecoveryGrantObjectR1(grant), (error) => error.code === 'RECOVERY_GRANT_UNKNOWN_FIELD');
  }
});
