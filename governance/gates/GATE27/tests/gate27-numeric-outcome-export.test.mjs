import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  PRODUCT_ROOT,
  compareCandidateTrees,
  validateNumericOutcomeExport,
} from '../implementation/numeric-outcome-export-v1.mjs';
import {
  loadNumericOutcomeManifest,
  readNumericOutcomeForDecision,
} from '../implementation/numeric-outcome-consumer-v1.mjs';

const repositoryRoot = process.env.GATE27_REPOSITORY_ROOT;
const candidateRoot = process.env.GATE27_CANDIDATE_ROOT;
const evidenceRoot = process.env.GATE27_TEST_EVIDENCE_ROOT;
if (!repositoryRoot || !candidateRoot || !evidenceRoot) throw new Error('GATE27_REPOSITORY_ROOT, GATE27_CANDIDATE_ROOT and GATE27_TEST_EVIDENCE_ROOT are required');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = (value) => value.split(path.sep).join('/');

function filesBelow(root, current = root) {
  const files = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(root, absolute));
    else if (entry.isFile()) files.push(slash(path.relative(root, absolute)));
    else throw new Error(`NON_FILE_CANDIDATE_ENTRY:${absolute}`);
  }
  return files.sort();
}

test('G27-P01 candidate cohort is exactly A plus the 543 B paths and no D', () => {
  const manifestPath = 'governance/historical-architecture/GATE27_NUMERIC_OUTCOME_EXPORT_AUTHORIZED_PATHS_R1.json';
  const authorityPath = 'governance/sources/GEE_V1_POST_FREEZE_MAINTENANCE_AUTHORITY_GATE27_NUMERIC_OUTCOME_EXPORT_R1.json';
  const authorization = JSON.parse(fs.readFileSync(path.join(candidateRoot, ...manifestPath.split('/')), 'utf8'));
  assert.equal(authorization.paths.length, 546);
  const aPaths = [authorityPath, manifestPath].sort();
  const bPaths = authorization.paths.slice(2, -1).map((entry) => entry.path).sort();
  const dPath = authorization.paths.at(-1).path;
  assert.equal(bPaths.length, 543);
  assert.equal(bPaths.filter((name) => name.startsWith('governance/gates/GATE27/')).length, 6);
  assert.equal(bPaths.filter((name) => name.startsWith(`${PRODUCT_ROOT}/`)).length, 537);
  assert.deepEqual(filesBelow(candidateRoot), [...aPaths, ...bPaths].sort());
  assert.equal(fs.existsSync(path.join(candidateRoot, ...dPath.split('/'))), false);
  assert.equal(sha256(fs.readFileSync(path.join(candidateRoot, ...authorityPath.split('/')))), 'e00c87e72300b9c02629630698ddf8bb0b0f40314de50297decbae4995178e3f');
  assert.equal(sha256(fs.readFileSync(path.join(candidateRoot, ...manifestPath.split('/')))), '99799b8a2ed4395021cdaa9a579c5781008700e8a48b897196c796eed9753469');
});

let validation;
test('G27-P02 independent raw-bar replay validates every page and OutcomeSetId', async () => {
  validation = await validateNumericOutcomeExport({ repositoryRoot, candidateRoot, evidenceRoot });
  const report = validation.report;
  assert.equal(report.verdict, 'VALID');
  assert.equal(report.baseHead, 'eb8500359e0a149a55c7f586dc1e35d290dcf02d');
  assert.equal(report.outputFileCount, 537);
  assert.equal(report.pageCount, 536);
  assert.equal(report.cohortDigest, '7ca9a18c4608c07be752cfdce8e3cbbc01ec343da85da7c710d0143705e336fb');
  assert.equal(report.outcomeSetIdDigest, '405f4720236ea99737d30fcbb97ccf6e1011542b40423a4cce927d0a9ba64d58');
  assert.equal(report.sourceBindingId, 'sha256:04d3e217eb0303a506a112c40e00732ffb0586d6aa37b717464c49ea0b05282b');
  assert.equal(report.counts.queries, 68562);
  assert.equal(report.counts.cells, 841928);
  assert.equal(report.counts.outcomeSetIdMatched, 68562);
  assert.equal(report.counts.outcomeSetIdMismatched, 0);
  assert.equal(report.counts.available, 63952);
  assert.equal(report.counts.missing, 777976);
  assert.deepEqual(report.counts.availableByHorizon, { 30: 63952, 90: 0, 180: 0, 252: 0 });
  assert.deepEqual(report.counts.missingByHorizon, { 30: 146530, 90: 210482, 180: 210482, 252: 210482 });
  assert.equal(report.counts.m5PredatedBars, 0);
  assert.equal(report.counts.analogueBeforeQueryViolations, 0);
  assert.ok(report.counts.minimumOutcomeSlackMs >= 0);
  assert.ok(report.counts.minimumCalendarSlackMs >= 0);
  assert.deepEqual(report.networkCalls, []);
  assert.equal(report.tooling.yahoo, false);
  assert.equal(report.tooling.selectionInvoked, false);
  assert.equal(report.tooling.gate26ProducerInvoked, false);
  assert.equal(report.tooling.universeFullScanCount, 0);
  assert.ok(report.resources.peak.rssBytes <= report.resources.limits.maximumRssBytes);
  assert.ok(report.resources.peak.heapUsedBytes <= report.resources.limits.maximumHeapUsedBytes);
  assert.ok(report.resources.peak.externalBytes <= report.resources.limits.maximumExternalBytes);
  assert.ok(report.resources.maximumSinglePageMs <= report.resources.limits.maximumSinglePageMs);
  assert.ok(report.resources.runtimeMs <= report.resources.limits.absoluteMaximumRuntimeMs);
  assert.ok(report.totalProductBytes <= report.resources.limits.maximumTotalProductBytes);
});

