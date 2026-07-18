# Directional Lab — Phase 1

Laboratoire de recherche directionnelle isolé et backtester causal.
**Research-only** : voir [RESEARCH_ONLY.md](./RESEARCH_ONLY.md). Aucune
influence sur la production, aucun signal réel, aucun réseau, aucun ordre.

## Objectif

Construire une fondation honnête pour tester plus tard : entrées, maintien,
protection des profits, sorties partielles/complètes, réentrées, régimes de
marché, confluences (tendance/momentum/volatilité/volume/contexte) et la
qualité directionnelle d'un sous-jacent utilisé dans une stratégie Wheel.

Phase 1 ne cherche **pas** la meilleure stratégie, ne garantit aucun
rendement, n'optimise aucun paramètre et n'entraîne aucun modèle.

## Architecture

```
research/directional-lab/
  RESEARCH_ONLY.md          statut research-only (à lire en premier)
  DATA_CONTRACT.md          contrat DailyBarV1, raw/adjusted, missingness
  TEMPORAL_RULES.md         invariants temporels (close t -> open t+1, etc.)
  RESEARCH_PROTOCOL.md      protocole anti-overfitting (walk-forward, etc.)
  config/
    research-universe.v1.json   120 titres research-only (IA + contrôles)
    pilot-universe.v1.json      sources locales découvertes et admissibles
    baseline-configs.v1.json    coûts + paramètres fixes des baselines
  src/
    cli.mjs                 point d'entrée unique
    contracts/              10 contrats V1 (bar, action, manifest, feature,
                            régime, signal, ordre, fill, trade, résultat)
    data/                   adaptateurs JSON/CSV read-only, normalisation,
                            validation, manifest+hash, découverte allowlist,
                            sélection de base de prix cohérente
    time/                   dates civiles UTC pures, sessions US (DST
                            déterministe), split chronologique, purge/embargo
    features/               rolling null-aware, MA/EMA, momentum, volatilité,
                            volume, structure, force relative, featureEngine
    regime/                 régime de marché V1 (QQQ/SPY requis, IWM/VIX
                            optionnels, UNKNOWN si couverture insuffisante)
    strategy/               interface commune + 4 baselines à paramètres fixes
    execution/              commission, slippage, fill open, stop gap-aware
    backtest/               position, portefeuille, moteur causal, walk-forward
    metrics/                rendements, drawdown, risque, trades, excursions
    reporting/              stdout, JSON déterministe, rapport qualité
  test/                     15 suites (77 tests) anti-look-ahead + fixtures
```

## Commandes

Toutes les commandes s'exécutent depuis la racine du dépôt, n'écrivent rien
par défaut (stdout seulement) et acceptent `--output CHEMIN` explicite.

```bash
# Valider un fichier de données local (read-only)
node research/directional-lab/src/cli.mjs validate --symbol APLD --input "debug/ohlc-cache-APLD.json"

# Construire un manifest (hash sha256, couverture, qualité)
node research/directional-lab/src/cli.mjs manifest --symbol APLD --input "debug/ohlc-cache-APLD.json"

# Calculer les features (snapshot par défaut : dernière séance)
node research/directional-lab/src/cli.mjs features --symbol APLD --input "debug/ohlc-cache-APLD.json" --price-basis SPLIT_ADJUSTED

# Lancer une baseline
node research/directional-lab/src/cli.mjs backtest --symbol APLD --input "debug/ohlc-cache-APLD.json" --strategy MA50 --price-basis SPLIT_ADJUSTED

# Pilote technique (6 symboles x 4 baselines, PILOT_TECHNICAL_ONLY)
node research/directional-lab/src/cli.mjs pilot

# Vérifier l'univers (doit compter exactement 120 après déduplication)
node research/directional-lab/src/cli.mjs universe-check

# Tests
node --test research/directional-lab/test/*.test.mjs
```

Stratégies disponibles : `BUY_HOLD`, `MA50`, `EMA21_EMA50`, `TREND_ATR`.
Bases de prix : `RAW`, `SPLIT_ADJUSTED`, `TOTAL_RETURN_ADJUSTED`,
`DERIVED_ADJUSTED` (refusée en mode strict; toujours flaggée).

## Formats supportés

- `OHLC_CACHE_JSON_V1` : les caches locaux `{symbol, rows:[{date, open,
  high, low, close, volume, [adjclose]}]}` présents sous `debug/` (lus en
  lecture seule, jamais modifiés ni stagés).
- `CSV_DAILY_V1` : CSV `date,open,high,low,close,volume[,adjclose]`.

## Reproduire un résultat

Le moteur est entièrement déterministe : aucun horodatage mural, aucun
aléatoire. Chaque `BacktestResultV1` porte un `resultHash` (sha256 de la
sérialisation stable triée). Relancer la même commande sur le même fichier
produit le même hash (`test/deterministic-results.test.mjs`).

## Ajouter plus tard…

- **Une source de données** : écrire un adaptateur dans `src/data/` qui
  produit des `DailyBarV1` via `normalizeDailyBars` en déclarant
  explicitement `ohlcBasis`; ne jamais mélanger raw et adjusted.
- **Une stratégie** : implémenter l'interface de
  `src/strategy/strategyInterface.mjs` (fonction `decide(ctx)` pure,
  aucun accès aux bougies futures, intents `ENTER_LONG/HOLD/REDUCE_25/
  REDUCE_50/EXIT/NO_ACTION`), l'enregistrer dans `STRATEGIES` de `cli.mjs`.
- **Un benchmark** : passer `benchmarks: {SYM: series}` au featureEngine ou
  au régime; les dates absentes restent null (`BENCHMARK_UNAVAILABLE`).

## Limites connues (V1)

- Les caches locaux fournissent un OHLC split-adjusted **sans dividendes** :
  le rendement total des payeurs de dividendes (SPY, QQQ) est sous-estimé
  (warning `DIVIDENDS_NOT_INCLUDED` systématique).
- Pas de demi-séances (early closes) dans `marketSession`.
- Pas de raw OHLC natif dans les caches : la base `RAW` est refusée pour
  ces fichiers plutôt que fabriquée.
- Un seul symbole par portefeuille, cash account, actions entières,
  aucune marge — les ETF à levier restent des instruments à levier mais le
  portefeuille n'en ajoute pas.
- Baselines à paramètres fixes : aucune conclusion de performance ne doit
  en être tirée (`PILOT_TECHNICAL_ONLY`).
