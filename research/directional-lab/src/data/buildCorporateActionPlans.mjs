/** L2C price/entitlement plans and snapshot bindings (downstream of registry). */

import { CA, CorporateActionError, isSortedIdSubset, normalizeCorporateActionCanonicalValue } from '../contracts/corporateActionL2CV1.mjs';
import { DATASET_SNAPSHOT_CORE_SCHEMA_VERSION } from '../contracts/datasetSnapshotV1.mjs';
import { sortedUniqueStrings } from '../contracts/contractPrimitivesV1.mjs';
import { assertCorporateActionInput, putCorporateActionObject, readCorporateActionObject } from './corporateActionStore.mjs';
import { resolveCorporateActionsAsOf, verifyCorporateActionRegistry } from './buildCorporateActionRegistry.mjs';
import { verifyCorporateActionPolicy } from './corporateActionBuildersCore.mjs';

function exact(input, allowed) {
  assertCorporateActionInput(input); const fields = new Set(['store', ...allowed]);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new CorporateActionError('CORPORATE_ACTION_INPUT_INVALID', `unknown field: ${key}`);
}
function save(store, schema, value, idName, valueName) {
  const normalized = normalizeCorporateActionCanonicalValue(schema, value); const stored = putCorporateActionObject(store, schema, normalized);
  return { [idName]: stored.objectId, [valueName]: stored.value, object: stored };
}
function readPlan(store, id, schema, label) { return readCorporateActionObject(store, id, schema, label); }
function invert(r) { return { numerator: r.denominator, denominator: r.numerator }; }
function copyRatio(r) { return { numerator: r.numerator, denominator: r.denominator }; }

export function buildCorporateActionPriceAdjustmentPlan(input) {
  exact(input, ['registryManifestId', 'knowledgeCutoff', 'instrumentIdentityId', 'economicRange', 'priceBasis', 'providerAdjustmentDeclaration']);
  const registry = verifyCorporateActionRegistry({ store: input.store, registryManifestId: input.registryManifestId });
  const policy = verifyCorporateActionPolicy({ store: input.store, policyId: registry.registryManifest.priceAdjustmentPolicyId, schemaVersion: CA.PRICE_POLICY }).policy;
  if (!policy.supportedPriceBases.includes(input.priceBasis)) throw new CorporateActionError('CORPORATE_ACTION_ADJUSTMENT_UNSUPPORTED', 'price basis is not enabled by policy');
  const resolved = resolveCorporateActionsAsOf({ store: input.store, registryManifestId: input.registryManifestId, knowledgeCutoff: input.knowledgeCutoff,
    instrumentIdentityId: input.instrumentIdentityId ?? null, economicRange: input.economicRange ?? null });
  const active = resolved.results.filter((x) => x.status === 'RESOLVED');
  const unsupported = active.filter((x) => ['MERGER_CASH', 'MERGER_STOCK', 'MERGER_MIXED', 'SPIN_OFF', 'CONVERSION', 'RETURN_OF_CAPITAL'].includes(x.revision.eventKind));
  if (input.priceBasis !== 'RAW' && unsupported.length) throw new CorporateActionError('CORPORATE_ACTION_ADJUSTMENT_UNSUPPORTED', 'complex or non-cash adjustment producer is unavailable in V1');
  if (input.priceBasis === 'PROVIDER_ADJUSTED') {
    const declaration = input.providerAdjustmentDeclaration;
    if (!declaration || declaration.providerPolicyId !== registry.registryManifest.priceAdjustmentPolicyId
      || declaration.providerCutoff > input.knowledgeCutoff) {
      throw new CorporateActionError('CORPORATE_ACTION_DOUBLE_ADJUSTMENT_RISK', 'provider adjustment declaration is absent or inconsistent');
    }
  }
  const splitEvents = active.filter((x) => ['FORWARD_SPLIT', 'REVERSE_SPLIT', 'STOCK_DIVIDEND'].includes(x.revision.eventKind));
  const adjustments = input.priceBasis === 'SPLIT_ADJUSTED' ? splitEvents.map((x) => ({
    corporateActionIdentityId: x.corporateActionIdentityId, effectiveDate: x.revision.economicPayload.effectiveDate,
    ohlcFactor: invert(x.revision.economicPayload.ratio), volumeFactor: copyRatio(x.revision.economicPayload.ratio), sharesFactor: copyRatio(x.revision.economicPayload.ratio),
  })).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.corporateActionIdentityId.localeCompare(b.corporateActionIdentityId)) : [];
  const influencingEventIds = input.priceBasis === 'RAW' ? [] : sortedUniqueStrings((input.priceBasis === 'SPLIT_ADJUSTED' ? splitEvents : active).map((x) => x.corporateActionIdentityId));
  return save(input.store, CA.PRICE_PLAN, { schemaVersion: CA.PRICE_PLAN, registryManifestId: input.registryManifestId,
    priceAdjustmentPolicyId: registry.registryManifest.priceAdjustmentPolicyId, knowledgeCutoff: input.knowledgeCutoff,
    instrumentIdentityId: input.instrumentIdentityId ?? null, economicRange: input.economicRange ?? null, priceBasis: input.priceBasis,
    providerAdjustmentDeclaration: input.providerAdjustmentDeclaration ?? null, adjustments, influencingEventIds }, 'priceAdjustmentPlanId', 'priceAdjustmentPlan');
}
export function verifyCorporateActionPriceAdjustmentPlan(input) {
  exact(input, ['priceAdjustmentPlanId']); const plan = readPlan(input.store, input.priceAdjustmentPlanId, CA.PRICE_PLAN, 'price adjustment plan');
  const rebuilt = buildCorporateActionPriceAdjustmentPlan({ store: input.store, registryManifestId: plan.registryManifestId, knowledgeCutoff: plan.knowledgeCutoff, instrumentIdentityId: plan.instrumentIdentityId, economicRange: plan.economicRange, priceBasis: plan.priceBasis, providerAdjustmentDeclaration: plan.providerAdjustmentDeclaration });
  if (rebuilt.priceAdjustmentPlanId !== input.priceAdjustmentPlanId) throw new CorporateActionError('CORPORATE_ACTION_REFERENCE_CORRUPT', 'price adjustment plan does not match authoritative recomputation');
  return { priceAdjustmentPlanId: input.priceAdjustmentPlanId, priceAdjustmentPlan: plan };
}

