#!/usr/bin/env node
// generate-genesis-import-source-map (R3 PROVENANCE BINDING AND FINALIZATION CLOSURE)
//
// Canonical generation mode accepts NO template as a normative input.
// --source-map-template and --provenance-template are rejected outright
// (defect B02). Prior payloads may only be supplied as --golden-map /
// --golden-provenance, which are read strictly AFTER the output bytes are
// frozen and can never influence them.
//
// Every normative input is hash-pinned by the reconstruction rule, and the rule
// itself is hash-pinned by --expect-rule-sha256 when the caller knows it.
// The map and its provenance are produced in the same pass, so no row can exist
// without the derivation that produced it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const has = (name) => args.includes(name);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function fail(code, details = {}) {
  process.stdout.write(JSON.stringify({ valid: false, code, ...details }) + '\n');
  process.exit(2);
}

// ---------------------------------------------------------------- B02 guard
const FORBIDDEN_TEMPLATE_FLAGS = ['--source-map-template', '--provenance-template', '--map-template', '--field-provenance-template'];
for (const flag of FORBIDDEN_TEMPLATE_FLAGS) {
  if (has(flag)) fail('NORMATIVE_TEMPLATE_INPUT_FORBIDDEN', { argument: flag, defect: 'B02', remedy: 'Supply prior payloads as --golden-map / --golden-provenance for post-generation comparison only.' });
}

const REQUIRED = ['--rule', '--source-root', '--normative-input-registry', '--transformation-registry',
  '--semantic-classification-registry', '--owner-policy-registry', '--primitive-lib',
  '--out-map', '--out-provenance', '--summary'];
for (const name of REQUIRED) if (!option(name)) fail('MISSING_CLI_ARGUMENT', { argument: name });

const sourceRoot = path.resolve(option('--source-root'));
const consumption = new Map();
function readBytes(file, code, inputId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail(code, { path: file, inputId });
  const bytes = fs.readFileSync(file);
  if (inputId) consumption.set(inputId, { path: file, sha256: sha(bytes), bytesRead: bytes.length, actuallyConsumed: false });
  return bytes;
}
const readJson = (file, code, inputId) => {
  const bytes = readBytes(file, code, inputId);
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { fail(code, { path: file, message: error.message }); }
};
const consume = (inputId, rulesUsed) => {
  const row = consumption.get(inputId);
  if (!row) fail('UNDECLARED_INPUT', { inputId });
  row.actuallyConsumed = true;
  row.usedByRules = [...new Set([...(row.usedByRules || []), ...rulesUsed])];
};

// ---------------------------------------------------------------- rule (B01)
const ruleBytes = readBytes(option('--rule'), 'MISSING_RECONSTRUCTION_RULE', 'RECONSTRUCTION_RULE');
const ruleSha = sha(ruleBytes);
let rule;
try { rule = JSON.parse(ruleBytes.toString('utf8')); } catch (e) { fail('MISSING_RECONSTRUCTION_RULE', { message: e.message }); }
const expectRuleSha = option('--expect-rule-sha256');
if (expectRuleSha && expectRuleSha !== ruleSha) fail('RECONSTRUCTION_RULE_HASH_MISMATCH', { expected: expectRuleSha, actual: ruleSha });
if (rule.reconstructionRuleId !== 'GENESIS_IMPORT_SOURCE_MAP_DETERMINISTIC_RECONSTRUCTION_RULE_R2') fail('UNKNOWN_RECONSTRUCTION_RULE', { actual: rule.reconstructionRuleId });
if (rule.ruleVersion !== 'R3_PROVENANCE_BINDING_AND_FINALIZATION_CLOSURE_V1') fail('UNKNOWN_RECONSTRUCTION_RULE', { ruleVersion: rule.ruleVersion });
if (rule.deterministicReconstruction !== true || rule.historicalOriginal !== false) fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { field: 'deterministicReconstruction|historicalOriginal' });
for (const section of ['implementationAuthorities', 'allowedInputs', 'normativeSources', 'fieldDerivationRules', 'fallbackRules', 'sourceAuthorityBindings', 'provenanceBindingPolicy', 'transformationContractPolicy',
  'unresolvedHistoricalDetailsPolicy', 'primitiveCoveragePolicy', 'provenanceRequirements', 'deterministicOutputRequirements',
  'failureConditions', 'ledgerImmutabilityRequirement', 'genesisImportTreatment', 'srcR1ExternalPassTreatment', 'sourceSelectionOrder']) {
  if (rule[section] === undefined || rule[section] === null) fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { missingSection: section });
}
// forbiddenClaims are mandatory and must be substantively complete.
const REQUIRED_CLAIMS = ['historical source recovered when not demonstrated', 'source authority invented',
  'unresolved history presented as known', 'unknown transformation accepted', 'unknown semantic class accepted',
  'unknown owner policy accepted', 'source pointer not resolved', 'normative source hash mismatch ignored',
  'template used as normative generation input', 'uncovered primitive field accepted'];
