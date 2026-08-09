#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWheelContextAdapter } from '../adapters/wheel/context-wheel-adapter.mjs';
import { compileContext } from '../context/compile-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const repoRoot = arg('--root', root);
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const result = compileContext({ repoRoot, adapter: createWheelContextAdapter(repoRoot), workUnitId: arg('--work-unit', 'GATE13'), mission: { id: arg('--mission', null) }, sourceHead });
if (process.argv.includes('--markdown')) process.stdout.write(result.markdown);
else process.stdout.write(`${JSON.stringify({ ...result.json, efficiency: result.metrics }, null, 2)}\n`);
