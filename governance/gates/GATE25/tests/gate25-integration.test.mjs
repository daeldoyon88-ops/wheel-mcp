/**
 * GATE25 real P3H integration.
 *
 * Consumes the frozen P3H product read-only: 793 admitted keys by content address,
 * the 9 documented exclusions, the pinned historical calendar and the verified
 * instrument identity registry. No fetch, no repair, no fabrication.
 *
 * Two independent child processes prepare the universe and run the same anchors
 * with every network surface trapped; the parent compares their outputs and checks
 * them against counts recomputed here from the finalization and the calendar. The
 * identity resolver is cross-checked against the official as-of resolver, and the
 * trailing-window features against GATE23 resolveTrailingWindow + simpleReturn.
 *
 * Engine correctness only: nothing here measures or claims trading performance.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const THIS_FILE = fileURLToPath(import.meta.url);
const QUERY_SYMBOL = 'AAPL';
const ANCHOR_END = '2026-09-04';
const ANCHOR_MID_FROM = '2026-06-01';
const ANCHOR_PRE_ALIAS = '2024-06-03';
const SUMMARY_PREFIX = 'GATE25_INTEGRATION_SUMMARY ';

/* ------------------------------------------------------------------------ child */

async function runChild() {
  const networkCalls = [];
  const trap = (name) => () => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();

  const engine = await import('../implementation/historical-analogue-engine-v1.mjs');
  const { sha256Canonical } = await import('../../../tools/canonical-json.mjs');
  const { serializeAnalogueIndex, analogueIndexSha256 } = await import('../implementation/analogue-index-v1.mjs');
  const { simpleReturn } = await import('../../GATE23/implementation/feature-families-v1.mjs');
  const { createFeatureWindowSpec, resolveTrailingWindow } = await import('../../GATE23/implementation/feature-window-v1.mjs');
  const { computeJarviseHistoricalCalendarBindingR1, loadJarviseHistoricalCalendarR1 } = await import('../../../../app/jarvise/jarviseHistoricalCalendarBindingR1.mjs');

  const started = process.hrtime.bigint();
  const authority = engine.loadGate25BuildAuthority({ root: ROOT });
  const p3h = engine.loadP3hDatasetBinding({ authority });
  const calendar = engine.loadHistoricalWindowCalendar({ authority, root: ROOT });
  const policy = engine.bindR0003SelectionPolicy({ authority, p3h, calendar });
  const identityResolver = engine.createRegistryHistoricalIdentityResolver({ root: ROOT });
  const prepared = engine.prepareP3hHistoricalUniverse({ p3h, calendar, identityResolver });
  const { foundation, described } = engine.bindPublishedHistoricalRegimeFoundation({ authority, root: ROOT });
  const universe = engine.attachPublishedFoundationProjections({ universe: prepared, foundation });
  const preparedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const queryKey = universe.keys.find((key) => key.providerSymbol === QUERY_SYMBOL && key.exclusionClass === null);
  const midSession = universe.sessions.find((session) => session.sessionDate >= ANCHOR_MID_FROM);
  let supportedSessionDate = null;
  for (const members of universe.coreV1ClassifyingGroups.values()) {
    const sameInstrument = members.filter((member) => member.acquisitionKey === queryKey.acquisitionKey)
      .sort((left, right) => (left.sessionDate < right.sessionDate ? -1 : left.sessionDate > right.sessionDate ? 1 : 0));
    if (sameInstrument.length >= 3) {
      supportedSessionDate = sameInstrument[sameInstrument.length - 1].sessionDate;
      break;
    }
  }
  const anchors = {};
  let endSelection = null;
  let productSelection = null;
  const namedAnchors = [['end', ANCHOR_END], ['mid', midSession.sessionDate], ['preAlias', ANCHOR_PRE_ALIAS]];
  if (supportedSessionDate !== null) namedAnchors.push(['supported', supportedSessionDate]);
  for (const [name, sessionDate] of namedAnchors) {
    try {
      const query = engine.buildP3hQuery({ universe, acquisitionKey: queryKey.acquisitionKey, sessionDate });
      const selection = engine.runAnalogueSelection({
        authority, policy, query, candidates: engine.iterateP3hCandidates(universe), historicalOutcomeUniverse: universe,
      });
      const nonClassifyingCommonFactors = (selection.comparisonReport.analogues ?? []).flatMap((entry) => (
        (entry.commonFactors ?? []).filter((factor) => factor.value === 'INFLATION_INSUFFICIENT_DATA'
          || factor.value === 'NOT_AVAILABLE'
          || factor.value === 'INSUFFICIENT_DATA'
          || factor.value === 'REGIME_INSUFFICIENT_DATA'
          || factor.value === 'UNKNOWN'
          || factor.value === 'REGIME_UNKNOWN'
          || factor.value === 'INFLATION_UNKNOWN'
          || factor.value === 'RATES_UNKNOWN'
          || factor.value === 'RATES_INSUFFICIENT_DATA')
      ));
      const outcomeAvailable = selection.outcomeSet.records.filter((record) => record.outcomeStatus === 'AVAILABLE').length;
      const outcomeMissing = selection.outcomeSet.records.filter((record) => record.outcomeStatus === 'MISSING').length;
      anchors[name] = {
        sessionDate,
        code: 'SELECTION_COMPLETED',
        queryIdentityStatus: query.instrumentIdentity.status,
        queryFeatureStatuses: Object.values(query.features).map((feature) => feature?.status ?? null),
        queryIdentityId: selection.queryIdentity.analogueIdentityId,
        queryAllCoreV1Classifying: selection.accounting.structuralGatesPass || selection.supportReport.structuralGatesPass,
        accounting: selection.accounting,
        supportReport: {
          supportStatus: selection.supportReport.supportStatus,
          decision: selection.supportReport.decision,
          abstainReason: selection.supportReport.abstainReason,
          structuralGatesPass: selection.supportReport.structuralGatesPass,
          eligibleCount: selection.supportReport.eligibleCount,
          universeCount: selection.supportReport.universeCount,
        },
        eligibleCount: selection.accounting.eligibleCount,
        supportStatus: selection.supportReport.supportStatus,
        decision: selection.supportReport.decision,
        selectionDigest: selection.frozenSelection.selectionDigest,
        analogueCount: selection.comparisonReport.analogues.length,
        nonClassifyingCommonFactorCount: nonClassifyingCommonFactors.length,
        outcomeAvailable,
        outcomeMissing,
        outcomeRecordCount: selection.outcomeSet.records.length,
        horizonCount: selection.horizonBindings.length,
      };
      if (name === 'end') endSelection = selection;
      if (name === 'supported' || (name === 'end' && productSelection === null)) productSelection = selection;
    } catch (error) {
      let queryIdentityStatus = null;
      let queryFeatureStatuses = null;
      try {
        const query = engine.buildP3hQuery({ universe, acquisitionKey: queryKey.acquisitionKey, sessionDate });
        queryIdentityStatus = query.instrumentIdentity.status;
        queryFeatureStatuses = Object.values(query.features).map((feature) => feature?.status ?? null);
      } catch {
        queryIdentityStatus = 'QUERY_BUILD_FAILED';
      }
      anchors[name] = {
        sessionDate,
        code: error.code ?? error.message,
        queryIdentityStatus,
        queryFeatureStatuses,
        missingMembers: error.details?.missingMembers ?? null,
        accounting: error.details?.accounting ?? null,
        supportReport: error.details?.supportReport ?? null,
        supportReportId: error.details?.supportReportId ?? null,
      };
    }
  }

  const builtIndex = engine.buildAnalogueIndexFromCandidates({ policy, candidates: engine.iterateP3hCandidates(universe) });
  const indexText = serializeAnalogueIndex(builtIndex.index);
  const products = (productSelection ?? endSelection) === null ? null : engine.materializeCanonicalProducts({
    store: engine.createCanonicalProductStore({ root: ROOT }),
    index: builtIndex.index,
    selection: productSelection ?? endSelection,
    policy,
  });

  /* GATE23 cross-check for every session of the query key, from its own content-addressed bars. */
  const entry = p3h.admittedEntries.find((item) => item.acquisitionKey === queryKey.acquisitionKey);
  const snapshot = engine.readP3hAdmittedSnapshot({ snapshotRoot: p3h.snapshotRoot, entry });
  const calendarWindowBinding = computeJarviseHistoricalCalendarBindingR1({ root: ROOT });
  const allSessions = loadJarviseHistoricalCalendarR1({ root: ROOT }).sessions;
  const windowSessions = allSessions.filter((session) => session.sessionDate >= '2018-01-02' && session.sessionDate <= '2026-09-04');
  const barsByDate = new Map(snapshot.bars.map((bar) => [bar.sessionDate, bar]));
  let featureChecks = 0;
  let featureMismatches = 0;
  for (const [featureId, sessionCount] of [['F1_SIMPLE_RETURN@W5', 5], ['F1_SIMPLE_RETURN@W21', 21]]) {
    const spec = createFeatureWindowSpec({ sessionCount, calendarWindowBinding });
    windowSessions.forEach((session) => {
      const window = resolveTrailingWindow({ sessionDate: session.sessionDate, featureWindowSpec: spec, calendarWindowBinding, sessions: windowSessions });
      let expected;
      if (window.status === 'INSUFFICIENT_DATA') expected = { status: 'INSUFFICIENT_DATA', value: null };
      else {
        const bars = window.sessions.map((item) => barsByDate.get(item.sessionDate));
        expected = bars.some((bar) => bar === undefined)
          ? { status: 'FAIL_CLOSED', value: null }
          : (() => { const computed = simpleReturn(bars.map((bar) => bar.close)); return { status: computed.status, value: computed.value }; })();
      }
      const actual = engine.buildP3hQuery({ universe, acquisitionKey: queryKey.acquisitionKey, sessionDate: session.sessionDate }).features[featureId];
      featureChecks += 1;
      if (actual.status !== expected.status || actual.value !== expected.value) featureMismatches += 1;
    });
  }

  const summary = {
    executionContractSha256: authority.contractSha256,
    datasetId: p3h.datasetId,
    datasetSha256: p3h.datasetSha256,
    selectionPolicyVersionId: policy.selectionPolicyVersionId,
    calendarRegistryManifestId: calendar.calendarRegistryManifestId,
    universeAccounting: universe.accounting,
    identityOutcomeCount: universe.identityOutcomes.length,
    queryAcquisitionKey: queryKey.acquisitionKey,
    queryInstrumentIdentityAtEnd: engine.buildP3hQuery({ universe, acquisitionKey: queryKey.acquisitionKey, sessionDate: ANCHOR_END }).instrumentIdentity,
    anchors,
    index: { accounting: builtIndex.accounting, recordCount: builtIndex.index.records.size, sha256: analogueIndexSha256(indexText) },
    products: products === null ? null : { analogueIndexSha256: products.analogueIndexSha256, provenanceSha256: products.provenanceSha256 },
    foundationIdentities: {
      regimeHorizonSpecId: described.regimeHorizonSpecId,
      classifierVersionId: described.classifierVersionId,
      parameterSetId: described.parameterSetId,
      macroContextBindingId: described.macroContextBindingId,
    },
    foundationAccounting: universe.foundationAccounting,
    featureCrossCheck: { checks: featureChecks, mismatches: featureMismatches },
    networkCalls,
  };
  process.stdout.write(`${SUMMARY_PREFIX}${JSON.stringify({ summary, digest: sha256Canonical(summary), preparedMs })}\n`);
}

