/**
 * Deterministic identity bindings for the P3 historical Yahoo FETCH_ONCE pass.
 *
 * Everything the acquisition needs in order to be reproducible is derived here
 * from already-published bytes: the pinned acquisition window (OD-P3-1), the
 * ratified events policy (OD-P3-2), the content-addressed 802-instrument
 * cohort, the pinned calendar V2 binding and the ratified Yahoo source basis
 * declaration. No clock is read, no directory is listed and no symbol is taken
 * from ambient runtime state.
 *
 * The acquisition key is a pure function of the complete request identity, so
 * changing the cutoff, the events policy, the interval or the instrument
 * necessarily produces a different key and therefore a different pinned raw
 * object. That is what makes "already RAW_PINNED" mean the same query rather
 * than merely the same symbol.
 *
 * This module performs no acquisition and constructs no HTTP client.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  CORPORATE_ACTION_POLICY,
  CORPORATE_ACTION_POLICY_VERSION,
} from '../../research/directional-lab/src/data/corporateActionPolicy.mjs';
import {
  buildTransformImplementationManifest,
  transformImplementationHash,
} from '../../research/directional-lab/src/data/transformImplementationManifestV1.mjs';

export const JARVISE_ACQUISITION_QUERY_IDENTITY_VERSION = 'jarviseAcquisitionQueryIdentityR1/1';
export const ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION = 'WHEEL_JARVISE_ACQUISITION_REQUEST_IDENTITY/1';
export const CORPORATE_ACTION_POLICY_BINDING_SCHEMA_VERSION = 'WHEEL_JARVISE_CORPORATE_ACTION_POLICY_BINDING/1';

/** The acquisition method reachable only under an activated fetch authority. */
export const ACQUISITION_METHOD = 'YAHOO_CHART_EOD_FETCH_ONCE';

/** OD-P3-2. Exactly these two event families, never a third. */
export const EVENTS_POLICY = Object.freeze({ splits: true, dividends: true, otherEventFamilies: false });

export const PROGRAM_ID = 'P3_HISTORICAL_YAHOO_FETCH_ONCE_R1';
export const EXECUTION_AUTHORITY_ID = 'P3_HISTORICAL_YAHOO_FETCH_ONCE_EXECUTION_AUTHORITY_R1';
export const SOURCE_ID = 'YAHOO_CHART_EOD';
export const PROVIDER_ID = 'yahoo-finance2';
export const PLANE = 'HISTORICAL';

/** Modules whose bytes define the P3 raw to CanonicalDailyBars/1 transform. */
export const TRANSFORM_MODULE_LOGICAL_PATHS = Object.freeze([
  'app/jarvise/jarviseYahooChartAdapterR1.mjs',
  'app/jarvise/pinnedSessionTimestampsR1.mjs',
  'research/directional-lab/src/data/normalizeDailyBars.mjs',
  'research/directional-lab/src/canonical/canonicalDailyBarsV1.mjs',
  'research/directional-lab/src/canonical/canonicalJsonV1.mjs',
]);

export const TRANSFORM_RUNTIME_CONTRACT_VERSION = 'jarviseHistoricalYahooTransformR1/1';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OBJECT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

export class JarviseAcquisitionIdentityError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'JarviseAcquisitionIdentityError';
    this.code = code;
    this.details = details;
  }
}

/** @param {string} code @param {string} message @param {object} [details] */
function fail(code, message, details = {}) {
  throw new JarviseAcquisitionIdentityError(code, message, details);
}

/** @param {unknown} root */
function assertRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('IDENTITY_INPUT_INVALID', 'root must be an absolute path');
  return /** @type {string} */ (root);
}

