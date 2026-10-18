# Audit qualité des trades — Stratégie Pine TQQQ « L10 + R4 corrigé »

_Généré le 2026-06-06T01:00:07.173Z. TradingView / Pine / backtest technique TQQQ — audit qualité des trades. Aucun Pine modifié, aucun git._

> ⚠️ **Aucune modification du Pine final.** Aucun fichier .pine touché, aucun git add/commit. Audit/backtest uniquement. Le Wheel Dashboard n'est pas concerné.

## 1. Résumé exécutif

- Baseline analysé (moteur local) : **23 trades**, **+4371%**, DD **-37.99%**, taux gagnants **60.87%**, PF **5.93**.
- Référence TradingView L10+R4 (fournie) : +4213.73%, DD 27.45%, 59.09% gagnants, PF 3.823. _Référence TradingView L10+R4 fournie par l'utilisateur. Écart vs moteur local attendu et documenté (surtout le calcul du max DD : TV = DD d'équité du strategy tester)._
- 0 variante(s) passent TOUTES les contraintes d'acceptation (étape 6).
- **Meilleur compromis : F8 — Après une perte, cooldown 2 -> 5 barres** → 4249.86% (Δ-121.14%), DD -42.43%, WR 63.64% (Δ+2.77 pts), PF 6.04, 22 trades.

**Recommandation courte : NE RIEN CHANGER** — aucune variante ne satisfait simultanément toutes les contraintes (P&L, DD, WR, PF, gros gagnants).

## 2. Baseline L10+R4 corrigé

Config : tvRealConfig + protExit L(10) + reentry R4 (MA 8/24/24, RSI 47/1, MASTER on, blockMMSlope on/LB100, recovery on, 100% cash, 0 add, cooldown 2, stops/trailing/scaling OFF, fill close).

| Métrique | Moteur local | Réf. TradingView |
|---|---|---|
| Rendement | +4371% | +4213.73% |
| Max DD | -37.99% | 27.45% |
| Trades | 23 | 22 |
| Taux gagnants | 60.87% | 59.09% |
| Profit factor | 5.93 | 3.823 |
| Exposition | 23.88% | — |

> L'écart moteur/TV vient surtout du **calcul du max drawdown** (TV = DD d'équité du strategy tester, intrabar) et d'une barre de données de moins. Les EXPÉRIENCES ci-dessous sont toutes lancées sur le **même moteur local**, donc les comparaisons relatives (Δ) sont fiables.

## 3. Tableau des trades (gagnants / perdants)

