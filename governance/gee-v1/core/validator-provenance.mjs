/**
 * H6 — which code decided?
 *
 * THE DEFECT. Governance tools are invoked with a `--root` pointing at whatever
 * tree is being judged, and module resolution follows the process's own working
 * directory. Put those together and a CANDIDATE tree can supply the very code
 * that judges it: run the validator "from" the candidate and the candidate's own
 * `governance/tools/validate-*.mjs` decides whether the candidate is valid.
 * Nothing needs to be forged — a permissive validator simply reports PASS, and
 * the verdict looks identical to a real one.
 *
 * That is the governance equivalent of letting the defendant pick the judge, and
 * it is invisible in the output: the report says `valid: true` either way.
 *
 * THE RULE. Two distinct questions, two distinct resolutions:
 *
 *   ADMISSION  (judging a candidate now)
 *     The validator MUST be the one at its CANONICAL repository path, and its
 *     bytes MUST hash to the digest pinned in the execution manifest. Candidate
 *     cwd is never consulted. A validator resolved from anywhere else is
 *     refused, not merely noted.
 *
 *   REPLAY  (re-checking history)
 *     The validator is identified by RETAINED CONTENT IDENTITY: the digest the
 *     historical record says decided that outcome. Replaying yesterday's verdict
 *     with today's code silently re-decides it, which is not a replay at all.
 *
 * NO KEYS. Provenance here is content identity, nothing more. This program
 * introduces no signing, no key rotation, no revocation and no recovery root;
 * a validator's identity is its bytes.
 *
 * Pure: no filesystem, no process. Callers supply observed digests and paths.
 */

export const VALIDATOR_PROVENANCE_MANIFEST_KIND = 'HISTORICAL_ARCHITECTURE_VALIDATOR_PROVENANCE_MANIFEST';
export const VALIDATOR_PROVENANCE_SCHEMA_VERSION = 1;

export const PURPOSE_ADMISSION = 'ADMISSION';
export const PURPOSE_REPLAY = 'REPLAY';

const SHA256_RE = /^[a-f0-9]{64}$/;

function finding(findings, code, detail) {
  findings.push(detail === undefined ? { code } : { code, detail });
}

function isExactRepoPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes(':')) return false;
  if (value.includes('*') || value.includes('?')) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function validateValidatorProvenanceManifest(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    finding(findings, 'PROVENANCE_MANIFEST_ABSENT');
    return { valid: false, findings, byPath: new Map() };
  }
  if (manifest.documentKind !== VALIDATOR_PROVENANCE_MANIFEST_KIND) finding(findings, 'PROVENANCE_MANIFEST_KIND_INVALID');
  if (manifest.schemaVersion !== VALIDATOR_PROVENANCE_SCHEMA_VERSION) finding(findings, 'PROVENANCE_MANIFEST_SCHEMA_VERSION_INVALID');
  if (!Array.isArray(manifest.validators) || manifest.validators.length === 0) {
    finding(findings, 'PROVENANCE_MANIFEST_EMPTY');
    return { valid: false, findings, byPath: new Map() };
  }
  const byPath = new Map();
  for (const entry of manifest.validators) {
    if (!entry || typeof entry !== 'object') { finding(findings, 'PROVENANCE_ENTRY_INVALID'); continue; }
    if (!isExactRepoPath(entry.canonicalPath)) { finding(findings, 'PROVENANCE_CANONICAL_PATH_INVALID', entry.canonicalPath); continue; }
    if (!SHA256_RE.test(entry.sha256 || '')) { finding(findings, 'PROVENANCE_DIGEST_INVALID', entry.canonicalPath); continue; }
    if (byPath.has(entry.canonicalPath)) { finding(findings, 'PROVENANCE_DUPLICATE_PATH', entry.canonicalPath); continue; }
    byPath.set(entry.canonicalPath, entry);
  }
  return { valid: findings.length === 0, findings, byPath };
}

/**
 * Decide whether a validator may execute for a given purpose.
 *
 * `observed`:
 *   { resolvedPath, resolvedSha256, resolvedFromCandidateTree, historicalSha256 }
 */
export function evaluateValidatorProvenance({
  manifest = null,
  canonicalPath = null,
  purpose = PURPOSE_ADMISSION,
  observed = {}
} = {}) {
  const findings = [];
  const manifestResult = validateValidatorProvenanceManifest(manifest);
  findings.push(...manifestResult.findings);
  if (purpose !== PURPOSE_ADMISSION && purpose !== PURPOSE_REPLAY) finding(findings, 'PROVENANCE_PURPOSE_INVALID', purpose);

  const entry = manifestResult.byPath.get(canonicalPath) ?? null;
  if (!entry) {
    finding(findings, 'VALIDATOR_NOT_IN_EXECUTION_MANIFEST', canonicalPath);
    return { decision: 'BLOCKED', purpose, findings };
  }

  if (purpose === PURPOSE_ADMISSION) {
    // The single most important line in this module: code offered by the tree
    // under judgement never judges it.
    if (observed.resolvedFromCandidateTree === true) {
      finding(findings, 'VALIDATOR_RESOLVED_FROM_CANDIDATE_TREE', canonicalPath);
    }
    if (observed.resolvedPath !== canonicalPath) {
      finding(findings, 'VALIDATOR_NOT_AT_CANONICAL_PATH', observed.resolvedPath ?? 'ABSENT');
    }
    if (observed.resolvedSha256 !== entry.sha256) {
      finding(findings, 'VALIDATOR_DIGEST_MISMATCH', observed.resolvedSha256 ?? 'ABSENT');
    }
  } else {
    // Replay: identity is whatever the historical record says decided it.
    if (!SHA256_RE.test(observed.historicalSha256 || '')) {
      finding(findings, 'REPLAY_HISTORICAL_IDENTITY_ABSENT', canonicalPath);
    } else if (observed.resolvedSha256 !== observed.historicalSha256) {
      finding(findings, 'REPLAY_VALIDATOR_IDENTITY_MISMATCH', `${observed.historicalSha256}!=${observed.resolvedSha256 ?? 'ABSENT'}`);
    }
  }

  return { decision: findings.length === 0 ? 'AUTHORIZED' : 'BLOCKED', purpose, findings };
}