/** @param {string} root @param {string} relativePath */
function readJson(root, relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

/** @param {Buffer|Uint8Array} bytes */
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Pinned acquisition window (OD-P3-1). @param {{root?: string}} [options] */
export function loadJarviseAcquisitionWindowR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const acquisitionWindow = readJson(root, 'app/jarvise/jarviseHistoricalAcquisitionWindowR1.json');
  if (acquisitionWindow.schemaVersion !== 'WHEEL_JARVISE_HISTORICAL_ACQUISITION_WINDOW/1') {
    fail('ACQUISITION_WINDOW_INVALID', 'unexpected acquisition window schemaVersion');
  }
  if (acquisitionWindow.runtimeWallClockDerivation !== 'FORBIDDEN') {
    fail('ACQUISITION_WINDOW_INVALID', 'window must forbid runtime wall-clock derivation');
  }
  return Object.freeze(acquisitionWindow);
}

/** Pinned 802-instrument cohort binding. @param {{root?: string}} [options] */
export function loadJarviseCohortBindingR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const cohort = readJson(root, 'app/jarvise/jarviseHistoricalCohortBindingR1.json');
  if (cohort.schemaVersion !== 'WHEEL_JARVISE_HISTORICAL_COHORT_BINDING/1') {
    fail('COHORT_BINDING_INVALID', 'unexpected cohort binding schemaVersion');
  }
  if (cohort.runtimeSymbolEnumeration !== 'FORBIDDEN') {
    fail('COHORT_BINDING_INVALID', 'cohort must forbid runtime symbol enumeration');
  }
  return Object.freeze(cohort);
}

/**
 * Read one content-addressed instrument-identity object and verify that its
 * bytes hash to the identifier used to reach them.
 * @param {string} root @param {string} casRootPath @param {string} objectId
 */
function readIdentityCasObject(root, casRootPath, objectId) {
  if (typeof objectId !== 'string' || !OBJECT_ID_PATTERN.test(objectId)) {
    fail('COHORT_OBJECT_ID_INVALID', `object id must use sha256:<64 lowercase hex>: ${String(objectId)}`);
  }
  const hex = objectId.slice(7);
  const path = resolve(root, casRootPath, 'snapshots', 'sha256', hex.slice(0, 2), `${hex}.json`);
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    return fail('COHORT_OBJECT_MISSING', `cohort object is missing: ${objectId}`, { path });
  }
  const actual = `sha256:${sha256Hex(bytes)}`;
  if (actual !== objectId) {
    fail('COHORT_OBJECT_DIGEST_MISMATCH', 'cohort object bytes do not match their object id', { objectId, actual });
  }
  return JSON.parse(bytes.toString('utf8'));
}

/**
 * Enumerate the acquisition cohort from the authoritative content-addressed
 * registry manifest. The identity-store projection is never consulted.
 * @param {{root?: string, cohort?: Record<string, any>}} [options]
 */