export function buildCorporateActionEntitlementPlan(input) {
  exact(input, ['registryManifestId', 'knowledgeCutoff', 'instrumentIdentityId', 'economicRange']);
  const registry = verifyCorporateActionRegistry({ store: input.store, registryManifestId: input.registryManifestId });
  verifyCorporateActionPolicy({ store: input.store, policyId: registry.registryManifest.entitlementPolicyId, schemaVersion: CA.ENTITLEMENT_POLICY });
  const resolved = resolveCorporateActionsAsOf({ store: input.store, registryManifestId: input.registryManifestId, knowledgeCutoff: input.knowledgeCutoff,
    instrumentIdentityId: input.instrumentIdentityId ?? null, economicRange: input.economicRange ?? null });
  const active = resolved.results.filter((x) => x.status === 'RESOLVED'); const entitlements = [];
  for (const x of active) {
    const kind = x.revision.eventKind; const payload = x.revision.economicPayload;
    if (['FORWARD_SPLIT', 'REVERSE_SPLIT', 'STOCK_DIVIDEND'].includes(kind)) entitlements.push({ corporateActionIdentityId: x.corporateActionIdentityId, effectiveDate: payload.effectiveDate, entitlementKind: 'QUANTITY', ratio: copyRatio(payload.ratio), cashAmount: null });
    else if (['CASH_DIVIDEND_ORDINARY', 'CASH_DIVIDEND_SPECIAL'].includes(kind)) entitlements.push({ corporateActionIdentityId: x.corporateActionIdentityId, effectiveDate: payload.effectiveDate, entitlementKind: 'CASH', ratio: null, cashAmount: { ...payload.cashAmount } });
    else if (['RETURN_OF_CAPITAL', 'MERGER_CASH', 'MERGER_STOCK', 'MERGER_MIXED', 'SPIN_OFF', 'CONVERSION'].includes(kind)) throw new CorporateActionError('CORPORATE_ACTION_ENTITLEMENT_UNSUPPORTED', 'complete entitlement rules are unavailable for this event kind');
  }
  entitlements.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.corporateActionIdentityId.localeCompare(b.corporateActionIdentityId));
  return save(input.store, CA.ENTITLEMENT_PLAN, { schemaVersion: CA.ENTITLEMENT_PLAN, registryManifestId: input.registryManifestId,
    entitlementPolicyId: registry.registryManifest.entitlementPolicyId, knowledgeCutoff: input.knowledgeCutoff,
    instrumentIdentityId: input.instrumentIdentityId ?? null, economicRange: input.economicRange ?? null, entitlements,
    influencingEventIds: sortedUniqueStrings(entitlements.map((x) => x.corporateActionIdentityId)) }, 'entitlementPlanId', 'entitlementPlan');
}
export function verifyCorporateActionEntitlementPlan(input) {
  exact(input, ['entitlementPlanId']); const plan = readPlan(input.store, input.entitlementPlanId, CA.ENTITLEMENT_PLAN, 'entitlement plan');
  const rebuilt = buildCorporateActionEntitlementPlan({ store: input.store, registryManifestId: plan.registryManifestId, knowledgeCutoff: plan.knowledgeCutoff, instrumentIdentityId: plan.instrumentIdentityId, economicRange: plan.economicRange });
  if (rebuilt.entitlementPlanId !== input.entitlementPlanId) throw new CorporateActionError('CORPORATE_ACTION_REFERENCE_CORRUPT', 'entitlement plan does not match authoritative recomputation');
  return { entitlementPlanId: input.entitlementPlanId, entitlementPlan: plan };
}