test('G27-P03 manifest and pages are closed, ordered, bounded and provenance-paired', () => {
  const { manifest } = loadNumericOutcomeManifest({ candidateRoot });
  assert.equal(manifest.pages.length, 536);
  assert.equal(manifest.recordCounts.queries, 68562);
  assert.equal(manifest.recordCounts.cells, 841928);
  assert.equal(manifest.pages[0].firstQueryOrdinal, 1);
  assert.equal(manifest.pages.at(-1).lastQueryOrdinal, 68562);
  let prior = null;
  let bytes = 0;
  for (const descriptor of manifest.pages) {
    assert.equal(descriptor.pageNumber, manifest.pages.indexOf(descriptor) + 1);
    assert.match(descriptor.pairedFullProvenancePage.path, /PROVENANCE_PAGE_\d{4}\.json$/);
    assert.ok(descriptor.byteLength <= 3145728);
    assert.ok(prior === null || descriptor.firstQueryIdentityId > prior);
    prior = descriptor.lastQueryIdentityId;
    bytes += descriptor.byteLength;
  }
  bytes += fs.statSync(path.join(candidateRoot, ...PRODUCT_ROOT.split('/'), 'MANIFEST.json')).size;
  assert.equal(bytes, validation.report.totalProductBytes);
  assert.ok(bytes <= 52428800);
});

test('G27-P04 consumer reads one page, preserves OutcomeSetId, and enforces exact cutoff', async () => {
  const product = path.join(candidateRoot, ...PRODUCT_ROOT.split('/'));
  const firstPage = JSON.parse(fs.readFileSync(path.join(product, 'OUTCOME_PAGE_0001.json'), 'utf8'));
  const tuple = firstPage.records.find((entry) => entry[4].length > 0) ?? firstPage.records[0];
  let pageReads = 0;
  const readFile = (file) => {
    if (/OUTCOME_PAGE_\d{4}\.json$/.test(String(file))) pageReads += 1;
    return fs.readFileSync(file);
  };
  const result = readNumericOutcomeForDecision({
    candidateRoot,
    request: { requestKind: 'HISTORICAL_ANALOGUE_QUERY', queryIdentityId: tuple[0], decisionCutoff: tuple[1] },
    readFile,
  });
  assert.equal(result.decision, 'OUTCOME_SET');
  assert.equal(result.outcomeSetId, tuple[3]);
  assert.equal(pageReads, 1);
  const canonical = await import(pathToFileURL(path.join(repositoryRoot, 'governance/tools/canonical-json.mjs')).href);
  assert.equal(canonical.sha256Canonical(result.outcomeSet), result.outcomeSetId);
  const mismatch = readNumericOutcomeForDecision({
    candidateRoot,
    request: { requestKind: 'HISTORICAL_ANALOGUE_QUERY', queryIdentityId: tuple[0], decisionCutoff: '2018-01-01T00:00:00.000Z' },
  });
  assert.deepEqual(mismatch, { decision: 'ABSTAIN', reason: 'DECISION_CUTOFF_MISMATCH', queryIdentityId: tuple[0] });
});

test('G27-P05 export contains no probability, quantile or confidence fields', () => {
  const product = path.join(candidateRoot, ...PRODUCT_ROOT.split('/'));
  for (const name of fs.readdirSync(product)) {
    const text = fs.readFileSync(path.join(product, name), 'utf8');
    assert.equal(/"(?:probability|quantile|confidence)"\s*:/.test(text), false, name);
  }
});

test('G27-P06 tree comparator proves a byte-identical peer candidate when supplied', { skip: !process.env.GATE27_PEER_CANDIDATE_ROOT }, () => {
  assert.deepEqual(compareCandidateTrees(candidateRoot, process.env.GATE27_PEER_CANDIDATE_ROOT), { identical: true, pathCount: 545 });
});
