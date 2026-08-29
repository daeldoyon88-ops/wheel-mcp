#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluatePostFreezeMaintenanceAuthorityV2,
  PHASE_AUTHORIZE_PROGRAM_APPLY,
  PHASE_VERIFY_PROGRAM_CONSUMPTION
} from '../gee-v1/core/post-freeze-maintenance-authority.mjs';
import { collectPostFreezeMaintenanceObservation, resolveMaintenancePath } from './post-freeze-maintenance-observation.mjs';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(option('--root', path.resolve(toolsDir, '..', '..')));
const authorityOption = option('--authority');
const phase = option('--phase', PHASE_AUTHORIZE_PROGRAM_APPLY);
const includeConsumptionCohort = phase === PHASE_VERIFY_PROGRAM_CONSUMPTION;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^Ã¯Â»Â¿/, ''));
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
  // A V2 manifest may self-exclude the authority document from the pre-state
  // gate, and the evaluator refuses that exclusion unless it can see which
  // document was actually loaded. Reported repo-relative, POSIX-style, so it
  // compares against manifest paths on every platform.
  const canonicalObservation = collectPostFreezeMaintenanceObservation({
    root, authority,
    authorityDocumentPath: path.relative(root, authorityPath).split(path.sep).join('/'),
    includeConsumptionCohort
  });
  findings.push(...canonicalObservation.findings);
  manifest = canonicalObservation.manifest;
  observed = canonicalObservation.observed;
  const consumptionPath = resolveMaintenancePath(root, authority.consumptionRecordPath);
  if (consumptionPath && fs.existsSync(consumptionPath)) consumptionRecord = readJson(consumptionPath);
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
