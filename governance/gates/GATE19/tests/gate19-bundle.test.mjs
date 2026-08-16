import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle, readZipEntries, pathChecks, verifyExisting } from '../implementation/build-foundation-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ARCHIVE = path.join(ROOT, 'governance/gates/GATE19/evidence/FOUNDATION_BUNDLE_20260815T120000Z.zip');

test('G19-POS-01 bounded bundle passes self-verification', () => {
  buildBundle();
  assert.equal(verifyExisting(), true);
  const entries = readZipEntries(fs.readFileSync(ARCHIVE));
  assert.equal(entries.length, 6);
  assert.equal(pathChecks(entries.map((entry) => entry.name), 'foundation/').OUTSIDE_PACKAGE_PREFIX, 0);
});

test('G19-POS-02 repeat build is byte-identical', () => {
  buildBundle(); const first = fs.readFileSync(ARCHIVE); buildBundle(); const second = fs.readFileSync(ARCHIVE);
  assert.deepEqual(second, first);
});

test('G19-NEG-01 outside prefix and unsafe paths are rejected', () => {
  const checks = pathChecks(['foundation/ok.txt', 'outside.txt', 'foundation/../escape.txt', 'foundation\\bad.txt'], 'foundation/');
  assert.equal(checks.OUTSIDE_PACKAGE_PREFIX, 2);
  assert.equal(checks.UNSAFE_PATHS, 1);
  assert.equal(checks.BACKSLASH_ENTRIES, 1);
});

test('G19-NEG-02 duplicate entries are rejected', () => {
  assert.equal(pathChecks(['foundation/a', 'foundation/a'], 'foundation/').DUPLICATE_ENTRIES, 1);
});
