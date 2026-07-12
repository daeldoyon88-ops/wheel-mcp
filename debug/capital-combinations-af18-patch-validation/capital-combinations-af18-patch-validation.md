# AF-18 — Validation du patch (flags Optimizer V2 / localStorage)

**Date :** 2026-07-12  
**HEAD :** `61bfde3 fix AF-17 weekly normalized yield bands`  
**Verdict :** `PATCH APPLIED — SAFE TO COMMIT`

---

## 1. État Git initial

| Contrôle | Résultat |
|----------|----------|
| HEAD | `61bfde3 fix AF-17 weekly normalized yield bands` |
| Branche | `main...origin/main` |
| Diff pré-patch | vide |

---

## 2. Cause racine

`buildPortfolioCombos` était appelé **sans** `options.optimizerV2` par le dashboard. Le moteur tombait alors dans `getCapitalOptimizerV2Flags()` qui lisait silencieusement `localStorage["wheelCapitalComboOptimizerV2Flags"]` avec un parsing JSON laxiste (`"false"` string truthy via `!== false`).

---

## 3. Architecture

### Avant

```
dashboard → buildPortfolioCombos(pool, capital, pct, pos, rejected)
         → resolveOptimizerV2ForCombo(undefined)
         → getCapitalOptimizerV2Flags() → localStorage
```

### Après (OPTION A)

```
dashboard → readCapitalOptimizerV2FlagsFromLocalStorage()  [runtime]
         → buildPortfolioCombos(..., { optimizerV2 })
         → resolveCapitalOptimizerV2Flags()  [pur, normalisé]
```

---

## 4. Clé et flags (6)

| Flag | Type | Défaut |
|------|------|--------|
| `leftoverDensityPassEnabled` | bool | `true` |
| `safeLeftoverDensityPassEnabled` | bool | `false` |
| `capDiagnosticsEnabled` | bool | `true` |
| `maxLeftoverIterations` | int 1–100 | `22` |
| `leftoverMinPctOfUsable` | float 0–1 | `0.012` |
| `leftoverMinAbsoluteUsd` | float 0–1M | `320` |

---

## 5. Parsing strict

- Booléens : `true`/`false`/`"true"`/`"false"`/`1`/`0`/`"1"`/`"0"` (trim, casse)
- Autre → défaut du flag
- Nombres : finis et dans bornes ; sinon défaut
- JSON invalide ou non-objet → défauts, pas de crash
- Clés inconnues ignorées
- Objets immutables (frozen) ; pas de mutation defaults/input

---

## 6. Priorité

1. `options.optimizerV2` explicite (normalisé)
2. Dashboard runtime (localStorage lu une fois)
3. `CAPITAL_COMBO_OPTIMIZER_DEFAULTS`

`optimizerV2: {}` → defaults ; **ne lit pas** localStorage.

---

## 7. Impacts mesurés

| Dimension | Changé ? |
|-----------|----------|
| Score / ordre / picks / contrats / capital | **Non** (pool harness) |
| flagsSnapshot / trace | **Oui** (normalisation visible) |
| Allocation | **Non démontré** |

---

## 8. Tests

| Suite | Pass | Fail |
|-------|------|------|
| AF-18 flags | 54 | 0 |
| AF-18 intégration | 12 | 0 |
| Non-régressions (batch) | 333 | 0 |
| Backend free-capital | 5 | 0 |
| **Total** | **404** | **0** |

- **Build Vite :** PASS  
- **Fable audit :** exit 0 (FAIL préexistants T15c AF-02 inchangés)

---

## 9. Fichiers touchés

**Modifiés :**
- `wheel-dashboard/src/capitalComboEngineV2.js`
- `wheel-dashboard/src/capitalComboPortfolio.js`
- `wheel-dashboard/src/dashboard.jsx`

**Créés :**
- `wheel-dashboard/src/capitalComboEngineV2.flags.test.mjs`
- `wheel-dashboard/src/capitalComboPortfolio.optimizer-flags.test.mjs`
- `debug/capital-combinations-af18-patch-validation/*`

---

## 10. Confirmations

- Aucun `git add`
- Aucun commit
- Aucun push
- Aucun fichier suivi hors portée modifié
- AF-17 / bandes / allocation greedy inchangés

---

## 11. Recommandation commit

Message suggéré :

```
fix AF-18 centralize optimizer V2 flags resolution

Dashboard reads localStorage once and passes normalized optimizerV2;
pure engine resolver with strict bool/number parsing; no silent
localStorage in buildPortfolioCombos.
```
