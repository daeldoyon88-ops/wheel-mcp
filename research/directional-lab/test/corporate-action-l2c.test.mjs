import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CA, CorporateActionError, corporateActionObjectId } from '../src/contracts/corporateActionL2CV1.mjs';
import {
  buildInstrumentIdentity, buildInstrumentIdentityAuthorityPolicy, buildInstrumentIdentityManifest,
  buildInstrumentIdentityRegistry,
} from '../src/data/buildInstrumentIdentity.mjs';
import {
  buildCorporateActionAdjudication, buildCorporateActionEntitlementPlan, buildCorporateActionEventManifest,
  buildCorporateActionIdentity, buildCorporateActionObservation, buildCorporateActionObservationRecord,
  buildCorporateActionPlanManifest, buildCorporateActionPolicies, buildCorporateActionPriceAdjustmentPlan,
  buildCorporateActionRegistry, buildCorporateActionRevision, buildCorporateActionSourceAttestation,
  buildCorporateActionSourcePayload, buildDatasetSnapshotCorporateActionBinding,
  buildDatasetSnapshotCorporateActionBindingAuthorityPolicy,
  buildDatasetSnapshotCorporateActionBindingRegistry, buildInstrumentCorporateActionLedger,
  buildCorporateActionParticipant, buildTimeZoneRuleset, recoverCorporateActionRegistry,
  buildProviderCorporateActionBinding,
  resolveCorporateActionsAsOf, resolveDatasetSnapshotCorporateActionBinding,
  verifyCorporateActionSourcePayload,
} from '../src/data/buildCorporateAction.mjs';
import { buildSyntheticSnapshot, withStore } from './l2aSyntheticPipeline.mjs';

const UTC = (instant) => ({ temporalPrecision: 'UTC_INSTANT', availableOn: null, sourceTimeZone: null,
  timeZoneRulesetId: null, knowledgeTimeLowerBound: instant, knowledgeTimeUpperBound: instant });
const EXEC = { runnerId: 'node:test', runId: null, environment: 'LOCAL_TEST' };

function code(error) { return error?.code; }

function setup(store) {
  const instrumentAuthority = buildInstrumentIdentityAuthorityPolicy({ store, authorityId: 'l2c-synthetic-instruments/1', identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64 });
  const instrument = buildInstrumentIdentity({ store, authorityPolicyId: instrumentAuthority.authorityPolicyId, identitySeed: '1'.repeat(64), instrumentKind: 'EQUITY' });
  const instrumentManifest = buildInstrumentIdentityManifest({
    store, instrumentIdentityId: instrument.instrumentIdentityId, aliasBindingCoreIds: [],
  });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store,
    authorityPolicyId: instrumentAuthority.authorityPolicyId,
    identityManifestIds: [instrumentManifest.identityManifestId],
  });
  const policies = buildCorporateActionPolicies({ store,
    authorityPolicy: { schemaVersion: CA.AUTHORITY, authorityId: 'l2c-synthetic-actions/1', identityNamespaceVersion: 'B2/1', eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64 },
    normalizationPolicy: { schemaVersion: CA.NORMALIZATION, normalizationVersion: 'synthetic/1', supportedEventKinds: [...['CASH_DIVIDEND_ORDINARY', 'FORWARD_SPLIT', 'MERGER_CASH']].sort(), currencyCodes: ['CAD', 'USD'] },
    temporalPolicy: { schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'synthetic/1', dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366 },
    adjudicationPolicy: { schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'synthetic/1', requireAllVisibleObservations: true, allowContested: true },
    priceAdjustmentPolicy: { schemaVersion: CA.PRICE_POLICY, policyVersion: 'synthetic/1', supportedPriceBases: ['PROVIDER_ADJUSTED', 'RAW', 'SPLIT_ADJUSTED'] },
    entitlementPolicy: { schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'synthetic/1', roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED' },
  });
  return { instrumentAuthority, instrument, instrumentManifest, instrumentRegistry, policies };
}

function registryArgs(policies, instrumentRegistry, instrumentLedgerManifestIds, supersedesRegistryManifestId = null) {
  return {
    authorityPolicyId: policies.authorityPolicy.policyId,
    normalizationPolicyId: policies.normalizationPolicy.policyId,
    temporalPolicyId: policies.temporalPolicy.policyId,
    adjudicationPolicyId: policies.adjudicationPolicy.policyId,
    priceAdjustmentPolicyId: policies.priceAdjustmentPolicy.policyId,
    entitlementPolicyId: policies.entitlementPolicy.policyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    instrumentLedgerManifestIds,
    supersedesRegistryManifestId,
  };
}

