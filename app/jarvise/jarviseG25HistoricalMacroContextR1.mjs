/**
 * GATE25 historical regime foundation R1: real historical CORE_V1 macro context.
 *
 * Two halves, both network-free:
 *
 * 1. Source-evidence parsing (used by the materializer). Pinned FREE/public bytes
 *    already acquired OFF_SCAN: U.S. Treasury Daily Par Yield Curve Rates CSVs
 *    (US_TREASURY authority, US.TREAS.DGS3MO/2/5/10/30) and the ALFRED
 *    "Observations by Real-Time Period" export of CPIAUCSL (BLS authority,
 *    FRED_ALFRED archival carrier, US.BLS.CPIAUCSL point-in-time vintages).
 *
 * 2. Runtime producer. Verifies the persisted L4B-I1/I2 CAS authority with the
 *    unchanged lab verifiers, then derives the GATE24-facing prepared context with
 *    the unchanged canonical producers the GATE24 mandate binds:
 *      curveShape / curveDirection  macroCurveFeaturesL4BV1.mjs::computeCurveState
 *                                   over resolveMacroSeriesForSession, chained
 *                                   session to session exactly as
 *                                   macroStateBySessionRowsL4BV1.mjs does
 *      cpiYoY                       macroInflationFeaturesL4BF2V2.mjs::computeInflationStateV2
 *                                   over buildMonthlyWeeklySeriesIndex, under the additive
 *                                   CPI successor MarketMacroInstrumentProjectionPolicy/2
 *                                   (ENDPOINTS_M_AND_M_MINUS_12_REQUIRED); the V1 policy
 *                                   object stays materialized and verified, unchanged
 *      US.TREAS.DGS10               verified vintages, admitted by GATE24 at its own vintage
 *    and binds it with GATE24 createMacroContextBinding. The binding's availableAtPolicyId
 *    is the historical derived-row availability policy, which pins the as-of policy and
 *    the CPI successor policy, so a changed CPI admission rule is a new MacroContextBindingId.
 *
 * Causality: every vintage availableAt is derived by the pinned release rule
 * (Treasury 16:00 America/New_York, BLS 08:30 America/New_York) on its release
 * civil date; a derived session row is first usable at its own K(T); GATE24
 * admits every consumed observation with availableAt <= K(T). No latest value, no
 * interpolation, no forward fill beyond the frozen producer carry-forward policy.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { createContentAddressedStore } from '../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { verifyMacroIngestionPolicy } from '../../research/directional-lab/src/macro/macroIngestionPolicyL4BV1.mjs';
import { verifyMacroAsOfResolutionPolicy } from '../../research/directional-lab/src/macro/macroAsOfResolutionPolicyL4BV1.mjs';
import { verifyMacroSeriesRegistryManifest } from '../../research/directional-lab/src/macro/macroSeriesRegistryL4BV1.mjs';
import { verifyMacroVintageSetManifest } from '../../research/directional-lab/src/macro/macroVintageSetL4BV1.mjs';
import { verifyMacroDatasetSnapshotManifest } from '../../research/directional-lab/src/macro/macroDatasetSnapshotL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from '../../research/directional-lab/src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { verifyMarketMacroInstrumentProjectionPolicy } from '../../research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V1.mjs';
import { verifyMarketMacroInstrumentProjectionPolicyV2 } from '../../research/directional-lab/src/macro/marketMacroInstrumentProjectionPolicyL4BF2V2.mjs';
import { CPI_YOY_ENDPOINT_WINDOW_POLICY_V2 } from '../../research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V2.mjs';
import { resolveMacroSeriesForSession } from '../../research/directional-lab/src/macro/macroSeriesSessionResolutionL4BV1.mjs';
import { computeCurveState } from '../../research/directional-lab/src/macro/macroCurveFeaturesL4BV1.mjs';
import { buildMonthlyWeeklySeriesIndex } from '../../research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs';
import { computeInflationStateV2 } from '../../research/directional-lab/src/macro/macroInflationFeaturesL4BF2V2.mjs';
import { verifyMacroObservationVintageCore } from '../../research/directional-lab/src/macro/macroObservationVintageL4BV1.mjs';
import { F1_SERIES_CODES } from '../../research/directional-lab/src/contracts/macroFeatureContractsL4BV1.mjs';
import { sha256Canonical } from '../../governance/tools/canonical-json.mjs';
import {
  createMacroContextBinding,
  resolveMacroSnapshot,
} from '../../governance/gates/GATE24/implementation/macro-context-binding-v1.mjs';
import { G24_MACRO_SEMANTICS_R1 } from './jarviseG24RatifiedParametersR1.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const HISTORICAL_MACRO_CONTEXT_RELATIVE_ROOT_R1 = 'data/jarvise/historical-macro-context';
const DEFAULT_DATA_ROOT = resolve(REPOSITORY_ROOT, HISTORICAL_MACRO_CONTEXT_RELATIVE_ROOT_R1);

export const HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1 = 'G25_HISTORICAL_REAL_MACRO_CONTEXT';
export const HISTORICAL_MACRO_BINDING_PROJECTION_SCHEMA_R1 = 'JarviseG25HistoricalMacroContextBindingProjection/2';
export const HISTORICAL_MACRO_AVAILABILITY_POLICY_SCHEMA_R1 = 'JarviseG25HistoricalMacroAvailabilityPolicy/2';

/** Exact canonical bytes of the CPI successor policy, addressed by their own sha256. */
export function cpiSuccessorPolicyRelativePathR1(instrumentProjectionPolicyId) {
  if (!/^sha256:[0-9a-f]{64}$/.test(instrumentProjectionPolicyId ?? '')) fail('CPI_SUCCESSOR_POLICY_ID_INVALID');
  return `cpi-successor-policy/sha256/${instrumentProjectionPolicyId.slice(7)}.json`;
}

