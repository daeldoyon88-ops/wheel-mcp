/**
 * P3 bounded-acquirer coverage.
 *
 * No test in this suite reaches a provider or a socket. The "provider client"
 * is always a local stub, and several tests assert that no client is
 * constructed at all. Acquisition roots and content-addressed stores used here
 * are throwaway temporary directories, never the repository data root.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { createContentAddressedStore } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import {
  DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
  validateDatasetSnapshotRecord,
} from '../../research/directional-lab/src/contracts/datasetSnapshotV1.mjs';
import {
  ACQUISITION_METHOD,
  buildJarviseAcquisitionPlanR1,
} from './jarviseAcquisitionQueryIdentityR1.mjs';
import { canonicalProviderResultBytesR1 } from './jarviseYahooChartAdapterR1.mjs';
import {
  ATTEMPT_STATE_ABANDONED,
  ATTEMPT_STATE_FAILED_RETRYABLE,
  ATTEMPT_STATE_FAILED_TERMINAL,
  RETRY_ELIGIBLE_CONDITIONS,
  RETRY_INELIGIBLE_CONDITIONS,
  STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY,
  STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT,
  assertExternalAcquisitionRootR1,
  canonicalChartParamsR1,
  classifyAcquisitionFailureR1,
  countDurableAttemptReservationsR1,
  countDurableAttemptsForKeyR1,
  createJarviseYahooFetchOnceAcquirerR1,
  inspectJarviseAttemptR1,
  jarviseAttemptReservationPathR1,
  jarviseAttemptTerminalPathR1,
  mutableProviderChartParamsR1,
  resolveEffectiveAcquisitionAuthorityR1,
} from './jarviseYahooFetchOnceAcquirerR1.mjs';
import {
  createJarviseSnapshotDirectoryJournalR1,
  createJarviseSnapshotMemoryJournalR1,
  createJarviseSnapshotPersistenceR1,
} from './jarviseSnapshotPersistenceR1.mjs';
import {
  parseJarviseHistoricalFetchOnceArgsR1,
  runJarviseHistoricalFetchOnceR1,
} from '../../scripts/runJarviseHistoricalFetchOnceR1.mjs';
import {
  createJarviseYahooFinance2ChartClientR1,
  projectYahooFinance2HttpErrorR1,
  extractP3ePerCallFetchTransportCodeR1,
} from './jarviseYahooFinance2ChartClientFactoryR1.mjs';
import {
  ATTEMPT_RESERVATION_SCHEMA_VERSION_V2,
  CANONICAL_PREPARED_AUTHORITY_SHA256,
  assertGitCanonicalTrackedWorktreeEquivalenceR1,
  loadOwnerIncidentRecoveryGrantR1,
  parseOwnerIncidentRecoveryGrantObjectR1,
} from './jarviseYahooIncidentRecoveryAuthorizationR1.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PREPARED_AUTHORITY_URL = new URL('./jarviseFetchOnceExecutionAuthorityR1.json', import.meta.url);
const ACQUIRER_MODULE_PATH = fileURLToPath(new URL('./jarviseYahooFetchOnceAcquirerR1.mjs', import.meta.url));
const IDENTITY_MODULE_PATH = fileURLToPath(new URL('./jarviseAcquisitionQueryIdentityR1.mjs', import.meta.url));

const preparedBytes = readFileSync(PREPARED_AUTHORITY_URL);
const preparedAuthority = JSON.parse(preparedBytes.toString('utf8'));
const preparedSha256 = createHash('sha256').update(preparedBytes).digest('hex');

/** Owner-supplied EXPLICIT_MISSION_GRANT stand-in without a bound root. Never published by P3. */
const TEST_EXECUTION_GRANT = Object.freeze({
  mechanism: 'EXPLICIT_MISSION_GRANT',
  decisionType: 'PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION',
  preparedAuthoritySha256: preparedSha256,
  executionAuthorized: true,
  networkAuthorized: true,
});

function testExecutionGrant(acquisitionRoot, extra = {}) {
  return {
    ...TEST_EXECUTION_GRANT,
    acquisitionRoot,
    ...extra,
  };
}

const activatedAuthority = (acquisitionRoot) => resolveEffectiveAcquisitionAuthorityR1({
  root: REPOSITORY_ROOT,
  gitRoot: REPOSITORY_ROOT,
  acquisitionRoot,
  executionGrant: testExecutionGrant(acquisitionRoot),
});

const EMPTY_JOURNAL = Object.freeze({ readEntry: () => null });

let cachedPlan = null;
function plan() {
  cachedPlan ??= buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  return cachedPlan;
}
function planEntry(index = 0) {
  return plan().entries[index];
}
function permittedKeys() {
  return new Set(plan().entries.map((entry) => entry.acquisitionKey));
}

function chartFor(symbol) {
  return {
    meta: { symbol, currency: 'USD', exchangeName: 'NYQ' },
    quotes: [{ date: new Date('2026-05-04T13:30:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, adjclose: 1.4 }],
    events: { dividends: [], splits: [] },
  };
}

/** @param {string} code @param {number} [status] */
function providerError(code, status) {
  const error = new Error(`stub provider failure ${code}`);
  if (code) error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

/** @param {string} code */
function p3eTransportError(code) {
  const error = new TypeError('fetch failed');
  error.p3eTransportFailure = Object.freeze({ source: 'P3E_PER_CALL_FETCH', code });
  error.p3eOwnedTimeoutAbort = false;
  error.p3eHttpCapture = Object.freeze({ responseSeen: false, responseStatus: null });
  return error;
}

function temporaryStore(t) {
  const root = mkdtempSync(join(tmpdir(), 'jarvise-p3-acquirer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return createContentAddressedStore({ root });
}

function temporaryAcquisitionRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'p3-yahoo-acq-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeAcquirer(t, overrides = {}) {
  const acquisitionRoot = overrides.acquisitionRoot ?? temporaryAcquisitionRoot(t);
  const { acquisitionRoot: _ignored, ...rest } = overrides;
  return createJarviseYahooFetchOnceAcquirerR1({
    authority: activatedAuthority(acquisitionRoot),
    acquisitionRoot,
    gitRoot: REPOSITORY_ROOT,
    permittedAcquisitionKeys: permittedKeys(),
    journal: EMPTY_JOURNAL,
    ...rest,
  });
}

function childScript({ mode, acquisitionRoot, entryIndex = 0, markerDir, goPath = null, releasePath = null }) {
  return `import { writeFileSync, existsSync } from 'node:fs';
import { createJarviseYahooFetchOnceAcquirerR1, resolveEffectiveAcquisitionAuthorityR1, countDurableAttemptsForKeyR1 } from ${JSON.stringify(pathToFileURL(ACQUIRER_MODULE_PATH).href)};
import { buildJarviseAcquisitionPlanR1 } from ${JSON.stringify(pathToFileURL(IDENTITY_MODULE_PATH).href)};

const root = ${JSON.stringify(REPOSITORY_ROOT)};
const acquisitionRoot = ${JSON.stringify(acquisitionRoot)};
const markerDir = ${JSON.stringify(markerDir)};
const mode = ${JSON.stringify(mode)};
const goPath = ${JSON.stringify(goPath)};
const releasePath = ${JSON.stringify(releasePath)};
const grant = {
  mechanism: 'EXPLICIT_MISSION_GRANT',
  decisionType: 'PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION',
  preparedAuthoritySha256: ${JSON.stringify(preparedSha256)},
  executionAuthorized: true,
  networkAuthorized: true,
  acquisitionRoot,
};
const plan = buildJarviseAcquisitionPlanR1({ root });
const entry = plan.entries[${entryIndex}];
const authority = resolveEffectiveAcquisitionAuthorityR1({ root, gitRoot: root, acquisitionRoot, executionGrant: grant });

writeFileSync(markerDir + '/READY_' + process.pid, String(process.pid));
if (goPath) {
  const started = Date.now();
  while (!existsSync(goPath)) {
    if (Date.now() - started > 30000) {
      writeFileSync(markerDir + '/TIMEOUT_WAITING_FOR_GO', '1');
      process.exit(2);
    }
  }
}

const acquirer = createJarviseYahooFetchOnceAcquirerR1({
  authority,
  acquisitionRoot,
  gitRoot: root,
  permittedAcquisitionKeys: plan.entries.map((item) => item.acquisitionKey),
  journal: { readEntry: () => null },
  sleep: async () => {
    if (mode === 'hold-in-flight') {
      writeFileSync(markerDir + '/RETRYABLE_TERMINAL_EXIT', '1');
      process.exit(3);
    }
  },
  createProviderClient: () => {
    writeFileSync(markerDir + '/RESERVATION_BOUNDARY_REACHED', JSON.stringify({
      pid: process.pid,
      mode,
      attempts: countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey),
    }));
    if (mode === 'crash-after-reservation') process.exit(97);
    return {
      chart: async (symbol) => {
        writeFileSync(markerDir + '/PROVIDER_ENTER_' + process.pid, '1');
        writeFileSync(markerDir + '/PROVIDER_CONTACTED_' + process.pid, JSON.stringify({
          pid: process.pid,
          attempts: countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey),
          symbol,
        }));
        if (mode === 'hold-in-flight') {
          writeFileSync(markerDir + '/IN_FLIGHT_' + process.pid, String(process.pid));
          const holdStarted = Date.now();
          while (!existsSync(releasePath)) {
            if (Date.now() - holdStarted > 60000) {
              writeFileSync(markerDir + '/TIMEOUT_WAITING_FOR_RELEASE', '1');
              process.exit(2);
            }
          }
          const held = new Error('stub timeout after in-flight hold');
          held.code = 'ETIMEDOUT';
          held.p3eTransportFailure = { source: 'P3E_PER_CALL_FETCH', code: 'ETIMEDOUT' };
          writeFileSync(markerDir + '/PROVIDER_LEAVE_' + process.pid, '1');
          throw held;
        }
        if (mode === 'timeout-once') {
          const error = new Error('stub timeout');
          error.code = 'ETIMEDOUT';
          error.p3eTransportFailure = { source: 'P3E_PER_CALL_FETCH', code: 'ETIMEDOUT' };
          writeFileSync(markerDir + '/PROVIDER_LEAVE_' + process.pid, '1');
          throw error;
        }
        writeFileSync(markerDir + '/PROVIDER_LEAVE_' + process.pid, '1');
        return {
          meta: { symbol, currency: 'USD', exchangeName: 'NYQ' },
          quotes: [{ date: new Date('2026-05-04T13:30:00.000Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, adjclose: 1.4 }],
          events: { dividends: [], splits: [] },
        };
      },
    };
  },
});

try {
  const bytes = await acquirer.acquireRawBytesFor(entry);
  writeFileSync(markerDir + '/ACQUIRE_OK', String(bytes.length));
  process.exit(0);
} catch (error) {
  writeFileSync(markerDir + '/ACQUIRE_ERROR', JSON.stringify({ code: error?.code ?? null, message: error?.message ?? String(error) }));
  process.exit(error?.code === 'ACQUIRER_ATTEMPT_BUDGET_EXHAUSTED' || error?.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED' ? 3 : 1);
}
`;
}

function spawnChild(scriptPath, extra = {}) {
  return spawn(process.execPath, [scriptPath], {
    cwd: dirname(scriptPath),
    env: { ...process.env, ...extra.env },
    stdio: 'ignore',
    windowsHide: true,
  });
}

function runChildSync(scriptPath) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: dirname(scriptPath),
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
}

test('P3-F1 the published authority is prepared, not executable, and constructs no client', (t) => {
  const authority = resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null });
  assert.equal(preparedAuthority.authorityState, 'PREPARED_NOT_EXECUTABLE');
  assert.equal(preparedAuthority.executionAuthorized, false);
  assert.equal(preparedAuthority.networkAuthorized, false);
  assert.equal(preparedAuthority.providerCallsAuthorized, 0);
  assert.equal(preparedAuthority.executionAuthorization.mechanism, 'EXPLICIT_MISSION_GRANT');
  assert.equal(preparedAuthority.executionAuthorization.optionalDurableOwnerRecord, 'PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION');
  assert.equal(preparedAuthority.executionAuthorization.grantDocumentPresent, false);
  assert.equal(preparedAuthority.executionAuthorization.selfAuthorization, 'FORBIDDEN');
  assert.equal(preparedAuthority.executionAuthorization.activatingGrantMustBindAcquisitionRoot, true);
  assert.equal(preparedAuthority.executionAuthorization.resumePolicy, 'ONE_LOGICAL_MISSION_MULTI_RESUME_SAME_BOUND_ROOT');
  assert.equal(preparedAuthority.executionAuthorization.yahooFetchAuthorizedRole, 'DECLARATIVE_NON_RUNTIME_METADATA');
  assert.deepEqual(preparedAuthority.executionAuthorization.effectiveRuntimeGates, ['executionAuthorized', 'networkAuthorized']);
  assert.equal(preparedAuthority.yahooFetchAuthorized, false);
  assert.equal(preparedAuthority.executionAuthorization.effectOnGrant.includes('exactly one run'), false);
  assert.match(preparedAuthority.executionAuthorization.effectOnGrant, /one logical Owner mission/);
  assert.equal(preparedAuthority.acquisitionRootPolicy, 'OUTSIDE_GOVERNED_REPOSITORY');
  assert.equal(preparedAuthority.repositoryDynamicAcquisitionWrites, 'FORBIDDEN');
  assert.equal(preparedAuthority.authorityPredecessor, null);
  assert.equal(authority.activated, false);
  assert.equal(authority.networkAuthorized, false);
  assert.equal(authority.reasonCode, 'OWNER_MISSION_GRANT_ABSENT');

  const acquirer = makeAcquirer(t, {
    authority,
    createProviderClient: () => assert.fail('no provider client may be constructed without activation'),
  });
  assert.equal(acquirer.providerClientConstructed(), false);
});

test('P3-F2 an unactivated authority refuses acquisition with AUTHORIZATION_FAILURE', async (t) => {
  const authority = resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null });
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const acquirer = makeAcquirer(t, {
    authority,
    acquisitionRoot,
    createProviderClient: () => assert.fail('unreachable'),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_NOT_AUTHORIZED' && error.details.condition === 'AUTHORIZATION_FAILURE',
  );
  assert.equal(acquirer.providerInvocations(), 0);
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
});

test('P3-F3 execution grant must be bound to the exact prepared authority bytes', () => {
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      executionGrant: { ...TEST_EXECUTION_GRANT, preparedAuthoritySha256: 'x'.repeat(64) },
    }),
    (error) => error.code === 'EXECUTION_GRANT_BINDING_MISMATCH',
  );
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      executionGrant: { ...TEST_EXECUTION_GRANT, networkAuthorized: false },
    }),
    (error) => error.code === 'EXECUTION_GRANT_INVALID',
  );
});

