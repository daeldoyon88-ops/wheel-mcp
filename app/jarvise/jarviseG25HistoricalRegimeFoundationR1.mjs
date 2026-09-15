/**
 * GATE25_HISTORICAL_REGIME_FOUNDATION_R1.
 *
 * A bounded historical consumer layer over the already-admitted Calendar V2
 * historical plane. It does not touch the closed P2 pipeline
 * (jarvisePipelineR1.mjs::runJarviseHistoricalPreFetchPipelineR1 still emits
 * OBSERVATION + FEATURE only) and it does not touch GATE24 production V1 bytes or
 * identities. It composes unchanged GATE23/GATE24 primitives into, per
 * (P3H admitted key, historical session T):
 *
 *   observations <= K(T) --GATE23 materializer--> FeatureRecords
 *        (F1_SIMPLE_RETURN@W5, F1_SIMPLE_RETURN@W21 core; F2_REALIZED_VOLATILITY@W21 declared non-core)
 *   FeatureSet --GATE24 createFeatureVectorBinding--> FeatureVectorBindingId
 *   real historical macro context at K(T) --GATE24 createMacroContextBinding--> MacroContextBindingId
 *   Calendar V2 --GATE24 createActiveRegimeHorizonSpec--> RegimeHorizonSpecId
 *   ratified CORE_V1 classifier label and 22 ratified parameters bound to the V2 horizon
 *        --> ClassifierVersionId, ParameterSetId
 *   --GATE24 emitRegimeRecord--> RegimeRecordId, six CORE_V1 dimension values, evidence
 *
 * Identity is resolved at each historical session date, never backdated. A session
 * whose required inputs are genuinely unavailable fails closed with an explicit code
 * or carries a dimension-local fail-closed member; no value is manufactured.
 *
 * Network-free, broker-free, model-free, wall-clock-free. Never on the live scan path.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Bytes, sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import { createFeatureWindowSpec, resolvePinnedCanonicalSession, resolveTrailingWindow } from '../../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { F1_DEFINITION, CORE_FEATURE_SET_V1, declareFeatureVector, memberKey } from '../../governance/gates/GATE23/implementation/feature-families-v1.mjs';
import { createFeatureRegistry } from '../../governance/gates/GATE23/implementation/feature-registry-v1.mjs';
import { FEATURE_MATERIALIZER_VERSION, materializeFeatureRecords } from '../../governance/gates/GATE23/implementation/feature-materializer-v1.mjs';
import { createFeatureVectorBinding } from '../../governance/gates/GATE24/implementation/regime-identity-v1.mjs';
import { emitRegimeRecord } from '../../governance/gates/GATE24/implementation/regime-store-v1.mjs';
import {
  admitProductionCalendarWindowBinding,
  createActiveRegimeHorizonSpec,
  resolveProductionCalendarWindowBinding,
} from '../../governance/gates/GATE24/implementation/regime-horizon-v1.mjs';
import { createClassifierVersion, createParameterSet, REGIME_VECTOR_VERSION_ID } from '../../governance/gates/GATE24/implementation/regime-classifier-v1.mjs';
import { ACTIVE_DIMENSION_NAMES_V1, isClassifyingValue } from '../../governance/gates/GATE24/implementation/regime-taxonomy-v1.mjs';
import { createContentAddressedStore } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { verifyInstrumentIdentityRegistry } from '../../research/directional-lab/src/data/buildInstrumentIdentityRegistry.mjs';
import { verifySymbolNamespacePolicy } from '../../research/directional-lab/src/data/instrumentIdentityBuildersCore.mjs';
import {
  InstrumentIdentityError,
  computeSymbolLookupKey,
  effectiveBindingInterval,
  isDateInHalfOpenInterval,
  namespacePolicyBindingProblems,
} from '../../research/directional-lab/src/contracts/instrumentIdentityV1.mjs';
import {
  HISTORICAL_CALENDAR_BINDING_ID,
  GATE24_V1_CALENDAR_BINDING_ID,
  computeJarviseHistoricalCalendarBindingR1,
  loadJarviseHistoricalCalendarR1,
} from './jarviseHistoricalCalendarBindingR1.mjs';
import { loadJarviseG24ProductionFoundationR1 } from './jarviseG24ProductionFoundationR1.mjs';
import { deriveJarviseSourceBindingIdR1 } from './jarviseDatasetIdentityTripleR1.mjs';
import { sourceBindingIdR1 } from './jarviseAcquisitionQueryIdentityR1.mjs';
import { F2_REALIZED_VOLATILITY_DEFINITION_R1, describeF2ProducerR1 } from './jarviseG25HistoricalRealizedVolatilityR1.mjs';
import { loadJarviseG25HistoricalMacroAuthorityR1, prepareJarviseG25HistoricalMacroContextR1 } from './jarviseG25HistoricalMacroContextR1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const FOUNDATION_ID_R1 = 'GATE25_HISTORICAL_REGIME_FOUNDATION_R1';
export const HISTORICAL_OBSERVATION_DATASET_SCHEMA_R1 = 'JarviseG25HistoricalObservationDataset/1';
export const HISTORICAL_FEATURE_DATASET_SCHEMA_R1 = 'JarviseG25HistoricalFeatureDataset/1';
export const HISTORICAL_PRICE_BASIS_ID_R1 = 'SPLIT_ADJUSTED';
export const HISTORICAL_PLANE_R1 = 'HISTORICAL';
export const GATE25_EXECUTION_CONTRACT_PATH_R1 = 'governance/gates/GATE25/contracts/EXECUTION_CONTRACT_R0003.json';
export const GATE25_EXECUTION_CONTRACT_SHA256_R1 = 'f369ce7844167a5ae46940dcd1e2edd61f1b92327893723cd6953d8fafa0578f';
export const GATE25_MANDATE_PATH_R1 = 'governance/sources/GATE25_CANONICAL_MANDATE_R0.json';
export const GATE25_MANDATE_SHA256_R1 = '0aefedc757e2ba749ebd25a2cd40dc2070fafb04f3ac8f7b194c08d2b513c618';

/** Historical FeatureSet: the GATE23 core plus the declared non-core F2 member. */
export const HISTORICAL_FEATURE_VECTOR_MEMBERS_R1 = Object.freeze([
  ...CORE_FEATURE_SET_V1,
  Object.freeze({ featureDefinitionId: F2_REALIZED_VOLATILITY_DEFINITION_R1.featureDefinitionId, sessionCount: 21 }),
]);
export const GATE25_DISTANCE_FEATURE_KEYS_R1 = Object.freeze(['F1_SIMPLE_RETURN@W5', 'F1_SIMPLE_RETURN@W21']);
export const GATE25_REGIME_RECORD_PROOF_INPUT_ID_R1 = 'GATE24_REGIME_RECORD';
const MAX_WINDOW_SESSION_COUNT = Math.max(...HISTORICAL_FEATURE_VECTOR_MEMBERS_R1.map((member) => member.sessionCount));
const BAR_FIELDS = Object.freeze(['sessionDate', 'eventTime', 'availableAt', 'open', 'high', 'low', 'close', 'volume']);

