import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  TRANSFORM_PIPELINE_BASE_ROLES,
  TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION,
  normalizeTransformPipelineProfileV1,
  transformPipelineProfileHash,
  transformPipelineProfileProblems,
  validateTransformPipelineProfile,
} from '../src/contracts/transformPipelineProfileV1.mjs';
import {
  buildLabTransformPipelineProfile,
  buildTransformPipelineProfile,
  LAB_PIPELINE_ROLE_LOGICAL_PATHS,
  labPipelineLogicalPaths,
  transformManifestCoverageProblems,
} from '../src/data/transformPipelineProfilesV1.mjs';
import { buildTransformImplementationManifestV2 } from '../src/data/transformImplementationManifestV2.mjs';
import { code, syntheticPipelineProfile, syntheticTransformManifest } from './l2aSyntheticPipeline.mjs';

const LAB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('TP1 — complete profile normalizes with sorted roles/modules and stable hash', () => {
  const profile = syntheticPipelineProfile();
  assert.deepEqual(validateTransformPipelineProfile(profile), { valid: true, problems: [] });
  assert.deepEqual(profile.roles.map((role) => role.role), [...profile.roles.map((role) => role.role)].sort());
  const reordered = {
    ...profile,
    roles: [...profile.roles].reverse().map((role) => ({ ...role, modules: [...role.modules].reverse() })),
  };
  assert.equal(transformPipelineProfileHash(reordered), transformPipelineProfileHash(profile));
});

test('TP2 — a missing base role is an explicit stable error', () => {
  const roleLogicalPaths = { ...LAB_PIPELINE_ROLE_LOGICAL_PATHS['lab-json-daily/1'] };
  delete roleLogicalPaths.PRICE_BASIS_POLICY;
  assert.throws(() => buildTransformPipelineProfile({
    pipelineProfileId: 'lab-json-daily/1',
    roleLogicalPaths,
    transformManifest: syntheticTransformManifest(),
  }), code('TRANSFORM_PIPELINE_ROLE_MISSING'));
  for (const required of TRANSFORM_PIPELINE_BASE_ROLES) {
    const problems = transformPipelineProfileProblems({
      ...syntheticPipelineProfile(),
      roles: syntheticPipelineProfile().roles.filter((role) => role.role !== required),
    });
    assert.ok(problems.some((problem) => problem.includes(`required role missing: ${required}`)));
  }
});

test('TP3 — duplicate roles are refused with their own code', () => {
  const profile = syntheticPipelineProfile();
  assert.throws(() => normalizeTransformPipelineProfileV1({
    ...profile,
    roles: [...profile.roles, profile.roles[0]],
  }), code('TRANSFORM_PIPELINE_ROLE_DUPLICATE'));
});

test('TP4 — unknown role and unknown field are refused', () => {
  const profile = syntheticPipelineProfile();
  assert.throws(() => normalizeTransformPipelineProfileV1({
    ...profile,
    roles: [...profile.roles, { role: 'HOLDOUT_SELECTOR', modules: profile.roles[0].modules }],
  }), code('TRANSFORM_PIPELINE_PROFILE_INVALID'));
  assert.throws(() => normalizeTransformPipelineProfileV1({ ...profile, admissibleFor: ['DEV'] }), code('CANONICAL_UNKNOWN_FIELD'));
});

test('TP5 — absolute paths, traversal and backslashes are not portable', () => {
  const profile = syntheticPipelineProfile();
  for (const badPath of ['/abs/adapter.mjs', 'C:/abs/adapter.mjs', '../escape.mjs', 'src\\windows\\adapter.mjs', 'src//double.mjs']) {
    const tampered = {
      ...profile,
      roles: profile.roles.map((role, index) => (index === 0
        ? { ...role, modules: [{ logicalPath: badPath, contentSha256: role.modules[0].contentSha256 }] }
        : role)),
    };
    const problems = transformPipelineProfileProblems(tampered);
    assert.ok(problems.some((problem) => problem.includes('not a portable relative path')), `expected refusal for ${badPath}`);
  }
});

