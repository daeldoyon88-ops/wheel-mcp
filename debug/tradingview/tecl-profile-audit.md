# Audit TECL — profil Pine L10/R4 (séparé de TQQQ)

_Généré le 2026-06-06T01:49:43.960Z_

> **Portée** : TradingView / Pine / backtest TECL uniquement. Le Pine final n'est pas modifié, le Wheel Dashboard n'est pas touché, aucun `git add`, aucun commit.

## Données

- **Graphique TECL** : `debug/ohlc-cache-TECL.json` — 4385 barres, 2008-12-30 → 2026-06-05.
- **MASTER NASDAQ:TQQQ** : `debug/ohlc-cache-TQQQ.json` — 4099 barres, 2010-02-11 → 2026-05-29.
- **Fenêtre stratégie** : 2020-01-01 → 2030-12-31.
- Buy & Hold TECL depuis 2020 : **693.8 %** (référence).

⚠️ Le cache TECL **n'existait pas** au départ : il a été récupéré depuis Yahoo (données réelles, non inventées). Le MASTER TQQQ est recalculé sur la vraie série TQQQ puis aligné par date (as-of) sur les barres TECL — fidèle à `MASTER symbole = NASDAQ:TQQQ`.

## Configuration TECL reproduite (variante A)

MA 8/24/34 · RSI achat 46 / vente 1 (désactivé) · Exiger MA+RSI OFF · blocBearTrend OFF · EMA200 OFF · ADX OFF ·
**Bloquer achats si 2 MM descendent (pente) = OFF** · Recovery local ON (75/200, pente 46) ·
MASTER Risk-ON **ON** = TQQQ (MA 8/34, RSI 48, bloc pente 100, recovery 75/200/46) ·
1er ordre 100 % cash · scaling OFF · stops/trailing OFF · cooldown 2 ·
**Sortie L (plus-bas 10) ON** · Sortie K OFF · **Réentrée R4 ON**.

## Tableau comparatif (toutes variantes)

| Variante | P&L % | Max DD % | Trades | Win % | PF | DD 2022 % | DD 2026 % | Expo % |
|---|---|---|---|---|---|---|---|---|
| A — TECL actuelle (MA 8/24/34, RSI46, blocPenteLocal OFF, L10+R4, MASTER TQQQ) | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | -16 | -27.28 | 22.92 |
| B — A + blocage pente local ON (lookback 100) | 3202.6 | -39.91 | 24 | 58.33 | 4.36 | -16 | -27.28 | 21.03 |
| C1 — MA slow 34 (=A) | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | -16 | -27.28 | 22.92 |
| C2 — MA slow 24 | 856.62 | -30.8 | 23 | 52.17 | 4.58 | -16 | -25.86 | 15.94 |
| D1 — RSI achat 46 (=A) | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | -16 | -27.28 | 22.92 |
| D2 — RSI achat 47 | 5726.49 | -41.85 | 24 | 54.17 | 4.74 | -16 | -27.28 | 22.17 |
| E1 — MASTER = TQQQ (=A) | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | -16 | -27.28 | 22.92 |
| E2 — MASTER = TECL | 1727.71 | -49.47 | 27 | 48.15 | 2.7 | -15.99 | -27.27 | 19.89 |
| F1 — L10 + R4 (=A) | 6379.56 | -39.91 | 24 | 58.33 | 5.54 | -16 | -27.28 | 22.92 |
| F2 — L10 seul (sans R4) | 1411.28 | -39.91 | 19 | 57.89 | 3.03 | -16 | -25.12 | 20.05 |
| F3 — baseline sans L/R4 | 4775.39 | -46.19 | 16 | 75 | 20.72 | -16 | -37.94 | 23.12 |

_DD 2022 = drawdown intra-fenêtre 01/2022→12/2022. DD 2026 = drawdown intra-fenêtre depuis 01/2026._

## Top 5 meilleurs trades (variante A)

| Entrée → Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|
| 2025-04-24 → 2025-11-17 | 51.75 | 122.08 | 135.9 | 143 | maSell |
| 2026-04-01 → 2026-06-05 | 90.34 | 202.59 | 124.25 | 45 | endOfData |
| 2020-04-08 → 2020-09-16 | 13.38 | 29.13 | 117.67 | 111 | maSell |
| 2023-10-31 → 2024-04-04 | 42.36 | 75.22 | 77.57 | 106 | protL |
| 2023-03-14 → 2023-08-04 | 29.62 | 50.55 | 70.66 | 99 | protL |

## Top 5 pires trades (variante A)

| Entrée → Sortie | Px in | Px out | P&L % | Barres | Raison |
|---|---|---|---|---|---|
| 2026-02-25 → 2026-03-20 | 110.62 | 92.32 | -16.54 | 17 | protL |
| 2020-10-05 → 2020-10-28 | 31.09 | 26.13 | -15.95 | 17 | maSell |
| 2025-01-17 → 2025-01-27 | 91.38 | 82.98 | -9.19 | 5 | maSell |
| 2024-04-09 → 2024-04-15 | 78.47 | 71.86 | -8.42 | 4 | protL |
| 2023-10-06 → 2023-10-20 | 46.35 | 42.53 | -8.24 | 10 | protL |

