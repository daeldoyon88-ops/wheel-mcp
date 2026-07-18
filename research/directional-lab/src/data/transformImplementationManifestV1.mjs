import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalHash, CanonicalizationError } from '../canonical/canonicalJsonV1.mjs';
import { DatasetSnapshotError, SHA256_OBJECT_ID_PATTERN } from '../contracts/datasetSnapshotV1.mjs';

export const TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION = 'TransformImplementationManifest/1';

const ROOT_FIELDS = Object.freeze(['schemaVersion', 'modules', 'runtimeContractVersion']);
const MODULE_FIELDS = Object.freeze(['logicalPath', 'contentSha256']);

/** @param {string} logicalPath */
function isPortableLogicalPath(logicalPath) {
  if (typeof logicalPath !== 'string' || logicalPath.length === 0 || logicalPath.includes('\\') || logicalPath.includes('\0')) return false;
  if (logicalPath.includes(':') || logicalPath.startsWith('/') || isAbsolute(logicalPath)) return false;
  const segments = logicalPath.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** @param {unknown} value */
export function transformImplementationManifestProblems(value) {
  const problems = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['manifest must be a plain object'];
  const manifest = /** @type {Record<string, unknown>} */ (value);
  for (const field of ROOT_FIELDS) if (!Object.hasOwn(manifest, field)) problems.push(`${field} is required`);
  for (const field of Object.keys(manifest)) if (!ROOT_FIELDS.includes(field)) problems.push(`unknown field: ${field}`);
  if (manifest.schemaVersion !== TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION}`);
  }
  if (typeof manifest.runtimeContractVersion !== 'string' || manifest.runtimeContractVersion.length === 0) {
    problems.push('runtimeContractVersion must be a non-empty string');
  }
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    problems.push('modules must be a non-empty array');
  } else {
    const seen = new Set();
    manifest.modules.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`modules[${index}] must be an object`);
        return;
      }
      const module = /** @type {Record<string, unknown>} */ (entry);
      for (const field of MODULE_FIELDS) if (!Object.hasOwn(module, field)) problems.push(`modules[${index}].${field} is required`);
      for (const field of Object.keys(module)) if (!MODULE_FIELDS.includes(field)) problems.push(`modules[${index}] unknown field: ${field}`);
      if (!isPortableLogicalPath(/** @type {any} */ (module.logicalPath))) problems.push(`modules[${index}].logicalPath is not portable`);
      if (typeof module.contentSha256 !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(module.contentSha256)) {
        problems.push(`modules[${index}].contentSha256 must use sha256:<64 lowercase hex>`);
      }
      if (seen.has(module.logicalPath)) problems.push(`duplicate logicalPath: ${String(module.logicalPath)}`);
      seen.add(module.logicalPath);
    });
  }
  return problems;
}

/** @param {unknown} value */
export function normalizeTransformImplementationManifestV1(value) {
  const problems = transformImplementationManifestProblems(value);
  if (problems.some((problem) => problem.includes('unknown field:'))) {
    throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', problems.find((problem) => problem.includes('unknown field:')));
  }
  if (problems.length > 0) {
    throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', problems.join('; '), { problems });
  }
  const manifest = /** @type {any} */ (value);
  return {
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules: manifest.modules
      .map((module) => ({ logicalPath: module.logicalPath, contentSha256: module.contentSha256 }))
      .sort((a, b) => a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0),
    runtimeContractVersion: manifest.runtimeContractVersion,
  };
}

/**
 * Hash an explicit, audited list of implementation modules. No dependency
 * discovery, timestamps or absolute paths enter the manifest.
 * @param {{labRoot: string, logicalPaths: string[], runtimeContractVersion: string}} input
 */
export function buildTransformImplementationManifest(input) {
  if (!input || typeof input.labRoot !== 'string' || !isAbsolute(input.labRoot)) {
    throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', 'labRoot must be an absolute path');
  }
  if (!existsSync(input.labRoot) || !statSync(input.labRoot).isDirectory()) {
    throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', 'labRoot must be an existing directory');
  }
  if (!Array.isArray(input.logicalPaths) || input.logicalPaths.length === 0) {
    throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', 'logicalPaths must be a non-empty explicit list');
  }
  const rootReal = realpathSync(input.labRoot);
  const modules = input.logicalPaths.map((logicalPath) => {
    if (!isPortableLogicalPath(logicalPath)) {
      throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', `invalid logical path: ${String(logicalPath)}`);
    }
    const physicalPath = resolve(input.labRoot, ...logicalPath.split('/'));
    let moduleRealPath;
    try {
      moduleRealPath = realpathSync(physicalPath);
    } catch (error) {
      throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', `module is missing or unreadable: ${logicalPath}`, { cause: error });
    }
    const relativePath = relative(rootReal, moduleRealPath);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', `module escapes labRoot: ${logicalPath}`);
    }
    const bytes = readFileSync(physicalPath);
    return { logicalPath, contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  });
  return normalizeTransformImplementationManifestV1({
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules,
    runtimeContractVersion: input.runtimeContractVersion,
  });
}

/** @param {unknown} manifest */
export function transformImplementationHash(manifest) {
  const normalized = normalizeTransformImplementationManifestV1(manifest);
  return canonicalHash(TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION, normalized);
}
