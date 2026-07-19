import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as Candidate from '../src/contracts/marketDataCandidateL3V1.mjs';
import * as Revision from '../src/contracts/marketDataBarRevisionL3V1.mjs';
import * as Delta from '../src/contracts/marketDataDeltaL3V1.mjs';

const ID_A = `sha256:${'a'.repeat(64)}`;
const ID_B = `sha256:${'b'.repeat(64)}`;
const ID_C = `sha256:${'c'.repeat(64)}`;
const ID_D = `sha256:${'d'.repeat(64)}`;

const VALUES = Object.freeze({
  openAtoms: '1000', highAtoms: '1200', lowAtoms: '900', closeAtoms: '1100',
  priceScale: 2, volumeAtoms: '100', volumeScale: 0, currency: 'USD', priceBasis: 'RAW',
});

function candidateValue(overrides = {}) {
  return {
    schemaVersion: Candidate.MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,
    candidateKind: 'BAR_INITIAL_VALUE', ingestionLineageId: ID_A,
    sourceArtifactId: ID_B, acquisitionRecordId: ID_C, parseResultId: ID_D,
    sourceRowIndex: 0, sourceRowDigest: ID_A, knowledgeMode: 'CAPTURE_TIME_ONLY',
    knowledgeTimeLowerBound: null, knowledgeTimeUpperBound: '2026-01-03T00:00:00.000Z',
    sourceTimestampEvidenceId: null, providerRevisionId: null,
    calendarRegistryManifestId: ID_B, marketValidTime: '2026-01-02T21:00:00.000Z',
    barIdentityId: ID_C, targetCorrectionId: null, replacementValues: VALUES,
    ...overrides,
  };
}

function correctionValue(overrides = {}) {
  return {
    schemaVersion: Revision.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,
    correctionKind: 'INITIAL_ROOT', ingestionLineageId: ID_A, barIdentityId: ID_B,
    parentCorrectionId: null, observationId: ID_C, restoredObservationId: null,
    sessionDateLink: null, sourceArtifactId: ID_C, acquisitionRecordId: ID_D,
    parseResultId: ID_A, sourceRowIndex: 0, sourceRowDigest: ID_B,
    knowledgeMode: 'CAPTURE_TIME_ONLY', knowledgeTimeLowerBound: null,
    knowledgeTimeUpperBound: '2026-01-03T00:00:00.000Z',
    sourceTimestampEvidenceId: null, providerRevisionId: null,
    ...overrides,
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    assert.doesNotMatch(String(error), /TypeError/);
    return true;
  });
}

test('L3-I2 candidate union fails closed on ambiguity, cross-variant fields and missing parent', () => {
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(
    candidateValue({ candidateKind: 'UNKNOWN' })), 'MARKET_DATA_CANDIDATE_DISCRIMINATION_FAILED');
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(
    candidateValue({ restoredObservationId: ID_D })), 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
  const revision = candidateValue({ candidateKind: 'BAR_VALUE_REVISION' });
  delete revision.targetCorrectionId;
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(revision),
    'MARKET_DATA_CORRECTION_PARENT_REQUIRED');
  const withdrawal = candidateValue({ candidateKind: 'BAR_WITHDRAWAL', targetCorrectionId: ID_D });
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(withdrawal),
    'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
});

test('L3-I2 temporal candidate shape distinguishes required, invalid and invalid-mode diagnostics', () => {
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(
    candidateValue({ knowledgeMode: 'WALL_CLOCK' })), 'MARKET_DATA_KNOWLEDGE_MODE_INVALID');
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(
    candidateValue({ knowledgeTimeUpperBound: null })), 'MARKET_DATA_CANDIDATE_SHAPE_INVALID');
  expectCode(() => Candidate.normalizeMarketDataNormalizedCandidateV1(
    candidateValue({ providerRevisionId: '' })), 'MARKET_DATA_KNOWLEDGE_BOUNDS_INVALID');
});

test('L3-I2 correction variants reject protocol contamination and impossible reference cardinalities', () => {
  expectCode(() => Revision.normalizeMarketDataBarCorrectionCoreV1(
    correctionValue({ correctionKind: 'WITHDRAWAL', parentCorrectionId: ID_D })),
  'MARKET_DATA_CORRECTION_CHAIN_INVALID');
  expectCode(() => Revision.normalizeMarketDataBarCorrectionCoreV1(correctionValue({
    correctionKind: 'SESSION_DATE_WITHDRAWAL', parentCorrectionId: ID_D,
    observationId: null, sessionDateLink: {
      previousBarIdentityId: ID_A, nextBarIdentityId: ID_B, withdrawalCorrectionId: null,
    },
  })), 'MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION');
  expectCode(() => Revision.normalizeMarketDataBarCorrectionCoreV1(correctionValue({
    correctionKind: 'SESSION_DATE_REPLACEMENT', parentCorrectionId: null,
    sessionDateLink: {
      previousBarIdentityId: ID_A, nextBarIdentityId: null, withdrawalCorrectionId: null,
    },
  })), 'MARKET_DATA_SESSION_DATE_PROTOCOL_VIOLATION');
});

