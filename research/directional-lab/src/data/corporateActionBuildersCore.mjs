import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../canonical/canonicalJsonV1.mjs';
import {
  CA, CorporateActionError, normalizeCorporateActionCanonicalValue,
} from '../contracts/corporateActionL2CV1.mjs';
import { verifyInstrumentIdentity } from './instrumentIdentityBuildersCore.mjs';
import {
  assertCorporateActionId, assertCorporateActionInput, assertCorporateActionStore,
  putCorporateActionObject, readCorporateActionObject,
} from './corporateActionStore.mjs';

function exactInput(input, fields) {
  assertCorporateActionInput(input);
  const allowed = new Set(['store', ...fields]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `unknown field: ${key}`);
}
function build(store, schemaVersion, candidate, idName, valueName) {
  const normalized = normalizeCorporateActionCanonicalValue(schemaVersion, candidate);
  const stored = putCorporateActionObject(store, schemaVersion, normalized);
  return { [idName]: stored.objectId, [valueName]: stored.value, object: stored };
}
function verify(input, schemaVersion, inputIdName, valueName) {
  exactInput(input, [inputIdName]); assertCorporateActionStore(input.store);
  const objectId = input[inputIdName]; assertCorporateActionId(objectId, inputIdName);
  return { [inputIdName]: objectId, [valueName]: readCorporateActionObject(input.store, objectId, schemaVersion, valueName) };
}

export function buildCorporateActionPolicy(input) {
  exactInput(input, ['policy']); assertCorporateActionStore(input.store, ['putCanonicalObject', 'readCanonicalObject', 'uriForObject']);
  if (!input.policy?.schemaVersion || ![CA.AUTHORITY, CA.NORMALIZATION, CA.TEMPORAL, CA.ADJUDICATION_POLICY, CA.PRICE_POLICY, CA.ENTITLEMENT_POLICY].includes(input.policy.schemaVersion)) {
    throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'policy schema is unsupported');
  }
  return build(input.store, input.policy.schemaVersion, input.policy, 'policyId', 'policy');
}
export function verifyCorporateActionPolicy(input) {
  exactInput(input, ['policyId', 'schemaVersion']);
  if (![CA.AUTHORITY, CA.NORMALIZATION, CA.TEMPORAL, CA.ADJUDICATION_POLICY, CA.PRICE_POLICY, CA.ENTITLEMENT_POLICY].includes(input.schemaVersion)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'policy schema is unsupported');
  return verify({ store: input.store, policyId: input.policyId }, input.schemaVersion, 'policyId', 'policy');
}
export function buildCorporateActionPolicies(input) {
  exactInput(input, ['authorityPolicy', 'normalizationPolicy', 'temporalPolicy', 'adjudicationPolicy', 'priceAdjustmentPolicy', 'entitlementPolicy']);
  const entries = {};
  for (const [name, schema] of [['authorityPolicy', CA.AUTHORITY], ['normalizationPolicy', CA.NORMALIZATION], ['temporalPolicy', CA.TEMPORAL], ['adjudicationPolicy', CA.ADJUDICATION_POLICY], ['priceAdjustmentPolicy', CA.PRICE_POLICY], ['entitlementPolicy', CA.ENTITLEMENT_POLICY]]) {
    if (input[name]?.schemaVersion !== schema) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `${name} schema is invalid`);
    entries[name] = buildCorporateActionPolicy({ store: input.store, policy: input[name] });
  }
  return entries;
}

export function buildTimeZoneRuleset(input) {
  exactInput(input, ['ruleset']); return build(input.store, CA.TIMEZONE, input.ruleset, 'timeZoneRulesetId', 'timeZoneRuleset');
}
export function verifyTimeZoneRuleset(input) { return verify(input, CA.TIMEZONE, 'timeZoneRulesetId', 'timeZoneRuleset'); }