/**
 * The availableAtPolicyId bound into the historical MacroContextBinding. Its preimage is
 * the complete rule deciding when a prepared macro member is usable at K(T): the as-of
 * resolution policy, the curve feature policy, the CPI successor policy and its window
 * token, and the derived-row rule (a session row is first usable at its own K(T)).
 */
export function deriveHistoricalMacroAvailabilityPolicyIdR1(projection) {
  return `sha256:${sha256Canonical({
    schemaVersion: HISTORICAL_MACRO_AVAILABILITY_POLICY_SCHEMA_R1,
    macroAsOfResolutionPolicyId: projection.macroAsOfResolutionPolicyId,
    featureComputationPolicyId: projection.featureComputationPolicyId,
    cpiInstrumentProjectionPolicyId: projection.cpiSuccessorInstrumentProjectionPolicyId,
    cpiYoYMonthlyWindowPolicy: CPI_YOY_ENDPOINT_WINDOW_POLICY_V2,
    derivedRowAvailableAtRule: 'SESSION_ROW_FIRST_USABLE_AT_OWN_KNOWLEDGE_CUTOFF',
  })}`;
}

/** Declared coverage of this foundation. Bounded, explicit, never "latest". */
export const HISTORICAL_MACRO_COVERAGE_R1 = Object.freeze({
  treasuryObservationFromInclusive: '2024-12-02',
  treasuryObservationToInclusive: '2026-09-04',
  cpiReferencePeriodFromInclusive: '2023-11',
  cpiReferencePeriodToInclusive: '2026-07',
  vintageReleaseCivilDateToInclusive: '2026-09-04',
  sessionStateFromInclusive: '2024-12-02',
  sessionStateToInclusive: '2026-09-04',
  classificationCoverageFromInclusive: '2025-01-02',
});

