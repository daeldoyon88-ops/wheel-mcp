/**
 * MODEL D — how a governed artifact is allowed to be verified.
 *
 * The defect this closes is "format-only historical PASS": a validator that
 * confirms an artifact has the right SHAPE and reports PROVEN, without ever
 * reaching bytes anyone actually retained. Shape is not evidence. A forged
 * record and a genuine one have identical shape.
 *
 * MODEL D fixes that by making the CLASS of an artifact decide what counts as
 * proof for it, and by requiring every historical verification to TERMINATE in
 * one of exactly two grounds:
 *
 *   RETAINED_IMMUTABLE_BYTES      the real bytes still exist and hash as pinned
 *   DETERMINISTIC_RECONSTRUCTION  the bytes are regenerated from immutable
 *                                 sources by a generator whose own identity is
 *                                 retained, and the result hashes as pinned
 *
 * Anything else — "the JSON parsed", "the field was present", "the shape was
 * valid" — is NOT a historical proof and is reported as such.
 *
 * Why reconstruction is a first-class ground, not a loophole: derived views
 * legitimately do not survive. GATE_STATUS_SNAPSHOT is overwritten every time
 * the ledger grows, so the snapshot as of ordinal 57 exists nowhere on disk and
 * in no commit. It is still provable, because the ledger prefix through 57 is
 * immutable and the generator is a pure function of it. That is a real proof:
 * substituting a different generator changes the digest and the verification
 * fails. The generator identity is therefore part of the evidence, never a
 * decoration — which is exactly why RECONSTRUCTABLE artifacts must declare it.
 *
 * Conversely, a MUTABLE_PROJECTION must NOT be byte-pinned forever. Pinning a
 * pointer's bytes into a permanent record freezes something the architecture
 * defines as movable, and the only way to satisfy it later is to stop moving —
 * which is how a pointer silently becomes an immutable artifact nobody may
 * advance. Pointers are proved through their target's lineage instead.
 *
 * This module is pure: no filesystem, no clock, no process. Callers supply
 * observed facts; it decides.
 */

export const MODEL_D_VERSION = 1;

/** Bytes are fixed forever. Any difference is tampering, never an update. */
export const IMMUTABLE_VERSIONED_ARTIFACT = 'IMMUTABLE_VERSIONED_ARTIFACT';
/** A pointer that is SUPPOSED to move. Proved via its target, never byte-pinned forever. */
export const MUTABLE_PROJECTION = 'MUTABLE_PROJECTION';
/** A derived view. Not retained; regenerated from immutable sources on demand. */
export const RECONSTRUCTABLE_PROJECTION = 'RECONSTRUCTABLE_PROJECTION';
/** Grows only at the end. Every prefix is immutable; the whole file is not. */
export const APPEND_ONLY_LOG = 'APPEND_ONLY_LOG';
/** Content is never interpreted. Only its bytes are evidence. */
export const OPAQUE = 'OPAQUE';
/** Lives outside the governed set; proved by retained identity and digest. */
export const EXTERNAL_LEGACY_AUTHORITY = 'EXTERNAL_LEGACY_AUTHORITY';
/** Code that decides outcomes. Its own identity must be bound before it runs. */
export const EXECUTABLE_AUTHORITY = 'EXECUTABLE_AUTHORITY';

export const MODEL_D_CLASSES = Object.freeze([
  IMMUTABLE_VERSIONED_ARTIFACT, MUTABLE_PROJECTION, RECONSTRUCTABLE_PROJECTION,
  APPEND_ONLY_LOG, OPAQUE, EXTERNAL_LEGACY_AUTHORITY, EXECUTABLE_AUTHORITY
]);

export const GROUND_RETAINED_BYTES = 'RETAINED_IMMUTABLE_BYTES';
export const GROUND_RECONSTRUCTION = 'DETERMINISTIC_RECONSTRUCTION';
export const GROUND_TARGET_LINEAGE = 'TARGET_LINEAGE';
export const GROUND_PREFIX_IMMUTABILITY = 'PREFIX_IMMUTABILITY';

/** The only grounds that terminate a HISTORICAL verification. */
export const HISTORICAL_TERMINAL_GROUNDS = Object.freeze([GROUND_RETAINED_BYTES, GROUND_RECONSTRUCTION]);

/**
 * Which grounds each class may terminate on. A class is not free to pick: an
 * IMMUTABLE artifact may never fall back to "reconstruct it", and a MUTABLE
 * pointer may never claim retained bytes as a permanent proof.
 */