if (!Array.isArray(rule.forbiddenClaims) || rule.forbiddenClaimsMandatory !== true) fail('MISSING_FORBIDDEN_CLAIMS_POLICY', {});
if (rule.forbiddenClaims.length < (rule.forbiddenClaimsMinimumCount ?? 10)) fail('MISSING_FORBIDDEN_CLAIMS_POLICY', { count: rule.forbiddenClaims.length });
const missingClaims = REQUIRED_CLAIMS.filter((c) => !rule.forbiddenClaims.includes(c));
if (missingClaims.length) fail('MISSING_FORBIDDEN_CLAIMS_POLICY', { missingClaims });
consumption.get('RECONSTRUCTION_RULE').semanticRole = 'DETERMINISTIC_RECONSTRUCTION_RULE';
consume('RECONSTRUCTION_RULE', ['RULE_AUTHORITY_ENFORCEMENT', 'DERIVE_STATUS_DERIVATION_NARRATIVE', 'DERIVE_UNRESOLVED_HISTORICAL_DETAILS_V1']);

// -------------------------------------------------- implementation authorities
const IA = rule.implementationAuthorities;
const authorityFiles = {
  normativeInputRegistry: [option('--normative-input-registry'), IA.normativeInputRegistrySha256, 'NORMATIVE_INPUT_REGISTRY_HASH_MISMATCH', 'MISSING_NORMATIVE_INPUT_REGISTRY'],
  transformationRegistry: [option('--transformation-registry'), IA.transformationRegistrySha256, 'TRANSFORMATION_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT'],
  semanticClassificationRegistry: [option('--semantic-classification-registry'), IA.semanticClassificationRegistrySha256, 'SEMANTIC_CLASSIFICATION_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT'],
  ownerPolicyRegistry: [option('--owner-policy-registry'), IA.ownerPolicyRegistrySha256, 'OWNER_POLICY_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT']
};
const authority = {};
for (const [key, [file, expected, mismatchCode, missingCode]] of Object.entries(authorityFiles)) {
  const bytes = readBytes(file, missingCode, key);
  const actual = sha(bytes);
  if (actual !== expected) fail(mismatchCode, { registry: key, expected, actual });
  authority[key] = JSON.parse(bytes.toString('utf8'));
  consume(key, ['AUTHORITY_ENFORCEMENT']);
}
const libPath = path.resolve(option('--primitive-lib'));
const libBytes = readBytes(libPath, 'MISSING_INPUT', 'primitiveLib');
const libSha = sha(libBytes);
if (libSha !== IA.primitiveLibSha256) fail('PRIMITIVE_LIB_HASH_MISMATCH', { expected: IA.primitiveLibSha256, actual: libSha });
const LIB = await import(pathToFileURL(libPath).href);
if (LIB.PRIMITIVE_LEAF_FILTERING_FORBIDDEN !== true) fail('PRIMITIVE_COVERAGE_FILTER_FORBIDDEN', {});
consume('primitiveLib', ['PRIMITIVE_COVERAGE']);
const { canonicalize, collectPrimitiveLeaves, resolveJsonPointer, POINTER_NOT_RESOLVED } = LIB;

// ------------------------------------------------------- normative data inputs
const inputRegistry = authority.normativeInputRegistry;
const pins = new Map(rule.allowedInputs.map((row) => [row.inputId, row.sha256]));
const inputPath = (inputId) => {
  const entry = (inputRegistry.entries || []).find((e) => e.inputId === inputId);
  if (!entry) fail('UNDECLARED_INPUT', { inputId });
  return path.join(sourceRoot, entry.relativePath);
};
const docs = {};
for (const entry of inputRegistry.entries) {
  const file = path.join(sourceRoot, entry.relativePath);
  const bytes = readBytes(file, 'MISSING_INPUT', entry.inputId);
  const actual = sha(bytes);
  const pinned = pins.get(entry.inputId);
  if (!pinned) fail('UNDECLARED_INPUT', { inputId: entry.inputId });
  if (actual !== pinned) fail('INPUT_HASH_MISMATCH', { inputId: entry.inputId, expected: pinned, actual });
  if (actual !== entry.sha256) fail('NORMATIVE_INPUT_REGISTRY_HASH_MISMATCH', { inputId: entry.inputId, registrySha256: entry.sha256, actual });
  consumption.get(entry.inputId).semanticRole = entry.semanticRole;
  docs[entry.inputId] = entry.mediaType === 'application/json' ? JSON.parse(bytes.toString('utf8'))
    : entry.mediaType === 'application/x-ndjson' ? bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
      : bytes.toString('utf8');
}
// Every declared normative source hash must match the real pinned bytes (defect B01).
for (const row of rule.normativeSources) {
  const observed = consumption.get(row.id);
  if (!observed) fail('UNKNOWN_DERIVATION_AUTHORITY', { normativeSourceId: row.id });
  if (observed.sha256 !== row.sha256) fail('NORMATIVE_SOURCE_HASH_MISMATCH', { normativeSourceId: row.id, declared: row.sha256, actual: observed.sha256 });
  consume(row.id, ['NORMATIVE_SOURCE_ENFORCEMENT']);
}

