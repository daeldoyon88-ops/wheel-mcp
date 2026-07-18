import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { findForbiddenMemoryMarkers } from './memoryScan.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const LAB_ROOT = resolve(TEST_DIR, '..');
const REPO_ROOT = resolve(LAB_ROOT, '..', '..');

/** Recursively list files under dir, skipping heavy/irrelevant folders. */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'backups'].includes(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const labSourceFiles = walk(join(LAB_ROOT, 'src')).filter((f) => f.endsWith('.mjs'));

test('lab imports only node: builtins and lab-internal relative modules', () => {
  const importRe = /(?:import\s[^'"]*?|from|import\()\s*['"]([^'"]+)['"]/g;
  const allowedBuiltins = new Set(['node:fs', 'node:path', 'node:crypto', 'node:url', 'node:os', 'node:util', 'node:test', 'node:assert', 'node:assert/strict']);
  assert.ok(labSourceFiles.length > 30, `expected the lab source tree, found ${labSourceFiles.length} files`);
  for (const file of labSourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const spec = m[1];
      if (spec.startsWith('node:')) {
        assert.ok(allowedBuiltins.has(spec), `${file}: builtin ${spec} not in the allowlist`);
      } else {
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file}: bare import "${spec}" forbidden (no dependencies)`);
        const resolved = resolve(dirname(file), spec);
        const rel = relative(LAB_ROOT, resolved);
        assert.ok(!rel.startsWith('..'), `${file}: import "${spec}" escapes the lab directory`);
      }
    }
  }
});

test('lab never imports network/process modules and never calls fetch/IBKR/Yahoo endpoints', () => {
  const forbiddenModules = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'child_process', 'worker_threads', 'cluster'];
  const forbiddenPatterns = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket\s*\(/, /query1\.finance/i, /finance\.yahoo/i, /localhost:\d+/, /127\.0\.0\.1/];
  for (const file of labSourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const mod of forbiddenModules) {
      assert.ok(!new RegExp(`['"](?:node:)?${mod}['"]`).test(text), `${file}: forbidden module ${mod}`);
    }
    for (const re of forbiddenPatterns) {
      assert.ok(!re.test(text), `${file}: forbidden pattern ${re}`);
    }
  }
});

test('no production file references the lab', () => {
  const productionRoots = ['app', 'scripts', 'wheel-dashboard', 'python_ibkr'].map((d) => join(REPO_ROOT, d)).filter(existsSync);
  const productionFiles = productionRoots.flatMap((d) => walk(d))
    .filter((f) => /\.(m?js|cjs|jsx|ts|tsx|py|json)$/.test(f));
  const serverJs = join(REPO_ROOT, 'server.js');
  if (existsSync(serverJs)) productionFiles.push(serverJs);
  assert.ok(productionFiles.length > 0, 'expected production files to scan');
  for (const file of productionFiles) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('directional-lab'), `${file} references the research lab`);
  }
});

test('the lab does not import production modules (no ../../app, ../../scripts, server.js)', () => {
  for (const file of labSourceFiles) {
    const text = readFileSync(file, 'utf8');
    for (const marker of ['../../app', '../../scripts', '../../server', '../../wheel-dashboard', 'universe.master']) {
      assert.ok(!text.includes(marker), `${file}: references production path ${marker}`);
    }
  }
});

test('lab code never references external agent-memory or persistent paths outside the lab', () => {
  const labFiles = [
    ...labSourceFiles,
    ...walk(join(LAB_ROOT, 'test')).filter((f) => f.endsWith('.mjs')),
    ...walk(LAB_ROOT).filter((f) => f.endsWith('.md')),
  ];
  assert.ok(labFiles.length > 40, `expected the lab file tree, found ${labFiles.length} files`);
  for (const file of labFiles) {
    const text = readFileSync(file, 'utf8');
    const hits = findForbiddenMemoryMarkers(text);
    assert.deepEqual(hits, [], `${file}: forbidden external-memory reference(s) ${hits.join(', ')}`);
  }
});

test('package.json is untouched by the lab (no new dependencies)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  assert.ok(!Object.keys(allDeps).some((d) => d.includes('directional')), 'lab must not appear in dependencies');
  const text = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
  assert.ok(!text.includes('directional-lab'));
});