function completeSplitGraph(store) {
  const { instrument, instrumentRegistry, policies } = setup(store);
  const identity = buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'a'.repeat(64) });
  const participant = buildCorporateActionParticipant({ store, participant: { schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
    instrumentIdentityId: instrument.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT', validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null } });
  const payload = buildCorporateActionSourcePayload({ store, payloadFormat: 'CANONICAL_JSON', mediaType: 'application/json', payloadValue: { synthetic: true, ratio: '2:1' } });
  const attestation = buildCorporateActionSourceAttestation({ store, attestation: { schemaVersion: CA.ATTESTATION, provenanceMode: 'EMBEDDED_CANONICAL_PAYLOAD', embeddedPayloadId: payload.sourcePayloadId,
    digestAlgorithm: null, payloadDigest: null, payloadByteLength: null, sourceKind: null, providerId: null, observedAt: '2026-01-08T12:00:00.000Z', ...UTC('2026-01-08T12:00:00.000Z') } });
  const obs1 = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId, normalizationPolicyId: policies.normalizationPolicy.policyId, sourceAttestationId: attestation.sourceAttestationId,
    claim: { eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null } }, ...UTC('2026-01-08T12:00:00.000Z') } });
  const obs2 = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId, normalizationPolicyId: policies.normalizationPolicy.policyId, sourceAttestationId: null,
    claim: { eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '3', denominator: '1' }, cashAmount: null } }, ...UTC('2026-01-15T12:00:00.000Z') } });
  const record = buildCorporateActionObservationRecord({ store, record: { schemaVersion: CA.OBSERVATION_RECORD, observationCoreId: obs1.observationCoreId, observedAt: '2026-01-08T12:01:00.000Z', executionIdentity: EXEC } });
  const revision1 = buildCorporateActionRevision({ store, revision: { schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId, eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null }, participantCoreIds: [participant.participantCoreId], revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null, ...UTC('2026-01-08T13:00:00.000Z') } });
  const revision2 = buildCorporateActionRevision({ store, revision: { schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId, eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '3', denominator: '1' }, cashAmount: null }, participantCoreIds: [participant.participantCoreId], revisionDisposition: 'ASSERTED', revisionReasonCode: 'ECONOMIC_CORRECTION', supersedesRevisionId: revision1.revisionCoreId, ...UTC('2026-01-15T13:00:00.000Z') } });
  const adjudication1 = buildCorporateActionAdjudication({ store, adjudication: { schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId, selectedRevisionId: revision1.revisionCoreId, adjudicationPolicyId: policies.adjudicationPolicy.policyId, confidence: 'CONFIRMED', decisionReasonCodes: [], consideredObservationIds: [obs1.observationCoreId], acceptedObservationIds: [obs1.observationCoreId], rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null, ...UTC('2026-01-08T14:00:00.000Z') } });
  const adjudication2 = buildCorporateActionAdjudication({ store, adjudication: { schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId, selectedRevisionId: revision2.revisionCoreId, adjudicationPolicyId: policies.adjudicationPolicy.policyId, confidence: 'CONFIRMED', decisionReasonCodes: ['ECONOMIC_CORRECTION_APPROVED'], consideredObservationIds: [obs1.observationCoreId, obs2.observationCoreId].sort(), acceptedObservationIds: [obs2.observationCoreId], rejectedObservationIds: [obs1.observationCoreId], conflictObservationIds: [], supersedesAdjudicationId: adjudication1.adjudicationCoreId, ...UTC('2026-01-15T14:00:00.000Z') } });
  const event = buildCorporateActionEventManifest({ store, corporateActionIdentityId: identity.corporateActionIdentityId, observationCoreIds: [obs1.observationCoreId, obs2.observationCoreId], observationRecordIds: [record.observationRecordId], sourcePayloadIds: [payload.sourcePayloadId], sourceAttestationIds: [attestation.sourceAttestationId], providerBindingCoreIds: [], participantCoreIds: [participant.participantCoreId], revisionCoreIds: [revision1.revisionCoreId, revision2.revisionCoreId], adjudicationCoreIds: [adjudication1.adjudicationCoreId, adjudication2.adjudicationCoreId], supersedesEventManifestId: null });
  const ledger = buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: instrument.instrumentIdentityId, eventManifestIds: [event.eventManifestId], supersedesLedgerManifestId: null });
  const registry = buildCorporateActionRegistry({ store, ...registryArgs(policies, instrumentRegistry, [ledger.ledgerManifestId]) });
  return { instrument, instrumentRegistry, policies, identity, participant, payload, attestation, obs1, obs2, record, revision1, revision2, adjudication1, adjudication2, event, ledger, registry };
}

