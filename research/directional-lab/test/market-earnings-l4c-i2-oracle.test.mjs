/**
 * L4C-I2 executable oracles.
 *
 * Every expected value in this file comes from the independent oracle helper or
 * from a literal declared in the authority bundle - never from the production
 * builder under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INDEPENDENT_DIGEST_DOMAINS,
  INDEPENDENT_FINGERPRINT_DOMAIN,
  INDEPENDENT_ORACLE_VECTORS,
  INDEPENDENT_ORACLE_VECTOR_COUNT,
  INDEPENDENT_ORDERED_ID_SAMPLE,
  independentCanonicalObjectIdV1,
  independentDiagnosticDigestV1,
  independentDomainDigestV1,
  independentFunctionalFingerprintV1,
  verifyIndependentOracleVectorsV1,
  exerciseAllIndependentOracleVectorsSemanticallyV1,
} from './helpers/independentEarningsAsOfOracleL4CIIV1.mjs';
import {
  EARNINGS_AS_OF_MATERIALIZATION_FUNCTIONAL_FINGERPRINT_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN,
  EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN,
  earningsAsOfMaterializationFunctionalFingerprintV1,
  recomputeCanonicalDigestV1,
} from '../src/earnings/earningsAsOfMaterializationL4CIIV1.mjs';
import { earningsFiscalClassificationDiagnosticDigestV1 } from '../src/contracts/earningsContractsL4CIIV1.mjs';
import {
  materializeL4CI2Dataset,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const ORACLE_PATH = fileURLToPath(
  new URL('./helpers/independentEarningsAsOfOracleL4CIIV1.mjs', import.meta.url));
const ORACLE_SOURCE = readFileSync(ORACLE_PATH, 'utf8');

/** The production digest domains, in the same K6 field order as the oracle's. */
const PRODUCTION_DIGEST_DOMAINS = [
  EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN,
  EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN,
  EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN,
];

const importSpecifiers = () =>
  [...ORACLE_SOURCE.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gmu)].map((match) => match[1]);

test('I2-O001 the oracle module imports no production module', () => {
  for (const specifier of importSpecifiers()) {
    assert.equal(specifier.startsWith('.'), false, specifier);
    assert.equal(specifier.includes('src/'), false, specifier);
  }
  assert.equal(ORACLE_SOURCE.includes('canonicalJsonV1'), false);
  assert.equal(ORACLE_SOURCE.includes('earningsContractsL4CIIV1'), false);
  assert.equal(ORACLE_SOURCE.includes('earningsAsOfMaterializationL4CIIV1'), false);
});

test('I2-O002 the oracle module imports only node:crypto', () => {
  assert.deepEqual(importSpecifiers(), ['node:crypto']);
});

test('I2-O003 the oracle reproduces the seven empty-domain digests', () => {
  for (const domain of PRODUCTION_DIGEST_DOMAINS) {
    assert.equal(recomputeCanonicalDigestV1(domain, []),
      independentDomainDigestV1(domain, []), domain);
  }
  assert.equal(earningsFiscalClassificationDiagnosticDigestV1([]),
    independentDiagnosticDigestV1([]));
  assert.equal(INDEPENDENT_DIGEST_DOMAINS.length, 7);
});

