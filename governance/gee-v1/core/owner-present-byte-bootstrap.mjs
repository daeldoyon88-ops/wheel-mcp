/** Bounded R2 recovery primitive.  It consumes external ceremony input; it never emits it. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BOOTSTRAP_ID = 'GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_R1';
export const AUTHORITY_ID = 'GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_AUTHORITY_R1';
export const DECISION_ID = 'GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_DECISION_R1';
export const GATE_ID = 'GATE20';
export const OWNER_AUTHORIZATION_KIND = 'OWNER_PRESENT_BYTE_BOOTSTRAP_OWNER_AUTHORIZATION';
export const AUTHORITY_KIND = 'OWNER_PRESENT_BYTE_BOOTSTRAP_AUTHORITY';
export const TRANSITION_RECEIPT_KIND = 'OWNER_PRESENT_BYTE_BOOTSTRAP_TRANSITION_CONSUMPTION';
export const CONSUMPTION_KIND = 'OWNER_PRESENT_BYTE_BOOTSTRAP_CONSUMPTION';
export const OWNER_AUTHORIZATION_PATH = 'governance/authority/owner-present-byte-bootstrap/GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_DECISION_R1.json';
export const AUTHORITY_PATH = 'governance/authority/owner-present-byte-bootstrap/GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_AUTHORITY_R1.json';
export const TRANSITION_RECEIPT_PATH = 'governance/historical-architecture/GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_TRANSITION_R1.json';
export const CONSUMPTION_PATH = 'governance/historical-architecture/GATE20_OWNER_PRESENT_BYTE_BOOTSTRAP_CONSUMPTION_R1.json';
export const PREEXISTING_BYTE_RATIFICATION_KIND = 'OWNER_PREEXISTING_BYTE_RATIFICATION';
export const PREEXISTING_BYTE_RATIFICATION_PATH = 'governance/authority/owner-present-byte-bootstrap/GATE20_OWNER_PREEXISTING_C_BYTE_RATIFICATION_R1.json';
export const EXTERNAL_OWNER_BYTE_AUTHORITY_KIND = 'EXTERNAL_OWNER_BYTE_AUTHORITY';
export const EXTERNAL_OWNER_BYTE_CONSUMPTION_KIND = 'EXTERNAL_OWNER_BYTE_AUTHORITY_CONSUMPTION';
export const EXTERNAL_OWNER_BYTE_AUTHORITY_PATH = 'governance/authority/external-owner-byte-authority/GATE20_OWNER_BYTE_AUTHORITY_R1.json';
export const EXTERNAL_OWNER_BYTE_CONSUMPTION_PATH = 'governance/historical-architecture/GATE20_OWNER_BYTE_AUTHORITY_CONSUMPTION_R1.json';
const C_PATH = 'governance/tools/post-freeze-maintenance-observation.mjs';
const A = 'governance/gee-v1/core/current-byte-authorization.mjs';
const B = 'governance/gee-v1/core/canonical-authorized-cohort.mjs';
const CREATE_PATHS = [
  'governance/gee-v1/core/owner-present-byte-bootstrap.mjs',
  'governance/schemas/owner-present-byte-bootstrap-authority-v1.schema.json',
  'governance/tests/owner-present-byte-bootstrap.test.mjs',
  'governance/tests/fixtures/owner-present-byte-bootstrap-c-source.mjs'
];
const SHA = /^[0-9a-f]{64}$/;
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const finding = (code, detail = null) => detail === null ? { code } : { code, detail };

function file(root, relative, prefix = 'governance/') {
  if (typeof relative !== 'string' || !relative.startsWith(prefix) || relative.includes('..') || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, ...relative.split('/')); const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null;
}
function read(root, relative, findings, code) { const p = file(root, relative); if (!p || !fs.existsSync(p)) { findings.push(finding(code)); return null; } try { return { value: json(p), bytes: fs.readFileSync(p) }; } catch { findings.push(finding(`${code}_JSON_INVALID`)); return null; } }
function exactBindings(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) return false;
  const seen = new Set();
  for (const e of entries) { if (!e || ![A, B].includes(e.path) || seen.has(e.path) || !SHA.test(e.sha256 || '') || !Number.isInteger(e.byteLength) || e.byteLength < 0) return false; seen.add(e.path); }
  return seen.size === 2;
}
function sameBindings(left, right) { return exactBindings(left) && exactBindings(right) && left.every((e) => right.some((x) => x.path === e.path && x.sha256 === e.sha256 && x.byteLength === e.byteLength)); }
function exactCreateBindings(entries) {
  if (!Array.isArray(entries) || entries.length !== CREATE_PATHS.length) return false;
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !CREATE_PATHS.includes(entry.path) || seen.has(entry.path) || !SHA.test(entry.sha256 || '') || !Number.isInteger(entry.byteLength) || entry.byteLength < 0) return false;
    seen.add(entry.path);
  }
  return seen.size === CREATE_PATHS.length;
}
function sameCreateBindings(left, right) { return exactCreateBindings(left) && exactCreateBindings(right) && left.every((entry) => right.some((other) => other.path === entry.path && other.sha256 === entry.sha256 && other.byteLength === entry.byteLength)); }
function sameTransition(left, right) { return left && right && left.path === C_PATH && right.path === C_PATH && SHA.test(left.sourceSha256 || '') && SHA.test(left.targetSha256 || '') && left.sourceSha256 === right.sourceSha256 && left.targetSha256 === right.targetSha256 && left.sourceByteLength === right.sourceByteLength && left.targetByteLength === right.targetByteLength; }
function bootstrapDocuments(root, kinds) {
  const dirs = ['governance/authority/owner-present-byte-bootstrap/', 'governance/authority/external-owner-byte-authority/', 'governance/historical-architecture/']; const docs = [];
  for (const dir of dirs) { const p = file(root, dir, 'governance/'); if (!p || !fs.existsSync(p)) continue; for (const name of fs.readdirSync(p).filter((x) => x.endsWith('.json'))) { try { const value = json(path.join(p, name)); if (kinds.includes(value?.documentKind)) docs.push({ path: `${dir}${name}`, value }); } catch {} } }
  return docs;
}
function globalOneShot(root, findings, { requireConsumed = false } = {}) {
  const authorities = bootstrapDocuments(root, [AUTHORITY_KIND]);
  if (authorities.length !== 1 || authorities[0]?.path !== AUTHORITY_PATH || authorities[0]?.value?.bootstrapId !== BOOTSTRAP_ID || authorities[0]?.value?.authorityId !== AUTHORITY_ID) findings.push(finding('GLOBAL_BOOTSTRAP_AUTHORITY_IDENTITY_INVALID'));
  const anyAlternative = bootstrapDocuments(root, [AUTHORITY_KIND, TRANSITION_RECEIPT_KIND, CONSUMPTION_KIND]).some(({ value }) => value.bootstrapId !== BOOTSTRAP_ID || value.authorityId !== AUTHORITY_ID);
  if (anyAlternative) findings.push(finding('GLOBAL_BOOTSTRAP_ALIAS_OR_ALTERNATE_REFUSED'));
  const transitions = bootstrapDocuments(root, [TRANSITION_RECEIPT_KIND]); const consumptions = bootstrapDocuments(root, [CONSUMPTION_KIND]);
  if (transitions.length > 1 || consumptions.length > 1) findings.push(finding('GLOBAL_BOOTSTRAP_MAX_USE_EXCEEDED'));
  if (requireConsumed && (transitions.length !== 1 || transitions[0]?.path !== TRANSITION_RECEIPT_PATH || consumptions.length !== 1 || consumptions[0]?.path !== CONSUMPTION_PATH)) findings.push(finding('GLOBAL_BOOTSTRAP_DURABLE_RECEIPTS_INVALID'));
  return { transitions, consumptions };
}

/** External Owner object is a distinct input, bound by the authority; this module never creates it. */
export function evaluateExternalOwnerAuthorization({ root, authority }) {
  const findings = []; const owner = read(root, authority?.ownerAuthorizationPath, findings, 'OWNER_AUTHORIZATION_ABSENT');
  if (!owner) return { valid: false, findings };
  if (authority.ownerAuthorizationPath !== OWNER_AUTHORIZATION_PATH || hash(owner.bytes) !== authority.ownerAuthorizationSha256) findings.push(finding('OWNER_AUTHORIZATION_SHA_MISMATCH'));
  const o = owner.value;
  if (o.documentKind !== OWNER_AUTHORIZATION_KIND || o.decisionId !== DECISION_ID || authority.ownerDecisionId !== DECISION_ID) findings.push(finding('OWNER_DECISION_ID_MISMATCH'));
  if (o.gateId !== GATE_ID || o.bootstrapId !== BOOTSTRAP_ID || o.authorityId !== AUTHORITY_ID) findings.push(finding('OWNER_AUTHORIZATION_IDENTITY_MISMATCH'));
  if (o.issuedBy !== 'PROJECT_OWNER_EXTERNAL_CEREMONY' || o.derivedFromGitDelta !== false || o.derivedFromFinalGateIntegrityFindings !== false) findings.push(finding('OWNER_AUTHORIZATION_ROOT_INVALID'));
  if (!sameBindings(o.presentPaths, authority.presentPaths)) findings.push(finding('OWNER_AUTHORIZATION_BINDINGS_MISMATCH'));
  if (!sameTransition(o.transition, authority.transition)) findings.push(finding('OWNER_AUTHORIZATION_TRANSITION_MISMATCH'));
  if (o.preexistingByteRatificationPath !== PREEXISTING_BYTE_RATIFICATION_PATH || o.preexistingByteRatificationPath !== authority.preexistingByteRatificationPath || o.preexistingByteRatificationSha256 !== authority.preexistingByteRatificationSha256 || !SHA.test(o.preexistingByteRatificationSha256 || '')) findings.push(finding('OWNER_RATIFICATION_BINDING_MISMATCH'));
  return { valid: findings.length === 0, findings, owner: o };
}

