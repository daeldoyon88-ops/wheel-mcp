/**
 * Bounded Yahoo FETCH_ONCE acquirer for the P3 historical plane.
 *
 * The acquirer is the only P3 component that may ever touch the network. Reaching
 * the provider factory — let alone chart() — requires one coherent durable path:
 * the query key is one of the exact 802 planned keys, an Owner-supplied
 * EXPLICIT_MISSION_GRANT is valid, the persistence journal is still EMPTY, the
 * per-key durable attempt budget remains, the durable reservation cardinality is
 * still within 2406, no same-key attempt is IN_FLIGHT, ordinal N+1 is authorized
 * only by a durable retryable/abandoned terminal of ordinal N, and a write-once
 * reservation file has been committed under the external acquisition root with
 * exclusive create, write, fsync and close.
 *
 * Attempt accounting lives on disk, never in process memory. A restart cannot
 * reset the budget. A crash after the reservation file exists spends the
 * attempt; nothing refunds it. A fourth attempt is never named on disk.
 *
 * The provider client is injected. Nothing here imports yahoo-finance2 at
 * module scope, so importing this module cannot open a socket.
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalProviderResultBytesR1 } from './jarviseYahooChartAdapterR1.mjs';

export const JARVISE_YAHOO_FETCH_ONCE_ACQUIRER_VERSION = 'jarviseYahooFetchOnceAcquirerR1/1';
export const ATTEMPT_RESERVATION_SCHEMA_VERSION = 'JarviseYahooFetchOnceAttemptReservation/1';
export const ATTEMPT_TERMINAL_SCHEMA_VERSION = 'JarviseYahooFetchOnceAttemptTerminal/1';

export const ATTEMPT_STATE_IN_FLIGHT = 'IN_FLIGHT';
export const ATTEMPT_STATE_FAILED_RETRYABLE = 'FAILED_RETRYABLE';
export const ATTEMPT_STATE_FAILED_TERMINAL = 'FAILED_TERMINAL';
export const ATTEMPT_STATE_ABANDONED = 'ABANDONED';

export const STRUCTURAL_LOGICAL_ACQUISITION_KEY_COUNT = 802;
export const STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY = 3;
export const STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT = 2406;

/** Only these three conditions may ever be retried. */
export const RETRY_ELIGIBLE_CONDITIONS = Object.freeze(['TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_SERVER_ERROR']);

export const RETRY_INELIGIBLE_CONDITIONS = Object.freeze([
  'MALFORMED_PROVIDER_RESULT',
  'EMPTY_PROVIDER_RESULT',
  'DIGEST_DIVERGENCE',
  'CAS_DIVERGENCE',
  'SCHEMA_FAILURE',
  'AUTHORIZATION_FAILURE',
]);

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
const LEGAL_ATTEMPT_ORDINALS = Object.freeze([1, 2, 3]);
const PINNED_OR_LATER = new Set(['RAW_PINNED', 'NORMALIZED', 'VERSION_CACHED']);

export class JarviseAcquirerError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseAcquirerError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseAcquirerError(code, message, details);
}

/** @param {unknown} value */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {string} target */
function realpathNative(target) {
  const impl = typeof realpathSync.native === 'function' ? realpathSync.native : realpathSync;
  return impl(target);
}

/** @param {string} value */
function normalizePathForCompare(value) {
  return resolve(value).replaceAll('/', '\\').replace(/[\\/]+$/, '').toLowerCase();
}

/** @param {string} candidate @param {string} root */
function isPathEqualOrInside(candidate, root) {
  const left = normalizePathForCompare(candidate);
  const right = normalizePathForCompare(root);
  return left === right || left.startsWith(`${right}\\`);
}

/**
 * Physical destination of an acquisition root: realpath the deepest existing
 * ancestor, then reconstruct the missing suffix onto that physical base.
 * Must run before any acquisition mkdir/write.
 * @param {string} lexical
 */
function physicalAcquisitionDestination(lexical) {
  const missingSuffix = [];
  let cursor = lexical;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      fail('ACQUISITION_ROOT_UNRESOLVED', 'acquisitionRoot has no existing ancestor', { acquisitionRoot: lexical });
    }
    missingSuffix.push(basename(cursor));
    cursor = parent;
  }
  missingSuffix.reverse();
  let ancestorReal;
  try {
    ancestorReal = realpathNative(cursor);
  } catch (cause) {
    fail('ACQUISITION_ROOT_UNRESOLVED', 'existing ancestor of acquisitionRoot cannot be resolved', {
      acquisitionRoot: lexical,
      ancestor: cursor,
      cause: /** @type {Error} */ (cause)?.message ?? null,
    });
  }
  const physical = missingSuffix.length === 0 ? ancestorReal : resolve(ancestorReal, ...missingSuffix);
  return { ancestor: cursor, ancestorReal, physical, missingSuffix };
}

/**
 * Refuse an acquisition root that is relative, unresolved, or whose physical
 * destination is equal to / inside the governed repository. Must run before
 * any reservation directory is created.
 * @param {unknown} acquisitionRoot
 * @param {unknown} gitRoot
 */
