/**
 * GEE V1 R6 repository index.
 *
 * The question this answers is narrow: WHERE IS THE RELEVANT REPOSITORY STATE,
 * and what is its identity right now? It is an index, not a summary — nothing
 * here reads a source file for meaning, classifies code, or forms an opinion.
 * Every derived field comes from a declared policy applied to a path, so two
 * runs over identical bytes under an identical policy produce byte-identical
 * output and one digest.
 *
 * Four properties hold it together:
 *
 * 1. NOTHING AMBIENT IN IDENTITY. No clock, no locale-sensitive ordering, no
 *    absolute repository root, no temp directory, no randomness. Paths are
 *    repository-relative, forward-slashed and NFC; ordering is by UTF-16 code
 *    unit. A different machine with the same bytes computes the same digest.
 *
 * 2. DERIVATION IS ORDER-FREE. Subsystem and layer come from longest-prefix
 *    match over a rule set with unique prefixes, so the same rules in any
 *    order classify identically. The normalized policy sorts them anyway.
 *
 * 3. REUSE IS PROVEN, NOT ASSUMED. Incremental update re-hashes a file unless
 *    an R3 delta proves that exact path unchanged, or an explicit changed-path
 *    set is separately declared exhaustive, and its size still matches the
 *    prior entry. A modification timestamp is never treated as content
 *    identity, and a partial change list degrades to a full re-hash.
 *
 * 4. BUILDERS CANONICALIZE, MATERIALIZED INDEXES ARE STRICT. validateRepoIndex()
 *    rejects a persisted index whose identifiers are not already canonical
 *    rather than rewriting them, because canonical-json hashes strings as NFC:
 *    silently normalizing would let one indexSha256 stand for two different
 *    runtime path resolutions.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes, sha256Canonical } from '../../tools/canonical-json.mjs';
import { validateAgainstJsonSchema } from '../contracts/validate-against-json-schema.mjs';

export const REPO_INDEX_VERSION = 'GEE_V1_REPO_INDEX_R6';
export const REPO_INDEX_KIND = 'GEE_REPO_INDEX';
export const REPO_INDEX_POLICY_VERSION = 'GEE_V1_REPO_INDEX_POLICY_R6';

/** Tracked/untracked is a Git fact, not a byte fact; absent, it stays UNKNOWN. */
export const TRACKED = 'TRACKED';
export const UNTRACKED = 'UNTRACKED';
export const TRACKED_UNKNOWN = 'UNKNOWN';
const TRACKED_STATES = Object.freeze([TRACKED, UNTRACKED, TRACKED_UNKNOWN]);

export const ENTRY_KINDS = Object.freeze(['JSON_SCHEMA', 'JSON', 'NDJSON', 'ESM_MODULE', 'SCRIPT', 'MARKDOWN', 'OTHER']);

/**
 * The default scope: the governance subtree, which is the whole of what GEE
 * work units read and write. Everything else in this repository is application
 * code that no GEE layer consumes, so indexing it would cost work and prove
 * nothing. A caller that genuinely needs more supplies its own roots.
 */