/** Durable authority validation: intentionally does not read A/B live bytes. */
export function evaluateHistoricalOwnerPresentByteBootstrapAuthority({ root, authority }) {
  const findings = [];
  if (!authority || authority.documentKind !== AUTHORITY_KIND || authority.authorityId !== AUTHORITY_ID || authority.bootstrapId !== BOOTSTRAP_ID || authority.gateId !== GATE_ID) findings.push(finding('BOOTSTRAP_AUTHORITY_IDENTITY_INVALID'));
  if (authority?.authorityMode !== 'LOCAL_EXPLICIT_AUTHORITY' || authority?.maxUse !== 1 || authority?.derivedFromGitDelta !== false || authority?.derivedFromFinalGateIntegrityFindings !== false || authority?.permitsStart === true || authority?.permitsGateStatusMutation === true || authority?.permitsGATE21 === true || authority?.signature) findings.push(finding('BOOTSTRAP_AUTHORITY_CONSTRAINT_INVALID'));
  if (!exactBindings(authority?.presentPaths) || !sameTransition(authority?.transition, authority?.transition)) findings.push(finding('BOOTSTRAP_AUTHORITY_BINDINGS_INVALID'));
  findings.push(...evaluateExternalOwnerAuthorization({ root, authority }).findings); globalOneShot(root, findings);
  return { valid: findings.length === 0, findings };
}