export function assertExternalAcquisitionRootR1(acquisitionRoot, gitRoot) {
  if (typeof gitRoot !== 'string' || gitRoot.length === 0 || !isAbsolute(gitRoot)) {
    fail('ACQUISITION_ROOT_UNSAFE', 'gitRoot must be an absolute path');
  }
  if (typeof acquisitionRoot !== 'string' || acquisitionRoot.length === 0) {
    fail('ACQUISITION_ROOT_REQUIRED', 'acquisitionRoot is required');
  }
  if (acquisitionRoot.includes('\0') || gitRoot.includes('\0')) {
    fail('ACQUISITION_ROOT_UNSAFE', 'acquisitionRoot contains unsafe bytes');
  }
  if (!isAbsolute(acquisitionRoot)) {
    fail('ACQUISITION_ROOT_NOT_ABSOLUTE', 'acquisitionRoot must be an absolute path outside the governed repository');
  }
  if (acquisitionRoot.split(/[/\\]/).includes('..')) {
    fail('ACQUISITION_ROOT_UNSAFE', 'acquisitionRoot must not contain parent-directory segments');
  }

  let gitReal;
  try {
    gitReal = realpathNative(gitRoot);
  } catch (cause) {
    fail('ACQUISITION_ROOT_UNSAFE', 'gitRoot cannot be resolved', { cause: /** @type {Error} */ (cause)?.message ?? null });
  }

  const lexical = resolve(acquisitionRoot);
  if (isPathEqualOrInside(lexical, gitReal)) {
    fail('ACQUISITION_ROOT_INSIDE_REPOSITORY', 'acquisitionRoot must resolve outside the governed repository', {
      acquisitionRoot: lexical, gitRoot: gitReal,
    });
  }

  const destination = physicalAcquisitionDestination(lexical);
  if (isPathEqualOrInside(destination.ancestorReal, gitReal) || isPathEqualOrInside(destination.physical, gitReal)) {
    fail('ACQUISITION_ROOT_INSIDE_REPOSITORY', 'physical acquisition destination is inside the governed repository', {
      acquisitionRoot: lexical,
      ancestorReal: destination.ancestorReal,
      physicalDestination: destination.physical,
      gitRoot: gitReal,
    });
  }
  const rel = relative(gitReal, destination.physical);
  if (rel === '' || !(rel.startsWith(`..${sep}`) || rel === '..')) {
    fail('ACQUISITION_ROOT_INSIDE_REPOSITORY', 'physical acquisition destination is not strictly outside gitRoot', {
      acquisitionRoot: destination.physical, gitRoot: gitReal,
    });
  }
  return lexical;
}

/** @param {unknown} error */
export function classifyAcquisitionFailureR1(error) {
  const candidate = /** @type {any} */ (error);
  const status = Number(candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status ?? NaN);
  const code = typeof candidate?.code === 'string' ? candidate.code : null;
  const name = typeof candidate?.name === 'string' ? candidate.name : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : '';

  if (status === 429) return { condition: 'PROVIDER_RATE_LIMITED', retryEligible: true };
  if (Number.isFinite(status) && status >= 500 && status <= 599) {
    return { condition: 'PROVIDER_SERVER_ERROR', retryEligible: true };
  }
  if ((code !== null && TIMEOUT_CODES.has(code)) || name === 'AbortError' || /timed?\s*out/i.test(message)) {
    return { condition: 'TIMEOUT', retryEligible: true };
  }
  if (Number.isFinite(status) && status >= 400 && status <= 499) {
    return { condition: 'SCHEMA_FAILURE', retryEligible: false };
  }
  if (candidate?.name === 'JarviseYahooChartAdapterError') {
    const adapterCode = String(candidate.code ?? '');
    if (adapterCode === 'PROVIDER_RESULT_EMPTY') return { condition: 'EMPTY_PROVIDER_RESULT', retryEligible: false };
    return { condition: 'MALFORMED_PROVIDER_RESULT', retryEligible: false };
  }
  return { condition: 'MALFORMED_PROVIDER_RESULT', retryEligible: false };
}

/**
/**
 * Physical compare-key for an already-validated acquisition root. Reuses the
 * existing destination reconstruction; does not mkdir.
 * @param {string} lexical
 */
function canonicalPhysicalAcquisitionRootIdentity(lexical) {
  const destination = physicalAcquisitionDestination(lexical);
  return {
    lexical,
    physical: destination.physical,
    compareKey: normalizePathForCompare(destination.physical),
  };
}

/**
 * Validate and canonicalize an acquisition root against gitRoot using the
 * existing external-root path algebra. Does not mkdir.
 * @param {unknown} acquisitionRoot
 * @param {unknown} gitRoot
 */
function canonicalizePresentedAcquisitionRoot(acquisitionRoot, gitRoot) {
  const lexical = assertExternalAcquisitionRootR1(acquisitionRoot, gitRoot);
  return canonicalPhysicalAcquisitionRootIdentity(lexical);
}

/**
 * After prepared SHA and authorization booleans pass, bind grant.acquisitionRoot
 * to the presented CLI/acquirer root. Unknown extra grant fields are ignored.
 * @param {Record<string, any>} executionGrant
 * @param {{root?: string, gitRoot?: string, acquisitionRoot?: unknown}} options
 */
function bindActivatingGrantAcquisitionRoot(executionGrant, options) {
  const grantRoot = executionGrant.acquisitionRoot;
  if (grantRoot === undefined || grantRoot === null || grantRoot === '') {
    fail('EXECUTION_GRANT_ACQUISITION_ROOT_REQUIRED', 'activating grant must bind acquisitionRoot');
  }
  const gitRoot = options.gitRoot ?? options.root ?? REPOSITORY_ROOT;
  const bound = canonicalizePresentedAcquisitionRoot(grantRoot, gitRoot);
  const presentedRoot = options.acquisitionRoot;
  if (presentedRoot === undefined || presentedRoot === null || presentedRoot === '') {
    fail('EXECUTION_GRANT_ACQUISITION_ROOT_REQUIRED', 'presented acquisitionRoot is required to bind an activating grant');
  }
  const presented = canonicalizePresentedAcquisitionRoot(presentedRoot, gitRoot);
  if (bound.compareKey !== presented.compareKey) {
    fail('EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH', 'grant acquisitionRoot does not bind the presented acquisitionRoot', {
      grantAcquisitionRoot: bound.lexical,
      presentedAcquisitionRoot: presented.lexical,
      grantPhysical: bound.physical,
      presentedPhysical: presented.physical,
    });
  }
  return bound;
}

