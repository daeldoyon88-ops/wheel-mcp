/**
 * GATE25 historical regime foundation R1: end-to-end prerequisite sweep.
 *
 *   real P3H observation -> F1/F2 -> macro context -> six-dimension regime vector
 *   -> RegimeRecordId -> GATE25 D1 analogue identity -> eligibility/distance input
 *
 * Two independent child processes run the full cohort with every network surface
 * trapped; the parent requires identical digests. With --gate25-build-root <path>
 * the child additionally drives the GATE25 BUILD readers found at that root, read
 * only, to prove D1 formability and eligibility input acceptance with the real
 * GATE25 code. Nothing is written except the optional --out report path.
 *
 * The "cpiSuccessor" block audits the CPI successor policy V2 on the real cohort: an
 * independent endpoints-only recomputation must agree with every emitted inflationState,
 * and every consumed CPI endpoint is checked against the genuine verified vintages
 * (fabricated / interpolated / forward-filled / future-vintage counts, October 2025).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const PREFIX = 'G25_HISTORICAL_FOUNDATION_SWEEP ';
const argValue = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };

async function runChild() {
  const networkCalls = [];
  const trap = (name) => () => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();

  const foundationModule = await import('../app/jarvise/jarviseG25HistoricalRegimeFoundationR1.mjs');
  const { simpleReturn } = await import('../governance/gates/GATE23/implementation/feature-families-v1.mjs');
  const { createFeatureWindowSpec, resolveTrailingWindow } = await import('../governance/gates/GATE23/implementation/feature-window-v1.mjs');
  const { classifyRegimeVector, resolveParameter } = await import('../governance/gates/GATE24/implementation/regime-classifier-v1.mjs');
  const { ACTIVE_DIMENSION_NAMES_V1, isClassifyingValue } = await import('../governance/gates/GATE24/implementation/regime-taxonomy-v1.mjs');
  const { computeRealizedVolatilityR1 } = await import('../app/jarvise/jarviseG25HistoricalRealizedVolatilityR1.mjs');
  const { buildMonthlyWeeklySeriesIndex, mostRecentAdmissibleReferencePeriodAsOf, resolveSeriesReferencePeriodAsOf } = await import('../research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs');
  const { addMonthsToMonthKey, macroRatioChangeFixed } = await import('../research/directional-lab/src/macro/macroFixedPointRatioL4BF2V1.mjs');
  const { fixedToNumberR1 } = await import('../app/jarvise/jarviseG25HistoricalMacroContextR1.mjs');

  const started = process.hrtime.bigint();
  const foundation = foundationModule.loadJarviseG25HistoricalRegimeFoundationR1();
  const loadMs = Number(process.hrtime.bigint() - started) / 1e6;

  const buildRoot = argValue('--gate25-build-root');
  let build = null;
  if (buildRoot !== null) {
    const url = (relative) => pathToFileURL(resolve(buildRoot, relative)).href;
    const engine = await import(url('governance/gates/GATE25/implementation/historical-analogue-engine-v1.mjs'));
    const eligibility = await import(url('governance/gates/GATE25/implementation/analogue-eligibility-v1.mjs'));
    const identity = await import(url('governance/gates/GATE25/implementation/analogue-identity-v1.mjs'));
    const authority = engine.loadGate25BuildAuthority({ root: buildRoot });
    const p3h = engine.loadP3hDatasetBinding({ authority });
    const calendar = engine.loadHistoricalWindowCalendar({ authority, root: buildRoot });
    const policy = engine.bindR0003SelectionPolicy({ authority, p3h, calendar });
    build = { engine, eligibility, identity, authority, policy };
  }

  const counts = {
    keyCount: foundation.p3h.admittedEntries.length + foundation.p3h.exclusions.length,
    windowSessionCount: foundation.windowSessions.length,
    pairCount: 0,
    byStatus: {},
    refusalByCode: {},
    refusalByIdentityCode: {},
    refusalFeatureSetDetail: {},
    refusalKeysWithoutAnyEmission: 0,
    gate25CoreV1ExactMatchPairs: { sameInstrumentOrderedPairs: 0, allWithInflationInsufficientOnBothSides: 0, keysWithAtLeastOnePair: 0 },
    emitted: 0,
    firstEmittedSession: null,
    lastEmittedSession: null,
    emittedSessionCount: 0,
    emittedKeyCount: 0,
    dimensionClassifying: Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, 0])),
    dimensionValues: Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, {}])),
    classifyingDimensionCountHistogram: {},
    sixOfSix: 0,
    classificationQuality: {},
    missingnessState: {},
    featureStatus: {},
    foundationD1MembersNonNull: 0,
    gate25: build === null ? null : { candidateContextsRead: 0, candidateD1Formable: 0, candidateD1NotFormable: 0, missingMembers: {}, queryContextsRead: 0, queryD1Formable: 0, queryRejections: {}, candidateRejections: {} },
  };
  const bump = (bag, key, by = 1) => { bag[key] = (bag[key] ?? 0) + by; };
  const recordDigest = createHash('sha256');
  const d1Digest = createHash('sha256');
  const emittedSessions = new Set();
  const aaplCandidates = [];
  const aaplQueries = new Map();
  let aaplMatchAnchor = null;

  /* CPI successor cross-check: an independent endpoints-only recomputation (unchanged V1 as-of
     resolver and fixed-point ratio, no V2 code) must agree with every emitted inflationState, and
     every consumed endpoint is audited against the genuine verified vintages. */
  const cpiIndex = buildMonthlyWeeklySeriesIndex({ store: foundation.macroAuthority.store, vintageSet: foundation.macroAuthority.verified.vintageSet.vintageSet, seriesRegistry: foundation.macroAuthority.verified.registry.registry, canonicalSeriesCode: 'US.BLS.CPIAUCSL' });
  const inflationMin = resolveParameter(foundation.v2.parameterSet, 'inflationState', 'inflationaryMin');
  const disinflationMax = resolveParameter(foundation.v2.parameterSet, 'inflationState', 'disinflationaryMax');
  const genuineVintages = new Map();
  for (const [referencePeriod, entry] of cpiIndex.byReferencePeriod) {
    for (const item of entry.chain.vintages) genuineVintages.set(item.observationVintageId, { referencePeriod, availableAt: item.vintage.availableAt, value: item.vintage.value });
  }
  const independentInflation = new Map();
  const independent = (session) => {
    if (independentInflation.has(session.sessionDate)) return independentInflation.get(session.sessionDate);
    const current = mostRecentAdmissibleReferencePeriodAsOf(cpiIndex, session.closeUtc, session.sessionDate.slice(0, 7));
    let value = 'INFLATION_INSUFFICIENT_DATA';
    if (current !== null && current.resolutionStatus === 'RESOLVED') {
      const base = resolveSeriesReferencePeriodAsOf(cpiIndex, addMonthsToMonthKey(current.referencePeriod, -12), session.closeUtc);
      if (base.resolutionStatus === 'RESOLVED' && base.value !== null) {
        const ratio = macroRatioChangeFixed(current.value, base.value, 'CPI_SUCCESSOR_CROSS_CHECK');
        const percent = fixedToNumberR1({ atoms: ratio.atoms, scale: 4 });
        value = percent >= inflationMin ? 'INFLATIONARY' : percent <= disinflationMax ? 'DISINFLATIONARY' : 'INFLATION_STABLE';
      }
    }
    independentInflation.set(session.sessionDate, value);
    return value;
  };
  const cpiSuccessor = {
    monthlyWindowPolicy: foundation.macroAuthority.verified.projectionPolicy.instrumentProjectionPolicy.monthlyWindowPolicy,
    instrumentProjectionPolicyId: foundation.macroAuthority.projection.cpiSuccessorInstrumentProjectionPolicyId,
    independentAgreementOnEmitted: 0,
    independentDisagreementOnEmitted: 0,
    consumedEndpointCount: 0,
    endpointPairsNotTwelveMonthsApart: 0,
    october2025EndpointConsumption: 0,
    fabricatedObservationCount: 0,
    interpolatedObservationCount: 0,
    forwardFilledObservationCount: 0,
    futureVintageConsumptionCount: 0,
    october2025PresentInIndex: cpiIndex.byReferencePeriod.has('2025-10'),
  };
  for (const state of foundation.macro.states) {
    const endpoints = state.inflation.cpiYoYEndpointEvidence?.endpoints;
    if (!endpoints) continue;
    if (addMonthsToMonthKey(endpoints[0].referencePeriod, -12) !== endpoints[1].referencePeriod) cpiSuccessor.endpointPairsNotTwelveMonthsApart += 1;
    for (const endpoint of endpoints) {
      cpiSuccessor.consumedEndpointCount += 1;
      const real = genuineVintages.get(endpoint.observationVintageId);
      if (endpoint.referencePeriod === '2025-10') cpiSuccessor.october2025EndpointConsumption += 1;
      if (real === undefined) { cpiSuccessor.fabricatedObservationCount += 1; continue; }
      if (real.value.atoms !== endpoint.value.atoms || real.value.scale !== endpoint.value.scale) cpiSuccessor.interpolatedObservationCount += 1;
      if (real.referencePeriod !== endpoint.referencePeriod) cpiSuccessor.forwardFilledObservationCount += 1;
      if (real.availableAt > state.session.closeUtc) cpiSuccessor.futureVintageConsumptionCount += 1;
    }
  }
  cpiSuccessor.october2025PresentInIndexAfterSweep = cpiIndex.byReferencePeriod.has('2025-10');

  const sessionsByDate = new Map(foundation.calendarSessions.map((session) => [session.sessionDate, session]));
  for (const exclusion of foundation.p3h.exclusions) {
    counts.pairCount += foundation.windowSessions.length;
    bump(counts.byStatus, 'P3H_EXCLUDED', foundation.windowSessions.length);
    bump(counts.refusalByCode, `P3H_EXCLUDED_${exclusion.reasonCode}`, foundation.windowSessions.length);
  }
  for (const entry of foundation.p3h.admittedEntries) {
    const keyBars = foundationModule.readP3hAdmittedBarsR1({ p3h: foundation.p3h, entry });
    let keyEmitted = false;
    const vectorsBySession = [];
    for (const session of foundation.windowSessions) {
      counts.pairCount += 1;
      const emitted = foundationModule.emitJarviseG25HistoricalRegimeRecordR1({ foundation, entry, keyBars, sessionDate: session.sessionDate });
      bump(counts.byStatus, emitted.status);
      if (emitted.status !== 'EMITTED') {
        bump(counts.refusalByCode, emitted.code);
        if (emitted.identityCode) bump(counts.refusalByIdentityCode, emitted.identityCode);
        if (emitted.featureSetStatus) bump(counts.refusalFeatureSetDetail, `${emitted.featureSetStatus}:${emitted.featureSetCode}`);
        continue;
      }
      keyEmitted = true;
      counts.emitted += 1;
      emittedSessions.add(session.sessionDate);
      if (counts.firstEmittedSession === null || session.sessionDate < counts.firstEmittedSession) counts.firstEmittedSession = session.sessionDate;
      if (counts.lastEmittedSession === null || session.sessionDate > counts.lastEmittedSession) counts.lastEmittedSession = session.sessionDate;
      const vector = emitted.regimeRecord.regimeVector;
      vectorsBySession.push({ sessionDate: session.sessionDate, signature: ACTIVE_DIMENSION_NAMES_V1.map((dimension) => vector[dimension]).join('|'), inflation: vector.inflationState });
      let classifying = 0;
      for (const dimension of ACTIVE_DIMENSION_NAMES_V1) {
        bump(counts.dimensionValues[dimension], vector[dimension]);
        if (isClassifyingValue(dimension, vector[dimension])) { counts.dimensionClassifying[dimension] += 1; classifying += 1; }
      }
      bump(counts.classifyingDimensionCountHistogram, String(classifying));
      if (classifying === 6) counts.sixOfSix += 1;
      bump(counts.classificationQuality, emitted.regimeRecord.classificationQuality);
      bump(counts.missingnessState, emitted.regimeRecord.missingnessState);
      for (const record of emitted.featureSet.records) bump(counts.featureStatus, `${record.featureDefinitionId}@W${record.sessionCount}:${record.status}`);
      if (independent(sessionsByDate.get(session.sessionDate)) === vector.inflationState) cpiSuccessor.independentAgreementOnEmitted += 1;
      else cpiSuccessor.independentDisagreementOnEmitted += 1;

      const members = foundationModule.foundationD1MembersR1({ foundation, emitted });
      if (Object.values(members).every((value) => typeof value === 'string' && value.length > 0)) counts.foundationD1MembersNonNull += 1;
      recordDigest.update(`${entry.acquisitionKey}|${session.sessionDate}|${emitted.regimeRecord.regimeRecordId}|${emitted.featureVectorBinding.featureVectorBindingId}\n`);

      if (build !== null) {
        const inputs = foundationModule.projectGate25AnalogueInputsR1({ foundation, emitted });
        const instrumentIdentity = { status: 'RESOLVED', instrumentIdentityId: emitted.instrumentIdentityId, resolvedAsOfSessionDate: session.sessionDate };
        const candidate = {
          schema: build.eligibility.CANDIDATE_SCHEMA_V1,
          candidateKey: `${entry.acquisitionKey}|${session.sessionDate}`,
          p3hKeyId: entry.acquisitionKey,
          p3hAdmission: { status: 'ADMITTED' },
          sessionDate: session.sessionDate,
          knowledgeCutoff: inputs.knowledgeCutoff,
          instrumentIdentity,
          priceBasisId: inputs.priceBasisId,
          featureVectorBinding: inputs.featureVectorBinding,
          features: inputs.features,
          regimeRecord: inputs.regimeRecord,
          inputProofs: inputs.inputProofs,
        };
        try {
          const context = build.eligibility.readHistoricalCandidate(candidate, build.policy);
          counts.gate25.candidateContextsRead += 1;
          const derived = build.eligibility.deriveAnalogueIdentityMembers({ context, policy: build.policy });
          if (derived.formable) {
            counts.gate25.candidateD1Formable += 1;
            d1Digest.update(`${build.identity.createAnalogueIdentity(derived.members).analogueIdentityId}\n`);
          } else {
            counts.gate25.candidateD1NotFormable += 1;
            for (const member of derived.missingMembers) bump(counts.gate25.missingMembers, member);
          }
        } catch (error) {
          bump(counts.gate25.candidateRejections, error.code ?? error.message);
        }
        const query = {
          schema: build.eligibility.QUERY_SCHEMA_V1,
          sessionDate: session.sessionDate,
          knowledgeCutoff: inputs.knowledgeCutoff,
          instrumentIdentity,
          priceBasisId: inputs.priceBasisId,
          featureVectorBinding: inputs.featureVectorBinding,
          features: inputs.features,
          regimeRecord: inputs.regimeRecord,
          inputProofs: inputs.inputProofs,
          sourceBindingId: inputs.sourceBindingId,
        };
        try {
          const queryContext = build.eligibility.readAnalogueQuery(query, build.policy);
          counts.gate25.queryContextsRead += 1;
          if (build.eligibility.deriveAnalogueIdentityMembers({ context: queryContext, policy: build.policy }).formable) counts.gate25.queryD1Formable += 1;
        } catch (error) {
          bump(counts.gate25.queryRejections, error.code ?? error.message);
        }
        if (entry.providerSymbol === 'AAPL') { aaplCandidates.push(candidate); aaplQueries.set(session.sessionDate, query); }
      }
    }
    if (keyEmitted) counts.emittedKeyCount += 1;
    else counts.refusalKeysWithoutAnyEmission += 1;
    /* GATE25 D7 CORE_V1 exact match compares values by equality; count same-instrument (earlier, later) pairs it would treat as matching. */
    const seen = new Map();
    let keyPairs = 0;
    for (const item of vectorsBySession) {
      const earlier = seen.get(item.signature) ?? 0;
      if (earlier > 0) {
        keyPairs += earlier;
        counts.gate25CoreV1ExactMatchPairs.sameInstrumentOrderedPairs += earlier;
        if (item.inflation === 'INFLATION_INSUFFICIENT_DATA') counts.gate25CoreV1ExactMatchPairs.allWithInflationInsufficientOnBothSides += earlier;
        if (entry.providerSymbol === 'AAPL' && !aaplMatchAnchor) aaplMatchAnchor = item.sessionDate;
      }
      seen.set(item.signature, earlier + 1);
    }
    if (keyPairs > 0) counts.gate25CoreV1ExactMatchPairs.keysWithAtLeastOnePair += 1;
  }
  counts.emittedSessionCount = emittedSessions.size;

  /* Selection anchors on the real GATE25 engine: the query identity is formable. */
  const anchors = {};
  if (build !== null && aaplQueries.size > 0) {
    const dates = [...aaplQueries.keys()].sort();
    const named = [['end', dates.at(-1)], ['mid', dates[Math.floor(dates.length / 2)]]];
    if (aaplMatchAnchor !== null) named.push(['firstExactCoreV1Match', aaplMatchAnchor]);
    for (const [name, date] of named) {
      try {
        const selection = build.engine.runAnalogueSelection({ authority: build.authority, policy: build.policy, query: aaplQueries.get(date), candidates: aaplCandidates, outcomeSource: null });
        const eligibleInflation = {};
        for (const analogue of selection.comparisonReport.analogues ?? []) {
          const factor = (analogue.commonFactors ?? []).find((item) => item.dimensionId === 'inflationState');
          bump(eligibleInflation, factor?.value ?? 'UNREPORTED');
        }
        anchors[name] = {
          sessionDate: date,
          code: 'SELECTION_COMPLETED',
          queryIdentityId: selection.queryIdentity.analogueIdentityId,
          universeCount: selection.accounting.universeCount,
          eligibleCount: selection.accounting.eligibleCount,
          exclusionCountsByReason: selection.accounting.exclusionCountsByReason.filter((item) => item.count > 0),
          supportStatus: selection.supportReport.supportStatus,
          eligibleInflationStateCommonFactor: eligibleInflation,
        };
      } catch (error) {
        anchors[name] = { sessionDate: date, code: error.code ?? error.message, missingMembers: error.details?.missingMembers ?? null };
      }
    }
  }

  /* Classification capability on real pre-gap history (identity-free vector classification). */
  const capability = { sampledPairs: 0, sixOfSix: 0, dimensionClassifying: Object.fromEntries(ACTIVE_DIMENSION_NAMES_V1.map((name) => [name, 0])), note: 'CLASSIFICATION_CAPABILITY_ONLY_NO_REGIME_RECORD: instrument identity is not resolvable before 2026-05-04, so no RegimeRecordId exists for these sessions' };
  const capabilitySessions = foundation.windowSessions.filter((session) => session.sessionDate >= '2025-01-02' && session.sessionDate <= '2025-12-17').filter((_, index) => index % 5 === 0);
  for (const entry of foundation.p3h.admittedEntries.filter((_, index) => index % 40 === 0)) {
    const keyBars = foundationModule.readP3hAdmittedBarsR1({ p3h: foundation.p3h, entry });
    const barsByDate = new Map(keyBars.bars.map((bar) => [bar.sessionDate, bar]));
    for (const session of capabilitySessions) {
      const window = (count) => resolveTrailingWindow({ sessionDate: session.sessionDate, featureWindowSpec: createFeatureWindowSpec({ sessionCount: count, calendarWindowBinding: foundation.calendarWindowBinding }), calendarWindowBinding: foundation.calendarWindowBinding, sessions: foundation.calendarSessions });
      const closes = (count) => { const w = window(count); if (w.status !== 'RESOLVED') return null; const list = w.sessions.map((item) => barsByDate.get(item.sessionDate)?.close ?? null); return list; };
      const featureRecord = (featureDefinitionId, sessionCount, outcome) => ({ featureDefinitionId, sessionCount, status: outcome.status, value: outcome.value });
      const w5 = closes(5); const w21 = closes(21);
      if (w5 === null || w21 === null) continue;
      const featureSet = { knowledgeCutoff: session.closeUtc, records: [featureRecord('F1_SIMPLE_RETURN', 5, simpleReturn(w5)), featureRecord('F1_SIMPLE_RETURN', 21, simpleReturn(w21)), featureRecord('F2_REALIZED_VOLATILITY', 21, computeRealizedVolatilityR1({ closes: w21 }))] };
      const snapshot = foundation.macro.snapshotAt({ sessionDate: session.sessionDate, knowledgeCutoff: session.closeUtc });
      const horizon = window(21);
      const vector = classifyRegimeVector({ featureSet, macroSnapshot: snapshot.snapshot, vintageStore: foundation.macro.vintageStore, horizonStartKnowledgeCutoff: horizon.sessions[0].closeUtc, parameterSet: foundation.v2.parameterSet, declaredMacroCompleteness: snapshot.snapshot.macroFeatureCompleteness });
      capability.sampledPairs += 1;
      let all = true;
      for (const dimension of ACTIVE_DIMENSION_NAMES_V1) {
        if (isClassifyingValue(dimension, vector.regimeVector[dimension])) capability.dimensionClassifying[dimension] += 1; else all = false;
      }
      if (all) capability.sixOfSix += 1;
    }
  }

  const summary = {
    identities: foundationModule.describeJarviseG25HistoricalRegimeFoundationR1(foundation),
    counts,
    regimeRecordDigest: recordDigest.digest('hex'),
    gate25D1IdentityDigest: build === null ? null : d1Digest.digest('hex'),
    anchors,
    capability,
    cpiSuccessor,
    networkCalls,
  };
  const digest = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  process.stdout.write(`${PREFIX}${JSON.stringify({ summary, digest, loadMs, totalMs: Number(process.hrtime.bigint() - started) / 1e6 })}\n`);
}

function spawnChild(extraArgs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=6144', THIS_FILE, '--child', ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').find((item) => item.startsWith(PREFIX));
      if (code !== 0 || line === undefined) reject(new Error(`CHILD_FAILED ${code}\n${stderr.slice(-4000)}`));
      else resolvePromise(JSON.parse(line.slice(PREFIX.length)));
    });
  });
}

async function runParent() {
  const extra = [];
  const buildRoot = argValue('--gate25-build-root');
  if (buildRoot !== null) extra.push('--gate25-build-root', buildRoot);
  const [first, second] = await Promise.all([spawnChild(extra), spawnChild(extra)]);
  const report = {
    deterministic: first.digest === second.digest,
    digests: [first.digest, second.digest],
    timingsMs: [{ load: first.loadMs, total: first.totalMs }, { load: second.loadMs, total: second.totalMs }],
    summary: first.summary,
  };
  const out = argValue('--out');
  if (out !== null) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ deterministic: report.deterministic, digests: report.digests, timingsMs: report.timingsMs }, null, 2)}\n`);
  if (!report.deterministic) process.exitCode = 1;
}

if (process.argv.includes('--child')) await runChild();
else await runParent();
