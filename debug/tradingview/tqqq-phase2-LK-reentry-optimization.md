# Phase 2 — Optimisation sorties L/K + réentrées — Stratégie Pine TQQQ

_Généré le 2026-06-05T23:28:21.467Z. Moteur local validé (réconcilié 22/22 vs TradingView). Style swing CELI._

> ⚠️ **Aucune modification du script Pine.** Backtest/audit seulement. Snippet fourni uniquement pour la meilleure variante (à valider toi-même dans TradingView).

## Référence

| Stratégie | P&L (local) | P&L (TV) | Max DD (local) | Max DD (TV) | Trades (local/TV) | Crise 2026 (local) |
|---|---|---|---|---|---|---|
| Baseline | 4386.81 % | ~3894 % | -42.36 % | ~-35.94 % | 22/21 | -27.0 % |
| L10 (actuel) | 2185.89 % | ~2372 % | -37.99 % | ~-27.45 % | 22/22 | -16.9 % |
| K1 (actuel) | 1389.17 % | ~1402 % | -41.44 % | ~-23.8 % | 31/31 | -7.7 % |

_Note : le P&L local est un peu plus haut que TV (valorisation de la position ouverte + calcul DD close-to-close). Les **écarts relatifs** entre variantes sont fiables — c'est ce qui compte ici._

## Contraintes appliquées
- Max trades = 60 ; idéal ≤ 45
- DD global < baseline (-42.36 %) ; DD crise 2026 < baseline (-27.0 %)
- P&L le plus proche possible du baseline ; rester swing

## Top 20 variantes (classées : contraintes respectées d'abord, puis score)

Score = 0.5·(P&L/baseline) + 0.3·(amélioration DD) + 0.2·(amélioration crise).

| # | Variante | P&L % | Max DD % | Crise 2026 % | Trades | PF | Expo % | Réentrées | Score | Contraintes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | L5+R2 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 2 | L5+R4 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 3 | L5+R6 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 4 | L7+R2 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 5 | L7+R4 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 6 | L7+R6 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 7 | L10+R2 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 8 | L10+R4 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 9 | L10+R6 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 10 | L15+R2 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 11 | L15+R4 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 12 | L15+R6 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 13 | L20+R2 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 14 | L20+R4 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 15 | L20+R6 | 4371 | -37.99 | -16.9 | 23 | 5.93 | 23.88 | 1 | 0.603 | ✅ |
| 16 | L5+R1 | 4277.91 | -37.99 | -16.9 | 23 | 5.83 | 23.81 | 1 | 0.593 | ✅ |
| 17 | L5+R3 | 4277.91 | -37.99 | -16.9 | 23 | 5.83 | 23.81 | 1 | 0.593 | ✅ |
| 18 | L5+R5 | 4277.91 | -37.99 | -16.9 | 23 | 5.83 | 23.81 | 1 | 0.593 | ✅ |
| 19 | L7+R1 | 4277.91 | -37.99 | -16.9 | 23 | 5.83 | 23.81 | 1 | 0.593 | ✅ |
| 20 | L7+R3 | 4277.91 | -37.99 | -16.9 | 23 | 5.83 | 23.81 | 1 | 0.593 | ✅ |

> 🔎 **Pourquoi 15 lignes identiques ?** Le lookback N de L (5/7/10/15/20) **ne change rien** : L ne se déclenche qu'une fois sur tout l'historique (le trade ouvert de 2026), donc tous les N donnent le même trade. Seul le **groupe de réentrée** distingue : R2/R4/R6 → 4371 % ; R1/R3/R5 → 4278 %. Les variantes K (toutes plus bas en P&L) sont hors top 20 — voir détail dans le `.json`.

## Walk-forward (robustesse, sous-périodes)

Rétention rendement = moyenne (P&L variante / P&L baseline) sur les sous-périodes.
Dégât marché haussier = perte moyenne de rendement sur 2020-2021 & 2022-2023 (0 % = aucun effet parasite).
Protection crise = réduction moyenne du DD de crise (pts). Inflation trades = trades ajoutés vs baseline (somme sous-périodes).

| Variante | Rétention rendement | Dégât marché haussier | Protection crise | Inflation trades |
|---|---|---|---|---|
| L10 | 66 % | 0 % | 10 pts | +1 |
| K1 | 51 % | 26 % | 19.3 pts | +22 |
| L5+R2 | 98 % | 0 % | 10 pts | +4 |
| L5+R4 | 100 % | 0 % | 10 pts | +4 |
| L5+R6 | 98 % | 0 % | 10 pts | +4 |
| L7+R2 | 98 % | 0 % | 10 pts | +4 |
| L7+R4 | 100 % | 0 % | 10 pts | +4 |
| L7+R6 | 98 % | 0 % | 10 pts | +4 |
| L10+R2 | 98 % | 0 % | 10 pts | +4 |
| L10+R4 | 100 % | 0 % | 10 pts | +4 |

### Détail par période (P&L % / DD % / trades)