export function buildCorporateActionIdentity(input) {
  exactInput(input, ['authorityPolicyId', 'corporateActionSeed']);
  const policy = verifyCorporateActionPolicy({ store: input.store, policyId: input.authorityPolicyId, schemaVersion: CA.AUTHORITY }).policy;
  if (policy.eventSeedFormat !== 'HEX_LOWERCASE' || typeof input.corporateActionSeed !== 'string' || input.corporateActionSeed.length !== policy.eventSeedLength || !/^[0-9a-f]+$/.test(input.corporateActionSeed)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'corporateActionSeed violates authority policy');
  return build(input.store, CA.IDENTITY, { schemaVersion: CA.IDENTITY, authorityPolicyId: input.authorityPolicyId, corporateActionSeed: input.corporateActionSeed }, 'corporateActionIdentityId', 'corporateActionIdentityCore');
}
export function verifyCorporateActionIdentity(input) {
  const out = verify(input, CA.IDENTITY, 'corporateActionIdentityId', 'corporateActionIdentityCore');
  verifyCorporateActionPolicy({ store: input.store, policyId: out.corporateActionIdentityCore.authorityPolicyId, schemaVersion: CA.AUTHORITY }); return out;
}

export function buildCorporateActionSourcePayload(input) {
  exactInput(input, ['payloadFormat', 'mediaType', 'payloadValue']);
  const normalizedValue = input.payloadFormat === 'CANONICAL_JSON'
    ? normalizePayloadJson(input.payloadValue) : input.payloadValue;
  const bytes = input.payloadFormat === 'CANONICAL_JSON' ? canonicalJsonBytes(normalizedValue) : Buffer.from(normalizedValue ?? '', 'utf8');
  const candidate = { schemaVersion: CA.PAYLOAD, provenanceMode: 'EMBEDDED_CANONICAL_PAYLOAD', payloadFormat: input.payloadFormat,
    mediaType: input.mediaType, payloadValue: normalizedValue, payloadDigest: createHash('sha256').update(bytes).digest('hex'), payloadByteLength: bytes.length };
  return build(input.store, CA.PAYLOAD, candidate, 'sourcePayloadId', 'sourcePayload');
}
function normalizePayloadJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'payload numeric values must be safe integers'); return value; }
  if (Array.isArray(value)) return value.map(normalizePayloadJson);
  if (!value || typeof value !== 'object') throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'payloadValue is invalid');
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalizePayloadJson(value[k])]));
}
export function verifyCorporateActionSourcePayload(input) { return verify(input, CA.PAYLOAD, 'sourcePayloadId', 'sourcePayload'); }

function verifyTemporal(store, object) {
  if (object.temporalPrecision === 'UTC_INSTANT') return;
  if (object.temporalPrecision !== 'DATE_ONLY') throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_PRECISION_INVALID', 'temporal precision is invalid');
  if (!object.timeZoneRulesetId) throw new CorporateActionError('CORPORATE_ACTION_TIMEZONE_RULESET_REQUIRED', 'DATE_ONLY requires a timezone ruleset');
  const ruleset = verifyTimeZoneRuleset({ store, timeZoneRulesetId: object.timeZoneRulesetId }).timeZoneRuleset;
  if (ruleset.zoneId !== object.sourceTimeZone) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT', 'source timezone does not match ruleset');
  const bound = ruleset.civilDateBounds.find((x) => x.civilDate === object.availableOn);
  if (!bound || bound.endUtcExclusive !== object.knowledgeTimeUpperBound || ![null, bound.startUtc].includes(object.knowledgeTimeLowerBound)) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT', 'DATE_ONLY bounds do not match the authoritative ruleset');
}

export function buildCorporateActionSourceAttestation(input) {
  exactInput(input, ['attestation']);
  const candidate = normalizeCorporateActionCanonicalValue(CA.ATTESTATION, input.attestation);
  verifyTemporal(input.store, candidate);
  if (candidate.provenanceMode === 'EMBEDDED_CANONICAL_PAYLOAD') verifyCorporateActionSourcePayload({ store: input.store, sourcePayloadId: candidate.embeddedPayloadId });
  return build(input.store, CA.ATTESTATION, candidate, 'sourceAttestationId', 'sourceAttestation');
}
export function verifyCorporateActionSourceAttestation(input) {
  const out = verify(input, CA.ATTESTATION, 'sourceAttestationId', 'sourceAttestation'); verifyTemporal(input.store, out.sourceAttestation);
  if (out.sourceAttestation.embeddedPayloadId) verifyCorporateActionSourcePayload({ store: input.store, sourcePayloadId: out.sourceAttestation.embeddedPayloadId }); return out;
}

