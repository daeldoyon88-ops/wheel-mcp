/**
 * L4C-I2 cutoff contract.
 *
 * publicAvailableAt <= knowledgeCutoff is the causal boundary and equality is
 * inside the visible set. The cutoff itself must be a strict UTC instant: a
 * civil date, an offset-bearing instant, a padded string or the literal
 * "latest" are all refused rather than coerced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEarningsAsOfV1 } from '../src/earnings/resolveEarningsAsOfL4CIIV1.mjs';
import { buildEarningsDatasetBinding } from '../src/earnings/earningsDatasetBindingL4CIIV1.mjs';
import {
  L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT,
  code,
  withL4CI2ThreeFilingFixture,
} from './earningsFiscalL4CIISyntheticFixture.mjs';

const resolveAt = (ctx, knowledgeCutoff) => resolveEarningsAsOfV1({
  store: ctx.store,
  earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
  knowledgeCutoff,
  earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
});

const bindAt = (ctx, knowledgeCutoff) => buildEarningsDatasetBinding({
  store: ctx.store,
  earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
  earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
  earningsFiscalClassificationPolicyId: ctx.earningsFiscalClassificationPolicyId,
  transformImplementationManifestId: ctx.transformImplementationManifestId,
  knowledgeCutoff,
});

/** The middle filing: the 8-K, second of the three publicAvailableAt instants. */
const BOUNDARY = L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.q1EightK;
const ONE_MS_BEFORE = '2026-04-23T20:05:29.999Z';
const ONE_MS_AFTER = '2026-04-23T20:05:30.001Z';

test('I2-C001 rejects an absent knowledgeCutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveEarningsAsOfV1({
      store: ctx.store,
      earningsDatasetSnapshotManifestId: ctx.earningsDatasetSnapshotManifestId,
      earningsAsOfResolutionPolicyId: ctx.earningsAsOfResolutionPolicyId,
    }), code('MARKET_DATA_INPUT_INVALID'));
  });
});

test('I2-C002 rejects an undefined knowledgeCutoff on the binding builder', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => bindAt(ctx, undefined), code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
  });
});

test('I2-C003 rejects a civil date without a time part', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveAt(ctx, '2026-04-23'),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
    assert.throws(() => bindAt(ctx, '2026-04-23'),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
  });
});

test('I2-C004 rejects an offset-bearing instant (+02:00)', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveAt(ctx, '2026-04-23T22:05:30.000+02:00'),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
    assert.throws(() => bindAt(ctx, '2026-04-23T22:05:30.000+02:00'),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
  });
});

test('I2-C005 includes a revision whose publicAvailableAt equals the cutoff exactly', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, BOUNDARY);
    assert.equal(resolution.visibleRevisionCount, 2);
    assert.equal(resolution.latestVisiblePublicAvailableAt, BOUNDARY);
  });
});

test('I2-C006 excludes a revision one millisecond after the cutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, ONE_MS_BEFORE);
    assert.equal(resolution.visibleRevisionCount, 1);
    assert.equal(resolution.latestVisiblePublicAvailableAt,
      L4C_I2_THREE_FILING_PUBLIC_AVAILABLE_AT.fyTenKA);
  });
});

test('I2-C007 includes a revision one millisecond before the cutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    const resolution = resolveAt(ctx, ONE_MS_AFTER);
    assert.equal(resolution.visibleRevisionCount, 2);
    assert.equal(resolution.latestVisiblePublicAvailableAt, BOUNDARY);
    // One millisecond either side of the boundary is the whole difference.
    assert.equal(resolveAt(ctx, ONE_MS_BEFORE).visibleRevisionCount + 1,
      resolution.visibleRevisionCount);
  });
});

test('I2-C008 rejects a non-string cutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    for (const value of [0, 1774300000000, null, {}, ['2026-04-23T20:05:30.000Z']]) {
      assert.throws(() => resolveAt(ctx, value), code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
    }
  });
});

test('I2-C009 rejects a cutoff with a trailing space', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    assert.throws(() => resolveAt(ctx, `${BOUNDARY} `),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
    assert.throws(() => resolveAt(ctx, ` ${BOUNDARY}`),
      code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
  });
});

test('I2-C010 rejects the literal "latest" as a cutoff', () => {
  withL4CI2ThreeFilingFixture((ctx) => {
    for (const value of ['latest', 'LATEST', 'now']) {
      assert.throws(() => resolveAt(ctx, value), code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
      assert.throws(() => bindAt(ctx, value), code('EARNINGS_KNOWLEDGE_CUTOFF_INVALID'));
    }
  });
});
