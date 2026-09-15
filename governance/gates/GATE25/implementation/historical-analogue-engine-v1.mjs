/**
 * GATE25 HISTORICAL ANALOGUE ENGINE, OFF_SCAN.
 *
 * Two-phase transformation under EXECUTION_CONTRACT_R0003:
 *   Phase 1 SELECTION          exact eligibility, min-max normalization over the
 *                              eligible historical universe, Manhattan L1, ranking,
 *                              support report, selectionComplete freeze.
 *   Phase 2 OUTCOME_ATTACHMENT GATE22 horizons attached to the frozen set only.
 *
 * Authority is read from the pinned bytes of R0003, the ratified mandate and the
 * GATE22 horizon contract, and every D1-D8 binding artifact is verified against
 * R0003 before any computation. The P3H adapter consumes the frozen P3H product
 * read-only by content address.
 *
 * No network, no provider, no broker, no model inference, no wall clock, no random
 * source. The live Wheel scan never calls this module.
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { simpleReturn } from '../../GATE23/implementation/feature-families-v1.mjs';
import { resolvePinnedCanonicalSession } from '../../GATE23/implementation/feature-window-v1.mjs';
import { createHorizon, resolveOutcomeWindow } from '../../GATE22/implementation/temporal-horizon-v1.mjs';
import {
  HISTORICAL_CALENDAR_BINDING_ID,
  computeJarviseHistoricalCalendarBindingR1,
  loadJarviseHistoricalCalendarR1,
} from '../../../../app/jarvise/jarviseHistoricalCalendarBindingR1.mjs';
import {
  describeJarviseG25HistoricalRegimeFoundationR1,
  emitJarviseG25HistoricalRegimeRecordR1,
  loadJarviseG25HistoricalRegimeFoundationR1,
  projectGate25AnalogueInputsR1,
  readP3hAdmittedBarsR1,
  coreV1ClassificationR1,
} from '../../../../app/jarvise/jarviseG25HistoricalRegimeFoundationR1.mjs';
import { createContentAddressedStore } from '../../../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { verifyInstrumentIdentityRegistry } from '../../../../research/directional-lab/src/data/buildInstrumentIdentityRegistry.mjs';
import { verifySymbolNamespacePolicy } from '../../../../research/directional-lab/src/data/instrumentIdentityBuildersCore.mjs';
import {
  computeSymbolLookupKey,
  effectiveBindingInterval,
  isDateInHalfOpenInterval,
  namespacePolicyBindingProblems,
} from '../../../../research/directional-lab/src/contracts/instrumentIdentityV1.mjs';

import {
  Gate25FailClosedError,
  createAnalogueIdentity,
  failClosed,
  isCanonicalUtcInstant,
  isExactGovernedString,
} from './analogue-identity-v1.mjs';
import {
  CANDIDATE_SCHEMA_V1,
  CORE_V1_DIMENSIONS_V1,
  P3H_EXCLUSION_CLASS_REASONS_V1,
  QUERY_SCHEMA_V1,
  coreV1Factors,
  coreV1Signature,
  deriveAnalogueIdentityMembers,
  evaluateEligibleUniverse,
  historicallyCausal,
  readAnalogueQuery,
  readHistoricalCandidate,
} from './analogue-eligibility-v1.mjs';
import {
  DISTANCE_FEATURE_IDS_V1,
  DISTANCE_METRIC_V1,
  DISTANCE_PARAMETER_SET_ID_V1,
  NORMALIZATION_POPULATION_V1,
  computeDistanceEvidence,
  computeNormalizationBounds,
} from './analogue-distance-v1.mjs';
import {
  ANALOGUE_INDEX_PRODUCT_PATH_V1,
  analogueIndexSha256,
  appendIndexRecord,
  buildIndexRecord,
  compareCodeUnits,
  createAnalogueIndex,
  mergeAnalogueIndexBytes,
  parseAnalogueIndex,
  rankQueryResults,
  readIndexRecord,
} from './analogue-index-v1.mjs';
import { buildComparisonReport, buildSupportReport } from './analogue-report-v1.mjs';
import { admissibleHorizonBindings, attachPostSelectionOutcomes, freezeSelection } from './analogue-outcome-v1.mjs';
import {
  PROVENANCE_PRODUCT_PATH_V1,
  PROVENANCE_SCHEMA_V1,
  buildInputProof,
  buildProvenanceManifest,
  verifyProvenanceIndexBinding,
} from './analogue-provenance-v1.mjs';

export const ENGINE_VERSION = 'GATE25_HistoricalAnalogueEngine/1';
export const ENGINE_PRODUCT_CLASS = 'OFF_SCAN';
export const SELECTION_POLICY_VERSION_SCHEMA_V1 = 'GATE25_SelectionPolicyVersion/1';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const EXECUTION_CONTRACT_PATH = 'governance/gates/GATE25/contracts/EXECUTION_CONTRACT_R0003.json';
export const EXECUTION_CONTRACT_SHA256 = 'f369ce7844167a5ae46940dcd1e2edd61f1b92327893723cd6953d8fafa0578f';
export const MANDATE_PATH = 'governance/sources/GATE25_CANONICAL_MANDATE_R0.json';
export const MANDATE_SHA256 = '0aefedc757e2ba749ebd25a2cd40dc2070fafb04f3ac8f7b194c08d2b513c618';

export const BINDING_ARTIFACTS_V1 = Object.freeze([
  Object.freeze({ bindingId: 'GATE25_ANALOGUE_IDENTITY_V1', requirementId: 'G25-BUILD-04' }),
  Object.freeze({ bindingId: 'GATE25_ANALOGUE_COMPARISON_REPORT_V1', requirementId: 'G25-BUILD-05' }),
  Object.freeze({ bindingId: 'GATE25_ANALOGUE_SUPPORT_REPORT_V1', requirementId: 'G25-BUILD-06' }),
  Object.freeze({ bindingId: 'GATE25_ANALOGUE_INDEX_V1', requirementId: 'G25-BUILD-07' }),
  Object.freeze({ bindingId: 'GATE25_ANALOGUE_PROVENANCE_MANIFEST_V1', requirementId: 'G25-BUILD-08' }),
  Object.freeze({ bindingId: 'GATE25_DISTANCE_PARAMETERS_V1', requirementId: 'G25-BUILD-09' }),
  Object.freeze({ bindingId: 'GATE25_ELIGIBILITY_EXCLUSION_REASON_V1', requirementId: 'G25-BUILD-10' }),
  Object.freeze({ bindingId: 'GATE25_POST_SELECTION_OUTCOME_SET_V1', requirementId: 'G25-BUILD-11' }),
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Map) && !(value instanceof Set)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function readPinnedBytes(root, path, expectedSha256, code) {
  let bytes;
  try {
    bytes = readFileSync(resolve(root, path));
  } catch (cause) {
    failClosed(`${code}_ABSENT`, { path, cause: cause.code });
  }
  const observed = sha256Bytes(bytes);
  if (observed !== expectedSha256) failClosed(`${code}_SHA256_MISMATCH`, { path, observed });
  return bytes;
}

/* ---------------------------------------------------------------------- authority */

/**
 * Loads and verifies the complete BUILD authority. Every binding the engine uses
 * is the R0003 binding object; each persisted artifact must reproduce it exactly.
 */
