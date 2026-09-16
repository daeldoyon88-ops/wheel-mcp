/**
 * GATE26 MINI materialization over REAL canonical inputs. Same pipeline as a later
 * full build: GATE25 loadP3hDatasetBinding -> loadHistoricalWindowCalendar ->
 * prepareP3hHistoricalUniverse -> buildP3hQuery -> runAnalogueSelection (whose
 * historical outcome source is createHistoricalObservationOutcomeSource), checked
 * against the published GATE25 ANALOGUE_INDEX, then GATE26 combination.
 *
 * The query cases are read from the Owner-resolved D4 binding bytes, not from code
 * constants. P3H, the analogue index and every GATE21-GATE25 surface are read-only.
 *
 * Building product bytes (buildMiniProducts) never writes. Only the explicit CLI
 * `--materialize` writes the four MINI product paths. Tests never materialize.
 */

import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalize, sha256Bytes, sha256Canonical } from '../../../tools/canonical-json.mjs';
import { durableReplaceFileSync, sweepPublicationResidue } from '../../../tools/durable-write.mjs';
import {
  attachPublishedFoundationProjections,
  bindPublishedHistoricalRegimeFoundation,
  bindR0003SelectionPolicy,
  buildP3hQuery,
  createRegistryHistoricalIdentityResolver,
  iterateP3hCandidates,
  loadGate25BuildAuthority,
  loadHistoricalWindowCalendar,
  loadP3hDatasetBinding,
  prepareP3hHistoricalUniverse,
  runAnalogueSelection,
} from '../../GATE25/implementation/historical-analogue-engine-v1.mjs';
import { ANALOGUE_INDEX_PRODUCT_PATH_V1, ANALOGUE_INDEX_SCHEMA_V1 } from '../../GATE25/implementation/analogue-index-v1.mjs';
import { ENSEMBLE_ENGINE_VERSION_V1, failClosed, horizonCoverageId } from './ensemble-identity-v1.mjs';
import { COMBINATION_POLICY_SCHEMA_V1 } from './combination-policy-v1.mjs';
import { ADMISSIBLE_SESSION_COUNTS_V1 } from './ensemble-record-v1.mjs';
import {
  ENSEMBLE_INDEX_PRODUCT_PATH_V1,
  PRODUCT_PROVENANCE_SCHEMA_V1,
  PROVENANCE_PRODUCT_PATH_V1,
  appendEnsembleRecord,
  buildEnsembleIndexRecord,
  createEnsembleIndex,
  serializeEnsembleIndex,
  validateInputBinding,
} from './ensemble-provenance-v1.mjs';
import {
  EXECUTION_CONTRACT_PATH,
  abstainForRefusedQuery,
  combineFrozenSelection,
  loadGate26MiniBuildAuthority,
} from './predictive-ensemble-engine-v1.mjs';
import { consumeEnsemble, describeConsumptionBoundary } from './consumption-boundary-v1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export const SIZE_MEASUREMENT_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/SIZE_MEASUREMENT.json';
export const REHEARSAL_REPORT_PATH_V1 = 'data/jarvise/predictive-ensemble/GATE26/V1/MINI/REHEARSAL_REPORT.json';
export const MINI_PRODUCT_PATHS_V1 = Object.freeze([
  ENSEMBLE_INDEX_PRODUCT_PATH_V1, PROVENANCE_PRODUCT_PATH_V1, SIZE_MEASUREMENT_PATH_V1, REHEARSAL_REPORT_PATH_V1,
]);

/** D4 anchor case grammar. The symbol and the anchor date are parsed out of the binding's own case ids. */
export const D4_ANCHOR_CASE_RULES_V1 = Object.freeze([
  Object.freeze({ pattern: /^([A-Z]+)_END_(\d{4}-\d{2}-\d{2})$/, role: 'END', rule: 'EXACT_PINNED_SESSION' }),
  Object.freeze({ pattern: /^([A-Z]+)_MID_FROM_(\d{4}-\d{2}-\d{2})$/, role: 'MID', rule: 'FIRST_PINNED_SESSION_ON_OR_AFTER' }),
  Object.freeze({ pattern: /^([A-Z]+)_PREALIAS_(\d{4}-\d{2}-\d{2})$/, role: 'PRE_ALIAS', rule: 'EXACT_PINNED_SESSION' }),
]);
export const D4_PROPERTY_CASES_V1 = Object.freeze([
  'ABSTAIN_ELIGIBLE_COUNT_LT_2',
  'HORIZON_MISSING',
  'CORE_V1_SIGNATURES_GTE_2',
  'HORIZONS_ALL_AND_ONLY_30_90_180_252',
]);

