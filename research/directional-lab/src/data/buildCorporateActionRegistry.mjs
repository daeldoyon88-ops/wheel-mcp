/** L2C append-only manifests, authoritative registry and as-of resolver. */

import {
  CA, CorporateActionError, intervalsOverlap, isSortedIdSubset,
  normalizeCorporateActionCanonicalValue,
} from '../contracts/corporateActionL2CV1.mjs';
import { sortedUniqueStrings } from '../contracts/contractPrimitivesV1.mjs';
import {
  assertCorporateActionId, assertCorporateActionInput, assertCorporateActionStore,
  putCorporateActionObject, readCorporateActionObject,
} from './corporateActionStore.mjs';
import {
  verifyCorporateActionAdjudication, verifyCorporateActionIdentity, verifyCorporateActionObservation,
  verifyCorporateActionObservationRecord, verifyCorporateActionParticipant, verifyCorporateActionPolicy,
  verifyCorporateActionRevision, verifyCorporateActionSourceAttestation, verifyCorporateActionSourcePayload,
  verifyProviderCorporateActionBinding,
} from './corporateActionBuildersCore.mjs';
import { verifyInstrumentAliasBinding, verifyInstrumentIdentity } from './instrumentIdentityBuildersCore.mjs';
import { verifyInstrumentIdentityRegistry } from './buildInstrumentIdentityRegistry.mjs';

function exact(input, allowed) {
  assertCorporateActionInput(input);
  const fields = new Set(['store', ...allowed]);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `unknown field: ${key}`);
}
function storeCandidate(store, schema, candidate, idName, valueName) {
  const normalized = normalizeCorporateActionCanonicalValue(schema, candidate);
  const saved = putCorporateActionObject(store, schema, normalized);
  return { [idName]: saved.objectId, [valueName]: saved.value, object: saved };
}
function verifyChain({ store, current, currentId, parentField, schema, setFields, identityField, cycleCode, appendCode, label, visit }) {
  const seen = new Set(currentId ? [currentId] : []); let child = current;
  while (child[parentField]) {
    const parentId = child[parentField];
    if (seen.has(parentId)) throw new CorporateActionError(cycleCode, `${label} supersedes cycle detected`);
    seen.add(parentId);
    const parent = readCorporateActionObject(store, parentId, schema, `${label} ancestor`);
    if (identityField && parent[identityField] !== current[identityField]) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', `${label} ancestor belongs to another identity`);
    for (const field of setFields) if (!isSortedIdSubset(parent[field], child[field])) throw new CorporateActionError(appendCode, `${field} was removed from ${label}`);
    visit?.(parent, parentId); child = parent;
  }
}