/** Treasury CSV column -> canonical CORE_V1 series code. */
export const TREASURY_COLUMN_SERIES_R1 = Object.freeze({
  '3 Mo': 'US.TREAS.DGS3MO',
  '2 Yr': 'US.TREAS.DGS2',
  '5 Yr': 'US.TREAS.DGS5',
  '10 Yr': 'US.TREAS.DGS10',
  '30 Yr': 'US.TREAS.DGS30',
});
export const TREASURY_SERIES_CODES_R1 = Object.freeze(Object.values(TREASURY_COLUMN_SERIES_R1));
export const CPI_SERIES_CODE_R1 = 'US.BLS.CPIAUCSL';

/** GATE24-facing members whose representation the Owner ratified (G24_MACRO_SEMANTICS_R1 plus the taxonomy token carriers). */
export const G24_FACING_SERIES_CODES_R1 = Object.freeze(['US.TREAS.DGS10']);
export const G24_FACING_DERIVED_CODES_R1 = Object.freeze(['cpiYoY', 'curveShape', 'curveDirection']);

export class JarviseG25HistoricalMacroError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'JarviseG25HistoricalMacroError';
    this.code = code;
    this.details = details;
  }
}
const fail = (code, details) => { throw new JarviseG25HistoricalMacroError(code, details); };
const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* --------------------------------------------------------------- source parsing */

/** Exact decimal string -> canonical fixed point; no float ever touches the value. */
export function decimalStringToFixedR1(text) {
  if (typeof text !== 'string' || !/^-?\d+(\.\d+)?$/.test(text)) fail('MACRO_SOURCE_DECIMAL_INVALID', { text });
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '');
  const atoms = digits === '0' || /^0+$/.test(digits) ? '0' : `${negative ? '-' : ''}${digits}`;
  return Object.freeze({ atoms, scale: fraction.length });
}

/** Canonical fixed point -> the correctly rounded plain JavaScript number of its decimal. */
export function fixedToNumberR1({ atoms, scale }) {
  const negative = atoms.startsWith('-');
  const digits = (negative ? atoms.slice(1) : atoms).padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  const value = Number(`${negative ? '-' : ''}${text}`);
  if (!Number.isFinite(value)) fail('MACRO_FIXED_POINT_NOT_FINITE', { atoms, scale });
  return value === 0 ? 0 : value;
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells;
}

/** One Treasury par yield curve CSV -> per-date rows for the CORE_V1 tenors. */
export function parseTreasuryParYieldCsvR1(bytes) {
  const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
  const header = splitCsvLine(lines[0]);
  if (header[0] !== 'Date') fail('TREASURY_CSV_HEADER_INVALID');
  const columnIndex = Object.fromEntries(Object.keys(TREASURY_COLUMN_SERIES_R1).map((column) => {
    const index = header.indexOf(column);
    if (index < 0) fail('TREASURY_CSV_COLUMN_ABSENT', { column });
    return [column, index];
  }));
  const rows = [];
  const dates = new Set();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(cells[0]);
    if (!match) fail('TREASURY_CSV_DATE_INVALID', { cell: cells[0] });
    const date = `${match[3]}-${match[1]}-${match[2]}`;
    if (dates.has(date)) fail('TREASURY_CSV_DATE_DUPLICATE', { date });
    dates.add(date);
    const values = {};
    for (const [column, seriesCode] of Object.entries(TREASURY_COLUMN_SERIES_R1)) {
      const cell = (cells[columnIndex[column]] ?? '').trim();
      values[seriesCode] = cell === '' ? null : decimalStringToFixedR1(cell);
    }
    rows.push(Object.freeze({ date, values: Object.freeze(values) }));
  }
  return Object.freeze(rows.sort((left, right) => left.date.localeCompare(right.date)));
}

/** Minimal deterministic ZIP reader (stored or deflate entries) over pinned bytes. */
export function readZipEntriesR1(bytes) {
  const buffer = Buffer.from(bytes);
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if ((flags & 0x08) !== 0) fail('ZIP_DATA_DESCRIPTOR_UNSUPPORTED');
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data));
    else fail('ZIP_METHOD_UNSUPPORTED', { method });
    offset = start + compressedSize;
  }
  if (entries.size === 0) fail('ZIP_NO_ENTRIES');
  return entries;
}

