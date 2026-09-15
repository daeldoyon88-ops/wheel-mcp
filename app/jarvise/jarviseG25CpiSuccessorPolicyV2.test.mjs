import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import { canonicalHash } from '../../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import {
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES,
} from '../../research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V1.mjs';
import {
  CPI_YOY_ENDPOINT_WINDOW_POLICY_V2,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V1_TO_V2_DELTA,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION,
  MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES,
  normalizeMarketMacroInstrumentProjectionPolicyV2,
} from '../../research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V2.mjs';
import { computeInflationState } from '../../research/directional-lab/src/macro/macroInflationFeaturesL4BF2V1.mjs';
import { CPI_INFLATION_V2_POLICY_CODE, computeInflationStateV2 } from '../../research/directional-lab/src/macro/macroInflationFeaturesL4BF2V2.mjs';
import {
  buildMarketMacroInstrumentProjectionPolicyV2,
  verifyMarketMacroInstrumentProjectionPolicyV2,
} from '../../research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V2.mjs';
import { addMonthsToMonthKey, monthsBetweenMonthKeys } from '../../research/directional-lab/src/macro/macroFixedPointRatioL4BF2V1.mjs';
import { buildMonthlyWeeklySeriesIndex } from '../../research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';
import { loadJarviseHistoricalCalendarR1 } from './jarviseHistoricalCalendarBindingR1.mjs';
import {
  ALFRED_REAL_TIME_ENTRY_NAME_R1,
  fixedToNumberR1,
  loadJarviseG25HistoricalMacroAuthorityR1,
  parseAlfredRealTimePeriodCsvR1,
  projectCpiYoYR1,
  readZipEntriesR1,
} from './jarviseG25HistoricalMacroContextR1.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MACRO_ROOT = resolve(ROOT, 'data/jarvise/historical-macro-context');
const V1_POLICY_ID = 'sha256:20e04ff36e1276a502f4bbd7c3afd0ce63dd595217bde9501c8619112a7e195c';
const V2_POLICY_ID = 'sha256:4d68fb2ee981d51fa3f3810d833ba1796a54cc63b8f5df8afe5944a1209789de';
const V1_FILES = Object.freeze([
  'research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroInflationFeaturesL4BF2V1.mjs',
  'research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs',
  'research/directional-lab/src/macro/macroFixedPointRatioL4BF2V1.mjs',
]);

const networkCalls = [];
let authority;
let cpiIndex;
let sessions;
let v1Policy;
let v2Policy;
const byDate = new Map();
const stateAt = (session, index = cpiIndex) => computeInflationStateV2({ cpiIndex: index, knowledgeCutoff: session.closeUtc, sessionMonthKey: session.sessionDate.slice(0, 7), policy: v2Policy });

test.before(() => {
  const trap = (name) => () => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();
  authority = loadJarviseG25HistoricalMacroAuthorityR1();
  cpiIndex = buildMonthlyWeeklySeriesIndex({ store: authority.store, vintageSet: authority.verified.vintageSet.vintageSet, seriesRegistry: authority.verified.registry.registry, canonicalSeriesCode: 'US.BLS.CPIAUCSL' });
  const coverage = authority.projection.coverage;
  sessions = loadJarviseHistoricalCalendarR1().sessions.filter((session) => session.sessionDate >= coverage.sessionStateFromInclusive && session.sessionDate <= coverage.sessionStateToInclusive);
  for (const session of sessions) byDate.set(session.sessionDate, session);
  v1Policy = authority.verified.projectionPolicyV1.instrumentProjectionPolicy;
  v2Policy = authority.verified.projectionPolicy.instrumentProjectionPolicy;
});

/* Every real vintage of every reference month, straight from the verified chains. */
function genuineVintages() {
  const byVintageId = new Map();
  for (const [referencePeriod, entry] of cpiIndex.byReferencePeriod) {
    for (const item of entry.chain.vintages) byVintageId.set(item.observationVintageId, { referencePeriod, availableAt: item.vintage.availableAt, value: item.vintage.value });
  }
  return byVintageId;
}

