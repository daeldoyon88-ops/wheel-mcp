#!/usr/bin/env node
/**
 * JARVISE_DH_2011 WU2B - Calendar V3 (WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/3) builder.
 *
 * Deterministic and network-free. Every calendar assertion is derived from the
 * Owner-accepted WU2A R1+R2+R3 evidence cohort (exact source bytes, re-hashed) or
 * from governed canonical inputs read as git blobs at HEAD. Missing market bars
 * are never read here: they are corroboration only and live in the audit tooling.
 *
 * Calendar V2 is immutable and only read. The WU2A evidence roots are only read.
 * Output is canonical JSON (CanonicalJSON/1 + LF) and contains no wall-clock time.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROGRAM_ID = 'JARVISE_DH_2011_WU2';
export const WORK_UNIT = 'WU2B';
export const PUBLICATION_IDENTITY = 'WHEEL::GATE27::JARVISE_DH_2011_WU2';
export const NAMESPACE = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/3';
export const V2_NAMESPACE = 'WHEEL_JARVISE_US_EQUITY_XNYS_CALENDAR/2';
export const VENUE_ID = 'XNYS';
export const ZONE_ID = 'America/New_York';
export const YEARS = Object.freeze(Array.from({ length: 17 }, (_, i) => 2010 + i));
export const DATA_ROOT = 'data/jarvise/session-calendar-xnys-v3';
export const RAW_DATA_START_TARGET = '2010-01-04';
export const ANALOGUE_SEARCH_START_TARGET = '2011-01-03';
export const DATA_END_SESSION_INCLUSIVE = '2026-09-04';
export const N5_INTERVAL = Object.freeze({ fromDate: '2026-08-27', toDateInclusive: '2026-09-04' });
export const SPECIAL_CLOSURE_DATES = Object.freeze(['2012-10-29', '2012-10-30', '2018-12-05', '2025-01-09']);
export const OWNER_EVIDENCE_ACCEPTANCE = 'OWNER_ACCEPT_JARVISE_DH_2011_WU2A_R1_R2_R3_EVIDENCE_COHORT_R1';
export const OWNER_BUILD_AUTHORITY = 'OWNER_AUTHORIZE_JARVISE_DH_2011_WU2B_CALENDAR_V3_BUILD_R1';

const COHORT = Object.freeze({
  R1: { dir: 'JARVISE_DH_2011_WU2A_EVIDENCE_R1', manifestSha256: 'b178f907dba3d547922e5ed599fcd4beb2651d4b58f52564e1c2fdcbfa87b90a', reportSha256: '5112b9ded291d1b0593282f6d30c3ba0384aa952f2d128f0aa38589e5eae8f26' },
  R2: { dir: 'JARVISE_DH_2011_WU2A_EVIDENCE_R2', manifestSha256: '997da9a983b160bf5a5c3591bcc31a5e2d3c96049b1c0d17fcb041845c9d2b53', reportSha256: 'e4b2784bccaf07176b5dbb1a77b8b1e31f4579f032eeeb3a870af5823cbf1bf9' },
  R3: { dir: 'JARVISE_DH_2011_WU2A_EVIDENCE_R3', manifestSha256: 'd9be0fdf82b947f868661a2b90c8911e5358527bda3d7bf8ca76b9600578cd44', reportSha256: '0a234872a2b5de93b2446d37db19000e42fd9233141b5e7a76a98276021753ea' },
});

/** Calendar V2 immutable identities (read-only predecessor). */
const V2 = Object.freeze({
  registryManifestId: 'sha256:3df426b405f9ae43cb996b14f310d8efed55ce9f6377ed68dea4cd6ef939883f',
  authorityPolicyId: 'sha256:6bb5d738b9df8593187bcd5111d389dfef8add2ffc3d6ad4fedeebfcd1a59c41',
  calendarWindowBindingId: '3fe7456e03175fc49fb8af810d2050e58f34d2e3d548b27ad071db8957882308',
  bindingDocumentSha256: '15f5fd28f8bca3b09c573e1c64679573ebf8ed297a1aecaac14812d8d63ca612',
  years: Object.freeze([2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]),
});

/** V2-pinned annual source digests (scripts/buildJarviseSessionCalendarXNYSHistorical.mjs PIN). */
const V2_PIN = Object.freeze({
  2018: { nyse: ['34dc1338f65915dccbfe15dee38499ac2bc35ac6522b31ed1db64b953d05aea6', 169075, '20180313104706'], nasdaq: ['4528bce33aec7cfdce0a7b6d1b434f279f5cb185be4d90a1467a1c2f51386d60', 62697, '20180611230814'] },
  2019: { nyse: ['7c2998c0e96196bb232bb3bb45cd0551353c5375d651c9a19021e89dac5d722f', 96890, '20190313090715'], nasdaq: ['39bc3e45bdf9e9379d2397a64af123feafa2f8b9ce8418cdb6b9e72ee5b998d3', 61993, '20190601174453'] },
  2020: { nyse: ['902b381d9b42c81e96e26f80f6123e9743434232f60be1c7e2e1d5857e0d0137', 183790, '20200317114832'], nasdaq: ['71591012f13ac1ec68a9ed287ce56180e66275eb7e855bbd925a73bf699c09f0', 60931, '20200530191653'] },
  2021: { nyse: ['af093f08804bf09fa345e46d54ce0ac89c09152e7ef24d22aa527b63d6f3b632', 94896, '20210531122307'], nasdaq: ['691ea1f7a9b274052eae45a96dffa814690798a9fc53db73705639d1d089507b', 62641, '20210609120759'] },
  2022: { nyse: ['af093f08804bf09fa345e46d54ce0ac89c09152e7ef24d22aa527b63d6f3b632', 94896, '20210531122307'], nasdaq: ['cf646847ff4a89414c2f491ee20314f5ddd883d0414fc387b718ce48810af87d', 55247, '20220602215354'] },
  2023: { nyse: ['9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f', 101642, '20230601084000'], nasdaq: ['965d71c7d98d1a3cdb19546d7a81462aafff5490247e44821cea4e89446a8cc9', 56106, '20230601083950'] },
  2024: { nyse: ['9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f', 101642, '20230601084000'], nasdaq: ['144f5810ca4c77e738405a63fd3470775d11a21c142c3a06ff686e4312937e96', 56953, '20240515134932'] },
  2025: { nyse: ['9a46162d7a0bfd229f18db2d2b152486f8e46c67c01eeb70048aee8dfa3dcb7f', 101642, '20230601084000'], nasdaq: ['904df68534be1e61a67e99cf2c734239318416efc5a2b4ce4028a6d749c054b1', 56727, '20250528035718'] },
});
const V1_2026_NYSE = Object.freeze({ sha256: '49ee8a651ec01ef2866e347842c0fb11309541f247d17aeaaf7ad9d6a513b1ed', byteLength: 109180, gitPath: 'data/jarvise/session-calendar/source-evidence/2026/nyse-hours-calendars.html', retrievedAtUtc: '2026-08-27T02:54:58.706Z', originalUrl: 'https://www.nyse.com/trade/hours-calendars' });
const V1_2026_SWEEP = Object.freeze({ sha256: '0bc725d68247239820b77e2a1d8de6e4d78375a3d48e5f56c0db65451b48e0f5', gitPath: 'data/jarvise/session-calendar/source-evidence/2026/EXCEPTIONAL_CLOSURE_SWEEP.json' });
const NYSE_HOURS_URL = 'https://www.nyse.com/markets/hours-calendars';
const NASDAQ_CAL_URL = 'https://www.nasdaqtrader.com/Trader.aspx?id=Calendar';

/**
 * Scheduled-calendar plan per year. Entries name cohort objects ({run, objectId})
 * or a V2-governed git blob ({v2Year}). `parser` selects the deterministic parser.
 */
const SCHEDULED_PLAN = Object.freeze({
  2010: { nyse: [{ run: 'R1', objectId: '026_N2_2010_NYSE_LEGACY', inYear: true }], nasdaq: [{ run: 'R1', objectId: '018_N2_2010_NASDAQ', parser: 'V3_NASDAQ' }] },
  2011: { nyse: [{ run: 'R1', objectId: '027_N2_2011_NYSE_LEGACY', inYear: true }, { run: 'R1', objectId: '026_N2_2010_NYSE_LEGACY', inYear: false }], nasdaq: [{ run: 'R1', objectId: '019_N2_2011_NASDAQ', parser: 'V3_NASDAQ' }] },
  2012: { nyse: [{ run: 'R1', objectId: '042_N2_2012_NYSE_NYX_HOLIDAYS', inYear: true }, { run: 'R1', objectId: '027_N2_2011_NYSE_LEGACY', inYear: false }], nasdaq: [{ run: 'R1', objectId: '020_N2_2012_NASDAQ', parser: 'V3_NASDAQ' }] },
  2013: { nyse: [{ run: 'R1', objectId: '042_N2_2012_NYSE_NYX_HOLIDAYS', inYear: false }, { run: 'R1', objectId: '027_N2_2011_NYSE_LEGACY', inYear: false }], nasdaq: [{ run: 'R1', objectId: '021_N2_2013_NASDAQ', parser: 'V3_NASDAQ' }] },
  2014: { nyse: [{ run: 'R1', objectId: '042_N2_2012_NYSE_NYX_HOLIDAYS', inYear: false }], nasdaq: [{ run: 'R1', objectId: '022_N2_2014_NASDAQ', parser: 'V2_NASDAQ' }] },
  2015: { nyse: [{ run: 'R1', objectId: '029_N2_2015_NYSE', inYear: true }], nasdaq: [{ run: 'R1', objectId: '023_N2_2015_NASDAQ', parser: 'V2_NASDAQ' }] },
  2016: { nyse: [{ run: 'R1', objectId: '030_N2_2016_NYSE', inYear: true }, { run: 'R1', objectId: '029_N2_2015_NYSE', inYear: false }], nasdaq: [{ run: 'R1', objectId: '024_N2_2016_NASDAQ', parser: 'V2_NASDAQ' }] },
  2017: { nyse: [{ run: 'R1', objectId: '031_N2_2017_NYSE', inYear: true }, { run: 'R1', objectId: '030_N2_2016_NYSE', inYear: false }], nasdaq: [{ run: 'R1', objectId: '025_N2_2017_NASDAQ', parser: 'V2_NASDAQ' }] },
});
/** The ten V2 annual blobs whose committed git bytes are EOL-normalized; R1 re-acquired the exact declared bytes. */
const V2_REPAIRED_FROM_R1 = Object.freeze({
  '2018:nyse': '001_N3_2018_NYSE', '2018:nasdaq': '002_N3_2018_NASDAQ_TRADER',
  '2019:nyse': '003_N3_2019_NYSE', '2019:nasdaq': '004_N3_2019_NASDAQ_TRADER',
  '2020:nasdaq': '005_N3_2020_NASDAQ_TRADER', '2021:nasdaq': '006_N3_2021_NASDAQ_TRADER',
  '2022:nasdaq': '007_N3_2022_NASDAQ_TRADER', '2023:nasdaq': '008_N3_2023_NASDAQ_TRADER',
  '2024:nasdaq': '009_N3_2024_NASDAQ_TRADER', '2025:nasdaq': '010_N3_2025_NASDAQ_TRADER',
});
/** Additional corroborating NYSE pages for V2-era years (V3 legacy parser; must agree). */
const V2_ERA_NYSE_CORROBORATION = Object.freeze({ 2018: ['031_N2_2017_NYSE'], 2019: ['031_N2_2017_NYSE'] });

