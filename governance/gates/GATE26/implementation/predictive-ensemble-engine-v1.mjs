/**
 * GATE26 PREDICTIVE ENSEMBLE ENGINE V1, OFF_SCAN.
 *
 * Consumes a frozen GATE25 analogue selection (same pipeline) and emits an
 * inspectable, weightless ensemble record over ALL_AND_ONLY GATE22 horizons.
 * The live Wheel scan never calls this module.
 *
 * DatasetId_observation is never assumed: it is read off the selection's own query
 * identity and comparison report and must equal the declared input binding, or the
 * combination fails closed.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { CORE_V1_DIMENSIONS_V1 } from '../../GATE25/implementation/analogue-eligibility-v1.mjs';
import { identityMemberValue, verifyAnalogueIdentity } from '../../GATE25/implementation/analogue-identity-v1.mjs';
import { SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1 } from '../../GATE25/implementation/analogue-report-v1.mjs';
import { freezeSelection } from '../../GATE25/implementation/analogue-outcome-v1.mjs';

import {
  ENSEMBLE_ENGINE_VERSION_V1,
  createEnsembleIdentity,
  failClosed,
  horizonCoverageId,
} from './ensemble-identity-v1.mjs';
import {
  ABSTAIN_REASONS_V1,
  COMBINATION_POLICY_SCHEMA_V1,
  FAMILIES_V1,
  createCombinationPolicy,
  refusePermissiveFallback,
  refuseProbabilityClaim,
} from './combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1, MULTI_HORIZON_OUTPUT_SCHEMA_V1, buildHorizonRecord } from './ensemble-record-v1.mjs';
import { buildProvenanceManifest, validateInputBinding } from './ensemble-provenance-v1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const EXECUTION_CONTRACT_PATH = 'governance/gates/GATE26/contracts/EXECUTION_CONTRACT_R0002.json';
export const EXECUTION_CONTRACT_SHA256 = 'b0ab114a7a8125d37c871addfc2d795f3900894edac287fd7a1d5a67150a8d93';
export const MANDATE_PATH = 'governance/sources/GATE26_CANONICAL_MANDATE_R0.json';
export const MANDATE_SHA256 = '5b02dc6628ca1874e0f60cbdf44823a1adc4b7c63d0428dfb78f3de16902b8b7';

/** GATE25 query refusals that mean the query itself is not comparable at T. Every other refusal fails closed. */
export const QUERY_NOT_COMPARABLE_REFUSAL_CODES_V1 = Object.freeze([
  'QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE',
  'QUERY_IDENTITY_NOT_FORMABLE',
  'QUERY_DISTANCE_FEATURE_INCOMPLETE',
]);

const BINDING_IDS = Object.freeze([
  'GATE26_ENSEMBLE_IDENTITY_V1',
  'GATE26_COMBINATION_POLICY_V1',
  'GATE26_MULTI_HORIZON_OUTPUT_V1',
  'GATE26_MINI_FIXTURE_SELECTION_V1',
  'GATE26_TEST_LAYOUT_V1',
  'GATE26_LFS_THRESHOLD_V1',
  'GATE26_CONSUMPTION_BOUNDARY_V1',
]);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof Map) && !(value instanceof Set)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function readPinned(root, path, expected, code) {
  let bytes;
  try { bytes = readFileSync(resolve(root, path)); } catch (cause) { failClosed(`${code}_ABSENT`, { path, cause: cause.code }); }
  const observed = sha256Bytes(bytes);
  if (observed !== expected) failClosed(`${code}_SHA256_MISMATCH`, { path, observed });
  return JSON.parse(bytes.toString('utf8'));
}

