/**
 * GEE V1 core — external witness source.
 * FINAL-01 support: the real production adapter had a head-witness comparator
 * (head-witness.mjs) but no way to feed it anything other than an empty array,
 * so ANCHORED_EXTERNAL was structurally unreachable outside unit tests. This
 * module is the loader half: it reads witness declarations from a path that is
 * OUTSIDE the governed set (never under governance/), never fabricates one
 * when absent, and never performs any write.
 *
 * Absence of a configured/resolvable source, a missing file, unparsable JSON,
 * or a structurally invalid entry all resolve to "no witnesses" — never to a
 * synthesized pass. A stale or mismatching witness is filtered here only on
 * SHAPE; the actual hash comparison against the live ledger stays in
 * head-witness.mjs, which already treats absence/mismatch as never-a-match.
 *
 * R1-FINAL-CLOSURE-BLOCKER-FIX-R1 / FC-01: externality was documented above
 * but never enforced — any structurally valid, hash-matching witness file was
 * accepted regardless of where it lived, including under governance/ itself
 * (a "self-witness"). A caller may now pass `governedRoots` (absolute
 * directory paths this generic core module knows nothing else about) and a
 * witness source whose REAL, symlink-resolved path resolves on/under any of
 * them is never loaded — it degrades to "no witnesses" exactly like an
 * absent/missing file, never to a synthesized pass. Callers that omit
 * `governedRoots` get the prior, unrestricted behavior (used by fixtures that
 * already point at os.tmpdir() paths outside any governed set); the real
 * Wheel adapter always supplies its own governance/ directory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isKnownWitnessKind } from './head-witness.mjs';

export const DEFAULT_WITNESS_SOURCE_ENV_VAR = 'GEE_HEAD_WITNESS_SOURCE';

/**
 * Resolves the external witness source path. Explicit argument wins; falls
 * back to the environment variable; resolves to null (never a governed-set
 * default) when neither is set.
 * @param {{ env?: object, explicitPath?: string|null }} [options]
 */
export function resolveWitnessSourcePath({ env = process.env, explicitPath = null } = {}) {
  if (typeof explicitPath === 'string' && explicitPath) return explicitPath;
  const fromEnv = env?.[DEFAULT_WITNESS_SOURCE_ENV_VAR];
  return typeof fromEnv === 'string' && fromEnv ? fromEnv : null;
}

function isStructurallyValidWitness(witness) {
  return Boolean(witness)
    && typeof witness === 'object'
    && !Array.isArray(witness)
    && isKnownWitnessKind(witness.kind)
    && witness.verified === true
    && typeof witness.pinnedLedgerSha256 === 'string'
    && /^[a-f0-9]{64}$/.test(witness.pinnedLedgerSha256)
    && typeof witness.ref === 'string'
    && witness.ref.length > 0;
}

/**
 * True when `resolvedRealPath` (already symlink-resolved) is on or under any
 * of `governedRoots`. Each root is itself resolved via realpath so a governed
 * directory that is itself reached through a symlink is still honored. A root
 * that cannot be resolved (does not exist) falls back to its literal absolute
 * form — it still participates in the boundary check.
 * @param {string} resolvedRealPath
 * @param {Array<string>} governedRoots
 */
export function isWithinGovernedRoots(resolvedRealPath, governedRoots) {
  const roots = (Array.isArray(governedRoots) ? governedRoots : [governedRoots]).filter((r) => typeof r === 'string' && r);
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = path.resolve(root);
    }
    if (resolvedRealPath === realRoot || resolvedRealPath.startsWith(realRoot + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Loads witnesses from `sourcePath`. Never throws; never writes; never
 * upgrades an absent/invalid file to a passing witness.
 *
 * FC-01: when `governedRoots` is supplied, a source whose real (symlink-
 * resolved) path resolves on/under any governed root is treated exactly like
 * a missing file — it can never contribute a witness, so it can never produce
 * ANCHORED_EXTERNAL. Path traversal and symlink indirection are both defeated
 * by resolving through fs.realpathSync before the boundary comparison.
 * @param {string|null} sourcePath
 * @param {{ governedRoots?: Array<string> }} [options]
 * @returns {Array<object>}
 */
export function loadExternalWitnesses(sourcePath, { governedRoots = [] } = {}) {
  if (!sourcePath || typeof sourcePath !== 'string') return [];
  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];

  let realSourcePath;
  try {
    realSourcePath = fs.realpathSync(sourcePath);
  } catch {
    // Unresolvable (e.g. broken symlink between stat and realpath) — never a pass.
    return [];
  }
  if (isWithinGovernedRoots(realSourcePath, governedRoots)) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.witnesses) ? parsed.witnesses : []);
  return list.filter(isStructurallyValidWitness);
}

/**
 * Convenience: resolve + load in one call, using the process environment by
 * default. This is what the real adapter calls; tests pass explicitPath to
 * point at a fixture under os.tmpdir(), never under governance/.
 * `governedRoots` should always be supplied by a real project adapter (see
 * the Wheel adapter) so a self-witness can never be honored.
 */
export function loadConfiguredExternalWitnesses({ env = process.env, explicitPath = null, governedRoots = [] } = {}) {
  return loadExternalWitnesses(resolveWitnessSourcePath({ env, explicitPath }), { governedRoots });
}
