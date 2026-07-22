/**
 * L4B-I1 observation identity tests: closed period conventions per frequency,
 * strict series matching and identity stability. All fixtures are synthetic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
  assertMacroObservationPeriodShapeV1,
  macroObservationIdentityIdFor,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import { buildMacroSeriesIdentityCore } from '../src/macro/macroSeriesRegistryL4BV1.mjs';
import {
  buildMacroObservationIdentityCore as buildObservation,
  verifyMacroObservationIdentityCore,
} from '../src/macro/macroObservationVintageL4BV1.mjs';
import {
  code,
  syntheticMacroSeriesIdentity,
  withMacroStore,
} from './macroIngestionL4BSyntheticFixture.mjs';

function observationWire(series, overrides = {}) {
  return {
    schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
    macroSeriesIdentityId: series.macroSeriesIdentityId,
    unit: series.macroSeriesIdentity.units,
    seasonalAdjustment: series.macroSeriesIdentity.seasonalAdjustment,
    ...overrides,
  };
}

function withSeries(codeName, fn) {
  return withMacroStore((store) => {
    const series = buildMacroSeriesIdentityCore({
      store, identity: syntheticMacroSeriesIdentity(codeName),
    });
    return fn(store, series);
  });
}

test('DAILY observation pins exactly one civil date', () => {
  withSeries('US.NYFED.EFFR', (store, series) => {
    const built = buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
      }),
    });
    const verified = verifyMacroObservationIdentityCore({
      store, observationIdentityId: built.observationIdentityId,
    });
    assert.deepEqual(verified.observationIdentity, built.observationIdentity);
  });
});

test('DAILY observation with a multi-day period is refused', () => {
  withSeries('US.NYFED.EFFR', (store, series) => {
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-06',
        referencePeriod: '2026-01-05',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  });
});

test('WEEKLY observation pins a seven-day period keyed by its end date', () => {
  withSeries('US.BLS.ICSA', (store, series) => {
    const built = buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-04',
        observationPeriodEnd: '2026-01-10',
        referencePeriod: '2026-01-10',
      }),
    });
    assert.match(built.observationIdentityId, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-04',
        observationPeriodEnd: '2026-01-09',
        referencePeriod: '2026-01-09',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  });
});

test('MONTHLY observation pins one calendar month keyed YYYY-MM', () => {
  withSeries('US.BLS.CPIAUCSL', (store, series) => {
    const built = buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2025-12-01',
        observationPeriodEnd: '2025-12-31',
        referencePeriod: '2025-12',
      }),
    });
    assert.match(built.observationIdentityId, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2025-12-01',
        observationPeriodEnd: '2025-12-30',
        referencePeriod: '2025-12',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  });
});

test('EVENT observation pins exactly one civil date', () => {
  withSeries('US.FOMC.DECISION', (store, series) => {
    const built = buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-28',
        observationPeriodEnd: '2026-01-28',
        referencePeriod: '2026-01-28',
      }),
    });
    assert.match(built.observationIdentityId, /^sha256:[0-9a-f]{64}$/);
  });
});

test('period shape helper closes every frequency convention', () => {
  assert.throws(() => assertMacroObservationPeriodShapeV1(
    'MONTHLY', '2025-12-02', '2025-12-31', '2025-12'),
  code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  assert.throws(() => assertMacroObservationPeriodShapeV1(
    'WEEKLY', '2026-01-04', '2026-01-10', '2026-01-04'),
  code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  assert.throws(() => assertMacroObservationPeriodShapeV1(
    'QUARTERLY', '2026-01-01', '2026-03-31', '2026-03'),
  code('MARKET_DATA_MACRO_FREQUENCY_MISMATCH'));
});

test('observation referencing an absent series is refused', () => {
  withMacroStore((store) => {
    assert.throws(() => buildObservation({
      store,
      identity: {
        schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
        macroSeriesIdentityId: `sha256:${'a'.repeat(64)}`,
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
        unit: 'PERCENT',
        seasonalAdjustment: 'NOT_APPLICABLE',
      },
    }), code('MARKET_DATA_REFERENCE_MISSING'));
  });
});

test('unit diverging from the pinned series is refused', () => {
  withSeries('US.NYFED.EFFR', (store, series) => {
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
        unit: 'INDEX',
      }),
    }), code('MARKET_DATA_MACRO_UNIT_MISMATCH'));
  });
});

test('seasonal adjustment diverging from the pinned series is refused', () => {
  withSeries('US.BLS.CPIAUCSL', (store, series) => {
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2025-12-01',
        observationPeriodEnd: '2025-12-31',
        referencePeriod: '2025-12',
        seasonalAdjustment: 'NOT_SEASONALLY_ADJUSTED',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_SERIES_MISMATCH'));
  });
});

test('period incompatible with the series frequency is refused', () => {
  withSeries('US.BLS.CPIAUCSL', (store, series) => {
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2025-12-01',
        observationPeriodEnd: '2025-12-01',
        referencePeriod: '2025-12-01',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_PERIOD_INVALID'));
  });
});

test('the same logical observation always reproduces the same observationIdentityId', () => {
  const build = () => withSeries('US.TREAS.DGS10', (store, series) => buildObservation({
    store,
    identity: observationWire(series, {
      observationPeriodStart: '2026-01-05',
      observationPeriodEnd: '2026-01-05',
      referencePeriod: '2026-01-05',
    }),
  }).observationIdentityId);
  assert.equal(build(), build());
});

test('display metadata cannot leak into the observation identity', () => {
  withSeries('US.TREAS.DGS10', (store, series) => {
    assert.throws(() => buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2026-01-05',
        observationPeriodEnd: '2026-01-05',
        referencePeriod: '2026-01-05',
        title: 'synthetic display title',
      }),
    }), code('MARKET_DATA_MACRO_OBSERVATION_IDENTITY_INVALID'));
  });
});

test('a methodology change produces a different series and a different observation identity', () => {
  const idFor = (methodologySuffix) => withMacroStore((store) => {
    const series = buildMacroSeriesIdentityCore({
      store,
      identity: syntheticMacroSeriesIdentity('US.BLS.CPIAUCSL', {
        methodologyVersionId: `sha256:${methodologySuffix.repeat(64)}`,
      }),
    });
    return buildObservation({
      store,
      identity: observationWire(series, {
        observationPeriodStart: '2025-12-01',
        observationPeriodEnd: '2025-12-31',
        referencePeriod: '2025-12',
      }),
    }).observationIdentityId;
  });
  assert.notEqual(idFor('a'), idFor('b'));
});

test('macroObservationIdentityIdFor is a pure deterministic projection', () => {
  const wire = {
    schemaVersion: MACRO_OBSERVATION_IDENTITY_CORE_SCHEMA_VERSION,
    macroSeriesIdentityId: `sha256:${'a'.repeat(64)}`,
    observationPeriodStart: '2026-01-05',
    observationPeriodEnd: '2026-01-05',
    referencePeriod: '2026-01-05',
    unit: 'PERCENT',
    seasonalAdjustment: 'NOT_APPLICABLE',
  };
  assert.equal(macroObservationIdentityIdFor(wire), macroObservationIdentityIdFor({ ...wire }));
});
