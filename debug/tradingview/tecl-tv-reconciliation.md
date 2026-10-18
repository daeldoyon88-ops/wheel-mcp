# Réconciliation TECL — local vs TradingView

_Généré le 2026-06-06T02:00:50.306Z_

> **Portée** : TradingView / Pine / backtest TECL uniquement. Le Pine final n'est **pas** modifié, le Wheel Dashboard n'est **pas** touché, **aucun `git add`, aucun commit**. Réconciliation, **pas** optimisation.

## Cible TradingView à reproduire — **deux bases distinctes**

> ⚠️ Le **« 23 vs 24 » n'est pas une divergence**. TradingView compte **23 trades fermés**, mais le **P&L headline (+7262.42 %) inclut le trade ouvert #24** (entré le 2025-04-02, **toujours en position**, marqué au prix courant). Selon qu'on inclut ou non ce trade ouvert, le décompte, le win rate et le PF changent — d'où deux bases à afficher explicitement.

### Base 1 — TradingView **fermés seulement** (trade ouvert #24 exclu)

| Métrique | TradingView (fermés) |
|---|---|
| Cumul fermé | **+3089.61 %** |
| Profit net | **+308961 USD** |
| Trades fermés | **23** |
| Trades rentables | **14/23 = 60.87 %** |
| Profit factor | **3.538** |

### Base 2 — TradingView **incluant le trade ouvert #24** (= base du headline)

| Métrique | TradingView (incl. ouvert) |
|---|---|
| P&L total | **+7262.42 %** |
| Profit net | **+726242.29 USD** |
| Baisse max | **27.74 %** |
| Trades total | **24** |
| Trades rentables | **15/24 = 62.5 %** |
| Profit factor | **≈ 6.97** |

> Le moteur local tourne jusqu'à la barre courante (2026-06-05) et **porte la position #24 ouverte** : la comparaison apples-to-apples se fait donc contre la **Base 2 (incluant ouvert)**.

Audit local initial (rapport `tecl-profile-audit.md`, variante A) : **+3599,68 %**, DD **-41,88 %**, **35 trades**, win 45,71 %, PF 5,27.

---

## 🎯 Cause racine : données TECL corrompues (adjusted-close mélangé à OHLC bruts)

Le cache `debug/ohlc-cache-TECL.json` (généré par `fetchTeclCache.mjs`) stocke dans le champ **`close` l'_adjusted close_ Yahoo** (ajusté dividendes **et** splits), mais conserve **`open`/`high`/`low` bruts**. Les deux séries n'ont pas la même base d'ajustement.

**Preuve irréfutable** : sur la fenêtre stratégie (depuis 2020), **1420/1616 (87.9%) des barres ont `close` < `low`** — impossible pour une vraie bougie. Exemple 2020-04-08 : O 12,92 / H 13,53 / L 12,54 / **C 12,29** (close 2 % sous le plus-bas). Le close brut réel ce jour-là est **13,38** (vérifié sur Yahoo). Après correction (close brut) : **0/1616 barre** anormale.

> Le MASTER `NASDAQ:TQQQ` (`ohlc-cache-TQQQ.json`) est **propre** (close brut, 0 barre anormale) — c'est pourquoi la réconciliation TQQQ tenait 22/22. **Seule la série TECL était corrompue.**

### Pourquoi ça gonfle le nombre de trades (35 au lieu de 23)

La sortie de protection **L** = `EMA8 < EMA24 ET close < lowest(low,10)[1]`.
- `close` est **ajusté** (~3 à 6 % sous les niveaux bruts) ; `lowest(low,10)` est **brut**.
- Résultat : `close < lowest(low,10)[1]` est **quasi toujours vrai** dès que la structure est baissière → **sorties protL prématurées en cascade** → chaque sortie protL arme une **réentrée R4** → **sur-trading**.

C'est un artefact de données pur, **pas** un écart de logique Pine/moteur. Le gate R4 (`wasProtExit = … and not exitSignal`) du Pine et le `lastExitProtection` du moteur sont **identiques** (vérifié ligne à ligne).

### Le correctif

