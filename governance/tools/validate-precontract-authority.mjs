#!/usr/bin/env node
/**
 * PRECONTRACT authority validator.
 *
 * Both phases now run through the Wheel adapter so that BOTH modes are decided
 * against the live repository. Verifying consumption against a hand-supplied
 * `observed` would have let a caller assert the bootstrap's own outcome.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWheelPrecontractAuthoritySource } from '../gee-v1/adapters/wheel/precontract-authority-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const requestPath = option('--request');
const authorityPath = option('--authority');
const ownerKeyPath = option('--owner-key', path.join(ROOT, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json'));
const phase = option('--phase', 'AUTHORIZE_WRITE');
const gateOption = option('--gate', null);

/**
 * Identification only. The adapter is the one that applies the mode-dependent
 * location rule; reading a document here to learn its Gate id decides nothing.
 */
function peek(filePath) {
  if (!filePath) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

const request = peek(requestPath);
const authority = peek(authorityPath);
const gateId = gateOption || authority?.gateId || request?.gateId || null;
const source = createWheelPrecontractAuthoritySource(ROOT, { requestPath, authorityPath, ownerKeyPath });
const result = phase === 'VERIFY_CONSUMPTION'
  ? source.verifyPrecontractConsumption(gateId)
  : source.resolvePrecontractAuthority(gateId);
const findings = [...result.findings];
const verdict = findings.length > 0 ? 'BLOCKED' : (result.consumed ? 'CONSUMED' : result.decision);
const report = {
  document: 'PRECONTRACT_AUTHORITY_VALIDATION',
  PRECONTRACT_VERDICT: verdict,
  phase,
  gateId,
  authorityMode: result.authorityMode ?? null,
  bootstrapAuthorized: findings.length === 0 && result.bootstrapAuthorized === true,
  consumed: findings.length === 0 && result.consumed === true,
  executionAuthorized: false,
  authorizedPaths: findings.length === 0 ? result.authorizedPaths : [],
  findings, requestPath, authorityPath
};
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.PRECONTRACT_VERDICT === 'AUTHORIZED' || report.PRECONTRACT_VERDICT === 'CONSUMED' ? 0 : 2;