export function loadGate26MiniBuildAuthority({ root = REPOSITORY_ROOT } = {}) {
  const contract = readPinned(root, EXECUTION_CONTRACT_PATH, EXECUTION_CONTRACT_SHA256, 'EXECUTION_CONTRACT');
  if (contract.gateId !== 'GATE26' || contract.contractRevision !== 'R0002') failClosed('EXECUTION_CONTRACT_REVISION_INVALID');
  const mandate = readPinned(root, MANDATE_PATH, MANDATE_SHA256, 'MANDATE');
  const requirements = new Map(contract.canonicalRequirements.map((requirement) => [requirement.requirementId, requirement]));
  const bindings = {};
  for (const bindingId of BINDING_IDS) {
    const requirement = [...requirements.values()].find((item) => item.bindingId === bindingId);
    if (!requirement || requirement.resolutionStatus !== 'OWNER_RESOLVED') failClosed('BINDING_REQUIREMENT_UNRESOLVED', { bindingId });
    const artifact = JSON.parse(readFileSync(resolve(root, requirement.bindingArtifactPath), 'utf8'));
    if (artifact.bindingId !== bindingId
      || artifact.authority?.executionContractSha256 !== EXECUTION_CONTRACT_SHA256) {
      failClosed('BINDING_ARTIFACT_DIVERGES_FROM_R0002', { bindingId });
    }
    if (requirement.binding && sha256Canonical(artifact.binding) !== sha256Canonical(requirement.binding)) {
      failClosed('BINDING_ARTIFACT_DIVERGES_FROM_R0002', { bindingId, field: 'binding' });
    }
    bindings[bindingId] = artifact.binding ?? requirement.binding;
  }
  if (!Array.isArray(contract.authorizedPaths) || contract.authorizedPaths.length !== 22
    || new Set(contract.authorizedPaths).size !== 22
    || contract.authorizedPaths.some((path) => /[*?[\]]/.test(path))) {
    failClosed('AUTHORIZED_PATHS_NOT_EXACT');
  }
  const policyBinding = bindings.GATE26_COMBINATION_POLICY_V1;
  const policy = createCombinationPolicy({
    schema: COMBINATION_POLICY_SCHEMA_V1,
    policyId: policyBinding.policyId,
    weights: policyBinding.weights,
    winnerTakeAll: policyBinding.winnerTakeAll,
    missingFamily: policyBinding.missingFamily,
    insufficientSupport: policyBinding.insufficientSupport,
    disagreementWhenSecondFamilyRegistered: policyBinding.disagreementWhenSecondFamilyRegistered,
    degradedInput: policyBinding.degradedInput,
    familiesV1: policyBinding.familiesV1,
    abstainReasons: [...ABSTAIN_REASONS_V1],
  });
  return deepFreeze({
    contractSha256: EXECUTION_CONTRACT_SHA256,
    mandateSha256: MANDATE_SHA256,
    authorizedPaths: [...contract.authorizedPaths],
    requiredInputs: contract.requiredInputs.map((input) => ({ path: input.path, sha256: input.sha256, role: input.role })),
    bindings,
    policy,
    mandate,
  });
}

function regimeBinding(selection) {
  return {
    dimensions: [...CORE_V1_DIMENSIONS_V1],
    factors: (selection.comparisonReport?.analogues ?? []).map((entry) => ({
      analogueIdentityId: entry.analogueIdentityId,
      commonFactors: entry.commonFactors,
    })),
  };
}

function presentFamilies(selection, extraFamilies) {
  const present = new Set();
  if (selection?.outcomeSet && selection?.frozenSelection) present.add('ANALOGUE_OUTCOME_FAMILY');
  if (selection?.supportReport) present.add('ANALOGUE_SUPPORT_FAMILY');
  if (selection?.comparisonReport?.analogues) present.add('REGIME_BINDING_FAMILY');
  for (const family of extraFamilies) {
    if (!family?.familyId) failClosed('REGISTERED_FAMILY_MALFORMED');
    present.add(family.familyId);
  }
  return present;
}

function abstainResult({ reason, selection, authority, extra = {} }) {
  if (!ABSTAIN_REASONS_V1.includes(reason)) failClosed('ABSTAIN_REASON_INVALID', { reason });
  return deepFreeze({
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    policySchema: COMBINATION_POLICY_SCHEMA_V1,
    combinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    decision: 'ABSTAIN',
    abstention: { decision: 'ABSTAIN', reason },
    families: [],
    horizons: [],
    identity: null,
    provenance: null,
    ...extra,
    supportReport: selection?.supportReport ?? null,
  });
}

/**
 * A GATE25 query refusal is an ensemble ABSTAIN only when the refusal says the query
 * is not comparable at T. Any other refusal is rethrown unchanged.
 */
export function abstainForRefusedQuery({ authority, refusal }) {
  if (!QUERY_NOT_COMPARABLE_REFUSAL_CODES_V1.includes(refusal?.code)) throw refusal;
  return abstainResult({ reason: 'QUERY_NOT_COMPARABLE', selection: null, authority, extra: { refusalCode: refusal.code } });
}

