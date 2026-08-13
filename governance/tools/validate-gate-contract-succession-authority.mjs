import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWheelGateContractSuccessionAuthoritySource } from '../gee-v1/adapters/wheel/gate-contract-succession-authority-source.mjs';

function option(name, fallback = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; }
const root = path.resolve(option('--root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')));
const candidateRoot = path.resolve(option('--candidate-root', root));
const gateId = option('--gate-id', null);
const requestPath = option('--request', null);
const recordPath = option('--record', null);
const authorityPath = option('--authority', null);
const report = gateId && requestPath && authorityPath
  ? createWheelGateContractSuccessionAuthoritySource(root, { candidateRoot, requestPath, recordPath, authorityPath }).resolveWorkUnitAuthority(gateId)
  : { decision: 'BLOCKED', successionAuthorized: false, authorizedPaths: [], findings: [{ code: 'REQUIRED_OPTIONS_MISSING' }] };
process.stdout.write(JSON.stringify({ GATE_CONTRACT_SUCCESSION_VERDICT: report.successionAuthorized ? 'AUTHORIZED' : 'BLOCKED', ...report }, null, 2) + '\n');
process.exitCode = report.successionAuthorized ? 0 : 2;