export function loadGate25BuildAuthority({ root = REPOSITORY_ROOT } = {}) {
  const contract = JSON.parse(readPinnedBytes(root, EXECUTION_CONTRACT_PATH, EXECUTION_CONTRACT_SHA256, 'EXECUTION_CONTRACT').toString('utf8'));
  if (contract.gateId !== 'GATE25' || contract.contractRevision !== 'R0003') failClosed('EXECUTION_CONTRACT_REVISION_INVALID');
  const mandate = JSON.parse(readPinnedBytes(root, MANDATE_PATH, MANDATE_SHA256, 'MANDATE').toString('utf8'));
  const requirements = new Map(contract.canonicalRequirements.map((requirement) => [requirement.requirementId, requirement]));

  const bindings = {};
  for (const { bindingId, requirementId } of BINDING_ARTIFACTS_V1) {
    const requirement = requirements.get(requirementId);
    if (requirement?.bindingId !== bindingId || requirement.resolutionStatus !== 'OWNER_RESOLVED') {
      failClosed('BINDING_REQUIREMENT_UNRESOLVED', { bindingId });
    }
    let artifact;
    try {
      artifact = JSON.parse(readFileSync(resolve(root, requirement.bindingArtifactPath), 'utf8'));
    } catch (cause) {
      failClosed('BINDING_ARTIFACT_ABSENT', { bindingId, cause: cause.code ?? cause.message });
    }
    if (artifact.bindingId !== bindingId || artifact.requirementId !== requirementId
      || artifact.authority?.executionContractSha256 !== EXECUTION_CONTRACT_SHA256
      || sha256Canonical(artifact.binding) !== sha256Canonical(requirement.binding)
      || artifact.authority?.bindingSha256Canonical !== sha256Canonical(requirement.binding)) {
      failClosed('BINDING_ARTIFACT_DIVERGES_FROM_R0003', { bindingId });
    }
    bindings[bindingId] = requirement.binding;
  }

  const horizonSource = bindings.GATE25_POST_SELECTION_OUTCOME_SET_V1.horizonSource;
  const horizonContract = JSON.parse(readPinnedBytes(root, horizonSource.path, horizonSource.sha256, 'HORIZON_CONTRACT').toString('utf8'));

  const admission = requirements.get('G25-BUILD-02');
  const scope = admission?.observationAdmissionScope;
  if (admission?.observationAdmissionAuthorized !== true || scope?.restriction !== 'GATE25_HISTORICAL_SCOPE_ONLY') {
    failClosed('OBSERVATION_ADMISSION_SCOPE_ABSENT');
  }
  const pinSet = mandate.historyPolicy?.pinSet;
  if (pinSet?.datasetIdentity !== scope.datasetIdentity || pinSet.admittedKeyDigest !== scope.admittedKeyDigest
    || pinSet.exclusionDigest !== scope.exclusionDigest) {
    failClosed('MANDATE_PIN_SET_DIVERGES_FROM_R0003');
  }
  const authorizedPaths = contract.authorizedPaths;
  if (!Array.isArray(authorizedPaths) || authorizedPaths.length !== 22 || new Set(authorizedPaths).size !== 22
    || authorizedPaths.some((path) => /[*?[\]]/.test(path))) {
    failClosed('AUTHORIZED_PATHS_NOT_EXACT');
  }
  return deepFreeze({
    contractSha256: EXECUTION_CONTRACT_SHA256,
    mandateSha256: MANDATE_SHA256,
    authorizedPaths: [...authorizedPaths],
    bindings,
    horizonContract,
    scope: {
      datasetIdentity: scope.datasetIdentity,
      admittedKeyDigest: scope.admittedKeyDigest,
      exclusionDigest: scope.exclusionDigest,
      admittedCount: scope.cohort.admittedCount,
      exclusionCount: scope.cohort.exclusionCount,
      cohortStatus: scope.cohort.status,
      historicalObservationWindow: { ...scope.historicalObservationWindow },
    },
    identityPolicy: { ...admission.identityPolicy },
    p3hFinalizationPath: pinSet.artifactPath,
  });
}

/* ---------------------------------------------------------------- selection policy */

export function createSelectionPolicyVersion({ authority, eligibleHistoryPinSetId, historicalObservationWindow }) {
  const payload = {
    schema: SELECTION_POLICY_VERSION_SCHEMA_V1,
    executionContractSha256: authority.contractSha256,
    identityBindingSha256: sha256Canonical(authority.bindings.GATE25_ANALOGUE_IDENTITY_V1),
    supportBindingSha256: sha256Canonical(authority.bindings.GATE25_ANALOGUE_SUPPORT_REPORT_V1),
    indexBindingSha256: sha256Canonical(authority.bindings.GATE25_ANALOGUE_INDEX_V1),
    distanceBindingSha256: sha256Canonical(authority.bindings.GATE25_DISTANCE_PARAMETERS_V1),
    eligibilityBindingSha256: sha256Canonical(authority.bindings.GATE25_ELIGIBILITY_EXCLUSION_REASON_V1),
    coreV1Dimensions: [...CORE_V1_DIMENSIONS_V1],
    distanceFeatureIds: [...DISTANCE_FEATURE_IDS_V1],
    historicalObservationWindow: {
      startSessionInclusive: historicalObservationWindow.startSessionInclusive,
      endSessionInclusive: historicalObservationWindow.endSessionInclusive,
    },
    eligibleHistoryPinSetId,
    identityPolicy: {
      identityResolutionRule: authority.identityPolicy.identityResolutionRule,
      aliasBackdating: authority.identityPolicy.aliasBackdating,
      retroactive2026IdentityApplication: authority.identityPolicy.retroactive2026IdentityApplication,
    },
  };
  return deepFreeze({ ...payload, selectionPolicyVersionId: sha256Canonical(payload) });
}

/**
 * Explicit selection context. The pin set carries every key the universe may
 * contain: admitted keys, and excluded keys with their P3H exclusion class.
 */
export function createSelectionPolicy({
  authority, datasetId, datasetSha256, historicalObservationWindow, admittedKeyIds, exclusionClassByKeyId, outcomeCalendarRegistryManifestId,
}) {
  if (!isExactGovernedString(datasetId) || typeof datasetSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(datasetSha256)) {
    failClosed('SELECTION_POLICY_DATASET_BINDING_INVALID');
  }
  if (!(admittedKeyIds instanceof Set) || !(exclusionClassByKeyId instanceof Map)) failClosed('SELECTION_POLICY_PIN_SET_INVALID');
  for (const [keyId, exclusionClass] of exclusionClassByKeyId) {
    if (admittedKeyIds.has(keyId)) failClosed('SELECTION_POLICY_PIN_SET_OVERLAP', { keyId });
    if (P3H_EXCLUSION_CLASS_REASONS_V1[exclusionClass] === undefined) failClosed('P3H_EXCLUSION_CLASS_NOT_MAPPED', { exclusionClass });
  }
  const version = createSelectionPolicyVersion({ authority, eligibleHistoryPinSetId: datasetId, historicalObservationWindow });
  return Object.freeze({
    selectionPolicyVersion: version,
    selectionPolicyVersionId: version.selectionPolicyVersionId,
    datasetId,
    datasetSha256,
    eligibleHistoryPinSetId: datasetId,
    historicalObservationWindow: Object.freeze({ ...historicalObservationWindow }),
    pinSet: Object.freeze({ admittedKeyIds, exclusionClassByKeyId }),
    outcomeCalendarRegistryManifestId,
  });
}

/**
 * Production binding: the dataset must be exactly the R0003 bounded historical
 * scope, and outcome horizons are composed over the historical calendar registry
 * that the P3H observations are bound to.
 */
export function bindR0003SelectionPolicy({ authority, p3h, calendar }) {
  const scope = authority.scope;
  if (p3h?.datasetId !== scope.datasetIdentity || `sha256:${p3h.datasetSha256}` !== scope.datasetIdentity
    || p3h.admittedKeyDigest !== scope.admittedKeyDigest || p3h.exclusionDigest !== scope.exclusionDigest
    || p3h.pinSet?.admittedKeyIds?.size !== scope.admittedCount || p3h.pinSet?.exclusionClassByKeyId?.size !== scope.exclusionCount) {
    failClosed('DATASET_BINDING_NOT_R0003_SCOPE');
  }
  if (calendar?.calendarWindowBindingId !== HISTORICAL_CALENDAR_BINDING_ID || !isExactGovernedString(calendar.calendarRegistryManifestId)) {
    failClosed('HISTORICAL_CALENDAR_BINDING_NOT_BOUND');
  }
  return createSelectionPolicy({
    authority,
    datasetId: p3h.datasetId,
    datasetSha256: p3h.datasetSha256,
    historicalObservationWindow: scope.historicalObservationWindow,
    admittedKeyIds: p3h.pinSet.admittedKeyIds,
    exclusionClassByKeyId: p3h.pinSet.exclusionClassByKeyId,
    outcomeCalendarRegistryManifestId: calendar.calendarRegistryManifestId,
  });
}