function eventReferences(store, manifest, manifestId = null) {
  verifyCorporateActionIdentity({ store, corporateActionIdentityId: manifest.corporateActionIdentityId });
  verifyChain({ store, current: manifest, currentId: manifestId, parentField: 'supersedesEventManifestId', schema: CA.EVENT_MANIFEST,
    setFields: ['observationCoreIds', 'observationRecordIds', 'sourcePayloadIds', 'sourceAttestationIds', 'providerBindingCoreIds', 'participantCoreIds', 'revisionCoreIds', 'adjudicationCoreIds'],
    identityField: 'corporateActionIdentityId', cycleCode: 'CORPORATE_ACTION_MANIFEST_CYCLE', appendCode: 'CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', label: 'event manifest',
    visit: (parent) => verifyEventDirectReferences(store, parent) });
  return verifyEventDirectReferences(store, manifest);
}
function sameEvent(object, identityId, label) {
  if (object.corporateActionIdentityId !== identityId) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', `${label} belongs to another event`);
}
function verifyEventDirectReferences(store, manifest) {
  const identityId = manifest.corporateActionIdentityId;
  const payloads = manifest.sourcePayloadIds.map((sourcePayloadId) => verifyCorporateActionSourcePayload({ store, sourcePayloadId }));
  const attestations = manifest.sourceAttestationIds.map((sourceAttestationId) => verifyCorporateActionSourceAttestation({ store, sourceAttestationId }));
  for (const a of attestations) if (a.sourceAttestation.embeddedPayloadId && !manifest.sourcePayloadIds.includes(a.sourceAttestation.embeddedPayloadId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'embedded payload is omitted from event manifest');
  const observations = manifest.observationCoreIds.map((observationCoreId) => verifyCorporateActionObservation({ store, observationCoreId }));
  observations.forEach((x) => sameEvent(x.observationCore, identityId, 'observation'));
  for (const x of observations) if (x.observationCore.sourceAttestationId && !manifest.sourceAttestationIds.includes(x.observationCore.sourceAttestationId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'observation attestation is omitted');
  const records = manifest.observationRecordIds.map((observationRecordId) => verifyCorporateActionObservationRecord({ store, observationRecordId }));
  for (const x of records) if (!manifest.observationCoreIds.includes(x.observationRecord.observationCoreId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'observation record core is omitted');
  const bindings = manifest.providerBindingCoreIds.map((providerBindingCoreId) => verifyProviderCorporateActionBinding({ store, providerBindingCoreId }));
  bindings.forEach((x) => sameEvent(x.providerBindingCore, identityId, 'provider binding'));
  const participants = manifest.participantCoreIds.map((participantCoreId) => verifyCorporateActionParticipant({ store, participantCoreId }));
  participants.forEach((x) => sameEvent(x.participantCore, identityId, 'participant'));
  const revisions = manifest.revisionCoreIds.map((revisionCoreId) => verifyCorporateActionRevision({ store, revisionCoreId }));
  revisions.forEach((x) => sameEvent(x.revisionCore, identityId, 'revision'));
  for (const x of revisions) if (x.revisionCore.supersedesRevisionId && !manifest.revisionCoreIds.includes(x.revisionCore.supersedesRevisionId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'revision parent is omitted');
  const revisionChildren = new Map();
  for (const x of revisions) if (x.revisionCore.supersedesRevisionId) { const p = x.revisionCore.supersedesRevisionId; if (revisionChildren.has(p)) throw new CorporateActionError('CORPORATE_ACTION_REVISION_BRANCH', 'two revisions supersede the same parent'); revisionChildren.set(p, x.revisionCoreId); }
  const adjudications = manifest.adjudicationCoreIds.map((adjudicationCoreId) => verifyCorporateActionAdjudication({ store, adjudicationCoreId }));
  adjudications.forEach((x) => sameEvent(x.adjudicationCore, identityId, 'adjudication'));
  for (const x of adjudications) {
    if (!manifest.revisionCoreIds.includes(x.adjudicationCore.selectedRevisionId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'selected revision is omitted');
    if (x.adjudicationCore.consideredObservationIds.some((id) => !manifest.observationCoreIds.includes(id))) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'considered observation is omitted');
    if (x.adjudicationCore.supersedesAdjudicationId && !manifest.adjudicationCoreIds.includes(x.adjudicationCore.supersedesAdjudicationId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'adjudication parent is omitted');
  }
  const adjudicationChildren = new Map();
  for (const x of adjudications) if (x.adjudicationCore.supersedesAdjudicationId) { const p = x.adjudicationCore.supersedesAdjudicationId; if (adjudicationChildren.has(p)) throw new CorporateActionError('CORPORATE_ACTION_ADJUDICATION_CONFLICT', 'two adjudications supersede the same parent'); adjudicationChildren.set(p, x.adjudicationCoreId); }
  return { payloads, attestations, observations, records, bindings, participants, revisions, adjudications };
}

export function buildCorporateActionEventManifest(input) {
  exact(input, ['corporateActionIdentityId', 'observationCoreIds', 'observationRecordIds', 'sourcePayloadIds', 'sourceAttestationIds', 'providerBindingCoreIds', 'participantCoreIds', 'revisionCoreIds', 'adjudicationCoreIds', 'supersedesEventManifestId']);
  const c = { schemaVersion: CA.EVENT_MANIFEST, corporateActionIdentityId: input.corporateActionIdentityId,
    observationCoreIds: sortedUniqueStrings(input.observationCoreIds ?? []), observationRecordIds: sortedUniqueStrings(input.observationRecordIds ?? []), sourcePayloadIds: sortedUniqueStrings(input.sourcePayloadIds ?? []), sourceAttestationIds: sortedUniqueStrings(input.sourceAttestationIds ?? []), providerBindingCoreIds: sortedUniqueStrings(input.providerBindingCoreIds ?? []), participantCoreIds: sortedUniqueStrings(input.participantCoreIds ?? []), revisionCoreIds: sortedUniqueStrings(input.revisionCoreIds ?? []), adjudicationCoreIds: sortedUniqueStrings(input.adjudicationCoreIds ?? []), supersedesEventManifestId: input.supersedesEventManifestId ?? null };
  const refs = eventReferences(input.store, normalizeCorporateActionCanonicalValue(CA.EVENT_MANIFEST, c));
  return { ...storeCandidate(input.store, CA.EVENT_MANIFEST, c, 'eventManifestId', 'eventManifest'), ...refs };
}
export function verifyCorporateActionEventManifest(input) { exact(input, ['eventManifestId']); assertCorporateActionStore(input.store); assertCorporateActionId(input.eventManifestId, 'eventManifestId'); const eventManifest = readCorporateActionObject(input.store, input.eventManifestId, CA.EVENT_MANIFEST, 'event manifest'); return { eventManifestId: input.eventManifestId, eventManifest, ...eventReferences(input.store, eventManifest, input.eventManifestId) }; }

function ledgerReferences(store, ledger, ledgerId = null) {
  try { verifyInstrumentIdentity({ store, instrumentIdentityId: ledger.instrumentIdentityId }); } catch (cause) { throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_INVALID', 'ledger instrument identity is invalid', { cause }); }
  verifyChain({ store, current: ledger, currentId: ledgerId, parentField: 'supersedesLedgerManifestId', schema: CA.LEDGER, setFields: ['eventManifestIds'], identityField: 'instrumentIdentityId', cycleCode: 'CORPORATE_ACTION_MANIFEST_CYCLE', appendCode: 'CORPORATE_ACTION_LEDGER_APPEND_ONLY_VIOLATION', label: 'instrument ledger', visit: (p) => p.eventManifestIds.forEach((id) => verifyCorporateActionEventManifest({ store, eventManifestId: id })) });
  const eventBundles = ledger.eventManifestIds.map((eventManifestId) => verifyCorporateActionEventManifest({ store, eventManifestId }));
  for (const event of eventBundles) if (!event.participants.some((p) => p.participantCore.instrumentIdentityId === ledger.instrumentIdentityId)) throw new CorporateActionError('CORPORATE_ACTION_LEDGER_PARTICIPATION_MISMATCH', 'ledger indexes an event without matching participant');
  return eventBundles;
}
export function buildInstrumentCorporateActionLedger(input) { exact(input, ['instrumentIdentityId', 'eventManifestIds', 'supersedesLedgerManifestId']); const c = { schemaVersion: CA.LEDGER, instrumentIdentityId: input.instrumentIdentityId, eventManifestIds: sortedUniqueStrings(input.eventManifestIds ?? []), supersedesLedgerManifestId: input.supersedesLedgerManifestId ?? null }; const eventBundles = ledgerReferences(input.store, normalizeCorporateActionCanonicalValue(CA.LEDGER, c)); return { ...storeCandidate(input.store, CA.LEDGER, c, 'ledgerManifestId', 'ledgerManifest'), eventBundles }; }
export function verifyInstrumentCorporateActionLedger(input) { exact(input, ['ledgerManifestId']); const ledgerManifest = readCorporateActionObject(input.store, input.ledgerManifestId, CA.LEDGER, 'instrument ledger'); return { ledgerManifestId: input.ledgerManifestId, ledgerManifest, eventBundles: ledgerReferences(input.store, ledgerManifest, input.ledgerManifestId) }; }

function selectTips(bundles, idKey, objectKey, identityKey, parentKey, conflictCode) {
  const groups = new Map(); for (const b of bundles) { const k = b[objectKey][identityKey]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); }
  const tips = new Map();
  for (const [identity, xs] of groups) {
    const parentIds = new Set(xs.map((x) => x[objectKey][parentKey]).filter(Boolean));
    const candidates = xs.filter((x) => !parentIds.has(x[idKey]));
    if (candidates.length !== 1) throw new CorporateActionError(conflictCode, `authoritative tip is ambiguous for ${identity}`);
    tips.set(identity, candidates[0]);
  }
  return tips;
}

function authorizedInstrumentIdentityIds(instrumentRegistry) {
  return new Set(instrumentRegistry.identityBundles.map((bundle) => bundle.identityManifest.instrumentIdentityId));
}

function authorizedAliasBindingIds(instrumentRegistry) {
  const ids = new Set();
  for (const bundle of instrumentRegistry.allIdentityBundles) {
    for (const alias of bundle.aliases) ids.add(alias.aliasBindingCoreId);
  }
  return ids;
}

function isInstrumentRegistryDescendantOrSame(store, candidateId, ancestorId) {
  if (candidateId === ancestorId) return true;
  const seen = new Set();
  let currentId = candidateId;
  while (currentId) {
    if (seen.has(currentId)) throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH', 'instrument identity registry supersedes cycle');
    seen.add(currentId);
    let current;
    try {
      current = verifyInstrumentIdentityRegistry({ store, registryManifestId: currentId });
    } catch (cause) {
      throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH', 'instrument identity registry chain is corrupt', { cause });
    }
    const parentId = current.registryManifest.supersedesRegistryManifestId;
    if (parentId === ancestorId) return true;
    currentId = parentId;
  }
  return false;
}

function assertAuthorizedParticipants(authorizedIds, participants, context) {
  for (const participant of participants) {
    const identityId = participant.participantCore?.instrumentIdentityId ?? participant.instrumentIdentityId;
    if (!authorizedIds.has(identityId)) {
      throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
        `instrument identity is not a member of the authoritative L2B registry (${context})`,
        { instrumentIdentityId: identityId });
    }
  }
}

function assertSymbolChangeAliases(store, instrumentRegistry, revision, participants) {
  if (revision.eventKind !== 'SYMBOL_CHANGE') return;
  const payload = revision.economicPayload;
  const authorizedAliases = authorizedAliasBindingIds(instrumentRegistry);
  if (!authorizedAliases.has(payload.previousAliasBindingCoreId) || !authorizedAliases.has(payload.nextAliasBindingCoreId)) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases must exist in the pinned L2B registry');
  }
  let previousAlias;
  let nextAlias;
  try {
    previousAlias = verifyInstrumentAliasBinding({ store, aliasBindingCoreId: payload.previousAliasBindingCoreId }).aliasBindingCore;
    nextAlias = verifyInstrumentAliasBinding({ store, aliasBindingCoreId: payload.nextAliasBindingCoreId }).aliasBindingCore;
  } catch (cause) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases are absent or corrupt', { cause });
  }
  const primary = participants.find((x) => x.participantRole === 'PRIMARY_SUBJECT');
  if (!primary || previousAlias.instrumentIdentityId !== primary.instrumentIdentityId
    || nextAlias.instrumentIdentityId !== primary.instrumentIdentityId
    || previousAlias.instrumentIdentityId !== nextAlias.instrumentIdentityId) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases must belong to the PRIMARY_SUBJECT identity');
  }
  if (previousAlias.validToExclusive === null || previousAlias.validToExclusive !== nextAlias.validFrom) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases must abut with exclusive end of previous alias');
  }
  if (intervalsOverlap(previousAlias.validFrom, previousAlias.validToExclusive, nextAlias.validFrom, nextAlias.validToExclusive)) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases overlap contradictorily');
  }
  // Alias civil dates vs economic effectiveDate: require previous end / next start on the effective date.
  if (previousAlias.validToExclusive !== payload.effectiveDate || nextAlias.validFrom !== payload.effectiveDate) {
    throw new CorporateActionError('CORPORATE_ACTION_SYMBOL_CHANGE_CONFLICT', 'SYMBOL_CHANGE aliases must transition on the economic effectiveDate');
  }
}

