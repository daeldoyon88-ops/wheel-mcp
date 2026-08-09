#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { validateStrategicContract } from '../contracts/validate-strategic-contract.mjs';
import { validateExecutionContract } from '../contracts/validate-execution-contract.mjs';
import { detectSealedMutation } from '../contracts/detect-sealed-mutation.mjs';

function option(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const strategicPath = option('--strategic', null);
const executionPath = option('--execution', null);
const sealPath = option('--seal', null);
const known = option('--known-verdicts', null);
const knownVerdicts = known ? new Set(known.split(',').map((s) => s.trim()).filter(Boolean)) : null;

const report = { strategic: null, execution: null, mutation: null };

if (strategicPath) {
  report.strategic = validateStrategicContract(readJson(path.resolve(strategicPath)));
}
if (executionPath) {
  report.execution = validateExecutionContract(readJson(path.resolve(executionPath)), { knownVerdicts });
}
if (sealPath && executionPath) {
  report.mutation = detectSealedMutation(readJson(path.resolve(executionPath)), readJson(path.resolve(sealPath)));
}

const ok = (!report.strategic || report.strategic.valid)
  && (!report.execution || report.execution.valid)
  && (!report.mutation || report.mutation.status === 'INTACT');

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(ok ? 0 : 2);
