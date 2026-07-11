# Validation patch AF-05 — Tie-break déterministe

## 1. Résumé

Correctif ciblé appliqué dans `wheel-dashboard/src/capitalComboPortfolio.js` uniquement.

- **Problème** : à égalité complète des critères métier, le gagnant dépendait de l'ordre d'entrée.
- **Solution** : helper unique `compareCapitalComboCandidatesStable(a, b)` branché comme **dernier** critère dans le tri du pool et dans les duels greedy (principale, filler, leftover).
- **Tests AF-05** : 26/26 PASS.
- **AF-02** : 6/6 PASS.
- **AF-03** : 15/15 PASS (TEST 15 actualisé pour refléter le comportement AF-05 voulu).
- **Spread** : 15/15 PASS.
- **Build** : PASS.

## 2. Cause exacte

Combinaison de :

1. tri **stable** JavaScript sur `scoredStaging`;
2. comparaisons strictes `>` dans `pickBestCandidate` / filler / leftover;
3. absence de départage canonique final;
4. conservation implicite du **premier** candidat rencontré;
5. ordre d'entrée pouvant provenir du tri ou des filtres UI.

## 3. État Git initial

| Champ | Valeur |
|---|---|
| Racine | `C:/Users/melan/Desktop/wheel-mcp-remote` |
| HEAD | `92444e4 fix capital combo POP and selected-leg grade resolution` |
| Branch | `main...origin/main` |
| Fichiers suivis modifiés avant patch | aucun |

## 4. Chemins de sélection concernés

| Chemin | Fonction |
|---|---|
| Tri pool scoré | `scoredStaging.sort` |
| Passe principale | `pickBestCandidate(false)` |
| Passe soft-cap | `pickBestCandidate(true)` |
| Passe filler | `pickBestFillerCandidate` |
| Passe leftover | `pickBestDensityLeftoverCandidate` |

## 5. Comportement avant

| Ordre d'entrée | Gagnant (avant) |
|---|---|
| `[AAPL, MSFT]` | AAPL |
| `[MSFT, AAPL]` | MSFT (extrapolation analytique) |
| `[CRM, ORCL]` | CRM (preuve exécutée directe au commit 92444e4) |
| `[ORCL, CRM]` | ORCL (preuve exécutée directe au commit 92444e4) |

Quatre tickers égaux : le premier de l'ordre d'entrée gagnait.

**Caveat documentaire** : la preuve « avant » pour `[MSFT, AAPL] → MSFT` n'a pas été exécutée directement sur le commit `92444e4`, car aucun checkout n'a été effectué. Elle est déduite du code pré-patch et du mécanisme de tri stable. La preuve exécutée directe de l'ancien comportement ordre-dépendant est le cas CRM/ORCL du TEST 15 au commit `92444e4`.

## 6. Correctif appliqué

Nouveau helper exporté :

```js
compareCapitalComboCandidatesStable(a, b)
```

Branché uniquement **après** égalité de tous les critères métier existants dans chaque comparateur.

## 7. Clé canonique de départage

1. `ticker` normalisé `UPPER` croissant
2. `strike` sélectionné croissant
3. `mode` : SAFE < BALANCED < AGGRESSIVE < autres
4. clé stable : `expiration|capitalPerContract|premiumPerContract|finalDisplayGrade|source`

## 8. Comparateur du pool scoré

**Avant** : pas de tie-break final → ordre d'entrée conservé.

**Après** : `compareCapitalComboCandidatesStable(a, b)` en dernier critère du `sort`.

## 9. Duel greedy

**Avant** : `marginalScore >` puis `allocScore >` → premier gagnant à égalité.

**Après** : branche stable si `marginalScore` **et** `allocScore` égaux.

## 10. Passe principale

Résultat identique sur pool inversé 4 tickers : `AAPL, GOOGL` dans les deux sens.

## 11. Passe soft-cap

**NON REPRODUCTIBLE SANS ALTÉRER UNE AUTRE RÈGLE** avec fixture isolée à égalité parfaite (conflit avec les caps métier).

## 12. Passe filler

Ordre indépendant quand `filler_primary` est atteint ; sinon le tie-break principal suffit.

## 13. Passe leftover

Ordre indépendant quand `leftover_density_v2` est atteint (flags via `optimizerV2` uniquement).

## 14. Cas AAPL / MSFT

