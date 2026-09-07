/**
 * P3H Owner incident-recovery authorization.
 *
 * Parses an Owner-supplied recovery grant from an explicit absolute path.
 * Does not emit a grant, does not mutate P3G, does not autodiscover a path,
 * and does not authorize Yahoo/network. Execution remains EXPLICIT_MISSION_GRANT.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  buildTransformImplementationManifest,
  transformImplementationHash,
} from '../../research/directional-lab/src/data/transformImplementationManifestV1.mjs';

export const JARVISE_YAHOO_INCIDENT_RECOVERY_AUTHORIZATION_VERSION = 'jarviseYahooIncidentRecoveryR1/1';
export const RECOVERY_GRANT_SCHEMA_VERSION = 'JarviseYahooIncidentRecoveryAuthorization/1';
export const RECOVERY_PROVENANCE_SCHEMA_VERSION = 'JarviseYahooIncidentRecoveryProvenance/1';
export const ATTEMPT_RESERVATION_SCHEMA_VERSION_V1 = 'JarviseYahooFetchOnceAttemptReservation/1';
export const ATTEMPT_RESERVATION_SCHEMA_VERSION_V2 = 'JarviseYahooFetchOnceAttemptReservation/2';
export const INCIDENT_RECOVERY_ID = 'P3G_ZERO_HTTP_MALFORMED_802_R1';
export const RECOVERY_MECHANISM = 'OWNER_INCIDENT_RECOVERY_AUTHORIZATION';
export const RECOVERY_DECISION_TYPE = 'PROJECT_OWNER_INCIDENT_RECOVERY_AUTHORIZATION';
export const P3H_RUNTIME_CONTRACT_VERSION = 'jarviseYahooIncidentRecoveryR1/1';
export const P3H_MANIFEST_ROLE = 'P3H_LOAD_BEARING_COHORT_AUDIT_IDENTITY';
export const GIT_BINDING_NAME = 'GIT_CANONICAL_TRACKED_WORKTREE_EQUIVALENCE';

export const CANONICAL_PREPARED_AUTHORITY_SHA256 = '4c997ff500ce51864f68530a3add3b005677dc14c6ff62450aa03e02c8398cae';
export const CANONICAL_INCIDENT_EVIDENCE_DIGEST = '8af220d4b119a8b6eca03f06a50422f93c46ef8b3885cadbca6dd96e33026bea';
export const CANONICAL_RESERVATIONS_ONLY_DIGEST = 'ed7518ee18455a6179ba8022ec2e52f02a332d8d4a4dce13379ea7887677e0b7';
export const CANONICAL_TERMINALS_ONLY_DIGEST = '537e45b485522eb522821225cc873ef40d0e503b40042763c1a47556e7f93705';
export const CANONICAL_COHORT_802_KEY_DIGEST = '1372f49e8b032d99e3480332a15a413b1431e27502756fe4e5d7590b5d23bc5b';
export const CANONICAL_PROVIDER_LIBRARY_VERSION = '3.14.0';

export const DIGEST_ALGORITHM_IDS = Object.freeze({
  incidentEvidenceDigest: 'JarviseYahooIncidentOrdinal1EvidenceDigest/1',
  reservationsOnlyDigest: 'JarviseYahooIncidentOrdinal1ReservationsDigest/1',
  terminalsOnlyDigest: 'JarviseYahooIncidentOrdinal1TerminalsDigest/1',
  cohort802KeyDigest: 'JarviseYahooIncidentCohort802KeyDigest/1',
});

export const P3H_LOAD_BEARING_LOGICAL_PATHS = Object.freeze([
  'app/jarvise/jarviseYahooFetchOnceAcquirerR1.mjs',
  'app/jarvise/jarviseYahooFinance2ChartClientFactoryR1.mjs',
  'app/jarvise/jarviseYahooChartAdapterR1.mjs',
  'app/jarvise/jarviseYahooIncidentRecoveryAuthorizationR1.mjs',
  'scripts/runJarviseHistoricalFetchOnceR1.mjs',
  'research/directional-lab/src/canonical/canonicalJsonV1.mjs',
  'research/directional-lab/src/data/transformImplementationManifestV1.mjs',
]);

export const ADMITTED_UNTRACKED_PATHS = Object.freeze([
  'governance/sources/GATE25_CANONICAL_MANDATE_R0.json',
]);

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_OID40 = /^[0-9a-f]{40}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export class JarviseRecoveryAuthorizationError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseRecoveryAuthorizationError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseRecoveryAuthorizationError(code, message, details);
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const CLOSED_GRANT_FIELDS = Object.freeze([
  'schemaVersion',
  'mechanism',
  'recoveryMechanismVersion',
  'incidentRecoveryId',
  'grantId',
  'issuedAt',
  'issuedBy',
  'decisionType',
  'preparedAuthoritySha256',
  'providerLibraryVersion',
  'acquisitionRoot',
  'digestAlgorithmIds',
  'incidentEvidenceDigest',
  'reservationsOnlyDigest',
  'terminalsOnlyDigest',
  'cohort802KeyDigest',
  'expectedReservationCount',
  'expectedTerminalCount',
  'expectedIncidentOrdinal',
  'expectedCondition',
  'expectedRetryEligible',
  'expectedJournalStage',
  'expectedRawPinnedCount',
  'expectedOrdinal2Count',
  'expectedBudgetConsumed',
  'permittedNextOrdinal',
  'recoveryImplementationManifestSchemaVersion',
  'recoveryImplementationManifestDigest',
  'implementationCommit',
  'implementationTree',
]);

const FORBIDDEN_GRANT_FIELDS = Object.freeze([
  'executionAuthorized',
  'networkAuthorized',
  'recoveryGrantSha256',
  'acquirerModuleSha256',
]);

const CLOSED_PROVENANCE_FIELDS = Object.freeze([
  'schemaVersion',
  'mechanism',
  'incidentRecoveryId',
  'recoveryGrantId',
  'recoveryGrantSha256',
  'recoveryImplementationManifestSchemaVersion',
  'recoveryImplementationManifestDigest',
  'preparedAuthoritySha256',
  'incidentEvidenceDigest',
  'cohort802KeyDigest',
  'acquisitionKey',
  'attemptOrdinal',
  'permittedFromIncidentOrdinal',
  'ordinal1Reservation',
  'ordinal1Terminal',
]);

const CLOSED_FILE_REF_FIELDS = Object.freeze(['relPath', 'sha256', 'byteLength']);

/** @param {string} acquisitionKey */
export function recoveryReservationDirectoryNameR1(acquisitionKey) {
  if (typeof acquisitionKey !== 'string' || acquisitionKey.length === 0) {
    fail('ACQUIRER_INPUT_INVALID', 'acquisitionKey is required');
  }
  return createHash('sha256').update(acquisitionKey, 'utf8').digest('hex');
}

