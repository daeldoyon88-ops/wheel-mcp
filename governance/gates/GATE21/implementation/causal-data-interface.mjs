/**
 * GATE21 canonical causal market-data facade for GATE22+.
 *
 * Wraps DailyBarV1 / missingness / corporate-action / vintage lab contracts.
 * Does not rebuild them. Downstream consumers depend on this interface, not
 * on provider-specific schemas.
 */

import { sha256Canonical } from '../../../tools/canonical-json.mjs';
import {
  DAILY_BAR_SCHEMA_VERSION,
  ADJUSTMENT_TYPES,
  isStrictUtcIsoInstant,
  dailyBarProblems,
  MISSING_REASONS,
  isCanonicalMissingReason,
  reasonForTrailingWindow,
  corporateActionPolicyFor,
  CORPORATE_ACTION_POLICY_VERSION,
  isValidCivilDate,
  sessionCloseUtc,
  normalizeDailyBars,
  validateDailyBars,
  selectPriceBasis,
  validateDatasetManifest,
  resolveMacroVintageAsOf,
  refuseDirectionalLabMutation,
} from './lab-import-adapter.mjs';
import {
  GATE21_V1_SOURCE_ROWS,
  GATE21_CANONICAL_BAR_SCHEMA,
  resolveFallback,
  validateSourceRegistry,
} from './source-registry-v1.mjs';

export const GATE21_CAUSAL_INTERFACE_VERSION = 'GATE21_CausalDataInterface/1';
export const GATE21_NORMALIZED_RECORD_VERSION = 'GATE21_NormalizedCausalRecord/1';
export const GATE21_BINDING_ID = 'GATE21_BINDING_V1';

export const GATE21_PLANE = Object.freeze({
  HISTORICAL: 'HISTORICAL',
  LIVE: 'LIVE',
});

export const GATE21_PLANE_CONTRACT = Object.freeze({
  historical: 'GATE21 snapshots, vintages, manifests and replay',
  live: 'NOT_IMPLEMENTED_IN_GATE21',
  liveSubstitutionIntoHistorical: 'FORBIDDEN',
  sharedLiveSnapshot: 'OUT_OF_SCOPE',
  productionIngestion: 'NOT_IMPLEMENTED',
});

export const GATE21_PERFORMANCE_CONTRACT = Object.freeze({
  liveScanCriticalPath: 'MUST_NOT_LENGTHEN',
  historicalWork: 'OFF_SCAN',
  architecture: Object.freeze(['FETCH_ONCE', 'NORMALIZE', 'VERSION_CACHE', 'REUSE']),
  perScanApiCalls: 'FORBIDDEN_FOR_HISTORICAL_PRECOMPUTE',
  wheelScannerCoupling: 'NONE',
});

export const DECISION = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  ABSENT: 'ABSENT',
  BLOCKED: 'BLOCKED',
  FAIL_CLOSED: 'FAIL_CLOSED',
});

const IANA_TZ = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/;
const EXPLICIT_TZ = new Set(['UTC', 'Etc/UTC', 'America/New_York']);

export function isExplicitTimezone(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value === 'LOCAL' || value === 'local' || value === 'ambiguous') return false;
  if (value === 'EST' || value === 'EDT' || value === 'CST' || value === 'PST') return false;
  return EXPLICIT_TZ.has(value) || IANA_TZ.test(value);
}