/** Admission-only validation.  A/B must still be the exact live bytes here. */
export function evaluateOwnerPresentByteBootstrapAuthority({ root, authority }) {
  const historical = evaluateHistoricalOwnerPresentByteBootstrapAuthority({ root, authority }); const findings = [...historical.findings];
  for (const e of authority?.presentPaths ?? []) { const p = file(root, e.path); if (!p || !fs.existsSync(p)) { findings.push(finding('BOOTSTRAP_PRESENT_PATH_ABSENT', e.path)); continue; } const b = fs.readFileSync(p); if (hash(b) !== e.sha256) findings.push(finding('BOOTSTRAP_PRESENT_SHA_MISMATCH', e.path)); if (b.length !== e.byteLength) findings.push(finding('BOOTSTRAP_PRESENT_LENGTH_MISMATCH', e.path)); }
  return { valid: findings.length === 0, findings };
}

/** Durable transition validation: C/C' bindings are verified, never C' live bytes. */
export function evaluateHistoricalDurableTransitionReceipt({ root, receipt }) {
  const findings = [];
  if (!receipt || receipt.documentKind !== TRANSITION_RECEIPT_KIND || receipt.bootstrapId !== BOOTSTRAP_ID || receipt.authorityId !== AUTHORITY_ID || receipt.gateId !== GATE_ID || receipt.spent !== true || typeof receipt.consumedAt !== 'string') findings.push(finding('TRANSITION_RECEIPT_IDENTITY_INVALID'));
  const authorityRecord = read(root, AUTHORITY_PATH, findings, 'BOOTSTRAP_AUTHORITY_ABSENT'); const authority = authorityRecord?.value;
  if (!authority || !sameTransition(receipt, authority.transition) || receipt.authoritySha256 !== hash(authorityRecord?.bytes ?? Buffer.alloc(0)) || receipt.ownerDecisionId !== DECISION_ID || receipt.ownerAuthorizationPath !== OWNER_AUTHORIZATION_PATH || receipt.ownerAuthorizationSha256 !== authority.ownerAuthorizationSha256) findings.push(finding('TRANSITION_RECEIPT_BINDING_MISMATCH'));
  if (authority) findings.push(...evaluateHistoricalOwnerPresentByteBootstrapAuthority({ root, authority }).findings);
  globalOneShot(root, findings);
  return { valid: findings.length === 0, findings };
}