test('L3-I2 ValidationReport closes decisions, dispositions, reason codes and diagnostics', () => {
  const report = {
    schemaVersion: Candidate.MARKET_DATA_VALIDATION_REPORT_SCHEMA_VERSION,
    candidateSetId: ID_A, ingestionPolicyId: ID_B,
    baseIngestionRegistryManifestId: ID_C, expectedParentIngestionManifestId: null,
    decisions: [{ candidateId: ID_D, disposition: 'ACCEPTED', reasonCodes: [] }],
    fatalErrors: [], warnings: [],
  };
  assert.deepEqual(Candidate.normalizeMarketDataValidationReportV1(report), report);
  expectCode(() => Candidate.normalizeMarketDataValidationReportV1({ ...report,
    decisions: [...report.decisions, ...report.decisions] }), 'MARKET_DATA_VALIDATION_FAILED');
  expectCode(() => Candidate.normalizeMarketDataValidationReportV1({ ...report,
    decisions: [{ ...report.decisions[0], disposition: 'REJECTED' }] }), 'MARKET_DATA_VALIDATION_FAILED');
  expectCode(() => Candidate.normalizeMarketDataValidationReportV1({ ...report,
    fatalErrors: ['UNREGISTERED_ERROR'] }), 'MARKET_DATA_VALIDATION_FAILED');
});