/* ------------------------------------------------------------------------ pipeline */

function rethrowWithAccounting(fn, accounting) {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof Gate25FailClosedError) throw new Gate25FailClosedError(cause.code, { ...cause.details, accounting });
    throw cause;
  }
}

/**
 * Runs one analogue query over one candidate universe. Outcomes are attached only
 * after the selection is frozen and the reports that depend on it are built.
 */
export function runAnalogueSelection({ authority, policy, query, candidates, outcomeSource = null, analogueIndex = null, historicalOutcomeUniverse = null }) {
  const queryContext = readAnalogueQuery(query, policy);
  const universe = evaluateEligibleUniverse({ candidates, query: queryContext, policy });
  const accounting = Object.freeze({
    universeCount: universe.universeCount,
    eligibleCount: universe.eligibleCount,
    excludedCount: universe.excludedCount,
    exclusionCountsByReason: universe.exclusionCountsByReason,
    decisionDigest: universe.decisionDigest,
    structuralGatesPass: queryContext.structuralGatesPass,
  });
  const support = rethrowWithAccounting(() => buildSupportReport({
    universeCount: universe.universeCount,
    eligibleCount: universe.eligibleCount,
    excludedCount: universe.excludedCount,
    exclusionCountsByReason: universe.exclusionCountsByReason,
    structuralGatesPass: queryContext.structuralGatesPass,
  }), accounting);

  const queryMembers = deriveAnalogueIdentityMembers({ context: queryContext, policy });
  if (!queryMembers.formable) {
    failClosed('QUERY_IDENTITY_NOT_FORMABLE', {
      missingMembers: queryMembers.missingMembers,
      accounting,
      supportReport: support.report,
      supportReportId: support.supportReportId,
    });
  }
  const queryIdentity = createAnalogueIdentity(queryMembers.members);
  if (universe.eligibleCount > 0 && !queryContext.features.complete) {
    failClosed('QUERY_DISTANCE_FEATURE_INCOMPLETE', { accounting });
  }

  const analogues = universe.eligible.map(({ context }) => {
    const derived = deriveAnalogueIdentityMembers({ context, policy });
    if (!derived.formable) failClosed('ELIGIBLE_CANDIDATE_IDENTITY_NOT_FORMABLE', { candidateKey: context.candidateKey, missingMembers: derived.missingMembers });
    const identity = createAnalogueIdentity(derived.members);
    const record = buildIndexRecord({ identity, p3hKeyId: context.p3hKeyId, regime: context.regime, features: context.features, inputProofs: context.inputProofs });
    if (analogueIndex !== null) {
      const persisted = readIndexRecord(analogueIndex, identity.analogueIdentityId);
      if (persisted === null) failClosed('SELECTED_ANALOGUE_NOT_IN_INDEX', { analogueIdentityId: identity.analogueIdentityId });
      if (sha256Canonical(persisted) !== sha256Canonical(record)) failClosed('SELECTED_ANALOGUE_DIVERGES_FROM_INDEX', { analogueIdentityId: identity.analogueIdentityId });
    }
    return { context, identity, record };
  });

  /* Normalization population: eligible historical candidates only. */
  const normalizationBounds = analogues.length === 0 ? [] : computeNormalizationBounds(analogues.map(({ context }) => context.features.values));
  const byIdentity = new Map(analogues.map((analogue) => [analogue.identity.analogueIdentityId, analogue]));
  const ranked = rankQueryResults(analogues.map(({ context, identity }) => ({
    analogueIdentityId: identity.analogueIdentityId,
    sessionDate: context.sessionDate,
    ...computeDistanceEvidence({
      queryFeatureValues: queryContext.features.values,
      candidateFeatureValues: context.features.values,
      bounds: normalizationBounds,
    }),
    commonFactors: coreV1Factors(context.regime),
  })));

  const frozenSelection = freezeSelection({ queryIdentityId: queryIdentity.analogueIdentityId, rankedAnalogues: ranked });
  const comparison = buildComparisonReport({
    queryIdentityId: queryIdentity.analogueIdentityId,
    datasetId: policy.datasetId,
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
    knowledgeCutoff: queryContext.knowledgeCutoff,
    supportReport: support.report,
    rankedAnalogues: ranked,
  });

  /* Phase 2: only now does any outcome become visible. */
  const horizonBindings = admissibleHorizonBindings({
    horizonContract: authority.horizonContract,
    calendarRegistryManifestId: policy.outcomeCalendarRegistryManifestId,
  });
  const resolvedOutcomeSource = outcomeSource ?? (historicalOutcomeUniverse === null
    ? null
    : createHistoricalObservationOutcomeSource({
      universe: historicalOutcomeUniverse,
      analogueBindings: new Map(analogues.map((analogue) => [analogue.identity.analogueIdentityId, Object.freeze({
        sessionDate: analogue.context.sessionDate,
        p3hKeyId: analogue.context.p3hKeyId,
      })])),
      horizonBindings,
    }));
  const outcomeSet = attachPostSelectionOutcomes({
    frozenSelection,
    horizonBindings,
    outcomeSource: resolvedOutcomeSource,
    queryKnowledgeCutoff: queryContext.knowledgeCutoff,
  });

  const inputProofs = [
    ...queryContext.inputProofs.map((proof) => buildInputProof({
      inputId: `QUERY:${proof.inputId}`,
      sourceArtifactId: proof.sourceArtifactId,
      sourceArtifactSha256: proof.sourceArtifactSha256,
      availableAt: proof.availableAt,
      knowledgeCutoff: queryContext.knowledgeCutoff,
    })),
    ...ranked.flatMap((entry) => byIdentity.get(entry.analogueIdentityId).context.inputProofs.map((proof) => buildInputProof({
      inputId: `${entry.analogueIdentityId}:${proof.inputId}`,
      sourceArtifactId: proof.sourceArtifactId,
      sourceArtifactSha256: proof.sourceArtifactSha256,
      availableAt: proof.availableAt,
      knowledgeCutoff: byIdentity.get(entry.analogueIdentityId).context.knowledgeCutoff,
    }))),
  ];

  return deepFreeze({
    engineVersion: ENGINE_VERSION,
    queryIdentity,
    query: {
      instrumentIdentityId: queryContext.identity.instrumentIdentityId,
      sourceBindingId: queryContext.sourceBindingId,
      featureDatasetId: queryContext.featureDatasetId,
      knowledgeCutoff: queryContext.knowledgeCutoff,
    },
    accounting,
    supportReport: support.report,
    supportReportId: support.supportReportId,
    comparisonReport: comparison.report,
    comparisonReportId: comparison.comparisonReportId,
    frozenSelection,
    normalizationBounds,
    horizonBindings,
    outcomeSet,
    inputProofs,
    analogueIndexRecords: analogues.map(({ record }) => record)
      .sort((left, right) => compareCodeUnits(left.analogueIdentityId, right.analogueIdentityId)),
  });
}

/**
 * Query-independent OFF_SCAN index over every candidate whose identity is formable
 * from bound, causally proven inputs. Candidates that cannot be keyed are counted,
 * never silently omitted.
 */
