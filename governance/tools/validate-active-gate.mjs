import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateLedger } from './validate-status-ledger.mjs';
import { validateContract } from './validate-gate-contract.mjs';
import { validateStateRevision } from './validate-state-revision.mjs';
import { WHEEL_EXTERNAL_AUTHORITY_POLICY } from '../gee-v1/adapters/wheel/external-authority-policy.mjs';

const root = process.cwd();
const j = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, ''));
const h = (b) => crypto.createHash('sha256').update(b).digest('hex');
const bad = [];

// Fail-closed, authority-driven gate transition rule.
//
// This intentionally names no gate number. A candidate activeGate is accepted only if every one of
// the following, independently re-derived from real files on every run, agrees:
//   1. The candidate matches the GATE\d{2} shape (existing schema-level check).
//   2. The status ledger itself validates with zero blocking findings.
//   3. Replaying the ledger gives this gate a currentStatus that is not NOT_STARTED (i.e. some real
//      GENESIS_IMPORT or transition event actually authorized it -- not merely a well-formed gate id).
// If that replayed status is already CLOSED (COMPLETE_CONFIRMED or SUPERSEDED), the ledger's own
// closure -- which itself required an independent-reinspection authority to be reached -- is the
// authority, and steps 4-6 below are not re-applied retroactively; a closed gate's contract/state are
// a historical record, not a live gate to keep re-authorizing against a registry that may since have
// been legitimately amended for a later gate (the same "historical authority pinned to a mutable
// file" problem this repair solves for the ledger). For any NOT-closed-but-authorized status
// (currently the only such case is AUTHORIZED_NOT_STARTED, but this covers IN_PROGRESS /
// INTERRUPTED_RESUMABLE / REPAIR_REQUIRED / BLOCKED_GOVERNANCE / COMPLETE_AGENT / REOPENED_AUTHORIZED
// too) the gate is still actively being worked, so its supporting authority must currently validate:
//   4. The gate has a CURRENT_CONTRACT.json + EXECUTION_CONTRACT_R0001.json that validates with zero
//      blocking findings against the real contract validator (existence, hashes, registry binding,
//      policy ids -- all real).
//   5. The gate has a CURRENT_STATE.json + sealed state revision that validates with zero blocking
//      findings against the real state/seal validator (existence, chain, seal, protected hashes).
//   6. If a numeric predecessor gate exists (GATE(N-1)), the ledger replay shows it CLOSED
//      (COMPLETE_CONFIRMED or SUPERSEDED). Gate 00 has no predecessor and skips this check.
// A gate with no contract/state on disk anywhere in the repository -- which is the real, current
// situation for every unauthorized gate including GATE14 -- fails steps 4 and 5 without ever being
// named. There is no denylist of specific gate ids left in this file.
function isGateAuthorizedAndExecutable(activeGate) {
  const reasons = [];
  const closedStatuses = new Set(['COMPLETE_CONFIRMED', 'SUPERSEDED']);

  const ledgerReport = validateLedger({
    root,
    ledgerPath: path.join(root, process.env.LEDGER_PATH || 'governance/state/GATE_STATUS_LEDGER.ndjson'),
    policy: WHEEL_EXTERNAL_AUTHORITY_POLICY
  });
  if (!ledgerReport.valid) { reasons.push('LEDGER_INVALID'); return { ok: false, reasons }; }

  const gateStatus = ledgerReport.gates.find((g) => g.gateId === activeGate);
  if (!gateStatus) { reasons.push('GATE_STATUS_NOT_IN_LEDGER'); return { ok: false, reasons }; }
  if (gateStatus.currentStatus === 'NOT_STARTED') { reasons.push('GATE_STATUS_NOT_AUTHORIZED'); return { ok: false, reasons }; }

  if (closedStatuses.has(gateStatus.currentStatus)) return { ok: true, reasons: [] };

  const gateRoot = path.join(root, 'governance', 'gates', activeGate);
  const pointerPath = path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json');
  let contractPath = path.join(gateRoot, 'contracts', 'EXECUTION_CONTRACT_R0001.json');
  if (fs.existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
      if (typeof pointer.contractPath === 'string') contractPath = path.resolve(root, pointer.contractPath);
    } catch { /* left at default; validateContract will report MISSING_REQUIRED_INPUT/INVALID_JSON */ }
  }
  const contractReport = validateContract({
    root,
    contractPath,
    pointerPath,
    registryPath: path.join(root, 'governance', 'GATE_REGISTRY_00_40.json'),
    constitutionPath: path.join(root, 'governance', 'PROJECT_CONSTITUTION.json')
  });
  if (!contractReport.valid) { reasons.push('GATE_CONTRACT_INVALID'); return { ok: false, reasons }; }

  const stateReport = validateStateRevision({
    root,
    gateId: activeGate,
    currentStatePath: path.join(gateRoot, 'state', 'CURRENT_STATE.json'),
    contractPath
  });
  if (!stateReport.valid) { reasons.push('GATE_STATE_INVALID'); return { ok: false, reasons }; }

  const match = /^GATE(\d{2})$/.exec(activeGate);
  const ordinal = match ? Number.parseInt(match[1], 10) : null;
  if (ordinal !== null && ordinal > 0) {
    const predecessorId = `GATE${String(ordinal - 1).padStart(2, '0')}`;
    const predecessorStatus = ledgerReport.gates.find((g) => g.gateId === predecessorId);
    if (!predecessorStatus || !closedStatuses.has(predecessorStatus.currentStatus)) {
      reasons.push('PREDECESSOR_NOT_CLOSED');
      return { ok: false, reasons };
    }
  }

  return { ok: true, reasons: [] };
}