test('L3-I2 temporary adversarial harness runs at least 25 independent fail-closed scenarios', () => {
  const root = mkdtempSync(join(tmpdir(), 'market-data-l3-i2-'));
  const harnessPath = join(root, 'counter-harness.mjs');
  const candidateUrl = pathToFileURL(resolve('research/directional-lab/src/contracts/marketDataCandidateL3V1.mjs')).href;
  const revisionUrl = pathToFileURL(resolve('research/directional-lab/src/contracts/marketDataBarRevisionL3V1.mjs')).href;
  const deltaUrl = pathToFileURL(resolve('research/directional-lab/src/contracts/marketDataDeltaL3V1.mjs')).href;
  const source = `
import assert from 'node:assert/strict';
import * as C from ${JSON.stringify(candidateUrl)};
import * as R from ${JSON.stringify(revisionUrl)};
import * as D from ${JSON.stringify(deltaUrl)};
const A=${JSON.stringify(ID_A)},B=${JSON.stringify(ID_B)},C0=${JSON.stringify(ID_C)},D0=${JSON.stringify(ID_D)};
const V=${JSON.stringify(VALUES)};
const cv=(o={})=>({schemaVersion:C.MARKET_DATA_NORMALIZED_CANDIDATE_SCHEMA_VERSION,candidateKind:'BAR_INITIAL_VALUE',ingestionLineageId:A,sourceArtifactId:B,acquisitionRecordId:C0,parseResultId:D0,sourceRowIndex:0,sourceRowDigest:A,knowledgeMode:'CAPTURE_TIME_ONLY',knowledgeTimeLowerBound:null,knowledgeTimeUpperBound:'2026-01-03T00:00:00.000Z',sourceTimestampEvidenceId:null,providerRevisionId:null,calendarRegistryManifestId:B,marketValidTime:'2026-01-02T21:00:00.000Z',barIdentityId:C0,targetCorrectionId:null,replacementValues:V,...o});
const rv=(o={})=>({schemaVersion:R.MARKET_DATA_BAR_CORRECTION_CORE_SCHEMA_VERSION,correctionKind:'INITIAL_ROOT',ingestionLineageId:A,barIdentityId:B,parentCorrectionId:null,observationId:C0,restoredObservationId:null,sessionDateLink:null,sourceArtifactId:C0,acquisitionRecordId:D0,parseResultId:A,sourceRowIndex:0,sourceRowDigest:B,knowledgeMode:'CAPTURE_TIME_ONLY',knowledgeTimeLowerBound:null,knowledgeTimeUpperBound:'2026-01-03T00:00:00.000Z',sourceTimestampEvidenceId:null,providerRevisionId:null,...o});
const chunk=(o={})=>({schemaVersion:D.NORMALIZED_MARKET_DATA_DELTA_CHUNK_SCHEMA_VERSION,ingestionLineageId:A,chunkIndex:0,fromSessionDate:'2026-01-02',toSessionDateExclusive:'2026-01-03',observationIds:[B],correctionIds:[],...o});
const scenarios=[
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({candidateKind:'BAD'})),
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({alien:true})),
()=>{const x=cv({candidateKind:'BAR_VALUE_REVISION'});delete x.targetCorrectionId;return C.normalizeMarketDataNormalizedCandidateV1(x)},
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({candidateKind:'BAR_WITHDRAWAL',targetCorrectionId:D0})),
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({candidateKind:'BAR_RESTORATION',targetWithdrawalCorrectionId:D0,restoredObservationId:B})),
()=>C.normalizeMarketDataReplacementValuesV1({...V,closeAtoms:undefined}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,highAtoms:'999'}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,lowAtoms:'1150'}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,openAtoms:'10.5'}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,priceScale:-1}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,priceScale:19}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,volumeAtoms:null,volumeScale:0}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,volumeAtoms:'-1'}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,currency:'usd'}),
()=>C.normalizeMarketDataReplacementValuesV1({...V,priceBasis:'TOTAL_RETURN'}),
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({knowledgeMode:'BAD'})),
()=>C.normalizeMarketDataNormalizedCandidateV1(cv({knowledgeTimeUpperBound:null})),
()=>R.normalizeMarketDataBarCorrectionCoreV1(rv({correctionKind:'BAD'})),
()=>R.normalizeMarketDataBarCorrectionCoreV1(rv({parentCorrectionId:D0})),
()=>R.normalizeMarketDataBarCorrectionCoreV1(rv({correctionKind:'WITHDRAWAL',parentCorrectionId:D0})),
()=>R.normalizeMarketDataBarCorrectionCoreV1(rv({correctionKind:'RESTORATION',parentCorrectionId:D0,observationId:null})),
()=>R.normalizeMarketDataBarCorrectionCoreV1(rv({correctionKind:'SESSION_DATE_WITHDRAWAL',parentCorrectionId:D0,observationId:null,sessionDateLink:null})),
()=>R.normalizeMarketDataAcceptedCandidatePublicationManifestV1({schemaVersion:R.MARKET_DATA_ACCEPTED_CANDIDATE_PUBLICATION_MANIFEST_SCHEMA_VERSION,candidateSetId:A,validationReportId:B,baseIngestionRegistryManifestId:C0,expectedParentIngestionManifestId:null,ingestionLineageId:D0,publications:[]}),
()=>D.normalizeNormalizedMarketDataDeltaChunkV1(chunk({observationIds:[],correctionIds:[]})),
()=>D.normalizeNormalizedMarketDataDeltaChunkV1(chunk({observationIds:[B,B]})),
()=>D.normalizeNormalizedMarketDataDeltaChunkV1(chunk({toSessionDateExclusive:'2026-01-02'})),
()=>D.normalizeNormalizedMarketDataDeltaAssemblyManifestV1({schemaVersion:D.NORMALIZED_MARKET_DATA_DELTA_ASSEMBLY_MANIFEST_SCHEMA_VERSION,ingestionLineageId:A,candidateSetId:B,validationReportId:C0,publicationManifestId:D0,chunkIds:[A],acceptedObservationIds:[],acceptedCorrectionIds:[],coverageFromDate:'2026-01-02',coverageToDateExclusive:'2026-01-03',acceptedCandidateCount:0})
];
let passed=0;for(const scenario of scenarios){assert.throws(scenario);passed+=1}console.log(JSON.stringify({scenarios:scenarios.length,passed}));
`;
  writeFileSync(harnessPath, source, 'utf8');
  const run = spawnSync(process.execPath, [harnessPath], { encoding: 'utf8' });
  try {
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim());
    assert.equal(result.scenarios, 27);
    assert.equal(result.passed, 27);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L3-I2 deterministic modules contain no network, wall-clock, legacy calendar or physical-path authority', () => {
  const files = [
    'research/directional-lab/src/contracts/marketDataCandidateL3V1.mjs',
    'research/directional-lab/src/contracts/marketDataBarRevisionL3V1.mjs',
    'research/directional-lab/src/contracts/marketDataDeltaL3V1.mjs',
  ];
  const source = files.map((file) => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(source, /\bfetch\s*\(|Yahoo|IBKR|Date\.now\s*\(|marketSession\.mjs|https?:\/\//i);
  assert.doesNotMatch(source, /process\.cwd|import\.meta\.url|[A-Za-z]:\\/);
});
