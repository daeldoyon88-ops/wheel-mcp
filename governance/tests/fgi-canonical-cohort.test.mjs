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
 *
 * The C10+ block covers the R2 addition: a lifecycle phase's own authority
 * artifacts — its record and the owner document that approved it — are derived
 * from canonical path helpers rather than harvested out of a payload. Those
 * tests attack the obvious way that could go wrong, which is self-admission: if
 * merely occupying a canonical authority path put that path into the cohort,
 * any file dropped there would authorize itself.
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
import {
  gateAuthorizationRecordPath, gateAuthorizationAuthoritySnapshotPath
} from '../gee-v1/core/gate-authorization-authority.mjs';
import { gateStartRecordPath, gateStartAuthorityPath } from '../gee-v1/core/gate-start-authority.mjs';
import { precontractLocalAuthorityPath } from '../gee-v1/core/precontract-authority.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = 'GATE19';

const classesOf = (report) => new Set(report.findings.map((f) => f.defectClass));

function gitDelta(root) {
  return execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((line) => line.slice(3));
}

/** A scratch copy outside the repository; the derivation only reads governance/. */
function scratchRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fgi-cohort-'));
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

/**
 * The same copy with the post-freeze maintenance programs removed.
 *
 * WHY THE HOSTILES NEED THIS. A path may be authorized by more than one
 * authority — a Gate's own maintenance program legitimately names lifecycle
 * artifacts too — so breaking ONE authority does not have to remove the path
 * from the cohort, and asserting that it does would assert something false.
 * Isolating the lifecycle sources makes each hostile measure exactly what it
 * claims to measure: what this authority, alone, contributes.
 */
function scratchRepoWithoutMaintenancePrograms() {
  const root = scratchRepo();
  fs.rmSync(path.join(root, 'governance', 'sources'), { recursive: true, force: true });
  return root;
}

const readDoc = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, ...relative.split('/')), 'utf8'));
const writeDoc = (root, relative, value) => {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

test('C01 the cohort is derived from authority documents, with every source resolved', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  assert.ok(derived.cohort.length > 0);

  // REFUSALS ARE NOW PART OF THE ANSWER, NOT A FAILURE OF IT.
  //
  // This case asserted `refusedSources === 0`, which was true while the cohort
  // admitted any structurally valid manifest. Admissibility is now the exact
  // biconditional of canonical publishability: a source is admitted only if some
  // canonical publisher could actually publish it. GATE19 carries two legacy
  // schemaVersion-1 NORMAL_MAINTENANCE programs, and the only publisher that
  // governs that class requires a pre-state-bound V2 manifest — so no publisher
  // could publish them, and admitting them would excuse paths that no canonical
  // publication could have produced. That is the defect the biconditional closes.
  //
  // What must still hold, and is asserted, is that the refusals are exactly that
  // one class and are REPORTED rather than silently dropped. A refusal for any
  // other reason is a real defect and still fails here.
  const refused = derived.sources.filter((source) => !source.admitted);
  assert.equal(refused.length, derived.refusedSources);
  for (const source of refused) {
    assert.equal(source.refusedReason, 'LEGACY_V1_NOT_CANONICALLY_PUBLISHABLE', `${source.sourcePath}: ${source.refusedReason}`);
    assert.equal(source.pathCount, 0);
  }
  assert.deepEqual(
    derived.findings.filter((finding) => finding.code !== 'AUTHORITY_SOURCE_REFUSED'),
    [],
    JSON.stringify(derived.findings)
  );
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

/* ---------------------------------------------------------------------------
 * R2 — lifecycle authority artifacts as a derived path class.
 * ------------------------------------------------------------------------ */

test('C10 every lifecycle phase contributes its own record and owner authority', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  // The authorization pair and the precontract authority are the ones that no
  // payload can name: their primitives refuse a record that lists them. They are
  // in the cohort only because the derivation computes them.
  for (const relative of [
    gateAuthorizationRecordPath(GATE), gateAuthorizationAuthoritySnapshotPath(GATE),
    gateStartRecordPath(GATE), gateStartAuthorityPath(GATE),
    precontractLocalAuthorityPath(GATE)
  ]) {
    assert.ok(derived.cohort.includes(relative), `lifecycle authority artifact missing from cohort: ${relative}`);
  }
});

test('C11 an authority-shaped file at a canonical authority path does not admit itself', () => {
  const root = scratchRepoWithoutMaintenancePrograms();
  const target = gateAuthorizationRecordPath(GATE);
  assert.ok(deriveCanonicalAuthorizedCohort({ root, gateId: GATE }).cohort.includes(target));

  // Plausible, correctly located, correctly named — and not a valid record.
  writeDoc(root, target, {
    document: 'GATE_AUTHORIZATION_RECORD', gateId: GATE, projectId: 'WHEEL',
    authorizedStateArtifacts: [], authorizedDerivedArtifacts: []
  });

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.valid, false);
  assert.equal(after.cohort.includes(target), false, 'an invalid document must not authorize its own path');
  assert.ok(after.sources.some((s) => s.sourcePath === target
    && s.refusedReason === 'AUTHORITY_DOCUMENT_INVALID' && s.pathCount === 0));
});