/**
 * Defense in depth: an activated authority may not be used against another root.
 * In-repo / malformed presented roots still fail with ACQUISITION_ROOT_*.
 * @param {Record<string, any>} authority
 * @param {unknown} acquisitionRoot
 * @param {unknown} gitRoot
 */
function assertActivatedAuthorityBoundToAcquisitionRoot(authority, acquisitionRoot, gitRoot) {
  if (authority.activated !== true) return;
  if (typeof authority.boundAcquisitionRoot !== 'string' || authority.boundAcquisitionRoot.length === 0) {
    fail('EXECUTION_GRANT_ACQUISITION_ROOT_REQUIRED', 'activated authority must bind acquisitionRoot');
  }
  const presented = canonicalizePresentedAcquisitionRoot(acquisitionRoot, gitRoot);
  const bound = canonicalizePresentedAcquisitionRoot(authority.boundAcquisitionRoot, gitRoot);
  if (presented.compareKey !== bound.compareKey) {
    fail('EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH', 'activated authority is bound to a different acquisitionRoot', {
      boundAcquisitionRoot: bound.lexical,
      presentedAcquisitionRoot: presented.lexical,
      boundPhysical: bound.physical,
      presentedPhysical: presented.physical,
    });
  }
}

/**
 * Resolve the authority the persistence surface will actually see.
 *
 * With no Owner-supplied EXPLICIT_MISSION_GRANT the prepared bounds are returned
 * with network still denied. P3 never creates or self-issues that grant.
 * An activating grant must bind acquisitionRoot to the presented root after
 * prepared SHA and authorization booleans pass.
 * @param {{root?: string, gitRoot?: string, acquisitionRoot?: unknown, preparedAuthority?: Record<string, any>, executionGrant?: Record<string, any>|null}} [options]
 */
export function resolveEffectiveAcquisitionAuthorityR1(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT;
  if (!isAbsolute(root)) fail('ACQUIRER_INPUT_INVALID', 'root must be an absolute path');
  const preparedPath = resolve(root, 'app/jarvise/jarviseFetchOnceExecutionAuthorityR1.json');
  const preparedBytes = readFileSync(preparedPath);
  const prepared = options.preparedAuthority ?? JSON.parse(preparedBytes.toString('utf8'));
  const preparedSha256 = createHash('sha256').update(preparedBytes).digest('hex');

  if (prepared.authorityState !== 'PREPARED_NOT_EXECUTABLE') {
    fail('AUTHORITY_STATE_INVALID', 'prepared authority must publish authorityState PREPARED_NOT_EXECUTABLE');
  }
  if (prepared.executionAuthorized !== false || prepared.networkAuthorized !== false) {
    fail('AUTHORITY_STATE_INVALID', 'prepared authority must publish execution and network as false');
  }
  if (prepared.executionAuthorization?.mechanism !== 'EXPLICIT_MISSION_GRANT') {
    fail('AUTHORITY_STATE_INVALID', 'prepared authority must bind execution authorization to EXPLICIT_MISSION_GRANT');
  }

  const executionGrant = options.executionGrant === undefined ? null : options.executionGrant;
  if (executionGrant === null) {
    return Object.freeze({
      authorityId: prepared.authorityId,
      executionAuthorized: false,
      networkAuthorized: false,
      activated: false,
      reasonCode: 'OWNER_MISSION_GRANT_ABSENT',
      grant: Object.freeze({ ...prepared.preparedGrant }),
      preparedSha256,
      boundAcquisitionRoot: null,
    });
  }

  if (!isPlainObject(executionGrant)) fail('EXECUTION_GRANT_INVALID', 'executionGrant must be a plain object');
  if (executionGrant.mechanism !== 'EXPLICIT_MISSION_GRANT') {
    fail('EXECUTION_GRANT_INVALID', 'executionGrant.mechanism must be EXPLICIT_MISSION_GRANT');
  }
  if (
    executionGrant.decisionType !== undefined
    && executionGrant.decisionType !== 'PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION'
  ) {
    fail('EXECUTION_GRANT_INVALID', 'optional durable Owner record must be PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION');
  }
  if (executionGrant.preparedAuthoritySha256 !== preparedSha256) {
    fail('EXECUTION_GRANT_BINDING_MISMATCH', 'execution grant is bound to different prepared authority bytes', {
      expected: preparedSha256, actual: executionGrant.preparedAuthoritySha256,
    });
  }
  if (executionGrant.executionAuthorized !== true || executionGrant.networkAuthorized !== true) {
    fail('EXECUTION_GRANT_INVALID', 'execution grant must explicitly authorize execution and network');
  }
  const bound = bindActivatingGrantAcquisitionRoot(executionGrant, options);
  return Object.freeze({
    authorityId: prepared.authorityId,
    executionAuthorized: true,
    networkAuthorized: true,
    activated: true,
    reasonCode: null,
    grant: Object.freeze({ ...prepared.preparedGrant }),
    preparedSha256,
    boundAcquisitionRoot: bound.lexical,
  });
}

/** @param {string} acquisitionKey */
export function reservationDirectoryNameForAcquisitionKeyR1(acquisitionKey) {
  if (typeof acquisitionKey !== 'string' || acquisitionKey.length === 0) {
    fail('ACQUIRER_INPUT_INVALID', 'acquisitionKey is required');
  }
  return createHash('sha256').update(acquisitionKey, 'utf8').digest('hex');
}

