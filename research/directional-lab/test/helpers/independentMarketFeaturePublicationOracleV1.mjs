import { createHash } from 'node:crypto';
import { canonicalJsonBytes } from '../../src/canonical/canonicalJsonV1.mjs';

export function oracleOrderedRowIdentityDigest(rows) {
  const projection = rows.map(({ sessionDate, subjectBarIdentityId }) => ({
    sessionDate, subjectBarIdentityId,
  }));
  return `sha256:${createHash('sha256').update(canonicalJsonBytes(projection)).digest('hex')}`;
}

export function oracleSessionCoverage(rows) {
  return {
    rowCount: rows.length,
    firstSessionDate: rows.length === 0 ? null : rows[0].sessionDate,
    lastSessionDate: rows.length === 0 ? null : rows.at(-1).sessionDate,
    orderedRowIdentityDigest: oracleOrderedRowIdentityDigest(rows),
  };
}

export function oracleLogicalKey(manifest) {
  return {
    instrumentIdentityId: manifest.instrumentIdentityId,
    datasetSnapshotBindingId: manifest.datasetSnapshotBindingId,
    publicationAuthorityPolicyId: manifest.publicationAuthorityPolicyId,
    featureSetVersion: manifest.featureSetVersion,
  };
}

export function oracleTips(entries) {
  const parentIds = new Set(entries.map((entry) => entry.supersedesPublicationManifestId)
    .filter((id) => id !== null));
  return entries.filter((entry) => !parentIds.has(entry.publicationManifestId));
}

export function oracleHasCycle(entries) {
  const byId = new Map(entries.map((entry) => [entry.publicationManifestId, entry]));
  for (const start of [...byId.keys()].sort()) {
    const seen = new Set();
    let cursor = start;
    while (cursor !== null && byId.has(cursor)) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor).supersedesPublicationManifestId;
    }
  }
  return false;
}

export function oracleResolveAsOf(entries, cutoff) {
  const eligible = entries.filter((entry) => entry.knowledgeCutoff <= cutoff);
  const tips = oracleTips(eligible);
  if (tips.length !== 1) return null;
  return tips[0].publicationManifestId;
}
