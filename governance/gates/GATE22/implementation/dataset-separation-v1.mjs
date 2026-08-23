import { verifySnapshotDatasetManifest } from '../../../../research/directional-lab/src/data/buildSnapshotDatasetManifest.mjs';

export function deriveOutcomeDatasetAsOf(windowBars) {
  if (!Array.isArray(windowBars) || windowBars.length === 0 || windowBars.some((bar) => !bar.initialRootAvailableAt)) return null;
  return windowBars.map((bar) => bar.initialRootAvailableAt).sort().at(-1);
}

export function validateOutcomeWindowCoverage({ sessions, windowBars }) {
  if (!Array.isArray(sessions) || !Array.isArray(windowBars) || sessions.length !== windowBars.length) {
    return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW' };
  }
  const expected = new Set(sessions.map((session) => session?.sessionDate));
  const actual = new Set(windowBars.map((bar) => bar?.sessionDate));
  if (expected.size !== sessions.length || actual.size !== windowBars.length
    || [...expected].some((sessionDate) => !actual.has(sessionDate))
    || windowBars.some((bar) => !bar?.initialRootAvailableAt || !bar?.settlingAt)) {
    return { status: 'INSUFFICIENT_DATA', code: 'INSUFFICIENT_SESSIONS_IN_WINDOW' };
  }
  return { status: 'RESOLVED' };
}

export function verifyOutcomeDatasetSnapshot({ outcomeDatasetSnapshot, observationInstrumentIdentityId, priceBasisId, windowBars, asOf }) {
  if (!outcomeDatasetSnapshot || outcomeDatasetSnapshot.instrumentIdentityId !== observationInstrumentIdentityId) {
    throw new Error('OUTCOME_DATASET_INSTRUMENT_MISMATCH');
  }
  const verified = verifySnapshotDatasetManifest({
    store: outcomeDatasetSnapshot.store,
    snapshotDatasetManifestId: outcomeDatasetSnapshot.snapshotDatasetManifestId,
  });
  if (verified.snapshot.core.canonicalSymbol !== observationInstrumentIdentityId
    || verified.snapshot.core.priceBasis !== priceBasisId) {
    throw new Error('OUTCOME_DATASET_SNAPSHOT_MISMATCH');
  }
  const snapshotBars = verified.snapshot.normalizedDailyBars.bars;
  if (snapshotBars.length !== windowBars.length) throw new Error('OUTCOME_DATASET_WINDOW_MISMATCH');
  const bySession = new Map(snapshotBars.map((bar) => [bar.sessionDate, bar]));
  if (bySession.size !== snapshotBars.length || windowBars.some((bar) => {
    const snapshotBar = bySession.get(bar.sessionDate);
    return !snapshotBar || snapshotBar.eventTime !== bar.settlingAt
      || snapshotBar.availableAt !== bar.initialRootAvailableAt
      || snapshotBar.availableAt > asOf;
  })) throw new Error('OUTCOME_DATASET_WINDOW_MISMATCH');
  return Object.freeze({ datasetId: verified.snapshotDatasetManifestId, verified });
}

export function bindSeparateDatasets({ observationDatasetId, outcomeDatasetId }) {
  if (!observationDatasetId || !outcomeDatasetId || observationDatasetId === outcomeDatasetId) throw new Error('DATASET_SEPARATION_REQUIRED');
  return Object.freeze({ observationDatasetId, outcomeDatasetId });
}
