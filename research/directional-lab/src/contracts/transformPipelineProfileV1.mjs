/**
 * TransformPipelineProfileV1 — explicit, versioned declaration of which
 * implementation modules fill each role of a source→normalized pipeline.
 * Modules are pinned by logical path AND content hash so a coverage check can
 * detect a missing module or a silently different implementation. This is a
 * deliberate explicit list, not a transitive dependency analyzer.
 */

import { canonicalHash } from '../canonical/canonicalJsonV1.mjs';
import { SHA256_OBJECT_ID_PATTERN } from './datasetSnapshotV1.mjs';
import {
  checkFieldSet,
  checkNonEmptyString,
  isPlainObject,
  isPortableLogicalPath,
  throwForProblems,
} from './contractPrimitivesV1.mjs';

export const TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION = 'TransformPipelineProfileV1';

/** Roles every daily-bar pipeline must declare. */
export const TRANSFORM_PIPELINE_BASE_ROLES = Object.freeze([
  'CANONICAL_DAILY_BARS', 'DAILY_BAR_NORMALIZER', 'MATERIALIZER_REGISTRY',
  'PRICE_BASIS_POLICY', 'SOURCE_ADAPTER',
]);

/** All roles the contract understands (corporate actions is per-pipeline). */
export const TRANSFORM_PIPELINE_KNOWN_ROLES = Object.freeze([
  'CANONICAL_DAILY_BARS', 'CORPORATE_ACTION_POLICY', 'DAILY_BAR_NORMALIZER',
  'MATERIALIZER_REGISTRY', 'PRICE_BASIS_POLICY', 'SOURCE_ADAPTER',
]);

const ROOT_FIELDS = Object.freeze(['schemaVersion', 'pipelineProfileId', 'roles']);
const ROLE_FIELDS = Object.freeze(['role', 'modules']);
const MODULE_FIELDS = Object.freeze(['logicalPath', 'contentSha256']);

export class TransformPipelineError extends Error {
  /** @param {string} code @param {string} message @param {object} [details] */
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'TransformPipelineError';
    this.code = code;
    this.details = details;
  }
}

/** @param {unknown} value @returns {string[]} */
export function transformPipelineProfileProblems(value) {
  if (!isPlainObject(value)) return ['profile must be a plain object'];
  const profile = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  checkFieldSet(profile, ROOT_FIELDS, problems);
  if (profile.schemaVersion !== TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION}`);
  }
  checkNonEmptyString(profile.pipelineProfileId, 'pipelineProfileId', problems);
  if (!Array.isArray(profile.roles) || profile.roles.length === 0) {
    problems.push('roles must be a non-empty array');
    return problems;
  }
  const seenRoles = new Set();
  /** @type {Map<string, string>} */
  const pathHashes = new Map();
  profile.roles.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`roles[${index}] must be an object`);
      return;
    }
    const role = /** @type {Record<string, unknown>} */ (entry);
    checkFieldSet(role, ROLE_FIELDS, problems);
    if (!TRANSFORM_PIPELINE_KNOWN_ROLES.includes(/** @type {any} */ (role.role))) {
      problems.push(`roles[${index}].role is unknown: ${String(role.role)}`);
      return;
    }
    if (seenRoles.has(role.role)) problems.push(`duplicate role: ${String(role.role)}`);
    seenRoles.add(role.role);
    if (!Array.isArray(role.modules) || role.modules.length === 0) {
      problems.push(`roles[${index}].modules must be a non-empty array`);
      return;
    }
    const seenPaths = new Set();
    role.modules.forEach((moduleEntry, moduleIndex) => {
      if (!isPlainObject(moduleEntry)) {
        problems.push(`roles[${index}].modules[${moduleIndex}] must be an object`);
        return;
      }
      const module = /** @type {Record<string, unknown>} */ (moduleEntry);
      checkFieldSet(module, MODULE_FIELDS, problems);
      if (!isPortableLogicalPath(module.logicalPath)) {
        problems.push(`roles[${index}].modules[${moduleIndex}].logicalPath is not a portable relative path`);
        return;
      }
      if (typeof module.contentSha256 !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(module.contentSha256)) {
        problems.push(`roles[${index}].modules[${moduleIndex}].contentSha256 must use sha256:<64 lowercase hex>`);
        return;
      }
      const logicalPath = /** @type {string} */ (module.logicalPath);
      if (seenPaths.has(logicalPath)) problems.push(`duplicate logicalPath in role ${String(role.role)}: ${logicalPath}`);
      seenPaths.add(logicalPath);
      const knownHash = pathHashes.get(logicalPath);
      if (knownHash !== undefined && knownHash !== module.contentSha256) {
        problems.push(`conflicting contentSha256 for logicalPath: ${logicalPath}`);
      }
      pathHashes.set(logicalPath, /** @type {string} */ (module.contentSha256));
    });
  });
  for (const required of TRANSFORM_PIPELINE_BASE_ROLES) {
    if (!seenRoles.has(required)) problems.push(`required role missing: ${required}`);
  }
  return problems;
}

/** @param {string[]} problems */
function profileErrorFor(problems) {
  const missing = problems.find((problem) => problem.startsWith('required role missing:'));
  if (missing) return new TransformPipelineError('TRANSFORM_PIPELINE_ROLE_MISSING', missing, { problems });
  const duplicate = problems.find((problem) => problem.startsWith('duplicate role:'));
  if (duplicate) return new TransformPipelineError('TRANSFORM_PIPELINE_ROLE_DUPLICATE', duplicate, { problems });
  return new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', problems.join('; '), { problems });
}

/** @param {unknown} value */
export function normalizeTransformPipelineProfileV1(value) {
  const problems = transformPipelineProfileProblems(value);
  throwForProblems(problems, profileErrorFor);
  const profile = /** @type {any} */ (value);
  return {
    schemaVersion: TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
    pipelineProfileId: profile.pipelineProfileId,
    roles: profile.roles
      .map((role) => ({
        role: role.role,
        modules: role.modules
          .map((module) => ({ logicalPath: module.logicalPath, contentSha256: module.contentSha256 }))
          .sort((a, b) => a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0),
      }))
      .sort((a, b) => a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
  };
}

/** @param {unknown} value */
export function validateTransformPipelineProfile(value) {
  const problems = transformPipelineProfileProblems(value);
  return { valid: problems.length === 0, problems };
}

/** Content-bound identity of a profile. @param {unknown} value */
export function transformPipelineProfileHash(value) {
  const normalized = normalizeTransformPipelineProfileV1(value);
  return canonicalHash(TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION, normalized);
}