export const DEFAULT_REPO_INDEX_POLICY = Object.freeze({
  policyVersion: REPO_INDEX_POLICY_VERSION,
  roots: Object.freeze(['governance/']),
  excludedDirectorySegments: Object.freeze(['.git', 'node_modules', '.cache', 'coverage', 'dist', 'build', 'tmp']),
  excludedPathPrefixes: Object.freeze([]),
  subsystemRules: Object.freeze([
    Object.freeze({ prefix: 'governance/', subsystem: 'GOVERNANCE' }),
    Object.freeze({ prefix: 'governance/gee-v1/', subsystem: 'GEE_V1' }),
    Object.freeze({ prefix: 'governance/gee-v1/tests/', subsystem: 'GEE_V1_TESTS' }),
    Object.freeze({ prefix: 'governance/gee-v1/missions/', subsystem: 'GEE_V1_AUTHORITY' }),
    Object.freeze({ prefix: 'governance/gee-v1/schemas/', subsystem: 'GEE_V1_SCHEMAS' }),
    Object.freeze({ prefix: 'governance/gee-v1/adapters/', subsystem: 'GEE_V1_ADAPTERS' }),
    Object.freeze({ prefix: 'governance/gates/', subsystem: 'WHEEL_GATES' }),
    Object.freeze({ prefix: 'governance/tools/', subsystem: 'GOVERNANCE_TOOLS' })
  ]),
  layerRules: Object.freeze([
    Object.freeze({ prefix: 'governance/gee-v1/core/', layer: 'R1' }),
    Object.freeze({ prefix: 'governance/gee-v1/contracts/', layer: 'R1' }),
    Object.freeze({ prefix: 'governance/gee-v1/readiness/', layer: 'R1' }),
    Object.freeze({ prefix: 'governance/gee-v1/context/', layer: 'R2' }),
    Object.freeze({ prefix: 'governance/gee-v1/delta/', layer: 'R3' }),
    Object.freeze({ prefix: 'governance/gee-v1/evidence/', layer: 'R4' }),
    Object.freeze({ prefix: 'governance/gee-v1/cas/', layer: 'R4' }),
    Object.freeze({ prefix: 'governance/gee-v1/router/', layer: 'R5' }),
    Object.freeze({ prefix: 'governance/gee-v1/repair/', layer: 'R5' }),
    Object.freeze({ prefix: 'governance/gee-v1/index/', layer: 'R6' }),
    Object.freeze({ prefix: 'governance/gee-v1/recovery/', layer: 'R6' }),
    Object.freeze({ prefix: 'governance/gee-v1/usage/', layer: 'R6' })
  ]),
  governancePrefixes: Object.freeze(['governance/gee-v1/missions/', 'governance/gee-v1/schemas/', 'governance/PROJECT_CONSTITUTION.json']),
  geeRelevantPrefixes: Object.freeze(['governance/gee-v1/']),
  trackedStatusSource: 'UNAVAILABLE',
  trackedPathsSha256: null
});

function fail(reason) { throw new Error(`INVALID_REPO_INDEX_POLICY:${reason}`); }

function compareIdentifiers(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function isCanonicalIdentifier(value) { return typeof value === 'string' && value === value.normalize('NFC'); }

/**
 * THE canonical form of a repository-relative path, and the only one. Backslash
 * separators are a spelling of the same path, so they normalize; absolute
 * paths, traversal and empty segments are refused rather than repaired.
 */
export function canonicalRepoPath(value, field = 'REPO_PATH') {
  if (typeof value !== 'string' || !value) throw new Error(`${field}_REQUIRED`);
  const normalized = value.split('\\').join('/').normalize('NFC');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`INVALID_${field}:${value}`);
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error(`INVALID_${field}:${value}`);
  return normalized;
}

function canonicalRootPrefix(value) {
  const normalized = canonicalRepoPath(value.replace(/\/+$/, ''), 'REPO_INDEX_ROOT');
  return `${normalized}/`;
}

function normalizeRules(rules, valueField, label) {
  if (!Array.isArray(rules)) fail(`${label}_REQUIRED`);
  const seen = new Set();
  const normalized = rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail(`${label}_RULE_OBJECT_REQUIRED`);
    if (typeof rule.prefix !== 'string' || !rule.prefix) fail(`${label}_PREFIX_REQUIRED`);
    if (!isCanonicalIdentifier(rule.prefix)) fail(`NON_CANONICAL_${label}_PREFIX:${rule.prefix}`);
    const value = rule[valueField];
    if (typeof value !== 'string' || !value) fail(`${label}_VALUE_REQUIRED:${rule.prefix}`);
    if (!isCanonicalIdentifier(value)) fail(`NON_CANONICAL_${label}_VALUE:${value}`);
    // Unique prefixes are what make longest-prefix resolution order-free: with
    // a duplicate, two rules could claim one path and only declaration order
    // would settle it, which is exactly the ambiguity this must not carry.
    if (seen.has(rule.prefix)) fail(`DUPLICATE_${label}_PREFIX:${rule.prefix}`);
    seen.add(rule.prefix);
    return { prefix: rule.prefix, [valueField]: value };
  });
  return normalized.sort((a, b) => compareIdentifiers(a.prefix, b.prefix));
}

