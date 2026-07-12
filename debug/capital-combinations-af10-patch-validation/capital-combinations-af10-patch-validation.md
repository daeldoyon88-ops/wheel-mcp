# Validation patch AF-10 — Capital agrégé multi-contrats

## 1. Résumé

Patch UI ciblé : affichage du capital total par ligne et concentration RISQUE alignée sur `capitalUsed` agrégé. Aucune modification moteur, backend, snapshot ou allocation.

**Verdict : SAFE TO COMMIT**

## 2. État Git initial

- Racine : `C:/Users/melan/Desktop/wheel-mcp-remote`
- HEAD : `bafc9f7` — fix deployable capital free balance
- Branche : `main...origin/main` synchronisée
- Aucun fichier suivi modifié au départ

## 3. Cause exacte

`capitalRequired` = collatéral d’**un** contrat (figé à `createPick`).  
`capitalUsed` = collatéral **agrégé** (`+=` à chaque contrat).  
La carte RISQUE et la colonne Capital utilisaient `capitalRequired`.

## 4. capitalRequired

Collatéral par contrat ($). Non mis à jour quand `contracts > 1`.

## 5. capitalUsed

Collatéral total de la ligne ($). Source de vérité moteur pour totaux et concentration.

## 6. Helper de résolution

Fichier : `wheel-dashboard/src/pickLineCapital.js`

- `resolvePickLineCapital(pick)` — capital affiché par ligne
- `resolveDominantTickerCapital(picks)` — ticker dominant + %

Priorité : `capitalUsed` ≥ 0 → `capitalPerContract × contracts` → `capitalRequired × contracts` → 0.

## 7. Carte RISQUE avant

```text
total = Σ capitalRequired
dominant.pct = max(byTicker capitalRequired) / total × 100
```

## 8. Carte RISQUE après

```text
dominant = resolveDominantTickerCapital(riskCombo.picks)
→ aligné sur largestTickerCapitalPct moteur
```

`concentrationRiskScore`, couleurs et seuils **inchangés**.

## 9. Colonne Capital avant

`pick.capitalRequired` (1 lot) + colonne Contrats séparée.

## 10. Colonne Capital après

`resolvePickLineCapital(pick)` — libellé **Capital total**.

## 11. Accordéon

Avant : `capital {pick.capitalRequired}$`  
Après : `capital total {resolvePickLineCapital(pick)}$`

## 12. Exemple NOK / SOFI

| | NOK×3 | SOFI×1 |
|---|-------|--------|
| capitalRequired | 1 100 $ | 4 000 $ |
| capitalUsed | 3 300 $ | 4 000 $ |
| Dominant % avant | — | **78,43 %** |
| Dominant % après | — | **54,79 %** |

## 13. SAFE / 14. BALANCED / 15. AGGRESSIVE

Même helper pour tous les modes — affichage uniquement ; allocation moteur inchangée (non-régressions PASS).

## 16. Cas legacy

Objets sans `capitalUsed` : fallback `capitalPerContract` ou `capitalRequired` × `contracts` (défaut 1).

## 17. Protections NaN/Infinity

`capitalUsed` NaN/Infinity/négatif → fallback contrôlé ; jamais NaN/Infinity en sortie ; jamais `capitalUsed × contracts`.

## 18. Tests AF-10

`wheel-dashboard/src/pickLineCapital.test.mjs` — **20/20 PASS**

## 19. Non-régressions

| Fichier | Résultat |
|---------|----------|
| pickLineCapital.test.mjs | 20/20 PASS |
| free-capital (moteur) | 15/15 PASS |
| free-capital (backend) | 5/5 PASS |
| soft-cap | 27/27 PASS |
| pop-null | 6/6 PASS |
| selected-leg-grade | 15/15 PASS |
| deterministic-tiebreak | 25/25 PASS |
| inputPool | 20/20 PASS |
| balanced-fallback | 30/30 PASS |
| spreadPct | 15/15 PASS |

## 20. Fable

29 PASS / 9 FAIL / 5 INFO — `criticalConfirmed = 0`  
**T10a** reste PASS (harnais rejoue l’ancienne formule inline — non modifié). **Pas de régression réelle.**

## 21. Build

`npm run build` — **PASS** (warnings framer-motion et chunk size préexistants).

## 22. Fichiers modifiés

- `wheel-dashboard/src/dashboard.jsx`

## 23. Fichiers créés

- `wheel-dashboard/src/pickLineCapital.js`
- `wheel-dashboard/src/pickLineCapital.test.mjs`
- Ce rapport + JSON

## 24. Limites

- Inspector conserve `capitalRequired` (diagnostic 1 contrat)
- Fable T10a obsolète relativement à l’UI corrigée

## 25. État Git final

- HEAD inchangé : `bafc9f7`
- Modifié : `dashboard.jsx`
- Nouveaux untracked : helper, tests, rapports
- Aucun git add / commit / push

## 26. Verdict

**SAFE TO COMMIT**