export class JarviseG25HistoricalRegimeFoundationError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'JarviseG25HistoricalRegimeFoundationError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, details) => { throw new JarviseG25HistoricalRegimeFoundationError(code, details); };
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};

function readPinnedJson(root, path, expectedSha256, code) {
  let bytes;
  try { bytes = readFileSync(resolve(root, path)); } catch (cause) { fail(`${code}_ABSENT`, { path, causeCode: cause?.code }); }
  if (sha256Bytes(bytes) !== expectedSha256) fail(`${code}_SHA256_MISMATCH`, { path });
  return JSON.parse(bytes.toString('utf8'));
}

/* ------------------------------------------------------------ V2 regime identities */

/**
 * The Calendar V2 counterparts of the three production V1 native identities. The
 * classifier label, the regime vector version and all 22 ratified parameters are
 * read from the verified V1 foundation; only the calendar-dependent horizon differs.
 */
export function createHistoricalV2RegimeIdentitiesR1({ productionFoundation, calendarWindowBinding }) {
  const admitted = admitProductionCalendarWindowBinding(calendarWindowBinding);
  if (admitted.status !== 'ADMITTED' || admitted.calendarWindowBindingId !== HISTORICAL_CALENDAR_BINDING_ID) {
    fail('HISTORICAL_CALENDAR_BINDING_NOT_ADMITTED', admitted);
  }
  const horizon = createActiveRegimeHorizonSpec({ calendarWindowBindingId: calendarWindowBinding.calendarWindowBindingId });
  const classifier = createClassifierVersion({
    classifierVersionLabel: productionFoundation.classifier.classifierVersionLabel,
    activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId],
  });
  const parameterSet = createParameterSet({
    parameterSetLabel: productionFoundation.parameterSet.parameterSetLabel,
    regimeVectorVersionId: REGIME_VECTOR_VERSION_ID,
    activeRegimeHorizonSpecIds: [horizon.regimeHorizonSpecId],
    parameters: productionFoundation.parameterSet.parameters.map(({ dimension, parameterName, value }) => ({ dimension, parameterName, value })),
  });
  const strip = (parameters) => parameters.map(({ dimension, parameterName, value }) => ({ dimension, parameterName, value }));
  if (sha256Canonical(strip(parameterSet.parameters)) !== sha256Canonical(strip(productionFoundation.parameterSet.parameters))
    || parameterSet.parameters.length !== 22
    || sha256Canonical(classifier.dimensionTaxonomyVersionIds) !== sha256Canonical(productionFoundation.classifier.dimensionTaxonomyVersionIds)) {
    fail('HISTORICAL_V2_IDENTITIES_DIVERGE_FROM_RATIFIED_V1_SEMANTICS');
  }
  if (horizon.calendarWindowBindingId === GATE24_V1_CALENDAR_BINDING_ID
    || horizon.regimeHorizonSpecId === productionFoundation.horizon.regimeHorizonSpecId
    || classifier.classifierVersionId === productionFoundation.classifier.classifierVersionId
    || parameterSet.parameterSetId === productionFoundation.parameterSet.parameterSetId) {
    fail('HISTORICAL_V2_IDENTITY_NOT_DISTINCT_FROM_V1');
  }
  return deepFreeze({ horizon, classifier, parameterSet });
}

