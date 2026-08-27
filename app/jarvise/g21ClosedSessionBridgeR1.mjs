import { readFileSync } from 'node:fs';
import { normalizeDailyBars } from '../../research/directional-lab/src/data/normalizeDailyBars.mjs';
import { requestHistoricalCausalData } from '../../governance/gates/GATE21/implementation/causal-data-interface.mjs';
import { getCapturedYahooChartResult } from './g21BridgeCaptureR1.mjs';
import { MP1_XNYS_CALENDAR_PATH, selectClosedMp1Sessions } from './closedSessionSelectorR1.mjs';

export const G21_YAHOO_SOURCE_ID = 'YAHOO_CHART_EOD';
export const G21_YAHOO_PRICE_BASIS = 'SPLIT_ADJUSTED';

function readMp1Calendar() {
  return JSON.parse(readFileSync(new URL(`../../${MP1_XNYS_CALENDAR_PATH}`, import.meta.url), 'utf8'));
}

function rowSessionDate(row) {
  if (typeof row?.date === 'string') return row.date.slice(0, 10);
  if (row?.date instanceof Date && Number.isFinite(row.date.getTime())) return row.date.toISOString().slice(0, 10);
  return null;
}

function canonicalRow(row) {
  const sessionDate = rowSessionDate(row);
  return sessionDate ? { ...row, date: sessionDate } : null;
}

function replayUnavailable({ symbol, requestedKnowledgeCutoff, captureLatestClosedSession, requestedLatestClosedSession }) {
  return {
    status: 'UNAVAILABLE',
    reasonCode: 'HISTORICAL_REPLAY_UNAVAILABLE',
    symbol,
    requestedKnowledgeCutoff,
    effectiveKnowledgeCutoff: null,
    captureLatestClosedSession,
    requestedLatestClosedSession,
    admittedBarCount: 0,
    records: [],
    absences: [],
    historicalReplaySupport: 'UNAVAILABLE',
    earliestReplayBoundary: 'UNAVAILABLE prior to future pinned snapshot',
  };
}

