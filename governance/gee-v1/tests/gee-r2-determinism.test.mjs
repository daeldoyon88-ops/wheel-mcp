import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGeeR2SyntheticAdapter } from '../fixtures/gee-r2-synthetic-adapter.mjs';
import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { compileContext } from '../context/compile-context.mjs';

test('R2-H01/H02 repeated real compilation is byte-identical and source mutation changes digest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gee-r2-mutation-'));
  fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
  const source = path.join(root, 'fixtures', 'canonical.json');
  fs.writeFileSync(source, JSON.stringify({ objective: 'Synthetic objective', revision: 1 }));
  const args = { repoRoot: root, adapter: createGeeR2SyntheticAdapter(), workUnitId: 'SYNTH_01', sourceHead: 'HEAD_TEST' };
  const first = compileContext(args); const second = compileContext(args);
  const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value.json)).digest('hex');
  assert.equal(digest(first), digest(second));
  fs.writeFileSync(source, JSON.stringify({ objective: 'Synthetic objective', revision: 2 }));
  const mutated = compileContext(args);
  assert.notEqual(digest(first), digest(mutated));
  assert.notEqual(first.json.relevantSources[0].sha256, mutated.json.relevantSources[0].sha256);
});

test('R2-H03/H04 compiler output cannot satisfy a prerequisite or write R1', () => {
  const result = compileContext({ repoRoot: process.cwd(), adapter: createWheelContextAdapter(process.cwd()), workUnitId: 'GATE13', sourceHead: '9d9054a71faa43872416fb3616daf54cca9b1cd1' });
  assert.equal(result.json.activeState.prerequisites.find((p) => p.id === 'GATE12')?.critical, true);
  assert.equal(result.json.relevantSources.some((s) => s.path.includes('contracts/EXECUTION_CONTRACT_R0001')), true);
  assert.equal(result.json.relevantSources.some((s) => s.path.includes('GEE_V1_EXECUTION_CONTRACT_R0002')), false);
});