export function buildCorporateActionObservation(input) {
  exactInput(input, ['observation']); const candidate = normalizeCorporateActionCanonicalValue(CA.OBSERVATION, input.observation);
  verifyCorporateActionIdentity({ store: input.store, corporateActionIdentityId: candidate.corporateActionIdentityId });
  verifyCorporateActionPolicy({ store: input.store, policyId: candidate.normalizationPolicyId, schemaVersion: CA.NORMALIZATION });
  if (candidate.temporalPrecision === 'DATE_ONLY' && !candidate.sourceAttestationId) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_ATTESTATION_REQUIRED', 'DATE_ONLY observation requires a source attestation');
  if (candidate.sourceAttestationId) {
    const attestation = verifyCorporateActionSourceAttestation({ store: input.store, sourceAttestationId: candidate.sourceAttestationId }).sourceAttestation;
    if (candidate.temporalPrecision === 'DATE_ONLY' && (attestation.temporalPrecision !== 'DATE_ONLY'
      || attestation.availableOn !== candidate.availableOn || attestation.timeZoneRulesetId !== candidate.timeZoneRulesetId
      || attestation.knowledgeTimeLowerBound !== candidate.knowledgeTimeLowerBound
      || attestation.knowledgeTimeUpperBound !== candidate.knowledgeTimeUpperBound)) {
      throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT', 'observation and attestation DATE_ONLY bounds differ');
    }
  }
  verifyTemporal(input.store, candidate); return build(input.store, CA.OBSERVATION, candidate, 'observationCoreId', 'observationCore');
}
export function verifyCorporateActionObservation(input) {
  const out = verify(input, CA.OBSERVATION, 'observationCoreId', 'observationCore'); verifyTemporal(input.store, out.observationCore);
  verifyCorporateActionIdentity({ store: input.store, corporateActionIdentityId: out.observationCore.corporateActionIdentityId });
  if (out.observationCore.temporalPrecision === 'DATE_ONLY' && !out.observationCore.sourceAttestationId) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_ATTESTATION_REQUIRED', 'DATE_ONLY observation requires a source attestation');
  if (out.observationCore.sourceAttestationId) {
    const attestation = verifyCorporateActionSourceAttestation({ store: input.store, sourceAttestationId: out.observationCore.sourceAttestationId }).sourceAttestation;
    if (out.observationCore.temporalPrecision === 'DATE_ONLY' && (attestation.temporalPrecision !== 'DATE_ONLY'
      || attestation.availableOn !== out.observationCore.availableOn || attestation.timeZoneRulesetId !== out.observationCore.timeZoneRulesetId
      || attestation.knowledgeTimeLowerBound !== out.observationCore.knowledgeTimeLowerBound
      || attestation.knowledgeTimeUpperBound !== out.observationCore.knowledgeTimeUpperBound)) throw new CorporateActionError('CORPORATE_ACTION_TEMPORAL_BOUNDS_INCONSISTENT', 'observation and attestation DATE_ONLY bounds differ');
  }
  return out;
}

export function buildCorporateActionObservationRecord(input) {
  exactInput(input, ['record']); const candidate = normalizeCorporateActionCanonicalValue(CA.OBSERVATION_RECORD, input.record);
  verifyCorporateActionObservation({ store: input.store, observationCoreId: candidate.observationCoreId }); return build(input.store, CA.OBSERVATION_RECORD, candidate, 'observationRecordId', 'observationRecord');
}
export function verifyCorporateActionObservationRecord(input) { const out = verify(input, CA.OBSERVATION_RECORD, 'observationRecordId', 'observationRecord'); verifyCorporateActionObservation({ store: input.store, observationCoreId: out.observationRecord.observationCoreId }); return out; }