/* ------------------------------------------------------------ identity resolution */

/**
 * The official L2B as-of resolution rule applied to a registry verified once. The
 * per-(symbol, date) branch is the official resolver's own loop over the same
 * verified bundles with the same lab primitives; only the per-call registry
 * re-verification is hoisted.
 */
export function createVerifiedHistoricalIdentityResolverR1({ root = REPOSITORY_ROOT } = {}) {
  const provenance = JSON.parse(readFileSync(resolve(root, 'data/jarvise/instrument-identity/PROVENANCE.json'), 'utf8'));
  const namespace = JSON.parse(readFileSync(resolve(root, 'data/jarvise/instrument-identity/symbol-namespace-policy.json'), 'utf8'));
  const store = createContentAddressedStore({ root: resolve(root, 'data/jarvise/instrument-identity/cas') });
  const registry = verifyInstrumentIdentityRegistry({ store, registryManifestId: provenance.registryManifestId });
  const { namespacePolicy } = verifySymbolNamespacePolicy({ store, namespacePolicyId: provenance.namespacePolicyId });
  const lookup = { providerId: namespace.providerId, venueId: null, currency: 'USD' };
  if (namespacePolicy.providerId !== lookup.providerId || namespacePolicyBindingProblems(namespacePolicy, lookup).length > 0) {
    fail('IDENTITY_NAMESPACE_POLICY_BINDING_INVALID');
  }
  /* The official loop's first filters (namespace, provider, venue, currency, lookup key) do
     not depend on the date, so aliases are indexed by lookup key once, in registry order. */
  const aliasesByLookupKey = new Map();
  for (const bundle of registry.identityBundles) {
    for (const entry of bundle.aliases) {
      const alias = entry.aliasBindingCore;
      if (alias.namespacePolicyId !== provenance.namespacePolicyId || alias.providerId !== lookup.providerId
        || alias.venueId !== lookup.venueId || alias.currency !== lookup.currency) continue;
      const list = aliasesByLookupKey.get(alias.symbolLookupKey) ?? [];
      list.push({ alias, revFrom: bundle.aliasRevocationByBinding.get(entry.aliasBindingCoreId) ?? null });
      aliasesByLookupKey.set(alias.symbolLookupKey, list);
    }
  }
  function resolveAsOf(symbol, asOfDate) {
    try {
      const normalizedLookupKey = computeSymbolLookupKey(namespacePolicy, symbol);
      const matches = [];
      const revokedMatches = [];
      for (const { alias, revFrom } of aliasesByLookupKey.get(normalizedLookupKey) ?? []) {
        const effective = effectiveBindingInterval(alias.validFrom, alias.validToExclusive, revFrom);
        if (!isDateInHalfOpenInterval(asOfDate, alias.validFrom, alias.validToExclusive)) continue;
        if (revFrom !== null && asOfDate >= revFrom) { revokedMatches.push(alias.instrumentIdentityId); continue; }
        if (!isDateInHalfOpenInterval(asOfDate, effective.validFrom, effective.validToExclusive)) continue;
        matches.push(alias.instrumentIdentityId);
      }
      if (matches.length === 0 && revokedMatches.length > 0) return Object.freeze({ status: 'UNRESOLVED', code: 'INSTRUMENT_ALIAS_REVOKED', resolvedAsOfSessionDate: asOfDate });
      if (matches.length === 0) return Object.freeze({ status: 'UNRESOLVED', code: 'INSTRUMENT_ALIAS_NOT_FOUND', resolvedAsOfSessionDate: asOfDate });
      if (matches.length > 1) return Object.freeze({ status: 'UNRESOLVED', code: 'INSTRUMENT_ALIAS_AMBIGUOUS', resolvedAsOfSessionDate: asOfDate });
      return Object.freeze({ status: 'RESOLVED', instrumentIdentityId: matches[0], resolvedAsOfSessionDate: asOfDate });
    } catch (cause) {
      if (cause instanceof InstrumentIdentityError) return Object.freeze({ status: 'UNRESOLVED', code: cause.code, resolvedAsOfSessionDate: asOfDate });
      throw cause;
    }
  }
  return Object.freeze({
    resolveAsOf,
    officialResolverInput: Object.freeze({ store, registryManifestId: provenance.registryManifestId, namespacePolicyId: provenance.namespacePolicyId, providerId: lookup.providerId, venueId: lookup.venueId, currency: lookup.currency }),
  });
}

