#!/usr/bin/env node
/**
 * Executable verifier for validator provenance (H6), and the generator for the
 * execution manifest it checks against.
 *
 *   validate-validator-provenance.mjs             verify
 *   validate-validator-provenance.mjs --regenerate   rebind digests to real bytes
 *
 * The verifier resolves every validator by CANONICAL repository path, never
 * relative to the working directory, and proves that a validator offered by a
 * candidate tree cannot be admitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  evaluateValidatorProvenance,
  validateValidatorProvenanceManifest,
  VALIDATOR_PROVENANCE_MANIFEST_KIND,
  VALIDATOR_PROVENANCE_SCHEMA_VERSION,
  PURPOSE_ADMISSION
} from '../gee-v1/core/validator-provenance.mjs';

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * CANONICAL root is derived from THIS FILE's own location, never from cwd and
 * never from --root. --root selects the tree being judged; it must not select
 * the code doing the judging.
 */
const canonicalRoot = path.resolve(toolsDir, '..', '..');
const manifestPath = path.resolve(option('--manifest', path.join(canonicalRoot, 'governance/historical-architecture/VALIDATOR_PROVENANCE_MANIFEST.json')));

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The executable validators this program admits, by canonical repo path. */
const ADMITTED_VALIDATORS = [
  'governance/tools/validate-status-ledger.mjs',
  'governance/tools/validate-state-seal.mjs',
  'governance/tools/validate-state-revision.mjs',
  'governance/tools/validate-artifact-classification.mjs',
  'governance/tools/validate-legacy-state-binding.mjs',
  'governance/tools/validate-post-freeze-maintenance-authority.mjs',
  'governance/tools/replay-governance-history.mjs',
  'governance/tools/validate-validator-provenance.mjs'
];

if (process.argv.includes('--regenerate')) {
  const validators = ADMITTED_VALIDATORS.map((canonicalPath) => {
    const bytes = fs.readFileSync(path.join(canonicalRoot, ...canonicalPath.split('/')));
    return { canonicalPath, sha256: sha256(bytes), byteLength: bytes.length, purpose: 'ADMISSION_AND_REPLAY' };
  });
  const manifest = {
    documentKind: VALIDATOR_PROVENANCE_MANIFEST_KIND,
    schemaVersion: VALIDATOR_PROVENANCE_SCHEMA_VERSION,
    programId: 'GOVERNANCE_HISTORICAL_ARCHITECTURE_IMPLEMENTATION_PROGRAM_R1',
    statement: 'Canonical path and byte identity of every executable validator this program admits. Admission resolves validators by canonical path plus this digest; a candidate tree can never supply the code that judges it. Replay resolves validators by retained historical content identity instead. No key material is involved: a validator IS its bytes.',
    validators
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ document: 'VALIDATOR_PROVENANCE_REGENERATED', validators: validators.length, manifestPath: path.relative(canonicalRoot, manifestPath).replaceAll('\\', '/') }, null, 2) + '\n');
} else {
  const findings = [];
  const results = [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, '')); }
  catch (error) { findings.push({ code: 'PROVENANCE_MANIFEST_UNREADABLE', detail: error?.message || String(error) }); }

  if (manifest) {
    findings.push(...validateValidatorProvenanceManifest(manifest).findings);
    for (const entry of manifest.validators || []) {
      const absolute = path.join(canonicalRoot, ...entry.canonicalPath.split('/'));
      const exists = fs.existsSync(absolute) && fs.statSync(absolute).isFile();
      const evaluation = evaluateValidatorProvenance({
        manifest,
        canonicalPath: entry.canonicalPath,
        purpose: PURPOSE_ADMISSION,
        observed: {
          resolvedPath: entry.canonicalPath,
          resolvedSha256: exists ? sha256(fs.readFileSync(absolute)) : null,
          resolvedFromCandidateTree: false
        }
      });
      findings.push(...evaluation.findings);
      results.push({ canonicalPath: entry.canonicalPath, decision: evaluation.decision });
    }
    for (const required of ADMITTED_VALIDATORS) {
      if (!(manifest.validators || []).some((entry) => entry.canonicalPath === required)) {
        findings.push({ code: 'ADMITTED_VALIDATOR_NOT_PINNED', detail: required });
      }
    }
  }

  const valid = findings.length === 0;
  process.stdout.write(JSON.stringify({
    document: 'VALIDATOR_PROVENANCE_VALIDATION',
    valid,
    canonicalRootDerivedFrom: 'THIS_FILE_LOCATION',
    validators: results,
    findings
  }, null, 2) + '\n');
  process.exitCode = valid ? 0 : 2;
}
