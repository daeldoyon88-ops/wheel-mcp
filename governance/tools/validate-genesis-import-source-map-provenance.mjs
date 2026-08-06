#!/usr/bin/env node
// validate-genesis-import-source-map-provenance (R4 EXACT EVENT AND BRANCH BINDING)
//
// Repairs defects B01, B03 and B04 of the R1 validator, and closes R3-AUD-01 and
// R3-AUD-02 of the R3 independent audit.
//
// R3-AUD-01 : transformationInputs were only type-checked. gateIndex, branchId,
//             externalConfirmed and sourceIndex are now re-derived by this validator
//             from the pinned authoritative sources and must equal the declared values.
// R3-AUD-02 : a source pointer was accepted whenever the pointed value happened to
//             equal the target value. Every pointer must now be the exact pointer
//             derived for the target gate, its genesis ledger event and its selected
//             branch. Value equality alone can never produce a PASS.
//
// B01 : the reconstruction rule is enforced by content, not merely by id. Every
//       declared normative-source hash is checked against the real pinned bytes,
//       every derivation authority must be registered, and forbiddenClaims must be
//       present and substantively complete.
// B03 : every provenance row is checked on sixteen semantic axes. transformationId,
//       sourceJsonPointer and ownerPolicyReference are resolved, not trusted.
// B04 : primitive coverage is measured with the shared unfiltered leaf function.
//       No pointer class may be filtered out. Filtering is itself a failure.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const errors = [];
const warnings = [];
const add = (code, details = {}) => {
  const key = code + '|' + JSON.stringify(details);
  if (!errors.some((row) => row.key === key)) errors.push({ key, code, details });
};
const emitReport = (report) => {
  report.errors = report.errors.map(({ key, ...rest }) => rest);
  process.stdout.write(JSON.stringify(report) + '\n');
  process.exitCode = report.exitCode;
};
function hardFail(code, details = {}) {
  add(code, details);
  emitReport({
    valid: false, errors, warnings, mapHash: null, provenanceHash: null, ruleHash: null,
    normativeInputRegistryHash: null, transformationRegistryHash: null,
    semanticClassificationRegistryHash: null, ownerPolicyRegistryHash: null,
    primitiveTargetCount: 0, provenanceRowCount: 0, uniqueTargetPointerCount: 0,
    uncoveredPrimitiveFields: 0, orphanProvenanceRows: 0, unknownSourceIds: 0,
    invalidSourcePointers: 0, unknownTransformationIds: 0, failedTransformationReplays: 0,
    unknownSemanticClassIds: 0, invalidOwnerPolicyReferences: 0, unresolvedRuleIds: 0,
    historicalClaimsWithoutEvidence: 0, forbiddenClaimViolations: 0,
    gateIndexTargetMismatches: 0, branchSelectionMismatches: 0, externalConfirmationMismatches: 0,
    sourceIndexBindingMismatches: 0, ledgerEventGateBindingMismatches: 0, sourceBranchPointerMismatches: 0,
    exactBindingEnforced: true, valueEqualityAloneAcceptedAsProof: false, exitCode: 2
  });
  process.exit(2);
}
function loadBytes(file, missingCode) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) hardFail(missingCode, { path: file });
  return fs.readFileSync(file);
}
const loadJson = (file, missingCode) => {
  const bytes = loadBytes(file, missingCode);
  try { return { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: sha(bytes) }; }
  catch (error) { hardFail('JSON_PARSE_ERROR', { path: file, message: error.message }); }
};

const REQUIRED = ['--map', '--provenance', '--rule', '--map-schema', '--provenance-schema',
  '--normative-input-registry', '--transformation-registry', '--semantic-classification-registry',
  '--owner-policy-registry', '--primitive-lib', '--source-root'];
for (const name of REQUIRED) if (!option(name)) hardFail('MISSING_CLI_ARGUMENT', { argument: name });

const ruleDoc = loadJson(option('--rule'), 'MISSING_RECONSTRUCTION_RULE');
const rule = ruleDoc.value;
const expectRuleSha = option('--expect-rule-sha256');
if (expectRuleSha && expectRuleSha !== ruleDoc.sha256) hardFail('RECONSTRUCTION_RULE_HASH_MISMATCH', { expected: expectRuleSha, actual: ruleDoc.sha256 });
if (rule.reconstructionRuleId !== 'GENESIS_IMPORT_SOURCE_MAP_DETERMINISTIC_RECONSTRUCTION_RULE_R2') hardFail('UNKNOWN_RECONSTRUCTION_RULE', { actual: rule.reconstructionRuleId });
if (rule.ruleVersion !== 'R3_PROVENANCE_BINDING_AND_FINALIZATION_CLOSURE_V1') hardFail('UNKNOWN_RECONSTRUCTION_RULE', { ruleVersion: rule.ruleVersion });
for (const section of ['implementationAuthorities', 'allowedInputs', 'normativeSources', 'fieldDerivationRules',
  'fallbackRules', 'unresolvedHistoricalDetailsPolicy', 'primitiveCoveragePolicy', 'provenanceRequirements',
  'deterministicOutputRequirements', 'failureConditions', 'ledgerImmutabilityRequirement']) {
  if (rule[section] === undefined || rule[section] === null) hardFail('INCOMPLETE_RECONSTRUCTION_RULE_SCOPE', { missingSection: section });
}
const REQUIRED_CLAIMS = ['historical source recovered when not demonstrated', 'source authority invented',
  'unresolved history presented as known', 'unknown transformation accepted', 'unknown semantic class accepted',
  'unknown owner policy accepted', 'source pointer not resolved', 'normative source hash mismatch ignored',
  'template used as normative generation input', 'uncovered primitive field accepted'];
if (!Array.isArray(rule.forbiddenClaims) || rule.forbiddenClaimsMandatory !== true) hardFail('MISSING_FORBIDDEN_CLAIMS_POLICY', {});
if (rule.forbiddenClaims.length < (rule.forbiddenClaimsMinimumCount ?? 10)) hardFail('MISSING_FORBIDDEN_CLAIMS_POLICY', { count: rule.forbiddenClaims.length });
{
  const missing = REQUIRED_CLAIMS.filter((c) => !rule.forbiddenClaims.includes(c));
  if (missing.length) hardFail('MISSING_FORBIDDEN_CLAIMS_POLICY', { missingClaims: missing });
}

