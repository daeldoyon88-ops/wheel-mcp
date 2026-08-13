/**
 * Wheel adapter — GATE execution-authority source.
 *
 * This is the GATE work-unit type expressed as ONE source in the generic
 * execution-authority registry (core/work-unit-core.mjs). Before the
 * foundation repair, the same logic lived inline in governance-preflight.mjs
 * and was the ONLY way any work unit could ever be authorized, which is why a
 * non-GATE mission had no route to authority at all.
 *
 * Behaviour is deliberately IDENTICAL to the pre-repair preflight: a gate is
 * executable when its CURRENT_CONTRACT.json pointer exists AND the append-only
 * ledger replays it to a status in EXECUTABLE_STATUSES. Nothing was tightened
 * and nothing was loosened here — the repair is about routing, not about
 * changing what a gate means. The deeper contract/state/predecessor integrity
 * checks continue to be enforced where they already were, by
 * governance/tools/validate-active-gate.mjs, which the preflight still runs on
 * every invocation as a configuration validator.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createWheelGateStartAuthoritySource } from './gate-start-authority-source.mjs';
import { isModernGateStartId } from '../../core/gate-start-authority.mjs';

/**
 * The exact status set the pre-repair preflight treated as executable. A gate
 * that has reached a closed status is NOT executable, which is what keeps a
 * COMPLETE_CONFIRMED gate closed without anyone having to name it.
 */
export const EXECUTABLE_GATE_STATUSES = Object.freeze(['IN_PROGRESS']);

export const ACTIVE_GATE_POINTER_PATH = 'governance/active/ACTIVE_GATE.json';
const LEDGER_PATH = 'governance/state/GATE_STATUS_LEDGER.ndjson';

function readJson(absolutePath) {
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8').replace(/^﻿/, ''));
}

function replayStatus(repoRoot, workUnitId) {
  const ledgerPath = path.join(repoRoot, LEDGER_PATH);
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const last = events.filter((event) => event.gateId === workUnitId).at(-1);
  return last ? last.toStatus : null;
}

/**
 * The work unit this project's legacy pointer designates. Exposed separately
 * from resolution so the preflight can keep its historical no-argument
 * behaviour (resolve the active gate) without the generic router ever
 * consulting an ambient pointer of its own.
 */
export function readActiveGateId(repoRoot) {
  try {
    return readJson(path.join(repoRoot, ACTIVE_GATE_POINTER_PATH)).activeGate ?? null;
  } catch {
    return null;
  }
}

export function createWheelGateAuthoritySource(repoRoot, { projectId = 'WHEEL' } = {}) {
  const root = path.resolve(repoRoot);
  const startSource = createWheelGateStartAuthoritySource(root, { projectId });

  return {
    projectId,
    workUnitType: 'GATE',
    sourceId: 'wheel-gate-authority-source',

    resolveWorkUnitAuthority(workUnitId) {
      const findings = [];
      const contractPointerPath = path.join(root, 'governance', 'gates', workUnitId, 'contracts', 'CURRENT_CONTRACT.json');
      const contractPresent = fs.existsSync(contractPointerPath);

      let status = null;
      try {
        status = replayStatus(root, workUnitId);
      } catch (error) {
        findings.push({ code: 'LEDGER_UNREADABLE', detail: error?.message || String(error) });
      }

      // A work unit the ledger has never heard of is unknown, not merely
      // unauthorized: returning null makes the router report it as such.
      if (status === null && !contractPresent) return null;

      let contract = null;
      let authorizedPaths = [];
      if (contractPresent) {
        try {
          const pointer = readJson(contractPointerPath);
          contract = readJson(path.resolve(root, pointer.contractPath));
          authorizedPaths = Array.isArray(contract.authorizedPaths) ? contract.authorizedPaths : [];
        } catch (error) {
          findings.push({ code: 'GATE_CONTRACT_UNREADABLE', detail: error?.message || String(error) });
        }
      }

      // AUTHORIZED_NOT_STARTED is deliberately not executable.  START is a
      // separate, owner-signed authority and its exact functional scope is
      // checked only once the ledger has replayed IN_PROGRESS.
      const modernStart = status === 'IN_PROGRESS' && isModernGateStartId(workUnitId)
        ? startSource.resolveWorkUnitAuthority(workUnitId)
        : null;
      const executable = isModernGateStartId(workUnitId)
        ? contractPresent && status === 'IN_PROGRESS'
          && modernStart?.executionAuthorized === true
          && Array.isArray(modernStart.authorizedPaths)
          && modernStart.authorizedPaths.length > 0
        : contractPresent && status === 'IN_PROGRESS';
      if (status === 'IN_PROGRESS' && modernStart?.findings?.length) findings.push(...modernStart.findings);

      return {
        workUnitId,
        workUnitType: 'GATE',
        status,
        executionAuthorized: executable,
        contract,
        authorizedPaths,
        findings,
        proofs: {
          EXECUTION_CONTRACT: contractPresent
            ? { state: 'PROVEN', reason: 'CURRENT_CONTRACT pointer present' }
            : { state: 'FAILED', reason: 'CURRENT_CONTRACT pointer absent' },
          // Not re-implemented here: contract hashes, registry binding, sealed
          // state revision and predecessor closure are all re-derived on every
          // preflight run by governance/tools/validate-active-gate.mjs, whose
          // findings already gate configurationValid. Duplicating them would
          // create a second, divergent copy of the same authority.
          CONTRACT_INTEGRITY: {
            state: 'NOT_APPLICABLE',
            reason: 'enforced by governance/tools/validate-active-gate.mjs as a preflight configuration validator'
          },
          PREREQUISITES: {
            state: 'NOT_APPLICABLE',
            reason: 'gate dependency closure enforced by validate-active-gate.mjs predecessor check'
          },
          WORK_UNIT_EXECUTABLE: executable
            ? { state: 'PROVEN', reason: 'IN_PROGRESS plus valid modern START authority and exact contract scope' }
            : { state: 'FAILED', reason: status === 'AUTHORIZED_NOT_STARTED' ? 'START authority cannot grant pre-START execution' : status === null ? 'no ledger status' : 'modern START authority or exact scope invalid' }
        },
        startAuthority: modernStart
      };
    }
  };
}
