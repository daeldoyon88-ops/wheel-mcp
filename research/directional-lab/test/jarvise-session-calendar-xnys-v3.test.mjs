/**
 * JARVISE_DH_2011 WU2B - Calendar V3 published-data invariants.
 *
 * Reads only the Calendar V3 data tree and immutable repository code/blobs; never
 * the WU2A evidence roots and never market bars. Pre-publication, point
 * JARVISE_CALENDAR_V3_DATA_ROOT at a candidate root and JARVISE_REPO_ROOT at a
 * byte-faithful checkout of the bound base.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(process.env.JARVISE_REPO_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../../..'));
const DATA_BASE = resolve(process.env.JARVISE_CALENDAR_V3_DATA_ROOT || REPO_ROOT);
const DATA = 'data/jarvise/session-calendar-xnys-v3';
const YEARS = Array.from({ length: 17 }, (_, i) => 2010 + i);
const NAMESPACE = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/3';
const SPECIAL = ['2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09'];
const V2_REGISTRY = 'sha256:3df426b405f9ae43cb996b14f310d8efed55ce9f6377ed68dea4cd6ef939883f';

const imp = (p) => import(pathToFileURL(resolve(REPO_ROOT, ...p.split('/'))).href);
const { canonicalJsonBytes } = await imp('research/directional-lab/src/canonical/canonicalJsonV1.mjs');
const { canonicalize, sha256Canonical } = await imp('governance/tools/canonical-json.mjs');
const { normalizeMarketCalendarAuthorityPolicyV2, normalizeMarketSessionCalendarCoreV2 } = await imp('research/directional-lab/src/contracts/marketCalendarL3V2.mjs');
const { createCalendarWindowBinding, createFeatureWindowSpec, FEATURE_WINDOW_LADDER_V1 } = await imp('governance/gates/GATE23/implementation/feature-window-v1.mjs');
const { createHorizon, HORIZONS_V1 } = await imp('governance/gates/GATE22/implementation/temporal-horizon-v1.mjs');
const { dayOfWeek, addDays } = await imp('research/directional-lab/src/time/civilDate.mjs');

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const raw = (p) => readFileSync(resolve(DATA_BASE, ...`${DATA}/${p}`.split('/')));
const json = (p) => JSON.parse(raw(p).toString('utf8'));
const casId = (v) => `sha256:${sha256(canonicalJsonBytes(v))}`;
const identityId = (v) => `sha256:${sha256Canonical(v)}`;
const gitJson = (p) => { const r = spawnSync('git', ['-C', REPO_ROOT, 'cat-file', 'blob', `HEAD:${p}`], { encoding: null, maxBuffer: 1 << 26 }); assert.equal(r.status, 0, p); return JSON.parse(Buffer.from(r.stdout).toString('utf8')); };

const policy = json('XNYS/authority-policy.json');
const registry = json('XNYS/registry/R0001/registry-manifest.json');
const provenance = json('XNYS/registry/R0001/PROVENANCE.json');
const cores = new Map(YEARS.map((y) => [y, json(`XNYS/${y}/session-calendar-core.json`)]));
const rulesets = new Map(YEARS.map((y) => [y, json(`XNYS/${y}/timezone-ruleset.json`)]));
const normalized = new Map(YEARS.map((y) => [y, json(`XNYS/${y}/normalized-source.json`)]));
const evidenceSet = json('evidence/CALENDAR_SOURCE_EVIDENCE.json');
const evidence = new Map(evidenceSet.records.map((r) => [r.evidenceId, r]));
const sessions = YEARS.flatMap((y) => cores.get(y).sessions);

test('every Calendar V3 file is canonical JSON + LF with no CR byte', () => {
  const paths = ['XNYS/authority-policy.json', ...YEARS.flatMap((y) => ['session-calendar-core', 'timezone-ruleset', 'normalized-source', 'PROVENANCE'].map((f) => `XNYS/${y}/${f}.json`)),
    ...['registry-manifest', 'PROVENANCE', 'CALENDAR_WINDOW_BINDING', 'HORIZON_BINDINGS', 'ANALOGUE_SEARCH_SCOPE', 'V2_V3_DIFFERENTIAL'].map((f) => `XNYS/registry/R0001/${f}.json`),
    ...['CALENDAR_SOURCE_EVIDENCE', 'SPECIAL_CLOSURE_EVIDENCE', 'EXCEPTIONAL_CLOSURE_SWEEP_2026', 'ACCEPTED_EVIDENCE_COHORT'].map((f) => `evidence/${f}.json`)];
  assert.equal(paths.length, 79);
  for (const p of paths) {
    const b = raw(p); const v = JSON.parse(b.toString('utf8'));
    assert.ok(!b.includes(0x0d), p);
    assert.ok(canonicalJsonBytes(v).equals(b), p);
    assert.equal(`${canonicalize(v)}\n`, b.toString('utf8'), p);
  }
});

test('17 year records, contiguous civil coverage [2010-01-01, 2027-01-01), identities recompute', () => {
  assert.equal(policy.calendarNamespaceVersion, NAMESPACE);
  assert.deepEqual(normalizeMarketCalendarAuthorityPolicyV2(policy), policy);
  assert.deepEqual(policy.yearlyRulesets.map((r) => r.calendarYear), YEARS);
  const policyId = casId(policy);
  assert.equal(registry.calendarAuthorityPolicyId, policyId);
  assert.equal(registry.preimage.OrderedYearRecords.length, 17);
  for (const [i, y] of YEARS.entries()) {
    const core = cores.get(y); const rs = rulesets.get(y); const rec = registry.preimage.OrderedYearRecords[i];
    assert.deepEqual(normalizeMarketSessionCalendarCoreV2(core), core);
    assert.equal(core.coverageFromDate, `${y}-01-01`); assert.equal(core.coverageToDateExclusive, `${y + 1}-01-01`);
    assert.equal(core.calendarAuthorityPolicyId, policyId);
    assert.equal(rs.validFromDate, `${y}-01-01`); assert.equal(rs.validToDateExclusive, `${y + 1}-01-01`);
    assert.deepEqual(rec, { calendarYear: y, calendarCoreId: casId(core), timeZoneRulesetId: casId(rs), normalizedSourceId: casId(normalized.get(y)) });
    assert.equal(policy.yearlyRulesets[i].timeZoneRulesetId, casId(rs));
    assert.equal(registry.preimage.TimeZoneRulesetIds[i], casId(rs));
  }
  assert.deepEqual(Object.keys(registry.preimage).sort(), ['NamespaceVersion', 'OrderedYearRecords', 'TimeZoneRulesetIds', 'CalendarSourceEvidenceIds', 'SpecialClosureEvidenceIds', 'PredecessorRegistryManifestId'].sort()); // closed members (canonical JSON orders keys)
  assert.equal(registry.preimage.PredecessorRegistryManifestId, V2_REGISTRY);
  assert.equal(identityId(registry.preimage), registry.calendarRegistryManifestId);
  assert.equal(provenance.calendarRegistryManifestId, registry.calendarRegistryManifestId);
  assert.equal(provenance.sessionCount, sessions.length);
});

test('timezone rulesets agree with the IANA America/New_York database at every civil day', () => {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const local = (iso) => { const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
  for (const y of YEARS) {
    const rs = rulesets.get(y); assert.equal(rs.civilDateBounds.length, (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000);
    for (const b of rs.civilDateBounds) { assert.equal(local(b.startUtc), `${b.civilDate} 00:00`); assert.equal(local(b.endUtcExclusive), `${addDays(b.civilDate, 1)} 00:00`); }
  }
  for (const s of sessions) { assert.equal(local(s.openUtc), `${s.sessionDate} 09:30`); assert.equal(local(s.closeUtc), `${s.sessionDate} ${s.sessionKind === 'HALF_DAY_SESSION' ? '13:00' : '16:00'}`); }
});

test('raw start 2010-01-04, analogue search 2011-01-03, 2010 is warm-up only', () => {
  const scope = json('XNYS/registry/R0001/ANALOGUE_SEARCH_SCOPE.json');
  assert.deepEqual(scope.preimage, { RawDataStartTarget: '2010-01-04', AnalogueSearchStartTarget: '2011-01-03', DataEndSessionInclusive: '2026-09-04', CalendarRegistryManifestId: registry.calendarRegistryManifestId });
  assert.equal(identityId(scope.preimage), scope.analogueSearchScopeId);
  assert.equal(sessions[0].sessionDate, '2010-01-04');
  assert.equal(sessions.find((s) => s.sessionDate >= '2011-01-01').sessionDate, '2011-01-03');
  assert.equal(scope.rules.sessionsBeforeAnalogueStartMayBeCandidates, false);
  assert.equal(scope.rules.sessionsBeforeAnalogueStartMayBeHistoricalQueries, false);
  assert.equal(scope.derivedCounts.sessions2010InScope, 0);
  assert.equal(scope.derivedCounts.warmupOnlySessionCount, cores.get(2010).sessions.length);
  assert.equal(scope.derivedCounts.scopeSessionCount, sessions.filter((s) => s.sessionDate >= '2011-01-03' && s.sessionDate <= '2026-09-04').length);
});

test('special closures are evidenced closures, never sessions, never derived from bars', () => {
  const special = json('evidence/SPECIAL_CLOSURE_EVIDENCE.json');
  assert.deepEqual(special.closures.map((c) => c.sessionDate), SPECIAL);
  assert.equal(special.missingBarsUsedAsAuthority, false);
  const dates = new Set(sessions.map((s) => s.sessionDate));
  for (const c of special.closures) {
    assert.ok(!dates.has(c.sessionDate), c.sessionDate);
    assert.equal(c.derivedFromMissingBars, false);
    assert.ok(c.primary.length >= 1 && c.corroborating.some((x) => x.assertionKind === 'SPECIAL_FULL_CLOSURE'));
    for (const e of [...c.primary, ...c.corroborating]) assert.ok(registry.preimage.SpecialClosureEvidenceIds.includes(e.evidenceId));
    assert.ok(normalized.get(Number(c.sessionDate.slice(0, 4))).specialClosureDates.includes(c.sessionDate));
  }
});

test('every evidence identity recomputes and every calendar day is supported by evidence', () => {
  assert.deepEqual([...evidence.keys()].sort(), registry.preimage.CalendarSourceEvidenceIds);
  for (const r of evidence.values()) {
    assert.deepEqual(Object.keys(r.preimage).sort(), ['EvidenceSourceId', 'CoverageYear', 'SourceBytesSha256', 'PublishedAt', 'PublicationEvidenceId', 'CapturedAt', 'ClosureAssertions'].sort());
    assert.equal(identityId(r.preimage), r.evidenceId);
    assert.equal(identityId(r.publicationEvidence), r.preimage.PublicationEvidenceId);
    assert.match(r.preimage.SourceBytesSha256, /^[0-9a-f]{64}$/);
  }
  const byDate = new Map(sessions.map((s) => [s.sessionDate, s]));
  for (const y of YEARS) {
    const ns = normalized.get(y); const asserted = new Map();
    for (const id of ns.calendarSourceEvidenceIds) {
      const r = evidence.get(id); assert.ok(r, id);
      for (const a of r.preimage.ClosureAssertions) if (a.date) { const k = asserted.get(a.date) ?? new Set(); k.add(a.kind); asserted.set(a.date, k); }
    }
    for (let d = `${y}-01-01`; d < `${y + 1}-01-01`; d = addDays(d, 1)) {
      const wd = dayOfWeek(d); const s = byDate.get(d); const k = asserted.get(d) ?? new Set();
      if (wd === 0 || wd === 6) { assert.ok(!s, d); continue; }
      if (!s) assert.ok(k.has('FULL_CLOSURE') || k.has('SPECIAL_FULL_CLOSURE'), `unsupported closure ${d}`);
      else {
        assert.ok(!k.has('FULL_CLOSURE') && !k.has('SPECIAL_FULL_CLOSURE'), `session asserted closed ${d}`);
        assert.equal(s.sessionKind === 'HALF_DAY_SESSION', k.has('EARLY_CLOSE'), `half-day support ${d}`);
      }
    }
  }
});

test('V2 is untouched and the V2/V3 delta is exactly the two accepted special closures', () => {
  const v2Registry = gitJson('data/jarvise/session-calendar-historical/XNYS/registry/R0001/registry-manifest.json');
  assert.equal(casId(v2Registry), V2_REGISTRY);
  const v2 = new Map();
  for (const [i, y] of [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].entries()) {
    const core = gitJson(`data/jarvise/session-calendar-historical/XNYS/${y}/session-calendar-core.json`);
    assert.equal(casId(core), v2Registry.calendarCoreIds[i]);
    for (const s of core.sessions) v2.set(s.sessionDate, s);
  }
  const v3 = new Map(sessions.filter((s) => s.sessionDate >= '2018-01-01').map((s) => [s.sessionDate, s]));
  assert.deepEqual([...v2.keys()].filter((d) => !v3.has(d)).sort(), ['2018-12-05', '2025-01-09']);
  assert.deepEqual([...v3.keys()].filter((d) => !v2.has(d)), []);
  for (const [d, s] of v3) assert.deepEqual(s, v2.get(d), d);
  const diff = json('XNYS/registry/R0001/V2_V3_DIFFERENTIAL.json');
  assert.deepEqual(diff.throughDataEnd.removedInV3, ['2018-12-05', '2025-01-09']);
  assert.deepEqual(diff.unexplainedSessionDelta, []);
});

test('window binding, feature windows and horizons are re-minted on V3 with unchanged definitions', () => {
  const doc = json('XNYS/registry/R0001/CALENDAR_WINDOW_BINDING.json');
  const binding = createCalendarWindowBinding({ calendarAuthorityPolicyId: casId(policy), calendarRegistryManifestId: registry.calendarRegistryManifestId, allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'], calendarNamespaceVersion: NAMESPACE });
  assert.deepEqual(doc.calendarWindowBinding, { ...binding, allowedSessionKinds: [...binding.allowedSessionKinds] });
  assert.notEqual(binding.calendarWindowBindingId, doc.v2CalendarWindowBindingId);
  assert.deepEqual(doc.featureWindowSpecs.map((s) => s.featureWindowSpecId), FEATURE_WINDOW_LADDER_V1.map((n) => createFeatureWindowSpec({ sessionCount: n, calendarWindowBinding: binding }).featureWindowSpecId));
  const h = json('XNYS/registry/R0001/HORIZON_BINDINGS.json');
  assert.deepEqual([...HORIZONS_V1], [30, 90, 180, 252]);
  assert.equal(h.horizonDefinitionChanged, false);
  assert.deepEqual(h.horizons.map((x) => x.horizonId), HORIZONS_V1.map((n) => createHorizon({ sessionCount: n, calendarRegistryManifestId: registry.calendarRegistryManifestId }).horizonId));
});