test('P3-F4 the ratified bounds are exactly 802 keys, 3 attempts and a 2406 ceiling', () => {
  const grant = preparedAuthority.preparedGrant;
  assert.equal(grant.logicalAcquisitionKeyCount, 802);
  assert.equal(grant.maxAttemptsPerEmptyKey, 3);
  assert.equal(grant.maxProviderInvocationCount, 2406);
  assert.equal(802 * 3, 2406);
  assert.equal(grant.invocationCountingRule, 'EVERY_PROVIDER_INVOCATION_COUNTS_WHETHER_SUCCESSFUL_OR_NOT');
  assert.deepEqual(grant.events, ['SPLITS', 'DIVIDENDS']);
  assert.equal(grant.interval, '1d');
  assert.equal(grant.period1, '2018-01-01T00:00:00.000Z');
  assert.equal(grant.period2, '2026-09-05T00:00:00.000Z');
  assert.equal(grant.terminalStage, 'VERSION_CACHED');
  assert.equal(STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY, 3);
  assert.equal(STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT, 2406);
});

test('P3-F5 a successful acquisition costs exactly one invocation', async (t) => {
  const entry = planEntry();
  let calls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async (symbol, params) => {
        calls += 1;
        assert.equal(symbol, entry.acquisitionRequestIdentity.providerSymbol);
        assert.equal(params.interval, '1d');
        assert.equal(params.period1, '2018-01-01T00:00:00.000Z');
        assert.equal(params.period2, '2026-09-05T00:00:00.000Z');
        assert.equal(params.events, 'div|split');
        return chartFor(symbol);
      },
    }),
  });
  const bytes = await acquirer.acquireRawBytesFor(entry);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(calls, 1);
  assert.equal(acquirer.providerInvocations(), 1);
  assert.equal(acquirer.attemptsFor(entry.acquisitionKey), 1);
});

test('P3-F6 a retry-eligible failure retries at most 3 times, then fails closed', async (t) => {
  const entry = planEntry();
  let calls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async () => {
        calls += 1;
        throw p3eTransportError('ETIMEDOUT');
      },
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED',
  );
  assert.equal(calls, 3, 'exactly three attempts while the key is EMPTY');
  assert.equal(acquirer.providerInvocations(), 3);
  assert.equal(acquirer.attemptsFor(entry.acquisitionKey), 3);
});

test('P3-F7 a fourth attempt on the same key fails closed without contacting the provider', async (t) => {
  const entry = planEntry();
  let calls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async () => {
        calls += 1;
        throw providerError(undefined, 503);
      },
    }),
  });
  await assert.rejects(() => acquirer.acquireRawBytesFor(entry), (e) => e.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED');
  assert.equal(calls, 3);

  await assert.rejects(
    () => acquirer.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_ATTEMPT_BUDGET_EXHAUSTED',
  );
  assert.equal(calls, 3, 'the fourth attempt must not reach the provider');
  assert.equal(acquirer.providerInvocations(), 3);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquirer.acquisitionRoot, entry.acquisitionKey, 3)), true);
  assert.throws(
    () => jarviseAttemptReservationPathR1(acquirer.acquisitionRoot, entry.acquisitionKey, 4),
    (error) => error.code === 'ACQUIRER_ATTEMPT_ORDINAL_INVALID',
  );
});

test('P3-F8 the global invocation ceiling is enforced and counts failures', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const authority = {
    ...activatedAuthority(acquisitionRoot),
    grant: { ...preparedAuthority.preparedGrant, maxAttemptsPerEmptyKey: 3, maxProviderInvocationCount: 4 },
  };
  let calls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    authority,
    createProviderClient: () => ({
      chart: async () => {
        calls += 1;
        throw providerError(undefined, 429);
      },
    }),
  });
  await assert.rejects(() => acquirer.acquireRawBytesFor(planEntry(0)), (e) => e.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED');
  assert.equal(acquirer.providerInvocations(), 3);
  assert.equal(acquirer.remainingInvocationBudget(), 1);

  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry(1)),
    (error) => error.code === 'ACQUIRER_INVOCATION_CEILING_REACHED',
  );
  assert.equal(calls, 4, 'the ceiling stops contact at exactly the granted budget');
  assert.equal(acquirer.providerInvocations(), 4);
});

test('P3-F9 non-retryable conditions fail closed on the first attempt', async (t) => {
  const cases = [
    { chart: async () => ({ meta: { symbol: 'X' }, quotes: [] }), expected: 'EMPTY_PROVIDER_RESULT' },
    { chart: async () => { throw providerError(undefined, 404); }, expected: 'SCHEMA_FAILURE' },
  ];
  for (const testCase of cases) {
    let calls = 0;
    const acquirer = makeAcquirer(t, {
      createProviderClient: () => ({
        chart: async (...args) => {
          calls += 1;
          return testCase.chart(...args);
        },
      }),
    });
    await assert.rejects(
      () => acquirer.acquireRawBytesFor(planEntry()),
      (error) => error.code === 'ACQUIRER_FAIL_CLOSED' && error.details.condition === testCase.expected,
    );
    assert.equal(calls, 1, 'a non-retryable failure must not be retried');
  }
});

test('P3-F10 the retry taxonomy matches the ratified decision exactly', () => {
  assert.deepEqual([...RETRY_ELIGIBLE_CONDITIONS], ['TIMEOUT', 'PROVIDER_RATE_LIMITED', 'PROVIDER_SERVER_ERROR']);
  assert.deepEqual([...RETRY_INELIGIBLE_CONDITIONS], [
    'MALFORMED_PROVIDER_RESULT', 'EMPTY_PROVIDER_RESULT', 'DIGEST_DIVERGENCE',
    'CAS_DIVERGENCE', 'SCHEMA_FAILURE', 'AUTHORIZATION_FAILURE',
  ]);
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ETIMEDOUT')).retryEligible, true);
  assert.equal(classifyAcquisitionFailureR1(providerError(undefined, 429)).retryEligible, true);
  assert.equal(classifyAcquisitionFailureR1(providerError(undefined, 502)).retryEligible, true);
  assert.equal(classifyAcquisitionFailureR1(providerError(undefined, 404)).retryEligible, false);
  assert.equal(classifyAcquisitionFailureR1(new Error('nonsense')).retryEligible, false);
  assert.deepEqual(preparedAuthority.retryEligibleConditions, [...RETRY_ELIGIBLE_CONDITIONS]);
  assert.deepEqual(preparedAuthority.retryIneligibleConditions, [...RETRY_INELIGIBLE_CONDITIONS]);
});

test('P3-F11 a key that is already RAW_PINNED is never acquired again', async (t) => {
  const store = temporaryStore(t);
  const journal = createJarviseSnapshotMemoryJournalR1();
  const authority = activatedAuthority(temporaryAcquisitionRoot(t));
  const entry = planEntry();
  const bytes = canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol));

  const persistence = createJarviseSnapshotPersistenceR1({ store, journal, acquisitionAuthority: authority });
  const acquisition = {
    sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
    ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
    acquisitionMethod: ACQUISITION_METHOD,
    acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
    acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
    acquisitionEvidenceIds: [],
  };

  const first = persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition,
    acquireRawBytes: () => bytes,
  });
  assert.equal(first.stage, 'RAW_PINNED');
  assert.equal(first.acquired, true);
  assert.equal(persistence.acquisitionInvocations(), 1);

  const second = persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition,
    acquireRawBytes: () => assert.fail('a RAW_PINNED key must never be acquired again'),
  });
  assert.equal(second.reused, true);
  assert.equal(second.acquired, false);
  assert.equal(second.sourceObjectId, first.sourceObjectId);
  assert.equal(persistence.acquisitionInvocations(), 1, 'no second acquisition may be counted');

  const resumed = persistence.resume({ acquisitionKey: entry.acquisitionKey });
  assert.equal(resumed.stage, 'RAW_PINNED');
  assert.equal(resumed.refetchRequired, false);
  assert.equal(resumed.rawPinned, true);
  assert.equal(resumed.nextStep, 'normalizePinnedRaw');
});

test('P3-F12 an unactivated authority refuses the pin even with bytes already in hand', async (t) => {
  const store = temporaryStore(t);
  const persistence = createJarviseSnapshotPersistenceR1({
    store,
    journal: createJarviseSnapshotMemoryJournalR1(),
    acquisitionAuthority: resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null }),
  });
  const entry = planEntry();
  const bytes = canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol));
  assert.throws(
    () => persistence.pinRawOnce({
      acquisitionKey: entry.acquisitionKey,
      acquisition: {
        sourceAcquiredAt: null,
        ingestedIntoLabAt: '2026-09-05T12:00:00.000Z',
        acquisitionMethod: ACQUISITION_METHOD,
        acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
        acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
        acquisitionEvidenceIds: [],
      },
      acquireRawBytes: () => bytes,
    }),
    (error) => error.code === 'PERSISTENCE_ACQUISITION_FORBIDDEN',
  );
});

test('P3-F13 the acquisition provenance is a valid DatasetSnapshotRecord/1 body', () => {
  const entry = planEntry();
  const record = {
    schemaVersion: DATASET_SNAPSHOT_RECORD_SCHEMA_VERSION,
    snapshotCoreId: `sha256:${'0'.repeat(64)}`,
    sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
    ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
    acquisitionMethod: ACQUISITION_METHOD,
    acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
    acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
    acquisitionEvidenceIds: [],
  };
  const result = validateDatasetSnapshotRecord(record);
  assert.deepEqual(result.problems, []);
  assert.equal(result.valid, true);
});

test('P3-F14 a query outside the granted bounds is refused before any provider contact', async (t) => {
  const entry = planEntry();
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => assert.fail('out-of-bounds queries must not reach the provider'),
  });
  const widened = {
    acquisitionKey: 'OUT_OF_BOUNDS',
    acquisitionRequestIdentity: { ...entry.acquisitionRequestIdentity, period2: '2026-12-31T00:00:00.000Z' },
  };
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(widened),
    (error) => error.code === 'ACQUIRER_QUERY_OUT_OF_BOUNDS',
  );
  assert.equal(acquirer.providerInvocations(), 0);
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
});