test('TP6 — coverage detects a module missing from the manifest and a different module hash', () => {
  const manifest = syntheticTransformManifest();
  const profile = syntheticPipelineProfile();
  const withoutAdapter = {
    ...manifest,
    modules: manifest.modules.filter((module) => module.logicalPath !== 'src/data/jsonDailyAdapter.mjs'),
  };
  const missing = transformManifestCoverageProblems({ transformManifest: withoutAdapter, pipelineProfile: profile });
  assert.deepEqual(missing.map((problem) => problem.code), ['TRANSFORM_PIPELINE_MODULE_MISSING']);

  const changedHash = {
    ...manifest,
    modules: manifest.modules.map((module) => (module.logicalPath === 'src/data/normalizeDailyBars.mjs'
      ? { ...module, canonicalContentSha256: `sha256:${'f'.repeat(64)}` }
      : module)),
  };
  const mismatched = transformManifestCoverageProblems({ transformManifest: changedHash, pipelineProfile: profile });
  assert.deepEqual(mismatched.map((problem) => problem.code), ['TRANSFORM_PIPELINE_MODULE_HASH_MISMATCH']);
});

test('TP7 — corporate action policy coverage is enforced only when declared required', () => {
  const manifest = syntheticTransformManifest();
  const withoutPolicy = buildTransformPipelineProfile({
    pipelineProfileId: 'lab-json-without-policy/1',
    roleLogicalPaths: Object.fromEntries(Object.entries(LAB_PIPELINE_ROLE_LOGICAL_PATHS['lab-json-daily/1'])
      .filter(([role]) => role !== 'CORPORATE_ACTION_POLICY')),
    transformManifest: manifest,
  });
  assert.deepEqual(transformManifestCoverageProblems({ transformManifest: manifest, pipelineProfile: withoutPolicy }), []);
  const problems = transformManifestCoverageProblems({
    transformManifest: manifest,
    pipelineProfile: withoutPolicy,
    requiredRoles: [...TRANSFORM_PIPELINE_BASE_ROLES, 'CORPORATE_ACTION_POLICY'],
  });
  assert.deepEqual(problems.map((problem) => problem.code), ['TRANSFORM_PIPELINE_ROLE_MISSING']);
  const withPolicy = syntheticPipelineProfile();
  assert.deepEqual(transformManifestCoverageProblems({
    transformManifest: manifest,
    pipelineProfile: withPolicy,
    requiredRoles: [...TRANSFORM_PIPELINE_BASE_ROLES, 'CORPORATE_ACTION_POLICY'],
  }), []);
});

test('TP8 — extra manifest modules beyond the profile are allowed', () => {
  const manifest = syntheticTransformManifest();
  const extended = {
    ...manifest,
    modules: [...manifest.modules, { logicalPath: 'src/synthetic/extraHelper.mjs', canonicalContentSha256: `sha256:${'6'.repeat(64)}` }],
  };
  assert.deepEqual(transformManifestCoverageProblems({ transformManifest: extended, pipelineProfile: syntheticPipelineProfile() }), []);
});

test('TP9 — building a profile against a manifest missing the module is an explicit error', () => {
  const manifest = syntheticTransformManifest();
  assert.throws(() => buildTransformPipelineProfile({
    pipelineProfileId: 'lab-json-daily/1',
    roleLogicalPaths: { ...LAB_PIPELINE_ROLE_LOGICAL_PATHS['lab-json-daily/1'], SOURCE_ADAPTER: ['src/synthetic/notCovered.mjs'] },
    transformManifest: manifest,
  }), code('TRANSFORM_PIPELINE_MODULE_MISSING'));
});

test('TP10 — the real lab pipelines are declarable and fully covered', () => {
  for (const pipelineProfileId of ['lab-json-daily/1', 'lab-csv-daily/1']) {
    const transformManifest = buildTransformImplementationManifestV2({
      labRoot: LAB_ROOT,
      logicalPaths: labPipelineLogicalPaths(pipelineProfileId),
      runtimeContractVersion: 'lab-runtime/2',
    });
    const profile = buildLabTransformPipelineProfile({ pipelineProfileId, transformManifest });
    assert.equal(profile.schemaVersion, TRANSFORM_PIPELINE_PROFILE_SCHEMA_VERSION);
    assert.deepEqual(transformManifestCoverageProblems({
      transformManifest,
      pipelineProfile: profile,
      requiredRoles: [...TRANSFORM_PIPELINE_BASE_ROLES, 'CORPORATE_ACTION_POLICY'],
    }), []);
  }
});