function normalizeStringList(values, label, { canonicalPath = false } = {}) {
  if (!Array.isArray(values)) fail(`${label}_REQUIRED`);
  const normalized = values.map((value) => {
    if (typeof value !== 'string' || !value) fail(`${label}_ENTRY_REQUIRED`);
    if (!isCanonicalIdentifier(value)) fail(`NON_CANONICAL_${label}:${value}`);
    return canonicalPath ? canonicalRepoPath(value, label) : value;
  });
  return [...new Set(normalized)].sort(compareIdentifiers);
}

/**
 * Validates and normalizes an index policy. A malformed policy is rejected
 * rather than silently completed from defaults: a caller who ships a broken
 * policy must find out, not receive an index built under one they never wrote.
 */
export function validateRepoIndexPolicy(policy = DEFAULT_REPO_INDEX_POLICY) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('POLICY_OBJECT_REQUIRED');
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion) fail('POLICY_VERSION_REQUIRED');
  if (!Array.isArray(policy.roots) || policy.roots.length === 0) fail('ROOTS_REQUIRED');
  const roots = [...new Set(policy.roots.map(canonicalRootPrefix))].sort(compareIdentifiers);
  // A root nested inside another would visit the same file twice and make the
  // duplicate-path rule fire on a policy mistake rather than on real data.
  for (const root of roots) {
    for (const other of roots) {
      if (root !== other && root.startsWith(other)) fail(`NESTED_ROOT:${root}`);
    }
  }
  const trackedStatusSource = policy.trackedStatusSource === undefined ? 'UNAVAILABLE' : policy.trackedStatusSource;
  if (trackedStatusSource !== 'UNAVAILABLE' && trackedStatusSource !== 'SUPPLIED') fail(`UNKNOWN_TRACKED_STATUS_SOURCE:${String(trackedStatusSource)}`);
  const trackedPathsSha256 = policy.trackedPathsSha256 === undefined ? null : policy.trackedPathsSha256;
  if (trackedPathsSha256 !== null && !/^[a-f0-9]{64}$/.test(String(trackedPathsSha256))) fail('INVALID_TRACKED_PATHS_DIGEST');
  // The supplied tracked set is an INPUT, so its identity belongs to the policy.
  // Without this, one index digest could stand for two different tracked states.
  if (trackedStatusSource === 'SUPPLIED' && trackedPathsSha256 === null) fail('TRACKED_PATHS_DIGEST_REQUIRED');
  if (trackedStatusSource === 'UNAVAILABLE' && trackedPathsSha256 !== null) fail('TRACKED_PATHS_DIGEST_FORBIDDEN');
  return Object.freeze({
    policyVersion: policy.policyVersion,
    roots: Object.freeze(roots),
    excludedDirectorySegments: Object.freeze(normalizeStringList(policy.excludedDirectorySegments || [], 'EXCLUDED_DIRECTORY_SEGMENT')),
    excludedPathPrefixes: Object.freeze(normalizeStringList(policy.excludedPathPrefixes || [], 'EXCLUDED_PATH_PREFIX')),
    subsystemRules: Object.freeze(normalizeRules(policy.subsystemRules || [], 'subsystem', 'SUBSYSTEM').map(Object.freeze)),
    layerRules: Object.freeze(normalizeRules(policy.layerRules || [], 'layer', 'LAYER').map(Object.freeze)),
    governancePrefixes: Object.freeze(normalizeStringList(policy.governancePrefixes || [], 'GOVERNANCE_PREFIX')),
    geeRelevantPrefixes: Object.freeze(normalizeStringList(policy.geeRelevantPrefixes || [], 'GEE_RELEVANT_PREFIX')),
    trackedStatusSource,
    trackedPathsSha256
  });
}