const IA = rule.implementationAuthorities;
const registryDefs = [
  ['normativeInputRegistry', '--normative-input-registry', IA.normativeInputRegistrySha256, 'NORMATIVE_INPUT_REGISTRY_HASH_MISMATCH', 'MISSING_NORMATIVE_INPUT_REGISTRY'],
  ['transformationRegistry', '--transformation-registry', IA.transformationRegistrySha256, 'TRANSFORMATION_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT'],
  ['semanticClassificationRegistry', '--semantic-classification-registry', IA.semanticClassificationRegistrySha256, 'SEMANTIC_CLASSIFICATION_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT'],
  ['ownerPolicyRegistry', '--owner-policy-registry', IA.ownerPolicyRegistrySha256, 'OWNER_POLICY_REGISTRY_HASH_MISMATCH', 'MISSING_INPUT']
];
const authority = {}; const authorityHash = {};
for (const [key, flag, expected, mismatchCode, missingCode] of registryDefs) {
  const doc = loadJson(option(flag), missingCode);
  if (doc.sha256 !== expected) hardFail(mismatchCode, { registry: key, expected, actual: doc.sha256 });
  authority[key] = doc.value; authorityHash[key] = doc.sha256;
}
const libPath = path.resolve(option('--primitive-lib'));
const libSha = sha(loadBytes(libPath, 'MISSING_INPUT'));
if (libSha !== IA.primitiveLibSha256) hardFail('PRIMITIVE_LIB_HASH_MISMATCH', { expected: IA.primitiveLibSha256, actual: libSha });
const LIB = await import(pathToFileURL(libPath).href);
if (LIB.PRIMITIVE_LEAF_FILTERING_FORBIDDEN !== true) hardFail('PRIMITIVE_COVERAGE_FILTER_FORBIDDEN', {});
const { canonicalize, collectPrimitiveLeaves, resolveJsonPointer, POINTER_NOT_RESOLVED } = LIB;

const mapDoc = loadJson(option('--map'), 'MISSING_SOURCE_MAP');
const provenanceDoc = loadJson(option('--provenance'), 'MISSING_PROVENANCE');
const mapSchemaDoc = loadJson(option('--map-schema'), 'MISSING_MAP_SCHEMA');
const provenanceSchemaDoc = loadJson(option('--provenance-schema'), 'MISSING_PROVENANCE_SCHEMA');
const map = mapDoc.value; const provenance = provenanceDoc.value;

for (const [doc, code] of [[mapDoc, 'NON_CANONICAL_SOURCE_MAP'], [provenanceDoc, 'NON_CANONICAL_PROVENANCE'],
  [ruleDoc, 'NON_CANONICAL_RECONSTRUCTION_RULE'], [mapSchemaDoc, 'NON_CANONICAL_MAP_SCHEMA'],
  [provenanceSchemaDoc, 'NON_CANONICAL_PROVENANCE_SCHEMA']]) {
  if (canonicalize(doc.value) !== doc.bytes.toString('utf8')) add(code);
}

// ------------------------------------------------- compact JSON Schema checker
function checkSchema(value, schema, pointer, out, root) {
  const S = schema.$ref ? resolveJsonPointer(root, schema.$ref.replace(/^#/, '')) : schema;
  if (!S || S === POINTER_NOT_RESOLVED) { out.push({ pointer, reason: 'UNRESOLVED_SCHEMA_REF', ref: schema.$ref }); return; }
  if (S.const !== undefined && canonicalize(value) !== canonicalize(S.const)) out.push({ pointer, reason: 'CONST_MISMATCH', expected: S.const });
  if (S.enum && !S.enum.some((e) => canonicalize(e) === canonicalize(value))) out.push({ pointer, reason: 'ENUM_MISMATCH' });
  const types = S.type ? (Array.isArray(S.type) ? S.type : [S.type]) : null;
  if (types) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) { out.push({ pointer, reason: 'TYPE_MISMATCH', expected: types, actual }); return; }
  }
  if (typeof value === 'string' && S.pattern && !new RegExp(S.pattern).test(value)) out.push({ pointer, reason: 'PATTERN_MISMATCH', pattern: S.pattern });
  if (Array.isArray(value)) {
    if (S.minItems !== undefined && value.length < S.minItems) out.push({ pointer, reason: 'MIN_ITEMS' });
    if (S.maxItems !== undefined && value.length > S.maxItems) out.push({ pointer, reason: 'MAX_ITEMS' });
    if (S.items) value.forEach((item, i) => checkSchema(item, S.items, pointer + '/' + i, out, root));
  } else if (value && typeof value === 'object') {
    for (const req of S.required || []) if (!Object.prototype.hasOwnProperty.call(value, req)) out.push({ pointer, reason: 'MISSING_REQUIRED', field: req });
    for (const [k, v] of Object.entries(value)) {
      const sub = S.properties?.[k];
      if (sub) checkSchema(v, sub, pointer + '/' + k, out, root);
      else if (S.additionalProperties === false) out.push({ pointer: pointer + '/' + k, reason: 'ADDITIONAL_PROPERTY_FORBIDDEN' });
    }
  }
}
{
  const mapSchemaErrors = [];
  checkSchema(map, mapSchemaDoc.value, '', mapSchemaErrors, mapSchemaDoc.value);
  if (mapSchemaErrors.length) add('MAP_SCHEMA_INVALID', { count: mapSchemaErrors.length, first: mapSchemaErrors.slice(0, 5) });
  const provSchemaErrors = [];
  checkSchema(provenance, provenanceSchemaDoc.value, '', provSchemaErrors, provenanceSchemaDoc.value);
  if (provSchemaErrors.length) add('PROVENANCE_SCHEMA_INVALID', { count: provSchemaErrors.length, first: provSchemaErrors.slice(0, 5) });
  // the schemas must themselves forbid the dangerous shapes
  if (mapSchemaDoc.value.properties?.historicalOriginal?.const !== false) add('SCHEMA_ALLOWS_HISTORICAL_ORIGINAL_TRUE');
  const entryReq = provenanceSchemaDoc.value.$defs?.entry?.required || [];
  for (const field of ['targetJsonPointer', 'targetValueHash', 'sourceArtifactId', 'transformationId',
    'semanticClassId', 'ownerPolicyReference', 'reconstructionRuleId', 'historicalOriginal', 'fieldDerivationRuleId']) {
    if (!entryReq.includes(field)) add('SCHEMA_ALLOWS_MISSING_REQUIRED_AUTHORITY', { field });
  }
}