const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** Every network surface refuses, for the lifetime of an OFF_SCAN run. Returns the attempted calls. */
export function installNetworkTrap() {
  const calls = [];
  const trap = (name) => () => { calls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'],
    [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();
  return calls;
}

function readRequiredInput(root, authority, role) {
  const entry = authority.requiredInputs.find((input) => input.role === role);
  if (!entry) failClosed('REQUIRED_INPUT_UNBOUND', { role });
  const bytes = readFileSync(resolve(root, entry.path));
  if (sha256Bytes(bytes) !== entry.sha256) failClosed('REQUIRED_INPUT_SHA256_MISMATCH', { role, path: entry.path });
  return { path: entry.path, sha256: entry.sha256, bytes };
}

/**
 * Read-only lookup view over the published GATE25 ANALOGUE_INDEX bytes, in the shape
 * GATE25 runAnalogueSelection accepts as `analogueIndex`. The bytes are identified by
 * the SHA-256 the pinned GATE25 PROVENANCE declares; nothing is rebuilt or rewritten.
 */
export function readPublishedAnalogueIndexView({ root, expectedSha256, datasetId, selectionPolicyVersionId }) {
  const bytes = readFileSync(resolve(root, ANALOGUE_INDEX_PRODUCT_PATH_V1));
  const sha256 = sha256Bytes(bytes);
  if (sha256 !== expectedSha256) failClosed('ANALOGUE_INDEX_IDENTITY_MISMATCH', { observed: sha256, expected: expectedSha256 });
  const parsed = JSON.parse(bytes.toString('utf8'));
  if (parsed.schema !== ANALOGUE_INDEX_SCHEMA_V1 || parsed.datasetId !== datasetId || parsed.selectionPolicyVersionId !== selectionPolicyVersionId
    || !Array.isArray(parsed.records) || parsed.recordCount !== parsed.records.length) {
    failClosed('ANALOGUE_INDEX_BINDING_MISMATCH');
  }
  const records = new Map();
  parsed.records.forEach((record, index) => {
    if (index > 0 && !(record.analogueIdentityId > parsed.records[index - 1].analogueIdentityId)) failClosed('ANALOGUE_INDEX_STORAGE_ORDER_INVALID', { index });
    records.set(record.analogueIdentityId, record);
  });
  return Object.freeze({
    schema: parsed.schema,
    datasetId: parsed.datasetId,
    selectionPolicyVersionId: parsed.selectionPolicyVersionId,
    records,
    recordCount: parsed.recordCount,
    sha256,
    byteLength: bytes.length,
  });
}

/** Loads every real, read-only input of the MINI once. No fetch, no repair, no regeneration. */
export function loadMiniRealInputs({ root = REPOSITORY_ROOT, authority = loadGate26MiniBuildAuthority({ root }) } = {}) {
  const gate25Provenance = readRequiredInput(root, authority, 'GATE25_ANALOGUE_PROVENANCE_READ_ONLY');
  const gate25ProvenanceDocument = JSON.parse(gate25Provenance.bytes.toString('utf8'));
  const horizonContract = readRequiredInput(root, authority, 'HORIZON_AUTHORITY_ALL_AND_ONLY');
  const gate25Authority = loadGate25BuildAuthority({ root });
  if (gate25Authority.bindings.GATE25_POST_SELECTION_OUTCOME_SET_V1.horizonSource.sha256 !== horizonContract.sha256) {
    failClosed('HORIZON_AUTHORITY_DIVERGES_FROM_GATE25');
  }
  const p3h = loadP3hDatasetBinding({ authority: gate25Authority });
  const calendar = loadHistoricalWindowCalendar({ authority: gate25Authority, root });
  const policy = bindR0003SelectionPolicy({ authority: gate25Authority, p3h, calendar });
  const identityResolver = createRegistryHistoricalIdentityResolver({ root });
  const { foundation, described } = bindPublishedHistoricalRegimeFoundation({ authority: gate25Authority, root });
  const universe = attachPublishedFoundationProjections({
    universe: prepareP3hHistoricalUniverse({ p3h, calendar, identityResolver }),
    foundation,
  });
  if (gate25ProvenanceDocument.datasetId !== p3h.datasetId || gate25ProvenanceDocument.selectionPolicyVersionId !== policy.selectionPolicyVersionId) {
    failClosed('GATE25_PROVENANCE_BINDING_MISMATCH');
  }
  const analogueIndex = readPublishedAnalogueIndexView({
    root,
    expectedSha256: gate25ProvenanceDocument.analogueIndexSha256,
    datasetId: p3h.datasetId,
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
  });
  const inputBinding = validateInputBinding({
    datasetId: p3h.datasetId,
    datasetSha256: p3h.datasetSha256,
    admittedKeyDigest: p3h.admittedKeyDigest,
    exclusionDigest: p3h.exclusionDigest,
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
    gate25ExecutionContractSha256: gate25Authority.contractSha256,
    calendarRegistryManifestId: calendar.calendarRegistryManifestId,
    analogueIndexSha256: analogueIndex.sha256,
    gate25ProvenanceSha256: gate25Provenance.sha256,
    horizonContractSha256: horizonContract.sha256,
  });
  return {
    authority, gate25Authority, p3h, calendar, policy, universe, analogueIndex, inputBinding,
    foundationIdentities: {
      regimeHorizonSpecId: described.regimeHorizonSpecId,
      classifierVersionId: described.classifierVersionId,
      parameterSetId: described.parameterSetId,
      macroContextBindingId: described.macroContextBindingId,
    },
  };
}

/** The D4 anchor cases, parsed from the Owner-resolved binding. Unknown or missing anchor grammar fails closed. */
export function deriveD4AnchorCases(authority) {
  const queryCases = authority.bindings.GATE26_MINI_FIXTURE_SELECTION_V1.queryCases;
  const anchors = [];
  for (const caseId of queryCases) {
    if (D4_PROPERTY_CASES_V1.includes(caseId)) continue;
    const matched = D4_ANCHOR_CASE_RULES_V1.map((rule) => ({ rule, match: rule.pattern.exec(caseId) })).filter((item) => item.match);
    if (matched.length !== 1) failClosed('D4_QUERY_CASE_UNRECOGNIZED', { caseId });
    const [{ rule, match }] = matched;
    anchors.push(Object.freeze({ caseId, role: rule.role, rule: rule.rule, querySymbol: match[1], anchorDate: match[2] }));
  }
  for (const role of ['END', 'MID', 'PRE_ALIAS']) {
    if (anchors.filter((anchor) => anchor.role === role).length !== 1) failClosed('D4_ANCHOR_CASE_NOT_EXACT', { role });
  }
  if (D4_PROPERTY_CASES_V1.some((caseId) => !queryCases.includes(caseId)) || queryCases.length !== anchors.length + D4_PROPERTY_CASES_V1.length) {
    failClosed('D4_QUERY_CASES_NOT_EXACT');
  }
  return anchors;
}

function resolveAnchorSession(universe, anchor) {
  const session = anchor.rule === 'FIRST_PINNED_SESSION_ON_OR_AFTER'
    ? universe.sessions.find((item) => item.sessionDate >= anchor.anchorDate)
    : universe.sessions.find((item) => item.sessionDate === anchor.anchorDate);
  if (!session) failClosed('D4_ANCHOR_SESSION_NOT_PINNED', { caseId: anchor.caseId });
  return session.sessionDate;
}

function coreV1SignatureDigest(universe, acquisitionKey, sessionDate) {
  for (const [signature, members] of universe.coreV1ClassifyingGroups) {
    if (members.some((entry) => entry.acquisitionKey === acquisitionKey && entry.sessionDate === sessionDate)) {
      return sha256Bytes(Buffer.from(signature, 'utf8'));
    }
  }
  return null;
}

/** Executes one D4 anchor case end to end on the real universe and returns the combined result plus execution evidence. */
export function executeAnchorCase({ inputs, anchor }) {
  const { authority, gate25Authority, policy, universe, analogueIndex, inputBinding } = inputs;
  const key = universe.keys.find((item) => item.providerSymbol === anchor.querySymbol && item.exclusionClass === null);
  if (!key) failClosed('D4_QUERY_SYMBOL_NOT_ADMITTED', { caseId: anchor.caseId });
  const sessionDate = resolveAnchorSession(universe, anchor);
  const query = buildP3hQuery({ universe, acquisitionKey: key.acquisitionKey, sessionDate });
  let selection = null;
  let refusal = null;
  try {
    selection = runAnalogueSelection({
      authority: gate25Authority, policy, query, candidates: iterateP3hCandidates(universe), historicalOutcomeUniverse: universe, analogueIndex,
    });
  } catch (error) {
    refusal = error;
  }
  const combined = selection === null
    ? abstainForRefusedQuery({ authority, refusal })
    : combineFrozenSelection({ authority, selection, inputBinding });
  const evidence = {
    caseId: anchor.caseId,
    derivation: {
      role: anchor.role,
      rule: anchor.rule,
      anchorDate: anchor.anchorDate,
      querySymbol: anchor.querySymbol,
      queryAcquisitionKey: key.acquisitionKey,
      sessionDate,
    },
    execution: selection === null ? 'QUERY_REFUSED' : 'SELECTION_COMPLETED',
    refusalCode: refusal?.code ?? null,
    queryInstrumentIdentity: {
      status: query.instrumentIdentity.status,
      instrumentIdentityId: query.instrumentIdentity.instrumentIdentityId ?? null,
      code: query.instrumentIdentity.code ?? null,
    },
    queryKnowledgeCutoff: query.knowledgeCutoff,
    queryCoreV1SignatureDigest: coreV1SignatureDigest(universe, key.acquisitionKey, sessionDate),
    queryIdentityId: selection?.queryIdentity.analogueIdentityId ?? null,
    accounting: selection === null ? null : {
      universeCount: selection.accounting.universeCount,
      eligibleCount: selection.accounting.eligibleCount,
      excludedCount: selection.accounting.excludedCount,
      decisionDigest: selection.accounting.decisionDigest,
    },
    supportReportId: selection?.supportReportId ?? null,
    comparisonReportId: selection?.comparisonReportId ?? null,
    selectionDigest: selection?.frozenSelection.selectionDigest ?? null,
    outcomeSetId: selection?.outcomeSet.outcomeSetId ?? null,
    analogueIdentityIds: selection === null ? [] : selection.frozenSelection.analogues.map((entry) => entry.analogueIdentityId),
    horizonAvailability: selection === null ? [] : selection.horizonBindings.map((binding) => {
      const rows = selection.outcomeSet.records.filter((record) => record.horizonId === binding.horizonId);
      return {
        horizonId: binding.horizonId,
        sessionCount: binding.sessionCount,
        analogueCount: rows.length,
        availableCount: rows.filter((record) => record.outcomeStatus === 'AVAILABLE').length,
      };
    }),
    ensembleIdentityId: combined.identity?.ensembleIdentityId ?? null,
    decision: combined.decision,
    abstainReason: combined.abstention.reason,
  };
  return { anchor, combined, evidence };
}

/** D4 coverage computed from execution evidence; any uncovered case fails closed. */
export function computeD4Coverage(evidence) {
  const completed = evidence.filter((item) => item.execution === 'SELECTION_COMPLETED');
  const signatures = [...new Set(completed.map((item) => item.queryCoreV1SignatureDigest).filter((digest) => digest !== null))].sort();
  const coverage = [
    ...evidence.map((item) => ({ queryCase: item.caseId, coveredBy: [item.caseId] })),
    {
      queryCase: 'ABSTAIN_ELIGIBLE_COUNT_LT_2',
      coveredBy: completed.filter((item) => item.accounting.eligibleCount < 2 && item.decision === 'ABSTAIN' && item.abstainReason === 'INSUFFICIENT_SUPPORT').map((item) => item.caseId),
    },
    {
      queryCase: 'HORIZON_MISSING',
      coveredBy: completed.filter((item) => item.horizonAvailability.some((horizon) => horizon.availableCount === 0)).map((item) => item.caseId),
    },
    {
      queryCase: 'CORE_V1_SIGNATURES_GTE_2',
      coveredBy: signatures.length >= 2 ? completed.filter((item) => item.queryCoreV1SignatureDigest !== null).map((item) => item.caseId) : [],
      distinctSignatureDigests: signatures,
    },
    {
      queryCase: 'HORIZONS_ALL_AND_ONLY_30_90_180_252',
      coveredBy: completed.length > 0 && completed.every((item) => canonicalize(item.horizonAvailability.map((horizon) => horizon.sessionCount)) === canonicalize([...ADMISSIBLE_SESSION_COUNTS_V1]))
        ? completed.map((item) => item.caseId) : [],
    },
  ];
  const uncovered = coverage.filter((item) => item.coveredBy.length === 0).map((item) => item.queryCase);
  if (uncovered.length > 0) failClosed('MINI_D4_CASE_NOT_COVERED', { uncovered });
  return coverage;
}

function measureSize({ index, indexBytes, provenanceBytes, productProvenance, analogueIndex, thresholdBytes }) {
  const envelopeBytes = serializeEnsembleIndex(createEnsembleIndex({
    engineVersion: index.engineVersion, combinationPolicyVersionId: index.combinationPolicyVersionId, horizonCoverageId: index.horizonCoverageId,
  })).length;
  const eligibleOf = (manifest) => manifest.analogueIdentityIds.length;
  const indexRows = index.records.map((record) => ({
    ensembleIdentityId: record.ensembleIdentityId,
    decision: record.decision,
    rowBytes: Buffer.byteLength(canonicalize(record), 'utf8'),
  }));
  const provenanceRows = productProvenance.records.map((manifest) => ({
    ensembleIdentityId: manifest.ensembleIdentityId,
    analogueCount: eligibleOf(manifest),
    inputProofCount: manifest.inputProofs.length,
    rowBytes: Buffer.byteLength(JSON.stringify(manifest, null, 2), 'utf8'),
  }));
  const max = (rows) => rows.reduce((acc, row) => Math.max(acc, row.rowBytes), 0);
  const indexRowMax = max(indexRows);
  const provenanceRowMax = max(provenanceRows);
  const byAnalogues = [...provenanceRows].sort((left, right) => left.analogueCount - right.analogueCount);
  const lowest = byAnalogues[0];
  const highest = byAnalogues.at(-1);
  const provenanceBytesPerAnalogue = highest.analogueCount > lowest.analogueCount
    ? Math.ceil((highest.rowBytes - lowest.rowBytes) / (highest.analogueCount - lowest.analogueCount)) : null;
  const rowCount = analogueIndex.recordCount;
  const projectedIndexBytes = envelopeBytes + rowCount * (indexRowMax + 1);
  const projectedProvenanceBytes = rowCount * (provenanceRowMax + 2);
  const classify = (bytes) => (bytes >= thresholdBytes ? 'LFS_REQUIRED' : 'NORMAL_GIT_ELIGIBLE');
  return {
    schema: 'GATE26_MINI_SIZE_MEASUREMENT_V1',
    method: {
      methodId: 'GATE26_MINI_SERIALIZED_ROW_BYTES_V1',
      basis: 'REAL_DATA_MINI_PRODUCT_BYTES',
      indexRowBytes: 'UTF-8 byte length of CanonicalJSON/1 of each ENSEMBLE_INDEX record as serialized in ENSEMBLE_INDEX.json',
      indexEnvelopeBytes: 'byte length of the serialized ENSEMBLE_INDEX with zero records',
      provenanceRowBytes: 'UTF-8 byte length of each per-record provenance manifest in PROVENANCE.json layout (JSON, 2-space indent)',
      projection: 'envelope + rowCount x (maximum measured row bytes + separator); rowCount = GATE25 ANALOGUE_INDEX recordCount (one ensemble row per indexed observation)',
      conservatism: 'maximum, not mean, measured row; provenance rows scale with analogue count, so the provenance projection at the MINI maximum analogue count is a lower bound where full-build analogue counts are larger',
    },
    measured: {
      indexByteLength: indexBytes.length,
      indexEnvelopeByteLength: envelopeBytes,
      provenanceByteLength: provenanceBytes.length,
      recordCount: index.recordCount,
      indexRows,
      indexRowBytesMax: indexRowMax,
      provenanceRows,
      provenanceRowBytesMax: provenanceRowMax,
      provenanceBytesPerAnalogue,
    },
    fullBuildProjection: {
      rowCountBasis: 'GATE25_ANALOGUE_INDEX_RECORD_COUNT',
      analogueIndexSha256: analogueIndex.sha256,
      rowCount,
      projectedEnsembleIndexBytes: projectedIndexBytes,
      projectedEnsembleIndexClass: classify(projectedIndexBytes),
      projectedProvenanceBytesAtMiniMaxAnalogueCount: projectedProvenanceBytes,
      projectedProvenanceClassAtMiniMaxAnalogueCount: classify(projectedProvenanceBytes),
      fullBuildRequiresLfsBeforeWrite: classify(projectedIndexBytes) === 'LFS_REQUIRED' || classify(projectedProvenanceBytes) === 'LFS_REQUIRED',
    },
    lfsThresholdBytes: thresholdBytes,
    miniClass: indexBytes.length < thresholdBytes && provenanceBytes.length < thresholdBytes ? 'NORMAL_GIT' : 'LFS_REQUIRED',
  };
}

/**
 * Builds the four MINI product byte buffers from real inputs. Performs no write.
 * Deterministic: no clock, no randomness, canonical ordering throughout.
 */
export function buildMiniProducts({ root = REPOSITORY_ROOT, inputs = loadMiniRealInputs({ root }) } = {}) {
  const { authority, inputBinding, analogueIndex } = inputs;
  const anchors = deriveD4AnchorCases(authority);
  const executed = anchors.map((anchor) => executeAnchorCase({ inputs, anchor }));
  const evidence = executed.map((item) => item.evidence);
  const d4Coverage = computeD4Coverage(evidence);

  const coverageId = horizonCoverageId(ADMISSIBLE_SESSION_COUNTS_V1);
  let index = createEnsembleIndex({
    engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
    combinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    horizonCoverageId: coverageId,
  });
  const published = executed.filter((item) => item.combined.identity !== null);
  for (const item of published) index = appendEnsembleRecord(index, buildEnsembleIndexRecord(item.combined));
  const indexBytes = serializeEnsembleIndex(index);

  const productProvenance = {
    schema: PRODUCT_PROVENANCE_SCHEMA_V1,
    authority: {
      executionContractPath: EXECUTION_CONTRACT_PATH,
      executionContractSha256: authority.contractSha256,
      mandateSha256: authority.mandateSha256,
      fixtureSelectionBindingSha256: sha256Canonical(authority.bindings.GATE26_MINI_FIXTURE_SELECTION_V1),
    },
    modelPolicy: {
      engineVersion: ENSEMBLE_ENGINE_VERSION_V1,
      combinationPolicySchema: COMBINATION_POLICY_SCHEMA_V1,
      combinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
      horizonCoverageId: coverageId,
      sessionCounts: [...ADMISSIBLE_SESSION_COUNTS_V1],
    },
    inputBinding,
    queryCases: evidence,
    d4Coverage,
    records: published
      .map((item) => item.combined.provenance)
      .sort((left, right) => (left.ensembleIdentityId < right.ensembleIdentityId ? -1 : 1)),
    product: {
      ensembleIndexPath: ENSEMBLE_INDEX_PRODUCT_PATH_V1,
      ensembleIndexSha256: sha256Bytes(indexBytes),
      ensembleIndexByteLength: indexBytes.length,
      recordCount: index.recordCount,
    },
    analogueIndexMutation: 'FORBIDDEN',
    samePipelineAsFullBuild: true,
  };
  const provenanceBytes = jsonBytes(productProvenance);
  const thresholdBytes = authority.bindings.GATE26_LFS_THRESHOLD_V1.thresholdBytes;
  if (provenanceBytes.length >= thresholdBytes) failClosed('LFS_THRESHOLD_EXCEEDED', { path: PROVENANCE_PRODUCT_PATH_V1, byteLength: provenanceBytes.length });

  const sizeBytes = jsonBytes(measureSize({ index, indexBytes, provenanceBytes, productProvenance, analogueIndex, thresholdBytes }));

  const indexSha256 = sha256Bytes(indexBytes);
  const provenanceSha256 = sha256Bytes(provenanceBytes);
  const consumption = index.records.map((record) => {
    const consumed = consumeEnsemble({
      indexBytes,
      provenanceBytes,
      ensembleIdentityId: record.ensembleIdentityId,
      expectedIndexSha256: indexSha256,
      expectedProvenanceSha256: provenanceSha256,
      expectedCombinationPolicyVersionId: authority.policy.combinationPolicyVersionId,
    });
    return { ensembleIdentityId: record.ensembleIdentityId, decision: consumed.decision, abstainReason: consumed.abstainReason, provenanceId: consumed.verification.provenanceId };
  });
  const rehearsalBytes = jsonBytes({
    schema: 'GATE26_MINI_REHEARSAL_REPORT_V1',
    publication: {
      indexPath: ENSEMBLE_INDEX_PRODUCT_PATH_V1,
      indexSha256,
      indexByteLength: indexBytes.length,
      provenancePath: PROVENANCE_PRODUCT_PATH_V1,
      provenanceSha256,
      provenanceByteLength: provenanceBytes.length,
      identityRule: 'SHA256_OF_PRODUCT_BYTES_EQUALS_CONSUMED_AND_PUBLISHED',
      lfsPointerRequired: false,
    },
    consumption: {
      boundary: describeConsumptionBoundary(),
      consumedFrom: 'SERIALIZED_PRODUCT_BYTES_BEFORE_WRITE_SHA256_BOUND',
      results: consumption,
    },
    closure: {
      agentClosureExecuted: false,
      externalConfirmationExecuted: false,
      independentAuditPassAssigned: false,
      checklist: [
        'PRECONTRACT_ANCHORED',
        'AUTHORIZATION_APPLIED',
        'START_APPLIED',
        'CONTRACT_SUCCESSION_R0002_APPLIED',
        'MINI_REAL_DATA_MATERIALIZED',
        'HOSTILES_H01_H21',
        'FGI_NOT_AGENT_CLOSURE',
      ],
    },
    queryCaseOutcomes: evidence.map((item) => ({ caseId: item.caseId, execution: item.execution, decision: item.decision, abstainReason: item.abstainReason })),
    checkpointResume: 'R0003 IN_PROGRESS_MINI_BUILD_AUTHORIZED',
  });

  return {
    bytes: new Map([
      [ENSEMBLE_INDEX_PRODUCT_PATH_V1, indexBytes],
      [PROVENANCE_PRODUCT_PATH_V1, provenanceBytes],
      [SIZE_MEASUREMENT_PATH_V1, sizeBytes],
      [REHEARSAL_REPORT_PATH_V1, rehearsalBytes],
    ]),
    evidence,
    executed,
  };
}

/** Writes the four MINI product paths, and nothing else, then proves the bytes on disk are the bytes built. */
export function materializeMiniFixture({ root = REPOSITORY_ROOT, inputs = undefined } = {}) {
  const built = buildMiniProducts({ root, ...(inputs ? { inputs } : {}) });
  const thresholdBytes = (inputs?.authority ?? loadGate26MiniBuildAuthority({ root })).bindings.GATE26_LFS_THRESHOLD_V1.thresholdBytes;
  for (const [path, bytes] of built.bytes) {
    if (!MINI_PRODUCT_PATHS_V1.includes(path)) failClosed('MINI_PRODUCT_PATH_NOT_AUTHORIZED', { path });
    if (bytes.length >= thresholdBytes) failClosed('LFS_THRESHOLD_EXCEEDED', { path, byteLength: bytes.length });
  }
  const targets = MINI_PRODUCT_PATHS_V1.map((path) => resolve(root, path));
  for (const path of MINI_PRODUCT_PATHS_V1) durableReplaceFileSync(resolve(root, path), built.bytes.get(path));
  const residue = sweepPublicationResidue(targets);
  const written = MINI_PRODUCT_PATHS_V1.map((path) => {
    const sha256 = sha256Bytes(readFileSync(resolve(root, path)));
    if (sha256 !== sha256Bytes(built.bytes.get(path))) failClosed('PUBLISHED_BYTES_DISAGREE_WITH_BUILD', { path });
    return { path, sha256, byteLength: built.bytes.get(path).length };
  });
  return { written, residue, evidence: built.evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes('--materialize')) {
    process.stdout.write('usage: mini-fixture-v1.mjs --materialize   (writes only the four GATE26 MINI product paths)\n');
    process.exitCode = 2;
  } else {
    const networkCalls = installNetworkTrap();
    const result = materializeMiniFixture({});
    process.stdout.write(`${JSON.stringify({ written: result.written, residue: result.residue, networkCalls,
      cases: result.evidence.map((item) => ({ caseId: item.caseId, sessionDate: item.derivation.sessionDate, execution: item.execution, eligibleCount: item.accounting?.eligibleCount ?? null, decision: item.decision, abstainReason: item.abstainReason })) }, null, 2)}\n`);
    if (networkCalls.length > 0) process.exitCode = 2;
  }
}