export function repoIndexPolicySha256(policy) { return sha256Canonical(validateRepoIndexPolicy(policy)); }

/** Deterministic identity of a supplied tracked-path set, for the policy above. */
export function trackedPathsSha256(paths) {
  if (!Array.isArray(paths)) throw new Error('TRACKED_PATHS_REQUIRED');
  return sha256Canonical([...new Set(paths.map((entry) => canonicalRepoPath(entry, 'TRACKED_PATH')))].sort(compareIdentifiers));
}

/* -------------------------------------------------------------------------
 * Derivation. Purely a function of (path, policy) — no file content is read.
 * ---------------------------------------------------------------------- */

function longestPrefixValue(rules, valueField, repoPath) {
  let best = null;
  for (const rule of rules) {
    if (!repoPath.startsWith(rule.prefix)) continue;
    if (best === null || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best ? best[valueField] : null;
}

function matchesAnyPrefix(prefixes, repoPath) {
  return prefixes.some((prefix) => repoPath === prefix || repoPath.startsWith(prefix));
}

export function repoEntryKind(repoPath) {
  if (repoPath.endsWith('.schema.json')) return 'JSON_SCHEMA';
  if (repoPath.endsWith('.ndjson')) return 'NDJSON';
  if (repoPath.endsWith('.json')) return 'JSON';
  if (repoPath.endsWith('.mjs')) return 'ESM_MODULE';
  if (repoPath.endsWith('.js') || repoPath.endsWith('.cjs')) return 'SCRIPT';
  if (repoPath.endsWith('.md')) return 'MARKDOWN';
  return 'OTHER';
}

function derivedFields(repoPath, policy, trackedPaths) {
  return {
    kind: repoEntryKind(repoPath),
    subsystem: longestPrefixValue(policy.subsystemRules, 'subsystem', repoPath),
    layer: longestPrefixValue(policy.layerRules, 'layer', repoPath),
    governanceArtifact: matchesAnyPrefix(policy.governancePrefixes, repoPath),
    geeRelevant: matchesAnyPrefix(policy.geeRelevantPrefixes, repoPath),
    tracked: policy.trackedStatusSource === 'SUPPLIED' ? (trackedPaths.has(repoPath) ? TRACKED : UNTRACKED) : TRACKED_UNKNOWN
  };
}

function isExcluded(policy, repoPath) {
  if (repoPath.split('/').some((segment) => policy.excludedDirectorySegments.includes(segment))) return true;
  return policy.excludedPathPrefixes.some((prefix) => repoPath === prefix || repoPath.startsWith(prefix));
}

/* -------------------------------------------------------------------------
 * Scanning
 * ---------------------------------------------------------------------- */

/**
 * Repository-relative path and size of every file inside the policy roots.
 * Deliberately does NOT hash: this is the cheap half that an incremental
 * update runs, and the size it reports is only ever used as a corroborating
 * guard, never as content identity on its own.
 */
function scanFiles(repoRoot, policy) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new Error('REPO_ROOT_REQUIRED');
  const absoluteRoot = path.resolve(repoRoot);
  const files = [];
  const excluded = [];
  let skippedSymlinks = 0;

  const walk = (relativeDirectory) => {
    const absolute = relativeDirectory ? path.join(absoluteRoot, ...relativeDirectory.split('/')) : absoluteRoot;
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    // Locale-independent ordering, so directory traversal order cannot depend
    // on the runtime's collation.
    for (const entry of [...entries].sort((a, b) => compareIdentifiers(a.name, b.name))) {
      const name = entry.name;
      if (!isCanonicalIdentifier(name)) throw new Error(`NON_CANONICAL_REPO_PATH:${relativeDirectory}/${name}`);
      const repoPath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (isExcluded(policy, repoPath)) { excluded.push(repoPath); continue; }
      // A symlink's bytes live somewhere this index does not describe, so it is
      // skipped and counted rather than followed into an unindexed subtree.
      if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue; }
      if (entry.isDirectory()) { walk(repoPath); continue; }
      if (!entry.isFile()) continue;
      files.push({ path: repoPath, bytes: fs.statSync(path.join(absolute, name)).size });
    }
  };

  for (const root of policy.roots) walk(root.slice(0, -1));
  return { files: files.sort((a, b) => compareIdentifiers(a.path, b.path)), excluded: excluded.sort(compareIdentifiers), skippedSymlinks };
}