export function buildProviderCorporateActionBinding(input) { exactInput(input, ['binding']); const c = normalizeCorporateActionCanonicalValue(CA.PROVIDER_BINDING, input.binding); verifyCorporateActionIdentity({ store: input.store, corporateActionIdentityId: c.corporateActionIdentityId }); return build(input.store, CA.PROVIDER_BINDING, c, 'providerBindingCoreId', 'providerBindingCore'); }
export function verifyProviderCorporateActionBinding(input) { const out = verify(input, CA.PROVIDER_BINDING, 'providerBindingCoreId', 'providerBindingCore'); verifyCorporateActionIdentity({ store: input.store, corporateActionIdentityId: out.providerBindingCore.corporateActionIdentityId }); return out; }

export function buildCorporateActionParticipant(input) { exactInput(input, ['participant']); const c = normalizeCorporateActionCanonicalValue(CA.PARTICIPANT, input.participant); verifyCorporateActionIdentity({ store: input.store, corporateActionIdentityId: c.corporateActionIdentityId }); try { verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: c.instrumentIdentityId }); } catch (error) { throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_INVALID', 'instrument identity is absent or corrupt', { cause: error }); } return build(input.store, CA.PARTICIPANT, c, 'participantCoreId', 'participantCore'); }
export function verifyCorporateActionParticipant(input) { const out = verify(input, CA.PARTICIPANT, 'participantCoreId', 'participantCore'); try { verifyInstrumentIdentity({ store: input.store, instrumentIdentityId: out.participantCore.instrumentIdentityId }); } catch (error) { throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_INVALID', 'instrument identity is absent or corrupt', { cause: error }); } return out; }

/** Exact role cardinalities per event kind. Values are exact counts; CHILD uses min. */
const ROLE_CARDINALITY = Object.freeze({
  FORWARD_SPLIT: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  REVERSE_SPLIT: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  STOCK_DIVIDEND: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  CASH_DIVIDEND_ORDINARY: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  CASH_DIVIDEND_SPECIAL: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  RETURN_OF_CAPITAL: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  SYMBOL_CHANGE: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  DELISTING: Object.freeze({ PRIMARY_SUBJECT: 1 }),
  MERGER_CASH: Object.freeze({ TARGET: 1, ACQUIRER: 1 }),
  MERGER_STOCK: Object.freeze({ TARGET: 1, ACQUIRER: 1 }),
  MERGER_MIXED: Object.freeze({ TARGET: 1, ACQUIRER: 1 }),
  SPIN_OFF: Object.freeze({ PARENT: 1, CHILD: { min: 1 } }),
  CONVERSION: Object.freeze({ CONVERTED_FROM: 1, CONVERTED_TO: 1 }),
});

function assertParticipantRoleCardinality(eventKind, participants) {
  const spec = ROLE_CARDINALITY[eventKind];
  if (!spec) throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', `unsupported event kind for roles: ${eventKind}`);
  const allowedRoles = new Set(Object.keys(spec));
  const counts = new Map();
  const instrumentRoles = new Map();
  for (const participant of participants) {
    const role = participant.participantRole;
    if (!allowedRoles.has(role)) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', `role ${role} is incompatible with ${eventKind}`);
    }
    counts.set(role, (counts.get(role) ?? 0) + 1);
    const key = participant.instrumentIdentityId;
    if (!instrumentRoles.has(key)) instrumentRoles.set(key, new Set());
    const rolesForInstrument = instrumentRoles.get(key);
    if (rolesForInstrument.has(role)) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', 'duplicate economic participant cores for the same instrument and role');
    }
    rolesForInstrument.add(role);
  }
  for (const [role, requirement] of Object.entries(spec)) {
    const count = counts.get(role) ?? 0;
    if (typeof requirement === 'number') {
      if (count !== requirement) {
        throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', `${eventKind} requires exactly ${requirement} ${role}`);
      }
    } else if (count < requirement.min) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', `${eventKind} requires at least ${requirement.min} ${role}`);
    }
  }
  if (['MERGER_CASH', 'MERGER_STOCK', 'MERGER_MIXED'].includes(eventKind)) {
    const target = participants.find((x) => x.participantRole === 'TARGET');
    const acquirer = participants.find((x) => x.participantRole === 'ACQUIRER');
    if (target && acquirer && target.instrumentIdentityId === acquirer.instrumentIdentityId) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', 'TARGET and ACQUIRER must be distinct instruments');
    }
  }
  if (eventKind === 'CONVERSION') {
    const from = participants.find((x) => x.participantRole === 'CONVERTED_FROM');
    const to = participants.find((x) => x.participantRole === 'CONVERTED_TO');
    if (from && to && from.instrumentIdentityId === to.instrumentIdentityId) {
      throw new CorporateActionError('CORPORATE_ACTION_PARTICIPANT_ROLE_CONFLICT', 'CONVERTED_FROM and CONVERTED_TO must be distinct instruments');
    }
  }
}

