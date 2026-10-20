/** Manifest-first, one-page-at-a-time consumer for the GATE27 numeric export. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PRODUCT_ROOT,
  assertExactKeys,
  expandCompactQueryTuple,
  validateManifestShape,
  validatePageShape,
} from './numeric-outcome-export-v1.mjs';

function fail(code, detail = null) {
  const error = new Error(detail === null ? code : `${code}: ${JSON.stringify(detail)}`);
  error.code = code;
  error.detail = detail;
  throw error;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const pageRoot = (candidateRoot) => path.resolve(candidateRoot, ...PRODUCT_ROOT.split('/'));
const abstain = (reason, queryIdentityId = null) => Object.freeze({ decision: 'ABSTAIN', reason, queryIdentityId });

export function loadNumericOutcomeManifest({ candidateRoot, readFile = fs.readFileSync } = {}) {
  if (typeof candidateRoot !== 'string' || candidateRoot.length === 0) fail('CANDIDATE_ROOT_REQUIRED');
  const bytes = readFile(path.join(pageRoot(candidateRoot), 'MANIFEST.json'));
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
  validateManifestShape(manifest);
  return Object.freeze({ manifest, bytes: Buffer.from(bytes), sha256: sha256(bytes) });
}

function locatePage(pages, queryIdentityId) {
  let low = 0;
  let high = pages.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const page = pages[middle];
    if (queryIdentityId < page.firstQueryIdentityId) high = middle - 1;
    else if (queryIdentityId > page.lastQueryIdentityId) low = middle + 1;
    else return page;
  }
  return null;
}

/**
 * requestKind must be HISTORICAL_ANALOGUE_QUERY. A Wheel scan object is refused,
 * and a cutoff mismatch abstains instead of returning a nearby historical value.
 */
export function readNumericOutcomeForDecision({ candidateRoot, request, readFile = fs.readFileSync } = {}) {
  if (!request || typeof request !== 'object') fail('CONSUMER_REQUEST_REQUIRED');
  assertExactKeys(request, ['requestKind', 'queryIdentityId', 'decisionCutoff'], 'CONSUMER_REQUEST_SCHEMA_NOT_CLOSED');
  if (request.requestKind === 'WHEEL_SCAN') fail('WHEEL_SCAN_PARSE_FORBIDDEN');
  if (request.requestKind !== 'HISTORICAL_ANALOGUE_QUERY') fail('CONSUMER_REQUEST_KIND_INVALID', request.requestKind);
  if (typeof request.queryIdentityId !== 'string' || !/^[0-9a-f]{64}$/.test(request.queryIdentityId)) fail('CONSUMER_QUERY_ID_INVALID');
  if (typeof request.decisionCutoff !== 'string') fail('CONSUMER_DECISION_CUTOFF_REQUIRED');

  const { manifest } = loadNumericOutcomeManifest({ candidateRoot, readFile });
  const descriptor = locatePage(manifest.pages, request.queryIdentityId);
  if (descriptor === null) return abstain('QUERY_NOT_IN_EXPORT', request.queryIdentityId);
  const bytes = Buffer.from(readFile(path.join(pageRoot(candidateRoot), descriptor.path)));
  if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.sha256) fail('CONSUMER_PAGE_IDENTITY_MISMATCH', descriptor.path);
  const page = JSON.parse(bytes.toString('utf8'));
  validatePageShape(page);
  if (page.pageNumber !== descriptor.pageNumber
    || page.pairedFullProvenancePage.path !== descriptor.pairedFullProvenancePage.path
    || page.pairedFullProvenancePage.sha256 !== descriptor.pairedFullProvenancePage.sha256) {
    fail('CONSUMER_PAGE_DESCRIPTOR_MISMATCH', descriptor.path);
  }
  const tuple = page.records.find((entry) => entry[0] === request.queryIdentityId);
  if (!tuple) fail('CONSUMER_PAGE_RANGE_LIED', request.queryIdentityId);
  if (tuple[1] !== request.decisionCutoff) return abstain('DECISION_CUTOFF_MISMATCH', request.queryIdentityId);
  const expanded = expandCompactQueryTuple(tuple, {
    horizonIds: manifest.horizons.map((entry) => entry.horizonId),
    sourceBindingId: manifest.sourceBindingId,
  });
  return Object.freeze({
    decision: 'OUTCOME_SET',
    queryIdentityId: expanded.queryIdentityId,
    knowledgeCutoff: expanded.knowledgeCutoff,
    outcomeSetId: expanded.outcomeSetId,
    outcomeSet: expanded.outcomeSet,
  });
}
