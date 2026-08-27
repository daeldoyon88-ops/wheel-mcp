import { readFileSync } from 'node:fs';

import { getCapturedYahooChartResult } from './g21BridgeCaptureR1.mjs';
import { MP1_XNYS_CALENDAR_PATH, selectClosedMp1Sessions } from './closedSessionSelectorR1.mjs';

function normalizeSymbol(symbol) {
  return String(symbol ?? '').trim().toUpperCase();
}

function readProductionMp1Calendar() {
  return JSON.parse(readFileSync(new URL(`../../${MP1_XNYS_CALENDAR_PATH}`, import.meta.url), 'utf8'));
}

export function getJarviseCaptureContextR1({ symbol } = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) {
    return { status: 'FAIL_CLOSED', reasonCode: 'SYMBOL_INVALID' };
  }

  const capture = getCapturedYahooChartResult(normalizedSymbol);
  if (!capture) {
    return Object.freeze({
      symbol: normalizedSymbol,
      captureAvailable: false,
      sessionDate: null,
      effectiveKnowledgeCutoff: null,
      historicalReplaySupport: 'UNAVAILABLE',
    });
  }

  const selected = selectClosedMp1Sessions(readProductionMp1Calendar(), capture.capturedAt);
  if (selected.status !== 'AVAILABLE' || !selected.latestClosedSession) {
    return {
      status: 'FAIL_CLOSED',
      reasonCode: selected.reasonCode ?? 'MP1_SESSION_UNAVAILABLE',
    };
  }

  return Object.freeze({
    symbol: normalizedSymbol,
    captureAvailable: true,
    sessionDate: selected.latestClosedSession.sessionDate,
    effectiveKnowledgeCutoff: selected.latestClosedSession.closeUtc,
    historicalReplaySupport: 'UNAVAILABLE',
  });
}
