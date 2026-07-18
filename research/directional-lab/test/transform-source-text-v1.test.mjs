import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION,
  TRANSFORM_SOURCE_TEXT_POLICY_VERSION,
  buildTransformImplementationManifestV2,
  normalizeTransformSourceTextV1,
  transformImplementationManifestHash,
  transformSourceTextSha256,
} from '../src/data/transformImplementationManifestV2.mjs';
import { code } from './l2aSyntheticPipeline.mjs';

function withLab(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-transform-v2-'));
  mkdirSync(join(root, 'src'));
  try { return fn(root, join(root, 'src', 'module.mjs')); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('TIMV2-1 — LF, CRLF and isolated CR produce the same source hash', () => {
  const lf = Buffer.from('export const value = 1;\nconst next = 2;\n');
  const crlf = Buffer.from('export const value = 1;\r\nconst next = 2;\r\n');
  const cr = Buffer.from('export const value = 1;\rconst next = 2;\r');
  assert.equal(transformSourceTextSha256(lf), transformSourceTextSha256(crlf));
  assert.equal(transformSourceTextSha256(lf), transformSourceTextSha256(cr));
  assert.deepEqual(normalizeTransformSourceTextV1(crlf), lf);
});

test('TIMV2-2 — code, spaces and terminal LF remain significant', () => {
  const base = transformSourceTextSha256(Buffer.from('const x = 1;\n'));
  assert.notEqual(base, transformSourceTextSha256(Buffer.from('const x = 2;\n')));
  assert.notEqual(base, transformSourceTextSha256(Buffer.from('const  x = 1;\n')));
  assert.notEqual(base, transformSourceTextSha256(Buffer.from('const x = 1;')));
});

test('TIMV2-3 — BOM, invalid UTF-8 and surrogate encodings are refused', () => {
  assert.throws(() => transformSourceTextSha256(Buffer.from([0xef, 0xbb, 0xbf, 0x61])),
    code('TRANSFORM_SOURCE_TEXT_BOM_FORBIDDEN'));
  assert.throws(() => transformSourceTextSha256(Buffer.from([0xc3, 0x28])),
    code('TRANSFORM_SOURCE_TEXT_UTF8_INVALID'));
  assert.throws(() => transformSourceTextSha256(Buffer.from([0xed, 0xa0, 0x80])),
    code('TRANSFORM_SOURCE_TEXT_UTF8_INVALID'));
});

test('TIMV2-4 — V2 manifest identity is invariant to working-tree line endings', () => withLab((root, modulePath) => {
  writeFileSync(modulePath, 'export const value = 1;\n');
  const lf = buildTransformImplementationManifestV2({
    labRoot: root, logicalPaths: ['src/module.mjs'], runtimeContractVersion: 'runtime/1',
  });
  writeFileSync(modulePath, 'export const value = 1;\r\n');
  const crlf = buildTransformImplementationManifestV2({
    labRoot: root, logicalPaths: ['src/module.mjs'], runtimeContractVersion: 'runtime/1',
  });
  assert.deepEqual(lf, crlf);
  assert.equal(transformImplementationManifestHash(lf), transformImplementationManifestHash(crlf));
  assert.equal(lf.schemaVersion, TRANSFORM_IMPLEMENTATION_MANIFEST_V2_SCHEMA_VERSION);
  assert.equal(lf.moduleHashPolicyVersion, TRANSFORM_SOURCE_TEXT_POLICY_VERSION);
  assert.match(lf.modules[0].canonicalContentSha256, /^sha256:[0-9a-f]{64}$/);
}));