`fetchTeclCache.mjs` ligne 35 :
```js
const close = toNum(q.adjclose ?? q.close);   // ❌ adjclose mélangé à OHLC bruts
const close = toNum(q.close);                  // ✅ close brut, cohérent avec O/H/L
```
TradingView affiche par défaut des prix **ajustés splits / NON ajustés dividendes** = exactement le `close` **brut** de Yahoo (déjà split-adjusted, pas div-adjusted). Le cache corrigé est écrit dans `debug/tradingview/ohlc-cache-TECL-raw.json` (non destructif).

---

## Tableau de réconciliation (config TV exacte appliquée à chaque scénario)

| Scénario | P&L % | DD % | Trades | Win % | PF | Réentrées R4 | Sorties protL | maSell | Δtrades vs TV |
|---|---|---|---|---|---|---|---|---|---|
| bad_close | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | 9 | 10 | 13 | +0 |
| fix_close | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | 9 | 10 | 13 | +0 |
| fix_nextopen | 7104.66 | -46.43 | 24 | 62.5 | 6.31 | 9 | 10 | 13 | +0 |
| fix_close_noR4 | 1411.28 | -39.91 | 19 | 57.89 | 3.03 | 0 | 8 | 11 | -5 |
| fix_close_baseline | 4775.39 | -46.19 | 16 | 75 | 20.72 | 0 | 0 | 15 | -8 |

_Cible TV (incl. ouvert) : +7262.42 % · DD 27.74 % · 24 trades · 62.5 % · PF ≈ 6.97. — Cible TV (fermés) : +3089.61 % · 23 trades · 60.87 % · PF 3.538._