function hashFile(repoRoot, repoPath) {
  const bytes = fs.readFileSync(path.join(path.resolve(repoRoot), ...repoPath.split('/')));
  return { sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function indexBody(index) {
  return { schemaVersion: index.schemaVersion, indexKind: index.indexKind, engine: index.engine, policy: index.policy, entries: index.entries };
}

function withDigest(body) { return { ...body, indexSha256: sha256Canonical(indexBody(body)) }; }

function metricsFor(entries, scan, update) {
  const bySubsystem = {};
  for (const entry of entries) {
    const key = entry.subsystem || 'UNCLASSIFIED';
    bySubsystem[key] = (bySubsystem[key] || 0) + 1;
  }
  return {
    ENTRY_COUNT: entries.length,
    TOTAL_BYTES: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    GOVERNANCE_ARTIFACT_COUNT: entries.filter((entry) => entry.governanceArtifact).length,
    GEE_RELEVANT_COUNT: entries.filter((entry) => entry.geeRelevant).length,
    EXCLUDED_PATH_COUNT: scan.excluded.length,
    SKIPPED_SYMLINK_COUNT: scan.skippedSymlinks,
    BY_SUBSYSTEM: bySubsystem,
    ...update
  };
}

function assembleEntries(rows, policy, trackedPaths) {
  const entries = rows
    .map((row) => ({ path: row.path, ...derivedFields(row.path, policy, trackedPaths), bytes: row.bytes, sha256: row.sha256 }))
    .sort((a, b) => compareIdentifiers(a.path, b.path));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`DUPLICATE_REPO_INDEX_PATH:${entry.path}`);
    seen.add(entry.path);
  }
  return entries;
}

function trackedSet(policy, suppliedTrackedPaths) {
  if (policy.trackedStatusSource !== 'SUPPLIED') return new Set();
  if (!Array.isArray(suppliedTrackedPaths)) throw new Error('TRACKED_PATHS_REQUIRED');
  if (trackedPathsSha256(suppliedTrackedPaths) !== policy.trackedPathsSha256) throw new Error('TRACKED_PATHS_DIGEST_MISMATCH');
  return new Set(suppliedTrackedPaths.map((entry) => canonicalRepoPath(entry, 'TRACKED_PATH')));
}

/**
 * Full build: every file inside the policy roots is read and hashed.
 * @param {{ repoRoot: string, policy?: object, trackedPaths?: string[] }} options
 */
export function buildRepoIndex({ repoRoot, policy, trackedPaths = null } = {}) {
  const activePolicy = validateRepoIndexPolicy(policy === undefined ? DEFAULT_REPO_INDEX_POLICY : policy);
  const tracked = trackedSet(activePolicy, trackedPaths);
  const scan = scanFiles(repoRoot, activePolicy);
  const rows = scan.files.map((file) => ({ path: file.path, ...hashFile(repoRoot, file.path) }));
  const entries = assembleEntries(rows, activePolicy, tracked);
  const index = withDigest({ schemaVersion: 1, indexKind: REPO_INDEX_KIND, engine: REPO_INDEX_VERSION, policy: activePolicy, entries });
  return {
    ...index,
    metrics: metricsFor(entries, scan, {
      REHASHED_ENTRY_COUNT: entries.length,
      REUSED_ENTRY_COUNT: 0,
      ADDED_ENTRY_COUNT: entries.length,
      REMOVED_ENTRY_COUNT: 0,
      REHASHED_BYTES: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      REUSED_BYTES: 0,
      UPDATE_MODE: 'FULL_BUILD'
    })
  };
}

