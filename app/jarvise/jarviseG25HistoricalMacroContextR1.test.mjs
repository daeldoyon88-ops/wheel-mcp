import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

import { admitMacroVintage, selectVintageAsOf } from '../../governance/gates/GATE24/implementation/causal-admission-v1.mjs';
import { createMacroContextBinding, resolveMacroSnapshot } from '../../governance/gates/GATE24/implementation/macro-context-binding-v1.mjs';
import { assertExplicitPinnedMacroId } from '../../research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs';
import { buildMonthlyWeeklySeriesIndex, resolveSeriesReferencePeriodAsOf } from '../../research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';
import { computeInflationState } from '../../research/directional-lab/src/macro/macroInflationFeaturesL4BF2V1.mjs';
import { loadJarviseHistoricalCalendarR1 } from './jarviseHistoricalCalendarBindingR1.mjs';
import { produceJarviseEmptyMacroContextR1 } from './jarviseEmptyMacroContextProducerR1.mjs';
import { SOURCE_EVIDENCE_R1 } from '../../scripts/materializeJarviseG25HistoricalMacroContextR1.mjs';
import {
  ALFRED_REAL_TIME_ENTRY_NAME_R1,
  HISTORICAL_MACRO_COVERAGE_R1,
  decimalStringToFixedR1,
  deriveHistoricalMacroAvailabilityPolicyIdR1,
  fixedToNumberR1,
  loadJarviseG25HistoricalMacroAuthorityR1,
  parseAlfredRealTimePeriodCsvR1,
  parseTreasuryParYieldCsvR1,
  prepareJarviseG25HistoricalMacroContextR1,
  readZipEntriesR1,
} from './jarviseG25HistoricalMacroContextR1.mjs';