test('P3-R1 reservation survives a process restart', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const markerDir = temporaryAcquisitionRoot(t);
  const scriptPath = join(markerDir, 'child.mjs');
  writeFileSync(scriptPath, childScript({ mode: 'success', acquisitionRoot, markerDir }));
  const child = runChildSync(scriptPath);
  assert.equal(child.status, 0, child.stderr || child.stdout || 'child must exit 0');
  assert.equal(existsSync(join(markerDir, 'RESERVATION_BOUNDARY_REACHED')), true);
  assert.equal(existsSync(join(markerDir, 'ACQUIRE_OK')), true);

  const restarted = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => assert.fail('restart must not construct a provider merely to read durable state'),
  });
  const entry = planEntry();
  assert.equal(restarted.attemptsFor(entry.acquisitionKey), 1);
  assert.equal(restarted.providerInvocations(), 1);
  assert.equal(restarted.providerClientConstructed(), false);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 1)), true);
});

test('P3-R2 crash after reservation consumes the attempt', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const markerDir = temporaryAcquisitionRoot(t);
  const scriptPath = join(markerDir, 'child.mjs');
  writeFileSync(scriptPath, childScript({ mode: 'crash-after-reservation', acquisitionRoot, markerDir }));
  const child = runChildSync(scriptPath);
  assert.equal(child.status, 97, 'child must die at the reservation boundary');
  assert.equal(existsSync(join(markerDir, 'RESERVATION_BOUNDARY_REACHED')), true, 'non-vacuity: child reached the reservation boundary');
  assert.equal(existsSync(join(markerDir, 'PROVIDER_CONTACTED_' + 'x')), false);
  const entry = planEntry();
  assert.equal(countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey), 1);

  let factoryCalls = 0;
  let chartCalls = 0;
  const restarted = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => {
      factoryCalls += 1;
      return {
        chart: async (symbol) => {
          chartCalls += 1;
          return chartFor(symbol);
        },
      };
    },
  });
  const bytes = await restarted.acquireRawBytesFor(entry);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(restarted.attemptsFor(entry.acquisitionKey), 2, 'the crashed attempt remains spent');
  assert.equal(factoryCalls, 1);
  assert.equal(chartCalls, 1);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 1)), true);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 2)), true);
  const abandoned = JSON.parse(readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, entry.acquisitionKey, 1), 'utf8'));
  assert.equal(abandoned.attemptState, ATTEMPT_STATE_ABANDONED, 'S1b-C4: crash recovery is a durable ABANDONED terminal; ordinal is not refunded');
  assert.equal(abandoned.condition, 'OWNER_PROCESS_DEAD');
});

test('P3-R3 three lifetime attempts across separate processes; fourth blocked before provider construction', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const entry = planEntry();
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const markerDir = temporaryAcquisitionRoot(t);
    const scriptPath = join(markerDir, 'child.mjs');
    writeFileSync(scriptPath, childScript({ mode: 'crash-after-reservation', acquisitionRoot, markerDir }));
    const child = runChildSync(scriptPath);
    assert.equal(child.status, 97, `process ${ordinal} must die after reserving`);
    assert.equal(existsSync(join(markerDir, 'RESERVATION_BOUNDARY_REACHED')), true, `process ${ordinal} reached the reservation boundary`);
    assert.equal(countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey), ordinal);
  }

  let factoryCalls = 0;
  const fourth = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('fourth process must not construct a provider client');
    },
  });
  await assert.rejects(
    () => fourth.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_ATTEMPT_BUDGET_EXHAUSTED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(fourth.providerClientConstructed(), false);
  assert.equal(fourth.attemptsFor(entry.acquisitionKey), 3);
});

test('P3-R4 durable structural 2406 ceiling survives restart', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const reservationsRoot = join(acquisitionRoot, 'reservations');
  mkdirSync(reservationsRoot, { recursive: true });
  for (let index = 0; index < STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT; index += 1) {
    const hex = createHash('sha256').update(`p3-r4-seed-${index}`, 'utf8').digest('hex');
    const dir = join(reservationsRoot, hex);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.json'), `${JSON.stringify({ schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/1', seed: index })}\n`, { flag: 'wx' });
  }
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 2406);

  let factoryCalls = 0;
  const restarted = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('structural ceiling must block provider construction');
    },
  });
  await assert.rejects(
    () => restarted.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_INVOCATION_CEILING_REACHED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(restarted.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 2406);
});

test('P3-R5 RAW_PINNED key does not construct a provider, contact it, or burn a reservation', async (t) => {
  const store = temporaryStore(t);
  const journal = createJarviseSnapshotMemoryJournalR1();
  const authority = activatedAuthority(temporaryAcquisitionRoot(t));
  const entry = planEntry();
  const bytes = canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol));
  const persistence = createJarviseSnapshotPersistenceR1({ store, journal, acquisitionAuthority: authority });
  persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition: {
      sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
      ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
      acquisitionMethod: ACQUISITION_METHOD,
      acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
      acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
      acquisitionEvidenceIds: [],
    },
    acquireRawBytes: () => bytes,
  });
  assert.equal(persistence.stageOf(entry.acquisitionKey), 'RAW_PINNED');

  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    journal,
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('RAW_PINNED must not construct a provider client');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_REFETCH_FORBIDDEN',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
  assert.equal(acquirer.attemptsFor(entry.acquisitionKey), 0);
});

test('P3-R6 S1b-C1/C2/C3 same-key in-flight excludes concurrent provider contact and ordinal 2', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const markerA = temporaryAcquisitionRoot(t);
  const markerB = temporaryAcquisitionRoot(t);
  const markerC = temporaryAcquisitionRoot(t);
  const releasePath = join(markerA, 'RELEASE');
  const scriptA = join(markerA, 'child-a.mjs');
  const scriptB = join(markerB, 'child-b.mjs');
  const scriptC = join(markerC, 'child-c.mjs');
  writeFileSync(scriptA, childScript({
    mode: 'hold-in-flight', acquisitionRoot, markerDir: markerA, releasePath,
  }));
  writeFileSync(scriptB, childScript({
    mode: 'success', acquisitionRoot, markerDir: markerB,
  }));
  writeFileSync(scriptC, childScript({
    mode: 'success', acquisitionRoot, markerDir: markerC,
  }));

  const childA = spawnChild(scriptA);
  t.after(() => {
    childA.kill();
  });
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline && !existsSync(join(markerA, `IN_FLIGHT_${childA.pid}`))) {
    await delay(50);
  }
  assert.equal(existsSync(join(markerA, `PROVIDER_CONTACTED_${childA.pid}`)), true, 'A must contact the provider stub');
  assert.equal(existsSync(join(markerA, `IN_FLIGHT_${childA.pid}`)), true, 'A must remain in-flight');

  const entry = planEntry();
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 1)), true);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 2)), false, 'S1b-C2: ordinal 2 must not exist while ordinal 1 is in-flight');
  assert.equal(existsSync(jarviseAttemptTerminalPathR1(acquisitionRoot, entry.acquisitionKey, 1)), false);

  const childB = spawnChild(scriptB);
  t.after(() => {
    childB.kill();
  });
  const statusB = await new Promise((resolveStatus) => childB.on('exit', (code) => resolveStatus(code)));
  assert.equal(existsSync(join(markerA, `IN_FLIGHT_${childA.pid}`)), true, 'A must still be in-flight while B finishes');
  assert.equal(existsSync(join(markerB, `PROVIDER_CONTACTED_${childB.pid}`)), false, 'S1b-C1: B must not contact the provider');
  assert.equal(existsSync(join(markerB, 'PROVIDER_ENTER_' + childB.pid)), false);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 2)), false, 'B must not activate ordinal 2');
  assert.equal(statusB, 1, `B must fail closed, exit ${statusB}`);
  const errorB = JSON.parse(readFileSync(join(markerB, 'ACQUIRE_ERROR'), 'utf8'));
  assert.equal(errorB.code, 'ACQUIRER_SAME_KEY_IN_FLIGHT');
  assert.equal(existsSync(join(markerA, `PROVIDER_LEAVE_${childA.pid}`)), false, 'A has not terminally resolved yet');
  const contactsBeforeAResolves = [childA.pid, childB.pid].filter((pid) => (
    existsSync(join(markerA, `PROVIDER_CONTACTED_${pid}`)) || existsSync(join(markerB, `PROVIDER_CONTACTED_${pid}`))
  ));
  assert.deepEqual(contactsBeforeAResolves, [childA.pid], 'total provider contacts before A terminally resolves === 1');
  assert.equal(contactsBeforeAResolves.length, 1, 'maxConcurrentProviderCalls === 1');

  writeFileSync(releasePath, 'release');
  const statusA = await new Promise((resolveStatus) => childA.on('exit', (code) => resolveStatus(code)));
  assert.ok(statusA === 1 || statusA === 3, `A retryable terminal exit, got ${statusA}`);
  assert.equal(existsSync(join(markerA, 'RETRYABLE_TERMINAL_EXIT')), true, 'A must stop after the durable retryable terminal');
  const terminal1 = JSON.parse(readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, entry.acquisitionKey, 1), 'utf8'));
  assert.equal(terminal1.attemptState, ATTEMPT_STATE_FAILED_RETRYABLE);
  assert.equal(terminal1.condition, 'TIMEOUT');
  assert.equal(terminal1.retryEligible, true);

  const childC = spawnChild(scriptC);
  t.after(() => {
    childC.kill();
  });
  const statusC = await new Promise((resolveStatus) => childC.on('exit', (code) => resolveStatus(code)));
  assert.equal(statusC, 0, childC.stderr || 'C must succeed on ordinal 2 after durable retryable terminal');
  assert.equal(existsSync(join(markerC, `PROVIDER_CONTACTED_${childC.pid}`)), true, 'S1b-C3: ordinal 2 may contact provider only after durable retryable terminal');
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 2)), true);
  assert.equal(existsSync(join(markerC, 'ACQUIRE_OK')), true);
});

test('P3-R7 execution/network authorization failure occurs before provider construction and before reservation creation', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    authority: resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null }),
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('unauthorized acquire must not construct a provider');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_NOT_AUTHORIZED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
  assert.equal(existsSync(join(acquisitionRoot, 'reservations')), false);
});

test('P3-R8a acquisition root equal or inside the repository fails closed', async (t) => {
  assert.throws(
    () => assertExternalAcquisitionRootR1('relative/path', REPOSITORY_ROOT),
    (error) => error.code === 'ACQUISITION_ROOT_NOT_ABSOLUTE',
  );
  assert.throws(
    () => assertExternalAcquisitionRootR1(REPOSITORY_ROOT, REPOSITORY_ROOT),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.throws(
    () => assertExternalAcquisitionRootR1(join(REPOSITORY_ROOT, 'app', 'jarvise'), REPOSITORY_ROOT),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.throws(
    () => createJarviseYahooFetchOnceAcquirerR1({
      authority: activatedAuthority(temporaryAcquisitionRoot(t)),
      acquisitionRoot: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      permittedAcquisitionKeys: permittedKeys(),
      journal: EMPTY_JOURNAL,
      createProviderClient: () => assert.fail('inside-repo root must not construct a provider'),
    }),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot: REPOSITORY_ROOT,
      executionGrant: TEST_EXECUTION_GRANT,
      createProviderClient: () => assert.fail('runner must not construct a provider for an in-repo root'),
    }),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY' || error.details?.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY' || error.message.includes('ACQUISITION_ROOT_INSIDE_REPOSITORY'),
  );
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      executionGrant: TEST_EXECUTION_GRANT,
    }),
    (error) => error.code === 'RUN_ACQUISITION_ROOT_REQUIRED',
  );
  assert.deepEqual(
    parseJarviseHistoricalFetchOnceArgsR1(['--acquisition-root', 'C:\\outside\\acq']),
    { acquisitionRoot: 'C:\\outside\\acq', executionGrantPath: null, recoveryGrantPath: null },
  );
});

test('P3-R8b acquisition root outside the repository is structurally accepted', (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const accepted = assertExternalAcquisitionRootR1(acquisitionRoot, REPOSITORY_ROOT);
  assert.equal(resolve(accepted), resolve(acquisitionRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => assert.fail('construction alone must not contact a provider'),
  });
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.ok(acquirer.acquisitionRoot);
});

function fakeGitScratch(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'p3-s1b-realpath-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fakeGit = join(scratch, 'fake-git-root');
  mkdirSync(fakeGit);
  writeFileSync(join(fakeGit, 'MARKER.txt'), 'inside-fake-git\n');
  const outside = join(scratch, 'outside');
  mkdirSync(outside);
  const junction = join(outside, 'via-junction');
  symlinkSync(fakeGit, junction, process.platform === 'win32' ? 'junction' : 'dir');
  return { scratch, fakeGit, outside, junction };
}

test('P3-S1b-P1 existing junction into fake gitRoot is refused', (t) => {
  const { fakeGit, junction } = fakeGitScratch(t);
  assert.throws(
    () => assertExternalAcquisitionRootR1(junction, fakeGit),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'S1b-P4: no mkdir side effect under fake gitRoot');
});

test('P3-S1b-P2/P4 nonexistent child through junction is refused before mkdir', (t) => {
  const { fakeGit, junction, outside } = fakeGitScratch(t);
  const candidate = join(junction, 'YahooData');
  assert.equal(existsSync(candidate), false);
  assert.throws(
    () => assertExternalAcquisitionRootR1(candidate, fakeGit),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'validator must not mkdir');
  assert.throws(
    () => createJarviseYahooFetchOnceAcquirerR1({
      authority: activatedAuthority(outside),
      acquisitionRoot: candidate,
      gitRoot: fakeGit,
      permittedAcquisitionKeys: [],
      journal: EMPTY_JOURNAL,
      createProviderClient: () => assert.fail('constructor must not reach provider'),
    }),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'S1b-P4: constructor must not mkdir under fake gitRoot');
  assert.equal(existsSync(candidate), false);
});

test('P3-S1b-P3 normal external real path is accepted against a fake gitRoot', (t) => {
  const { scratch, fakeGit } = fakeGitScratch(t);
  const external = join(scratch, 'real-external', 'YahooData');
  mkdirSync(join(scratch, 'real-external'));
  const accepted = assertExternalAcquisitionRootR1(external, fakeGit);
  assert.equal(resolve(accepted), resolve(external));
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false);
  const acquirer = createJarviseYahooFetchOnceAcquirerR1({
    authority: activatedAuthority(external),
    acquisitionRoot: external,
    gitRoot: fakeGit,
    permittedAcquisitionKeys: permittedKeys(),
    journal: EMPTY_JOURNAL,
    createProviderClient: () => assert.fail('construction alone must not contact a provider'),
  });
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(existsSync(external), true);
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false);
});

test('P3-S1b-P2 runner does not mkdir a junction child before containment proof', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'p3-s1b-runner-'));
  const fakeGit = join(scratch, 'fake-git-root');
  mkdirSync(fakeGit);
  const outside = join(scratch, 'outside');
  mkdirSync(outside);
  const junction = join(outside, 'via-junction');
  symlinkSync(fakeGit, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const candidate = join(junction, 'YahooData');
  try {
    await assert.rejects(
      () => runJarviseHistoricalFetchOnceR1({
        gitRoot: fakeGit,
        acquisitionRoot: candidate,
        executionGrant: TEST_EXECUTION_GRANT,
        createProviderClient: () => assert.fail('runner must not construct a provider'),
      }),
      (error) => error.code === 'RUN_GIT_ROOT_INJECTION_FORBIDDEN',
    );
    assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'runner write-before-check is forbidden');
    assert.equal(existsSync(candidate), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function p3eHttpError(code) {
  const error = new Error(`p3e stub HTTP ${code}`);
  error.name = 'HTTPError';
  error.code = code;
  return error;
}

test('P3E-T2 no grant means zero provider-factory creation', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    authority: resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null }),
    createProviderClient: async () => {
      factoryCalls += 1;
      assert.fail('P3E-T2 factory must not run without a grant');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_NOT_AUTHORIZED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(acquirer.providerClientConstructed(), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
});

test('P3E-T3 unsafe acquisition root means zero provider-factory creation', async (t) => {
  let factoryCalls = 0;
  assert.throws(
    () => createJarviseYahooFetchOnceAcquirerR1({
      authority: activatedAuthority(temporaryAcquisitionRoot(t)),
      acquisitionRoot: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      permittedAcquisitionKeys: permittedKeys(),
      journal: EMPTY_JOURNAL,
      createProviderClient: async () => {
        factoryCalls += 1;
        assert.fail('P3E-T3 factory must not run for an in-repo root');
      },
    }),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.equal(factoryCalls, 0);
});

test('P3E-T4 invalid grant means zero provider-factory creation', async (t) => {
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      executionGrant: { ...TEST_EXECUTION_GRANT, preparedAuthoritySha256: 'f'.repeat(64) },
    }),
    (error) => error.code === 'EXECUTION_GRANT_BINDING_MISMATCH',
  );
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot,
      executionGrant: { ...TEST_EXECUTION_GRANT, networkAuthorized: false },
      createProviderClient: async () => {
        factoryCalls += 1;
        assert.fail('P3E-T4 factory must not run for an invalid grant');
      },
    }),
    (error) => error.code === 'EXECUTION_GRANT_INVALID' || error.message.includes('EXECUTION_GRANT_INVALID'),
  );
  assert.equal(factoryCalls, 0);
});

test('P3E-T5 valid authority but reservation cannot be acquired means zero chart call', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const reservationsRoot = join(acquisitionRoot, 'reservations');
  mkdirSync(reservationsRoot, { recursive: true });
  for (let index = 0; index < STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT; index += 1) {
    const hex = createHash('sha256').update(`p3e-t5-seed-${index}`, 'utf8').digest('hex');
    const dir = join(reservationsRoot, hex);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.json'), `${JSON.stringify({ schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/1', seed: index })}\n`, { flag: 'wx' });
  }
  let factoryCalls = 0;
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: async () => {
      factoryCalls += 1;
      return {
        chart: async () => {
          chartCalls += 1;
          assert.fail('P3E-T5 chart must not run when a reservation cannot be acquired');
        },
      };
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_INVOCATION_CEILING_REACHED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(chartCalls, 0);
  assert.equal(acquirer.providerClientConstructed(), false);
});

test('P3E-T6 factory is invoked only after a durable reservation is committed', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const entry = planEntry();
  const events = [];
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: async () => {
      events.push({
        at: 'factory',
        reserved: countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey),
      });
      return {
        chart: async (symbol, params) => {
          events.push({
            at: 'chart',
            reserved: countDurableAttemptsForKeyR1(acquisitionRoot, entry.acquisitionKey),
            symbol,
            params,
          });
          return chartFor(symbol);
        },
      };
    },
  });
  const bytes = await acquirer.acquireRawBytesFor(entry);
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(events.length, 2);
  assert.equal(events[0].at, 'factory');
  assert.equal(events[0].reserved, 1);
  assert.equal(events[1].at, 'chart');
  assert.equal(events[1].reserved, 1);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 1)), true);
  assert.equal(events[1].symbol, entry.acquisitionRequestIdentity.providerSymbol);
  assert.deepEqual(events[1].params, {
    period1: entry.acquisitionRequestIdentity.period1,
    period2: entry.acquisitionRequestIdentity.period2,
    interval: entry.acquisitionRequestIdentity.interval,
    events: 'div|split',
    return: 'array',
  });
});

