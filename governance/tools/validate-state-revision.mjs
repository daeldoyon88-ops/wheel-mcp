import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './canonical-json.mjs';
import { validateStateSeal } from './validate-state-seal.mjs';

const CHECKPOINT_FIELDS = ['gateId', 'stateRevision', 'milestone', 'resumePoint', 'completedTasks', 'openTasks', 'reusableEvidence', 'invalidatedEvidence', 'requiredNextActions', 'protectedHashes', 'createdAt'];
const DEFECT_FIELDS = ['defectId', 'severity', 'status', 'description', 'affectedRequirements', 'evidence', 'detector', 'repairScope', 'blockingProgression', 'openedAt', 'closedAt', 'closureEvidence'];
const POINTER_FIELDS = ['schemaVersion', 'gateId', 'stateRevision', 'revisionPath', 'stateSealSha256', 'committedByTransactionId'];

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resolveOptionPath(root, value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

function finding(findings, detectorId, jsonPointer, actualValue, expectedRule, message, requirementId = 'REQ-REV-01') {
  findings.push({ detectorId, severity: 'BLOCKING', jsonPointer, actualValue, expectedRule, message, requirementId });
}

function readJson(file, findings, requirementId) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    finding(findings, 'MISSING_REVISION_INPUT', '/', file, 'existing JSON file', 'Required revision input is missing.', requirementId);
    return null;
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    finding(findings, 'INVALID_JSON', '/', file, 'valid JSON', error.message, requirementId);
    return null;
  }
}

