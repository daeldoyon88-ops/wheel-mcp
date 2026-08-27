import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  materializeJarviseEmptyMacroContextR1,
} from '../../scripts/materializeJarviseEmptyMacroContextR1.mjs';
import {
  EMPTY_MACRO_VINTAGE_STORE,
  JarviseEmptyMacroContextAuthorityError,
  produceJarviseEmptyMacroContextR1,
} from './jarviseEmptyMacroContextProducerR1.mjs';
import {
  MACRO_CORE_V1_BASE_SERIES,
  MACRO_CORE_V1_CURVE_FEATURE_CODES,
  MACRO_CORE_V1_DERIVED_FEATURES,
  MACRO_OPTIONAL_V1_MEMBERS,
  createMacroContextBinding,
} from '../../governance/gates/GATE24/implementation/macro-context-binding-v1.mjs';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '../..');
const PRODUCTION_DATA_ROOT = resolve(REPOSITORY_ROOT, 'data/jarvise/macro-context');
const PRODUCER_PATH = resolve(import.meta.dirname, 'jarviseEmptyMacroContextProducerR1.mjs');
const VALID_KNOWLEDGE_CUTOFF = '2026-01-02T21:00:00.000Z';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function regularFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...regularFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function inventory(root) {
  return Object.fromEntries(regularFiles(root).map((path) => {
    const bytes = readFileSync(path);
    return [relative(root, path).replaceAll('\\', '/'), `${bytes.length}:${sha256(bytes)}`];
  }));
}

function withTemporaryRoot(prefix, fn) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function authorityRefusal(error) {
  return error instanceof JarviseEmptyMacroContextAuthorityError
    && error.code === 'G24_EMPTY_MACRO_CONTEXT_AUTHORITY_REFUSED';
}

test('production materialization is exactly five verified empty CAS objects and is byte-stable', () => {
  const before = inventory(PRODUCTION_DATA_ROOT);
  const result = materializeJarviseEmptyMacroContextR1();
  const after = inventory(PRODUCTION_DATA_ROOT);
  assert.deepEqual(after, before);
  assert.equal(result.authoritativeObjectCount, 5);
  assert.equal(result.newAuthoritativeObjectCount, 0);
  assert.equal(result.changedAuthoritativeIds, 0);
  assert.equal(result.changedAuthoritativeBytes, 0);
  assert.equal(result.duplicateAuthorities, 0);
  assert.deepEqual(result.authoritativeSchemas, [
    'MacroIngestionPolicy/1',
    'MacroAsOfResolutionPolicy/1',
    'MacroSeriesRegistryManifest/1',
    'MacroVintageSetManifest/1',
    'MacroDatasetSnapshotManifest/1',
  ]);
  assert.ok(result.artifacts.every((artifact) => artifact.verified === true));
  assert.deepEqual(result.emptyState, {
    seriesCount: 0,
    observationCount: 0,
    vintageCount: 0,
    firstAvailableAt: null,
    lastAvailableAt: null,
    emptySnapshot: true,
  });
  assert.equal(regularFiles(join(PRODUCTION_DATA_ROOT, 'cas')).length, 5);
  const projection = JSON.parse(readFileSync(join(PRODUCTION_DATA_ROOT, 'binding-projection.json'), 'utf8'));
  const provenance = JSON.parse(readFileSync(join(PRODUCTION_DATA_ROOT, 'PROVENANCE.json'), 'utf8'));
  assert.equal(projection.authoritative, false);
  assert.equal(provenance.authoritative, false);
  assert.equal(projection.availableAtPolicyId, result.ids.macroAsOfResolutionPolicyId);
  assert.equal(projection.macroVintageSetManifestId, result.ids.macroVintageSetManifestId);
  assert.equal(projection.macroDatasetSnapshotManifestId, result.ids.macroDatasetSnapshotManifestId);
});

