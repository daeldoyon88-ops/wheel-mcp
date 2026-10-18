# Diagnostic période critique TQQQ — 2026-01-28 → 2026-03-30

_Config validée (22/22 trades vs TradingView). Voir tqqq-strategy-backtest-current.md._

## Résumé

- Jours dans la fenêtre : **43**
- Jours en position : **30**
- Signaux de sortie déclenchés dans la fenêtre : **1** (2026-02-04)
- Pire drawdown depuis l'entrée (sur close) dans la fenêtre : **-26.95 %**
- Trade en cause : entré le **2026-02-25 @ 51.87**, excursion adverse **-27.0 %**, sortie effective le 2026-05-29.

## Pourquoi aucune sortie n'a déclenché (mécanisme précis)

Séquence réelle dans la fenêtre :
1. **2026-02-04** : le trade précédent (entré le 2026-01-22) **sort** sur un vrai croisement EMA8↓EMA24 (perte −7,68 %). ✅ la sortie a bien fonctionné une fois.
2. **Flat du 04 au 25 fév.**
3. **2026-02-25** : **ré-entrée @ 51.87** déclenchée par **RSI qui croise 47 + MASTER ON**, ALORS QUE **EMA8 était déjà SOUS EMA24** (49,99 < 51,05). C'est permis parce que `blockBearTrend` est **OFF** : la stratégie achète un simple rebond de RSI dans une structure de moyennes déjà baissière.
4. **Du 25 fév au 30 mars** : EMA8 **reste en permanence sous** EMA24 → le **croisement baissier (un ÉVÈNEMENT) a déjà eu lieu avant l'entrée et ne peut plus se redéclencher** → `maSellEvent` = "no" tous les jours → **aucune sortie ne peut physiquement se produire** pendant toute la chute (-26.95 % depuis l'entrée).

Pourquoi rien d'autre ne sort :
- **RSI vente = 1** → `rsiCrossDown` impossible (RSI ne descend pas sous 1). Porte RSI désactivée.
- **Stop Loss / Trailing ATR = OFF** → aucune protection.
- **MASTER Risk-ON ne filtre que les ENTRÉES** → le master passe "off" pendant la baisse (voir colonne) mais **ne ferme rien**.

➡️ **Double problème de sortie à corriger** (Étape 5) :
- (a) **aucune sortie basée sur un ÉTAT** (close < MA, momentum baissier) — uniquement un évènement de croisement qui peut être "déjà consommé" au moment de l'entrée ;
- (b) **aucune sortie réactive au momentum** (MACD, RSI, cassure de plus-bas) ni de stop.
La combinaison `blockBearTrend` OFF + sortie = évènement-seulement crée le piège : on peut entrer long sans aucune sortie active disponible.

## Détail jour par jour

