# Validation J5-B6 — Remplissage du Top 20 réaliste (stricts + « à confirmer »)

> Phase J5-B6 · 2026-06-07 · source : C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.json
> Records journal : 154 (résolus : 0).
>
> ⚠️ Le journal local de ce checkout ne contient **aucun record résolu** → aucun profil exploitable → Top 20 réel vide. La mécanique de remplissage est donc démontrée sur un **jeu synthétique** (section dédiée). Sur un journal résolu (env. de production), le même tri stricts→confirm s'applique sans changement.

## Comportement

- Le Top 20 est rempli **d'abord par les admissibles STRICTS** (selectedTradeCount≥5 + rendement réel ≥0,5 % + profondeur réelle ≤50 % + score réaliste suffisant).
- S'il reste des places, il est complété par des candidats **« à confirmer »** (3–4 décisions réelles, mêmes garde-fous qualité, observations≥15), placés **derrière** les stricts.
- Les tickers **rejetés** (rendement réel <0,5 %, profondeur réelle >50 %, crypto-block, exclusions critiques) restent exclus.
- Le **score réaliste reste le score principal** ; aucun second classement n'est créé.

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| `app/journal/wheelValidationService.js` | `computeRealisticPreviewScore` (buckets strict/confirm/rejected), `computeE2bDynamicTop20` (remplissage strict→confirm), `mapDynamicTop20ProfileRow` (nouveaux champs), meta guardrails |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Badge « À confirmer · échantillon faible », légende remplissage, cellule admissibilité modal |
| `app/journal/wheelValidationService.realisticTop20Fill.test.mjs` | Tests A–H du remplissage (nouveau) |

## Fonctions modifiées

- `computeRealisticPreviewScore` — classification en buckets `strict` / `confirm` / `rejected` + champs `eligibleForTop20Confirm`, `dynamicTop20Confidence`, `selectedTradeCountGuard`, `realisticEligibilityReason`. `eligibleForTop20` (strict) inchangé.
- `computeE2bDynamicTop20` — remplissage du Top 20 : stricts d'abord, confirm derrière (jamais devant), plafond 20. Expose `strictEligibleCount`, `confirmEligibleCount`, `strictInTop20`, `confirmInTop20`.
- `mapDynamicTop20ProfileRow` — porte les nouveaux champs sur la ligne et dans `realisticActive`.
- `buildDynamicTop20E2bResult` — `meta.guardrails` enrichi (seuils confirm + compteurs).

## Nouveaux champs (ligne Top 20 / realisticActive)

- `dynamicTop20RealisticBucket` : `strict` | `confirm` | `rejected`
- `dynamicTop20Confidence` : `normal` | `low` | `insufficient`
- `selectedTradeCountGuard` : `ok` | `confirm` | `insufficient`
- `realisticEligibilityReason` : raison lisible d'admissibilité
- `eligibleForTop20Confirm` : booléen (remplissage « à confirmer »)
- (aucun champ existant supprimé)

## Données réelles (journal local)

- Top 20 total : **0**
- Stricts dans le Top 20 : **0**
- À confirmer dans le Top 20 : **0**
- Admissibles stricts (total) : 0
- Admissibles à confirmer (total) : 0

**Stricts (Top 20)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | _aucun_ | — | — | — | — | — | — | — | — |

**À confirmer (Top 20)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | _aucun_ | — | — | — | — | — | — | — | — |

**Exclus / rejetés (échantillon)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | _aucun_ | — | — | — | — | — | — | — | — |

**Impact tickers focus**

| Ticker | Statut | Bucket | Score réaliste | n déc. | n obs. | Rend.% | Prof.% | Raison |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| HOOD | absent | — | — | — | — | — | — | — |
| CCL | absent | — | — | — | — | — | — | — |
| HIMS | absent | — | — | — | — | — | — | — |
| APLD | absent | — | — | — | — | — | — | — |
| TQQQ | absent | — | — | — | — | — | — | — |
| INTC | absent | — | — | — | — | — | — | — |
| AFRM | absent | — | — | — | — | — | — | — |
| SOFI | absent | — | — | — | — | — | — | — |

**Garde-fous**

```json
{
  "exploitableForTop20Count": 0,
  "exploitableMinScore": 35,
  "exploitableMinN": 10,
  "realisticMinSelectedTradeCount": 5,
  "realisticMinSelectedYieldPct": 0.5,
  "realisticMaxDeepAssignmentRatePct": 50,
  "realisticConfirmMinSelectedTradeCount": 3,
  "realisticConfirmMinObservationResolved": 15,
  "strictEligibleForTop20Count": 0,
  "confirmEligibleForTop20Count": 0,
  "strictInTop20Count": 0,
  "confirmInTop20Count": 0
}
```

