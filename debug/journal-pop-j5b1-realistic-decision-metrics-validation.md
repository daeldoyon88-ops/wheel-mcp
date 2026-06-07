# Validation J5-B1 — Métriques « décision réelle » additives (Journal POP)

> Phase J5-B1 · 2026-06-07 · **additif uniquement** — aucun score, tri ni verdict modifié.

## Objectif

Ajouter au service Journal POP des métriques « décision réelle » (1 décision théorique
par ticker × `selectedExpiration`, politique **BALANCED**) pour chaque profil
Top 20 / Objectif 1%+, **sans** créer de second classement, **sans** modifier le
classement actuel, **sans** toucher les scores/tris/verdicts existants.

## Fichiers modifiés

| Fichier | Nature | Lignes |
| --- | --- | --- |
| `app/journal/wheelValidationService.js` | Modifié (additif) | +199 |

## Fichiers créés

| Fichier | Nature |
| --- | --- |
| `app/journal/wheelValidationService.realisticDecisionMetrics.test.mjs` | Tests unitaires |
| `debug/journal-pop-j5b1-realistic-decision-metrics-validation.md` | Rapport |
| `debug/journal-pop-j5b1-realistic-decision-metrics-validation.json` | Rapport machine |

## Fonctions ajoutées

Toutes dans `app/journal/wheelValidationService.js` :

- **`computeRealisticDecisionMetrics(records, options)`** — *exportée*. Réduit les
  observations résolues (hors `intradayRetest`) à 1 décision par ticker × `selectedExpiration`
  puis calcule les métriques `selected*` + duplication.
- `selectBalancedRealisticDecision(candidates)` — sélection BALANCED déterministe d'1 observation par groupe (exposée via `__testables__`).
- `realisticDecisionRiskTier(record)` — hiérarchie résultat/risque : 0 non assigné < 1 proche < 2 modérée < 3 profonde.
- `realisticDecisionNormMode(record)` — normalisation SAFE / AGGRESSIVE / OTHER.
- `realisticDecisionExpirationKey(record)` — clé d'expiration (`selectedExpiration`).
- `realisticDecisionStableCompare(a, b)` — départage déterministe par `id`.
- `computeRealisticDecisionWinRatePct(records)` — win rate sur la base décision.

### Politique BALANCED implémentée (ordre de priorité)

1. non assigné → 2. assigné proche → 3. assigné modéré → 4. assigné profond ;
5-6. rendement CSP ≥ 0,5 % préféré puis rendement plus élevé ;
7. DTE 7 ou 4 préféré avant 3/2 à résultat comparable ;
8. SAFE préféré à AGRESSIF si écart de rendement ≤ 0,15 % ;
9. sinon première observation déterministe (`id`).

## Champs ajoutés

Bloc additif `realisticDecisionMetrics` attaché à **chaque profil ticker** (via
`buildOnePercentProfile`) et **porté sur chaque ligne Top 20** (via
`mapDynamicTop20ProfileRow`) :

```
realisticDecisionMetrics: {
  policy: "BALANCED",
  selectedTradeCount,
  selectedAssignedCount,
  selectedAssignmentRatePct,
  selectedNearAssignmentCount,
  selectedModerateAssignmentCount,
  selectedDeepAssignmentCount,
  selectedDeepAssignmentRatePct,
  selectedWinRatePct,
  selectedAvgCspYieldPct,
  selectedMedianCspYieldPct,
  selectedAvgDepthPct,
  selectedModeSplit,        // { SAFE, AGGRESSIVE, OTHER }
  selectedDteSplit,         // { [dte]: count }
  duplicationRatio,         // observationResolvedCount / selectedTradeCount
  observationResolvedCount,
  observationAssignedCount,
  distinctExpirationCount
}
```

Aucun champ existant supprimé ou remplacé : `recordsResolved`, `assignmentRate`,
`avgYieldPct`, `onePercentObjective`, `dynamicTop20Score`, `dynamicTop20Status`,
`scoreReasons`, etc. restent intacts.