| # | Entrée | Sortie | Jours | EntréePx | SortiePx | P&L% | Issue | TypeEntrée | TypeSortie | DDintra% | MaxOuvert% | Rendu% | RSI | clo/EMA8% | EMA8>EMA24 | histMACD |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2020-04-08 | 2020-09-11 | 156 | 6.8088 | 15.2137 | +123.44 | WIN | RSI | MA | 0 | 220.41 | 96.97 | 49.31 | +11.78 | non | rising |
| 2 | 2020-09-28 | 2020-10-28 | 30 | 16.215 | 15.015 | -7.4 | LOSS | RSI | MA | -7.4 | 18.93 | 26.33 | 50.79 | +5.64 | non | rising |
| 3 | 2020-11-04 | 2021-02-25 | 113 | 17.51 | 21.975 | +25.5 | WIN | RSI | MA | -3.99 | 57.21 | 31.71 | 54.87 | +8.61 | non | rising |
| 4 | 2021-03-11 | 2021-05-10 | 60 | 22.695 | 24 | +5.75 | WIN | RSI | MA | -6.48 | 23.17 | 17.42 | 48.45 | +4.52 | non | rising |
| 5 | 2021-05-20 | 2021-09-21 | 124 | 24.5175 | 33.415 | +36.29 | WIN | RSI | MA | -1.65 | 55.06 | 18.77 | 49.06 | +2.93 | non | rising |
| 6 | 2021-10-14 | 2021-12-03 | 50 | 33.31 | 37.52 | +12.64 | WIN | RSI | MA | 0 | 32.95 | 20.31 | 51.4 | +4.29 | non | rising |
| 7 | 2021-12-15 | 2021-12-16 | 1 | 41.4475 | 38.285 | -7.63 | LOSS | MA+RSI | MA | -7.63 | 0 | 7.63 | 53.05 | +2.15 | oui | rising |
| 8 | 2021-12-21 | 2022-01-06 | 16 | 39.0175 | 37.235 | -4.57 | LOSS | RSI | MA | -4.57 | 11.1 | 15.67 | 48.24 | +0.27 | non | rising |
| 9 | 2023-03-14 | 2023-08-09 | 148 | 11.39 | 19.855 | +74.32 | WIN | RSI | MA | 0 | 103.34 | 29.02 | 50.98 | +2.62 | non | rising |
| 10 | 2023-08-23 | 2023-09-19 | 27 | 19.89 | 19.8 | -0.45 | LOSS | RSI | MA | -6.59 | 6.69 | 7.14 | 48.83 | +2.92 | non | rising |
| 11 | 2023-10-06 | 2023-10-13 | 7 | 18.675 | 18.705 | +0.16 | WIN | RSI | MA | 0 | 5.33 | 5.17 | 49.02 | +3.36 | non | rising |
| 12 | 2023-11-02 | 2024-04-08 | 158 | 18.15 | 29.95 | +65.01 | WIN | RSI | MA | 0 | 73.91 | 8.9 | 52.68 | +6.44 | non | rising |
| 13 | 2024-04-11 | 2024-04-12 | 1 | 30.85 | 29.36 | -4.83 | LOSS | MA+RSI | MA | -4.83 | 0 | 4.83 | 54.53 | +2.22 | oui | rising |
| 14 | 2024-04-29 | 2024-07-23 | 85 | 27.97 | 36.68 | +31.14 | WIN | RSI | MA | -7.76 | 51.82 | 20.68 | 48.59 | +2.87 | non | rising |
| 15 | 2024-09-11 | 2024-11-04 | 54 | 32.285 | 35.135 | +8.83 | WIN | RSI | MA | 0 | 19.06 | 10.24 | 49.65 | +3.36 | non | rising |
| 16 | 2024-11-18 | 2024-12-31 | 43 | 37.885 | 39.565 | +4.43 | WIN | RSI | MA | 0 | 23.12 | 18.69 | 49.66 | -2.89 | oui | falling |
| 17 | 2025-01-15 | 2025-02-03 | 19 | 40.44 | 40.36 | -0.2 | LOSS | RSI | MA | -2.15 | 9.22 | 9.42 | 48.98 | +1.88 | non | rising |
| 18 | 2025-04-24 | 2025-11-14 | 204 | 26.07 | 52.37 | +100.88 | WIN | RSI | MA | 0 | 131.32 | 30.44 | 49.09 | +9.22 | non | rising |
| 19 | 2025-11-25 | 2025-12-16 | 21 | 52.01 | 52.33 | +0.62 | WIN | RSI | MA | 0 | 8.92 | 8.31 | 48.99 | +2.62 | non | rising |
| 20 | 2025-12-19 | 2026-01-02 | 14 | 53.52 | 52.35 | -2.19 | LOSS | RSI | MA | -2.19 | 3.44 | 5.62 | 50.4 | +1.39 | non | rising |
| 21 | 2026-01-22 | 2026-02-04 | 13 | 53.9 | 49.76 | -7.68 | LOSS | RSI | MA | -7.68 | 5.86 | 13.54 | 50.02 | +0.61 | non | rising |
| 22 | 2026-02-25 | 2026-03-20 | 23 | 51.87 | 43.08 | -16.95 | LOSS | RSI | L | -16.95 | 0 | 16.95 | 51.79 | +3.77 | non | rising |
| 23 | 2026-04-01 | 2026-05-29 | 58 | 43.23 | 84.56 | +95.6 | WIN | R4 | fin de données | 0 | 95.6 | 0 | 44.57 | +2.52 | non | rising |

## 4. Profil moyen des trades GAGNANTS (14)

| Indicateur | Valeur |
|---|---|
| Nombre | 14 |
| P&L moyen | +41.76% |
| Durée moyenne | 91.5 j |
| RSI moyen entrée | 49.74 |
| RSI pente 3j moy | +10.08 |
| close vs EMA8 moy | +4.45% |
| close vs EMA24 moy | +0.34% |
| % EMA8>EMA24 à l'entrée | 7.1% |
| MACD hist moyen | -0.06 |
| % hist en hausse | 92.9% |
| % close<EMA8 à l'entrée | 7.1% |
| % bougie rouge à l'entrée | 7.1% |
| dist EMA50 moy | -2.53% |
| dist EMA200 moy | +5.59% |
| DD intra-trade moy | -1.42% |
| Répartition entrées | RSI:13, R4:1 |

