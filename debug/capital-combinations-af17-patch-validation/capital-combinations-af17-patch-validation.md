# Validation patch AF-17 — Rendement hebdomadaire normalisé

**Date :** 2026-07-12  
**HEAD :** `932cc9d fix selected-leg pro scores and pick metadata`  
**Verdict :** **PATCH APPLIED — SAFE TO COMMIT**

---

## 1. État Git initial

- HEAD : `932cc9d fix selected-leg pro scores and pick metadata`
- Branche : `main...origin/main`
- Aucun fichier suivi modifié avant patch

## 2. Cause

Les bandes `minWeeklyYield` / `maxWeeklyYield` comparaient le rendement **brut de période** (`premium/strike × 100`) alors que les noms et commentaires indiquaient un rendement hebdomadaire.

## 3. Politique appliquée (Option A)

| Helper | Rôle |
|--------|------|
| `getLegPeriodYieldPct` | Rendement brut expiration (%) — legacy |
| `getLegYieldPct` | Alias → `getLegPeriodYieldPct` |
| `getLegWeeklyNormalizedYieldPct` | Rendement hebdo linéarisé pour bandes/scoring |
| `resolveLegDte` / `isValidComboDte` | DTE > 0 fini |
| `hasExplicitInvalidDte` / `isDteFieldUnset` | Gestion DTE absent vs invalide vs legacy |

**Formule :** `weeklyNormalizedYieldPct = periodYieldPct × 7 / DTE`

**Priorité hebdomadaire :**

1. `leg.weeklyNormalizedYield`
2. `candidate.weeklyNormalizedYield` (si `allowParentCandidateFallback`)
3. Recalcul `period × 7 / DTE`
4. Legacy : si **aucun** champ DTE défini (`undefined`), `periodYield` ≈ 7 DTE historique

**Double normalisation :** jamais `× 7/DTE` sur `weeklyNormalizedYield` explicite.

## 4. Fichiers modifiés / créés

| Fichier | Action |
|---------|--------|
| `wheel-dashboard/src/capitalComboPortfolio.js` | Modifié |
| `wheel-dashboard/src/capitalComboPortfolio.weekly-normalized-yield.test.mjs` | Créé (56 tests) |
| `wheel-dashboard/src/capitalComboPortfolio.af17-allocation.test.mjs` | Créé (13 tests) |
| `wheel-dashboard/src/capitalComboPortfolio.pick-metadata.test.mjs` | Modifié (TEST 6 fixture AF-17) |
| `debug/capital-combinations-af17-patch-validation/*` | Rapports mis à jour |

Aucun autre fichier suivi modifié.

- `buildCapitalComboCandidate` : `_safeYieldPct`, `_aggYieldPct`, `selectedYieldPct`, `weeklyReturn` = hebdo ; `_safePeriodYieldPct` / `periodYieldPct` conservés ; `computeTickerQualityOverlay` utilise la période pour premium trap
- `resolveCompatibleLegForMode` : `yieldPct` descripteurs = hebdo via `_safeYieldPct` / `_aggYieldPct`
- Gates `minWeeklyYield` / `maxWeeklyYield` / WATCH : via `weeklyReturn` hebdo
- `normalizeComboYieldScore` : via `selectedYieldPct` hebdo
- `getLegWeeklyYieldDecimalForProScore` : hebdo une seule fois (AF-12)
- Grades `gradeLeg` / `getAggressivePriorityGrade` : **inchangés** (période via `getLegPeriodYieldPct`)

## 6. Bandes conservées (seuils inchangés)

- SAFE : [0,45 ; 0,80)
- BALANCED : [0,70 ; 1,05) — V3 min 0,675
- AGGRESSIVE : ≥ 0,95
- Preferred BALANCED : [0,75 ; 1,05) mid 0,875

## 7. Résultats par DTE (synthétique)

| DTE | Période 0,5–1,5 % | Hebdo normalisé |
|-----|-------------------|-----------------|
| 3 | 0,50 % | 1,17 % |
| 4 | 0,70 % | 1,23 % |
| 7 | 0,70 % | 0,70 % (identique) |
| 14 | 0,80 % | 0,40 % |
| 30 | 1,50 % | 0,35 % |
| 45 | 2,00 % | 0,31 % |

## 8. Tests AF-17

| Suite | Pass | Fail |
|-------|------|------|
| weekly-normalized-yield | 55+ | 0 |
| af17-allocation | 13 | 0 |
| **Total AF-17** | **68** | **0** |

## 9. Non-régressions

| Suite | Pass | Fail |
|-------|------|------|
| negative-spread | 32 | 0 |
| free-capital | 15 | 0 |
| soft-cap | 27 | 0 |
| pop-null | 6 | 0 |
| selected-leg-grade | 15 | 0 |
| deterministic-tiebreak | 26 | 0 |
| input-pool | 22 | 0 |
| balanced-fallback | 30 | 0 |
| selected-leg-pro-score | 20 | 0 |
| pick-metadata | 37 | 0 |
| spreadPctPercent | 15 | 0 |

**Total non-régressions : 245/245 PASS** (37 pick-metadata, dont TEST 6 corrigé)

### Correction TEST 6 (AF-15)

Fixture ajustée : `dte=5` conservé ; `periodYield=0,50` ; `weeklyNormalizedYield=0,70` (dans bande SAFE). Rejet initial : `MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT` (hebdo 0,84 % avec défaut 0,60 % période).

## 10. Build / Fable

- **Build** : `npm run build` (wheel-dashboard) — PASS
- **Fable** : T15b/T15c FAIL préexistants (grade/POP) — non liés AF-17

## 11. Données locales 7 DTE

Scan `debug/phase-a3b-result-scan-7dte-20260710.json` : à 7 DTE, `period = weekly` → comportement équivalent pour candidats avec `dteDays` explicite.

## 12. Confirmations Git

- `git diff --name-only` : `capitalComboPortfolio.js`, `capitalComboPortfolio.pick-metadata.test.mjs`
- Aucun `git add`, commit ou push
- Fichiers untracked préexistants intacts

## 13. Verdict final

**PATCH APPLIED — SAFE TO COMMIT**

Recommandation commit : message du type `fix(AF-17): use weekly normalized yield for capital combo bands`