// -------------------------------------------- derivation authority enforcement
const transformations = new Map((authority.transformationRegistry.entries || []).map((e) => [e.transformationId, e]));
const semanticClasses = new Map((authority.semanticClassificationRegistry.classes || []).map((c) => [c.semanticClassId, c]));
const ownerPolicies = new Map((authority.ownerPolicyRegistry.entries || []).map((p) => [p.ownerPolicyId, p]));
if (!Array.isArray(rule.fieldDerivationRules) || rule.fieldDerivationRules.length < 8) fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { fieldDerivationRules: rule.fieldDerivationRules?.length });
for (const fdr of rule.fieldDerivationRules) {
  if (!transformations.has(fdr.transformationId)) fail('UNKNOWN_DERIVATION_AUTHORITY', { fieldDerivationRuleId: fdr.id, transformationId: fdr.transformationId });
  if (!semanticClasses.has(fdr.semanticClassId)) fail('UNKNOWN_DERIVATION_AUTHORITY', { fieldDerivationRuleId: fdr.id, semanticClassId: fdr.semanticClassId });
  if (!ownerPolicies.has(fdr.ownerPolicyReference)) fail('UNKNOWN_DERIVATION_AUTHORITY', { fieldDerivationRuleId: fdr.id, ownerPolicyReference: fdr.ownerPolicyReference });
  const cls = semanticClasses.get(fdr.semanticClassId);
  if (!cls.permittedTransformationIds.includes(fdr.transformationId)) fail('SEMANTIC_CLASS_TRANSFORMATION_NOT_ALLOWED', { fieldDerivationRuleId: fdr.id, semanticClassId: fdr.semanticClassId, transformationId: fdr.transformationId });
  const pol = ownerPolicies.get(fdr.ownerPolicyReference);
  if (!pol.authorizedTransformationIds.includes(fdr.transformationId)) fail('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { fieldDerivationRuleId: fdr.id, ownerPolicyReference: fdr.ownerPolicyReference, transformationId: fdr.transformationId });
  if (!pol.authorizedSemanticClassIds.includes(fdr.semanticClassId)) fail('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { fieldDerivationRuleId: fdr.id, ownerPolicyReference: fdr.ownerPolicyReference, semanticClassId: fdr.semanticClassId });
}
const FDR = new Map(rule.fieldDerivationRules.map((r) => [r.id, r]));

// ------------------------------------- pinned derived-rule engine cross-check
const engineEntry = inputRegistry.entries.find((e) => e.inputId === 'R7_DERIVED_RULE_ENGINE');
const engine = await import(pathToFileURL(path.join(sourceRoot, engineEntry.relativePath)).href);
const fallbackPolicy = rule.fallbackRules.unresolvedHistoricalDetailsPolicy;
if (fallbackPolicy.historicalOriginal !== false) fail('UNSUPPORTED_HISTORICAL_ORIGINAL_CLAIM', { section: 'unresolvedHistoricalDetailsPolicy' });
for (const c of fallbackPolicy.cases) {
  const produced = engine[authority.transformationRegistry.entries.find((e) => e.transformationId === fallbackPolicy.derivedRuleId).implementationFunction](
    { authorityKind: c.authorityKind, historicalDetailCompleteness: c.historicalDetailCompleteness });
  if (canonicalize(produced) !== canonicalize(c.details)) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { caseId: c.caseId, rule: c.details, engine: produced });
}
consume('R7_DERIVED_RULE_ENGINE', ['DERIVE_UNRESOLVED_HISTORICAL_DETAILS_V1']);
consume('R7_DERIVED_RULE_REGISTRY', ['DERIVE_UNRESOLVED_HISTORICAL_DETAILS_V1']);

// ---------------------------------------------------- specification enforcement
const spec = docs.R2_RECONSTRUCTION_SPEC;
if (!spec || typeof spec !== 'object') fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { missingSection: 'R2_RECONSTRUCTION_SPEC' });
consume('R2_RECONSTRUCTION_SPEC', ['ENFORCE_RECONSTRUCTION_SPECIFICATION']);
const r1RuleBody = docs.R1_RULE_BODY;
if (!r1RuleBody || typeof r1RuleBody !== 'object') fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { missingSection: 'R1_RULE_BODY' });
if (rule.ruleLineage?.predecessorRuleBody?.sha256 !== consumption.get('R1_RULE_BODY').sha256) fail('NORMATIVE_SOURCE_HASH_MISMATCH', { normativeSourceId: 'R1_RULE_BODY' });
consume('R1_RULE_BODY', ['ENFORCE_RULE_LINEAGE']);
// The rule's fallback payloads must agree with the ratified R1 rule body branches.
if (fallbackPolicy.r1RuleBodyCrossCheckRequired === true) {
  for (const c of fallbackPolicy.cases) {
    const pointer = '/perGateFieldDerivation/' + c.branchId + '/unresolvedHistoricalDetails';
    const ratified = resolveJsonPointer(r1RuleBody, pointer);
    if (ratified === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'R1_RULE_BODY', pointer });
    if (canonicalize(ratified) !== canonicalize(c.details)) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { caseId: c.caseId, pointer, ratified, rule: c.details });
  }
}
for (const [key, branchId] of [['registryFallback', 'REGISTRY_FALLBACK_branch'], ['externalAuthority', 'EXTERNAL_REPORT_branch']]) {
  const narrative = rule.fallbackRules.statusDerivation[key];
  const ratifiedProse = resolveJsonPointer(r1RuleBody, '/perGateFieldDerivation/' + branchId + '/statusDerivation');
  if (ratifiedProse === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'R1_RULE_BODY', pointer: '/perGateFieldDerivation/' + branchId + '/statusDerivation' });
  if (!String(ratifiedProse).includes(narrative)) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { field: 'statusDerivation', branchId, narrative });
}