## 5. Profil moyen des trades PERDANTS (9)

| Indicateur | Valeur |
|---|---|
| Nombre | 9 |
| P&L moyen | -5.77% |
| Durée moyenne | 16 j |
| RSI moyen entrée | 50.74 |
| RSI pente 3j moy | +5.9 |
| close vs EMA8 moy | +2.32% |
| close vs EMA24 moy | +0.53% |
| % EMA8>EMA24 à l'entrée | 22.2% |
| MACD hist moyen | -0.2 |
| % hist en hausse | 100% |
| % close<EMA8 à l'entrée | 0% |
| % bougie rouge à l'entrée | 11.1% |
| dist EMA50 moy | +1.93% |
| dist EMA200 moy | +19.58% |
| DD intra-trade moy | -6.67% |
| Répartition entrées | RSI:7, MA+RSI:2 |

### Taux de réussite par type d'entrée

| Type | Trades | Gagnants | Taux | P&L moyen |
|---|---|---|---|---|
| RSI | 20 | 13 | 65% | +22.48% |
| MA+RSI | 2 | 0 | 0% | -6.23% |
| R4 | 1 | 1 | 100% | +95.6% |

## 6. Causes principales des pertes

- **Le contexte d'entrée ne distingue PAS les perdants des gagnants.** À l'entrée, RSI moyen 50.74 (perdants) vs 49.74 (gagnants), close vs EMA8 +2.32% vs +4.45%, hist en hausse 100% vs 92.9%. Les deux populations entrent dans des conditions quasi identiques. **Conséquence prouvée** : les filtres F1/F3/F4/F5/F6/F7/F10 laissent le taux de réussite inchangé (59.09%) tout en rognant le rendement — ils retirent surtout des petits gagnants, pas des perdants.
- **Les entrées « MA+RSI » (croisement MA confirmé) sont structurellement mauvaises** : 2 trades, **0% de réussite** (P&L moyen -6.23%). Elles se déclenchent en sur-extension (EMA8>EMA24, ~+27% au-dessus de l'EMA200), n'ouvrent jamais en vert (maxOpen 0%) et se retournent en 1 jour. À l'inverse, les entrées RSI seules font 65% (+22.48%) et portent tous les gros gagnants. (Échantillon MA+RSI faible = 2 trades.)
- **Profits rendus (round-trips)** : plusieurs perdants/quasi-nuls sont montés franchement en vert avant de revenir rouge — ex. #2 (+18.9% → −7.4%), #8 (+11.1% → −4.6%), #10 (+6.7% → −0.5%), #17 (+9.2% → −0.2%). Ce sont des trades de momentum qui s'essoufflent. Seul un trailing/breakeven les corrigerait — or ATR/trailing est OFF par design et hors du périmètre S1–S6 ; la seule S qui les cible (S4) coupe aussi des gagnants et fait chuter le rendement de ~28%.
- **Whipsaws de range** : grappe de petits gains/pertes quand le RSI croise 47 sans tendance qui suit (fin 2025/début 2026 : #17, #19, #20, #21 ; durées 16 j en moyenne côté perdants). Allonger le cooldown après une perte (F8) améliore un peu le taux (→63.6%) mais creuse le DD (−42.4% vs −38.0%).
- **La seule perte importante (#22, −16.95%, krach 2026) est déjà coupée par la sortie L** ; sans L elle aurait été bien pire. La protection en place fait déjà l'essentiel du travail de réduction du risque.

## 7. Résultats des filtres d'entrée F1–F10

| Var | Description | Rendement | ΔRdt | DD | ΔDD | Trades | WR | ΔWR | PF | Bloqués/Réentrées | GrosGagnants | Accept |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F1 | Bloquer entrée normale si close < EMA8 | 4181.49% | -189.51 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.9 | 3/1 | 5 (2020/2023/2025/2026) | ❌ |
| F2 | Bloquer entrée normale si EMA8<EMA24 (R4 exempté) | 148.89% | -4222.11 | -31.51% | +6.48 | 16 | 43.75% | -17.12 | 2.04 | 28/0 | 2 (2023) | ❌ |
| F3 | Bloquer entrée RSI seule si MACD hist baisse | 4102.09% | -268.91 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.73 | 2/1 | 5 (2020/2023/2025/2026) | ❌ |
| F4 | Bloquer entrée RSI seule si close < EMA8 | 4181.49% | -189.51 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.9 | 3/1 | 5 (2020/2023/2025/2026) | ❌ |
| F5 | Entrée RSI valide seulement si RSI>47 ET hist remonte | 4102.09% | -268.91 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.73 | 2/1 | 5 (2020/2023/2025/2026) | ❌ |
| F6 | Entrée RSI valide seulement si RSI>47 ET close>EMA8 | 4181.49% | -189.51 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.9 | 3/1 | 5 (2020/2023/2025/2026) | ❌ |
| F7 | Entrée normale valide seulement si close>EMA8 OU MA8 croise MA24 | 4181.49% | -189.51 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.9 | 3/1 | 5 (2020/2023/2025/2026) | ❌ |
| F8 | Après une perte, cooldown 2 -> 5 barres | 4249.86% | -121.14 | -42.43% | -4.44 | 22 | 63.64% | +2.77 | 6.04 | 0/1 | 5 (2020/2023/2025/2026) | ❌ |
| F9 | Pas d'entrée si bougie rouge ET MACD hist baisse | 4371% | +0 | -37.99% | +0 | 23 | 60.87% | +0 | 5.93 | 0/1 | 5 (2020/2023/2025/2026) | ❌ |
| F10 | Pas d'entrée si close<EMA24 ET MACD hist baisse | 4102.09% | -268.91 | -37.99% | +0 | 22 | 59.09% | -1.78 | 5.73 | 2/1 | 5 (2020/2023/2025/2026) | ❌ |

## 8. Résultats des sorties anti-perte S1–S6

| Var | Description | Rendement | ΔRdt | DD | ΔDD | Trades | WR | ΔWR | PF | Bloqués/Réentrées | GrosGagnants | Accept |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Si perte <= -5% ET close<EMA8 -> sortir | 1909.87% | -2461.13 | -37.99% | +0 | 25 | 52% | -8.87 | 3.97 | 0/0 | 4 (2020/2023/2025) | ❌ |
| S2 | Si perte <= -7% ET MACD hist baisse -> sortir | 1695.44% | -2675.56 | -37.99% | +0 | 22 | 54.55% | -6.32 | 4.08 | 0/0 | 4 (2020/2023/2025) | ❌ |
| S3 | Si perte <= -8% ET close<EMA24 -> sortir | 2422.53% | -1948.47 | -37.99% | +0 | 22 | 59.09% | -1.78 | 4.73 | 0/0 | 4 (2020/2023/2025) | ❌ |
| S4 | Si close casse low5 avant d'atteindre +10% -> sortir | 3151.67% | -1219.33 | -37.99% | +0 | 26 | 65.38% | +4.51 | 5.11 | 0/1 | 5 (2020/2023/2025/2026) | ❌ |
| S5 | Si jamais +5% après 10j ET close<EMA8 -> sortir | 2211.31% | -2159.69 | -37.99% | +0 | 23 | 56.52% | -4.35 | 4.37 | 0/0 | 4 (2020/2023/2025) | ❌ |
| S6 | Si négatif après 15j ET EMA8<EMA24 -> sortir | 2346.13% | -2024.87 | -37.99% | +0 | 22 | 59.09% | -1.78 | 4.23 | 0/0 | 4 (2020/2023/2025) | ❌ |

> Légende acceptation : ✅ = passe les 6 contraintes (P&L ≥ −10% du baseline, DD pas plus profond, 20–60 trades, WR en hausse, PF ≥ 80% du baseline, gros gagnants 2020/2025/2026 conservés).

## 9. Meilleure variante — RENDEMENT

**F8 — Après une perte, cooldown 2 -> 5 barres**

- Rendement 4249.86% (Δ-121.14% vs 4371%)
- DD -42.43% (Δ-4.44)
- Taux gagnants 63.64% (Δ+2.77 pts vs 60.87%)
- PF 6.04, 22 trades, gros gagnants conservés : 5 (2020/2023/2025/2026). ⚠️ ne passe PAS toutes les contraintes : ddNotWorse

## 10. Meilleure variante — TAUX DE RÉUSSITE

**S4 — Si close casse low5 avant d'atteindre +10% -> sortir**

- Rendement 3151.67% (Δ-1219.33% vs 4371%)
- DD -37.99% (Δ+0)
- Taux gagnants 65.38% (Δ+4.51 pts vs 60.87%)
- PF 5.11, 26 trades, gros gagnants conservés : 5 (2020/2023/2025/2026). ⚠️ ne passe PAS toutes les contraintes : returnNearOrBetter

## 11. Meilleur compromis

**F8 — Après une perte, cooldown 2 -> 5 barres**

- Rendement 4249.86% (Δ-121.14% vs 4371%)
- DD -42.43% (Δ-4.44)
- Taux gagnants 63.64% (Δ+2.77 pts vs 60.87%)
- PF 6.04, 22 trades, gros gagnants conservés : 5 (2020/2023/2025/2026). ⚠️ ne passe PAS toutes les contraintes : ddNotWorse

## 12. Recommandation

**NE RIEN CHANGER pour l'instant.** Garder la config validée (L10 + R4).

Aucune des 16 variantes (F1–F10, S1–S6) ne passe les 6 contraintes d'acceptation en même temps. Raisons de fond, démontrées par les chiffres :
- **Les conditions d'entrée ne séparent pas les bons des mauvais trades** (RSI ~50, hist en hausse, juste au-dessus de l'EMA8 dans les DEUX cas). Les filtres d'entrée « propres » (F1/F3/F4/F5/F6/F7/F10) laissent donc le taux à 59.09% et ne font que **retirer de petits gagnants** → rendement en baisse, zéro gain de taux.
- F2 (interdire si EMA8<EMA24) est **destructeur** : il tue les entrées de creux (2020, 2025) → +148% seulement.
- Les **sorties anti-perte S1–S6 coupent des trades qui repartent** : toutes font chuter le rendement de 28 à 61% pour un gain de taux faible ou nul.
- La performance vient de **4 trades énormes** (2020 +123%, 2023 +74%/+65%, 2025 +101%, 2026 +96%), tous des entrées RSI seules : tout filtre statistiquement « logique » risque d'en sacrifier un.

**Quasi-acceptées à connaître (échouent sur UNE seule contrainte)** : F8 (échoue seulement sur : ddNotWorse) · S4 (échoue seulement sur : returnNearOrBetter).
- **F8** (cooldown 2→5 après une perte) : taux **63.6%** (+2.8 pts), PF **6.04**, rendement quasi intact (−2.8%) — mais **DD plus profond** (−42.4% vs −38.0%). À tester dans TradingView SI on accepte un DD légèrement plus élevé ; c'est la piste la moins risquée pour le P&L.
- **S4** (sortir si cassure low5 avant +10%) : meilleur **taux 65.4%** et DD inchangé, mais **−28% de rendement** → trop coûteux.

La sortie L (déjà en place) est le bon compromis protection/rendement et gère déjà la seule grosse perte (krach 2026). _(Variantes no-op = identiques au baseline : F9.)_

## 13. Snippet Pine (seulement si une variante est clairement meilleure)

_Aucune variante n'est clairement supérieure au baseline sur **toutes** les contraintes → **recommandation = ne rien changer**._

Si (et seulement si) tu veux EXPÉRIMENTER la seule piste neutre pour le P&L — **F8, cooldown plus long après une perte** (taux +2.8 pts, DD un peu plus profond) — voici le snippet à tester dans une COPIE du Pine, en input.bool OFF par défaut. Ne touche pas au Pine final tant que TradingView n'a pas confirmé.

```pine
// === [EXPÉRIMENTAL] F8 : cooldown allongé après une perte (2 -> 5 barres) ===
useF8        = input.bool(false, "Exp: cooldown 5 barres après une perte")
var int   lastExitBarIdx = na
var float lastEntryAvg   = na
var bool  lastTradeLoss  = false
// mémoriser le prix d'entrée tant qu'on est en position
if strategy.position_size > 0 and strategy.position_size[1] == 0
    lastEntryAvg := strategy.position_avg_price
// à la fermeture d'un trade : marquer perte/gain + barre de sortie
if strategy.position_size == 0 and strategy.position_size[1] > 0
    lastTradeLoss := close < nz(lastEntryAvg, close)
    lastExitBarIdx := bar_index
cdBars      = useF8 and lastTradeLoss ? 5 : 2
cooldownOk  = na(lastExitBarIdx) or (bar_index - lastExitBarIdx) > cdBars
// puis dans le signal d'entrée NORMALE : entryLong := entryLong and cooldownOk
```

_Rappel : audit/backtest seulement. Le moteur local donne pour F8 +4249% / DD −42.4% / taux 63.6% / PF 6.04 — à reconfirmer dans TradingView._