test('I2-O004 the oracle reproduces the seven non-empty digests', () => {
  const hexTokens = [...INDEPENDENT_ORDERED_ID_SAMPLE];
  const ids = hexTokens.map((token) => `sha256:${token}`);
  for (const id of ids) {
    assert.match(id, /^sha256:[0-9a-f]{64}$/);
    assert.equal(id.startsWith('sha256:sha256:'), false);
  }
  for (const domain of PRODUCTION_DIGEST_DOMAINS) {
    assert.equal(recomputeCanonicalDigestV1(domain, ids),
      independentDomainDigestV1(domain, ids), domain);
  }
  // D-01 tokens are sha256:<64 lowercase hex> or NONE — never a double prefix.
  const diagnostics = [
    { code: 'EARNINGS_FISCAL_ROLE_UNDETERMINED', rawPeriodIdToken: ids[0] },
    { code: 'EARNINGS_FISCAL_CLASSIFICATION_AMBIGUOUS', rawPeriodIdToken: ids[1] },
  ];
  assert.equal(earningsFiscalClassificationDiagnosticDigestV1(diagnostics),
    independentDiagnosticDigestV1(diagnostics));

  // Negative D-01 token forms must reject. Canonical-form failures use
  // EARNINGS_FISCAL_REPORT_INVALID; embedded CR/LF/NUL may be refused earlier by
  // the shared input guard (MARKET_DATA_INPUT_INVALID) — both close the reject.
  const rejectToken = (rawPeriodIdToken, allowedCodes = ['EARNINGS_FISCAL_REPORT_INVALID']) => {
    assert.throws(() => earningsFiscalClassificationDiagnosticDigestV1([
      { code: 'EARNINGS_FISCAL_ROLE_UNDETERMINED', rawPeriodIdToken },
    ]), (error) => allowedCodes.includes(error.code));
  };
  rejectToken(`sha256:${ids[0]}`); // double prefix
  rejectToken(`sha256:${'a'.repeat(64).toUpperCase()}`); // uppercase hex
  rejectToken(`sha256:${hexTokens[0].slice(0, 63)}`); // short
  rejectToken(`sha256:${hexTokens[0]}\0`,
    ['EARNINGS_FISCAL_REPORT_INVALID', 'MARKET_DATA_INPUT_INVALID']); // NUL
  rejectToken(`sha256:${hexTokens[0]}\r`,
    ['EARNINGS_FISCAL_REPORT_INVALID', 'MARKET_DATA_INPUT_INVALID']); // CR
  rejectToken(`sha256:${hexTokens[0]}\n`,
    ['EARNINGS_FISCAL_REPORT_INVALID', 'MARKET_DATA_INPUT_INVALID']); // LF
  assert.throws(() => earningsFiscalClassificationDiagnosticDigestV1([
    { code: 'EARNINGS_FISCAL_ROLE_UNDETERMINED', rawPeriodIdToken: ids[0] },
    { code: 'EARNINGS_FISCAL_ROLE_UNDETERMINED', rawPeriodIdToken: ids[0] },
  ]), (error) => error.code === 'EARNINGS_FISCAL_REPORT_INVALID'); // duplicate tuple
  // NONE remains a valid sentinel.
  assert.match(earningsFiscalClassificationDiagnosticDigestV1([
    { code: 'EARNINGS_FISCAL_METADATA_ABSENT', rawPeriodIdToken: 'NONE' },
  ]), /^sha256:[0-9a-f]{64}$/);
});

test('I2-O005 the oracle reproduces the functional fingerprint preimage', () => {
  assert.equal(EARNINGS_AS_OF_MATERIALIZATION_FUNCTIONAL_FINGERPRINT_DOMAIN,
    INDEPENDENT_FINGERPRINT_DOMAIN);
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    assert.equal(earningsAsOfMaterializationFunctionalFingerprintV1(report),
      independentFunctionalFingerprintV1(report));
  });
});

test('I2-O006 the oracle reproduces the diagnostic digest preimage', () => {
  const tokenA = `sha256:${'a'.repeat(64)}`;
  const tokenB = `sha256:${'b'.repeat(64)}`;
  const entries = [
    { code: 'EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS', rawPeriodIdToken: tokenB },
    { code: 'EARNINGS_FISCAL_Q4_MULTI_DURATION_AMBIGUOUS', rawPeriodIdToken: tokenA },
  ];
  assert.equal(earningsFiscalClassificationDiagnosticDigestV1(entries),
    independentDiagnosticDigestV1(entries));
  // The digest is order-free: the preimage sorts on token then code.
  assert.equal(earningsFiscalClassificationDiagnosticDigestV1([...entries].reverse()),
    independentDiagnosticDigestV1(entries));
});

test('I2-O007 the oracle reproduces the classification core id preimage', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    assert.ok(report.orderedFiscalClassificationIds.length > 0);
    for (const objectId of report.orderedFiscalClassificationIds) {
      const value = ctx.store.readCanonicalObject({
        uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
        expectedObjectId: objectId,
        schemaVersion: 'EarningsFiscalPeriodClassificationCore/1',
      }).value;
      assert.equal(independentCanonicalObjectIdV1(value), objectId);
    }
  });
});

test('I2-O008 the oracle reproduces the classification report id preimage', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    assert.ok(report.orderedFiscalClassificationReportIds.length > 0);
    for (const objectId of report.orderedFiscalClassificationReportIds) {
      const value = ctx.store.readCanonicalObject({
        uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
        expectedObjectId: objectId,
        schemaVersion: 'EarningsFiscalClassificationReport/1',
      }).value;
      assert.equal(independentCanonicalObjectIdV1(value), objectId);
    }
  });
});

test('I2-O009 the oracle reproduces the binding id preimage', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { binding } = materializeL4CI2Dataset(ctx.store, ctx);
    assert.equal(independentCanonicalObjectIdV1(binding.earningsDatasetBinding),
      binding.earningsDatasetBindingId);
  });
});