// ============================================================ DERIVATION PASS
const ledger = docs.LEDGER;
const registry = docs.GATE_REGISTRY;
const report = docs.EXTERNAL_REPORT;
const ownerR6 = docs.R6_OWNER_DECISION;
const ownerR2 = docs.R2_OWNER_DECISION;
const sourceAuthority = docs.R6_SOURCE_AUTHORITY_REGISTRY;

// Compact JSON Schema subset checker for the registered transformationInputs contracts.
function schemaErrors(value, schema, pointer = '') {
  const out = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  if (types) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    if (!types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) { out.push({ pointer, reason: 'TYPE_MISMATCH', expected: types, actual }); return out; }
  }
  if (schema.enum && !schema.enum.some((e) => canonicalize(e) === canonicalize(value))) out.push({ pointer, reason: 'ENUM_MISMATCH' });
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, req)) out.push({ pointer, reason: 'MISSING_REQUIRED', field: req });
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k];
      if (sub) out.push(...schemaErrors(v, sub, pointer + '/' + k));
      else if (schema.additionalProperties === false) out.push({ pointer: pointer + '/' + k, reason: 'ADDITIONAL_PROPERTY_FORBIDDEN' });
    }
  }
  return out;
}

const provenance = [];
const emit = (row) => {
  const fdr = FDR.get(row.fieldDerivationRuleId);
  if (!fdr) fail('UNKNOWN_DERIVATION_AUTHORITY', { fieldDerivationRuleId: row.fieldDerivationRuleId });
  if (!new RegExp(fdr.targetPointerPattern).test(row.targetJsonPointer)) {
    fail('TARGET_POINTER_PATTERN_MISMATCH', { fieldDerivationRuleId: fdr.id, targetJsonPointer: row.targetJsonPointer, pattern: fdr.targetPointerPattern });
  }
  if (!fdr.allowedSourceArtifactIds.includes(row.sourceArtifactId)) {
    fail('SOURCE_AUTHORITY_RULE_MISMATCH', { fieldDerivationRuleId: fdr.id, sourceArtifactId: row.sourceArtifactId });
  }
  const transformation = transformations.get(fdr.transformationId);
  if (transformation.transformationVersion !== fdr.transformationVersion) {
    fail('TRANSFORMATION_VERSION_MISMATCH', { transformationId: fdr.transformationId, registry: transformation.transformationVersion, rule: fdr.transformationVersion });
  }
  const inputs = {
    targetJsonPointer: row.targetJsonPointer,
    targetField: row.targetField,
    sourceAuthorityId: row.sourceArtifactId,
    sourceIndex: row.sourceIndex ?? null,
    ...(row.extraInputs || {})
  };
  const inputErrors = schemaErrors(inputs, transformation.inputSchema);
  if (inputErrors.length) fail('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { fieldDerivationRuleId: fdr.id, transformationId: fdr.transformationId, targetJsonPointer: row.targetJsonPointer, errors: inputErrors });
  provenance.push({
    targetJsonPointer: row.targetJsonPointer,
    targetValueHash: sha(Buffer.from(canonicalize(row.value))),
    fieldDerivationRuleId: fdr.id,
    sourceArtifactId: row.sourceArtifactId,
    sourcePath: row.sourcePath ?? null,
    sourceSha256: row.sourceSha256 ?? null,
    sourceJsonPointer: row.sourceJsonPointer ?? null,
    rulePointer: row.rulePointer ?? null,
    transformationId: fdr.transformationId,
    transformationVersion: fdr.transformationVersion,
    transformationInputs: inputs,
    semanticClassId: fdr.semanticClassId,
    ownerPolicyReference: fdr.ownerPolicyReference,
    reconstructionRuleId: rule.reconstructionRuleId,
    historicalOriginal: false
  });
  return row.value;
};
const srcEntryIndex = (id) => (sourceAuthority.entries || []).findIndex((e) => e.sourceAuthorityId === id);
const srcEntry = (id) => {
  const i = srcEntryIndex(id);
  if (i < 0) fail('UNKNOWN_SOURCE_ID', { sourceAuthorityId: id });
  return { index: i, entry: sourceAuthority.entries[i] };
};
const REL = Object.fromEntries(inputRegistry.entries.map((e) => [e.inputId, e]));
const bind = (inputId) => ({ sourcePath: REL[inputId].relativePath, sourceSha256: consumption.get(inputId).sha256 });
const RULE_BIND = { sourceArtifactId: 'RECONSTRUCTION_RULE', sourcePath: null, sourceSha256: ruleSha };

// ---- top-level values from the R6 owner decision
const TOP = [
  ['document', 'COPY_TOP_LEVEL_FROM_R6_OWNER_DECISION'],
  ['schemaVersion', 'COPY_TOP_LEVEL_FROM_R6_OWNER_DECISION'],
  ['artifactClass', 'COPY_TOP_LEVEL_FROM_R6_OWNER_DECISION'],
  ['historicalOriginal', 'COPY_TOP_LEVEL_FROM_R6_OWNER_DECISION'],
  ['reconstructionRuleId', 'COPY_RECONSTRUCTION_METADATA_FROM_R6_OWNER_DECISION'],
  ['policy', 'COPY_POLICY_UNDER_OWNER_R2_AUTHORITY']
];
const map = {};
for (const [field, fdrId] of TOP) {
  const pointer = '/canonicalValues/' + field;
  const value = resolveJsonPointer(ownerR6, pointer);
  if (value === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'R6_OWNER_DECISION', pointer });
  map[field] = emit({
    targetJsonPointer: '/' + field, value, fieldDerivationRuleId: fdrId,
    sourceArtifactId: 'R6_OWNER_DECISION', ...bind('R6_OWNER_DECISION'), sourceJsonPointer: pointer,
    targetField: field, sourceIndex: null
  });
}
consume('R6_OWNER_DECISION', ['COPY_TOP_LEVEL_FROM_R6_OWNER_DECISION']);
// The /policy value rests on the R2 owner policy: the registry entry must ratify the same string.
const policyEntry = ownerPolicies.get(FDR.get('COPY_POLICY_UNDER_OWNER_R2_AUTHORITY').ownerPolicyReference);
if (policyEntry.policyCanonicalValue !== map.policy) fail('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { pointer: '/policy', policyValue: policyEntry.policyCanonicalValue, mapValue: map.policy });
if (policyEntry.sha256 !== consumption.get('R2_OWNER_DECISION').sha256) fail('NORMATIVE_SOURCE_HASH_MISMATCH', { ownerPolicyId: policyEntry.ownerPolicyId });
if (ownerR2.policyCanonicalValue !== map.policy) fail('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { pointer: '/policy' });
consume('R2_OWNER_DECISION', ['AUTHORIZE_POLICY_FIELD_DERIVATION']);

// ---- external authority row
const ext = srcEntry('SRC-R1-EXTERNAL-PASS');
if (!ext.entry.canonicalReference) fail('MISSING_TRANSITION_AUTHORITY', { sourceAuthorityId: 'SRC-R1-EXTERNAL-PASS' });
const externalReportSha = consumption.get('EXTERNAL_REPORT').sha256;
if (externalReportSha !== ext.entry.sha256) fail('EXTERNAL_REPORT_HASH_MISMATCH', { expected: ext.entry.sha256, actual: externalReportSha });
const extFields = [
  ['authorityId', '/entries/' + ext.index + '/canonicalReference/authorityId', ext.entry.canonicalReference.authorityId],
  ['path', '/entries/' + ext.index + '/canonicalReference/path', ext.entry.canonicalReference.path],
  ['sha256', '/entries/' + ext.index + '/sha256', externalReportSha],
  ['classification', '/entries/' + ext.index + '/canonicalReference/classification', ext.entry.canonicalReference.classification]
];
const externalAuthority = {};
for (const [field, pointer, value] of extFields) {
  const resolved = resolveJsonPointer(sourceAuthority, pointer);
  if (resolved === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'R6_SOURCE_AUTHORITY_REGISTRY', pointer });
  if (canonicalize(resolved) !== canonicalize(value)) fail('TRANSFORMATION_REPLAY_MISMATCH', { pointer, resolved, value });
  externalAuthority[field] = emit({
    targetJsonPointer: '/externalAuthorities/0/' + field, value, fieldDerivationRuleId: 'DERIVE_EXTERNAL_AUTHORITY_REFERENCE',
    sourceArtifactId: 'SRC-R1-EXTERNAL-PASS', sourcePath: REL.R6_SOURCE_AUTHORITY_REGISTRY.relativePath,
    sourceSha256: consumption.get('R6_SOURCE_AUTHORITY_REGISTRY').sha256, sourceJsonPointer: pointer,
    targetField: field, sourceIndex: String(ext.index)
  });
}
map.externalAuthorities = [externalAuthority];
consume('R6_SOURCE_AUTHORITY_REGISTRY', ['RESOLVE_SOURCE_AUTHORITY_IDENTITY', 'DERIVE_EXTERNAL_AUTHORITY_REFERENCE']);
consume('EXTERNAL_REPORT', ['DERIVE_EXTERNAL_AUTHORITY_REFERENCE', 'RESOLVE_SRC_R1_EXTERNAL_PASS']);

// ---- gates
const gateIds = (registry.gates || []).map((g) => (typeof g === 'string' ? g : g.gateId));
if (gateIds.length !== rule.deterministicOutputRequirements.gateCount) fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { gateCount: gateIds.length });
const genesisByGate = new Map();
ledger.forEach((event, index) => {
  if (event.transitionType !== 'GENESIS_IMPORT' || event.fromStatus !== null) return;
  if (genesisByGate.has(event.gateId)) fail('DUPLICATE_GENESIS_EVENT', { gateId: event.gateId });
  genesisByGate.set(event.gateId, { event, index });
});
const registryAuthority = srcEntry('SRC-REGISTRY');
const gates = gateIds.map((gateId, gateIndex) => {
  const found = genesisByGate.get(gateId);
  if (!found) fail('MISSING_GENESIS_EVENT', { gateId });
  const { event, index: eventIndex } = found;
  const isExternal = event.authorityPath === 'SRC-R1-EXTERNAL-PASS';
  const isRegistry = event.authorityPath === 'governance/GATE_REGISTRY_00_40.json';
  if (!isExternal && !isRegistry) fail('UNKNOWN_AUTHORITY_PATH', { gateId, authorityPath: event.authorityPath });
  const branch = rule.fallbackRules.branchSelection.branches[event.authorityPath];
  if (!branch) fail('UNKNOWN_AUTHORITY_PATH', { gateId, authorityPath: event.authorityPath });
  const bound = srcEntry(branch.boundSourceAuthorityId);
  const G = '/gates/' + gateIndex;
  const gate = {};

  // gateId — canonical registry order
  const gateIdPointer = '/gates/' + gateIndex + '/gateId';
  if (resolveJsonPointer(registry, gateIdPointer) !== gateId) fail('INVALID_SOURCE_JSON_POINTER', { pointer: gateIdPointer });
  gate.gateId = emit({ targetJsonPointer: G + '/gateId', value: gateId, fieldDerivationRuleId: 'COPY_GATE_ID_FROM_REGISTRY',
    sourceArtifactId: 'SRC-REGISTRY', sourcePath: REL.GATE_REGISTRY.relativePath, sourceSha256: consumption.get('GATE_REGISTRY').sha256,
    sourceJsonPointer: gateIdPointer, targetField: 'gateId', sourceIndex: String(gateIndex) });

  // ledger-bound scalars
  for (const [field, ledgerField] of [['importedStatus', 'toStatus'], ['sourceAuthorityPath', 'authorityPath'], ['sourceAuthoritySha256', 'authoritySha256']]) {
    const pointer = '/' + eventIndex + '/' + ledgerField;
    const value = resolveJsonPointer(ledger, pointer);
    if (value === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'SRC-LEDGER', pointer });
    gate[field] = emit({ targetJsonPointer: G + '/' + field, value, fieldDerivationRuleId: 'COPY_GATE_STATUS_AND_AUTHORITY_FROM_LEDGER',
      sourceArtifactId: 'SRC-LEDGER', sourcePath: REL.LEDGER.relativePath, sourceSha256: consumption.get('LEDGER').sha256,
      sourceJsonPointer: pointer, targetField: field, sourceIndex: String(eventIndex) });
  }
  if (isRegistry && gate.sourceAuthoritySha256 !== registryAuthority.entry.sha256) fail('SOURCE_HASH_MISMATCH', { gateId });
  if (isExternal) {
    if (gate.sourceAuthoritySha256 !== externalReportSha) fail('EXTERNAL_REPORT_HASH_MISMATCH', { gateId });
    const statusPointer = '/statuses/' + gateId;
    const declared = resolveJsonPointer(report, statusPointer);
    if (declared === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'SRC-R1-EXTERNAL-PASS', pointer: statusPointer });
    if (declared !== gate.importedStatus) fail('STATUS_POINTER_MISMATCH', { gateId, declared, ledger: gate.importedStatus });
  }

  // sourcePointer
  const sourcePointerValue = isExternal ? '/statuses/' + gateId : '/gates/' + gateIndex;
  gate.sourcePointer = emit({ targetJsonPointer: G + '/sourcePointer', value: sourcePointerValue, fieldDerivationRuleId: 'DERIVE_GATE_ORDER_AND_POINTER_FROM_REGISTRY',
    sourceArtifactId: 'SRC-REGISTRY', sourcePath: REL.GATE_REGISTRY.relativePath, sourceSha256: consumption.get('GATE_REGISTRY').sha256,
    sourceJsonPointer: gateIdPointer, targetField: 'sourcePointer', sourceIndex: String(gateIndex), extraInputs: { gateIndex, externalConfirmed: isExternal } });

  // statusDerivation — narrative held by the rule, not by the generator
  const narrativeKey = isExternal ? 'externalAuthority' : 'registryFallback';
  const narrativePointer = '/fallbackRules/statusDerivation/' + narrativeKey;
  const narrative = resolveJsonPointer(rule, narrativePointer);
  if (narrative === POINTER_NOT_RESOLVED) fail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { missingSection: narrativePointer });
  gate.statusDerivation = emit({ targetJsonPointer: G + '/statusDerivation', value: narrative, fieldDerivationRuleId: 'DERIVE_STATUS_DERIVATION_NARRATIVE',
    ...RULE_BIND, rulePointer: narrativePointer,
    targetField: 'statusDerivation', sourceIndex: narrativeKey, extraInputs: { branchId: branch.branchId, gateIndex, externalConfirmed: isExternal } });

  // branch constants — resolved at exact pointers inside the pinned R1 rule body
  for (const [field, fdrId] of [
    ['confidenceClass', 'DERIVE_CONFIDENCE_FROM_AUTHORITY_CLASS'],
    ['historicalDetailCompleteness', 'DERIVE_COMPLETENESS_FROM_AUTHORITY_AVAILABILITY'],
    ['fabricatedTransitionCount', 'DERIVE_FABRICATED_TRANSITION_COUNT_FROM_POLICY'],
    ['authorityKind', 'DERIVE_AUTHORITY_KIND_FROM_SOURCE_CLASSIFICATION']
  ]) {
    const pointer = '/perGateFieldDerivation/' + branch.branchId + '/' + field;
    const value = resolveJsonPointer(r1RuleBody, pointer);
    if (value === POINTER_NOT_RESOLVED) fail('INVALID_SOURCE_JSON_POINTER', { sourceAuthorityId: 'R1_RULE_BODY', pointer });
    gate[field] = emit({ targetJsonPointer: G + '/' + field, value, fieldDerivationRuleId: fdrId,
      sourceArtifactId: 'R1_RULE_BODY', sourcePath: REL.R1_RULE_BODY.relativePath,
      sourceSha256: consumption.get('R1_RULE_BODY').sha256, sourceJsonPointer: pointer,
      targetField: field, sourceIndex: branch.branchId, extraInputs: { branchId: branch.branchId, gateIndex, externalConfirmed: isExternal } });
  }
  // The rule's own fallback constant must agree with the ratified branch constant.
  if (resolveJsonPointer(rule, '/fallbackRules/fabricatedTransitionCount') !== gate.fabricatedTransitionCount) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { field: 'fabricatedTransitionCount' });
  if (rule.fallbackRules.confidenceClass[bound.entry.authorityClass] !== gate.confidenceClass) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { field: 'confidenceClass', authorityClass: bound.entry.authorityClass });
  if (rule.fallbackRules.historicalDetailCompleteness[bound.entry.authorityClass] !== gate.historicalDetailCompleteness) fail('DERIVED_RULE_ENGINE_CROSS_CHECK_FAILED', { field: 'historicalDetailCompleteness', authorityClass: bound.entry.authorityClass });

  // unresolvedHistoricalDetails — every element gets its own provenance row (defect B04)
  const caseIndex = fallbackPolicy.cases.findIndex((c) => c.authorityKind === gate.authorityKind && c.historicalDetailCompleteness === gate.historicalDetailCompleteness);
  if (caseIndex < 0) fail('UNKNOWN_DERIVATION_AUTHORITY', { field: 'unresolvedHistoricalDetails', authorityKind: gate.authorityKind, historicalDetailCompleteness: gate.historicalDetailCompleteness });
  const details = fallbackPolicy.cases[caseIndex].details;
  gate.unresolvedHistoricalDetails = details.map((detail, k) => emit({
    targetJsonPointer: G + '/unresolvedHistoricalDetails/' + k, value: detail,
    fieldDerivationRuleId: 'DERIVE_UNRESOLVED_HISTORICAL_DETAILS_V1', ...RULE_BIND,
    rulePointer: '/fallbackRules/unresolvedHistoricalDetailsPolicy/cases/' + caseIndex + '/details/' + k,
    targetField: 'unresolvedHistoricalDetails', sourceIndex: String(caseIndex),
    extraInputs: { branchId: branch.branchId, authorityKind: gate.authorityKind, historicalDetailCompleteness: gate.historicalDetailCompleteness, elementIndex: k }
  }));
  return gate;
});
map.gates = gates;
consume('GATE_REGISTRY', ['COPY_GATE_ID_FROM_REGISTRY', 'DERIVE_GATE_ORDER_AND_POINTER_FROM_REGISTRY']);
consume('LEDGER', ['COPY_GATE_STATUS_AND_AUTHORITY_FROM_LEDGER']);
consume('R6_FIELD_SEMANTIC_CLASSIFICATION_REGISTRY', ['RESOLVE_SEMANTIC_CLASS']);
consume('R6_TRANSFORMATION_REGISTRY', ['RESOLVE_TRANSFORMATION_AUTHORITY']);