/* ------------------------------------------------------------------- P3H product */

const objectHex = (objectId) => {
  if (typeof objectId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(objectId)) fail('P3H_OBJECT_ID_INVALID', { objectId });
  return objectId.slice(7);
};

export function loadP3hFinalizationR1({ finalizationPath, datasetIdentity, admittedCount, exclusionCount }) {
  const bytes = readFileSync(finalizationPath);
  const datasetSha256 = sha256Bytes(bytes);
  if (`sha256:${datasetSha256}` !== datasetIdentity) fail('P3H_DATASET_IDENTITY_MISMATCH', { observed: datasetSha256 });
  const finalization = JSON.parse(bytes.toString('utf8'));
  if (finalization.schemaVersion !== 'JarviseYahooFetchOnceCohortFinalization/1' || finalization.terminalStage !== 'VERSION_CACHED'
    || finalization.admittedEntries.length !== admittedCount || finalization.exclusions.length !== exclusionCount) {
    fail('P3H_FINALIZATION_HEADER_INVALID');
  }
  const byKey = (left, right) => (left.acquisitionKey < right.acquisitionKey ? -1 : left.acquisitionKey > right.acquisitionKey ? 1 : 0);
  return deepFreeze({
    datasetId: datasetIdentity,
    datasetSha256,
    admittedEntries: [...finalization.admittedEntries].sort(byKey),
    exclusions: [...finalization.exclusions].sort(byKey),
    snapshotRoot: join(dirname(finalizationPath), 'observation-snapshots'),
  });
}

/** Content-addressed read of one admitted key; every binding is re-verified, nothing is repaired. */
export function readP3hAdmittedBarsR1({ p3h, entry }) {
  const readVerified = (path, objectId) => {
    const bytes = readFileSync(path);
    if (sha256Bytes(bytes) !== objectHex(objectId)) fail('P3H_CONTENT_ADDRESS_MISMATCH', { objectId });
    return bytes;
  };
  const snapshotPath = (objectId) => join(p3h.snapshotRoot, 'snapshots', 'sha256', objectHex(objectId).slice(0, 2), `${objectHex(objectId)}.json`);
  const record = JSON.parse(readVerified(snapshotPath(entry.snapshotRecordId), entry.snapshotRecordId).toString('utf8'));
  const core = JSON.parse(readVerified(snapshotPath(entry.snapshotCoreId), entry.snapshotCoreId).toString('utf8'));
  const normalizedHex = objectHex(entry.normalizedObjectId);
  const normalized = JSON.parse(readVerified(join(p3h.snapshotRoot, 'objects', 'normalized', 'sha256', normalizedHex.slice(0, 2), normalizedHex), entry.normalizedObjectId).toString('utf8'));
  const request = record.acquisitionRequestIdentity ?? {};
  if (record.schemaVersion !== 'DatasetSnapshotRecord/1' || core.schemaVersion !== 'DatasetSnapshotCore/1'
    || normalized.schemaVersion !== 'CanonicalDailyBars/1' || record.snapshotCoreId !== entry.snapshotCoreId
    || core.normalizedObjectId !== entry.normalizedObjectId || core.priceBasis !== HISTORICAL_PRICE_BASIS_ID_R1
    || entry.priceBasis !== HISTORICAL_PRICE_BASIS_ID_R1 || core.providerSymbol !== entry.providerSymbol
    || request.calendarWindowBindingId !== HISTORICAL_CALENDAR_BINDING_ID || request.priceBasis !== HISTORICAL_PRICE_BASIS_ID_R1
    || request.providerSymbol !== entry.providerSymbol || request.plane !== HISTORICAL_PLANE_R1 || !Array.isArray(normalized.bars)) {
    fail('P3H_SNAPSHOT_BINDING_INVALID', { acquisitionKey: entry.acquisitionKey });
  }
  return deepFreeze({
    bars: normalized.bars,
    sourceBindingId: request.sourceBindingId,
    normalizedObjectId: entry.normalizedObjectId,
    normalizedSha256: normalizedHex,
  });
}

/* --------------------------------------------------------------- foundation load */

/**
 * Loads the complete foundation authority once per execution: GATE25 R0003 scope
 * (read-only), Calendar V2, the verified V1 production foundation, the V2
 * identities, the historical FeatureSet, the real macro context, the verified
 * identity registry and the P3H finalization.
 */
