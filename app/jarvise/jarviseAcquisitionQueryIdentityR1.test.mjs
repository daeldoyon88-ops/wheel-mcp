/**
 * P3 acquisition identity coverage. Nothing in this suite reaches a provider,
 * a socket or the wall clock: every assertion is derived from published bytes.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ACQUISITION_METHOD,
  ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION,
  EVENTS_POLICY,
  acquisitionKeyFor,
  buildAcquisitionRequestIdentityR1,
  buildJarviseAcquisitionPlanR1,
  computeJarviseCorporateActionPolicyHashR1,
  computeJarviseTransformImplementationHashR1,
  enumerateJarviseCohortR1,
  loadJarviseAcquisitionWindowR1,
  loadJarviseCohortBindingR1,
} from './jarviseAcquisitionQueryIdentityR1.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CALENDAR_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];

const readJson = (relativePath) => JSON.parse(readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8'));
const sha256 = (relativePath) => createHash('sha256')
  .update(readFileSync(new URL(`../../${relativePath}`, import.meta.url)))
  .digest('hex');

function allPinnedSessions() {
  const sessions = [];
  for (const year of CALENDAR_YEARS) {
    sessions.push(...readJson(`data/jarvise/session-calendar-historical/XNYS/${year}/session-calendar-core.json`).sessions);
  }
  sessions.sort((left, right) => left.sessionDate.localeCompare(right.sessionDate, 'en'));
  return sessions;
}

test('P3-T1 the ratified window is pinned and never derived from a runtime clock', () => {
  const acquisitionWindow = loadJarviseAcquisitionWindowR1({ root: REPOSITORY_ROOT });
  assert.equal(acquisitionWindow.acquisitionCutoffSessionDate, '2026-09-04');
  assert.equal(acquisitionWindow.acquisitionCutoffUtc, '2026-09-04T20:00:00.000Z');
  assert.equal(acquisitionWindow.period1, '2018-01-01T00:00:00.000Z');
  assert.equal(acquisitionWindow.period2, '2026-09-05T00:00:00.000Z');
  assert.equal(acquisitionWindow.interval, '1d');
  assert.equal(acquisitionWindow.runtimeWallClockDerivation, 'FORBIDDEN');
  assert.equal(acquisitionWindow.cutoffDerivation, 'PINNED_CANONICAL_SESSION_CLOSE_UTC');
  assert.equal(
    acquisitionWindow.calendarWindowBindingId,
    '3fe7456e03175fc49fb8af810d2050e58f34d2e3d548b27ad071db8957882308',
  );
});

test('P3-T2 the window spans exactly 2183 pinned sessions and its cutoff close comes from calendar bytes', () => {
  const acquisitionWindow = loadJarviseAcquisitionWindowR1({ root: REPOSITORY_ROOT });
  const sessions = allPinnedSessions();
  const inWindow = sessions.filter((session) => session.sessionDate >= acquisitionWindow.firstSessionDate
    && session.sessionDate <= acquisitionWindow.lastSessionDate);

  assert.equal(inWindow.length, 2183);
  assert.equal(inWindow.length, acquisitionWindow.expectedSessionCount);
  assert.equal(inWindow[0].sessionDate, '2018-01-02');
  assert.equal(inWindow.at(-1).sessionDate, '2026-09-04');
  assert.equal(inWindow.at(-1).closeUtc, acquisitionWindow.acquisitionCutoffUtc);

  const halfDays = inWindow.filter((session) => session.sessionKind === 'HALF_DAY_SESSION');
  assert.equal(halfDays.length, acquisitionWindow.expectedHalfDaySessionCount);

  const afterCutoff = sessions.filter((session) => session.sessionDate > acquisitionWindow.lastSessionDate);
  assert.equal(afterCutoff.length, acquisitionWindow.sessionsExcludedAfterCutoff);
  assert.ok(afterCutoff.length > 0, 'calendar coverage deliberately extends past the acquisition cutoff');

  const digest = createHash('sha256')
    .update(`${inWindow.map((session) => session.sessionDate).join('\n')}\n`, 'utf8')
    .digest('hex');
  assert.equal(digest, acquisitionWindow.sessionDateListSha256);
});

test('P3-T3 the cohort is exactly the 802 content-addressed identities', () => {
  const cohort = loadJarviseCohortBindingR1({ root: REPOSITORY_ROOT });
  assert.equal(cohort.expectedInstrumentCount, 802);
  assert.equal(cohort.registryManifestId, 'sha256:cdcb86d15d0a286d0eb02ee5af7ae5259b26a799c22a91517a610f796d6a3aa0');
  assert.equal(cohort.authorityPolicyId, 'sha256:a83a34cb6b1d30b2248a7501047a18abc83b23e5132c20af3f15edf3434df071');
  assert.equal(cohort.namespacePolicyId, 'sha256:747e1108bfb68086fb6d81cd09ad61b1fa5a93cde18f787dc48c8139884ee897');
  assert.equal(cohort.runtimeSymbolEnumeration, 'FORBIDDEN');
  assert.equal(cohort.excludedUnresolvedKindCount, 122);

  const members = enumerateJarviseCohortR1({ root: REPOSITORY_ROOT, cohort });
  assert.equal(members.length, 802);
  assert.equal(new Set(members.map((member) => member.symbol)).size, 802);
  for (const member of members) assert.equal(member.aliasValidFrom, '2026-05-03');

  const digest = createHash('sha256').update(
    `${members.map((m) => `${m.symbol}|${m.instrumentIdentityId}|${m.identityManifestId}`).join('\n')}\n`,
    'utf8',
  ).digest('hex');
  assert.equal(digest, cohort.cohortBindingSha256);
});

test('P3-T4 the enumerated cohort agrees with the identity-store projection', () => {
  const members = enumerateJarviseCohortR1({ root: REPOSITORY_ROOT });
  const projection = readJson('data/jarvise/instrument-identity/identity-store.json');
  assert.equal(projection.authoritative, false);
  assert.deepEqual(
    members.map((member) => member.symbol),
    projection.identities.map((identity) => identity.symbol).sort((a, b) => a.localeCompare(b, 'en')),
  );
});

test('P3-T5 acquisition keys are deterministic, unique and cover the whole cohort', () => {
  const first = buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  const second = buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  assert.equal(first.acquisitionKeyCount, 802);
  assert.deepEqual(
    first.entries.map((entry) => entry.acquisitionKey),
    second.entries.map((entry) => entry.acquisitionKey),
  );
  assert.equal(new Set(first.entries.map((entry) => entry.acquisitionKey)).size, 802);
  for (const entry of first.entries) {
    assert.equal(entry.acquisitionRequestIdentity.schemaVersion, ACQUISITION_REQUEST_IDENTITY_SCHEMA_VERSION);
    assert.equal(entry.acquisitionRequestIdentity.interval, '1d');
    assert.equal(entry.acquisitionRequestIdentity.priceBasis, 'SPLIT_ADJUSTED');
    assert.equal(entry.acquisitionRequestIdentity.vintageClaim, 'NONE');
    assert.equal(entry.acquisitionRequestIdentity.retrospectiveSemantics, 'RETROSPECTIVE_RECONSTRUCTION');
    assert.equal(entry.acquisitionRequestIdentity.sourceRepresentation, 'CANONICAL_PROVIDER_RESULT_BYTES');
  }
});

test('P3-T6 the request identity binds every field the ratified decisions require', () => {
  const plan = buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  const identity = plan.entries[0].acquisitionRequestIdentity;
  for (const field of [
    'sourceBindingId', 'sourceId', 'plane', 'sourceBasisDeclarationSha256', 'providerId',
    'providerLibrary', 'providerLibraryVersion', 'providerSymbol', 'instrumentIdentityId',
    'identityManifestId', 'registryManifestId', 'period1', 'period2', 'acquisitionCutoffUtc',
    'interval', 'priceBasis', 'corporateActionTreatment', 'eventsPolicy', 'calendarWindowBindingId',
    'calendarNamespaceVersion', 'sessionInterpretation', 'authorityId', 'canonicalSerializationVersion',
  ]) {
    assert.ok(identity[field] !== undefined && identity[field] !== null, `${field} must be bound`);
  }
  assert.equal(identity.sourceId, 'YAHOO_CHART_EOD');
  assert.equal(identity.canonicalSerializationVersion, 'CanonicalJSON/1');
  assert.equal(
    identity.sourceBasisDeclarationSha256,
    'fb9e5a17f4ef5503c58e2f2beac49fe3c3f035f3525b06fe282a13a60540364b',
  );
  assert.equal(identity.sourceBasisDeclarationSha256, sha256('app/jarvise/yahooSourceBasisDeclarationR1.json'));
  assert.deepEqual(identity.eventsPolicy, { splits: true, dividends: true, otherEventFamilies: false });
  assert.equal(ACQUISITION_METHOD, 'YAHOO_CHART_EOD_FETCH_ONCE');
});

test('P3-T7 a different events policy yields a different acquisition key', () => {
  const plan = buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  const baseline = plan.entries[0];
  const altered = buildAcquisitionRequestIdentityR1({
    member: baseline.member,
    acquisitionWindow: plan.acquisitionWindow,
    cohort: plan.cohort,
    sourceBasisDeclarationSha256: plan.sourceBasisDeclarationSha256,
    calendarWindowBindingId: plan.acquisitionWindow.calendarWindowBindingId,
    calendarNamespaceVersion: plan.acquisitionWindow.calendarNamespaceVersion,
    eventsPolicy: { splits: true, dividends: false, otherEventFamilies: false },
  });
  assert.notEqual(acquisitionKeyFor(altered), baseline.acquisitionKey);
  assert.deepEqual(EVENTS_POLICY, { splits: true, dividends: true, otherEventFamilies: false });
});

test('P3-T8 a different cutoff yields a different acquisition key', () => {
  const plan = buildJarviseAcquisitionPlanR1({ root: REPOSITORY_ROOT });
  const baseline = plan.entries[0];
  const altered = buildAcquisitionRequestIdentityR1({
    member: baseline.member,
    acquisitionWindow: { ...plan.acquisitionWindow, acquisitionCutoffUtc: '2026-09-03T20:00:00.000Z', period2: '2026-09-04T00:00:00.000Z' },
    cohort: plan.cohort,
    sourceBasisDeclarationSha256: plan.sourceBasisDeclarationSha256,
    calendarWindowBindingId: plan.acquisitionWindow.calendarWindowBindingId,
    calendarNamespaceVersion: plan.acquisitionWindow.calendarNamespaceVersion,
  });
  assert.notEqual(acquisitionKeyFor(altered), baseline.acquisitionKey);
});

test('P3-T9 corporateActionPolicyHash is a real recomputed hash, not a placeholder', () => {
  const declaration = readJson('app/jarvise/jarviseCorporateActionPolicyBindingR1.json');
  const computed = computeJarviseCorporateActionPolicyHashR1({ root: REPOSITORY_ROOT });
  assert.equal(declaration.placeholder, false);
  assert.equal(computed.corporateActionPolicyHash, declaration.corporateActionPolicyHash);
  assert.match(computed.corporateActionPolicyHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(computed.preimage, declaration.preimage);
  assert.equal(
    computed.preimage.corporateActionPolicyModuleSha256,
    `sha256:${sha256('research/directional-lab/src/data/corporateActionPolicy.mjs')}`,
  );
  const placeholder = `sha256:${createHash('sha256').update('jarvise-corporate-action-policy', 'utf8').digest('hex')}`;
  assert.notEqual(computed.corporateActionPolicyHash, placeholder);
});

test('P3-T10 transformImplementationHash is a real recomputed hash, not a placeholder', () => {
  const declaration = readJson('app/jarvise/jarviseTransformImplementationManifestR1.json');
  const computed = computeJarviseTransformImplementationHashR1({ root: REPOSITORY_ROOT });
  assert.equal(declaration.placeholder, false);
  assert.equal(computed.transformImplementationHash, declaration.transformImplementationHash);
  assert.match(computed.transformImplementationHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(computed.manifest, declaration.manifest);
  for (const module of computed.manifest.modules) {
    assert.equal(module.contentSha256, `sha256:${sha256(module.logicalPath)}`);
  }
  const placeholder = `sha256:${createHash('sha256').update('jarvise-transform-implementation', 'utf8').digest('hex')}`;
  assert.notEqual(computed.transformImplementationHash, placeholder);
});

test('P3-T11 the published P2 pinned-session transform bytes are unmodified', () => {
  const computed = computeJarviseTransformImplementationHashR1({ root: REPOSITORY_ROOT });
  const pinnedModule = computed.manifest.modules.find((module) => module.logicalPath === 'app/jarvise/pinnedSessionTimestampsR1.mjs');
  assert.equal(
    pinnedModule.contentSha256,
    'sha256:3fbbcc69ff7a2debbf077fbfb4052bdb51ddb22b77571242b47140ea0ef85757',
  );
});

test('P3-T12 the historical identity boundary is untouched and RAW is not observation admission', () => {
  const policy = readJson('app/jarvise/jarviseHistoricalIdentityPolicyR1.json');
  assert.equal(policy.currentAliasValidFrom, '2026-05-03');
  assert.equal(policy.earliestAdmissibleSession, '2026-05-04');
  assert.equal(policy.aliasBackdating, 'FORBIDDEN');
  assert.equal(policy.retroactive2026IdentityApplication, 'FORBIDDEN');
  assert.equal(policy.historicalAliasEvidenceBeforeValidFrom, 'SEPARATE_FUTURE_PROGRAM_REQUIRED');
  assert.equal(policy.failureMode, 'FAIL_CLOSED');

  const cohort = loadJarviseCohortBindingR1({ root: REPOSITORY_ROOT });
  const acquisitionWindow = loadJarviseAcquisitionWindowR1({ root: REPOSITORY_ROOT });
  assert.equal(cohort.observationAdmissionScope, 'GOVERNED_SEPARATELY_BY_jarviseHistoricalIdentityPolicyR1');
  assert.ok(
    acquisitionWindow.firstSessionDate < policy.earliestAdmissibleSession,
    'raw acquisition deliberately starts before the earliest observation-admissible session',
  );

  const authority = readJson('app/jarvise/jarviseFetchOnceExecutionAuthorityR1.json');
  assert.equal(authority.observationAdmissionAuthorized, false);
});

test('P3-T13 no P3 artifact claims point-in-time vintage or emits a GATE24 V2 regime', () => {
  const artifacts = [
    'app/jarvise/jarviseHistoricalAcquisitionWindowR1.json',
    'app/jarvise/jarviseHistoricalCohortBindingR1.json',
    'app/jarvise/jarviseCorporateActionPolicyBindingR1.json',
    'app/jarvise/jarviseTransformImplementationManifestR1.json',
    'app/jarvise/jarviseFetchOnceExecutionAuthorityR1.json',
    'app/jarvise/jarviseAcquisitionQueryIdentityR1.mjs',
    'app/jarvise/jarviseYahooChartAdapterR1.mjs',
    'app/jarvise/jarviseYahooFetchOnceAcquirerR1.mjs',
    'scripts/runJarviseHistoricalFetchOnceR1.mjs',
  ];
  for (const artifact of artifacts) {
    const text = readFileSync(new URL(`../../${artifact}`, import.meta.url), 'utf8');
    assert.ok(!text.includes('POINT_IN_TIME_VINTAGE'), `${artifact} must not claim point-in-time vintage`);
    // RegimeRecord may be named in a prohibition, but never constructed: no
    // artifact may bind the schema version or import a regime emitter.
    assert.ok(!/RegimeRecord\s*\//.test(text), `${artifact} must not bind a RegimeRecord schema version`);
    assert.ok(!/regimeRecord\s*[:=]/i.test(text), `${artifact} must not construct a RegimeRecord value`);
    assert.ok(!/import[^;]*[Rr]egime/.test(text), `${artifact} must not import a regime emitter`);
  }
  const calendarBinding = readJson('app/jarvise/jarviseHistoricalCalendarBindingR1.json');
  assert.equal(calendarBinding.gate24RegimeRecordEmission, 'FORBIDDEN_UNDER_CALENDAR_V2');
  assert.equal(calendarBinding.historicalProcessingBoundary, 'OBSERVATION_FEATURE');
});

test('P3-T14 no P3 module constructs a provider client or imports the network adapter at module scope', () => {
  for (const artifact of [
    'app/jarvise/jarviseAcquisitionQueryIdentityR1.mjs',
    'app/jarvise/jarviseYahooChartAdapterR1.mjs',
    'app/jarvise/jarviseYahooFetchOnceAcquirerR1.mjs',
  ]) {
    const text = readFileSync(new URL(`../../${artifact}`, import.meta.url), 'utf8');
    assert.ok(!/^import .*yahoo-finance2/m.test(text), `${artifact} must not import yahoo-finance2`);
    assert.ok(!text.includes('new YahooFinance'), `${artifact} must not construct a provider client`);
    assert.ok(!text.includes('fetch('), `${artifact} must not call fetch`);
  }
});
