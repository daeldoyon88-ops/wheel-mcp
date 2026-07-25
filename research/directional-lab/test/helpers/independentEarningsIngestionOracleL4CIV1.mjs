/** Independent binary-preimage oracle; intentionally imports no earnings code. */

import { createHash } from 'node:crypto';

function digest(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(Buffer.isBuffer(part) ? part : Buffer.from(part));
  return `sha256:${hash.digest('hex')}`;
}

export function oracleDatasetIdentityKeyV1(value) {
  return digest(['EarningsDatasetIdentityKey/1\n', `${value.datasetSeriesIdentity}\n`,
    `${value.jurisdictionCode}\n`, `${value.currencyCode}\n`,
    `${value.allowedSourceAuthority}\n`]);
}

const FIELDS = [
  'datasetSeriesIdentity', 'earningsIngestionPolicyId', 'earningsMetricExtractionPolicyId',
  'earningsEventSetManifestId', 'earningsRevisionSetManifestId',
  'earningsExtractionSetManifestId', 'transformImplementationManifestId',
  'earningsTaxonomyBundleManifestId', 'jurisdictionCode', 'currencyCode', 'eventCount',
  'revisionCount', 'extractionReportCount', 'metricObservationCount',
  'firstPublicAvailableAt', 'lastPublicAvailableAt', 'emptySnapshot',
  'orderedEventIdentityDigest', 'orderedRevisionIdentityDigest',
  'orderedExtractionReportDigest', 'orderedMetricObservationDigest',
  'orderedMetricObservationIdentityDigest',
];

export function oracleFunctionalSnapshotFingerprintV1(value) {
  const parts = ['EarningsDatasetFunctionalFingerprint/1\n'];
  for (const field of FIELDS) {
    const scalar = value[field] === null ? 'null'
      : typeof value[field] === 'boolean' ? String(value[field]) : `${value[field]}`;
    parts.push(field, Buffer.from([0]), `${scalar}\n`);
  }
  return digest(parts);
}

export function oracleGroupedMetricObservationDigestV1(entries) {
  const parts = ['EarningsMetricObservationGroups/1\n'];
  for (const entry of entries) {
    parts.push(entry.earningsRevisionIdentityId, Buffer.from([0]),
      `${entry.orderedMetricObservationIds.length}\n`);
    for (const id of entry.orderedMetricObservationIds) parts.push(`${id}\n`);
  }
  return digest(parts);
}

export function oracleOrderedMetricObservationIdentityDigestV1(ids) {
  return digest(['EarningsMetricObservationIdentityDigest/1\n',
    ...[...ids].sort().map((id) => `${id}\n`)]);
}
