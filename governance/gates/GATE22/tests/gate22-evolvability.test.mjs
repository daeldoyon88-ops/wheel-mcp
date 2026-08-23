import assert from 'node:assert/strict';
import { TAXONOMY_PRIMITIVES, validateTaxonomy } from '../implementation/taxonomy-v1.mjs';
import { bindSeparateDatasets } from '../implementation/dataset-separation-v1.mjs';
import { createOutcomeRecord, appendOutcome } from '../implementation/outcome-persistence-v1.mjs';
assert.equal(TAXONOMY_PRIMITIVES.length, 6); assert.throws(() => validateTaxonomy(['CAPITULATION']));
assert.throws(() => bindSeparateDatasets({ observationDatasetId: 'v1', outcomeDatasetId: 'v1' }));
assert.equal(createOutcomeRecord({ asOf: 'z', now: 'a', outcomeId: 'x', status: 'RESOLVED' }), null);
const record = createOutcomeRecord({ asOf: 'a', now: 'z', outcomeId: 'x', status: 'RESOLVED' }); assert.throws(() => appendOutcome([record], record));
console.log('GATE22_EVOLVABILITY_PASS 5');