/* ----------------------------------------------------------------------- parent */

function spawnChild() {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=6144', THIS_FILE, '--child'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((item) => item.startsWith(SUMMARY_PREFIX));
      if (code !== 0 || line === undefined) reject(new Error(`CHILD_FAILED ${code}\n${stderr}\n${stdout}`));
      else resolvePromise(JSON.parse(line.slice(SUMMARY_PREFIX.length)));
    });
  });
}

async function runParent() {
  let assertions = 0;
  const check = (fn) => { fn(); assertions += 1; };

  const [first, second] = await Promise.all([spawnChild(), spawnChild()]);

  /* Deterministic output across two independent executions. */
  check(() => assert.equal(first.digest, second.digest));
  check(() => assert.deepEqual(first.summary, second.summary));
  const summary = first.summary;

  const { readFileSync } = await import('node:fs');
  const { sha256Bytes } = await import('../../../tools/canonical-json.mjs');
  const { loadJarviseHistoricalCalendarR1 } = await import('../../../../app/jarvise/jarviseHistoricalCalendarBindingR1.mjs');
  const engine = await import('../implementation/historical-analogue-engine-v1.mjs');
  const { createContentAddressedStore } = await import('../../../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs');
  const { resolveInstrumentIdentityAsOf } = await import('../../../../research/directional-lab/src/data/buildInstrumentIdentity.mjs');

  /* Independent expectations from the finalization bytes and the calendar. */
  const contract = JSON.parse(readFileSync(resolve(ROOT, 'governance/gates/GATE25/contracts/EXECUTION_CONTRACT_R0003.json'), 'utf8'));
  const scope = contract.canonicalRequirements.find((item) => item.requirementId === 'G25-BUILD-02').observationAdmissionScope;
  const mandate = JSON.parse(readFileSync(resolve(ROOT, 'governance/sources/GATE25_CANONICAL_MANDATE_R0.json'), 'utf8'));
  const finalizationBytes = readFileSync(mandate.historyPolicy.pinSet.artifactPath);
  const finalization = JSON.parse(finalizationBytes.toString('utf8'));
  const sessions = loadJarviseHistoricalCalendarR1({ root: ROOT }).sessions
    .filter((session) => session.sessionDate >= scope.historicalObservationWindow.startSessionInclusive && session.sessionDate <= scope.historicalObservationWindow.endSessionInclusive);
  const N = sessions.length;
  const keyCount = finalization.admittedEntries.length + finalization.exclusions.length;
  const universeCount = keyCount * N;
  const classCount = (reasonCode) => finalization.exclusions.filter((item) => item.reasonCode === reasonCode).length;

  /* Canonical dataset identity accepted; 793 consumed; 9 accounted for. */
  check(() => assert.equal(`sha256:${sha256Bytes(finalizationBytes)}`, scope.datasetIdentity));
  check(() => assert.equal(summary.datasetId, 'sha256:cc7bb76f37a97a5673a32c5a8f357088ee94230fefcbef1c19ad16227476488e'));
  check(() => assert.equal(summary.datasetSha256, sha256Bytes(finalizationBytes)));
  check(() => assert.equal(summary.executionContractSha256, 'f369ce7844167a5ae46940dcd1e2edd61f1b92327893723cd6953d8fafa0578f'));
  check(() => assert.equal(finalization.admittedEntries.length, 793));
  check(() => assert.equal(finalization.exclusions.length, 9));
  check(() => assert.equal(keyCount, 802));
  check(() => assert.equal(summary.universeAccounting.admittedKeysConsumed, 793));
  check(() => assert.equal(summary.universeAccounting.excludedKeysAccounted, 9));
  check(() => assert.deepEqual(summary.universeAccounting.exclusionClassCounts, { MALFORMED_PROVIDER_RESULT: classCount('MALFORMED_PROVIDER_RESULT'), SCHEMA_FAILURE: classCount('SCHEMA_FAILURE'), SNAPSHOT_CONTRACT_INVALID: classCount('SNAPSHOT_CONTRACT_INVALID') }));
  check(() => assert.equal(summary.universeAccounting.windowSessionCount, N));
  check(() => assert.equal(summary.universeAccounting.candidateCount, universeCount));
  check(() => assert.ok(summary.universeAccounting.barsConsumed > 0 && summary.universeAccounting.barsConsumed <= 793 * N));
  check(() => assert.deepEqual(summary.networkCalls, []));

  /* Identity: the query resolves at T, and never before the alias interval. */
  const identity = engine.createRegistryHistoricalIdentityResolver({ root: ROOT });
  const provenance = JSON.parse(readFileSync(resolve(ROOT, 'data/jarvise/instrument-identity/PROVENANCE.json'), 'utf8'));
  const namespace = JSON.parse(readFileSync(resolve(ROOT, 'data/jarvise/instrument-identity/symbol-namespace-policy.json'), 'utf8'));
  const store = createContentAddressedStore({ root: resolve(ROOT, 'data/jarvise/instrument-identity/cas') });
  const official = (symbol, asOfDate) => {
    try {
      const resolved = resolveInstrumentIdentityAsOf({ store, registryManifestId: provenance.registryManifestId, namespacePolicyId: provenance.namespacePolicyId, providerId: namespace.providerId, venueId: null, symbol, currency: 'USD', asOfDate });
      return { status: 'RESOLVED', instrumentIdentityId: resolved.instrumentIdentityId, resolvedAsOfSessionDate: asOfDate };
    } catch (error) {
      return { status: 'UNRESOLVED', code: error.code, resolvedAsOfSessionDate: asOfDate };
    }
  };
  const lastPreAlias = [...sessions].reverse().find((session) => session.sessionDate < '2026-05-03').sessionDate;
  const firstPostAlias = sessions.find((session) => session.sessionDate >= '2026-05-03').sessionDate;
  const excludedSymbol = finalization.exclusions.find((item) => item.reasonCode === 'SNAPSHOT_CONTRACT_INVALID').providerSymbol;
  for (const [symbol, date] of [[QUERY_SYMBOL, '2019-01-02'], [QUERY_SYMBOL, lastPreAlias], [QUERY_SYMBOL, firstPostAlias], [QUERY_SYMBOL, ANCHOR_END], [excludedSymbol, ANCHOR_END]]) {
    check(() => assert.deepEqual({ ...identity.resolveAsOf(symbol, date) }, official(symbol, date), `${symbol}@${date}`));
  }
  check(() => assert.equal(official(QUERY_SYMBOL, lastPreAlias).status, 'UNRESOLVED'));
  check(() => assert.deepEqual(summary.queryInstrumentIdentityAtEnd, official(QUERY_SYMBOL, ANCHOR_END)));
  const matchableSessions = sessions.filter((session) => session.sessionDate >= firstPostAlias).length;

  /* Features equal GATE23 window + formula on every session of the query key. */
  check(() => assert.equal(summary.featureCrossCheck.checks, 2 * N));
  check(() => assert.equal(summary.featureCrossCheck.mismatches, 0));

  const count = (accounting, reasonId) => accounting.exclusionCountsByReason.find((item) => item.reasonId === reasonId).count;
  const midIndex = sessions.findIndex((session) => session.sessionDate === summary.anchors.mid.sessionDate);
  for (const name of ['end', 'mid']) {
    const anchor = summary.anchors[name];
    const anchorIndex = sessions.findIndex((session) => session.sessionDate === anchor.sessionDate);
    const { accounting, supportReport } = anchor;
    check(() => assert.equal(anchor.code, 'SELECTION_COMPLETED'));
    check(() => assert.equal(anchor.queryIdentityStatus, 'RESOLVED'));
    check(() => assert.deepEqual(anchor.queryFeatureStatuses, ['RESOLVED', 'RESOLVED']));
    check(() => assert.match(anchor.queryIdentityId, /^[0-9a-f]{64}$/));
    check(() => assert.equal(accounting.universeCount, universeCount));
    check(() => assert.equal(accounting.eligibleCount + accounting.excludedCount, universeCount));
    check(() => assert.ok(accounting.eligibleCount >= 0, `${name} eligibleCount`));
    check(() => assert.equal(accounting.structuralGatesPass, true));
    check(() => assert.equal(supportReport.structuralGatesPass, true));
    check(() => assert.equal(anchor.nonClassifyingCommonFactorCount, 0));
    check(() => assert.equal(anchor.analogueCount, accounting.eligibleCount));
    check(() => assert.equal(anchor.outcomeRecordCount, accounting.eligibleCount * anchor.horizonCount));
    check(() => assert.equal(anchor.horizonCount, 4));
    check(() => assert.equal(anchor.outcomeAvailable + anchor.outcomeMissing, anchor.outcomeRecordCount));
    if (accounting.eligibleCount >= 2) {
      check(() => assert.equal(supportReport.supportStatus, 'SUFFICIENT_SUPPORT'));
      check(() => assert.equal(supportReport.decision, 'PROCEED'));
      check(() => assert.equal(supportReport.abstainReason, null));
    } else {
      check(() => assert.equal(supportReport.supportStatus, 'INSUFFICIENT_SUPPORT'));
      check(() => assert.equal(supportReport.decision, 'ABSTAIN'));
    }
    check(() => assert.equal(count(accounting, 'P3H_EXCLUDED_MALFORMED_PROVIDER_RESULT'), classCount('MALFORMED_PROVIDER_RESULT') * N));
    check(() => assert.equal(count(accounting, 'P3H_EXCLUDED_SCHEMA_FAILURE'), classCount('SCHEMA_FAILURE') * N));
    check(() => assert.equal(count(accounting, 'P3H_EXCLUDED_SNAPSHOT_CONTRACT_INVALID'), classCount('SNAPSHOT_CONTRACT_INVALID') * N));
    check(() => assert.equal(count(accounting, 'OUTSIDE_HISTORICAL_WINDOW'), keyCount * (N - anchorIndex)));
    check(() => assert.ok(count(accounting, 'AVAILABLE_AFTER_KNOWLEDGE_CUTOFF') >= keyCount * (N - anchorIndex - 1)));
    check(() => assert.equal(count(accounting, 'INSTRUMENT_IDENTITY_MISMATCH'), universeCount - matchableSessions));
    check(() => assert.ok(count(accounting, 'CORE_V1_REGIME_MISMATCH') < universeCount));
    check(() => assert.ok(count(accounting, 'REGIME_HORIZON_SPEC_MISMATCH') < universeCount));
    check(() => assert.ok(count(accounting, 'REQUIRED_DISTANCE_FEATURE_MISSING') >= 9 * N));
  }
  check(() => assert.ok(midIndex > 0 && midIndex < N - 1));
  for (const reasonId of ['REQUIRED_DISTANCE_FEATURE_MISSING', 'REQUIRED_DISTANCE_FEATURE_MALFORMED', 'REQUIRED_DISTANCE_FEATURE_NON_FINITE']) {
    check(() => assert.equal(count(summary.anchors.end.accounting, reasonId), count(summary.anchors.mid.accounting, reasonId)));
  }
  check(() => assert.notEqual(summary.anchors.end.accounting.decisionDigest, summary.anchors.mid.accounting.decisionDigest));
  check(() => assert.notEqual(summary.anchors.end.queryIdentityId, summary.anchors.mid.queryIdentityId));
  const supported = summary.anchors.supported;
  if (supported !== undefined) {
    check(() => assert.equal(supported.code, 'SELECTION_COMPLETED'));
    check(() => assert.ok(supported.eligibleCount >= 2));
    check(() => assert.equal(supported.decision, 'PROCEED'));
    check(() => assert.equal(supported.nonClassifyingCommonFactorCount, 0));
  } else {
    check(() => assert.ok(summary.anchors.end.eligibleCount > 0 || summary.anchors.mid.eligibleCount > 0));
  }

  /* No backdating on real data: before the alias interval the query identity itself is refused. */
  check(() => assert.equal(summary.anchors.preAlias.code, 'QUERY_INSTRUMENT_IDENTITY_NOT_RESOLVED_AT_SESSION_DATE'));
  check(() => assert.equal(summary.anchors.preAlias.queryIdentityStatus, 'UNRESOLVED'));

  /* Real foundation RegimeRecords produce a non-empty formable index. */
  check(() => assert.equal(summary.index.accounting.candidateCount, universeCount));
  check(() => assert.ok(summary.foundationAccounting.emittedCount > 0));
  check(() => assert.equal(summary.index.recordCount, summary.foundationAccounting.emittedCount));
  check(() => assert.equal(summary.index.accounting.indexedCount, summary.index.recordCount));
  check(() => assert.equal(summary.index.accounting.notFormableCount, universeCount - summary.index.recordCount));
  check(() => assert.match(summary.index.sha256, /^[0-9a-f]{64}$/));
  check(() => assert.equal(summary.products.analogueIndexSha256, summary.index.sha256));
  check(() => assert.match(summary.products.provenanceSha256, /^[0-9a-f]{64}$/));
  check(() => assert.match(summary.foundationIdentities.regimeHorizonSpecId, /^[0-9a-f]{64}$/));
  check(() => assert.match(summary.foundationIdentities.classifierVersionId, /^[0-9a-f]{64}$/));
  check(() => assert.match(summary.foundationIdentities.parameterSetId, /^[0-9a-f]{64}$/));
  check(() => assert.match(summary.foundationIdentities.macroContextBindingId, /^[0-9a-f]{64}$/));

  console.log(`GATE25_INTEGRATION_PASS ${assertions} preparedMs=${Math.round(first.preparedMs)}/${Math.round(second.preparedMs)} digest=${first.digest}`);
}

if (process.argv.includes('--child')) await runChild();
else await runParent();