test('L2C-B2 — corporate-action identity is deterministic and rejects ticker-like seeds', () => withStore((store) => {
  const { policies } = setup(store); const a = buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'a'.repeat(64) });
  const b = buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'a'.repeat(64) });
  assert.equal(a.corporateActionIdentityId, b.corporateActionIdentityId);
  assert.throws(() => buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'APLD' }), (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID');
  assert.throws(() => buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'A'.repeat(64) }), (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID');
}));

test('L2C-TZ — DATE_ONLY bounds are CAS-authoritative and environment-independent', () => withStore((store) => {
  const rules = buildTimeZoneRuleset({ store, ruleset: { schemaVersion: CA.TIMEZONE, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', zoneId: 'America/Toronto/synthetic', validFromDate: '2026-01-10', validToDateExclusive: '2026-01-12', civilDateBounds: [
    { civilDate: '2026-01-10', startUtc: '2026-01-10T05:00:00.000Z', endUtcExclusive: '2026-01-11T05:00:00.000Z' },
    { civilDate: '2026-01-11', startUtc: '2026-01-11T05:00:00.000Z', endUtcExclusive: '2026-01-12T05:00:00.000Z' },
  ] } });
  assert.match(rules.timeZoneRulesetId, /^sha256:/);
  const src = readFileSync(new URL('../src/data/corporateActionBuildersCore.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bIntl\b|\bTemporal\b/);
}));

test('L2C-PROV — embedded payload round-trips and secret-bearing payload fails closed', () => withStore((store) => {
  const p = buildCorporateActionSourcePayload({ store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain', payloadValue: 'synthetic notice' });
  assert.equal(verifyCorporateActionSourcePayload({ store, sourcePayloadId: p.sourcePayloadId }).sourcePayload.payloadValue, 'synthetic notice');
  assert.throws(() => buildCorporateActionSourcePayload({ store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain', payloadValue: 'Authorization: Bearer abc' }), (e) => code(e) === 'CORPORATE_ACTION_PROVENANCE_SECRET_FORBIDDEN');
}));

test('L2C-PROV-DIGEST — digest-only attestation never claims payload recovery', () => withStore((store) => {
  setup(store);
  const attestation = buildCorporateActionSourceAttestation({ store, attestation: { schemaVersion: CA.ATTESTATION,
    provenanceMode: 'DIGEST_ONLY_ATTESTATION', embeddedPayloadId: null, digestAlgorithm: 'SHA256', payloadDigest: 'f'.repeat(64),
    payloadByteLength: 123, sourceKind: 'SYNTHETIC_NOTICE', providerId: 'synthetic-provider', observedAt: '2026-01-08T12:00:00.000Z',
    ...UTC('2026-01-08T12:00:00.000Z') } });
  assert.equal(attestation.sourceAttestation.embeddedPayloadId, null);
  assert.equal(attestation.sourceAttestation.payloadDigest, 'f'.repeat(64));
}));

test('L2C-DATE-ONLY — observation requires a matching temporal attestation', () => withStore((store) => {
  const { policies } = setup(store);
  const ruleset = buildTimeZoneRuleset({ store, ruleset: { schemaVersion: CA.TIMEZONE, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', zoneId: 'Synthetic/Eastern', validFromDate: '2026-01-10', validToDateExclusive: '2026-01-11', civilDateBounds: [
    { civilDate: '2026-01-10', startUtc: '2026-01-10T05:00:00.000Z', endUtcExclusive: '2026-01-11T05:00:00.000Z' },
  ] } });
  const identity = buildCorporateActionIdentity({ store, authorityPolicyId: policies.authorityPolicy.policyId, corporateActionSeed: 'b'.repeat(64) });
  const temporal = { temporalPrecision: 'DATE_ONLY', availableOn: '2026-01-10', sourceTimeZone: 'Synthetic/Eastern', timeZoneRulesetId: ruleset.timeZoneRulesetId, knowledgeTimeLowerBound: '2026-01-10T05:00:00.000Z', knowledgeTimeUpperBound: '2026-01-11T05:00:00.000Z' };
  const attestation = buildCorporateActionSourceAttestation({ store, attestation: { schemaVersion: CA.ATTESTATION, provenanceMode: 'DIGEST_ONLY_ATTESTATION', embeddedPayloadId: null, digestAlgorithm: 'SHA256', payloadDigest: 'e'.repeat(64), payloadByteLength: 1, sourceKind: 'SYNTHETIC_NOTICE', providerId: 'synthetic-provider', observedAt: '2026-01-10T12:00:00.000Z', ...temporal } });
  const claim = { eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null } };
  const observation = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId, normalizationPolicyId: policies.normalizationPolicy.policyId, sourceAttestationId: attestation.sourceAttestationId, claim, ...temporal } });
  assert.match(observation.observationCoreId, /^sha256:/);
  assert.throws(() => buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId, normalizationPolicyId: policies.normalizationPolicy.policyId, sourceAttestationId: null, claim, ...temporal } }), (e) => code(e) === 'CORPORATE_ACTION_TEMPORAL_ATTESTATION_REQUIRED');
}));

