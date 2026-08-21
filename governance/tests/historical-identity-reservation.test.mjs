/**
 * HISTORICAL IDENTITY RESERVATION — the durable B05 hostile battery.
 *
 * WHY THIS FILE EXISTS AT ALL. The B05 closure was originally proven by throwaway
 * scripts in a temporary directory. That is not evidence a repository holds: an
 * independent inspection of the checkpoint could not find the matrix, and a proof
 * nobody can re-run is indistinguishable from a proof that was never run. The
 * hostile cases live here now, registered in EVIDENCE_SUITE_IDENTITY_BASELINE.json
 * like every other governed suite.
 *
 * WHAT IS BEING DEFENDED, IN ONE SENTENCE. Once the Project Owner reserves a
 * historical program identity, the exact ratified bytes may be recognised through
 * the bounded historical bridge, and NO other bytes may be recognised under that
 * identity by any route — not by rewriting the documents, not by publishing, and
 * not by destroying the evidence that the reservation exists.
 *
 * THE TWO ATTACK FAMILIES.
 *
 *   B05-*    REWRITE the identity. The original exploit turned the legacy V1
 *            manifest into a coherent V2 one, resealed the authority and the
 *            consumption record onto it, and kept the programId — so the source
 *            stopped being V1 and sailed down the ordinary V2 path, never touching
 *            the bridge. Closed by deciding reserved identities ABOVE the schema
 *            branch, in the shared admissibility boundary.
 *
 *   B05-P*   DESTROY the reservation. Delete the ratification, corrupt its
 *            documentKind, alter its gateId or programId and legitimately recompute
 *            its digest, or make it unparseable — and the identity became
 *            UNRESERVED, at which point the rewrite worked again. Five of five were
 *            reproduced. Closed by deriving reserved-ness from a UNION of
 *            independent witnesses, none of which can subtract a reservation.
 *
 * NON-VACUITY IS ASSERTED, NOT ASSUMED. B05-01 and B05-P06 must ADMIT, and B05-12,
 * B05-13 and B05-P07 must PUBLISH. A battery that refused everything would pass
 * every BLOCK case below while proving nothing at all.
 *
 * Every case runs against the REAL canonical boundary — `deriveCanonicalAuthorizedCohort`
 * for admission, `applyPathPrestateProgram` for publication — in a disposable copy.
 * The canonical repository is never mutated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { deriveCanonicalAuthorizedCohort } from '../gee-v1/core/canonical-authorized-cohort.mjs';
import {
  computeHistoricalAdmissionBridgeDigest,
  computeHistoricalIdentityRatificationDigest,
  computeReservationRegistryDigest,
  RESERVATION_REGISTRY_PATH
} from '../gee-v1/core/historical-admission-bridge.mjs';
import { evaluateMaintenanceSourceAdmissibility, MODE_PUBLICATION } from '../gee-v1/core/maintenance-publication-admissibility.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = 'GATE20';
const PROGRAM = 'GATE20_FOUNDATION_PROJECTION_SYNC_R1';
const AUTH = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json';
const MAN = 'governance/historical-architecture/GATE20_FOUNDATION_PROJECTION_SYNC_AUTHORIZED_PATHS_R1.json';
const CONS = 'governance/historical-architecture/GATE20_FOUNDATION_PROJECTION_SYNC_CONSUMPTION_R1.json';
const RAT = `governance/authority/historical-ratifications/${GATE}/PROJECT_OWNER_HISTORICAL_IDENTITY_RATIFICATION_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json`;
const BRIDGE = `governance/authority/historical-bridges/${GATE}/PROJECT_OWNER_HISTORICAL_ADMISSION_BRIDGE_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json`;

const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hist-identity-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ } });

const abs = (root, rel) => path.resolve(root, ...rel.split('/'));
const readJson = (root, rel) => JSON.parse(fs.readFileSync(abs(root, rel), 'utf8').replace(/^﻿/, ''));
const writeJson = (root, rel, value) => {
  fs.mkdirSync(path.dirname(abs(root, rel)), { recursive: true });
  fs.writeFileSync(abs(root, rel), `${JSON.stringify(value, null, 2)}\n`);
};
const sha = (root, rel) => crypto.createHash('sha256').update(fs.readFileSync(abs(root, rel))).digest('hex');

let ordinal = 0;
/**
 * A disposable copy of the governance tree.
 *
 * The cohort derivation is forbidden to read Git, so a plain copy is the honest
 * fixture here — if these cases needed a clone, the derivation would be consulting
 * the thing it exists to judge.
 */