export function buildAnalogueIndexFromCandidates({ policy, candidates }) {
  let index = createAnalogueIndex({ datasetId: policy.datasetId, selectionPolicyVersionId: policy.selectionPolicyVersionId });
  let candidateCount = 0;
  let notFormableCount = 0;
  let previousKey = null;
  const window = policy.historicalObservationWindow;
  for (const candidate of candidates) {
    const context = readHistoricalCandidate(candidate, policy);
    if (previousKey !== null && !(context.candidateKey > previousKey)) failClosed('CANDIDATE_ORDER_NOT_CANONICAL_OR_DUPLICATE');
    previousKey = context.candidateKey;
    candidateCount += 1;
    const derived = deriveAnalogueIdentityMembers({ context, policy });
    const indexable = context.p3hReason === null
      && context.sessionDate >= window.startSessionInclusive && context.sessionDate <= window.endSessionInclusive
      && historicallyCausal(context, Infinity)
      && derived.formable;
    if (!indexable) {
      notFormableCount += 1;
      continue;
    }
    const identity = createAnalogueIdentity(derived.members);
    index = appendIndexRecord(index, buildIndexRecord({
      identity, p3hKeyId: context.p3hKeyId, regime: context.regime, features: context.features, inputProofs: context.inputProofs,
    }));
  }
  return Object.freeze({
    index,
    accounting: Object.freeze({ candidateCount, indexedCount: index.records.size, notFormableCount }),
  });
}

export function buildSelectionProvenance({ selection, policy, indexText }) {
  const index = parseAnalogueIndex(indexText);
  for (const analogue of selection.frozenSelection.analogues) {
    if (readIndexRecord(index, analogue.analogueIdentityId) === null) failClosed('SELECTED_ANALOGUE_NOT_IN_INDEX', { analogueIdentityId: analogue.analogueIdentityId });
  }
  return buildProvenanceManifest({
    schema: PROVENANCE_SCHEMA_V1,
    queryIdentityId: selection.queryIdentity.analogueIdentityId,
    datasetId: policy.datasetId,
    datasetSha256: policy.datasetSha256,
    sourceBindingId: selection.query.sourceBindingId,
    instrumentIdentityId: selection.query.instrumentIdentityId,
    featureDatasetId: selection.query.featureDatasetId,
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
    knowledgeCutoff: selection.query.knowledgeCutoff,
    eligibleHistoryPinSetId: policy.eligibleHistoryPinSetId,
    inputProofs: selection.inputProofs,
    selectedAnalogueIdentityIds: selection.frozenSelection.analogues.map((analogue) => analogue.analogueIdentityId),
    distanceEvidence: {
      parameterSetId: DISTANCE_PARAMETER_SET_ID_V1,
      distance: DISTANCE_METRIC_V1,
      distanceFeatureIds: [...DISTANCE_FEATURE_IDS_V1],
      normalizationPopulation: NORMALIZATION_POPULATION_V1,
      queryObservationInPopulation: false,
      normalizationBounds: selection.normalizationBounds,
      analogues: selection.comparisonReport.analogues.map((entry) => ({
        analogueIdentityId: entry.analogueIdentityId,
        finalDistance: entry.finalDistance,
        distanceComponents: entry.distanceComponents,
        differences: entry.differences,
      })),
    },
    eligibleUniverseCount: selection.accounting.eligibleCount,
    excludedUniverseCount: selection.accounting.excludedCount,
    exclusionCountsByReason: selection.accounting.exclusionCountsByReason,
    outcomeHorizonBindings: selection.horizonBindings,
    supportReportId: selection.supportReportId,
    analogueIndexSha256: analogueIndexSha256(indexText),
  });
}

/**
 * Materializes both canonical OFF_SCAN products through an explicit store adapter
 * { read(path) -> string | null, write(path, text) }. The index is merged append-only
 * first, provenance is bound to the merged bytes, and an existing provenance manifest
 * may only be replaced by byte-identical content.
 */
export function materializeCanonicalProducts({ store, index, selection, policy }) {
  const indexText = mergeAnalogueIndexBytes({ existingText: store.read(ANALOGUE_INDEX_PRODUCT_PATH_V1), index });
  const provenance = buildSelectionProvenance({ selection, policy, indexText });
  verifyProvenanceIndexBinding({ provenanceText: provenance.text, indexText });
  const existingProvenance = store.read(PROVENANCE_PRODUCT_PATH_V1);
  if (existingProvenance !== null && existingProvenance !== provenance.text) failClosed('PROVENANCE_DIVERGENT_REPLACEMENT_REFUSED');
  store.write(ANALOGUE_INDEX_PRODUCT_PATH_V1, indexText);
  store.write(PROVENANCE_PRODUCT_PATH_V1, provenance.text);
  return Object.freeze({
    indexText,
    provenanceText: provenance.text,
    analogueIndexSha256: analogueIndexSha256(indexText),
    provenanceSha256: sha256Bytes(Buffer.from(provenance.text, 'utf8')),
  });
}

/* ------------------------------------------------------------------- P3H adapter */

const OBJECT_ID = /^sha256:[0-9a-f]{64}$/;
const objectHex = (objectId) => {
  if (typeof objectId !== 'string' || !OBJECT_ID.test(objectId)) failClosed('P3H_OBJECT_ID_INVALID', { objectId });
  return objectId.slice(7);
};

/** Reads the frozen P3H finalization by its pinned dataset identity; nothing is repaired. */
export function loadP3hDatasetBinding({ authority, finalizationPath = authority.p3hFinalizationPath, finalizationBytes = null }) {
  const bytes = finalizationBytes ?? readFileSync(finalizationPath);
  const datasetSha256 = sha256Bytes(bytes);
  if (`sha256:${datasetSha256}` !== authority.scope.datasetIdentity) failClosed('P3H_DATASET_IDENTITY_MISMATCH', { observed: datasetSha256 });
  const finalization = JSON.parse(bytes.toString('utf8'));
  if (finalization.schemaVersion !== 'JarviseYahooFetchOnceCohortFinalization/1' || finalization.terminalStage !== authority.scope.cohortStatus) {
    failClosed('P3H_FINALIZATION_HEADER_INVALID');
  }
  const admitted = finalization.admittedEntries;
  const exclusions = finalization.exclusions;
  if (!Array.isArray(admitted) || !Array.isArray(exclusions)
    || admitted.length !== finalization.admittedKeyCount || admitted.length !== authority.scope.admittedCount
    || exclusions.length !== finalization.exclusionCount || exclusions.length !== authority.scope.exclusionCount
    || finalization.planKeyCount !== admitted.length + exclusions.length
    || finalization.admittedKeyDigest !== authority.scope.admittedKeyDigest
    || finalization.exclusionDigest !== authority.scope.exclusionDigest) {
    failClosed('P3H_COHORT_COUNTS_OR_DIGESTS_INVALID');
  }
  const admittedKeyIds = new Set(admitted.map((entry) => entry.acquisitionKey));
  const exclusionClassByKeyId = new Map(exclusions.map((entry) => [entry.acquisitionKey, entry.reasonCode]));
  if (admittedKeyIds.size !== admitted.length || exclusionClassByKeyId.size !== exclusions.length
    || [...exclusionClassByKeyId.keys()].some((keyId) => admittedKeyIds.has(keyId))) {
    failClosed('P3H_KEY_SET_NOT_DISJOINT');
  }
  const exclusionClassCounts = {};
  for (const exclusion of exclusions) {
    if (P3H_EXCLUSION_CLASS_REASONS_V1[exclusion.reasonCode] === undefined) failClosed('P3H_EXCLUSION_CLASS_NOT_MAPPED', { reasonCode: exclusion.reasonCode });
    exclusionClassCounts[exclusion.reasonCode] = (exclusionClassCounts[exclusion.reasonCode] ?? 0) + 1;
  }
  const byKey = (left, right) => compareCodeUnits(left.acquisitionKey, right.acquisitionKey);
  return Object.freeze({
    datasetId: authority.scope.datasetIdentity,
    datasetSha256,
    admittedKeyDigest: finalization.admittedKeyDigest,
    exclusionDigest: finalization.exclusionDigest,
    admittedEntries: Object.freeze([...admitted].sort(byKey)),
    exclusions: Object.freeze([...exclusions].sort(byKey)),
    exclusionClassCounts: Object.freeze(exclusionClassCounts),
    snapshotRoot: join(dirname(finalizationPath), 'observation-snapshots'),
    pinSet: Object.freeze({ admittedKeyIds, exclusionClassByKeyId }),
  });
}