/** @param {string} value */
export function stripSha256PrefixOnceR1(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('sha256:')) return value.slice('sha256:'.length);
  return value;
}

/** @param {unknown} value */
function requireHex64(value, field) {
  if (typeof value !== 'string' || !HEX64.test(value)) {
    fail('RECOVERY_GRANT_WRONG_VALUE', `${field} must be 64 lowercase hex`, { field, actual: value });
  }
  return value;
}

/** @param {unknown} value */
function requireOid40(value, field) {
  if (typeof value !== 'string' || !GIT_OID40.test(value)) {
    fail('RECOVERY_GRANT_WRONG_VALUE', `${field} must be 40 lowercase hex`, { field, actual: value });
  }
  return value;
}

/**
 * @param {{labRoot?: string}} [options]
 */
export function buildP3hLoadBearingCohortAuditIdentityR1(options = {}) {
  const labRoot = options.labRoot ?? REPOSITORY_ROOT;
  const manifest = buildTransformImplementationManifest({
    labRoot,
    logicalPaths: [...P3H_LOAD_BEARING_LOGICAL_PATHS],
    runtimeContractVersion: P3H_RUNTIME_CONTRACT_VERSION,
  });
  const hashed = transformImplementationHash(manifest);
  const digest = stripSha256PrefixOnceR1(hashed);
  if (typeof digest !== 'string' || !HEX64.test(digest)) {
    fail('RECOVERY_IMPLEMENTATION_MANIFEST_INVALID', 'transformImplementationHash did not yield 64 hex');
  }
  return Object.freeze({
    role: P3H_MANIFEST_ROLE,
    runtimeContractVersion: P3H_RUNTIME_CONTRACT_VERSION,
    manifest,
    recoveryImplementationManifestDigest: digest,
    logicalPaths: [...P3H_LOAD_BEARING_LOGICAL_PATHS],
  });
}

/**
 * @param {unknown} value
 */
function assertDigestAlgorithmIds(value) {
  if (!isPlainObject(value)) fail('RECOVERY_GRANT_WRONG_TYPE', 'digestAlgorithmIds must be a plain object');
  const keys = Object.keys(value);
  const expected = Object.keys(DIGEST_ALGORITHM_IDS);
  const extra = keys.filter((key) => !expected.includes(key));
  if (extra.length > 0) fail('RECOVERY_GRANT_UNKNOWN_FIELD', `digestAlgorithmIds unknown field: ${extra[0]}`, { field: extra[0] });
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      fail('RECOVERY_GRANT_MISSING_REQUIRED_FIELD', `digestAlgorithmIds.${key} is required`, { field: `digestAlgorithmIds.${key}` });
    }
    if (value[key] !== DIGEST_ALGORITHM_IDS[key]) {
      fail('RECOVERY_GRANT_WRONG_VALUE', `digestAlgorithmIds.${key} mismatch`, { field: `digestAlgorithmIds.${key}` });
    }
  }
}

/**
 * Closed-schema parse of an already-loaded grant object. Does not read a path.
 * @param {unknown} value
 */