test('runtime verifies persisted authority, uses canonical defaults, and derives zero-series missingness', () => {
  const before = inventory(PRODUCTION_DATA_ROOT);
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error('NETWORK_FORBIDDEN'); };
  let produced;
  try {
    produced = produceJarviseEmptyMacroContextR1({ knowledgeCutoff: VALID_KNOWLEDGE_CUTOFF });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(inventory(PRODUCTION_DATA_ROOT), before);
  assert.equal(networkCalls, 0);
  assert.equal(Object.keys(produced.vintageStore).length, 0);
  assert.equal(produced.vintageStore, EMPTY_MACRO_VINTAGE_STORE);
  assert.equal(Object.isFrozen(produced.vintageStore), true);
  assert.deepEqual(produced.macroContextBinding.coreSeriesCodes, [...MACRO_CORE_V1_BASE_SERIES].sort());
  assert.deepEqual(produced.macroContextBinding.derivedFeatureCodes, [...MACRO_CORE_V1_DERIVED_FEATURES].sort());
  assert.deepEqual(produced.macroContextBinding.curveFeatureCodes, [...MACRO_CORE_V1_CURVE_FEATURE_CODES].sort());
  assert.deepEqual(produced.macroContextBinding.optionalSeriesCodes, MACRO_OPTIONAL_V1_MEMBERS);
  const reconstructed = createMacroContextBinding({
    macroVintageSetManifestId: produced.macroContextBinding.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: produced.macroContextBinding.macroDatasetSnapshotManifestId,
    availableAtPolicyId: produced.macroContextBinding.availableAtPolicyId,
  });
  assert.deepEqual(produced.macroContextBinding, reconstructed);
  assert.equal(produced.macroSnapshotResolution.status, 'UNAVAILABLE');
  assert.equal(produced.macroSnapshotResolution.snapshot.macroFeatureCompleteness, 'UNAVAILABLE');
  assert.deepEqual(
    produced.macroSnapshotResolution.snapshot.absentSeriesCodes,
    [...MACRO_CORE_V1_BASE_SERIES].sort(),
  );
  assert.equal(produced.macroSnapshotResolution.snapshot.networkCalls, 0);
  assert.equal(produced.macroSnapshotResolution.snapshot.fetches, 0);
});

test('missing K(T), optional promotion, arbitrary IDs, and fixture IDs fail closed', () => {
  const missing = produceJarviseEmptyMacroContextR1();
  assert.equal(missing.macroSnapshotResolution.status, 'FAIL_CLOSED');
  assert.equal(missing.macroSnapshotResolution.code, 'KNOWLEDGE_CUTOFF_REQUIRED');
  assert.throws(() => createMacroContextBinding({
    macroVintageSetManifestId: 'a',
    macroDatasetSnapshotManifestId: 'b',
    availableAtPolicyId: 'c',
    optionalSeriesCodes: ['US.BLS.ICSA'],
  }), /SILENT_TIER_PROMOTION_FORBIDDEN/);

  withTemporaryRoot('jarvise-empty-macro-refusal-', (root) => {
    cpSync(PRODUCTION_DATA_ROOT, root, { recursive: true });
    const projectionPath = join(root, 'binding-projection.json');
    const projection = JSON.parse(readFileSync(projectionPath, 'utf8'));
    projection.macroVintageSetManifestId = `sha256:${'aa'.repeat(32)}`;
    writeFileSync(projectionPath, JSON.stringify(projection));
    assert.throws(
      () => produceJarviseEmptyMacroContextR1({ knowledgeCutoff: VALID_KNOWLEDGE_CUTOFF, dataRoot: root }),
      authorityRefusal,
    );
    projection.macroVintageSetManifestId = `sha256:${'d3'.repeat(32)}`;
    writeFileSync(projectionPath, JSON.stringify(projection));
    assert.throws(
      () => produceJarviseEmptyMacroContextR1({ knowledgeCutoff: VALID_KNOWLEDGE_CUTOFF, dataRoot: root }),
      authorityRefusal,
    );
  });
});

test('isolated materialization rerun preserves IDs and bytes, while hostile CAS mutation is refused', () => {
  withTemporaryRoot('jarvise-empty-macro-idempotence-', (root) => {
    const first = materializeJarviseEmptyMacroContextR1({ outputRoot: root, testOnlyAllowOutputRoot: true });
    const firstBytes = inventory(root);
    const second = materializeJarviseEmptyMacroContextR1({ outputRoot: root, testOnlyAllowOutputRoot: true });
    assert.deepEqual(second.ids, first.ids);
    assert.deepEqual(inventory(root), firstBytes);
    assert.equal(first.newAuthoritativeObjectCount, 5);
    assert.equal(second.newAuthoritativeObjectCount, 0);
    assert.equal(second.changedAuthoritativeIds, 0);
    assert.equal(second.changedAuthoritativeBytes, 0);

    const target = regularFiles(join(root, 'cas'))[0];
    const original = readFileSync(target);
    writeFileSync(target, Buffer.concat([original, Buffer.from(' ')]));
    assert.notEqual(sha256(readFileSync(target)), sha256(original));
    assert.throws(
      () => produceJarviseEmptyMacroContextR1({ knowledgeCutoff: VALID_KNOWLEDGE_CUTOFF, dataRoot: root }),
      authorityRefusal,
    );
  });
});

test('producer source contains no business-result hardcoding or runtime I/O surface', () => {
  const source = readFileSync(PRODUCER_PATH, 'utf8');
  assert.equal(source.includes('classificationQuality'), false);
  assert.equal(source.includes("'UNAVAILABLE'"), false);
  assert.equal(/\b(?:writeFile|appendFile|mkdir|rm|unlink|rename|fetch)Sync?\b/.test(source), false);
  assert.equal(/Yahoo|IBKR/i.test(source), false);
});
