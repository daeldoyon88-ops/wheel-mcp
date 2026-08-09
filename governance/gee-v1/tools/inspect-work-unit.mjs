#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { createProjectSession } from '../core/work-unit-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '../../..');

function option(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

const repoRoot = path.resolve(option('--root', defaultRoot));
const workUnitId = option('--work-unit', null);
const adapter = createWheelProjectAdapter(repoRoot);
const session = createProjectSession(adapter);

if (!workUnitId) {
  const report = {
    projectId: session.projectId,
    workUnitType: session.workUnitType,
    workUnitIds: session.listWorkUnitIds(),
    count: session.listWorkUnitIds().length
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const view = session.getWorkUnit(workUnitId);
process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