export function loadJarviseG25HistoricalRegimeFoundationR1({ root = REPOSITORY_ROOT, macroDataRoot, p3hFinalizationPath } = {}) {
  const contract = readPinnedJson(root, GATE25_EXECUTION_CONTRACT_PATH_R1, GATE25_EXECUTION_CONTRACT_SHA256_R1, 'GATE25_EXECUTION_CONTRACT');
  const mandate = readPinnedJson(root, GATE25_MANDATE_PATH_R1, GATE25_MANDATE_SHA256_R1, 'GATE25_MANDATE');
  const admission = contract.canonicalRequirements.find((item) => item.requirementId === 'G25-BUILD-02');
  const scope = admission?.observationAdmissionScope;
  if (admission?.observationAdmissionAuthorized !== true || scope?.restriction !== 'GATE25_HISTORICAL_SCOPE_ONLY'
    || mandate.historyPolicy?.pinSet?.datasetIdentity !== scope.datasetIdentity) {
    fail('GATE25_HISTORICAL_SCOPE_NOT_BOUND');
  }
  const identityPolicy = admission.identityPolicy;
  if (identityPolicy.aliasBackdating !== 'FORBIDDEN' || identityPolicy.identityResolutionRule !== 'RESOLVE_AT_EACH_HISTORICAL_SESSION_DATE') {
    fail('GATE25_IDENTITY_POLICY_UNEXPECTED');
  }

  const calendarWindowBinding = computeJarviseHistoricalCalendarBindingR1({ root });
  const calendar = loadJarviseHistoricalCalendarR1({ root });
  const window = scope.historicalObservationWindow;
  const windowSessions = calendar.sessions.filter((session) => session.sessionDate >= window.startSessionInclusive && session.sessionDate <= window.endSessionInclusive);
  if (windowSessions[0]?.sessionDate !== window.startSessionInclusive || windowSessions.at(-1)?.sessionDate !== window.endSessionInclusive) {
    fail('HISTORICAL_WINDOW_NOT_CALENDAR_ALIGNED');
  }

  const productionFoundation = loadJarviseG24ProductionFoundationR1();
  const v2 = createHistoricalV2RegimeIdentitiesR1({ productionFoundation, calendarWindowBinding });
  const registry = createFeatureRegistry([F1_DEFINITION, F2_REALIZED_VOLATILITY_DEFINITION_R1]);
  const vector = declareFeatureVector(HISTORICAL_FEATURE_VECTOR_MEMBERS_R1);
  const featureDefinitionSet = HISTORICAL_FEATURE_VECTOR_MEMBERS_R1.map((member) => {
    const definition = member.featureDefinitionId === F1_DEFINITION.featureDefinitionId ? F1_DEFINITION : F2_REALIZED_VOLATILITY_DEFINITION_R1;
    return { featureDefinitionId: definition.featureDefinitionId, formulaId: definition.formulaId, featureWindowSpecId: createFeatureWindowSpec({ sessionCount: member.sessionCount, calendarWindowBinding }).featureWindowSpecId };
  }).sort((left, right) => left.featureDefinitionId.localeCompare(right.featureDefinitionId) || left.featureWindowSpecId.localeCompare(right.featureWindowSpecId));
  const horizonWindowSpec = createFeatureWindowSpec({ sessionCount: v2.horizon.sessionCount, calendarWindowBinding });

  const macroAuthority = loadJarviseG25HistoricalMacroAuthorityR1({ dataRoot: macroDataRoot });
  const macro = prepareJarviseG25HistoricalMacroContextR1({ authority: macroAuthority, sessions: calendar.sessions });
  const identityResolver = createVerifiedHistoricalIdentityResolverR1({ root });
  const p3h = loadP3hFinalizationR1({
    finalizationPath: p3hFinalizationPath ?? mandate.historyPolicy.pinSet.artifactPath,
    datasetIdentity: scope.datasetIdentity,
    admittedCount: scope.cohort.admittedCount,
    exclusionCount: scope.cohort.exclusionCount,
  });
  /* P3H acquisition requests carry the P3 encoding (lab canonicalHash) of the same ratified
     R2SourceBinding/1 preimage; the declaration bytes are re-verified before it is recomputed. */
  const sourceDeclaration = deriveJarviseSourceBindingIdR1();
  const expectedSourceBindingId = sourceBindingIdR1(sourceDeclaration.sourceBasisDeclarationSha256);

  return Object.freeze({
    foundationId: FOUNDATION_ID_R1,
    root,
    scope: deepFreeze({ ...scope }),
    identityPolicy: deepFreeze({ ...identityPolicy }),
    calendarWindowBinding,
    calendarSessions: Object.freeze(calendar.sessions),
    calendarIndex: new Map(calendar.sessions.map((session, index) => [session.sessionDate, index])),
    windowSessions: Object.freeze(windowSessions),
    windowSessionIndex: new Map(windowSessions.map((session, index) => [session.sessionDate, index])),
    productionFoundation,
    v2,
    registry,
    vector,
    featureDefinitionSet: deepFreeze(featureDefinitionSet),
    horizonWindowSpec,
    macroAuthority,
    macro,
    identityResolver,
    p3h,
    expectedSourceBindingId,
    f2Producer: describeF2ProducerR1(),
  });
}