// ------------------------------------------- normative sources actually pinned
const sourceRoot = path.resolve(option('--source-root'));
const inputEntries = new Map((authority.normativeInputRegistry.entries || []).map((e) => [e.inputId, e]));
const sourceBytes = new Map();
const sourceDocs = new Map();
for (const [inputId, entry] of inputEntries) {
  const file = path.join(sourceRoot, entry.relativePath);
  if (!fs.existsSync(file)) { add('MISSING_SOURCE_FILE', { inputId, relativePath: entry.relativePath }); continue; }
  const bytes = fs.readFileSync(file);
  const actual = sha(bytes);
  if (actual !== entry.sha256) add('NORMATIVE_INPUT_REGISTRY_HASH_MISMATCH', { inputId, expected: entry.sha256, actual });
  sourceBytes.set(inputId, actual);
  try {
    sourceDocs.set(inputId, entry.mediaType === 'application/json' ? JSON.parse(bytes.toString('utf8'))
      : entry.mediaType === 'application/x-ndjson' ? bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
        : bytes.toString('utf8'));
  } catch { add('JSON_PARSE_ERROR', { inputId }); }
}
for (const row of rule.normativeSources) {
  const actual = sourceBytes.get(row.id);
  if (!actual) { add('UNKNOWN_DERIVATION_AUTHORITY', { normativeSourceId: row.id }); continue; }
  if (actual !== row.sha256) add('NORMATIVE_SOURCE_HASH_MISMATCH', { normativeSourceId: row.id, declared: row.sha256, actual });
}
for (const forbidden of rule.forbiddenNormativeInputs || []) {
  if (inputEntries.has(forbidden.inputId)) add('NORMATIVE_TEMPLATE_INPUT_FORBIDDEN', { inputId: forbidden.inputId });
}

// --------------------------------------------------------- authority indexes
const transformations = new Map((authority.transformationRegistry.entries || []).map((e) => [e.transformationId, e]));
const semanticClasses = new Map((authority.semanticClassificationRegistry.classes || []).map((c) => [c.semanticClassId, c]));
const ownerPolicies = new Map((authority.ownerPolicyRegistry.entries || []).map((p) => [p.ownerPolicyId, p]));
const fdrById = new Map((rule.fieldDerivationRules || []).map((r) => [r.id, r]));
const sourceAuthorityRegistry = sourceDocs.get('R6_SOURCE_AUTHORITY_REGISTRY');
const sourceAuthorityIds = new Set((sourceAuthorityRegistry?.entries || []).map((e) => e.sourceAuthorityId));
const RULE_SOURCE_ID = 'RECONSTRUCTION_RULE';