test('V1 CPI rule is byte-identical to HEAD and its persisted identity is unchanged', () => {
  const committed = execFileSync('git', ['ls-tree', 'HEAD', '--', ...V1_FILES], { cwd: ROOT }).toString('utf8').split('\n').filter(Boolean).map((line) => [line.split('\t')[1], line.split('\t')[0].split(' ')[2]]);
  /* Git-normalized content (the canonical blob bytes); checkout EOL conversion of lab sources is not a content change. */
  const working = execFileSync('git', ['hash-object', '--stdin-paths'], { cwd: ROOT, input: V1_FILES.join('\n') }).toString('utf8').split('\n').filter(Boolean);
  assert.equal(execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...V1_FILES], { cwd: ROOT }).toString('utf8').trim(), '');
  assert.equal(committed.length, V1_FILES.length);
  assert.deepEqual(Object.fromEntries(committed), Object.fromEntries(V1_FILES.map((path, index) => [path, working[index]])));
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', ...V1_FILES], { cwd: ROOT }).toString('utf8').trim(), '');
  assert.equal(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES.monthlyWindowPolicy, 'ALL_INTERMEDIATE_MONTHS_REQUIRED');
  assert.equal(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_VALUES.cpiMinObservationsForYoY, 13);
  assert.equal(authority.projection.instrumentProjectionPolicyId, V1_POLICY_ID);
  assert.equal(canonicalHash(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION, v1Policy), V1_POLICY_ID);
});

test('V2 successor has a distinct content-addressed identity and differs from V1 only by the declared delta', () => {
  const built = buildMarketMacroInstrumentProjectionPolicyV2();
  assert.equal(built.instrumentProjectionPolicyId, V2_POLICY_ID);
  assert.notEqual(V2_POLICY_ID, V1_POLICY_ID);
  const bytes = readFileSync(resolve(MACRO_ROOT, `cpi-successor-policy/sha256/${V2_POLICY_ID.slice(7)}.json`));
  assert.equal(verifyMarketMacroInstrumentProjectionPolicyV2({ policyBytes: bytes, instrumentProjectionPolicyId: V2_POLICY_ID }).instrumentProjectionPolicyId, V2_POLICY_ID);
  assert.throws(() => verifyMarketMacroInstrumentProjectionPolicyV2({ policyBytes: Buffer.concat([bytes, Buffer.from(' ')]), instrumentProjectionPolicyId: V2_POLICY_ID }), /MISMATCH/);
  const differing = Object.keys(v1Policy).filter((key) => JSON.stringify(v1Policy[key]) !== JSON.stringify(v2Policy[key])).sort();
  assert.deepEqual(differing, MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V1_TO_V2_DELTA.map((item) => item.field).sort());
  assert.deepEqual([v2Policy.schemaVersion, v2Policy.cpiMinObservationsForYoY, v2Policy.monthlyWindowPolicy], [MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION, 2, 'ENDPOINTS_M_AND_M_MINUS_12_REQUIRED']);
  for (const field of ['cpiInputScale', 'ratioScale', 'roundingMode', 'cpiStalenessMaxMonths', 'cpiMinObservationsForMoM', 'latestPolicy', 'networkPolicy', 'fixedPointPolicy']) assert.equal(v2Policy[field], v1Policy[field], field);
  /* Closed: V1 values, extra fields and a V1 schema are refused by the V2 normalizer; V2 producer refuses the V1 policy. */
  const good = { schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_SCHEMA_VERSION, ...structuredClone(MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_V2_VALUES) };
  assert.throws(() => normalizeMarketMacroInstrumentProjectionPolicyV2({ ...good, monthlyWindowPolicy: 'ALL_INTERMEDIATE_MONTHS_REQUIRED' }));
  assert.throws(() => normalizeMarketMacroInstrumentProjectionPolicyV2({ ...good, cpiMinObservationsForYoY: 13 }));
  assert.throws(() => normalizeMarketMacroInstrumentProjectionPolicyV2({ ...good, cpiYoYInterpolation: 'LINEAR' }));
  assert.throws(() => normalizeMarketMacroInstrumentProjectionPolicyV2({ ...good, schemaVersion: MARKET_MACRO_INSTRUMENT_PROJECTION_POLICY_SCHEMA_VERSION }));
  assert.throws(() => stateAtWithPolicy(byDate.get('2026-06-15'), v1Policy), (error) => error.code === CPI_INFLATION_V2_POLICY_CODE);
});
const stateAtWithPolicy = (session, policy) => computeInflationStateV2({ cpiIndex, knowledgeCutoff: session.closeUtc, sessionMonthKey: session.sessionDate.slice(0, 7), policy });

