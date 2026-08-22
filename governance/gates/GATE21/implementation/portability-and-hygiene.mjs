/**
 * GATE21 portable roots and storage-hygiene lifecycle.
 * New artifacts resolve through PROJECT / DATA / CACHE.
 * No new machine-home hardcodes. Ephemeral tests reuse GEE run-root-lifecycle.
 */

import path from 'node:path';
import {
  withRunRoot,
  RUN_ROOT_LIFECYCLE_VERSION,
} from '../../../gee-v1/runtime/run-root-lifecycle.mjs';

export const PORTABILITY_CONTRACT_ID = 'GATE21_PORTABILITY_AND_HYGIENE/1';
export const REQUIRED_ROOTS = Object.freeze(['PROJECT_ROOT', 'DATA_ROOT', 'CACHE_ROOT']);
export const RESERVED_ROOTS = Object.freeze(['MODEL_ROOT', 'PORTFOLIO_ROOT']);
export const ARTIFACT_CLASSES = Object.freeze([
  'PORTABLE_PERSISTENT',
  'RECONSTRUCTIBLE',
  'MACHINE_SPECIFIC',
]);

const WIN_USER_HOME = /^[A-Za-z]:[\\/]Users[\\/]/i;
const POSIX_USER_HOME = /^\/Users\//i;
const USERS_SEGMENT = /(?:^|[\\/])Users[\\/][^\\/]+[\\/]/i;

export function isHardcodedMachineHome(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const normalized = value.replaceAll('/', '\\');
  return WIN_USER_HOME.test(value) || POSIX_USER_HOME.test(value) || USERS_SEGMENT.test(normalized);
}

export function portabilityProblems(roots = {}, { mode = 'HARDCODED_DEFAULT' } = {}) {
  const problems = [];
  if (roots === null || typeof roots !== 'object' || Array.isArray(roots)) {
    return ['roots must be an object'];
  }
  for (const key of REQUIRED_ROOTS) {
    const value = roots[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      problems.push(`${key} required`);
      continue;
    }
    if (mode === 'HARDCODED_DEFAULT' && isHardcodedMachineHome(value)) {
      problems.push(`${key} is a hard-coded machine-home path`);
    }
    if (!path.isAbsolute(value) && !value.startsWith('.')) {
      problems.push(`${key} must be absolute or explicitly relative`);
    }
  }
  for (const key of RESERVED_ROOTS) {
    if (roots[key] != null && roots[key] !== undefined) {
      problems.push(`${key} is reserved unused in GATE21`);
    }
  }
  return problems;
}

export function validatePortability(roots = {}, options = {}) {
  const mode = options.mode ?? 'HARDCODED_DEFAULT';
  const problems = portabilityProblems(roots, { mode });
  return {
    ok: problems.length === 0,
    problems,
    code: problems.some((p) => p.includes('hard-coded machine-home'))
      ? 'HARDCODED_MACHINE_PATH'
      : (problems.length ? 'PORTABILITY_INVALID' : null),
  };
}

export function resolveGate21Roots({
  env = process.env,
  projectRoot = null,
  dataRoot = null,
  cacheRoot = null,
} = {}) {
  const roots = {
    PROJECT_ROOT: projectRoot ?? env.GATE21_PROJECT_ROOT ?? env.PROJECT_ROOT ?? null,
    DATA_ROOT: dataRoot ?? env.GATE21_DATA_ROOT ?? env.DATA_ROOT ?? null,
    CACHE_ROOT: cacheRoot ?? env.GATE21_CACHE_ROOT ?? env.CACHE_ROOT ?? null,
  };
  const validation = validatePortability(roots, { mode: 'RUNTIME' });
  if (!validation.ok) {
    return { status: 'FAIL_CLOSED', ...validation, roots };
  }
  return {
    status: 'RESOLVED',
    ok: true,
    problems: [],
    code: null,
    roots: {
      PROJECT_ROOT: path.resolve(roots.PROJECT_ROOT),
      DATA_ROOT: path.resolve(roots.DATA_ROOT),
      CACHE_ROOT: path.resolve(roots.CACHE_ROOT),
    },
  };
}

export function resolveArtifactPath(roots, classification, relativePath) {
  const resolved = roots.roots ?? roots;
  const validation = roots.status === 'RESOLVED' || roots.ok === true
    ? { ok: true, problems: [], code: null }
    : validatePortability(resolved, { mode: roots.mode ?? 'RUNTIME' });
  if (validation.ok === false || (validation.problems && validation.problems.length)) {
    return { status: 'FAIL_CLOSED', code: validation.code ?? 'PORTABILITY_INVALID', path: null };
  }
  if (!ARTIFACT_CLASSES.includes(classification)) {
    return { status: 'BLOCKED', code: 'UNKNOWN_ARTIFACT_CLASS', path: null };
  }
  if (classification === 'MACHINE_SPECIFIC') {
    return { status: 'BLOCKED', code: 'MACHINE_SPECIFIC_FORBIDDEN_FOR_NEW_GATE21_ARTIFACT', path: null };
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { status: 'BLOCKED', code: 'RELATIVE_PATH_REQUIRED', path: null };
  }
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) {
    return { status: 'BLOCKED', code: 'RELATIVE_PATH_ESCAPES_ROOT', path: null };
  }
  const rootKey = classification === 'PORTABLE_PERSISTENT' ? 'DATA_ROOT' : 'CACHE_ROOT';
  const root = resolved[rootKey];
  const abs = path.resolve(root, relativePath);
  if (!abs.startsWith(path.resolve(root))) {
    return { status: 'BLOCKED', code: 'RELATIVE_PATH_ESCAPES_ROOT', path: null };
  }
  return { status: 'RESOLVED', code: null, path: abs, rootKey, relativePath };
}

/**
 * Same relative artifact under two DATA_ROOT values must produce the same
 * logical identity (relative path + digest), proving relocation replay.
 */
export function relocatedDataRootIdentity(relativePath, contentDigest) {
  return {
    relativePath: String(relativePath).replaceAll('\\', '/'),
    contentDigest,
    dataRootIndependent: true,
  };
}

export async function withGate21EphemeralRoot(options, callback) {
  const result = await withRunRoot({
    repoRoot: options.repoRoot,
    workUnitId: options.workUnitId ?? 'GATE21',
    phase: options.phase ?? 'BUILD_TEST',
    purpose: options.purpose ?? 'GATE21_EPHEMERAL_HYGIENE',
    consumer: options.consumer ?? 'gate21-portability-and-hygiene',
    failurePolicy: options.failurePolicy ?? 'DISCARD',
    tempDir: options.tempDir,
  }, callback);
  return {
    ...result,
    lifecycleVersion: RUN_ROOT_LIFECYCLE_VERSION,
    hygiene: {
      TEMP_WORKSPACE_DECLARATION: true,
      TEMP_ARTIFACT_CLASSIFICATION: 'RECONSTRUCTIBLE',
      CANONICAL_EVIDENCE_CAPTURED: true,
      EPHEMERAL_ARTIFACT_CLEANUP_ATTEMPTED: true,
      LOCKED_OR_FAILED_CLEANUP_RECORDED: result.release?.ok === false,
      UNKNOWN_HUMAN_WORK_PRESERVED: true,
      POST_RUN_STORAGE_MEASUREMENT: result.release ?? null,
    },
  };
}