test('P3E-T6A concurrent first-client construction remains memoized to one client', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const gate = { release: null };
  const hold = new Promise((resolve) => {
    gate.release = resolve;
  });
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: async () => {
      factoryCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await hold;
      inFlight -= 1;
      return {
        chart: async (symbol) => chartFor(symbol),
      };
    },
  });
  const first = acquirer.acquireRawBytesFor(planEntry(0));
  const second = acquirer.acquireRawBytesFor(planEntry(1));
  const started = Date.now();
  while (Date.now() - started < 5_000 && factoryCalls === 0) {
    await delay(10);
  }
  assert.equal(factoryCalls, 1, 'only one factory construction may start');
  gate.release();
  const [bytesA, bytesB] = await Promise.all([first, second]);
  assert.ok(Buffer.isBuffer(bytesA));
  assert.ok(Buffer.isBuffer(bytesB));
  assert.equal(factoryCalls, 1);
  assert.equal(maxInFlight, 1);
  assert.equal(acquirer.providerClientConstructed(), true);
  assert.equal(acquirer.providerInvocations(), 2);
});

test('P3E-T7 exactly one chart invocation per reserved provider invocation', async (t) => {
  const entry = planEntry();
  let factoryCalls = 0;
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: async () => {
      factoryCalls += 1;
      return {
        chart: async (symbol) => {
          chartCalls += 1;
          return chartFor(symbol);
        },
      };
    },
  });
  await acquirer.acquireRawBytesFor(entry);
  assert.equal(factoryCalls, 1);
  assert.equal(chartCalls, 1);
  assert.equal(acquirer.providerInvocations(), 1);
  assert.equal(acquirer.attemptsFor(entry.acquisitionKey), 1);
});

test('P3E-T8 same-key concurrency still permits maximum one provider contact', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const markerA = temporaryAcquisitionRoot(t);
  const markerB = temporaryAcquisitionRoot(t);
  const releasePath = join(markerA, 'RELEASE');
  writeFileSync(join(markerA, 'child-a.mjs'), childScript({
    mode: 'hold-in-flight', acquisitionRoot, markerDir: markerA, releasePath,
  }));
  writeFileSync(join(markerB, 'child-b.mjs'), childScript({
    mode: 'success', acquisitionRoot, markerDir: markerB,
  }));
  const childA = spawnChild(join(markerA, 'child-a.mjs'));
  t.after(() => {
    childA.kill();
  });
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline && !existsSync(join(markerA, `IN_FLIGHT_${childA.pid}`))) {
    await delay(50);
  }
  assert.equal(existsSync(join(markerA, `PROVIDER_CONTACTED_${childA.pid}`)), true, 'A must contact the provider stub');
  const childB = spawnChild(join(markerB, 'child-b.mjs'));
  t.after(() => {
    childB.kill();
  });
  const statusB = await new Promise((resolveStatus) => childB.on('exit', (code) => resolveStatus(code)));
  assert.notEqual(statusB, 0);
  assert.equal(existsSync(join(markerB, `PROVIDER_CONTACTED_${childB.pid}`)), false, 'B must not contact the provider');
  writeFileSync(releasePath, '1');
  await new Promise((resolveStatus) => childA.on('exit', (code) => resolveStatus(code)));
});

test('P3E-T9 timeout conditions remain retryable TIMEOUT through the factory wrapper', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => createJarviseYahooFinance2ChartClientR1({
      loadYahooFinance2: async () => ({
        default: class {
          async chart() {
            chartCalls += 1;
            throw p3eTransportError('ETIMEDOUT');
          }
        },
      }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED',
  );
  assert.equal(chartCalls, 3);
  const classified = classifyAcquisitionFailureR1(p3eTransportError('ETIMEDOUT'));
  assert.equal(classified.condition, 'TIMEOUT');
  assert.equal(classified.retryEligible, true);
});

test('P3E-T10 HTTPError 429 is classified PROVIDER_RATE_LIMITED / retryable', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => createJarviseYahooFinance2ChartClientR1({
      loadYahooFinance2: async () => ({
        default: class {
          async chart() {
            chartCalls += 1;
            throw p3eHttpError(429);
          }
        },
      }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED',
  );
  assert.equal(chartCalls, 3);
  const classified = classifyAcquisitionFailureR1(projectYahooFinance2HttpErrorR1(p3eHttpError(429)));
  assert.equal(classified.condition, 'PROVIDER_RATE_LIMITED');
  assert.equal(classified.retryEligible, true);
});

test('P3E-T11 HTTPError 5xx is classified PROVIDER_SERVER_ERROR / retryable', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => createJarviseYahooFinance2ChartClientR1({
      loadYahooFinance2: async () => ({
        default: class {
          async chart() {
            chartCalls += 1;
            throw p3eHttpError(502);
          }
        },
      }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED',
  );
  assert.equal(chartCalls, 3);
  const classified = classifyAcquisitionFailureR1(projectYahooFinance2HttpErrorR1(p3eHttpError(502)));
  assert.equal(classified.condition, 'PROVIDER_SERVER_ERROR');
  assert.equal(classified.retryEligible, true);
});

test('P3E-T12 malformed provider response remains terminal / fail-closed', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => createJarviseYahooFinance2ChartClientR1({
      loadYahooFinance2: async () => ({
        default: class {
          async chart() {
            chartCalls += 1;
            return null;
          }
        },
      }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_FAIL_CLOSED' && error.details.condition === 'MALFORMED_PROVIDER_RESULT',
  );
  assert.equal(chartCalls, 1);
});

test('P3E-T13 empty provider result remains terminal / fail-closed', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => createJarviseYahooFinance2ChartClientR1({
      loadYahooFinance2: async () => ({
        default: class {
          async chart(symbol) {
            chartCalls += 1;
            return { meta: { symbol }, quotes: [], events: { dividends: [], splits: [] } };
          }
        },
      }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_FAIL_CLOSED' && error.details.condition === 'EMPTY_PROVIDER_RESULT',
  );
  assert.equal(chartCalls, 1);
});

test('P3E-T14 RAW_PINNED prevents provider factory and chart refetch', async (t) => {
  const store = temporaryStore(t);
  const journal = createJarviseSnapshotMemoryJournalR1();
  const authority = activatedAuthority(temporaryAcquisitionRoot(t));
  const entry = planEntry();
  const bytes = canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol));
  const persistence = createJarviseSnapshotPersistenceR1({ store, journal, acquisitionAuthority: authority });
  persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition: {
      sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
      ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
      acquisitionMethod: ACQUISITION_METHOD,
      acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
      acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
      acquisitionEvidenceIds: [],
    },
    acquireRawBytes: () => bytes,
  });
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    journal,
    createProviderClient: async () => {
      factoryCalls += 1;
      assert.fail('P3E-T14 RAW_PINNED must not construct a factory client');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_REFETCH_FORBIDDEN',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(acquirer.providerClientConstructed(), false);
});

test('P3E programmatic runner still fail-closes when createProviderClient is omitted', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const summary = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    executionGrant: testExecutionGrant(acquisitionRoot),
    limit: 1,
  });
  assert.equal(summary.failed, 1);
  assert.equal(summary.acquired, 0);
  assert.equal(summary.results[0].error.code === 'ACQUIRER_FAIL_CLOSED' || summary.results[0].error.code === 'ACQUIRER_PROVIDER_UNAVAILABLE', true);
});