/**
 * Durable write-once reservation path:
 *   <ACQUISITION_ROOT>/reservations/<sha256(acquisitionKey)>/<ordinal>.json
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 * @param {number} attemptOrdinal
 */
export function jarviseAttemptReservationPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal) {
  if (!LEGAL_ATTEMPT_ORDINALS.includes(attemptOrdinal)) {
    fail('ACQUIRER_ATTEMPT_ORDINAL_INVALID', 'attempt ordinal must be 1, 2 or 3', { attemptOrdinal });
  }
  const hex = reservationDirectoryNameForAcquisitionKeyR1(acquisitionKey);
  return resolve(acquisitionRoot, 'reservations', hex, `${attemptOrdinal}.json`);
}

/**
 * Durable write-once terminal-outcome sibling of a reservation:
 *   <ACQUISITION_ROOT>/reservations/<sha256(acquisitionKey)>/<ordinal>.terminal.json
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 * @param {number} attemptOrdinal
 */
export function jarviseAttemptTerminalPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal) {
  if (!LEGAL_ATTEMPT_ORDINALS.includes(attemptOrdinal)) {
    fail('ACQUIRER_ATTEMPT_ORDINAL_INVALID', 'attempt ordinal must be 1, 2 or 3', { attemptOrdinal });
  }
  const hex = reservationDirectoryNameForAcquisitionKeyR1(acquisitionKey);
  return resolve(acquisitionRoot, 'reservations', hex, `${attemptOrdinal}.terminal.json`);
}

/** @param {string} directory */
function fsyncDirectoryBestEffort(directory) {
  let handle;
  try {
    handle = openSync(directory, 'r');
    fsyncSync(handle);
  } catch {
    /* Windows may refuse a directory fsync; process-crash durability still holds. */
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * Count durable reservation files. Only legal 1.json/2.json/3.json names under
 * a sha256(key) directory are authoritative. No process-memory counter.
 * @param {string} acquisitionRoot
 */
export function countDurableAttemptReservationsR1(acquisitionRoot) {
  const reservationsRoot = resolve(acquisitionRoot, 'reservations');
  if (!existsSync(reservationsRoot)) return 0;
  let count = 0;
  for (const dirent of readdirSync(reservationsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !/^[0-9a-f]{64}$/.test(dirent.name)) continue;
    for (const ordinal of LEGAL_ATTEMPT_ORDINALS) {
      if (existsSync(join(reservationsRoot, dirent.name, `${ordinal}.json`))) count += 1;
    }
  }
  return count;
}

/** @param {string} acquisitionRoot @param {string} acquisitionKey */
export function countDurableAttemptsForKeyR1(acquisitionRoot, acquisitionKey) {
  let count = 0;
  for (const ordinal of LEGAL_ATTEMPT_ORDINALS) {
    if (existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, acquisitionKey, ordinal))) count += 1;
  }
  return count;
}

/**
 * Commit one write-once reservation with exclusive create. Never deletes the
 * file afterwards: a crash between create and a provider response spends the
 * attempt.
 * @param {{path: string, body: Record<string, unknown>}} input
 * @returns {{committed: boolean}}
 */
function commitWriteOnceReservation(input) {
  const target = input.path;
  mkdirSync(dirname(target), { recursive: true });
  let handle;
  try {
    handle = openSync(target, 'wx', 0o600);
  } catch (cause) {
    if (/** @type {{code?: string}} */ (cause)?.code === 'EEXIST') return { committed: false };
    throw cause;
  }
  try {
    writeFileSync(handle, Buffer.from(`${JSON.stringify(input.body, null, 2)}\n`, 'utf8'));
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  fsyncDirectoryBestEffort(dirname(target));
  return { committed: true };
}

/** @param {unknown} identity */
function acquisitionRequestIdentityHash(identity) {
  return `sha256:${createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex')}`;
}

/**
 * CAS-lock liveness probe: process.kill(pid, 0). ESRCH means dead. Any other
 * error cannot disprove liveness and is fail-closed.
 * @param {unknown} pid
 * @returns {'ALIVE'|'DEAD'|'UNPROVABLE'}
 */
function ownerLiveness(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'UNPROVABLE';
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    if (/** @type {{code?: string}} */ (error).code === 'ESRCH') return 'DEAD';
    return 'UNPROVABLE';
  }
}

/** @param {string} filePath */
function readJsonObjectIfPresent(filePath) {
  if (!existsSync(filePath)) return { present: false, value: null, malformed: false };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isPlainObject(parsed)) return { present: true, value: null, malformed: true };
    return { present: true, value: parsed, malformed: false };
  } catch {
    return { present: true, value: null, malformed: true };
  }
}

/**
 * @param {string} acquisitionRoot
 * @param {string} acquisitionKey
 * @param {number} attemptOrdinal
 */
