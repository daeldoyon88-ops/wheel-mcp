import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMacroSeriesForSession } from '../src/macro/macroSeriesSessionResolutionL4BV1.mjs';
import { verifyMarketMacroFeatureSourceBundle } from '../src/macro/marketMacroFeatureSourceBundleL4BV1.mjs';
import { verifyMarketMacroFeatureComputationPolicy } from '../src/macro/marketMacroFeatureComputationPolicyL4BV1.mjs';
import { code, openOfficialMacroL4BF1Live } from './macroFeaturesL4BSyntheticFixture.mjs';

const live = openOfficialMacroL4BF1Live();
process.on('exit', () => live.close());

function resolutionContext() {
  const bundleCtx = verifyMarketMacroFeatureSourceBundle({
    store: live.store, sourceBundleId: live.sourceBundle.sourceBundleId,
  });
  const policyCtx = verifyMarketMacroFeatureComputationPolicy({
    store: live.store, featureComputationPolicyId: live.featurePolicy.featureComputationPolicyId,
  });
  return { bundleCtx, policyCtx };
}

function resolveSeries(canonicalSeriesCode, sessionDate) {
  const { bundleCtx, policyCtx } = resolutionContext();
  const session = bundleCtx.orderedSessionsInRange.find((s) => s.sessionDate === sessionDate);
  assert.ok(session, sessionDate);
  const orderedSessions = bundleCtx.orderedSessionsAll.map((s) => ({
    sessionDate: s.sessionDate,
    openUtc: s.openUtc,
    closeUtc: s.closeUtc,
  }));
  return resolveMacroSeriesForSession({
    store: live.store,
    canonicalSeriesCode,
    session,
    orderedSessions,
    binding: bundleCtx.bindingContext.binding,
    vintageSet: bundleCtx.bindingContext.vintageSet,
    seriesRegistry: bundleCtx.bindingContext.seriesRegistry,
    policy: policyCtx.featureComputationPolicy,
  });
}

test('official fixture has six sessions in range', () => {
  const { bundleCtx } = resolutionContext();
  assert.equal(bundleCtx.orderedSessionsInRange.length, 6);
});

test('SOFR carry-forward reaches age 5 on last session without crossing stale threshold', () => {
  const sofr = resolveSeries('US.NYFED.SOFR', '2026-03-09');
  assert.equal(sofr.availabilityStatus, 'AVAILABLE');
  assert.equal(sofr.carryForwardAgeSessions, 5);
});

test('EFFR withdrawal after last close is not visible at 03-09 tip', () => {
  const effr = resolveSeries('US.NYFED.EFFR', '2026-03-09');
  assert.notEqual(effr.availabilityStatus, 'WITHDRAWN');
  assert.equal(effr.availabilityStatus, 'AVAILABLE');
});

test('policy rate is available from first session close', () => {
  const lower = resolveSeries('US.FRB.DFEDTARL', '2026-03-02');
  assert.equal(lower.availabilityStatus, 'AVAILABLE');
  assert.notEqual(lower.value, null);
});

test('half-day session resolves at early close cutoff', () => {
  const { bundleCtx } = resolutionContext();
  const halfDay = bundleCtx.orderedSessionsInRange.find((s) => s.sessionDate === '2026-03-06');
  assert.equal(halfDay.sessionKind, 'HALF_DAY_SESSION');
  const treas = resolveSeries('US.TREAS.DGS10', '2026-03-06');
  assert.equal(treas.availabilityStatus, 'AVAILABLE');
});

test('weekend dates are absent from ordered sessions in range', () => {
  const { bundleCtx } = resolutionContext();
  const dates = bundleCtx.orderedSessionsInRange.map((s) => s.sessionDate);
  assert.equal(dates.includes('2026-03-07'), false);
  assert.equal(dates.includes('2026-03-08'), false);
});

test('treasury series resolves on DST boundary session 03-09', () => {
  const treas = resolveSeries('US.TREAS.DGS10', '2026-03-09');
  assert.equal(treas.availabilityStatus, 'AVAILABLE');
});

test('carry-forward age increments across consecutive sessions for SOFR', () => {
  const ages = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-09']
    .map((date) => resolveSeries('US.NYFED.SOFR', date).carryForwardAgeSessions);
  assert.deepEqual(ages, [0, 1, 2, 3, 4, 5]);
});

test('resolve refuses session absent from ordered list', () => {
  const { bundleCtx, policyCtx } = resolutionContext();
  assert.throws(() => resolveMacroSeriesForSession({
    store: live.store,
    canonicalSeriesCode: 'US.NYFED.SOFR',
    session: {
      sessionDate: '2026-03-07',
      openUtc: '2026-03-07T14:30:00.000Z',
      closeUtc: '2026-03-07T21:00:00.000Z',
    },
    orderedSessions: bundleCtx.orderedSessionsAll,
    binding: bundleCtx.bindingContext.binding,
    vintageSet: bundleCtx.bindingContext.vintageSet,
    seriesRegistry: bundleCtx.bindingContext.seriesRegistry,
    policy: policyCtx.featureComputationPolicy,
  }), code('MARKET_DATA_MACRO_SESSION_REGISTRY_MISMATCH'));
});

test('resolve refuses unknown series code', () => {
  const { bundleCtx, policyCtx } = resolutionContext();
  const session = bundleCtx.orderedSessionsInRange[0];
  assert.throws(() => resolveMacroSeriesForSession({
    store: live.store,
    canonicalSeriesCode: 'US.FAKE.SERIES',
    session,
    orderedSessions: bundleCtx.orderedSessionsAll,
    binding: bundleCtx.bindingContext.binding,
    vintageSet: bundleCtx.bindingContext.vintageSet,
    seriesRegistry: bundleCtx.bindingContext.seriesRegistry,
    policy: policyCtx.featureComputationPolicy,
  }), code('MARKET_DATA_MACRO_SERIES_RESOLUTION_MISMATCH'));
});

test('future vintage after session close is excluded from tip', () => {
  const futureTreas = resolveSeries('US.TREAS.DGS10', '2026-03-02');
  assert.equal(futureTreas.availabilityStatus, 'AVAILABLE');
  assert.notEqual(futureTreas.referencePeriod, '2026-03-12');
});

test('binding knowledge cutoff covers all session closes in range', () => {
  const { bundleCtx } = resolutionContext();
  for (const session of bundleCtx.orderedSessionsInRange) {
    assert.ok(bundleCtx.bindingContext.binding.knowledgeCutoff >= session.closeUtc);
  }
});

test('FOMC decision series resolves on hike session 03-03', () => {
  const fomc = resolveSeries('US.FOMC.DECISION', '2026-03-03');
  assert.equal(fomc.availabilityStatus, 'AVAILABLE');
});

test('no backward carry: landing session age is zero on release day', () => {
  const sofr = resolveSeries('US.NYFED.SOFR', '2026-03-02');
  assert.equal(sofr.carryForwardAgeSessions, 0);
});

test('correction after initial release resolves on later session', () => {
  const effr = resolveSeries('US.NYFED.EFFR', '2026-03-05');
  assert.equal(effr.availabilityStatus, 'AVAILABLE');
});