## Preuve synthétique — 9 stricts + 11 à confirmer + 2 rejets

- Top 20 total : **20**
- Stricts dans le Top 20 : **9**
- À confirmer dans le Top 20 : **11**
- Admissibles stricts (total) : 9
- Admissibles à confirmer (total) : 11

**Stricts (Top 20)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | STRICT0 | strict | 81 | 65 | 6 | 12 | 1.2 | — | normal |
| 2 | STRICT1 | strict | 81 | 65 | 6 | 12 | 1.18 | — | normal |
| 3 | STRICT2 | strict | 81 | 65 | 6 | 12 | 1.16 | — | normal |
| 4 | STRICT3 | strict | 81 | 65 | 6 | 12 | 1.14 | — | normal |
| 5 | STRICT4 | strict | 81 | 65 | 6 | 12 | 1.12 | — | normal |
| 6 | STRICT5 | strict | 81 | 65 | 6 | 12 | 1.1 | — | normal |
| 7 | STRICT6 | strict | 81 | 65 | 6 | 12 | 1.08 | — | normal |
| 8 | STRICT7 | strict | 81 | 65 | 6 | 12 | 1.06 | — | normal |
| 9 | STRICT8 | strict | 81 | 65 | 6 | 12 | 1.04 | — | normal |

**À confirmer (Top 20)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | CONF0 | confirm | 80 | 79 | 4 | 16 | 1.12 | — | low |
| 11 | CONF1 | confirm | 78 | 77 | 4 | 16 | 1.1 | — | low |
| 12 | CONF2 | confirm | 78 | 77 | 4 | 16 | 1.08 | — | low |
| 13 | CONF3 | confirm | 78 | 77 | 4 | 16 | 1.06 | — | low |
| 14 | CONF4 | confirm | 78 | 77 | 4 | 16 | 1.04 | — | low |
| 15 | CONF5 | confirm | 78 | 77 | 4 | 16 | 1.02 | — | low |
| 16 | CONF6 | confirm | 78 | 77 | 4 | 16 | 1 | — | low |
| 17 | CONF7 | confirm | 71 | 73 | 4 | 16 | 0.98 | — | low |
| 18 | CONF8 | confirm | 71 | 73 | 4 | 16 | 0.96 | — | low |
| 19 | CONF9 | confirm | 71 | 73 | 4 | 16 | 0.94 | — | low |
| 20 | CONF10 | confirm | 71 | 73 | 4 | 16 | 0.92 | — | low |

**Exclus / rejetés (échantillon)**

| Rang | Ticker | Bucket | Score réaliste | Ancien E2b | n déc. | n obs. | Rend.% | Prof.% | Confiance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | _aucun_ | — | — | — | — | — | — | — | — |

**Garde-fous**

```json
{
  "exploitableForTop20Count": 9,
  "exploitableMinScore": 35,
  "exploitableMinN": 10,
  "realisticMinSelectedTradeCount": 5,
  "realisticMinSelectedYieldPct": 0.5,
  "realisticMaxDeepAssignmentRatePct": 50,
  "realisticConfirmMinSelectedTradeCount": 3,
  "realisticConfirmMinObservationResolved": 15,
  "strictEligibleForTop20Count": 9,
  "confirmEligibleForTop20Count": 11,
  "strictInTop20Count": 9,
  "confirmInTop20Count": 11
}
```

## Pas de second classement

```json
{
  "top20Realistic": null,
  "realisticTop20": null,
  "confirmTop20": null
}
```

## Tests / build

- `node --test app/journal/*.test.mjs` — 164 tests (155 existants + 9 J5-B6) ✓
- `npx vite build` (wheel-dashboard) ✓
- `git diff --check` ✓

## Limites

- Score réaliste, capture Journal POP, scanner/IBKR/Yahoo, Archive Funnel, DB et formules POP : **non touchés**.
- Le remplissage « à confirmer » est volontairement subordonné aux stricts ; un confirm ne passe jamais devant un strict.
- Les candidats à confirmer portent une confiance faible — à ne pas traiter comme des admissibles solides.
- Le journal local de ce checkout n'a aucun record résolu (Top 20 réel vide) ; la mécanique est prouvée sur jeu synthétique. Sur un journal résolu, le même comportement s'applique.