export function parseOwnerIncidentRecoveryGrantObjectR1(value) {
  if (!isPlainObject(value)) fail('RECOVERY_GRANT_WRONG_TYPE', 'recovery grant must be a plain object');
  const grant = /** @type {Record<string, unknown>} */ (value);

  for (const field of FORBIDDEN_GRANT_FIELDS) {
    if (Object.hasOwn(grant, field)) {
      fail('RECOVERY_GRANT_UNKNOWN_FIELD', `forbidden field ${field}`, { field });
    }
  }
  const extra = Object.keys(grant).filter((field) => !CLOSED_GRANT_FIELDS.includes(field));
  if (extra.length > 0) fail('RECOVERY_GRANT_UNKNOWN_FIELD', `unknown field ${extra[0]}`, { field: extra[0] });
  for (const field of CLOSED_GRANT_FIELDS) {
    if (!Object.hasOwn(grant, field)) {
      fail('RECOVERY_GRANT_MISSING_REQUIRED_FIELD', `${field} is required`, { field });
    }
  }

  const stringFields = [
    'schemaVersion', 'mechanism', 'recoveryMechanismVersion', 'incidentRecoveryId',
    'grantId', 'issuedAt', 'issuedBy', 'decisionType', 'preparedAuthoritySha256',
    'providerLibraryVersion', 'acquisitionRoot', 'incidentEvidenceDigest',
    'reservationsOnlyDigest', 'terminalsOnlyDigest', 'cohort802KeyDigest',
    'expectedCondition', 'expectedJournalStage',
    'recoveryImplementationManifestSchemaVersion', 'recoveryImplementationManifestDigest',
    'implementationCommit', 'implementationTree',
  ];
  for (const field of stringFields) {
    if (typeof grant[field] !== 'string') fail('RECOVERY_GRANT_WRONG_TYPE', `${field} must be a string`, { field });
  }
  const integerFields = [
    'expectedReservationCount', 'expectedTerminalCount', 'expectedIncidentOrdinal',
    'expectedRawPinnedCount', 'expectedOrdinal2Count', 'expectedBudgetConsumed',
    'permittedNextOrdinal',
  ];
  for (const field of integerFields) {
    if (typeof grant[field] !== 'number' || !Number.isInteger(grant[field])) {
      fail('RECOVERY_GRANT_WRONG_TYPE', `${field} must be an integer`, { field });
    }
  }
  if (typeof grant.expectedRetryEligible !== 'boolean') {
    fail('RECOVERY_GRANT_WRONG_TYPE', 'expectedRetryEligible must be a boolean', { field: 'expectedRetryEligible' });
  }

  if (grant.schemaVersion !== RECOVERY_GRANT_SCHEMA_VERSION) fail('RECOVERY_GRANT_WRONG_VALUE', 'schemaVersion mismatch');
  if (grant.mechanism !== RECOVERY_MECHANISM) fail('RECOVERY_GRANT_WRONG_VALUE', 'mechanism mismatch');
  if (grant.recoveryMechanismVersion !== JARVISE_YAHOO_INCIDENT_RECOVERY_AUTHORIZATION_VERSION) {
    fail('RECOVERY_GRANT_WRONG_VALUE', 'recoveryMechanismVersion mismatch');
  }
  if (grant.incidentRecoveryId !== INCIDENT_RECOVERY_ID) fail('RECOVERY_GRANT_WRONG_VALUE', 'incidentRecoveryId mismatch');
  if (grant.grantId.length === 0) fail('RECOVERY_GRANT_WRONG_VALUE', 'grantId must be non-empty');
  if (!ISO_UTC.test(/** @type {string} */ (grant.issuedAt))) fail('RECOVERY_GRANT_WRONG_VALUE', 'issuedAt must be ISO-8601 UTC');
  if (grant.issuedBy !== 'PROJECT_OWNER') fail('RECOVERY_GRANT_WRONG_VALUE', 'issuedBy must be PROJECT_OWNER');
  if (grant.decisionType !== RECOVERY_DECISION_TYPE) fail('RECOVERY_GRANT_WRONG_VALUE', 'decisionType mismatch');
  if (grant.preparedAuthoritySha256 !== CANONICAL_PREPARED_AUTHORITY_SHA256) {
    fail('RECOVERY_GRANT_WRONG_VALUE', 'preparedAuthoritySha256 mismatch');
  }
  if (grant.providerLibraryVersion !== CANONICAL_PROVIDER_LIBRARY_VERSION) {
    fail('RECOVERY_GRANT_WRONG_VALUE', 'providerLibraryVersion mismatch');
  }
  if (typeof grant.acquisitionRoot !== 'string' || grant.acquisitionRoot.length === 0 || !isAbsolute(grant.acquisitionRoot)) {
    fail('RECOVERY_GRANT_WRONG_VALUE', 'acquisitionRoot must be an absolute path');
  }
  assertDigestAlgorithmIds(grant.digestAlgorithmIds);
  if (grant.incidentEvidenceDigest !== CANONICAL_INCIDENT_EVIDENCE_DIGEST) fail('RECOVERY_GRANT_WRONG_VALUE', 'incidentEvidenceDigest mismatch');
  if (grant.reservationsOnlyDigest !== CANONICAL_RESERVATIONS_ONLY_DIGEST) fail('RECOVERY_GRANT_WRONG_VALUE', 'reservationsOnlyDigest mismatch');
  if (grant.terminalsOnlyDigest !== CANONICAL_TERMINALS_ONLY_DIGEST) fail('RECOVERY_GRANT_WRONG_VALUE', 'terminalsOnlyDigest mismatch');
  if (grant.cohort802KeyDigest !== CANONICAL_COHORT_802_KEY_DIGEST) fail('RECOVERY_GRANT_WRONG_VALUE', 'cohort802KeyDigest mismatch');
  if (grant.expectedReservationCount !== 802) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedReservationCount must be 802');
  if (grant.expectedTerminalCount !== 802) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedTerminalCount must be 802');
  if (grant.expectedIncidentOrdinal !== 1) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedIncidentOrdinal must be 1');
  if (grant.expectedCondition !== 'MALFORMED_PROVIDER_RESULT') fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedCondition mismatch');
  if (grant.expectedRetryEligible !== false) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedRetryEligible must be false');
  if (grant.expectedJournalStage !== 'EMPTY') fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedJournalStage must be EMPTY');
  if (grant.expectedRawPinnedCount !== 0) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedRawPinnedCount must be 0');
  if (grant.expectedOrdinal2Count !== 0) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedOrdinal2Count must be 0');
  if (grant.expectedBudgetConsumed !== 802) fail('RECOVERY_GRANT_WRONG_VALUE', 'expectedBudgetConsumed must be 802');
  if (grant.permittedNextOrdinal !== 2) fail('RECOVERY_GRANT_WRONG_VALUE', 'permittedNextOrdinal must be 2');
  if (grant.recoveryImplementationManifestSchemaVersion !== 'TransformImplementationManifest/1') {
    fail('RECOVERY_GRANT_WRONG_VALUE', 'recoveryImplementationManifestSchemaVersion mismatch');
  }
  requireHex64(grant.recoveryImplementationManifestDigest, 'recoveryImplementationManifestDigest');
  requireOid40(grant.implementationCommit, 'implementationCommit');
  requireOid40(grant.implementationTree, 'implementationTree');

  return Object.freeze({ ...grant });
}

/**
 * Strict external Owner recovery-grant parser. No autodiscovery, no default path.
 * @param {{grantPath: string}} options
 */
