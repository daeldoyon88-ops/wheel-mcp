# L4A-C2 — Market Seasonality Feature Computation Report

Closed report + full verifier for seasonality features. **No C3 publication** in this slice.

## Report schema

`MarketSeasonalityFeatureComputationReport/1` (`MARKET_SEASONALITY_FEATURE_COMPUTATION_REPORT_SCHEMA_VERSION`).

Family: `MARKET_SEASONALITY_FEATURE_L4A_C2/1`. Configured horizon×forward pairs: **20**.

Closed fields include: source/policy/rows IDs, binding/identity/normalized pins, knowledgeCutoff, price basis, corporate-action treatment, `featureFamilyVersion`, `implementationManifestId`, `rowCount`, `firstSessionDate` / `lastSessionDate`, `configuredHorizonWindowPairCount`, `countsByHorizon` / `countsByForwardSessionCount` (each bucket: `rowPresenceCount`, `occurrenceCountSum`, `distinctOccurrenceCount`), availability / primary-reason / rejected / current-window status counts, partial/completed current-window totals, `distinctOccurrenceCount`, `distinctHistoricalYearCount`, `emptySnapshot`, `orderedRowIdentityDigest`.

## APIs

| Surface | Function |
| --- | --- |
| Rows only (C1) | `computeMarketSeasonalityFeatureRows` |
| Rows + report (C2) | `computeMarketSeasonalityFeatures` |
| Full verify | `verifyMarketSeasonalityFeatureComputation` |
| Report derive | `deriveMarketSeasonalityFeatureComputationReportValueV1` |
| Digest | `computeSeasonalityOrderedRowIdentityDigestV1` |

## Verifier sequence

1. Load + normalize stored report by `seasonalityFeatureComputationReportId`.
2. Re-verify source bundle + policy; recompute rows + occurrence unions from pinned authorities.
3. Compare stored rows to recomputed document → `MARKET_DATA_SEASONALITY_ROWS_MISMATCH` on divergence.
4. Re-derive expected report from recomputed artifacts; compare bytes → `MARKET_DATA_SEASONALITY_REPORT_MISMATCH`.
5. Contract gate on normalize → `MARKET_DATA_SEASONALITY_REPORT_INVALID`.

## Ordered row identity digest

`sha256:` + SHA-256 of CanonicalJSON(`[ { sessionDate, subjectBarIdentityId }, ... ]`) in stored row order. Non-identity fields (stats, reasons) do not affect the digest. Order swaps do.

## Anti-double-count

Nested horizons share historical occurrences. Report `distinctOccurrenceCount` comes from occurrence **unions**, never from Σ `occurrenceCount` / `occurrenceCountSum` across horizons. Always:

`distinctOccurrenceCount ≤ Σ countsByHorizon[*].occurrenceCountSum`

(and typically strict `<` when history exists).

## Empty snapshot

Empty OHLCV official bindings (via `withOfficialVolumeStructureBinding([])`) produce:

- seasonality rows `[]`
- `rowCount = 0`, dates `null`, `emptySnapshot = true`
- all counters zero / closed empty maps
- deterministic empty `orderedRowIdentityDigest`
- full `verifyMarketSeasonalityFeatureComputation` PASS, replay, and multi-store byte identity

## C1 golden stability

With the C1 implementation-manifest shape, rows-only and C2 paths share the same rows CAS id on the official L3-I6 fixture. C2 adds a separate report object; it must not mutate row bytes.

## Out of scope (C3)

No feature publication manifest, no tip registry, no “latest” publication surface.
