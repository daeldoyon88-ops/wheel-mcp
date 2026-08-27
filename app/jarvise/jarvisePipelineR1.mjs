import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createContentAddressedStore } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { resolveInstrumentIdentityAsOf } from '../../research/directional-lab/src/data/buildInstrumentIdentity.mjs';
import { createCalendarWindowBinding } from '../../governance/gates/GATE23/implementation/feature-window-v1.mjs';
import { CORE_FEATURE_SET_V1, F1_DEFINITION, declareFeatureVector } from '../../governance/gates/GATE23/implementation/feature-families-v1.mjs';
import { createFeatureRegistry } from '../../governance/gates/GATE23/implementation/feature-registry-v1.mjs';
import { materializeFeatureRecords } from '../../governance/gates/GATE23/implementation/feature-materializer-v1.mjs';
import { createFeatureVectorBinding } from '../../governance/gates/GATE24/implementation/regime-identity-v1.mjs';
import { emitRegimeRecord } from '../../governance/gates/GATE24/implementation/regime-store-v1.mjs';
import { buildG21ClosedSessionBridgeR1 } from './g21ClosedSessionBridgeR1.mjs';
import { selectClosedMp1Sessions } from './closedSessionSelectorR1.mjs';
import { deriveJarviseDatasetIdentityTripleR1, verifyJarviseFeatureDatasetCohortR1 } from './jarviseDatasetIdentityTripleR1.mjs';
import { loadJarviseG24ProductionFoundationR1 } from './jarviseG24ProductionFoundationR1.mjs';
import { produceJarviseEmptyMacroContextR1 } from './jarviseEmptyMacroContextProducerR1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const isStrictUtcIso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

function result(status, reasonCode, details = {}) {
  return Object.freeze({ status, reasonCode, ...details });
}