// ===================================================== R4 : independently derived truth
// Nothing below is read from the provenance being validated. The gate order comes from
// the pinned gate registry, the genesis event and its index come from the pinned ledger,
// the branch comes from the ratified branch-selection rule applied to that event's
// authorityPath, and the branch constants come from the pinned R1 rule body.
const R4 = {
  gateIndexTargetMismatches: 0, branchSelectionMismatches: 0, externalConfirmationMismatches: 0,
  sourceIndexBindingMismatches: 0, ledgerEventGateBindingMismatches: 0, sourceBranchPointerMismatches: 0
};
const ledgerDoc = sourceDocs.get('LEDGER');
const registryDoc = sourceDocs.get('GATE_REGISTRY');
const r1RuleBodyDoc = sourceDocs.get('R1_RULE_BODY');
const branchSelection = rule.fallbackRules?.branchSelection || {};
const fallbackPolicy = rule.fallbackRules?.unresolvedHistoricalDetailsPolicy || {};
const BRANCH_CONSTANT_TEMPLATE = branchSelection.branchConstantPointerTemplate || '/perGateFieldDerivation/{branchId}/{field}';
const gateTruth = [];
const gateTruthAvailable = Array.isArray(ledgerDoc) && registryDoc && r1RuleBodyDoc && branchSelection.branches;
if (!gateTruthAvailable) add('UNKNOWN_DERIVATION_AUTHORITY', { reason: 'EXACT_BINDING_TRUTH_SOURCES_UNAVAILABLE' });
else {
  const genesisByGate = new Map();
  ledgerDoc.forEach((event, index) => {
    if (!event || event.transitionType !== 'GENESIS_IMPORT' || event.fromStatus !== null) return;
    if (genesisByGate.has(event.gateId)) add('DUPLICATE_GENESIS_EVENT', { gateId: event.gateId });
    else genesisByGate.set(event.gateId, { event, index });
  });
  const gateIds = (registryDoc.gates || []).map((g) => (typeof g === 'string' ? g : g.gateId));
  gateIds.forEach((gateId, gateIndex) => {
    const found = genesisByGate.get(gateId);
    if (!found) { add('MISSING_GENESIS_EVENT', { gateId }); gateTruth[gateIndex] = null; return; }
    const branch = branchSelection.branches[found.event.authorityPath];
    if (!branch) { add('UNKNOWN_AUTHORITY_PATH', { gateId, authorityPath: found.event.authorityPath }); gateTruth[gateIndex] = null; return; }
    const constant = (field) => resolveJsonPointer(r1RuleBodyDoc, BRANCH_CONSTANT_TEMPLATE.replace('{branchId}', branch.branchId).replace('{field}', field));
    const authorityKind = constant('authorityKind');
    const historicalDetailCompleteness = constant('historicalDetailCompleteness');
    const externalConfirmed = found.event.authorityPath === 'SRC-R1-EXTERNAL-PASS';
    const caseIndex = (fallbackPolicy.cases || []).findIndex((c) => c.authorityKind === authorityKind && c.historicalDetailCompleteness === historicalDetailCompleteness);
    gateTruth[gateIndex] = {
      gateIndex, gateId, eventIndex: found.index, authorityPath: found.event.authorityPath,
      branchId: branch.branchId, boundSourceAuthorityId: branch.boundSourceAuthorityId, externalConfirmed,
      narrativeKey: externalConfirmed ? 'externalAuthority' : 'registryFallback',
      authorityKind, historicalDetailCompleteness, caseIndex
    };
  });
}
const externalAuthorityIndex = (sourceAuthorityRegistry?.entries || []).findIndex((e) => e.sourceAuthorityId === 'SRC-R1-EXTERNAL-PASS');
const LEDGER_FIELD_BY_TARGET = { importedStatus: 'toStatus', sourceAuthorityPath: 'authorityPath', sourceAuthoritySha256: 'authoritySha256' };
const gateIndexOfTarget = (pointer) => { const m = /^\/gates\/(0|[1-9][0-9]*)\//.exec(pointer); return m ? Number(m[1]) : null; };
// target field and element index are derived from the target pointer itself, never from
// the declared transformationInputs, so a forged targetField cannot move the expectation.
function targetIdentity(pointer) {
  const tail = pointer.split('/').filter(Boolean);
  const last = tail[tail.length - 1];
  const isIndex = /^(?:0|[1-9][0-9]*)$/.test(last);
  return { field: isIndex ? tail[tail.length - 2] : last, elementIndex: isIndex ? Number(last) : null };
}
// The expected source identity, index and pointer for a row, derived per authority class.
// A row whose authority class yields no derivable expectation is a failure, never a pass.
function deriveExpectedBinding(row, truth, identity) {
  const id = row.sourceArtifactId;
  const field = identity.field;
  if (id === 'R6_OWNER_DECISION') return { kind: 'OWNER_DECISION', sourceIndex: null, pointerKind: 'SOURCE', pointer: '/canonicalValues/' + field };
  if (id === 'SRC-R1-EXTERNAL-PASS') {
    if (externalAuthorityIndex < 0) return null;
    return { kind: 'EXTERNAL_AUTHORITY', sourceIndex: String(externalAuthorityIndex), pointerKind: 'SOURCE',
      pointer: field === 'sha256' ? '/entries/' + externalAuthorityIndex + '/sha256' : '/entries/' + externalAuthorityIndex + '/canonicalReference/' + field };
  }
  if (!truth) return null;
  if (id === 'SRC-REGISTRY') return { kind: 'REGISTRY', sourceIndex: String(truth.gateIndex), pointerKind: 'SOURCE', pointer: '/gates/' + truth.gateIndex + '/gateId' };
  if (id === 'SRC-LEDGER') {
    const ledgerField = LEDGER_FIELD_BY_TARGET[field];
    if (!ledgerField) return null;
    return { kind: 'LEDGER_EVENT', sourceIndex: String(truth.eventIndex), pointerKind: 'SOURCE', pointer: '/' + truth.eventIndex + '/' + ledgerField, ledgerField };
  }
  if (id === 'R1_RULE_BODY') {
    if (!(branchSelection.branchConstantFields || []).includes(field)) return null;
    return { kind: 'BRANCH_CONSTANT', sourceIndex: truth.branchId, pointerKind: 'SOURCE',
      pointer: BRANCH_CONSTANT_TEMPLATE.replace('{branchId}', truth.branchId).replace('{field}', field) };
  }
  if (id === RULE_SOURCE_ID) {
    if (row.semanticClassId === (fallbackPolicy.semanticClassId ?? rule.unresolvedHistoricalDetailsPolicy?.requiredSemanticClassId)) {
      if (!(truth.caseIndex >= 0)) return null;
      const selectedCase = (fallbackPolicy.cases || [])[truth.caseIndex];
      if (!selectedCase || selectedCase.branchId !== truth.branchId) return null;
      if (identity.elementIndex === null) return null;
      return { kind: 'RULE_FALLBACK_CASE', sourceIndex: String(truth.caseIndex), pointerKind: 'RULE',
        pointer: '/fallbackRules/unresolvedHistoricalDetailsPolicy/cases/' + truth.caseIndex + '/details/' + identity.elementIndex,
        elementIndex: identity.elementIndex, authorityKind: truth.authorityKind, historicalDetailCompleteness: truth.historicalDetailCompleteness };
    }
    return { kind: 'RULE_BRANCH_NARRATIVE', sourceIndex: truth.narrativeKey, pointerKind: 'RULE',
      pointer: '/fallbackRules/statusDerivation/' + truth.narrativeKey };
  }
  return null;
}

// pinned derived-rule engine, used to replay the fallback transformation
let engine = null;
{
  const entry = inputEntries.get('R7_DERIVED_RULE_ENGINE');
  if (entry) {
    const file = path.join(sourceRoot, entry.relativePath);
    if (fs.existsSync(file)) engine = await import(pathToFileURL(file).href);
  }
  if (!engine) add('UNKNOWN_DERIVATION_AUTHORITY', { normativeSourceId: 'R7_DERIVED_RULE_ENGINE' });
}

// Source resolution NEVER starts from the path the row declares. It starts from
// sourceArtifactId, walks the rule's declared binding to a registered normative
// input, and only then requires the declared sourcePath to equal that input's
// registered relativePath. (R2-AUD-01)
const BINDINGS = rule.sourceAuthorityBindings || {};
function resolveSourceDocument(row) {
  const binding = BINDINGS[row.sourceArtifactId];
  if (!binding) return null;
  if (binding.sourcePathMustBeNull) return { doc: rule, sha256: ruleDoc.sha256, kind: 'RULE', registeredRelativePath: null };
  const entry = inputEntries.get(binding.inputId);
  if (!entry) return null;
  return { doc: sourceDocs.get(binding.inputId), sha256: sourceBytes.get(binding.inputId), kind: 'BOUND_AUTHORITY', boundInputId: binding.inputId, registeredRelativePath: entry.relativePath };
}
// A declared source path must be a normalized, relative, traversal-free POSIX path.
function unsafeSourcePath(p) {
  if (typeof p !== 'string' || p.length === 0) return 'NOT_A_STRING';
  if (p.includes('\\')) return 'BACKSLASH';
  if (/^[A-Za-z]:/.test(p)) return 'DRIVE_LETTER';
  if (p.startsWith('/')) return 'ABSOLUTE_PATH';
  const decoded = (() => { try { return decodeURIComponent(p); } catch { return p; } })();
  if (/(^|\/)\.\.(\/|$)/.test(p) || /(^|\/)\.\.(\/|$)/.test(decoded)) return 'PARENT_TRAVERSAL';
  if (decoded !== p && /%2e|%2f|%5c/i.test(p)) return 'PERCENT_ENCODED_TRAVERSAL';
  if (p.split('/').some((seg) => seg === '' || seg === '.')) return 'EMPTY_OR_DOT_SEGMENT';
  return null;
}

// Compact JSON Schema subset checker for the registered transformationInputs contracts.
function inputSchemaErrors(value, schema, pointer = '') {
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
      if (sub) out.push(...inputSchemaErrors(v, sub, pointer + '/' + k));
      else if (schema.additionalProperties === false) out.push({ pointer: pointer + '/' + k, reason: 'ADDITIONAL_PROPERTY_FORBIDDEN' });
    }
  }
  return out;
}

