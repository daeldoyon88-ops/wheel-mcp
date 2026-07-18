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
  test/                     18 suites (114 tests) anti-look-ahead + fixtures
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
- `CSV_DAILY_V1` : CSV `date,open,high,low,close,volume[,adjclose]
  [,splitFactor][,cashDividend]`. Entêtes normalisées (`src/data/
  csvHeader.mjs`) : insensibles à la casse, au BOM UTF-8, aux espaces et
  aux underscores; synonymes usuels mappés (`Adj Close`, `Adjusted Close`,
  `session_date`, `split_factor`, `Dividend`, ...); colonnes inconnues
  signalées dans `ignoredColumns` (jamais interprétées); collisions après
  normalisation refusées (`CSV_HEADER_COLLISION`); lignes au mauvais nombre
  de cellules refusées avec leur numéro de ligne; champs entre guillemets
  hors périmètre (refus explicite).

## Corporate actions

Politique canonique par base dans `src/data/corporateActionPolicy.mjs`
(`splitFactor` = actions après/avant, ex. 2 = 2:1, 0.2 = reverse 1:5;
`cashDividend` = cash par action admissible à l'ex-date) :

- **RAW** : le moteur applique les splits à la position avant l'open
  (fractions refusées : `FRACTIONAL_SPLIT_RESULT_UNSUPPORTED`, pas de
  cash-in-lieu) et crédite les dividendes en cash sur la quantité détenue
  à la clôture précédente (droit causal : une vente à l'open de l'ex-date
  conserve le dividende, un achat à l'open ne le reçoit pas);
- **SPLIT_ADJUSTED** : splits jamais réappliqués (`SPLIT_ALREADY_EMBEDDED`);
  dividendes crédités lorsque les montants existent; split+dividende même
  séance **autorisé**;
- **TOTAL_RETURN_ADJUSTED** : rien n'est réappliqué ni crédité (déjà dans
  les prix, aucun double comptage); split+dividende informatif autorisé;
- **DERIVED_ADJUSTED** : toute corporate action refuse le backtest
  (`CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED`);
- **RAW** split + dividende la même séance : refus
  `CORPORATE_ACTION_ORDER_AMBIGUOUS`;
- dividende déclaré sans position : `CASH_DIVIDEND_NOT_ENTITLED`
  (cashImpact 0);
- CSV header-only / sans lignes de données : `CSV_NO_DATA_ROWS`.

Chaque événement laisse une trace déterministe dans
`corporateActionEvents` et les dividendes crédités s'additionnent dans
`totalDividendsCash`, séparés du PnL des trades, des commissions et du
slippage. Suites dédiées : `dividend-accounting.test.mjs`,
`raw-split-accounting.test.mjs`, `csv-header-normalization.test.mjs`,
`manifest-coverage.test.mjs`, `missing-reasons.test.mjs`,
`contract-hardening.test.mjs`, `correctif-a-p2.test.mjs`.

Le laboratoire n'écrit jamais hors de son dossier : aucune mémoire
d'agent, aucun index persistant, aucun checkpoint externe (scan
insensible à la casse / séparateurs dans
`no-production-coupling.test.mjs`; ce scan ne contrôle que le **code du
laboratoire**, pas le comportement global de l'agent). Les tests
utilisent uniquement le répertoire temporaire du système et
suppriment leurs fichiers.

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
  au régime; série absente → `BENCHMARK_UNAVAILABLE`, date absente →
  `BENCHMARK_DATE_MISSING`.

## Limites connues (V1)

- Les caches locaux fournissent un OHLC split-adjusted **sans montants de
  dividendes par barre** : pour ces fichiers le rendement total des payeurs
  de dividendes (SPY, QQQ) reste sous-estimé (warning
  `DIVIDENDS_NOT_INCLUDED`). Lorsque `cashDividend` est fourni (CSV), le
  moteur le crédite causalement (voir « Corporate actions »).
- Actions entières uniquement : un split produisant une quantité
  fractionnaire refuse le backtest (`FRACTIONAL_SPLIT_RESULT_UNSUPPORTED`),
  aucun cash-in-lieu n'est simulé.
- Pas de demi-séances (early closes) dans `marketSession`.
- Pas de raw OHLC natif dans les caches : la base `RAW` est refusée pour
  ces fichiers plutôt que fabriquée.
- Un seul symbole par portefeuille, cash account, actions entières,
  aucune marge — les ETF à levier restent des instruments à levier mais le
  portefeuille n'en ajoute pas.
- Baselines à paramètres fixes : aucune conclusion de performance ne doit
  en être tirée (`PILOT_TECHNICAL_ONLY`).