export function enumerateJarviseCohortR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const cohort = options.cohort ?? loadJarviseCohortBindingR1({ root });
  const registry = readIdentityCasObject(root, cohort.casRootPath, cohort.registryManifestId);
  if (registry.schemaVersion !== 'InstrumentIdentityRegistryManifest/1') {
    fail('COHORT_REGISTRY_INVALID', 'unexpected registry manifest schemaVersion');
  }
  if (registry.authorityPolicyId !== cohort.authorityPolicyId) {
    fail('COHORT_AUTHORITY_POLICY_MISMATCH', 'registry authorityPolicyId does not match the pinned cohort binding');
  }

  const members = [];
  for (const identityManifestId of registry.identityManifestIds) {
    const manifest = readIdentityCasObject(root, cohort.casRootPath, identityManifestId);
    if (manifest.schemaVersion !== 'InstrumentIdentityManifest/1') {
      fail('COHORT_MANIFEST_INVALID', `unexpected identity manifest schemaVersion for ${identityManifestId}`);
    }
    if (!Array.isArray(manifest.aliasBindingCoreIds) || manifest.aliasBindingCoreIds.length !== 1) {
      fail('COHORT_ALIAS_AMBIGUOUS', `exactly one alias binding is required for ${identityManifestId}`);
    }
    const alias = readIdentityCasObject(root, cohort.casRootPath, manifest.aliasBindingCoreIds[0]);
    if (alias.schemaVersion !== 'InstrumentAliasBindingCore/1') {
      fail('COHORT_ALIAS_INVALID', 'unexpected alias binding schemaVersion');
    }
    if (alias.providerId !== cohort.providerId) {
      fail('COHORT_PROVIDER_MISMATCH', `alias providerId ${String(alias.providerId)} is not ${cohort.providerId}`);
    }
    if (alias.bindingStatus !== cohort.requiredAliasBindingStatus) {
      fail('COHORT_ALIAS_NOT_CONFIRMED', `alias bindingStatus must be ${cohort.requiredAliasBindingStatus}`);
    }
    if (alias.validToExclusive !== null) {
      fail('COHORT_ALIAS_CLOSED', `alias for ${String(alias.symbol)} has a closed validity interval`);
    }
    if (alias.namespacePolicyId !== cohort.namespacePolicyId) {
      fail('COHORT_NAMESPACE_MISMATCH', 'alias namespacePolicyId does not match the pinned cohort binding');
    }
    if (alias.instrumentIdentityId !== manifest.instrumentIdentityId) {
      fail('COHORT_IDENTITY_MISMATCH', 'alias and manifest disagree on instrumentIdentityId');
    }
    members.push(Object.freeze({
      symbol: alias.symbol,
      providerSymbol: alias.symbol,
      instrumentIdentityId: manifest.instrumentIdentityId,
      identityManifestId,
      aliasBindingCoreId: manifest.aliasBindingCoreIds[0],
      aliasValidFrom: alias.validFrom,
      currency: alias.currency,
    }));
  }

  // Code-unit ordering, not localeCompare: this ordering feeds a content
  // address, and ICU collation disagrees with code-unit order on punctuated
  // symbols such as BF.B and BRK-B.
  members.sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0));
  if (new Set(members.map((member) => member.symbol)).size !== members.length) {
    fail('COHORT_DUPLICATE_SYMBOL', 'cohort contains duplicate provider symbols');
  }
  if (members.length !== cohort.expectedInstrumentCount) {
    fail('COHORT_COUNT_MISMATCH', `expected ${cohort.expectedInstrumentCount} instruments, enumerated ${members.length}`);
  }
  const lines = members.map((member) => `${member.symbol}|${member.instrumentIdentityId}|${member.identityManifestId}`);
  const bindingDigest = sha256Hex(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
  if (bindingDigest !== cohort.cohortBindingSha256) {
    fail('COHORT_BINDING_DIGEST_MISMATCH', 'enumerated cohort does not match the pinned cohort digest', {
      expected: cohort.cohortBindingSha256, actual: bindingDigest,
    });
  }
  return Object.freeze(members);
}

/** Content address of the ratified R2SourceBinding/1 preimage. @param {string} declarationSha256 */
export function sourceBindingIdR1(declarationSha256) {
  if (typeof declarationSha256 !== 'string' || !HEX64_PATTERN.test(declarationSha256)) {
    fail('SOURCE_BINDING_INVALID', 'sourceBasisDeclarationSha256 must be 64 lowercase hex');
  }
  return canonicalHash('R2SourceBinding/1', {
    schemaVersion: 'R2SourceBinding/1',
    sourceId: SOURCE_ID,
    plane: PLANE,
    sourceBasisDeclarationPath: 'app/jarvise/yahooSourceBasisDeclarationR1.json',
    sourceBasisDeclarationSha256: declarationSha256,
  });
}

/**
 * Build the complete, deterministic request identity for one instrument. This
 * object is what DatasetSnapshotRecord/1 carries in acquisitionRequestIdentity.
 * @param {{member: Record<string, any>, acquisitionWindow: Record<string, any>, cohort: Record<string, any>,
 *   sourceBasisDeclarationSha256: string, calendarWindowBindingId: string,
 *   calendarNamespaceVersion: string, authorityId?: string, eventsPolicy?: Record<string, boolean>}} input
 */
