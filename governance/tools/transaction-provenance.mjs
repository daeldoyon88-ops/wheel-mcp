import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { collectPostFreezeMaintenanceObservation } from './post-freeze-maintenance-observation.mjs';
import { evaluatePostFreezeMaintenanceAuthorityV2, PHASE_AUTHORIZE_PROGRAM_APPLY } from '../gee-v1/core/post-freeze-maintenance-authority.mjs';

function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !path.posix.isAbsolute(value)
    && !/^[A-Za-z]:/.test(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function rootPath(root, relative) {
  if (!safeRelative(relative)) return null;
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

function cohortFor(writes, before) {
  return writes.map((write) => {
    const prior = before.find((entry) => entry.write.path === write.path);
    return {
      path: write.path, sha256: write.sha256, byteLength: write.byteLength,
      expectedBeforePresent: prior?.existed ?? false,
      expectedBeforeSha256: prior?.bytes ? sha256Bytes(prior.bytes) : null,
      expectedBeforeByteLength: prior?.bytes?.length ?? null
    };
  }).sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function createLifecycleTransactionProvenance({ root, candidate, before, authorityDocumentPath, authority }) {
  if (!authorityDocumentPath || authority?.decision !== 'AUTHORIZED' || !authority.observed) return null;
  const authorityFile = rootPath(root, authorityDocumentPath);
  if (!authorityFile || !fs.existsSync(authorityFile)) return null;
  const authorityBytes = fs.readFileSync(authorityFile);
  const authorityDocument = JSON.parse(authorityBytes.toString('utf8'));
  const cohort = cohortFor(candidate.writes, before);
  const candidateManifest = { gateId: candidate.gateId, transitionType: candidate.transitionType, cohort };
  return {
    schemaVersion: 1,
    mechanism: 'LOCAL_EXPLICIT_AUTHORITY',
    transactionId: `${candidate.eventId}_TRANSACTION`,
    gateId: candidate.gateId,
    transitionType: candidate.transitionType,
    candidateManifestSha256: sha256Canonical(candidateManifest),
    candidateCohort: cohort,
    requestedOperationClasses: [candidate.transitionType],
    preState: {
      baseHead: authority.observed.baseHead,
      ledgerEventCount: authority.observed.ledgerEventCount,
      ledgerPrefixSha256: authority.observed.ledgerPrefixSha256,
      gateStatus: authority.observed.gateStatus,
      stateRevision: authority.observed.stateRevision,
      contractRevision: authority.observed.contractRevision,
      activeGate: authority.observed.activeGate
    },
    authority: {
      documentPath: authorityDocumentPath,
      documentSha256: sha256Bytes(authorityBytes),
      authorityId: authorityDocument.authorityId,
      authorizedPathManifestPath: authorityDocument.authorizedPathManifestPath,
      authorizedPathManifestSha256: authorityDocument.authorizedPathManifestSha256,
      authorityPredecessor: authorityDocument.authorityPredecessor,
      observed: authority.observed
    },
    external: authorityDocument.authorityPurpose === 'GATE_EXTERNAL_CONFIRMATION' ? {
      logicalAuthorityId: candidate.event.authorityPath,
      reportPath: authorityDocument.externalReinspectionReportPath,
      reportSha256: authorityDocument.externalReinspectionReportSha256,
      authorityPredecessor: authorityDocument.authorityPredecessor
    } : null
  };
}

function finding(findings, code, detail = null) { findings.push({ code, detail }); }

function readStagedBytes(root, artifact, findings) {
  const source = rootPath(root, artifact?.sourcePath);
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    finding(findings, 'PENDING_TRANSACTION_STAGED_ARTIFACT_MISSING', artifact?.sourcePath ?? null);
    return null;
  }
  const bytes = fs.readFileSync(source);
  if (sha256Bytes(bytes) !== artifact.sha256 || bytes.length !== artifact.byteLength) {
    finding(findings, 'PENDING_TRANSACTION_STAGED_ARTIFACT_ALTERED', artifact.targetPath);
    return null;
  }
  return bytes;
}

function isPermittedProgress(root, provenance, candidateByPath, findings) {
  let progressed = false;
  let seenUnchangedAfterProgress = false;
  for (const entry of provenance.candidateCohort) {
    const target = rootPath(root, entry.path);
    const present = Boolean(target && fs.existsSync(target));
    const bytes = present ? fs.readFileSync(target) : null;
    const atCandidate = present && sha256Bytes(bytes) === entry.sha256 && bytes.length === entry.byteLength;
    const atBefore = present === entry.expectedBeforePresent
      && (!present || (sha256Bytes(bytes) === entry.expectedBeforeSha256 && bytes.length === entry.expectedBeforeByteLength));
    if (!atCandidate && !atBefore) finding(findings, 'PENDING_TRANSACTION_CANONICAL_BYTES_UNEXPECTED', entry.path);
    if (atCandidate) {
      if (seenUnchangedAfterProgress) finding(findings, 'PENDING_TRANSACTION_PROGRESS_NON_PREFIX', entry.path);
      progressed = true;
    } else if (progressed) seenUnchangedAfterProgress = true;
    if (!candidateByPath.has(entry.path)) finding(findings, 'PENDING_TRANSACTION_COHORT_ARTIFACT_MISSING', entry.path);
  }
}

/** Recomputes authority, cohort and byte bindings before a pending transaction can publish. */
export function validateLifecycleTransactionProvenance({ root, transaction }) {
  const findings = [];
  const provenance = transaction?.provenance;
  if (!provenance || provenance.schemaVersion !== 1) return { valid: false, findings: [{ code: 'PENDING_TRANSACTION_PROVENANCE_INVALID', detail: 'PROVENANCE_ABSENT_OR_INVALID' }] };
  for (const field of ['baseHead', 'ledgerEventCount', 'ledgerPrefixSha256', 'gateStatus', 'stateRevision', 'contractRevision', 'activeGate']) {
    if (provenance.preState?.[field] !== provenance.authority?.observed?.[field]) finding(findings, 'PENDING_TRANSACTION_PRESTATE_RECEIPT_MISMATCH', field);
  }
  if (transaction.caseType !== 'STATUS_TRANSITION' || transaction.transactionId !== provenance.transactionId
      || transaction.gateId !== provenance.gateId || transaction.ledgerEvent?.gateId !== provenance.gateId
      || transaction.ledgerEvent?.transitionType !== provenance.transitionType) finding(findings, 'PENDING_TRANSACTION_IDENTITY_MISMATCH');
  if (provenance.mechanism !== 'LOCAL_EXPLICIT_AUTHORITY') finding(findings, 'PENDING_TRANSACTION_AUTHORITY_MECHANISM_INVALID');
  const candidateByPath = new Map();
  for (const artifact of transaction.stagedArtifacts ?? []) {
    const bytes = readStagedBytes(root, artifact, findings);
    if (bytes) candidateByPath.set(artifact.targetPath, bytes);
  }
  const expected = new Map((transaction.expectedHashes ?? []).map((item) => [item.targetPath, item]));
  const observedCohort = [...candidateByPath.entries()].map(([path, bytes]) => ({ path, sha256: sha256Bytes(bytes), byteLength: bytes.length }))
    .sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const claimedCohort = Array.isArray(provenance.candidateCohort) ? provenance.candidateCohort : [];
  if (canonicalize(observedCohort) !== canonicalize(claimedCohort.map(({ path, sha256, byteLength }) => ({ path, sha256, byteLength })))) finding(findings, 'PENDING_TRANSACTION_COHORT_MISMATCH');
  const manifest = { gateId: provenance.gateId, transitionType: provenance.transitionType, cohort: claimedCohort };
  if (sha256Canonical(manifest) !== provenance.candidateManifestSha256) finding(findings, 'PENDING_TRANSACTION_CANDIDATE_MANIFEST_MISMATCH');
  if (canonicalize([...expected.values()].map(({ targetPath, sha256, byteLength }) => ({ path: targetPath, sha256, byteLength })).sort((a, b) => a.path.localeCompare(b.path, 'en'))) !== canonicalize(observedCohort)) finding(findings, 'PENDING_TRANSACTION_EXPECTED_HASHES_MISMATCH');
  if (canonicalize(transaction.commitOrder) !== canonicalize(claimedCohort.map((entry) => entry.path))) finding(findings, 'PENDING_TRANSACTION_COMMIT_ORDER_MISMATCH');
  isPermittedProgress(root, provenance, candidateByPath, findings);

  const authorityPath = rootPath(root, provenance.authority?.documentPath);
  if (!authorityPath || !fs.existsSync(authorityPath)) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_ABSENT');
  else {
    const authorityBytes = fs.readFileSync(authorityPath);
    if (sha256Bytes(authorityBytes) !== provenance.authority.documentSha256) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_SHA_MISMATCH');
    else {
      const authority = JSON.parse(authorityBytes.toString('utf8'));
      if (authority.authorityId !== provenance.authority.authorityId || authority.authorizedPathManifestSha256 !== provenance.authority.authorizedPathManifestSha256) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_BINDING_MISMATCH');
      const candidateWrites = observedCohort.map((entry) => ({ ...entry, bytes: candidateByPath.get(entry.path) }));
      const observation = collectPostFreezeMaintenanceObservation({ root, authority, requestedPaths: observedCohort.map((entry) => entry.path), requestedOperationClasses: provenance.requestedOperationClasses, candidateWrites });
      if (!observation.valid) finding(findings, 'PENDING_TRANSACTION_AUTHORITY_OBSERVATION_INVALID');
      else {
        const evaluation = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest: observation.manifest, observed: observation.observed, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
        const preStateMatches = Object.entries(provenance.preState ?? {}).every(([key, value]) => observation.observed[key] === value);
        if (!preStateMatches) {
          // A recovery may have published a prefix already. Re-evaluate the original
          // authority binding from the immutable receipt, while real current bytes
          // above prove that the only divergence is that exact publication prefix.
          const receiptEvaluation = evaluatePostFreezeMaintenanceAuthorityV2({ authority, manifest: observation.manifest, observed: { ...observation.observed, ...provenance.preState, ...provenance.authority.observed, requestedPaths: observedCohort.map((entry) => entry.path), requestedOperationClasses: provenance.requestedOperationClasses }, phase: PHASE_AUTHORIZE_PROGRAM_APPLY });
          if (receiptEvaluation.decision !== 'AUTHORIZED') finding(findings, 'PENDING_TRANSACTION_AUTHORITY_NOT_AUTHORIZED');
        } else if (evaluation.decision !== 'AUTHORIZED') finding(findings, 'PENDING_TRANSACTION_AUTHORITY_NOT_AUTHORIZED');
      }
    }
  }
  if (provenance.external) {
    const external = provenance.external;
    if (external.logicalAuthorityId !== transaction.ledgerEvent?.authorityPath) finding(findings, 'PENDING_TRANSACTION_EXTERNAL_LOGICAL_ID_MISMATCH');
    const report = rootPath(root, external.reportPath);
    if (!report || !fs.existsSync(report) || sha256Bytes(fs.readFileSync(report)) !== external.reportSha256) finding(findings, 'PENDING_TRANSACTION_EXTERNAL_REPORT_MISMATCH');
  }
  return { valid: findings.length === 0, findings };
}