// ============================================================ COVERAGE (B04)
const leaves = collectPrimitiveLeaves(map);
const byPointer = new Map();
for (const row of provenance) {
  if (byPointer.has(row.targetJsonPointer)) fail('DUPLICATE_TARGET_POINTER', { pointer: row.targetJsonPointer });
  byPointer.set(row.targetJsonPointer, row);
}
const uncovered = leaves.filter((leaf) => !byPointer.has(leaf.pointer)).map((leaf) => leaf.pointer);
if (uncovered.length) fail('UNCOVERED_PRIMITIVE_FIELD', { count: uncovered.length, pointers: uncovered.slice(0, 20) });
const leafPointers = new Set(leaves.map((l) => l.pointer));
const orphans = provenance.filter((row) => !leafPointers.has(row.targetJsonPointer)).map((row) => row.targetJsonPointer);
if (orphans.length) fail('ORPHAN_PROVENANCE_ROW', { count: orphans.length, pointers: orphans.slice(0, 20) });
if (rule.primitiveCoveragePolicy.everyPrimitiveMapFieldCoveredExactlyOnce === true && leaves.length !== provenance.length) {
  fail('UNCOVERED_PRIMITIVE_FIELD', { primitiveTargetCount: leaves.length, provenanceRowCount: provenance.length });
}
// forbidden-claim enforcement on the produced bytes
if (map.historicalOriginal !== false) fail('UNSUPPORTED_HISTORICAL_ORIGINAL_CLAIM', {});
if (provenance.some((row) => row.historicalOriginal !== false)) fail('FORBIDDEN_CLAIM_VIOLATION', { claim: 'historical source recovered when not demonstrated' });
if (provenance.some((row) => row.sourceArtifactId === 'RECONSTRUCTION_RULE' && row.sourceJsonPointer !== null)) fail('FORBIDDEN_CLAIM_VIOLATION', { claim: 'source pointer not resolved' });
if (!map.gates.some((g) => g.sourceAuthorityPath === 'SRC-R1-EXTERNAL-PASS')) fail('MISSING_TRANSITION_AUTHORITY', {});

