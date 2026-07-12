# Validation patch UI Capital Combinations — AF-01 / AF-13 / AF-14 / AF-16

## 1. État Git initial

- **HEAD** : `2559972 fix AF-18 centralize optimizer V2 flags resolution`
- **Branche** : `main...origin/main`

## 2. Cause AF-01

`createPick` projetait `mode: candidate.finalDisplayMode` (recommandation scanner) au lieu de la jambe bucket réellement retenue.

## 3. Correction AF-01

- `_capitalComboMode` et `_bucketFallbackUsed` sur candidat bucket
- Pick expose : `bucketMode`, `selectedLegMode`, `scannerMode`, `fallbackUsed`
- Legacy : `pick.mode` inchangé (`finalDisplayMode`)
- Badge UI : `Jambe SAFE/AGG · Grade X` + contexte `Bucket BALANCED`

## 4. Politique mode / bucket / jambe

| Champ | Signification |
|-------|---------------|
| bucketMode | Carte SAFE / BALANCED / AGGRESSIVE |
| selectedLegMode | Jambe SAFE ou AGGRESSIVE retenue |
| scannerMode | finalDisplayMode historique |
| mode | Legacy = scannerMode |

## 5. Cause AF-13

`allowedModes` affiché comme filtre actif sans effet moteur.

## 6. Correction AF-13

Suppression de `modes SAFE/AGGRESSIVE` dans l'Inspector. Aucun filtre moteur ajouté.

## 7. Confirmation aucun filtre moteur

0 lecture `allowedModes.has()` dans le moteur.

## 8. Cause AF-14

Inspector recalculait BALANCED avec rendement de période (logique inline).

## 9. Correction AF-14

`resolveCapitalComboInspectorLegView` + `resolveBucketLegForPresentation` (AF-17 / AF-07).

## 10. Source de vérité Inspector

1. Pick runtime
2. Résolution bucket moteur
3. Legacy marqué explicitement

## 11. Fallback legacy

`Estimation legacy — sans pick runtime` si aucune jambe bucket.

## 12. Cause AF-16

Labels trompeurs (Mode, Rend. moy. / sem., RISQUE).

## 13. Labels avant/après

| Zone | Avant | Après |
|------|-------|-------|
| Colonne modal | Mode / Grade | Jambe / Grade |
| Ligne pick | rendement | Rend. hebdo. |
| Carte résumé | Rend. moy. % / sem. | Prime / capital |
| Carte risque | RISQUE | CONCENTRATION |
| Ligne capital | capital total | Collatéral ligne |

## 14. Valeurs numériques

**Inchangées** — projection et labels seulement.

## 15–21. Impacts moteur

Score, ordre, picks financiers, contrats, capitalUsed, allocation, caps : **aucun changement**.

## 22. Persistance

Champs JSON facultatifs sur pick (`bucketMode`, `selectedLegMode`, `scannerMode`, `fallbackUsed`).

## 23. Tests UI

- `capitalComboPortfolio.ui-mode-metadata.test.mjs` : 11 tests
- `capitalComboUiPresentation.test.mjs` : 3 tests

## 24. Non-régressions

**417/417** pass — negative-spread, pick-line-capital, free-capital, soft-cap, pop-null, selected-leg-grade, deterministic-tiebreak, input-pool, balanced-fallback, AF-17, AF-18, pick-metadata, etc.

## 25. Fable

N/A — pas de harness fable dédié dans le repo.

## 26. Build

`npm run build` : OK

## 27. Limites

Pas de test navigateur ; Inspector fallback legacy conservé pour données incomplètes.

## 28. git diff final

- `wheel-dashboard/src/capitalComboPortfolio.js`
- `wheel-dashboard/src/dashboard.jsx`

## 29–31. Confirmations

- Aucun git add
- Aucun commit
- Aucun push

## 32. Verdict final

**PATCH APPLIED — SAFE TO COMMIT**