export function buildAcquisitionRequestIdentityR1(input) {
  const member = input?.member;
  const acquisitionWindow = input?.acquisitionWindow;
  const cohort = input?.cohort;
  if (!member || !acquisitionWindow || !cohort) {
    fail('IDENTITY_INPUT_INVALID', 'member, acquisitionWindow and cohort are required');
  }
  const eventsPolicy = input.eventsPolicy ?? EVENTS_POLICY;
  return Object.freeze({
    schemaVersion: ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION,
    programId: PROGRAM_ID,
    authorityId: input.authorityId ?? EXECUTION_AUTHORITY_ID,
    sourceBindingId: sourceBindingIdR1(input.sourceBasisDeclarationSha256),
    sourceId: SOURCE_ID,
    plane: PLANE,
    sourceBasisDeclarationSha256: input.sourceBasisDeclarationSha256,
    providerId: PROVIDER_ID,
    providerLibrary: 'yahoo-finance2',
    providerLibraryVersion: '3.14.0',
    providerEndpointFamily: 'chart',
    providerSymbol: member.providerSymbol,
    instrumentIdentityId: member.instrumentIdentityId,
    identityManifestId: member.identityManifestId,
    registryManifestId: cohort.registryManifestId,
    period1: acquisitionWindow.period1,
    period2: acquisitionWindow.period2,
    acquisitionCutoffUtc: acquisitionWindow.acquisitionCutoffUtc,
    acquisitionCutoffSessionDate: acquisitionWindow.acquisitionCutoffSessionDate,
    interval: acquisitionWindow.interval,
    priceBasis: 'SPLIT_ADJUSTED',
    corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
    eventsPolicy: { ...eventsPolicy },
    calendarWindowBindingId: input.calendarWindowBindingId,
    calendarNamespaceVersion: input.calendarNamespaceVersion,
    sessionInterpretation: acquisitionWindow.sessionInterpretation,
    retrospectiveSemantics: 'RETROSPECTIVE_RECONSTRUCTION',
    vintageClaim: 'NONE',
    sourceRepresentation: 'CANONICAL_PROVIDER_RESULT_BYTES',
    canonicalSerializationVersion: 'CanonicalJSON/1',
  });
}

/**
 * The journal key for one acquisition. A pure function of the whole request
 * identity: any change to cutoff, events policy, interval or instrument yields
 * a different key and therefore a distinct pinned raw object.
 * @param {Record<string, unknown>} acquisitionRequestIdentity
 */
export function acquisitionKeyFor(acquisitionRequestIdentity) {
  if (acquisitionRequestIdentity?.schemaVersion !== ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION) {
    fail('IDENTITY_INPUT_INVALID', `acquisitionRequestIdentity must be ${ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION}`);
  }
  const digest = canonicalHash(ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION, acquisitionRequestIdentity).slice(7);
  return `${SOURCE_ID}/${String(acquisitionRequestIdentity.providerSymbol)}/${digest}`;
}

/**
 * Real, non-placeholder corporateActionPolicyHash for DatasetSnapshotCore/1.
 * Identifies the governing policy, not a registry of realized events.
 * @param {{root?: string}} [options]
 */
