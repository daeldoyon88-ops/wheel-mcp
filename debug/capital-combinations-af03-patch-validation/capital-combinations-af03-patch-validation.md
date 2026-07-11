# Validation patch AF-03 - Grade de la jambe selectionnee

## 1. Resume

Patch AF-03 applique uniquement dans `wheel-dashboard/src/capitalComboPortfolio.js`.

Le moteur ne reprend plus `candidate.finalDisplayGrade` quand le grade explicite de la jambe bucket est absent. Il resout maintenant le grade depuis la jambe selectionnee.

## 2. Cause exacte

Chemin fautif :

```text
buildPortfolioCombos()
-> makeCombo()
-> bucketResolvedPool
-> resolvedGrade = bucketGrade ?? candidate.finalDisplayGrade
```

`candidate.finalDisplayGrade` peut venir de la classification principale du candidat, donc d'une jambe AGGRESSIVE, alors que le bucket SAFE utilise une jambe SAFE.

## 3. Comportement avant

Cas controle avant patch :

| Cas | Grade explicite jambe | Grade source | Grade derive attendu | Grade avant | Score avant | Pick avant |
|---|---:|---:|---:|---:|---:|---:|
| CRM safeGrade null | null | A | B | A | 69 | CRM |
| CRM safeGrade B | B | A | B | B | 68 | ORCL |

Le changement de presence de `safeGrade` suffisait a changer le portefeuille.

## 4. Correctif applique

Ajout de `resolveSelectedLegGrade(...)` :

```text
grade explicite de la jambe
-> sinon grade derive de selectedLeg
-> jamais candidate.finalDisplayGrade
```

Le score de tie local `_comboGradeScore` est aussi recalcule depuis le grade de jambe resolu, pour eviter une contamination residuelle par le grade source.

## 5. Resolution generique du grade

Ordre applique :

1. `explicitGrade` normalise, si present.
2. Pour `AGGRESSIVE`, `getAggressivePriorityGrade(...)` reste prioritaire quand aucun grade explicite n'existe.
3. Sinon `gradeLeg(...)` avec spread, rendement et POP de `selectedLeg`.
4. Si la jambe est absente : `null`.
5. Si les metriques de jambe sont insuffisantes : `WATCH`.

## 6. Compatibilite future BALANCED

Le helper accepte `selectedMode = "BALANCED"` et derive via `gradeLeg(...)`.

Aucun de ces champs n'a ete cree : `balancedLeg`, `balancedStrike`, `balancedGrade`, `balancedScore`.

La selection BALANCED actuelle reste limitee au choix existant entre jambe SAFE et jambe AGGRESSIVE.

## 7. Cas CRM contre ORCL

Apres patch :

| Cas | Grade explicite jambe | Grade source | Grade derive attendu | Grade apres | Score apres | Pick apres |
|---|---:|---:|---:|---:|---:|---:|
| CRM safeGrade null | null | A | B | B | 63 | ORCL |
| CRM safeGrade B | B | A | B | B | 63 | ORCL |

ORCL gagne dans les deux cas. CRM ne recoit plus la composante SAFE `A` de `+24`.

## 8. SAFE

SAFE utilise toujours exclusivement la jambe SAFE dans le bucket `conservative`.

Cas verifies :

- `safeGrade = A` : grade A conserve, composante SAFE `+24`.
- `safeGrade = B` : grade B conserve, composante SAFE `+17`.
- `safeGrade = null` avec jambe meritant B : grade derive B, pas de fallback source.
- jambe absente ou metriques insuffisantes : pas de substitution par le grade source.

## 9. AGGRESSIVE

`getAggressivePriorityGrade(...)` est conserve.

Cas verifies :

- `aggressiveGrade` explicite : grade explicite utilise.
- `aggressiveGrade` absent : grade derive depuis la jambe AGGRESSIVE.
- aucun fallback vers `candidate.finalDisplayGrade`.

## 10. BALANCED actuel

La regle de choix BALANCED n'a pas ete modifiee.

Cas verifies :

- BALANCED choisissant la jambe SAFE : strike et prime inchanges, grade derive depuis SAFE.
- BALANCED choisissant la jambe AGGRESSIVE : strike et prime inchanges, grade derive depuis AGGRESSIVE.

## 11. POP inconnu et preservation AF-02

AF-02 est preserve :