function assertRevisionReasonInvariants(revision, parent) {
  const { revisionDisposition, revisionReasonCode, eventKind, supersedesRevisionId } = revision;
  if (supersedesRevisionId === null) {
    if (revisionDisposition !== 'ASSERTED' || revisionReasonCode !== 'INITIAL_ASSERTION') {
      throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'first revision must be ASSERTED with INITIAL_ASSERTION');
    }
    return;
  }
  if (!parent) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'revision parent is required');
  if (revisionReasonCode === 'INITIAL_ASSERTION') {
    throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'INITIAL_ASSERTION cannot supersede another revision');
  }
  if (revisionReasonCode === 'ECONOMIC_CORRECTION') {
    if (revisionDisposition !== 'ASSERTED' || eventKind !== parent.eventKind) {
      throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'ECONOMIC_CORRECTION requires ASSERTED disposition and unchanged eventKind');
    }
    return;
  }
  if (revisionReasonCode === 'EVENT_KIND_RECLASSIFICATION') {
    if (revisionDisposition !== 'ASSERTED' || eventKind === parent.eventKind) {
      throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'EVENT_KIND_RECLASSIFICATION requires ASSERTED disposition and a changed eventKind');
    }
    return;
  }
  if (revisionReasonCode === 'CANCELLATION') {
    if (revisionDisposition !== 'CANCELS_EVENT' || eventKind !== parent.eventKind) {
      throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'CANCELLATION requires CANCELS_EVENT and unchanged eventKind');
    }
    return;
  }
  if (revisionReasonCode === 'RESTORATION') {
    if (revisionDisposition !== 'ASSERTED' || parent.revisionDisposition !== 'CANCELS_EVENT' || eventKind !== parent.eventKind) {
      throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', 'RESTORATION must restore the cancelled classification without silent reclassification');
    }
  }
}

function verifyRevisionReferences(store, revision, revisionId = null) {
  verifyCorporateActionIdentity({ store, corporateActionIdentityId: revision.corporateActionIdentityId }); verifyTemporal(store, revision);
  const participants = revision.participantCoreIds.map((participantCoreId) => verifyCorporateActionParticipant({ store, participantCoreId }).participantCore);
  if (participants.some((x) => x.corporateActionIdentityId !== revision.corporateActionIdentityId)) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', 'revision participant belongs to another event');
  assertParticipantRoleCardinality(revision.eventKind, participants);
  let parent = null;
  if (revision.supersedesRevisionId) {
    if (revision.supersedesRevisionId === revisionId) throw new CorporateActionError('CORPORATE_ACTION_REVISION_BRANCH', 'revision cannot supersede itself');
    parent = readCorporateActionObject(store, revision.supersedesRevisionId, CA.REVISION, 'superseded revision');
    if (parent.corporateActionIdentityId !== revision.corporateActionIdentityId) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', 'revision parent belongs to another event');
    const seen = new Set([revisionId].filter(Boolean)); let cursor = parent;
    while (cursor.supersedesRevisionId) { if (seen.has(cursor.supersedesRevisionId)) throw new CorporateActionError('CORPORATE_ACTION_REVISION_BRANCH', 'revision cycle detected'); seen.add(cursor.supersedesRevisionId); cursor = readCorporateActionObject(store, cursor.supersedesRevisionId, CA.REVISION, 'revision ancestor'); }
  }
  assertRevisionReasonInvariants(revision, parent);
  return participants;
}
export function buildCorporateActionRevision(input) { exactInput(input, ['revision']); const c = normalizeCorporateActionCanonicalValue(CA.REVISION, input.revision); const participants = verifyRevisionReferences(input.store, c); const stored = build(input.store, CA.REVISION, c, 'revisionCoreId', 'revisionCore'); return { ...stored, participants }; }
export function verifyCorporateActionRevision(input) { const out = verify(input, CA.REVISION, 'revisionCoreId', 'revisionCore'); const participants = verifyRevisionReferences(input.store, out.revisionCore, input.revisionCoreId); return { ...out, participants }; }

