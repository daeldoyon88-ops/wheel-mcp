# L4B-P — Official market-macro feature publication

This document is explanatory only. Canonical contracts, builders and verifiers
remain the authority.

## Scope and exclusions

L4B-P publishes immutable references to the existing L4B chain:

`I1 ingestion → I2 point-in-time materialization → F1 rates/FOMC/curve → F2
inflation/labor/claims/full state/instrument projection → P publication`.

It does not copy feature rows, fetch data, place orders, score instruments,
rank candidates, recommend trades or integrate with the scanner, dashboard,
Journal POP, Yahoo or IBKR.

## Canonical objects

Four additive snapshot schemas close the publication:

1. `MarketMacroFeatureAuthorityPolicy/1`
2. `MarketMacroFeatureRegistryManifest/1`
3. `MarketMacroFeatureCoverageReport/1`
4. `MarketMacroFeaturePublicationManifest/1`

The snapshot registry grows from 109 to 113 unique schemas. The normalized
namespace remains exactly five schemas.

Implementation identity reuses `TransformImplementationManifest/2`. Four
closed profiles independently identify I1, I2, F1 and F2 from portable logical
module paths and canonical source hashes. No time, hostname, current working
directory, Git state or filesystem metadata participates in an identity.

## Explicit authority closure

Every publication pins the four official IDs from each I1/I2/F1/F2 phase, plus
the market-session registry and instrument-identity registry. The verifier
loads and recomputes every referenced authority. No `latest`, CAS enumeration,
network access or implicit source selection is permitted.

The registry contains the closed ordered families:

- `RATES`
- `FOMC`
- `TREASURY_CURVE`
- `INFLATION`
- `UNEMPLOYMENT`
- `CLAIMS`
- `FULL_MACRO_STATE`
- `INSTRUMENT_PROJECTION`

It stores references only. No score or recommendation family exists.

## Coverage and status

Coverage is derived from verified F1/F2 rows and reports. It includes session,
row and instrument counts; complete/partial/unavailable sessions; per-family
coverage; projection statuses; stale, withdrawn and future-rejected counts;
and ordered session, row, instrument, provenance and publication-entry
digests.

`EMPTY`, `PARTIAL` and `PUBLISHED` are derived from coverage. `WITHDRAWN` and
`DEPRECATED` are explicit history events and require a parent publication plus
a non-empty reason. They preserve every historical object.

## Append-only history and resolver

A child registry references its immediate parent registry. Each of its eight
entries references the exact preceding family-entry identity. A child
publication references its immediate parent publication and the child
registry.

`resolveMarketMacroFeaturePublicationAsOf` accepts only an explicitly pinned
publication manifest and an explicit UTC knowledge cutoff. It walks only the
manifest supersession chain:

- before genesis `availableAt`: `NOT_AVAILABLE`;
- exactly at `availableAt`: the publication is visible;
- before a future withdrawal: the explicit parent is selected;
- at the withdrawal boundary: `WITHDRAWN`;
- resolving an older explicit tip remains prefix-invariant.

The resolver never scans the CAS, selects the last inserted object or compares
content addresses lexically.

## Determinism and validation

Permanent tests cover closed contracts and policy, implementation identity,
official partial publication, empty publication, replay, multi-store,
insertion-order independence, CAS noise, exact as-of boundaries,
supersession/withdrawal, prefix invariance, 101 named corruptions and an
isolated 80-vector oracle. The official fixture pins stable golden IDs only
after the recomputation invariants pass.