export const ALFRED_REAL_TIME_ENTRY_NAME_R1 = 'obs._by_real-time_period.csv';

/**
 * ALFRED Observations by Real-Time Period -> per reference month vintage chains.
 * An explicitly empty value is a published non-observation: it is recorded as
 * such and never becomes a vintage.
 */
export function parseAlfredRealTimePeriodCsvR1(csvBytes, { seriesColumn = 'CPIAUCSL' } = {}) {
  const lines = Buffer.from(csvBytes).toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
  const header = splitCsvLine(lines[0]);
  if (header.join(',') !== `period_start_date,${seriesColumn},realtime_start_date,realtime_end_date`) {
    fail('ALFRED_CSV_HEADER_INVALID', { header });
  }
  const byPeriod = new Map();
  const nonPublications = [];
  for (const line of lines.slice(1)) {
    const [periodStart, valueText, realtimeStart, realtimeEnd] = splitCsvLine(line);
    if (!/^\d{4}-\d{2}-01$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(realtimeStart)
      || (realtimeEnd !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(realtimeEnd))) {
      fail('ALFRED_CSV_ROW_INVALID', { line });
    }
    const referencePeriod = periodStart.slice(0, 7);
    if (valueText === '') {
      nonPublications.push(Object.freeze({ referencePeriod, realtimeStart, realtimeEnd: realtimeEnd || null }));
      continue;
    }
    const list = byPeriod.get(referencePeriod) ?? [];
    list.push({ referencePeriod, value: decimalStringToFixedR1(valueText), realtimeStart, realtimeEnd: realtimeEnd || null });
    byPeriod.set(referencePeriod, list);
  }
  const chains = [...byPeriod.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([referencePeriod, list]) => {
    const ordered = [...list].sort((left, right) => left.realtimeStart.localeCompare(right.realtimeStart));
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1].realtimeEnd === null || ordered[index - 1].realtimeEnd >= ordered[index].realtimeStart) {
        fail('ALFRED_REAL_TIME_PERIODS_OVERLAP', { referencePeriod });
      }
    }
    return Object.freeze({ referencePeriod, vintages: Object.freeze(ordered.map((item) => Object.freeze(item))) });
  });
  return Object.freeze({ chains: Object.freeze(chains), nonPublications: Object.freeze(nonPublications) });
}

/* ------------------------------------------------------------- runtime authority */

/** Content-addressed reads are pure functions of their object id; memoize them per process. */
function memoizedStore(store) {
  const objects = new Map();
  const canonical = new Map();
  return Object.freeze({
    ...store,
    readObject(input) {
      const key = `${input.uri}|${input.expectedObjectId}`;
      if (!objects.has(key)) objects.set(key, store.readObject(input));
      return objects.get(key);
    },
    readCanonicalObject(input) {
      const key = `${input.uri}|${input.expectedObjectId}|${input.schemaVersion}`;
      if (!canonical.has(key)) canonical.set(key, store.readCanonicalObject(input));
      return canonical.get(key);
    },
  });
}

function readProjection(dataRoot) {
  let projection;
  try {
    projection = JSON.parse(readFileSync(join(dataRoot, 'binding-projection.json'), 'utf8'));
  } catch (cause) {
    fail('HISTORICAL_MACRO_BINDING_PROJECTION_ABSENT', { causeCode: cause?.code });
  }
  const ids = ['macroIngestionPolicyId', 'macroAsOfResolutionPolicyId', 'macroSeriesRegistryManifestId',
    'macroVintageSetManifestId', 'macroDatasetSnapshotManifestId', 'featureComputationPolicyId',
    'instrumentProjectionPolicyId', 'cpiSuccessorInstrumentProjectionPolicyId'];
  if (projection?.schemaVersion !== HISTORICAL_MACRO_BINDING_PROJECTION_SCHEMA_R1 || projection.authoritative !== false
    || projection.producerClassification !== HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1
    || ids.some((field) => !/^sha256:[0-9a-f]{64}$/.test(projection[field] ?? ''))
    || sha256Canonical(projection.coverage) !== sha256Canonical(HISTORICAL_MACRO_COVERAGE_R1)) {
    fail('HISTORICAL_MACRO_BINDING_PROJECTION_INVALID');
  }
  return projection;
}