/** Content-addressed read of one admitted P3H key: record, manifest head, core and bars. */
export function readP3hAdmittedSnapshot({ snapshotRoot, entry }) {
  const readVerified = (path, objectId) => {
    const bytes = readFileSync(path);
    if (sha256Bytes(bytes) !== objectHex(objectId)) failClosed('P3H_CONTENT_ADDRESS_MISMATCH', { objectId });
    return bytes;
  };
  const snapshotPath = (objectId) => join(snapshotRoot, 'snapshots', 'sha256', objectHex(objectId).slice(0, 2), `${objectHex(objectId)}.json`);
  const record = JSON.parse(readVerified(snapshotPath(entry.snapshotRecordId), entry.snapshotRecordId).toString('utf8'));
  const manifest = JSON.parse(readVerified(snapshotPath(entry.manifestHeadId), entry.manifestHeadId).toString('utf8'));
  const core = JSON.parse(readVerified(snapshotPath(entry.snapshotCoreId), entry.snapshotCoreId).toString('utf8'));
  const normalizedHex = objectHex(entry.normalizedObjectId);
  const normalized = JSON.parse(readVerified(join(snapshotRoot, 'objects', 'normalized', 'sha256', normalizedHex.slice(0, 2), normalizedHex), entry.normalizedObjectId).toString('utf8'));
  const request = record.acquisitionRequestIdentity ?? {};
  if (record.schemaVersion !== 'DatasetSnapshotRecord/1' || manifest.schemaVersion !== 'SnapshotDatasetManifestV1'
    || core.schemaVersion !== 'DatasetSnapshotCore/1' || normalized.schemaVersion !== entry.normalizedSchemaVersion
    || normalized.schemaVersion !== 'CanonicalDailyBars/1'
    || manifest.snapshotRecordId !== entry.snapshotRecordId || manifest.snapshotCoreId !== entry.snapshotCoreId
    || record.snapshotCoreId !== entry.snapshotCoreId || core.normalizedObjectId !== entry.normalizedObjectId
    || core.sourceObjectId !== entry.sourceObjectId || core.priceBasis !== 'SPLIT_ADJUSTED' || entry.priceBasis !== 'SPLIT_ADJUSTED'
    || core.providerSymbol !== entry.providerSymbol || core.calendarId !== entry.calendarId
    || request.calendarWindowBindingId !== HISTORICAL_CALENDAR_BINDING_ID || request.priceBasis !== 'SPLIT_ADJUSTED'
    || request.providerSymbol !== entry.providerSymbol || request.plane !== 'HISTORICAL'
    || !isExactGovernedString(request.sourceBindingId) || !Array.isArray(normalized.bars)) {
    failClosed('P3H_SNAPSHOT_BINDING_INVALID', { acquisitionKey: entry.acquisitionKey });
  }
  return Object.freeze({
    bars: normalized.bars,
    sourceBindingId: request.sourceBindingId,
    normalizedObjectId: entry.normalizedObjectId,
    normalizedSha256: normalizedHex,
  });
}

/** Historical calendar V2 by reference; K(T) is read off the pinned canonical session. */
export function loadHistoricalWindowCalendar({ authority, root = REPOSITORY_ROOT }) {
  const calendarWindowBinding = computeJarviseHistoricalCalendarBindingR1({ root });
  const calendar = loadJarviseHistoricalCalendarR1({ root });
  const window = authority.scope.historicalObservationWindow;
  const sessions = calendar.sessions
    .filter((session) => session.sessionDate >= window.startSessionInclusive && session.sessionDate <= window.endSessionInclusive)
    .map((session) => {
      const pinned = resolvePinnedCanonicalSession({ sessionDate: session.sessionDate, calendarWindowBinding, sessions: calendar.sessions });
      if (pinned.status !== 'RESOLVED') failClosed('HISTORICAL_SESSION_NOT_PINNED', { sessionDate: session.sessionDate, code: pinned.code });
      return Object.freeze({ sessionDate: session.sessionDate, knowledgeCutoff: pinned.knowledgeCutoff, knowledgeCutoffMs: Date.parse(pinned.knowledgeCutoff) });
    });
  if (sessions[0]?.sessionDate !== window.startSessionInclusive || sessions.at(-1)?.sessionDate !== window.endSessionInclusive) {
    failClosed('HISTORICAL_WINDOW_NOT_CALENDAR_ALIGNED');
  }
  return Object.freeze({
    calendarWindowBindingId: calendarWindowBinding.calendarWindowBindingId,
    calendarRegistryManifestId: calendarWindowBinding.calendarRegistryManifestId,
    sessions: Object.freeze(sessions),
  });
}

/**
 * Resolves identity at each historical session date from the verified instrument
 * identity registry. The registry is verified once; each (symbol, date) lookup then
 * applies the same half-open alias interval and revocation rules as the official
 * as-of resolver. There is no backdating path: a date outside every alias interval
 * is UNRESOLVED.
 */
export function createRegistryHistoricalIdentityResolver({ root = REPOSITORY_ROOT } = {}) {
  const provenance = JSON.parse(readFileSync(resolve(root, 'data/jarvise/instrument-identity/PROVENANCE.json'), 'utf8'));
  const namespace = JSON.parse(readFileSync(resolve(root, 'data/jarvise/instrument-identity/symbol-namespace-policy.json'), 'utf8'));
  const store = createContentAddressedStore({ root: resolve(root, 'data/jarvise/instrument-identity/cas') });
  const registry = verifyInstrumentIdentityRegistry({ store, registryManifestId: provenance.registryManifestId });
  const { namespacePolicy } = verifySymbolNamespacePolicy({ store, namespacePolicyId: provenance.namespacePolicyId });
  const lookup = { providerId: namespace.providerId, venueId: null, currency: 'USD' };
  if (namespacePolicy.providerId !== lookup.providerId || namespacePolicyBindingProblems(namespacePolicy, lookup).length > 0) {
    failClosed('IDENTITY_NAMESPACE_POLICY_BINDING_INVALID');
  }
  const aliasesByLookupKey = new Map();
  for (const bundle of registry.identityBundles) {
    for (const entry of bundle.aliases) {
      const alias = entry.aliasBindingCore;
      if (alias.namespacePolicyId !== provenance.namespacePolicyId || alias.providerId !== lookup.providerId
        || alias.venueId !== lookup.venueId || alias.currency !== lookup.currency) continue;
      const list = aliasesByLookupKey.get(alias.symbolLookupKey) ?? [];
      list.push(Object.freeze({
        instrumentIdentityId: alias.instrumentIdentityId,
        validFrom: alias.validFrom,
        validToExclusive: alias.validToExclusive,
        revocationFrom: bundle.aliasRevocationByBinding.get(entry.aliasBindingCoreId) ?? null,
      }));
      aliasesByLookupKey.set(alias.symbolLookupKey, list);
    }
  }
  const unresolved = (code, asOfDate) => Object.freeze({ status: 'UNRESOLVED', code, resolvedAsOfSessionDate: asOfDate });
  function resolveAsOf(symbol, asOfDate) {
    let lookupKey;
    try {
      lookupKey = computeSymbolLookupKey(namespacePolicy, symbol);
    } catch (cause) {
      return unresolved(cause.code ?? 'INSTRUMENT_ALIAS_INVALID', asOfDate);
    }
    const matches = [];
    let revoked = 0;
    for (const alias of aliasesByLookupKey.get(lookupKey) ?? []) {
      if (!isDateInHalfOpenInterval(asOfDate, alias.validFrom, alias.validToExclusive)) continue;
      if (alias.revocationFrom !== null && asOfDate >= alias.revocationFrom) {
        revoked += 1;
        continue;
      }
      const effective = effectiveBindingInterval(alias.validFrom, alias.validToExclusive, alias.revocationFrom);
      if (!isDateInHalfOpenInterval(asOfDate, effective.validFrom, effective.validToExclusive)) continue;
      matches.push(alias.instrumentIdentityId);
    }
    /* As the official resolver: any second active binding is ambiguous, even to the same identity. */
    if (matches.length === 0) return unresolved(revoked > 0 ? 'INSTRUMENT_ALIAS_REVOKED' : 'INSTRUMENT_ALIAS_NOT_FOUND', asOfDate);
    if (matches.length > 1) return unresolved('INSTRUMENT_ALIAS_AMBIGUOUS', asOfDate);
    return Object.freeze({ status: 'RESOLVED', instrumentIdentityId: matches[0], resolvedAsOfSessionDate: asOfDate });
  }
  return Object.freeze({
    resolveAsOf,
    officialResolverInput: Object.freeze({
      store,
      registryManifestId: provenance.registryManifestId,
      namespacePolicyId: provenance.namespacePolicyId,
      providerId: lookup.providerId,
      venueId: lookup.venueId,
      currency: lookup.currency,
    }),
  });
}