// ---------------------------------------------------- transformation replays
function replay(row, resolvedSourceValue) {
  const inputs = row.transformationInputs || {};
  switch (row.transformationId) {
    case 'COPY_EXACT_CANONICAL_VALUE':
    case 'DERIVE_EXTERNAL_AUTHORITY_REFERENCE':
    case 'R3_DERIVE_CONFIDENCE_FROM_RATIFIED_BRANCH_CONSTANT':
    case 'R3_DERIVE_COMPLETENESS_FROM_RATIFIED_BRANCH_CONSTANT':
    case 'R3_DERIVE_AUTHORITY_KIND_FROM_RATIFIED_BRANCH_CONSTANT':
    case 'R3_DERIVE_FABRICATED_TRANSITION_COUNT_FROM_RATIFIED_BRANCH_CONSTANT':
    case 'R3_DERIVE_GATE_STATUS_FROM_RATIFIED_BRANCH_NARRATIVE':
      return { ok: true, value: resolvedSourceValue };
    case 'DERIVE_SOURCE_POINTER_FROM_CANONICAL_ORDER':
      return { ok: true, value: inputs.externalConfirmed === true ? '/statuses/' + resolvedSourceValue : '/gates/' + inputs.gateIndex };
    case 'R3_DERIVE_UNRESOLVED_HISTORICAL_DETAILS': {
      if (!engine) return { ok: false, reason: 'ENGINE_UNAVAILABLE' };
      const impl = transformations.get(row.transformationId)?.implementationFunction;
      const fn = impl ? engine[impl] : null;
      if (typeof fn !== 'function') return { ok: false, reason: 'IMPLEMENTATION_NOT_FOUND' };
      const produced = fn({ authorityKind: inputs.authorityKind, historicalDetailCompleteness: inputs.historicalDetailCompleteness });
      if (!Array.isArray(produced) || inputs.elementIndex === undefined) return { ok: false, reason: 'ENGINE_SHAPE_MISMATCH' };
      // the rule-bound value and the engine output must agree
      if (canonicalize(produced[inputs.elementIndex]) !== canonicalize(resolvedSourceValue)) return { ok: false, reason: 'RULE_AND_ENGINE_DISAGREE' };
      return { ok: true, value: produced[inputs.elementIndex] };
    }
    default:
      return { ok: false, reason: 'NO_REPLAY_IMPLEMENTATION' };
  }
}

// ================================================== per-row semantic validation
const leaves = collectPrimitiveLeaves(map);
const leafByPointer = new Map(leaves.map((l) => [l.pointer, l.value]));
const rows = Array.isArray(provenance.fields) ? provenance.fields : [];
const byPointer = new Map();
let unknownSourceIds = 0, invalidSourcePointers = 0, unknownTransformationIds = 0, failedTransformationReplays = 0;
let unknownSemanticClassIds = 0, invalidOwnerPolicyReferences = 0, unresolvedRuleIds = 0;
let historicalClaimsWithoutEvidence = 0, forbiddenClaimViolations = 0, orphanProvenanceRows = 0;
let sourcePathMismatches = 0, unsafeSourcePaths = 0, fieldDerivationRuleBindingMismatches = 0, targetPointerPatternMismatches = 0;
let transformationIdRuleMismatches = 0, transformationVersionMismatches = 0, semanticClassRuleMismatches = 0;
let ownerPolicyRuleMismatches = 0, sourceAuthorityRuleMismatches = 0, invalidTransformationInputs = 0;