test('October 2025 hostile proof: the month is absent, never synthesized, and later lawful endpoint pairs still compute', () => {
  /* Absent at the source: ALFRED carries an explicit empty value, and it never became a vintage. */
  const zip = readFileSync(resolve(MACRO_ROOT, 'source-evidence/FRED_ALFRED/CPIAUCSL-observations-by-real-time-period.zip'));
  const parsed = parseAlfredRealTimePeriodCsvR1(readZipEntriesR1(zip).get(ALFRED_REAL_TIME_ENTRY_NAME_R1));
  assert.deepEqual(parsed.nonPublications.map((item) => item.referencePeriod), ['2025-10']);
  assert.equal(parsed.chains.some((chain) => chain.referencePeriod === '2025-10'), false);
  assert.equal(cpiIndex.byReferencePeriod.has('2025-10'), false);
  assert.equal(cpiIndex.orderedReferencePeriods.includes('2025-10'), false);
  const referencePeriodsBefore = JSON.stringify(cpiIndex.orderedReferencePeriods);

  const genuine = genuineVintages();
  const counters = { fabricatedObservationCount: 0, interpolatedObservationCount: 0, forwardFilledObservationCount: 0, futureVintageConsumptionCount: 0 };
  let computedAcrossGap = 0;
  let consumed = 0;
  for (const session of sessions) {
    const result = stateAt(session);
    const evidence = result.cpiYoYEndpointEvidence;
    const pairs = [evidence?.endpoints, evidence?.previousEndpoints].filter(Boolean);
    for (const endpoint of pairs.flat()) {
      consumed += 1;
      const real = genuine.get(endpoint.observationVintageId);
      if (!cpiIndex.byReferencePeriod.has(endpoint.referencePeriod) || real === undefined) { counters.fabricatedObservationCount += 1; continue; }
      if (real.value.atoms !== endpoint.value.atoms || real.value.scale !== endpoint.value.scale) counters.interpolatedObservationCount += 1;
      if (real.referencePeriod !== endpoint.referencePeriod) counters.forwardFilledObservationCount += 1;
      if (real.availableAt > session.closeUtc || endpoint.availableAt > session.closeUtc) counters.futureVintageConsumptionCount += 1;
    }
    assert.notEqual(result.inflationState.cpiReferencePeriod, '2025-10');
    for (const pair of pairs) assert.ok(pair.every((endpoint) => endpoint.referencePeriod !== '2025-10'));
    const current = result.inflationState.cpiReferencePeriod;
    /* The window [m-12, m] spans the unpublished month, yet the genuine endpoint pair computes. */
    if (evidence?.endpoints && evidence.endpoints[1].referencePeriod < '2025-10' && evidence.endpoints[0].referencePeriod > '2025-10') computedAcrossGap += 1;
    /* No neighbour substitution: MoM for November 2025 has no October 2025 and stays null. */
    if (current === '2025-11') assert.equal(result.inflationState.cpiMoM, null);
  }
  assert.deepEqual(counters, { fabricatedObservationCount: 0, interpolatedObservationCount: 0, forwardFilledObservationCount: 0, futureVintageConsumptionCount: 0 });
  assert.ok(consumed > 800);
  assert.ok(computedAcrossGap > 150);
  assert.equal(JSON.stringify(cpiIndex.orderedReferencePeriods), referencePeriodsBefore);
  assert.equal(cpiIndex.byReferencePeriod.has('2025-10'), false);

  /* Concrete: 2026-01-02 reads November 2025 over November 2024 with October 2025 missing in between. */
  const january = stateAt(byDate.get('2026-01-02'));
  assert.deepEqual(january.cpiYoYEndpointEvidence.endpoints.map((item) => item.referencePeriod), ['2025-11', '2024-11']);
  assert.notEqual(january.inflationState.cpiYoY, null);
  assert.equal(computeInflationState({ cpiIndex, knowledgeCutoff: byDate.get('2026-01-02').closeUtc, sessionMonthKey: '2026-01', policy: v1Policy }).inflationState.cpiYoY, null);
});

