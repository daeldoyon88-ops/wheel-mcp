# Rapport final — Optimisation des SORTIES (sans ATR) — Stratégie Pine TQQQ

_Généré le 2026-06-05T21:16:47.042Z. Style swing (CELI). Backtest local validé 22/22 trades vs export TradingView._

> ⚠️ **Aucune modification du script Pine n'a été appliquée.** Ce rapport propose des changements à **valider d'abord** dans TradingView (Étape 7, point 7).

## Baseline (config réelle validée)

MA 8/24/24 · RSI achat 47 · RSI vente 1 (inactif) · MASTER on (8/34, RSI 48) · 100 % cash · 0 add · cooldown 2 ·
`blockBearTrend`/EMA200/`blockIfMMSlopeBear` **OFF** · fill à la clôture · ATR/stops **OFF** · capital 10 000 $.

- Rendement : **+4386.81 %** · Max DD : **-42.36 %** · Trades : **22** · PF : **11.46** · Exposition : 24.08 %
- Drawdown de la position pendant la crise 2026-01-28→03-30 : **-27.0 %**

---

## 1. Pourquoi la stratégie est restée investie pendant la baisse

La seule sortie active est **`maSellEvent` = EMA8 croise SOUS EMA24** (un **ÉVÈNEMENT** de croisement). RSI vente=1 est inactif, Stop Loss/Trailing ATR sont OFF, et **MASTER ne filtre que les entrées** (il ne ferme jamais).

Séquence réelle (cf. `tqqq-2026-drawdown-diagnostic`) :
- 2026-02-04 : sortie correcte sur vrai croisement EMA8↓EMA24.
- **2026-02-25 : ré-entrée @ 51,87 sur un pop de RSI (RSI↑47) + MASTER ON, alors que EMA8 était DÉJÀ sous EMA24.** Possible car `blockBearTrend` est OFF.
- Du 25 fév au 30 mars : EMA8 reste **en permanence** sous EMA24 → le croisement baissier **a déjà eu lieu avant l'entrée** et **ne peut plus se redéclencher** → aucune sortie possible → la position encaisse **-27.0 %**.

**Cause racine :** la stratégie peut entrer long **sans aucune sortie active disponible** (sortie = évènement déjà consommé), et il n'existe **aucune sortie basée sur un ÉTAT** ni sur le momentum.

## 2. Quelle sortie aurait aidé

Toutes les sorties d'état/momentum coupent ce trade. Réduction du DD de la position pendant la crise :

| Sortie | DD crise | vs baseline -27.0% |
|---|---|---|
| C | -7.7 % | -19.3 pts mieux |
| K | -7.7 % | -19.3 pts mieux |
| L | -16.9 % | -10.0 pts mieux |
| B | -7.7 % | -19.3 pts mieux |

- **Protection maximale de la crise : C / K** (−7,7 % au lieu de −27 %).
- **Bon compromis : L** (−16,9 %), avec beaucoup moins d'effets de bord (voir §3 et §5).

## 3. Quelle sortie réduit le DD sans trop augmenter les trades

| Sortie | Rendement | Max DD | Trades (Δ) | PF | DD crise |
|---|---|---|---|---|---|
| baseline | 4386.81 % | -42.36 % | 22 | 11.46 | -27.0 % |
| L | 2185.89 % | -37.99 % | 22 (+0) | 3.47 | -16.9 % |
| C | 1389.17 % | -41.44 % | 31 (+9) | 3.48 | -7.7 % |
| K | 1389.17 % | -41.44 % | 31 (+9) | 3.48 | -7.7 % |
| B | 1327.59 % | -41.44 % | 29 (+7) | 3.02 | -7.7 % |

➡️ **L réduit le DD global (−42 → −38) et la crise (−27 → −17) avec +1 seul trade** et reste un vrai style swing. C/K protègent plus la crise mais ajoutent +9 trades et abîment les marchés haussiers.

## 4. Quelle sortie est trop agressive

