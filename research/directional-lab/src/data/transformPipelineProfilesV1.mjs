/**
 * Explicit transform pipeline profiles + coverage check against a
 * TransformImplementationManifest/1 or /2. The goal is to make a forgotten module
 * (adapter, normalizer, canonicalization, price-basis policy, relevant
 * corporate-action policy) an explicit error instead of a silent omission.
 * This is a versioned explicit list, not a transitive dependency analyzer.
 */

import {
  TRANSFORM_PIPELINE_BASE_ROLES,
  TRANSFORM_PIPELINE_KNOWN_ROLES,
  TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
  TransformPipelineError,
  normalizeTransformPipelineProfileV1,
} from '../contracts/transformPipelineProfileV1.mjs';
import {
  normalizeTransformImplementationManifest,
  transformManifestModuleHashes,
} from './transformImplementationManifestV2.mjs';

/** Role → logical module paths for the lab's own daily pipelines. */
export const LAB_PIPELINE_ROLE_LOGICAL_PATHS = Object.freeze({
  'lab-json-daily/1': Object.freeze({
    MATERIALIZER_REGISTRY: Object.freeze(['src/data/materializerRegistryV1.mjs']),
    SOURCE_ADAPTER: Object.freeze(['src/data/jsonDailyAdapter.mjs']),
    DAILY_BAR_NORMALIZER: Object.freeze(['src/data/normalizeDailyBars.mjs']),
    CANONICAL_DAILY_BARS: Object.freeze(['src/canonical/canonicalDailyBarsV1.mjs', 'src/canonical/canonicalJsonV1.mjs']),
    PRICE_BASIS_POLICY: Object.freeze(['src/data/selectPriceBasis.mjs']),
    CORPORATE_ACTION_POLICY: Object.freeze(['src/data/corporateActionPolicy.mjs']),
  }),
  'lab-csv-daily/1': Object.freeze({
    MATERIALIZER_REGISTRY: Object.freeze(['src/data/materializerRegistryV1.mjs']),
    SOURCE_ADAPTER: Object.freeze(['src/data/csvDailyAdapter.mjs', 'src/data/csvHeader.mjs']),
    DAILY_BAR_NORMALIZER: Object.freeze(['src/data/normalizeDailyBars.mjs']),
    CANONICAL_DAILY_BARS: Object.freeze(['src/canonical/canonicalDailyBarsV1.mjs', 'src/canonical/canonicalJsonV1.mjs']),
    PRICE_BASIS_POLICY: Object.freeze(['src/data/selectPriceBasis.mjs']),
    CORPORATE_ACTION_POLICY: Object.freeze(['src/data/corporateActionPolicy.mjs']),
  }),
});

/** Flattened sorted unique module list for one lab pipeline. @param {string} pipelineProfileId */
export function labPipelineLogicalPaths(pipelineProfileId) {
  const roles = /** @type {Record<string, readonly string[]>|undefined} */ (
    LAB_PIPELINE_ROLE_LOGICAL_PATHS[/** @type {any} */ (pipelineProfileId)]
  );
  if (!roles) {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', `unknown lab pipeline: ${String(pipelineProfileId)}`);
  }
  return [...new Set(Object.values(roles).flat())].sort();
}

/**
 * Build a profile by resolving each declared module's contentSha256 from an
 * already-built transform manifest. A module absent from the manifest is an
 * explicit error, never a silent omission.
 * @param {{pipelineProfileId: string, roleLogicalPaths: Record<string, readonly string[]>, transformManifest: unknown}} input
 */
