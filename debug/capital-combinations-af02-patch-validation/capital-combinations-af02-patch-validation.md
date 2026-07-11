# Validation patch AF-02 — POP inconnu

## 1. Résumé

Patch ciblé sur `wheel-dashboard/src/capitalComboPortfolio.js`.

Objectif validé : un POP inconnu (`null`, `undefined`, champ manquant, `NaN`, chaîne vide, non numérique) reste inconnu et ne devient plus un vrai POP `0 %`. Un vrai `0` reste un `0 %`.

## 2. Cause du bug

`gradeLeg()` et `getAggressivePriorityGrade()` utilisaient une coercition du type `Number(popDecimal)`.

En JavaScript :

| Entrée | Ancienne coercition métier |
| --- | ---: |
| `null` | `0` |
| `""` | `0` |
| `86` | `8600 %` après multiplication par 100 |

Conséquence AF-02 : dans le chemin AGGRESSIVE, le grade dérivé `WATCH` pouvait être retenu avant le grade stocké `A`, puis le bucket pouvait rejeter le candidat comme `WATCH` non admissible.

## 3. Comportement avant

Reproduction minimale avant patch :

| Cas | POP input | POP normalisé avant | Grade avant | Pick avant |
| --- | --- | ---: | --- | --- |
| `null` | `null` | `0` | `WATCH` | non |
| `undefined` | `undefined` | inconnu | `A` | oui |
| manquant | champ absent | inconnu | `A` | oui |
| `NaN` | `NaN` | inconnu | `A` | oui |
| zéro réel | `0` | `0` | `WATCH` | non |
| décimal | `0.86` | `86` | `A` | oui |
| max décimal | `1` | `100` | `A` | oui |
| chaîne vide | `""` | `0` | `WATCH` | non |
| non numérique | `"abc"` | inconnu | `A` | oui |
| pourcentage | `86` | `8600` | `A` | oui |

Cas AGGRESSIVE contrôlé avant patch :

| Variante | Grade stocké | Grade bucket construit | Pick |
| --- | --- | --- | --- |
| POP `0.86` | `A` | `A` | oui |
| POP `null` | `A` | `WATCH` | non |

## 4. Correctif appliqué

Ajout d’une normalisation explicite :

- `normalizeOptionalPopDecimal(value)` : retourne `null` pour inconnu, conserve `0`, conserve les décimaux, convertit `86` vers `0.86`.
- `firstKnownOptionalPopDecimal(...)` : parcourt les champs POP candidats sans confondre `0` et inconnu.
- `normalizeOptionalPopPct(value)` : convertit la valeur décimale normalisée vers l’unité pourcentage attendue par les seuils de grade.

Fonctions touchées :

- `gradeLeg`
- `getAggressivePriorityGrade`
- `getFinalDisplayRecommendation`
- `getLegPopPct`
- `buildCapitalComboCandidate`

Aucun changement de priorité générale entre grade stocké, grade dérivé et priorityGrade n’a été nécessaire : une fois `null` conservé comme inconnu, le grade dérivé redevient `A` dans le cas contrôlé.

## 5. Compatibilité future BALANCED

Le correctif POP est mode-agnostique et pourra être utilisé par une future jambe BALANCED explicite.

Test direct avec un objet fictif `{ mode: "BALANCED" }` :

| Cas | Résultat |
| --- | ---: |
| POP inconnu | `null` |
| POP `0.86` | `86` |
| `popProfitEstimated: ""`, `popEstimate: 0.86` | `86` |

Aucune `balancedLeg`, aucun champ BALANCED explicite et aucune logique de sélection BALANCED n’ont été créés.

## 6. Matrice de tests

Résultat après patch :

| Cas | POP input | POP normalisé | Grade avant | Grade après | Pick avant | Pick après | Verdict |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| `null` | `null` | inconnu | `WATCH` | `A` | non | oui | PASS |
| `undefined` | `undefined` | inconnu | `A` | `A` | oui | oui | PASS |
| manquant | champ absent | inconnu | `A` | `A` | oui | oui | PASS |
| `NaN` | `NaN` | inconnu | `A` | `A` | oui | oui | PASS |
| zéro réel | `0` | `0 %` | `WATCH` | `WATCH` | non | non | PASS |
| décimal | `0.86` | `86 %` | `A` | `A` | oui | oui | PASS |
| max décimal | `1` | `100 %` | `A` | `A` | oui | oui | PASS |
| chaîne vide | `""` | inconnu | `WATCH` | `A` | non | oui | PASS |
| non numérique | `"abc"` | inconnu | `A` | `A` | oui | oui | PASS |
| pourcentage | `86` | `86 %` | `A` | `A` | oui | oui | PASS |