| Date | Close | MA8 | MA24 | MA34 | MA50 | RSI | MACDhist | Master | EMA8<EMA24 | exitSignal | Pos | DD%entrée |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-01-28 | 57.06 | 55.15 | 54.46 | 54.27 | 53.91 | 59.6 | 0.271 | off | no | no | YES | 5.86 |
| 2026-01-29 | 56.04 | 55.35 | 54.58 | 54.37 | 53.99 | 55.5 | 0.269 | off | no | no | YES | 3.97 |
| 2026-01-30 | 54.00 | 55.05 | 54.54 | 54.35 | 53.99 | 48.4 | 0.122 | off | no | no | YES | 0.19 |
| 2026-02-02 | 55.10 | 55.06 | 54.58 | 54.39 | 54.04 | 52.0 | 0.091 | off | no | no | YES | 2.23 |
| 2026-02-03 | 52.52 | 54.49 | 54.42 | 54.29 | 53.98 | 44.2 | -0.100 | off | no | no | YES | -2.56 |
| 2026-02-04 | 49.76 | 53.44 | 54.04 | 54.03 | 53.81 | 37.7 | -0.393 | off | YES | YES | YES | -7.68 |
| 2026-02-05 | 47.64 | 52.15 | 53.53 | 53.66 | 53.57 | 33.6 | -0.693 | off | no | no | no |  |
| 2026-02-06 | 50.59 | 51.81 | 53.30 | 53.49 | 53.45 | 42.9 | -0.656 | off | no | no | no |  |
| 2026-02-09 | 51.74 | 51.79 | 53.17 | 53.39 | 53.39 | 46.1 | -0.523 | off | no | no | no |  |
| 2026-02-10 | 51.02 | 51.62 | 53.00 | 53.25 | 53.29 | 44.4 | -0.455 | off | no | no | no |  |
| 2026-02-11 | 51.40 | 51.57 | 52.87 | 53.15 | 53.22 | 45.5 | -0.361 | off | no | no | no |  |
| 2026-02-12 | 48.26 | 50.84 | 52.50 | 52.87 | 53.02 | 38.6 | -0.478 | off | no | no | no |  |
| 2026-02-13 | 48.47 | 50.31 | 52.18 | 52.61 | 52.85 | 39.3 | -0.507 | off | no | no | no |  |
| 2026-02-17 | 48.35 | 49.87 | 51.87 | 52.37 | 52.67 | 39.0 | -0.500 | off | no | no | no |  |
| 2026-02-18 | 49.39 | 49.77 | 51.67 | 52.20 | 52.54 | 42.6 | -0.394 | off | no | no | no |  |
| 2026-02-19 | 48.83 | 49.56 | 51.45 | 52.01 | 52.40 | 41.2 | -0.334 | off | no | no | no |  |
| 2026-02-20 | 50.06 | 49.67 | 51.34 | 51.90 | 52.30 | 45.4 | -0.190 | off | no | no | no |  |
| 2026-02-23 | 48.24 | 49.35 | 51.09 | 51.69 | 52.14 | 40.7 | -0.196 | off | no | no | no |  |
| 2026-02-24 | 49.78 | 49.45 | 50.98 | 51.58 | 52.05 | 45.8 | -0.080 | off | no | no | no |  |
| 2026-02-25 | 51.87 | 49.99 | 51.05 | 51.60 | 52.04 | 51.8 | 0.141 | ON | no | no | YES | 0.00 |
| 2026-02-26 | 50.05 | 50.00 | 50.97 | 51.51 | 51.97 | 46.9 | 0.166 | off | no | no | YES | -3.51 |
| 2026-02-27 | 49.52 | 49.89 | 50.86 | 51.39 | 51.87 | 45.6 | 0.150 | off | no | no | YES | -4.53 |
| 2026-03-02 | 49.70 | 49.85 | 50.77 | 51.30 | 51.79 | 46.1 | 0.153 | off | no | no | YES | -4.18 |
| 2026-03-03 | 48.10 | 49.46 | 50.55 | 51.11 | 51.64 | 42.0 | 0.055 | off | no | no | YES | -7.27 |
| 2026-03-04 | 50.26 | 49.64 | 50.53 | 51.07 | 51.59 | 48.7 | 0.137 | ON | no | no | YES | -3.10 |
| 2026-03-05 | 49.80 | 49.67 | 50.47 | 50.99 | 51.52 | 47.4 | 0.162 | off | no | no | YES | -3.99 |
| 2026-03-06 | 47.54 | 49.20 | 50.24 | 50.80 | 51.36 | 41.7 | 0.033 | off | no | no | YES | -8.35 |
| 2026-03-09 | 49.39 | 49.24 | 50.17 | 50.72 | 51.28 | 47.3 | 0.077 | off | no | no | YES | -4.78 |
| 2026-03-10 | 49.40 | 49.28 | 50.11 | 50.64 | 51.21 | 47.4 | 0.110 | off | no | no | YES | -4.76 |
| 2026-03-11 | 49.35 | 49.29 | 50.05 | 50.57 | 51.14 | 47.2 | 0.130 | off | no | no | YES | -4.86 |
| 2026-03-12 | 46.83 | 48.75 | 49.79 | 50.35 | 50.97 | 40.6 | -0.017 | off | no | no | YES | -9.72 |
| 2026-03-13 | 45.93 | 48.12 | 49.48 | 50.10 | 50.77 | 38.5 | -0.158 | off | no | no | YES | -11.45 |
| 2026-03-16 | 47.46 | 47.97 | 49.32 | 49.95 | 50.64 | 43.8 | -0.132 | off | no | no | YES | -8.50 |
| 2026-03-17 | 48.16 | 48.02 | 49.23 | 49.85 | 50.54 | 46.1 | -0.056 | off | no | no | YES | -7.15 |
| 2026-03-18 | 46.10 | 47.59 | 48.98 | 49.63 | 50.37 | 40.8 | -0.127 | off | no | no | YES | -11.12 |
| 2026-03-19 | 45.69 | 47.17 | 48.71 | 49.41 | 50.19 | 39.8 | -0.183 | off | no | no | YES | -11.91 |
| 2026-03-20 | 43.08 | 46.26 | 48.26 | 49.05 | 49.91 | 34.3 | -0.365 | off | no | no | YES | -16.95 |
| 2026-03-23 | 44.57 | 45.88 | 47.97 | 48.79 | 49.70 | 39.5 | -0.355 | off | no | no | YES | -14.07 |
| 2026-03-24 | 43.62 | 45.38 | 47.62 | 48.49 | 49.46 | 37.4 | -0.379 | off | no | no | YES | -15.91 |
| 2026-03-25 | 44.39 | 45.16 | 47.36 | 48.26 | 49.26 | 40.1 | -0.314 | off | no | no | YES | -14.42 |
| 2026-03-26 | 41.23 | 44.29 | 46.87 | 47.86 | 48.95 | 33.7 | -0.445 | off | no | no | YES | -20.51 |
| 2026-03-27 | 38.78 | 43.06 | 46.22 | 47.34 | 48.55 | 29.7 | -0.647 | off | no | no | YES | -25.24 |
| 2026-03-30 | 37.89 | 41.91 | 45.56 | 46.80 | 48.13 | 28.4 | -0.781 | off | no | no | YES | -26.95 |

_CSV complet (toutes colonnes) : tqqq-2026-drawdown-diagnostic.csv_
