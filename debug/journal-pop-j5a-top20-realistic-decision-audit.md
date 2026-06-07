# Audit J5-A — Top 20 réaliste « 1 décision par ticker×expiration »

> **Lecture seule** — généré le 2026-06-07T14:47:45 · 3184 records · 1628 observations éligibles
> Source : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite`

## Verdict global

**Le Top 20 actuel s'appuie sur 1628 observations (334 assignées) alors qu'une base « 1 décision par expiration » n'en retient 385 (59 assignées). Ratio duplication global ≈ 4.23×. Assignation 20.5% → BALANCED 15.3%.**

- Chevauchement Top 20 : 9/20 tickers communs (projection top 20 par score E2b — Top 20 strict vide car n max ≈ 5 après déduplication (seuil E2b n≥10)).
- ⚠️ Top 20 strict simulé BALANCED = 0 ticker : après déduplication, aucun ticker n'atteint n≥10 (max ≈ 5 expirations/ticker). Comparaison de rang via projection score E2b (nearEntry + classement score).
- Chevauchement strict (n≥10) : 0/20 au seuil strict n≥10.
- Tickers les plus gonflés : TEM (9×), CZR (8×), DAL (7.5×), PAAS (7×), CIFR (7×), BNO (6.67×), PINS (6.5×), BMNR (6.5×)
- Politique recommandée pour J5-B : **BALANCED — équilibre rendement/risque sans oracle post-mortem.**
- ⚠️ BEST_OBSERVED est un plafond théorique post-mortem (oracle) : il choisit après coup la meilleure observation selon le résultat réel. Non tradable en live.

## Méthodologie

1. Charger `wheelValidationJournal.sqlite` via le store existant.
2. Filtrer les observations éligibles (résolues, expirées, hors `intradayRetest`) — même base que Top 20 / 1%+.
3. Grouper par `ticker + selectedExpiration`.
4. Appliquer 4 politiques de sélection → 1 record par groupe.
5. Comparer métriques observationnelles vs décision réelle.
6. Reconstruire Top 20 actuel via `computeDynamicTop20WheelProfiles` ; simuler Top 20 BALANCED sur records dédupliqués.

## Politiques simulées

### SAFE_FIRST

Meilleure observation SAFE admissible ; sinon AGRESSIF. Préférence DTE 7>4>3>2, strike bas, spread propre.

### BALANCED

Équilibre rendement/risque, rendement ≥0,5 %, évite profondeur, préfère SAFE si rendement comparable.

### YIELD_FIRST

Meilleur rendement CSP admissible — mesure si courir la prime amplifie les profondeurs.

### BEST_OBSERVED

Oracle post-mortem — meilleure observation selon résultat réel. Non tradable.

*Non tradable — oracle post-mortem uniquement.*

## Tableau global des politiques

| Politique | Trades | Assign.% | Prof.% | Win% | Rend.moy.% | Rend méd.% | Dup.reduc. | Ratio dup. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SAFE_FIRST | 385 | 16.6 | 29.7 | 83.4 | 0.68 | 0.64 | 0.76 | 4.23 |
| BALANCED | 385 | 15.3 | 30.5 | 84.7 | 0.95 | 0.81 | 0.76 | 4.23 |
| YIELD_FIRST | 385 | 24.2 | 34.4 | 75.8 | 1 | 0.87 | 0.76 | 4.23 |
| BEST_OBSERVED | 385 | 15.3 | 30.5 | 84.7 | 0.95 | 0.82 | 0.76 | 4.23 |

## Comparaison Top 20 actuel vs Top 20 simulé BALANCED

Méthode : computeDynamicTop20WheelProfiles via createWheelValidationService (E2b si records disponibles)

**Chevauchement : 9/20** (projection top 20 par score E2b — Top 20 strict vide car n max ≈ 5 après déduplication (seuil E2b n≥10))

> **Limite importante** : le Top 20 strict simulé est **vide** (n max ≈ 5 après déduplication vs seuil E2b n≥10). Le tableau ci-dessous utilise la **projection par score E2b** post-déduplication.

### Top 20 actuel (observationnel)

| Rang | Ticker | Score | N | Assign.% | Prof.% |
| --- | --- | --- | --- | --- | --- |
| 1 | HOOD | 100 | — | 5.8 | 0 |
| 2 | CCL | 100 | — | 10 | 0 |
| 3 | HIMS | 100 | — | 0 | — |
| 4 | DAL | 100 | — | 0 | — |
| 5 | NOK | 85 | — | 3.6 | 0 |
| 6 | U | 85 | — | 0 | — |
| 7 | HPE | 85 | — | 0 | — |
| 8 | BNO | 85 | — | 0 | — |
| 9 | DOW | 85 | — | 12.5 | 0 |
| 10 | INTC | 82 | — | 8.8 | 33.3 |
| 11 | APLD | 69 | — | 7.9 | 66.7 |
| 12 | AFRM | 69 | — | 6.7 | 100 |
| 13 | TQQQ | 67 | — | 11.5 | 83.3 |
| 14 | RIVN | 65 | — | 14.3 | 0 |
| 15 | APA | 65 | — | 0 | — |
| 16 | FLY | 65 | — | 0 | — |
| 17 | CSCO | 65 | — | 0 | — |
| 18 | FISV | 65 | — | 0 | — |
| 19 | DOCU | 65 | — | 0 | — |
| 20 | CNC | 65 | — | 0 | — |

### Top 20 simulé BALANCED (1 décision/expiration)

| Rang | Ticker | Score | N | Assign.% | Prof.% | Statut |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | AAL | 50 | — | 20 | 0 | near_entry |
| 2 | APLD | 50 | — | 0 | — | near_entry |
| 3 | CCL | 50 | — | 0 | — | near_entry |
| 4 | DOCU | 50 | — | 0 | — | near_entry |
| 5 | HIMS | 50 | — | 0 | — | near_entry |
| 6 | HOOD | 50 | — | 0 | — | near_entry |
| 7 | HPQ | 50 | — | 20 | 0 | near_entry |
| 8 | INTC | 50 | — | 0 | — | near_entry |
| 9 | IONQ | 50 | — | 0 | — | near_entry |
| 10 | RIVN | 50 | — | 20 | 0 | watch_validate |
| 11 | SOFI | 50 | — | 20 | 0 | near_entry |
| 12 | TQQQ | 50 | — | 20 | 0 | near_entry |
| 13 | U | 50 | — | 0 | — | near_entry |
| 14 | NOW | 46 | — | 20 | 100 | watch_validate |
| 15 | SLV | 35 | — | 20 | 100 | watch_validate |
| 16 | AA | 25 | — | 0 | — | insufficient_sample |
| 17 | AAOI | 25 | — | 0 | — | insufficient_sample |
| 18 | ABNB | 25 | — | 0 | — | insufficient_sample |
| 19 | ACMR | 25 | — | 0 | — | insufficient_sample |
| 20 | ADBE | 25 | — | 0 | — | insufficient_sample |

### Near entry simulé BALANCED (seuil score≥20, n≥5)

| Rang | Ticker | Score | N | Assign.% |
| --- | --- | --- | --- | --- |
| 1 | INTC | 50 | — | 0 |
| 2 | APLD | 50 | — | 0 |
| 3 | IONQ | 50 | — | 0 |
| 4 | TQQQ | 50 | — | 20 |
| 5 | U | 50 | — | 0 |
| 6 | HIMS | 50 | — | 0 |
| 7 | HOOD | 50 | — | 0 |
| 8 | SOFI | 50 | — | 20 |
| 9 | CCL | 50 | — | 0 |
| 10 | AAL | 50 | — | 20 |
| 11 | HPQ | 50 | — | 20 |
| 12 | DOCU | 50 | — | 0 |

**Entrants simulés :** AAL, HPQ, IONQ, SOFI, NOW, SLV, AA, AAOI, ABNB, ACMR, ADBE

**Sortants simulés :** DAL, NOK, HPE, BNO, DOW, AFRM, APA, FLY, CSCO, FISV, CNC

### Plus grands changements de rang

| Ticker | Rang actuel | Rang BALANCED | Delta | Score actuel | Score BALANCED |
| --- | --- | --- | --- | --- | --- |
| DOCU | 19 | 4 | 15 | 65 | 50 |
| APLD | 11 | 2 | 9 | 69 | 50 |
| U | 6 | 13 | -7 | 85 | 50 |
| HOOD | 1 | 6 | -5 | 100 | 50 |
| RIVN | 14 | 10 | 4 | 65 | 50 |
| HIMS | 3 | 5 | -2 | 100 | 50 |
| INTC | 10 | 8 | 2 | 82 | 50 |
| CCL | 2 | 3 | -1 | 100 | 50 |
| TQQQ | 13 | 12 | 1 | 67 | 50 |

## 1. Tickers gonflés par duplication

| Ticker | Obs.assign. | Exp.assign. | Ratio | Assign.obs.% | Rang actuel | Rang BALANCED |
| --- | --- | --- | --- | --- | --- | --- |
| TEM | 9 | 1 | 9 | 75 | — | — |
| CZR | 0 | 0 | 8 | 0 | — | — |
| DAL | 0 | 0 | 7.5 | 0 | 4 | — |
| PAAS | 7 | 1 | 7 | 70 | — | — |
| CIFR | 0 | 0 | 7 | 0 | — | — |
| BNO | 0 | 0 | 6.67 | 0 | 8 | — |
| PINS | 13 | 2 | 6.5 | 59.1 | — | — |
| BMNR | 13 | 2 | 6.5 | 54.2 | — | — |
| HIMS | 0 | 0 | 6.4 | 0 | 3 | 5 |
| TTD | 6 | 1 | 6 | 37.5 | — | — |
| TQQQ | 6 | 1 | 6 | 11.5 | 13 | 12 |
| SOFI | 6 | 1 | 6 | 16.7 | — | 11 |
| PLTR | 6 | 1 | 6 | 60 | — | — |
| OKLO | 6 | 1 | 6 | 27.3 | — | — |
| ETSY | 6 | 1 | 6 | 42.9 | — | — |

## 2. Tickers meilleurs en base décision réelle

| Ticker | Assign.obs.% | Assign BALANCED% | Verdict rang | Rang actuel | Rang BALANCED |
| --- | --- | --- | --- | --- | --- |
| TNA | 50 | 0 | à confirmer | — | — |
| SMCI | 22.2 | 0 | stable | — | — |
| PATH | 20 | 0 | stable | — | — |
| IONQ | 21.9 | 0 | monte | — | 9 |
| INTC | 8.8 | 0 | stable | 10 | 8 |
| IGV | 25 | 0 | stable | — | — |
| HOOD | 5.8 | 0 | descend | 1 | 6 |
| CCL | 10 | 0 | stable | 2 | 3 |
| MRNA | 27.3 | 0 | stable | — | — |
| FCX | 16.7 | 0 | stable | — | — |
| DOW | 12.5 | 0 | descend | 9 | — |
| APLD | 7.9 | 0 | monte | 11 | 2 |

## 3. Tickers moins bons en base décision réelle

| Ticker | Assign.obs.% | Assign BALANCED% | Verdict rang | Rang actuel | Rang BALANCED |
| --- | --- | --- | --- | --- | --- |
| PYPL | 40 | 50 | à confirmer | — | — |
| UUUU | 33.3 | 50 | à confirmer | — | — |
| AG | 33.3 | 50 | à confirmer | — | — |
| MSTR | 16.7 | 50 | à confirmer | — | — |
| BP | 33.3 | 50 | à confirmer | — | — |
| MCHP | 22.2 | 33.3 | stable | — | — |
| RBLX | 20 | 33.3 | à confirmer | — | — |
| BAC | 25 | 33.3 | à confirmer | — | — |
| SHOP | 25 | 33.3 | à confirmer | — | — |
| SLB | 20 | 25 | à confirmer | — | — |
| AFRM | 6.7 | 25 | descend | 12 | — |
| TQQQ | 11.5 | 20 | stable | 13 | 12 |

## 4. SAFE vs AGRESSIF

- Paires SAFE+AGG (même ticker×expiration×DTE) : **729**
- SAFE aurait évité l'assignation : **43** fois
- SAFE réduisait la profondeur : **49** fois
- AGRESSIF payait plus (rendement) : **394** fois
- AGRESSIF valait le risque : **309** fois
- AGRESSIF augmentait la profondeur : **49** fois

### Focus tickers

| Ticker | Paires | SAFE évite | SAFE ↓prof. | AGG +rend. | AGG valait | AGG ↑prof. |
| --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 22 | 0 | 3 | 20 | 17 | 3 |
| APLD | 16 | 1 | 1 | 16 | 14 | 1 |
| HOOD | 22 | 3 | 0 | 14 | 11 | 0 |
| SOFI | 16 | 0 | 2 | 5 | 3 | 2 |
| BAC | 4 | 0 | 0 | 0 | 0 | 0 |
| CCL | 16 | 2 | 0 | 11 | 9 | 0 |
| HIMS | 14 | 0 | 0 | 12 | 12 | 0 |

## 5. DTE — observationnel vs décision réelle

| DTE | Base | N | Assign.% | Prof.% | Rend.% | Win% | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | observationnel | 132 | 8.3 | 36.4 | 0.75 | 91.7 | prudent |
| 2 | BALANCED | 22 | 9.1 | 50 | 0.7 | 90.9 | profondeur élevée |
| 3 | observationnel | 166 | 25.9 | 53.5 | 0.84 | 74.1 | risque élevé |
| 3 | BALANCED | 23 | 13 | 33.3 | 1.05 | 87 | prudent |
| 4 | observationnel | 190 | 46.3 | 52.3 | 0.8 | 53.7 | risque élevé |
| 4 | BALANCED | 42 | 47.6 | 45 | 0.89 | 52.4 | risque élevé |
| 7 | observationnel | 552 | 20.8 | 21.7 | 0.8 | 79.2 | prudent |
| 7 | BALANCED | 137 | 17.5 | 25 | 0.86 | 82.5 | prudent |

## 6. Tableau par ticker focus

| Ticker | Obs.rés. | Obs.assign. | Exp.dist. | Ratio dup. | Rang actuel | Rang BALANCED | Assign BAL.% | Prof BAL.% | Mode BAL. | DTE BAL. | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 52 | 6 | 5 | 6 | 13 | 12 | 20 | 0 | AGGRESSIVE | 3 | stable |
| APLD | 38 | 3 | 5 | 3 | 11 | 2 | 0 | — | AGGRESSIVE | 7 | monte |
| HOOD | 52 | 3 | 5 | 1.5 | 1 | 6 | 0 | — | AGGRESSIVE | 3 | descend |
| SOFI | 36 | 6 | 5 | 6 | — | 11 | 20 | 0 | SAFE | 3 | monte |
| BAC | 8 | 2 | 3 | 2 | — | — | 33.3 | 0 | SAFE | 7 | à confirmer |
| CCL | 40 | 4 | 5 | 4 | 2 | 3 | 0 | — | AGGRESSIVE | 4 | stable |
| HIMS | 32 | 0 | 5 | — | 3 | 5 | 0 | — | AGGRESSIVE | 3 | stable |

## Recommandation J5-B

### J5-B1 — Facteur duplication / risk-event dans le score actuel (haute)

1628 observations éligibles vs 385 décisions BALANCED (ratio 4.23×). Pénaliser assignmentConcentrationPct et confirmedRepeatedRisk existants avec le dénominateur expiration, pas observation.

**Action :** Dans computeE2bTickerEventUniqueness / score E2b : utiliser distinctAssignedExpirationCount comme base d'assignation, garder observation_count en métrique de confiance séparée.

### J5-B2 — Remplacer assignmentRate observationnel par selectedAssignmentRate (haute)

Global : assignation obs. 20.5% → BALANCED 15.3% (5.2 pts).

**Action :** Avant computeOnePercentWheelProfiles pour Top 20 : réduire à 1 record par ticker×selectedExpiration (politique BALANCED par défaut) puis recalculer csp.assignmentRate.

### J5-B3 — deepAssignmentRate sur base décision réelle (haute)

Profonde obs. 33.5% → BALANCED 30.5%.

**Action :** Utiliser assignment.profondeRatePct des profils post-déduplication pour les pénalités E2b deepExpsPenalties.

### J5-B4 — SAFE vs AGRESSIF risk-adjusted (moyenne)

729 paires SAFE/AGG : SAFE aurait évité 43 assignations ; AGG payait plus 394 fois.

**Action :** Intégrer un tie-break SAFE quand rendement comparable (±0,15 %) dans la sélection pré-scoring ; exposer safeVsAggressive dans le diagnostic Top 20.

### J5-B5 — observation_count = confiance, pas score direct (moyenne)

Le n observationnel gonfle le mérite sample et les pénalités d'assignation sans refléter le risque réel.

**Action :** Conserver recordsResolved observationnel en badge « variantes testées » ; utiliser selectedTradeCount (expirations) pour n minimum E2b et crédibilité.

### J5-B6 — Recalibrer le seuil n minimum après déduplication (haute)

Après déduplication BALANCED, n max ≈ 5 expirations/ticker — le Top 20 strict E2b (n≥10) devient vide (0 ticker).

**Action :** Ajuster E2B_EXPLOITABLE_MIN_N vers distinctExpirationCount (≈5–8) ou exiger n_observation≥30 ET n_decision≥5 ; ne pas bloquer la migration décisionnelle par un seuil observationnel.

## Limites

- Simulation read-only — aucune modification du moteur E2b, formule ou tri production.
- Top 20 simulé BALANCED recalcule profils + score E2b sur records dédupliqués ; le classement peut diverger pour d'autres facteurs (stress, bonus robuste).
- BEST_OBSERVED utilise le résultat post-expiration — biais look-ahead.
- Politiques appliquées sur le même pool éligible isOnePercentProfileRecord ; DTE hors 2/3/4/7 inclus dans les groupes.
- Cycles Wheel théoriques non re-simulés par décision — wheel metrics restent sur cycles existants.