function runtimeAuthority() {
  const calendar = readJson(resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json'));
  const calendarProvenance = readJson(resolve(REPOSITORY_ROOT, 'data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json'));
  const identityProvenance = readJson(resolve(REPOSITORY_ROOT, 'data/jarvise/instrument-identity/PROVENANCE.json'));
  const namespace = readJson(resolve(REPOSITORY_ROOT, 'data/jarvise/instrument-identity/symbol-namespace-policy.json'));
  const calendarWindowBinding = createCalendarWindowBinding({
    calendarAuthorityPolicyId: calendarProvenance.calendarAuthorityPolicyId,
    calendarRegistryManifestId: calendarProvenance.calendarRegistryManifestId,
    allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'],
    calendarNamespaceVersion: calendarProvenance.calendarNamespaceVersion,
  });
  if (calendarWindowBinding.calendarWindowBindingId !== calendarProvenance.calendarWindowBindingId) {
    throw new Error('MP1_CALENDAR_BINDING_ID_MISMATCH');
  }
  return { calendar, calendarWindowBinding, identityProvenance, namespace };
}

function resolveIdentity({ authority, symbol, sessionDate }) {
  try {
    const store = createContentAddressedStore({ root: resolve(REPOSITORY_ROOT, 'data/jarvise/instrument-identity/cas') });
    return resolveInstrumentIdentityAsOf({
      store,
      registryManifestId: authority.identityProvenance.registryManifestId,
      namespacePolicyId: authority.identityProvenance.namespacePolicyId,
      providerId: authority.namespace.providerId,
      venueId: null,
      symbol,
      currency: 'USD',
      asOfDate: sessionDate,
    });
  } catch (cause) {
    return result('ABSENT', 'IDENTITY_UNAVAILABLE', { causeCode: cause?.code ?? null });
  }
}

function observationBars(records) {
  return records.map((record) => ({
    recordType: 'Observation',
    sessionDate: record.sessionDate,
    close: record.adjusted?.close,
    volume: record.adjusted?.volume,
    priceBasisId: 'SPLIT_ADJUSTED',
    provenance: {
      producerGateId: 'GATE21',
      originRecordType: 'Observation',
      availableAt: record.availableAt,
    },
  }));
}

/** Consumes only the existing process-local G21 capture; it never fetches Yahoo. */
export function runJarvisePipelineR1({ symbol, knowledgeCutoff } = {}) {
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (!normalizedSymbol) return result('FAIL_CLOSED', 'SYMBOL_INVALID');
  if (!isStrictUtcIso(knowledgeCutoff)) return result('FAIL_CLOSED', 'KNOWLEDGE_CUTOFF_INVALID');

  const authority = runtimeAuthority();
  const selected = selectClosedMp1Sessions(authority.calendar, knowledgeCutoff);
  if (selected.status !== 'AVAILABLE') return result(selected.status, selected.reasonCode);

  const identity = resolveIdentity({ authority, symbol: normalizedSymbol, sessionDate: selected.latestClosedSession.sessionDate });
  if (identity.status === 'ABSENT') return identity;

  const g21 = buildG21ClosedSessionBridgeR1({
    symbol: normalizedSymbol,
    knowledgeCutoff,
    calendar: authority.calendar,
  });
  if (g21.status !== 'AVAILABLE') return result(g21.status, g21.reasonCode, { g21 });

  try {
    const triple = deriveJarviseDatasetIdentityTripleR1({
      g21BridgeOutput: g21,
      instrumentIdentityId: identity.instrumentIdentityId,
      priceBasisId: 'SPLIT_ADJUSTED',
      calendarWindowBinding: authority.calendarWindowBinding,
    });
    const featureSet = materializeFeatureRecords({
      instrumentIdentityId: identity.instrumentIdentityId,
      sessionDate: g21.sessionDate,
      calendarWindowBinding: authority.calendarWindowBinding,
      sessions: authority.calendar.sessions,
      observationBars: observationBars(g21.records),
      registry: createFeatureRegistry([F1_DEFINITION]),
      vector: declareFeatureVector(CORE_FEATURE_SET_V1),
      sourceBindingId: triple.sourceBindingId,
      datasetIdObservation: triple.datasetIdObservation,
    });
    if (featureSet.status !== 'RESOLVED') return result(featureSet.status, featureSet.code, { g21, triple, featureSet });
    const cohort = verifyJarviseFeatureDatasetCohortR1({
      datasetIdObservation: triple.datasetIdObservation,
      datasetIdFeature: triple.datasetIdFeature,
      featureRecords: featureSet.records,
      calendarWindowBinding: authority.calendarWindowBinding,
    });
    const foundation = loadJarviseG24ProductionFoundationR1();
    foundation.verifyFeatureSetHorizonBinding(featureSet);
    const macro = produceJarviseEmptyMacroContextR1({ knowledgeCutoff: g21.effectiveKnowledgeCutoff });
    const featureVectorBinding = createFeatureVectorBinding({
      featureSet: { ...featureSet, datasetIdFeature: triple.datasetIdFeature },
    });
    const regimeRecord = emitRegimeRecord({
      instrumentIdentityId: identity.instrumentIdentityId,
      sessionDate: g21.sessionDate,
      knowledgeCutoff: g21.effectiveKnowledgeCutoff,
      knowledgeCutoffBoundary: featureSet.knowledgeCutoffBoundary,
      regimeHorizonSpec: foundation.horizon,
      featureVectorBinding,
      macroContextBinding: macro.macroContextBinding,
      macroSnapshot: macro.macroSnapshotResolution.snapshot,
      vintageStore: macro.vintageStore,
      horizonStartKnowledgeCutoff: null,
      classifierVersion: foundation.classifier,
      parameterSet: foundation.parameterSet,
      featureSet,
      datasetIdFeature: triple.datasetIdFeature,
      declaredMacroCompleteness: macro.macroSnapshotResolution.snapshot.macroFeatureCompleteness,
    });
    return result('AVAILABLE', null, {
      symbol: normalizedSymbol,
      g21,
      instrumentIdentity: identity,
      triple,
      featureSet,
      cohort,
      foundationIds: {
        regimeHorizonSpecId: foundation.horizon.regimeHorizonSpecId,
        classifierVersionId: foundation.classifier.classifierVersionId,
        parameterSetId: foundation.parameterSet.parameterSetId,
      },
      macroContextBindingId: macro.macroContextBinding.macroContextBindingId,
      regimeRecord,
    });
  } catch (cause) {
    return result('FAIL_CLOSED', cause?.code ?? cause?.message ?? 'JARVISE_PIPELINE_FAILED');
  }
}