/* --------------------------------------------------------------- dataset identities */

export function deriveHistoricalObservationDatasetIdR1({ foundation, acquisitionKey, sourceBindingId, instrumentIdentityId, knowledgeCutoff, admittedWindowBars }) {
  const preimage = {
    schemaVersion: HISTORICAL_OBSERVATION_DATASET_SCHEMA_R1,
    eligibleHistoryPinSetId: foundation.p3h.datasetId,
    acquisitionKey,
    sourceBindingId,
    instrumentIdentityId,
    effectiveKnowledgeCutoff: knowledgeCutoff,
    plane: HISTORICAL_PLANE_R1,
    priceBasisId: HISTORICAL_PRICE_BASIS_ID_R1,
    calendarWindowBindingId: foundation.calendarWindowBinding.calendarWindowBindingId,
    admittedWindowBars: admittedWindowBars.map((bar) => Object.fromEntries(BAR_FIELDS.map((field) => [field, bar[field] ?? null]))),
  };
  return sha256Canonical(preimage);
}

export function deriveHistoricalFeatureDatasetIdR1({ foundation, datasetIdObservation }) {
  return sha256Canonical({
    schemaVersion: HISTORICAL_FEATURE_DATASET_SCHEMA_R1,
    datasetIdObservation,
    featureDefinitionSet: foundation.featureDefinitionSet,
    materializerModuleVersion: FEATURE_MATERIALIZER_VERSION,
  });
}

/* ------------------------------------------------------------------ record emission */

const refusal = (code, details = {}) => Object.freeze({ status: 'FAIL_CLOSED', code, ...details });

/**
 * Calendar V2 holds only admitted session kinds, sorted and unique, so every trailing
 * window anchored at T and the pinned-session lookup read only sessions at or before
 * T. A slice ending at T and starting MAX_WINDOW + margin sessions earlier (or at the
 * calendar start) therefore yields identical GATE23 windows and identical
 * INSUFFICIENT_DATA decisions, at a fraction of the sort cost.
 */
const TRAILING_CALENDAR_MARGIN_R1 = 8;
export function trailingCalendarSliceR1({ foundation, sessionDate }) {
  const index = foundation.calendarIndex.get(sessionDate);
  if (index === undefined) fail('CALENDAR_SESSION_ABSENT', { sessionDate });
  return foundation.calendarSessions.slice(Math.max(0, index - MAX_WINDOW_SESSION_COUNT - TRAILING_CALENDAR_MARGIN_R1), index + 1);
}

/**
 * Emits the historical RegimeRecord for one (admitted key, session T), or an explicit
 * refusal. `keyBars` is readP3hAdmittedBarsR1 output for the key.
 */