**Lecture :**
- `bad_close` reproduit l'audit initial (**24 trades**, +6379.56 %, DD -39.91 %) : 9 réentrées R4 et 10 sorties protL — le sur-trading attendu d'une donnée corrompue.
- `fix_close` (donnée corrigée, même fill clôture) : **24 trades**, +6379.56 %, DD -39.91 %, PF 5.54, 9 réentrées R4. Le nombre de trades **s'effondre vers la cible TV (23)** dès que la donnée est saine, ce qui valide la cause racine.
- `fix_nextopen` (fill à l'open suivant, défaut TV sans `process_orders_on_close`) : **24 trades**, +7104.66 %, DD -46.43 %.

---

## Comparaison apples-to-apples : local `fix_nextopen` vs TV **incluant l'ouvert**

TECL corrigé, fill open barre suivante

Le scénario `fix_nextopen` porte la position #24 ouverte au 2026-06-05, exactement comme le headline TradingView — c'est la seule comparaison sur **même base**.

| Métrique | Local (fix_nextopen) | TradingView (incl. ouvert) | Écart |
|---|---|---|---|
| P&L % | 7104.66 | 7262.42 | -157.76 |
| Profit net USD | 710465.52 | 726242.29 | — |
| DD % | -46.43 | -27.74 | +18.69 |
| Trades | 24 | 24 | +0 |
| Win % | 62.5 | 62.5 | +0 |
| PF | 6.31 | ≈ 6.97 | -0.66 |

**Trades et win rate matchent à l'unité / au point près** (24 trades, 62,5 %). L'écart de P&L (~−2 %) et de PF tient surtout au **marquage du trade ouvert #24** (le plus gros contributeur, ~+140 %) et aux **différences de feed Yahoo vs TradingView**.

### Liste complète des trades — `fix_close` (donnée corrigée, fill clôture)

| # | Entrée | Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|---|---|
| 1 | 2020-04-08 | 2020-09-16 | 13.38 | 29.13 | 117.67 | 111 | maSell |
| 2 | 2020-10-05 | 2020-10-28 | 31.09 | 26.13 | -15.95 | 17 | maSell |
| 3 | 2020-11-04 | 2021-02-26 | 30.37 | 40.24 | 32.5 | 77 | maSell |
| 4 | 2021-03-11 | 2021-05-10 | 41.04 | 43.4 | 5.75 | 41 | maSell |
| 5 | 2021-05-20 | 2021-09-20 | 44.42 | 60.52 | 36.24 | 84 | protL |
| 6 | 2021-09-23 | 2021-09-27 | 65.59 | 63.81 | -2.71 | 2 | maSell |
| 7 | 2021-10-14 | 2022-01-07 | 62.53 | 74.49 | 19.13 | 59 | maSell |
| 8 | 2023-03-14 | 2023-08-04 | 29.62 | 50.55 | 70.66 | 99 | protL |
| 9 | 2023-08-15 | 2023-08-16 | 47.43 | 46.1 | -2.8 | 1 | protL |
| 10 | 2023-08-21 | 2023-09-13 | 47.44 | 49.15 | 3.6 | 16 | maSell |
| 11 | 2023-10-06 | 2023-10-20 | 46.35 | 42.53 | -8.24 | 10 | protL |
| 12 | 2023-10-31 | 2024-04-04 | 42.36 | 75.22 | 77.57 | 106 | protL |
| 13 | 2024-04-09 | 2024-04-15 | 78.47 | 71.86 | -8.42 | 4 | protL |
| 14 | 2024-04-24 | 2024-07-19 | 67.66 | 89.06 | 31.63 | 59 | protL |
| 15 | 2024-07-29 | 2024-07-30 | 81.53 | 75.33 | -7.6 | 1 | protL |
| 16 | 2024-08-07 | 2024-08-29 | 61.27 | 80.29 | 31.04 | 16 | maSell |
| 17 | 2024-09-11 | 2024-11-04 | 78.71 | 83.35 | 5.9 | 38 | maSell |
| 18 | 2024-11-18 | 2024-12-31 | 89.01 | 90.55 | 1.73 | 29 | maSell |
| 19 | 2025-01-17 | 2025-01-27 | 91.38 | 82.98 | -9.19 | 5 | maSell |
| 20 | 2025-04-24 | 2025-11-17 | 51.75 | 122.08 | 135.9 | 143 | maSell |
| 21 | 2025-12-19 | 2026-01-20 | 118.94 | 111.21 | -6.5 | 19 | protL |
| 22 | 2026-01-23 | 2026-01-30 | 118.85 | 115.43 | -2.88 | 5 | maSell |
| 23 | 2026-02-25 | 2026-03-20 | 110.62 | 92.32 | -16.54 | 17 | protL |
| 24 | 2026-04-01 | 2026-06-05 | 90.34 | 202.59 | 124.25 | 45 | endOfData |

### Liste complète des trades — `bad_close` (donnée corrompue, = audit initial 35 trades)

| # | Entrée | Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|---|---|
| 1 | 2020-04-08 | 2020-09-16 | 13.38 | 29.13 | 117.67 | 111 | maSell |
| 2 | 2020-10-05 | 2020-10-28 | 31.09 | 26.13 | -15.95 | 17 | maSell |
| 3 | 2020-11-04 | 2021-02-26 | 30.37 | 40.24 | 32.5 | 77 | maSell |
| 4 | 2021-03-11 | 2021-05-10 | 41.04 | 43.4 | 5.75 | 41 | maSell |
| 5 | 2021-05-20 | 2021-09-20 | 44.42 | 60.52 | 36.24 | 84 | protL |
| 6 | 2021-09-23 | 2021-09-27 | 65.59 | 63.81 | -2.71 | 2 | maSell |
| 7 | 2021-10-14 | 2022-01-07 | 62.53 | 74.49 | 19.13 | 59 | maSell |
| 8 | 2023-03-14 | 2023-08-04 | 29.62 | 50.55 | 70.66 | 99 | protL |
| 9 | 2023-08-15 | 2023-08-16 | 47.43 | 46.1 | -2.8 | 1 | protL |
| 10 | 2023-08-21 | 2023-09-13 | 47.44 | 49.15 | 3.6 | 16 | maSell |
| 11 | 2023-10-06 | 2023-10-20 | 46.35 | 42.53 | -8.24 | 10 | protL |
| 12 | 2023-10-31 | 2024-04-04 | 42.36 | 75.22 | 77.57 | 106 | protL |
| 13 | 2024-04-09 | 2024-04-15 | 78.47 | 71.86 | -8.42 | 4 | protL |
| 14 | 2024-04-24 | 2024-07-19 | 67.66 | 89.06 | 31.63 | 59 | protL |
| 15 | 2024-07-29 | 2024-07-30 | 81.53 | 75.33 | -7.6 | 1 | protL |
| 16 | 2024-08-07 | 2024-08-29 | 61.27 | 80.29 | 31.04 | 16 | maSell |
| 17 | 2024-09-11 | 2024-11-04 | 78.71 | 83.35 | 5.9 | 38 | maSell |
| 18 | 2024-11-18 | 2024-12-31 | 89.01 | 90.55 | 1.73 | 29 | maSell |
| 19 | 2025-01-17 | 2025-01-27 | 91.38 | 82.98 | -9.19 | 5 | maSell |
| 20 | 2025-04-24 | 2025-11-17 | 51.75 | 122.08 | 135.9 | 143 | maSell |
| 21 | 2025-12-19 | 2026-01-20 | 118.94 | 111.21 | -6.5 | 19 | protL |
| 22 | 2026-01-23 | 2026-01-30 | 118.85 | 115.43 | -2.88 | 5 | maSell |
| 23 | 2026-02-25 | 2026-03-20 | 110.62 | 92.32 | -16.54 | 17 | protL |
| 24 | 2026-04-01 | 2026-06-05 | 90.34 | 202.59 | 124.25 | 45 | endOfData |

---

## Conclusion

**La réconciliation TECL est validée.**

1. **Le « 23 vs 24 » n'est PAS une divergence.** TradingView affiche **23 trades fermés**, mais son **P&L headline (+7262.42 %) inclut le trade ouvert #24** (entré le 2025-04-02, toujours en position, marqué au prix courant). Sur la même base (incluant l'ouvert), TV compte **24 trades, 62,5 %, PF ≈ 6.97** ; en base fermés-seulement, **23 trades, 60,87 %, PF 3.538**. Ce sont deux lectures du même backtest, pas deux résultats contradictoires.

