/**
 * L4B-I1 ingestion policy tests: the closed V1 singleton, series-specific
 * release rules, scope enforcement and permissive-corruption rejection.
 * All fixtures are synthetic and offline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJsonBytes } from '../src/canonical/canonicalJsonV1.mjs';
import {
  MACRO_INGESTION_POLICY_SCHEMA_VERSION,
  MACRO_INGESTION_POLICY_VALUES,
  findMacroReleaseTimeRuleV1,
  normalizeMacroIngestionPolicyV1,
} from '../src/contracts/macroIngestionContractsL4BV1.mjs';
import {
  buildMacroIngestionPolicy,
  verifyMacroIngestionPolicy,
} from '../src/macro/macroIngestionPolicyL4BV1.mjs';
import {
  assertMacroVintageAdmissibleV1,
} from '../src/macro/macroVintageSetL4BV1.mjs';
import {
  code,
  syntheticMacroSeriesIdentity,
  withMacroStore,
  withOfficialMacroL4BI1Fixture,
} from './macroIngestionL4BSyntheticFixture.mjs';

function wirePolicy(overrides = {}) {
  return {
    schemaVersion: MACRO_INGESTION_POLICY_SCHEMA_VERSION,
    ...structuredClone(MACRO_INGESTION_POLICY_VALUES),
    ...overrides,
  };
}

test('the V1 policy builds, verifies and round-trips through the store', () => {
  withMacroStore((store) => {
    const built = buildMacroIngestionPolicy({ store });
    const verified = verifyMacroIngestionPolicy({
      store, macroIngestionPolicyId: built.macroIngestionPolicyId,
    });
    assert.deepEqual(verified.macroIngestionPolicy, built.macroIngestionPolicy);
  });
});

test('the policy pins the closed 13-series V1 scope and nothing else', () => {
  const policy = normalizeMacroIngestionPolicyV1(wirePolicy());
  assert.equal(policy.allowedSeriesCodes.length, 13);
  for (const deferred of ['US.BEA.GDP', 'US.BEA.PCE', 'US.BLS.PAYEMS', 'US.CBOE.VIX']) {
    assert.equal(policy.allowedSeriesCodes.includes(deferred), false);
  }
  assert.deepEqual(policy.revisionSensitiveSeriesCodes,
    ['US.BLS.CPIAUCSL', 'US.BLS.ICSA', 'US.BLS.UNRATE']);
  assert.deepEqual(policy.publicationAttestedSeriesCodes, ['US.FOMC.DECISION']);
});

test('every release rule is series-specific, New-York pinned and time-bounded', () => {
  const policy = normalizeMacroIngestionPolicyV1(wirePolicy());
  assert.equal(policy.releaseTimeRules.length, 13);
  for (const rule of policy.releaseTimeRules) {
    assert.equal(policy.allowedSeriesCodes.includes(rule.canonicalSeriesCode), true);
    assert.equal(rule.timezone, 'AMERICA_NEW_YORK');
    assert.equal(rule.effectiveFrom, '2007-01-01');
    assert.equal(rule.resolutionMode, 'SERIES_AUTHORITY_POLICY');
    assert.match(rule.localTime, /^([01]\d|2[0-3]):[0-5]\d$/);
    assert.notEqual(rule.canonicalSeriesCode, '*');
  }
});

const policyCorruptions = [
  ['unknown source authority admitted', {
    allowedSourceAuthorities: [...MACRO_INGESTION_POLICY_VALUES.allowedSourceAuthorities, 'YAHOO'],
  }],
  ['out-of-scope series admitted', {
    allowedSeriesCodes: [...MACRO_INGESTION_POLICY_VALUES.allowedSeriesCodes, 'US.BEA.GDP'],
  }],
  ['out-of-scope frequency admitted', {
    allowedFrequencies: [...MACRO_INGESTION_POLICY_VALUES.allowedFrequencies, 'QUARTERLY'],
  }],
  ['out-of-scope unit admitted', {
    allowedUnits: [...MACRO_INGESTION_POLICY_VALUES.allowedUnits, 'DOLLARS'],
  }],
  ['wildcard release rule', {
    releaseTimeRules: [...MACRO_INGESTION_POLICY_VALUES.releaseTimeRules, {
      sourceAuthority: 'BLS',
      canonicalSeriesCode: '*',
      localTime: '08:30',
      timezone: 'AMERICA_NEW_YORK',
      effectiveFrom: '2007-01-01',
      effectiveThrough: null,
      resolutionMode: 'SERIES_AUTHORITY_POLICY',
    }],
  }],
  ['generic global 08:30 default', {
    releaseTimeRules: [{
      sourceAuthority: 'DEFAULT_ALL_SERIES',
      canonicalSeriesCode: 'DEFAULT_ALL_SERIES_08_30',
      localTime: '08:30',
      timezone: 'AMERICA_NEW_YORK',
      effectiveFrom: '2007-01-01',
      effectiveThrough: null,
      resolutionMode: 'SERIES_AUTHORITY_POLICY',
    }],
  }],
  ['machine timezone rule', {
    releaseTimeRules: MACRO_INGESTION_POLICY_VALUES.releaseTimeRules.map((rule, index) => (
      index === 0 ? { ...rule, timezone: 'LOCAL_MACHINE' } : rule)),
  }],
  ['rule without validity start', {
    releaseTimeRules: MACRO_INGESTION_POLICY_VALUES.releaseTimeRules.map((rule, index) => (
      index === 0 ? { ...rule, effectiveFrom: null } : rule)),
  }],
  ['unstructured free-text rule', {
    releaseTimeRules: ['BLS releases CPI at 08:30 New York time'],
  }],
  ['latest reference allowed', { latestReferencePolicy: 'ALLOWED' }],
  ['network during computation allowed', { networkDuringComputationPolicy: 'ALLOWED' }],
  ['mutable registry policy', { registryMutationPolicy: 'MUTABLE' }],
  ['permissive conflict policy', { vintageConflictPolicy: 'LAST_WRITE_WINS' }],
  ['permissive cycle policy', { vintageCyclePolicy: 'ALLOWED' }],
  ['permissive duplicate policy', { duplicateObservationPolicy: 'KEEP_BOTH' }],
  ['unknown release time accepted', { unknownReleaseTimePolicy: 'ACCEPT' }],
  ['revision-sensitive protection dropped', { revisionSensitiveSeriesCodes: [] }],
  ['undeclared publication-attested series', {
    publicationAttestedSeriesCodes: ['US.FOMC.DECISION', 'US.NYFED.EFFR'],
  }],
  ['RELEASE_TIME_UNKNOWN admitted', {
    allowedCompletenessClasses: [
      ...MACRO_INGESTION_POLICY_VALUES.allowedCompletenessClasses, 'RELEASE_TIME_UNKNOWN',
    ],
  }],
  ['UNUSABLE_FOR_POINT_IN_TIME admitted', {
    allowedCompletenessClasses: [
      ...MACRO_INGESTION_POLICY_VALUES.allowedCompletenessClasses, 'UNUSABLE_FOR_POINT_IN_TIME',
    ],
  }],
  ['forged policy version', { policyVersion: 'MACRO_INGESTION_L4B_I1_V2' }],
  ['foreign jurisdiction', { jurisdictionCode: 'CANADA' }],
  ['foreign currency', { currencyCode: 'CAD' }],
];

for (const [label, overrides] of policyCorruptions) {
  test(`policy corruption is refused: ${label}`, () => {
    assert.throws(() => normalizeMacroIngestionPolicyV1(wirePolicy(overrides)),
      code('MARKET_DATA_MACRO_POLICY_INVALID'));
  });
}

test('overlapping contradictory release rules are refused at lookup', () => {
  const policy = normalizeMacroIngestionPolicyV1(wirePolicy());
  const overlapping = {
    ...policy,
    releaseTimeRules: [
      ...policy.releaseTimeRules,
      { ...policy.releaseTimeRules[0], localTime: '09:30' },
    ],
  };
  assert.throws(() => findMacroReleaseTimeRuleV1(overlapping, 'BLS', 'US.BLS.CPIAUCSL', '2026-01-13'),
    code('MARKET_DATA_MACRO_POLICY_INVALID'));
});

test('rule lookup respects the validity window and yields null outside it', () => {
  const policy = normalizeMacroIngestionPolicyV1(wirePolicy());
  assert.notEqual(findMacroReleaseTimeRuleV1(policy, 'BLS', 'US.BLS.CPIAUCSL', '2026-01-13'), null);
  assert.equal(findMacroReleaseTimeRuleV1(policy, 'BLS', 'US.BLS.CPIAUCSL', '2006-12-31'), null);
  assert.equal(findMacroReleaseTimeRuleV1(policy, 'BLS', 'US.BEA.GDP', '2026-01-13'), null);
  assert.equal(findMacroReleaseTimeRuleV1(policy, 'FRB', 'US.BLS.CPIAUCSL', '2026-01-13'), null);
});

test('a series outside the closed scope is refused at admission', () => {
  withOfficialMacroL4BI1Fixture(({ policy, vintages, observations, series }) => {
    const outOfScope = {
      ...series['US.NYFED.EFFR'].macroSeriesIdentity,
      canonicalSeriesCode: 'US.BEA.GDP',
    };
    assert.throws(() => assertMacroVintageAdmissibleV1(policy, outOfScope,
      observations.effr.observationIdentity, vintages.effrInitial.observationVintage),
    code('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE'));
  });
});

test('a TEST_FIXTURE authority is storable in a registry but not admissible', () => {
  withOfficialMacroL4BI1Fixture(({ policy, vintages, observations }) => {
    const fixtureSeries = syntheticMacroSeriesIdentity('US.NYFED.EFFR', {
      sourceAuthority: 'TEST_FIXTURE', releaseAuthority: 'TEST_FIXTURE',
    });
    assert.throws(() => assertMacroVintageAdmissibleV1(policy, fixtureSeries,
      observations.effr.observationIdentity, vintages.effrInitial.observationVintage),
    code('MARKET_DATA_MACRO_SERIES_NOT_IN_SCOPE'));
  });
});

test('FINAL_ONLY for a revision-sensitive series (CPI) is refused', () => {
  withOfficialMacroL4BI1Fixture(({ policy, series, observations, vintages }) => {
    const forged = {
      ...vintages.cpiInitial.observationVintage,
      vintageCompletenessClass: 'FINAL_ONLY',
    };
    assert.throws(() => assertMacroVintageAdmissibleV1(policy,
      series['US.BLS.CPIAUCSL'].macroSeriesIdentity,
      observations.cpi.observationIdentity, forged),
    code('MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN'));
  });
});

test('PUBLICATION_ATTESTED outside the declared list is refused', () => {
  withOfficialMacroL4BI1Fixture(({ policy, series, observations, vintages }) => {
    const forged = {
      ...vintages.effrInitial.observationVintage,
      vintageCompletenessClass: 'PUBLICATION_ATTESTED',
    };
    assert.throws(() => assertMacroVintageAdmissibleV1(policy,
      series['US.NYFED.EFFR'].macroSeriesIdentity,
      observations.effr.observationIdentity, forged),
    code('MARKET_DATA_MACRO_COMPLETENESS_FORBIDDEN'));
  });
});

test('a fixed-point scale incompatible with the series unit is refused', () => {
  withOfficialMacroL4BI1Fixture(({ policy, series, observations, vintages }) => {
    const forged = {
      ...vintages.icsaInitial.observationVintage,
      value: { atoms: '2140005', scale: 1 },
    };
    assert.throws(() => assertMacroVintageAdmissibleV1(policy,
      series['US.BLS.ICSA'].macroSeriesIdentity,
      observations.icsa.observationIdentity, forged),
    code('MARKET_DATA_MACRO_UNIT_MISMATCH'));
  });
});

test('the derived policy runtime is byte-identical across two stores', () => {
  const build = () => withMacroStore((store) => {
    const built = buildMacroIngestionPolicy({ store });
    return {
      id: built.macroIngestionPolicyId,
      bytes: canonicalJsonBytes(built.macroIngestionPolicy).toString('hex'),
    };
  });
  assert.deepEqual(build(), build());
});

test('a stored policy diverging from the closed singleton is refused at verification', () => {
  withMacroStore((store) => {
    const built = buildMacroIngestionPolicy({ store });
    assert.throws(() => verifyMacroIngestionPolicy({
      store, macroIngestionPolicyId: `sha256:${'a'.repeat(64)}`,
    }), code('MARKET_DATA_REFERENCE_MISSING'));
    assert.throws(() => verifyMacroIngestionPolicy({
      store, macroIngestionPolicyId: 'latest',
    }), code('MARKET_DATA_MACRO_LATEST_FORBIDDEN'));
    void built;
  });
});
