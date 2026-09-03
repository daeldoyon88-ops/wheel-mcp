#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJsonBytes } from '../research/directional-lab/src/canonical/canonicalJsonV1.mjs';
import { deriveNewYorkUtcInstantV1 } from '../research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs';
import { addDays, assertCivilDate, dayOfWeek } from '../research/directional-lab/src/time/civilDate.mjs';

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROGRAM_ID = 'P1_HISTORICAL_CALENDAR_V2_PRODUCT_R1';
export const PRODUCT_ID = 'P1_HISTORICAL_MARKET_SESSION_CALENDAR_DATASET_R1';
export const CALENDAR_NAMESPACE_VERSION = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/2';
export const VENUE_ID = 'XNYS';
export const YEARS = Object.freeze([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);

const NYSE_ORIGINAL = 'https://www.nyse.com/markets/hours-calendars';
const NASDAQ_ORIGINAL = 'https://www.nasdaqtrader.com/Trader.aspx?id=Calendar';
const PIN = Object.freeze({
  2018: { nyse: ['NYSE-20180313104706.html','20180313104706','34dc1338f65915dccbfe15dee38499ac2bc35ac6522b31ed1db64b953d05aea6',169075,'text/html; charset=ISO-8859-1'], nasdaq: ['Nasdaq-2018.html','20180611230814','4528bce33aec7cfdce0a7b6d1b434f279f5cb185be4d90a1467a1c2f51386d60',62697,'text/html; charset=utf-8','20180605221306','http://www.nasdaqtrader.com/Trader.aspx?id=Calendar'] },
  2019: { nyse: ['NYSE-20190313090715.html','20190313090715','7c2998c0e96196bb232bb3bb45cd0551353c5375d651c9a19021e89dac5d722f',96890,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2019.html','20190601174453','39bc3e45bdf9e9379d2397a64af123feafa2f8b9ce8418cdb6b9e72ee5b998d3',61993,'text/html; charset=utf-8'] },
  2020: { nyse: ['NYSE-20200317114832.html','20200317114832','902b381d9b42c81e96e26f80f6123e9743434232f60be1c7e2e1d5857e0d0137',183790,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2020.html','20200530191653','71591012f13ac1ec68a9ed287ce56180e66275eb7e855bbd925a73bf699c09f0',60931,'text/html; charset=utf-8'] },
  2021: { nyse: ['NYSE-20210531122307.html','20210531122307','af093f08804bf09fa345e46d54ce0ac89c09152e7ef24d22aa527b63d6f3b632',94896,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2021.html','20210609120759','691ea1f7a9b274052eae45a96dffa814690798a9fc53db73705639d1d089507b',62641,'text/html; charset=utf-8'] },
  2022: { nyse: ['NYSE-20210531122307.html','20210531122307','af093f08804bf09fa345e46d54ce0ac89c09152e7ef24d22aa527b63d6f3b632',94896,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2022.html','20220602215354','cf646847ff4a89414c2f491ee20314f5ddd883d0414fc387b718ce48810af87d',55247,'text/html; charset=utf-8'] },
  2023: { nyse: ['NYSE-20230601084000.html','20230601084000','9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f',101642,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2023.html','20230601083950','965d71c7d98d1a3cdb19546d7a81462aafff5490247e44821cea4e89446a8cc9',56106,'text/html; charset=utf-8'] },
  2024: { nyse: ['NYSE-20230601084000.html','20230601084000','9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f',101642,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2024.html','20240515134932','144f5810ca4c77e738405a63fd3470775d11a21c142c3a06ff686e4312937e96',56953,'text/html; charset=utf-8'] },
  2025: { nyse: ['NYSE-20230601084000.html','20230601084000','9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f',101642,'text/html;charset=UTF-8'], nasdaq: ['Nasdaq-2025.html','20250528035718','904df68534be1e61a67e99cf2c734239318416efc5a2b4ce4028a6d749c054b1',56727,'text/html; charset=utf-8'] },
});
const CORRECTION = Object.freeze({ file: 'official-corrections/XNYS/2022/nyse-hours-calendars-20220617191332.html', timestamp: '20220617191332', sha256: 'f3af2298a203d4cca19583adc04cfe0d76c0bd0bb042a941169e47dae3d5b559', byteLength: 99787, mediaType: 'text/html;charset=UTF-8' });
const V1_2026 = Object.freeze({ nyseSha: '49ee8a651ec01ef2866e347842c0fb11309541f247d17aeaaf7ad9d6a513b1ed', nyseLength: 109180, nasdaqSha: 'cbe20bc325c270ecb4459b71bc86695547f3742425701887a8670249eac105cd', nasdaqLength: 53751, sweepSha: '0bc725d68247239820b77e2a1d8de6e4d78375a3d48e5f56c0db65451b48e0f5' });
const ALLOWED_PARENTHETICALS = new Set(['christmas holiday observed','juneteenth holiday observed',"new year's holiday observed",'july 4 holiday observed',"new year's day holiday observed"]);
const MONTHS = Object.freeze({ january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' });
const WEEKDAYS = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH_NAMES = '(January|February|March|April|May|June|July|August|September|October|November|December)';

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function casId(value) { return `sha256:${sha256(canonicalJsonBytes(value))}`; }
function die(code, detail = '') { throw new Error(`${code}${detail ? `: ${detail}` : ''}`); }
function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) die('CALENDAR_SOURCE_TRUTH_MISMATCH', `${label} must be object`);
  const actual = Object.keys(value).sort(); const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) die('CALENDAR_SOURCE_TRUTH_MISMATCH', `${label} fields mismatch`);
}
function decodeHtml(value) {
  return String(value).replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ')
    .replace(/&#x([0-9a-f]+);/gi,(_,h)=>String.fromCodePoint(Number.parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'").replace(/&mdash;/gi,'—').replace(/&ndash;/gi,'–')
    .replace(/\s+/g,' ').trim();
}
function tableCells(fragment) { return [...fragment.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((m)=>decodeHtml(m[1])); }
function tableRows(fragment) { return [...fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m)=>tableCells(m[1])).filter((r)=>r.length); }
function tables(html) { return [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m)=>m[1]); }
function normalizeWhitespace(value) { return String(value).trim().replace(/\s+/g,' '); }
function normalizeStatus(value) { return normalizeWhitespace(value).toLowerCase().replace(/\bp\s*\.?\s*m\s*\.?/g,'p.m.'); }

export function stripNyseObservedParenthetical(value) {
  let text = decodeHtml(value).replace(/\u2019/g,"'").trim().replace(/\*+\s*$/,'').trim();
  if (!/[()]/.test(text)) return text;
  const match = /^([^()]*)\s*\(([^()]*)\)\s*$/.exec(text);
  if (!match) die('CALENDAR_SOURCE_TRUTH_MISMATCH','invalid NYSE observed parenthetical');
  const interior = normalizeWhitespace(match[2]).toLowerCase();
  if (!ALLOWED_PARENTHETICALS.has(interior)) die('CALENDAR_SOURCE_TRUTH_MISMATCH',`unapproved NYSE parenthetical ${interior}`);
  if (/\d{4}|\d{1,2}:\d{2}|a\.m\.|p\.m\.|close early|early close|half[- ]day/i.test(interior) && interior !== 'july 4 holiday observed') die('CALENDAR_SOURCE_TRUTH_MISMATCH','semantic content in NYSE parenthetical');
  return match[1].trim();
}

export function parseEnglishCivilDate(value, calendarYear, { nyse = false, requireYear = false } = {}) {
  const text = nyse ? stripNyseObservedParenthetical(value) : decodeHtml(value);
  const re = new RegExp(`^(?:${WEEKDAYS},\\s*)?${MONTH_NAMES}\\s+(\\d{1,2})(?:,)?(?:\\s+(\\d{4}))?$`,'i');
  const match = re.exec(normalizeWhitespace(text));
  if (!match) die('CALENDAR_SOURCE_TRUTH_MISMATCH',`unparseable date ${text}`);
  const explicit = match[3] ? Number(match[3]) : null;
  if (requireYear && explicit === null) die('CALENDAR_SOURCE_TRUTH_MISMATCH','year-stamped date required');
  if (explicit !== null && explicit !== calendarYear) die('CALENDAR_SOURCE_TRUTH_MISMATCH','date year mismatch');
  const date = `${calendarYear}-${MONTHS[match[1].toLowerCase()]}-${String(Number(match[2])).padStart(2,'0')}`;
  assertCivilDate(date); return date;
}

function uniqueSorted(values, label) {
  if (new Set(values).size !== values.length) die('CALENDAR_SOURCE_TRUTH_MISMATCH',`${label} duplicate`);
  return [...values].sort();
}

export function parseArchivedNyseHoursCalendars(html, calendarYear) {
  const candidates=[];
  for(const table of tables(html)){
    const thead=[...table.matchAll(/<thead\b[^>]*>([\s\S]*?)<\/thead>/gi)].map((m)=>m[1]).join(' ');
    const bodyTable=thead?table.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi,' '):table;
    const allRows=tableRows(bodyTable); const header=thead ? tableCells(thead) : allRows[0];
    if(!header.some((x)=>/^holiday$/i.test(normalizeWhitespace(x)))) continue;
    const yearIndexes=header.map((x,i)=>/^\d{4}$/.test(normalizeWhitespace(x))&&Number(x)===calendarYear?i:-1).filter((i)=>i>=0);
    if(yearIndexes.length===1) candidates.push({table,header,rows:thead?allRows:allRows.slice(1),yearIndex:yearIndexes[0]});
  }
  if(candidates.length!==1) die('CALENDAR_SOURCE_TRUTH_MISMATCH',`NYSE holiday table count ${candidates.length}`);
  const selected=candidates[0]; const full=[];
  for(const row of selected.rows){
    const raw=row[selected.yearIndex]; if(raw===undefined) continue;
    const cell=normalizeWhitespace(raw); if(!cell||(!/[A-Za-z]/.test(cell)&&/[-—–]/.test(cell))) continue;
    full.push(parseEnglishCivilDate(cell,calendarYear,{nyse:true}));
  }
  const early=[];
  for(const paragraph of [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m)=>decodeHtml(m[1]))){
    const normalized=normalizeWhitespace(paragraph).toLowerCase().replace(/\ba\.?m\.?\b/g,'a.m.').replace(/\bp\.?m\.?\b/g,'p.m.');
    if(!normalized.includes('close early at 1:00 p.m.')) continue;
    const dateRe=new RegExp(`${WEEKDAYS},\\s*${MONTH_NAMES}\\s+(\\d{1,2}),\\s*(\\d{4})`,'gi');
    for(const m of paragraph.matchAll(dateRe)) if(Number(m[3])===calendarYear) early.push(parseEnglishCivilDate(`${m[1]} ${m[2]}, ${m[3]}`,calendarYear,{requireYear:true}));
  }
  return { authority:'NYSE', fullClosureDates:uniqueSorted(full,'NYSE closure'), earlyCloseDates:uniqueSorted([...new Set(early)],'NYSE early close') };
}

export function parseArchivedNasdaqTraderCalendar(html, calendarYear) {
  const candidates=[];
  for(const table of tables(html)){
    const rows=tableRows(table); if(!rows.length) continue;
    const header=rows[0].map(normalizeWhitespace);
    const dateIndex=header.findIndex((x)=>/^date$/i.test(x))>=0?header.findIndex((x)=>/^date$/i.test(x)):0;
    const statusIndex=header.findIndex((x)=>/^status$/i.test(x));
    if(statusIndex<0||normalizeWhitespace(header[0])!==String(calendarYear)) continue;
    candidates.push({rows:rows.slice(1),dateIndex,statusIndex});
  }
  if(candidates.length!==1) die('CALENDAR_SOURCE_TRUTH_MISMATCH',`Nasdaq holiday table count ${candidates.length}`);
  const full=[]; const early=[];
  for(const row of candidates[0].rows){
    if(!row[candidates[0].dateIndex]) continue;
    const date=parseEnglishCivilDate(row[candidates[0].dateIndex],calendarYear);
    const status=normalizeStatus(row[candidates[0].statusIndex]);
    if(status==='closed') full.push(date);
    else if(status==='1:00 p.m.') early.push(date);
    else die('CALENDAR_SOURCE_TRUTH_MISMATCH',`unsupported Nasdaq status ${status}`);
  }
  return { authority:'NASDAQ_TRADER', fullClosureDates:uniqueSorted(full,'Nasdaq closure'), earlyCloseDates:uniqueSorted(early,'Nasdaq early close') };
}

function keySet(parsed){return new Set([...parsed.fullClosureDates.map((d)=>`${d}:FULL_CLOSURE`),...parsed.earlyCloseDates.map((d)=>`${d}:HALF_DAY`)]);}
export function reconcileAuthorities(nyse,nasdaq,calendarYear){
  const a=keySet(nyse),b=keySet(nasdaq); const onlyA=[...a].filter((x)=>!b.has(x)); const onlyB=[...b].filter((x)=>!a.has(x));
  const allowed=calendarYear===2022&&onlyA.length===0&&JSON.stringify(onlyB)===JSON.stringify(['2022-06-20:FULL_CLOSURE']);
  if((onlyA.length||onlyB.length)&&!allowed) die('US_EQUITY_CALENDAR_AUTHORITY_CONFLICT',JSON.stringify({onlyNyse:onlyA,onlyNasdaq:onlyB}));
  return { baseConflict:allowed?'2022-06-20:FULL_CLOSURE':null };
}

function correctionOverlay(){return {authority:'NYSE',originalUrl:NYSE_ORIGINAL,archiveTimestamp:'20220617191332',archivedOriginalRetrievalUrl:`https://web.archive.org/web/20220617191332id_/${NYSE_ORIGINAL}`,sha256:CORRECTION.sha256,byteLength:CORRECTION.byteLength,mediaType:CORRECTION.mediaType,baseAnnualSourceTimestamp:'20210531122307',calendarYear:2022,sessionDate:'2022-06-20',finalSessionTruth:'FULL_CLOSURE',orderingRule:'CORRECTION_TIMESTAMP_STRICTLY_AFTER_BASE_AUTHORITY_TIMESTAMP'};}
function annualSource(authority,year,pin){
  const isNasdaq=authority==='NASDAQ_TRADER'; const ts=pin[1]; const requested=pin[5]??ts; const effective=ts; const effectiveOriginal=pin[6]??(isNasdaq?NASDAQ_ORIGINAL:NYSE_ORIGINAL);
  return {authority,role:isNasdaq?'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY':'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY',originalUrl:isNasdaq?NASDAQ_ORIGINAL:NYSE_ORIGINAL,archiveTimestamp:effective,requestedArchiveTimestamp:requested,effectiveArchiveTimestamp:effective,archivedOriginalRetrievalUrl:`https://web.archive.org/web/${effective}id_/${effectiveOriginal}`,sha256:pin[2],byteLength:pin[3],mediaType:pin[4],retrievalBasis:'ARCHIVED_ORIGINAL_BYTES'};
}
function readVerified(path,sha,length){if(!existsSync(path))die('CALENDAR_SOURCE_TRUTH_MISMATCH',`missing ${path}`);const bytes=readFileSync(path);if(bytes.length!==length||sha256(bytes)!==sha)die('CALENDAR_SOURCE_TRUTH_MISMATCH',`identity ${path}`);return bytes;}
function writeBytes(root,path,bytes){const absolute=resolve(root,...path.split('/'));mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,bytes);}
function writeCanonical(root,path,value){writeBytes(root,path,canonicalJsonBytes(value));}
function gitBlob(path){const r=spawnSync('git',['show',`HEAD:${path}`],{cwd:REPOSITORY_ROOT,encoding:null,maxBuffer:2_000_000});if(r.status!==0)die('CALENDAR_SOURCE_TRUTH_MISMATCH',`git blob ${path}`);return Buffer.from(r.stdout);}
function buildRuleset(year){const from=`${year}-01-01`,to=`${year+1}-01-01`,bounds=[];for(let d=from;d<to;d=addDays(d,1))bounds.push({civilDate:d,startUtc:deriveNewYorkUtcInstantV1(d,'00:00'),endUtcExclusive:deriveNewYorkUtcInstantV1(addDays(d,1),'00:00')});return {schemaVersion:'TimeZoneRuleset/1',rulesetFormat:'CIVIL_DATE_UTC_BOUNDS_V1',zoneId:'America/New_York',validFromDate:from,validToDateExclusive:to,civilDateBounds:bounds};}
function buildSessions(year,closures,early){const c=new Set(closures),e=new Set(early),rows=[];for(let d=`${year}-01-01`;d<`${year+1}-01-01`;d=addDays(d,1)){const dow=dayOfWeek(d);if(dow===0||dow===6||c.has(d))continue;const kind=e.has(d)?'HALF_DAY_SESSION':'REGULAR_SESSION';const open=deriveNewYorkUtcInstantV1(d,'09:30'),close=deriveNewYorkUtcInstantV1(d,kind==='HALF_DAY_SESSION'?'13:00':'16:00');rows.push({sessionDate:d,sessionKind:kind,openUtc:open,closeUtc:close,marketValidTime:close});}return rows;}
function manifestPaths(){const path=resolve(REPOSITORY_ROOT,'governance/historical-architecture/P1_HISTORICAL_CALENDAR_V2_PRODUCT_AUTHORIZED_PATHS_R2.json');const m=JSON.parse(readFileSync(path,'utf8'));return m.paths.map((x)=>x.path).filter((p)=>!p.endsWith('P1_HISTORICAL_CALENDAR_V2_PRODUCT_CONSUMPTION_R2.json'));}
export function buildHistoricalCandidate({candidateRoot,evidenceInputRoot}){
  if(!candidateRoot||!evidenceInputRoot)die('P1_BUILDER_FLAGS_REQUIRED');
  if(existsSync(candidateRoot)&&statSync(candidateRoot).isFile())die('P1_CANDIDATE_ROOT_INVALID');
  mkdirSync(candidateRoot,{recursive:true});
  const expected=manifestPaths();
  const codePaths=['research/directional-lab/src/contracts/marketCalendarL3V2.mjs','research/directional-lab/src/canonical/canonicalSchemaRegistryV1.mjs','scripts/buildJarviseSessionCalendarXNYSHistorical.mjs','research/directional-lab/test/market-calendar-l3-v2.test.mjs','research/directional-lab/test/market-calendar-l3-v2-adversarial.test.mjs','research/directional-lab/test/jarvise-session-calendar-xnys-historical.test.mjs'];
  for(const path of codePaths)writeBytes(candidateRoot,path,readFileSync(resolve(REPOSITORY_ROOT,...path.split('/'))));
  const builderSha=sha256(readFileSync(resolve(REPOSITORY_ROOT,'scripts/buildJarviseSessionCalendarXNYSHistorical.mjs')));
  const yearly=new Map();
  for(const year of YEARS.slice(0,-1)){
    const pin=PIN[year];const nyseBytes=readVerified(resolve(evidenceInputRoot,pin.nyse[0]),pin.nyse[2],pin.nyse[3]);const nasdaqBytes=readVerified(resolve(evidenceInputRoot,pin.nasdaq[0]),pin.nasdaq[2],pin.nasdaq[3]);
    const nyse=parseArchivedNyseHoursCalendars(nyseBytes.toString(year===2018?'latin1':'utf8'),year);const nasdaq=parseArchivedNasdaqTraderCalendar(nasdaqBytes.toString('utf8'),year);reconcileAuthorities(nyse,nasdaq,year);
    let closures=[...nyse.fullClosureDates],early=[...nyse.earlyCloseDates];let overlay=null;
    if(year===2022){const correctionBytes=readVerified(resolve(evidenceInputRoot,CORRECTION.file),CORRECTION.sha256,CORRECTION.byteLength);const corrected=parseArchivedNyseHoursCalendars(correctionBytes.toString('utf8'),2022);if(!corrected.fullClosureDates.includes('2022-06-20'))die('US_EQUITY_CALENDAR_AUTHORITY_CONFLICT','correction fact absent');overlay=correctionOverlay();closures=[...new Set([...closures,'2022-06-20'])].sort();}
    yearly.set(year,{nyseBytes,nasdaqBytes,nyse,nasdaq,closures,early,overlay});
  }
  const v1Nyse=gitBlob('data/jarvise/session-calendar/source-evidence/2026/nyse-hours-calendars.html');const v1Nasdaq=gitBlob('data/jarvise/session-calendar/source-evidence/2026/nasdaqtrader-calendar.html');
  if(sha256(v1Nyse)!==V1_2026.nyseSha||v1Nyse.length!==V1_2026.nyseLength||sha256(v1Nasdaq)!==V1_2026.nasdaqSha||v1Nasdaq.length!==V1_2026.nasdaqLength)die('CALENDAR_SOURCE_TRUTH_MISMATCH','2026 Git evidence');
  const v1Core=JSON.parse(gitBlob('data/jarvise/session-calendar/XNYS/2026/session-calendar-core.json').toString('utf8'));yearly.set(2026,{closures:[],early:[],sessions:v1Core.sessions,overlay:null});
  const rulesets=new Map(YEARS.map((year)=>{const value=buildRuleset(year);return [year,{value,id:casId(value)}]}));
  const policy={schemaVersion:'MarketCalendarAuthorityPolicy/2',calendarNamespaceVersion:CALENDAR_NAMESPACE_VERSION,venueId:VENUE_ID,zoneId:'America/New_York',rulesetFormat:'CIVIL_DATE_UTC_BOUNDS_V1',allowedSessionKinds:['HALF_DAY_SESSION','REGULAR_SESSION'],yearlyRulesets:YEARS.map((year)=>({calendarYear:year,zoneId:'America/New_York',rulesetFormat:'CIVIL_DATE_UTC_BOUNDS_V1',timeZoneRulesetId:rulesets.get(year).id}))};const policyId=casId(policy);
  const cores=new Map();for(const year of YEARS){const sessions=year===2026?yearly.get(year).sessions:buildSessions(year,yearly.get(year).closures,yearly.get(year).early);const value={schemaVersion:'MarketSessionCalendarCore/2',calendarAuthorityPolicyId:policyId,venueId:VENUE_ID,timeZoneRulesetId:rulesets.get(year).id,coverageFromDate:`${year}-01-01`,coverageToDateExclusive:`${year+1}-01-01`,sessions};cores.set(year,{value,id:casId(value)});}
  const registry={schemaVersion:'MarketCalendarRegistryManifest/2',calendarAuthorityPolicyId:policyId,calendarCoreIds:YEARS.map((y)=>cores.get(y).id),supersedesCalendarRegistryManifestId:null};const registryId=casId(registry);
  writeCanonical(candidateRoot,'data/jarvise/session-calendar-historical/XNYS/authority-policy.json',policy);
  for(const year of YEARS){let sourceDigests=null,sweep=null,sourceDigestsId=null,sweepId=null,annualSources=[];const data=yearly.get(year);
    if(year<2026){const pin=PIN[year];annualSources=[annualSource('NYSE',year,pin.nyse),annualSource('NASDAQ_TRADER',year,pin.nasdaq)];sourceDigests={schemaVersion:'JarviseHistoricalSessionCalendarSourceDigests/1',calendarYear:year,annualSources,officialCorrectionOverlay:data.overlay};sweep={schemaVersion:'JarviseHistoricalExceptionalClosureSweep/1',calendarYear:year,coverageFromDate:`${year}-01-01`,coverageToDateInclusive:`${year}-12-31`,boundSourceIds:[pin.nyse[2],pin.nasdaq[2]],result:year===2022?'EXTRA_ROWS_IDENTIFIED':'INSUFFICIENT',identifiedEvents:year===2022?[{sessionDate:'2022-06-20',sessionTruth:'FULL_CLOSURE'}]:[],completenessRule:'EXCEPTIONAL_CLOSURE_COMPLETENESS_NOT_ESTABLISHABLE_FROM_SCHEDULED_CALENDAR_HTML_ALONE',officialCorrectionOverlay:data.overlay};sourceDigestsId=sha256(canonicalJsonBytes(sourceDigests));sweepId=sha256(canonicalJsonBytes(sweep));
      const base=`data/jarvise/session-calendar-historical/source-evidence/${year}`;writeBytes(candidateRoot,`${base}/nyse-hours-calendars.html`,data.nyseBytes);writeBytes(candidateRoot,`${base}/nasdaqtrader-calendar.html`,data.nasdaqBytes);writeCanonical(candidateRoot,`${base}/SOURCE_DIGESTS.json`,sourceDigests);writeCanonical(candidateRoot,`${base}/EXCEPTIONAL_CLOSURE_SWEEP.json`,sweep);
    }else{sweepId=V1_2026.sweepSha;annualSources=[{authority:'NYSE',role:'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY',sha256:V1_2026.nyseSha,byteLength:V1_2026.nyseLength,originalUrl:NYSE_ORIGINAL,archivedOriginalRetrievalUrl:'GIT_COMMITTED_V1_2026_SOURCE_EVIDENCE'},{authority:'NASDAQ_TRADER',role:'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY',sha256:V1_2026.nasdaqSha,byteLength:V1_2026.nasdaqLength,originalUrl:NASDAQ_ORIGINAL,archivedOriginalRetrievalUrl:'GIT_COMMITTED_V1_2026_SOURCE_EVIDENCE'}];}
    const normalized={schemaVersion:'JarviseHistoricalSessionCalendarMaterializationInput/1',calendarYear:year,calendarNamespaceVersion:CALENDAR_NAMESPACE_VERSION,venueId:VENUE_ID,zoneId:'America/New_York',annualSourceIds:year<2026?[PIN[year].nyse[2],PIN[year].nasdaq[2]]:[V1_2026.nyseSha,V1_2026.nasdaqSha],officialCorrectionOverlay:data.overlay,exceptionalClosureSweepId:sweepId,fullClosureDates:year<2026?data.closures:v1Core.sessions?[]:[],earlyCloseDates:year<2026?data.early:[]};
    if(year===2026){const sessionDates=new Set(v1Core.sessions.map((s)=>s.sessionDate));const all=[];for(let d='2026-01-01';d<'2027-01-01';d=addDays(d,1))if(![0,6].includes(dayOfWeek(d))&&!sessionDates.has(d))all.push(d);normalized.fullClosureDates=all;normalized.earlyCloseDates=v1Core.sessions.filter((s)=>s.sessionKind==='HALF_DAY_SESSION').map((s)=>s.sessionDate);}
    const provenance={schemaVersion:'JarviseHistoricalSessionCalendarProvenance/1',programId:PROGRAM_ID,productId:PRODUCT_ID,calendarYear:year,venueId:VENUE_ID,calendarNamespaceVersion:CALENDAR_NAMESPACE_VERSION,calendarAuthorityPolicyId:policyId,timeZoneRulesetId:rulesets.get(year).id,calendarCoreId:cores.get(year).id,annualSources,officialCorrectionOverlay:data.overlay,exceptionalClosureEvidence:{basis:year<2026?'HISTORICAL_BOUND_SCHEDULED_CALENDAR_HTML':'APPROVED_CROSS_NAMESPACE_V1_2026_SOURCE_EVIDENCE_REUSE',result:year<2026?(year===2022?'EXTRA_ROWS_IDENTIFIED':'INSUFFICIENT'):'NONE_FOUND',referenceId:sweepId},sourceDigestsId,normalizedSourceId:sha256(canonicalJsonBytes(normalized)),buildContractId:builderSha};
    const base=`data/jarvise/session-calendar-historical/XNYS/${year}`;writeCanonical(candidateRoot,`${base}/normalized-source.json`,normalized);writeCanonical(candidateRoot,`${base}/timezone-ruleset.json`,rulesets.get(year).value);writeCanonical(candidateRoot,`${base}/session-calendar-core.json`,cores.get(year).value);writeCanonical(candidateRoot,`${base}/PROVENANCE.json`,provenance);
  }
  writeCanonical(candidateRoot,'data/jarvise/session-calendar-historical/XNYS/registry/R0001/registry-manifest.json',registry);
  writeCanonical(candidateRoot,'data/jarvise/session-calendar-historical/XNYS/registry/R0001/PROVENANCE.json',{schemaVersion:'JarviseHistoricalSessionCalendarRegistryProvenance/1',programId:PROGRAM_ID,productId:PRODUCT_ID,venueId:VENUE_ID,calendarNamespaceVersion:CALENDAR_NAMESPACE_VERSION,calendarAuthorityPolicyId:policyId,calendarRegistryManifestId:registryId,calendarCoreIds:registry.calendarCoreIds,supersedesCalendarRegistryManifestId:null,coverageFromDate:'2018-01-01',coverageToDateExclusive:'2027-01-01',buildContractId:builderSha});
  const found=[];const walk=(dir)=>{for(const entry of readdirSync(dir,{withFileTypes:true})){const p=resolve(dir,entry.name);if(entry.isDirectory())walk(p);else found.push(p.slice(resolve(candidateRoot).length+1).replace(/\\/g,'/'));}};walk(candidateRoot);found.sort();const wanted=[...expected].sort();if(JSON.stringify(found)!==JSON.stringify(wanted))die('P1_CANDIDATE_PATHSET_MISMATCH',JSON.stringify({missing:wanted.filter((p)=>!found.includes(p)),unexpected:found.filter((p)=>!wanted.includes(p))}));
  return {outputPathCount:found.length,calendarAuthorityPolicyId:policyId,calendarRegistryManifestId:registryId,paths:found};
}
function args(argv){const out={};for(let i=0;i<argv.length;i+=2){if(!argv[i]?.startsWith('--')||argv[i+1]===undefined)die('P1_BUILDER_FLAGS_REQUIRED');out[argv[i].slice(2)]=resolve(argv[i+1]);}if(Object.keys(out).sort().join(',')!=='candidate-root,evidence-input-root')die('P1_BUILDER_FLAGS_REQUIRED');return out;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const a=args(process.argv.slice(2));console.log(JSON.stringify(buildHistoricalCandidate({candidateRoot:a['candidate-root'],evidenceInputRoot:a['evidence-input-root']}),null,2));}catch(error){console.error(error?.stack||String(error));process.exitCode=1;}}
