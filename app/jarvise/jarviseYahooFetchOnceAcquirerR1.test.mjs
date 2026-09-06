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
import { dirname, join, resolve } from 'node:path';
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
  RETRY_ELIGIBLE_CONDITIONS,
  RETRY_INELIGIBLE_CONDITIONS,
  STRUCTURAL_MAX_ATTEMPTS_PER_EMPTY_KEY,
  STRUCTURAL_MAX_PROVIDER_INVOCATION_COUNT,
  assertExternalAcquisitionRootR1,
  classifyAcquisitionFailureR1,
  countDurableAttemptReservationsR1,
  countDurableAttemptsForKeyR1,
  createJarviseYahooFetchOnceAcquirerR1,
  jarviseAttemptReservationPathR1,
  jarviseAttemptTerminalPathR1,
  resolveEffectiveAcquisitionAuthorityR1,
} from './jarviseYahooFetchOnceAcquirerR1.mjs';
import {
  createJarviseSnapshotMemoryJournalR1,
  createJarviseSnapshotPersistenceR1,
} from './jarviseSnapshotPersistenceR1.mjs';
import {
  parseJarviseHistoricalFetchOnceArgsR1,
  runJarviseHistoricalFetchOnceR1,
} from '../../scripts/runJarviseHistoricalFetchOnceR1.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PREPARED_AUTHORITY_URL = new URL('./jarviseFetchOnceExecutionAuthorityR1.json', import.meta.url);
const ACQUIRER_MODULE_PATH = fileURLToPath(new URL('./jarviseYahooFetchOnceAcquirerR1.mjs', import.meta.url));
const IDENTITY_MODULE_PATH = fileURLToPath(new URL('./jarviseAcquisitionQueryIdentityR1.mjs', import.meta.url));

const preparedBytes = readFileSync(PREPARED_AUTHORITY_URL);
const preparedAuthority = JSON.parse(preparedBytes.toString('utf8'));
const preparedSha256 = createHash('sha256').update(preparedBytes).digest('hex');

/** Owner-supplied EXPLICIT_MISSION_GRANT stand-in. Never published by P3. */
const TEST_EXECUTION_GRANT = Object.freeze({
  mechanism: 'EXPLICIT_MISSION_GRANT',
  decisionType: 'PROJECT_OWNER_TEMPORARY_SINGLE_USE_AUTHORIZATION',
  preparedAuthoritySha256: preparedSha256,
  executionAuthorized: true,
  networkAuthorized: true,
});

const activatedAuthority = () => resolveEffectiveAcquisitionAuthorityR1({
  root: REPOSITORY_ROOT,
  executionGrant: TEST_EXECUTION_GRANT,
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
    authority: activatedAuthority(),
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
};
const plan = buildJarviseAcquisitionPlanR1({ root });
const entry = plan.entries[${entryIndex}];
const authority = resolveEffectiveAcquisitionAuthorityR1({ root, executionGrant: grant });

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
          writeFileSync(markerDir + '/PROVIDER_LEAVE_' + process.pid, '1');
          throw held;
        }
        if (mode === 'timeout-once') {
          const error = new Error('stub timeout');
          error.code = 'ETIMEDOUT';
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
        throw providerError('ETIMEDOUT');
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
  const authority = {
    ...activatedAuthority(),
    grant: { ...preparedAuthority.preparedGrant, maxAttemptsPerEmptyKey: 3, maxProviderInvocationCount: 4 },
  };
  let calls = 0;
  const acquirer = makeAcquirer(t, {
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
  assert.equal(classifyAcquisitionFailureR1(providerError('ETIMEDOUT')).retryEligible, true);
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
  const authority = activatedAuthority();
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
  const authority = activatedAuthority();
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
      authority: activatedAuthority(),
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
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      acquisitionRoot: REPOSITORY_ROOT,
      executionGrant: TEST_EXECUTION_GRANT,
      createProviderClient: () => assert.fail('runner must not construct a provider for an in-repo root'),
    }),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY' || error.details?.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY' || error.message.includes('ACQUISITION_ROOT_INSIDE_REPOSITORY'),
  );
  await assert.rejects(
    () => runJarviseHistoricalFetchOnceR1({
      root: REPOSITORY_ROOT,
      gitRoot: REPOSITORY_ROOT,
      executionGrant: TEST_EXECUTION_GRANT,
    }),
    (error) => error.code === 'RUN_ACQUISITION_ROOT_REQUIRED',
  );
  assert.deepEqual(
    parseJarviseHistoricalFetchOnceArgsR1(['--acquisition-root', 'C:\\outside\\acq']),
    { acquisitionRoot: 'C:\\outside\\acq', executionGrantPath: null },
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
  const { fakeGit, junction } = fakeGitScratch(t);
  const candidate = join(junction, 'YahooData');
  assert.equal(existsSync(candidate), false);
  assert.throws(
    () => assertExternalAcquisitionRootR1(candidate, fakeGit),
    (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
  );
  assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'validator must not mkdir');
  assert.throws(
    () => createJarviseYahooFetchOnceAcquirerR1({
      authority: activatedAuthority(),
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
    authority: activatedAuthority(),
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
        root: REPOSITORY_ROOT,
        gitRoot: fakeGit,
        acquisitionRoot: candidate,
        executionGrant: TEST_EXECUTION_GRANT,
        createProviderClient: () => assert.fail('runner must not construct a provider'),
      }),
      (error) => error.code === 'ACQUISITION_ROOT_INSIDE_REPOSITORY',
    );
    assert.equal(existsSync(join(fakeGit, 'YahooData')), false, 'runner write-before-check is forbidden');
    assert.equal(existsSync(candidate), false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