| Sortie | Rendement | Trades | PF | Verdict |
|---|---|---|---|---|
| A | 87.13 % | 37 | 1.56 | rendement détruit / trades gonflés |
| D | -1.96 % | 46 | 0.98 | rendement détruit / trades gonflés |
| E | 16.64 % | 49 | 1.14 | rendement détruit / trades gonflés |
| I | 86.25 % | 46 | 1.66 | rendement détruit / trades gonflés |
| J | 42.89 % | 39 | 1.32 | rendement détruit / trades gonflés |
| M | 872.75 % | 30 | 2.38 | rendement détruit / trades gonflés |
| F | 123.84 % | 37 | 1.55 | rendement détruit / trades gonflés |
| G | 123.84 % | 37 | 1.55 | rendement détruit / trades gonflés |
| H | 269.41 % | 36 | 2.79 | inutile pour cette crise (pas d'extension préalable) |

Toutes les sorties contenant **`close < MA8`** (D, E, F, G) ou les sorties d'état trop serrées (I close<MA24, J close<MA50, M Donchian seul, A master-off) **coupent les gros gagnants** sur des creux normaux de tendance ; comme l'**entrée rigide** (RSI doit re-croiser 47 + MASTER) ne permet pas de re-rentrer dans la tendance, le rendement s'effondre.

## 5. Quelle variante recommander

**Recommandée : L — « cassure du plus-bas 10 jours quand EMA8 < EMA24 ».**

Robustesse walk-forward (sous-périodes) :

| Sortie | Rétention rendement | Dégât marché haussier | Protection crise | Inflation trades |
|---|---|---|---|---|
| L | 66 % | 0 % | 10 pts | +1 |
| C | 51 % | 26 % | 19.3 pts | +22 |
| K | 51 % | 26 % | 19.3 pts | +22 |
| B | 50 % | 25 % | 19.3 pts | +18 |

Pourquoi **L** :
- **0 % de dégât en marché haussier** (2020-2021 et 2022-2023 : identique au baseline, aucune sortie parasite, **mêmes trades**).
- **Meilleure rétention de rendement** (66 % vs 50-51 %).
- **+1 trade seulement** sur tout l'historique → reste swing.
- Ne se déclenche **que** quand la structure est baissière ET qu'un nouveau plus-bas de 10 jours casse → laisse respirer les tendances saines, coupe les rebonds qui échouent (comme février 2026).

**Alternative (protection maximale) : K** si tu acceptes un rendement plus bas, plus de trades et un peu de chop en marché haussier, en échange d'une crise ramenée à −7,7 %.

**Dilemme central à connaître :** la même permission (acheter un rebond RSI quand EMA8<EMA24) qui crée les **gros gagnants contre-tendance** (2020-04 +123 %, 2025-04 +101 %) est aussi celle qui a créé le piège de février 2026. Remettre `blockBearTrend` ON « réglerait » le piège mais **détruirait l'edge** (rendement 4386 % → 149 %). C'est pourquoi la solution passe par la **sortie**, pas par un filtre d'entrée de tendance.

## 6. Modifications Pine exactes proposées (à VALIDER, non appliquées)

### Option recommandée — L
```pine
// === Sortie protectrice "L" (RECOMMANDÉE) : cassure plus-bas 10j en structure baissière ===
// À insérer après le calcul des MA/signaux et AVANT le bloc EXIT.
useExitLowBreak = input.bool(true, "🛡️ Sortie: cassure plus-bas Nj si EMA8<EMA24")
lowBreakLen     = input.int(10, "Sortie: plus-bas (bars)", minval=2)
exitLowBreak    = useExitLowBreak and (maFast < maMid) and (close < ta.lowest(low, lowBreakLen)[1])

// puis, dans la construction de exitSignal, AJOUTER :
exitSignal := exitSignal or (inRange and exitLowBreak)
```

### Option protection maximale — K
```pine
// === Sortie protectrice "K" (PROTECTION MAX, plus de chop) : EMA8<EMA24 ET close<EMA24 ===
useExitBearMA = input.bool(false, "🛡️ Sortie: close<EMA24 si EMA8<EMA24")
exitBearMA    = useExitBearMA and (maFast < maMid) and (close < maMid)
exitSignal   := exitSignal or (inRange and exitBearMA)
```

Notes d'implémentation :
- Dans ta config, `maMid` = EMA24 et `maFast` = EMA8 ; `maFast < maMid` = « EMA8 sous EMA24 ».
- `ta.lowest(low, 10)[1]` = plus-bas des 10 barres **précédentes** (cohérent avec le backtest).
- Comme tes ordres sont remplis **à la clôture** (`process_orders_on_close`), la sortie agit le jour même de la cassure — pas de décalage.
- Garde ATR/stops OFF comme demandé. Ces sorties n'utilisent **pas** d'ATR.

## 7. Validation requise avant toute modification du Pine

Ce rapport **ne modifie pas** le script. Avant d'appliquer L (ou K) :
1. Colle le snippet dans une **copie** de ta stratégie.
2. Vérifie sur TradingView que les **22 trades historiques restent globalement intacts** hors crises (L ne doit rien changer en 2020-2021 / 2022-2023).
3. Vérifie que le trade ouvert (entré 2026-02-25) **sort bien** lors de la cassure de mars 2026.
4. Compare DD / PF / nombre de trades aux chiffres de ce rapport.
5. Seulement ensuite, décide d'activer L (recommandé) ou K (protection max).

---

### Fichiers produits
- `tqqq-strategy-backtest-current.md/.json` (baseline validé, réconciliation 22/22)
- `tqqq-2026-drawdown-diagnostic.md/.csv` (diagnostic crise)
- `tqqq-exit-candidates.json` (Étape 5)
- `tqqq-walkforward.json` (Étape 6)
- `tv-trades-TQQQ-2026-06-05.csv` (référence TradingView)