function verifyPlanManifestValue(store, manifest, manifestId = null) {
  verifyCorporateActionRegistry({ store, registryManifestId: manifest.registryManifestId });
  const pricePlans = manifest.priceAdjustmentPlanIds.map((priceAdjustmentPlanId) => verifyCorporateActionPriceAdjustmentPlan({ store, priceAdjustmentPlanId }));
  const entitlementPlans = manifest.entitlementPlanIds.map((entitlementPlanId) => verifyCorporateActionEntitlementPlan({ store, entitlementPlanId }));
  for (const x of [...pricePlans.map((p) => p.priceAdjustmentPlan), ...entitlementPlans.map((p) => p.entitlementPlan)]) if (x.registryManifestId !== manifest.registryManifestId || x.knowledgeCutoff !== manifest.knowledgeCutoff) throw new CorporateActionError('CORPORATE_ACTION_IDENTITY_MISMATCH', 'plan manifest mixes registry or cutoff');
  const seen = new Set(manifestId ? [manifestId] : []); let child = manifest;
  while (child.supersedesPlanManifestId) {
    if (seen.has(child.supersedesPlanManifestId)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_CYCLE', 'plan manifest cycle'); seen.add(child.supersedesPlanManifestId);
    const parent = readPlan(store, child.supersedesPlanManifestId, CA.PLAN_MANIFEST, 'plan manifest ancestor');
    if (parent.registryManifestId !== manifest.registryManifestId || parent.knowledgeCutoff !== manifest.knowledgeCutoff || !isSortedIdSubset(parent.priceAdjustmentPlanIds, child.priceAdjustmentPlanIds) || !isSortedIdSubset(parent.entitlementPlanIds, child.entitlementPlanIds)) throw new CorporateActionError('CORPORATE_ACTION_MANIFEST_APPEND_ONLY_VIOLATION', 'plan manifest is not append-only'); child = parent;
  }
  return { pricePlans, entitlementPlans };
}
export function buildCorporateActionPlanManifest(input) { exact(input, ['registryManifestId', 'knowledgeCutoff', 'priceAdjustmentPlanIds', 'entitlementPlanIds', 'supersedesPlanManifestId']); const c = normalizeCorporateActionCanonicalValue(CA.PLAN_MANIFEST, { schemaVersion: CA.PLAN_MANIFEST, registryManifestId: input.registryManifestId, knowledgeCutoff: input.knowledgeCutoff, priceAdjustmentPlanIds: sortedUniqueStrings(input.priceAdjustmentPlanIds ?? []), entitlementPlanIds: sortedUniqueStrings(input.entitlementPlanIds ?? []), supersedesPlanManifestId: input.supersedesPlanManifestId ?? null }); const refs = verifyPlanManifestValue(input.store, c); return { ...save(input.store, CA.PLAN_MANIFEST, c, 'planManifestId', 'planManifest'), ...refs }; }
export function verifyCorporateActionPlanManifest(input) { exact(input, ['planManifestId']); const planManifest = readPlan(input.store, input.planManifestId, CA.PLAN_MANIFEST, 'plan manifest'); return { planManifestId: input.planManifestId, planManifest, ...verifyPlanManifestValue(input.store, planManifest, input.planManifestId) }; }

/**
 * Structural verification of one snapshot binding. This does NOT prove
 * authoritative uniqueness across CAS roots — only that the binding object
 * is internally coherent. Uniqueness is guaranteed solely for a pinned
 * DatasetSnapshotCorporateActionBindingRegistryManifest/1 via
 * resolveDatasetSnapshotCorporateActionBinding.
 */
function verifyBindingValue(store, binding) {
  readCorporateActionObject(store, binding.snapshotCoreId, DATASET_SNAPSHOT_CORE_SCHEMA_VERSION, 'dataset snapshot core');
  const registry = verifyCorporateActionRegistry({ store, registryManifestId: binding.registryManifestId }); const plans = [];
  if (binding.priceAdjustmentPlanId) plans.push(verifyCorporateActionPriceAdjustmentPlan({ store, priceAdjustmentPlanId: binding.priceAdjustmentPlanId }).priceAdjustmentPlan);
  if (binding.entitlementPlanId) plans.push(verifyCorporateActionEntitlementPlan({ store, entitlementPlanId: binding.entitlementPlanId }).entitlementPlan);
  for (const plan of plans) if (plan.registryManifestId !== binding.registryManifestId || plan.knowledgeCutoff !== binding.knowledgeCutoff) throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT', 'binding plan uses another registry or cutoff');
  const expectedEvents = sortedUniqueStrings(plans.flatMap((p) => p.influencingEventIds));
  if (expectedEvents.join('|') !== binding.influencingEventIds.join('|')) throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT', 'influencing events do not match plans');
  for (const eventId of binding.influencingEventIds) if (!registry.eventTips.has(eventId)) throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT', 'influencing event is absent from registry');
  return { registry, plans };
}
export function buildDatasetSnapshotCorporateActionBinding(input) { exact(input, ['snapshotCoreId', 'registryManifestId', 'priceAdjustmentPlanId', 'entitlementPlanId', 'knowledgeCutoff', 'influencingEventIds']); const c = normalizeCorporateActionCanonicalValue(CA.SNAPSHOT_BINDING, { schemaVersion: CA.SNAPSHOT_BINDING, snapshotCoreId: input.snapshotCoreId, registryManifestId: input.registryManifestId, priceAdjustmentPlanId: input.priceAdjustmentPlanId ?? null, entitlementPlanId: input.entitlementPlanId ?? null, knowledgeCutoff: input.knowledgeCutoff, influencingEventIds: sortedUniqueStrings(input.influencingEventIds ?? []) }); const refs = verifyBindingValue(input.store, c); return { ...save(input.store, CA.SNAPSHOT_BINDING, c, 'snapshotCorporateActionBindingId', 'snapshotCorporateActionBinding'), ...refs }; }
export function verifyDatasetSnapshotCorporateActionBinding(input) { exact(input, ['snapshotCorporateActionBindingId']); const binding = readPlan(input.store, input.snapshotCorporateActionBindingId, CA.SNAPSHOT_BINDING, 'snapshot corporate-action binding'); return { snapshotCorporateActionBindingId: input.snapshotCorporateActionBindingId, snapshotCorporateActionBinding: binding, ...verifyBindingValue(input.store, binding) }; }

function bindingSignature(binding) {
  return [binding.registryManifestId, binding.priceAdjustmentPlanId, binding.entitlementPlanId, binding.knowledgeCutoff, ...binding.influencingEventIds].join('|');
}

function verifyBindingRegistryValue(store, registry, registryId = null) {
  const authority = readPlan(store, registry.bindingAuthorityPolicyId, CA.BINDING_AUTHORITY_POLICY, 'binding authority policy');
  const bindings = registry.bindingIds.map((snapshotCorporateActionBindingId) => (
    verifyDatasetSnapshotCorporateActionBinding({ store, snapshotCorporateActionBindingId })
  ));
  const bySnapshot = new Map();
  for (const entry of bindings) {
    const binding = entry.snapshotCorporateActionBinding;
    const previous = bySnapshot.get(binding.snapshotCoreId);
    if (!previous) {
      bySnapshot.set(binding.snapshotCoreId, binding);
      continue;
    }
    if (bindingSignature(previous) !== bindingSignature(binding)) {
      throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT',
        'pinned binding registry contains contradictory bindings for one snapshot');
    }
  }
  const seen = new Set(registryId ? [registryId] : []);
  let child = registry;
  while (child.supersedesBindingRegistryManifestId) {
    const parentId = child.supersedesBindingRegistryManifestId;
    if (seen.has(parentId)) throw new CorporateActionError('CORPORATE_ACTION_BINDING_REGISTRY_CYCLE', 'binding registry supersedes cycle');
    seen.add(parentId);
    const parent = readPlan(store, parentId, CA.BINDING_REGISTRY, 'binding registry ancestor');
    if (parent.bindingAuthorityPolicyId !== registry.bindingAuthorityPolicyId) {
      throw new CorporateActionError('CORPORATE_ACTION_BINDING_REGISTRY_AUTHORITY_MISMATCH', 'binding registry authority policy changed across the chain');
    }
    if (!isSortedIdSubset(parent.bindingIds, child.bindingIds)) {
      throw new CorporateActionError('CORPORATE_ACTION_BINDING_REGISTRY_APPEND_ONLY_VIOLATION', 'bindingIds were removed from binding registry');
    }
    parent.bindingIds.forEach((snapshotCorporateActionBindingId) => {
      verifyDatasetSnapshotCorporateActionBinding({ store, snapshotCorporateActionBindingId });
    });
    child = parent;
  }
  return { authorityPolicy: authority, bindings };
}

