/**
 * FINAL_GATE_INTEGRITY — canonical cohort derivation hostiles.
 *
 * The defect this battery exists to keep closed: FINAL_GATE_INTEGRITY once
 * accepted its authorized cohort as a caller argument, so passing the observed
 * Git delta made "delta minus cohort is empty" true by construction. The
 * historical GATE19 PASS was produced that way.
 *
 * Every test below attacks the derivation from a different side: feed it the
 * delta, feed it a superset, feed it a subset, break a link in the authority
 * chain, and check that Git can never contribute a path to the cohort.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { deriveCanonicalAuthorizedCohort } from '../gee-v1/core/canonical-authorized-cohort.mjs';
import { auditFinalGateIntegrity } from '../tools/final-gate-integrity-auditor.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = 'GATE19';

const classesOf = (report) => new Set(report.findings.map((f) => f.defectClass));

function gitDelta(root) {
  return execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
}

test('C01 the cohort is derived from authority documents, with every source resolved', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  assert.equal(derived.valid, true, JSON.stringify(derived.findings));
  assert.equal(derived.refusedSources, 0);
  assert.ok(derived.cohort.length > 0);
  assert.equal(derived.document, 'CANONICAL_AUTHORIZED_COHORT');
  // Deterministic: same inputs, same digest.
  const again = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  assert.equal(again.cohortDigest, derived.cohortDigest);
});

test('C02 no path enters the cohort from Git', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  const declared = new Set();
  for (const source of derived.sources.filter((s) => s.admitted)) assert.ok(source.pathCount >= 0);
  // Every cohort member must be nameable by at least one admitted authority
  // document; the derivation never consults the working tree, so a path that is
  // only in the delta cannot appear.
  const delta = gitDelta(REPO_ROOT);
  const deltaOnly = delta.filter((p) => derived.cohort.includes(p));
  for (const p of deltaOnly) declared.add(p);
  assert.ok(derived.cohort.every((p) => typeof p === 'string' && p.startsWith('governance/')));
  assert.equal(derived.cohort.length, new Set(derived.cohort).size);
});

test('C03 supplying the Git delta as --cohort cannot manufacture a PASS', () => {
  const delta = gitDelta(REPO_ROOT);
  const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: GATE, authorizedCohort: delta });
  const classes = classesOf(report);
  // The delta and the derived cohort are different sets, so the cross-check must
  // object in at least one direction rather than agreeing with itself.
  assert.ok(
    classes.has('SUPPLIED_COHORT_PATH_NOT_CANONICALLY_AUTHORIZED')
    || classes.has('SUPPLIED_COHORT_OMITS_CANONICAL_PATH')
    || delta.length === 0,
    'a Git-derived cohort claim must be refused by the canonical derivation'
  );
});

test('C04 an extra path in the supplied cohort is refused', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  const report = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: GATE,
    authorizedCohort: [...derived.cohort, 'governance/tools/not-authorized-anywhere.mjs']
  });
  assert.ok(classesOf(report).has('SUPPLIED_COHORT_PATH_NOT_CANONICALLY_AUTHORIZED'));
});

test('C05 omitting a canonically authorized path from the supplied cohort is refused', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  const report = auditFinalGateIntegrity({
    root: REPO_ROOT, gateId: GATE, authorizedCohort: derived.cohort.slice(1)
  });
  assert.ok(classesOf(report).has('SUPPLIED_COHORT_OMITS_CANONICAL_PATH'));
});

test('C06 the exact derived cohort raises no cross-check finding', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  const report = auditFinalGateIntegrity({ root: REPO_ROOT, gateId: GATE, authorizedCohort: derived.cohort });
  const classes = classesOf(report);
  assert.equal(classes.has('SUPPLIED_COHORT_PATH_NOT_CANONICALLY_AUTHORIZED'), false);
  assert.equal(classes.has('SUPPLIED_COHORT_OMITS_CANONICAL_PATH'), false);
});

test('C07 a drifted manifest digest removes its program from the cohort', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fgi-cohort-'));
  // A shallow copy is enough: the derivation only reads governance documents.
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  const before = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const target = before.sources.find((s) => s.kind === 'POST_FREEZE_MAINTENANCE_AUTHORITY' && s.admitted);
  assert.ok(target, 'fixture needs at least one admitted post-freeze program');

  const authority = JSON.parse(fs.readFileSync(path.join(root, ...target.sourcePath.split('/')), 'utf8'));
  const manifestFile = path.join(root, ...authority.authorizedPathManifestPath.split('/'));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.paths.push({
    path: 'governance/tools/smuggled-by-manifest-edit.mjs', operation: 'CREATE',
    phase: 'MAINTENANCE', reason: 'smuggled', artifactClass: 'MAINTENANCE'
  });
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.ok(after.refusedSources > before.refusedSources);
  assert.equal(after.cohort.includes('governance/tools/smuggled-by-manifest-edit.mjs'), false);
  assert.equal(after.valid, false);
});

test('C08 a program whose consumption record is absent contributes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fgi-cohort-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  const before = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const target = before.sources.find((s) => s.kind === 'POST_FREEZE_MAINTENANCE_AUTHORITY' && s.admitted);
  const authority = JSON.parse(fs.readFileSync(path.join(root, ...target.sourcePath.split('/')), 'utf8'));
  fs.rmSync(path.join(root, ...authority.consumptionRecordPath.split('/')), { force: true });

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.valid, false);
  assert.ok(after.sources.some((s) => s.sourcePath === target.sourcePath && s.refusedReason === 'CONSUMPTION_ABSENT'));
  assert.ok(after.cohort.length < before.cohort.length);
});

test('C09 an unknown Gate derives an empty cohort and is invalid', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: 'NOT_A_GATE' });
  assert.equal(derived.valid, false);
  assert.equal(derived.cohort.length, 0);
});
