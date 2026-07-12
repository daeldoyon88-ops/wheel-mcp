# Validation patch AF-09 — Capital libre déployable

## 1. Résumé

Le patch AF-09 aligne `freeCapital` sur le reliquat du **capital déployable**
(`usableCapital − capitalUtilisé`), et non plus sur le capital total du compte.
L'allocation, les picks, les contrats et les caps restent inchangés.

## 2. État Git initial

- Racine : `C:/Users/melan/Desktop/wheel-mcp-remote`
- HEAD : `30105a8` — fix capital combo soft cap dollar limits
- Branche : `main...origin/main` synchronisée
- Aucun fichier suivi modifié avant patch

## 3. Définition métier

```text
usableCapital = capitalTotal × maxCapitalPct / 100
freeCapital = max(0, usableCapital − capitalUtilisé)
```

La réserve volontairement non déployable est exclue de `freeCapital`.

## 4. Architecture avant patch

| Couche | Formule avant |
|---|---|
| Moteur `makeCombo` | `capital − used` (brut) |
| Simulateur alt. | `grossCapital − used` |
| UI modale/cartes | `usableCapital − totalCapital` (déjà correct) |
| Inspector | `combo.freeCapital` (brut si pct<100) |
| Audit backend | `accountCapital − capitalUsed` |
| SQLite | `capital_free` via audit (brut si pct<100) |

## 5. Moteur principal

**Fichier :** `wheel-dashboard/src/capitalComboPortfolio.js`  
**Ligne :** ~3365 (`makeCombo` return)

```js
freeCapital: Math.max(0, usableCapital - used)
```

## 6. Simulateur alternatif

**Fichier :** `wheel-dashboard/src/alternativeCompositionSimV1.js`  
**Fonction :** `buildCompositionSnapshot`

```js
freeCapital: Math.max(0, usableCapital - used)
```

## 7. UI principale

Modale et cartes : recalcul `usableCapital − combo.totalCapital` **inchangé**
(résultat financier identique).

## 8. Inspector

**Fichier :** `dashboard.jsx` — `_inspCandidateDiag`  
Utilise `combo.freeCapital` corrigé, avec repli `capital − combo.totalCapital`
(le paramètre `capital` est déjà le déployable dans l'Inspector).

## 9. Payload snapshot

**Fichier :** `dashboard.jsx` — `handleSaveSnapshot`

Champs ajoutés au payload racine :

- `maxCapitalPct`
- `deployableCapital`
- `usableCapital`

Champs mode enrichis :

- `capitalUsed` (alias de `totalCapital`)

## 10. Backend audit

**Fichier :** `app/capital/capitalCombinationAuditService.js`

Nouvelle fonction `resolveDeployableCapital` :

1. `deployableCapital` / `usableCapital` explicite
2. sinon `accountCapital × maxCapitalPct / 100`
3. sinon `accountCapital` (legacy 100 %)

```js
capitalFree = max(0, deployableCapital - capitalUsed)
```

Le backend **recalcule** et ne fait pas confiance au `freeCapital` client.

## 11. Compatibilité anciens payloads

Snapshots sans `maxCapitalPct` ni `deployableCapital` : fallback 100 % déployable.
Comportement identique à l'historique pour les captures à 25 500 $ / 100 %.

## 12. SQLite

Schéma **inchangé**. `capital_free` stocke désormais la valeur corrigée
lorsque le payload moderne inclut `maxCapitalPct` / `deployableCapital`.

## 13. Cas 100 %

25 500 $, 100 %, SAFE utilisé 24 800 $ → libre **700 $** (inchangé).

## 14. Cas 50 %

50 000 $, 50 %, usable 25 000 $, SAFE utilisé 24 800 $ → libre **200 $**
(anciennement ~25 200 $).

## 15. Cas 25 %

40 000 $, 25 %, usable 10 000 $, SAFE utilisé 3 900 $ → libre **6 100 $**
(anciennement ~36 100 $).

## 16. SAFE

Formule `usable − used` validée (tests AF-09 TEST 6).

## 17. BALANCED

Formule validée quand picks présents (TEST 7).

## 18. AGGRESSIVE

Formule validée quand picks présents (TEST 8).

## 19. Invariants

Pour chaque combo :

- `0 ≤ freeCapital ≤ usableCapital`
- `totalCapital + freeCapital ≈ usableCapital` (tolérance 0,02 $)

## 20. Tests AF-09

Fichier : `wheel-dashboard/src/capitalComboPortfolio.free-capital.test.mjs`  
**15/15 PASS**

## 21. Anciens tests ajustés

Aucun. Tous les tests legacy passent sans modification d'assertion.

## 22. Non-régressions

| Suite | Résultat |
|---|---|
| AF-08 soft-cap | 27/27 PASS |
| AF-02 pop-null | 6/6 PASS |
| AF-03 selected-leg-grade | 15/15 PASS |
| AF-05 deterministic-tiebreak | 26/26 PASS |
| AF-06 inputPool | 22/22 PASS |
| AF-07 balanced-fallback | 30/30 PASS |
| spread | 15/15 PASS |
| Backend AF-09 | 5/5 PASS |

## 23. Fable

Baseline avant : 30 PASS / 8 FAIL / 5 INFO  
Après patch : **29 PASS / 9 FAIL / 5 INFO**

| ID | Avant | Après | Interprétation |
|---|---|---|---|
| T9a | PASS (défaut confirmé) | FAIL | Check historique obsolète — `freeCapital=15000` = attendu |

Pas de régression réelle. Les 8 autres FAIL sont préexistants (AF-01/02/03/04/06/15).

## 24. Build

`npm.cmd run build` depuis `wheel-dashboard` : **PASS**  
Warnings framer-motion préexistants seulement.

## 25. Fichiers modifiés

- `wheel-dashboard/src/capitalComboPortfolio.js`
- `wheel-dashboard/src/alternativeCompositionSimV1.js`
- `wheel-dashboard/src/dashboard.jsx`
- `app/capital/capitalCombinationAuditService.js`

## 26. Fichiers créés

- `wheel-dashboard/src/capitalComboPortfolio.free-capital.test.mjs`
- `app/capital/capitalCombinationAuditService.free-capital.test.mjs`
- `debug/capital-combinations-af09-patch-validation/capital-combinations-af09-patch-validation.md`
- `debug/capital-combinations-af09-patch-validation/capital-combinations-af09-patch-validation.json`

## 27. Limites

- `capitalPct` dans le combo reste basé sur le capital brut (hors périmètre AF-09).
- Schéma SQLite sans colonne `max_capital_pct` — rétrocompatibilité via fallback 100 %.
- `node --check dashboard.jsx` non applicable (extension JSX).

## 28. État Git final

4 fichiers modifiés, 2 fichiers de test créés, 2 rapports créés.
Aucun git add / commit / push.

## 29. Verdict

**SAFE TO COMMIT**
