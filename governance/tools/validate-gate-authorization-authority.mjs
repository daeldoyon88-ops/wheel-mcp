#!/usr/bin/env node
/**
 * Pre-write validation of a Gate authorization authority.
 *
 * Answers exactly one question: may the ONE ledger transition
 * NOT_STARTED -> AUTHORIZED_NOT_STARTED be applied to this Gate right now,
 * together with its first sealed R0001 state revision?
 *
 * It never answers "may this Gate execute" or "may this Gate START": both are
 * reported as literal false, at every outcome, because this authority kind has
 * no such privilege to grant.
 *
 * This tool WRITES NOTHING. It is the read-only decision gate that must pass
 * before an authorization mission is allowed to append anything.
 *
 *   node governance/tools/validate-gate-authorization-authority.mjs \
 *     --gate <GATE_ID> \
 *     --request  <path outside the repository> \
 *     --authority <path outside the repository> \
 *     [--owner-key governance/authority/PROJECT_OWNER_RELEASE_KEY.json] \
 *     [--root <repository root>] [--phase AUTHORIZE_APPLY|VERIFY_CONSUMPTION]
 *
 * Exit code 0 only when the verdict is AUTHORIZED; 2 otherwise.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWheelGateAuthorizationAuthoritySource } from '../gee-v1/adapters/wheel/gate-authorization-authority-source.mjs';
import { PHASE_AUTHORIZE_APPLY, PHASE_VERIFY_CONSUMPTION } from '../gee-v1/core/gate-authorization-authority.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const root = path.resolve(option('--root', DEFAULT_ROOT));
const gateId = option('--gate');
const requestPath = option('--request');
const authorityPath = option('--authority');
const ownerKeyPath = option('--owner-key', path.join(root, 'governance/authority/PROJECT_OWNER_RELEASE_KEY.json'));
const phase = option('--phase', PHASE_AUTHORIZE_APPLY);

const findings = [];
if (!gateId) findings.push({ code: 'GATE_ID_NOT_SUPPLIED', detail: '--gate is required' });
if (phase !== PHASE_AUTHORIZE_APPLY && phase !== PHASE_VERIFY_CONSUMPTION) findings.push({ code: 'PHASE_INVALID', detail: phase });

let result = { decision: 'BLOCKED', authorizationAuthorized: false, authorizedPaths: [], findings: [], proofs: null, recordPath: null, ownerAuthoritySnapshotPath: null };
if (findings.length === 0) {
  result = createWheelGateAuthorizationAuthoritySource(root, { requestPath, authorityPath, ownerKeyPath, phase })
    .resolveGateAuthorizationAuthority(gateId);
}

const allFindings = [...findings, ...result.findings];
const authorized = allFindings.length === 0 && result.authorizationAuthorized;

const report = {
  document: 'GATE_AUTHORIZATION_AUTHORITY_VALIDATION',
  GATE_AUTHORIZATION_VERDICT: authorized ? 'AUTHORIZED' : 'BLOCKED',
  gateId: gateId ?? null,
  phase,
  transitionAuthorized: authorized ? 'NOT_STARTED->AUTHORIZED_NOT_STARTED:AUTHORIZATION' : null,
  authorizationAuthorized: authorized,
  // Constants, not results. No input can move either of these.
  executionAuthorized: false,
  startAuthorized: false,
  authorizedPaths: authorized ? result.authorizedPaths : [],
  recordPath: result.recordPath ?? null,
  ownerAuthoritySnapshotPath: result.ownerAuthoritySnapshotPath ?? null,
  proofs: result.proofs ?? null,
  findings: allFindings,
  requestPath,
  authorityPath
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = report.GATE_AUTHORIZATION_VERDICT === 'AUTHORIZED' ? 0 : 2;