/** Initial transition admission only: C' must still be the exact live target. */
export function evaluateDurableTransitionReceipt({ root, receipt }) {
  const historical = evaluateHistoricalDurableTransitionReceipt({ root, receipt }); const findings = [...historical.findings];
  const target = file(root, C_PATH); if (!target || !fs.existsSync(target)) findings.push(finding('TRANSITION_TARGET_ABSENT')); else { const b = fs.readFileSync(target); if (b.length !== receipt?.targetByteLength) findings.push(finding('TRANSITION_TARGET_LENGTH_MISMATCH')); if (hash(b) !== receipt?.targetSha256) findings.push(finding('TRANSITION_TARGET_SHA_MISMATCH')); }
  return { valid: findings.length === 0, findings };
}

export function evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }) {
  const findings = [];
  if (!receipt || receipt.documentKind !== CONSUMPTION_KIND || receipt.bootstrapId !== BOOTSTRAP_ID || receipt.authorityId !== AUTHORITY_ID || receipt.gateId !== GATE_ID || receipt.spent !== true || typeof receipt.consumedAt !== 'string') findings.push(finding('BOOTSTRAP_RECEIPT_IDENTITY_INVALID'));
  const authorityRecord = read(root, AUTHORITY_PATH, findings, 'BOOTSTRAP_AUTHORITY_ABSENT'); const authority = authorityRecord?.value;
  if (!authority || receipt?.authoritySha256 !== hash(authorityRecord?.bytes ?? Buffer.alloc(0)) || receipt?.ownerDecisionId !== DECISION_ID || receipt?.ownerAuthorizationPath !== OWNER_AUTHORIZATION_PATH || receipt?.ownerAuthorizationSha256 !== authority.ownerAuthorizationSha256 || !sameBindings(receipt?.cohort, authority.presentPaths)) findings.push(finding('BOOTSTRAP_RECEIPT_BINDING_MISMATCH'));
  if (authority) findings.push(...evaluateHistoricalOwnerPresentByteBootstrapAuthority({ root, authority }).findings);
  const transitionRecord = read(root, TRANSITION_RECEIPT_PATH, findings, 'TRANSITION_RECEIPT_ABSENT'); if (transitionRecord) findings.push(...evaluateHistoricalDurableTransitionReceipt({ root, receipt: transitionRecord.value }).findings);
  globalOneShot(root, findings, { requireConsumed: true });
  return { valid: findings.length === 0, findings };
}

/** Initial admission path only: the receipt is accepted only while A/B are live-exact. */
export function evaluateLiveOwnerPresentByteBootstrapConsumption({ root, receipt }) {
  const historical = evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }); const findings = [...historical.findings];
  const authorityRecord = read(root, AUTHORITY_PATH, findings, 'BOOTSTRAP_AUTHORITY_ABSENT');
  if (authorityRecord) findings.push(...evaluateOwnerPresentByteBootstrapAuthority({ root, authority: authorityRecord.value }).findings);
  const transitionRecord = read(root, TRANSITION_RECEIPT_PATH, findings, 'TRANSITION_RECEIPT_ABSENT');
  if (transitionRecord) findings.push(...evaluateDurableTransitionReceipt({ root, receipt: transitionRecord.value }).findings);
  return { valid: findings.length === 0, findings };
}