test('endpoint selection is deterministic, exactly 12 reference months apart, genuinely present and causal at K(T)', () => {
  const genuine = genuineVintages();
  let checked = 0;
  const withoutPair = [];
  for (const session of sessions) {
    const first = stateAt(session);
    assert.deepEqual(stateAt(session), first, session.sessionDate);
    const endpoints = first.cpiYoYEndpointEvidence?.endpoints;
    if (!endpoints) { assert.equal(first.inflationState.cpiYoY, null); withoutPair.push(session.sessionDate); continue; }
    const [current, base] = endpoints;
    assert.equal(monthsBetweenMonthKeys(base.referencePeriod, current.referencePeriod), 12);
    assert.equal(addMonthsToMonthKey(current.referencePeriod, -12), base.referencePeriod);
    for (const endpoint of endpoints) {
      assert.equal(genuine.get(endpoint.observationVintageId).referencePeriod, endpoint.referencePeriod);
      assert.ok(endpoint.availableAt <= session.closeUtc);
    }
    assert.ok(current.referencePeriod <= first.inflationState.cpiReferencePeriod);
    checked += 1;
  }
  assert.equal(sessions.length, 442);
  assert.equal(checked, 435);
  /* Before the 2024-12-11 release the current month is 2024-10, whose m-12 precedes the materialized
     2023-11 CPI coverage: truthfully no pair, and all of it before classification coverage begins. */
  assert.deepEqual(withoutPair, ['2024-12-02', '2024-12-03', '2024-12-04', '2024-12-05', '2024-12-06', '2024-12-09', '2024-12-10']);
  assert.ok(withoutPair.every((date) => date < authority.projection.coverage.classificationCoverageFromInclusive));
});

test('a missing required endpoint fails closed; the latest lawful m is chosen only within the staleness bound', () => {
  const without = (...periods) => ({ ...cpiIndex, byReferencePeriod: new Map([...cpiIndex.byReferencePeriod].filter(([key]) => !periods.includes(key))), orderedReferencePeriods: cpiIndex.orderedReferencePeriods.filter((key) => !periods.includes(key)) });
  /* 2026-01-02: current m = 2025-11; its base 2024-11 removed; 2025-10 is absent; 2025-09 is 4 months stale -> fail closed. */
  const failed = stateAt(byDate.get('2026-01-02'), without('2024-11'));
  assert.equal(failed.inflationState.cpiReferencePeriod, '2025-11');
  assert.equal(failed.inflationState.cpiYoY, null);
  assert.equal(failed.cpiYoYEndpointEvidence.endpoints, null);
  assert.deepEqual([...failed.cpiYoYEndpointEvidence.candidatesExamined], ['2025-11', '2025-10']);
  assert.equal(projectCpiYoYR1(failed), 'NOT_AVAILABLE');
  /* 2025-12-19: same removal, but 2025-09 is within 3 months -> latest lawful pair (2025-09, 2024-09); never 2025-10. */
  const fallback = stateAt(byDate.get('2025-12-19'), without('2024-11'));
  assert.deepEqual(fallback.cpiYoYEndpointEvidence.endpoints.map((item) => item.referencePeriod), ['2025-09', '2024-09']);
  assert.deepEqual([...fallback.cpiYoYEndpointEvidence.candidatesExamined], ['2025-11', '2025-10', '2025-09']);
  /* Current endpoint itself missing: nothing newer is invented. */
  const noCurrent = stateAt(byDate.get('2026-09-04'), without('2026-07', '2025-07'));
  assert.equal(noCurrent.inflationState.cpiReferencePeriod, '2026-06');
  assert.deepEqual(noCurrent.cpiYoYEndpointEvidence.endpoints.map((item) => item.referencePeriod), ['2026-06', '2025-06']);
  /* Empty series: fail closed. */
  assert.equal(computeInflationStateV2({ cpiIndex: { ...cpiIndex, status: 'NO_OBSERVATIONS' }, knowledgeCutoff: byDate.get('2026-06-15').closeUtc, sessionMonthKey: '2026-06', policy: v2Policy }).inflationState.cpiYoY, null);
});