test('L2C-ASOF — future correction cannot leak (2:1 then 3:1)', () => withStore((store) => {
  const g = completeSplitGraph(store); const resolve = (cutoff) => resolveCorporateActionsAsOf({ store, registryManifestId: g.registry.registryManifestId, instrumentIdentityId: g.instrument.instrumentIdentityId, economicRange: null, knowledgeCutoff: cutoff }).results[0];
  assert.deepEqual(resolve('2026-01-09T23:59:59.999Z').revision.economicPayload.ratio, { numerator: '2', denominator: '1' });
  assert.deepEqual(resolve('2026-01-12T23:59:59.999Z').revision.economicPayload.ratio, { numerator: '2', denominator: '1' });
  assert.deepEqual(resolve('2026-01-16T00:00:00.000Z').revision.economicPayload.ratio, { numerator: '3', denominator: '1' });
  assert.throws(() => resolveCorporateActionsAsOf({ store, registryManifestId: g.registry.registryManifestId }), (e) => code(e) === 'CORPORATE_ACTION_KNOWLEDGE_CUTOFF_REQUIRED');
}));

test('L2C-RECOVERY — registry ID recovers the complete authoritative graph', () => withStore((store) => {
  const g = completeSplitGraph(store); const recovered = recoverCorporateActionRegistry({ store, registryManifestId: g.registry.registryManifestId });
  assert.equal(recovered.eventTips.get(g.identity.corporateActionIdentityId).payloads[0].sourcePayload.payloadValue.synthetic, true);
  assert.equal(recovered.instrumentRegistry.registryManifestId, g.instrumentRegistry.registryManifestId);
}));

test('L2C-APPEND — event, ledger and registry removals are refused', () => withStore((store) => {
  const g = completeSplitGraph(store);
  assert.throws(() => buildCorporateActionEventManifest({ store, corporateActionIdentityId: g.identity.corporateActionIdentityId, observationCoreIds: [], observationRecordIds: [g.record.observationRecordId], sourcePayloadIds: [g.payload.sourcePayloadId], sourceAttestationIds: [g.attestation.sourceAttestationId], providerBindingCoreIds: [], participantCoreIds: [g.participant.participantCoreId], revisionCoreIds: [g.revision1.revisionCoreId, g.revision2.revisionCoreId], adjudicationCoreIds: [g.adjudication1.adjudicationCoreId, g.adjudication2.adjudicationCoreId], supersedesEventManifestId: g.event.eventManifestId }), (e) => code(e) === 'CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION');
  assert.throws(() => buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: g.instrument.instrumentIdentityId, eventManifestIds: [], supersedesLedgerManifestId: g.ledger.ledgerManifestId }), (e) => code(e) === 'CORPORATE_ACTION_LEDGER_APPEND_ONLY_VIOLATION');
}));

test('L2C-REVISION — two children of one revision are a detected branch', () => withStore((store) => {
  const g = completeSplitGraph(store);
  const branch = buildCorporateActionRevision({ store, revision: { ...g.revision2.revisionCore, economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '4', denominator: '1' }, cashAmount: null }, knowledgeTimeLowerBound: '2026-01-16T13:00:00.000Z', knowledgeTimeUpperBound: '2026-01-16T13:00:00.000Z' } });
  assert.throws(() => buildCorporateActionEventManifest({ store, corporateActionIdentityId: g.identity.corporateActionIdentityId, observationCoreIds: [g.obs1.observationCoreId, g.obs2.observationCoreId], observationRecordIds: [g.record.observationRecordId], sourcePayloadIds: [g.payload.sourcePayloadId], sourceAttestationIds: [g.attestation.sourceAttestationId], providerBindingCoreIds: [], participantCoreIds: [g.participant.participantCoreId], revisionCoreIds: [g.revision1.revisionCoreId, g.revision2.revisionCoreId, branch.revisionCoreId], adjudicationCoreIds: [g.adjudication1.adjudicationCoreId, g.adjudication2.adjudicationCoreId], supersedesEventManifestId: g.event.eventManifestId }), (e) => code(e) === 'CORPORATE_ACTION_REVISION_BRANCH');
}));

