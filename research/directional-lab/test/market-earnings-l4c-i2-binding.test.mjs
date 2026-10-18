/**
 * L4C-I2 EarningsDatasetBinding/1.
 *
 * Five values are accepted from the caller; the remaining twelve are derived
 * from verified objects. A caller that supplies a derived field is refused, so
 * a binding can never assert a composition the snapshot does not prove.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1,
  buildEarningsDatasetBinding,
  verifyEarningsDatasetBinding,
} from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import {
  EARNINGS_DATASET_BINDING_FIELDS,
  normalizeEarningsDatasetBindingV1,
} from '../src/contracts/earningsContractsL4CIIV1.mjs';
import { verifyEarningsDatasetSnapshotManifest } from '../src/earnings/earningsDatasetSnapshotL4CIV1.mjs';
import { buildEarningsAsOfResolutionPolicy } from '../src/earnings/earningsAsOfResolutionPolicyL4CIIV1.mjs';
import {
  L4C_I2_CUTOFF_AFTER_ALL,
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  bindL4CI2Dataset,
  code,
  overlayL4CI2Store,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const callerInput = (ctx, overrides = {}) => ({
  store: ctx.store,
  earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
  earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
  earningsFiscalClassificationPolicyId: ctx.earningsFiscalClassificationPolicyId,
  transformImplementationManifestId: ctx.transformImplementationManifestId,
  knowledgeCutoff: L4C_I2_CUTOFF_AFTER_ALL,
  ...overrides,
});

test('I2-B001 builds a binding from snapshot, both policies, the I2 transform manifest and a cutoff',
  () => {
    withL4CI2ThreeFilingFixture((ctx) => {
      const built = buildEarningsDatasetBinding(callerInput(ctx));
      assert.match(built.earningsDatasetBindingId, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(built.earningsDatasetBinding).sort(),
        [...EARNINGS_DATASET_BINDING_FIELDS].sort());
      assert.equal(built.earningsDatasetBinding.knowledgeCutoff, L4C_I2_CUTOFF_AFTER_ALL);
      assert.equal(built.earningsDatasetBinding.earningsDatasetSnapshotManifestId,
        ctx.earningsDatasetSnapshotManifestId);
    });
  });

test('I2-B002 derives every non-caller field from verified objects', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const built = buildEarningsDatasetBinding(callerInput(ctx));
    const snapshot = verifyEarningsDatasetSnapshotManifest({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).earningsDatasetSnapshotManifest;
    for (const field of ['earningsEventSetManifestId', 'earningsRevisionSetManifestId',
      'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
      'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId',
      'datasetSeriesIdentity']) {
      assert.equal(built.earningsDatasetBinding[field], snapshot[field], field);
    }
    assert.equal(built.earningsDatasetBinding.jurisdictionCode, 'US');
    assert.equal(built.earningsDatasetBinding.currencyCode, 'USD');
    assert.equal(built.earningsDatasetBinding.bindingPolicyVersion, 'EarningsDatasetBinding/1');
  });
});

test('I2-B003 refuses a caller-supplied jurisdictionCode', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => buildEarningsDatasetBinding(callerInput(ctx, { jurisdictionCode: 'US' })),
      code('EARNINGS_BINDING_INVALID'));
  });
});

test('I2-B004 refuses a caller-supplied currencyCode', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => buildEarningsDatasetBinding(callerInput(ctx, { currencyCode: 'USD' })),
      code('EARNINGS_BINDING_INVALID'));
  });
});

test('I2-B005 refuses a caller-supplied temporalCapability', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => buildEarningsDatasetBinding(callerInput(ctx, {
      temporalCapability: EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1,
    })), code('EARNINGS_BINDING_INVALID'));
  });
});

test('I2-B006 refuses a caller-supplied event, revision or extraction set id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const snapshot = verifyEarningsDatasetSnapshotManifest({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
    }).earningsDatasetSnapshotManifest;
    for (const field of ['earningsEventSetManifestId', 'earningsRevisionSetManifestId',
      'earningsExtractionSetManifestId', 'earningsIngestionPolicyId',
      'earningsMetricExtractionPolicyId', 'earningsTaxonomyBundleManifestId']) {
      assert.throws(() => buildEarningsDatasetBinding(
        callerInput(ctx, { [field]: snapshot[field] })),
      code('EARNINGS_BINDING_INVALID'), field);
    }
  });
});

test('I2-B007 verify recomputes the binding and rejects any divergence', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const built = bindL4CI2Dataset(ctx.store, ctx);
    const verified = verifyEarningsDatasetBinding({
      store: ctx.store, earningsDatasetBindingId: built.earningsDatasetBindingId,
    });
    assert.deepEqual(verified.earningsDatasetBinding, built.earningsDatasetBinding);
    // temporalCapability is derived, never declared: a stored binding that
    // claims a capability outside the closed enum is refused on recomputation.
    const mutated = {
      ...structuredClone(built.earningsDatasetBinding),
      temporalCapability: 'POINT_IN_TIME_SNAPSHOT_KNOWLEDGE_AT',
    };
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[built.earningsDatasetBindingId, mutated]]));
    assert.throws(() => verifyEarningsDatasetBinding({
      store: overlay, earningsDatasetBindingId: built.earningsDatasetBindingId,
    }), code('EARNINGS_BINDING_INVALID'));
  });
});

test('I2-B008 rejects a binding whose event set id diverges from the snapshot', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const built = bindL4CI2Dataset(ctx.store, ctx);
    const mutated = normalizeEarningsDatasetBindingV1({
      ...structuredClone(built.earningsDatasetBinding),
      earningsEventSetManifestId: built.earningsDatasetBinding.earningsRevisionSetManifestId,
    });
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[built.earningsDatasetBindingId, mutated]]));
    assert.throws(() => verifyEarningsDatasetBinding({
      store: overlay, earningsDatasetBindingId: built.earningsDatasetBindingId,
    }), code('EARNINGS_BINDING_MISMATCH'));
  });
});

test('I2-B009 rejects a binding whose taxonomy bundle diverges from the snapshot', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const built = bindL4CI2Dataset(ctx.store, ctx);
    const mutated = normalizeEarningsDatasetBindingV1({
      ...structuredClone(built.earningsDatasetBinding),
      earningsTaxonomyBundleManifestId:
        built.earningsDatasetBinding.earningsIngestionPolicyId,
    });
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[built.earningsDatasetBindingId, mutated]]));
    assert.throws(() => verifyEarningsDatasetBinding({
      store: overlay, earningsDatasetBindingId: built.earningsDatasetBindingId,
    }), code('EARNINGS_BINDING_MISMATCH'));
  });
});

test('I2-B010 rejects a missing binding reference', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => verifyEarningsDatasetBinding({
      store: ctx.store, earningsDatasetBindingId: `sha256:${'4'.repeat(64)}`,
    }), code('EARNINGS_BINDING_MISSING'));
  });
});

test('I2-B011 rejects a latest-capable as-of policy', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const policy = buildEarningsAsOfResolutionPolicy({ store: ctx.store });
    const latestCapable = {
      ...structuredClone(policy.earningsAsOfResolutionPolicy),
      latestReferencePolicy: 'ALLOWED',
    };
    const overlay = overlayL4CI2Store(ctx.store,
      new Map([[policy.earningsAsOfResolutionPolicyId, latestCapable]]));
    assert.throws(() => buildEarningsDatasetBinding({
      ...callerInput(ctx), store: overlay,
    }), code('EARNINGS_AS_OF_POLICY_INVALID'));
    // The literal string "latest" is refused before any read.
    assert.throws(() => buildEarningsDatasetBinding(
      callerInput(ctx, { earningsAsOfResolutionPolicyId: 'latest' })),
    code('EARNINGS_POLICY_LATEST_FORBIDDEN'));
  });
});

test('I2-B012 two cutoffs on the same snapshot produce two different binding ids', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = bindL4CI2Dataset(ctx.store, ctx, L4C_I2_CUTOFF_AFTER_ALL);
    const second = bindL4CI2Dataset(ctx.store, ctx,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK);
    assert.notEqual(second.earningsDatasetBindingId, first.earningsDatasetBindingId);
    assert.equal(second.earningsDatasetBinding.earningsDatasetSnapshotManifestId,
      first.earningsDatasetBinding.earningsDatasetSnapshotManifestId);
  });
});

test('I2-B013 the same inputs produce a byte-identical binding and the same id', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const first = buildEarningsDatasetBinding(callerInput(ctx));
    const second = buildEarningsDatasetBinding(callerInput(ctx));
    assert.equal(second.earningsDatasetBindingId, first.earningsDatasetBindingId);
    assert.deepEqual(second.earningsDatasetBinding, first.earningsDatasetBinding);
  });
});

test('I2-B014 the binding pins temporalCapability = POINT_IN_TIME_PUBLIC_AVAILABLE_AT', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const built = bindL4CI2Dataset(ctx.store, ctx);
    assert.equal(built.earningsDatasetBinding.temporalCapability,
      'POINT_IN_TIME_PUBLIC_AVAILABLE_AT');
    assert.equal(EARNINGS_BINDING_TEMPORAL_CAPABILITY_V1, 'POINT_IN_TIME_PUBLIC_AVAILABLE_AT');
  });
});
