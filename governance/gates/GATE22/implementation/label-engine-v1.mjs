import { observationIsAdmissible, createHorizon, resolveOutcomeWindow } from './temporal-horizon-v1.mjs';
import { createObservationId, createOutcomeId } from './identity-model-v1.mjs';
import { validatePriceBasisWindow } from './price-basis-v1.mjs';
import { deriveOutcomeDatasetAsOf, bindSeparateDatasets, validateOutcomeWindowCoverage, verifyOutcomeDatasetSnapshot } from './dataset-separation-v1.mjs';
import { validateTaxonomy, TAXONOMY_VERSION } from './taxonomy-v1.mjs';
import { createOutcomeRecord } from './outcome-persistence-v1.mjs';

export function buildLabelOutcome(input) {
  if (!observationIsAdmissible(input.observation)) return { status: 'BLOCKED', code: 'OBSERVATION_KNOWLEDGE_CUTOFF' };
  const horizon = createHorizon(input.horizon);
  const window = resolveOutcomeWindow({ sessionDate: input.observation.SessionDate, horizon, calendarSessions: input.calendarSessions });
  if (window.status !== 'RESOLVED') return window;
  const coverage = validateOutcomeWindowCoverage({ sessions: window.sessions, windowBars: input.windowBars });
  if (coverage.status !== 'RESOLVED') return coverage;
  const basis = validatePriceBasisWindow(input.windowBars.map((bar) => bar.priceBasisId));
  if (basis.status !== 'RESOLVED') return basis;
  const asOf = deriveOutcomeDatasetAsOf(input.windowBars);
  if (!asOf || input.now < asOf) return { status: 'NOT_YET_RESOLVED' };
  const outcomeDataset = verifyOutcomeDatasetSnapshot({
    outcomeDatasetSnapshot: input.outcomeDatasetSnapshot,
    observationInstrumentIdentityId: input.observation.InstrumentIdentityId,
    priceBasisId: basis.priceBasisId,
    windowBars: input.windowBars,
    asOf,
  });
  if (input.outcomeDatasetId !== undefined && input.outcomeDatasetId !== outcomeDataset.datasetId) {
    throw new Error('OUTCOME_DATASET_ID_MISMATCH');
  }
  bindSeparateDatasets({ observationDatasetId: input.observation.DatasetId_observation, outcomeDatasetId: outcomeDataset.datasetId });
  const observationId = createObservationId(input.observation);
  const outcomeId = createOutcomeId({ ObservationId: observationId, HorizonId: horizon.horizonId, FormulaId: input.formulaId, DatasetId_outcome: outcomeDataset.datasetId, PriceBasisId: basis.priceBasisId, TaxonomyVersion: TAXONOMY_VERSION });
  const labels = validateTaxonomy(input.labels);
  return createOutcomeRecord({ asOf, now: input.now, outcomeId, status: 'RESOLVED', payload: { labels, observationId, horizon } });
}