/**
 * The dataset and selection policy the selection was actually computed under, read
 * from its own verified query identity and comparison report. Any disagreement with
 * the declared input binding fails closed.
 */
export function deriveSelectionInputBinding({ selection, inputBinding }) {
  const binding = validateInputBinding(inputBinding);
  const queryIdentity = verifyAnalogueIdentity(selection.queryIdentity);
  const identityDataset = identityMemberValue(queryIdentity.orderedMembers, 'EligibleHistoryPinSetId');
  const identityPolicy = identityMemberValue(queryIdentity.orderedMembers, 'SelectionPolicyVersionId');
  if (selection.comparisonReport?.queryIdentityId !== queryIdentity.analogueIdentityId
    || selection.frozenSelection?.queryIdentityId !== queryIdentity.analogueIdentityId) {
    failClosed('PROVENANCE_OR_IDENTITY_MISMATCH', { field: 'queryIdentityId' });
  }
  if (identityDataset !== selection.comparisonReport.datasetId || identityDataset !== binding.datasetId) {
    failClosed('DATASET_IDENTITY_MISMATCH', {
      selectionDatasetId: identityDataset,
      comparisonDatasetId: selection.comparisonReport.datasetId,
      declaredDatasetId: binding.datasetId,
    });
  }
  if (identityPolicy !== selection.comparisonReport.selectionPolicyVersionId || identityPolicy !== binding.selectionPolicyVersionId) {
    failClosed('SELECTION_POLICY_BINDING_MISMATCH', { selectionPolicyVersionId: identityPolicy, declared: binding.selectionPolicyVersionId });
  }
  const calendars = new Set((selection.horizonBindings ?? []).map((horizon) => horizon.calendarRegistryManifestId));
  if (calendars.size !== 1 || !calendars.has(binding.calendarRegistryManifestId)) {
    failClosed('HORIZON_CALENDAR_BINDING_MISMATCH', { declared: binding.calendarRegistryManifestId });
  }
  return Object.freeze({ datasetIdObservation: identityDataset, inputBinding: binding });
}

/**
 * Bounded ensemble cache. The module-level Map retained one entry per unique
 * ensemble identity for the lifetime of the process and never evicted, so a
 * FULL-scale run would retain every identity it had ever computed. The bound is
 * exact and the eviction order is deterministic: a Map iterates in insertion
 * order, so the evicted entry is always the oldest inserted one, and re-writing
 * an existing identity does not refresh its position.
 *
 * Bounding cannot change what the engine emits. The cached payload is never
 * returned as an authoritative output: combineFrozenSelection recomputes every
 * payload from the frozen selection, and readEnsembleCache is consulted only as
 * a stale-identity guard. Eviction therefore turns a guard hit into a guard
 * miss and nothing else, so a recomputed identity yields byte-identical bytes.
 */
export const ENSEMBLE_CACHE_MAX_ENTRIES = 128;

const CACHE = new Map();

/** Retained entry count. Observation only; it is never an input to a product. */
export function ensembleCacheSize() {
  return CACHE.size;
}

export function readEnsembleCache(identityId) {
  return CACHE.get(identityId) ?? null;
}

export function writeEnsembleCache(identityId, payload, currentIdentityId) {
  if (identityId !== currentIdentityId) failClosed('STALE_CACHE_SILENT_HIT_FORBIDDEN', { identityId, currentIdentityId });
  CACHE.set(identityId, payload);
  while (CACHE.size > ENSEMBLE_CACHE_MAX_ENTRIES) {
    const oldest = CACHE.keys().next();
    if (oldest.done) break;
    CACHE.delete(oldest.value);
  }
  return payload;
}