/** The paths an R3 delta proves are not unchanged. */
export function changedPathsFromR3Delta(r3Delta) {
  if (!r3Delta || !Array.isArray(r3Delta.deltas)) throw new Error('R3_DELTA_REQUIRED');
  return r3Delta.deltas.filter((delta) => delta.kind !== 'UNCHANGED').map((delta) => canonicalRepoPath(delta.path, 'R3_DELTA_PATH'));
}

/**
 * Incremental build. An entry keeps its prior digest only when the supplied
 * proof covers that exact path as unchanged and its size still matches what
 * the prior index recorded. An explicit changed-path array is not exhaustive
 * unless the caller supplies `changedPathsExhaustive: true`.
 *
 * Passing no proof, or a partial changed-path array, degrades to a full
 * re-hash instead of trusting stale digests. That is the whole reason a
 * modification timestamp appears nowhere in this file.
 *
 * @param {{ repoRoot: string, previousIndex: object, policy?: object,
 *           changedPaths?: string[]|null, changedPathsExhaustive?: boolean,
 *           r3Delta?: object|null,
 *           trackedPaths?: string[]|null }} options
 */
export function updateRepoIndex({ repoRoot, previousIndex, policy, changedPaths = null, changedPathsExhaustive = false, r3Delta = null, trackedPaths = null } = {}) {
  assertRepoIndex(previousIndex, 'PREVIOUS');
  const activePolicy = validateRepoIndexPolicy(policy === undefined ? previousIndex.policy : policy);
  const tracked = trackedSet(activePolicy, trackedPaths);
  const r3ProofSupplied = r3Delta !== null;
  const exhaustiveChangeProofSupplied = Array.isArray(changedPaths) && changedPathsExhaustive === true;
  const proofSupplied = r3ProofSupplied || exhaustiveChangeProofSupplied;
  const changed = new Set([
    ...(Array.isArray(changedPaths) ? changedPaths.map((entry) => canonicalRepoPath(entry, 'CHANGED_PATH')) : []),
    ...(r3Delta ? changedPathsFromR3Delta(r3Delta) : [])
  ]);
  const provenUnchanged = new Set(
    r3Delta
      ? r3Delta.deltas.filter((delta) => delta.kind === 'UNCHANGED').map((delta) => canonicalRepoPath(delta.path, 'R3_DELTA_PATH'))
      : []
  );
  const previousByPath = new Map(previousIndex.entries.map((entry) => [entry.path, entry]));

  const scan = scanFiles(repoRoot, activePolicy);
  const rows = [];
  let reused = 0;
  let rehashed = 0;
  let reusedBytes = 0;
  let rehashedBytes = 0;
  for (const file of scan.files) {
    const prior = previousByPath.get(file.path);
    const reusable = prior && prior.bytes === file.bytes && (
      (r3ProofSupplied && provenUnchanged.has(file.path))
      || (exhaustiveChangeProofSupplied && !changed.has(file.path))
    );
    if (reusable) {
      rows.push({ path: file.path, sha256: prior.sha256, bytes: prior.bytes });
      reused += 1;
      reusedBytes += prior.bytes;
    } else {
      rows.push({ path: file.path, ...hashFile(repoRoot, file.path) });
      rehashed += 1;
      rehashedBytes += file.bytes;
    }
  }

  const currentPaths = new Set(scan.files.map((file) => file.path));
  const removedPaths = previousIndex.entries.map((entry) => entry.path).filter((entry) => !currentPaths.has(entry)).sort(compareIdentifiers);
  const addedPaths = scan.files.map((file) => file.path).filter((entry) => !previousByPath.has(entry)).sort(compareIdentifiers);
  const changedPathsObserved = rows
    .filter((row) => previousByPath.has(row.path) && previousByPath.get(row.path).sha256 !== row.sha256)
    .map((row) => row.path)
    .sort(compareIdentifiers);

  const entries = assembleEntries(rows, activePolicy, tracked);
  const index = withDigest({ schemaVersion: 1, indexKind: REPO_INDEX_KIND, engine: REPO_INDEX_VERSION, policy: activePolicy, entries });
  return {
    index: {
      ...index,
      metrics: metricsFor(entries, scan, {
        REHASHED_ENTRY_COUNT: rehashed,
        REUSED_ENTRY_COUNT: reused,
        ADDED_ENTRY_COUNT: addedPaths.length,
        REMOVED_ENTRY_COUNT: removedPaths.length,
        REHASHED_BYTES: rehashedBytes,
        REUSED_BYTES: reusedBytes,
        UPDATE_MODE: proofSupplied ? 'INCREMENTAL' : 'FULL_REHASH_NO_CHANGE_PROOF'
      })
    },
    update: {
      addedPaths,
      removedPaths,
      changedPaths: changedPathsObserved,
      reusedEntryCount: reused,
      rehashedEntryCount: rehashed,
      reusedBytes,
      rehashedBytes,
      changeProofSupplied: proofSupplied
    }
  };
}