## 7. Cas AGGRESSIVE

Cas contrôlé :

- jambe AGGRESSIVE valide ;
- grade stocké `A` ;
- spread valide ;
- rendement valide ;
- distance valide.

Résultat après patch :

| POP | Grade bucket | Pick | POP pick |
| ---: | --- | --- | ---: |
| `0.86` | `A` | oui | `86` |
| `null` | `A` | oui | `null` |
| `0` | `WATCH` | non | n/a |

## 8. Cas SAFE

Cas contrôlé SAFE :

| POP | Mode pick | Grade pick | Pick | POP pick |
| ---: | --- | --- | --- | ---: |
| `0.86` | `SAFE` | `A` | oui | `86` |
| `null` | `SAFE` | `A` | oui | `null` |

Aucune substitution vers une autre jambe n’a été observée dans ce test.

## 9. Cas POP réel égal à zéro

`POP = 0` reste une valeur connue :

- normalisation décimale : `0`;
- normalisation pourcentage : `0 %`;
- grade contrôlé : `WATCH`;
- candidat AGGRESSIVE contrôlé : non sélectionné.

## 10. Non-régressions

POP présents testés : `0.80`, `0.86`, `0.92`, `0.99`.

Résultat : grade `A`, ticker sélectionné inchangé dans le cas contrôlé, `capitalRequired = 5000`, `premiumCollected = 300`, `totalCapital = 25000`, `freeCapital = 25000`.

Zones non modifiées :

- backend ;
- IBKR ;
- scanner ;
- Journal POP ;
- `dashboard.jsx` ;
- `capitalComboEngineV2.js` ;
- `alternativeCompositionSimV1.js` ;
- caps de capital ;
- tie-break ;
- soft-cap ;
- `freeCapital` ;
- rendement ;
- DTE ;
- fallback BALANCED existant.

Snapshot SAFE observé dans le harnais Fable :

| Mesure | Résultat |
| --- | ---: |
| capital utilisé | `25400` |
| capital libre | `100` |
| rendement approx. | `0.6118 %` |
| remplissage | `99.6078 %` |

## 11. Résultats du harnais existant

Commande :

```powershell
node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs
```

Résultat :

- exit code `0`;
- checks `43`;
- pass `35`;
- fail `3`;
- info `5`;
- `criticalConfirmed = 0`.

Les trois `FAIL` sont `T15a`, `T15b`, `T15c`. Ce sont les anciens checks qui confirmaient AF-02 ; ils changent parce que le défaut est corrigé. Les autres vérifications restent stables.

## 12. Fichiers modifiés

- `wheel-dashboard/src/capitalComboPortfolio.js`
- `wheel-dashboard/src/capitalComboPortfolio.pop-null.test.mjs`
- `debug/capital-combinations-af02-patch-validation/capital-combinations-af02-patch-validation.json`
- `debug/capital-combinations-af02-patch-validation/capital-combinations-af02-patch-validation.md`

## 13. Limites

Ce patch ne corrige pas AF-01, AF-03, AF-04.

Le rapport ne prétend pas valider un snapshot live complet Yahoo/IBKR ; les résultats financiers SAFE `25400 / 100 / 0.61 % / 99.6 %` proviennent du harnais Fable existant.

## 14. État Git final

Commandes de validation exécutées :

```powershell
node --check wheel-dashboard/src/capitalComboPortfolio.js
node --check wheel-dashboard/src/capitalComboPortfolio.pop-null.test.mjs
node --test wheel-dashboard/src/capitalComboPortfolio.pop-null.test.mjs
node --test wheel-dashboard/src/spreadPctPercent.test.mjs
node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs
npm.cmd run build
```

Résultats :

- test AF-02 : `6/6 PASS`;
- test existant spread : `15/15 PASS`;
- build Vite : PASS avec warnings non bloquants `framer-motion` et chunk size ;
- aucun `git add`, commit ou push.

`git diff --name-only` liste uniquement le fichier tracked modifié :

```text
wheel-dashboard/src/capitalComboPortfolio.js
```

Les nouveaux test et rapports sont des fichiers untracked autorisés.