export function buildTransformPipelineProfile(input) {
  if (!input || typeof input !== 'object') {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', 'profile build input is required');
  }
  const manifest = normalizeTransformImplementationManifest(input.transformManifest);
  const moduleHashes = transformManifestModuleHashes(manifest);
  if (!input.roleLogicalPaths || typeof input.roleLogicalPaths !== 'object' || Array.isArray(input.roleLogicalPaths)) {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', 'roleLogicalPaths must be an object');
  }
  const roles = Object.entries(input.roleLogicalPaths).map(([role, logicalPaths]) => {
    if (!Array.isArray(logicalPaths)) {
      throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', `role ${role} must declare an array of logical paths`);
    }
    return {
      role,
      modules: logicalPaths.map((logicalPath) => {
        const contentSha256 = moduleHashes.get(logicalPath);
        if (contentSha256 === undefined) {
          throw new TransformPipelineError('TRANSFORM_PIPELINE_MODULE_MISSING',
            `module is not covered by the transform manifest: ${String(logicalPath)}`, { role, logicalPath });
        }
        return { logicalPath, contentSha256 };
      }),
    };
  });
  return normalizeTransformPipelineProfileV1({
    schemaVersion: TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
    pipelineProfileId: input.pipelineProfileId,
    roles,
  });
}

/** @param {{pipelineProfileId: string, transformManifest: unknown}} input */
export function buildLabTransformPipelineProfile(input) {
  const roles = LAB_PIPELINE_ROLE_LOGICAL_PATHS[/** @type {any} */ (input?.pipelineProfileId)];
  if (!roles) {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', `unknown lab pipeline: ${String(input?.pipelineProfileId)}`);
  }
  return buildTransformPipelineProfile({
    pipelineProfileId: input.pipelineProfileId,
    roleLogicalPaths: /** @type {any} */ (roles),
    transformManifest: input.transformManifest,
  });
}

/**
 * Deterministic coverage problems of a transform manifest for a profile.
 * @param {{transformManifest: unknown, pipelineProfile: unknown, requiredRoles?: readonly string[]}} input
 * @returns {{code: string, detail: string}[]} empty when fully covered
 */
export function transformManifestCoverageProblems(input) {
  if (!input || typeof input !== 'object') {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', 'coverage input is required');
  }
  const manifest = normalizeTransformImplementationManifest(input.transformManifest);
  const profile = normalizeTransformPipelineProfileV1(input.pipelineProfile);
  const requiredRoles = input.requiredRoles === undefined
    ? TRANSFORM_PIPELINE_BASE_ROLES
    : input.requiredRoles;
  if (!Array.isArray(requiredRoles) || requiredRoles.some((role) => !TRANSFORM_PIPELINE_KNOWN_ROLES.includes(/** @type {any} */ (role)))) {
    throw new TransformPipelineError('TRANSFORM_PIPELINE_PROFILE_INVALID', 'requiredRoles must only contain known roles');
  }
  const problems = [];
  const declaredRoles = new Set(profile.roles.map((role) => role.role));
  for (const required of [...requiredRoles].sort()) {
    if (!declaredRoles.has(required)) {
      problems.push({ code: 'TRANSFORM_PIPELINE_ROLE_MISSING', detail: `required role is not declared: ${required}` });
    }
  }
  const moduleHashes = transformManifestModuleHashes(manifest);
  for (const role of profile.roles) {
    for (const module of role.modules) {
      const manifestHash = moduleHashes.get(module.logicalPath);
      if (manifestHash === undefined) {
        problems.push({
          code: 'TRANSFORM_PIPELINE_MODULE_MISSING',
          detail: `role ${role.role} module missing from transform manifest: ${module.logicalPath}`,
        });
      } else if (manifestHash !== module.contentSha256) {
        problems.push({
          code: 'TRANSFORM_PIPELINE_MODULE_HASH_MISMATCH',
          detail: `role ${role.role} module hash differs from transform manifest: ${module.logicalPath}`,
        });
      }
    }
  }
  return problems;
}

/**
 * Throwing variant for callers that require full coverage.
 * @param {{transformManifest: unknown, pipelineProfile: unknown, requiredRoles?: readonly string[]}} input
 */
export function assertTransformManifestCoverage(input) {
  const problems = transformManifestCoverageProblems(input);
  if (problems.length > 0) {
    throw new TransformPipelineError(problems[0].code, problems.map((problem) => problem.detail).join('; '), { problems });
  }
}