test('a future CPI vintage is never consumed and latest-value reconstruction is rejected', () => {
  const chain = cpiIndex.byReferencePeriod.get('2026-07').chain;
  const release = chain.vintages.map((item) => item.vintage.availableAt).sort()[0];
  const before = new Date(Date.parse(release) - 1).toISOString();
  const state = (knowledgeCutoff) => computeInflationStateV2({ cpiIndex, knowledgeCutoff, sessionMonthKey: '2026-08', policy: v2Policy });
  assert.equal(state(before).inflationState.cpiReferencePeriod, '2026-06');
  assert.equal(state(release).inflationState.cpiReferencePeriod, '2026-07');
  /* Revised endpoints: the as-of tip is consumed, not the latest vintage. */
  let revisedConsumed = 0;
  for (const session of sessions) {
    const endpoints = stateAt(session).cpiYoYEndpointEvidence?.endpoints ?? [];
    for (const endpoint of endpoints) {
      const vintages = cpiIndex.byReferencePeriod.get(endpoint.referencePeriod).chain.vintages;
      const latest = [...vintages].sort((left, right) => left.vintage.availableAt.localeCompare(right.vintage.availableAt)).at(-1);
      if (latest.vintage.availableAt > session.closeUtc && latest.vintage.value.atoms !== endpoint.value.atoms) {
        assert.notEqual(endpoint.observationVintageId, latest.observationVintageId);
        revisedConsumed += 1;
      }
    }
  }
  assert.ok(revisedConsumed > 0);
});

test('fixed-point ratio and HALF_EVEN rounding are the V1 semantics, reproduced independently in BigInt', () => {
  const halfEven = (numerator, denominator) => {
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    const twice = 2n * remainder;
    if (twice > denominator || (twice === denominator && quotient % 2n !== 0n)) return quotient + 1n;
    return quotient;
  };
  let checked = 0;
  for (const session of sessions) {
    const result = stateAt(session);
    const endpoints = result.cpiYoYEndpointEvidence?.endpoints;
    if (!endpoints) continue;
    const [current, base] = endpoints;
    assert.equal(current.value.scale, 3);
    assert.equal(base.value.scale, 3);
    const expected = halfEven(BigInt(current.value.atoms) * 1000000n, BigInt(base.value.atoms)) - 1000000n;
    assert.deepEqual({ ...result.inflationState.cpiYoY }, { atoms: expected.toString(), scale: 6 });
    assert.equal(projectCpiYoYR1(result), fixedToNumberR1({ atoms: expected.toString(), scale: 4 }));
    checked += 1;
  }
  assert.equal(checked, 435);
});

test('the successor computation performed no network access and imports no network surface', () => {
  assert.deepEqual(networkCalls, []);
  for (const path of ['research/directional-lab/src/macro/macroInflationFeaturesL4BF2V2.mjs', 'research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V2.mjs', 'research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V2.mjs']) {
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    assert.equal(/\bfetch\s*\(|node:(https?|net|tls|dgram|dns)'/.test(source), false, path);
    assert.equal(/interpolat|forward.?fill/i.test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false, path);
  }
  assert.equal(CPI_YOY_ENDPOINT_WINDOW_POLICY_V2, 'ENDPOINTS_M_AND_M_MINUS_12_REQUIRED');
});