/**
 * Special closures: accepted documentary result. Each assertion is re-verified as a
 * verbatim quote in the exact source text. Order inside `primary`/`corroborating` is fixed.
 */
const SPECIAL_CLOSURES = Object.freeze([
  {
    sessionDate: '2012-10-29', event: 'HURRICANE_SANDY',
    primary: [{ run: 'R2', objectId: '023_A_BW_NYSE_EURONEXT_STATEMENT_CLOSURE_MONDAY_20121028', authority: 'NYSE_EURONEXT', quote: 'NYSE Euronext (NYX) will close its markets on Monday, Oct. 29, 2012', dateline: 'October 28, 2012 11:20 PM Eastern Daylight Time' }],
    corroborating: [{ run: 'R2', objectId: '009_A_GNW_NASDAQOMX_500468_CLOSED_MONDAY', authority: 'NASDAQ_OMX', quote: 'will be closed for business on Monday, October 29', dateline: 'October 28, 2012 23:30 ET' }],
  },
  {
    sessionDate: '2012-10-30', event: 'HURRICANE_SANDY',
    primary: [{ run: 'R1', objectId: '047_N4_SANDY_NYX_SANDY_NEAREST_20121030', authority: 'NYSE_EURONEXT', quote: 'NYSE Euronext (NYX) will close its markets in coordination with all U.S. equities, bonds, options and derivatives markets on Tuesday, Oct. 30, 2012', dateline: null }],
    corroborating: [
      { run: 'R2', objectId: '010_B_GNW_NASDAQOMX_500742_CLOSED_TUESDAY', authority: 'NASDAQ_OMX', quote: 'will be closed for business on Tuesday, October 30', dateline: 'October 29, 2012 13:37' },
      { run: 'R2', objectId: '023_A_BW_NYSE_EURONEXT_STATEMENT_CLOSURE_MONDAY_20121028', authority: 'NYSE_EURONEXT', quote: 'and pending confirmation on Tuesday, Oct. 30, 2012', dateline: 'October 28, 2012 11:20 PM Eastern Daylight Time', role: 'ANNOUNCED_PENDING_CONFIRMATION_ONLY' },
    ],
  },
  {
    sessionDate: '2018-12-05', event: 'NATIONAL_DAY_OF_MOURNING_GEORGE_H_W_BUSH',
    primary: [{ run: 'R1', objectId: '033_N4_BUSH_ICE_PRESS_20181201', authority: 'ICE_NYSE_GROUP', quote: 'will be closed on Wednesday, December 5, 2018 in observance of the National Day of Mourning', dateline: null }],
    corroborating: [{ run: 'R2', objectId: '021_B_GNW_NASDAQ_BUSH_20181201', authority: 'NASDAQ', quote: 'closing all Nasdaq U.S. equities and options markets on Wednesday, December 5, 2018', dateline: 'December 01, 2018 12:13 ET' }],
  },
  {
    sessionDate: '2025-01-09', event: 'NATIONAL_DAY_OF_MOURNING_JIMMY_CARTER',
    primary: [{ run: 'R1', objectId: '034_N4_CARTER_ICE_PRESS_20241230', authority: 'ICE_NYSE_GROUP', quote: 'will close all NYSE Group equity and options markets on Thursday, January 9, 2025', dateline: null }],
    corroborating: [{ run: 'R2', objectId: '022_B_GNW_NASDAQ_CARTER_20241230', authority: 'NASDAQ', quote: 'closing all Nasdaq U.S. equities and options markets on Thursday, January 9, 2025', dateline: null }],
  },
]);
/** Documented, non-asserting Sandy context (accepted cohort record; never used as a closure assertion). */
const SANDY_CONTEXT = Object.freeze([
  { run: 'R1', objectId: '048_N4_SANDY_NYX_SANDY_20121028', disposition: 'SUPERSEDED_PRE_DECISION_STATEMENT', quote: 'markets to operate normally on Monday', note: 'Captured 2012-10-28T20:04:00Z, before the NYSE Euronext closure statement issued October 28, 2012 11:20 PM EDT (2012-10-29T03:20Z); superseded by the later statement of the same issuer.' },
  { run: 'R1', objectId: '047_N4_SANDY_NYX_SANDY_NEAREST_20121030', disposition: 'DOCUMENTED_SOURCE_DATE_DEFECT', quote: 'This follows the closure of U.S. markets on Monday, Oct. 28, 2012.', note: 'Oct. 28, 2012 was a Sunday; the weekday/date pair is internally inconsistent. Not used to assert 2012-10-29, which rests on R2 object 023 and R2 object 009.' },
  { run: 'R1', objectId: '032_N4_SANDY_NYSE_PRESS_1351545708685', disposition: 'REOPENING_STATEMENT', quote: 'will open for normal trading operations in coordination with all U.S. equities, bonds, options and derivatives markets on Wednesday, Oct. 31, 2012', note: 'Confirms 2012-10-31 as a regular session after the two-day closure.' },
]);
const OBJECT_023_ADVISORY = 'R2 object 023: archive index (CDX) digest 4L3ELCWAOJRRZ6E4XJZA4MWYDE5ENJCP differs from the SHA-1 of the served bytes DCTCXKVOAQNGJRMWA75JQGKTRTYXIX2N; the CDX SHA-1 was not independently verified. Bytes are used exactly as accepted (sha256 88e9a2a561ae6c4a363efb13ddfe17eaabf616ba378598585eab17c93d31e4d9); this note is documentary metadata and grants no permission to alter them.';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const MONTH_RE = '(January|February|March|April|May|June|July|August|September|October|November|December)';
const WEEKDAY_RE = '(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';

