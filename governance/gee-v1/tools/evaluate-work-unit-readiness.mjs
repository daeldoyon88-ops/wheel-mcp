#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateReadiness } from '../readiness/evaluate-readiness.mjs';
import { buildReadinessContext } from '../readiness/build-readiness-context.mjs';
import { createWheelProjectAdapter } from '../adapters/wheel/wheel-project-adapter.mjs';
import { sealExecutionContract } from '../contracts/seal-execution-contract.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(__dirname, '../../..');

function option(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const repoRoot = path.resolve(option('--root', defaultRoot));
const workUnitId = option('--work-unit', null);

let result;

if (workUnitId) {
  // RC-4/CT-E repair: a real work unit has exactly one path — buildReadinessContext. There is no
  // activationState / requireActivationAnchor / authorityState flag here for a caller to forget;
  // every critical proof is derived from canonical ledger + seal + defects state.
  const adapter = createWheelProjectAdapter(repoRoot);
  const preflightOk = process.argv.includes('--preflight-ok')
    ? true
    : (process.argv.includes('--preflight-explicit-false') ? false : undefined);
  const context = buildReadinessContext({ adapter, workUnitId, preflightOk });
  result = evaluateReadiness(context);
} else {
  // Fixture/legacy path: no real work unit to derive canonical state from, so the caller supplies
  // contracts directly. Used by tests exercising evaluateReadiness's check bodies in isolation.
  const strategicPath = option('--strategic', null);
  const executionPath = option('--execution', null);
  const sealPath = option('--seal', null);
  const requireSeal = !process.argv.includes('--no-require-seal');

  const strategicContract = strategicPath ? readJson(path.resolve(strategicPath)) : null;
  const executionContract = executionPath ? readJson(path.resolve(executionPath)) : null;
  let executionSeal = sealPath ? readJson(path.resolve(sealPath)) : null;
  if (!executionSeal && executionContract && process.argv.includes('--seal-now')) {
    executionSeal = sealExecutionContract(executionContract).seal;
  }

  const authorityState = process.argv.includes('--authority-ok')
    ? { consistent: true, source: 'caller-explicit-authority-ok' }
    : { consistent: false, reason: 'caller contracts without explicit --authority-ok' };
  const preflightOk = process.argv.includes('--preflight-ok') ? true : undefined;

  const readinessInput = {
    workUnitId: executionContract?.id || strategicContract?.id || 'UNKNOWN',
    strategicContract,
    executionContract,
    executionSeal,
    prerequisiteStatuses: {},
    requireSeal,
    authorityState
  };
  if (preflightOk === true) readinessInput.preflightOk = true;

  result = evaluateReadiness(readinessInput);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.verdict === 'READY' ? 0 : 2);