export function emitJarviseG25HistoricalRegimeRecordR1({ foundation, entry, keyBars, sessionDate }) {
  const index = foundation.windowSessionIndex.get(sessionDate);
  if (index === undefined) return refusal('SESSION_OUTSIDE_GATE25_HISTORICAL_WINDOW');
  if (keyBars.sourceBindingId !== foundation.expectedSourceBindingId) return refusal('P3H_SOURCE_BINDING_MISMATCH');
  const calendarSlice = trailingCalendarSliceR1({ foundation, sessionDate });
  const pinned = resolvePinnedCanonicalSession({ sessionDate, calendarWindowBinding: foundation.calendarWindowBinding, sessions: calendarSlice });
  if (pinned.status !== 'RESOLVED') return refusal('PINNED_CANONICAL_SESSION_NOT_RESOLVED', { pinnedCode: pinned.code });
  const knowledgeCutoff = pinned.knowledgeCutoff;

  const identity = foundation.identityResolver.resolveAsOf(entry.providerSymbol, sessionDate);
  if (identity.status !== 'RESOLVED') {
    return refusal('INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE', { identityCode: identity.code });
  }

  const macroSnapshot = foundation.macro.snapshotAt({ sessionDate, knowledgeCutoff });
  if (macroSnapshot.status !== 'RESOLVED') return refusal('HISTORICAL_MACRO_CONTEXT_NOT_RESOLVED', { macroStatus: macroSnapshot.status });

  const windowDates = new Set(foundation.windowSessions.slice(Math.max(0, index - MAX_WINDOW_SESSION_COUNT), index + 1).map((session) => session.sessionDate));
  const admittedWindowBars = keyBars.bars.filter((bar) => windowDates.has(bar.sessionDate));
  if (admittedWindowBars.some((bar) => typeof bar.availableAt !== 'string' || bar.availableAt > knowledgeCutoff)) {
    return refusal('OBSERVATION_AVAILABLE_AFTER_KNOWLEDGE_CUTOFF');
  }
  const observationBars = admittedWindowBars.map((bar) => ({
    recordType: 'Observation',
    sessionDate: bar.sessionDate,
    close: bar.close,
    volume: bar.volume,
    priceBasisId: HISTORICAL_PRICE_BASIS_ID_R1,
    provenance: { producerGateId: 'GATE21', originRecordType: 'Observation', availableAt: bar.availableAt },
  }));
  const datasetIdObservation = deriveHistoricalObservationDatasetIdR1({
    foundation, acquisitionKey: entry.acquisitionKey, sourceBindingId: keyBars.sourceBindingId,
    instrumentIdentityId: identity.instrumentIdentityId, knowledgeCutoff, admittedWindowBars,
  });
  const datasetIdFeature = deriveHistoricalFeatureDatasetIdR1({ foundation, datasetIdObservation });

  const featureSet = materializeFeatureRecords({
    instrumentIdentityId: identity.instrumentIdentityId,
    sessionDate,
    calendarWindowBinding: foundation.calendarWindowBinding,
    sessions: calendarSlice,
    observationBars,
    registry: foundation.registry,
    vector: foundation.vector,
    sourceBindingId: keyBars.sourceBindingId,
    datasetIdObservation,
  });
  if (featureSet.status !== 'RESOLVED') return refusal('FEATURE_SET_CORE_NOT_RESOLVED', { featureSetStatus: featureSet.status, featureSetCode: featureSet.code });
  const horizonBinding = resolveProductionCalendarWindowBinding({ featureSet, calendarWindowBinding: foundation.calendarWindowBinding });
  if (horizonBinding.status !== 'RESOLVED' || horizonBinding.calendarWindowBindingId !== foundation.v2.horizon.calendarWindowBindingId) {
    return refusal('FEATURE_SET_CALENDAR_BINDING_NOT_HORIZON_BINDING', { horizonBinding });
  }
  const featureVectorBinding = createFeatureVectorBinding({ featureSet: { ...featureSet, datasetIdFeature } });

  const horizonWindow = resolveTrailingWindow({ sessionDate, featureWindowSpec: foundation.horizonWindowSpec, calendarWindowBinding: foundation.calendarWindowBinding, sessions: calendarSlice });
  const horizonStartKnowledgeCutoff = horizonWindow.status === 'RESOLVED' ? horizonWindow.sessions[0].closeUtc : null;

  const regimeRecord = emitRegimeRecord({
    instrumentIdentityId: identity.instrumentIdentityId,
    sessionDate,
    knowledgeCutoff,
    knowledgeCutoffBoundary: featureSet.knowledgeCutoffBoundary,
    regimeHorizonSpec: foundation.v2.horizon,
    featureVectorBinding,
    macroContextBinding: foundation.macro.macroContextBinding,
    macroSnapshot: macroSnapshot.snapshot,
    vintageStore: foundation.macro.vintageStore,
    horizonStartKnowledgeCutoff,
    classifierVersion: foundation.v2.classifier,
    parameterSet: foundation.v2.parameterSet,
    featureSet,
    datasetIdFeature,
    declaredMacroCompleteness: macroSnapshot.snapshot.macroFeatureCompleteness,
  });

  return Object.freeze({
    status: 'EMITTED',
    code: null,
    acquisitionKey: entry.acquisitionKey,
    sessionDate,
    knowledgeCutoff,
    instrumentIdentityId: identity.instrumentIdentityId,
    datasetIdObservation,
    datasetIdFeature,
    featureSet,
    featureVectorBinding,
    horizonStartKnowledgeCutoff,
    macroSnapshot: macroSnapshot.snapshot,
    regimeRecord,
    keyBars,
  });
}

/* --------------------------------------------------------------------- projections */

export function coreV1ClassificationR1(regimeRecord) {
  return Object.freeze(Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((dimension) => [dimension, Object.freeze({
    value: regimeRecord.regimeVector[dimension],
    classifying: isClassifyingValue(dimension, regimeRecord.regimeVector[dimension]),
  })])));
}

/**
 * The GATE25 phase-1 inputs for an emitted record, in the exact shapes the GATE25
 * readers close over: the GATE24 FeatureVectorBinding, the distance FeatureRecords,
 * the GATE24 RegimeRecord and one availability proof per consumed input.
 */
