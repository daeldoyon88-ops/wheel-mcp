import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  CanonicalizationError,
  assertValidUnicode,
  canonicalHash,
} from '../canonical/canonicalJsonV1.mjs';
import { DatasetSnapshotError, SHA256_OBJECT_ID_PATTERN } from '../contracts/datasetSnapshotV1.mjs';
import { isPlainObject, isPortableLogicalPath } from '../contracts/contractPrimitivesV1.mjs';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
  normalizeTransformImplementationManifestV1,
  transformImplementationHash as transformImplementationHashV1,
} from './transformImplementationManifestV1.mjs';

export const TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION = 'TransformImplementationManifest/2';
export const TRANSFORM_SOURCE_TEXT_POLICY_VERSION = 'TransformSourceText/1';

const ROOT_FIELDS = Object.freeze([
  'schemaVersion', 'runtimeContractVersion', 'moduleHashPolicyVersion', 'modules',
]);
const MODULE_FIELDS = Object.freeze(['logicalPath', 'canonicalContentSha256']);

/**
 * Decode JavaScript source bytes as strict UTF-8, reject a BOM and invalid
 * Unicode, then canonicalize CRLF and isolated CR to LF. No other byte is
 * changed and terminal-LF presence remains significant.
 * @param {Buffer|Uint8Array} sourceBytes
 */
export function normalizeTransformSourceTextV1(sourceBytes) {
  if (!Buffer.isBuffer(sourceBytes) && !(sourceBytes instanceof Uint8Array)) {
    throw new DatasetSnapshotError('TRANSFORM_SOURCE_TEXT_INVALID', 'sourceBytes must be bytes');
  }
  const bytes = Buffer.from(sourceBytes);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new DatasetSnapshotError('TRANSFORM_SOURCE_TEXT_BOM_FORBIDDEN', 'UTF-8 BOM is forbidden');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new DatasetSnapshotError('TRANSFORM_SOURCE_TEXT_UTF8_INVALID', 'module source is not valid UTF-8', { cause: error });
  }
  try {
    assertValidUnicode(text);
  } catch (error) {
    throw new DatasetSnapshotError('TRANSFORM_SOURCE_TEXT_UNICODE_INVALID', 'module source contains an invalid Unicode surrogate', { cause: error });
  }
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

/** @param {Buffer|Uint8Array} sourceBytes */
export function transformSourceTextSha256(sourceBytes) {
  const normalizedBytes = normalizeTransformSourceTextV1(sourceBytes);
  return `sha256:${createHash('sha256').update(normalizedBytes).digest('hex')}`;
}

/** @param {unknown} value @returns {string[]} */
export function transformImplementationManifestV2Problems(value) {
  if (!isPlainObject(value)) return ['manifest must be a plain object'];
  const manifest = /** @type {Record<string, unknown>} */ (value);
  const problems = [];
  for (const field of ROOT_FIELDS) if (!Object.hasOwn(manifest, field)) problems.push(`${field} is required`);
  for (const field of Object.keys(manifest)) if (!ROOT_FIELDS.includes(field)) problems.push(`unknown field: ${field}`);
  if (manifest.schemaVersion !== TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION}`);
  }
  if (typeof manifest.runtimeContractVersion !== 'string' || manifest.runtimeContractVersion.length === 0) {
    problems.push('runtimeContractVersion must be a non-empty string');
  }
  if (manifest.moduleHashPolicyVersion !== TRANSFORM_SOURCE_TEXT_POLICY_VERSION) {
    problems.push(`moduleHashPolicyVersion must be ${TRANSFORM_SOURCE_TEXT_POLICY_VERSION}`);
  }
  if (!Array.isArray(manifest.modules) || manifest.modules.length === 0) {
    problems.push('modules must be a non-empty array');
    return problems;
  }
  const seen = new Set();
  manifest.modules.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      problems.push(`modules[${index}] must be an object`);
      return;
    }
    const module = /** @type {Record<string, unknown>} */ (entry);
    for (const field of MODULE_FIELDS) if (!Object.hasOwn(module, field)) problems.push(`modules[${index}].${field} is required`);
    for (const field of Object.keys(module)) if (!MODULE_FIELDS.includes(field)) problems.push(`modules[${index}] unknown field: ${field}`);
    if (!isPortableLogicalPath(module.logicalPath)) problems.push(`modules[${index}].logicalPath is not portable`);
    if (typeof module.canonicalContentSha256 !== 'string' || !SHA256_OBJECT_ID_PATTERN.test(module.canonicalContentSha256)) {
      problems.push(`modules[${index}].canonicalContentSha256 must use sha256:<64 lowercase hex>`);
    }
    if (seen.has(module.logicalPath)) problems.push(`duplicate logicalPath: ${String(module.logicalPath)}`);
    seen.add(module.logicalPath);
  });
  return problems;
}

/** @param {unknown} value */
export function normalizeTransformImplementationManifestV2(value) {
  const problems = transformImplementationManifestV2Problems(value);
  const unknown = problems.find((problem) => problem.includes('unknown field:'));
  if (unknown) throw new CanonicalizationError('CANONICAL_UNKNOWN_FIELD', unknown);
  if (problems.length > 0) {
    throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', problems.join('; '), { problems });
  }
  const manifest = /** @type {any} */ (value);
  return {
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    runtimeContractVersion: manifest.runtimeContractVersion,
    moduleHashPolicyVersion: TRANSFORM_SOURCE_TEXT_POLICY_VERSION,
    modules: manifest.modules
      .map((module) => ({
        logicalPath: module.logicalPath,
        canonicalContentSha256: module.canonicalContentSha256,
      }))
      .sort((a, b) => a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0),
  };
}

/** @param {unknown} value */
export function normalizeTransformImplementationManifest(value) {
  const schemaVersion = isPlainObject(value) ? value.schemaVersion : undefined;
  if (schemaVersion === TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION) {
    return normalizeTransformImplementationManifestV1(value);
  }
  if (schemaVersion === TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION) {
    return normalizeTransformImplementationManifestV2(value);
  }
  throw new DatasetSnapshotError('SNAPSHOT_TRANSFORM_MANIFEST_INVALID', `unknown transform manifest schema: ${String(schemaVersion)}`);
}

/** @param {unknown} manifest */
export function transformImplementationManifestHash(manifest) {
  const normalized = normalizeTransformImplementationManifest(manifest);
  if (normalized.schemaVersion === TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION) {
    return transformImplementationHashV1(normalized);
  }
  return canonicalHash(TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION, normalized);
}

/** @param {unknown} manifest */
export function transformManifestModuleHashes(manifest) {
  const normalized = normalizeTransformImplementationManifest(manifest);
  return new Map(normalized.modules.map((module) => [
    module.logicalPath,
    normalized.schemaVersion === TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION
      ? module.canonicalContentSha256
      : module.contentSha256,
  ]));
}

/**
 * Build an explicit V2 manifest from source modules below one audited lab root.
 * @param {{labRoot: string, logicalPaths: string[], runtimeContractVersion: string}} input
 */
export function buildTransformImplementationManifestV2(input) {
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
    return { logicalPath, canonicalContentSha256: transformSourceTextSha256(readFileSync(physicalPath)) };
  });
  return normalizeTransformImplementationManifestV2({
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
    runtimeContractVersion: input.runtimeContractVersion,
    moduleHashPolicyVersion: TRANSFORM_SOURCE_TEXT_POLICY_VERSION,
    modules,
  });
}