/* -------------------------------------------------------------------------
 * Validation of a MATERIALIZED index
 * ---------------------------------------------------------------------- */

const REPO_INDEX_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas', 'repo-index.schema.json'), 'utf8')
);

function identityErrors(index) {
  const errors = [];
  const push = (jsonPointer, reason, message) => errors.push({ jsonPointer, reason, message });

  let policy;
  try {
    policy = validateRepoIndexPolicy(index.policy);
  } catch (error) {
    push('/policy', 'INVALID_REPO_INDEX_POLICY', error.message);
    return errors;
  }
  // The persisted policy must already be its own normal form, otherwise two
  // spellings of one policy would index identically while hashing differently.
  if (sha256Canonical(policy) !== sha256Canonical(index.policy)) {
    push('/policy', 'NON_CANONICAL_REPO_INDEX_POLICY', 'policy must already be in normalized canonical form');
  }

  const seen = new Set();
  index.entries.forEach((entry, position) => {
    const pointer = `/entries/${position}`;
    if (!isCanonicalIdentifier(entry.path)) { push(`${pointer}/path`, 'NON_CANONICAL_REPO_INDEX_PATH', 'path must already be NFC'); return; }
    let canonical;
    try {
      canonical = canonicalRepoPath(entry.path);
    } catch (error) {
      push(`${pointer}/path`, 'INVALID_REPO_INDEX_PATH', error.message);
      return;
    }
    // Rejects, never rewrites: a backslash spelling resolves to the same file
    // at runtime but hashes as a different string, so one indexSha256 would
    // stand for two path identities.
    if (canonical !== entry.path) { push(`${pointer}/path`, 'NON_CANONICAL_REPO_INDEX_PATH', 'path must already be in canonical repository-relative form'); return; }
    if (seen.has(entry.path)) push(`${pointer}/path`, 'DUPLICATE_REPO_INDEX_PATH', 'two entries share one canonical path');
    seen.add(entry.path);
    if (!policy.roots.some((root) => entry.path.startsWith(root))) push(`${pointer}/path`, 'REPO_INDEX_PATH_OUTSIDE_ROOTS', 'path is not inside any declared index root');
    if (isExcluded(policy, entry.path)) push(`${pointer}/path`, 'EXCLUDED_PATH_IN_REPO_INDEX', 'path is excluded by the declared policy');
    // Derived fields are a pure function of (path, policy); a persisted index
    // that disagrees with that function is describing something else.
    const derived = derivedFields(entry.path, policy, new Set());
    if (entry.kind !== derived.kind) push(`${pointer}/kind`, 'REPO_INDEX_DERIVED_FIELD_MISMATCH', 'kind does not match the declared policy');
    if (entry.subsystem !== derived.subsystem) push(`${pointer}/subsystem`, 'REPO_INDEX_DERIVED_FIELD_MISMATCH', 'subsystem does not match the declared policy');
    if (entry.layer !== derived.layer) push(`${pointer}/layer`, 'REPO_INDEX_DERIVED_FIELD_MISMATCH', 'layer does not match the declared policy');
    if (entry.governanceArtifact !== derived.governanceArtifact) push(`${pointer}/governanceArtifact`, 'REPO_INDEX_DERIVED_FIELD_MISMATCH', 'governanceArtifact does not match the declared policy');
    if (entry.geeRelevant !== derived.geeRelevant) push(`${pointer}/geeRelevant`, 'REPO_INDEX_DERIVED_FIELD_MISMATCH', 'geeRelevant does not match the declared policy');
    if (policy.trackedStatusSource === 'UNAVAILABLE' && entry.tracked !== TRACKED_UNKNOWN) {
      push(`${pointer}/tracked`, 'REPO_INDEX_TRACKED_STATE_UNSUPPORTED', 'tracked state claimed while the policy declares it unavailable');
    }
    if (!TRACKED_STATES.includes(entry.tracked)) push(`${pointer}/tracked`, 'INVALID_REPO_INDEX_TRACKED_STATE', 'unknown tracked state');
    if (position > 0 && compareIdentifiers(index.entries[position - 1].path, entry.path) >= 0) {
      push(pointer, 'REPO_INDEX_ORDER_NOT_CANONICAL', 'entries must be sorted by canonical path');
    }
  });

  if (index.indexSha256 !== sha256Canonical(indexBody(index))) {
    push('/indexSha256', 'INVALID_REPO_INDEX_DIGEST', 'digest does not match the index body');
  }
  return errors;
}

