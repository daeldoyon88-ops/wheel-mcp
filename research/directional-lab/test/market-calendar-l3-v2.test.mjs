import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeMarketCalendarAuthorityPolicyV2,
  normalizeMarketCalendarRegistryManifestV2,
  normalizeMarketSessionCalendarCoreV2,
} from '../src/contracts/marketCalendarL3V2.mjs';

const ROOT=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const CANDIDATE=process.env.P1_CANDIDATE_ROOT;
if(!CANDIDATE)throw new Error('P1_CANDIDATE_ROOT required');
const json=(p)=>JSON.parse(readFileSync(resolve(CANDIDATE,...p.split('/')),'utf8'));
const year=(y,n)=>json(`data/jarvise/session-calendar-historical/XNYS/${y}/${n}`);
const policy=json('data/jarvise/session-calendar-historical/XNYS/authority-policy.json');
const registry=json('data/jarvise/session-calendar-historical/XNYS/registry/R0001/registry-manifest.json');

test('U1 CY2026 source truth is preserved',()=>{const old=JSON.parse(readFileSync(resolve(ROOT,'data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json'),'utf8'));assert.deepEqual(year(2026,'session-calendar-core.json').sessions,old.sessions);});
test('U2 registry namespace and provenance graph are closed',()=>{const p=json('data/jarvise/session-calendar-historical/XNYS/registry/R0001/PROVENANCE.json');assert.equal(p.calendarNamespaceVersion,'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/2');assert.deepEqual(p.calendarCoreIds,registry.calendarCoreIds);});
test('V2.1 one policy id binds 2018 and 2026',()=>{assert.equal(year(2018,'session-calendar-core.json').calendarAuthorityPolicyId,year(2026,'session-calendar-core.json').calendarAuthorityPolicyId);});
test('V2.2 dual 2026 facts equal while ids differ',()=>{const a=year(2026,'session-calendar-core.json'),b=JSON.parse(readFileSync(resolve(ROOT,'data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json'),'utf8'));const oldProvenance=JSON.parse(readFileSync(resolve(ROOT,'data/jarvise/session-calendar/XNYS/2026/PROVENANCE.json'),'utf8'));assert.deepEqual(a.sessions,b.sessions);assert.notEqual(year(2026,'PROVENANCE.json').calendarCoreId,oldProvenance.calendarCoreId);});
test('V2.3 registry parent is closed to historical V2',()=>{assert.equal(registry.schemaVersion,'MarketCalendarRegistryManifest/2');assert.equal(registry.supersedesCalendarRegistryManifestId,null);assert.equal(normalizeMarketCalendarRegistryManifestV2(registry).schemaVersion,'MarketCalendarRegistryManifest/2');});
test('V2.4 every core coverage equals its ruleset bounds',()=>{for(const y of [2018,2019,2020,2021,2022,2023,2024,2025,2026]){const c=year(y,'session-calendar-core.json'),r=year(y,'timezone-ruleset.json');assert.equal(c.coverageFromDate,r.validFromDate);assert.equal(c.coverageToDateExclusive,r.validToDateExclusive);}});
test('V2.5 subset core normalization remains admissible',()=>{const c=structuredClone(year(2020,'session-calendar-core.json'));c.coverageFromDate='2020-01-02';c.sessions=c.sessions.filter((s)=>s.sessionDate>='2020-01-02');assert.equal(normalizeMarketSessionCalendarCoreV2(c).coverageFromDate,'2020-01-02');});
test('V2.6 partial and disjoint bounds are detectable',()=>{const c=year(2021,'session-calendar-core.json'),r=year(2021,'timezone-ruleset.json');assert.ok(c.coverageFromDate>=r.validFromDate&&c.coverageToDateExclusive<=r.validToDateExclusive);assert.ok('2020-12-31'<r.validFromDate&&'2022-01-02'>r.validToDateExclusive);});
test('V2.7 nine distinct ruleset ids are bound',()=>{assert.equal(policy.yearlyRulesets.length,9);assert.equal(new Set(policy.yearlyRulesets.map((x)=>x.timeZoneRulesetId)).size,9);});
test('V2.8 V1 core is rejected by V2 normalizer',()=>{const old=JSON.parse(readFileSync(resolve(ROOT,'data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json'),'utf8'));assert.throws(()=>normalizeMarketSessionCalendarCoreV2(old));});
test('V2.9 policy stitch zone format and years are exact',()=>{const p=normalizeMarketCalendarAuthorityPolicyV2(policy);assert.deepEqual(p.yearlyRulesets.map((x)=>x.calendarYear),[2018,2019,2020,2021,2022,2023,2024,2025,2026]);assert.ok(p.yearlyRulesets.every((x)=>x.zoneId===p.zoneId&&x.rulesetFormat===p.rulesetFormat));});