| Variante | 2020-2021 | 2022-2023 | 2024-2026 | 2021-2026 | 2022-2026 | 2020-2026 |
|---|---|---|---|---|---|---|
| baseline | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 417.15 / -42.32 / 11 | 1516 / -42.36 / 19 | 1106.96 / -42.35 / 14 | 4386.81 / -42.36 / 22 |
| L10 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 163.71 / -34.44 / 11 | 665.58 / -34.47 / 20 | 515.04 / -34.46 / 14 | 2185.89 / -37.99 / 22 |
| K1 | 228.64 / -41.44 / 13 | 101.68 / -25.27 / 5 | 154.51 / -25.08 / 14 | 477.84 / -25.27 / 28 | 420.22 / -25.27 / 18 | 1389.17 / -41.44 / 31 |
| L5+R2 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1397.12 / -34.47 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L5+R4 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1501.03 / -34.46 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L5+R6 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1397.12 / -34.47 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L7+R2 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1397.12 / -34.47 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L7+R4 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1501.03 / -34.46 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L7+R6 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1397.12 / -34.47 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L10+R2 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1397.12 / -34.47 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |
| L10+R4 | 326.76 / -37.99 / 8 | 130.33 / -19.91 / 4 | 415.82 / -34.44 / 12 | 1501.03 / -34.46 / 21 | 1102.75 / -34.46 / 15 | 4371 / -37.99 / 23 |

## Comparaison directe baseline vs L10 vs K1 vs recommandée

| Métrique | Baseline | L10 | K1 | L10+R4 (reco) |
|---|---|---|---|---|
| P&L % | 4386.81 | 2185.89 | 1389.17 | 4371 |
| Max DD % | -42.36 | -37.99 | -41.44 | -37.99 |
| Crise 2026 % | -27.0 | -16.9 | -7.7 | -16.9 |
| Trades | 22 | 22 | 31 | 23 |
| PF | 11.46 | 3.47 | 3.48 | 5.93 |

## Recommandation finale

**L10+R4** — Sortie L avec plus-bas 10 jours + réentrée R4.

- P&L 4371 % (vs baseline 4386.81 %, soit **100 % conservé**) · Max DD -37.99 % (vs -42.36 %) · Crise 2026 -16.9 % (vs -27.0 %) · 23 trades · PF 5.93.
- Robustesse : rétention rendement 100 %, dégât marché haussier 0 %, protection crise 10 pts, inflation trades +4.
- Reste **swing** (23 ≤ 45) et **ne récupère le P&L que la réentrée a permis** : L seul tombait à 2185.89 %, la réentrée le ramène à 4371 %.

### ⚠️ Honnêteté sur la portée (important)
- **Le lookback N de L (5→20) n'a AUCUN effet** sur ces données : la sortie L ne se déclenche, sur 2020-2026, **que sur le trade ouvert de 2026**. Partout ailleurs le baseline sort déjà correctement (EMA8↓EMA24). On garde donc **N=10** par convention (déjà testé chez toi).
- **Le bénéfice est concentré sur 2026.** En 2020-2021 et 2022-2023, la variante est **strictement identique au baseline** (zéro dégât, zéro gain). Ce n'est pas un défaut : 2026 est le **seul** échec structurel de sortie de tout l'historique ; l'objectif réaliste était de **corriger 2026 sans rien abîmer ailleurs** — c'est exactement ce que fait L10+R4 (dégât marché haussier 0 %).
- Concrètement tu **ne peux pas** réduire le DD des périodes 2020-2021/2022-2023 avec une sortie de protection : leur drawdown vient de positions qui sortent déjà normalement, pas d'un piège.
- Les réentrées **R2 / R4 / R6** donnent le même P&L total (4371 %) ; **R4** (MACD hist remonte 2 j) est légèrement meilleure sur 2021-2026 (1501 vs 1397 %). **R1 / R3 / R5** sont à peine en dessous (4278 %).

## Snippet Pine — UNIQUEMENT la meilleure variante (L10+R4) — à valider, non appliqué

```pine
// === PHASE 2 : sortie de protection + réentrée optionnelle (OFF par défaut) ===
// À insérer après le calcul des MA/RSI/MACD et AVANT le bloc EXIT.
useProtExit = input.bool(false, "🛡️ Sortie protection L (cassure plus-bas Nj si EMA8<EMA24)")
protLLen    = input.int(10, "Protection L: plus-bas (bars)", minval=2)
protExitCond = useProtExit and (maFast < maMid) and (close < ta.lowest(low, protLLen)[1])

// Réentrée optionnelle UNIQUEMENT après une sortie de protection :
// (MACD requis — absent du script d'origine, à ajouter :)
[macdLine, macdSignal, macdHist] = ta.macd(close, 12, 26, 9)
useReentry = input.bool(false, "🔁 Réentrée R4 après sortie protection")
var bool lastExitWasProt = false
reentryCond = useReentry and lastExitWasProt and (strategy.position_size == 0) and inRange and ((macdHist > macdHist[1] and macdHist[1] > macdHist[2]))

// Dans le bloc EXIT, ajouter protExitCond ; gérer lastExitWasProt et la réentrée :
// if (exitSignal or (inRange and protExitCond) or not inRange) and strategy.position_size>0
//     strategy.close("Long")
//     lastExitWasProt := (inRange and protExitCond)   // (sinon false)
//     ...reset habituel...
// // réentrée (taille = même logique que le 1er ordre) :
// if reentryCond and strategy.position_size==0 and currentCash>0
//     qtyRe = f_qty_from_amount(currentCash*(initialPct/100.0))
//     if qtyRe>0
//         strategy.entry("Long", strategy.long, qty=qtyRe)
//         lastExitWasProt := false
```

---
### Fichiers
- `tqqq-phase2-LK-reentry-optimization.md/.json` (ce rapport)
- Détail brut des 56 variantes dans le `.json` (clé `allVariants`).