function inspectAttempt(acquisitionRoot, acquisitionKey, attemptOrdinal) {
  const reservationPath = jarviseAttemptReservationPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal);
  const terminalPath = jarviseAttemptTerminalPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal);
  const reservationRead = readJsonObjectIfPresent(reservationPath);
  const terminalRead = readJsonObjectIfPresent(terminalPath);
  if (!reservationRead.present) {
    if (terminalRead.present) {
      fail('ACQUIRER_ATTEMPT_STATE_INVALID', 'terminal outcome exists without a reservation', {
        acquisitionKey, attemptOrdinal,
      });
    }
    return { kind: 'ABSENT', reservationPath, terminalPath, reservation: null, terminal: null };
  }
  if (reservationRead.malformed) {
    fail('ACQUIRER_ATTEMPT_STATE_INVALID', 'reservation file is unreadable', { acquisitionKey, attemptOrdinal });
  }
  if (terminalRead.malformed) {
    fail('ACQUIRER_ATTEMPT_STATE_INVALID', 'terminal outcome file is unreadable', { acquisitionKey, attemptOrdinal });
  }
  if (terminalRead.present) {
    const state = terminalRead.value.attemptState;
    if (
      state === ATTEMPT_STATE_FAILED_RETRYABLE
      || state === ATTEMPT_STATE_FAILED_TERMINAL
      || state === ATTEMPT_STATE_ABANDONED
    ) {
      return {
        kind: state,
        reservationPath,
        terminalPath,
        reservation: reservationRead.value,
        terminal: terminalRead.value,
      };
    }
    fail('ACQUIRER_ATTEMPT_STATE_INVALID', `unknown terminal attemptState ${String(state)}`, {
      acquisitionKey, attemptOrdinal,
    });
  }
  const liveness = ownerLiveness(reservationRead.value.ownerPid);
  if (liveness === 'ALIVE') {
    return {
      kind: ATTEMPT_STATE_IN_FLIGHT,
      reservationPath,
      terminalPath,
      reservation: reservationRead.value,
      terminal: null,
    };
  }
  if (liveness === 'UNPROVABLE') {
    fail('ACQUIRER_OWNER_LIVENESS_UNPROVABLE', 'owner process liveness cannot be disproved; fail closed', {
      acquisitionKey, attemptOrdinal, ownerPid: reservationRead.value.ownerPid ?? null,
    });
  }
  return {
    kind: 'ABANDONED_UNMARKED',
    reservationPath,
    terminalPath,
    reservation: reservationRead.value,
    terminal: null,
  };
}

/** @param {string} kind */
function previousAuthorizesNextOrdinal(kind) {
  return kind === ATTEMPT_STATE_FAILED_RETRYABLE || kind === ATTEMPT_STATE_ABANDONED;
}

/**
 * Durable recovery of a dead-owner IN_FLIGHT reservation. Exclusive create.
 * The attempt remains spent.
 * @param {{acquisitionKey: string, attempt: ReturnType<typeof inspectAttempt>, recoveredByPid: number}} input
 */
function commitAbandonedTerminal(input) {
  const body = {
    schemaVersion: ATTEMPT_TERMINAL_SCHEMA_VERSION,
    acquisitionKey: input.acquisitionKey,
    attemptOrdinal: input.attempt.reservation?.attemptOrdinal ?? null,
    attemptState: ATTEMPT_STATE_ABANDONED,
    condition: 'OWNER_PROCESS_DEAD',
    retryEligible: false,
    previousOwnerPid: input.attempt.reservation?.ownerPid ?? null,
    recoveredByPid: input.recoveredByPid,
  };
  return commitWriteOnceReservation({ path: input.attempt.terminalPath, body });
}

/**
 * @param {{
 *   acquisitionKey: string,
 *   attemptOrdinal: number,
 *   terminalPath: string,
 *   attemptState: string,
 *   condition: string,
 *   retryEligible: boolean,
 * }} input
 */
function commitOwnedTerminal(input) {
  const committed = commitWriteOnceReservation({
    path: input.terminalPath,
    body: {
      schemaVersion: ATTEMPT_TERMINAL_SCHEMA_VERSION,
      acquisitionKey: input.acquisitionKey,
      attemptOrdinal: input.attemptOrdinal,
      attemptState: input.attemptState,
      condition: input.condition,
      retryEligible: input.retryEligible,
      ownerPid: process.pid,
    },
  });
  if (!committed.committed) {
    fail('ACQUIRER_ATTEMPT_STATE_INVALID', 'terminal outcome already exists for this attempt', {
      acquisitionKey: input.acquisitionKey, attemptOrdinal: input.attemptOrdinal,
    });
  }
}