function registryReferences(store, registry, registryId = null) {
  let temporalPolicy;
  for (const [field, schema] of [['authorityPolicyId', CA.AUTHORITY], ['normalizationPolicyId', CA.NORMALIZATION], ['temporalPolicyId', CA.TEMPORAL], ['adjudicationPolicyId', CA.ADJUDICATION_POLICY], ['priceAdjustmentPolicyId', CA.PRICE_POLICY], ['entitlementPolicyId', CA.ENTITLEMENT_POLICY]]) {
    const verified = verifyCorporateActionPolicy({ store, policyId: registry[field], schemaVersion: schema });
    if (field === 'temporalPolicyId') temporalPolicy = verified.policy;
  }
  let instrumentRegistry;
  try {
    instrumentRegistry = verifyInstrumentIdentityRegistry({
      store, registryManifestId: registry.instrumentIdentityRegistryManifestId,
    });
  } catch (cause) {
    throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_IDENTITY_NOT_AUTHORIZED',
      'pinned L2B instrument identity registry is missing or corrupt', { cause });
  }
  const authorizedIds = authorizedInstrumentIdentityIds(instrumentRegistry);

  verifyChain({
    store, current: registry, currentId: registryId, parentField: 'supersedesRegistryManifestId', schema: CA.REGISTRY,
    setFields: ['instrumentLedgerManifestIds'], identityField: 'authorityPolicyId',
    cycleCode: 'CORPORATE_ACTION_REGISTRY_CYCLE', appendCode: 'CORPORATE_ACTION_REGISTRY_APPEND_ONLY_VIOLATION',
    label: 'registry',
    visit: (parent, parentId) => {
      parent.instrumentLedgerManifestIds.forEach((id) => verifyInstrumentCorporateActionLedger({ store, ledgerManifestId: id }));
      if (!isInstrumentRegistryDescendantOrSame(store, registry.instrumentIdentityRegistryManifestId, parent.instrumentIdentityRegistryManifestId)) {
        throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH',
          'L2C registry cannot pin a foreign or older L2B instrument registry chain');
      }
      let parentInstrumentRegistry;
      try {
        parentInstrumentRegistry = verifyInstrumentIdentityRegistry({
          store, registryManifestId: parent.instrumentIdentityRegistryManifestId,
        });
      } catch (cause) {
        throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH',
          'historical L2B instrument registry is missing or corrupt', { cause, parentId });
      }
      const parentAuthorized = authorizedInstrumentIdentityIds(parentInstrumentRegistry);
      for (const identityId of parentAuthorized) {
        if (!authorizedIds.has(identityId)) {
          throw new CorporateActionError('CORPORATE_ACTION_INSTRUMENT_REGISTRY_MISMATCH',
            'L2C registry cannot drop a previously authorized L2B instrument identity');
        }
      }
    },
  });

  const ledgerBundles = registry.instrumentLedgerManifestIds.map((ledgerManifestId) => verifyInstrumentCorporateActionLedger({ store, ledgerManifestId }));
  const ledgerTips = selectTips(ledgerBundles, 'ledgerManifestId', 'ledgerManifest', 'instrumentIdentityId', 'supersedesLedgerManifestId', 'CORPORATE_ACTION_LEDGER_TIP_CONFLICT');
  const allEventBundles = [...new Map(
    [...ledgerTips.values()].flatMap((l) => l.eventBundles).map((event) => [event.eventManifestId, event]),
  ).values()];
  // Historical ledgers (not only tips) still contribute participants that must remain authorized.
  for (const ledger of ledgerBundles) {
    assertAuthorizedParticipants(authorizedIds, [{ participantCore: { instrumentIdentityId: ledger.ledgerManifest.instrumentIdentityId } }], 'ledger');
    for (const event of ledger.eventBundles) {
      assertAuthorizedParticipants(authorizedIds, event.participants, 'historical event');
      for (const revision of event.revisions) {
        assertAuthorizedParticipants(authorizedIds, revision.participants.map((p) => ({ participantCore: p })), 'historical revision');
        assertSymbolChangeAliases(store, instrumentRegistry, revision.revisionCore, revision.participants);
      }
    }
  }
  const eventTips = selectTips(allEventBundles, 'eventManifestId', 'eventManifest', 'corporateActionIdentityId', 'supersedesEventManifestId', 'CORPORATE_ACTION_LEDGER_TIP_CONFLICT');
  for (const event of eventTips.values()) {
    assertAuthorizedParticipants(authorizedIds, event.participants, 'event tip');
    const temporalObjects = [...event.attestations.map((x) => x.sourceAttestation), ...event.observations.map((x) => x.observationCore),
      ...event.revisions.map((x) => x.revisionCore), ...event.adjudications.map((x) => x.adjudicationCore)];
    for (const object of temporalObjects) if (object.temporalPrecision === 'DATE_ONLY') {
      const expectedNull = temporalPolicy.dateOnlyLowerBoundMode === 'NULL';
      if ((object.knowledgeTimeLowerBound === null) !== expectedNull) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT', 'DATE_ONLY lower bound violates registry temporal policy');
    }
  }
  for (const event of eventTips.values()) for (const participant of event.participants) {
    const ledger = ledgerTips.get(participant.participantCore.instrumentIdentityId);
    if (!ledger?.ledgerManifest.eventManifestIds.includes(event.eventManifestId)) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_LEDGER_MISSING', 'participant has no authoritative instrument ledger containing the event tip');
    }
  }
  const bindings = [...eventTips.values()].flatMap((e) => e.bindings);
  for (let i = 0; i < bindings.length; i++) for (let j = i + 1; j < bindings.length; j++) {
    const a = bindings[i].providerBindingCore; const b = bindings[j].providerBindingCore;
    if (a.providerId === b.providerId && a.providerEventId === b.providerEventId && a.corporateActionIdentityId !== b.corporateActionIdentityId && intervalsOverlap(a.validFrom, a.validToExclusive, b.validFrom, b.validToExclusive)) throw new CorporateActionError('CORPORATE_ACTION_PROVIDER_BINDING_CONFLICT', 'provider event binding overlaps across corporate-action identities');
  }
  return { ledgerBundles, ledgerTips, eventTips, instrumentRegistry };
}