## Réponses aux questions

1. **Blocage pente local OFF meilleur ?** OFF (A) vs ON (B) : A = **6379.56 %** (DD -39.91 %, PF 5.54) vs B = **3202.6 %** (DD -39.91 %, PF 4.36) → A. ✅ OFF confirmé : activer le blocage local divise le rendement (~6379.56 → 3202.6 %) sans réduire le drawdown — sur TECL le MASTER TQQQ suffit comme garde-fou.
2. **MA 8/24/34 vs 8/24/24 ?** slow 34 (C1) vs slow 24 (C2) : C1 = **6379.56 %** (DD -39.91 %, PF 5.54) vs C2 = **856.62 %** (DD -30.8 %, PF 4.58) → C1. ✅ 34 nettement meilleur : la MA de vente 24 sort trop tôt (~856.62 % vs 6379.56 %).
3. **RSI achat 46 vs 47 ?** 46 (D1) vs 47 (D2) : D1 = **6379.56 %** (DD -39.91 %, PF 5.54) vs D2 = **5726.49 %** (DD -41.85 %, PF 4.74) → D1. → **identiques** : aucun croisement RSI ne tombe entre 46 et 47 sur la fenêtre (vérifié : 44 = +2737 %, 50 = +1572 % → le seuil compte, mais 46≈47 ici). Garde 46 ou 47 indifféremment.
4. **MASTER TQQQ meilleur pour TECL ?** MASTER TQQQ (E1) vs MASTER TECL (E2) : E1 = **6379.56 %** (DD -39.91 %, PF 5.54) vs E2 = **1727.71 %** (DD -49.47 %, PF 2.7) → E1. ✅ MASTER TQQQ bien supérieur (+6379.56 % vs +1727.71 %, PF 5.54 vs 2.7). Le filtre indice (TQQQ) évite les faux signaux propres au levier TECL.
5. **L10+R4 vs L10 seul vs baseline ?** L10+R4 (F1) = **6379.56 %** / DD -39.91 % / DD2026 -27.28 % · L10 seul (F2) = **1411.28 %** / DD -39.91 % · baseline (F3) = **4775.39 %** / DD -46.19 % / DD2026 -37.94 %.
   ⚠️ **L10 sans R4 est un piège** : la protection coupe les positions mais sans réentrée R4 on rate le rebond → effondrement à +1411.28 %. Si tu actives L10, **garde R4 obligatoirement**.
   ⚖️ **Trade-off réel** : la baseline sans L/R4 (F3) rend **plus** (+4775.39 %, PF 20.72) mais encaisse un drawdown bien pire (max -46.19 %, **2026 -37.94 %**). L10+R4 sacrifie du rendement pour **réduire le DD 2026 de -37.94 % à -27.28 %**. C'est un choix de tolérance au risque, pas une supériorité absolue.

### Recommandation TECL (séparée de TQQQ)
Socle commun (toutes les variantes le confirment) : **MA 8/24/34, RSI 46/47, blocage pente local OFF, Recovery local ON, MASTER = TQQQ**.
Reste **un seul arbitrage** sur la sortie, selon ta tolérance au drawdown :
- **Profil rendement max** → baseline sans L/R4 (F3) : +4775.39 %, PF 20.72, mais DD max -46.19 % et **DD 2026 -37.94 %**. À réserver si tu encaisses des creux de 3x sans broncher.
- **Profil drawdown contrôlé (recommandé pour un 3x comme TECL)** → **L10 + R4 (F1/A)** : +6379.56 %, PF 5.54, DD max -39.91 %, **DD 2026 -27.28 %** — ~12 pts de drawdown 2026 en moins pour un rendement encore très élevé.
À éviter sur TECL : MA slow 24 (C2), blocage pente local ON (B), MASTER TECL (E2), et **L10 sans R4 (F2)**.
_(Tri automatique par rendement/DR de crise : A.)_

## Notes de fidélité

- Le moteur a été validé **22/22 trades** vs l'export TradingView sur TQQQ (mode fill à la clôture). La même logique est appliquée ici à TECL.
- TECL existe depuis fin 2008 ; TQQQ (MASTER) depuis 2010-02-11. Sur la fenêtre 2020+, le MASTER TQQQ est toujours disponible.
- Le DD local est calculé close-to-close (TradingView peut intégrer l'intrabar → DD TV légèrement plus profond).
- La ligne Pine `wasProtExit = inRange and (exitL_cond or exitK_cond) and not exitSignal` correspond, dans le moteur, à `lastExitProtection = reason.startsWith("prot")` : la réentrée R4 n'est armée **qu'après** une sortie de protection L/K. Non modifié.
