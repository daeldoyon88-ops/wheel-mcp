import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { collectClosedStateSealMembers, collectClosedStateSealMembersAtCommit } from '../gee-v1/core/sealed-state-evidence.mjs';
import { isExactMaintenancePath } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }

export function resolveMaintenancePath(root, relativePath) {
  if (!isExactMaintenancePath(relativePath)) return null;
  const resolved = path.resolve(root, ...relativePath.split('/'));
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? resolved : null;
}

/** The one canonical observation projection used by both the CLI validator and lifecycle apply. */
export function collectPostFreezeMaintenanceObservation({ root, authority, requestedPaths = null, requestedOperationClasses = null, candidateWrites = null }) {
  const findings = [];
  try {
    if (!authority || typeof authority !== 'object') throw new Error('AUTHORITY_ABSENT');
    const manifestPath = resolveMaintenancePath(root, authority.authorizedPathManifestPath);
    if (!manifestPath) throw new Error('MANIFEST_PATH_INVALID');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const ledgerPath = path.join(root, 'governance', 'state', 'GATE_STATUS_LEDGER.ndjson');
    const ledgerBytes = fs.readFileSync(ledgerPath);
    const events = ledgerBytes.toString('utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const gateId = authority.preState?.gateId;
    const gateRoot = gateId ? path.join(root, 'governance', 'gates', gateId) : null;
    const currentState = gateRoot ? readJson(path.join(gateRoot, 'state', 'CURRENT_STATE.json')) : null;
    const currentContract = gateRoot ? readJson(path.join(gateRoot, 'contracts', 'CURRENT_CONTRACT.json')) : null;
    const activeGate = readJson(path.join(root, 'governance', 'active', 'ACTIVE_GATE.json'));
    const externalReportFile = authority.externalReinspectionReportPath ? resolveMaintenancePath(root, authority.externalReinspectionReportPath) : null;
    const externalReportBytes = externalReportFile && fs.existsSync(externalReportFile) ? fs.readFileSync(externalReportFile) : null;
    let authorityPredecessorSha256 = null;
    if (authority.authorityPredecessor !== null) {
      const sources = path.join(root, 'governance', 'sources');
      const matches = fs.readdirSync(sources).filter((entry) => entry.endsWith('.json'))
        .map((entry) => path.join(sources, entry)).filter((file) => { try { return readJson(file).authorityId === authority.authorityPredecessor.authorityId; } catch { return false; } });
      if (matches.length === 1) authorityPredecessorSha256 = sha256(fs.readFileSync(matches[0]));
    }
    const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const preStateInventory = collectClosedStateSealMembersAtCommit(root, authority.preState?.baseHead);
    const candidateBytesByPath = new Map((candidateWrites ?? []).map((write) => [write.path, write.bytes]));
    const consumptionCohort = manifest.paths.filter((entry) => entry.path !== authority.consumptionRecordPath).map((entry) => {
      const candidateBytes = candidateBytesByPath.get(entry.path);
      if (candidateBytes) return { path: entry.path, sha256: sha256(candidateBytes), byteLength: candidateBytes.length };
      const file = resolveMaintenancePath(root, entry.path);
      if (!file || !fs.existsSync(file)) throw new Error(`CONSUMPTION_COHORT_PATH_ABSENT:${entry.path}`);
      const bytes = fs.readFileSync(file);
      return { path: entry.path, sha256: sha256(bytes), byteLength: bytes.length };
    });
    return {
      valid: true, findings, manifest,
      observed: {
        baseHead, ledgerEventCount: events.length, ledgerPrefixSha256: sha256(ledgerBytes), gateId,
        gateStatus: events.filter((event) => event.gateId === gateId).at(-1)?.toStatus ?? null,
        stateRevision: currentState?.stateRevision ?? null, contractRevision: currentContract?.contractRevision ?? null,
        activeGate: activeGate?.activeGate ?? null,
        R8Absent: !fs.existsSync(path.join(root, 'governance', 'gee-v1', 'missions', 'GEE_V1_EXECUTION_CONTRACT_R0008.json')),
        manifestSha256: sha256(manifestBytes), authorityPredecessorSha256,
        externalReinspectionReportPath: externalReportBytes ? authority.externalReinspectionReportPath : null,
        externalReinspectionReportSha256: externalReportBytes ? sha256(externalReportBytes) : null,
        requestedPaths: requestedPaths ?? manifest.paths.map((entry) => entry.path),
        requestedOperationClasses: requestedOperationClasses ?? manifest.paths.map((entry) => entry.artifactClass),
        closedStateSealMembers: collectClosedStateSealMembers(root).members,
        closedStateSealFindings: collectClosedStateSealMembers(root).findings,
        preStateClosedStateSealMembers: preStateInventory.members,
        preStateClosedStateSealFindings: preStateInventory.findings,
        consumptionCohort
      }
    };
  } catch (error) {
    findings.push({ code: error?.message || String(error) });
    return { valid: false, findings, manifest: null, observed: {} };
  }
}