const MACRO_ROOT = new URL('../../data/jarvise/historical-macro-context/', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const networkCalls = [];
let authority;
let macro;
let sessionsByDate;

test.before(() => {
  const trap = (name) => () => { networkCalls.push(name); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
  globalThis.fetch = trap('fetch');
  for (const [target, keys, label] of [[http, ['request', 'get'], 'http'], [https, ['request', 'get'], 'https'], [net, ['connect', 'createConnection'], 'net'], [tls, ['connect'], 'tls'], [dns, ['lookup', 'resolve'], 'dns'], [dgram, ['createSocket'], 'dgram']]) {
    for (const key of keys) target[key] = trap(`${label}.${key}`);
  }
  syncBuiltinESMExports();
  const sessions = loadJarviseHistoricalCalendarR1().sessions;
  sessionsByDate = new Map(sessions.map((session) => [session.sessionDate, session]));
  authority = loadJarviseG25HistoricalMacroAuthorityR1();
  macro = prepareJarviseG25HistoricalMacroContextR1({ authority, sessions });
});

test('pinned FREE source evidence is byte-exact and parses to the declared real coverage', () => {
  for (const item of SOURCE_EVIDENCE_R1) {
    const bytes = readFileSync(new URL(item.path, MACRO_ROOT));
    assert.equal(bytes.length, item.byteLength, item.path);
    assert.equal(sha256(bytes), item.sha256, item.path);
  }
  const rows = SOURCE_EVIDENCE_R1.filter((item) => item.sourceAuthority === 'US_TREASURY').flatMap((item) => parseTreasuryParYieldCsvR1(readFileSync(new URL(item.path, MACRO_ROOT))));
  const inCoverage = rows.filter((row) => row.date >= HISTORICAL_MACRO_COVERAGE_R1.treasuryObservationFromInclusive && row.date <= HISTORICAL_MACRO_COVERAGE_R1.treasuryObservationToInclusive);
  assert.equal(inCoverage.length, 441);
  assert.deepEqual({ ...inCoverage.find((row) => row.date === '2026-09-04').values['US.TREAS.DGS10'] }, { atoms: '478', scale: 2 });
  const zip = readFileSync(new URL(SOURCE_EVIDENCE_R1.find((item) => item.sourceAuthority === 'FRED_ALFRED').path, MACRO_ROOT));
  const parsed = parseAlfredRealTimePeriodCsvR1(readZipEntriesR1(zip).get(ALFRED_REAL_TIME_ENTRY_NAME_R1));
  assert.equal(parsed.chains.length, 32);
  assert.deepEqual(parsed.nonPublications.map((item) => ({ ...item })), [{ referencePeriod: '2025-10', realtimeStart: '2025-12-18', realtimeEnd: null }]);
  const sep2025 = parsed.chains.find((chain) => chain.referencePeriod === '2025-09').vintages.map((item) => [item.realtimeStart, item.value.atoms]);
  assert.deepEqual(sep2025, [['2025-10-24', '324368'], ['2026-02-13', '324245']]);
});

test('fixed-point conversions are exact', () => {
  assert.deepEqual({ ...decimalStringToFixedR1('4.40') }, { atoms: '440', scale: 2 });
  assert.deepEqual({ ...decimalStringToFixedR1('0.05') }, { atoms: '5', scale: 2 });
  assert.deepEqual({ ...decimalStringToFixedR1('308.024') }, { atoms: '308024', scale: 3 });
  assert.equal(fixedToNumberR1({ atoms: '30227', scale: 4 }), 3.0227);
  assert.equal(fixedToNumberR1({ atoms: '-5', scale: 2 }), -0.05);
  assert.throws(() => decimalStringToFixedR1('4,40'), /MACRO_SOURCE_DECIMAL_INVALID/);
});

test('persisted L4B authority verifies, is non-empty, and the MacroContextBindingId is deterministic', () => {
  const again = loadJarviseG25HistoricalMacroAuthorityR1();
  const projection = JSON.parse(readFileSync(new URL('binding-projection.json', MACRO_ROOT), 'utf8'));
  const recomputed = createMacroContextBinding({ macroVintageSetManifestId: projection.macroVintageSetManifestId, macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId, availableAtPolicyId: deriveHistoricalMacroAvailabilityPolicyIdR1(projection) });
  assert.equal(projection.schemaVersion, 'JarviseG25HistoricalMacroContextBindingProjection/2');
  assert.equal(projection.cpiSuccessorInstrumentProjectionPolicyId, 'sha256:4d68fb2ee981d51fa3f3810d833ba1796a54cc63b8f5df8afe5944a1209789de');
  assert.equal(projection.instrumentProjectionPolicyId, 'sha256:20e04ff36e1276a502f4bbd7c3afd0ce63dd595217bde9501c8619112a7e195c');
  assert.equal(authority.macroContextBinding.macroContextBindingId, 'cf802fa6dee61c578a4615084820d15c3e58d0b27d9347501ae58e162bbed0ef');
  assert.equal(authority.verified.projectionPolicyV1.instrumentProjectionPolicy.monthlyWindowPolicy, 'ALL_INTERMEDIATE_MONTHS_REQUIRED');
  assert.equal(authority.verified.projectionPolicy.instrumentProjectionPolicy.monthlyWindowPolicy, 'ENDPOINTS_M_AND_M_MINUS_12_REQUIRED');
  assert.equal(authority.macroContextBinding.macroContextBindingId, again.macroContextBinding.macroContextBindingId);
  assert.equal(authority.macroContextBinding.macroContextBindingId, recomputed.macroContextBindingId);
  assert.equal(authority.verified.vintageSet.vintageSet.vintageCount, 2278);
  assert.equal(authority.verified.vintageSet.vintageSet.observationCount, 2237);
  assert.equal(authority.verified.snapshot.datasetSnapshot.emptySnapshot, false);
  /* A real vintage set is a different macro input from the admitted empty context. */
  const empty = produceJarviseEmptyMacroContextR1({ knowledgeCutoff: '2026-06-01T20:00:00.000Z' });
  assert.notEqual(empty.macroContextBinding.macroContextBindingId, authority.macroContextBinding.macroContextBindingId);
  const prepared = prepareJarviseG25HistoricalMacroContextR1({ authority: again, sessions: [...sessionsByDate.values()] });
  assert.equal(prepared.projectionDigest, macro.projectionDigest);
});

test('every consumed macro vintage satisfies availableAt <= K(T) on real sessions', () => {
  let checked = 0;
  for (const state of macro.states) {
    if (state.session.sessionDate < HISTORICAL_MACRO_COVERAGE_R1.classificationCoverageFromInclusive) continue;
    const K = state.session.closeUtc;
    const { snapshot } = macro.snapshotAt({ sessionDate: state.session.sessionDate, knowledgeCutoff: K });
    for (const observation of [...Object.values(snapshot.series), ...Object.values(snapshot.derived)]) {
      assert.ok(observation.availableAt <= K && observation.vintageAvailableAt <= K, `${state.session.sessionDate}`);
      checked += 1;
    }
    for (const resolution of state.orderedResolutions) if (resolution.availableAt !== null) assert.ok(resolution.availableAt <= K);
  }
  assert.ok(checked >= 4 * 420);
  /* Half-day session: the same-day 16:00 America/New_York Treasury print is not yet usable. */
  const halfDay = sessionsByDate.get('2025-12-24');
  assert.equal(halfDay.sessionKind, 'HALF_DAY_SESSION');
  const dgs10 = macro.snapshotAt({ sessionDate: '2025-12-24', knowledgeCutoff: halfDay.closeUtc }).snapshot.series['US.TREAS.DGS10'];
  assert.equal(dgs10.sequenceId.slice(0, 10), '2025-12-23');
});

test('a future macro vintage is rejected and never selected', () => {
  const list = macro.vintageStore['US.TREAS.DGS10'];
  const K = sessionsByDate.get('2026-06-01').closeUtc;
  const future = list.find((item) => item.availableAt > K);
  assert.deepEqual([admitMacroVintage({ observation: future, knowledgeCutoff: K }).status, admitMacroVintage({ observation: future, knowledgeCutoff: K }).code], ['BLOCKED', 'FUTURE_PROVENANCE_DEPENDENCY_FORBIDDEN']);
  const selected = selectVintageAsOf({ observations: list, knowledgeCutoff: K });
  assert.equal(selected.observation.sequenceId, '2026-06-01|0');
  const earlier = resolveMacroSnapshot({ macroContextBinding: authority.macroContextBinding, vintageStore: macro.vintageStore, knowledgeCutoff: sessionsByDate.get('2026-05-29').closeUtc });
  assert.equal(earlier.snapshot.series['US.TREAS.DGS10'].sequenceId, '2026-05-29|0');
  assert.equal(earlier.snapshot.derived.curveShape.sequenceId, '2026-05-29');
});

test('latest-value historical reconstruction is rejected: CPI is read at its vintage as of K(T)', () => {
  const cpiIndex = buildMonthlyWeeklySeriesIndex({ store: authority.store, vintageSet: authority.verified.vintageSet.vintageSet, seriesRegistry: authority.verified.registry.registry, canonicalSeriesCode: 'US.BLS.CPIAUCSL' });
  const asOfNov2025 = resolveSeriesReferencePeriodAsOf(cpiIndex, '2025-09', sessionsByDate.get('2025-11-03').closeUtc);
  const asOfMar2026 = resolveSeriesReferencePeriodAsOf(cpiIndex, '2025-09', sessionsByDate.get('2026-03-02').closeUtc);
  assert.deepEqual({ ...asOfNov2025.value }, { atoms: '324368', scale: 3 });
  assert.deepEqual({ ...asOfMar2026.value }, { atoms: '324245', scale: 3 });
  assert.equal(resolveSeriesReferencePeriodAsOf(cpiIndex, '2025-09', sessionsByDate.get('2025-10-23').closeUtc).resolutionStatus, 'NOT_AVAILABLE');
  /* cpiYoY on 2025-12-17: first-release Sep-2025 over the Feb-2025-vintage Sep-2024 gives 3.0227;
     rebuilding from the latest vintages would give 3.0226 and is not what is emitted. */
  const derived = macro.snapshotAt({ sessionDate: '2025-12-17', knowledgeCutoff: sessionsByDate.get('2025-12-17').closeUtc }).snapshot.derived;
  assert.equal(derived.cpiYoY.value, 3.0227);
  assert.notEqual(derived.cpiYoY.value, 3.0226);
  assert.equal(macro.snapshotAt({ sessionDate: '2025-06-02', knowledgeCutoff: sessionsByDate.get('2025-06-02').closeUtc }).snapshot.derived.cpiYoY.value, 2.3337);
  assert.throws(() => assertExplicitPinnedMacroId('latest', 'macroVintageSetManifestId'), /MARKET_DATA_MACRO_LATEST_FORBIDDEN/);
});

test('real macro-fed producers classify where data exists; the V1 window rule stays reproducible and unchanged', () => {
  const inWindow = macro.states.filter((state) => state.session.sessionDate >= HISTORICAL_MACRO_COVERAGE_R1.classificationCoverageFromInclusive);
  assert.equal(inWindow.length, 421);
  assert.ok(inWindow.every((state) => state.curveState.curveShape !== 'NOT_AVAILABLE'));
  assert.ok(inWindow.every((state) => state.curveState.curveDirection !== 'NOT_AVAILABLE'));
  const beforeGap = inWindow.filter((state) => state.session.sessionDate <= '2025-12-17');
  const afterGap = inWindow.filter((state) => state.session.sessionDate >= '2025-12-18');
  assert.ok(beforeGap.every((state) => state.inflation.inflationState.cpiYoY !== null && state.inflation.inflationState.cpiAvailabilityStatus === 'AVAILABLE'));
  /* Successor V2: BLS did not publish October 2025, yet every later session has a genuine (m, m-12) pair. */
  assert.ok(afterGap.length > 0 && afterGap.every((state) => state.inflation.inflationState.cpiYoY !== null && state.inflation.inflationState.cpiAvailabilityStatus === 'AVAILABLE'));
  assert.ok(afterGap.every((state) => typeof macro.snapshotAt({ sessionDate: state.session.sessionDate, knowledgeCutoff: state.session.closeUtc }).snapshot.derived.cpiYoY.value === 'number'));
  /* V1, run unchanged over the same verified vintages, still refuses every post-gap session (13-contiguous-month window). */
  const cpiIndex = buildMonthlyWeeklySeriesIndex({ store: authority.store, vintageSet: authority.verified.vintageSet.vintageSet, seriesRegistry: authority.verified.registry.registry, canonicalSeriesCode: 'US.BLS.CPIAUCSL' });
  const v1 = (state) => computeInflationState({ cpiIndex, knowledgeCutoff: state.session.closeUtc, sessionMonthKey: state.session.sessionDate.slice(0, 7), policy: authority.verified.projectionPolicyV1.instrumentProjectionPolicy });
  assert.ok(afterGap.every((state) => v1(state).inflationState.cpiYoY === null));
  /* Wherever V1 computes, V2 yields the identical inflationState. */
  let equal = 0;
  for (const state of macro.states) {
    const legacy = v1(state);
    if (legacy.inflationState.cpiYoY === null) continue;
    assert.deepEqual(state.inflation.inflationState, legacy.inflationState, state.session.sessionDate);
    assert.equal(state.inflation.availability, legacy.availability);
    equal += 1;
  }
  assert.equal(equal, 256);
  assert.equal(macro.snapshotAt({ sessionDate: '2024-12-31', knowledgeCutoff: sessionsByDate.get('2024-12-31').closeUtc }).status, 'OUTSIDE_HISTORICAL_MACRO_COVERAGE');
});

test('macro preparation performed no network access', () => {
  assert.deepEqual(networkCalls, []);
  const source = readFileSync(new URL('./jarviseG25HistoricalMacroContextR1.mjs', import.meta.url), 'utf8');
  assert.equal(/\bfetch\s*\(|node:https?'|yahoo|ibkr|ollama|openai/i.test(source), false);
});
