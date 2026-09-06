/**
 * Single governed execution entry point for P3_HISTORICAL_YAHOO_FETCH_ONCE_R1.
 *
 * Lifecycle per acquisition key:
 *   EMPTY -> RAW_PINNED -> NORMALIZED -> VERSION_CACHED -> (REUSE)
 *
 * The run terminates at VERSION_CACHED. It materializes no DatasetId_observation,
 * no DatasetId_feature, no GATE24 V2 RegimeRecord and no GATE25 analogue.
 *
 * Orchestration only. This runner does not decide whether provider contact is
 * allowed: the acquirer owns that decision atomically against durable
 * reservations and the persistence journal. The runner supplies the 802-key
 * plan, an Owner-supplied EXPLICIT_MISSION_GRANT, and an acquisition root that
 * must resolve outside the governed repository.
 *
 * Dynamic Yahoo CAS objects are written under that external acquisition root.
 * The repository is never used as an acquisition write target.
 */


import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACQUISITION_METHOD,
  buildJarviseAcquisitionPlanR1,
  computeJarviseCorporateActionPolicyHashR1,
  computeJarviseTransformImplementationHashR1,
} from '../app/jarvise/jarviseAcquisitionQueryIdentityR1.mjs';
import {
  JARVISE_YAHOO_CHART_ADAPTER_VERSION,
  SOURCE_FORMAT,
  loadPinnedSessionsR1,
  normalizeJarviseYahooChartR1,
} from '../app/jarvise/jarviseYahooChartAdapterR1.mjs';
import {
  assertExternalAcquisitionRootR1,
  createJarviseYahooFetchOnceAcquirerR1,
  resolveEffectiveAcquisitionAuthorityR1,
} from '../app/jarvise/jarviseYahooFetchOnceAcquirerR1.mjs';
import {
  JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
  createJarviseSnapshotDirectoryJournalR1,
  createJarviseSnapshotPersistenceR1,
  readJarviseSnapshotPersistenceProvenanceR1,
} from '../app/jarvise/jarviseSnapshotPersistenceR1.mjs';
import { NORMALIZE_DAILY_BARS_VERSION } from '../research/directional-lab/src/data/normalizeDailyBars.mjs';
import { createContentAddressedStore } from '../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';

export const RUN_JARVISE_HISTORICAL_FETCH_ONCE_VERSION = 'runJarviseHistoricalFetchOnceR1/1';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class JarviseFetchOnceRunError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseFetchOnceRunError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseFetchOnceRunError(code, message, details);
}

/**
 * Parse runner CLI arguments. --acquisition-root is mandatory and must be
 * absolute; there is no in-repo default.
 * @param {string[]} argv
 */