/**
 * Loads and verifies the complete historical macro authority. Every projected id
 * must be backed by its verified CAS object; the vintage set must be non-empty and
 * reference the verified policy and registry.
 */
export function loadJarviseG25HistoricalMacroAuthorityR1({ dataRoot } = {}) {
  const root = resolve(dataRoot ?? DEFAULT_DATA_ROOT);
  const projection = readProjection(root);
  const store = memoizedStore(createContentAddressedStore({ root: join(root, 'cas') }));
  let verified;
  try {
    verified = {
      ingestion: verifyMacroIngestionPolicy({ store, macroIngestionPolicyId: projection.macroIngestionPolicyId }),
      asOf: verifyMacroAsOfResolutionPolicy({ store, macroAsOfResolutionPolicyId: projection.macroAsOfResolutionPolicyId }),
      registry: verifyMacroSeriesRegistryManifest({ store, macroSeriesRegistryManifestId: projection.macroSeriesRegistryManifestId }),
      vintageSet: verifyMacroVintageSetManifest({ store, macroVintageSetManifestId: projection.macroVintageSetManifestId }),
      snapshot: verifyMacroDatasetSnapshotManifest({ store, macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId }),
      featurePolicy: verifyMarketMacroFeatureComputationPolicy({ store, featureComputationPolicyId: projection.featureComputationPolicyId }),
      projectionPolicyV1: verifyMarketMacroInstrumentProjectionPolicy({ store, instrumentProjectionPolicyId: projection.instrumentProjectionPolicyId }),
      projectionPolicy: verifyMarketMacroInstrumentProjectionPolicyV2({
        policyBytes: readFileSync(join(root, cpiSuccessorPolicyRelativePathR1(projection.cpiSuccessorInstrumentProjectionPolicyId))),
        instrumentProjectionPolicyId: projection.cpiSuccessorInstrumentProjectionPolicyId,
      }),
    };
    if (projection.cpiSuccessorInstrumentProjectionPolicyId === projection.instrumentProjectionPolicyId) {
      fail('HISTORICAL_MACRO_CPI_SUCCESSOR_POLICY_NOT_DISTINCT');
    }
  } catch (cause) {
    if (cause instanceof JarviseG25HistoricalMacroError) throw cause;
    fail('HISTORICAL_MACRO_AUTHORITY_NOT_VERIFIED', { causeCode: cause?.code, causeMessage: cause?.message });
  }
  const vintageSet = verified.vintageSet.vintageSet;
  const snapshot = verified.snapshot.datasetSnapshot;
  if (vintageSet.macroIngestionPolicyId !== projection.macroIngestionPolicyId
    || vintageSet.macroSeriesRegistryManifestId !== projection.macroSeriesRegistryManifestId
    || snapshot.macroVintageSetManifestId !== projection.macroVintageSetManifestId
    || snapshot.macroIngestionPolicyId !== projection.macroIngestionPolicyId
    || snapshot.macroSeriesRegistryManifestId !== projection.macroSeriesRegistryManifestId) {
    fail('HISTORICAL_MACRO_AUTHORITY_REFERENCES_DISAGREE');
  }
  if (vintageSet.vintageCount === 0 || snapshot.emptySnapshot !== false) fail('HISTORICAL_MACRO_CONTEXT_EMPTY');
  const codes = verified.registry.registry.orderedSeriesEntries.map((entry) => entry.canonicalSeriesCode).sort();
  if (JSON.stringify(codes) !== JSON.stringify([CPI_SERIES_CODE_R1, ...TREASURY_SERIES_CODES_R1].sort())) {
    fail('HISTORICAL_MACRO_SERIES_PERIMETER_MISMATCH', { codes });
  }
  const macroContextBinding = createMacroContextBinding({
    macroVintageSetManifestId: projection.macroVintageSetManifestId,
    macroDatasetSnapshotManifestId: projection.macroDatasetSnapshotManifestId,
    availableAtPolicyId: deriveHistoricalMacroAvailabilityPolicyIdR1(projection),
  });
  return Object.freeze({ dataRoot: root, projection, store, verified, macroContextBinding });
}