export function refuseOutOfScope(kind, detail = null) {
  const blocked = {
    G22_LABELS: 'G22_PLUS_FORBIDDEN',
    G23_FEATURES: 'G22_PLUS_FORBIDDEN',
    G24_REGIMES: 'G22_PLUS_FORBIDDEN',
    G25_ANALOGS: 'G22_PLUS_FORBIDDEN',
    LIVE_INGESTION: 'LIVE_PLANE_NOT_IMPLEMENTED',
    SCANNER_REWRITE: 'PRODUCTION_COUPLING_FORBIDDEN',
    LAB_MUTATION: 'DIRECTIONAL_LAB_MUTATION_FORBIDDEN',
  };
  return {
    status: DECISION.BLOCKED,
    code: blocked[kind] ?? 'OUT_OF_SCOPE',
    kind,
    detail,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assertDailyBarV1(bar) {
  const problems = dailyBarProblems(bar);
  return { ok: problems.length === 0, problems, schema: DAILY_BAR_SCHEMA_VERSION };
}

export function normalizeProviderRows(rows, options) {
  const schema = options?.canonicalSchema ?? GATE21_CANONICAL_BAR_SCHEMA;
  if (schema !== GATE21_CANONICAL_BAR_SCHEMA) {
    return { status: DECISION.BLOCKED, code: 'INCOMPATIBLE_FALLBACK_SCHEMA', bars: [] };
  }
  const bars = normalizeDailyBars(rows, {
    symbol: options.symbol,
    source: options.source,
    ohlcBasis: options.ohlcBasis ?? 'RAW',
    timezone: options.timezone ?? 'America/New_York',
    currency: options.currency ?? 'USD',
    documentedSplits: options.documentedSplits,
    loaderVersion: options.loaderVersion,
  });
  return { status: DECISION.AVAILABLE, code: null, bars };
}

function barUnavailableAtAsOf(bar, asOfMs) {
  const eventMs = Date.parse(bar.eventTime);
  const availableMs = Date.parse(bar.availableAt);
  if (eventMs > asOfMs) return { absent: true, code: 'FUTURE_BAR_UNAVAILABLE_AT_AS_OF' };
  if (availableMs > asOfMs) return { absent: true, code: 'NOT_YET_AVAILABLE' };
  return { absent: false, code: null };
}

function missingVolumeState(volume) {
  if (volume === 0) {
    return { volume, volumeMissing: false, missingReason: null, note: 'zero volume is observed, not missing' };
  }
  if (volume === null || volume === undefined) {
    return {
      volume: null,
      volumeMissing: true,
      missingReason: MISSING_REASONS.VOLUME_MISSING,
    };
  }
  return { volume, volumeMissing: false, missingReason: null };
}

export function refuseMissingVolumeAsZero(volume) {
  if (volume === null || volume === undefined) {
    return { status: DECISION.BLOCKED, code: 'MISSING_VOLUME_NOT_ZERO', coerced: false, volume: null };
  }
  return { status: DECISION.AVAILABLE, code: null, coerced: false, volume };
}

export function refuseForwardFill(requested) {
  if (requested === true) {
    return { status: DECISION.BLOCKED, code: 'FORWARD_FILL_FORBIDDEN' };
  }
  return { status: DECISION.AVAILABLE, code: null };
}

export function refuseRawOverwrite(bar, proposedRaw) {
  const current = sha256Canonical(bar.raw);
  const proposed = sha256Canonical(proposedRaw);
  if (current !== proposed) {
    return { status: DECISION.BLOCKED, code: 'RAW_SEMANTICS_OVERWRITE_FORBIDDEN', raw: cloneJson(bar.raw) };
  }
  return { status: DECISION.AVAILABLE, code: null, raw: cloneJson(bar.raw) };
}

export function selectAdjustedView(bar, adjustmentMode, { overwriteRaw = false, strict = true } = {}) {
  if (overwriteRaw) {
    return { status: DECISION.BLOCKED, code: 'RAW_SEMANTICS_OVERWRITE_FORBIDDEN', view: null };
  }
  if (!ADJUSTMENT_TYPES.includes(adjustmentMode)) {
    return { status: DECISION.BLOCKED, code: 'UNKNOWN_ADJUSTMENT_MODE', view: null };
  }
  try {
    const selected = selectPriceBasis([bar], adjustmentMode, { strict });
    return {
      status: DECISION.AVAILABLE,
      code: null,
      view: {
        raw: cloneJson(bar.raw),
        adjusted: cloneJson(bar.adjusted),
        selected: selected.series[0],
        basis: selected.basis,
        warnings: selected.warnings,
        policy: corporateActionPolicyFor(adjustmentMode),
      },
    };
  } catch (error) {
    return { status: DECISION.BLOCKED, code: 'ADJUSTMENT_SELECTION_REFUSED', error: error.message, view: null };
  }
}

/**
 * Lightweight wrap of the lab as-of rule: availableAt <= knowledgeCutoff.
 * Store-backed callers should use resolveMacroVintageAsOf directly.
 */
export function selectMacroVintageAsOf({ vintages, knowledgeCutoff }) {
  if (!isStrictUtcIsoInstant(knowledgeCutoff)) {
    return { status: DECISION.FAIL_CLOSED, code: 'KNOWLEDGE_CUTOFF_INVALID', selected: null, resolutionStatus: 'NOT_AVAILABLE' };
  }
  if (!Array.isArray(vintages)) {
    return { status: DECISION.FAIL_CLOSED, code: 'VINTAGES_NOT_ARRAY', selected: null, resolutionStatus: 'NOT_AVAILABLE' };
  }
  const admissible = vintages
    .filter((item) => item && typeof item.availableAt === 'string' && item.availableAt <= knowledgeCutoff)
    .sort((left, right) => {
      if (left.availableAt < right.availableAt) return -1;
      if (left.availableAt > right.availableAt) return 1;
      return (left.vintageSequence ?? 0) - (right.vintageSequence ?? 0);
    });
  const invisible = vintages.filter((item) => item && item.availableAt > knowledgeCutoff);
  if (admissible.length === 0) {
    return {
      status: DECISION.ABSENT,
      code: 'MACRO_VINTAGE_NOT_AVAILABLE',
      selected: null,
      resolutionStatus: 'NOT_AVAILABLE',
      invisibleLaterRevisions: invisible.map((item) => item.vintageId ?? item.availableAt),
    };
  }
  const selected = admissible[admissible.length - 1];
  return {
    status: DECISION.AVAILABLE,
    code: null,
    selected,
    resolutionStatus: 'RESOLVED',
    invisibleLaterRevisions: invisible.map((item) => item.vintageId ?? item.availableAt),
  };
}

export function verifyReplayManifest({
  source,
  contentHash,
  version,
  expectedSource,
  expectedHash,
  expectedVersion,
}) {
  if (source !== expectedSource || contentHash !== expectedHash || version !== expectedVersion) {
    return {
      status: DECISION.BLOCKED,
      code: 'REPLAY_MANIFEST_MISMATCH',
      actual: { source, contentHash, version },
      expected: { source: expectedSource, contentHash: expectedHash, version: expectedVersion },
    };
  }
  return { status: DECISION.AVAILABLE, code: null };
}

function toNormalizedRecord(bar, selected, adjustmentMode) {
  const volumeState = missingVolumeState(selected.volume);
  return {
    schemaVersion: GATE21_NORMALIZED_RECORD_VERSION,
    dailyBarSchema: DAILY_BAR_SCHEMA_VERSION,
    symbol: bar.symbol,
    sessionDate: bar.sessionDate,
    eventTime: bar.eventTime,
    availableAt: bar.availableAt,
    timezone: bar.timezone,
    basis: adjustmentMode,
    raw: cloneJson(bar.raw),
    adjusted: cloneJson(bar.adjusted),
    selected: {
      open: selected.open,
      high: selected.high,
      low: selected.low,
      close: selected.close,
      volume: volumeState.volume,
    },
    missing: {
      volumeMissing: volumeState.volumeMissing,
      missingReason: volumeState.missingReason,
    },
    corporateActions: cloneJson(bar.corporateActions),
    qualityFlags: [...bar.qualityFlags],
    source: bar.source,
  };
}

export function requestHistoricalCausalData(input = {}) {
  const plane = input.plane ?? GATE21_PLANE.HISTORICAL;
  if (plane === GATE21_PLANE.LIVE) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: 'LIVE_PLANE_NOT_IMPLEMENTED',
      records: [],
      absences: [],
      digest: null,
    };
  }
  if (input.liveSubstitution === true) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: 'LIVE_INTO_HISTORICAL_FORBIDDEN',
      records: [],
      absences: [],
      digest: null,
    };
  }
  const fill = refuseForwardFill(input.forwardFill === true);
  if (fill.status === DECISION.BLOCKED) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: fill.code,
      records: [],
      absences: [],
      digest: null,
    };
  }
  if (input.coerceMissingVolumeToZero === true) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: 'MISSING_VOLUME_NOT_ZERO',
      records: [],
      absences: [],
      digest: null,
    };
  }
  if (input.overwriteRaw === true) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: 'RAW_SEMANTICS_OVERWRITE_FORBIDDEN',
      records: [],
      absences: [],
      digest: null,
    };
  }
  if (!isExplicitTimezone(input.timezone)) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.FAIL_CLOSED,
      code: 'TIMEZONE_AMBIGUOUS',
      records: [],
      absences: [],
      digest: null,
    };
  }
  if (!isStrictUtcIsoInstant(input.asOf)) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.FAIL_CLOSED,
      code: 'AS_OF_INVALID',
      records: [],
      absences: [],
      digest: null,
    };
  }

  const adjustmentMode = input.adjustmentMode ?? 'RAW';
  if (!ADJUSTMENT_TYPES.includes(adjustmentMode)) {
    return {
      interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
      status: DECISION.BLOCKED,
      code: 'UNKNOWN_ADJUSTMENT_MODE',
      records: [],
      absences: [],
      digest: null,
    };
  }

  if (input.fallbackSchema && input.fallbackSchema !== GATE21_CANONICAL_BAR_SCHEMA) {
    const fallback = resolveFallback(input.registry ?? GATE21_V1_SOURCE_ROWS, input.sourceId, input.fallbackSchema);
    if (fallback.status === DECISION.BLOCKED) {
      return {
        interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
        status: DECISION.BLOCKED,
        code: fallback.code,
        records: [],
        absences: [],
        digest: null,
      };
    }
  }

  if (input.manifestExpected) {
    const replay = verifyReplayManifest({
      source: input.manifest?.source,
      contentHash: input.manifest?.contentHash,
      version: input.manifest?.version,
      expectedSource: input.manifestExpected.source,
      expectedHash: input.manifestExpected.contentHash,
      expectedVersion: input.manifestExpected.version,
    });
    if (replay.status === DECISION.BLOCKED) {
      return {
        interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
        status: DECISION.BLOCKED,
        code: replay.code,
        records: [],
        absences: [],
        digest: null,
        replay,
      };
    }
  }

  const bars = Array.isArray(input.bars) ? input.bars : [];
  const seriesValidation = validateDailyBars(bars);
  const asOfMs = Date.parse(input.asOf);
  const records = [];
  const absences = [];

  for (const bar of bars) {
    const structural = assertDailyBarV1(bar);
    if (!structural.ok) {
      absences.push({
        sessionDate: bar?.sessionDate ?? null,
        status: DECISION.BLOCKED,
        code: 'DAILYBAR_INVALID',
        problems: structural.problems,
      });
      continue;
    }
    if (bar.timezone !== input.timezone) {
      return {
        interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
        status: DECISION.FAIL_CLOSED,
        code: 'TIMEZONE_AMBIGUOUS',
        records: [],
        absences: [],
        digest: null,
      };
    }
    if (Date.parse(bar.availableAt) < Date.parse(bar.eventTime)) {
      return {
        interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
        status: DECISION.BLOCKED,
        code: 'AVAILABLE_AT_PRECEDES_EVENT_TIME',
        records: [],
        absences: [],
        digest: null,
      };
    }
    const availability = barUnavailableAtAsOf(bar, asOfMs);
    if (availability.absent) {
      absences.push({
        sessionDate: bar.sessionDate,
        eventTime: bar.eventTime,
        availableAt: bar.availableAt,
        status: availability.code === 'FUTURE_BAR_UNAVAILABLE_AT_AS_OF' ? DECISION.BLOCKED : DECISION.ABSENT,
        code: availability.code,
      });
      continue;
    }
    const view = selectAdjustedView(bar, adjustmentMode, {
      overwriteRaw: false,
      strict: input.strict !== false,
    });
    if (view.status !== DECISION.AVAILABLE) {
      absences.push({
        sessionDate: bar.sessionDate,
        status: DECISION.BLOCKED,
        code: view.code,
        error: view.error ?? null,
      });
      continue;
    }
    records.push(toNormalizedRecord(bar, view.view.selected, adjustmentMode));
  }

  const policy = corporateActionPolicyFor(adjustmentMode);
  const replayIdentity = {
    interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
    sourceVersion: input.sourceVersion ?? GATE21_CAUSAL_INTERFACE_VERSION,
    manifest: input.manifest ?? null,
    causalCutoff: input.asOf,
    corporateActionPolicy: CORPORATE_ACTION_POLICY_VERSION,
    corporateActionPolicyId: input.corporateActionPolicyId ?? `${CORPORATE_ACTION_POLICY_VERSION}:${adjustmentMode}`,
    adjustmentMode,
    timezone: input.timezone,
    records,
  };
  const digest = sha256Canonical(replayIdentity);
  const anyBlocked = absences.some((item) => item.status === DECISION.BLOCKED);
  const status = records.length > 0
    ? DECISION.AVAILABLE
    : (anyBlocked ? DECISION.BLOCKED : DECISION.ABSENT);

  return {
    interfaceVersion: GATE21_CAUSAL_INTERFACE_VERSION,
    bindingId: GATE21_BINDING_ID,
    status,
    code: records.length > 0 ? null : (absences[0]?.code ?? 'NO_CAUSAL_RECORDS'),
    plane: GATE21_PLANE.HISTORICAL,
    asOf: input.asOf,
    adjustmentMode,
    corporateActionPolicy: policy,
    seriesValidation: {
      problems: seriesValidation.problems,
      warnings: seriesValidation.warnings,
      stats: seriesValidation.stats,
    },
    records,
    absences,
    completeness: {
      available: records.length > 0,
      complete: records.length > 0 && absences.length === 0 && bars.length > 0,
      emptyDatasetNotComplete: bars.length === 0,
    },
    digest,
    replay: {
      sourceVersion: replayIdentity.sourceVersion,
      manifest: replayIdentity.manifest,
      causalCutoff: input.asOf,
      corporateActionPolicyId: replayIdentity.corporateActionPolicyId,
      adjustmentMode,
    },
    performance: GATE21_PERFORMANCE_CONTRACT,
    planeContract: GATE21_PLANE_CONTRACT,
  };
}

export function replayHistoricalCausalData(input) {
  const first = requestHistoricalCausalData(input);
  const second = requestHistoricalCausalData(input);
  return {
    identical: first.digest === second.digest && first.digest !== null,
    digest: first.digest,
    first,
    second,
  };
}

export {
  isCanonicalMissingReason,
  reasonForTrailingWindow,
  isValidCivilDate,
  sessionCloseUtc,
  validateDatasetManifest,
  resolveMacroVintageAsOf,
  refuseDirectionalLabMutation,
  validateSourceRegistry,
};
