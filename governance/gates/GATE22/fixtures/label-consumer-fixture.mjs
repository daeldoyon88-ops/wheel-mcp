import { buildLabelOutcome } from '../implementation/label-engine-v1.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createContentAddressedStore } from '../../../../research/directional-lab/src/storage/contentAddressedStoreV1.mjs';
import { buildDatasetSnapshot } from '../../../../research/directional-lab/src/data/buildDatasetSnapshot.mjs';
import { buildSnapshotDatasetManifest } from '../../../../research/directional-lab/src/data/buildSnapshotDatasetManifest.mjs';

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const sessionDate = (index) => `2026-03-${String(index + 1).padStart(2, '0')}`;
const session = (index) => ({ sessionDate: sessionDate(index), sessionKind: index === 10 ? 'HALF_DAY_SESSION' : 'REGULAR_SESSION' });
const windowBar = (index) => ({ sessionDate: sessionDate(index), priceBasisId: 'RAW', settlingAt: `${sessionDate(index)}T20:00:00.000Z`, initialRootAvailableAt: `${sessionDate(index)}T20:00:00.000Z` });

export function createOutcomeDatasetSnapshot({ providerId = 'fixture-provider' } = {}) {
  const store = createContentAddressedStore({ root: mkdtempSync(join(tmpdir(), 'gate22-snapshot-')) });
  const built = buildDatasetSnapshot({
    store,
    sourceBytes: Buffer.from(JSON.stringify({ providerId, sessions: 30 }), 'utf8'),
    normalizedDailyBars: { schemaVersion: 'CanonicalDailyBars/1', bars: Array.from({ length: 30 }, (_, index) => ({
      sessionDate: sessionDate(index), eventTime: `${sessionDate(index)}T20:00:00Z`, availableAt: `${sessionDate(index)}T20:00:00Z`,
      open: 30, high: 32, low: 29, close: 31, volume: null,
      corporateActions: { splitFactor: null, cashDividend: null }, qualityFlags: ['SYNTHETIC', 'VOLUME_MISSING'],
    })) },
    core: {
      canonicalSymbol: 'iid-1', providerId, providerSymbol: 'SYNTH', sourceFormat: 'SYNTHETIC_JSON_V1',
      adapterVersion: 'syntheticAdapter/1', adapterOptions: {}, normalizerVersion: 'canonicalDailyBars/1', normalizationOptions: {},
      canonicalSerializationVersion: 'CanonicalJSON/1', priceBasis: 'RAW', corporateActionPolicyHash: HASH_A,
      calendarId: 'SYNTHETIC_WEEKDAY', calendarVersion: 'calendar/1', transformImplementationHash: HASH_B,
    },
    record: { sourceAcquiredAt: null, ingestedIntoLabAt: '2026-03-31T21:00:00Z', acquisitionMethod: 'fixture', acquisitionToolVersion: 'fixture/1', acquisitionRequestIdentity: { providerId }, acquisitionEvidenceIds: [HASH_A] },
  });
  const manifest = buildSnapshotDatasetManifest({ store, snapshotCoreId: built.snapshotCore.objectId, snapshotRecordId: built.snapshotRecord.objectId });
  return Object.freeze({ store, snapshotDatasetManifestId: manifest.manifestId, instrumentIdentityId: 'iid-1' });
}

const outcomeDatasetSnapshot = createOutcomeDatasetSnapshot();
export const fixtureInput = Object.freeze({
  observation: { InstrumentIdentityId: 'iid-1', SessionDate: '2026-01-02', KnowledgeCutoff: '2026-01-02T21:00:00Z', AvailableAt: '2026-01-02T20:00:00Z', Source: 'GATE21', DatasetId_observation: 'obs-v1', PriceBasisId: 'RAW', MissingnessState: 'COMPLETE' },
  horizon: { sessionCount: 30, calendarRegistryManifestId: 'calendar-v1' },
  calendarSessions: [{ sessionDate: '2026-01-02', sessionKind: 'REGULAR_SESSION' }, ...Array.from({ length: 30 }, (_, index) => session(index))],
  windowBars: Array.from({ length: 30 }, (_, index) => windowBar(index)), outcomeDatasetSnapshot, formulaId: 'GATE22_FORMULA_V1', labels: ['NEW_LOW', 'DRAWDOWN'], now: '2026-04-01T00:00:00Z'
});
export const consumeFixture = () => buildLabelOutcome(fixtureInput);