function fakeChartFactory(events) {
  return () => {
    events.factoryCalls += 1;
    return {
      chart: async (symbol) => {
        events.chartCalls += 1;
        return chartFor(symbol);
      },
    };
  };
}

function windowsEquivalentSpellings(absPath) {
  const trimmed = absPath.replace(/[\\/]+$/, '');
  const slash = trimmed.replaceAll('\\', '/');
  const backslash = trimmed.replaceAll('/', '\\');
  const match = trimmed.match(/^([A-Za-z]):(.*)$/);
  const driveUpper = match ? `${match[1].toUpperCase()}:${match[2]}` : trimmed;
  const driveLower = match ? `${match[1].toLowerCase()}:${match[2]}` : trimmed;
  return [
    trimmed,
    `${trimmed}${sep}`,
    slash,
    `${slash}/`,
    backslash,
    `${backslash}\\`,
    driveUpper,
    driveLower,
  ];
}

test('P3F-T1 correct bound root activates', (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const authority = resolveEffectiveAcquisitionAuthorityR1({
    root: REPOSITORY_ROOT,
    gitRoot: REPOSITORY_ROOT,
    acquisitionRoot,
    executionGrant: testExecutionGrant(acquisitionRoot),
  });
  assert.equal(authority.activated, true);
  assert.equal(authority.executionAuthorized, true);
  assert.equal(authority.networkAuthorized, true);
  assert.equal(authority.reasonCode, null);
  assert.ok(typeof authority.boundAcquisitionRoot === 'string');
});

test('P3F-T2 missing grant acquisitionRoot is EXECUTION_GRANT_ACQUISITION_ROOT_REQUIRED', (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot,
      executionGrant: { ...TEST_EXECUTION_GRANT },
    }),
    (error) => error.code === 'EXECUTION_GRANT_ACQUISITION_ROOT_REQUIRED',
  );
});

test('P3F-T3 wrong root is EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH', (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const otherRoot = temporaryAcquisitionRoot(t);
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: otherRoot,
      executionGrant: testExecutionGrant(boundRoot),
    }),
    (error) => error.code === 'EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH',
  );
});

test('P3F-T4/T5/T6 wrong root fails before mkdir, reservation, and provider factory', async (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const parent = mkdtempSync(join(tmpdir(), 'p3f-wrong-root-parent-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const missingTarget = join(parent, 'missing-target-root');
  let factoryCalls = 0;
  assert.equal(existsSync(missingTarget), false);
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot: missingTarget,
      executionGrant: testExecutionGrant(boundRoot),
      createProviderClient: () => {
        factoryCalls += 1;
        assert.fail('wrong root must not reach the provider factory');
      },
    }),
    (error) => error.code === 'EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH',
  );
  assert.equal(existsSync(missingTarget), false, 'P3F-T4: target root must not be created');
  assert.equal(existsSync(join(missingTarget, 'reservations')), false, 'P3F-T5: no reservation directory');
  assert.equal(countDurableAttemptReservationsR1(missingTarget), 0);
  assert.equal(factoryCalls, 0, 'P3F-T6: provider factory must not run');
});

test('P3F-T7 equivalent Windows spellings of the same physical destination activate', (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const grant = testExecutionGrant(acquisitionRoot);
  const spellings = windowsEquivalentSpellings(acquisitionRoot);
  for (const spelling of spellings) {
    const authority = resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: spelling,
      executionGrant: grant,
    });
    assert.equal(authority.activated, true, `equivalent spelling must activate: ${spelling}`);
  }
});

test('P3F-T8 distinct physical destination is refused', (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const otherRoot = temporaryAcquisitionRoot(t);
  assert.notEqual(resolve(boundRoot).toLowerCase(), resolve(otherRoot).toLowerCase());
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: otherRoot,
      executionGrant: testExecutionGrant(boundRoot),
    }),
    (error) => error.code === 'EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH',
  );
});

test('P3F-T9/T10/T11 same grant and bound root may resume, reuse partial state, and continue reservation count', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const grant = testExecutionGrant(acquisitionRoot);
  const events = { factoryCalls: 0, chartCalls: 0 };
  const first = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    executionGrant: grant,
    createProviderClient: fakeChartFactory(events),
    limit: 1,
  });
  assert.equal(first.cohortStatus, 'PARTIAL_RESUMABLE');
  assert.equal(first.acquired, 1);
  assert.equal(first.reused, 0);
  assert.equal(first.providerInvocations, 1);
  assert.equal(events.factoryCalls, 1);
  assert.equal(events.chartCalls, 1);
  const second = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    executionGrant: grant,
    createProviderClient: fakeChartFactory(events),
    limit: 1,
  });
  assert.equal(second.cohortStatus, 'PARTIAL_RESUMABLE');
  assert.equal(second.acquired, 0);
  assert.equal(second.reused, 1);
  assert.equal(second.providerInvocations, 1, 'durable reservation count continues across resume');
  assert.equal(events.factoryCalls, 1, 'RAW_PINNED resume must not construct a second factory');
  assert.equal(events.chartCalls, 1, 'RAW_PINNED resume must not refetch');
});

test('P3F-T12 another root cannot reset budget because mismatch occurs before reservation', async (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const events = { factoryCalls: 0, chartCalls: 0 };
  const first = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot: boundRoot,
    executionGrant: testExecutionGrant(boundRoot),
    createProviderClient: fakeChartFactory(events),
    limit: 1,
  });
  assert.equal(first.providerInvocations, 1);
  const otherParent = mkdtempSync(join(tmpdir(), 'p3f-other-root-parent-'));
  t.after(() => rmSync(otherParent, { recursive: true, force: true }));
  const otherRoot = join(otherParent, 'unbound-mission-root');
  let otherFactoryCalls = 0;
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot: otherRoot,
      executionGrant: testExecutionGrant(boundRoot),
      createProviderClient: () => {
        otherFactoryCalls += 1;
        assert.fail('mismatched root must not reach the provider factory');
      },
    }),
    (error) => error.code === 'EXECUTION_GRANT_ACQUISITION_ROOT_MISMATCH',
  );
  assert.equal(existsSync(otherRoot), false);
  assert.equal(countDurableAttemptReservationsR1(otherRoot), 0);
  assert.equal(otherFactoryCalls, 0);
  assert.equal(countDurableAttemptReservationsR1(boundRoot), 1);
});

test('P3F-T13 wrong preparedAuthoritySha256 retains EXECUTION_GRANT_BINDING_MISMATCH precedence', (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const otherRoot = temporaryAcquisitionRoot(t);
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: otherRoot,
      executionGrant: {
        ...TEST_EXECUTION_GRANT,
        preparedAuthoritySha256: 'a'.repeat(64),
        acquisitionRoot: boundRoot,
      },
    }),
    (error) => error.code === 'EXECUTION_GRANT_BINDING_MISMATCH',
  );
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      executionGrant: { ...TEST_EXECUTION_GRANT, preparedAuthoritySha256: 'b'.repeat(64) },
    }),
    (error) => error.code === 'EXECUTION_GRANT_BINDING_MISMATCH',
  );
});

test('P3F-T14 false authorization booleans retain EXECUTION_GRANT_INVALID precedence', (t) => {
  const boundRoot = temporaryAcquisitionRoot(t);
  const otherRoot = temporaryAcquisitionRoot(t);
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: otherRoot,
      executionGrant: testExecutionGrant(boundRoot, { executionAuthorized: false }),
    }),
    (error) => error.code === 'EXECUTION_GRANT_INVALID',
  );
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: otherRoot,
      executionGrant: testExecutionGrant(boundRoot, { networkAuthorized: false }),
    }),
    (error) => error.code === 'EXECUTION_GRANT_INVALID',
  );
  assert.throws(
    () => resolveEffectiveAcquisitionAuthorityR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      executionGrant: { ...TEST_EXECUTION_GRANT, executionAuthorized: false },
    }),
    (error) => error.code === 'EXECUTION_GRANT_INVALID',
  );
});

test('P3F-T15 current retry ceiling remains 3', async (t) => {
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async () => {
        chartCalls += 1;
        throw p3eTransportError('ETIMEDOUT');
      },
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_BUDGET_EXHAUSTED',
  );
  assert.equal(STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY, 3);
  assert.equal(preparedAuthority.preparedGrant.maxAttemptsPerEmptyKey, 3);
  assert.equal(chartCalls, 3);
  assert.equal(acquirer.providerInvocations(), 3);
});

test('P3F-T16 current provider invocation ceiling remains 2406', async (t) => {
  assert.equal(STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT, 2406);
  assert.equal(preparedAuthority.preparedGrant.maxProviderInvocationCount, 2406);
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const reservationsRoot = join(acquisitionRoot, 'reservations');
  mkdirSync(reservationsRoot, { recursive: true });
  for (let index = 0; index < STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT; index += 1) {
    const hex = createHash('sha256').update(`p3f-t16-seed-${index}`, 'utf8').digest('hex');
    mkdirSync(join(reservationsRoot, hex), { recursive: true });
    writeFileSync(join(reservationsRoot, hex, '1.json'), `${JSON.stringify({ schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/1', seed: index })}\n`, { flag: 'wx' });
  }
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('ceiling must refuse before factory');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_INVOCATION_CEILING_REACHED',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 2406);
});

test('P3F-T17 RAW_PINNED no-refetch remains enforced', async (t) => {
  const store = temporaryStore(t);
  const journal = createJarviseSnapshotMemoryJournalR1();
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const authority = activatedAuthority(acquisitionRoot);
  const entry = planEntry();
  const bytes = canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol));
  const persistence = createJarviseSnapshotPersistenceR1({ store, journal, acquisitionAuthority: authority });
  persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition: {
      sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
      ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
      acquisitionMethod: ACQUISITION_METHOD,
      acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
      acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
      acquisitionEvidenceIds: [],
    },
    acquireRawBytes: () => bytes,
  });
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    authority,
    journal,
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('RAW_PINNED must not construct a provider client');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(entry),
    (error) => error.code === 'ACQUIRER_REFETCH_FORBIDDEN',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
});

test('P3F-T18 same-key concurrent provider contact remains max 1', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const markerA = temporaryAcquisitionRoot(t);
  const markerB = temporaryAcquisitionRoot(t);
  const releasePath = join(markerA, 'RELEASE');
  writeFileSync(join(markerA, 'child-a.mjs'), childScript({
    mode: 'hold-in-flight', acquisitionRoot, markerDir: markerA, releasePath,
  }));
  writeFileSync(join(markerB, 'child-b.mjs'), childScript({
    mode: 'success', acquisitionRoot, markerDir: markerB,
  }));
  const childA = spawnChild(join(markerA, 'child-a.mjs'));
  t.after(() => {
    childA.kill();
  });
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline && !existsSync(join(markerA, `IN_FLIGHT_${childA.pid}`))) {
    await delay(50);
  }
  assert.equal(existsSync(join(markerA, `PROVIDER_CONTACTED_${childA.pid}`)), true);
  const childB = spawnChild(join(markerB, 'child-b.mjs'));
  t.after(() => {
    childB.kill();
  });
  const statusB = await new Promise((resolveStatus) => childB.on('exit', (code) => resolveStatus(code)));
  assert.notEqual(statusB, 0);
  assert.equal(existsSync(join(markerB, `PROVIDER_CONTACTED_${childB.pid}`)), false);
  writeFileSync(releasePath, '1');
  await new Promise((resolveStatus) => childA.on('exit', (code) => resolveStatus(code)));
});