export function buildDatasetSnapshotCorporateActionBindingAuthorityPolicy(input) {
  exact(input, ['authorityId', 'registryNamespaceVersion']);
  return save(input.store, CA.BINDING_AUTHORITY_POLICY, {
    schemaVersion: CA.BINDING_AUTHORITY_POLICY,
    authorityId: input.authorityId,
    registryNamespaceVersion: input.registryNamespaceVersion,
  }, 'bindingAuthorityPolicyId', 'bindingAuthorityPolicy');
}

export function verifyDatasetSnapshotCorporateActionBindingAuthorityPolicy(input) {
  exact(input, ['bindingAuthorityPolicyId']);
  const bindingAuthorityPolicy = readPlan(input.store, input.bindingAuthorityPolicyId, CA.BINDING_AUTHORITY_POLICY, 'binding authority policy');
  return { bindingAuthorityPolicyId: input.bindingAuthorityPolicyId, bindingAuthorityPolicy };
}

export function buildDatasetSnapshotCorporateActionBindingRegistry(input) {
  exact(input, ['bindingAuthorityPolicyId', 'bindingIds', 'supersedesBindingRegistryManifestId']);
  const c = normalizeCorporateActionCanonicalValue(CA.BINDING_REGISTRY, {
    schemaVersion: CA.BINDING_REGISTRY,
    bindingAuthorityPolicyId: input.bindingAuthorityPolicyId,
    bindingIds: sortedUniqueStrings(input.bindingIds ?? []),
    supersedesBindingRegistryManifestId: input.supersedesBindingRegistryManifestId ?? null,
  });
  const refs = verifyBindingRegistryValue(input.store, c);
  return {
    ...save(input.store, CA.BINDING_REGISTRY, c, 'bindingRegistryManifestId', 'bindingRegistryManifest'),
    ...refs,
  };
}