const PERMITTED_GROUNDS = Object.freeze({
  [IMMUTABLE_VERSIONED_ARTIFACT]: [GROUND_RETAINED_BYTES],
  [MUTABLE_PROJECTION]: [GROUND_TARGET_LINEAGE],
  [RECONSTRUCTABLE_PROJECTION]: [GROUND_RECONSTRUCTION],
  [APPEND_ONLY_LOG]: [GROUND_PREFIX_IMMUTABILITY, GROUND_RETAINED_BYTES],
  [OPAQUE]: [GROUND_RETAINED_BYTES],
  [EXTERNAL_LEGACY_AUTHORITY]: [GROUND_RETAINED_BYTES],
  [EXECUTABLE_AUTHORITY]: [GROUND_RETAINED_BYTES]
});

const SHA256_RE = /^[a-f0-9]{64}$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

export function isModelDClass(value) {
  return MODEL_D_CLASSES.includes(value);
}

export function permittedGroundsFor(artifactClass) {
  return PERMITTED_GROUNDS[artifactClass] ? [...PERMITTED_GROUNDS[artifactClass]] : [];
}

/**
 * Validates one registry entry's SHAPE and internal consistency — in particular
 * that a class carrying reconstruction semantics actually declares the two
 * things reconstruction needs (immutable sources and a generator identity), and
 * that a class which must never be byte-pinned does not carry a permanent pin.
 */
export function validateArtifactClassificationEntry(entry) {
  const findings = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    finding(findings, 'ENTRY_ABSENT');
    return { valid: false, findings };
  }
  const allowed = ['artifactId', 'path', 'artifactClass', 'verificationGround', 'retainedSha256',
    'retainedByteLength', 'immutableSources', 'generatorIdentity', 'targetLineage', 'note'];
  for (const key of Object.keys(entry)) if (!allowed.includes(key)) finding(findings, 'ENTRY_UNKNOWN_FIELD', key);
  if (typeof entry.artifactId !== 'string' || !entry.artifactId) finding(findings, 'ARTIFACT_ID_INVALID');
  if (typeof entry.path !== 'string' || !entry.path) finding(findings, 'ARTIFACT_PATH_INVALID');
  if (!isModelDClass(entry.artifactClass)) { finding(findings, 'ARTIFACT_CLASS_INVALID', entry.artifactClass); return { valid: false, findings }; }

  const permitted = permittedGroundsFor(entry.artifactClass);
  if (!permitted.includes(entry.verificationGround)) {
    finding(findings, 'VERIFICATION_GROUND_NOT_PERMITTED_FOR_CLASS', `${entry.artifactClass}:${entry.verificationGround}`);
  }

  if (entry.verificationGround === GROUND_RETAINED_BYTES) {
    if (!SHA256_RE.test(entry.retainedSha256 || '')) finding(findings, 'RETAINED_SHA_INVALID', entry.artifactId);
    if (!Number.isInteger(entry.retainedByteLength) || entry.retainedByteLength < 0) finding(findings, 'RETAINED_BYTE_LENGTH_INVALID', entry.artifactId);
  }

  if (entry.verificationGround === GROUND_RECONSTRUCTION) {
    // Reconstruction without immutable sources is not reconstruction, and
    // reconstruction without a pinned generator proves only "some program
    // produced this", which is not an identity.
    if (!Array.isArray(entry.immutableSources) || entry.immutableSources.length === 0) {
      finding(findings, 'RECONSTRUCTION_SOURCES_MISSING', entry.artifactId);
    }
    if (!entry.generatorIdentity || typeof entry.generatorIdentity !== 'object'
        || typeof entry.generatorIdentity.path !== 'string' || !entry.generatorIdentity.path
        || !SHA256_RE.test(entry.generatorIdentity.sha256 || '')) {
      finding(findings, 'RECONSTRUCTION_GENERATOR_IDENTITY_MISSING', entry.artifactId);
    }
    if (!SHA256_RE.test(entry.retainedSha256 || '')) {
      // The EXPECTED digest of the reconstruction result. Without it the
      // reconstruction can produce anything and still be called a match.
      finding(findings, 'RECONSTRUCTION_EXPECTED_DIGEST_MISSING', entry.artifactId);
    }
  }

  if (entry.artifactClass === MUTABLE_PROJECTION) {
    if (entry.retainedSha256 !== undefined) finding(findings, 'MUTABLE_PROJECTION_PERMANENTLY_BYTE_PINNED', entry.artifactId);
    if (typeof entry.targetLineage !== 'string' || !entry.targetLineage) finding(findings, 'MUTABLE_PROJECTION_TARGET_LINEAGE_MISSING', entry.artifactId);
  }

  return { valid: findings.length === 0, findings };
}