export function buildCorporateActionRegistry(input) {
  exact(input, ['authorityPolicyId', 'normalizationPolicyId', 'temporalPolicyId', 'adjudicationPolicyId', 'priceAdjustmentPolicyId', 'entitlementPolicyId', 'instrumentIdentityRegistryManifestId', 'instrumentLedgerManifestIds', 'supersedesRegistryManifestId']);
  const c = {
    schemaVersion: CA.REGISTRY,
    authorityPolicyId: input.authorityPolicyId,
    normalizationPolicyId: input.normalizationPolicyId,
    temporalPolicyId: input.temporalPolicyId,
    adjudicationPolicyId: input.adjudicationPolicyId,
    priceAdjustmentPolicyId: input.priceAdjustmentPolicyId,
    entitlementPolicyId: input.entitlementPolicyId,
    instrumentIdentityRegistryManifestId: input.instrumentIdentityRegistryManifestId,
    instrumentLedgerManifestIds: sortedUniqueStrings(input.instrumentLedgerManifestIds ?? []),
    supersedesRegistryManifestId: input.supersedesRegistryManifestId ?? null,
  };
  const refs = registryReferences(input.store, normalizeCorporateActionCanonicalValue(CA.REGISTRY, c));
  return { ...storeCandidate(input.store, CA.REGISTRY, c, 'registryManifestId', 'registryManifest'), ...refs };
}
export function verifyCorporateActionRegistry(input) { exact(input, ['registryManifestId']); const registryManifest = readCorporateActionObject(input.store, input.registryManifestId, CA.REGISTRY, 'corporate-action registry'); return { registryManifestId: input.registryManifestId, registryManifest, ...registryReferences(input.store, registryManifest, input.registryManifestId) }; }
export const recoverCorporateActionRegistry = verifyCorporateActionRegistry;