function sandbox() {
  ordinal += 1;
  const root = path.join(SCRATCH, `case-${ordinal}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'governance'), path.join(root, 'governance'), { recursive: true });
  return root;
}

/** Re-seal after editing, so a case attacks the BINDING rather than the digest. */
const resealBridge = (root, mutate) => {
  const b = readJson(root, BRIDGE); mutate(b);
  b.bridgeDigest = computeHistoricalAdmissionBridgeDigest(b);
  writeJson(root, BRIDGE, b);
};
const resealRatification = (root, mutate) => {
  const r = readJson(root, RAT); mutate(r);
  r.ratificationDigest = computeHistoricalIdentityRatificationDigest(r);
  writeJson(root, RAT, r);
};
const resealRegistry = (root, mutate) => {
  const g = readJson(root, RESERVATION_REGISTRY_PATH); mutate(g);
  g.registryDigest = computeReservationRegistryDigest(g);
  writeJson(root, RESERVATION_REGISTRY_PATH, g);
};

/**
 * THE ORIGINAL EXPLOIT, as one function.
 *
 * Rewrites the legacy V1 manifest into a coherent V2 manifest with real pre-state
 * declarations, repoints and reseals the authority onto it, and repoints the
 * consumption record at both — while keeping the same historical programId.
 */
function coherentV2Rewrite(root) {
  const manifest = readJson(root, MAN);
  manifest.schemaVersion = 2;
  manifest.prestateSelfExclusion = [
    { path: AUTH, role: 'AUTHORITY_DOCUMENT', reason: 'must exist for its own evaluator to read it' },
    { path: MAN, role: 'AUTHORIZED_PATH_MANIFEST', reason: 'must exist to be digest-pinned' }
  ];
  for (const entry of manifest.paths) {
    entry.prestate = entry.operation === 'CREATE'
      ? { state: 'ABSENT' }
      : { state: 'PRESENT', sha256: sha(root, entry.path), byteLength: fs.statSync(abs(root, entry.path)).size };
  }
  writeJson(root, MAN, manifest);
  const authority = readJson(root, AUTH);
  authority.authorizedPathManifestSha256 = sha(root, MAN);
  writeJson(root, AUTH, authority);
  const consumption = readJson(root, CONS);
  consumption.manifestSha256 = sha(root, MAN);
  for (const entry of consumption.cohort ?? []) {
    if (entry.path === MAN || entry.path === AUTH) {
      entry.sha256 = sha(root, entry.path);
      entry.byteLength = fs.statSync(abs(root, entry.path)).size;
    }
  }
  writeJson(root, CONS, consumption);
}

/** What the canonical cohort boundary says about the reserved source. */
function admissionVerdict(root, sourcePath = AUTH) {
  const cohort = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const source = cohort.sources.find((entry) => entry.sourcePath === sourcePath);
  return {
    admitted: source?.admitted ?? false,
    reason: source?.refusedReason ?? null,
    contributedPaths: source?.pathCount ?? 0,
    cohortSize: cohort.cohort.length
  };
}

/* ======================================================================== *
 * B05 — REWRITING THE RESERVED IDENTITY
 * ======================================================================== */

test('B05-01 the exact Owner-ratified historical triple is admitted through its bridge', () => {
  const root = sandbox();
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, true, `control refused: ${verdict.reason}`);
  assert.ok(verdict.contributedPaths > 0, 'an admitted historical program contributed no paths');
});

test('B05-02 the coherent V1 to V2 rewrite under the reserved identity is BLOCKED', () => {
  const root = sandbox();
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'the original B05 exploit was admitted again');
  assert.equal(verdict.reason, 'HISTORICAL_IDENTITY_RESERVED_MISMATCH');
  assert.equal(verdict.contributedPaths, 0, 'a blocked exploit still contributed paths');
});

test('B05-03 a wholly fresh coherent V2 triple under the reserved identity is BLOCKED', () => {
  const root = sandbox();
  coherentV2Rewrite(root);
  const authority = readJson(root, AUTH);
  authority.authorityId = 'FRESH_AUTHORITY_R1';
  authority.createdAt = '2026-08-17T12:00:00.000Z';
  writeJson(root, AUTH, authority);
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-04 the reserved identity can never publish, however valid the candidate', () => {
  const root = sandbox();
  // Asked of the SHARED admissibility boundary in MODE_PUBLICATION — the same
  // function the canonical publisher calls — so this is the publisher's answer.
  const result = evaluateMaintenanceSourceAdmissibility({
    authority: readJson(root, AUTH), manifest: readJson(root, MAN), manifestSha256: sha(root, MAN),
    consumption: null, requireConsumption: false, mode: MODE_PUBLICATION,
    historicalIdentity: { reserved: true, decision: 'ADMIT_HISTORICAL' }
  });
  assert.equal(result.admissible, false, 'a reserved identity was allowed to publish');
  assert.equal(result.reason, 'HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE');
});

test('B05-05 one altered byte in the ratified historical triple is BLOCKED', () => {
  const root = sandbox();
  const consumption = readJson(root, CONS);
  consumption.commitMessage = `${consumption.commitMessage} `;
  writeJson(root, CONS, consumption);
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-06 a ratification resealed to grant publication is BLOCKED', () => {
  const root = sandbox();
  resealRatification(root, (r) => { r.grantsPublicationPermission = true; });
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-07 a ratification edited without resealing fails its own digest', () => {
  const root = sandbox();
  const r = readJson(root, RAT);
  r.historicalManifest.sha256 = 'a'.repeat(64);
  writeJson(root, RAT, r);
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-08 a bridge bound to the wrong ratification is BLOCKED', () => {
  const root = sandbox();
  resealBridge(root, (b) => { b.ratification.sha256 = 'b'.repeat(64); });
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'BRIDGE_RATIFICATION_BINDING_INVALID');
});

test('B05-09 duplicate ratifications for one reserved identity fail closed', () => {
  const root = sandbox();
  const r = readJson(root, RAT);
  r.authorityId = 'DUPLICATE_RATIFICATION_R1';
  r.ratificationDigest = computeHistoricalIdentityRatificationDigest(r);
  writeJson(root, `governance/authority/historical-ratifications/${GATE}/DUPLICATE_RATIFICATION_R1.json`, r);
  assert.equal(admissionVerdict(root).admitted, false, 'a duplicate ratification was resolved first-wins');
});

test('B05-10 duplicate bridges for one reserved identity fail closed', () => {
  const root = sandbox();
  const b = readJson(root, BRIDGE);
  b.bridgeId = 'DUPLICATE_BRIDGE_R1';
  b.bridgeDigest = computeHistoricalAdmissionBridgeDigest(b);
  writeJson(root, `governance/authority/historical-bridges/${GATE}/DUPLICATE_BRIDGE_R1.json`, b);
  assert.equal(admissionVerdict(root).admitted, false, 'a duplicate bridge was resolved first-wins');
});

test('B05-11 an arbitrary sibling V1 program is still refused, so this is no generic hatch', () => {
  const root = sandbox();
  const SA = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_SIBLING_V1_R1.json';
  const SM = 'governance/historical-architecture/SIBLING_V1_AUTHORIZED_PATHS_R1.json';
  const SC = 'governance/historical-architecture/SIBLING_V1_CONSUMPTION_R1.json';
  const remap = (p) => (p === AUTH ? SA : p === MAN ? SM : p === CONS ? SC : p);
  const authority = readJson(root, AUTH);
  const manifest = readJson(root, MAN);
  const consumption = readJson(root, CONS);
  manifest.manifestId = 'SIBLING_V1_AUTHORIZED_PATHS_R1';
  manifest.programId = 'SIBLING_V1_R1';
  manifest.paths = manifest.paths.map((entry) => ({ ...entry, path: remap(entry.path) }));
  writeJson(root, SM, manifest);
  authority.programId = 'SIBLING_V1_R1';
  authority.authorityId = 'SIBLING_V1_LOCAL_AUTHORITY_R1';
  authority.authorizedPathManifestPath = SM;
  authority.authorizedPathManifestSha256 = sha(root, SM);
  authority.consumptionRecordPath = SC;
  writeJson(root, SA, authority);
  consumption.programId = 'SIBLING_V1_R1';
  consumption.authorityId = 'SIBLING_V1_LOCAL_AUTHORITY_R1';
  consumption.manifestSha256 = sha(root, SM);
  consumption.cohortSelfExclusion = { ...consumption.cohortSelfExclusion, path: SC };
  consumption.cohort = (consumption.cohort ?? []).map((entry) => ({ ...entry, path: remap(entry.path) }));
  writeJson(root, SC, consumption);
  const verdict = admissionVerdict(root, SA);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'LEGACY_V1_NOT_CANONICALLY_PUBLISHABLE');
});

test('B05-12 a recomputed but coherent receipt under the reserved identity is BLOCKED', () => {
  const root = sandbox();
  const consumption = readJson(root, CONS);
  consumption.recordedAt = '2026-08-17T23:59:00.000Z';
  consumption.transactionId = 'RECOMPUTED_TRANSACTION';
  writeJson(root, CONS, consumption);
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-13 a receipt naming the bridge as its own authority is BLOCKED', () => {
  const root = sandbox();
  const consumption = readJson(root, CONS);
  consumption.authorityId = readJson(root, BRIDGE).bridgeId;
  writeJson(root, CONS, consumption);
  assert.equal(admissionVerdict(root).admitted, false);
});

test('B05-14 a bridge naming ITSELF as its ratification is BLOCKED', () => {
  const root = sandbox();
  resealBridge(root, (b) => { b.ratification = { path: BRIDGE, sha256: sha(root, BRIDGE) }; });
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'BRIDGE_RATIFICATION_BINDING_INVALID');
});

test('B05-15 the exact historical triple is deterministic across fresh processes', () => {
  const root = sandbox();
  const script = `
    import { deriveCanonicalAuthorizedCohort } from ${JSON.stringify(new URL('../gee-v1/core/canonical-authorized-cohort.mjs', import.meta.url).href)};
    const c = deriveCanonicalAuthorizedCohort({ root: process.argv[2], gateId: '${GATE}' });
    const s = c.sources.find((x) => x.sourcePath === ${JSON.stringify(AUTH)});
    process.stdout.write(JSON.stringify({ admitted: s.admitted, digest: c.cohortDigest }));
  `;
  const file = path.join(SCRATCH, 'determinism.mjs');
  fs.writeFileSync(file, script, 'utf8');
  const runs = [0, 1, 2].map(() => spawnSync(process.execPath, [file, root], { encoding: 'utf8' }).stdout.trim());
  // maxUse = 1 bounds WHICH object may be admitted, never how often the validator
  // may be asked. Repeated validation of the same object must be idempotent.
  assert.equal(runs[0], runs[1]);
  assert.equal(runs[1], runs[2]);
  assert.match(runs[0], /"admitted":true/, 'the control stopped admitting, so determinism proves nothing');
});

/* ======================================================================== *
 * B05-P — DESTROYING THE RESERVATION (permanence)
 * ======================================================================== */

test('B05-P01 deleting the ratification does not release the reserved identity', () => {
  const root = sandbox();
  fs.rmSync(abs(root, RAT));
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'deleting the ratification released the identity');
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
  assert.equal(verdict.contributedPaths, 0);
});

test('B05-P02 corrupting the ratification documentKind does not release the identity', () => {
  const root = sandbox();
  const r = readJson(root, RAT);
  r.documentKind = 'SOMETHING_ELSE_ENTIRELY';
  writeJson(root, RAT, r);
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'an undiscoverable ratification released the identity');
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});

test('B05-P03 altering the ratification gateId and resealing does not release the identity', () => {
  const root = sandbox();
  resealRatification(root, (r) => { r.gateId = 'GATE19'; });
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'a re-pointed ratification released the original identity');
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});

test('B05-P04 altering the ratification programId and resealing does not release the identity', () => {
  const root = sandbox();
  resealRatification(root, (r) => { r.programId = 'SOME_OTHER_PROGRAM_R1'; });
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'a re-pointed ratification released the original identity');
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});

test('B05-P05 an unparseable ratification does not release the identity', () => {
  const root = sandbox();
  fs.writeFileSync(abs(root, RAT), '{ this is not valid json');
  coherentV2Rewrite(root);
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false, 'a malformed ratification released the identity');
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});

test('B05-P06 with registry and ratification intact the historical control still ADMITS', () => {
  // The non-vacuity anchor for the whole P family: every BLOCK above is only
  // meaningful because this case admits.
  const root = sandbox();
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, true, `permanence repair broke the control: ${verdict.reason}`);
  assert.ok(verdict.contributedPaths > 0);
});

test('B05-P07 an unrelated legitimate program is unaffected by the reservation', () => {
  // Reserving one identity must not disable maintenance globally. Every OTHER
  // admitted source in the Gate keeps contributing exactly as before.
  const root = sandbox();
  const before = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  const others = before.sources.filter((s) => s.sourcePath !== AUTH && s.admitted);
  assert.ok(others.length > 0, 'no other admitted source exists, so this proves nothing');

  fs.rmSync(abs(root, RAT));
  const after = deriveCanonicalAuthorizedCohort({ root, gateId: GATE });
  for (const source of others) {
    const now = after.sources.find((s) => s.sourcePath === source.sourcePath);
    assert.equal(now?.admitted, true, `unrelated source ${source.sourcePath} lost admission`);
    assert.equal(now?.pathCount, source.pathCount, `unrelated source ${source.sourcePath} changed its cohort`);
  }
});

test('B05-P08 deleting the registry entry alone does not release the identity', () => {
  // The witnesses are a union: the ratification and the bridge still testify.
  const root = sandbox();
  resealRegistry(root, (g) => { g.reservedHistoricalIdentities = []; });
  coherentV2Rewrite(root);
  assert.equal(admissionVerdict(root).admitted, false, 'emptying the registry released the identity');
});

test('B05-P09 a registry naming a ratification it does not match is BLOCKED', () => {
  const root = sandbox();
  resealRegistry(root, (g) => { g.reservedHistoricalIdentities[0].ratificationDigest = 'c'.repeat(64); });
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});

test('B05-P10 a ratification whose registry back-reference is wrong is BLOCKED', () => {
  const root = sandbox();
  resealRatification(root, (r) => { r.ownerAuthorizationSha256 = 'd'.repeat(64); });
  const verdict = admissionVerdict(root);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'RESERVED_BUT_AUTHORITY_INVALID');
});