try {
  const x = j(process.env.ACTIVE_GATE_PATH || 'governance/active/ACTIVE_GATE.json');
  const keys = ['schemaVersion', 'activeGate', 'activationEventId', 'activationEventOrdinal', 'activationEventSha256', 'currentStatePath', 'currentStateSha256'];

  if (Object.hasOwn(x, 'currentStatus')) bad.push('ACTIVE_GATE_STATUS_DUPLICATION');
  if (Object.hasOwn(x, 'dependencies')) bad.push('ACTIVE_GATE_DEPENDENCY_DUPLICATION');
  if (Object.keys(x).some((k) => !keys.includes(k))) bad.push('ACTIVE_GATE_ALLOWS_FORBIDDEN_FIELD');

  if (!/^GATE\d{2}$/.test(x.activeGate)) {
    bad.push('ACTIVE_GATE_NOT_AUTHORIZED');
  } else {
    const authorization = isGateAuthorizedAndExecutable(x.activeGate);
    if (!authorization.ok) bad.push('ACTIVE_GATE_NOT_AUTHORIZED', ...authorization.reasons);
  }

  if (path.isAbsolute(x.currentStatePath) || x.currentStatePath.split(/[\\/]/).includes('..')) bad.push('PATH_TRAVERSAL');

  const lp = process.env.LEDGER_PATH || 'governance/state/GATE_STATUS_LEDGER.ndjson';
  const ls = fs.readFileSync(path.join(root, lp), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const e = ls.find((y) => y.eventId === x.activationEventId && y.ordinal === x.activationEventOrdinal);
  if (!e) bad.push('ACTIVATION_EVENT_NOT_FOUND');
  else if (e.gateId !== x.activeGate) bad.push('ACTIVATION_EVENT_GATE_MISMATCH');

  const sp = path.join(root, x.currentStatePath);
  if (!fs.existsSync(sp)) bad.push('CURRENT_STATE_MISSING');
  else {
    if (fs.realpathSync(sp) !== sp) bad.push('SYMLINK_ESCAPE');
    if (x.currentStateSha256 && x.currentStateSha256 !== h(fs.readFileSync(sp))) bad.push('CURRENT_STATE_HASH_MISMATCH');
  }

  if (bad.length) {
    console.error(JSON.stringify({ findingIds: [...new Set(bad)] }));
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({ valid: true, findingIds: [] }));
  }
} catch (e) {
  console.error(JSON.stringify({ findingIds: ['ACTIVE_GATE_READ_ERROR'], detail: e.message }));
  process.exitCode = 2;
}