test('P3F-T19 failed provider-client construction memoization remains safe', async (t) => {
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    createProviderClient: async () => {
      factoryCalls += 1;
      throw new Error('injected factory construction failure');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry(0)),
    (error) => error.code === 'ACQUIRER_FAIL_CLOSED',
  );
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry(1)),
    (error) => error.code === 'ACQUIRER_FAIL_CLOSED',
  );
  assert.equal(factoryCalls, 2, 'a failed construction must not be sticky across later reservations');
  assert.equal(acquirer.providerClientConstructed(), false);
});

test('P3F-T20 no Yahoo or network is required by these tests', () => {
  const acquirerSource = readFileSync(ACQUIRER_MODULE_PATH, 'utf8');
  const testSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal(/^\s*import\s+['\"]yahoo-finance2['\"]/m.test(acquirerSource), false);
  assert.equal(/^\s*import\s+['\"]yahoo-finance2['\"]/m.test(testSource), false);
  assert.equal(/\bfetch\s*\(/.test(testSource), false);
  assert.equal(preparedAuthority.networkAuthorized, false);
  assert.equal(preparedAuthority.executionAuthorized, false);
});

function p3hGrantFields(acquisitionRoot) {
  return {
    schemaVersion: 'JarviseYahooIncidentRecoveryAuthorization/1',
    mechanism: 'OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
    recoveryMechanismVersion: 'jarviseYahooIncidentRecoveryR1/1',
    incidentRecoveryId: 'P3G_ZERO_HTTP_MALFORMED_802_R1',
    grantId: 'P3H-TEST-GRANT',
    issuedAt: '2026-09-07T00:00:00.000Z',
    issuedBy: 'PROJECT_OWNER',
    decisionType: 'PROJECT_OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
    preparedAuthoritySha256: CANONICAL_PREPARED_AUTHORITY_SHA256,
    providerLibraryVersion: '3.14.0',
    acquisitionRoot,
    digestAlgorithmIds: {
      incidentEvidenceDigest: 'JarviseYahooIncidentOrdinal1EvidenceDigest/1',
      reservationsOnlyDigest: 'JarviseYahooIncidentOrdinal1ReservationsDigest/1',
      terminalsOnlyDigest: 'JarviseYahooIncidentOrdinal1TerminalsDigest/1',
      cohort802KeyDigest: 'JarviseYahooIncidentCohort802KeyDigest/1',
    },
    incidentEvidenceDigest: '8af220d4b119a8b6eca03f06a50422f93c46ef8b3885cadbca6dd96e33026bea',
    reservationsOnlyDigest: 'ed7518ee18455a6179ba8022ec2e52f02a332d8d4a4dce13379ea7887677e0b7',
    terminalsOnlyDigest: '537e45b485522eb522821225cc873ef40d0e503b40042763c1a47556e7f93705',
    cohort802KeyDigest: '1372f49e8b032d99e3480332a15a413b1431e27502756fe4e5d7590b5d23bc5b',
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
  };
}

function seedOrdinal1Terminal(acquisitionRoot, entry, extra = {}) {
  const reservationPath = jarviseAttemptReservationPathR1(acquisitionRoot, entry.acquisitionKey, 1);
  const terminalPath = jarviseAttemptTerminalPathR1(acquisitionRoot, entry.acquisitionKey, 1);
  mkdirSync(dirname(reservationPath), { recursive: true });
  const reservation = {
    schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/1',
    acquisitionKey: entry.acquisitionKey,
    attemptOrdinal: 1,
    attemptState: 'IN_FLIGHT',
    ownerPid: process.pid,
    createdAt: '2026-09-05T12:00:00.000Z',
    acquisitionRequestIdentityHash: 'sha256:deadbeef',
    authorityId: preparedAuthority.authorityId,
    preparedAuthoritySha256: preparedSha256,
  };
  writeFileSync(reservationPath, `${JSON.stringify(reservation, null, 2)}\n`);
  const terminal = {
    schemaVersion: 'JarviseYahooFetchOnceAttemptTerminal/1',
    acquisitionKey: entry.acquisitionKey,
    attemptOrdinal: 1,
    attemptState: ATTEMPT_STATE_FAILED_TERMINAL,
    condition: 'MALFORMED_PROVIDER_RESULT',
    retryEligible: false,
    ownerPid: process.pid,
    ...extra,
  };
  writeFileSync(terminalPath, `${JSON.stringify(terminal, null, 2)}\n`);
  return { reservationPath, terminalPath };
}

function p3hHttpCapture(status, extra = {}) {
  const error = new Error(`finance.error stub ${status}`);
  error.p3eHttpCapture = Object.freeze({ responseSeen: true, responseStatus: status });
  error.p3eOwnedTimeoutAbort = false;
  Object.assign(error, extra);
  return error;
}

test('P3H-T1 mutable copy after reservation; canonical frozen ISO intact', async (t) => {
  const seen = [];
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async (_symbol, params) => {
        seen.push(params);
        return chartFor('X');
      },
    }),
  });
  const identity = planEntry().acquisitionRequestIdentity;
  const canonical = canonicalChartParamsR1(identity);
  await acquirer.acquireRawBytesFor(planEntry());
  assert.equal(seen.length, 1);
  assert.notEqual(seen[0], canonical);
  assert.equal(Object.isFrozen(canonical), true);
  assert.equal(canonical.period1, '2018-01-01T00:00:00.000Z');
  assert.equal(canonical.period2, '2026-09-05T00:00:00.000Z');
  assert.equal(canonical.interval, '1d');
  assert.equal(canonical.events, 'div|split');
  assert.equal(canonical.return, 'array');
});

test('P3H-T2 frozen canonical is a distinct object from the mutable provider copy', () => {
  const canonical = canonicalChartParamsR1(planEntry().acquisitionRequestIdentity);
  const mutable = mutableProviderChartParamsR1(canonical);
  assert.notEqual(mutable, canonical);
  mutable.period1 = new Date();
  assert.equal(canonical.period1, '2018-01-01T00:00:00.000Z');
});

test('P3H-T5/T6/T7/T11/T12/T14 HTTP and finance.error classification', () => {
  const rate = classifyAcquisitionFailureR1(p3hHttpCapture(429));
  assert.equal(rate.condition, 'PROVIDER_RATE_LIMITED');
  assert.equal(rate.retryEligible, true);
  const server = classifyAcquisitionFailureR1(p3hHttpCapture(503));
  assert.equal(server.condition, 'PROVIDER_SERVER_ERROR');
  const schema = classifyAcquisitionFailureR1(p3hHttpCapture(404));
  assert.equal(schema.condition, 'SCHEMA_FAILURE');
  const malformed200 = classifyAcquisitionFailureR1(p3hHttpCapture(200));
  assert.equal(malformed200.condition, 'MALFORMED_PROVIDER_RESULT');
  assert.equal(malformed200.retryEligible, false);
  const unknown = classifyAcquisitionFailureR1(new Error('nope'));
  assert.equal(unknown.condition, 'MALFORMED_PROVIDER_RESULT');
  const http429 = providerError(null, 429);
  http429.name = 'HTTPError';
  http429.code = 429;
  http429.status = 429;
  assert.equal(classifyAcquisitionFailureR1(http429).condition, 'PROVIDER_RATE_LIMITED');
});

test('P3H-T8 unowned AbortError is MALFORMED', () => {
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  abort.p3eTransportFailure = { source: 'P3E_PER_CALL_FETCH', code: 'ABORT_ERR' };
  abort.p3eOwnedTimeoutAbort = false;
  assert.equal(classifyAcquisitionFailureR1(abort).retryEligible, false);
});

test('P3H-T9 real-shape TypeError cause.code ETIMEDOUT is TIMEOUT at per-call fetch', () => {
  const error = new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT' } });
  assert.equal(extractP3ePerCallFetchTransportCodeR1(error), 'ETIMEDOUT');
  error.p3eTransportFailure = { source: 'P3E_PER_CALL_FETCH', code: extractP3ePerCallFetchTransportCodeR1(error) };
  assert.equal(classifyAcquisitionFailureR1(error).condition, 'TIMEOUT');
});

test('P3H-T10 ENOTFOUND is MALFORMED', () => {
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ENOTFOUND')).retryEligible, false);
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ECONNREFUSED')).retryEligible, false);
});

test('P3H-T13 empty quotes remain EMPTY_PROVIDER_RESULT', async (t) => {
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async (symbol) => ({ meta: { symbol }, quotes: [], events: { dividends: [], splits: [] } }),
    }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.details.condition === 'EMPTY_PROVIDER_RESULT',
  );
});

test('P3H-T15 without recovery grant ordinal1 FAILED_TERMINAL blocks ordinal2', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_NOT_AUTHORIZED' || error.code === 'ACQUIRER_RECOVERY_GRANT_REQUIRED',
  );
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), false);
});

test('P3H-T16 exact waiver match creates exactly one ordinal2', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({ chart: async () => chartFor(planEntry().acquisitionRequestIdentity.providerSymbol) }),
  });
  const bytes = await acquirer.acquireRawBytesFor(planEntry());
  assert.equal(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, true);
  const reservation2 = JSON.parse(readFileSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2), 'utf8'));
  assert.equal(reservation2.schemaVersion, ATTEMPT_RESERVATION_SCHEMA_VERSION_V2);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
});

test('P3H-T17 second ordinal2 is write-once', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({ chart: async () => chartFor(planEntry().acquisitionRequestIdentity.providerSymbol) }),
  });
  await acquirer.acquireRawBytesFor(planEntry());
  await assert.rejects(() => acquirer.acquireRawBytesFor(planEntry()));
});

test('P3H-T18 ordinal2 FAILED_RETRYABLE permits ordinal3; grant does not authorize it directly', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  let calls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({
      chart: async () => {
        calls += 1;
        if (calls === 1) throw p3eTransportError('ETIMEDOUT');
        return chartFor(planEntry().acquisitionRequestIdentity.providerSymbol);
      },
    }),
  });
  await acquirer.acquireRawBytesFor(planEntry());
  assert.equal(calls, 2);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), true);
});

test('P3H-T19/T37 ordinal2 FAILED_TERMINAL never waives to ordinal3', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({
      chart: async () => {
        throw p3hHttpCapture(404);
      },
    }),
  });
  await assert.rejects(() => acquirer.acquireRawBytesFor(planEntry()), (error) => error.code === 'ACQUIRER_FAIL_CLOSED');
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
});

test('P3H-T20 RAW_PINNED local continuation without recovery grant never constructs provider', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const grant = testExecutionGrant(acquisitionRoot);
  const events = { factoryCalls: 0, chartCalls: 0 };
  await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    executionGrant: grant,
    createProviderClient: fakeChartFactory(events),
    limit: 1,
  });
  let secondFactory = 0;
  const summary = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    executionGrant: grant,
    createProviderClient: async () => {
      secondFactory += 1;
      throw new Error('provider factory must not be constructed');
    },
    limit: 1,
  });
  assert.equal(secondFactory, 0);
  assert.equal(summary.results[0].stage, 'VERSION_CACHED');
  assert.equal(summary.reused, 1);
});

test('P3H-T21 digest/root mismatch fail closed with zero ordinal2', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const otherRoot = temporaryAcquisitionRoot(t);
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(otherRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(() => acquirer.acquireRawBytesFor(planEntry()));
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), false);
});

test('P3H-T24/T26/T44 budget remains 802×3=2406 with a single counter and no refund', async (t) => {
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({ chart: async () => chartFor('X') }),
  });
  assert.equal(acquirer.describe().maxProviderInvocationCount, 2406);
  assert.equal(acquirer.providerInvocations(), acquirer.durableProviderAttemptReservations());
  await acquirer.acquireRawBytesFor(planEntry());
  assert.equal(acquirer.providerInvocations(), 1);
  assert.equal(acquirer.remainingInvocationBudget(), 2405);
});

test('P3H-T33 fresh mutable copy per ordinal uses ISO strings not mutated Dates', async (t) => {
  const seen = [];
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({
      chart: async (_symbol, params) => {
        seen.push({ period1: params.period1, period2: params.period2 });
        params.period1 = new Date(params.period1);
        throw p3eTransportError('ETIMEDOUT');
      },
    }),
  });
  await assert.rejects(() => acquirer.acquireRawBytesFor(planEntry()));
  assert.equal(seen.length, 3);
  for (const item of seen) {
    assert.equal(typeof item.period1, 'string');
    assert.equal(item.period1, '2018-01-01T00:00:00.000Z');
  }
});