const FEATURE_STATUS = Object.freeze(['RESOLVED', 'INSUFFICIENT_DATA', 'FAIL_CLOSED']);
const FEATURE_CODES = Object.freeze([null, 'INSUFFICIENT_SESSIONS_IN_WINDOW', 'INPUT_MISSING', 'INVALID_INPUT', 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN']);
const WINDOW_SESSION_COUNTS = Object.freeze({ 'F1_SIMPLE_RETURN@W5': 5, 'F1_SIMPLE_RETURN@W21': 21 });

/**
 * GATE23 FeatureRecord semantics for one trailing window anchored at session index
 * i: INSUFFICIENT_DATA when fewer than W prior sessions exist; FAIL_CLOSED when a
 * window bar was available after K(T); INPUT_MISSING when a bar or close is absent;
 * INVALID_INPUT when a close is not a positive finite number; otherwise the GATE23
 * simpleReturn formula over the W + 1 closes.
 */
function trailingWindowFeature({ bars, sessions, index, sessionCount }) {
  const start = index - sessionCount;
  if (start < 0) return { status: 1, code: 1, value: NaN, maxAvailableMs: NaN };
  const cutoffMs = sessions[index].knowledgeCutoffMs;
  let maxAvailableMs = NaN;
  let absent = false;
  let nullClose = false;
  let invalidClose = false;
  let future = false;
  for (let position = start; position <= index; position += 1) {
    const bar = bars[position];
    if (bar === undefined) {
      absent = true;
      continue;
    }
    if (!(bar.availableAtMs <= maxAvailableMs)) maxAvailableMs = bar.availableAtMs;
    if (bar.availableAtMs > cutoffMs) future = true;
    if (bar.close === null || bar.close === undefined) nullClose = true;
    else if (typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0) invalidClose = true;
  }
  if (future) return { status: 2, code: 4, value: NaN, maxAvailableMs };
  if (absent || nullClose) return { status: 2, code: 2, value: NaN, maxAvailableMs };
  if (invalidClose) return { status: 2, code: 3, value: NaN, maxAvailableMs };
  const computed = simpleReturn(bars.slice(start, index + 1).map((bar) => bar.close));
  if (computed.status !== 'RESOLVED') failClosed('GATE23_SIMPLE_RETURN_DISAGREES_WITH_WINDOW_ADMISSION');
  return { status: 0, code: 0, value: computed.value, maxAvailableMs };
}

/**
 * Prepares the P3H historical universe once per execution (mandate IC-10): every
 * admitted key is read by content address, and every key of the pin set, admitted
 * or excluded, is expanded over every pinned window session.
 */
export function prepareP3hHistoricalUniverse({ p3h, calendar, identityResolver }) {
  const sessions = calendar.sessions;
  const sessionIndex = new Map(sessions.map((session, index) => [session.sessionDate, index]));
  const keys = [];
  let barsConsumed = 0;
  for (const entry of p3h.admittedEntries) {
    const snapshot = readP3hAdmittedSnapshot({ snapshotRoot: p3h.snapshotRoot, entry });
    const bars = new Array(sessions.length);
    for (const bar of snapshot.bars) {
      const index = sessionIndex.get(bar?.sessionDate);
      if (index === undefined) failClosed('P3H_BAR_OUTSIDE_PINNED_WINDOW_SESSIONS', { acquisitionKey: entry.acquisitionKey, sessionDate: bar?.sessionDate });
      if (bars[index] !== undefined) failClosed('P3H_BAR_DUPLICATE_SESSION', { acquisitionKey: entry.acquisitionKey, sessionDate: bar.sessionDate });
      if (!isCanonicalUtcInstant(bar.availableAt)) failClosed('P3H_BAR_AVAILABLE_AT_INVALID', { acquisitionKey: entry.acquisitionKey, sessionDate: bar.sessionDate });
      bars[index] = { close: bar.close, availableAtMs: Date.parse(bar.availableAt) };
      barsConsumed += 1;
    }
    const features = {};
    for (const [featureId, sessionCount] of Object.entries(WINDOW_SESSION_COUNTS)) {
      const status = new Uint8Array(sessions.length);
      const code = new Uint8Array(sessions.length);
      const value = new Float64Array(sessions.length);
      const maxAvailableMs = new Float64Array(sessions.length);
      for (let index = 0; index < sessions.length; index += 1) {
        const feature = trailingWindowFeature({ bars, sessions, index, sessionCount });
        status[index] = feature.status;
        code[index] = feature.code;
        value[index] = feature.value;
        maxAvailableMs[index] = feature.maxAvailableMs;
      }
      features[featureId] = { status, code, value, maxAvailableMs };
    }
    keys.push({
      acquisitionKey: entry.acquisitionKey,
      providerSymbol: entry.providerSymbol,
      exclusionClass: null,
      sourceBindingId: snapshot.sourceBindingId,
      normalizedObjectId: snapshot.normalizedObjectId,
      normalizedSha256: snapshot.normalizedSha256,
      features,
      bars,
    });
  }
  for (const exclusion of p3h.exclusions) {
    keys.push({
      acquisitionKey: exclusion.acquisitionKey,
      providerSymbol: exclusion.providerSymbol,
      exclusionClass: exclusion.reasonCode,
      sourceBindingId: null,
      normalizedObjectId: null,
      normalizedSha256: null,
      features: null,
      bars: null,
    });
  }
  keys.sort((left, right) => compareCodeUnits(left.acquisitionKey, right.acquisitionKey));
  /* Resolved per (symbol, session date); stored as a small table of distinct outcomes. */
  const identityOutcomes = [];
  const identityOutcomeIndex = new Map();
  for (const key of keys) {
    key.identityOutcome = new Int32Array(sessions.length);
    sessions.forEach((session, index) => {
      const resolution = identityResolver.resolveAsOf(key.providerSymbol, session.sessionDate);
      if (resolution.resolvedAsOfSessionDate !== session.sessionDate) failClosed('IDENTITY_RESOLVER_DATE_DRIFT');
      const outcome = resolution.status === 'RESOLVED' ? `RESOLVED|${resolution.instrumentIdentityId}` : `UNRESOLVED|${resolution.code}`;
      if (!identityOutcomeIndex.has(outcome)) {
        identityOutcomeIndex.set(outcome, identityOutcomes.length);
        identityOutcomes.push(resolution.status === 'RESOLVED'
          ? { status: 'RESOLVED', instrumentIdentityId: resolution.instrumentIdentityId }
          : { status: 'UNRESOLVED', code: resolution.code });
      }
      key.identityOutcome[index] = identityOutcomeIndex.get(outcome);
    });
  }
  return Object.freeze({
    sessions,
    calendarRegistryManifestId: calendar.calendarRegistryManifestId,
    identityOutcomes: Object.freeze(identityOutcomes),
    keys: Object.freeze(keys),
    accounting: Object.freeze({
      admittedKeysConsumed: p3h.admittedEntries.length,
      excludedKeysAccounted: p3h.exclusions.length,
      exclusionClassCounts: p3h.exclusionClassCounts,
      barsConsumed,
      windowSessionCount: sessions.length,
      candidateCount: keys.length * sessions.length,
    }),
  });
}

function realFeatureInput(key, featureId, index) {
  const feature = key.features[featureId];
  const status = FEATURE_STATUS[feature.status[index]];
  return {
    featureRecordId: null,
    status,
    code: FEATURE_CODES[feature.code[index]],
    value: status === 'RESOLVED' ? feature.value[index] : null,
  };
}

function realInputProofs(key, index) {
  if (key.features === null) return [];
  return DISTANCE_FEATURE_IDS_V1
    .filter((featureId) => !Number.isNaN(key.features[featureId].maxAvailableMs[index]))
    .map((featureId) => ({
      inputId: featureId,
      sourceArtifactId: key.normalizedObjectId,
      sourceArtifactSha256: key.normalizedSha256,
      availableAt: new Date(key.features[featureId].maxAvailableMs[index]).toISOString(),
    }));
}

function realCandidate(universe, key, index) {
  const session = universe.sessions[index];
  const projected = universe.foundationProjections?.get(`${key.acquisitionKey}|${session.sessionDate}`);
  if (projected !== undefined) {
    const identityOutcome = universe.identityOutcomes[key.identityOutcome[index]];
    return {
      schema: CANDIDATE_SCHEMA_V1,
      candidateKey: `${key.acquisitionKey}|${session.sessionDate}`,
      p3hKeyId: key.acquisitionKey,
      p3hAdmission: { status: 'ADMITTED' },
      sessionDate: session.sessionDate,
      knowledgeCutoff: projected.knowledgeCutoff,
      instrumentIdentity: { ...identityOutcome, resolvedAsOfSessionDate: session.sessionDate },
      priceBasisId: projected.priceBasisId,
      featureVectorBinding: projected.featureVectorBinding,
      features: projected.features,
      regimeRecord: projected.regimeRecord,
      inputProofs: projected.inputProofs,
    };
  }
  const identityOutcome = universe.identityOutcomes[key.identityOutcome[index]];
  return {
    schema: CANDIDATE_SCHEMA_V1,
    candidateKey: `${key.acquisitionKey}|${session.sessionDate}`,
    p3hKeyId: key.acquisitionKey,
    p3hAdmission: key.exclusionClass === null ? { status: 'ADMITTED' } : { status: 'EXCLUDED', exclusionClass: key.exclusionClass },
    sessionDate: session.sessionDate,
    knowledgeCutoff: session.knowledgeCutoff,
    instrumentIdentity: { ...identityOutcome, resolvedAsOfSessionDate: session.sessionDate },
    priceBasisId: key.exclusionClass === null ? 'SPLIT_ADJUSTED' : null,
    featureVectorBinding: null,
    features: key.features === null
      ? Object.fromEntries(DISTANCE_FEATURE_IDS_V1.map((featureId) => [featureId, null]))
      : Object.fromEntries(DISTANCE_FEATURE_IDS_V1.map((featureId) => [featureId, realFeatureInput(key, featureId, index)])),
    regimeRecord: null,
    inputProofs: realInputProofs(key, index),
  };
}

/** Candidates in strictly increasing candidateKey order: acquisitionKey, then sessionDate. */
export function* iterateP3hCandidates(universe) {
  for (const key of universe.keys) {
    for (let index = 0; index < universe.sessions.length; index += 1) yield realCandidate(universe, key, index);
  }
}

/** The observation at (acquisitionKey, T) as an analogue query, from the same prepared inputs. */
export function buildP3hQuery({ universe, acquisitionKey, sessionDate }) {
  const key = universe.keys.find((item) => item.acquisitionKey === acquisitionKey);
  if (key === undefined || key.features === null) failClosed('P3H_QUERY_KEY_NOT_ADMITTED', { acquisitionKey });
  const index = universe.sessions.findIndex((session) => session.sessionDate === sessionDate);
  if (index < 0) failClosed('P3H_QUERY_SESSION_NOT_PINNED', { sessionDate });
  const candidate = realCandidate(universe, key, index);
  return {
    schema: QUERY_SCHEMA_V1,
    sessionDate: candidate.sessionDate,
    knowledgeCutoff: candidate.knowledgeCutoff,
    instrumentIdentity: candidate.instrumentIdentity,
    priceBasisId: candidate.priceBasisId,
    featureVectorBinding: candidate.featureVectorBinding,
    features: candidate.features,
    regimeRecord: candidate.regimeRecord,
    inputProofs: candidate.inputProofs,
    sourceBindingId: key.sourceBindingId,
  };
}

export function describeEngine() {
  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    productClass: ENGINE_PRODUCT_CLASS,
    executionContract: { path: EXECUTION_CONTRACT_PATH, sha256: EXECUTION_CONTRACT_SHA256 },
    phases: ['SELECTION', 'OUTCOME_ATTACHMENT'],
    canonicalProducts: [ANALOGUE_INDEX_PRODUCT_PATH_V1, PROVENANCE_PRODUCT_PATH_V1],
    networkAccess: 'NONE',
    providerAccess: 'NONE',
    brokerAccess: 'NONE',
    modelInference: 'NONE',
    wallClockAsInput: 'NONE',
    liveWheelScanCoupling: 'NONE',
  });
}

