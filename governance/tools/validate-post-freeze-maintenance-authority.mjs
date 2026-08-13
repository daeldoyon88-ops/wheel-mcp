#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  isExactMaintenancePath,
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  PHASE_VERIFY_PROGRAM_CONSUMPTION
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const authorityOption = option('--authority');
const phase = option('--phase', PHASE_AUTHORIZE_PROGRAM_APPLY);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^Ã¯Â»Â¿/, ''));
}

function resolveInsideRoot(relativePath) {
  if (!isExactMaintenancePath(relativePath)) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function findAuthority() {
  if (authorityOption) return path.resolve(authorityOption);
  const programId = option('--program-id');
  if (!programId) return null;
  const sources = path.join(root, 'governance', 'sources');
  const matches = fs.readdirSync(sources)
    .filter((entry) => /^GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_[A-Za-z0-9_-]+\.json$/.test(entry))
    .map((entry) => path.join(sources, entry))
    .filter((file) => {
      try { return readJson(file).schemaVersion === 2 && readJson(file).programId === programId; } catch { return false; }
    });
  return matches.length === 1 ? matches[0] : null;
}

const findings = [];
let authority = null;
let manifest = null;
let consumptionRecord = null;
let observed = {};
const authorityPath = findAuthority();
try {
  if (!authorityPath) throw new Error('AUTHORITY_NOT_UNIQUE_OR_ABSENT');
  authority = readJson(authorityPath);
  const manifestPath = resolveInsideRoot(authority.authorizedPathManifestPath);
  if (!manifestPath) throw new Error('MANIFEST_PATH_INVALID');
  const manifestBytes = fs.readFileSync(manifestPath);
  manifest = JSON.parse(manifestBytes.toString('utf8'));
  const consumptionPath = resolveInsideRoot(authority.consumptionRecordPath);
  if (consumptionPath && fs.existsSync(consumptionPath)) consumptionRecord = readJson(consumptionPath);
  const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
  const ledgerBytes = fs.readFileSync(ledgerPath);
  const ledgerLines = ledgerBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim());
  const events = ledgerLines.map((line) => JSON.parse(line));
  const gateEvents = authority.preState.gateId === null ? [] : events.filter((event) => event.gateId === authority.preState.gateId);
  const gateRoot = authority.preState.gateId === null ? null : path.join(root, 'governance', 'gates', authority.preState.gateId);
  const currentState = gateRoot ? readJson(path.join(gateRoot, 'state', 'CURRENT_STATE.json')) : null;
  const currentContract = gateRoot ? readJson(path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json')) : null;
  const activeGate = readJson(path.join(root, 'governance', 'active', 'ACTIVE_GATE.json'));
  let authorityPredecessorSha256 = null;
  if (authority.authorityPredecessor !== null) {
    const sourceRoot = path.join(root, 'governance', 'sources');
    const predecessorFiles = fs.readdirSync(sourceRoot)
      .filter((entry) => /^GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_[A-Za-z0-9_-]+\.json$/.test(entry))
      .map((entry) => path.join(sourceRoot, entry))
      .filter((file) => { try { return readJson(file).authorityId === authority.authorityPredecessor.authorityId; } catch { return false; } });
    if (predecessorFiles.length === 1) authorityPredecessorSha256 = sha256(fs.readFileSync(predecessorFiles[0]));
  }
  observed = {
    baseHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    ledgerEventCount: ledgerLines.length,
    ledgerPrefixSha256: sha256(ledgerBytes),
    gateId: authority.preState.gateId,
    gateStatus: gateEvents.at(-1)?.toStatus ?? null,
    stateRevision: currentState?.stateRevision ?? null,
    contractRevision: currentContract?.contractRevision ?? null,
    activeGate: activeGate?.activeGate ?? null,
    R8Absent: !fs.existsSync(path.join(root, 'governance', 'gee-v1', 'missions', 'GEE_V1_EXECUTION_CONTRACT_R0008.json')),
    manifestSha256: sha256(manifestBytes),
    authorityPredecessorSha256,
    requestedPaths: manifest.paths.map((entry) => entry.path),
    requestedOperationClasses: manifest.paths.map((entry) => entry.artifactClass)
  };
} catch (error) {
  findings.push({ code: error?.message || String(error) });
}

const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({
  authority,
  manifest,
  observed,
  phase,
  consumptionRecord
});
const allFindings = [...findings, ...evaluation.findings];
const authorized = allFindings.length === 0
  && (phase === PHASE_AUTHORIZE_PROGRAM_APPLY ? evaluation.programAuthorized : evaluation.consumed);
console.log(JSON.stringify({
  document: 'POST_FREEZE_MAINTENANCE_AUTHORITY_V2_VALIDATION',
  verdict: authorized ? 'AUTHORIZED' : 'BLOCKED',
  authorityMode: evaluation.authorityMode,
  phase,
  programId: authority?.programId ?? null,
  authorityId: authority?.authorityId ?? null,
  authorityPath,
  authorizedPaths: authorized ? evaluation.authorizedPaths : [],
  authorizedOperationClasses: authorized ? evaluation.authorizedOperationClasses : [],
  pushAuthorized: false,
  findings: allFindings
}, null, 2));
process.exitCode = authorized ? 0 : 2;