/** Conformance of an index document: structure first, then runtime identity. */
export function validateRepoIndex(index) {
  const structural = validateAgainstJsonSchema(index, REPO_INDEX_SCHEMA);
  if (!structural.valid) return structural;
  const errors = identityErrors(index);
  return { valid: errors.length === 0, errors };
}

export function assertRepoIndex(index, label = 'REPO_INDEX') {
  const result = validateRepoIndex(index);
  if (!result.valid) throw new Error(`INVALID_${label}:${result.errors[0].reason}:${result.errors[0].jsonPointer}`);
  return index;
}

export function repoIndexSha256(index) { return sha256Canonical(indexBody(index)); }

/**
 * Re-hashes named entries and reports disagreement. This is the only place the
 * index claims anything about the CURRENT filesystem; everywhere else it is a
 * record of what was true when it was built.
 */
export function verifyRepoIndexAgainstDisk({ repoRoot, index, paths = null } = {}) {
  assertRepoIndex(index);
  const byPath = new Map(index.entries.map((entry) => [entry.path, entry]));
  const targets = paths === null ? [...byPath.keys()] : paths.map((entry) => canonicalRepoPath(entry, 'VERIFY_PATH'));
  const mismatches = [];
  const missing = [];
  for (const target of targets.sort(compareIdentifiers)) {
    const entry = byPath.get(target);
    if (!entry) { missing.push(target); continue; }
    const absolute = path.join(path.resolve(repoRoot), ...target.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) { missing.push(target); continue; }
    const observed = hashFile(repoRoot, target);
    if (observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes) {
      mismatches.push({ path: target, indexedSha256: entry.sha256, observedSha256: observed.sha256 });
    }
  }
  return {
    verified: mismatches.length === 0 && missing.length === 0,
    verifiedCount: targets.length - mismatches.length - missing.length,
    mismatches,
    missing: missing.sort(compareIdentifiers),
    reasonCodes: [
      ...(mismatches.length ? ['REPO_INDEX_ENTRY_DIGEST_MISMATCH'] : []),
      ...(missing.length ? ['REPO_INDEX_ENTRY_MISSING'] : [])
    ]
  };
}

export function repoIndexEntry(index, repoPath) {
  return index.entries.find((entry) => entry.path === canonicalRepoPath(repoPath, 'LOOKUP_PATH')) || null;
}

export { indexBody, isExcluded, compareIdentifiers };