test('L2C-OBS — a newly visible observation cannot be silently ignored', () => withStore((store) => {
  const g = completeSplitGraph(store);
  const obs3 = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: g.identity.corporateActionIdentityId, normalizationPolicyId: g.policies.normalizationPolicy.policyId, sourceAttestationId: null, claim: { eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '3', denominator: '1' }, cashAmount: null } }, ...UTC('2026-01-17T12:00:00.000Z') } });
  const event2 = buildCorporateActionEventManifest({ store, corporateActionIdentityId: g.identity.corporateActionIdentityId, observationCoreIds: [g.obs1.observationCoreId, g.obs2.observationCoreId, obs3.observationCoreId], observationRecordIds: [g.record.observationRecordId], sourcePayloadIds: [g.payload.sourcePayloadId], sourceAttestationIds: [g.attestation.sourceAttestationId], providerBindingCoreIds: [], participantCoreIds: [g.participant.participantCoreId], revisionCoreIds: [g.revision1.revisionCoreId, g.revision2.revisionCoreId], adjudicationCoreIds: [g.adjudication1.adjudicationCoreId, g.adjudication2.adjudicationCoreId], supersedesEventManifestId: g.event.eventManifestId });
  const ledger2 = buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: g.instrument.instrumentIdentityId, eventManifestIds: [g.event.eventManifestId, event2.eventManifestId], supersedesLedgerManifestId: g.ledger.ledgerManifestId });
  const registry2 = buildCorporateActionRegistry({ store, ...registryArgs(g.policies, g.instrumentRegistry, [g.ledger.ledgerManifestId, ledger2.ledgerManifestId], g.registry.registryManifestId) });
  assert.throws(() => resolveCorporateActionsAsOf({ store, registryManifestId: registry2.registryManifestId, knowledgeCutoff: '2026-01-18T00:00:00.000Z' }), (e) => code(e) === 'CORPORATE_ACTION_NEW_OBSERVATION_UNADJUDICATED');
}));

test('L2C-CANCEL — append-only cancellation resolves explicitly as CANCELLED', () => withStore((store) => {
  const g = completeSplitGraph(store);
  const cancellation = buildCorporateActionRevision({ store, revision: { ...g.revision2.revisionCore, revisionDisposition: 'CANCELS_EVENT', revisionReasonCode: 'CANCELLATION', supersedesRevisionId: g.revision2.revisionCoreId, knowledgeTimeLowerBound: '2026-01-18T13:00:00.000Z', knowledgeTimeUpperBound: '2026-01-18T13:00:00.000Z' } });
  const adjudication3 = buildCorporateActionAdjudication({ store, adjudication: { ...g.adjudication2.adjudicationCore, selectedRevisionId: cancellation.revisionCoreId, decisionReasonCodes: ['CANCELLATION_APPROVED'], supersedesAdjudicationId: g.adjudication2.adjudicationCoreId, knowledgeTimeLowerBound: '2026-01-18T14:00:00.000Z', knowledgeTimeUpperBound: '2026-01-18T14:00:00.000Z' } });
  const event2 = buildCorporateActionEventManifest({ store, corporateActionIdentityId: g.identity.corporateActionIdentityId, observationCoreIds: [g.obs1.observationCoreId, g.obs2.observationCoreId], observationRecordIds: [g.record.observationRecordId], sourcePayloadIds: [g.payload.sourcePayloadId], sourceAttestationIds: [g.attestation.sourceAttestationId], providerBindingCoreIds: [], participantCoreIds: [g.participant.participantCoreId], revisionCoreIds: [g.revision1.revisionCoreId, g.revision2.revisionCoreId, cancellation.revisionCoreId], adjudicationCoreIds: [g.adjudication1.adjudicationCoreId, g.adjudication2.adjudicationCoreId, adjudication3.adjudicationCoreId], supersedesEventManifestId: g.event.eventManifestId });
  const ledger2 = buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: g.instrument.instrumentIdentityId, eventManifestIds: [g.event.eventManifestId, event2.eventManifestId], supersedesLedgerManifestId: g.ledger.ledgerManifestId });
  const registry2 = buildCorporateActionRegistry({ store, ...registryArgs(g.policies, g.instrumentRegistry, [g.ledger.ledgerManifestId, ledger2.ledgerManifestId], g.registry.registryManifestId) });
  const result = resolveCorporateActionsAsOf({ store, registryManifestId: registry2.registryManifestId, knowledgeCutoff: '2026-01-19T00:00:00.000Z' }).results[0];
  assert.equal(result.status, 'CANCELLED');
}));