## Preuve « Top 20 score/tri non modifié »

1. **Aucun usage en amont du score** : `realisticDecisionMetrics` n'est lu par
   aucune des fonctions de scoring/tri (`scoreOnePercentProfileForSort`,
   `computeDynamicTop20LaboratoryScore`, pipeline E2b, comparateurs `sort`). Le bloc
   est uniquement écrit en sortie.
2. **Test automatisé d'additivité** : `computeDynamicTop20WheelProfiles` est calculé
   avec puis sans le bloc `realisticDecisionMetrics` (retiré des profils) → l'ordre
   et les `dynamicTop20Score` de `top20 + nearEntry + watchValidate + insufficientSample`
   sont **identiques** (`assert.deepEqual`).
3. **Script J5-A inchangé** : `node debug/journal-pop-j5a-top20-realistic-decision-audit.mjs`
   tourne toujours et produit les **mêmes chiffres** (1628 obs → 385 décisions BALANCED,
   assignation 15,3 %, profondeur 30,5 %, win 84,7 %, rendement 0,95 %, dup 4,23×).
4. **Parité de l'agrégat global** : `computeRealisticDecisionMetrics` sur l'ensemble
   éligible réel reproduit exactement la politique BALANCED de l'audit J5-A
   (1628 → 385, 15,3 % / 30,5 % / 84,7 % / 0,95 % / 4,23×).

## Tests ajoutés

`app/journal/wheelValidationService.realisticDecisionMetrics.test.mjs` (9 tests) :

- déduplication SAFE/AGRESSIF/DTE même ticker×expiration → `selectedTradeCount = 1` ;
- `duplicationRatio > 1` quand plusieurs observations pour une expiration ;
- BALANCED préfère non assigné à assigné ;
- BALANCED préfère assignation proche à profonde ;
- BALANCED préfère SAFE si rendement ≈ équivalent (≤ 0,15 %) ;
- BALANCED choisit AGRESSIF si rendement nettement supérieur (> 0,15 %) ;
- `selectedAssignmentRatePct` basé sur `selectedTradeCount`, pas sur les observations ;
- `intradayRetest` et records non résolus exclus du pool ;
- **additivité** : champ présent + `dynamicTop20Score`/tri inchangés.

## Résultats tests / build

- `node --test app/journal/*.test.mjs` → **138 pass / 0 fail**.
- `node --test app/journal/wheelValidationService.realisticDecisionMetrics.test.mjs` → **9 pass / 0 fail**.
- `npx vite build` (wheel-dashboard) → **✓ built** (aucune erreur).
- `git diff --check` → **OK** (aucun conflit / trailing whitespace).
- `node debug/journal-pop-j5a-top20-realistic-decision-audit.mjs` → OK, chiffres inchangés.

## Contraintes respectées

- `dynamicTop20Score`, `dynamicTop20Status`, tri Top 20, verdicts, formules POP,
  Objectif 1 %+, scanner, IBKR/Yahoo, Archive Funnel : **non touchés**.
- DB : **non modifiée**, **aucun backfill**.
- Aucun `git add`, aucun commit.
- Fichiers modifiés limités à `app/journal/wheelValidationService.js` (+ nouveaux fichiers).

## Limites restantes

- **Post-mortem** : la sélection BALANCED peut s'appuyer sur le résultat observé
  (assignation / profondeur) pour départager les variantes. Légitime **uniquement** en
  analyse post-analyse — ces champs ne doivent **jamais** alimenter le score live actuel
  (documenté dans le JSDoc de la fonction). J5-B1 = métrique additive, pas changement de scoring.
- `duplicationRatio` (par ticker) = `observationResolvedCount / selectedTradeCount` —
  diffère de la « dup. assignée » de l'audit J5-A (obs.assign / exp.assign) ; les deux
  cohabitent sans conflit.
- Le bloc reste disponible mais n'est encore **consommé par aucun changement de
  classement** — c'est l'objet des phases J5-B2+ (à décider séparément).