/* ------------------------------------------------------------- session states */

function seriesEntryByCode(authority, code) {
  return authority.verified.registry.registry.orderedSeriesEntries.find((entry) => entry.canonicalSeriesCode === code) ?? null;
}

/**
 * Semantics-preserving narrowing for resolveMacroSeriesForSession: its winner is the
 * admissible observation with the latest period end. Observations after the session
 * date can never be admissible (availableAt is on or after their own date), and when
 * an admissible observation exists in the recent range, no older one can win. When
 * the recent range yields nothing, the full <= T set is resolved instead.
 */
function narrowedVintageSet(vintageSet, seriesIdentityId, fromDate, toDate) {
  return {
    ...vintageSet,
    orderedObservationEntries: vintageSet.orderedObservationEntries.filter((entry) => entry.macroSeriesIdentityId === seriesIdentityId
      && entry.observationPeriodEnd <= toDate && (fromDate === null || entry.observationPeriodEnd >= fromDate)),
  };
}

const minusCalendarDays = (date, days) => new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86400000).toISOString().slice(0, 10);

function resolveSeriesForSession({ authority, code, session, orderedSessions, binding, policy }) {
  const entry = seriesEntryByCode(authority, code);
  const vintageSet = authority.verified.vintageSet.vintageSet;
  const common = { store: authority.store, binding, policy, canonicalSeriesCode: code, session, orderedSessions, seriesRegistry: authority.verified.registry.registry };
  if (entry === null) return resolveMacroSeriesForSession({ ...common, vintageSet });
  const recent = resolveMacroSeriesForSession({ ...common, vintageSet: narrowedVintageSet(vintageSet, entry.macroSeriesIdentityId, minusCalendarDays(session.sessionDate, 31), session.sessionDate) });
  if (recent.availabilityStatus !== 'NOT_AVAILABLE') return recent;
  return resolveMacroSeriesForSession({ ...common, vintageSet: narrowedVintageSet(vintageSet, entry.macroSeriesIdentityId, null, session.sessionDate) });
}

/**
 * Computes one causal macro state per canonical session in the declared state range,
 * chaining previousCurveState exactly as MacroStateBySessionRows/1. Returns the lab
 * states and their GATE24-facing projection.
 */