export function buildG21ClosedSessionBridgeR1({ symbol, knowledgeCutoff, captureRecord, calendar, requestHistoricalCausalDataFn = requestHistoricalCausalData } = {}) {
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (!normalizedSymbol) return { status: 'FAIL_CLOSED', reasonCode: 'SYMBOL_INVALID', records: [] };
  const resolvedCalendar = calendar ?? readMp1Calendar();
  const selected = selectClosedMp1Sessions(resolvedCalendar, knowledgeCutoff);
  if (selected.status === 'FAIL_CLOSED') return { ...selected, symbol: normalizedSymbol, records: [] };

  const capture = captureRecord ?? getCapturedYahooChartResult(normalizedSymbol);
  if (!capture || !capture.chartResult || typeof capture.capturedAt !== 'string') {
    return { status: 'ABSENT', reasonCode: 'CAPTURE_UNAVAILABLE', symbol: normalizedSymbol, records: [] };
  }
  const capturedSelection = selectClosedMp1Sessions(resolvedCalendar, capture.capturedAt);
  if (capturedSelection.status !== 'AVAILABLE' || selected.status !== 'AVAILABLE') {
    return replayUnavailable({
      symbol: normalizedSymbol,
      requestedKnowledgeCutoff: knowledgeCutoff,
      captureLatestClosedSession: capturedSelection.latestClosedSession ?? null,
      requestedLatestClosedSession: selected.latestClosedSession ?? null,
    });
  }
  const captureLatest = capturedSelection.latestClosedSession;
  const requestedLatest = selected.latestClosedSession;
  if (captureLatest.sessionDate !== requestedLatest.sessionDate || captureLatest.closeUtc !== requestedLatest.closeUtc) {
    return replayUnavailable({
      symbol: normalizedSymbol,
      requestedKnowledgeCutoff: knowledgeCutoff,
      captureLatestClosedSession: captureLatest,
      requestedLatestClosedSession: requestedLatest,
    });
  }
  const effectiveKnowledgeCutoff = requestedLatest.closeUtc;
  const quotes = Array.isArray(capture.chartResult.quotes) ? capture.chartResult.quotes : null;
  if (!quotes) return { status: 'ABSENT', reasonCode: 'CAPTURE_UNAVAILABLE', symbol: normalizedSymbol, records: [] };

  const closedByDate = new Map(selected.sessions.map((session) => [session.sessionDate, session]));
  const calendarByDate = new Map(resolvedCalendar.sessions.map((session) => [session.sessionDate, session]));
  const selectedRows = [];
  const exclusions = [];
  let excludedCurrentSessionCount = 0;
  let excludedInvalidRowCount = 0;
  for (const quote of quotes) {
    const sessionDate = rowSessionDate(quote);
    if (!sessionDate) {
      excludedInvalidRowCount += 1;
      exclusions.push({ sessionDate: null, reasonCode: 'YAHOO_ROW_DATE_INVALID' });
      continue;
    }
    if (!closedByDate.has(sessionDate)) {
      if (calendarByDate.has(sessionDate)) {
        excludedCurrentSessionCount += 1;
        exclusions.push({ sessionDate, reasonCode: 'SESSION_NOT_CLOSED_AT_K' });
      } else {
        exclusions.push({ sessionDate, reasonCode: 'MP1_SESSION_UNAVAILABLE' });
      }
      continue;
    }
    const row = canonicalRow(quote);
    if (row) selectedRows.push(row);
  }

  const normalized = normalizeDailyBars(selectedRows, {
    symbol: normalizedSymbol,
    source: G21_YAHOO_SOURCE_ID,
    ohlcBasis: G21_YAHOO_PRICE_BASIS,
    timezone: 'America/New_York',
    loaderVersion: 'g21ClosedSessionBridgeR1/1',
  });
  const cutoffMs = Date.parse(effectiveKnowledgeCutoff);
  const admissibleBars = normalized.filter((bar) => {
    const admissible = Date.parse(bar.eventTime) <= cutoffMs
      && Date.parse(bar.availableAt) <= cutoffMs
      && Date.parse(bar.availableAt) >= Date.parse(bar.eventTime);
    if (!admissible) exclusions.push({ sessionDate: bar.sessionDate, reasonCode: 'NORMALIZED_BAR_NOT_AVAILABLE_AT_K' });
    return admissible;
  });
  const excludedNotYetAvailableCount = normalized.length - admissibleBars.length;
  const admission = requestHistoricalCausalDataFn({
    sourceId: G21_YAHOO_SOURCE_ID,
    bars: admissibleBars,
    plane: 'HISTORICAL',
    asOf: effectiveKnowledgeCutoff,
    adjustmentMode: G21_YAHOO_PRICE_BASIS,
    timezone: 'America/New_York',
  });
  return {
    status: admission.status,
    reasonCode: admission.code,
    symbol: normalizedSymbol,
    sourceId: G21_YAHOO_SOURCE_ID,
    sessionDate: selected.latestClosedSession?.sessionDate ?? null,
    requestedKnowledgeCutoff: knowledgeCutoff,
    effectiveKnowledgeCutoff,
    captureLatestClosedSession: captureLatest,
    requestedLatestClosedSession: requestedLatest,
    priceBasis: G21_YAHOO_PRICE_BASIS,
    historicalPlaneStatus: admission.plane ?? 'HISTORICAL',
    normalizedBarCount: normalized.length,
    admittedBarCount: admission.records.length,
    excludedCurrentSessionCount,
    excludedNotYetAvailableCount,
    excludedInvalidRowCount,
    exclusions,
    completeness: admission.completeness,
    records: admission.records,
    absences: admission.absences,
    historicalReplaySupport: 'UNAVAILABLE',
    earliestReplayBoundary: 'UNAVAILABLE prior to future pinned snapshot',
  };
}