export function loadOwnerIncidentRecoveryGrantR1(options) {
  if (!isPlainObject(options) || typeof options.grantPath !== 'string' || options.grantPath.length === 0) {
    fail('RECOVERY_GRANT_PATH_REQUIRED', 'recovery grant path must be an explicit Owner-supplied absolute path');
  }
  if (!isAbsolute(options.grantPath)) {
    fail('RECOVERY_GRANT_PATH_UNSAFE', 'recovery grant path must be absolute; autodiscovery is forbidden');
  }
  if (!existsSync(options.grantPath)) {
    fail('ACQUIRER_RECOVERY_GRANT_REQUIRED', 'recovery grant file is absent', { grantPath: options.grantPath });
  }
  const bytes = readFileSync(options.grantPath);
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    fail('RECOVERY_GRANT_WRONG_TYPE', 'recovery grant is not valid JSON', { cause: /** @type {Error} */ (cause)?.message ?? null });
  }
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(parsed);
  const recoveryGrantSha256 = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    grant,
    grantPath: options.grantPath,
    recoveryGrantSha256,
    bytes,
  });
}

/**
 * Compare two already-canonicalized absolute acquisition roots.
 * Callers run P3F assertExternalAcquisitionRootR1 first.
 * @param {string} grantRoot
 * @param {string} presentedRoot
 */
export function assertRecoveryGrantRootEqualsPresentedR1(grantRoot, presentedRoot) {
  const boundCompare = resolve(grantRoot).replaceAll('/', '\\').replace(/[\\/]+$/, '').toLowerCase();
  const presentedCompare = resolve(presentedRoot).replaceAll('/', '\\').replace(/[\\/]+$/, '').toLowerCase();
  if (boundCompare !== presentedCompare) {
    fail('RECOVERY_GRANT_ACQUISITION_ROOT_MISMATCH', 'recovery grant acquisitionRoot does not bind the presented root', {
      grantAcquisitionRoot: grantRoot,
      presentedAcquisitionRoot: presentedRoot,
    });
  }
  return presentedRoot;
}

/** @param {string} gitRoot @param {string[]} args */
function gitText(gitRoot, args) {
  const result = spawnSync('git', args, {
    cwd: gitRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    fail('GIT_BINDING_UNAVAILABLE', 'git command failed to start', { cause: result.error.message, args });
  }
  if (result.status !== 0) {
    fail('GIT_BINDING_FAILED', `git ${args.join(' ')} failed`, {
      status: result.status,
      stderr: result.stderr ?? '',
    });
  }
  return (result.stdout ?? '').replace(/\r\n/g, '\n');
}

/**
 * GIT_CANONICAL_TRACKED_WORKTREE_EQUIVALENCE. Fail closed before EMPTY/provider
 * recovery traversal. Not byte-exact worktree equality.
 * @param {{gitRoot: string, grant: Record<string, any>}} input
 */
export function assertGitCanonicalTrackedWorktreeEquivalenceR1(input) {
  if (!isPlainObject(input)) fail('GIT_BINDING_INPUT_INVALID', 'git binding input is required');
  const gitRoot = input.gitRoot;
  const grant = input.grant;
  if (typeof gitRoot !== 'string' || !isAbsolute(gitRoot)) {
    fail('GIT_BINDING_INPUT_INVALID', 'gitRoot must be an absolute path');
  }
  if (!isPlainObject(grant)) fail('GIT_BINDING_INPUT_INVALID', 'grant is required');

  const head = gitText(gitRoot, ['rev-parse', 'HEAD']).trim();
  const tree = gitText(gitRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  if (head !== grant.implementationCommit) {
    fail('GIT_BINDING_COMMIT_MISMATCH', 'HEAD does not match recovery grant implementationCommit', {
      head, expected: grant.implementationCommit,
    });
  }
  if (tree !== grant.implementationTree) {
    fail('GIT_BINDING_TREE_MISMATCH', 'HEAD^{tree} does not match recovery grant implementationTree', {
      tree, expected: grant.implementationTree,
    });
  }

  const lsFiles = gitText(gitRoot, ['ls-files', '-v']);
  for (const line of lsFiles.split('\n')) {
    if (line.length === 0) continue;
    const tag = line[0];
    if (tag === 'h' || tag === 's' || tag === 'S') {
      fail('GIT_BINDING_MASKED_INDEX', 'assume-unchanged or skip-worktree bit is set on a tracked path', {
        tag, line,
      });
    }
  }

  const cached = gitText(gitRoot, ['diff-index', '--cached', '--name-only', 'HEAD']).trim();
  if (cached.length > 0) {
    fail('GIT_BINDING_INDEX_DIRTY', 'tracked index is not clean', { paths: cached.split('\n') });
  }
  const worktree = gitText(gitRoot, ['diff-index', '--name-only', 'HEAD']).trim();
  if (worktree.length > 0) {
    fail('GIT_BINDING_WORKTREE_DIRTY', 'tracked worktree is not Git-clean', { paths: worktree.split('\n') });
  }

  const porcelain = gitText(gitRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  const unexpected = [];
  for (const line of porcelain.split('\n')) {
    if (line.length === 0) continue;
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus !== ' ' && indexStatus !== '?' && indexStatus !== '!') {
      fail('GIT_BINDING_INDEX_DIRTY', 'porcelain shows a tracked index mutation', { line });
    }
    if (worktreeStatus === 'M' || worktreeStatus === 'D' || worktreeStatus === 'T') {
      fail('GIT_BINDING_WORKTREE_DIRTY', 'porcelain shows a tracked worktree mutation', { line });
    }
    if (line.startsWith('??')) {
      const path = line.slice(3).replaceAll('\\', '/');
      if (!ADMITTED_UNTRACKED_PATHS.includes(path)) unexpected.push(path);
    }
  }
  if (unexpected.length > 0) {
    fail('GIT_BINDING_UNEXPECTED_UNTRACKED', 'untracked path is not in the canonically admitted set', {
      unexpected,
      admitted: [...ADMITTED_UNTRACKED_PATHS],
    });
  }
  return Object.freeze({
    name: GIT_BINDING_NAME,
    head,
    tree,
    passed: true,
  });
}

/**
 * @param {{relPath: unknown, sha256: unknown, byteLength: unknown}} value
 * @param {string} field
 */
function assertFileRef(value, field) {
  if (!isPlainObject(value)) fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field} must be a plain object`);
  const extra = Object.keys(value).filter((key) => !CLOSED_FILE_REF_FIELDS.includes(key));
  if (extra.length > 0) fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field} unknown field ${extra[0]}`);
  for (const key of CLOSED_FILE_REF_FIELDS) {
    if (!Object.hasOwn(value, key)) fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field}.${key} is required`);
  }
  if (typeof value.relPath !== 'string' || value.relPath.includes('\\') || !value.relPath.startsWith('reservations/')) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field}.relPath must be POSIX reservations/...`);
  }
  if (typeof value.sha256 !== 'string' || !HEX64.test(value.sha256)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field}.sha256 must be 64 hex`);
  }
  if (typeof value.byteLength !== 'number' || !Number.isInteger(value.byteLength) || value.byteLength < 0) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field}.byteLength must be a non-negative integer`);
  }
}