export function computeJarviseG25HistoricalMacroSessionStatesR1({ authority, sessions }) {
  const coverage = authority.projection.coverage;
  const orderedSessionsAll = [...sessions].sort((left, right) => left.sessionDate.localeCompare(right.sessionDate));
  const inRange = orderedSessionsAll.filter((session) => session.sessionDate >= coverage.sessionStateFromInclusive
    && session.sessionDate <= coverage.sessionStateToInclusive);
  if (inRange.length === 0) fail('HISTORICAL_MACRO_SESSION_RANGE_EMPTY');
  const policy = authority.verified.featurePolicy.featureComputationPolicy;
  const projectionPolicy = authority.verified.projectionPolicy.instrumentProjectionPolicy;
  const binding = { knowledgeCutoff: inRange.at(-1).closeUtc };
  const cpiIndex = buildMonthlyWeeklySeriesIndex({
    store: authority.store,
    vintageSet: authority.verified.vintageSet.vintageSet,
    seriesRegistry: authority.verified.registry.registry,
    canonicalSeriesCode: CPI_SERIES_CODE_R1,
  });
  if (cpiIndex.status !== 'INDEXED') fail('HISTORICAL_MACRO_CPI_INDEX_UNAVAILABLE', { status: cpiIndex.status });

  const states = [];
  let previousCurveState = null;
  for (const session of inRange) {
    const orderedResolutions = F1_SERIES_CODES.map((code) => resolveSeriesForSession({
      authority, code, session, orderedSessions: orderedSessionsAll, binding, policy,
    }));
    const curveState = computeCurveState({ orderedResolutions, policy, previousCurveState, scale: policy.rateFeatureScale });
    const inflation = computeInflationStateV2({
      cpiIndex, knowledgeCutoff: session.closeUtc, sessionMonthKey: session.sessionDate.slice(0, 7), policy: projectionPolicy,
    });
    states.push(Object.freeze({ session, orderedResolutions, curveState, inflation }));
    previousCurveState = curveState;
  }
  return Object.freeze(states);
}

const CPI_YOY_DECLARATION = G24_MACRO_SEMANTICS_R1.find((item) => item.code === 'cpiYoY');
const DGS10_DECLARATION = G24_MACRO_SEMANTICS_R1.find((item) => item.code === 'US.TREAS.DGS10');

/**
 * cpiYoY in its ratified GATE24 representation: PERCENT, storageScale 4, plain number
 * in percentage points. The producer ratio is a decimal fraction at scale 6, so the
 * percent atoms at scale 4 are exactly the fraction atoms: no rounding occurs.
 * Only an AVAILABLE, non-null producer value is classifying; anything else is the
 * producer token NOT_AVAILABLE.
 */
export function projectCpiYoYR1(inflation) {
  const state = inflation.inflationState;
  if (state.cpiAvailabilityStatus !== 'AVAILABLE' || state.cpiYoY === null) return 'NOT_AVAILABLE';
  if (state.cpiYoY.scale !== 6 || CPI_YOY_DECLARATION?.storageScale !== 4 || CPI_YOY_DECLARATION.representation !== 'PERCENT') {
    fail('CPI_YOY_REPRESENTATION_MISMATCH');
  }
  return fixedToNumberR1({ atoms: state.cpiYoY.atoms, scale: CPI_YOY_DECLARATION.storageScale });
}

/**
 * Builds the GATE24 in-memory vintage store: DGS10 at every verified vintage, and one
 * derived row per session first usable at that session's K(T).
 */
export function buildJarviseG25HistoricalG24VintageStoreR1({ authority, states }) {
  if (DGS10_DECLARATION?.storageScale !== 2 || DGS10_DECLARATION.representation !== 'PERCENT') fail('DGS10_REPRESENTATION_MISMATCH');
  const dgs10Entry = seriesEntryByCode(authority, 'US.TREAS.DGS10');
  const dgs10 = [];
  for (const observation of authority.verified.vintageSet.vintageSet.orderedObservationEntries) {
    if (observation.macroSeriesIdentityId !== dgs10Entry.macroSeriesIdentityId) continue;
    for (const vintageEntry of observation.orderedVintages) {
      const { observationVintage } = verifyMacroObservationVintageCore({ store: authority.store, observationVintageId: vintageEntry.observationVintageId });
      if (observationVintage.value === null) continue;
      if (observationVintage.value.scale !== DGS10_DECLARATION.storageScale) fail('DGS10_STORAGE_SCALE_MISMATCH');
      dgs10.push(Object.freeze({
        value: fixedToNumberR1(observationVintage.value),
        availableAt: observationVintage.availableAt,
        vintageAvailableAt: observationVintage.availableAt,
        sequenceId: `${observation.observationPeriodEnd}|${observationVintage.vintageSequence}`,
        observationVintageId: vintageEntry.observationVintageId,
      }));
    }
  }
  const derived = { cpiYoY: [], curveShape: [], curveDirection: [] };
  for (const { session, curveState, inflation } of states) {
    const common = { availableAt: session.closeUtc, vintageAvailableAt: session.closeUtc, sequenceId: session.sessionDate };
    derived.cpiYoY.push(Object.freeze({ ...common, value: projectCpiYoYR1(inflation) }));
    derived.curveShape.push(Object.freeze({ ...common, value: curveState.curveShape }));
    derived.curveDirection.push(Object.freeze({ ...common, value: curveState.curveDirection }));
  }
  return Object.freeze({
    'US.TREAS.DGS10': Object.freeze(dgs10),
    cpiYoY: Object.freeze(derived.cpiYoY),
    curveShape: Object.freeze(derived.curveShape),
    curveDirection: Object.freeze(derived.curveDirection),
  });
}

