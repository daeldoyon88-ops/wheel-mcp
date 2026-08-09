/**
 * GEE V1 core — release authorization loader.
 *
 * Deliberately the same shape as core/witness-source.mjs, for the same reason:
 * an authority that the governed set can rewrite is not an authority. This is
 * the I/O half of the release primitive; core/release-authority.mjs stays pure.
 *
 * Two separate mechanisms keep the agent from authorizing itself:
 *
 *  1. LOCATION. The authorization is loaded only from a path configured OUTSIDE
 *     the repository, and a source whose real (symlink-resolved) path lands on
 *     or under any governed root is treated exactly like an absent file. An
 *     authorization copied into the repo can therefore never be honored.
 *
 *  2. SIGNATURE. Location alone is not enough — an agent with filesystem access
 *     can write outside the repo too. The ed25519 owner signature verified in
 *     release-authority.mjs is what actually makes forgery require the owner's
 *     private key rather than a text editor. Location is defence in depth.
 *
 * Absence, unreadability, unparsable JSON, wrong container shape, and governed
 * location all resolve to "no authorization" with a named finding. None of them
 * ever resolves to a synthesized pass. This module never writes.
 *
 * Distinct from GEE_HEAD_WITNESS_SOURCE: a witness ATTESTS a validated state, an
 * authorization GRANTS a future Git operation. They are never interchangeable
 * and are never read from the same configuration key.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isWithinGovernedRoots } from './witness-source.mjs';

export const RELEASE_AUTHORIZATION_ENV_VAR = 'GEE_RELEASE_AUTHORIZATION_SOURCE';
export const OWNER_RELEASE_KEY_ENV_VAR = 'GEE_OWNER_RELEASE_PUBLIC_KEY';

export function resolveAuthorizationSourcePath({ env = process.env, explicitPath = null } = {}) {
  if (typeof explicitPath === 'string' && explicitPath) return explicitPath;
  const fromEnv = env?.[RELEASE_AUTHORIZATION_ENV_VAR];
  return typeof fromEnv === 'string' && fromEnv ? fromEnv : null;
}

/**
 * @returns {{ authorization: object|null, finding: string|null, sourcePath: string|null, sha256: string|null }}
 */
export function loadReleaseAuthorization(sourcePath, { governedRoots = [] } = {}) {
  const empty = (finding) => ({ authorization: null, finding, sourcePath: sourcePath || null, sha256: null });
  if (!sourcePath || typeof sourcePath !== 'string') return empty('AUTHORIZATION_SOURCE_NOT_CONFIGURED');

  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return empty('AUTHORIZATION_ABSENT');
  }
  if (!stat.isFile()) return empty('AUTHORIZATION_ABSENT');

  let realSourcePath;
  try {
    realSourcePath = fs.realpathSync(sourcePath);
  } catch {
    return empty('AUTHORIZATION_ABSENT');
  }
  if (isWithinGovernedRoots(realSourcePath, governedRoots)) {
    return empty('AUTHORIZATION_INSIDE_GOVERNED_SET');
  }

  let bytes;
  try {
    bytes = fs.readFileSync(sourcePath);
  } catch {
    return empty('AUTHORIZATION_ABSENT');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return empty('AUTHORIZATION_MALFORMED');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return empty('AUTHORIZATION_MALFORMED');
  }
  return {
    authorization: parsed,
    finding: null,
    sourcePath,
    sha256: null // hashing is the caller's concern; this module reports bytes only
  };
}

export function loadConfiguredReleaseAuthorization({ env = process.env, explicitPath = null, governedRoots = [] } = {}) {
  return loadReleaseAuthorization(resolveAuthorizationSourcePath({ env, explicitPath }), { governedRoots });
}

/**
 * Loads the owner PUBLIC key. Unlike the authorization, the public key MAY live
 * inside the governed set: publishing it grants nothing, and tampering with it
 * can only cause authorizations to be REJECTED, never forged.
 * @returns {{ ownerKey: {keyId: string, publicKeyPem: string}|null, finding: string|null }}
 */
export function loadOwnerReleaseKey(keyPath) {
  if (!keyPath || typeof keyPath !== 'string') return { ownerKey: null, finding: 'OWNER_PUBLIC_KEY_UNAVAILABLE' };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.resolve(keyPath), 'utf8'));
  } catch {
    return { ownerKey: null, finding: 'OWNER_PUBLIC_KEY_UNAVAILABLE' };
  }
  if (typeof parsed?.keyId !== 'string' || typeof parsed?.publicKeyPem !== 'string' || !parsed.publicKeyPem) {
    return { ownerKey: null, finding: 'OWNER_PUBLIC_KEY_UNAVAILABLE' };
  }
  if (/PRIVATE KEY/.test(parsed.publicKeyPem)) {
    // A private key inside the governed set would collapse the whole boundary.
    return { ownerKey: null, finding: 'OWNER_PRIVATE_KEY_IN_GOVERNED_SET' };
  }
  return { ownerKey: { keyId: parsed.keyId, publicKeyPem: parsed.publicKeyPem }, finding: null };
}
