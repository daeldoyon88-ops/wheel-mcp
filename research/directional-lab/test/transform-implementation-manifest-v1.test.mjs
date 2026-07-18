import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
  buildTransformImplementationManifest,
  normalizeTransformImplementationManifestV1,
  transformImplementationHash,
  transformImplementationManifestProblems,
} from '../src/data/transformImplementationManifestV1.mjs';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function code(expected) {
  return (error) => error && error.code === expected;
}

function withLab(fn) {
  const root = mkdtempSync(join(tmpdir(), 'directional-lab-transform-'));
  mkdirSync(join(root, 'src'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('TIM1 — module entries are sorted by portable logical path', () => {
  const normalized = normalizeTransformImplementationManifestV1({
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules: [
      { logicalPath: 'src/z.mjs', contentSha256: HASH_B },
      { logicalPath: 'src/a.mjs', contentSha256: HASH_A },
    ],
    runtimeContractVersion: 'node-esm/1',
  });
  assert.deepEqual(normalized.modules.map((module) => module.logicalPath), ['src/a.mjs', 'src/z.mjs']);
});

test('TIM2 — absolute, traversal, backslash and duplicate logical paths are refused', () => {
  for (const logicalPath of ['/abs.mjs', '../escape.mjs', 'src\\win.mjs', 'C:/drive.mjs', 'src//empty.mjs']) {
    const problems = transformImplementationManifestProblems({
      schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
      modules: [{ logicalPath, contentSha256: HASH_A }], runtimeContractVersion: 'node-esm/1',
    });
    assert.ok(problems.some((problem) => problem.includes('logicalPath')));
  }
  assert.throws(() => normalizeTransformImplementationManifestV1({
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules: [
      { logicalPath: 'src/a.mjs', contentSha256: HASH_A },
      { logicalPath: 'src/a.mjs', contentSha256: HASH_B },
    ], runtimeContractVersion: 'node-esm/1',
  }), code('SNAPSHOT_TRANSFORM_MANIFEST_INVALID'));
});

test('TIM3 — unknown manifest fields are refused', () => {
  assert.throws(() => normalizeTransformImplementationManifestV1({
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules: [{ logicalPath: 'src/a.mjs', contentSha256: HASH_A }],
    runtimeContractVersion: 'node-esm/1', mtime: 123,
  }), code('CANONICAL_UNKNOWN_FIELD'));
});

test('TIM4 — exact module bytes determine contentSha256 without mtime or absolute path', () => withLab((root) => {
  writeFileSync(join(root, 'src', 'adapter.mjs'), 'export const value = 1;\r\n');
  const manifest = buildTransformImplementationManifest({
    labRoot: root, logicalPaths: ['src/adapter.mjs'], runtimeContractVersion: 'node-esm/1',
  });
  assert.equal(manifest.modules[0].logicalPath, 'src/adapter.mjs');
  assert.match(manifest.modules[0].contentSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(manifest).includes(root), false);
  assert.equal(Object.hasOwn(manifest.modules[0], 'mtime'), false);
}));

test('TIM5 — changing covered code changes transformImplementationHash', () => withLab((root) => {
  const modulePath = join(root, 'src', 'normalizer.mjs');
  writeFileSync(modulePath, 'export const version = 1;\n');
  const first = buildTransformImplementationManifest({ labRoot: root, logicalPaths: ['src/normalizer.mjs'], runtimeContractVersion: 'node-esm/1' });
  writeFileSync(modulePath, 'export const version = 2;\n');
  const second = buildTransformImplementationManifest({ labRoot: root, logicalPaths: ['src/normalizer.mjs'], runtimeContractVersion: 'node-esm/1' });
  assert.notEqual(first.modules[0].contentSha256, second.modules[0].contentSha256);
  assert.notEqual(transformImplementationHash(first), transformImplementationHash(second));
}));

test('TIM6 — input module order does not change manifest or hash', () => withLab((root) => {
  writeFileSync(join(root, 'src', 'a.mjs'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.mjs'), 'export const b = 2;\n');
  const first = buildTransformImplementationManifest({ labRoot: root, logicalPaths: ['src/b.mjs', 'src/a.mjs'], runtimeContractVersion: 'node-esm/1' });
  const second = buildTransformImplementationManifest({ labRoot: root, logicalPaths: ['src/a.mjs', 'src/b.mjs'], runtimeContractVersion: 'node-esm/1' });
  assert.deepEqual(first, second);
  assert.equal(transformImplementationHash(first), transformImplementationHash(second));
}));

test('TIM7 — runtime contract version is part of the implementation hash', () => {
  const base = {
    schemaVersion: TRANSFORM_IMPLEMENTATION_MANIFEST_SCHEMA_VERSION,
    modules: [{ logicalPath: 'src/a.mjs', contentSha256: HASH_A }],
  };
  assert.notEqual(
    transformImplementationHash({ ...base, runtimeContractVersion: 'node-esm/1' }),
    transformImplementationHash({ ...base, runtimeContractVersion: 'node-esm/2' }),
  );
});

test('TIM8 — a missing covered module keeps the stable manifest error code', () => withLab((root) => {
  assert.throws(() => buildTransformImplementationManifest({
    labRoot: root, logicalPaths: ['src/missing.mjs'], runtimeContractVersion: 'node-esm/1',
  }), code('SNAPSHOT_TRANSFORM_MANIFEST_INVALID'));
}));