function checkObject(value, required, allowed, findings, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    finding(findings, 'SCHEMA_VIOLATION', '/', value, 'object', `${label} must be an object.`);
    return;
  }
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) finding(findings, 'SCHEMA_VIOLATION', '/', key, 'required property', `${label} is missing ${key}.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) finding(findings, 'SCHEMA_VIOLATION', `/${key}`, value[key], 'additionalProperties=false', `${label} contains unknown field ${key}.`);
}

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function resolveUnderRoot(root, relativePath, findings, pointer, requirementId = 'REQ-REV-02') {
  if (!safeRelative(relativePath)) {
    finding(findings, 'INVALID_NORMALIZED_PATH', pointer, relativePath, 'relative slash-separated path without traversal', 'Pointer path is unsafe.', requirementId);
    return null;
  }
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    finding(findings, 'PATH_OUTSIDE_ROOT', pointer, relativePath, 'target below governed root', 'Pointer path escapes the governed root.', requirementId);
    return null;
  }
  return resolved;
}

function allowedMilestones(contract) {
  const policy = contract?.checkpointPolicy;
  if (Array.isArray(policy)) return policy;
  if (policy && Array.isArray(policy.milestones)) return policy.milestones;
  if (policy && Array.isArray(policy.allowedMilestones)) return policy.allowedMilestones;
  return [];
}

function validateDefects(defects, previous, findings) {
  const priorOpen = new Map((previous?.defects || []).filter((defect) => defect.status === 'OPEN').map((defect) => [defect.defectId, defect]));
  const currentIds = new Set();
  for (const [index, defect] of (defects || []).entries()) {
    const pointer = `/defects/${index}`;
    checkObject(defect, DEFECT_FIELDS, DEFECT_FIELDS, findings, 'Defect');
    if (currentIds.has(defect?.defectId)) finding(findings, 'DUPLICATE_DEFECT_ID', `${pointer}/defectId`, defect?.defectId, 'unique defectId', 'Defect id is duplicated.');
    currentIds.add(defect?.defectId);
    if (defect?.status === 'CLOSED' && (!defect.closedAt || !defect.closureEvidence)) finding(findings, 'DEFECT_CLOSED_WITHOUT_EVIDENCE', pointer, defect, 'closedAt and closureEvidence are non-empty', 'A defect was closed without executed closure evidence.', 'REQ-DEF-01');
  }
  for (const defectId of priorOpen.keys()) if (!currentIds.has(defectId)) finding(findings, 'DEFECT_DROPPED', '/defects', defectId, 'all prior OPEN defects carried forward', 'An OPEN defect disappeared without a CLOSED transition.', 'REQ-DEF-01');
}

function validateStateRevision({ root, gateId, currentStatePath, contractPath }) {
  const findings = [];
  const rootResolved = path.resolve(root);
  const gateRoot = path.join(rootResolved, 'governance', 'gates', gateId);
  const revisionRoot = path.join(gateRoot, 'state', 'revisions');
  const currentPath = currentStatePath || path.join(gateRoot, 'state', 'CURRENT_STATE.json');
  const contract = contractPath && fs.existsSync(contractPath) ? readJson(contractPath, findings, 'REQ-CHK-01') : null;
  const current = readJson(currentPath, findings, 'REQ-REV-02');
  if (current) {
    checkObject(current, POINTER_FIELDS, POINTER_FIELDS, findings, 'CURRENT_STATE pointer');
    if (current.gateId !== gateId) finding(findings, 'POINTER_TARGET_MISMATCH', '/gateId', current.gateId, gateId, 'CURRENT_STATE gateId differs from requested gate.', 'REQ-REV-02');
  }
  if (!fs.existsSync(revisionRoot) || !fs.statSync(revisionRoot).isDirectory()) finding(findings, 'MISSING_REVISION_ROOT', '/', revisionRoot, 'existing revisions/Rxxxx directory', 'Revision root is missing.', 'REQ-REV-01');
  const revisionNames = fs.existsSync(revisionRoot) ? fs.readdirSync(revisionRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^R[0-9]{4}$/.test(entry.name)).map((entry) => entry.name).sort() : [];
  const revisionNumbers = revisionNames.map((name) => Number.parseInt(name.slice(1), 10));
  for (let index = 0; index < revisionNumbers.length; index += 1) if (revisionNumbers[index] !== index + 1) finding(findings, 'REVISION_SEQUENCE_GAP', '/stateRevision', revisionNumbers, 'R0001..Rxxxx without gaps', 'Revision sequence is not contiguous.', 'REQ-REV-01');
  const revisions = [];
  for (const revisionName of revisionNames) {
    const revisionDir = path.join(revisionRoot, revisionName);
    const checkpointPath = path.join(revisionDir, 'CHECKPOINT.json');
    const defectsPath = path.join(revisionDir, 'OPEN_DEFECTS.json');
    const sealPath = path.join(revisionDir, 'STATE_SEAL.json');
    const checkpoint = readJson(checkpointPath, findings, 'REQ-REV-01');
    const defects = readJson(defectsPath, findings, 'REQ-DEF-01');
    checkObject(checkpoint, CHECKPOINT_FIELDS, CHECKPOINT_FIELDS, findings, 'CHECKPOINT');
    checkObject(defects, ['gateId', 'stateRevision', 'defects'], ['gateId', 'stateRevision', 'defects'], findings, 'OPEN_DEFECTS');
    if (checkpoint && (checkpoint.gateId !== gateId || checkpoint.stateRevision !== revisionName)) finding(findings, 'REVISION_ID_MISMATCH', '/stateRevision', checkpoint.stateRevision, revisionName, 'Checkpoint identity differs from its directory.', 'REQ-REV-01');
    if (defects && (defects.gateId !== gateId || defects.stateRevision !== revisionName)) finding(findings, 'REVISION_ID_MISMATCH', '/stateRevision', defects.stateRevision, revisionName, 'Defect identity differs from its directory.', 'REQ-DEF-01');
    if (checkpoint && (!checkpoint.resumePoint || typeof checkpoint.resumePoint !== 'string')) finding(findings, 'EMPTY_RESUME_POINT', '/resumePoint', checkpoint.resumePoint, 'non-empty actionable next action', 'Checkpoint has no actionable resume point.', 'REQ-RSM-01');
    const milestones = allowedMilestones(contract);
    if (checkpoint && milestones.length > 0 && !milestones.includes(checkpoint.milestone)) finding(findings, 'MILESTONE_NOT_AUTHORIZED', '/milestone', checkpoint.milestone, milestones, 'Checkpoint milestone is outside contract checkpointPolicy.', 'REQ-CHK-01');
    validateDefects(defects?.defects, revisions.at(-1)?.defects?.defects ? { defects: revisions.at(-1).defects.defects } : null, findings);
    const sealReport = validateStateSeal({ root: rootResolved, sealPath });
    for (const sealFinding of sealReport.findings) findings.push({ ...sealFinding, jsonPointer: `${revisionName}${sealFinding.jsonPointer}` });
    revisions.push({ name: revisionName, number: Number.parseInt(revisionName.slice(1), 10), checkpoint, defects, sealPath });
    const protectedHashes = checkpoint?.protectedHashes || [];
    for (const [index, protectedHash] of protectedHashes.entries()) {
      const protectedPath = resolveUnderRoot(rootResolved, protectedHash.path, findings, `/${revisionName}/protectedHashes/${index}/path`);
      if (protectedPath && fs.existsSync(protectedPath) && sha256Bytes(fs.readFileSync(protectedPath)) !== protectedHash.sha256) finding(findings, 'PROTECTED_HASH_MISMATCH', `/${revisionName}/protectedHashes/${index}`, protectedHash, 'hash of protected real bytes', 'Protected authority was changed after checkpoint.', 'REQ-REV-01');
    }
  }
  for (let index = 1; index < revisions.length; index += 1) {
    const prior = revisions[index - 1].checkpoint;
    const currentCheckpoint = revisions[index].checkpoint;
    for (const action of prior?.requiredNextActions || []) if (!(currentCheckpoint?.completedTasks || []).includes(action)) finding(findings, 'RESTART_FROM_ZERO_DETECTED', `/${revisions[index].name}/completedTasks`, currentCheckpoint?.completedTasks, action, 'Next revision does not consume the prior checkpoint resume contract.', 'REQ-RSM-01');
  }
  if (current) {
    const target = resolveUnderRoot(rootResolved, current.revisionPath, findings, '/revisionPath');
    const maxRevision = revisions.at(-1)?.number || 0;
    const pointedRevision = Number.parseInt(current.stateRevision?.slice(1), 10);
    if (!target || !fs.existsSync(target)) finding(findings, 'POINTER_TARGET_MISSING', '/revisionPath', current.revisionPath, 'existing revision directory', 'CURRENT_STATE target is absent.', 'REQ-REV-02');
    if (!Number.isInteger(pointedRevision) || pointedRevision < maxRevision) finding(findings, 'CHECKPOINT_ROLLBACK', '/stateRevision', current.stateRevision, `R${String(maxRevision).padStart(4, '0')}`, 'CURRENT_STATE points to an older revision.', 'REQ-REV-02');
    if (pointedRevision > maxRevision) finding(findings, 'POINTER_TARGET_MISSING', '/stateRevision', current.stateRevision, 'existing maximum revision', 'CURRENT_STATE points beyond available revisions.', 'REQ-REV-02');
    if (target && fs.existsSync(path.join(target, 'STATE_SEAL.json')) && sha256Bytes(fs.readFileSync(path.join(target, 'STATE_SEAL.json'))) !== current.stateSealSha256) finding(findings, 'POINTER_HASH_MISMATCH', '/stateSealSha256', current.stateSealSha256, sha256Bytes(fs.readFileSync(path.join(target, 'STATE_SEAL.json'))), 'CURRENT_STATE hash matches its seal bytes.', 'REQ-REV-02');
  }
  return { valid: findings.length === 0, blockingCount: findings.length, findings, gateId, revisionCount: revisions.length, currentStatePath: path.relative(rootResolved, currentPath).replaceAll('\\', '/') };
}

export { validateStateRevision };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
  const gateId = option('--gate-id', 'GATE13');
  const gateRoot = path.join(root, 'governance', 'gates', gateId);
  const report = validateStateRevision({
    root,
    gateId,
    currentStatePath: resolveOptionPath(root, option('--current-state', path.join(gateRoot, 'state/CURRENT_STATE.json'))),
    contractPath: resolveOptionPath(root, option('--contract', path.join(gateRoot, 'contracts/EXECUTION_CONTRACT_R0001.json')))
  });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.valid ? 0 : 2;
}
