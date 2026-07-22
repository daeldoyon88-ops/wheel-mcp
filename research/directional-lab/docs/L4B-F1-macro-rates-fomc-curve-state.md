# L4B-F1 Macro Rates, FOMC and Curve State

Non-authoritative overview of the L4B-F1 macro feature layer in the directional lab.

## Scope

L4B-F1 computes per-market-session macro state rows from pinned L4B-I1/I2 authorities:

- `MarketMacroFeatureSourceBundle/1` — session date range + binding pins
- `MarketMacroFeatureComputationPolicy/1` — closed singleton policy
- `MacroStateBySessionRows/1` — causal rows at official session close UTC
- `MarketMacroFeatureComputationReport/1` — recomputed counters and digests

## Session knowledge

Observations resolve **as-of each session's official close UTC**. Future vintages and calendar updates after close are excluded. Carry-forward tracks age in sessions; money-market and treasury families stale after five sessions.

## Rate state

Fed target bounds, midpoint, width, EFFR, SOFR, treasury anchors, policy direction (tightening/easing/unchanged), and rate regimes — all fixed-point scale 6.

## FOMC state

Decision type (hike/cut/hold/range restructure) from target changes and optional FOMC decision series. Calendar tip resolved only from knowledge available at session close.

## Curve state

Six closed spreads, shape (flat/partial inversion/inverted/normal/mixed), and steepening/flattening direction from required 10Y–2Y and 10Y–3M spreads.

## Verification

Builders pin by CAS; verifiers recompute byte-for-byte. `latest` markers and implicit binding are forbidden.