/** A second consumption is forbidden forever, including an alias or a revision label. */
export function evaluateBootstrapIssuance({ root }) { const findings = []; globalOneShot(root, findings); const receipts = bootstrapDocuments(root, [TRANSITION_RECEIPT_KIND, CONSUMPTION_KIND]); if (receipts.length > 0) findings.push(finding('BOOTSTRAP_RETIRED')); return { valid: findings.length === 0, findings }; }

export function collectValidatedOwnerPresentByteBootstrapReceipts({ root, relativePaths }) {
  const out = new Map(relativePaths.map((p) => [p, new Set()])); const p = file(root, CONSUMPTION_PATH);
  if (!p || !fs.existsSync(p)) return out; let receipt; try { receipt = json(p); } catch { return out; }
  if (!evaluateOwnerPresentByteBootstrapConsumption({ root, receipt }).valid) return out;
  for (const e of receipt.cohort) if (out.has(e.path)) out.get(e.path).add(e.sha256);
  return out;
}

/** A consumed bootstrap transition certifies only its exact C successor bytes. */
export function collectValidatedOwnerPresentByteBootstrapSuccessorBindings({ root, gateId }) {
  const refused = [];
  if (gateId !== GATE_ID) return { bindings: [], refused: [{ code: 'BOOTSTRAP_GATE_MISMATCH' }] };
  const transitionRecord = read(root, TRANSITION_RECEIPT_PATH, refused, 'TRANSITION_RECEIPT_ABSENT');
  const consumptionRecord = read(root, CONSUMPTION_PATH, refused, 'BOOTSTRAP_CONSUMPTION_ABSENT');
  const ratificationRecord = read(root, PREEXISTING_BYTE_RATIFICATION_PATH, refused, 'PREEXISTING_BYTE_RATIFICATION_ABSENT');
  if (!transitionRecord || !consumptionRecord || !ratificationRecord) return { bindings: [], refused };
  const transition = evaluateHistoricalDurableTransitionReceipt({ root, receipt: transitionRecord.value });
  const consumption = evaluateOwnerPresentByteBootstrapConsumption({ root, receipt: consumptionRecord.value });
  if (!transition.valid) refused.push(...transition.findings);
  if (!consumption.valid) refused.push(...consumption.findings);
  const authorityRecord = read(root, AUTHORITY_PATH, refused, 'BOOTSTRAP_AUTHORITY_ABSENT');
  const ratification = ratificationRecord.value;
  if (!authorityRecord || ratification.documentKind !== PREEXISTING_BYTE_RATIFICATION_KIND || ratification.gateId !== GATE_ID || ratification.bootstrapId !== BOOTSTRAP_ID || ratification.authorityId !== AUTHORITY_ID || ratification.issuedBy !== 'PROJECT_OWNER_EXTERNAL_CEREMONY' || ratification.derivedFromGitDelta !== false || ratification.derivedFromFinalGateIntegrityFindings !== false || ratification.admissionMode !== 'OWNER_PREEXISTING_OBSERVED_BYTE_RATIFICATION' || ratification.publicationProgramId !== undefined || !sameTransition({ path: C_PATH, sourceSha256: ratification.observedByte?.sha256, sourceByteLength: ratification.observedByte?.byteLength, targetSha256: ratification.observedByte?.sha256, targetByteLength: ratification.observedByte?.byteLength }, { path: C_PATH, sourceSha256: transitionRecord.value.sourceSha256, sourceByteLength: transitionRecord.value.sourceByteLength, targetSha256: transitionRecord.value.sourceSha256, targetByteLength: transitionRecord.value.sourceByteLength }) || ratification.previousCanonical?.path !== C_PATH || !SHA.test(ratification.previousCanonical?.sha256 || '') || !Number.isInteger(ratification.previousCanonical?.byteLength) || authorityRecord.value.preexistingByteRatificationPath !== PREEXISTING_BYTE_RATIFICATION_PATH || authorityRecord.value.preexistingByteRatificationSha256 !== hash(ratificationRecord.bytes)) refused.push({ code: 'PREEXISTING_BYTE_RATIFICATION_INVALID' });
  if (refused.length !== 0) return { bindings: [], refused };
  const receipt = transitionRecord.value;
  return { bindings: [{
    bindingClass: 'OWNER_PREEXISTING_BYTE_RATIFICATION', path: C_PATH,
    candidateSha256: ratification.observedByte.sha256, candidateByteLength: ratification.observedByte.byteLength,
    prestateSha256: ratification.previousCanonical.sha256, prestateAbsent: false,
    authorityPath: PREEXISTING_BYTE_RATIFICATION_PATH, authorityId: ratification.ratificationId ?? null, programId: null,
    transitionPath: null, consumptionPath: null
  }, {
    bindingClass: 'OWNER_PRESENT_BYTE_BOOTSTRAP_SUCCESSOR',
    path: C_PATH, candidateSha256: receipt.targetSha256, candidateByteLength: receipt.targetByteLength,
    prestateSha256: receipt.sourceSha256, prestateAbsent: false,
    authorityPath: AUTHORITY_PATH, authorityId: AUTHORITY_ID, programId: BOOTSTRAP_ID,
    transitionPath: TRANSITION_RECEIPT_PATH, consumptionPath: CONSUMPTION_PATH
  }], refused };
}