export function parseJarviseHistoricalFetchOnceArgsR1(argv) {
  const parsed = { acquisitionRoot: null, executionGrantPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--acquisition-root') {
      parsed.acquisitionRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--execution-grant') {
      parsed.executionGrantPath = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

/**
 * Read an Owner-supplied execution grant from an explicit absolute path.
 * P3 never invents this path and never writes the document.
 * @param {{grantPath?: string|null}} [options]
 */
export function loadOwnerExecutionGrantR1({ grantPath = null } = {}) {
  if (grantPath === null || grantPath === undefined || grantPath === '') return null;
  if (typeof grantPath !== 'string' || !isAbsolute(grantPath)) {
    fail('RUN_EXECUTION_GRANT_UNSAFE', 'execution grant path must be an absolute Owner-supplied path');
  }
  if (!existsSync(grantPath)) return null;
  return JSON.parse(readFileSync(grantPath, 'utf8'));
}

/**
 * Build the DatasetSnapshotCore/1 identity fields for one instrument. Both the
 * corporate-action policy hash and the transform implementation hash are real
 * content hashes recomputed from bytes, never placeholders.
 * @param {{entry: Record<string, any>, corporateActionPolicyHash: string, transformImplementationHash: string}} input
 */
export function buildSnapshotCoreFieldsR1(input) {
  const identity = input.entry.acquisitionRequestIdentity;
  return {
    canonicalSymbol: identity.providerSymbol,
    providerId: identity.providerId,
    providerSymbol: identity.providerSymbol,
    sourceFormat: SOURCE_FORMAT,
    adapterVersion: JARVISE_YAHOO_CHART_ADAPTER_VERSION,
    adapterOptions: {
      interval: identity.interval,
      period1: identity.period1,
      period2: identity.period2,
      events: identity.eventsPolicy,
      sourceRepresentation: identity.sourceRepresentation,
    },
    normalizerVersion: NORMALIZE_DAILY_BARS_VERSION,
    normalizationOptions: {
      ohlcBasis: 'SPLIT_ADJUSTED',
      sessionInterpretation: identity.sessionInterpretation,
      pinnedSessionTimestamps: true,
    },
    canonicalSerializationVersion: 'CanonicalJSON/1',
    priceBasis: 'SPLIT_ADJUSTED',
    corporateActionPolicyHash: input.corporateActionPolicyHash,
    calendarId: identity.calendarWindowBindingId,
    calendarVersion: identity.calendarNamespaceVersion,
    transformImplementationHash: input.transformImplementationHash,
  };
}

/**
 * Execute the FETCH_ONCE pass.
 * @param {{
 *   root?: string,
 *   gitRoot?: string,
 *   acquisitionRoot: string,
 *   executionGrant?: Record<string, any>|null,
 *   executionGrantPath?: string|null,
 *   createProviderClient?: () => {chart: Function},
 *   now?: () => string,
 *   limit?: number,
 * }} options
 */
export async function runJarviseHistoricalFetchOnceR1(options = {}) {
  const root = options.root ?? REPOSITORY_ROOT;
  const gitRoot = options.gitRoot ?? root;
  if (options.acquisitionRoot === undefined || options.acquisitionRoot === null || options.acquisitionRoot === '') {
    fail('RUN_ACQUISITION_ROOT_REQUIRED', '--acquisition-root <absolute-path> is required; the repository is not an acquisition write target');
  }
  const acquisitionRoot = assertExternalAcquisitionRootR1(options.acquisitionRoot, gitRoot);

  const provenance = readJarviseSnapshotPersistenceProvenanceR1({ root });
  if (provenance.vintageClaim !== 'NONE') fail('RUN_PROVENANCE_INVALID', 'persistence root must claim no vintage');

  const executionGrant = options.executionGrant !== undefined
    ? options.executionGrant
    : loadOwnerExecutionGrantR1({ grantPath: options.executionGrantPath ?? null });
  const authority = resolveEffectiveAcquisitionAuthorityR1({ root, executionGrant });
  if (!authority.activated) {
    fail('RUN_NOT_AUTHORIZED', 'no Owner EXPLICIT_MISSION_GRANT is present; the prepared authority grants no network', {
      reasonCode: authority.reasonCode,
      preparedAuthoritySha256: authority.preparedSha256,
    });
  }

  const plan = buildJarviseAcquisitionPlanR1({ root });
  if (plan.acquisitionKeyCount !== authority.grant.logicalAcquisitionKeyCount) {
    fail('RUN_COHORT_MISMATCH', 'plan key count does not match the granted logical acquisition key count', {
      planned: plan.acquisitionKeyCount, granted: authority.grant.logicalAcquisitionKeyCount,
    });
  }

  const { corporateActionPolicyHash } = computeJarviseCorporateActionPolicyHashR1({ root });
  const { transformImplementationHash } = computeJarviseTransformImplementationHashR1({ root });
  const sessions = loadPinnedSessionsR1({ root });

  const persistenceRoot = resolve(acquisitionRoot, 'observation-snapshots');
  assertExternalAcquisitionRootR1(acquisitionRoot, gitRoot);
  mkdirSync(persistenceRoot, { recursive: true });
  const store = createContentAddressedStore({ root: persistenceRoot });
  const journal = createJarviseSnapshotDirectoryJournalR1({ root: persistenceRoot });
  const persistence = createJarviseSnapshotPersistenceR1({
    store,
    journal,
    acquisitionAuthority: authority,
    toolVersion: JARVISE_SNAPSHOT_PERSISTENCE_VERSION,
  });

  const acquirer = createJarviseYahooFetchOnceAcquirerR1({
    authority,
    acquisitionRoot,
    gitRoot,
    permittedAcquisitionKeys: plan.entries.map((entry) => entry.acquisitionKey),
    journal,
    createProviderClient: options.createProviderClient,
  });

  const now = options.now ?? (() => new Date().toISOString());
  const entries = options.limit === undefined ? plan.entries : plan.entries.slice(0, options.limit);
  const results = [];
  let acquired = 0;
  let reused = 0;
  let failed = 0;

  for (const entry of entries) {
    const acquisitionKey = entry.acquisitionKey;
    try {
      let rawBytes = null;
      try {
        rawBytes = await acquirer.acquireRawBytesFor(entry);
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'ACQUIRER_REFETCH_FORBIDDEN') throw error;
        rawBytes = null;
      }

      const pin = persistence.pinRawOnce({
        acquisitionKey,
        acquisition: {
          sourceAcquiredAt: rawBytes === null ? null : now(),
          ingestedIntoLabAt: now(),
          acquisitionMethod: ACQUISITION_METHOD,
          acquisitionToolVersion: RUN_JARVISE_HISTORICAL_FETCH_ONCE_VERSION,
          acquisitionRequestIdentity: entry.acquisitionRequestIdentity,
          acquisitionEvidenceIds: [],
        },
        acquireRawBytes: () => {
          if (rawBytes === null) fail('RUN_REFETCH_FORBIDDEN', `refetch attempted for pinned key ${acquisitionKey}`);
          return rawBytes;
        },
      });
      if (pin.reused) reused += 1;
      else acquired += 1;

      persistence.normalizePinnedRaw({
        acquisitionKey,
        normalize: (bytes) => normalizeJarviseYahooChartR1({
          sourceBytes: bytes,
          expectedSymbol: entry.acquisitionRequestIdentity.providerSymbol,
          sessions,
          firstSessionDate: plan.acquisitionWindow.firstSessionDate,
          lastSessionDate: plan.acquisitionWindow.lastSessionDate,
          root,
        }),
      });

      const cached = persistence.versionCache({
        acquisitionKey,
        core: buildSnapshotCoreFieldsR1({ entry, corporateActionPolicyHash, transformImplementationHash }),
        instrumentBinding: undefined,
        createdByVersion: RUN_JARVISE_HISTORICAL_FETCH_ONCE_VERSION,
      });

      results.push({
        symbol: entry.symbol,
        acquisitionKey,
        stage: 'VERSION_CACHED',
        snapshotRecordId: cached.snapshotRecordId,
        manifestId: cached.manifestId,
        reused: pin.reused === true,
      });
    } catch (error) {
      failed += 1;
      results.push({
        symbol: entry.symbol,
        acquisitionKey,
        stage: persistence.stageOf(acquisitionKey),
        error: { code: /** @type {any} */ (error)?.code ?? null, message: /** @type {Error} */ (error)?.message ?? null },
      });
    }
  }

  const completed = results.filter((result) => result.stage === 'VERSION_CACHED').length;
  return Object.freeze({
    version: RUN_JARVISE_HISTORICAL_FETCH_ONCE_VERSION,
    programId: plan.programId,
    authorityId: authority.authorityId,
    terminalStage: 'VERSION_CACHED',
    expectedKeyCount: plan.acquisitionKeyCount,
    attemptedKeyCount: entries.length,
    acquired,
    reused,
    failed,
    completed,
    providerInvocations: acquirer.providerInvocations(),
    maxProviderInvocationCount: authority.grant.maxProviderInvocationCount,
    cohortStatus: completed === plan.acquisitionKeyCount ? 'COMPLETE' : 'PARTIAL_RESUMABLE',
    resumeSemantics: 'FROM_PINNED_LOCAL_STATE',
    acquisitionRoot,
    results,
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const parsed = parseJarviseHistoricalFetchOnceArgsR1(process.argv.slice(2));
  runJarviseHistoricalFetchOnceR1({
    acquisitionRoot: parsed.acquisitionRoot,
    executionGrantPath: parsed.executionGrantPath,
  })
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        code: error?.code ?? null,
        message: error?.message ?? String(error),
        details: error?.details ?? null,
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
