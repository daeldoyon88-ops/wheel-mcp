#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluatePrecontractAuthority } from '../gee-v1/core/precontract-authority.mjs';
import { loadOwnerReleaseKey, loadReleaseAuthorization } from '../gee-v1/core/release-authorization-source.mjs';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const requestPath = option('--request');
const authorityPath = option('--authority');
const ownerKeyPath = option('--owner-key', path.join(ROOT, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json'));
const phase = option('--phase', 'AUTHORIZE_WRITE');
const requestedPath = option('--path', null);
function loadExternal(filePath) {
  const loaded = loadReleaseAuthorization(filePath, { governedRoots: [ROOT] });
  if (loaded.finding) return { value: null, finding: loaded.finding };
  try { return { value: JSON.parse(fs.readFileSync(filePath, 'utf8')), finding: null }; } catch { return { value: null, finding: 'AUTHORITY_OR_REQUEST_MALFORMED' }; }
}
const request = loadExternal(requestPath);
const authority = loadExternal(authorityPath);
const ownerKey = loadOwnerReleaseKey(ownerKeyPath);
const result = phase === 'AUTHORIZE_WRITE'
  ? createWheelPrecontractAuthoritySource(ROOT, { requestPath, authorityPath, ownerKeyPath }).resolvePrecontractAuthority(request.value?.gateId || null)
  : evaluatePrecontractAuthority({ request: request.value, authority: authority.value, ownerKey: ownerKey.ownerKey, requestedPath, phase });
const findings = [request.finding, authority.finding, ownerKey.finding, ...result.findings].filter(Boolean);
const report = { document: 'PRECONTRACT_AUTHORITY_VALIDATION', PRECONTRACT_VERDICT: findings.length === 0 ? result.decision : 'BLOCKED', phase, bootstrapAuthorized: findings.length === 0 && result.bootstrapAuthorized, executionAuthorized: false, authorizedPaths: findings.length === 0 ? result.authorizedPaths : [], findings, requestPath, authorityPath };
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.PRECONTRACT_VERDICT === 'AUTHORIZED' || report.PRECONTRACT_VERDICT === 'CONSUMED' ? 0 : 2;