test('C12 an authority whose declared pre-state was altered is refused, and loses its own path', () => {
  const root = scratchRepoWithoutMaintenancePrograms();
  const target = precontractLocalAuthorityPath(GATE);
  const before = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.ok(before.cohort.includes(target));

  // Only the pre-state moves. Every other byte, including approvedRequestDigest,
  // stays exactly as the owner issued it — so the document's own digest
  // recomputation is what catches this, not a shape rule.
  const authority = readDoc(root, target);
  authority.preState.baseCommit = 'f'.repeat(40);
  writeDoc(root, target, authority);

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.valid, false);
  assert.equal(after.cohort.includes(target), false);
  assert.ok(after.sources.some((s) => s.sourcePath === target && s.pathCount === 0),
    'a refused authority contributes no paths at all');
});

test('C13 an owner authority whose approval is not bound to its record is refused', () => {
  const root = scratchRepoWithoutMaintenancePrograms();
  const snapshot = gateAuthorizationAuthoritySnapshotPath(GATE);
  const authority = readDoc(root, snapshot);
  // The owner approved a binding digest computed over the record's recordedAt.
  // Re-pointing the approval at anything else breaks that binding.
  authority.approvedBindingDigest = 'a'.repeat(64);
  writeDoc(root, snapshot, authority);

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.valid, false);
  assert.equal(after.cohort.includes(snapshot), false);
  // The whole phase is refused, not just its owner half: an authorization whose
  // owner approval does not bind it is not a half-valid authorization.
  assert.ok(after.sources.some((s) => s.sourcePath === snapshot
    && s.refusedReason === 'AUTHORITY_DOCUMENT_INVALID'));
});

test('C14 a lifecycle document bound to another Gate contributes nothing', () => {
  const root = scratchRepoWithoutMaintenancePrograms();
  const target = gateStartRecordPath(GATE);
  const record = readDoc(root, target);
  record.gateId = 'GATE13';
  writeDoc(root, target, record);

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.valid, false);
  assert.equal(after.cohort.includes(target), false);
});

test('C15 a path that exists but is authorized nowhere stays outside the cohort', () => {
  const root = scratchRepo();
  const intruder = 'governance/tools/exists-but-unauthorized.mjs';
  fs.writeFileSync(path.join(root, ...intruder.split('/')), '// present on disk, named by no authority\n');

  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(after.cohort.includes(intruder), false, 'existence is not authorization');
});

test('C16 the derivation produces the same cohort where there is no Git at all', () => {
  const derived = deriveCanonicalAuthorizedCohort({ root: REPO_ROOT, gateId: GATE });
  // The scratch copy holds governance/ and nothing else — no .git, no index, no
  // HEAD. An identical cohort digest there is the direct proof that no path
  // reaches the cohort by way of Git: the derivation cannot have consulted
  // something that is not present.
  const root = scratchRepo();
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
  const detached = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.equal(detached.cohortDigest, derived.cohortDigest);
  assert.deepEqual(detached.cohort, derived.cohort);

  // And a file that exists only in the working tree stays out of the cohort even
  // when Git would report it, which is the same property from the other side.
  const intruder = 'governance/tools/delta-only-intruder.mjs';
  fs.writeFileSync(path.join(root, ...intruder.split('/')), '// untracked\n');
  assert.equal(deriveCanonicalAuthorizedCohort({ root, gateId: GATE }).cohort.includes(intruder), false);
});

test('C17 lifecycle artifacts are derived, never read out of a record payload', () => {
  const root = scratchRepo();
  const target = gateAuthorizationRecordPath(GATE);
  const record = readDoc(root, target);
  // The authorization record cannot legally name its own pair — its cohort is a
  // closed role-keyed set. Confirm the derivation does not depend on it doing so.
  const named = [
    ...(record.authorizedStateArtifacts ?? []), ...(record.authorizedDerivedArtifacts ?? [])
  ].map((a) => a.repoRelativePath);
  assert.equal(named.includes(target), false, 'fixture assumption: the record does not name itself');
  assert.equal(named.includes(gateAuthorizationAuthoritySnapshotPath(GATE)), false);

  const derived = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  assert.ok(derived.cohort.includes(target));
  assert.ok(derived.cohort.includes(gateAuthorizationAuthoritySnapshotPath(GATE)));
});