export function validateArtifactClassificationRegistry(registry) {
  const findings = [];
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    finding(findings, 'REGISTRY_ABSENT');
    return { valid: false, findings, byPath: new Map() };
  }
  if (registry.documentKind !== 'HISTORICAL_ARCHITECTURE_ARTIFACT_CLASSIFICATION_REGISTRY') finding(findings, 'REGISTRY_KIND_INVALID');
  if (registry.schemaVersion !== 1) finding(findings, 'REGISTRY_SCHEMA_VERSION_INVALID');
  if (registry.modelDVersion !== MODEL_D_VERSION) finding(findings, 'MODEL_D_VERSION_UNSUPPORTED', registry.modelDVersion);
  if (!Array.isArray(registry.artifacts) || registry.artifacts.length === 0) {
    finding(findings, 'REGISTRY_ARTIFACTS_INVALID');
    return { valid: false, findings, byPath: new Map() };
  }
  const byPath = new Map();
  const seenIds = new Set();
  for (const entry of registry.artifacts) {
    const result = validateArtifactClassificationEntry(entry);
    findings.push(...result.findings);
    if (!result.valid) continue;
    if (seenIds.has(entry.artifactId)) finding(findings, 'REGISTRY_DUPLICATE_ARTIFACT_ID', entry.artifactId);
    seenIds.add(entry.artifactId);
    if (byPath.has(entry.path)) finding(findings, 'REGISTRY_DUPLICATE_PATH', entry.path);
    byPath.set(entry.path, entry);
  }
  return { valid: findings.length === 0, findings, byPath };
}

/**
 * The rule the whole model exists for.
 *
 * `observed` reports what the caller actually managed to establish:
 *   { groundReached, digestMatched, generatorIdentityMatched, prefixImmutable, targetLineageValid }
 *
 * A historical verification is PROVEN only when it terminated on a ground that
 * genuinely terminates history AND the evidence for that ground checked out.
 * Reaching no ground, or reaching only shape, is FORMAT_ONLY — reported as
 * NOT_PROVEN rather than quietly passing.
 */
export function evaluateHistoricalVerification({ entry = null, observed = {}, historical = true } = {}) {
  const findings = [];
  const shape = validateArtifactClassificationEntry(entry);
  findings.push(...shape.findings);
  if (!shape.valid) return { state: 'NOT_PROVEN', ground: null, findings };

  const ground = observed.groundReached ?? null;
  if (ground === null) {
    finding(findings, 'FORMAT_ONLY_VERIFICATION_REJECTED', entry.artifactId);
    return { state: 'NOT_PROVEN', ground: null, findings };
  }
  if (ground !== entry.verificationGround) {
    finding(findings, 'VERIFICATION_GROUND_MISMATCH', `${entry.verificationGround}!=${ground}`);
  }
  if (historical && !HISTORICAL_TERMINAL_GROUNDS.includes(ground)) {
    // TARGET_LINEAGE and PREFIX_IMMUTABILITY are legitimate PRESENT grounds;
    // neither terminates a claim about what was true at a past ordinal.
    finding(findings, 'GROUND_DOES_NOT_TERMINATE_HISTORY', ground);
  }
  if (ground === GROUND_RETAINED_BYTES && observed.digestMatched !== true) {
    finding(findings, 'RETAINED_BYTES_DIGEST_MISMATCH', entry.artifactId);
  }
  if (ground === GROUND_RECONSTRUCTION) {
    if (observed.generatorIdentityMatched !== true) finding(findings, 'GENERATOR_IDENTITY_MISMATCH', entry.artifactId);
    if (observed.digestMatched !== true) finding(findings, 'RECONSTRUCTION_DIGEST_MISMATCH', entry.artifactId);
  }
  if (ground === GROUND_PREFIX_IMMUTABILITY && observed.prefixImmutable !== true) {
    finding(findings, 'PREFIX_NOT_IMMUTABLE', entry.artifactId);
  }
  if (ground === GROUND_TARGET_LINEAGE && observed.targetLineageValid !== true) {
    finding(findings, 'TARGET_LINEAGE_INVALID', entry.artifactId);
  }
  return { state: findings.length === 0 ? 'PROVEN' : 'NOT_PROVEN', ground, findings };
}