function visibleTip(entries, idKey, valueKey, parentKey, cutoff, conflictCode) {
  const visible = entries.filter((x) => x[valueKey].knowledgeTimeUpperBound <= cutoff);
  const parentIds = new Set(visible.map((x) => x[valueKey][parentKey]).filter(Boolean));
  const tips = visible.filter((x) => !parentIds.has(x[idKey]));
  if (tips.length > 1) throw new CorporateActionError(conflictCode, 'multiple visible tips exist');
  return { visible, tip: tips[0] ?? null };
}
export function resolveCorporateActionsAsOf(input) {
  exact(input, ['registryManifestId', 'instrumentIdentityId', 'economicRange', 'knowledgeCutoff']);
  if (!input.knowledgeCutoff) throw new CorporateActionError('CORPORATE_ACTION_KNOWLEDGE_CUTOFF_REQUIRED', 'knowledgeCutoff is mandatory');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.knowledgeCutoff)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'knowledgeCutoff must be a strict UTC instant');
  const registry = verifyCorporateActionRegistry({ store: input.store, registryManifestId: input.registryManifestId }); const results = [];
  for (const event of registry.eventTips.values()) {
    if (input.instrumentIdentityId && !event.participants.some((x) => x.participantCore.instrumentIdentityId === input.instrumentIdentityId)) continue;
    const visibleObservations = event.observations.filter((x) => x.observationCore.knowledgeTimeUpperBound <= input.knowledgeCutoff);
    const adjudicationSelection = visibleTip(event.adjudications, 'adjudicationCoreId', 'adjudicationCore', 'supersedesAdjudicationId', input.knowledgeCutoff, 'CORPORATE_ACTION_ADJUDICATION_CONFLICT');
    if (!adjudicationSelection.tip) { results.push({ corporateActionIdentityId: event.eventManifest.corporateActionIdentityId, status: 'UNRESOLVED', reason: visibleObservations.length ? 'ADJUDICATION_REQUIRED' : 'NO_VISIBLE_OBSERVATION', selectedRevisionId: null, revision: null }); continue; }
    const adjudication = adjudicationSelection.tip.adjudicationCore;
    if (visibleObservations.some((x) => !adjudication.consideredObservationIds.includes(x.observationCoreId))) throw new CorporateActionError('CORPORATE_ACTION_NEW_OBSERVATION_UNADJUDICATED', 'a visible observation is absent from the adjudication');
    const revision = event.revisions.find((x) => x.revisionCoreId === adjudication.selectedRevisionId);
    if (!revision || revision.revisionCore.knowledgeTimeUpperBound > input.knowledgeCutoff) throw new CorporateActionError('CORPORATE_ACTION_FUTURE_INFORMATION', 'selected revision is not visible at knowledge cutoff');
    const effectiveDate = revision.revisionCore.economicPayload.effectiveDate;
    if (input.economicRange && (effectiveDate < input.economicRange.fromDate || effectiveDate >= input.economicRange.toDateExclusive)) continue;
    results.push({ corporateActionIdentityId: event.eventManifest.corporateActionIdentityId, status: revision.revisionCore.revisionDisposition === 'CANCELS_EVENT' ? 'CANCELLED' : 'RESOLVED', reason: null, selectedRevisionId: revision.revisionCoreId, revision: revision.revisionCore, adjudicationCoreId: adjudicationSelection.tip.adjudicationCoreId });
  }
  return { registryManifestId: input.registryManifestId, knowledgeCutoff: input.knowledgeCutoff, results: results.sort((a, b) => a.corporateActionIdentityId.localeCompare(b.corporateActionIdentityId)) };
}