export function combineFrozenSelection({
  authority,
  selection,
  inputBinding,
  extraFamilies = [],
  engineVersion = ENSEMBLE_ENGINE_VERSION_V1,
  policyVersionId = null,
}) {
  if (engineVersion !== ENSEMBLE_ENGINE_VERSION_V1) {
    return abstainResult({ reason: 'STALE_OR_WRONG_VERSION', selection, authority });
  }
  if (policyVersionId !== null && policyVersionId !== authority.policy.combinationPolicyVersionId) {
    return abstainResult({ reason: 'STALE_OR_WRONG_VERSION', selection, authority });
  }
  if (!selection) return abstainResult({ reason: 'INSUFFICIENT_EVIDENCE', selection, authority });

  const present = presentFamilies(selection, extraFamilies);
  for (const family of FAMILIES_V1) {
    if (!present.has(family)) {
      if (family === 'ANALOGUE_OUTCOME_FAMILY') return abstainResult({ reason: 'PREDICTIVE_FAMILY_MISSING', selection, authority });
      failClosed('DEGRADED_INPUT', { family });
    }
  }

  if (selection.frozenSelection?.selectionComplete !== true) failClosed('LEAKAGE_ATTEMPT', { reason: 'OUTCOME_BEFORE_SELECTION_COMPLETE' });
  freezeSelection({
    queryIdentityId: selection.frozenSelection.queryIdentityId,
    rankedAnalogues: selection.frozenSelection.analogues,
  });
  if (selection.frozenSelection.selectionDigest !== sha256Canonical({
    schema: selection.frozenSelection.schema,
    queryIdentityId: selection.frozenSelection.queryIdentityId,
    analogues: selection.frozenSelection.analogues.map((entry) => ({
      rank: entry.rank,
      analogueIdentityId: entry.analogueIdentityId,
      finalDistance: entry.finalDistance,
    })),
  })) {
    failClosed('LEAKAGE_ATTEMPT', { reason: 'SELECTION_DIGEST_MISMATCH' });
  }
  if (selection.outcomeSet.selectionDigest !== selection.frozenSelection.selectionDigest) {
    failClosed('LEAKAGE_ATTEMPT', { reason: 'OUTCOME_SET_NOT_BOUND_TO_FROZEN_SELECTION' });
  }

  const sessionCounts = [...new Set((selection.horizonBindings ?? []).map((binding) => binding.sessionCount))].sort((a, b) => a - b);
  if ((selection.horizonBindings ?? []).length !== ADMISSIBLE_SESSION_COUNTS_V1.length
    || sessionCounts.length !== ADMISSIBLE_SESSION_COUNTS_V1.length
    || ADMISSIBLE_SESSION_COUNTS_V1.some((count, index) => sessionCounts[index] !== count)) {
    failClosed('HORIZON_NOT_ADMISSIBLE', { sessionCounts });
  }

  const { datasetIdObservation, inputBinding: boundInput } = deriveSelectionInputBinding({ selection, inputBinding });

  const predictiveExtras = extraFamilies.filter((family) => family.role === 'PREDICTIVE');
  if (predictiveExtras.length > 0) {
    const analogueSignature = sha256Canonical(selection.outcomeSet.records.map((record) => ({
      horizonId: record.horizonId, status: record.outcomeStatus,
    })));
    for (const family of predictiveExtras) {
      if (family.signature && family.signature !== analogueSignature) {
        return abstainResult({ reason: 'REGISTERED_DISAGREEMENT', selection, authority });
      }
    }
  }

  refuseProbabilityClaim(selection.supportReport);

  const coverageId = horizonCoverageId(ADMISSIBLE_SESSION_COUNTS_V1);
  const regime = regimeBinding(selection);
  const identity = createEnsembleIdentity({
    QueryAnalogueIdentityId: selection.queryIdentity.analogueIdentityId,
    KnowledgeCutoff: selection.query.knowledgeCutoff,
    CombinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    HorizonCoverageId: coverageId,
    AnalogueSupportReportId: selection.supportReportId,
    OutcomeSetId: selection.outcomeSet.outcomeSetId,
    RegimeBindingDigest: sha256Canonical(regime),
    DatasetId_observation: datasetIdObservation,
    EnsembleEngineVersionId: ENSEMBLE_ENGINE_VERSION_V1,
    MissingnessStateId: selection.supportReport.supportStatus,
  });

  const cached = readEnsembleCache(identity.ensembleIdentityId);
  if (cached && cached.identity.ensembleIdentityId !== identity.ensembleIdentityId) {
    failClosed('STALE_CACHE_SILENT_HIT_FORBIDDEN');
  }

  const provenance = buildProvenanceManifest({
    ensembleIdentityId: identity.ensembleIdentityId,
    queryIdentityId: selection.queryIdentity.analogueIdentityId,
    knowledgeCutoff: selection.query.knowledgeCutoff,
    analogueIdentityIds: selection.frozenSelection.analogues.map((entry) => entry.analogueIdentityId),
    combinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    horizonCoverageId: coverageId,
    selectionDigest: selection.frozenSelection.selectionDigest,
    outcomeSetId: selection.outcomeSet.outcomeSetId,
    supportReportId: selection.supportReportId,
    inputBinding: boundInput,
    regimeBinding: regime,
    inputProofs: selection.inputProofs ?? [],
  });

  const availability = selection.horizonBindings.map((binding) => {
    const rows = selection.outcomeSet.records.filter((record) => record.horizonId === binding.horizonId);
    const available = rows.filter((record) => record.outcomeStatus === 'AVAILABLE').length;
    const missing = rows.filter((record) => record.outcomeStatus === 'MISSING').length;
    if (available + missing !== rows.length) failClosed('DEGRADED_INPUT', { reason: 'OUTCOME_STATUS_UNKNOWN', horizonId: binding.horizonId });
    return { binding, rows, available, missing, outcomeAvailability: missing === rows.length ? 'MISSING' : available === rows.length ? 'AVAILABLE' : 'PARTIAL' };
  });

  /* Frozen V1 semantics: insufficient support abstains; no usable predictive outcome at any horizon abstains. */
  const supportInsufficient = selection.supportReport.decision === 'ABSTAIN'
    || selection.supportReport.supportStatus === 'INSUFFICIENT_SUPPORT'
    || selection.supportReport.eligibleCount < SUFFICIENT_SUPPORT_MIN_ELIGIBLE_COUNT_V1;
  const allHorizonsMissing = availability.every((entry) => entry.outcomeAvailability === 'MISSING');
  const recordReason = supportInsufficient ? 'INSUFFICIENT_SUPPORT' : allHorizonsMissing ? 'PREDICTIVE_FAMILY_MISSING' : null;
  const decision = recordReason === null ? 'PROCEED' : 'ABSTAIN';

  const horizons = availability.map(({ binding, rows, available, missing, outcomeAvailability }) => {
    const horizonReason = recordReason ?? (outcomeAvailability === 'MISSING' ? 'PREDICTIVE_FAMILY_MISSING' : null);
    return buildHorizonRecord({
      schema: MULTI_HORIZON_OUTPUT_SCHEMA_V1,
      ensembleIdentityId: identity.ensembleIdentityId,
      horizonId: binding.horizonId,
      sessionCount: binding.sessionCount,
      outcomeAvailability,
      analogueOutcomeSummary: { analogueCount: rows.length, availableCount: available, missingCount: missing },
      supportDerivedConfidence: {
        kind: 'SUPPORT_DERIVED_NOT_PROBABILITY',
        supportStatus: selection.supportReport.supportStatus,
        eligibleCount: selection.supportReport.eligibleCount,
        outcomeAvailability: missing === rows.length ? 'MISSING' : 'PRESENT',
        calibratedProbability: null,
      },
      uncertainty: {
        kind: 'SUPPORT_AND_OUTCOME_MISSINGNESS',
        sampleSize: selection.supportReport.eligibleCount,
        missingOutcomeCount: missing,
        excludedCount: selection.supportReport.excludedCount,
      },
      abstention: { decision: horizonReason === null ? 'PROCEED' : 'ABSTAIN', reason: horizonReason },
      combinationTrace: Object.freeze([
        Object.freeze({ step: 'ANALOGUE_SUPPORT', familyId: 'ANALOGUE_SUPPORT_FAMILY', result: selection.supportReport.supportStatus }),
        Object.freeze({ step: 'ANALOGUE_OUTCOME', familyId: 'ANALOGUE_OUTCOME_FAMILY', result: `${available}/${rows.length}` }),
        Object.freeze({ step: 'REGIME_BINDING', familyId: 'REGIME_BINDING_FAMILY', result: 'BOUND_NOT_RECLASSIFIED' }),
        Object.freeze({ step: 'COMBINE', weights: 'FORBIDDEN', result: 'INSPECTABLE_UNWEIGHTED' }),
      ]),
      provenanceBinding: { provenanceId: provenance.provenanceId, selectionDigest: selection.frozenSelection.selectionDigest },
    });
  });

  const payload = deepFreeze({
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    policySchema: COMBINATION_POLICY_SCHEMA_V1,
    combinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    decision,
    abstention: { decision, reason: recordReason },
    families: FAMILIES_V1.filter((family) => present.has(family)),
    identity,
    provenance,
    horizons,
    supportReport: selection.supportReport,
  });
  writeEnsembleCache(identity.ensembleIdentityId, payload, identity.ensembleIdentityId);
  return payload;
}

export { refusePermissiveFallback };
