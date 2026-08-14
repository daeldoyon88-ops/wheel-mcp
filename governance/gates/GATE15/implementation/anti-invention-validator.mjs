import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalize, sha256Canonical, sha256Bytes } from '../../../tools/canonical-json.mjs';

export { canonicalize, sha256Canonical, sha256Bytes };

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, '../../../../');
export const GATE_ID = 'GATE15';
export const IMPLEMENTATION_DIR = 'governance/gates/GATE15/implementation';
export const TEST_PATH = 'governance/gates/GATE15/tests/gate15-anti-invention.test.mjs';
export const EVIDENCE_PATH = 'governance/gates/GATE15/evidence/ANTI_INVENTION_VALIDATION_EVIDENCE.json';
export const CONTRACT_PATH = 'governance/gates/GATE15/contracts/EXECUTION_CONTRACT_R0001.json';
export const MANDATE_PATH = 'governance/sources/GATE15_CANONICAL_MANDATE_R0.json';
export const VALIDATOR_MODULE_PATH = 'governance/gates/GATE15/implementation/anti-invention-validator.mjs';

export const REASON_CODES = Object.freeze([
  'FABRICATED_EVIDENCE',
  'UNSUPPORTED_PASS_OR_STATUS',
  'HARDCODED_VALIDATION_SUCCESS',
  'AUTHORITATIVE_SOURCE_MISSING',
  'SOURCE_EVIDENCE_HASH_MISMATCH',
  'CIRCULAR_VALIDATION',
  'SYNTHETIC_EVIDENCE_AS_OBSERVED',
  'INVENTED_PROBABILITY_OR_CONFIDENCE',
  'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY',
  'UNTRACEABLE_DERIVED_OUTPUT',
  'CONTRADICTORY_EVIDENCE',
  'STALE_EVIDENCE_AS_CURRENT',
  'REQUIRED_EVIDENCE_MISSING',
  'EVIDENCE_MUTATED_AFTER_VALIDATION'
]);

export const VALIDATOR_IDS = Object.freeze([
  'G15-V01', 'G15-V02', 'G15-V03', 'G15-V04', 'G15-V05', 'G15-V06'
]);

const ROOT_KEYS = new Set([
  'document', 'schemaVersion', 'gateId', 'contractBinding', 'requiredSourceIds',
  'sources', 'claims', 'transformations', 'provenanceEdges', 'processIdentity',
  'evidenceIdentity', 'claimedVerdict', 'validationResult', 'resolutions'
]);
const SOURCE_KEYS = new Set([
  'sourceId', 'path', 'classification', 'authorityClass', 'expectedSha256',
  'expectedByteLength', 'observedBytesBase64', 'identity', 'revision', 'metadata',
  'assertions', 'authority'
]);
const CLAIM_KEYS = new Set([
  'claimId', 'claimType', 'subject', 'value', 'sourceIds', 'authoritativePointer',
  'asOfBoundary', 'transformationId', 'freshnessSensitive'
]);
const TRANSFORMATION_KEYS = new Set([
  'transformationId', 'inputSourceIds', 'inputDigest', 'outputDigest'
]);
const EDGE_KEYS = new Set(['sourceId', 'claimId', 'relation']);
const PROCESS_KEYS = new Set(['runtime', 'nodeMajor', 'validatorModule', 'executionClass']);
const BINDING_KEYS = new Set(['algorithm', 'boundBodySha256']);
const CLAIM_TYPES = new Set(['STATUS', 'DERIVED', 'TIMESTAMP', 'REVISION', 'IDENTITY', 'PROBABILITY', 'CONFIDENCE']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function sorted(values) { return [...values].sort(); }
function sameSet(a, b) { return sorted(a).join('\n') === sorted(b).join('\n'); }
function sameValue(a, b) { return sha256Canonical(a) === sha256Canonical(b); }
function unique(values) { return [...new Set(values)]; }
function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\')
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && !value.includes('*') && !value.includes('?')
    && !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}