/**
 * Re-read a current ordinal1 reservation/terminal and require exact equality
 * with the provenance pin. Missing, mutated, wrong-length, wrong-SHA,
 * wrong-key, wrong-ordinal or malformed files fail closed.
 * @param {string} acquisitionRoot
 * @param {{relPath: string, sha256: string, byteLength: number}} pin
 * @param {string} acquisitionKey
 * @param {'reservation'|'terminal'} kind
 */
function revalidateOrdinal1ProvenancePinR1(acquisitionRoot, pin, acquisitionKey, kind) {
  const expectedRel = ordinal1EvidenceRelPathR1(acquisitionKey, kind);
  if (pin.relPath !== expectedRel) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${kind} relPath does not match acquisitionKey`, {
      expected: expectedRel, actual: pin.relPath,
    });
  }
  const filePath = resolve(acquisitionRoot, ...pin.relPath.split('/'));
  if (!existsSync(filePath)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} is missing`, {
      relPath: pin.relPath,
    });
  }
  const current = rawFileDigestR1(filePath);
  if (current.byteLength !== pin.byteLength) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} byteLength mismatch`, {
      relPath: pin.relPath, expected: pin.byteLength, actual: current.byteLength,
    });
  }
  if (current.sha256 !== pin.sha256) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} sha256 mismatch`, {
      relPath: pin.relPath, expected: pin.sha256, actual: current.sha256,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(current.bytes.toString('utf8'));
  } catch {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} is malformed`, {
      relPath: pin.relPath,
    });
  }
  if (!isPlainObject(parsed)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} is malformed`, {
      relPath: pin.relPath,
    });
  }
  if (parsed.acquisitionKey !== acquisitionKey) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} acquisitionKey mismatch`, {
      relPath: pin.relPath,
    });
  }
  if (parsed.attemptOrdinal !== 1) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `referenced ordinal1 ${kind} ordinal mismatch`, {
      relPath: pin.relPath, actual: parsed.attemptOrdinal,
    });
  }
}

/**
 * Ordinal2 provenance is evidence, never authority.
 * Schema, cross-invariants, AND current byte/SHA revalidation of the referenced
 * ordinal1 reservation and terminal. A stale pin must not authorize ordinal3.
 * @param {unknown} value
 * @param {{acquisitionKey: string, acquisitionRoot: string, grant?: Record<string, any>|null, recoveryGrantSha256?: string|null}} context
 */
export function validateOrdinal2RecoveryProvenanceR1(value, context) {
  if (!isPlainObject(value)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'recoveryProvenance must be a plain object');
  }
  const provenance = /** @type {Record<string, unknown>} */ (value);
  const extra = Object.keys(provenance).filter((field) => !CLOSED_PROVENANCE_FIELDS.includes(field));
  if (extra.length > 0) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `unknown field ${extra[0]}`);
  }
  for (const field of CLOSED_PROVENANCE_FIELDS) {
    if (!Object.hasOwn(provenance, field)) {
      fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', `${field} is required`);
    }
  }
  if (provenance.schemaVersion !== RECOVERY_PROVENANCE_SCHEMA_VERSION) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'schemaVersion mismatch');
  }
  if (provenance.mechanism !== RECOVERY_MECHANISM) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'mechanism mismatch');
  }
  if (provenance.incidentRecoveryId !== INCIDENT_RECOVERY_ID) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'incidentRecoveryId mismatch');
  }
  if (typeof provenance.recoveryGrantId !== 'string' || provenance.recoveryGrantId.length === 0) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'recoveryGrantId must be a non-empty string');
  }
  if (typeof provenance.recoveryGrantSha256 !== 'string' || !HEX64.test(provenance.recoveryGrantSha256)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'recoveryGrantSha256 must be 64 hex');
  }
  if (provenance.recoveryImplementationManifestSchemaVersion !== 'TransformImplementationManifest/1') {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'manifest schema mismatch');
  }
  if (typeof provenance.recoveryImplementationManifestDigest !== 'string' || !HEX64.test(provenance.recoveryImplementationManifestDigest)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'manifest digest must be 64 hex');
  }
  if (provenance.preparedAuthoritySha256 !== CANONICAL_PREPARED_AUTHORITY_SHA256) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'preparedAuthoritySha256 mismatch');
  }
  if (provenance.incidentEvidenceDigest !== CANONICAL_INCIDENT_EVIDENCE_DIGEST) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'incidentEvidenceDigest mismatch');
  }
  if (provenance.cohort802KeyDigest !== CANONICAL_COHORT_802_KEY_DIGEST) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'cohort802KeyDigest mismatch');
  }
  if (provenance.acquisitionKey !== context.acquisitionKey) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'acquisitionKey mismatch');
  }
  if (provenance.attemptOrdinal !== 2) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'attemptOrdinal must be 2');
  }
  if (provenance.permittedFromIncidentOrdinal !== 1) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'permittedFromIncidentOrdinal must be 1');
  }
  assertFileRef(provenance.ordinal1Reservation, 'ordinal1Reservation');
  assertFileRef(provenance.ordinal1Terminal, 'ordinal1Terminal');

  if (context.grant) {
    if (provenance.recoveryGrantId !== context.grant.grantId) {
      fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'recoveryGrantId does not match live grant');
    }
    if (typeof context.recoveryGrantSha256 === 'string' && provenance.recoveryGrantSha256 !== context.recoveryGrantSha256) {
      fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'recoveryGrantSha256 does not match live grant bytes');
    }
    if (provenance.recoveryImplementationManifestDigest !== context.grant.recoveryImplementationManifestDigest) {
      fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'manifest digest does not match live grant');
    }
  }

  if (typeof context?.acquisitionRoot !== 'string' || context.acquisitionRoot.length === 0 || !isAbsolute(context.acquisitionRoot)) {
    fail('ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID', 'acquisitionRoot is required to revalidate ordinal1 pins');
  }
  revalidateOrdinal1ProvenancePinR1(
    context.acquisitionRoot,
    /** @type {{relPath: string, sha256: string, byteLength: number}} */ (provenance.ordinal1Reservation),
    context.acquisitionKey,
    'reservation',
  );
  revalidateOrdinal1ProvenancePinR1(
    context.acquisitionRoot,
    /** @type {{relPath: string, sha256: string, byteLength: number}} */ (provenance.ordinal1Terminal),
    context.acquisitionKey,
    'terminal',
  );
  return provenance;
}

/**
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 * @param {'reservation'|'terminal'} kind
 */
export function ordinal1EvidenceRelPathR1(acquisitionKey, kind) {
  const hex = recoveryReservationDirectoryNameR1(acquisitionKey);
  return kind === 'reservation'
    ? `reservations/${hex}/1.json`
    : `reservations/${hex}/1.terminal.json`;
}

/**
 * @param {string} filePath
 */
export function rawFileDigestR1(filePath) {
  const bytes = readFileSync(filePath);
  return Object.freeze({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    bytes,
  });
}

/**
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 */
export function snapshotOrdinal1EvidenceR1(acquisitionRoot, acquisitionKey) {
  const reservationRel = ordinal1EvidenceRelPathR1(acquisitionKey, 'reservation');
  const terminalRel = ordinal1EvidenceRelPathR1(acquisitionKey, 'terminal');
  const reservationPath = resolve(acquisitionRoot, ...reservationRel.split('/'));
  const terminalPath = resolve(acquisitionRoot, ...terminalRel.split('/'));
  if (!existsSync(reservationPath) || !existsSync(terminalPath)) {
    fail('ACQUIRER_ORDINAL1_EVIDENCE_ABSENT', 'ordinal1 reservation and terminal must both exist for snapshot');
  }
  const reservation = rawFileDigestR1(reservationPath);
  const terminal = rawFileDigestR1(terminalPath);
  return Object.freeze({
    reservation: Object.freeze({ relPath: reservationRel, sha256: reservation.sha256, byteLength: reservation.byteLength }),
    terminal: Object.freeze({ relPath: terminalRel, sha256: terminal.sha256, byteLength: terminal.byteLength }),
  });
}

/**
 * Byte-exact TOCTOU compare against an immutable snapshot. Does not update the table.
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 * @param {{reservation: {relPath: string, sha256: string, byteLength: number}, terminal: {relPath: string, sha256: string, byteLength: number}}} snapshot
 */
export function assertOrdinal1EvidenceUnchangedR1(acquisitionRoot, acquisitionKey, snapshot) {
  const current = snapshotOrdinal1EvidenceR1(acquisitionRoot, acquisitionKey);
  if (
    current.reservation.sha256 !== snapshot.reservation.sha256
    || current.reservation.byteLength !== snapshot.reservation.byteLength
    || current.reservation.relPath !== snapshot.reservation.relPath
    || current.terminal.sha256 !== snapshot.terminal.sha256
    || current.terminal.byteLength !== snapshot.terminal.byteLength
    || current.terminal.relPath !== snapshot.terminal.relPath
  ) {
    fail('ACQUIRER_ORDINAL1_EVIDENCE_TOCTOU', 'ordinal1 evidence bytes changed since snapshot', {
      acquisitionKey, expected: snapshot, actual: current,
    });
  }
  return current;
}

/**
 * CanonicalJSON/1 cohort digest of the 802 plan keys. Grant stores 64 hex without prefix.
 * @param {Iterable<string>} acquisitionKeys
 */
export function computeCohort802KeyDigestR1(acquisitionKeys) {
  const keys = [...acquisitionKeys];
  if (keys.length !== 802) fail('COHORT_DIGEST_INVALID', 'cohort digest requires exactly 802 keys', { actual: keys.length });
  const unique = new Set(keys);
  if (unique.size !== 802) fail('COHORT_DIGEST_INVALID', 'cohort digest requires 802 unique keys');
  const acquisitionKeysSorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const envelope = {
    schemaVersion: DIGEST_ALGORITHM_IDS.cohort802KeyDigest,
    digestAlgorithmId: DIGEST_ALGORITHM_IDS.cohort802KeyDigest,
    expectedKeyCount: 802,
    acquisitionKeys: acquisitionKeysSorted,
  };
  return stripSha256PrefixOnceR1(canonicalHash(DIGEST_ALGORITHM_IDS.cohort802KeyDigest, envelope));
}

/**
 * @param {{acquisitionRoot: string, acquisitionKeys: Iterable<string>, mode: 'evidence'|'reservations'|'terminals'}} input
 */
export function computeOrdinal1IncidentDigestR1(input) {
  const keys = [...input.acquisitionKeys];
  if (keys.length !== 802) fail('INCIDENT_DIGEST_INVALID', 'ordinal1 digest requires exactly 802 keys');
  /** @type {{relPath: string, sha256: string, byteLength: number}[]} */
  const entries = [];
  for (const acquisitionKey of keys) {
    const hex = recoveryReservationDirectoryNameR1(acquisitionKey);
    const includeReservation = input.mode === 'evidence' || input.mode === 'reservations';
    const includeTerminal = input.mode === 'evidence' || input.mode === 'terminals';
    if (includeReservation) {
      const relPath = `reservations/${hex}/1.json`;
      const filePath = resolve(input.acquisitionRoot, ...relPath.split('/'));
      if (!existsSync(filePath)) fail('INCIDENT_DIGEST_INVALID', `missing ${relPath}`);
      const digest = rawFileDigestR1(filePath);
      entries.push({ relPath, sha256: digest.sha256, byteLength: digest.byteLength });
    }
    if (includeTerminal) {
      const relPath = `reservations/${hex}/1.terminal.json`;
      const filePath = resolve(input.acquisitionRoot, ...relPath.split('/'));
      if (!existsSync(filePath)) fail('INCIDENT_DIGEST_INVALID', `missing ${relPath}`);
      const digest = rawFileDigestR1(filePath);
      entries.push({ relPath, sha256: digest.sha256, byteLength: digest.byteLength });
    }
  }
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const algorithmId = input.mode === 'evidence'
    ? DIGEST_ALGORITHM_IDS.incidentEvidenceDigest
    : input.mode === 'reservations'
      ? DIGEST_ALGORITHM_IDS.reservationsOnlyDigest
      : DIGEST_ALGORITHM_IDS.terminalsOnlyDigest;
  const envelope = {
    schemaVersion: algorithmId,
    digestAlgorithmId: algorithmId,
    expectedIncidentOrdinal: 1,
    entryCount: entries.length,
    entries,
  };
  return stripSha256PrefixOnceR1(canonicalHash(algorithmId, envelope));
}

/**
 * @param {string} filePath
 * @param {string} acquisitionKey
 * @param {1} expectedOrdinal
 */
function readPlainJsonObjectOrFailIncident(filePath, acquisitionKey, field) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    fail('INCIDENT_ROOT_INVALID', `${field} is malformed`, { acquisitionKey, filePath });
  }
  if (!isPlainObject(parsed)) {
    fail('INCIDENT_ROOT_INVALID', `${field} is malformed`, { acquisitionKey, filePath });
  }
  return parsed;
}

/**
 * Prove the CURRENT durable ordinal1 incident matches the Owner-bound grant.
 * Uses the canonical digest algorithms only. Does not mutate the incident root.
 * @param {{
 *   acquisitionRoot: string,
 *   grant: Record<string, any>,
 *   acquisitionKeys: Iterable<string>,
 * }} input
 */
export function assertCurrentIncidentRootMatchesGrantR1(input) {
  if (!isPlainObject(input)) fail('INCIDENT_ROOT_INVALID', 'incident root validation input is required');
  const acquisitionRoot = input.acquisitionRoot;
  const grant = input.grant;
  if (typeof acquisitionRoot !== 'string' || acquisitionRoot.length === 0 || !isAbsolute(acquisitionRoot)) {
    fail('INCIDENT_ROOT_INVALID', 'acquisitionRoot must be an absolute path');
  }
  if (!isPlainObject(grant)) fail('INCIDENT_ROOT_INVALID', 'recovery grant is required');

  const keys = [...(input.acquisitionKeys ?? [])];
  if (keys.length !== 802) {
    fail('INCIDENT_ROOT_INVALID', 'incident cohort must be exactly 802 keys', { actual: keys.length });
  }
  const unique = new Set(keys);
  if (unique.size !== 802) {
    fail('INCIDENT_ROOT_INVALID', 'incident cohort requires 802 unique keys', { actual: unique.size });
  }

  const cohortDigest = computeCohort802KeyDigestR1(keys);
  if (cohortDigest !== grant.cohort802KeyDigest || cohortDigest !== CANONICAL_COHORT_802_KEY_DIGEST) {
    fail('INCIDENT_ROOT_INVALID', 'current 802-key cohort digest does not match the grant-bound canonical incident', {
      actual: cohortDigest, expected: grant.cohort802KeyDigest,
    });
  }

  const expectedReservationRels = new Set();
  const expectedTerminalRels = new Set();
  let reservationCount = 0;
  let terminalCount = 0;

  for (const acquisitionKey of keys) {
    const reservationRel = ordinal1EvidenceRelPathR1(acquisitionKey, 'reservation');
    const terminalRel = ordinal1EvidenceRelPathR1(acquisitionKey, 'terminal');
    expectedReservationRels.add(reservationRel);
    expectedTerminalRels.add(terminalRel);
    const reservationPath = resolve(acquisitionRoot, ...reservationRel.split('/'));
    const terminalPath = resolve(acquisitionRoot, ...terminalRel.split('/'));
    if (!existsSync(reservationPath)) {
      fail('INCIDENT_ROOT_INVALID', 'required ordinal1 reservation is missing', { acquisitionKey, relPath: reservationRel });
    }
    if (!existsSync(terminalPath)) {
      fail('INCIDENT_ROOT_INVALID', 'required ordinal1 terminal is missing', { acquisitionKey, relPath: terminalRel });
    }

    const reservation = readPlainJsonObjectOrFailIncident(reservationPath, acquisitionKey, 'ordinal1 reservation');
    if (reservation.acquisitionKey !== acquisitionKey) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 reservation acquisitionKey mismatch', { acquisitionKey });
    }
    if (reservation.attemptOrdinal !== grant.expectedIncidentOrdinal || reservation.attemptOrdinal !== 1) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 reservation ordinal mismatch', { acquisitionKey, actual: reservation.attemptOrdinal });
    }
    if (reservation.attemptState !== 'IN_FLIGHT') {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 reservation state mismatch', { acquisitionKey, actual: reservation.attemptState });
    }

    const terminal = readPlainJsonObjectOrFailIncident(terminalPath, acquisitionKey, 'ordinal1 terminal');
    if (terminal.acquisitionKey !== acquisitionKey) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal acquisitionKey mismatch', { acquisitionKey });
    }
    if (terminal.attemptOrdinal !== grant.expectedIncidentOrdinal || terminal.attemptOrdinal !== 1) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal ordinal mismatch', { acquisitionKey, actual: terminal.attemptOrdinal });
    }
    if (terminal.attemptState !== 'FAILED_TERMINAL') {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal state mismatch', { acquisitionKey, actual: terminal.attemptState });
    }
    if (terminal.condition !== grant.expectedCondition) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal condition mismatch', { acquisitionKey, actual: terminal.condition });
    }
    if (terminal.retryEligible !== grant.expectedRetryEligible) {
      fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal retryEligible mismatch', { acquisitionKey, actual: terminal.retryEligible });
    }
    reservationCount += 1;
    terminalCount += 1;
  }

  const reservationsRoot = resolve(acquisitionRoot, 'reservations');
  if (existsSync(reservationsRoot)) {
    for (const dirent of readdirSync(reservationsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const reservationRel = `reservations/${dirent.name}/1.json`;
      const terminalRel = `reservations/${dirent.name}/1.terminal.json`;
      const hasReservation = existsSync(join(reservationsRoot, dirent.name, '1.json'));
      const hasTerminal = existsSync(join(reservationsRoot, dirent.name, '1.terminal.json'));
      if (hasReservation && !expectedReservationRels.has(reservationRel)) {
        fail('INCIDENT_ROOT_INVALID', 'unexpected ordinal1 reservation exists', { relPath: reservationRel });
      }
      if (hasTerminal && !expectedTerminalRels.has(terminalRel)) {
        fail('INCIDENT_ROOT_INVALID', 'unexpected ordinal1 terminal exists', { relPath: terminalRel });
      }
      if ((hasReservation || hasTerminal) && !/^[0-9a-f]{64}$/.test(dirent.name)) {
        fail('INCIDENT_ROOT_INVALID', 'malformed ordinal1 directory name', { directory: dirent.name });
      }
    }
  }

  if (reservationCount !== grant.expectedReservationCount || reservationCount !== 802) {
    fail('INCIDENT_ROOT_INVALID', 'ordinal1 reservation count does not match the grant-bound incident snapshot', {
      actual: reservationCount, expected: grant.expectedReservationCount,
    });
  }
  if (terminalCount !== grant.expectedTerminalCount || terminalCount !== 802) {
    fail('INCIDENT_ROOT_INVALID', 'ordinal1 terminal count does not match the grant-bound incident snapshot', {
      actual: terminalCount, expected: grant.expectedTerminalCount,
    });
  }

  const evidenceDigest = computeOrdinal1IncidentDigestR1({
    acquisitionRoot, acquisitionKeys: keys, mode: 'evidence',
  });
  const reservationsDigest = computeOrdinal1IncidentDigestR1({
    acquisitionRoot, acquisitionKeys: keys, mode: 'reservations',
  });
  const terminalsDigest = computeOrdinal1IncidentDigestR1({
    acquisitionRoot, acquisitionKeys: keys, mode: 'terminals',
  });

  if (evidenceDigest !== grant.incidentEvidenceDigest || evidenceDigest !== CANONICAL_INCIDENT_EVIDENCE_DIGEST) {
    fail('INCIDENT_ROOT_INVALID', 'incident evidence digest does not match the grant-bound canonical incident', {
      actual: evidenceDigest, expected: grant.incidentEvidenceDigest,
    });
  }
  if (reservationsDigest !== grant.reservationsOnlyDigest || reservationsDigest !== CANONICAL_RESERVATIONS_ONLY_DIGEST) {
    fail('INCIDENT_ROOT_INVALID', 'reservations-only digest does not match the grant-bound canonical incident', {
      actual: reservationsDigest, expected: grant.reservationsOnlyDigest,
    });
  }
  if (terminalsDigest !== grant.terminalsOnlyDigest || terminalsDigest !== CANONICAL_TERMINALS_ONLY_DIGEST) {
    fail('INCIDENT_ROOT_INVALID', 'terminals-only digest does not match the grant-bound canonical incident', {
      actual: terminalsDigest, expected: grant.terminalsOnlyDigest,
    });
  }

  return Object.freeze({
    passed: true,
    reservationCount,
    terminalCount,
    cohort802KeyDigest: cohortDigest,
    incidentEvidenceDigest: evidenceDigest,
    reservationsOnlyDigest: reservationsDigest,
    terminalsOnlyDigest: terminalsDigest,
  });
}

export function posixRelPathFromMaybeWindowsR1(value) {
  if (typeof value !== 'string') return value;
  return value.replaceAll('\\', '/');
}

/** @param {string} directory */
export function listLegalReservationOrdinalFilesR1(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory).filter((name) => /^(?:1|2|3)\.json$/.test(name));
}

export { join };