for (const row of rows) {
  const at = { pointer: row.targetJsonPointer };
  if (byPointer.has(row.targetJsonPointer)) add('DUPLICATE_TARGET_POINTER', at);
  byPointer.set(row.targetJsonPointer, row);

  // 1 — target pointer must exist in the map
  const targetValue = resolveJsonPointer(map, row.targetJsonPointer);
  if (targetValue === POINTER_NOT_RESOLVED || !leafByPointer.has(row.targetJsonPointer)) {
    orphanProvenanceRows++; add('ORPHAN_PROVENANCE_ROW', at); continue;
  }
  // 2 — declared target value hash must equal the real value
  if (sha(Buffer.from(canonicalize(targetValue))) !== row.targetValueHash) add('MAP_OR_PROVENANCE_MISMATCH', at);

  // 14 — reconstruction rule identity
  if (row.reconstructionRuleId !== rule.reconstructionRuleId) { unresolvedRuleIds++; add('UNKNOWN_RECONSTRUCTION_RULE', { ...at, actual: row.reconstructionRuleId }); }

  // ---- exact binding to the referenced field derivation rule (R2-AUD-02)
  const fdr = fdrById.get(row.fieldDerivationRuleId);
  if (!fdr) { fieldDerivationRuleBindingMismatches++; add('FIELD_DERIVATION_RULE_BINDING_MISMATCH', { ...at, reason: 'UNKNOWN_FIELD_DERIVATION_RULE_ID', fieldDerivationRuleId: row.fieldDerivationRuleId }); continue; }
  if (!new RegExp(fdr.targetPointerPattern).test(row.targetJsonPointer)) {
    targetPointerPatternMismatches++;
    add('TARGET_POINTER_PATTERN_MISMATCH', { ...at, fieldDerivationRuleId: fdr.id, pattern: fdr.targetPointerPattern });
  }
  if (row.transformationId !== fdr.transformationId) { transformationIdRuleMismatches++; add('TRANSFORMATION_ID_RULE_MISMATCH', { ...at, fieldDerivationRuleId: fdr.id, expected: fdr.transformationId, actual: row.transformationId }); }
  if (row.transformationVersion !== fdr.transformationVersion) { transformationVersionMismatches++; add('TRANSFORMATION_VERSION_MISMATCH', { ...at, expected: fdr.transformationVersion, actual: row.transformationVersion }); }
  if (row.semanticClassId !== fdr.semanticClassId) { semanticClassRuleMismatches++; add('SEMANTIC_CLASS_RULE_MISMATCH', { ...at, expected: fdr.semanticClassId, actual: row.semanticClassId }); }
  if (row.ownerPolicyReference !== fdr.ownerPolicyReference) { ownerPolicyRuleMismatches++; add('OWNER_POLICY_RULE_MISMATCH', { ...at, expected: fdr.ownerPolicyReference, actual: row.ownerPolicyReference }); }
  if (!fdr.allowedSourceArtifactIds.includes(row.sourceArtifactId)) { sourceAuthorityRuleMismatches++; add('SOURCE_AUTHORITY_RULE_MISMATCH', { ...at, allowed: fdr.allowedSourceArtifactIds, actual: row.sourceArtifactId }); }

  // 3/4 — source artifact identity and pinned bytes, resolved from the id only
  const resolvedSource = resolveSourceDocument(row);
  if (!resolvedSource) { unknownSourceIds++; add('UNKNOWN_SOURCE_ID', { ...at, sourceArtifactId: row.sourceArtifactId }); continue; }
  if (row.sourceSha256 !== resolvedSource.sha256) add('SOURCE_HASH_MISMATCH', { ...at, sourceArtifactId: row.sourceArtifactId, declared: row.sourceSha256, actual: resolvedSource.sha256 });

  // ---- declared source path must be safe and must equal the registered path (R2-AUD-01)
  const isRuleBound = fdr.pointerKind === 'RULE';
  if (isRuleBound) {
    if (row.sourcePath !== null) { sourcePathMismatches++; add('SOURCE_PATH_MISMATCH', { ...at, reason: 'RULE_BOUND_ROW_MUST_DECLARE_NULL_SOURCE_PATH', declared: row.sourcePath }); }
  } else {
    const unsafe = unsafeSourcePath(row.sourcePath);
    if (unsafe) { unsafeSourcePaths++; add('UNSAFE_SOURCE_PATH', { ...at, declared: row.sourcePath, reason: unsafe }); }
    else if (row.sourcePath !== resolvedSource.registeredRelativePath) {
      sourcePathMismatches++;
      add('SOURCE_PATH_MISMATCH', { ...at, sourceArtifactId: row.sourceArtifactId, declared: row.sourcePath, registered: resolvedSource.registeredRelativePath });
    }
  }

  // 5/6 — the pointer must exist, address a real value, and match the permitted pattern
  let resolvedSourceValue;
  if (isRuleBound) {
    if (row.sourceJsonPointer !== null && row.sourceJsonPointer !== undefined) {
      invalidSourcePointers++; forbiddenClaimViolations++;
      add('INVALID_SOURCE_JSON_POINTER', { ...at, reason: 'RULE_BOUND_ROW_MUST_NOT_CARRY_A_SOURCE_POINTER', sourceJsonPointer: row.sourceJsonPointer });
    }
    if (typeof row.rulePointer !== 'string') { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, reason: 'MISSING_RULE_POINTER' }); continue; }
    if (!new RegExp(fdr.rulePointerPattern).test(row.rulePointer)) { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, rulePointer: row.rulePointer, pattern: fdr.rulePointerPattern }); }
    resolvedSourceValue = resolveJsonPointer(rule, row.rulePointer);
    if (resolvedSourceValue === POINTER_NOT_RESOLVED) { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, rulePointer: row.rulePointer }); continue; }
  } else {
    if (row.rulePointer !== null && row.rulePointer !== undefined) { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, reason: 'SOURCE_BOUND_ROW_MUST_NOT_CARRY_A_RULE_POINTER' }); }
    if (typeof row.sourceJsonPointer !== 'string') { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, reason: 'MISSING_SOURCE_POINTER' }); continue; }
    if (!new RegExp(fdr.sourcePointerPattern).test(row.sourceJsonPointer)) { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, sourceJsonPointer: row.sourceJsonPointer, pattern: fdr.sourcePointerPattern }); }
    resolvedSourceValue = resolveJsonPointer(resolvedSource.doc, row.sourceJsonPointer);
    if (resolvedSourceValue === POINTER_NOT_RESOLVED) { invalidSourcePointers++; add('INVALID_SOURCE_JSON_POINTER', { ...at, sourceJsonPointer: row.sourceJsonPointer, sourceArtifactId: row.sourceArtifactId }); continue; }
  }

  // ===================== R4 : exact gate, branch, event, source and pointer binding
  // Value equality is never sufficient. Every row must simultaneously prove the right
  // gate, the right genesis event, the right branch, the right source, the right index,
  // the right transformation and the right value.
  {
    const inputs = row.transformationInputs || {};
    const identity = targetIdentity(row.targetJsonPointer);
    const targetGateIndex = gateIndexOfTarget(row.targetJsonPointer);
    const truth = targetGateIndex === null ? null : (gateTruth[targetGateIndex] ?? null);

    // A — the gate index is derived from the target pointer, never read from the row
    if (inputs.gateIndex !== undefined && (targetGateIndex === null || inputs.gateIndex !== targetGateIndex)) {
      R4.gateIndexTargetMismatches++;
      add('GATE_INDEX_TARGET_MISMATCH', { ...at, declared: inputs.gateIndex, derivedFromTargetPointer: targetGateIndex });
    }
    if (targetGateIndex !== null && !truth) {
      R4.gateIndexTargetMismatches++;
      add('GATE_INDEX_TARGET_MISMATCH', { ...at, reason: 'TARGET_GATE_HAS_NO_DERIVED_AUTHORITY', gateIndex: targetGateIndex });
    }

    // B — the branch is derived from the gate's genesis authorityPath
    if (inputs.branchId !== undefined) {
      if (!truth) { R4.branchSelectionMismatches++; add('BRANCH_SELECTION_MISMATCH', { ...at, reason: 'NO_DERIVED_BRANCH_FOR_TARGET', declared: inputs.branchId }); }
      else if (inputs.branchId !== truth.branchId) {
        R4.branchSelectionMismatches++;
        add('BRANCH_SELECTION_MISMATCH', { ...at, declared: inputs.branchId, derived: truth.branchId, authorityPath: truth.authorityPath });
      }
    }
    if (truth && inputs.authorityKind !== undefined && inputs.authorityKind !== truth.authorityKind) {
      R4.branchSelectionMismatches++;
      add('BRANCH_SELECTION_MISMATCH', { ...at, input: 'authorityKind', declared: inputs.authorityKind, derived: truth.authorityKind });
    }
    if (truth && inputs.historicalDetailCompleteness !== undefined && inputs.historicalDetailCompleteness !== truth.historicalDetailCompleteness) {
      R4.branchSelectionMismatches++;
      add('BRANCH_SELECTION_MISMATCH', { ...at, input: 'historicalDetailCompleteness', declared: inputs.historicalDetailCompleteness, derived: truth.historicalDetailCompleteness });
    }

    // C — external confirmation is derived from the same authority path
    if (inputs.externalConfirmed !== undefined) {
      if (!truth) { R4.externalConfirmationMismatches++; add('EXTERNAL_CONFIRMATION_MISMATCH', { ...at, reason: 'NO_DERIVED_AUTHORITY_FOR_TARGET', declared: inputs.externalConfirmed }); }
      else if (inputs.externalConfirmed !== truth.externalConfirmed) {
        R4.externalConfirmationMismatches++;
        add('EXTERNAL_CONFIRMATION_MISMATCH', { ...at, declared: inputs.externalConfirmed, derived: truth.externalConfirmed, authorityPath: truth.authorityPath });
      }
    }

    const expect = deriveExpectedBinding(row, truth, identity);
    if (!expect) {
      R4.sourceBranchPointerMismatches++;
      add('SOURCE_BRANCH_POINTER_MISMATCH', { ...at, reason: 'NO_DERIVABLE_EXPECTATION', sourceArtifactId: row.sourceArtifactId, fieldDerivationRuleId: fdr.id });
    } else {
      // D — the source index or source identity is the one actually selected
      if (inputs.sourceIndex !== expect.sourceIndex) {
        R4.sourceIndexBindingMismatches++;
        add('SOURCE_INDEX_BINDING_MISMATCH', { ...at, bindingKind: expect.kind, declared: inputs.sourceIndex ?? null, derived: expect.sourceIndex });
      }
      if (expect.kind === 'RULE_FALLBACK_CASE' && inputs.elementIndex !== expect.elementIndex) {
        R4.sourceIndexBindingMismatches++;
        add('SOURCE_INDEX_BINDING_MISMATCH', { ...at, reason: 'ELEMENT_INDEX_TARGET_MISMATCH', declared: inputs.elementIndex ?? null, derivedFromTargetPointer: expect.elementIndex });
      }
      if (expect.pointerKind !== fdr.pointerKind) {
        R4.sourceBranchPointerMismatches++;
        add('SOURCE_BRANCH_POINTER_MISMATCH', { ...at, reason: 'POINTER_KIND_MISMATCH', derived: expect.pointerKind, ruleBound: fdr.pointerKind });
      } else if (expect.kind === 'LEDGER_EVENT') {
        // E — the ledger event must be the genesis event of the target gate itself
        const parsed = /^\/(0|[1-9][0-9]*)\/([A-Za-z0-9_]+)$/.exec(row.sourceJsonPointer || '');
        if (!parsed) {
          R4.ledgerEventGateBindingMismatches++;
          add('LEDGER_EVENT_GATE_BINDING_MISMATCH', { ...at, reason: 'UNPARSABLE_LEDGER_EVENT_POINTER', declared: row.sourceJsonPointer, expected: expect.pointer });
        } else {
          const eventIndex = Number(parsed[1]);
          const eventField = parsed[2];
          const event = Array.isArray(ledgerDoc) ? ledgerDoc[eventIndex] : undefined;
          const problems = [];
          if (!event) problems.push('LEDGER_EVENT_NOT_FOUND');
          else {
            if (event.gateId !== truth.gateId) problems.push('LEDGER_EVENT_BELONGS_TO_ANOTHER_GATE');
            if (event.transitionType !== 'GENESIS_IMPORT' || event.fromStatus !== null) problems.push('LEDGER_EVENT_IS_NOT_A_GENESIS_IMPORT_EVENT');
          }
          if (eventIndex !== truth.eventIndex) problems.push('LEDGER_EVENT_INDEX_IS_NOT_THE_RECONSTRUCTED_GENESIS_INDEX');
          if (eventField !== expect.ledgerField) problems.push('LEDGER_FIELD_DOES_NOT_CORRESPOND_TO_THE_TARGET_FIELD');
          if (problems.length) {
            R4.ledgerEventGateBindingMismatches++;
            add('LEDGER_EVENT_GATE_BINDING_MISMATCH', { ...at, declared: row.sourceJsonPointer, expected: expect.pointer, targetGateId: truth.gateId, observedGateId: event?.gateId ?? null, problems });
          }
        }
      } else {
        // F — the constant, rule or registry pointer must be the exact derived pointer
        const declaredPointer = expect.pointerKind === 'RULE' ? row.rulePointer : row.sourceJsonPointer;
        if (declaredPointer !== expect.pointer) {
          R4.sourceBranchPointerMismatches++;
          add('SOURCE_BRANCH_POINTER_MISMATCH', { ...at, bindingKind: expect.kind, pointerKind: expect.pointerKind, declared: declaredPointer ?? null, expected: expect.pointer, derivedBranchId: truth ? truth.branchId : null });
        }
      }
    }
  }

  // 7 — transformation must be registered
  const transformation = transformations.get(row.transformationId);
  if (!transformation) { unknownTransformationIds++; add('UNKNOWN_TRANSFORMATION_ID', { ...at, transformationId: row.transformationId }); continue; }
  if (transformation.transformationVersion !== row.transformationVersion) { transformationVersionMismatches++; add('TRANSFORMATION_VERSION_MISMATCH', { ...at, registry: transformation.transformationVersion, declared: row.transformationVersion }); }

  // ---- transformationInputs must satisfy the registered contract (R2-AUD-03)
  if (!transformation.inputSchema) { invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, reason: 'NO_REGISTERED_INPUT_SCHEMA', transformationId: row.transformationId }); }
  else {
    const inputErrors = inputSchemaErrors(row.transformationInputs, transformation.inputSchema);
    if (inputErrors.length) { invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, transformationId: row.transformationId, errors: inputErrors }); }
    // declared inputs may not contradict the row they describe
    const inputs = row.transformationInputs || {};
    if (inputs.targetJsonPointer !== undefined && inputs.targetJsonPointer !== row.targetJsonPointer) { invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, reason: 'INPUT_CONTRADICTS_TARGET_POINTER' }); }
    if (inputs.sourceAuthorityId !== undefined && inputs.sourceAuthorityId !== row.sourceArtifactId) { invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, reason: 'INPUT_CONTRADICTS_SOURCE_AUTHORITY' }); }
    if (inputs.targetField !== undefined) {
      const tail = row.targetJsonPointer.split('/').filter(Boolean);
      const field = /^(?:0|[1-9][0-9]*)$/.test(tail[tail.length - 1]) ? tail[tail.length - 2] : tail[tail.length - 1];
      if (inputs.targetField !== field) { invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, reason: 'INPUT_CONTRADICTS_TARGET_FIELD', declared: inputs.targetField, actual: field }); }
      if (Array.isArray(transformation.allowedTargetFieldPatterns) && transformation.allowedTargetFieldPatterns.length && !transformation.allowedTargetFieldPatterns.includes(inputs.targetField)) {
        invalidTransformationInputs++; add('TRANSFORMATION_INPUT_SCHEMA_FAILURE', { ...at, reason: 'TARGET_FIELD_NOT_ALLOWED_BY_TRANSFORMATION', declared: inputs.targetField });
      }
    }
  }

  // 10 — semantic class must be registered
  const semanticClass = semanticClasses.get(row.semanticClassId);
  if (!semanticClass) { unknownSemanticClassIds++; add('UNKNOWN_SEMANTIC_CLASS_ID', { ...at, semanticClassId: row.semanticClassId }); continue; }

  // 8/11 — the class must admit both the transformation and the source
  if (!semanticClass.permittedTransformationIds.includes(row.transformationId)) add('SEMANTIC_CLASS_TRANSFORMATION_NOT_ALLOWED', { ...at, semanticClassId: row.semanticClassId, transformationId: row.transformationId });
  if (!semanticClass.permittedSourceAuthorityIds.includes(row.sourceArtifactId)) add('SEMANTIC_CLASS_SOURCE_NOT_ALLOWED', { ...at, semanticClassId: row.semanticClassId, sourceArtifactId: row.sourceArtifactId });

  // 12/13 — owner policy must exist and authorize this derivation
  const policy = ownerPolicies.get(row.ownerPolicyReference);
  if (!policy) { invalidOwnerPolicyReferences++; add('INVALID_OWNER_POLICY_REFERENCE', { ...at, ownerPolicyReference: row.ownerPolicyReference }); }
  else {
    if (!policy.authorizedTransformationIds.includes(row.transformationId)) add('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { ...at, ownerPolicyReference: row.ownerPolicyReference, transformationId: row.transformationId });
    if (!policy.authorizedSemanticClassIds.includes(row.semanticClassId)) add('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { ...at, ownerPolicyReference: row.ownerPolicyReference, semanticClassId: row.semanticClassId });
    if (semanticClass.requiredOwnerPolicyId !== row.ownerPolicyReference) add('OWNER_POLICY_DOES_NOT_AUTHORIZE_DERIVATION', { ...at, requiredOwnerPolicyId: semanticClass.requiredOwnerPolicyId, declared: row.ownerPolicyReference });
  }

  // 9 — replay the declared transformation from the resolved source value
  const replayed = replay(row, resolvedSourceValue);
  if (!replayed.ok) { failedTransformationReplays++; add('TRANSFORMATION_REPLAY_MISMATCH', { ...at, transformationId: row.transformationId, reason: replayed.reason }); }
  else if (canonicalize(replayed.value) !== canonicalize(targetValue)) {
    failedTransformationReplays++;
    add('TRANSFORMATION_REPLAY_MISMATCH', { ...at, transformationId: row.transformationId, replayed: replayed.value, target: targetValue });
  }

  // 15 — historicalOriginal must be consistent with the evidence
  if (row.historicalOriginal !== false) { historicalClaimsWithoutEvidence++; add('UNSUPPORTED_HISTORICAL_ORIGINAL_CLAIM', at); }
  if (semanticClass.historicalOriginalPermitted === false && row.historicalOriginal === true) { historicalClaimsWithoutEvidence++; add('UNSUPPORTED_HISTORICAL_ORIGINAL_CLAIM', at); }

  // 16 — forbidden claims
  if (row.semanticClassId === 'EXPLICIT_UNKNOWN_HISTORICAL_FALLBACK') {
    if (row.transformationId !== rule.unresolvedHistoricalDetailsPolicy.requiredTransformationId) { forbiddenClaimViolations++; add('FORBIDDEN_CLAIM_VIOLATION', { ...at, claim: 'unresolved history presented as known' }); }
    if (row.sourceArtifactId !== rule.unresolvedHistoricalDetailsPolicy.requiredSourceArtifactId) { forbiddenClaimViolations++; add('FORBIDDEN_CLAIM_VIOLATION', { ...at, claim: 'source authority invented' }); }
  }
}

// ============================================================ coverage (B04)
const uncoveredPointers = leaves.filter((l) => !byPointer.has(l.pointer)).map((l) => l.pointer);
const uncoveredPrimitiveFields = uncoveredPointers.length;
if (uncoveredPrimitiveFields) add('UNCOVERED_PRIMITIVE_FIELD', { count: uncoveredPrimitiveFields, pointers: uncoveredPointers.slice(0, 20) });
if (rule.unresolvedHistoricalDetailsPolicy.filteringForbidden === true) {
  const unresolvedLeaves = leaves.filter((l) => l.pointer.includes('/unresolvedHistoricalDetails/'));
  const uncoveredUnresolved = unresolvedLeaves.filter((l) => !byPointer.has(l.pointer));
  if (uncoveredUnresolved.length) add('PRIMITIVE_COVERAGE_FILTER_FORBIDDEN', { count: uncoveredUnresolved.length });
}
if (provenance.primitiveTargetCount !== leaves.length) add('PROVENANCE_COUNT_MISMATCH', { declared: provenance.primitiveTargetCount, actual: leaves.length });
if (provenance.provenanceRowCount !== rows.length) add('PROVENANCE_COUNT_MISMATCH', { declared: provenance.provenanceRowCount, actual: rows.length });
if (rule.primitiveCoveragePolicy.everyPrimitiveMapFieldCoveredExactlyOnce === true && (leaves.length !== rows.length || leaves.length !== byPointer.size)) {
  add('UNCOVERED_PRIMITIVE_FIELD', { primitiveTargetCount: leaves.length, provenanceRowCount: rows.length, uniqueTargetPointerCount: byPointer.size });
}
if (map.historicalOriginal !== false) { historicalClaimsWithoutEvidence++; add('UNSUPPORTED_HISTORICAL_ORIGINAL_CLAIM', { pointer: '/historicalOriginal' }); }
if (map.reconstructionRuleId !== rule.reconstructionRuleId) { unresolvedRuleIds++; add('UNKNOWN_RECONSTRUCTION_RULE', { actual: map.reconstructionRuleId }); }
if (!Array.isArray(map.gates) || map.gates.length !== rule.deterministicOutputRequirements.gateCount) add('MAP_SCHEMA_INVALID', { gates: map.gates?.length });
if (!map.gates?.some((g) => g.sourceAuthorityPath === 'SRC-R1-EXTERNAL-PASS')) add('MISSING_TRANSITION_AUTHORITY', {});

const report = {
  valid: errors.length === 0,
  errors, warnings,
  mapHash: mapDoc.sha256,
  provenanceHash: provenanceDoc.sha256,
  ruleHash: ruleDoc.sha256,
  normativeInputRegistryHash: authorityHash.normativeInputRegistry,
  transformationRegistryHash: authorityHash.transformationRegistry,
  semanticClassificationRegistryHash: authorityHash.semanticClassificationRegistry,
  ownerPolicyRegistryHash: authorityHash.ownerPolicyRegistry,
  primitiveLibHash: libSha,
  primitiveTargetCount: leaves.length,
  provenanceRowCount: rows.length,
  uniqueTargetPointerCount: byPointer.size,
  uncoveredPrimitiveFields,
  orphanProvenanceRows,
  unknownSourceIds,
  invalidSourcePointers,
  unknownTransformationIds,
  failedTransformationReplays,
  unknownSemanticClassIds,
  invalidOwnerPolicyReferences,
  unresolvedRuleIds,
  historicalClaimsWithoutEvidence,
  forbiddenClaimViolations,
  sourcePathMismatches,
  unsafeSourcePaths,
  fieldDerivationRuleBindingMismatches,
  targetPointerPatternMismatches,
  transformationIdRuleMismatches,
  transformationVersionMismatches,
  semanticClassRuleMismatches,
  ownerPolicyRuleMismatches,
  sourceAuthorityRuleMismatches,
  invalidTransformationInputs,
  gateIndexTargetMismatches: R4.gateIndexTargetMismatches,
  branchSelectionMismatches: R4.branchSelectionMismatches,
  externalConfirmationMismatches: R4.externalConfirmationMismatches,
  sourceIndexBindingMismatches: R4.sourceIndexBindingMismatches,
  ledgerEventGateBindingMismatches: R4.ledgerEventGateBindingMismatches,
  sourceBranchPointerMismatches: R4.sourceBranchPointerMismatches,
  exactBindingEnforced: true,
  valueEqualityAloneAcceptedAsProof: false,
  duplicateTargetPointers: rows.length - byPointer.size,
  exitCode: errors.length === 0 ? 0 : 2
};
emitReport(report);