function die(code, detail = '') { const e = new Error(`${code}${detail ? `: ${detail}` : ''}`); e.code = code; throw e; }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function pad2(n) { return String(n).padStart(2, '0'); }
function captureIso(ts) { if (!/^\d{14}$/.test(ts)) die('STOP_SOURCE_PROVENANCE_UNPROVEN', `capture timestamp ${ts}`); return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}.000Z`; }
function isoMs(value) { const d = new Date(value); if (Number.isNaN(d.getTime())) die('STOP_SOURCE_PROVENANCE_UNPROVEN', `instant ${value}`); return d.toISOString(); }

let L = null; // loaded repository modules
async function loadModules(repoRoot) {
  const imp = (p) => import(pathToFileURL(resolve(repoRoot, ...p.split('/'))).href);
  const [cj, gcj, civil, macro, cal2, v2b, g23, g22] = await Promise.all([
    imp('research/directional-lab/src/canonical/canonicalJsonV1.mjs'),
    imp('governance/tools/canonical-json.mjs'),
    imp('research/directional-lab/src/time/civilDate.mjs'),
    imp('research/directional-lab/src/contracts/macroIngestionContractsL4BV1.mjs'),
    imp('research/directional-lab/src/contracts/marketCalendarL3V2.mjs'),
    imp('scripts/buildJarviseSessionCalendarXNYSHistorical.mjs'),
    imp('governance/gates/GATE23/implementation/feature-window-v1.mjs'),
    imp('governance/gates/GATE22/implementation/temporal-horizon-v1.mjs'),
  ]);
  return { cj, gcj, civil, macro, cal2, v2b, g23, g22 };
}

/** File bytes: CanonicalJSON/1 + LF; both repository implementations must agree byte-for-byte. */
function fileBytes(value) {
  const a = L.cj.canonicalJsonBytes(value);
  const b = Buffer.from(`${L.gcj.canonicalize(value)}\n`, 'utf8');
  if (!a.equals(b)) die('STOP_PROOF_DRIFTED', 'canonical JSON implementations disagree');
  if (a.includes(0x0d)) die('STOP_BYTE_FIDELITY_FAILED', 'CR byte in canonical output');
  return a;
}
/** Calendar-object CAS id (V2 convention: sha256 over canonical bytes incl. LF). */
function casId(value) { return `sha256:${sha256(fileBytes(value))}`; }
/** Successor identity id (contract: sha256Canonical over the closed preimage). */
function identityId(preimage) { return `sha256:${L.gcj.sha256Canonical(preimage)}`; }

function gitBlob(repoRoot, path) {
  const r = spawnSync('git', ['-C', repoRoot, 'cat-file', 'blob', `HEAD:${path}`], { encoding: null, maxBuffer: 1 << 28 });
  if (r.status !== 0) die('STOP_PROOF_DRIFTED', `git blob HEAD:${path}`);
  return Buffer.from(r.stdout);
}

// ---------------------------------------------------------------- cohort access
function loadCohort(evidenceRoot) {
  const cohort = {};
  for (const [run, spec] of Object.entries(COHORT)) {
    const root = resolve(evidenceRoot, spec.dir);
    const manifestBytes = readFileSync(resolve(root, 'ACQUISITION_MANIFEST.json'));
    const reportBytes = readFileSync(resolve(root, 'ACQUISITION_REPORT.md'));
    if (sha256(manifestBytes) !== spec.manifestSha256) die('STOP_PROOF_DRIFTED', `${run} manifest`);
    if (sha256(reportBytes) !== spec.reportSha256) die('STOP_PROOF_DRIFTED', `${run} report`);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.programId !== PROGRAM_ID) die('STOP_AUTHORITY_CONFLICT', `${run} programId`);
    const objects = new Map();
    for (const o of manifest.objects) {
      const id = o.objectId ?? o.itemId;
      const ref = run === 'R3' ? o.object : o.acquiredBytes;
      objects.set(run === 'R3' ? `${String(o.seq).padStart(3, '0')}_${o.itemId}` : id, { record: o, ref, decoded: run === 'R3' ? null : o.decodedBytes });
    }
    cohort[run] = { root, manifest, objects, used: new Map() };
  }
  return cohort;
}
function cohortObject(cohort, run, objectId, { decoded = 'AUTO' } = {}) {
  const c = cohort[run];
  const entry = c.objects.get(objectId);
  if (!entry || !entry.ref) die('STOP_CALENDAR_SOURCE_UNPROVEN', `${run}/${objectId} absent from accepted manifest`);
  const useDecoded = decoded === 'AUTO' ? Boolean(entry.decoded) : decoded;
  const ref = useDecoded ? entry.decoded : entry.ref;
  const bytes = readFileSync(resolve(c.root, ...ref.relativePath.split('/')));
  if (bytes.length !== ref.byteLength || sha256(bytes) !== ref.sha256) die('STOP_BYTE_FIDELITY_FAILED', `${run}/${objectId}`);
  const wire = useDecoded ? (() => { const w = readFileSync(resolve(c.root, ...entry.ref.relativePath.split('/'))); if (w.length !== entry.ref.byteLength || sha256(w) !== entry.ref.sha256) die('STOP_BYTE_FIDELITY_FAILED', `${run}/${objectId} wire`); return entry.ref; })() : entry.ref;
  c.used.set(objectId, { objectId, wireSha256: wire.sha256, wireByteLength: wire.byteLength, decodedSha256: useDecoded ? ref.sha256 : null, decodedByteLength: useDecoded ? ref.byteLength : null });
  return { bytes, record: entry.record, sourceSha256: ref.sha256, byteLength: ref.byteLength, decodedFromWire: useDecoded, wireSha256: wire.sha256 };
}

// ---------------------------------------------------------------- text helpers
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&rsquo;|&lsquo;/gi, "'").replace(/&ldquo;|&rdquo;/gi, '"').replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–');
}
function stripTags(html) { return html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '); }
export function pageText(html) { return decodeEntities(stripTags(html)).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); }
function cellText(fragment) { return decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim(); }
function htmlTables(html) {
  const clean = html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  return [...clean.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((m) => ({
    index: m.index, before: clean.slice(Math.max(0, m.index - 600), m.index),
    rows: [...m[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((c) => cellText(c[1]))).filter((r) => r.length),
  }));
}
function civil(year, monthName, day) {
  const date = `${year}-${pad2(MONTHS[monthName.toLowerCase()])}-${pad2(Number(day))}`;
  if (!L.civil.isValidCivilDate(date)) die('STOP_CALENDAR_SOURCE_UNPROVEN', `invalid date ${date}`);
  return date;
}
function checkWeekday(date, weekday, label) {
  if (weekday && WEEKDAYS[L.civil.dayOfWeek(date)].toLowerCase() !== weekday.toLowerCase()) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `${label}: ${weekday} != ${date}`);
}
function isWeekend(date) { const d = L.civil.dayOfWeek(date); return d === 0 || d === 6; }

// ---------------------------------------------------------------- V3 parsers (legacy layouts)
/** NYSE year-column holiday table (2010-2017 and 2026 layouts). */
export function parseNyseYearTable(html, year) {
  const candidates = htmlTables(html).filter((t) => {
    const h = t.rows[0] || [];
    return h.length >= 2 && /^(holiday)?$/i.test(h[0]) && h.slice(1).every((c) => /^\d{4}$/.test(c)) && h.slice(1).map(Number).includes(year);
  });
  if (candidates.length !== 1) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} year-table count ${candidates.length}`);
  const t = candidates[0]; const yi = t.rows[0].map((c) => (/^\d{4}$/.test(c) ? Number(c) : null)).indexOf(year);
  const closures = [];
  for (const row of t.rows.slice(1)) {
    if (!row[0]) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} unnamed row`);
    let cell = (row[yi] ?? '').replace(/[*†]/g, '').trim();
    if (cell === '' || /^[-–—]+$/.test(cell)) continue;
    const m = new RegExp(`^(?:${WEEKDAY_RE},\\s*)?${MONTH_RE}\\s+(\\d{1,2})\\s*(?:\\(([^()]*)\\))?$`, 'i').exec(cell);
    if (!m) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} cell "${cell}"`);
    let date = civil(year, m[2], m[3]); checkWeekday(date, m[1], `NYSE ${year} ${row[0]}`);
    if (m[4] !== undefined) {
      const obs = new RegExp(`^observed\\s+(?:${WEEKDAY_RE},\\s*)?${MONTH_RE}\\s+(\\d{1,2})$`, 'i').exec(m[4].trim());
      if (obs) { date = civil(year, obs[2], obs[3]); checkWeekday(date, obs[1], `NYSE ${year} observed`); }
      else if (!/(^|\s)observed$/i.test(m[4].trim())) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} parenthetical "${m[4]}"`);
    }
    if (isWeekend(date)) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} weekend closure ${date}`);
    closures.push(date);
  }
  const text = pageText(html); const early = [];
  for (const m of text.matchAll(/Each market will close (?:early )?at 1:00 p\.m\./g)) {
    const rest = text.slice(m.index); const stop = rest.search(/Crossing Session|Back to top|All times are/);
    const segment = rest.slice(0, stop > 0 ? stop : 600);
    for (const d of segment.matchAll(new RegExp(`${WEEKDAY_RE},\\s+${MONTH_RE}\\s+(\\d{1,2}),\\s+(\\d{4})`, 'g'))) {
      const date = civil(Number(d[4]), d[2], d[3]); checkWeekday(date, d[1], 'NYSE early close');
      if (Number(d[4]) === year) early.push(date);
    }
  }
  const uniq = (a) => [...new Set(a)].sort();
  if (new Set(closures).size !== closures.length) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE ${year} duplicate closure`);
  return { fullClosureDates: uniq(closures), earlyCloseDates: uniq(early), earlyCloseLocalTime: '13:00' };
}

/** Nasdaq Trader calendar layouts 2010-2013 (date | holiday | equity status | ...). */
export function parseNasdaqLegacy(html, year) {
  const candidates = [];
  for (const t of htmlTables(html)) {
    const header = t.rows[0] || [];
    let tableYear = /^\d{4}$/.test(header[0] || '') ? Number(header[0]) : null;
    if (tableYear === null) { const h3 = [...t.before.matchAll(/<h3[^>]*>\s*(\d{4})\s*<\/h3>/gi)].pop(); tableYear = h3 ? Number(h3[1]) : null; }
    if (tableYear !== year) continue;
    if (!(header[2] === '' || /stock market|equity markets/i.test(header[2] || ''))) continue;
    candidates.push(t);
  }
  if (candidates.length !== 1) die('STOP_CALENDAR_SOURCE_UNPROVEN', `Nasdaq ${year} table count ${candidates.length}`);
  const full = []; const early = []; let earlyTimes = new Set();
  for (const row of candidates[0].rows.slice(1)) {
    const m = new RegExp(`^${MONTH_RE}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`, 'i').exec(row[0] || '');
    if (!m) die('STOP_CALENDAR_SOURCE_UNPROVEN', `Nasdaq ${year} date "${row[0]}"`);
    if (m[3] && Number(m[3]) !== year) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `Nasdaq ${year} year`);
    const date = civil(year, m[1], m[2]); const status = (row[2] || '').toLowerCase();
    if (!row[1]) die('STOP_CALENDAR_SOURCE_UNPROVEN', `Nasdaq ${year} unnamed row`);
    if (status === 'closed') full.push(date);
    else if (/^1:00 (p\.m\.|pm et)$/.test(status)) { early.push(date); earlyTimes.add('13:00'); }
    else if (status === 'tba' && /early (market )?close/i.test(row[1])) { early.push(date); earlyTimes.add('UNSTATED_TBA'); }
    else die('STOP_CALENDAR_SOURCE_UNPROVEN', `Nasdaq ${year} status "${status}"`);
  }
  return { fullClosureDates: [...full].sort(), earlyCloseDates: [...early].sort(), earlyCloseLocalTime: earlyTimes.size === 1 && earlyTimes.has('13:00') ? '13:00' : (early.length ? 'UNSTATED_TBA' : null) };
}
function sameDates(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ---------------------------------------------------------------- evidence records
const evidence = new Map(); // evidenceId -> record
function mintEvidence({ evidenceSourceId, coverageYear, sourceBytesSha256, publishedAt, publicationEvidence, capturedAt, closureAssertions, meta }) {
  const publicationEvidenceId = identityId(publicationEvidence);
  const preimage = {
    EvidenceSourceId: evidenceSourceId, CoverageYear: coverageYear, SourceBytesSha256: sourceBytesSha256,
    PublishedAt: publishedAt, PublicationEvidenceId: publicationEvidenceId, CapturedAt: capturedAt,
    ClosureAssertions: closureAssertions,
  };
  const evidenceId = identityId(preimage);
  if (!evidence.has(evidenceId)) evidence.set(evidenceId, { schemaId: 'CalendarSourceEvidence/1', evidenceId, preimage, publicationEvidence, meta });
  return evidenceId;
}
function scheduledAssertions(parsed) {
  return [
    ...parsed.fullClosureDates.map((date) => ({ date, kind: 'FULL_CLOSURE', closeLocalTime: null })),
    ...parsed.earlyCloseDates.map((date) => ({ date, kind: 'EARLY_CLOSE', closeLocalTime: parsed.earlyCloseLocalTime })),
  ].sort((a, b) => (a.date === b.date ? a.kind.localeCompare(b.kind) : a.date.localeCompare(b.date)));
}
function cohortEvidence(cohort, run, objectId, obj, authority, role, coverageYear, assertions, extraMeta = {}) {
  const r = obj.record;
  const captureTs = r.captureTimestamp ?? null;
  const capturedAt = captureTs ? captureIso(captureTs) : isoMs(r.retrievalStartedAtUtc);
  const originalUrl = r.archivedOriginalUrl ?? r.exactUrl;
  return mintEvidence({
    evidenceSourceId: `${authority}|${originalUrl}|${captureTs ?? 'LIVE'}`,
    coverageYear, sourceBytesSha256: obj.sourceSha256,
    publishedAt: { basis: captureTs ? 'NOT_LATER_THAN_ARCHIVE_CAPTURE' : 'NOT_LATER_THAN_LIVE_RETRIEVAL', notLaterThanUtc: capturedAt, statedDateline: extraMeta.dateline ?? null },
    publicationEvidence: { cohortRun: run, acquisitionManifestSha256: COHORT[run].manifestSha256, objectId, captureTimestamp: captureTs, originalUrl, wireSha256: obj.wireSha256 },
    capturedAt, closureAssertions: assertions,
    meta: { authority, role, cohortRun: run, objectId, byteLength: obj.byteLength, decodedFromWire: obj.decodedFromWire, ...extraMeta },
  });
}

// ---------------------------------------------------------------- calendar construction
function buildRuleset(year) {
  const from = `${year}-01-01`; const to = `${year + 1}-01-01`; const bounds = [];
  for (let d = from; d < to; d = L.civil.addDays(d, 1)) bounds.push({ civilDate: d, startUtc: L.macro.deriveNewYorkUtcInstantV1(d, '00:00'), endUtcExclusive: L.macro.deriveNewYorkUtcInstantV1(L.civil.addDays(d, 1), '00:00') });
  return { schemaVersion: 'TimeZoneRuleset/1', rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', zoneId: ZONE_ID, validFromDate: from, validToDateExclusive: to, civilDateBounds: bounds };
}
function buildSessions(year, closures, early) {
  const c = new Set(closures); const e = new Set(early); const rows = [];
  for (let d = `${year}-01-01`; d < `${year + 1}-01-01`; d = L.civil.addDays(d, 1)) {
    if (isWeekend(d) || c.has(d)) continue;
    const kind = e.has(d) ? 'HALF_DAY_SESSION' : 'REGULAR_SESSION';
    const close = L.macro.deriveNewYorkUtcInstantV1(d, kind === 'HALF_DAY_SESSION' ? '13:00' : '16:00');
    rows.push({ sessionDate: d, sessionKind: kind, openUtc: L.macro.deriveNewYorkUtcInstantV1(d, '09:30'), closeUtc: close, marketValidTime: close });
  }
  return rows;
}

function deriveScheduledYear(cohort, repoRoot, year) {
  const records = []; let nyseResults = []; let nasdaq = null; let overlay = null; const notes = [];
  if (year <= 2017) {
    const plan = SCHEDULED_PLAN[year];
    for (const src of plan.nyse) {
      const obj = cohortObject(cohort, src.run, src.objectId);
      const parsed = parseNyseYearTable(obj.bytes.toString('latin1'), year);
      nyseResults.push({ src, parsed });
      records.push(cohortEvidence(cohort, src.run, src.objectId, obj, 'NYSE', src.inYear ? 'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY_IN_YEAR' : 'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY_PRIOR_YEAR_SCHEDULE', year, scheduledAssertions(parsed)));
    }
    const ns = plan.nasdaq[0]; const nobj = cohortObject(cohort, ns.run, ns.objectId);
    const nhtml = nobj.bytes.toString('utf8');
    nasdaq = ns.parser === 'V3_NASDAQ' ? parseNasdaqLegacy(nhtml, year) : { ...L.v2b.parseArchivedNasdaqTraderCalendar(nhtml, year), earlyCloseLocalTime: '13:00' };
    records.push(cohortEvidence(cohort, ns.run, ns.objectId, nobj, 'NASDAQ_TRADER', 'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY', year, scheduledAssertions(nasdaq)));
    if (!plan.nyse.some((s) => s.inYear)) notes.push('NO_IN_YEAR_NYSE_CAPTURE_PRIOR_YEAR_NYSE_SCHEDULE_PLUS_IN_YEAR_NASDAQ');
  } else if (year <= 2025) {
    const pin = V2_PIN[year];
    for (const side of ['nyse', 'nasdaq']) {
      const [sha, len, ts] = pin[side]; const key = `${year}:${side}`; let obj; let run = null; let objectId = null;
      if (V2_REPAIRED_FROM_R1[key]) {
        run = 'R1'; objectId = V2_REPAIRED_FROM_R1[key]; obj = cohortObject(cohort, run, objectId);
      } else {
        const bytes = gitBlob(repoRoot, `data/jarvise/session-calendar-historical/source-evidence/${year}/${side === 'nyse' ? 'nyse-hours-calendars.html' : 'nasdaqtrader-calendar.html'}`);
        obj = { bytes, sourceSha256: sha256(bytes), byteLength: bytes.length, decodedFromWire: false, wireSha256: sha256(bytes), record: null };
      }
      if (obj.sourceSha256 !== sha || obj.byteLength !== len) die('STOP_BYTE_FIDELITY_FAILED', `V2 ${key} source bytes`);
      const html = obj.bytes.toString(year === 2018 && side === 'nyse' ? 'latin1' : 'utf8');
      const parsed = side === 'nyse' ? { ...L.v2b.parseArchivedNyseHoursCalendars(html, year), earlyCloseLocalTime: '13:00' } : { ...L.v2b.parseArchivedNasdaqTraderCalendar(html, year), earlyCloseLocalTime: '13:00' };
      if (side === 'nyse') nyseResults.push({ src: { v2Year: year }, parsed }); else nasdaq = parsed;
      const authority = side === 'nyse' ? 'NYSE' : 'NASDAQ_TRADER';
      const role = side === 'nyse' ? 'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY_V2_PINNED' : 'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY_V2_PINNED';
      if (run) records.push(cohortEvidence(cohort, run, objectId, obj, authority, role, year, scheduledAssertions(parsed), { v2PinnedSha256: sha, v2CommittedBlobEolNormalized: true }));
      else {
        const originalUrl = side === 'nyse' ? NYSE_HOURS_URL : NASDAQ_CAL_URL; const capturedAt = captureIso(ts);
        records.push(mintEvidence({
          evidenceSourceId: `${authority}|${originalUrl}|${ts}`, coverageYear: year, sourceBytesSha256: sha,
          publishedAt: { basis: 'NOT_LATER_THAN_ARCHIVE_CAPTURE', notLaterThanUtc: capturedAt, statedDateline: null },
          publicationEvidence: { governedV2SourceDigests: true, calendarYear: year, authority, archiveTimestamp: ts, originalUrl, sha256: sha },
          capturedAt, closureAssertions: scheduledAssertions(parsed),
          meta: { authority, role, governedV2GitBlob: true, byteLength: len, v2CommittedBlobMatchesDeclared: true },
        }));
      }
    }
    for (const objectId of V2_ERA_NYSE_CORROBORATION[year] ?? []) {
      const obj = cohortObject(cohort, 'R1', objectId);
      const parsed = parseNyseYearTable(obj.bytes.toString('latin1'), year);
      nyseResults.push({ src: { run: 'R1', objectId, corroborating: true }, parsed });
      records.push(cohortEvidence(cohort, 'R1', objectId, obj, 'NYSE', 'CORROBORATING_PRIOR_YEAR_NYSE_SCHEDULE', year, scheduledAssertions(parsed)));
    }
    if (year === 2022) {
      const sd = JSON.parse(gitBlob(repoRoot, 'data/jarvise/session-calendar-historical/source-evidence/2022/SOURCE_DIGESTS.json').toString('utf8'));
      overlay = sd.officialCorrectionOverlay;
      if (!overlay || overlay.sessionDate !== '2022-06-20' || overlay.finalSessionTruth !== 'FULL_CLOSURE') die('STOP_CALENDAR_SOURCE_UNPROVEN', '2022 V2 correction overlay');
      records.push(mintEvidence({
        evidenceSourceId: `NYSE|${overlay.originalUrl}|${overlay.archiveTimestamp}`, coverageYear: 2022, sourceBytesSha256: overlay.sha256,
        publishedAt: { basis: 'NOT_LATER_THAN_ARCHIVE_CAPTURE', notLaterThanUtc: captureIso(overlay.archiveTimestamp), statedDateline: null },
        publicationEvidence: { governedV2OfficialCorrectionOverlay: true, calendarYear: 2022, archiveTimestamp: overlay.archiveTimestamp, originalUrl: overlay.originalUrl, sha256: overlay.sha256, orderingRule: overlay.orderingRule },
        capturedAt: captureIso(overlay.archiveTimestamp), closureAssertions: [{ date: '2022-06-20', kind: 'FULL_CLOSURE', closeLocalTime: null }],
        meta: { authority: 'NYSE', role: 'OFFICIAL_CORRECTION_OVERLAY_V2_GOVERNED', sourceBytesHeldLocally: false, boundBy: 'V2 governed SOURCE_DIGESTS.json officialCorrectionOverlay (sha256 binding); independently corroborated by the Nasdaq 2022 calendar exact bytes (R1 object 007)' },
      }));
    }
  } else {
    // 2026: in-year live-era captures (R1 038 NYSE, R1 039 Nasdaq) + V1 NYSE blob (declared bytes) as corroboration.
    const n = cohortObject(cohort, 'R1', '038_N5_2026_NYSE_TRADE_HOURS_LATEST');
    const np = parseNyseYearTable(n.bytes.toString('utf8'), 2026); nyseResults.push({ src: { run: 'R1', objectId: '038_N5_2026_NYSE_TRADE_HOURS_LATEST' }, parsed: np });
    records.push(cohortEvidence(cohort, 'R1', '038_N5_2026_NYSE_TRADE_HOURS_LATEST', n, 'NYSE', 'PRIMARY_HISTORICAL_CALENDAR_AUTHORITY_IN_YEAR', 2026, scheduledAssertions(np)));
    const v1 = gitBlob(repoRoot, V1_2026_NYSE.gitPath);
    if (sha256(v1) !== V1_2026_NYSE.sha256 || v1.length !== V1_2026_NYSE.byteLength) die('STOP_BYTE_FIDELITY_FAILED', 'V1 2026 NYSE blob');
    const vp = parseNyseYearTable(v1.toString('utf8'), 2026); nyseResults.push({ src: { v1Year: 2026 }, parsed: vp });
    records.push(mintEvidence({
      evidenceSourceId: `NYSE|${V1_2026_NYSE.originalUrl}|LIVE`, coverageYear: 2026, sourceBytesSha256: V1_2026_NYSE.sha256,
      publishedAt: { basis: 'NOT_LATER_THAN_LIVE_RETRIEVAL', notLaterThanUtc: V1_2026_NYSE.retrievedAtUtc, statedDateline: null },
      publicationEvidence: { governedV1SourceDigests: true, calendarYear: 2026, retrievedAtUtc: V1_2026_NYSE.retrievedAtUtc, originalUrl: V1_2026_NYSE.originalUrl, sha256: V1_2026_NYSE.sha256 },
      capturedAt: V1_2026_NYSE.retrievedAtUtc, closureAssertions: scheduledAssertions(vp),
      meta: { authority: 'NYSE', role: 'CORROBORATING_GOVERNED_V1_2026_SOURCE', governedV1GitBlob: true, byteLength: V1_2026_NYSE.byteLength, v1CommittedBlobMatchesDeclared: true },
    }));
    const q = cohortObject(cohort, 'R1', '039_N5_2026_NASDAQ_CAL_LATEST');
    nasdaq = { ...L.v2b.parseArchivedNasdaqTraderCalendar(q.bytes.toString('utf8'), 2026), earlyCloseLocalTime: '13:00' };
    records.push(cohortEvidence(cohort, 'R1', '039_N5_2026_NASDAQ_CAL_LATEST', q, 'NASDAQ_TRADER', 'MANDATORY_CORROBORATING_CALENDAR_AUTHORITY', 2026, scheduledAssertions(nasdaq)));
    notes.push('V1_2026_NASDAQ_GIT_BLOB_EXCLUDED_EOL_NORMALIZED_NOT_ORIGINAL_BYTES');
  }
  // Reconciliation: every NYSE source must agree; NYSE and Nasdaq must agree (V2 2022 rule preserved).
  const base = nyseResults[0].parsed;
  for (const { src, parsed } of nyseResults.slice(1)) {
    if (!sameDates(base.fullClosureDates, parsed.fullClosureDates) || !sameDates(base.earlyCloseDates, parsed.earlyCloseDates)) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `NYSE sources disagree for ${year}: ${JSON.stringify(src)}`);
  }
  let closures = [...base.fullClosureDates];
  const onlyNyse = closures.filter((d) => !nasdaq.fullClosureDates.includes(d));
  const onlyNasdaq = nasdaq.fullClosureDates.filter((d) => !closures.includes(d));
  const v2Exception = year === 2022 && onlyNyse.length === 0 && sameDates(onlyNasdaq, ['2022-06-20']) && overlay;
  if ((onlyNyse.length || onlyNasdaq.length) && !v2Exception) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `${year} full closures NYSE/Nasdaq ${JSON.stringify({ onlyNyse, onlyNasdaq })}`);
  if (!sameDates(base.earlyCloseDates, nasdaq.earlyCloseDates)) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `${year} early closes NYSE/Nasdaq`);
  if (v2Exception) { closures = [...new Set([...closures, '2022-06-20'])].sort(); notes.push('V2_OFFICIAL_CORRECTION_OVERLAY_2022_06_20_APPLIED'); }
  if (base.earlyCloseLocalTime !== '13:00') die('STOP_CALENDAR_SOURCE_UNPROVEN', `${year} early close time`);
  return { closures, early: [...base.earlyCloseDates], records, overlay, notes, nasdaqEarlyCloseLocalTime: nasdaq.earlyCloseLocalTime };
}

function deriveSpecialClosures(cohort) {
  const out = [];
  for (const sc of SPECIAL_CLOSURES) {
    const year = Number(sc.sessionDate.slice(0, 4));
    const bind = (s, role) => {
      const obj = cohortObject(cohort, s.run, s.objectId);
      const text = pageText(obj.bytes.toString('utf8'));
      if (!text.includes(s.quote)) die('STOP_CALENDAR_SOURCE_UNPROVEN', `${sc.sessionDate} quote absent in ${s.run}/${s.objectId}`);
      if (s.dateline && !text.includes(s.dateline)) die('STOP_SOURCE_PROVENANCE_UNPROVEN', `${sc.sessionDate} dateline absent in ${s.run}/${s.objectId}`);
      const kind = s.role === 'ANNOUNCED_PENDING_CONFIRMATION_ONLY' ? 'SPECIAL_CLOSURE_ANNOUNCED_PENDING_CONFIRMATION' : 'SPECIAL_FULL_CLOSURE';
      const meta = { dateline: s.dateline, quote: s.quote, event: sc.event };
      if (s.run === 'R2' && s.objectId.startsWith('023_')) meta.integrityAdvisory = OBJECT_023_ADVISORY;
      return { evidenceId: cohortEvidence(cohort, s.run, s.objectId, obj, s.authority, role, year, [{ date: sc.sessionDate, kind, closeLocalTime: null }], meta), run: s.run, objectId: s.objectId, authority: s.authority, quote: s.quote, dateline: s.dateline, assertionKind: kind };
    };
    const primary = sc.primary.map((s) => bind(s, 'SPECIAL_CLOSURE_PRIMARY_EVIDENCE'));
    const corroborating = sc.corroborating.map((s) => bind(s, 'SPECIAL_CLOSURE_INDEPENDENT_CORROBORATION'));
    if (!primary.length || !corroborating.some((c) => c.assertionKind === 'SPECIAL_FULL_CLOSURE')) die('STOP_CALENDAR_SOURCE_UNPROVEN', `${sc.sessionDate} needs primary + independent full-closure corroboration`);
    out.push({ sessionDate: sc.sessionDate, event: sc.event, finalSessionTruth: 'FULL_CLOSURE', primary, corroborating, derivedFromMissingBars: false });
  }
  const context = SANDY_CONTEXT.map((c) => {
    const obj = cohortObject(cohort, c.run, c.objectId);
    if (!pageText(obj.bytes.toString('utf8')).includes(c.quote)) die('STOP_CALENDAR_SOURCE_UNPROVEN', `context quote ${c.objectId}`);
    return { run: c.run, objectId: c.objectId, sourceBytesSha256: obj.sourceSha256, disposition: c.disposition, quote: c.quote, note: c.note, usedAsClosureAssertion: false };
  });
  return { closures: out, context };
}

/** N5: deterministic recheck of the R3 live enumeration for 2026-08-27..2026-09-04. */
function deriveN5(cohort) {
  const inWindow = (iso) => { const d = new Date(iso); const et = new Date(d.getTime() - 4 * 3600 * 1000).toISOString().slice(0, 10); return et >= N5_INTERVAL.fromDate && et <= N5_INTERVAL.toDateInclusive; };
  const windowDateRe = /\b(?:Aug(?:ust|\.)?\s+(?:27|28|31)|Sep(?:tember|t\.|\.)?\s+0?[1-4])(?:st|nd|rd|th)?,?\s+2026\b|\b0?8\/(?:27|28|31)\/2026\b|\b0?9\/0?[1-4]\/2026\b/i;
  const closureRe = /\b(?:to close|will (?:be )?close[d]?|closure of|markets? (?:will be )?closed|exchanges? (?:will be )?closed|day of mourning)\b/i;
  const sys = {};
  const records = [];
  for (const [objectId, systemId] of [['007_P4_NYSE_MARKET_STATUS_SYS2_2026_P0', 2], ['008_P4_NYSE_TRADER_UPDATE_SYS1_2026_P0', 1], ['009_P5_NYSE_TRADER_UPDATE_SYS1_2026_P1', 1]]) {
    const obj = cohortObject(cohort, 'R3', objectId); const page = JSON.parse(obj.bytes.toString('utf8'));
    sys[systemId] ??= { totalCount: page.totalCount, items: new Map() };
    if (sys[systemId].totalCount !== page.totalCount) die('STOP_CALENDAR_SOURCE_UNPROVEN', 'NYSE API totalCount drift');
    for (const it of page.data) sys[systemId].items.set(it.id, it);
    records.push({ objectId, obj, systemId });
  }
  const closureNotices = []; const windowCandidates = []; let inWindowCount = 0; let minPub = null; let maxPub = null;
  for (const [systemId, s] of Object.entries(sys)) {
    if (s.items.size !== s.totalCount) die('STOP_CALENDAR_SOURCE_UNPROVEN', `NYSE system ${systemId} enumeration ${s.items.size}/${s.totalCount}`);
    for (const it of s.items.values()) {
      const pub = new Date(it.publishedDate).toISOString(); minPub = !minPub || pub < minPub ? pub : minPub; maxPub = !maxPub || pub > maxPub ? pub : maxPub;
      if (inWindow(pub)) inWindowCount += 1;
      const text = `${it.subject} ${pageText(String(it.body ?? ''))}`;
      if (/to Close in Observance/i.test(it.subject)) {
        const m = new RegExp(`${WEEKDAY_RE},\\s+${MONTH_RE}\\s+(\\d{1,2}),\\s+(2026)`).exec(text);
        if (!m) die('STOP_CALENDAR_SOURCE_UNPROVEN', `closure notice ${it.id} date`);
        const date = civil(2026, m[2], m[3]); checkWeekday(date, m[1], `closure notice ${it.id}`);
        closureNotices.push({ id: it.id, systemId: Number(systemId), publishedUtc: pub, subject: it.subject, closesOn: date });
      }
      if (closureRe.test(text) && windowDateRe.test(text)) windowCandidates.push({ id: it.id, subject: it.subject });
    }
  }
  closureNotices.sort((a, b) => a.closesOn.localeCompare(b.closesOn));
  if (closureNotices.some((n) => n.closesOn >= N5_INTERVAL.fromDate && n.closesOn <= N5_INTERVAL.toDateInclusive)) die('STOP_CALENDAR_EVIDENCE_CONFLICT', 'closure notice inside N5 interval');
  if (windowCandidates.length) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `N5 closure-language candidates ${JSON.stringify(windowCandidates)}`);
  if (!(minPub <= `${N5_INTERVAL.fromDate}T00:00:00.000Z` && maxPub >= '2026-09-05T00:00:00.000Z')) die('STOP_CALENDAR_SOURCE_UNPROVEN', 'NYSE enumeration does not cover N5 interval');
  // ICE IR 2026 press-release list: no closure / mourning release in 2026.
  const ice = cohortObject(cohort, 'R3', '002_P1_ICE_Q4_PRESS_RELEASE_LIST_2026'); const iceList = JSON.parse(ice.bytes.toString('utf8'));
  const releases = iceList.GetPressReleaseListResult ?? iceList.d ?? iceList;
  if (!Array.isArray(releases) || releases.length === 0) die('STOP_CALENDAR_SOURCE_UNPROVEN', 'ICE list shape');
  const iceClosure = releases.filter((r) => /\b(close[sd]?|closure|mourning)\b/i.test(String(r.Headline ?? r.headline ?? '')) && /\b(market|exchange|NYSE)\b/i.test(String(r.Headline ?? r.headline ?? '')));
  if (iceClosure.length) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `ICE closure headline ${JSON.stringify(iceClosure.map((r) => r.Headline ?? r.headline))}`);
  // Nasdaq ETA 2026-49 (only alert in interval) carries no closure language for the interval.
  const eta = cohortObject(cohort, 'R3', '010_P5_NASDAQTRADER_ETA2026_49'); const etaText = pageText(eta.bytes.toString('utf8'));
  if (closureRe.test(etaText) && windowDateRe.test(etaText)) die('STOP_CALENDAR_EVIDENCE_CONFLICT', 'ETA2026-49 closure language');
  const assertion = [{ kind: 'NO_EXCEPTIONAL_CLOSURE_IN_INTERVAL', fromDate: N5_INTERVAL.fromDate, toDateInclusive: N5_INTERVAL.toDateInclusive }];
  const ids = [];
  for (const { objectId, obj, systemId } of records) ids.push(cohortEvidence(cohort, 'R3', objectId, obj, 'NYSE', systemId === 2 ? 'EXCEPTIONAL_CLOSURE_SWEEP_LIVE_MARKET_STATUS_ENUMERATION' : 'EXCEPTIONAL_CLOSURE_SWEEP_LIVE_TRADER_UPDATE_ENUMERATION', 2026, assertion));
  ids.push(cohortEvidence(cohort, 'R3', '002_P1_ICE_Q4_PRESS_RELEASE_LIST_2026', ice, 'ICE_NYSE_GROUP', 'EXCEPTIONAL_CLOSURE_SWEEP_LIVE_ISSUER_PRESS_RELEASE_LIST', 2026, assertion));
  ids.push(cohortEvidence(cohort, 'R3', '010_P5_NASDAQTRADER_ETA2026_49', eta, 'NASDAQ_TRADER', 'EXCEPTIONAL_CLOSURE_SWEEP_LIVE_EQUITY_TRADER_ALERT', 2026, assertion));
  return {
    interval: N5_INTERVAL, result: 'NO_EXCEPTIONAL_CLOSURE', calendarSourceEvidenceIds: ids,
    nyse: Object.fromEntries(Object.entries(sys).map(([k, s]) => [`system${k}`, { totalCount: s.totalCount, uniqueItems: s.items.size }])),
    nyseEnumerationPublishedRange: { fromUtc: minPub, toUtc: maxPub }, nyseItemsPublishedInIntervalEt: inWindowCount,
    nyseScheduledClosureNotices2026: closureNotices, closureLanguageWindowCandidates: 0,
    iceReleases2026: releases.length, iceClosureHeadlines: 0, laborDay2026: '2026-09-07',
    priorSweepThrough2026_08_26: { governedV1SweepSha256: V1_2026_SWEEP.sha256, result: 'NONE_FOUND' },
  };
}

// ---------------------------------------------------------------- main build
export async function buildCalendarV3({ repoRoot, evidenceRoot, candidateRoot }) {
  if (!repoRoot || !evidenceRoot || !candidateRoot) die('WU2B_BUILDER_FLAGS_REQUIRED');
  L = await loadModules(repoRoot); evidence.clear();
  const cohort = loadCohort(evidenceRoot);
  // V2 immutability probe (read-only, git blobs at HEAD).
  const v2Binding = gitBlob(repoRoot, 'app/jarvise/jarviseHistoricalCalendarBindingR1.json');
  if (sha256(v2Binding) !== V2.bindingDocumentSha256) die('STOP_PROOF_DRIFTED', 'V2 binding document');
  const v2Registry = JSON.parse(gitBlob(repoRoot, 'data/jarvise/session-calendar-historical/XNYS/registry/R0001/registry-manifest.json').toString('utf8'));
  if (casId(v2Registry) !== V2.registryManifestId || v2Registry.calendarAuthorityPolicyId !== V2.authorityPolicyId) die('STOP_PROOF_DRIFTED', 'V2 registry identity');
  const v2Policy = JSON.parse(gitBlob(repoRoot, 'data/jarvise/session-calendar-historical/XNYS/authority-policy.json').toString('utf8'));
  if (casId(v2Policy) !== V2.authorityPolicyId) die('STOP_PROOF_DRIFTED', 'V2 policy identity');
  const v2Cores = new Map();
  V2.years.forEach((y, i) => { const core = JSON.parse(gitBlob(repoRoot, `data/jarvise/session-calendar-historical/XNYS/${y}/session-calendar-core.json`).toString('utf8')); if (casId(core) !== v2Registry.calendarCoreIds[i]) die('STOP_PROOF_DRIFTED', `V2 core ${y}`); v2Cores.set(y, core); });
  const v1Sweep = gitBlob(repoRoot, V1_2026_SWEEP.gitPath); if (sha256(v1Sweep) !== V1_2026_SWEEP.sha256) die('STOP_BYTE_FIDELITY_FAILED', 'V1 2026 sweep');

  const special = deriveSpecialClosures(cohort);
  const n5 = deriveN5(cohort);
  const years = new Map();
  for (const year of YEARS) {
    const d = deriveScheduledYear(cohort, repoRoot, year);
    const specials = special.closures.filter((s) => s.sessionDate.startsWith(`${year}-`));
    for (const s of specials) { if (d.closures.includes(s.sessionDate) || d.early.includes(s.sessionDate) || isWeekend(s.sessionDate)) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `special closure ${s.sessionDate} collides with schedule`); }
    years.set(year, { ...d, specials });
  }
  // Rulesets, policy, cores.
  const rulesets = new Map(YEARS.map((y) => { const v = buildRuleset(y); return [y, { value: v, id: casId(v) }]; }));
  const policy = { schemaVersion: 'MarketCalendarAuthorityPolicy/2', calendarNamespaceVersion: NAMESPACE, venueId: VENUE_ID, zoneId: ZONE_ID, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', allowedSessionKinds: ['HALF_DAY_SESSION', 'REGULAR_SESSION'], yearlyRulesets: YEARS.map((y) => ({ calendarYear: y, zoneId: ZONE_ID, rulesetFormat: 'CIVIL_DATE_UTC_BOUNDS_V1', timeZoneRulesetId: rulesets.get(y).id })) };
  if (casId(L.cal2.normalizeMarketCalendarAuthorityPolicyV2(policy)) !== casId(policy)) die('STOP_PROOF_DRIFTED', 'policy normalization');
  const policyId = casId(policy);
  const cores = new Map(); const normalized = new Map();
  for (const y of YEARS) {
    const d = years.get(y);
    const closures = [...new Set([...d.closures, ...d.specials.map((s) => s.sessionDate)])].sort();
    const core = { schemaVersion: 'MarketSessionCalendarCore/2', calendarAuthorityPolicyId: policyId, venueId: VENUE_ID, timeZoneRulesetId: rulesets.get(y).id, coverageFromDate: `${y}-01-01`, coverageToDateExclusive: `${y + 1}-01-01`, sessions: buildSessions(y, closures, d.early) };
    if (casId(L.cal2.normalizeMarketSessionCalendarCoreV2(core)) !== casId(core)) die('STOP_PROOF_DRIFTED', `core ${y} normalization`);
    cores.set(y, { value: core, id: casId(core) });
    const specialIds = d.specials.flatMap((s) => [...s.primary, ...s.corroborating].map((e) => e.evidenceId));
    const yearEvidenceIds = [...new Set([...d.records, ...specialIds, ...(y === 2026 ? n5.calendarSourceEvidenceIds : [])])].sort();
    const ns = {
      schemaVersion: 'JarviseDh2011CalendarV3NormalizedSource/1', calendarYear: y, calendarNamespaceVersion: NAMESPACE, venueId: VENUE_ID, zoneId: ZONE_ID,
      scheduledFullClosureDates: d.closures, scheduledEarlyCloseDates: d.early, earlyCloseLocalTime: '13:00',
      specialClosureDates: d.specials.map((s) => s.sessionDate), officialCorrectionOverlay: d.overlay ? { sessionDate: d.overlay.sessionDate, finalSessionTruth: d.overlay.finalSessionTruth, sha256: d.overlay.sha256, archiveTimestamp: d.overlay.archiveTimestamp } : null,
      calendarSourceEvidenceIds: yearEvidenceIds, reconciliationNotes: [...d.notes].sort(),
      nasdaqEarlyCloseTimeStatement: d.nasdaqEarlyCloseLocalTime,
      exceptionalClosureCompleteness: exceptionalCompleteness(y),
      sessionCount: core.sessions.length, halfDaySessionCount: core.sessions.filter((s) => s.sessionKind === 'HALF_DAY_SESSION').length,
      missingBarsUsedAsAuthority: false,
    };
    normalized.set(y, { value: ns, id: casId(ns) });
  }
  // Registry/3.
  const allEvidenceIds = [...evidence.keys()].sort();
  const specialEvidenceIds = [...new Set(special.closures.flatMap((s) => [...s.primary, ...s.corroborating].map((e) => e.evidenceId)))].sort();
  const registryPreimage = {
    NamespaceVersion: NAMESPACE,
    OrderedYearRecords: YEARS.map((y) => ({ calendarYear: y, calendarCoreId: cores.get(y).id, timeZoneRulesetId: rulesets.get(y).id, normalizedSourceId: normalized.get(y).id })),
    TimeZoneRulesetIds: YEARS.map((y) => rulesets.get(y).id),
    CalendarSourceEvidenceIds: allEvidenceIds,
    SpecialClosureEvidenceIds: specialEvidenceIds,
    PredecessorRegistryManifestId: V2.registryManifestId,
  };
  const registryId = identityId(registryPreimage);
  const registryDoc = { schemaId: 'XnysCalendarRegistry/3', calendarRegistryManifestId: registryId, calendarAuthorityPolicyId: policyId, identityRule: 'sha256Canonical(preimage) over the closed ordered members of XnysCalendarRegistry/3', preimage: registryPreimage };
  // Window binding, feature windows, horizons.
  const binding = L.g23.createCalendarWindowBinding({ calendarAuthorityPolicyId: policyId, calendarRegistryManifestId: registryId, allowedSessionKinds: ['REGULAR_SESSION', 'HALF_DAY_SESSION'], calendarNamespaceVersion: NAMESPACE });
  const featureWindowSpecs = L.g23.FEATURE_WINDOW_LADDER_V1.map((n) => { const s = L.g23.createFeatureWindowSpec({ sessionCount: n, calendarWindowBinding: binding }); return { sessionCount: s.sessionCount, unit: s.unit, calendarWindowBindingId: s.calendarWindowBindingId, featureWindowSpecId: s.featureWindowSpecId }; });
  const horizonCounts = [...L.g22.HORIZONS_V1];
  if (JSON.stringify(horizonCounts) !== '[30,90,180,252]') die('STOP_PROOF_DRIFTED', 'horizon definitions');
  const horizons = horizonCounts.map((n) => { const h = L.g22.createHorizon({ sessionCount: n, calendarRegistryManifestId: registryId }); return { label: `H${n}`, sessionCount: h.sessionCount, calendarRegistryManifestId: h.calendarRegistryManifestId, horizonId: h.horizonId }; });
  // Analogue search scope.
  const allSessions = YEARS.flatMap((y) => cores.get(y).value.sessions);
  const sessionDates = allSessions.map((s) => s.sessionDate);
  if (sessionDates[0] !== RAW_DATA_START_TARGET) die('STOP_CALENDAR_SOURCE_UNPROVEN', `first session ${sessionDates[0]}`);
  if (sessionDates.find((d) => d >= '2011-01-01') !== ANALOGUE_SEARCH_START_TARGET) die('STOP_CALENDAR_SOURCE_UNPROVEN', 'analogue start is not the first 2011 session');
  if (!sessionDates.includes(DATA_END_SESSION_INCLUSIVE)) die('STOP_CALENDAR_SOURCE_UNPROVEN', 'data end is not a session');
  const scopePreimage = { RawDataStartTarget: RAW_DATA_START_TARGET, AnalogueSearchStartTarget: ANALOGUE_SEARCH_START_TARGET, DataEndSessionInclusive: DATA_END_SESSION_INCLUSIVE, CalendarRegistryManifestId: registryId };
  const scopeId = identityId(scopePreimage);
  const warmup = sessionDates.filter((d) => d < ANALOGUE_SEARCH_START_TARGET);
  const eligible = sessionDates.filter((d) => d >= ANALOGUE_SEARCH_START_TARGET && d <= DATA_END_SESSION_INCLUSIVE);
  const scopeDoc = {
    schemaId: 'AnalogueSearchScope/1', analogueSearchScopeId: scopeId, preimage: scopePreimage,
    rules: { sessionsBeforeAnalogueStartMayBeCandidates: false, sessionsBeforeAnalogueStartMayBeHistoricalQueries: false, rawDataRole: 'WARMUP_AND_SUPPORT_ONLY', sessionsAfterDataEndInScope: false, perInstrumentEligibleStart: 'LATEST_OF (contract historicalScope.perInstrumentEligibleStartTerms)', interpretation: 'OWNER_RATIFIED_SEARCH_SCOPE_BOUNDARY_NOT_AN_ELIGIBILITY_POLICY' },
    derivedCounts: { warmupOnlySessionCount: warmup.length, warmupFirstSession: warmup[0], warmupLastSession: warmup[warmup.length - 1], scopeSessionCount: eligible.length, scopeFirstSession: eligible[0], scopeLastSession: eligible[eligible.length - 1], sessions2010InScope: eligible.filter((d) => d < '2011-01-01').length },
  };
  // V2 / V3 differential.
  const diff = (fromD, toD) => {
    const v2 = new Map(V2.years.flatMap((y) => v2Cores.get(y).sessions).filter((s) => s.sessionDate >= fromD && s.sessionDate <= toD).map((s) => [s.sessionDate, s]));
    const v3 = new Map(allSessions.filter((s) => s.sessionDate >= fromD && s.sessionDate <= toD).map((s) => [s.sessionDate, s]));
    const onlyV2 = [...v2.keys()].filter((d) => !v3.has(d)).sort(); const onlyV3 = [...v3.keys()].filter((d) => !v2.has(d)).sort();
    const changed = [...v2.keys()].filter((d) => v3.has(d) && fileBytes(v2.get(d)).compare(fileBytes(v3.get(d))) !== 0).sort();
    return { fromDate: fromD, toDateInclusive: toD, v2SessionCount: v2.size, v3SessionCount: v3.size, removedInV3: onlyV2, addedInV3: onlyV3, sessionRecordChanges: changed };
  };
  const dThroughEnd = diff('2018-01-01', DATA_END_SESSION_INCLUSIVE); const dFull = diff('2018-01-01', '2026-12-31');
  const expectedRemoved = ['2018-12-05', '2025-01-09'];
  for (const d of [dThroughEnd, dFull]) if (!sameDates(d.removedInV3, expectedRemoved) || d.addedInV3.length || d.sessionRecordChanges.length) die('STOP_CALENDAR_EVIDENCE_CONFLICT', `V2/V3 differential ${JSON.stringify(d)}`);
  const rulesetAgreement = V2.years.map((y, i) => ({ calendarYear: y, v2TimeZoneRulesetId: v2Policy.yearlyRulesets[i].timeZoneRulesetId, v3TimeZoneRulesetId: rulesets.get(y).id, identical: v2Policy.yearlyRulesets[i].timeZoneRulesetId === rulesets.get(y).id }));
  if (rulesetAgreement.some((r) => !r.identical)) die('STOP_PROOF_DRIFTED', 'V2-era timezone ruleset drift');
  const differential = {
    schemaVersion: 'JarviseDh2011CalendarV2V3Differential/1', v2CalendarRegistryManifestId: V2.registryManifestId, v2CalendarAuthorityPolicyId: V2.authorityPolicyId, v2CalendarWindowBindingId: V2.calendarWindowBindingId,
    v3CalendarRegistryManifestId: registryId, v3CalendarAuthorityPolicyId: policyId, v3CalendarWindowBindingId: binding.calendarWindowBindingId,
    throughDataEnd: dThroughEnd, fullV2Overlap: dFull,
    explanations: expectedRemoved.map((date) => ({ sessionDate: date, change: 'REMOVED_IN_V3', reason: 'ACCEPTED_SPECIAL_FULL_CLOSURE', specialClosureEvidenceIds: special.closures.find((s) => s.sessionDate === date).primary.concat(special.closures.find((s) => s.sessionDate === date).corroborating).map((e) => e.evidenceId) })),
    unexplainedSessionDelta: [], v2EraTimeZoneRulesets: rulesetAgreement, v2BytesMutated: false,
  };
  // Write outputs.
  const files = new Map();
  const put = (path, value) => { if (files.has(path)) die('WU2B_DUPLICATE_OUTPUT', path); files.set(path, fileBytes(value)); };
  const builderSha256 = sha256(readFileSync(fileURLToPath(import.meta.url)));
  put(`${DATA_ROOT}/XNYS/authority-policy.json`, policy);
  for (const y of YEARS) {
    const d = years.get(y); const base = `${DATA_ROOT}/XNYS/${y}`;
    put(`${base}/timezone-ruleset.json`, rulesets.get(y).value);
    put(`${base}/session-calendar-core.json`, cores.get(y).value);
    put(`${base}/normalized-source.json`, normalized.get(y).value);
    put(`${base}/PROVENANCE.json`, {
      schemaVersion: 'JarviseDh2011CalendarV3YearProvenance/1', programId: PROGRAM_ID, workUnit: WORK_UNIT, calendarYear: y, venueId: VENUE_ID, calendarNamespaceVersion: NAMESPACE,
      calendarAuthorityPolicyId: policyId, timeZoneRulesetId: rulesets.get(y).id, calendarCoreId: cores.get(y).id, normalizedSourceId: normalized.get(y).id,
      sourceEvidence: normalized.get(y).value.calendarSourceEvidenceIds.map((id) => { const e = evidence.get(id); return { evidenceId: id, evidenceSourceId: e.preimage.EvidenceSourceId, authority: e.meta.authority, role: e.meta.role, sourceBytesSha256: e.preimage.SourceBytesSha256, publishedAt: e.preimage.PublishedAt, capturedAt: e.preimage.CapturedAt }; }),
      specialClosureDates: d.specials.map((s) => s.sessionDate), exceptionalClosureCompleteness: exceptionalCompleteness(y),
      analogueSearchRole: y === 2010 ? 'WARMUP_AND_SUPPORT_ONLY_NOT_ANALOGUE_SEARCH_SCOPE' : (y === 2026 ? 'ANALOGUE_SEARCH_SCOPE_THROUGH_2026_09_04_ONLY' : 'ANALOGUE_SEARCH_SCOPE'),
      buildContractId: builderSha256,
    });
  }
  put(`${DATA_ROOT}/evidence/CALENDAR_SOURCE_EVIDENCE.json`, { schemaVersion: 'JarviseDh2011CalendarSourceEvidenceSet/1', identitySchema: 'CalendarSourceEvidence/1', identityRule: 'evidenceId = sha256:sha256Canonical(preimage); PublicationEvidenceId = sha256:sha256Canonical(publicationEvidence)', records: allEvidenceIds.map((id) => evidence.get(id)) });
  put(`${DATA_ROOT}/evidence/SPECIAL_CLOSURE_EVIDENCE.json`, { schemaVersion: 'JarviseDh2011CalendarV3SpecialClosures/1', acceptedBy: OWNER_EVIDENCE_ACCEPTANCE, closures: special.closures, documentedContext: special.context, integrityAdvisories: [OBJECT_023_ADVISORY], missingBarsUsedAsAuthority: false });
  put(`${DATA_ROOT}/evidence/EXCEPTIONAL_CLOSURE_SWEEP_2026.json`, { schemaVersion: 'JarviseDh2011CalendarV3ExceptionalClosureSweep/1', acceptedBy: OWNER_EVIDENCE_ACCEPTANCE, ...n5 });
  put(`${DATA_ROOT}/evidence/ACCEPTED_EVIDENCE_COHORT.json`, {
    schemaVersion: 'JarviseDh2011Wu2aAcceptedEvidenceCohort/1', programId: PROGRAM_ID, publicationIdentity: PUBLICATION_IDENTITY, ownerEvidenceAcceptance: OWNER_EVIDENCE_ACCEPTANCE, ownerBuildAuthority: OWNER_BUILD_AUTHORITY,
    runs: Object.entries(COHORT).map(([run, spec]) => ({ run, acquisitionManifestSha256: spec.manifestSha256, acquisitionReportSha256: spec.reportSha256, objectsConsumed: [...cohort[run].used.values()].sort((a, b) => a.objectId.localeCompare(b.objectId)) })),
    v2RepairedSourceBlobs: Object.entries(V2_REPAIRED_FROM_R1).map(([key, objectId]) => { const [y, side] = key.split(':'); return { calendarYear: Number(y), authority: side === 'nyse' ? 'NYSE' : 'NASDAQ_TRADER', v2DeclaredSha256: V2_PIN[y][side][0], acceptedSourceObject: `R1/${objectId}`, committedGitBlobIsEolNormalizedNotOriginal: true }; }).sort((a, b) => a.calendarYear - b.calendarYear || a.authority.localeCompare(b.authority)),
    integrityAdvisories: [OBJECT_023_ADVISORY], evidenceLocationIsIdentity: false, networkUsedByBuild: false,
  });
  const reg = `${DATA_ROOT}/XNYS/registry/R0001`;
  put(`${reg}/registry-manifest.json`, registryDoc);
  put(`${reg}/CALENDAR_WINDOW_BINDING.json`, { schemaVersion: 'WHEEL_JARVISE_HISTORICAL_CALENDAR_BINDING_V3/1', calendarWindowBinding: { ...binding }, featureWindowSpecs, mutatesCalendarV2Binding: false, v2CalendarWindowBindingId: V2.calendarWindowBindingId, retrospectiveSemantics: 'RETROSPECTIVE_RECONSTRUCTION' });
  put(`${reg}/HORIZON_BINDINGS.json`, { schemaVersion: 'JarviseDh2011HorizonBindings/1', horizonDefinitionSource: 'GATE22_TEMPORAL_HORIZON_V1 (unchanged)', horizonIdComposition: 'sessionCount + calendarRegistryManifestId', horizonUnit: 'CANONICAL_TRADING_SESSION', horizonDefinitionChanged: false, remintReason: 'NEW_CALENDAR_V3_REGISTRY_BINDING', horizons });
  put(`${reg}/ANALOGUE_SEARCH_SCOPE.json`, scopeDoc);
  put(`${reg}/V2_V3_DIFFERENTIAL.json`, differential);
  put(`${reg}/PROVENANCE.json`, {
    schemaVersion: 'JarviseDh2011CalendarV3RegistryProvenance/1', programId: PROGRAM_ID, workUnit: WORK_UNIT, publicationIdentity: PUBLICATION_IDENTITY, venueId: VENUE_ID, calendarNamespaceVersion: NAMESPACE,
    ownerEvidenceAcceptance: OWNER_EVIDENCE_ACCEPTANCE, ownerBuildAuthority: OWNER_BUILD_AUTHORITY,
    calendarAuthorityPolicyId: policyId, calendarRegistryManifestId: registryId, calendarWindowBindingId: binding.calendarWindowBindingId, analogueSearchScopeId: scopeId,
    calendarCoreIds: YEARS.map((y) => cores.get(y).id), coverageFromDate: '2010-01-01', coverageToDateExclusive: '2027-01-01', yearRecordCount: YEARS.length,
    sessionCount: allSessions.length, halfDaySessionCount: allSessions.filter((s) => s.sessionKind === 'HALF_DAY_SESSION').length, firstSession: sessionDates[0], lastSession: sessionDates[sessionDates.length - 1],
    specialClosureDates: [...SPECIAL_CLOSURE_DATES], predecessorRegistryManifestId: V2.registryManifestId, supersedesCalendarV2: false, coexistsWithCalendarV2: true,
    gate27Role: 'DOCUMENTARY_PUBLICATION_CONTEXT_ONLY', gate27Started: false, buildContractId: builderSha256, networkUsed: false, missingBarsUsedAsAuthority: false,
  });
  // Write files.
  mkdirSync(candidateRoot, { recursive: true });
  for (const [p, bytes] of [...files.entries()].sort()) { const abs = resolve(candidateRoot, ...p.split('/')); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, bytes); }
  return {
    outputPathCount: files.size, outputBytes: [...files.values()].reduce((a, b) => a + b.length, 0), outputDigests: Object.fromEntries([...files.entries()].sort().map(([p, b]) => [p, sha256(b)])),
    calendarAuthorityPolicyId: policyId, calendarRegistryManifestId: registryId, calendarWindowBindingId: binding.calendarWindowBindingId, analogueSearchScopeId: scopeId,
    horizons, featureWindowSpecs, sessionCount: allSessions.length, evidenceRecordCount: allEvidenceIds.length, builderSha256,
    yearSummary: YEARS.map((y) => ({ year: y, sessions: cores.get(y).value.sessions.length, halfDays: cores.get(y).value.sessions.filter((s) => s.sessionKind === 'HALF_DAY_SESSION').length, calendarCoreId: cores.get(y).id, timeZoneRulesetId: rulesets.get(y).id })),
    differential: { throughDataEnd: dThroughEnd, fullV2Overlap: dFull },
  };
}

function exceptionalCompleteness(year) {
  if (year === 2026) return { status: 'POSITIVELY_ENUMERATED_THROUGH_DATA_END', basis: 'GOVERNED_V1_SWEEP_THROUGH_2026_08_26_PLUS_WU2A_R3_LIVE_OFFICIAL_ENUMERATION_2026_08_27_TO_2026_09_04', sessionsAfter2026_09_04: 'SCHEDULED_CALENDAR_ONLY_OUTSIDE_ANALOGUE_SEARCH_SCOPE' };
  if (year === 2012 || year === 2018 || year === 2025) return { status: 'OWNER_ACCEPTED_DOCUMENTARY_SPECIAL_CLOSURE_SET', basis: 'WU2A_R1_R2_ACCEPTED_SPECIAL_CLOSURE_EVIDENCE_PRIMARY_PLUS_INDEPENDENT_CORROBORATION', positiveEnumerationOfAllNotices: false };
  return { status: 'OWNER_ACCEPTED_DOCUMENTARY_SPECIAL_CLOSURE_SET', basis: 'WU2A_COHORT_IDENTIFIED_NO_SPECIAL_CLOSURE_FOR_THIS_YEAR', positiveEnumerationOfAllNotices: false };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) { if (!argv[i]?.startsWith('--') || argv[i + 1] === undefined) die('WU2B_BUILDER_FLAGS_REQUIRED'); out[argv[i].slice(2)] = resolve(argv[i + 1]); }
  if (Object.keys(out).sort().join(',') !== 'candidate-root,evidence-root,repo-root') die('WU2B_BUILDER_FLAGS_REQUIRED');
  return out;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const a = args(process.argv.slice(2));
    if (existsSync(a['candidate-root']) && statSync(a['candidate-root']).isFile()) die('WU2B_CANDIDATE_ROOT_INVALID');
    const result = await buildCalendarV3({ repoRoot: a['repo-root'], evidenceRoot: a['evidence-root'], candidateRoot: a['candidate-root'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error?.stack || String(error)}\n`); process.exitCode = 1; }
}