// ============================================================ FREEZE + WRITE
const provenanceDocument = {
  document: 'GENESIS_IMPORT_SOURCE_MAP_FIELD_PROVENANCE',
  schemaVersion: 1,
  artifactClass: 'DETERMINISTIC_RECONSTRUCTION_PROVENANCE',
  historicalOriginal: false,
  reconstructionRuleId: rule.reconstructionRuleId,
  ruleVersion: rule.ruleVersion,
  primitiveTargetCount: leaves.length,
  provenanceRowCount: provenance.length,
  fields: provenance
};
const mapBytes = Buffer.from(canonicalize(map));
const provenanceBytes = Buffer.from(canonicalize(provenanceDocument));
for (const file of [option('--out-map'), option('--out-provenance'), option('--summary')]) fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
fs.writeFileSync(option('--out-map'), mapBytes);
fs.writeFileSync(option('--out-provenance'), provenanceBytes);
const mapHash = sha(mapBytes);
const provenanceHash = sha(provenanceBytes);

// ---- goldens are read only AFTER the output bytes are frozen (defect B02)
let goldenComparison = null;
const goldenMap = option('--golden-map');
const goldenProvenance = option('--golden-provenance');
if (goldenMap || goldenProvenance) {
  goldenComparison = { mode: 'POST_GENERATION_COMPARISON_ONLY', influencedOutputBytes: false };
  if (goldenMap) { const g = sha(fs.readFileSync(goldenMap)); goldenComparison.goldenMapSha256 = g; goldenComparison.mapMatchesGolden = g === mapHash; }
  if (goldenProvenance) { const g = sha(fs.readFileSync(goldenProvenance)); goldenComparison.goldenProvenanceSha256 = g; goldenComparison.provenanceMatchesGolden = g === provenanceHash; }
  goldenComparison.status = (goldenComparison.mapMatchesGolden === false || goldenComparison.provenanceMatchesGolden === false)
    ? 'GOLDEN_COMPARISON_MISMATCH' : 'GOLDEN_COMPARISON_MATCH';
}