/** One loaded, verified, precomputed historical macro context, reusable across N instruments. */
export function prepareJarviseG25HistoricalMacroContextR1({ authority, sessions }) {
  const states = computeJarviseG25HistoricalMacroSessionStatesR1({ authority, sessions });
  const vintageStore = buildJarviseG25HistoricalG24VintageStoreR1({ authority, states });
  const snapshots = new Map();
  const statesByDate = new Map(states.map((state) => [state.session.sessionDate, state]));
  const coverage = authority.projection.coverage;
  function snapshotAt({ sessionDate, knowledgeCutoff }) {
    if (sessionDate < coverage.classificationCoverageFromInclusive || sessionDate > coverage.sessionStateToInclusive) {
      return Object.freeze({ status: 'OUTSIDE_HISTORICAL_MACRO_COVERAGE', snapshot: null });
    }
    if (!snapshots.has(knowledgeCutoff)) {
      snapshots.set(knowledgeCutoff, resolveMacroSnapshot({ macroContextBinding: authority.macroContextBinding, vintageStore, knowledgeCutoff }));
    }
    return snapshots.get(knowledgeCutoff);
  }
  const projectionDigest = sha256Canonical(Object.fromEntries(Object.entries(vintageStore).map(([code, list]) => [code, list.map((item) => ({ value: item.value, availableAt: item.availableAt, sequenceId: item.sequenceId }))])));
  return Object.freeze({
    macroContextBinding: authority.macroContextBinding,
    vintageStore,
    states,
    statesByDate,
    snapshotAt,
    projectionDigest,
    snapshotCacheSize: () => snapshots.size,
  });
}

export function describeJarviseG25HistoricalMacroContextR1() {
  return Object.freeze({
    producerClassification: HISTORICAL_MACRO_PRODUCER_CLASSIFICATION_R1,
    coverage: HISTORICAL_MACRO_COVERAGE_R1,
    g24FacingSeriesCodes: G24_FACING_SERIES_CODES_R1,
    g24FacingDerivedCodes: G24_FACING_DERIVED_CODES_R1,
    canonicalProducers: Object.freeze({
      curve: 'research/directional-lab/src/macro/macroCurveFeaturesL4BV1.mjs::computeCurveState',
      seriesSessionResolution: 'research/directional-lab/src/macro/macroSeriesSessionResolutionL4BV1.mjs::resolveMacroSeriesForSession',
      inflation: 'research/directional-lab/src/macro/macroInflationFeaturesL4BF2V2.mjs::computeInflationStateV2',
      cpiPolicy: 'research/directional-lab/src/contracts/macroFullFeatureContractsL4BF2V2.mjs::MarketMacroInstrumentProjectionPolicy/2',
      monthlyIndex: 'research/directional-lab/src/macro/macroMonthlyWeeklySeriesResolutionL4BF2V1.mjs::buildMonthlyWeeklySeriesIndex',
      binding: 'governance/gates/GATE24/implementation/macro-context-binding-v1.mjs::createMacroContextBinding',
    }),
    networkAccess: 'NONE',
    latestValuePolicy: 'FORBIDDEN',
  });
}

export { sha256Hex };