/**
 * Owner byte authority is intentionally a separate root: the bootstrap has no
 * authority over its own implementation or the three companion CREATE paths.
 */
export function collectValidatedExternalOwnerByteAuthorityBindings({ root, gateId }) {
  const refused = [];
  if (gateId !== GATE_ID) return { bindings: [], refused: [{ code: 'EXTERNAL_OWNER_BYTE_GATE_MISMATCH' }] };
  const authorityRecord = read(root, EXTERNAL_OWNER_BYTE_AUTHORITY_PATH, refused, 'EXTERNAL_OWNER_BYTE_AUTHORITY_ABSENT');
  const consumptionRecord = read(root, EXTERNAL_OWNER_BYTE_CONSUMPTION_PATH, refused, 'EXTERNAL_OWNER_BYTE_CONSUMPTION_ABSENT');
  if (!authorityRecord || !consumptionRecord) return { bindings: [], refused };
  const authority = authorityRecord.value, consumption = consumptionRecord.value;
  if (authority.documentKind !== EXTERNAL_OWNER_BYTE_AUTHORITY_KIND || authority.gateId !== GATE_ID || authority.authorityId !== 'GATE20_OWNER_BYTE_AUTHORITY_R1' || authority.issuedBy !== 'PROJECT_OWNER_EXTERNAL_CEREMONY' || authority.maxUse !== 1 || authority.derivedFromGitDelta !== false || authority.derivedFromFinalGateIntegrityFindings !== false || authority.permitsFutureBytes !== false || authority.bootstrapId !== undefined || authority.authorityProducedByBootstrap !== undefined || !exactCreateBindings(authority.bindings)) refused.push({ code: 'EXTERNAL_OWNER_BYTE_AUTHORITY_INVALID' });
  if (consumption.documentKind !== EXTERNAL_OWNER_BYTE_CONSUMPTION_KIND || consumption.gateId !== GATE_ID || consumption.authorityPath !== EXTERNAL_OWNER_BYTE_AUTHORITY_PATH || consumption.authorityId !== authority.authorityId || consumption.authoritySha256 !== hash(authorityRecord.bytes) || consumption.spent !== true || !sameCreateBindings(consumption.cohort, authority.bindings)) refused.push({ code: 'EXTERNAL_OWNER_BYTE_CONSUMPTION_INVALID' });
  const authorityDocs = bootstrapDocuments(root, [EXTERNAL_OWNER_BYTE_AUTHORITY_KIND]);
  const consumptionDocs = bootstrapDocuments(root, [EXTERNAL_OWNER_BYTE_CONSUMPTION_KIND]);
  if (authorityDocs.length !== 1 || authorityDocs[0]?.path !== EXTERNAL_OWNER_BYTE_AUTHORITY_PATH || consumptionDocs.length !== 1 || consumptionDocs[0]?.path !== EXTERNAL_OWNER_BYTE_CONSUMPTION_PATH) refused.push({ code: 'EXTERNAL_OWNER_BYTE_MAX_USE_EXCEEDED' });
  if (refused.length !== 0) return { bindings: [], refused };
  return { bindings: authority.bindings.map((entry) => ({
    path: entry.path, candidateSha256: entry.sha256, candidateByteLength: entry.byteLength,
    prestateSha256: null, prestateAbsent: true, authorityPath: EXTERNAL_OWNER_BYTE_AUTHORITY_PATH,
    authorityId: authority.authorityId, programId: null, consumptionPath: EXTERNAL_OWNER_BYTE_CONSUMPTION_PATH
  })), refused };
}
