# Audit divergence trade-par-trade — TQQQ L10 + R4 (Pine vs moteur local)

_Généré le 2026-06-06 — scripts/tradingview/r4DivergenceAudit.mjs_

Portée : backtest technique TQQQ uniquement. Le Pine n'a PAS été modifié.

## 1. Résumé

| Variante | Moteur local | Réplique Pine (BUG actuel) | Réplique Pine (corrigée) | TradingView (réel) |
|---|---|---|---|---|
| Baseline OFF/OFF | 22 | 22 | — | 21 tr, +3897%, DD 35.95% |
| L10 + R4 | 23 | 38 | 23 | 37 tr, +1554%, DD 74.69% |

Réentrées R4 — local : **0** · Pine BUG : **20** · Pine corrigé : **1**

> La réplique Pine fidèle (BUG actuel) reproduit les ~37 trades de TradingView. Le moteur local n'en fait que 23 (≈ baseline + 1 sortie L). Tout l'écart vient des réentrées R4 qui se déclenchent dans le Pine mais jamais dans le moteur local.

## 2. Premier trade divergent

Premier écart au **trade #5**.

- Entrée TradingView (réplique Pine) : **2021-05-17** (reentry, sortie maSell)
- Entrée locale attendue : **2021-05-20** (entrée normale, sortie maSell)

### Détail du trade #5 (premier divergent)