test('L2C-LEDGER — every merger participant requires an authoritative ledger', () => withStore((store) => {
  const base = setup(store);
  const acquirer = buildInstrumentIdentity({ store, authorityPolicyId: base.instrumentAuthority.authorityPolicyId, identitySeed: '2'.repeat(64), instrumentKind: 'EQUITY' });
  const acquirerManifest = buildInstrumentIdentityManifest({ store, instrumentIdentityId: acquirer.instrumentIdentityId, aliasBindingCoreIds: [] });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store,
    authorityPolicyId: base.instrumentAuthority.authorityPolicyId,
    identityManifestIds: [base.instrumentManifest.identityManifestId, acquirerManifest.identityManifestId],
    supersedesRegistryManifestId: base.instrumentRegistry.registryManifestId,
  });
  const identity = buildCorporateActionIdentity({ store, authorityPolicyId: base.policies.authorityPolicy.policyId, corporateActionSeed: 'c'.repeat(64) });
  const target = buildCorporateActionParticipant({ store, participant: { schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId, instrumentIdentityId: base.instrument.instrumentIdentityId, participantRole: 'TARGET', validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null } });
  const buyer = buildCorporateActionParticipant({ store, participant: { schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId, instrumentIdentityId: acquirer.instrumentIdentityId, participantRole: 'ACQUIRER', validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null } });
  const economicPayload = { effectiveDate: '2026-02-01', ratio: null, cashAmount: { amountAtoms: '1250', scale: 2, currency: 'USD' } };
  const observation = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId, normalizationPolicyId: base.policies.normalizationPolicy.policyId, sourceAttestationId: null, claim: { eventKind: 'MERGER_CASH', economicPayload }, ...UTC('2026-01-20T12:00:00.000Z') } });
  const revision = buildCorporateActionRevision({ store, revision: { schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId, eventKind: 'MERGER_CASH', economicPayload, participantCoreIds: [target.participantCoreId, buyer.participantCoreId].sort(), revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null, ...UTC('2026-01-20T13:00:00.000Z') } });
  const adjudication = buildCorporateActionAdjudication({ store, adjudication: { schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId, selectedRevisionId: revision.revisionCoreId, adjudicationPolicyId: base.policies.adjudicationPolicy.policyId, confidence: 'CONFIRMED', decisionReasonCodes: [], consideredObservationIds: [observation.observationCoreId], acceptedObservationIds: [observation.observationCoreId], rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null, ...UTC('2026-01-20T14:00:00.000Z') } });
  const event = buildCorporateActionEventManifest({ store, corporateActionIdentityId: identity.corporateActionIdentityId, observationCoreIds: [observation.observationCoreId], observationRecordIds: [], sourcePayloadIds: [], sourceAttestationIds: [], providerBindingCoreIds: [], participantCoreIds: [target.participantCoreId, buyer.participantCoreId], revisionCoreIds: [revision.revisionCoreId], adjudicationCoreIds: [adjudication.adjudicationCoreId], supersedesEventManifestId: null });
  const targetLedger = buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: base.instrument.instrumentIdentityId, eventManifestIds: [event.eventManifestId], supersedesLedgerManifestId: null });
  assert.throws(() => buildCorporateActionRegistry({ store, ...registryArgs(base.policies, instrumentRegistry, [targetLedger.ledgerManifestId]) }), (e) => code(e) === 'CORPORATE_ACTION_PARTICIPANT_LEDGER_MISSING');
}));