test('P3H-T35 retryable transport set is exact; unknown is MALFORMED', () => {
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']) {
    assert.equal(classifyAcquisitionFailureR1(p3eTransportError(code)).condition, 'TIMEOUT');
  }
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ESOCKETTIMEDOUT')).retryEligible, false);
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('UND_ERR_BODY_TIMEOUT')).retryEligible, false);
});

test('P3H-T36 free-text timeout message is not retryable', () => {
  const error = new Error('request timed out');
  assert.equal(classifyAcquisitionFailureR1(error).retryEligible, false);
});

test('P3H-T49/T50 per-call fetch cells do not leak HTTP status', async () => {
  let call = 0;
  const FakeYahooFinance = class {
    async chart(_symbol, _params, moduleOptions) {
      const status = call === 0 ? 429 : 200;
      call += 1;
      const perCallFetch = moduleOptions['fetch'];
      await perCallFetch(`https://example.invalid/${status}`, {});
      throw Object.assign(new Error('finance.error'), {});
    }
  };
  let fetchCall = 0;
  const client = await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
    fetch: async () => {
      const status = fetchCall === 0 ? 429 : 200;
      fetchCall += 1;
      return { status, headers: { getSetCookie: () => [] }, text: async () => '{}' };
    },
  });
  await assert.rejects(
    () => client.chart('A', {}),
    (error) => error.p3eHttpCapture.responseStatus === 429,
  );
  await assert.rejects(
    () => client.chart('B', {}),
    (error) => {
      assert.equal(error.p3eHttpCapture.responseStatus, 200);
      assert.equal(classifyAcquisitionFailureR1(error).condition, 'MALFORMED_PROVIDER_RESULT');
      return true;
    },
  );
});

test('P3H-T51 forged ordinal2 without live grant and malformed tuple fail closed', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const reservation2 = jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2);
  mkdirSync(dirname(reservation2), { recursive: true });
  const snapshotRes = JSON.parse(readFileSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 1)));
  const snapshotTerm = JSON.parse(readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 1)));
  const resBytes = readFileSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 1));
  const termBytes = readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 1));
  writeFileSync(reservation2, `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/2',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: 'IN_FLIGHT',
    ownerPid: process.pid,
    createdAt: '2026-09-07T00:00:00.000Z',
    acquisitionRequestIdentityHash: 'sha256:deadbeef',
    authorityId: preparedAuthority.authorityId,
    preparedAuthoritySha256: preparedSha256,
    recoveryProvenance: {
      schemaVersion: 'JarviseYahooIncidentRecoveryProvenance/1',
      mechanism: 'OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
      incidentRecoveryId: 'P3G_ZERO_HTTP_MALFORMED_802_R1',
      recoveryGrantId: 'FORGED',
      recoveryGrantSha256: 'a'.repeat(64),
      recoveryImplementationManifestSchemaVersion: 'TransformImplementationManifest/1',
      recoveryImplementationManifestDigest: 'a'.repeat(64),
      preparedAuthoritySha256: CANONICAL_PREPARED_AUTHORITY_SHA256,
      incidentEvidenceDigest: '8af220d4b119a8b6eca03f06a50422f93c46ef8b3885cadbca6dd96e33026bea',
      cohort802KeyDigest: '1372f49e8b032d99e3480332a15a413b1431e27502756fe4e5d7590b5d23bc5b',
      acquisitionKey: planEntry().acquisitionKey,
      attemptOrdinal: 2,
      permittedFromIncidentOrdinal: 1,
      ordinal1Reservation: {
        relPath: `reservations/${createHash('sha256').update(planEntry().acquisitionKey, 'utf8').digest('hex')}/1.json`,
        sha256: createHash('sha256').update(resBytes).digest('hex'),
        byteLength: resBytes.byteLength,
      },
      ordinal1Terminal: {
        relPath: `reservations/${createHash('sha256').update(planEntry().acquisitionKey, 'utf8').digest('hex')}/1.terminal.json`,
        sha256: createHash('sha256').update(termBytes).digest('hex'),
        byteLength: termBytes.byteLength,
      },
    },
  }, null, 2)}\n`);
  writeFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 2), `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptTerminal/1',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: ATTEMPT_STATE_FAILED_RETRYABLE,
    condition: 'TIMEOUT',
    retryEligible: true,
    ownerPid: process.pid,
  }, null, 2)}\n`);
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RECOVERY_GRANT_REQUIRED',
  );
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);

  const hostileRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(hostileRoot, planEntry());
  const hostile2 = jarviseAttemptReservationPathR1(hostileRoot, planEntry().acquisitionKey, 2);
  mkdirSync(dirname(hostile2), { recursive: true });
  writeFileSync(hostile2, `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/1',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: 'IN_FLIGHT',
    ownerPid: process.pid,
    createdAt: '2026-09-07T00:00:00.000Z',
    acquisitionRequestIdentityHash: 'sha256:deadbeef',
    authorityId: preparedAuthority.authorityId,
    preparedAuthoritySha256: preparedSha256,
  }, null, 2)}\n`);
  writeFileSync(jarviseAttemptTerminalPathR1(hostileRoot, planEntry().acquisitionKey, 2), `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptTerminal/1',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: ATTEMPT_STATE_FAILED_RETRYABLE,
    condition: 'MALFORMED_PROVIDER_RESULT',
    retryEligible: false,
    ownerPid: process.pid,
  }, null, 2)}\n`);
  const hostile = makeAcquirer(t, {
    acquisitionRoot: hostileRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => hostile.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_ATTEMPT_STATE_INVALID',
  );
});

test('P3H-T52 post-wx ordinal1 mutation is existing MALFORMED terminal only', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const seeded = seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const original = readFileSync(seeded.reservationPath);
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    onAfterOrdinal2Wx: () => {
      writeFileSync(seeded.reservationPath, Buffer.concat([original, Buffer.from(' ')]));
    },
    createProviderClient: () => ({ chart: async () => assert.fail('chart must not run') }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_FAIL_CLOSED' && error.details.condition === 'MALFORMED_PROVIDER_RESULT',
  );
  const terminal2 = JSON.parse(readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 2), 'utf8'));
  assert.equal(terminal2.attemptState, ATTEMPT_STATE_FAILED_TERMINAL);
  assert.equal(terminal2.condition, 'MALFORMED_PROVIDER_RESULT');
  assert.equal(terminal2.retryEligible, false);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
});

test('P3H-T56 structural 802×3 injective domain never names ordinal 4', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3h-t56-'));
  try {
    assert.throws(() => jarviseAttemptReservationPathR1(root, 'k', 4), (error) => error.code === 'ACQUIRER_ATTEMPT_ORDINAL_INVALID');
    assert.equal(STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY * 802, STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT);
    assert.equal(STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT, 2406);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('P3H-T57 AggregateError unanimity at top-level and cause', () => {
  const unanimous = new AggregateError([Object.assign(new Error('a'), { code: 'ETIMEDOUT' }), Object.assign(new Error('b'), { code: 'ETIMEDOUT' })]);
  assert.equal(extractP3ePerCallFetchTransportCodeR1(unanimous), 'ETIMEDOUT');
  const mixed = new AggregateError([Object.assign(new Error('a'), { code: 'ETIMEDOUT' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]);
  mixed.code = 'ETIMEDOUT';
  assert.equal(extractP3ePerCallFetchTransportCodeR1(mixed), null);
  const wrappedMixed = new TypeError('fetch failed', { cause: mixed });
  assert.equal(extractP3ePerCallFetchTransportCodeR1(wrappedMixed), null);
  const simpleCause = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
  assert.equal(extractP3ePerCallFetchTransportCodeR1(simpleCause), 'ECONNRESET');
  assert.equal(classifyAcquisitionFailureR1(Object.assign(new Error('x'), {
    p3eTransportFailure: { source: 'P3E_PER_CALL_FETCH', code: null },
  })).retryEligible, false);
});

test('P3H-T58 live grant removed after ordinal2 exists fail-closes recovery traversal', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const first = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    sleep: async (attemptOrdinal) => {
      if (attemptOrdinal === 2) {
        const error = new Error('stop-after-ordinal2');
        error.code = 'TEST_STOP_AFTER_ORDINAL2';
        throw error;
      }
    },
    createProviderClient: () => ({
      chart: async () => {
        throw p3eTransportError('ETIMEDOUT');
      },
    }),
  });
  await assert.rejects(() => first.acquireRawBytesFor(planEntry()), (error) => error.code === 'TEST_STOP_AFTER_ORDINAL2');
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), true);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
  const second = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => second.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RECOVERY_GRANT_REQUIRED',
  );
});

test('P3H-T3 factory constructor never receives fetch', async () => {
  let constructorOptions = null;
  const FakeYahooFinance = class {
    constructor(options) {
      constructorOptions = options;
    }
    async chart() {
      return {};
    }
  };
  await createJarviseYahooFinance2ChartClientR1({
    loadYahooFinance2: async () => ({ default: FakeYahooFinance }),
    fetch: async () => ({ status: 200, headers: { getSetCookie: () => [] }, text: async () => '{}' }),
  });
  assert.equal(Object.hasOwn(constructorOptions, 'fetch'), false);
  assert.equal(constructorOptions.versionCheck, false);
});

test('P3H-T22/T23/T42 recovery provenance without live grant cannot authorize ordinal3', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const reservation2 = jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2);
  mkdirSync(dirname(reservation2), { recursive: true });
  const resBytes = readFileSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 1));
  const termBytes = readFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 1));
  writeFileSync(reservation2, `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptReservation/2',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: 'IN_FLIGHT',
    ownerPid: process.pid,
    createdAt: '2026-09-07T00:00:00.000Z',
    acquisitionRequestIdentityHash: 'sha256:deadbeef',
    authorityId: preparedAuthority.authorityId,
    preparedAuthoritySha256: preparedSha256,
    recoveryProvenance: {
      schemaVersion: 'JarviseYahooIncidentRecoveryProvenance/1',
      mechanism: 'OWNER_INCIDENT_RECOVERY_AUTHORIZATION',
      incidentRecoveryId: 'P3G_ZERO_HTTP_MALFORMED_802_R1',
      recoveryGrantId: 'FORGED',
      recoveryGrantSha256: 'a'.repeat(64),
      recoveryImplementationManifestSchemaVersion: 'TransformImplementationManifest/1',
      recoveryImplementationManifestDigest: 'a'.repeat(64),
      preparedAuthoritySha256: CANONICAL_PREPARED_AUTHORITY_SHA256,
      incidentEvidenceDigest: '8af220d4b119a8b6eca03f06a50422f93c46ef8b3885cadbca6dd96e33026bea',
      cohort802KeyDigest: '1372f49e8b032d99e3480332a15a413b1431e27502756fe4e5d7590b5d23bc5b',
      acquisitionKey: planEntry().acquisitionKey,
      attemptOrdinal: 2,
      permittedFromIncidentOrdinal: 1,
      ordinal1Reservation: {
        relPath: `reservations/${createHash('sha256').update(planEntry().acquisitionKey, 'utf8').digest('hex')}/1.json`,
        sha256: createHash('sha256').update(resBytes).digest('hex'),
        byteLength: resBytes.byteLength,
      },
      ordinal1Terminal: {
        relPath: `reservations/${createHash('sha256').update(planEntry().acquisitionKey, 'utf8').digest('hex')}/1.terminal.json`,
        sha256: createHash('sha256').update(termBytes).digest('hex'),
        byteLength: termBytes.byteLength,
      },
    },
  }, null, 2)}\n`);
  writeFileSync(jarviseAttemptTerminalPathR1(acquisitionRoot, planEntry().acquisitionKey, 2), `${JSON.stringify({
    schemaVersion: 'JarviseYahooFetchOnceAttemptTerminal/1',
    acquisitionKey: planEntry().acquisitionKey,
    attemptOrdinal: 2,
    attemptState: ATTEMPT_STATE_FAILED_RETRYABLE,
    condition: 'TIMEOUT',
    retryEligible: true,
    ownerPid: process.pid,
  }, null, 2)}\n`);
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RECOVERY_GRANT_REQUIRED',
  );
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
});

test('P3H-T25 recovery grant permittedNextOrdinal cannot skip to ordinal3', () => {
  const grant = p3hGrantFields('C:\\\\abs\\\\root');
  grant.permittedNextOrdinal = 3;
  assert.throws(
    () => parseOwnerIncidentRecoveryGrantObjectR1(grant),
    (error) => error.code === 'RECOVERY_GRANT_WRONG_VALUE',
  );
});

test('P3H-T27 ordinal1 evidence is not deleted or rewritten by a successful waiver', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const seeded = seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const beforeRes = readFileSync(seeded.reservationPath);
  const beforeTerm = readFileSync(seeded.terminalPath);
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({ chart: async () => chartFor(planEntry().acquisitionRequestIdentity.providerSymbol) }),
  });
  await acquirer.acquireRawBytesFor(planEntry());
  assert.deepEqual(readFileSync(seeded.reservationPath), beforeRes);
  assert.deepEqual(readFileSync(seeded.terminalPath), beforeTerm);
});