| Ordre | Avant | Après | Tie-break |
|---|---|---|---|
| `[AAPL, MSFT]` | AAPL | AAPL | non requis |
| `[MSFT, AAPL]` | MSFT | **AAPL** | oui |

## 15. Permutations multiples

24 permutations heap sur `AAPL, GOOGL, MSFT, ORCL` → même portefeuille et même ordre `AAPL, GOOGL`.

## 16. Même ticker et strikes différents

Strike **inférieur d'abord** (égalité totale uniquement).

## 17. Modes SAFE / BALANCED / AGGRESSIVE

Ordre canonique : SAFE < BALANCED < AGGRESSIVE. Clé uniquement — aucune préférence financière ajoutée.

## 18. Compatibilité future balancedLeg

Le helper lit `finalDisplayMode` et le strike sélectionné sans branche SAFE/AGGRESSIVE rigide. Compatible `selectedMode = "BALANCED"`.

## 19. Préservation AF-02

Tests POP null / zéro / connu : **6/6 PASS**. Aucune modification de `normalizeOptionalPopDecimal` ni `getLegPopPct`.

## 20. Préservation AF-03

Tests grade jambe sélectionnée : **15/15 PASS**. TEST 15 a été actualisé pour refléter le comportement AF-05 voulu : les deux ordres CRM/ORCL donnent CRM. Le harnais Fable reste la preuve historique de l'ancien défaut.

## 21. Matrice de tests

| ID | Sujet | Résultat |
|---|---|---|
| 1 | AAPL/MSFT égalité | PASS |
| 2 | 4 tickers | PASS |
| 3 | 24 permutations | PASS |
| 4 | score différent | PASS |
| 5 | allocScore différent | PASS |
| 6 | rendement différent | PASS |
| 7 | spread différent | PASS |
| 8 | distance différente | PASS |
| 9 | grade jambe | PASS |
| 10 | sourceGrade inversé | PASS |
| 11 | même ticker strikes | PASS |
| 12 | modes SAFE/BAL/AGG | PASS |
| 13 | duel greedy | PASS |
| 14 | passe principale | PASS |
| 15 | soft-cap | NON REPRODUCTIBLE |
| 16 | filler | PASS conditionnel |
| 17 | leftover | PASS conditionnel |
| 18–19 | AF-02 | PASS |
| 20–22 | AF-03 | PASS |
| 23 | deep-freeze | PASS |
| 24 | 20 répétitions | PASS |
| 25 | critères métier prioritaires | PASS |

## 22. Harnais Fable historique

`node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs`

- 43 checks : 31 PASS, 7 FAIL, 5 INFO
- **Aucune régression nouvelle non expliquée**
- Checks devenus obsolètes :
  - **T4a** (AF-05) — anomalie plus reproductible
  - **T15a/b/c** (AF-02)
  - **T2b/c, T3a** (AF-03 / AF-04 partiel)

## 23. Non-régressions financières

Inchangé lorsque les candidats ne sont **pas** parfaitement égaux :

- scores, grades, rendements, spreads, distances, POP, caps, filler, leftover, BALANCED, DTE, capital.

Seul changement : à **égalité complète**, gagnant et ordre indépendants de l'ordre d'entrée.

## 24. Fichiers modifiés

| Fichier | Action |
|---|---|
| `wheel-dashboard/src/capitalComboPortfolio.js` | modifié (+89 lignes) — moteur AF-05 |
| `wheel-dashboard/src/capitalComboPortfolio.deterministic-tiebreak.test.mjs` | créé — tests AF-05 |
| `wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs` | modifié — actualisation TEST 15 uniquement, sans modification du moteur AF-03 |
| `debug/capital-combinations-af05-patch-validation/capital-combinations-af05-patch-validation.md` | créé/mis à jour |
| `debug/capital-combinations-af05-patch-validation/capital-combinations-af05-patch-validation.json` | créé/mis à jour |

## 25. Limites

1. Passe soft-cap : non reproductible sans altérer une autre règle.
2. Compatibilité BALANCED : structurellement compatible, pas encore validée sur une vraie `balancedLeg`.

## 26. État Git final

```
git diff --name-only
wheel-dashboard/src/capitalComboPortfolio.js
wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs

git status -sb
## main...origin/main
 M wheel-dashboard/src/capitalComboPortfolio.js
 M wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs
?? wheel-dashboard/src/capitalComboPortfolio.deterministic-tiebreak.test.mjs
?? debug/capital-combinations-af05-patch-validation/
```

- **git add** : non
- **git commit** : non
- **git push** : non