/**
 * Binds the published GATE25 historical regime foundation. Dataset-level identity
 * or binding failure is fail-closed. No synthetic records, no second classifier.
 */
export function bindPublishedHistoricalRegimeFoundation({ authority, root = REPOSITORY_ROOT } = {}) {
  const foundation = loadJarviseG25HistoricalRegimeFoundationR1({ root });
  const described = describeJarviseG25HistoricalRegimeFoundationR1(foundation);
  if (foundation.p3h.datasetId !== authority.scope.datasetIdentity) failClosed('FOUNDATION_DATASET_BINDING_MISMATCH');
  if (foundation.p3h.admittedEntries.length !== authority.scope.admittedCount
    || foundation.p3h.exclusions.length !== authority.scope.exclusionCount) {
    failClosed('FOUNDATION_P3H_COHORT_COUNT_MISMATCH');
  }
  if (!isExactGovernedString(described.regimeHorizonSpecId)
    || !isExactGovernedString(described.classifierVersionId)
    || !isExactGovernedString(described.parameterSetId)
    || !isExactGovernedString(described.macroContextBindingId)) {
    failClosed('FOUNDATION_REGIME_IDENTITY_NOT_BOUND');
  }
  if (described.regimeHorizonSpecId !== foundation.v2.horizon.regimeHorizonSpecId
    || described.classifierVersionId !== foundation.v2.classifier.classifierVersionId
    || described.parameterSetId !== foundation.v2.parameterSet.parameterSetId
    || described.macroContextBindingId !== foundation.macro.macroContextBinding.macroContextBindingId) {
    failClosed('FOUNDATION_REGIME_IDENTITY_INCONSISTENT');
  }
  return Object.freeze({ foundation, described });
}

/**
 * Emits every identity-resolvable (admitted key, session) through the published
 * foundation exactly once and indexes classifying CORE_V1 signatures. Unresolved
 * identity and foundation refusals stay on the existing fail-closed candidate path.
 */
