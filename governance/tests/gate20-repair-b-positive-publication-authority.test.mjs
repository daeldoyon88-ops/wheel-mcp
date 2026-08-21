import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  validateMaintenanceAuthorizedPathManifest,
  validatePostFreezeMaintenanceAuthorityV2Shape
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import {
  MODE_PUBLICATION,
  evaluateMaintenanceSourceAdmissibility
} from '../gee-v1/core/maintenance-publication-admissibility.mjs';
import { collectPostFreezeMaintenanceObservation } from '../tools/post-freeze-maintenance-observation.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const authorityPath = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_REPAIR_B_POSITIVE_PUBLICATION_R1.json';
const manifestPath = 'governance/historical-architecture/GATE20_REPAIR_B_POSITIVE_PUBLICATION_AUTHORIZED_PATHS_R1.json';
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const authority = readJson(authorityPath);
const manifest = readJson(manifestPath);

function canonicalPrepublicationObservation() {
  const observation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath: authorityPath });
  assert.equal(observation.valid, true, JSON.stringify(observation.findings));
  const pathPrestates = {};
  for (const entry of manifest.paths) {
    pathPrestates[entry.path] = entry.prestate.state === 'PRESENT'
      ? { ...entry.prestate, canonicalPredecessors: [entry.prestate.sha256] }
      : { state: 'ABSENT', sha256: null, byteLength: null, canonicalPredecessors: [] };
  }
  return {
    ...observation.observed,
    pathPrestates,
    requestedPaths: manifest.paths.map((entry) => entry.path),
    requestedOperationClasses: [...new Set(manifest.paths.map((entry) => entry.artifactClass))]
  };
}

test('GATE20 Repair-B authority is bounded while publication remains closed without Owner admission', () => {
  assert.equal(validatePostFreezeMaintenanceAuthorityV2Shape(authority).valid, true);
  const manifestResult = validateMaintenanceAuthorizedPathManifest(manifest, authority.programId, authority.authorityPurpose);
  assert.equal(manifestResult.valid, true, JSON.stringify(manifestResult.findings));
  assert.equal(manifestResult.authorizedPaths.length, 26);
  assert.equal(new Set(manifestResult.authorizedPaths).size, 26);
  assert.equal(manifestResult.authorizedPaths.some((item) => item.includes('*') || item.includes('?')), false);
  const publicationAdmission = evaluateMaintenanceSourceAdmissibility({
    authority,
    manifest,
    manifestSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, manifestPath))).digest('hex'),
    consumption: null,
    requireConsumption: false,
    mode: MODE_PUBLICATION
  });
  assert.equal(publicationAdmission.admissible, false, JSON.stringify(publicationAdmission.findings));
  assert.equal(publicationAdmission.reason, 'PUBLICATION_ADMISSION_ABSENT');

  const validObservation = canonicalPrepublicationObservation();
  const authorized = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest, observed: validObservation });
  assert.equal(authorized.decision, 'AUTHORIZED', JSON.stringify(authorized.findings));

  const wrongGate = evaluatePostFreezeMaintenanceAuthorityV2({
    authority,
    manifest,
    observed: { ...validObservation, gateId: 'GATE21' }
  });
  assert.equal(wrongGate.decision, 'BLOCKED');
  assert.ok(wrongGate.findings.some((finding) => finding.code === 'PRE_STATE_MISMATCH'));

  const outsideCohort = evaluatePostFreezeMaintenanceAuthorityV2({
    authority,
    manifest,
    observed: { ...validObservation, requestedPaths: [...validObservation.requestedPaths, 'governance/unrelated.mjs'] }
  });
  assert.equal(outsideCohort.decision, 'BLOCKED');
  assert.ok(outsideCohort.findings.some((finding) => finding.code === 'PATH_NOT_AUTHORIZED'));

  const tamperedManifest = { ...manifest, programId: 'GATE20_REPAIR_B_TAMPERED_R1' };
  const tampered = evaluatePostFreezeMaintenanceAuthorityV2({
    authority,
    manifest: tamperedManifest,
    observed: { ...validObservation, manifestSha256: '0'.repeat(64) }
  });
  assert.equal(tampered.decision, 'BLOCKED');
  assert.ok(tampered.findings.some((finding) => finding.code === 'AUTHORIZED_MANIFEST_SHA_MISMATCH'));

  const liveObservation = collectPostFreezeMaintenanceObservation({ root, authority, authorityDocumentPath: authorityPath });
  const liveBytes = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest, observed: liveObservation.observed });
  assert.equal(liveBytes.decision, 'BLOCKED');
  assert.ok(liveBytes.findings.some((finding) => finding.code.startsWith('PATH_PRESTATE_')));
});

test('Repair-B preserves non-publishing historical reservation and rejects generic legacy publication', () => {
  const reservation = readJson('governance/sources/HISTORICAL_IDENTITY_RESERVATION_OWNER_AUTHORIZATION_R1.json');
  assert.equal(reservation.publicationAuthorized, false);
  assert.equal(reservation.reexecutionAuthorized, false);

  const legacyAuthority = readJson('governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE20_FOUNDATION_PROJECTION_SYNC_R1.json');
  const legacyManifest = readJson(legacyAuthority.authorizedPathManifestPath);
  const legacyManifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, legacyAuthority.authorizedPathManifestPath))).digest('hex');
  const reserved = evaluateMaintenanceSourceAdmissibility({
    authority: legacyAuthority,
    manifest: legacyManifest,
    manifestSha256: legacyManifestSha256,
    consumption: null,
    requireConsumption: false,
    mode: MODE_PUBLICATION,
    historicalIdentity: { reserved: true }
  });
  assert.equal(reserved.admissible, false);
  assert.equal(reserved.reason, 'HISTORICAL_IDENTITY_RESERVED_NOT_PUBLISHABLE');

  const genericV1 = evaluateMaintenanceSourceAdmissibility({
    authority: legacyAuthority,
    manifest: legacyManifest,
    manifestSha256: legacyManifestSha256,
    consumption: null,
    requireConsumption: false,
    mode: MODE_PUBLICATION,
    historicalIdentity: { reserved: false }
  });
  assert.equal(genericV1.admissible, false);
  assert.equal(genericV1.reason, 'MANIFEST_DOES_NOT_BIND_PRESTATE');
  assert.equal(authority.authorizedPathManifestSha256.length, 64);
});