test('P3H-T34 finance.error is 429 only when this call captured 429', () => {
  const captured = p3hHttpCapture(200);
  assert.equal(classifyAcquisitionFailureR1(captured).condition, 'MALFORMED_PROVIDER_RESULT');
  const unseen = new Error('finance.error');
  unseen.p3eHttpCapture = Object.freeze({ responseSeen: false, responseStatus: 429 });
  assert.equal(classifyAcquisitionFailureR1(unseen).retryEligible, false);
  unseen.p3eHttpCapture = Object.freeze({ responseSeen: true, responseStatus: 429 });
  assert.equal(classifyAcquisitionFailureR1(unseen).condition, 'PROVIDER_RATE_LIMITED');
});

test('P3H-T38/T39/T40/T41 inspectAttempt FAIL CLOSED on malformed state/condition/retry tuples', (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry(), {
    attemptState: ATTEMPT_STATE_FAILED_RETRYABLE,
    condition: 'TIMEOUT',
    retryEligible: false,
  });
  assert.throws(
    () => inspectJarviseAttemptR1(acquisitionRoot, planEntry().acquisitionKey, 1, {
      authority: activatedAuthority(acquisitionRoot),
    }),
    (error) => error.code === 'ACQUIRER_ATTEMPT_STATE_INVALID',
  );
});

test('P3H-T45 computed digest does not itself authorize recovery', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    createProviderClient: () => ({ chart: async () => assert.fail('no chart') }),
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_RETRY_NOT_AUTHORIZED' || error.code === 'ACQUIRER_RECOVERY_GRANT_REQUIRED',
  );
});

test('P3H-T46/T47 budget-claims directory is not a second counter', async (t) => {
  const acquirer = makeAcquirer(t, {
    createProviderClient: () => ({ chart: async () => chartFor('X') }),
  });
  await acquirer.acquireRawBytesFor(planEntry());
  assert.equal(existsSync(join(acquirer.acquisitionRoot, 'budget-claims')), false);
  assert.equal(acquirer.providerInvocations(), acquirer.durableProviderAttemptReservations());
  assert.equal(countDurableAttemptReservationsR1(acquirer.acquisitionRoot), 1);
});

test('P3H-T53 unknown nested retryable-looking transport remains MALFORMED', () => {
  const nested = new Error('outer');
  nested.cause = Object.assign(new Error('inner'), { code: 'ETIMEDOUT' });
  assert.equal(classifyAcquisitionFailureR1(nested).retryEligible, false);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  abort.code = 'ABORT_ERR';
  assert.equal(classifyAcquisitionFailureR1(abort).retryEligible, false);
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ENOTFOUND')).retryEligible, false);
  assert.equal(classifyAcquisitionFailureR1(p3eTransportError('ECONNREFUSED')).retryEligible, false);
  for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']) {
    assert.equal(classifyAcquisitionFailureR1(p3eTransportError(code)).retryEligible, true);
  }
});

function seedOrdinal1IncidentCohort(acquisitionRoot, entries, { omitKey = null, mutateKey = null } = {}) {
  for (const entry of entries) {
    if (omitKey !== null && entry.acquisitionKey === omitKey) continue;
    const seeded = seedOrdinal1Terminal(acquisitionRoot, entry);
    if (mutateKey !== null && entry.acquisitionKey === mutateKey) {
      const original = readFileSync(seeded.reservationPath);
      writeFileSync(seeded.reservationPath, Buffer.concat([original, Buffer.from(' ')]));
    }
  }
}

test('P3H-R4A-A partial incident root fail-closes before chart and reservation', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  let factoryCalls = 0;
  let chartCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    createProviderClient: () => {
      factoryCalls += 1;
      return {
        chart: async () => {
          chartCalls += 1;
          assert.fail('partial incident root must not reach chart');
        },
      };
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'INCIDENT_ROOT_INVALID',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(chartCalls, 0);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), false);
  assert.equal(acquirer.providerClientConstructed(), false);
});

test('P3H-R4A-B altered incident root fail-closes before recovery', { timeout: 120000 }, async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  seedOrdinal1IncidentCohort(acquisitionRoot, plan().entries, { mutateKey: planEntry().acquisitionKey });
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  let factoryCalls = 0;
  const acquirer = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    createProviderClient: () => {
      factoryCalls += 1;
      assert.fail('altered incident root must not construct provider');
    },
  });
  await assert.rejects(
    () => acquirer.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'INCIDENT_ROOT_INVALID',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), false);
});

test('P3H-R4A-C ordinal2 provenance corruption fail-closes with no ordinal3 and no chart', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const seeded = seedOrdinal1Terminal(acquisitionRoot, planEntry());
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  const first = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    sleep: async (attemptOrdinal) => {
      if (attemptOrdinal === 2) {
        const error = new Error('stop-after-ordinal2');
        error.code = 'TEST_STOP_AFTER_ORDINAL2';
        throw error;
      }
    },
    createProviderClient: () => ({
      chart: async () => {
        throw p3eTransportError('ETIMEDOUT');
      },
    }),
  });
  await assert.rejects(() => first.acquireRawBytesFor(planEntry()), (error) => error.code === 'TEST_STOP_AFTER_ORDINAL2');
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 2)), true);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);

  const original = readFileSync(seeded.reservationPath);
  writeFileSync(seeded.reservationPath, Buffer.concat([original, Buffer.from(' ')]));

  let chartCalls = 0;
  const second = makeAcquirer(t, {
    acquisitionRoot,
    recoveryGrant: grant,
    recoveryGrantSha256: 'd'.repeat(64),
    verifyGitBinding: () => {},
    validateIncidentRoot: () => {},
    createProviderClient: () => ({
      chart: async () => {
        chartCalls += 1;
        assert.fail('stale ordinal2 provenance must not reach chart');
      },
    }),
  });
  await assert.rejects(
    () => second.acquireRawBytesFor(planEntry()),
    (error) => error.code === 'ACQUIRER_ORDINAL2_RECOVERY_PROVENANCE_INVALID',
  );
  assert.equal(chartCalls, 0);
  assert.equal(existsSync(jarviseAttemptReservationPathR1(acquisitionRoot, planEntry().acquisitionKey, 3)), false);
});

test('P3H-R4A-D RAW_PINNED production runner continues locally without grants', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const persistenceRoot = resolve(acquisitionRoot, 'observation-snapshots');
  mkdirSync(persistenceRoot, { recursive: true });
  const persistence = createJarviseSnapshotPersistenceR1({
    store: createContentAddressedStore({ root: persistenceRoot }),
    journal: createJarviseSnapshotDirectoryJournalR1({ root: persistenceRoot }),
    acquisitionAuthority: resolveEffectiveAcquisitionAuthorityR1({ root: REPOSITORY_ROOT, executionGrant: null }),
  });
  const entry = planEntry();
  persistence.pinRawOnce({
    acquisitionKey: entry.acquisitionKey,
    acquisition: {
      sourceAcquiredAt: '2026-09-05T12:00:00.000Z',
      ingestedIntoLabAt: '2026-09-05T12:00:01.000Z',
      acquisitionMethod: ACQUISITION_METHOD,
      acquisitionToolVersion: 'runJarviseHistoricalFetchOnceR1/1',
      acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
      acquisitionEvidenceIds: [],
    },
    rawBytes: canonicalProviderResultBytesR1(chartFor(entry.acquisitionRequestIdentity.providerSymbol)),
  });
  assert.equal(persistence.stageOf(entry.acquisitionKey), 'RAW_PINNED');
  const reservationsBefore = countDurableAttemptReservationsR1(acquisitionRoot);
  let factoryCalls = 0;
  let chartCalls = 0;
  const summary = await runJarviseHistoricalFetchOnceR1({
    acquisitionRoot,
    createProviderClient: async () => {
      factoryCalls += 1;
      return {
        chart: async () => {
          chartCalls += 1;
          throw new Error('RAW_PINNED must not chart');
        },
      };
    },
    limit: 1,
  });
  assert.equal(factoryCalls, 0);
  assert.equal(chartCalls, 0);
  assert.equal(summary.results[0].stage, 'VERSION_CACHED');
  assert.equal(summary.reused, 1);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), reservationsBefore, 'RAW_PINNED local continuation must not create a new reservation');
});

test('P3H-R4A-E production runner rejects injected recoveryGrant object', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const grant = parseOwnerIncidentRecoveryGrantObjectR1(p3hGrantFields(acquisitionRoot));
  let factoryCalls = 0;
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot,
      executionGrant: testExecutionGrant(acquisitionRoot),
      recoveryGrant: grant,
      createProviderClient: () => {
        factoryCalls += 1;
        assert.fail('grant-object injection must not construct a provider');
      },
      limit: 1,
    }),
    (error) => error.code === 'RUN_RECOVERY_GRANT_OBJECT_FORBIDDEN',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(existsSync(join(acquisitionRoot, 'reservations')), false);
});

test('P3H-R4A-F production runner rejects injected Git verifier callback', async (t) => {
  const acquisitionRoot = temporaryAcquisitionRoot(t);
  let factoryCalls = 0;
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      acquisitionRoot,
      executionGrant: testExecutionGrant(acquisitionRoot),
      verifyGitBinding: () => true,
      createProviderClient: () => {
        factoryCalls += 1;
        assert.fail('git-verifier injection must not construct a provider');
      },
      limit: 1,
    }),
    (error) => error.code === 'RUN_GIT_VERIFIER_INJECTION_FORBIDDEN',
  );
  assert.equal(factoryCalls, 0);
});

test('P3H-R4A-G production runner rejects foreign gitRoot/root injection before recovery', async (t) => {
  const repoB = mkdtempSync(join(tmpdir(), 'p3h-r4a-g-repo-b-'));
  t.after(() => rmSync(repoB, { recursive: true, force: true }));
  const gitAtB = (args) => {
    const result = spawnSync('git', args, { cwd: repoB, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return (result.stdout ?? '').replace(/\r\n/g, '\n');
  };
  gitAtB(['-c', 'init.defaultBranch=main', 'init']);
  gitAtB(['config', 'user.email', 'r4ag@local']);
  gitAtB(['config', 'user.name', 'R4AG']);
  gitAtB(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repoB, 'tracked.txt'), 'clean-b\n');
  gitAtB(['add', '--', 'tracked.txt']);
  gitAtB(['commit', '-m', 'seed-b']);
  const head = gitAtB(['rev-parse', 'HEAD']).trim();
  const tree = gitAtB(['rev-parse', 'HEAD^{tree}']).trim();

  const acquisitionRoot = temporaryAcquisitionRoot(t);
  const matchingGrant = {
    ...p3hGrantFields(acquisitionRoot),
    implementationCommit: head,
    implementationTree: tree,
  };
  assert.equal(
    assertGitCanonicalTrackedWorktreeEquivalenceR1({ gitRoot: repoB, grant: matchingGrant }).passed,
    true,
    'repo B is clean and matches the grant; a leaked gitRoot would not fail Git verification',
  );

  const grantPath = join(acquisitionRoot, 'recovery-grant-b.json');
  writeFileSync(grantPath, `${JSON.stringify(matchingGrant, null, 2)}\n`);

  let factoryCalls = 0;
  const forbiddenFactory = () => {
    factoryCalls += 1;
    assert.fail('foreign-root injection must not construct a provider');
  };

  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      gitRoot: repoB,
      acquisitionRoot,
      executionGrant: testExecutionGrant(acquisitionRoot),
      recoveryGrantPath: grantPath,
      createProviderClient: forbiddenFactory,
      limit: 1,
    }),
    (error) => {
      assert.equal(error.code, 'RUN_GIT_ROOT_INJECTION_FORBIDDEN');
      assert.equal(String(error.code).startsWith('GIT_BINDING_'), false);
      return true;
    },
  );
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      root: repoB,
      acquisitionRoot,
      executionGrant: testExecutionGrant(acquisitionRoot),
      recoveryGrantPath: grantPath,
      createProviderClient: forbiddenFactory,
      limit: 1,
    }),
    (error) => {
      assert.equal(error.code, 'RUN_ROOT_INJECTION_FORBIDDEN');
      assert.equal(String(error.code).startsWith('GIT_BINDING_'), false);
      return true;
    },
  );
  assert.equal(factoryCalls, 0);
  assert.equal(existsSync(join(acquisitionRoot, 'reservations')), false);
  assert.equal(countDurableAttemptReservationsR1(acquisitionRoot), 0);
});