const consumedInputs = [...consumption.entries()].map(([inputId, row]) => ({
  inputId, path: row.path, sha256: row.sha256, bytesRead: row.bytesRead,
  semanticRole: row.semanticRole ?? 'IMPLEMENTATION_AUTHORITY',
  usedByRules: row.usedByRules ?? [], actuallyConsumed: row.actuallyConsumed === true
}));
const unusedNormativeInputs = consumedInputs.filter((row) => !row.actuallyConsumed).map((row) => row.inputId);
if (unusedNormativeInputs.length) fail('UNDECLARED_INPUT', { unusedNormativeInputs });

const summary = {
  valid: true,
  reconstructionRuleId: rule.reconstructionRuleId,
  ruleVersion: rule.ruleVersion,
  ruleHash: ruleSha,
  normativeInputRegistryHash: IA.normativeInputRegistrySha256,
  transformationRegistryHash: IA.transformationRegistrySha256,
  semanticClassificationRegistryHash: IA.semanticClassificationRegistrySha256,
  ownerPolicyRegistryHash: IA.ownerPolicyRegistrySha256,
  primitiveLibHash: libSha,
  mapHash, provenanceHash,
  gateCount: gates.length,
  primitiveTargetCount: leaves.length,
  provenanceRowCount: provenance.length,
  uniqueTargetPointerCount: byPointer.size,
  uncoveredPrimitiveFields: 0,
  orphanProvenanceRows: 0,
  duplicateTargetPointers: 0,
  unknownSourceIds: 0,
  unknownTransformationIds: 0,
  unknownSemanticClassIds: 0,
  invalidOwnerPolicyReferences: 0,
  templateInputsUsedNormatively: 0,
  unusedNormativeInputs: 0,
  consumedInputs,
  goldenComparison,
  exitCode: 0
};
fs.writeFileSync(option('--summary'), Buffer.from(canonicalize(summary)));
process.stdout.write(JSON.stringify(summary) + '\n');