export function attachPublishedFoundationProjections({ universe, foundation }) {
  const projections = new Map();
  const coreV1ClassifyingGroups = new Map();
  const entryByKey = new Map(foundation.p3h.admittedEntries.map((entry) => [entry.acquisitionKey, entry]));
  let emittedCount = 0;
  let refusedCount = 0;
  let classifyingEmittedCount = 0;
  for (const key of universe.keys) {
    if (key.exclusionClass !== null) continue;
    const entry = entryByKey.get(key.acquisitionKey);
    if (entry === undefined) failClosed('FOUNDATION_ADMITTED_KEY_MISSING', { acquisitionKey: key.acquisitionKey });
    const keyBars = readP3hAdmittedBarsR1({ p3h: foundation.p3h, entry });
    for (let index = 0; index < universe.sessions.length; index += 1) {
      const identityOutcome = universe.identityOutcomes[key.identityOutcome[index]];
      if (identityOutcome.status !== 'RESOLVED') continue;
      const sessionDate = universe.sessions[index].sessionDate;
      const emitted = emitJarviseG25HistoricalRegimeRecordR1({ foundation, entry, keyBars, sessionDate });
      if (emitted.status !== 'EMITTED') {
        refusedCount += 1;
        continue;
      }
      const projected = projectGate25AnalogueInputsR1({ foundation, emitted });
      projections.set(`${key.acquisitionKey}|${sessionDate}`, projected);
      emittedCount += 1;
      const classification = coreV1ClassificationR1(emitted.regimeRecord);
      if (CORE_V1_DIMENSIONS_V1.every((dimension) => classification[dimension].classifying)) {
        classifyingEmittedCount += 1;
        const signature = coreV1Signature(emitted.regimeRecord.regimeVector);
        const member = Object.freeze({ acquisitionKey: key.acquisitionKey, sessionDate, index });
        const group = coreV1ClassifyingGroups.get(signature);
        if (group === undefined) coreV1ClassifyingGroups.set(signature, [member]);
        else group.push(member);
      }
    }
  }
  return Object.freeze({
    sessions: universe.sessions,
    calendarRegistryManifestId: universe.calendarRegistryManifestId,
    identityOutcomes: universe.identityOutcomes,
    keys: universe.keys,
    accounting: universe.accounting,
    foundationProjections: projections,
    coreV1ClassifyingGroups,
    foundation,
    calendarSessions: foundation.calendarSessions,
    foundationAccounting: Object.freeze({
      emittedCount,
      refusedAfterIdentityResolved: refusedCount,
      classifyingEmittedCount,
      classifyingGroupCount: coreV1ClassifyingGroups.size,
    }),
  });
}

/**
 * GATE22 forward-horizon simple return over published historical bars. Missing
 * windows, missing bars, non-finite closes, or availability after the query cutoff
 * are MISSING and never change selection.
 */
export function createHistoricalObservationOutcomeSource({ universe, analogueBindings, horizonBindings }) {
  if (!(analogueBindings instanceof Map)) failClosed('OUTCOME_ANALOGUE_BINDINGS_REQUIRED');
  const calendarSessions = universe.calendarSessions;
  if (!Array.isArray(calendarSessions) || calendarSessions.length === 0) failClosed('OUTCOME_CALENDAR_SESSIONS_REQUIRED');
  const keyByAcquisition = new Map(universe.keys.map((key) => [key.acquisitionKey, key]));
  const horizonById = new Map(horizonBindings.map((binding) => [binding.horizonId, binding]));
  const sourceBindingId = universe.foundation?.expectedSourceBindingId
    ?? universe.keys.find((key) => key.sourceBindingId !== null)?.sourceBindingId;
  if (!isExactGovernedString(sourceBindingId)) failClosed('OUTCOME_SOURCE_BINDING_REQUIRED');
  return Object.freeze({
    sourceBindingId,
    lookup({ analogueIdentityId, horizonId }) {
      const analogue = analogueBindings.get(analogueIdentityId);
      const horizon = horizonById.get(horizonId);
      if (analogue === undefined || horizon === undefined) return null;
      const key = keyByAcquisition.get(analogue.p3hKeyId);
      if (key === undefined || !Array.isArray(key.bars)) return null;
      const window = resolveOutcomeWindow({
        sessionDate: analogue.sessionDate,
        horizon: createHorizon({ sessionCount: horizon.sessionCount, calendarRegistryManifestId: horizon.calendarRegistryManifestId }),
        calendarSessions,
      });
      if (window.status !== 'RESOLVED') return null;
      const universeStart = universe.sessions.findIndex((session) => session.sessionDate === analogue.sessionDate);
      if (universeStart < 0) return null;
      const startBarRecord = key.bars[universeStart];
      if (startBarRecord === undefined || typeof startBarRecord.close !== 'number' || !Number.isFinite(startBarRecord.close) || startBarRecord.close <= 0) {
        return null;
      }
      const closes = [startBarRecord.close];
      let maxAvailableMs = typeof startBarRecord.availableAtMs === 'number' ? startBarRecord.availableAtMs : NaN;
      for (const session of window.sessions) {
        const index = universe.sessions.findIndex((item) => item.sessionDate === session.sessionDate);
        if (index < 0) return null;
        const bar = key.bars[index];
        if (bar === undefined || typeof bar.close !== 'number' || !Number.isFinite(bar.close) || bar.close <= 0) return null;
        closes.push(bar.close);
        if (typeof bar.availableAtMs === 'number' && !(bar.availableAtMs <= maxAvailableMs)) maxAvailableMs = bar.availableAtMs;
      }
      const computed = simpleReturn(closes);
      if (computed.status !== 'RESOLVED' || typeof computed.value !== 'number' || !Number.isFinite(computed.value)) return null;
      if (!Number.isFinite(maxAvailableMs)) return null;
      return { outcomeValue: computed.value, outcomeAvailableAt: new Date(maxAvailableMs).toISOString() };
    },
  });
}

/** Filesystem adapter for the two R0003 canonical product paths. */
export function createCanonicalProductStore({ root = REPOSITORY_ROOT } = {}) {
  return {
    read(path) {
      try {
        return readFileSync(resolve(root, path), 'utf8');
      } catch (cause) {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      }
    },
    write(path, text) {
      if (path !== ANALOGUE_INDEX_PRODUCT_PATH_V1 && path !== PROVENANCE_PRODUCT_PATH_V1) {
        failClosed('CANONICAL_PRODUCT_PATH_NOT_AUTHORIZED', { path });
      }
      const absolute = resolve(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${process.pid}.tmp`;
      writeFileSync(temporary, text);
      renameSync(temporary, absolute);
    },
  };
}

/**
 * OFF_SCAN materialization of ANALOGUE_INDEX.json and PROVENANCE.json over the
 * published historical foundation and the real P3H cohort. Never called from the
 * live Wheel scan.
 */
export function materializeR0003HistoricalAnalogueProducts({
  root = REPOSITORY_ROOT,
  querySymbol = 'AAPL',
  querySessionDate = '2026-09-04',
  store = createCanonicalProductStore({ root }),
} = {}) {
  const authority = loadGate25BuildAuthority({ root });
  const p3h = loadP3hDatasetBinding({ authority });
  const calendar = loadHistoricalWindowCalendar({ authority, root });
  const policy = bindR0003SelectionPolicy({ authority, p3h, calendar });
  const identityResolver = createRegistryHistoricalIdentityResolver({ root });
  const { foundation, described } = bindPublishedHistoricalRegimeFoundation({ authority, root });
  const universe = attachPublishedFoundationProjections({
    universe: prepareP3hHistoricalUniverse({ p3h, calendar, identityResolver }),
    foundation,
  });
  const indexBuilt = buildAnalogueIndexFromCandidates({ policy, candidates: iterateP3hCandidates(universe) });
  const queryKey = universe.keys.find((key) => key.providerSymbol === querySymbol && key.exclusionClass === null);
  if (queryKey === undefined) failClosed('MATERIALIZATION_QUERY_SYMBOL_NOT_ADMITTED', { querySymbol });
  const query = buildP3hQuery({ universe, acquisitionKey: queryKey.acquisitionKey, sessionDate: querySessionDate });
  const selection = runAnalogueSelection({
    authority,
    policy,
    query,
    candidates: iterateP3hCandidates(universe),
    historicalOutcomeUniverse: universe,
  });
  const products = materializeCanonicalProducts({ store, index: indexBuilt.index, selection, policy });
  return Object.freeze({
    products,
    selection,
    indexAccounting: indexBuilt.accounting,
    foundationIdentities: described,
    foundationAccounting: universe.foundationAccounting,
    queryIdentityId: selection.queryIdentity.analogueIdentityId,
  });
}