const REVISION_REASON_TO_DECISION = Object.freeze({
  ECONOMIC_CORRECTION: 'ECONOMIC_CORRECTION_APPROVED',
  EVENT_KIND_RECLASSIFICATION: 'EVENT_KIND_RECLASSIFICATION_APPROVED',
  CANCELLATION: 'CANCELLATION_APPROVED',
  RESTORATION: 'RESTORATION_APPROVED',
});

function verifyAdjudicationReferences(store, a, adjudicationId = null) {
  verifyTemporal(store, a); const revision = verifyCorporateActionRevision({ store, revisionCoreId: a.selectedRevisionId }).revisionCore;
  if (revision.corporateActionIdentityId !== a.corporateActionIdentityId || revision.knowledgeTimeUpperBound > a.knowledgeTimeUpperBound) throw new CorporateActionError('CORPORATE_ACTION_FUTURE_INFORMATION', 'selected revision is foreign or future');
  verifyCorporateActionPolicy({ store, policyId: a.adjudicationPolicyId, schemaVersion: CA.ADJUDICATION_POLICY });
  const observations = a.consideredObservationIds.map((observationCoreId) => verifyCorporateActionObservation({ store, observationCoreId }).observationCore);
  if (observations.some((x) => x.corporateActionIdentityId !== a.corporateActionIdentityId)) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', 'adjudication observation belongs to another event');
  const requiredDecision = REVISION_REASON_TO_DECISION[revision.revisionReasonCode];
  if (requiredDecision && !a.decisionReasonCodes.includes(requiredDecision)) {
    if (revision.revisionReasonCode === 'EVENT_KIND_RECLASSIFICATION') {
      throw new CorporateActionError('CORPORATE_ACTION_EVENT_KIND_RECLASSIFICATION_REQUIRED', 'reclassification adjudication must include EVENT_KIND_RECLASSIFICATION_APPROVED');
    }
    throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `adjudication must include ${requiredDecision}`);
  }
  if (a.supersedesAdjudicationId) {
    if (a.supersedesAdjudicationId === adjudicationId) throw new CorporateActionError('CORPORATE_ACTION_ADJUDICATION_CONFLICT', 'adjudication cannot supersede itself');
    const parent = readCorporateActionObject(store, a.supersedesAdjudicationId, CA.ADJUDICATION, 'superseded adjudication');
    if (parent.corporateActionIdentityId !== a.corporateActionIdentityId) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', 'adjudication parent belongs to another event');
    if (parent.consideredObservationIds.some((x) => !a.consideredObservationIds.includes(x))) throw new CorporateActionError('CORPORATE_ACTION_ADJUDICATION_APPEND_ONLY_VIOLATION', 'considered observations cannot be removed');
  }
  return { revision, observations };
}
export function buildCorporateActionAdjudication(input) { exactInput(input, ['adjudication']); const c = normalizeCorporateActionCanonicalValue(CA.ADJUDICATION, input.adjudication); const refs = verifyAdjudicationReferences(input.store, c); return { ...build(input.store, CA.ADJUDICATION, c, 'adjudicationCoreId', 'adjudicationCore'), ...refs }; }
export function verifyCorporateActionAdjudication(input) { const out = verify(input, CA.ADJUDICATION, 'adjudicationCoreId', 'adjudicationCore'); return { ...out, ...verifyAdjudicationReferences(input.store, out.adjudicationCore, input.adjudicationCoreId) }; }