test('L2C-PROVIDER — overlapping provider event IDs cannot bind two identities', () => withStore((store) => {
  const g = completeSplitGraph(store);
  const bindingA = buildProviderCorporateActionBinding({ store, binding: { schemaVersion: CA.PROVIDER_BINDING, providerId: 'synthetic-provider', providerEventId: 'event-42', corporateActionIdentityId: g.identity.corporateActionIdentityId, validFrom: '2026-01-01T00:00:00.000Z', validToExclusive: null } });
  const eventA2 = buildCorporateActionEventManifest({ store, corporateActionIdentityId: g.identity.corporateActionIdentityId, observationCoreIds: [g.obs1.observationCoreId, g.obs2.observationCoreId], observationRecordIds: [g.record.observationRecordId], sourcePayloadIds: [g.payload.sourcePayloadId], sourceAttestationIds: [g.attestation.sourceAttestationId], providerBindingCoreIds: [bindingA.providerBindingCoreId], participantCoreIds: [g.participant.participantCoreId], revisionCoreIds: [g.revision1.revisionCoreId, g.revision2.revisionCoreId], adjudicationCoreIds: [g.adjudication1.adjudicationCoreId, g.adjudication2.adjudicationCoreId], supersedesEventManifestId: g.event.eventManifestId });
  const identityB = buildCorporateActionIdentity({ store, authorityPolicyId: g.policies.authorityPolicy.policyId, corporateActionSeed: 'd'.repeat(64) });
  const participantB = buildCorporateActionParticipant({ store, participant: { schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identityB.corporateActionIdentityId, instrumentIdentityId: g.instrument.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT', validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null } });
  const observationB = buildCorporateActionObservation({ store, observation: { schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identityB.corporateActionIdentityId, normalizationPolicyId: g.policies.normalizationPolicy.policyId, sourceAttestationId: null, claim: { eventKind: 'FORWARD_SPLIT', economicPayload: { effectiveDate: '2026-02-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null } }, ...UTC('2026-01-21T12:00:00.000Z') } });
  const revisionB = buildCorporateActionRevision({ store, revision: { schemaVersion: CA.REVISION, corporateActionIdentityId: identityB.corporateActionIdentityId, eventKind: 'FORWARD_SPLIT', economicPayload: observationB.observationCore.claim.economicPayload, participantCoreIds: [participantB.participantCoreId], revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null, ...UTC('2026-01-21T13:00:00.000Z') } });
  const adjudicationB = buildCorporateActionAdjudication({ store, adjudication: { schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identityB.corporateActionIdentityId, selectedRevisionId: revisionB.revisionCoreId, adjudicationPolicyId: g.policies.adjudicationPolicy.policyId, confidence: 'CONFIRMED', decisionReasonCodes: [], consideredObservationIds: [observationB.observationCoreId], acceptedObservationIds: [observationB.observationCoreId], rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null, ...UTC('2026-01-21T14:00:00.000Z') } });
  const bindingB = buildProviderCorporateActionBinding({ store, binding: { schemaVersion: CA.PROVIDER_BINDING, providerId: 'synthetic-provider', providerEventId: 'event-42', corporateActionIdentityId: identityB.corporateActionIdentityId, validFrom: '2026-01-15T00:00:00.000Z', validToExclusive: null } });
  const eventB = buildCorporateActionEventManifest({ store, corporateActionIdentityId: identityB.corporateActionIdentityId, observationCoreIds: [observationB.observationCoreId], observationRecordIds: [], sourcePayloadIds: [], sourceAttestationIds: [], providerBindingCoreIds: [bindingB.providerBindingCoreId], participantCoreIds: [participantB.participantCoreId], revisionCoreIds: [revisionB.revisionCoreId], adjudicationCoreIds: [adjudicationB.adjudicationCoreId], supersedesEventManifestId: null });
  const ledger2 = buildInstrumentCorporateActionLedger({ store, instrumentIdentityId: g.instrument.instrumentIdentityId, eventManifestIds: [g.event.eventManifestId, eventA2.eventManifestId, eventB.eventManifestId], supersedesLedgerManifestId: g.ledger.ledgerManifestId });
  assert.throws(() => buildCorporateActionRegistry({ store, ...registryArgs(g.policies, g.instrumentRegistry, [g.ledger.ledgerManifestId, ledger2.ledgerManifestId], g.registry.registryManifestId) }), (e) => code(e) === 'CORPORATE_ACTION_PROVIDER_BINDING_CONFLICT');
}));

test('L2C-PLANS — RAW stays unchanged; split plans and entitlements remain separate', () => withStore((store) => {
  const g = completeSplitGraph(store); const args = { store, registryManifestId: g.registry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z', instrumentIdentityId: g.instrument.instrumentIdentityId, economicRange: null };
  const raw = buildCorporateActionPriceAdjustmentPlan({ ...args, priceBasis: 'RAW', providerAdjustmentDeclaration: null });
  const split = buildCorporateActionPriceAdjustmentPlan({ ...args, priceBasis: 'SPLIT_ADJUSTED', providerAdjustmentDeclaration: null });
  const entitlement = buildCorporateActionEntitlementPlan(args);
  assert.deepEqual(raw.priceAdjustmentPlan.adjustments, []);
  assert.deepEqual(split.priceAdjustmentPlan.adjustments[0].ohlcFactor, { numerator: '1', denominator: '3' });
  assert.equal(entitlement.entitlementPlan.entitlements[0].entitlementKind, 'QUANTITY');
}));

test('L2C-PROVIDER-PLAN — inconsistent provider declaration fails closed', () => withStore((store) => {
  const g = completeSplitGraph(store); const args = { store, registryManifestId: g.registry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z', instrumentIdentityId: g.instrument.instrumentIdentityId, economicRange: null, priceBasis: 'PROVIDER_ADJUSTED' };
  assert.throws(() => buildCorporateActionPriceAdjustmentPlan({ ...args, providerAdjustmentDeclaration: null }), (e) => code(e) === 'CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK');
  assert.throws(() => buildCorporateActionPriceAdjustmentPlan({ ...args, providerAdjustmentDeclaration: { providerId: 'synthetic-provider', splitsIncluded: true, dividendsIncluded: false, volumeAdjusted: true, retroactiveCorrectionsPossible: true, providerCutoff: '2026-01-17T00:00:00.000Z', providerPolicyId: g.policies.priceAdjustmentPolicy.policyId } }), (e) => code(e) === 'CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK');
}));

test('L2C-BIND — snapshot binding is coherent and recoverable by ID', () => withStore((store) => {
  const g = completeSplitGraph(store); const snapshot = buildSyntheticSnapshot(store);
  const args = { store, registryManifestId: g.registry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z', instrumentIdentityId: g.instrument.instrumentIdentityId, economicRange: null };
  const price = buildCorporateActionPriceAdjustmentPlan({ ...args, priceBasis: 'SPLIT_ADJUSTED', providerAdjustmentDeclaration: null });
  const entitlement = buildCorporateActionEntitlementPlan(args); const events = [g.identity.corporateActionIdentityId];
  const binding = buildDatasetSnapshotCorporateActionBinding({ store, snapshotCoreId: snapshot.built.snapshotCore.objectId, registryManifestId: g.registry.registryManifestId, priceAdjustmentPlanId: price.priceAdjustmentPlanId, entitlementPlanId: entitlement.entitlementPlanId, knowledgeCutoff: args.knowledgeCutoff, influencingEventIds: events });
  const authority = buildDatasetSnapshotCorporateActionBindingAuthorityPolicy({ store, authorityId: 'l2c-binding-authority/1', registryNamespaceVersion: '1' });
  const bindingRegistry = buildDatasetSnapshotCorporateActionBindingRegistry({
    store,
    bindingAuthorityPolicyId: authority.bindingAuthorityPolicyId,
    bindingIds: [binding.snapshotCorporateActionBindingId],
    supersedesBindingRegistryManifestId: null,
  });
  const resolved = resolveDatasetSnapshotCorporateActionBinding({
    store,
    bindingRegistryManifestId: bindingRegistry.bindingRegistryManifestId,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
  });
  assert.equal(resolved.snapshotCorporateActionBinding.registryManifestId, g.registry.registryManifestId);
  const planManifest = buildCorporateActionPlanManifest({ store, registryManifestId: g.registry.registryManifestId, knowledgeCutoff: args.knowledgeCutoff, priceAdjustmentPlanIds: [price.priceAdjustmentPlanId], entitlementPlanIds: [entitlement.entitlementPlanId], supersedesPlanManifestId: null });
  assert.match(planManifest.planManifestId, /^sha256:/);
}));

test('L2C-CLOSED — public APIs reject invalid/free-collection inputs without TypeError', () => withStore((store) => {
  for (const bad of [undefined, null, {}]) assert.throws(() => resolveCorporateActionsAsOf(bad), (e) => e instanceof CorporateActionError);
  assert.throws(() => resolveCorporateActionsAsOf({ store, registryManifestId: 'sha256:' + '0'.repeat(64), knowledgeCutoff: '2026-01-01T00:00:00.000Z', ledgerIds: [] }), (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID');
  assert.throws(() => resolveDatasetSnapshotCorporateActionBinding({ store, bindingRegistryManifestId: 'sha256:' + '0'.repeat(64), snapshotCoreId: 'sha256:' + '1'.repeat(64), bindingIds: [] }), (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID');
}));

test('L2C-CAS — every schema is content-addressed by canonical bytes', () => withStore((store) => {
  const { policies } = setup(store); const p = policies.authorityPolicy.policy;
  assert.equal(corporateActionObjectId(CA.AUTHORITY, p), policies.authorityPolicy.policyId);
}));
