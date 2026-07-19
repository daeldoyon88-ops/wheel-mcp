/**
 * L2C-R1 — authoritative L2B pin, binding registry, explicit reclassification,
 * exact role cardinality, honest provenance limits (synthetic fixtures only).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CA } from '../src/contracts/corporateActionL2CV1.mjs';
import {
  buildInstrumentAliasBinding, buildInstrumentIdentity, buildInstrumentIdentityAuthorityPolicy,
  buildInstrumentIdentityManifest, buildInstrumentIdentityRegistry, buildSymbolNamespacePolicy,
} from '../src/data/buildInstrumentIdentity.mjs';
import {
  buildCorporateActionAdjudication, buildCorporateActionEventManifest, buildCorporateActionIdentity,
  buildCorporateActionObservation, buildCorporateActionPolicies, buildCorporateActionPriceAdjustmentPlan,
  buildCorporateActionRegistry, buildCorporateActionRevision, buildCorporateActionSourcePayload,
  buildCorporateActionParticipant, buildDatasetSnapshotCorporateActionBinding,
  buildDatasetSnapshotCorporateActionBindingAuthorityPolicy,
  buildDatasetSnapshotCorporateActionBindingRegistry, buildInstrumentCorporateActionLedger,
  recoverCorporateActionRegistry, recoverDatasetSnapshotCorporateActionBindingRegistry,
  resolveCorporateActionsAsOf, resolveDatasetSnapshotCorporateActionBinding,
  verifyCorporateActionRegistry, verifyDatasetSnapshotCorporateActionBinding,
} from '../src/data/buildCorporateAction.mjs';
import { buildSyntheticSnapshot, withStore } from './l2aSyntheticPipeline.mjs';

const UTC = (instant) => ({
  temporalPrecision: 'UTC_INSTANT', availableOn: null, sourceTimeZone: null,
  timeZoneRulesetId: null, knowledgeTimeLowerBound: instant, knowledgeTimeUpperBound: instant,
});

function code(error) { return error?.code; }

function policies(store, kinds = ['FORWARD_SPLIT', 'CASH_DIVIDEND_ORDINARY', 'MERGER_CASH', 'SPIN_OFF', 'SYMBOL_CHANGE']) {
  return buildCorporateActionPolicies({
    store,
    authorityPolicy: {
      schemaVersion: CA.AUTHORITY, authorityId: 'l2c-r1-actions/1', identityNamespaceVersion: 'B2/1',
      eventSeedFormat: 'HEX_LOWERCASE', eventSeedLength: 64,
    },
    normalizationPolicy: {
      schemaVersion: CA.NORMALIZATION, normalizationVersion: 'r1/1',
      supportedEventKinds: [...kinds].sort(), currencyCodes: ['USD'],
    },
    temporalPolicy: {
      schemaVersion: CA.TEMPORAL, temporalPolicyVersion: 'r1/1',
      dateOnlyLowerBoundMode: 'START_UTC', maxRulesetDays: 366,
    },
    adjudicationPolicy: {
      schemaVersion: CA.ADJUDICATION_POLICY, adjudicationPolicyVersion: 'r1/1',
      requireAllVisibleObservations: true, allowContested: true,
    },
    priceAdjustmentPolicy: {
      schemaVersion: CA.PRICE_POLICY, policyVersion: 'r1/1',
      supportedPriceBases: ['RAW', 'SPLIT_ADJUSTED'],
    },
    entitlementPolicy: {
      schemaVersion: CA.ENTITLEMENT_POLICY, policyVersion: 'r1/1',
      roundingRule: 'EXACT_ONLY', fractionalShareRule: 'FAIL_CLOSED',
    },
  });
}

function publishInstrument(store, seed = '1'.repeat(64)) {
  const authority = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l2c-r1-instruments/1', identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const instrument = buildInstrumentIdentity({
    store, authorityPolicyId: authority.authorityPolicyId, identitySeed: seed, instrumentKind: 'EQUITY',
  });
  return { authority, instrument };
}

function registerInstruments(store, authorityPolicyId, instruments, supersedes = null) {
  const manifests = instruments.map((instrument) => buildInstrumentIdentityManifest({
    store, instrumentIdentityId: instrument.instrumentIdentityId, aliasBindingCoreIds: [],
  }));
  return buildInstrumentIdentityRegistry({
    store,
    authorityPolicyId,
    identityManifestIds: manifests.map((m) => m.identityManifestId),
    supersedesRegistryManifestId: supersedes,
  });
}

function registryInput(p, instrumentRegistry, ledgers, supersedes = null) {
  return {
    authorityPolicyId: p.authorityPolicy.policyId,
    normalizationPolicyId: p.normalizationPolicy.policyId,
    temporalPolicyId: p.temporalPolicy.policyId,
    adjudicationPolicyId: p.adjudicationPolicy.policyId,
    priceAdjustmentPolicyId: p.priceAdjustmentPolicy.policyId,
    entitlementPolicyId: p.entitlementPolicy.policyId,
    instrumentIdentityRegistryManifestId: instrumentRegistry.registryManifestId,
    instrumentLedgerManifestIds: ledgers,
    supersedesRegistryManifestId: supersedes,
  };
}

function publishSplitEvent(store, p, instrument, seed, ratio = { numerator: '2', denominator: '1' }, at = '2026-01-08T12:00:00.000Z') {
  const identity = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: seed,
  });
  const participant = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT,
      corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: instrument.instrumentIdentityId,
      participantRole: 'PRIMARY_SUBJECT',
      validFrom: '2020-01-01T00:00:00.000Z',
      validToExclusive: null,
    },
  });
  const economicPayload = { effectiveDate: '2026-01-10', ratio, cashAmount: null };
  const observation = buildCorporateActionObservation({
    store,
    observation: {
      schemaVersion: CA.OBSERVATION,
      corporateActionIdentityId: identity.corporateActionIdentityId,
      normalizationPolicyId: p.normalizationPolicy.policyId,
      sourceAttestationId: null,
      claim: { eventKind: 'FORWARD_SPLIT', economicPayload },
      ...UTC(at),
    },
  });
  const revision = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION,
      corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'FORWARD_SPLIT',
      economicPayload,
      participantCoreIds: [participant.participantCoreId],
      revisionDisposition: 'ASSERTED',
      revisionReasonCode: 'INITIAL_ASSERTION',
      supersedesRevisionId: null,
      ...UTC(at.replace('12:', '13:')),
    },
  });
  const adjudication = buildCorporateActionAdjudication({
    store,
    adjudication: {
      schemaVersion: CA.ADJUDICATION,
      corporateActionIdentityId: identity.corporateActionIdentityId,
      selectedRevisionId: revision.revisionCoreId,
      adjudicationPolicyId: p.adjudicationPolicy.policyId,
      confidence: 'CONFIRMED',
      decisionReasonCodes: [],
      consideredObservationIds: [observation.observationCoreId],
      acceptedObservationIds: [observation.observationCoreId],
      rejectedObservationIds: [],
      conflictObservationIds: [],
      supersedesAdjudicationId: null,
      ...UTC(at.replace('12:', '14:')),
    },
  });
  const event = buildCorporateActionEventManifest({
    store,
    corporateActionIdentityId: identity.corporateActionIdentityId,
    observationCoreIds: [observation.observationCoreId],
    observationRecordIds: [],
    sourcePayloadIds: [],
    sourceAttestationIds: [],
    providerBindingCoreIds: [],
    participantCoreIds: [participant.participantCoreId],
    revisionCoreIds: [revision.revisionCoreId],
    adjudicationCoreIds: [adjudication.adjudicationCoreId],
    supersedesEventManifestId: null,
  });
  const ledger = buildInstrumentCorporateActionLedger({
    store,
    instrumentIdentityId: instrument.instrumentIdentityId,
    eventManifestIds: [event.eventManifestId],
    supersedesLedgerManifestId: null,
  });
  return { identity, participant, observation, revision, adjudication, event, ledger };
}

// ─── L2B authority ───────────────────────────────────────────────────────────

test('L2C-R1-01 — orphan L2B core is refused by L2C registry; registered core is accepted', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const decoy = buildInstrumentIdentity({
    store, authorityPolicyId: authority.authorityPolicyId, identitySeed: '0'.repeat(64), instrumentKind: 'EQUITY',
  });
  // Authoritative L2B registry contains only the decoy — instrument A exists in CAS but is not registered.
  const orphanRegistry = registerInstruments(store, authority.authorityPolicyId, [decoy]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, 'a'.repeat(64));
  assert.throws(
    () => buildCorporateActionRegistry({ store, ...registryInput(p, orphanRegistry, [graph.ledger.ledgerManifestId]) }),
    (e) => code(e) === 'CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
  );
  const authorized = registerInstruments(store, authority.authorityPolicyId, [decoy, instrument], orphanRegistry.registryManifestId);
  const accepted = buildCorporateActionRegistry({ store, ...registryInput(p, authorized, [graph.ledger.ledgerManifestId]) });
  assert.match(accepted.registryManifestId, /^sha256:/);
}));

test('L2C-R1-02 — participant from a foreign L2B registry is refused', () => withStore((store) => {
  const a = publishInstrument(store, '1'.repeat(64));
  const foreignAuth = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l2c-r1-foreign/1', identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const foreign = buildInstrumentIdentity({
    store, authorityPolicyId: foreignAuth.authorityPolicyId, identitySeed: '2'.repeat(64), instrumentKind: 'EQUITY',
  });
  const foreignManifest = buildInstrumentIdentityManifest({
    store, instrumentIdentityId: foreign.instrumentIdentityId, aliasBindingCoreIds: [],
  });
  buildInstrumentIdentityRegistry({
    store, authorityPolicyId: foreignAuth.authorityPolicyId, identityManifestIds: [foreignManifest.identityManifestId],
  });
  const homeRegistry = registerInstruments(store, a.authority.authorityPolicyId, [a.instrument]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, foreign, 'b'.repeat(64));
  assert.throws(
    () => buildCorporateActionRegistry({ store, ...registryInput(p, homeRegistry, [graph.ledger.ledgerManifestId]) }),
    (e) => code(e) === 'CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
  );
}));

test('L2C-R1-03 — missing or corrupt L2B registry fails closed', () => withStore((store) => {
  const { instrument } = publishInstrument(store);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, 'c'.repeat(64));
  assert.throws(
    () => buildCorporateActionRegistry({
      store, ...registryInput(p, { registryManifestId: `sha256:${'0'.repeat(64)}` }, [graph.ledger.ledgerManifestId]),
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
  );
}));

test('L2C-R1-04 — merger fails when one participant is not registered in L2B', () => withStore((store) => {
  const { authority, instrument: targetInst } = publishInstrument(store, '1'.repeat(64));
  const acquirerInst = buildInstrumentIdentity({
    store, authorityPolicyId: authority.authorityPolicyId, identitySeed: '2'.repeat(64), instrumentKind: 'EQUITY',
  });
  const onlyTarget = registerInstruments(store, authority.authorityPolicyId, [targetInst]);
  const p = policies(store, ['MERGER_CASH']);
  const identity = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: 'd'.repeat(64),
  });
  const target = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: targetInst.instrumentIdentityId, participantRole: 'TARGET',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const acquirer = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: acquirerInst.instrumentIdentityId, participantRole: 'ACQUIRER',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const economicPayload = { effectiveDate: '2026-02-01', ratio: null, cashAmount: { amountAtoms: '100', scale: 2, currency: 'USD' } };
  const observation = buildCorporateActionObservation({
    store,
    observation: {
      schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      normalizationPolicyId: p.normalizationPolicy.policyId, sourceAttestationId: null,
      claim: { eventKind: 'MERGER_CASH', economicPayload }, ...UTC('2026-01-20T12:00:00.000Z'),
    },
  });
  const revision = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'MERGER_CASH', economicPayload,
      participantCoreIds: [target.participantCoreId, acquirer.participantCoreId].sort(),
      revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
      ...UTC('2026-01-20T13:00:00.000Z'),
    },
  });
  const adjudication = buildCorporateActionAdjudication({
    store,
    adjudication: {
      schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      selectedRevisionId: revision.revisionCoreId, adjudicationPolicyId: p.adjudicationPolicy.policyId,
      confidence: 'CONFIRMED', decisionReasonCodes: [],
      consideredObservationIds: [observation.observationCoreId], acceptedObservationIds: [observation.observationCoreId],
      rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null,
      ...UTC('2026-01-20T14:00:00.000Z'),
    },
  });
  const event = buildCorporateActionEventManifest({
    store, corporateActionIdentityId: identity.corporateActionIdentityId,
    observationCoreIds: [observation.observationCoreId], observationRecordIds: [], sourcePayloadIds: [],
    sourceAttestationIds: [], providerBindingCoreIds: [],
    participantCoreIds: [target.participantCoreId, acquirer.participantCoreId],
    revisionCoreIds: [revision.revisionCoreId], adjudicationCoreIds: [adjudication.adjudicationCoreId],
    supersedesEventManifestId: null,
  });
  const targetLedger = buildInstrumentCorporateActionLedger({
    store, instrumentIdentityId: targetInst.instrumentIdentityId, eventManifestIds: [event.eventManifestId],
    supersedesLedgerManifestId: null,
  });
  const acquirerLedger = buildInstrumentCorporateActionLedger({
    store, instrumentIdentityId: acquirerInst.instrumentIdentityId, eventManifestIds: [event.eventManifestId],
    supersedesLedgerManifestId: null,
  });
  assert.throws(
    () => buildCorporateActionRegistry({
      store, ...registryInput(p, onlyTarget, [targetLedger.ledgerManifestId, acquirerLedger.ledgerManifestId]),
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
  );
}));

test('L2C-R1-05 — SYMBOL_CHANGE with alias absent from L2B registry is refused', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const ns = buildSymbolNamespacePolicy({
    store, namespaceId: 'l2c-r1-ns', namespaceVersion: 1, providerId: 'synth-r1',
    venuePolicy: 'REQUIRED', casePolicy: 'ASCII_UPPERCASE', currencyPolicy: 'REQUIRED',
    allowedCharacterPolicy: 'ASCII_ALNUM_DOT_DASH_UNDERSCORE',
  });
  const previous = buildInstrumentAliasBinding({
    store, instrumentIdentityId: instrument.instrumentIdentityId, namespacePolicyId: ns.namespacePolicyId,
    venueId: 'XNAS', symbol: 'OLD', currency: 'USD', validFrom: '2020-01-01', validToExclusive: '2026-03-01',
  });
  const next = buildInstrumentAliasBinding({
    store, instrumentIdentityId: instrument.instrumentIdentityId, namespacePolicyId: ns.namespacePolicyId,
    venueId: 'XNAS', symbol: 'NEW', currency: 'USD', validFrom: '2026-03-01', validToExclusive: null,
  });
  // Registry lists identity but omits aliases from the manifest — aliases exist in CAS only.
  const manifest = buildInstrumentIdentityManifest({
    store, instrumentIdentityId: instrument.instrumentIdentityId, aliasBindingCoreIds: [],
  });
  const instrumentRegistry = buildInstrumentIdentityRegistry({
    store, authorityPolicyId: authority.authorityPolicyId, identityManifestIds: [manifest.identityManifestId],
  });
  const p = policies(store, ['SYMBOL_CHANGE']);
  const identity = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: 'e'.repeat(64),
  });
  const participant = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: instrument.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const economicPayload = {
    effectiveDate: '2026-03-01',
    previousAliasBindingCoreId: previous.aliasBindingCoreId,
    nextAliasBindingCoreId: next.aliasBindingCoreId,
  };
  const observation = buildCorporateActionObservation({
    store,
    observation: {
      schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      normalizationPolicyId: p.normalizationPolicy.policyId, sourceAttestationId: null,
      claim: { eventKind: 'SYMBOL_CHANGE', economicPayload }, ...UTC('2026-02-20T12:00:00.000Z'),
    },
  });
  const revision = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'SYMBOL_CHANGE', economicPayload, participantCoreIds: [participant.participantCoreId],
      revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
      ...UTC('2026-02-20T13:00:00.000Z'),
    },
  });
  const adjudication = buildCorporateActionAdjudication({
    store,
    adjudication: {
      schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      selectedRevisionId: revision.revisionCoreId, adjudicationPolicyId: p.adjudicationPolicy.policyId,
      confidence: 'CONFIRMED', decisionReasonCodes: [],
      consideredObservationIds: [observation.observationCoreId], acceptedObservationIds: [observation.observationCoreId],
      rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null,
      ...UTC('2026-02-20T14:00:00.000Z'),
    },
  });
  const event = buildCorporateActionEventManifest({
    store, corporateActionIdentityId: identity.corporateActionIdentityId,
    observationCoreIds: [observation.observationCoreId], observationRecordIds: [], sourcePayloadIds: [],
    sourceAttestationIds: [], providerBindingCoreIds: [], participantCoreIds: [participant.participantCoreId],
    revisionCoreIds: [revision.revisionCoreId], adjudicationCoreIds: [adjudication.adjudicationCoreId],
    supersedesEventManifestId: null,
  });
  const ledger = buildInstrumentCorporateActionLedger({
    store, instrumentIdentityId: instrument.instrumentIdentityId, eventManifestIds: [event.eventManifestId],
    supersedesLedgerManifestId: null,
  });
  assert.throws(
    () => buildCorporateActionRegistry({ store, ...registryInput(p, instrumentRegistry, [ledger.ledgerManifestId]) }),
    (e) => code(e) === 'CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT',
  );
}));

test('L2C-R1-06 — L2C supersession to a foreign L2B registry chain is refused', () => withStore((store) => {
  const home = publishInstrument(store, '1'.repeat(64));
  const homeRegistry = registerInstruments(store, home.authority.authorityPolicyId, [home.instrument]);
  const foreignAuth = buildInstrumentIdentityAuthorityPolicy({
    store, authorityId: 'l2c-r1-foreign-b/1', identitySeedFormat: 'HEX_LOWERCASE', identitySeedLength: 64,
  });
  const foreign = buildInstrumentIdentity({
    store, authorityPolicyId: foreignAuth.authorityPolicyId, identitySeed: '3'.repeat(64), instrumentKind: 'EQUITY',
  });
  const foreignRegistry = registerInstruments(store, foreignAuth.authorityPolicyId, [foreign]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, home.instrument, 'f'.repeat(64));
  const r1 = buildCorporateActionRegistry({ store, ...registryInput(p, homeRegistry, [graph.ledger.ledgerManifestId]) });
  assert.throws(
    () => buildCorporateActionRegistry({
      store, ...registryInput(p, foreignRegistry, [graph.ledger.ledgerManifestId], r1.registryManifestId),
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH',
  );
}));

// ─── Binding registry ────────────────────────────────────────────────────────

test('L2C-R1-07 — authoritative binding registry by ID; raw arrays refused; conflict detected', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const instrumentRegistry = registerInstruments(store, authority.authorityPolicyId, [instrument]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, '11'.repeat(32));
  const caRegistry = buildCorporateActionRegistry({
    store, ...registryInput(p, instrumentRegistry, [graph.ledger.ledgerManifestId]),
  });
  const snapshot = buildSyntheticSnapshot(store);
  const planArgs = {
    store, registryManifestId: caRegistry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z',
    instrumentIdentityId: instrument.instrumentIdentityId, economicRange: null,
  };
  const split = buildCorporateActionPriceAdjustmentPlan({ ...planArgs, priceBasis: 'SPLIT_ADJUSTED', providerAdjustmentDeclaration: null });
  const raw = buildCorporateActionPriceAdjustmentPlan({ ...planArgs, priceBasis: 'RAW', providerAdjustmentDeclaration: null });
  const bindingA = buildDatasetSnapshotCorporateActionBinding({
    store, snapshotCoreId: snapshot.built.snapshotCore.objectId, registryManifestId: caRegistry.registryManifestId,
    priceAdjustmentPlanId: split.priceAdjustmentPlanId, entitlementPlanId: null,
    knowledgeCutoff: planArgs.knowledgeCutoff, influencingEventIds: [graph.identity.corporateActionIdentityId],
  });
  const bindingB = buildDatasetSnapshotCorporateActionBinding({
    store, snapshotCoreId: snapshot.built.snapshotCore.objectId, registryManifestId: caRegistry.registryManifestId,
    priceAdjustmentPlanId: raw.priceAdjustmentPlanId, entitlementPlanId: null,
    knowledgeCutoff: planArgs.knowledgeCutoff, influencingEventIds: [],
  });
  const authorityPolicy = buildDatasetSnapshotCorporateActionBindingAuthorityPolicy({
    store, authorityId: 'l2c-r1-binding/1', registryNamespaceVersion: '1',
  });
  assert.throws(
    () => buildDatasetSnapshotCorporateActionBindingRegistry({
      store,
      bindingAuthorityPolicyId: authorityPolicy.bindingAuthorityPolicyId,
      bindingIds: [bindingA.snapshotCorporateActionBindingId, bindingB.snapshotCorporateActionBindingId],
      supersedesBindingRegistryManifestId: null,
    }),
    (e) => code(e) === 'CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT',
  );
  const registryA = buildDatasetSnapshotCorporateActionBindingRegistry({
    store,
    bindingAuthorityPolicyId: authorityPolicy.bindingAuthorityPolicyId,
    bindingIds: [bindingA.snapshotCorporateActionBindingId],
    supersedesBindingRegistryManifestId: null,
  });
  const otherAuthority = buildDatasetSnapshotCorporateActionBindingAuthorityPolicy({
    store, authorityId: 'l2c-r1-binding/other', registryNamespaceVersion: '1',
  });
  const registryB = buildDatasetSnapshotCorporateActionBindingRegistry({
    store,
    bindingAuthorityPolicyId: otherAuthority.bindingAuthorityPolicyId,
    bindingIds: [bindingB.snapshotCorporateActionBindingId],
    supersedesBindingRegistryManifestId: null,
  });
  const resolved = resolveDatasetSnapshotCorporateActionBinding({
    store,
    bindingRegistryManifestId: registryA.bindingRegistryManifestId,
    snapshotCoreId: snapshot.built.snapshotCore.objectId,
  });
  assert.equal(resolved.snapshotCorporateActionBindingId, bindingA.snapshotCorporateActionBindingId);
  assert.throws(
    () => resolveDatasetSnapshotCorporateActionBinding({
      store,
      bindingRegistryManifestId: registryA.bindingRegistryManifestId,
      snapshotCoreId: snapshot.built.snapshotCore.objectId,
      bindingIds: [bindingA.snapshotCorporateActionBindingId],
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID',
  );
  // Two separate roots may physically exist; consumer pins exactly one.
  assert.notEqual(registryA.bindingRegistryManifestId, registryB.bindingRegistryManifestId);
  verifyDatasetSnapshotCorporateActionBinding({
    store, snapshotCorporateActionBindingId: bindingB.snapshotCorporateActionBindingId,
  });
}));

test('L2C-R1-08 — binding registry append-only, authority match, cycle and ID-only recovery', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const instrumentRegistry = registerInstruments(store, authority.authorityPolicyId, [instrument]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, '22'.repeat(32));
  const caRegistry = buildCorporateActionRegistry({
    store, ...registryInput(p, instrumentRegistry, [graph.ledger.ledgerManifestId]),
  });
  const snapshot = buildSyntheticSnapshot(store);
  const plan = buildCorporateActionPriceAdjustmentPlan({
    store, registryManifestId: caRegistry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z',
    instrumentIdentityId: instrument.instrumentIdentityId, economicRange: null,
    priceBasis: 'SPLIT_ADJUSTED', providerAdjustmentDeclaration: null,
  });
  const binding = buildDatasetSnapshotCorporateActionBinding({
    store, snapshotCoreId: snapshot.built.snapshotCore.objectId, registryManifestId: caRegistry.registryManifestId,
    priceAdjustmentPlanId: plan.priceAdjustmentPlanId, entitlementPlanId: null,
    knowledgeCutoff: '2026-01-16T00:00:00.000Z', influencingEventIds: [graph.identity.corporateActionIdentityId],
  });
  const authorityPolicy = buildDatasetSnapshotCorporateActionBindingAuthorityPolicy({
    store, authorityId: 'l2c-r1-binding-chain/1', registryNamespaceVersion: '1',
  });
  const r1 = buildDatasetSnapshotCorporateActionBindingRegistry({
    store,
    bindingAuthorityPolicyId: authorityPolicy.bindingAuthorityPolicyId,
    bindingIds: [binding.snapshotCorporateActionBindingId],
    supersedesBindingRegistryManifestId: null,
  });
  assert.throws(
    () => buildDatasetSnapshotCorporateActionBindingRegistry({
      store,
      bindingAuthorityPolicyId: authorityPolicy.bindingAuthorityPolicyId,
      bindingIds: [],
      supersedesBindingRegistryManifestId: r1.bindingRegistryManifestId,
    }),
    (e) => code(e) === 'CORPORATE_ACTION_BINDING_REGISTRY_APPEND_ONLY_VIOLATION',
  );
  const foreignAuthority = buildDatasetSnapshotCorporateActionBindingAuthorityPolicy({
    store, authorityId: 'l2c-r1-binding-chain/foreign', registryNamespaceVersion: '1',
  });
  assert.throws(
    () => buildDatasetSnapshotCorporateActionBindingRegistry({
      store,
      bindingAuthorityPolicyId: foreignAuthority.bindingAuthorityPolicyId,
      bindingIds: [binding.snapshotCorporateActionBindingId],
      supersedesBindingRegistryManifestId: r1.bindingRegistryManifestId,
    }),
    (e) => code(e) === 'CORPORATE_ACTION_BINDING_REGISTRY_AUTHORITY_MISMATCH',
  );
  const recovered = recoverDatasetSnapshotCorporateActionBindingRegistry({
    store, bindingRegistryManifestId: r1.bindingRegistryManifestId,
  });
  assert.equal(recovered.bindings[0].snapshotCorporateActionBindingId, binding.snapshotCorporateActionBindingId);
  assert.equal(recovered.bindings[0].registry.registryManifest.instrumentIdentityRegistryManifestId,
    instrumentRegistry.registryManifestId);
}));

// ─── Event kind reclassification ─────────────────────────────────────────────

test('L2C-R1-09 — economic correction, silent kind change, explicit reclassification and cutoffs', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const instrumentRegistry = registerInstruments(store, authority.authorityPolicyId, [instrument]);
  const p = policies(store, ['FORWARD_SPLIT', 'CASH_DIVIDEND_ORDINARY']);
  const identity = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: '33'.repeat(32),
  });
  const participant = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: instrument.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const splitPayload = { effectiveDate: '2026-01-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null };
  const cashPayload = { effectiveDate: '2026-01-10', ratio: null, cashAmount: { amountAtoms: '25', scale: 2, currency: 'USD' } };
  const obs1 = buildCorporateActionObservation({
    store,
    observation: {
      schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      normalizationPolicyId: p.normalizationPolicy.policyId, sourceAttestationId: null,
      claim: { eventKind: 'FORWARD_SPLIT', economicPayload: splitPayload }, ...UTC('2026-01-08T12:00:00.000Z'),
    },
  });
  const revision1 = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'FORWARD_SPLIT', economicPayload: splitPayload, participantCoreIds: [participant.participantCoreId],
      revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
      ...UTC('2026-01-08T13:00:00.000Z'),
    },
  });
  // Silent kind change with ECONOMIC_CORRECTION must fail.
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
        eventKind: 'CASH_DIVIDEND_ORDINARY', economicPayload: cashPayload,
        participantCoreIds: [participant.participantCoreId],
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'ECONOMIC_CORRECTION',
        supersedesRevisionId: revision1.revisionCoreId, ...UTC('2026-01-15T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID',
  );
  // Wrong payload under new kind must fail at normalize time.
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
        eventKind: 'CASH_DIVIDEND_ORDINARY', economicPayload: splitPayload,
        participantCoreIds: [participant.participantCoreId],
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'EVENT_KIND_RECLASSIFICATION',
        supersedesRevisionId: revision1.revisionCoreId, ...UTC('2026-01-15T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID',
  );
  const economic = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'FORWARD_SPLIT',
      economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '3', denominator: '1' }, cashAmount: null },
      participantCoreIds: [participant.participantCoreId],
      revisionDisposition: 'ASSERTED', revisionReasonCode: 'ECONOMIC_CORRECTION',
      supersedesRevisionId: revision1.revisionCoreId, ...UTC('2026-01-12T13:00:00.000Z'),
    },
  });
  assert.equal(economic.revisionCore.revisionReasonCode, 'ECONOMIC_CORRECTION');
  const reclass = buildCorporateActionRevision({
    store,
    revision: {
      schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
      eventKind: 'CASH_DIVIDEND_ORDINARY', economicPayload: cashPayload,
      participantCoreIds: [participant.participantCoreId],
      revisionDisposition: 'ASSERTED', revisionReasonCode: 'EVENT_KIND_RECLASSIFICATION',
      supersedesRevisionId: economic.revisionCoreId, ...UTC('2026-01-15T13:00:00.000Z'),
    },
  });
  const obs2 = buildCorporateActionObservation({
    store,
    observation: {
      schemaVersion: CA.OBSERVATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      normalizationPolicyId: p.normalizationPolicy.policyId, sourceAttestationId: null,
      claim: { eventKind: 'CASH_DIVIDEND_ORDINARY', economicPayload: cashPayload }, ...UTC('2026-01-15T12:00:00.000Z'),
    },
  });
  const adj1 = buildCorporateActionAdjudication({
    store,
    adjudication: {
      schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      selectedRevisionId: revision1.revisionCoreId, adjudicationPolicyId: p.adjudicationPolicy.policyId,
      confidence: 'CONFIRMED', decisionReasonCodes: [],
      consideredObservationIds: [obs1.observationCoreId], acceptedObservationIds: [obs1.observationCoreId],
      rejectedObservationIds: [], conflictObservationIds: [], supersedesAdjudicationId: null,
      ...UTC('2026-01-08T14:00:00.000Z'),
    },
  });
  assert.throws(
    () => buildCorporateActionAdjudication({
      store,
      adjudication: {
        schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId,
        selectedRevisionId: reclass.revisionCoreId, adjudicationPolicyId: p.adjudicationPolicy.policyId,
        confidence: 'CONFIRMED', decisionReasonCodes: [],
        consideredObservationIds: [obs1.observationCoreId, obs2.observationCoreId].sort(),
        acceptedObservationIds: [obs2.observationCoreId], rejectedObservationIds: [obs1.observationCoreId],
        conflictObservationIds: [], supersedesAdjudicationId: adj1.adjudicationCoreId,
        ...UTC('2026-01-15T14:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_EVENT_KIND_RECLASSIFICATION_REQUIRED',
  );
  const adj2 = buildCorporateActionAdjudication({
    store,
    adjudication: {
      schemaVersion: CA.ADJUDICATION, corporateActionIdentityId: identity.corporateActionIdentityId,
      selectedRevisionId: reclass.revisionCoreId, adjudicationPolicyId: p.adjudicationPolicy.policyId,
      confidence: 'CONFIRMED', decisionReasonCodes: ['EVENT_KIND_RECLASSIFICATION_APPROVED'],
      consideredObservationIds: [obs1.observationCoreId, obs2.observationCoreId].sort(),
      acceptedObservationIds: [obs2.observationCoreId], rejectedObservationIds: [obs1.observationCoreId],
      conflictObservationIds: [], supersedesAdjudicationId: adj1.adjudicationCoreId,
      ...UTC('2026-01-15T14:00:00.000Z'),
    },
  });
  const event = buildCorporateActionEventManifest({
    store, corporateActionIdentityId: identity.corporateActionIdentityId,
    observationCoreIds: [obs1.observationCoreId, obs2.observationCoreId],
    observationRecordIds: [], sourcePayloadIds: [], sourceAttestationIds: [], providerBindingCoreIds: [],
    participantCoreIds: [participant.participantCoreId],
    revisionCoreIds: [revision1.revisionCoreId, economic.revisionCoreId, reclass.revisionCoreId],
    adjudicationCoreIds: [adj1.adjudicationCoreId, adj2.adjudicationCoreId],
    supersedesEventManifestId: null,
  });
  const ledger = buildInstrumentCorporateActionLedger({
    store, instrumentIdentityId: instrument.instrumentIdentityId, eventManifestIds: [event.eventManifestId],
    supersedesLedgerManifestId: null,
  });
  const registry = buildCorporateActionRegistry({
    store, ...registryInput(p, instrumentRegistry, [ledger.ledgerManifestId]),
  });
  const before = resolveCorporateActionsAsOf({
    store, registryManifestId: registry.registryManifestId, knowledgeCutoff: '2026-01-12T00:00:00.000Z',
  }).results[0];
  const after = resolveCorporateActionsAsOf({
    store, registryManifestId: registry.registryManifestId, knowledgeCutoff: '2026-01-16T00:00:00.000Z',
  }).results[0];
  assert.equal(before.revision.eventKind, 'FORWARD_SPLIT');
  assert.equal(after.revision.eventKind, 'CASH_DIVIDEND_ORDINARY');
}));

test('L2C-R1-10 — cancellation keeps kind; restoration after cancellation is explicit', () => withStore((store) => {
  const { authority, instrument } = publishInstrument(store);
  const instrumentRegistry = registerInstruments(store, authority.authorityPolicyId, [instrument]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, '44'.repeat(32));
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        ...graph.revision.revisionCore,
        revisionDisposition: 'CANCELS_EVENT',
        revisionReasonCode: 'ECONOMIC_CORRECTION',
        supersedesRevisionId: graph.revision.revisionCoreId,
        knowledgeTimeLowerBound: '2026-01-18T13:00:00.000Z',
        knowledgeTimeUpperBound: '2026-01-18T13:00:00.000Z',
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID',
  );
  const cancellation = buildCorporateActionRevision({
    store,
    revision: {
      ...graph.revision.revisionCore,
      revisionDisposition: 'CANCELS_EVENT',
      revisionReasonCode: 'CANCELLATION',
      supersedesRevisionId: graph.revision.revisionCoreId,
      knowledgeTimeLowerBound: '2026-01-18T13:00:00.000Z',
      knowledgeTimeUpperBound: '2026-01-18T13:00:00.000Z',
    },
  });
  assert.equal(cancellation.revisionCore.eventKind, 'FORWARD_SPLIT');
  const restoration = buildCorporateActionRevision({
    store,
    revision: {
      ...graph.revision.revisionCore,
      revisionDisposition: 'ASSERTED',
      revisionReasonCode: 'RESTORATION',
      supersedesRevisionId: cancellation.revisionCoreId,
      knowledgeTimeLowerBound: '2026-01-19T13:00:00.000Z',
      knowledgeTimeUpperBound: '2026-01-19T13:00:00.000Z',
    },
  });
  assert.equal(restoration.revisionCore.revisionReasonCode, 'RESTORATION');
  // Restoration must not silently reclassify.
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION,
        corporateActionIdentityId: graph.identity.corporateActionIdentityId,
        eventKind: 'CASH_DIVIDEND_ORDINARY',
        economicPayload: { effectiveDate: '2026-01-10', ratio: null, cashAmount: { amountAtoms: '1', scale: 2, currency: 'USD' } },
        participantCoreIds: [graph.participant.participantCoreId],
        revisionDisposition: 'ASSERTED',
        revisionReasonCode: 'RESTORATION',
        supersedesRevisionId: cancellation.revisionCoreId,
        ...UTC('2026-01-20T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_INPUT_INVALID',
  );
  void instrumentRegistry;
}));

// ─── Cardinality ─────────────────────────────────────────────────────────────

test('L2C-R1-11 — exact role cardinality refusals', () => withStore((store) => {
  const { authority, instrument: a } = publishInstrument(store, '1'.repeat(64));
  const b = buildInstrumentIdentity({
    store, authorityPolicyId: authority.authorityPolicyId, identitySeed: '2'.repeat(64), instrumentKind: 'EQUITY',
  });
  const p = policies(store, ['FORWARD_SPLIT', 'MERGER_CASH', 'SPIN_OFF']);
  const identity = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: '55'.repeat(32),
  });
  const primary1 = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: a.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const primary2 = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: identity.corporateActionIdentityId,
      instrumentIdentityId: b.instrumentIdentityId, participantRole: 'PRIMARY_SUBJECT',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: identity.corporateActionIdentityId,
        eventKind: 'FORWARD_SPLIT',
        economicPayload: { effectiveDate: '2026-01-10', ratio: { numerator: '2', denominator: '1' }, cashAmount: null },
        participantCoreIds: [primary1.participantCoreId, primary2.participantCoreId].sort(),
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
        ...UTC('2026-01-08T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT',
  );

  const mergerId = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: '56'.repeat(32),
  });
  const t1 = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: mergerId.corporateActionIdentityId,
      instrumentIdentityId: a.instrumentIdentityId, participantRole: 'TARGET',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const t2 = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: mergerId.corporateActionIdentityId,
      instrumentIdentityId: b.instrumentIdentityId, participantRole: 'TARGET',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const acq = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: mergerId.corporateActionIdentityId,
      instrumentIdentityId: b.instrumentIdentityId, participantRole: 'ACQUIRER',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: '2021-01-01T00:00:00.000Z',
    },
  });
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: mergerId.corporateActionIdentityId,
        eventKind: 'MERGER_CASH',
        economicPayload: { effectiveDate: '2026-02-01', ratio: null, cashAmount: { amountAtoms: '1', scale: 2, currency: 'USD' } },
        participantCoreIds: [t1.participantCoreId, t2.participantCoreId, acq.participantCoreId].sort(),
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
        ...UTC('2026-01-20T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT',
  );

  const sameTargetAcquirer = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: '57'.repeat(32),
  });
  const st = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: sameTargetAcquirer.corporateActionIdentityId,
      instrumentIdentityId: a.instrumentIdentityId, participantRole: 'TARGET',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  const sa = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: sameTargetAcquirer.corporateActionIdentityId,
      instrumentIdentityId: a.instrumentIdentityId, participantRole: 'ACQUIRER',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: sameTargetAcquirer.corporateActionIdentityId,
        eventKind: 'MERGER_CASH',
        economicPayload: { effectiveDate: '2026-02-01', ratio: null, cashAmount: { amountAtoms: '1', scale: 2, currency: 'USD' } },
        participantCoreIds: [st.participantCoreId, sa.participantCoreId].sort(),
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
        ...UTC('2026-01-20T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT',
  );

  const spinId = buildCorporateActionIdentity({
    store, authorityPolicyId: p.authorityPolicy.policyId, corporateActionSeed: '58'.repeat(32),
  });
  const parent = buildCorporateActionParticipant({
    store,
    participant: {
      schemaVersion: CA.PARTICIPANT, corporateActionIdentityId: spinId.corporateActionIdentityId,
      instrumentIdentityId: a.instrumentIdentityId, participantRole: 'PARENT',
      validFrom: '2020-01-01T00:00:00.000Z', validToExclusive: null,
    },
  });
  assert.throws(
    () => buildCorporateActionRevision({
      store,
      revision: {
        schemaVersion: CA.REVISION, corporateActionIdentityId: spinId.corporateActionIdentityId,
        eventKind: 'SPIN_OFF',
        economicPayload: { effectiveDate: '2026-02-01', ratio: { numerator: '1', denominator: '1' }, cashAmount: null },
        participantCoreIds: [parent.participantCoreId],
        revisionDisposition: 'ASSERTED', revisionReasonCode: 'INITIAL_ASSERTION', supersedesRevisionId: null,
        ...UTC('2026-01-20T13:00:00.000Z'),
      },
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT',
  );
}));

// ─── Provenance honesty ──────────────────────────────────────────────────────

test('L2C-R1-12 — provenance docs and structured secrets; no exhaustive guarantee', () => withStore((store) => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /best-effort/i);
  assert.doesNotMatch(readme, /aucun secret garanti/i);
  // Known structured patterns remain refused.
  assert.throws(
    () => buildCorporateActionSourcePayload({
      store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain',
      payloadValue: 'Authorization: Bearer tok_abc',
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PROVENANCE_SECRET_FORBIDDEN',
  );
  assert.throws(
    () => buildCorporateActionSourcePayload({
      store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain',
      payloadValue: 'see C:\\Users\\secret\\file.txt',
    }),
    (e) => ['CORPORATE_ACTION_PROVENANCE_SECRET_FORBIDDEN', 'CORPORATE_ACTION_PROVENANCE_MODE_INVALID'].includes(code(e)),
  );
  assert.throws(
    () => buildCorporateActionSourcePayload({
      store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain',
      payloadValue: 'api_key=not-for-production',
    }),
    (e) => code(e) === 'CORPORATE_ACTION_PROVENANCE_SECRET_FORBIDDEN',
  );
  // Arbitrary unrecognized key must not be claimed as detected — acceptance is allowed.
  const opaque = buildCorporateActionSourcePayload({
    store, payloadFormat: 'UTF8_TEXT', mediaType: 'text/plain',
    payloadValue: 'x-custom-opaque-material-zz9-not-a-known-pattern',
  });
  assert.match(opaque.sourcePayloadId, /^sha256:/);
  // ID-only recovery still walks the L2B pin.
  const { authority, instrument } = publishInstrument(store, '9'.repeat(64));
  const instrumentRegistry = registerInstruments(store, authority.authorityPolicyId, [instrument]);
  const p = policies(store);
  const graph = publishSplitEvent(store, p, instrument, '66'.repeat(32));
  const registry = buildCorporateActionRegistry({
    store, ...registryInput(p, instrumentRegistry, [graph.ledger.ledgerManifestId]),
  });
  const recovered = recoverCorporateActionRegistry({ store, registryManifestId: registry.registryManifestId });
  assert.equal(recovered.instrumentRegistry.registryManifestId, instrumentRegistry.registryManifestId);
  verifyCorporateActionRegistry({ store, registryManifestId: registry.registryManifestId });
}));