- `null`, `undefined`, chaine vide et `NaN` restent inconnus.
- `0` reste un vrai POP de 0 %.
- `0.86` et `86` representent 86 %.

Tests AF-02 : `6/6 PASS`.

## 12. Matrice de tests

Test cree :

```text
wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
```

Resultat :

```text
node --test wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
15/15 PASS
```

La matrice couvre SAFE, AGGRESSIVE, BALANCED actuel, future jambe BALANCED fictive, POP null, POP 0, sourceGrade inverse, jambe absente, metriques insuffisantes, et isolation du tie-break d'entree.

## 13. Resultats avant / apres

| Cas | Grade explicite jambe | Grade source | Grade derive attendu | Grade avant | Grade apres | Score avant | Score apres | Pick avant | Pick apres | Verdict |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CRM safeGrade null | null | A | B | A | B | 69 | 63 | CRM | ORCL | PASS |
| CRM safeGrade B | B | A | B | B | B | 68 | 63 | ORCL | ORCL | PASS |
| sourceGrade A/B/WATCH | null | variable | B | source-dependent | B | source-dependent | identique | source-dependent | identique | PASS |
| POP null | null | A | B | risque fallback | B | N/D | 69 | N/D | CRM | PASS |
| POP 0 | null | A | WATCH | risque fallback | WATCH | N/D | N/D | N/D | aucun pick | PASS |
| AGGRESSIVE missing | null | A | B | risque fallback | B | N/D | 65 | N/D | NFLX | PASS |
| BALANCED SAFE leg | null | A | B | risque fallback | B | N/D | 73 | N/D | CRM | PASS |
| BALANCED AGG leg | null | A | B | risque fallback | B | N/D | 73 | N/D | ORCL | PASS |

## 14. Harnais Fable historique

Commande :

```text
node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs
```

Resultat :

```text
43 checks; 32 PASS; 6 FAIL; 5 INFO; criticalConfirmed = 0
```

FAIL historiques :

| ID | Appartenance | Obsolete | Regression reelle |
|---|---|---:|---:|
| T2b | AF-03 | oui | non |
| T2c | AF-03 | oui | non |
| T3a | AF-03 / contamination grade source | oui | non |
| T15a | AF-02 | oui | non |
| T15b | AF-02 | oui | non |
| T15c | AF-02 | oui | non |

## 15. Non-regressions

Commandes executees :

```text
node --check wheel-dashboard/src/capitalComboPortfolio.js
node --check wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
node --test wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
node --test wheel-dashboard/src/capitalComboPortfolio.pop-null.test.mjs
node --test wheel-dashboard/src/spreadPctPercent.test.mjs
npm.cmd run build
```

Tous les tests ciblés passent. Le build Vite passe avec warnings connus `framer-motion` et chunk size.

Portefeuille SAFE runtime exact : Non verifiable avec le snapshot runtime disponible.

Le harnais Fable historique valide en revanche le scenario observe encode : capital total 25 400 $, capital libre 100 $, rendement 0,6118 %, remplissage 99,6078 %.

## 16. Fichiers modifies

Fichiers autorises modifies ou crees :

```text
wheel-dashboard/src/capitalComboPortfolio.js
wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
debug/capital-combinations-af03-patch-validation/capital-combinations-af03-patch-validation.json
debug/capital-combinations-af03-patch-validation/capital-combinations-af03-patch-validation.md
```

## 17. Limites

Non traite dans ce patch :

- AF-01 badge visuel.
- AF-04 / AF-05 tie-break ou departage.
- Creation d'une vraie jambe BALANCED.
- Scanner, backend, IBKR, Journal POP.
- Caps, filler, leftover, DTE, libelles support.

Le `pick.mode` peut donc encore afficher le mode source dans certains cas historiques.

## 18. Etat Git final

`git diff --name-only` :

```text
wheel-dashboard/src/capitalComboPortfolio.js
```

Nouveaux fichiers autorises non suivis :

```text
wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
debug/capital-combinations-af03-patch-validation/capital-combinations-af03-patch-validation.json
debug/capital-combinations-af03-patch-validation/capital-combinations-af03-patch-validation.md
```

Aucun `git add`, aucun commit, aucun push.

Le worktree contenait deja de nombreux fichiers non suivis hors scope; ils ont ete laisses intacts.