/**
 * Build the bounded acquirer. `createProviderClient` is only ever invoked after
 * a durable reservation has been committed for the current attempt.
 * @param {{
 *   authority: Record<string, any>,
 *   acquisitionRoot: string,
 *   gitRoot?: string,
 *   permittedAcquisitionKeys: Iterable<string>,
 *   journal?: {readEntry: Function},
 *   readPersistenceStage?: (acquisitionKey: string) => string|null,
 *   createProviderClient?: () => ({chart: Function}|Promise<{chart: Function}>),
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
export function createJarviseYahooFetchOnceAcquirerR1(options) {
  if (!isPlainObject(options)) fail('ACQUIRER_INPUT_INVALID', 'acquirer options are required');
  const authority = options.authority;
  if (!isPlainObject(authority)) fail('ACQUIRER_INPUT_INVALID', 'an effective authority is required');
  const grant = authority.grant;
  if (!isPlainObject(grant)) fail('ACQUIRER_INPUT_INVALID', 'authority.grant is required');

  const maxAttemptsPerEmptyKey = Number(grant.maxAttemptsPerEmptyKey);
  const maxProviderInvocationCount = Number(grant.maxProviderInvocationCount);
  if (maxAttemptsPerEmptyKey !== STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY) {
    fail('ACQUIRER_BOUNDS_INVALID', `maxAttemptsPerEmptyKey must be ${STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY}`);
  }
  if (!Number.isSafeInteger(maxProviderInvocationCount) || maxProviderInvocationCount < 1) {
    fail('ACQUIRER_BOUNDS_INVALID', 'maxProviderInvocationCount must be a positive integer');
  }
  if (maxProviderInvocationCount > STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT) {
    fail('ACQUIRER_BOUNDS_INVALID', `maxProviderInvocationCount cannot exceed ${STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT}`);
  }
  if (Number(grant.logicalAcquisitionKeyCount) !== STRUCTURAL_LOGICAL_ACQUISITION_KEY_COUNT) {
    fail('ACQUIRER_BOUNDS_INVALID', `logicalAcquisitionKeyCount must be ${STRUCTURAL_LOGICAL_ACQUISITION_KEY_COUNT}`);
  }

  const gitRoot = options.gitRoot ?? REPOSITORY_ROOT;
  assertActivatedAuthorityBoundToAcquisitionRoot(authority, options.acquisitionRoot, gitRoot);
  const acquisitionRoot = assertExternalAcquisitionRootR1(options.acquisitionRoot, gitRoot);
  mkdirSync(acquisitionRoot, { recursive: true });
  let acquisitionRootReal;
  try {
    acquisitionRootReal = realpathNative(acquisitionRoot);
  } catch (cause) {
    fail('ACQUISITION_ROOT_UNRESOLVED', 'acquisitionRoot cannot be resolved after create', {
      cause: /** @type {Error} */ (cause)?.message ?? null,
    });
  }
  assertExternalAcquisitionRootR1(acquisitionRootReal, gitRoot);

  const permittedAcquisitionKeys = new Set(options.permittedAcquisitionKeys ?? []);
  if (permittedAcquisitionKeys.size !== STRUCTURAL_LOGICAL_ACQUISITION_KEY_COUNT) {
    fail('ACQUIRER_PLAN_INVALID', `permittedAcquisitionKeys must be the exact ${STRUCTURAL_LOGICAL_ACQUISITION_KEY_COUNT}-key plan`, {
      actual: permittedAcquisitionKeys.size,
    });
  }

  if (typeof options.readPersistenceStage !== 'function' && typeof options.journal?.readEntry !== 'function') {
    fail('ACQUIRER_JOURNAL_REQUIRED', 'a persistence journal read capability is required');
  }

  let client = null;
  let clientInFlight = null;

  function readPersistenceStage(acquisitionKey) {
    if (typeof options.readPersistenceStage === 'function') {
      return options.readPersistenceStage(acquisitionKey) ?? 'EMPTY';
    }
    const entry = options.journal.readEntry(acquisitionKey);
    if (entry === null || entry === undefined) return 'EMPTY';
    return typeof entry.stage === 'string' ? entry.stage : 'EMPTY';
  }

  function assertStillEmpty(acquisitionKey) {
    const stage = readPersistenceStage(acquisitionKey);
    if (PINNED_OR_LATER.has(stage)) {
      fail('ACQUIRER_REFETCH_FORBIDDEN', `journal stage ${stage} forbids provider contact and further reservations`, {
        acquisitionKey, stage, condition: 'REFETCH_AFTER_RAW_PINNED',
      });
    }
    if (stage !== 'EMPTY') {
      fail('ACQUIRER_REFETCH_FORBIDDEN', `journal stage ${stage} is not EMPTY`, { acquisitionKey, stage });
    }
  }

  function durableCeiling() {
    return Math.min(maxProviderInvocationCount, STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT);
  }

  function assertCardinalityWithinCeiling() {
    const cardinality = countDurableAttemptReservationsR1(acquisitionRoot);
    if (cardinality > STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT) {
      fail('ACQUIRER_INVOCATION_CEILING_REACHED', `durable reservation cardinality ${cardinality} exceeds structural ceiling ${STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT}`, {
        cardinality, ceiling: STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT,
      });
    }
    return cardinality;
  }

  /**
   * Provider factory is unreachable until a durable reservation is held.
   * One in-flight construction is memoized so concurrent first-client awaits
   * cannot race into multiple factory calls.
   * @param {string} acquisitionKey
   */
  async function providerClientAfterReservation(acquisitionKey) {
    if (client !== null) return client;
    if (clientInFlight === null) {
      if (typeof options.createProviderClient !== 'function') {
        fail('ACQUIRER_PROVIDER_UNAVAILABLE', 'no provider client factory was supplied', { acquisitionKey });
      }
      clientInFlight = Promise.resolve()
        .then(() => options.createProviderClient())
        .then((constructed) => {
          if (!constructed || typeof constructed.chart !== 'function') {
            fail('ACQUIRER_PROVIDER_UNAVAILABLE', 'provider client must expose a chart function', { acquisitionKey });
          }
          client = constructed;
          return constructed;
        });
    }
    try {
      return await clientInFlight;
    } catch (error) {
      if (client === null) clientInFlight = null;
      throw error;
    }
  }

  /**
   * @param {string} acquisitionKey
   * @param {number} attemptOrdinal
   */
  function recoverAbandonedIfNeeded(acquisitionKey, attemptOrdinal) {
    let attempt = inspectAttempt(acquisitionRoot, acquisitionKey, attemptOrdinal);
    if (attempt.kind !== 'ABANDONED_UNMARKED') return attempt;
    commitAbandonedTerminal({
      acquisitionKey,
      attempt,
      recoveredByPid: process.pid,
    });
    attempt = inspectAttempt(acquisitionRoot, acquisitionKey, attemptOrdinal);
    if (attempt.kind === 'ABANDONED_UNMARKED') {
      fail('ACQUIRER_ATTEMPT_STATE_INVALID', 'abandoned recovery did not produce a durable terminal', {
        acquisitionKey, attemptOrdinal, kind: attempt.kind,
      });
    }
    return attempt;
  }

  /**
   * Acquire and canonically serialize the provider result for one plan entry.
   * Returns the exact bytes to pin. A RAW_PINNED (or later) key fails closed
   * before reservation and before any provider factory call.
   * @param {{acquisitionKey: string, acquisitionRequestIdentity: Record<string, any>}} entry
   */
  async function acquireRawBytesFor(entry) {
    if (!isPlainObject(entry)) fail('ACQUIRER_INPUT_INVALID', 'plan entry is required');
    const acquisitionKey = entry.acquisitionKey;
    const identity = entry.acquisitionRequestIdentity;
    if (typeof acquisitionKey !== 'string' || acquisitionKey.length === 0) {
      fail('ACQUIRER_INPUT_INVALID', 'entry.acquisitionKey is required');
    }
    if (!isPlainObject(identity)) fail('ACQUIRER_INPUT_INVALID', 'entry.acquisitionRequestIdentity is required');

    if (!permittedAcquisitionKeys.has(acquisitionKey)) {
      fail('ACQUIRER_QUERY_OUT_OF_BOUNDS', 'acquisition key is outside the exact 802-key plan', { acquisitionKey });
    }
    if (authority.executionAuthorized !== true || authority.networkAuthorized !== true) {
      fail('ACQUIRER_NOT_AUTHORIZED', `authority ${String(authority.authorityId)} does not authorize network acquisition`, {
        reasonCode: authority.reasonCode ?? 'NOT_ACTIVATED', condition: 'AUTHORIZATION_FAILURE',
      });
    }
    if (identity.interval !== grant.interval) fail('ACQUIRER_QUERY_OUT_OF_BOUNDS', 'interval is outside the granted bounds');
    if (identity.period1 !== grant.period1 || identity.period2 !== grant.period2) {
      fail('ACQUIRER_QUERY_OUT_OF_BOUNDS', 'requested period is outside the granted acquisition window');
    }
    if (identity.sourceId !== grant.sourceId) fail('ACQUIRER_QUERY_OUT_OF_BOUNDS', 'sourceId is outside the granted bounds');
    if (identity.registryManifestId !== grant.cohortRegistryManifestId) {
      fail('ACQUIRER_QUERY_OUT_OF_BOUNDS', 'instrument is outside the granted cohort');
    }

    assertStillEmpty(acquisitionKey);

    const chartParams = Object.freeze({
      period1: identity.period1,
      period2: identity.period2,
      interval: identity.interval,
      events: 'div|split',
      return: 'array',
    });

    let lastFailure = null;
    for (const attemptOrdinal of LEGAL_ATTEMPT_ORDINALS) {
      assertStillEmpty(acquisitionKey);

      const spentForKey = countDurableAttemptsForKeyR1(acquisitionRoot, acquisitionKey);
      if (spentForKey >= STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY) {
        fail('ACQUIRER_ATTEMPT_BUDGET_EXHAUSTED', `key exhausted its ${STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY}-attempt budget`, {
          acquisitionKey, attempts: spentForKey,
        });
      }

      let current = recoverAbandonedIfNeeded(acquisitionKey, attemptOrdinal);
      if (current.kind === ATTEMPT_STATE_IN_FLIGHT) {
        fail('ACQUIRER_SAME_KEY_IN_FLIGHT', 'same-key provider contact is already in flight', {
          acquisitionKey, attemptOrdinal, ownerPid: current.reservation?.ownerPid ?? null,
        });
      }
      if (current.kind === ATTEMPT_STATE_FAILED_TERMINAL) {
        fail('ACQUIRER_FAIL_CLOSED', `previous attempt is durably terminal: ${String(current.terminal?.condition)}`, {
          acquisitionKey,
          attemptOrdinal,
          condition: current.terminal?.condition ?? 'FAILED_TERMINAL',
        });
      }
      if (current.kind === ATTEMPT_STATE_FAILED_RETRYABLE || current.kind === ATTEMPT_STATE_ABANDONED) {
        continue;
      }
      if (current.kind !== 'ABSENT') {
        fail('ACQUIRER_ATTEMPT_STATE_INVALID', `unexpected attempt kind ${current.kind}`, {
          acquisitionKey, attemptOrdinal,
        });
      }

      if (attemptOrdinal > 1) {
        const previous = recoverAbandonedIfNeeded(acquisitionKey, attemptOrdinal - 1);
        if (previous.kind === ATTEMPT_STATE_IN_FLIGHT) {
          fail('ACQUIRER_SAME_KEY_IN_FLIGHT', 'previous ordinal is still in flight; retry is not authorized', {
            acquisitionKey, attemptOrdinal, previousOrdinal: attemptOrdinal - 1,
          });
        }
        if (!previousAuthorizesNextOrdinal(previous.kind)) {
          fail('ACQUIRER_RETRY_NOT_AUTHORIZED', 'ordinal N+1 requires a durable retryable or abandoned terminal for ordinal N', {
            acquisitionKey, attemptOrdinal, previousKind: previous.kind,
          });
        }
      }

      const cardinalityBefore = assertCardinalityWithinCeiling();
      if (cardinalityBefore >= durableCeiling()) {
        fail('ACQUIRER_INVOCATION_CEILING_REACHED', `provider invocation ceiling ${durableCeiling()} reached`, {
          acquisitionKey, providerInvocations: cardinalityBefore,
        });
      }

      const reservationPath = jarviseAttemptReservationPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal);
      const terminalPath = jarviseAttemptTerminalPathR1(acquisitionRoot, acquisitionKey, attemptOrdinal);
      const reservationBody = {
        schemaVersion: ATTEMPT_RESERVATION_SCHEMA_VERSION,
        acquisitionKey,
        attemptOrdinal,
        attemptState: ATTEMPT_STATE_IN_FLIGHT,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
        acquisitionRequestIdentityHash: acquisitionRequestIdentityHash(identity),
        authorityId: authority.authorityId,
        preparedAuthoritySha256: authority.preparedSha256,
      };
      const reserved = commitWriteOnceReservation({ path: reservationPath, body: reservationBody });
      if (!reserved.committed) {
        const raced = recoverAbandonedIfNeeded(acquisitionKey, attemptOrdinal);
        if (raced.kind === ATTEMPT_STATE_IN_FLIGHT) {
          fail('ACQUIRER_SAME_KEY_IN_FLIGHT', 'same-key reservation was taken by another in-flight owner', {
            acquisitionKey, attemptOrdinal, ownerPid: raced.reservation?.ownerPid ?? null,
          });
        }
        if (raced.kind === ATTEMPT_STATE_FAILED_RETRYABLE || raced.kind === ATTEMPT_STATE_ABANDONED) {
          continue;
        }
        if (raced.kind === ATTEMPT_STATE_FAILED_TERMINAL) {
          fail('ACQUIRER_FAIL_CLOSED', `raced attempt is durably terminal: ${String(raced.terminal?.condition)}`, {
            acquisitionKey, attemptOrdinal, condition: raced.terminal?.condition ?? 'FAILED_TERMINAL',
          });
        }
        fail('ACQUIRER_SAME_KEY_IN_FLIGHT', 'same-key reservation race could not be classified as retryable', {
          acquisitionKey, attemptOrdinal, kind: raced.kind,
        });
      }

      const cardinalityAfter = assertCardinalityWithinCeiling();
      if (cardinalityAfter > durableCeiling()) {
        fail('ACQUIRER_INVOCATION_CEILING_REACHED', `durable reservation cardinality ${cardinalityAfter} exceeds ceiling ${durableCeiling()}`, {
          acquisitionKey, providerInvocations: cardinalityAfter,
        });
      }

      let chartResult;
      try {
        chartResult = await (await providerClientAfterReservation(acquisitionKey)).chart(identity.providerSymbol, chartParams);
      } catch (error) {
        const classified = classifyAcquisitionFailureR1(error);
        lastFailure = { ...classified, message: /** @type {Error} */ (error)?.message ?? null };
        commitOwnedTerminal({
          acquisitionKey,
          attemptOrdinal,
          terminalPath,
          attemptState: classified.retryEligible ? ATTEMPT_STATE_FAILED_RETRYABLE : ATTEMPT_STATE_FAILED_TERMINAL,
          condition: classified.condition,
          retryEligible: classified.retryEligible,
        });
        if (!classified.retryEligible) {
          fail('ACQUIRER_FAIL_CLOSED', `non-retryable provider failure: ${classified.condition}`, {
            acquisitionKey, condition: classified.condition, cause: lastFailure.message,
          });
        }
        if (typeof options.sleep === 'function') await options.sleep(attemptOrdinal);
        continue;
      }

      try {
        const bytes = canonicalProviderResultBytesR1(chartResult);
        if (!Array.isArray(chartResult?.quotes) || chartResult.quotes.length === 0) {
          commitOwnedTerminal({
            acquisitionKey,
            attemptOrdinal,
            terminalPath,
            attemptState: ATTEMPT_STATE_FAILED_TERMINAL,
            condition: 'EMPTY_PROVIDER_RESULT',
            retryEligible: false,
          });
          fail('ACQUIRER_FAIL_CLOSED', 'provider returned a semantically empty result', {
            acquisitionKey, condition: 'EMPTY_PROVIDER_RESULT',
          });
        }
        return bytes;
      } catch (error) {
        if (/** @type {any} */ (error)?.name === 'JarviseAcquirerError') throw error;
        const classified = classifyAcquisitionFailureR1(error);
        commitOwnedTerminal({
          acquisitionKey,
          attemptOrdinal,
          terminalPath,
          attemptState: ATTEMPT_STATE_FAILED_TERMINAL,
          condition: classified.condition,
          retryEligible: false,
        });
        fail('ACQUIRER_FAIL_CLOSED', `provider result could not be canonically serialized: ${classified.condition}`, {
          acquisitionKey, condition: classified.condition, cause: /** @type {Error} */ (error)?.message ?? null,
        });
      }
    }

    const attempts = countDurableAttemptsForKeyR1(acquisitionRoot, acquisitionKey);
    if (attempts >= STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY) {
      return fail('ACQUIRER_RETRY_BUDGET_EXHAUSTED', `all ${STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY} attempts failed for a retry-eligible condition`, {
        acquisitionKey, attempts, lastFailure,
      });
    }
    return fail('ACQUIRER_ATTEMPT_BUDGET_EXHAUSTED', `key exhausted its ${STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY}-attempt budget`, {
      acquisitionKey, attempts,
    });
  }

  return Object.freeze({
    version: JARVISE_YAHOO_FETCH_ONCE_ACQUIRER_VERSION,
    acquireRawBytesFor,
    acquisitionRoot: acquisitionRootReal,
    providerInvocations: () => countDurableAttemptReservationsR1(acquisitionRoot),
    attemptsFor: (acquisitionKey) => countDurableAttemptsForKeyR1(acquisitionRoot, acquisitionKey),
    remainingInvocationBudget: () => durableCeiling() - countDurableAttemptReservationsR1(acquisitionRoot),
    providerClientConstructed: () => client !== null,
    describe: () => Object.freeze({
      version: JARVISE_YAHOO_FETCH_ONCE_ACQUIRER_VERSION,
      authorityId: authority.authorityId,
      activated: authority.activated === true,
      networkAuthorized: authority.networkAuthorized === true,
      maxAttemptsPerEmptyKey,
      maxProviderInvocationCount: durableCeiling(),
      providerInvocations: countDurableAttemptReservationsR1(acquisitionRoot),
      retryEligibleConditions: RETRY_ELIGIBLE_CONDITIONS,
      retryIneligibleConditions: RETRY_INELIGIBLE_CONDITIONS,
      acquisitionRootPolicy: 'OUTSIDE_GOVERNED_REPOSITORY',
    }),
  });
}