- **Trade #4** sort le **2021-05-10**. Dans le moteur local cette sortie est un **maSell** (le croisement EMA8↓EMA24 a tiré) → `lastExitProtection = false` → R4 **non armé**.
- Dans le Pine, la **même** barre a aussi `exitL_cond = true` (EMA8<EMA24 ET close sous le plus-bas 10j). Comme `wasProtExit` ignore le maSell, il vaut **true** → `lastExitWasProt = true` → **R4 armé**.
- `macdHistRise2` devient vrai le **2021-05-17** (avant l'entrée normale du 2021-05-20) → le Pine émet une **réentrée R4 le 2021-05-17**, 3 séances trop tôt.
- **Nature** : réentrée R4 parasite. Déclencheur Pine = drapeau de protection allumé à tort sur une sortie qui était en réalité un maSell.

## 3. Tableau comparatif (tous les trades)

| # | Moteur local | Réplique Pine | =? |
|---|---|---|---|
| 1 | 2020-04-08→2020-09-11 [norm/maSell] | 2020-04-08→2020-09-11 [norm/maSell] | ✓ |
| 2 | 2020-09-28→2020-10-28 [norm/maSell] | 2020-09-28→2020-10-28 [norm/protL] | ✓ |
| 3 | 2020-11-04→2021-02-25 [norm/maSell] | 2020-11-04→2021-02-25 [norm/maSell] | ✓ |
| 4 | 2021-03-11→2021-05-10 [norm/maSell] | 2021-03-11→2021-05-10 [norm/protL] | ✓ |
| 5 | 2021-05-20→2021-09-21 [norm/maSell] | 2021-05-17→2021-09-21 [R4/maSell] | ✗ |
| 6 | 2021-10-14→2021-12-03 [norm/maSell] | 2021-10-14→2021-12-03 [norm/protL] | ✓ |
| 7 | 2021-12-15→2021-12-16 [norm/maSell] | 2021-12-08→2021-12-14 [R4/maSell] | ✗ |
| 8 | 2021-12-21→2022-01-06 [norm/maSell] | 2021-12-21→2022-01-06 [norm/protL] | ✓ |
| 9 | 2023-03-14→2023-08-09 [norm/maSell] | 2022-01-12→2022-01-19 [R4/protL] | ✗ |
| 10 | 2023-08-23→2023-09-19 [norm/maSell] | 2022-01-27→2022-02-18 [R4/protL] | ✗ |
| 11 | 2023-10-06→2023-10-13 [norm/maSell] | 2022-02-25→2022-03-14 [R4/protL] | ✗ |
| 12 | 2023-11-02→2024-04-08 [norm/maSell] | 2022-03-17→2022-04-11 [R4/protL] | ✗ |
| 13 | 2024-04-11→2024-04-12 [norm/maSell] | 2022-04-20→2022-04-21 [R4/protL] | ✗ |
| 14 | 2024-04-29→2024-07-23 [norm/maSell] | 2022-05-03→2022-05-09 [R4/protL] | ✗ |
| 15 | 2024-09-11→2024-11-04 [norm/maSell] | 2022-05-13→2022-06-10 [R4/protL] | ✗ |
| 16 | 2024-11-18→2024-12-31 [norm/maSell] | 2022-06-21→2022-08-26 [R4/protL] | ✗ |
| 17 | 2025-01-15→2025-02-03 [norm/maSell] | 2022-09-02→2022-09-15 [R4/protL] | ✗ |
| 18 | 2025-04-24→2025-11-14 [norm/maSell] | 2022-09-20→2022-09-21 [R4/protL] | ✗ |
| 19 | 2025-11-25→2025-12-16 [norm/maSell] | 2022-09-28→2022-09-29 [R4/protL] | ✗ |
| 20 | 2025-12-19→2026-01-02 [norm/maSell] | 2022-10-04→2022-10-10 [R4/protL] | ✗ |
| 21 | 2026-01-22→2026-02-04 [norm/maSell] | 2022-10-18→2022-11-02 [R4/protL] | ✗ |
| 22 | 2026-02-25→2026-03-20 [norm/protL] | 2022-11-08→2022-12-09 [R4/maSell] | ✗ |
| 23 | 2026-04-01→2026-05-29 [norm/endOfData] | 2023-03-14→2023-08-09 [norm/protL] | ✗ |
| 24 | — | 2023-08-15→2023-08-16 [R4/protL] | ✗ |
| 25 | — | 2023-08-22→2023-09-19 [R4/maSell] | ✗ |
| 26 | — | 2023-10-06→2023-10-13 [norm/maSell] | ✗ |
| 27 | — | 2023-11-02→2024-04-08 [norm/maSell] | ✗ |
| 28 | — | 2024-04-11→2024-04-12 [norm/maSell] | ✗ |
| 29 | — | 2024-04-29→2024-07-23 [norm/maSell] | ✗ |
| 30 | — | 2024-09-11→2024-11-04 [norm/maSell] | ✗ |
| 31 | — | 2024-11-18→2024-12-31 [norm/maSell] | ✗ |
| 32 | — | 2025-01-15→2025-02-03 [norm/maSell] | ✗ |
| 33 | — | 2025-04-24→2025-11-14 [norm/maSell] | ✗ |
| 34 | — | 2025-11-25→2025-12-16 [norm/maSell] | ✗ |
| 35 | — | 2025-12-19→2026-01-02 [norm/maSell] | ✗ |
| 36 | — | 2026-01-22→2026-02-04 [norm/protL] | ✗ |
| 37 | — | 2026-02-09→2026-03-20 [R4/protL] | ✗ |
| 38 | — | 2026-04-01→2026-05-29 [R4/endOfData] | ✗ |


## 4. Cause racine

**Une seule ligne du Pine explique tout l'écart 37 vs 23.**

```
// Pine, bloc EXIT (ligne 296)
wasProtExit = inRange and (exitL_cond or exitK_cond)
```

Ce drapeau arme la réentrée R4 (`lastExitWasProt`). Il devient `true` **dès que `exitL_cond` est vrai**, **même quand la sortie a été déclenchée par le maSell normal** (croisement EMA8↓EMA24). Or `exitL_cond` (EMA8<EMA24 + cassure du plus-bas 10j) coïncide avec la plupart des maSell en repli. Résultat : presque chaque sortie ouvre la porte à une réentrée R4, surtout en marché baissier (cascade de 2022 → DD 74,69 %).

Le moteur local, lui, n'arme la protection que sur une sortie L/K **pure** :

```js
// pineEngine.mjs : la raison "protL" n'est posée que si le maSell n'a PAS tiré
if (!exitSignal) exitReason = "prot" + cfg.protExit;
...
lastExitProtection = String(reason).startsWith("prot");
```

Sur 2020→2026 il n'existe **qu'une seule** sortie L pure (2026-03-20) → 0/1 réentrée → 23 trades.

## 5. Réponses aux vérifications demandées

5. **R4 peut-elle se déclencher après une sortie non-L ?** → **OUI, c'est LE bug.** Dans le Pine, une sortie maSell (non-protection) arme quand même R4 si `exitL_cond` est vrai sur la même barre, parce que `wasProtExit` ne soustrait pas le maSell.

6. **`lastExitWasProt` reste-t-il `true` au mauvais moment ?** → **OUI.** Il est mis à `true` sur des sorties maSell déguisées en protection. Il est correctement remis à `false` par une entrée (FIRST BUY ligne 245 / R4 ligne 332) et par le bloc SYNC sur sortie stop/trail — mais le mal est déjà fait au moment où il est armé à tort.

7. **`strategy.entry("Long")` de R4 se mélange-t-il aux entrées normales ?** → **Non, pas de mélange de positions.** R4 et FIRST BUY exigent tous deux `position_size==0` et R4 efface `lastExitWasProt`, donc une seule entrée par barre (jamais d'empilement). L'id "Long" partagé est volontaire (pour que `strategy.close("Long")` referme R4). Le problème n'est pas le mélange d'ordres mais le **sur-armement** de R4.

8. **Le debug M2 spamme-t-il / influence-t-il la logique ?** → **Aucune influence logique.** Les `plotshape` (POST/M2/R4 READY/R4 BUY, lignes 414-417) sont purement visuels ; `showR4Debug` ne conditionne aucune entrée/sortie. Le « spam » M2 est normal : `macdHistRise2` est vrai très souvent (rebonds techniques de 2 jours), ce qui explique pourquoi chaque armement parasite trouve vite une barre pour tirer.

9. **`closeIssuedByLogic` reste-t-il true/false au mauvais moment ?** → **Non, il est correct ici.** Il est mis à `true` dans le bloc EXIT puis consommé par le bloc SYNC à la barre suivante (la fermeture process_orders_on_close se remplit à la clôture). Comme stops/trailing sont OFF, la branche `else` du SYNC (reset sur sortie non-logique) n'est jamais empruntée. Ce mécanisme est **inerte** et n'est PAS la cause.

## 6. Correctif proposé (NON appliqué — Pine inchangé)

Exclure le maSell du drapeau de protection, exactement comme le moteur local :

```
// Pine, bloc EXIT — remplacer la ligne wasProtExit par :
wasProtExit = inRange and (exitL_cond or exitK_cond) and not exitSignal
```

Réplique Pine ainsi corrigée : **23 trades**, **1** réentrée(s), **identique au moteur local trade pour trade** (mêmes dates d'entrée/sortie sur les 23 trades). Le seul reliquat est une étiquette (l'entrée du 2026-04-01 classée R4 au lieu de normale) — même date, même P&L, sans effet.