export function projectGate25AnalogueInputsR1({ foundation, emitted }) {
  if (emitted?.status !== 'EMITTED') fail('GATE25_PROJECTION_REQUIRES_EMITTED_RECORD');
  const byKey = new Map(emitted.featureSet.records.map((record) => [memberKey(record), record]));
  const barsByDate = new Map(emitted.keyBars.bars.map((bar) => [bar.sessionDate, bar]));
  const features = {};
  const inputProofs = [];
  for (const key of GATE25_DISTANCE_FEATURE_KEYS_R1) {
    const record = byKey.get(key);
    if (!record) fail('GATE25_PROJECTION_FEATURE_ABSENT', { key });
    features[key] = { featureRecordId: record.featureRecordId, status: record.status, code: record.code, value: record.value };
    if (record.status !== 'RESOLVED') continue;
    const window = resolveTrailingWindow({
      sessionDate: emitted.sessionDate,
      featureWindowSpec: createFeatureWindowSpec({ sessionCount: record.sessionCount, calendarWindowBinding: foundation.calendarWindowBinding }),
      calendarWindowBinding: foundation.calendarWindowBinding,
      sessions: trailingCalendarSliceR1({ foundation, sessionDate: emitted.sessionDate }),
    });
    if (window.status !== 'RESOLVED') fail('GATE25_PROJECTION_WINDOW_NOT_RESOLVED', { key });
    const availableAt = window.sessions.reduce((latest, session) => {
      const bar = barsByDate.get(session.sessionDate);
      if (!bar) fail('GATE25_PROJECTION_WINDOW_BAR_ABSENT', { key, sessionDate: session.sessionDate });
      return bar.availableAt > latest ? bar.availableAt : latest;
    }, '');
    inputProofs.push({ inputId: key, sourceArtifactId: emitted.keyBars.normalizedObjectId, sourceArtifactSha256: emitted.keyBars.normalizedSha256, availableAt });
  }
  inputProofs.push({
    inputId: GATE25_REGIME_RECORD_PROOF_INPUT_ID_R1,
    sourceArtifactId: `GATE24_RegimeRecord/1:${emitted.regimeRecord.regimeRecordId}`,
    sourceArtifactSha256: sha256Canonical(emitted.regimeRecord),
    availableAt: emitted.regimeRecord.KnowledgeCutoff,
  });
  return {
    sessionDate: emitted.sessionDate,
    knowledgeCutoff: emitted.knowledgeCutoff,
    priceBasisId: HISTORICAL_PRICE_BASIS_ID_R1,
    featureVectorBinding: { ...emitted.featureVectorBinding, featureRecordIds: [...emitted.featureVectorBinding.featureRecordIds], featureWindowSpecIds: [...emitted.featureVectorBinding.featureWindowSpecIds], calendarWindowBindingIds: [...emitted.featureVectorBinding.calendarWindowBindingIds] },
    features,
    regimeRecord: emitted.regimeRecord,
    inputProofs,
    sourceBindingId: emitted.keyBars.sourceBindingId,
  };
}

/** The D1 members this foundation owns, read off the emitted record. */
export function foundationD1MembersR1({ foundation, emitted }) {
  const identity = emitted.regimeRecord.identity;
  return Object.freeze({
    InstrumentIdentityId: identity.InstrumentIdentityId,
    SessionDate: identity.SessionDate,
    KnowledgeCutoff: identity.KnowledgeCutoff,
    FeatureVectorBindingId: identity.FeatureVectorBindingId,
    RegimeRecordId: emitted.regimeRecord.regimeRecordId,
    RegimeHorizonSpecId: identity.RegimeHorizonSpecId,
    MacroContextBindingId: identity.MacroContextBindingId,
    EligibleHistoryPinSetId: foundation.p3h.datasetId,
    PriceBasisId: HISTORICAL_PRICE_BASIS_ID_R1,
  });
}

export function describeJarviseG25HistoricalRegimeFoundationR1(foundation) {
  return Object.freeze({
    foundationId: FOUNDATION_ID_R1,
    calendarWindowBindingId: foundation.calendarWindowBinding.calendarWindowBindingId,
    gate24V1CalendarWindowBindingId: GATE24_V1_CALENDAR_BINDING_ID,
    regimeHorizonSpecId: foundation.v2.horizon.regimeHorizonSpecId,
    classifierVersionId: foundation.v2.classifier.classifierVersionId,
    parameterSetId: foundation.v2.parameterSet.parameterSetId,
    productionV1: {
      regimeHorizonSpecId: foundation.productionFoundation.horizon.regimeHorizonSpecId,
      classifierVersionId: foundation.productionFoundation.classifier.classifierVersionId,
      parameterSetId: foundation.productionFoundation.parameterSet.parameterSetId,
    },
    macroContextBindingId: foundation.macro.macroContextBinding.macroContextBindingId,
    macroVintageStoreProjectionDigest: foundation.macro.projectionDigest,
    featureDefinitionSet: foundation.featureDefinitionSet,
    historicalFeatureVectorMembers: HISTORICAL_FEATURE_VECTOR_MEMBERS_R1.map(memberKey),
    eligibleHistoryPinSetId: foundation.p3h.datasetId,
    f2Producer: foundation.f2Producer,
    closedP2BoundaryMutated: false,
    gate24ProductionV1Mutated: false,
    networkAccess: 'NONE',
    brokerAccess: 'NONE',
    modelInference: 'NONE',
    liveWheelScanCoupling: 'NONE',
  });
}

export const sha256HexR1 = (bytes) => createHash('sha256').update(bytes).digest('hex');