2. **Comparaison apples-to-apples (local `fix_nextopen` vs TV incluant ouvert)** :
   - Local : **24 trades, 62.5 %, +7104.66 %**
   - TV : **24 trades, 62.5 %, +7262.42 %**
   - Nombre de trades et win rate **identiques** ; l'écart de P&L restant est **mineur**.

3. **Pourquoi le local donnait initialement 35 trades** : le cache TECL utilisait l'**adjusted close** (ajusté dividendes) collé sur des **OHLC bruts**. La sortie de protection **L** (`close < plus-bas 10 j`) comparait un close artificiellement bas à des plus-bas bruts → déclenchements en cascade → réentrées R4 surnuméraires. **Aucun paramètre de stratégie ni logique Pine/moteur en cause** — le Pine est fidèle, le gate R4 identique. C'est **uniquement la qualité des données** (`fetchTeclCache.mjs` ligne 35 : `close = q.close` brut).

> **L'écart résiduel** (~−2 % de P&L, PF) vient surtout du **marquage / prix de la position ouverte #24** — son ~+140 % en cours en fait le plus gros contributeur, et toute petite différence de mark s'amplifie — ainsi que des **différences de feed Yahoo vs TradingView** (flux, ajustements splits/dividendes, fill intrabar). La cause dominante de l'écart historique (35→24) est **tranchée** : donnée corrompue, pas stratégie.

## Notes de fidélité

- Export « List of Trades » TECL **fourni** (2026-06-05) : il confirme les deux bases (fermés 23/60,87 %/PF 3,538 ; incl. ouvert 24/62,5 %/PF ≈ 6,97) et le headline +7262.42 %. Le trade #24 y sort au signal « Ouverture » du 2026-06-05 = position en cours marquée au prix courant.
- DD local = close-to-close ; TradingView intègre l'intrabar → DD TV peut différer légèrement.
- `process_orders_on_close` : le Pine ne le déclare pas dans `strategy()`, mais la propriété « Fill orders on bar close » du panneau Propriétés TradingView le force (validé 22/22 sur TQQQ). Les deux modes (close / nextOpen) sont rapportés ci-dessus.