function resolveUnderRoot(root, relativePath) {
  if (!safeRelative(relativePath)) return null;
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...relativePath.split('/'));
  return resolved.startsWith(`${base}${path.sep}`) ? resolved : null;
}
function readBytes(root, relativePath) {
  const file = resolveUnderRoot(root, relativePath);
  return file && fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null;
}
function readJson(root, relativePath) {
  const bytes = readBytes(root, relativePath);
  if (!bytes) return null;
  try { return JSON.parse(bytes.toString('utf8').replace(/^ï»¿/, '')); } catch { return null; }
}
function pointerValue(value, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  return pointer.slice(1).split('/').reduce((current, segment) => {
    if (current === undefined || current === null) return undefined;
    return current[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
  }, value);
}
function unknownKeys(value, allowed) { return Object.keys(value || {}).filter((key) => !allowed.has(key)); }
function processIdentity() {
  return { runtime: 'node', nodeMajor: Number(process.versions.node.split('.')[0]), validatorModule: VALIDATOR_MODULE_PATH, executionClass: 'PRODUCTION_VALIDATOR' };
}
function finding(reasonCode, detail, pathValue = null) {
  return { reasonCode, path: pathValue, detail };
}
function addFinding(findings, reasonCode, detail, pathValue = null) {
  if (!REASON_CODES.includes(reasonCode)) throw new Error(`UNKNOWN_REJECTION_REASON:${reasonCode}`);
  findings.push(finding(reasonCode, detail, pathValue));
}
function bodyForBinding(input) {
  const body = clone(input);
  if (body.evidenceIdentity) delete body.evidenceIdentity.boundBodySha256;
  return body;
}
function bodyDigest(input) { return sha256Canonical(bodyForBinding(input)); }
function digestForOutput(result) {
  return sha256Canonical({
    verdict: result.verdict,
    reasonCodes: result.reasonCodes,
    evidenceDigest: result.evidenceDigest,
    derived: result.derived
  });
}

export function bindEvidenceIdentity(input) {
  const output = clone(input);
  output.evidenceIdentity = { algorithm: 'SHA256_CANONICAL_JSON_EXCLUDING_BOUND_BODY_HASH_V1' };
  output.evidenceIdentity.boundBodySha256 = bodyDigest(output);
  return output;
}

function canonicalInputPaths(root) {
  const contract = readJson(root, CONTRACT_PATH);
  return {
    contract,
    requiredInputs: Array.isArray(contract?.requiredInputs) ? contract.requiredInputs : [],
    requiredPaths: Array.isArray(contract?.requiredInputs) ? contract.requiredInputs.map((item) => item.path) : []
  };
}

function readSourceDocument(root, source) {
  const bytes = readBytes(root, source.path);
  if (!bytes || !source.path.endsWith('.json')) return null;
  try { return JSON.parse(bytes.toString('utf8').replace(/^ï»¿/, '')); } catch { return null; }
}

function sourceActual(root, source) {
  const current = readBytes(root, source.path);
  if (current && (!source.expectedSha256 || sha256Bytes(current) === source.expectedSha256)) return { bytes: current, sha256: sha256Bytes(current), byteLength: current.length, document: readSourceDocument(root, source), authorityMode: 'CURRENT_REPOSITORY' };
  if (source.path === 'governance/state/GATE_STATUS_LEDGER.ndjson') {
    const authorityPath = path.resolve(root, 'governance/authority/authorizations/GATE15/GATE_START_RECORD.json');
    try {
      const authority = JSON.parse(fs.readFileSync(authorityPath, 'utf8'));
      const result = spawnSync('git', ['show', `${authority.baseCommit}:${source.path}`], { cwd: root, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
      if (result.status === 0 && sha256Bytes(result.stdout) === source.expectedSha256) return { bytes: result.stdout, sha256: sha256Bytes(result.stdout), byteLength: result.stdout.length, document: null, authorityMode: 'CONTRACT_PINNED_PRESTATE', baseCommit: authority.baseCommit, authorityPath: 'governance/authority/authorizations/GATE15/GATE_START_RECORD.json' };
    } catch { /* fail closed below */ }
  }
  return current ? { bytes: current, sha256: sha256Bytes(current), byteLength: current.length, document: readSourceDocument(root, source), authorityMode: 'CURRENT_REPOSITORY' } : null;
}

function expectedInput(requiredInputs, sourcePath) {
  return requiredInputs.find((item) => item.path === sourcePath) || null;
}

function validateShape(input, findings) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'The evidence package must be an object.');
    return;
  }
  for (const key of unknownKeys(input, ROOT_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported evidence property: ${key}`, `/${key}`);
  for (const key of ['document', 'schemaVersion', 'gateId', 'contractBinding', 'requiredSourceIds', 'sources', 'claims', 'transformations', 'provenanceEdges', 'processIdentity', 'evidenceIdentity']) {
    if (!Object.hasOwn(input, key)) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', `Required evidence member is absent: ${key}`, `/${key}`);
  }
  if (input.document !== 'GATE15_ANTI_INVENTION_EVIDENCE_PACKAGE' || input.schemaVersion !== 1 || input.gateId !== GATE_ID) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', 'Evidence package identity is unsupported.');
  if (!Array.isArray(input.sources) || !Array.isArray(input.requiredSourceIds) || !Array.isArray(input.claims) || !Array.isArray(input.transformations) || !Array.isArray(input.provenanceEdges)) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Evidence collections must be arrays.');
  for (const key of unknownKeys(input.processIdentity, PROCESS_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported process identity property: ${key}`, `/processIdentity/${key}`);
  for (const key of unknownKeys(input.evidenceIdentity, BINDING_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported evidence identity property: ${key}`, `/evidenceIdentity/${key}`);
}

function validateContractBinding(root, input, facts, findings) {
  const actual = readBytes(root, CONTRACT_PATH);
  const contract = facts.contract;
  const binding = input?.contractBinding;
  if (!binding || !actual || !contract) {
    addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', 'The executable GATE15 contract cannot be resolved.');
    return;
  }
  if (binding.path !== CONTRACT_PATH || binding.revision !== contract.contractRevision) addFinding(findings, 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY', 'Contract identity or revision is not authoritative.', '/contractBinding');
  if (binding.sha256 !== sha256Bytes(actual) || binding.byteLength !== actual.length) addFinding(findings, 'SOURCE_EVIDENCE_HASH_MISMATCH', 'The contract binding does not match its current bytes.', '/contractBinding');
}

function validateSources(root, input, facts, findings) {
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  const byId = new Map(sources.map((source) => [source?.sourceId, source]));
  const requiredPaths = facts.requiredPaths;
  const requiredIds = Array.isArray(input?.requiredSourceIds) ? input.requiredSourceIds : [];
  for (const requiredPath of requiredPaths) {
    if (!byId.has(requiredPath) || !requiredIds.includes(requiredPath)) addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', `Required authoritative source is absent: ${requiredPath}`, '/sources');
  }
  if (!sameSet(requiredIds, requiredPaths)) addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', 'Required source identity set differs from the executable contract.', '/requiredSourceIds');
  for (const source of sources) {
    if (!source || typeof source !== 'object') { addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Source binding is malformed.', '/sources'); continue; }
    for (const key of unknownKeys(source, SOURCE_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported source property: ${key}`, `/sources/${source.sourceId || '?'}/${key}`);
    const actual = sourceActual(root, source);
    const expected = expectedInput(facts.requiredInputs, source.path)
      || (source.path === CONTRACT_PATH && actual ? { sha256: actual.sha256 } : null);
    if (!expected || source.sourceId !== source.path) addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', 'Source is not declared by the executable contract.', `/sources/${source.sourceId || '?'}`);
    if (source.path === EVIDENCE_PATH || ['VALIDATOR_OUTPUT', 'PRODUCER_SUMMARY'].includes(source.authorityClass)) addFinding(findings, 'CIRCULAR_VALIDATION', 'A validator output or producer summary cannot be its own authority.', `/sources/${source.sourceId || '?'}`);
    if (!actual) { addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', `Authoritative source bytes are absent: ${source.path}`, `/sources/${source.sourceId || '?'}`); continue; }
    if (source.classification !== 'OBSERVED' || source.authorityClass !== 'CANONICAL_REPOSITORY' || source.synthetic === true) addFinding(findings, 'SYNTHETIC_EVIDENCE_AS_OBSERVED', 'Only observed canonical repository bytes may be presented as observed evidence.', `/sources/${source.sourceId}`);
    let observed;
    try { observed = Buffer.from(source.observedBytesBase64 || '', 'base64'); } catch { observed = Buffer.alloc(0); }
    if (!Buffer.from(observed).equals(actual.bytes)) addFinding(findings, 'FABRICATED_EVIDENCE', 'Observed evidence bytes differ from the authoritative source bytes.', `/sources/${source.sourceId}`);
    if (source.expectedSha256 !== actual.sha256 || source.expectedByteLength !== actual.byteLength || expected?.sha256 !== actual.sha256) addFinding(findings, 'SOURCE_EVIDENCE_HASH_MISMATCH', 'Observed source hash or byte length does not match the bound source.', `/sources/${source.sourceId}`);
    if (actual.authorityMode === 'CONTRACT_PINNED_PRESTATE' && (source.authority?.mode !== actual.authorityMode || source.authority?.baseCommit !== actual.baseCommit || source.authority?.authorityPath !== actual.authorityPath)) addFinding(findings, 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY', 'Pre-state source bytes must be bound to the canonical START authority.', `/sources/${source.sourceId}/authority`);
    if (source.identity?.sourcePath !== source.path || source.identity?.sha256 !== actual.sha256 || source.identity?.byteLength !== actual.byteLength) addFinding(findings, 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY', 'Source identity is not recomputed from authoritative bytes.', `/sources/${source.sourceId}/identity`);
    if (source.revision?.contractRevision !== facts.contract?.contractRevision) addFinding(findings, 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY', 'Source revision is not bound to the executable contract revision.', `/sources/${source.sourceId}/revision`);
    const document = actual.document;
    const metadata = source.metadata || {};
    for (const descriptor of ['identityPointer', 'revisionPointer', 'asOfPointer']) {
      const pointer = metadata[descriptor];
      if (pointer && (pointer.sourcePath !== source.path || pointer.value !== pointerValue(document, pointer.pointer))) addFinding(findings, 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY', `Source metadata ${descriptor} is not authoritative.`, `/sources/${source.sourceId}/metadata/${descriptor}`);
    }
  }
  return byId;
}

function validateClaims(input, sourceById, root, findings) {
  const claims = Array.isArray(input?.claims) ? input.claims : [];
  const transformations = new Map((input?.transformations || []).map((item) => [item?.transformationId, item]));
  const claimById = new Map();
  const subjects = new Map();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') { addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Claim is malformed.', '/claims'); continue; }
    for (const key of unknownKeys(claim, CLAIM_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported claim property: ${key}`, `/claims/${claim.claimId || '?'}/${key}`);
    if (!claim.claimId || claimById.has(claim.claimId) || !CLAIM_TYPES.has(claim.claimType) || !Array.isArray(claim.sourceIds) || claim.sourceIds.length === 0 || !Object.hasOwn(claim, 'value')) {
      addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Claim identity, type, value and source bindings are mandatory.', `/claims/${claim.claimId || '?'}`);
      continue;
    }
    claimById.set(claim.claimId, claim);
    for (const sourceId of claim.sourceIds) if (!sourceById.has(sourceId)) addFinding(findings, 'AUTHORITATIVE_SOURCE_MISSING', `Claim source is not bound: ${sourceId}`, `/claims/${claim.claimId}/sourceIds`);
    const subject = claim.subject || claim.claimId;
    if (!subjects.has(subject)) subjects.set(subject, []);
    subjects.get(subject).push(claim);
    if (['PROBABILITY', 'CONFIDENCE'].includes(claim.claimType) && (!claim.authoritativePointer || claim.sourceIds.length !== 1)) addFinding(findings, 'INVENTED_PROBABILITY_OR_CONFIDENCE', 'Probability and confidence require one authoritative value pointer.', `/claims/${claim.claimId}`);
    if (['STATUS', 'TIMESTAMP', 'REVISION', 'IDENTITY', 'PROBABILITY', 'CONFIDENCE'].includes(claim.claimType)) {
      const source = sourceById.get(claim.sourceIds[0]);
      const document = source ? readSourceDocument(root, source) : null;
      const authoritativeValue = pointerValue(document, claim.authoritativePointer);
      if (!claim.authoritativePointer || authoritativeValue === undefined || !sameValue(authoritativeValue, claim.value)) {
        const reason = ['PROBABILITY', 'CONFIDENCE'].includes(claim.claimType) ? 'INVENTED_PROBABILITY_OR_CONFIDENCE' : 'INVENTED_TIMESTAMP_REVISION_OR_IDENTITY';
        addFinding(findings, reason, 'Claim value is not equal to the authoritative source pointer.', `/claims/${claim.claimId}`);
      }
      if (claim.claimType === 'TIMESTAMP' || claim.freshnessSensitive === true) {
        const sourceMetadata = source?.metadata?.asOfPointer;
        const sourceDate = sourceMetadata?.value;
        if (!claim.asOfBoundary || typeof sourceDate !== 'string' || sourceDate > claim.asOfBoundary || sourceDate < claim.asOfBoundary) addFinding(findings, 'STALE_EVIDENCE_AS_CURRENT', 'Freshness-sensitive evidence is outside its declared as-of boundary.', `/claims/${claim.claimId}/asOfBoundary`);
      }
    }
    if (claim.claimType === 'DERIVED') {
      const transformation = transformations.get(claim.transformationId);
      const expectedInputDigest = sha256Canonical(sorted(claim.sourceIds).map((sourceId) => ({ sourceId, sha256: sourceById.get(sourceId)?.expectedSha256 || null })));
      if (!transformation || !sameSet(transformation.inputSourceIds || [], claim.sourceIds) || transformation.inputDigest !== expectedInputDigest || transformation.outputDigest !== sha256Canonical(claim.value)) addFinding(findings, 'UNTRACEABLE_DERIVED_OUTPUT', 'Derived output is missing an exact source-to-output transformation.', `/claims/${claim.claimId}`);
    }
  }
  for (const [subject, items] of subjects) {
    const values = unique(items.map((item) => sha256Canonical(item.value)));
    if (values.length > 1 && !(input.resolutions || []).some((resolution) => resolution.subject === subject && resolution.canonicalClaimId)) addFinding(findings, 'CONTRADICTORY_EVIDENCE', `Contradictory evidence has no canonical resolution: ${subject}`, `/claims/${subject}`);
  }
  return claimById;
}

function validateProvenance(input, sourceById, claimById, findings) {
  const edges = Array.isArray(input?.provenanceEdges) ? input.provenanceEdges : [];
  const seen = new Set();
  for (const edge of edges) {
    for (const key of unknownKeys(edge, EDGE_KEYS)) addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', `Unsupported provenance property: ${key}`, `/provenanceEdges/${edge?.claimId || '?'}/${key}`);
    const identity = `${edge?.sourceId}|${edge?.claimId}|${edge?.relation}`;
    if (seen.has(identity)) addFinding(findings, 'UNTRACEABLE_DERIVED_OUTPUT', 'Duplicate provenance edge is not an exact provenance graph.', `/provenanceEdges/${edge?.claimId || '?'}`);
    seen.add(identity);
    if (!sourceById.has(edge?.sourceId) || !claimById.has(edge?.claimId)) addFinding(findings, 'UNTRACEABLE_DERIVED_OUTPUT', 'Provenance edge points to an unknown source or claim.', `/provenanceEdges/${edge?.claimId || '?'}`);
  }
  for (const claim of claimById.values()) for (const sourceId of claim.sourceIds) {
    const exists = edges.some((edge) => edge.sourceId === sourceId && edge.claimId === claim.claimId);
    if (!exists) addFinding(findings, 'UNTRACEABLE_DERIVED_OUTPUT', 'Every claim input must have an explicit provenance edge.', `/claims/${claim.claimId}`);
  }
}

function validateClaimedVerdict(input, findings) {
  if (!Object.hasOwn(input || {}, 'claimedVerdict')) return;
  if (!['PASS', 'BLOCKED'].includes(input.claimedVerdict) || !input.validationResult || !['PASS', 'BLOCKED'].includes(input.validationResult.verdict)) {
    addFinding(findings, 'UNSUPPORTED_PASS_OR_STATUS', 'A claimed verdict requires a supported validation result.', '/claimedVerdict');
  } else if (input.claimedVerdict === 'PASS' && input.validationResult.verdict !== 'PASS') {
    addFinding(findings, 'HARDCODED_VALIDATION_SUCCESS', 'A literal PASS conflicts with the recomputed validation result.', '/claimedVerdict');
  }
}

export function validatePackage(input, { root = REPO_ROOT } = {}) {
  const findings = [];
  validateShape(input, findings);
  const facts = canonicalInputPaths(root);
  validateContractBinding(root, input, facts, findings);
  const sourceById = validateSources(root, input, facts, findings);
  const claimById = validateClaims(input, sourceById, root, findings);
  validateProvenance(input, sourceById, claimById, findings);
  validateClaimedVerdict(input, findings);
  if (input?.claimedVerdict === 'PASS' && findings.length > 0) addFinding(findings, 'HARDCODED_VALIDATION_SUCCESS', 'A claimed PASS does not survive recomputation of the governed inputs.', '/claimedVerdict');
  if (input?.processIdentity?.runtime !== 'node' || input?.processIdentity?.validatorModule !== VALIDATOR_MODULE_PATH) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'A production validator process identity is required.', '/processIdentity');
  if (input?.evidenceIdentity?.algorithm !== 'SHA256_CANONICAL_JSON_EXCLUDING_BOUND_BODY_HASH_V1' || input?.evidenceIdentity?.boundBodySha256 !== bodyDigest(input)) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', 'The evidence package changed after its identity was bound.', '/evidenceIdentity');
  const reasonCodes = unique(findings.map((item) => item.reasonCode));
  const verdict = findings.length === 0 ? 'PASS' : 'BLOCKED';
  const result = {
    document: 'GATE15_ANTI_INVENTION_VALIDATION_RESULT',
    gateId: GATE_ID,
    verdict,
    reasonCode: reasonCodes[0] || null,
    reasonCodes,
    findings,
    evidenceDigest: sha256Canonical(input),
    derived: {
      sourceCount: sourceById.size,
      claimCount: claimById.size,
      provenanceEdgeCount: Array.isArray(input?.provenanceEdges) ? input.provenanceEdges.length : 0,
      processIdentity: processIdentity()
    }
  };
  result.outputDigest = digestForOutput(result);
  return result;
}

export function buildObservedSource(root, sourcePath, contractRevision) {
  const contract = readJson(root, CONTRACT_PATH);
  const expected = expectedInput(contract?.requiredInputs || [], sourcePath)
    || (sourcePath === CONTRACT_PATH && readBytes(root, sourcePath) ? { sha256: sha256Bytes(readBytes(root, sourcePath)) } : null);
  const actual = sourceActual(root, { path: sourcePath, expectedSha256: expected?.sha256 });
  const bytes = actual?.bytes || readBytes(root, sourcePath);
  if (!bytes || !expected) throw new Error(`SOURCE_NOT_DECLARED:${sourcePath}`);
  const source = {
    sourceId: sourcePath,
    path: sourcePath,
    classification: 'OBSERVED',
    authorityClass: 'CANONICAL_REPOSITORY',
    expectedSha256: expected.sha256,
    expectedByteLength: bytes.length,
    observedBytesBase64: bytes.toString('base64'),
    identity: { sourcePath, sha256: sha256Bytes(bytes), byteLength: bytes.length },
    revision: { contractRevision },
    metadata: {},
    assertions: [],
    ...(actual?.authorityMode === 'CONTRACT_PINNED_PRESTATE' ? { authority: { mode: actual.authorityMode, baseCommit: actual.baseCommit, authorityPath: actual.authorityPath } } : {})
  };
  const document = readSourceDocument(root, source);
  if (sourcePath === MANDATE_PATH) {
    source.metadata = {
      identityPointer: { sourcePath, pointer: '/authorityId', value: pointerValue(document, '/authorityId') },
      revisionPointer: { sourcePath, pointer: '/authorityId', value: pointerValue(document, '/authorityId') },
      asOfPointer: { sourcePath, pointer: '/issuedAtUtc', value: pointerValue(document, '/issuedAtUtc') }
    };
  }
  return source;
}

export function buildPositivePackage(root = REPO_ROOT) {
  const contract = readJson(root, CONTRACT_PATH);
  const mandate = readJson(root, MANDATE_PATH);
  if (!contract || !mandate) throw new Error('CANONICAL_G15_INPUTS_MISSING');
  const sources = [
    ...(contract.requiredInputs || []).map((item) => buildObservedSource(root, item.path, contract.contractRevision)),
    buildObservedSource(root, CONTRACT_PATH, contract.contractRevision)
  ];
  const sourceIds = sources.map((source) => source.sourceId);
  const mandateSource = sources.find((source) => source.path === MANDATE_PATH);
  const contractSource = sources.find((source) => source.path === CONTRACT_PATH);
  const claims = [
    { claimId: 'claim:canonical-name', claimType: 'STATUS', subject: 'GATE15_CANONICAL_NAME', value: mandate.canonicalName, sourceIds: [mandateSource.sourceId], authoritativePointer: '/canonicalName', freshnessSensitive: false },
    { claimId: 'claim:contract-revision', claimType: 'REVISION', subject: 'GATE15_CONTRACT_REVISION', value: contract.contractRevision, sourceIds: [contractSource.sourceId], authoritativePointer: '/contractRevision', freshnessSensitive: false },
    { claimId: 'claim:mandate-issued-at', claimType: 'TIMESTAMP', subject: 'GATE15_MANDATE_ISSUED_AT', value: mandate.issuedAtUtc, sourceIds: [mandateSource.sourceId], authoritativePointer: '/issuedAtUtc', asOfBoundary: mandate.issuedAtUtc, freshnessSensitive: true },
    { claimId: 'claim:derived-objective', claimType: 'DERIVED', subject: 'GATE15_CANONICAL_OBJECTIVE', value: mandate.canonicalObjective, sourceIds: [mandateSource.sourceId, contractSource.sourceId], transformationId: 'transform:canonical-objective' }
  ];
  const transformations = [{
    transformationId: 'transform:canonical-objective',
    inputSourceIds: [mandateSource.sourceId, contractSource.sourceId],
    inputDigest: sha256Canonical(sorted([mandateSource.sourceId, contractSource.sourceId]).map((sourceId) => ({ sourceId, sha256: sources.find((source) => source.sourceId === sourceId).expectedSha256 }))),
    outputDigest: sha256Canonical(mandate.canonicalObjective)
  }];
  const provenanceEdges = claims.flatMap((claim) => claim.sourceIds.map((sourceId) => ({ sourceId, claimId: claim.claimId, relation: claim.claimType === 'DERIVED' ? 'INPUT_TO' : 'SUPPORTS' })));
  return bindEvidenceIdentity({
    document: 'GATE15_ANTI_INVENTION_EVIDENCE_PACKAGE', schemaVersion: 1, gateId: GATE_ID,
    contractBinding: { path: CONTRACT_PATH, revision: contract.contractRevision, sha256: sha256Bytes(readBytes(root, CONTRACT_PATH)), byteLength: readBytes(root, CONTRACT_PATH).length },
    requiredSourceIds: (contract.requiredInputs || []).map((item) => item.path), sources, claims, transformations, provenanceEdges,
    processIdentity: processIdentity()
  });
}

export function canonicalArtifactIdentities(root = REPO_ROOT, paths = []) {
  return Object.fromEntries(paths.map((relativePath) => {
    const bytes = readBytes(root, relativePath);
    return [relativePath, bytes ? { sha256: sha256Bytes(bytes), byteLength: bytes.length } : { sha256: null, byteLength: null }];
  }));
}

export function validateEvidenceArtifact(evidence, { root = REPO_ROOT, coverage = null } = {}) {
  const findings = [];
  if (!evidence || evidence.document !== 'GATE15_ANTI_INVENTION_VALIDATION_EVIDENCE' || evidence.gateId !== GATE_ID) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Canonical validation evidence identity is invalid.');
  if (!Array.isArray(evidence?.executions) || evidence.executions.length === 0) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Real validator executions are required.', '/executions');
  for (const execution of evidence?.executions || []) {
    const actual = validatePackage(execution.inputPackage, { root });
    if (execution.inputDigest !== sha256Canonical(execution.inputPackage)) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', `Execution input digest mismatch: ${execution.executionId}`);
    if (execution.outputDigest !== actual.outputDigest || execution.rawOutput?.verdict !== actual.verdict || !sameSet(execution.rawOutput?.reasonCodes || [], actual.reasonCodes)) addFinding(findings, 'HARDCODED_VALIDATION_SUCCESS', `Execution output is not recomputed from raw input: ${execution.executionId}`);
    if (!execution.processIdentity?.runtime || !execution.processIdentity?.validatorModule) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', `Execution process identity missing: ${execution.executionId}`);
  }
  for (const [relativePath, identity] of Object.entries(evidence?.artifactHashes || {})) {
    const bytes = readBytes(root, relativePath);
    if (!bytes || identity?.sha256 !== sha256Bytes(bytes) || identity?.byteLength !== bytes.length) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', `Evidence artifact identity mismatch: ${relativePath}`);
  }
  if (coverage && evidence.coverageMatrixDigest !== sha256Canonical(coverage)) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', 'Coverage matrix digest does not match the evidence binding.');
  if (evidence?.evidenceIdentity?.boundBodySha256 !== bodyDigest(evidence)) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', 'Validation evidence changed after its identity was bound.');
  const result = { verdict: findings.length === 0 ? 'PASS' : 'BLOCKED', reasonCodes: unique(findings.map((item) => item.reasonCode)), findings, executionCount: evidence?.executions?.length || 0 };
  result.outputDigest = sha256Canonical(result);
  return result;
}

export function validateCoverageMatrix(matrix, { root = REPO_ROOT, evidence = null } = {}) {
  const findings = [];
  const mandate = readJson(root, MANDATE_PATH);
  const contract = readJson(root, CONTRACT_PATH);
  const validatorRegistry = readJson(root, `${IMPLEMENTATION_DIR}/ANTI_INVENTION_VALIDATOR_REGISTRY.json`);
  const expectedRequirements = (mandate?.functionalRequirements || []).map((item) => item.requirementId);
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  if (matrix?.gateId !== GATE_ID || matrix?.document !== 'GATE15_ANTI_INVENTION_COVERAGE_MATRIX') addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Coverage matrix identity is invalid.');
  if (matrix?.mandatoryClassCount !== expectedRequirements.length || matrix?.uncoveredMandatoryClassCount !== 0 || !sameSet(rows.map((row) => row.requirementId), expectedRequirements)) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Coverage matrix does not enumerate every canonical mandatory class exactly once.');
  for (const row of rows) if (row.result !== 'COVERED' || !row.validatorIds?.length || !row.testIds?.length || row.observedRunCount < 1) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', `Coverage row is not proven by real execution: ${row.requirementId}`);
  const declaredValidatorIds = (validatorRegistry?.validators || []).map((item) => item.validatorId);
  const exercised = new Set(matrix?.exercisedValidatorIds || []);
  if (matrix?.declaredValidatorCount !== declaredValidatorIds.length || matrix?.exercisedValidatorCount !== declaredValidatorIds.length || !sameSet(declaredValidatorIds, VALIDATOR_IDS) || !sameSet([...exercised], declaredValidatorIds)) addFinding(findings, 'REQUIRED_EVIDENCE_MISSING', 'Every declared anti-invention validator must be exercised.');
  if (evidence && evidence.coverageMatrixDigest !== sha256Canonical(matrix)) addFinding(findings, 'EVIDENCE_MUTATED_AFTER_VALIDATION', 'Coverage matrix evidence digest mismatch.');
  const result = { verdict: findings.length === 0 ? 'PASS' : 'BLOCKED', reasonCodes: unique(findings.map((item) => item.reasonCode)), findings, mandatoryClassCount: expectedRequirements.length, declaredValidatorCount: declaredValidatorIds.length };
  result.outputDigest = sha256Canonical(result);
  return result;
}

export function buildRequirementsRegistry(root = REPO_ROOT) {
  const mandate = readJson(root, MANDATE_PATH);
  return { document: 'GATE15_ANTI_INVENTION_REQUIREMENTS_REGISTRY', schemaVersion: 1, gateId: GATE_ID, source: MANDATE_PATH, requirementCount: mandate.functionalRequirements.length, requirements: mandate.functionalRequirements.map((item) => ({ requirementId: item.requirementId, rejectionReasonCode: item.rejectionReasonCode, statement: item.requirement })) };
}

export function buildValidatorRegistry() {
  return {
    document: 'GATE15_ANTI_INVENTION_VALIDATOR_REGISTRY', schemaVersion: 1, gateId: GATE_ID,
    validators: [
      { validatorId: 'G15-V01', name: 'authoritative-source-binding-validator', implementation: VALIDATOR_MODULE_PATH, input: 'evidencePackage.sources and contract.requiredInputs', output: 'PASS or BLOCKED with deterministic reason codes', provenance: 'exact source bytes, SHA-256 and byte length' },
      { validatorId: 'G15-V02', name: 'claim-provenance-validator', implementation: VALIDATOR_MODULE_PATH, input: 'evidencePackage.claims and provenanceEdges', output: 'traceable claim verdict', provenance: 'source-to-claim edges and transformations' },
      { validatorId: 'G15-V03', name: 'evidence-freshness-and-identity-validator', implementation: VALIDATOR_MODULE_PATH, input: 'source metadata and as-of claims', output: 'freshness and identity verdict', provenance: 'authoritative pointers, revisions and ordered timestamps' },
      { validatorId: 'G15-V04', name: 'deterministic-verdict-validator', implementation: VALIDATOR_MODULE_PATH, input: 'identical evidence package bytes', output: 'identical verdict, reason codes and digest', provenance: 'canonical JSON replay and fresh-process replay' },
      { validatorId: 'G15-V05', name: 'anti-circularity-validator', implementation: VALIDATOR_MODULE_PATH, input: 'authority classes and provenance graph', output: 'circularity verdict', provenance: 'producer output cannot be an authoritative input' },
      { validatorId: 'G15-V06', name: 'anti-invention-coverage-validator', implementation: VALIDATOR_MODULE_PATH, input: 'canonical requirements, test executions and coverage matrix', output: 'complete mandatory coverage verdict', provenance: 'machine-derived rows from real executions' }
    ]
  };
}

export function buildValidationPolicy(root = REPO_ROOT) {
  const mandate = readJson(root, MANDATE_PATH);
  return {
    document: 'GATE15_ANTI_INVENTION_VALIDATION_POLICY', schemaVersion: 1, gateId: GATE_ID,
    policyId: 'GATE15_FAIL_CLOSED_ANTI_INVENTION_POLICY_R1', authority: { contract: CONTRACT_PATH, mandate: MANDATE_PATH, generatedSummariesAreNonAuthoritative: true },
    verdicts: ['PASS', 'BLOCKED'],
    observedEvidence: { allowedClassification: 'OBSERVED', allowedAuthorityClass: 'CANONICAL_REPOSITORY', syntheticAsObserved: 'BLOCKED' },
    failClosed: { missingEvidence: 'BLOCKED', unknownEvidence: 'BLOCKED', ambiguousEvidence: 'BLOCKED', contradictoryEvidence: 'BLOCKED', staleEvidence: 'BLOCKED', mutatedEvidence: 'BLOCKED', hardcodedSuccess: 'BLOCKED', circularEvidence: 'BLOCKED' },
    rejectionReasonCodes: mandate.deterministicRejectionReasonCodes,
    identity: { algorithm: 'SHA256', packageBinding: 'SHA256_CANONICAL_JSON_EXCLUDING_BOUND_BODY_HASH_V1', sourceBindingIncludes: ['sourcePath', 'sha256', 'byteLength', 'contractRevision'] },
    determinism: { canonicalJson: true, freshProcessRequired: true, wallClockVerdictDependency: false, networkDependency: false }
  };
}

function cliOption(name, fallback = null) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback; }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const inputPath = cliOption('--input');
  const evidencePath = cliOption('--evidence');
  const coveragePath = cliOption('--coverage', 'governance/gates/GATE15/implementation/ANTI_INVENTION_COVERAGE_MATRIX.json');
  const root = path.resolve(cliOption('--root', REPO_ROOT));
  if (evidencePath) {
    let evidence = null; let coverage = null;
    try { evidence = JSON.parse(fs.readFileSync(path.resolve(evidencePath), 'utf8')); } catch { evidence = null; }
    try { coverage = JSON.parse(fs.readFileSync(path.resolve(coveragePath), 'utf8')); } catch { coverage = null; }
    const evidenceResult = validateEvidenceArtifact(evidence, { root, coverage });
    const coverageResult = validateCoverageMatrix(coverage, { root, evidence });
    const result = { document: 'GATE15_ANTI_INVENTION_ARTIFACT_VALIDATION', verdict: evidenceResult.verdict === 'PASS' && coverageResult.verdict === 'PASS' ? 'PASS' : 'BLOCKED', evidence: evidenceResult, coverage: coverageResult };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.verdict === 'PASS' ? 0 : 2;
  } else if (!inputPath) { process.stdout.write(`${JSON.stringify({ usage: 'node anti-invention-validator.mjs --input <package.json> [--root <repo>] or --evidence <evidence.json> [--coverage <matrix.json>]' }, null, 2)}\n`); }
  else {
    let input = null;
    try { input = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8')); } catch { input = null; }
    const result = validatePackage(input, { root });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.verdict === 'PASS' ? 0 : 2;
  }
}