export function verifyDatasetSnapshotCorporateActionBindingRegistry(input) {
  exact(input, ['bindingRegistryManifestId']);
  const bindingRegistryManifest = readPlan(input.store, input.bindingRegistryManifestId, CA.BINDING_REGISTRY, 'binding registry');
  return {
    bindingRegistryManifestId: input.bindingRegistryManifestId,
    bindingRegistryManifest,
    ...verifyBindingRegistryValue(input.store, bindingRegistryManifest, input.bindingRegistryManifestId),
  };
}

export const recoverDatasetSnapshotCorporateActionBindingRegistry = verifyDatasetSnapshotCorporateActionBindingRegistry;

/**
 * Official authoritative resolver. Accepts only a pinned binding registry ID
 * and a snapshot core ID. For that pinned registry, a snapshot has at most one
 * coherent binding. Free binding arrays are refused.
 */
export function resolveDatasetSnapshotCorporateActionBinding(input) {
  exact(input, ['bindingRegistryManifestId', 'snapshotCoreId']);
  const registry = verifyDatasetSnapshotCorporateActionBindingRegistry({
    store: input.store,
    bindingRegistryManifestId: input.bindingRegistryManifestId,
  });
  const matches = registry.bindings.filter(
    (entry) => entry.snapshotCorporateActionBinding.snapshotCoreId === input.snapshotCoreId,
  );
  if (matches.length === 0) {
    throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_NOT_FOUND',
      'no binding for snapshot in the pinned binding registry');
  }
  const signatures = new Set(matches.map((entry) => bindingSignature(entry.snapshotCorporateActionBinding)));
  if (signatures.size > 1) {
    throw new CorporateActionError('CORPORATE_ACTION_SNAPSHOT_BINDING_CONFLICT',
      'pinned binding registry has contradictory bindings for the snapshot');
  }
  return {
    bindingRegistryManifestId: input.bindingRegistryManifestId,
    snapshotCoreId: input.snapshotCoreId,
    snapshotCorporateActionBindingId: matches[0].snapshotCorporateActionBindingId,
    snapshotCorporateActionBinding: matches[0].snapshotCorporateActionBinding,
  };
}

export const recoverDatasetSnapshotCorporateActionBinding = verifyDatasetSnapshotCorporateActionBinding;