test('I2-O010 the oracle reproduces the materialization report id preimage', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    assert.equal(
      independentCanonicalObjectIdV1(materialization.earningsAsOfMaterializationReport),
      materialization.earningsAsOfMaterializationReportId);
  });
});

test('I2-O011 production digests equal the oracle digests on the official fixture', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const pairs = [
      [EARNINGS_AS_OF_VISIBLE_EVENT_DIGEST_DOMAIN, report.orderedVisibleEventIdentityIds,
        report.orderedVisibleEventIdentityDigest],
      [EARNINGS_AS_OF_VISIBLE_REVISION_DIGEST_DOMAIN, report.orderedVisibleRevisionIdentityIds,
        report.orderedVisibleRevisionIdentityDigest],
      [EARNINGS_AS_OF_VISIBLE_EXTRACTION_REPORT_DIGEST_DOMAIN,
        report.orderedVisibleExtractionReportIds, report.orderedVisibleExtractionReportDigest],
      [EARNINGS_AS_OF_VISIBLE_OBSERVATION_DIGEST_DOMAIN,
        report.orderedVisibleMetricObservationIds, report.orderedVisibleMetricObservationDigest],
      [EARNINGS_AS_OF_VISIBLE_RAW_PERIOD_DIGEST_DOMAIN, report.orderedVisibleRawPeriodIds,
        report.orderedVisibleRawPeriodDigest],
      [EARNINGS_FISCAL_CLASSIFICATION_DIGEST_DOMAIN, report.orderedFiscalClassificationIds,
        report.orderedFiscalClassificationDigest],
    ];
    for (const [domain, ids, stored] of pairs) {
      assert.equal(stored, independentDomainDigestV1(domain, ids), domain);
    }
    assert.equal(report.orderedClassificationDiagnosticDigest,
      independentDiagnosticDigestV1(materialization.classificationDiagnostics));
    assert.equal(report.materializationFunctionalFingerprint,
      independentFunctionalFingerprintV1(report));
  });
});

test('I2-O012 production ids equal the oracle ids on the official fixture', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const { binding, materialization } = materializeL4CI2Dataset(ctx.store, ctx);
    const report = materialization.earningsAsOfMaterializationReport;
    const declared = [
      ...report.orderedFiscalClassificationIds,
      ...report.orderedFiscalClassificationReportIds,
      binding.earningsDatasetBindingId,
      materialization.earningsAsOfMaterializationReportId,
    ];
    assert.equal(new Set(declared).size, declared.length);
    for (const objectId of declared) {
      const bytes = ctx.store.readObject({
        uri: ctx.store.uriForObject({ namespace: 'snapshots', objectId }),
        expectedObjectId: objectId,
      }).bytes;
      const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
      assert.equal(independentCanonicalObjectIdV1(value), objectId);
    }
  });
});

test('I2-O013 every declared oracle vector is exercised at least once', () => {
  const integrity = verifyIndependentOracleVectorsV1();
  assert.equal(integrity.length, INDEPENDENT_ORACLE_VECTORS.length);
  assert.deepEqual(integrity.filter((result) => !result.match), []);

  const semantic = exerciseAllIndependentOracleVectorsSemanticallyV1();
  assert.equal(semantic.length, INDEPENDENT_ORACLE_VECTORS.length);
  const withoutSemantic = semantic.filter((row) => row.status !== 'PASS');
  const onlySelfHashed = semantic.filter((row) =>
    row.semanticExercise === 'UNHANDLED_DOMAIN' || row.independentFunction === null);
  assert.equal(withoutSemantic.length, 0, JSON.stringify(withoutSemantic.slice(0, 5)));
  assert.equal(onlySelfHashed.length, 0);
  for (const [index, row] of semantic.entries()) {
    assert.equal(row.vectorId, INDEPENDENT_ORACLE_VECTORS[index].vectorId);
    assert.equal(row.integrityMatch, true);
    assert.equal(typeof row.independentFunction, 'string');
    assert.equal(typeof row.productionComparable, 'string');
    assert.match(row.actualDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('I2-O014 the oracle vector count equals the declared inventory size', () => {
  assert.equal(INDEPENDENT_ORACLE_VECTORS.length, INDEPENDENT_ORACLE_VECTOR_COUNT);
  assert.equal(INDEPENDENT_ORACLE_VECTOR_COUNT, 44);
  assert.equal(new Set(INDEPENDENT_ORACLE_VECTORS.map((v) => v.vectorId)).size, 44);
});