export function computeJarviseCorporateActionPolicyHashR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const policy = CORPORATE_ACTION_POLICY.SPLIT_ADJUSTED;
  const moduleBytes = readFileSync(resolve(root, 'research/directional-lab/src/data/corporateActionPolicy.mjs'));
  const declarationBytes = readFileSync(resolve(root, 'app/jarvise/yahooSourceBasisDeclarationR1.json'));
  const preimage = {
    schemaVersion: CORPORATE_ACTION_POLICY_BINDING_SCHEMA_VERSION,
    corporateActionPolicyVersion: CORPORATE_ACTION_POLICY_VERSION,
    corporateActionPolicyModuleSha256: `sha256:${sha256Hex(moduleBytes)}`,
    priceBasis: 'SPLIT_ADJUSTED',
    basisPolicy: {
      priceBasis: policy.priceBasis,
      engineAppliesSplit: policy.engineAppliesSplit,
      creditsCashDividend: policy.creditsCashDividend,
      pricesIncludeSplits: policy.pricesIncludeSplits,
      pricesIncludeDividends: policy.pricesIncludeDividends,
      refusesCorporateActions: policy.refusesCorporateActions,
    },
    corporateActionTreatment: 'PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED',
    sourceId: SOURCE_ID,
    sourceBasisDeclarationSha256: sha256Hex(declarationBytes),
    eventsPolicy: { ...EVENTS_POLICY },
    adjcloseDisposition: 'LINEAGE_TOTAL_RETURN_CLOSE_ONLY',
  };
  return {
    corporateActionPolicyHash: canonicalHash(CORPORATE_ACTION_POLICY_BINDING_SCHEMA_VERSION, preimage),
    preimage,
  };
}

/**
 * Real, non-placeholder transformImplementationHash over the audited list of
 * modules whose bytes define the raw to CanonicalDailyBars/1 transform.
 * @param {{root?: string}} [options]
 */
export function computeJarviseTransformImplementationHashR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const manifest = buildTransformImplementationManifest({
    labRoot: root,
    logicalPaths: [...TRANSFORM_MODULE_LOGICAL_PATHS],
    runtimeContractVersion: TRANSFORM_RUNTIME_CONTRACT_VERSION,
  });
  return { transformImplementationHash: transformImplementationHash(manifest), manifest };
}

/**
 * The complete deterministic acquisition plan: one entry per cohort member,
 * ordered by provider symbol. Built entirely from pinned bytes.
 * @param {{root?: string, authorityId?: string}} [options]
 */
export function buildJarviseAcquisitionPlanR1(options = {}) {
  const root = assertRoot(options.root ?? REPOSITORY_ROOT);
  const acquisitionWindow = loadJarviseAcquisitionWindowR1({ root });
  const cohort = loadJarviseCohortBindingR1({ root });
  const members = enumerateJarviseCohortR1({ root, cohort });
  const declarationBytes = readFileSync(resolve(root, 'app/jarvise/yahooSourceBasisDeclarationR1.json'));
  const sourceBasisDeclarationSha256 = sha256Hex(declarationBytes);
  const calendarBinding = readJson(root, 'app/jarvise/jarviseHistoricalCalendarBindingR1.json');
  if (calendarBinding.calendarWindowBinding.calendarWindowBindingId !== acquisitionWindow.calendarWindowBindingId) {
    fail('CALENDAR_BINDING_MISMATCH', 'published calendar binding does not match the pinned acquisition window');
  }

  const entries = members.map((member) => {
    const acquisitionRequestIdentity = buildAcquisitionRequestIdentityR1({
      member,
      acquisitionWindow,
      cohort,
      sourceBasisDeclarationSha256,
      calendarWindowBindingId: acquisitionWindow.calendarWindowBindingId,
      calendarNamespaceVersion: acquisitionWindow.calendarNamespaceVersion,
      authorityId: options.authorityId,
    });
    return Object.freeze({
      symbol: member.symbol,
      member,
      acquisitionRequestIdentity,
      acquisitionKey: acquisitionKeyFor(acquisitionRequestIdentity),
    });
  });

  if (new Set(entries.map((entry) => entry.acquisitionKey)).size !== entries.length) {
    fail('ACQUISITION_KEY_COLLISION', 'acquisition keys are not unique across the cohort');
  }
  return Object.freeze({
    version: JARVISE_ACQUISITION_QUERY_IDENTITY_VERSION,
    programId: PROGRAM_ID,
    acquisitionWindow,
    cohort,
    sourceBasisDeclarationSha256,
    entries,
    acquisitionKeyCount: entries.length,
  });
}
