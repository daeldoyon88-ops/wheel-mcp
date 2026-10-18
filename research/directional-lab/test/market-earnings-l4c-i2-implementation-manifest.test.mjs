/**
 * L4C-I2 TransformImplementationManifest/2 reuse.
 *
 * No new manifest schema is introduced: the L4C-I2 profile is the runtime
 * contract NODE_L4C_I2_V1 over the ten declared I2 module paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  buildTransformImplementationManifestV2,
  transformSourceTextSha256,
} from '../src/data/transformImplementationManifestV2.mjs';
import { SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS } from '../src/canonical/canonicalSchemaRegistryV1.mjs';
import { EARNINGS_I2_RUNTIME_CONTRACT_VERSION } from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import { pinEarningsTransformImplementationManifestV2 } from './earningsIngestionL4CISyntheticFixture.mjs';
import {
  L4C_I2_RUNTIME_CONTRACT_VERSION,
  L4C_I2_TRANSFORM_LOGICAL_PATHS,
  bindL4CI2Dataset,
  code,
  l4cI2LabRoot,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const readManifest = (ctx, objectId) => ctx.store.readCanonicalObject({
  uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
  expectedObjectId: objectId,
  schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
}).value;

test('I2-I001 the L4C-I2 transform manifest pins exactly the declared I2 modules', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const manifest = readManifest(ctx, ctx.transformImplementationManifestId);
    // The manifest stores its modules in canonical (sorted) logicalPath order.
    assert.deepEqual(manifest.modules.map((module) => module.logicalPath),
      [...L4C_I2_TRANSFORM_LOGICAL_PATHS].sort());
    assert.equal(manifest.modules.length, 10);
    for (const module of manifest.modules) {
      assert.match(module.logicalPath, /^src\/(contracts|earnings)\/[A-Za-z]+L4CIIV1\.mjs$/);
    }
  });
});

test('I2-I002 the L4C-I2 transform manifest id differs from the L4C-I1 manifest id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const l4cI1 = pinEarningsTransformImplementationManifestV2(ctx.store);
    assert.notEqual(ctx.transformImplementationManifestId,
      l4cI1.transformImplementationManifestId);
  });
});

test('I2-I003 the L4C-I1 manifest id is unchanged by L4C-I2', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = pinEarningsTransformImplementationManifestV2(ctx.store);
    bindL4CI2Dataset(ctx.store, ctx);
    const second = pinEarningsTransformImplementationManifestV2(ctx.store);
    assert.equal(second.transformImplementationManifestId,
      first.transformImplementationManifestId);
  });
});

test('I2-I004 a report built with the L4C-I1 manifest is rejected', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const l4cI1 = pinEarningsTransformImplementationManifestV2(ctx.store);
    assert.throws(() => bindL4CI2Dataset(ctx.store, {
      ...ctx, transformImplementationManifestId: l4cI1.transformImplementationManifestId,
    }), code('EARNINGS_TRANSFORM_IMPLEMENTATION_ID_MISMATCH'));
  });
});

test('I2-I005 runtimeContractVersion is NODE_L4C_I2_V1', () => {
  assert.equal(L4C_I2_RUNTIME_CONTRACT_VERSION, 'NODE_L4C_I2_V1');
  assert.equal(EARNINGS_I2_RUNTIME_CONTRACT_VERSION, 'NODE_L4C_I2_V1');
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.equal(readManifest(ctx, ctx.transformImplementationManifestId).runtimeContractVersion,
      'NODE_L4C_I2_V1');
  });
});

test('I2-I006 editing an I2 module changes the manifest id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    // Real TransformSourceText/1 mutation outside the repository: copy the ten
    // modules into a temporary labRoot, flip one unambiguous source byte, then
    // rebuild. Dropping a path with slice(0, 9) does not mutate module bytes.
    const repoLabRoot = l4cI2LabRoot();
    const baseline = buildTransformImplementationManifestV2({
      labRoot: repoLabRoot,
      logicalPaths: [...L4C_I2_TRANSFORM_LOGICAL_PATHS],
      runtimeContractVersion: L4C_I2_RUNTIME_CONTRACT_VERSION,
    });
    const baselineId = ctx.store.putCanonicalObject({
      namespace: 'snapshots',
      schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
      value: baseline,
    }).objectId;
    assert.equal(baselineId, ctx.transformImplementationManifestId);

    const tempRoot = mkdtempSync(join(tmpdir(), 'l4c-i2-i006-'));
    try {
      for (const logicalPath of L4C_I2_TRANSFORM_LOGICAL_PATHS) {
        const from = join(repoLabRoot, ...logicalPath.split('/'));
        const to = join(tempRoot, ...logicalPath.split('/'));
        mkdirSync(dirname(to), { recursive: true });
        cpSync(from, to);
      }
      const targetLogical = L4C_I2_TRANSFORM_LOGICAL_PATHS[0];
      const targetPath = join(tempRoot, ...targetLogical.split('/'));
      const beforeBytes = readFileSync(targetPath);
      const beforeHash = transformSourceTextSha256(beforeBytes);
      const mutated = Buffer.from(beforeBytes);
      const flipAt = Math.max(0, mutated.length - 1);
      mutated[flipAt] = mutated[flipAt] ^ 0x01;
      writeFileSync(targetPath, mutated);
      const afterHash = transformSourceTextSha256(mutated);
      assert.notEqual(afterHash, beforeHash);

      const mutatedManifest = buildTransformImplementationManifestV2({
        labRoot: tempRoot,
        logicalPaths: [...L4C_I2_TRANSFORM_LOGICAL_PATHS],
        runtimeContractVersion: L4C_I2_RUNTIME_CONTRACT_VERSION,
      });
      assert.equal(mutatedManifest.modules.length, baseline.modules.length);
      const mutatedModule = mutatedManifest.modules
        .find((module) => module.logicalPath === targetLogical);
      assert.equal(mutatedModule.canonicalContentSha256, afterHash);
      const mutatedId = ctx.store.putCanonicalObject({
        namespace: 'snapshots',
        schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
        value: mutatedManifest,
      }).objectId;
      assert.notEqual(mutatedId, baselineId);

      // Repository module bytes must be unchanged by the temp-lab mutation.
      const repoBytes = readFileSync(join(repoLabRoot, ...targetLogical.split('/')));
      assert.equal(createHash('sha256').update(repoBytes).digest('hex'),
        createHash('sha256').update(beforeBytes).digest('hex'));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('I2-I007 no EarningsParserImplementationManifest schema is introduced', () => {
  assert.equal(
    SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.includes('EarningsParserImplementationManifest/1'), false);
  assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS
    .some((schemaVersion) => schemaVersion.startsWith('EarningsParserImplementationManifest')),
  false);
});

test('I2-I008 the manifest is reused without a new schema version', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const manifest = readManifest(ctx, ctx.transformImplementationManifestId);
    assert.equal(manifest.schemaVersion, TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION);
    assert.equal(manifest.schemaVersion, 'TransformImplementationManifest/2');
    assert.equal(SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS
      .filter((schemaVersion) => schemaVersion === 'TransformImplementationManifest/2').length, 1);
  });
});
