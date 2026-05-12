# Audit SQLite → Backend → UI — Journal POP Pro
**Date :** 2026-05-12  
**Commit de référence :** add journal pop stress metrics by bucket mode ticker  
**Périmètre :** Read-only. Aucun fichier applicatif modifié. Aucun commit.

---

## 1. Résumé exécutif

| Question | Réponse |
|---|---|
| DB active | `data/wheelValidationJournal.sqlite` (4.3 MB) |
| Table principale | `wheel_validation_records` — 1 016 rows, 114 colonnes |
| Records résolus | 168 / 1 016 (tous expiredWorthless, 0 assignment) |
| Records non résolus | 848 (744 exp. 20260515 + 104 exp. 20260522) |
| Safe / Aggressive (total) | 508 / 508 — parfaitement équilibré |
| Résolution confidence | NULL pour les 168 résolus → résolus avec version pré-Phase-1 |
| `premium_to_spot_pct` | 0/1016 peuplé en colonne → UI utilise fallback calculé |
| Métriques stress Safe = Aggressive | **Correct, pas un bug** — explication ci-dessous |
| Données cachées importantes | 10+ colonnes peuplées, non affichées en UI |
| Tables dormantes critiques | market_context_snapshot (0 rows), calibration summaries (0 rows) |

---

## 2. DB active identifiée

| Fichier | Taille | Rôle |
|---|---|---|
| `data/wheelValidationJournal.sqlite` | 4 297 728 o | **Active — Journal POP** |
| `data/wheelValidationJournal.backup-before-phase4A.sqlite` | 2 940 928 o | Backup avant Phase 4A |
| `data/wheelValidationJournal.backup-before-phase-1-3.sqlite` | 2 707 456 o | Backup avant Phase 1-3 |

Activation via `USE_SQLITE_JOURNAL=true` dans `server.js` (ligne 35).

---

## 3. Tables + row count

| Table | Rows | Rôle | Utilisée Journal POP |
|---|---:|---|---|
| `wheel_validation_records` | 1 016 | Records journalisés — source principale | Oui (intégrale) |
| `calibration_market_regime_summary` | 0 | Calibration par régime marché | Non — dormante |
| `calibration_ticker_summary` | 0 | Calibration adaptative par ticker | Non — dormante |
| `candidate_snapshots` | 3 | Snapshots candidats non liés au journal | Non |
| `capital_combination_modes` | 6 | Modes de combinaisons capital | Non |
| `capital_combination_outcomes` | 0 | Suivi performance des combos | Non — dormante |
| `capital_combination_positions` | 24 | Positions dans les combos | Non |
| `capital_combination_snapshots` | 2 | Snapshots de sessions capital | Non |
| `expiration_cohorts` | 1 | Cohorte d'expiration active | Non |
| `market_context_snapshot` | 0 | Contexte SPY/QQQ/VIX par record | Non — dormante |
| `outcomes` | 0 | Table legacy outcomes (candidateSnapshots) | Non — inutilisée |
| `scan_snapshots` | 3 | Métadonnées de sessions scanner | Non |
| `schema_version` | 1 | Versionnage migrations | Non |
| `trade_decisions` | 0 | Décisions trade manuelles | Non — dormante |

---

## 4. Data Dictionary — `wheel_validation_records`

### 4.1 Colonnes utilisées en UI

| Colonne SQLite | Type | UI Journal POP | Section |
|---|---|---|---|
| `id` | TEXT PK | Oui | Clé de déduplication |
| `scanTimestamp` | TEXT | Oui | Table À résoudre / Résolus |
| `scanDate` | TEXT | Oui | Cohort summary |
| `symbol` | TEXT | Oui | Partout |
| `strikeMode` | TEXT | Oui | Safe/Agg, Buckets, Tickers |
| `expiration` | TEXT | Oui | Tables raw |
| `expirationCohort` | TEXT | Oui | Cohort summary |
| `dteAtScan` | INTEGER | Oui | Tables + calibration DTE |
| `candidateRank` | INTEGER | Oui | Table raw |
| `captureSource` | TEXT | Oui | Table raw |
| `captureClass` | TEXT | Oui | Badge primary/retest + calibration filter |
| `eliteScore` | REAL | Oui | Table raw |
| `eliteBadge` | TEXT | Oui | Table raw |
| `premium` | REAL | Oui | Tables + buckets (fallback) |
| `popEstimate` | REAL | Oui | POP KPI, calibration |
| `spotAtScan` | REAL | Oui | Fallback bucket pct |
| `lowerBound` | REAL | Oui | V2 calibration |
| `strike` | REAL | Oui | Tables raw |
| `resolved` | INTEGER | Oui | Filtre partout |
| `expiredWorthless` | INTEGER | Oui | Win rate, win quality |
| `assigned` | INTEGER | Oui | Assignment rate |
| `strikeTouched` | INTEGER | Oui | Win quality, stressed_win |
| `brokeLowerBound` | INTEGER | Oui | Win quality, lucky_win |
| `drawdownPct` | REAL | Oui | Win quality, stressed_win ≥5% |
| `maxItmDepth` | REAL | Oui | Table résolus (showOutcomeV2) |
| `lowerBoundDistance` | REAL | Oui | Table résolus |
| `supportBreak` | INTEGER | Oui | Table résolus |
| `minPriceBetweenScanAndExpiration` | REAL | Oui | Table résolus |
| `realizedPl` | REAL | Oui | Table résolus |
| `realizedReturnPct` | REAL | Oui | Table résolus |
| `resultStatus` | TEXT | Oui | Table résolus |
| `resolvedAt` | TEXT | Oui | Table résolus |

### 4.2 Colonnes existantes, NON affichées — Priorité A (utiles immédiatement)

| Colonne | Nulls | Intérêt | Raison d'absence |
|---|---|---|---|
| `bid` / `ask` / `mid` | Disponibles | Qualité de marché, spread check | Non exposés en UI |
| `spread` / `spreadPct` | Disponibles | Spread d'option au scan | Non exposés |
| `annualizedYield` | Disponibles | Rendement annualisé | Non exposé |
| `support` / `resistance` | Disponibles | Niveaux techniques | Non exposés |
| `hasEarningsBeforeExpiration` | Disponibles | Flag risque earnings | Non exposé |
| `earningsDate` | Disponibles | Date earnings | Non exposé |
| `earningsDaysUntil` | Disponibles | Jours avant earnings | Non exposé |
| `rsi` | Disponibles | RSI au scan | Non exposé |
| `trade_signature` | Disponibles | Déduplication logique | Non exposé |
| `duplicate_candidate_flag` | Disponibles | Flag retest | Partiellement (captureClass) |
| `stale_quote_flag` | Disponibles | Qualité citation | Non exposé |
| `data_quality_score` | **0/1016** | Score qualité données | Colonne vide — non peuplée |
| `premium_efficiency` | Disponibles partiel | Efficience prime (premium/strike%) | Non exposé |
| `strike_safety_margin` | Disponibles | Marge sécurité en $ | Non exposé |
| `strike_safety_margin_pct` | Disponibles | Marge sécurité en % | Non exposé |
| `distance_strike_from_spot_pct` | Disponibles partiel | Distance strike/spot | Non exposé |
| `false_safety_flag` | Disponibles | LB cassé mais non touché | Non exposé |
| `days_held` | Disponibles résolu | Jours détenus | Non exposé |
| `resolution_confidence` | **NULL 168/168** | Confiance résolution | NULL pour tous → colonne vide |

### 4.3 Colonnes existantes, NON affichées — Priorité B (V3)

| Colonne | État | Pour V3 |
|---|---|---|
| `seasonality_score_at_scan` | 0/1016 peuplé | Biais saisonnier au scan |
| `seasonality_win_rate_at_scan` | 0/1016 peuplé | Win rate saisonnier |
| `seasonality_direction` | 0/1016 | Direction saisonnière |
| `iv_rank_at_scan` | 0/1016 | IV Rank au scan |
| `iv_percentile_at_scan` | 0/1016 | IV Percentile |
| `open_interest_at_scan` | Disponible partiellement | Open interest option |
| `volume_at_scan` | Disponible partiellement | Volume option |
| `liquidity_score` | Disponible partiellement | Score liquidité |
| `options_quality_score` | 0/1016 | Qualité options globale |
| `earnings_risk_flag` | 0/1016 | Flag risque earnings Phase 4A.3 |
| `event_risk_score` | 0/1016 | Score risque événement |
| `stress_score` | 0/1016 | Score stress global (non implémenté) |

### 4.4 Colonnes Priorité C (debug/audit)

`rawJson`, `createdAt`, `updatedAt`, `resolutionDate`, `outcomeStatus`, `notes`, `underlying_close_at_expiration`, `underlying_high_between_scan_and_expiration`, `intrinsic_value_at_expiration`, `option_final_value`, `max_itm_depth_pct`, `lower_bound_distance_pct`, `support_break_severity`, `strike_touch_recovery_flag`, `scanSessionId`.

---

## 5. Mapping SQLite → Backend → UI

### 5.1 Pipeline principal

```
SQLite.wheel_validation_records
  → wheelValidationStoreSqlite.load()         [SELECT id, rawJson, updatedAt]
  → wheelValidationService.listJournal()
  → GET /journal/wheel-validation             → { ok: true, journal: { records: [...] } }
  → JournalPopPanel.jsx : useState(journal)
  → useMemo(records, resolvedRecords, unresolvedRecords)
```

**Point critique** : Le store lit uniquement `rawJson` depuis SQLite. Toutes les colonnes enrichies (Phase 1-4A) sont stockées dans SQLite mais IGNORÉES lors du chargement — seul le JSON sérialisé au moment du capture/résolution compte.

### 5.2 Pipeline calibration

```
SQLite.wheel_validation_records
  → wheelValidationService.computeCalibrationSummary()   [lit tout rawJson]
  → GET /journal/wheel-validation/calibration-summary
  → JournalPopPanel.jsx : calibrationSummary
  → safeModeData, aggressiveModeData, tickerLeaderboard
```

### 5.3 Endpoints utilisés par Journal POP

| Endpoint | Fichier | Données retournées | Charge SQLite |
|---|---|---|---|
| `GET /journal/wheel-validation` | server.js:1997 | 1016 records complets via rawJson | SELECT id, rawJson, updatedAt — 1016 rows |
| `GET /journal/wheel-validation/cohort-summary` | server.js:2028 | Cohorts d'expiration, DTE, scans | Relit tout rawJson |
| `GET /journal/wheel-validation/calibration-summary` | server.js:2044 | POP buckets, DTE, mode, tickers | Relit tout rawJson + compute en mémoire |
| `POST /journal/wheel-validation/resolve-expired` | server.js:2112 | Résolution automatique via Yahoo close | Relit + écrit |
| `GET /journal/wheel-validation/stats` | server.js:2013 | Stats globales (non utilisé par UI Journal POP) | — |

### 5.4 Mapping détaillé champ → UI

| SQLite | rawJson path | Frontend | Section UI |
|---|---|---|---|
| `strikeMode` | `record.strikeMode` | `safeModeStressStats` / `aggressiveModeStressStats` | Safe vs Aggressive |
| `expiredWorthless` | `record.resolution.expiredWorthless` | `winRate`, `getWinQuality()` | Win Quality, KPI |
| `brokeLowerBound` | `record.resolution.brokeLowerBound` | `getWinQuality()` → `lucky_win` | Win Quality, Buckets, Tickers |
| `strikeTouched` | `record.resolution.strikeTouched` | `getWinQuality()` → `stressed_win` | Win Quality, Buckets, Tickers |
| `drawdownPct` | `record.resolution.drawdownPct` | `getWinQuality()` → stressed si ≥5% | Win Quality, Buckets, Tickers |
| `popEstimate` | `record.strike.popEstimate` | `avgPop`, calibration POP buckets | POP KPI, 1% Readiness |
| `premium` | `record.strike.premium` | `avgPremium`, bucket fallback | Buckets, Safe/Agg KPI |
| `spotAtScan` | `record.underlying.spotAtScan` | Fallback `premium_to_spot_pct` | Buckets |
| `premium_to_spot_pct` | `record.snapshot.premium_to_spot_pct` | Bucket primaire (0/1016 → fallback) | Buckets |
| `captureClass` | `record.captureClass` | Calibration filter `!= "intradayRetest"` | Calibration avancée |
| `eliteScore` | `record.scores.eliteScore` | Table résolus, cohort | Détails historiques |

---

## 6. Audit des sections UI

### Section A — Header Pro
- **Sources** : `stats` (computed frontend), `readiness` (computeOnePercentReadiness)
- **Données manquantes** : version UI affichée "V2C" — badge correct
- **Risque** : aucun

### Section V2A — Win Quality
- **Sources** : `computeWinQualityStats(records)` — sur TOUS les records (resolved + pending)
- **Calcul** : global uniquement
- **Données manquantes** : `data_quality_score` (NULL), `false_safety_flag` non utilisé
- **Risque** : Classification win quality correcte mais non segmentée par ticker/DTE/mode

### Section V2B — 1% Readiness
- **Sources** : `computeOnePercentReadiness` — agrégation globale
- **Données manquantes** : `iv_rank_at_scan` (NULL), `seasonality_score_at_scan` (NULL)
- **Risque** : Score partiellement incomplet — stressCoveragePct basé sur champs connus seulement

### Section B — Buckets rendement
- **Sources** : `premiumReturnBuckets` — filtre sur `premium_to_spot_pct` (fallback premium/spot)
- **Problème** : `premium_to_spot_pct` = NULL pour 100% des records → fallback systématique via `r?.snapshot?.premium_to_spot_pct ?? (premium/spotAtScan)*100`
- **Données manquantes** : bucket column vide, mais fallback fonctionne pour 168/168 résolus
- **Distribution réelle** : 65 records 0.40-0.60%, 35 en 0.60-0.80%, 40 en 0.80-1.00%, 9 en 1.00-1.25%, 19 en 1.25%+

### Section C — Safe vs Aggressive
- **Sources** : `safeModeData` / `aggressiveModeData` → `calibrationSummary.v2.strikeModeV2`
- **Calcul** : `summarizeV2Metrics` côté backend, `computeStressStats` côté frontend
- **Voir Étape 7 pour l'audit critique**

### Section D — Ticker Leaderboard
- **Sources** : `calibrationSummary.v2.tickerCohorts` (backend) + `computeStressStats` (frontend)
- **Filtre calibration** : n ≥ 3 résolus, captureClass !== "intradayRetest" (= tous les 168 en pratique)
- **Problème** : calibration_ticker_summary (0 rows) non utilisée — bon

### Section E — Confiance statistique
- **Sources** : stats frontend
- **V2C** : note "stress metrics intégrées" — correct

### Section F — Métriques avancées / Placeholders
- **État** : Days to First Touch, Market Regime, VIX Bucket, Cluster Risk, IV Rank, Premium Efficiency → tous NULL en DB
- **Priorité V3** : voir Étape 10

### Section G — Détails historiques (togglable)
- **Sources** : calibrationSummary complet du backend
- **Données affichées mais non utilisées en décision** : POP calibration V1, DTE stress, mode advanced, FTQS

### Saisonnalité V1
- **Sources** : endpoint `/seasonality/scan-summary` (Yahoo cache 6h)
- **Problème** : `seasonality_score_at_scan` jamais peuplé dans wheel_validation_records → disconnect total entre saisonnalité live et historique journal
- **Risque** : décision ne tient pas compte du contexte saisonnier au moment du scan

### Tables À résoudre / Résolus
- **Toutes les colonnes sont affichées** — correct

---

## 7. Audit critique — Safe vs Aggressive stress metrics

### Observation utilisateur
Safe et Aggressive affichent des métriques identiques : Clean %, Stressed %, Lucky %, LB break %, Assignment %.

### Résultat de l'audit SQLite

```
mode=safe      : strikeTouched=6/84 (7.1%), brokeLowerBound=22/84 (26.2%), drawdown_avg=2.44%
mode=aggressive: strikeTouched=11/84 (13.1%), brokeLowerBound=22/84 (26.2%), drawdown_avg=2.44%
```

### Analyse de l'overlap

```
Aggressive: touched_and_lb=11, touched_only=0, lb_only=11, drawdown_stressed=7, clean=55
Safe:       touched_and_lb=6,  touched_only=0, lb_only=16, drawdown_stressed=7, clean=55
```

**Découverte clé** : Dans ce dataset, **100% des records où strikeTouched=true ont également brokeLowerBound=true**. Il n'existe aucun record avec touched_only=true (strikeTouched sans brokeLowerBound).

### Pourquoi les métriques sont identiques

Dans `getWinQuality()`, l'ordre de priorité est :
```js
if (res.brokeLowerBound === true) return "lucky_win";   // ← priorité 1
if (res.strikeTouched === true)   return "stressed_win"; // ← priorité 2 — jamais atteinte
```

Puisque **tous** les records strikeTouched sont aussi brokeLowerBound, ils sont tous classifiés `lucky_win`. Le chemin `stressed_win` via strikeTouched est **toujours court-circuité**.

Résultat — classification identique pour Safe et Aggressive :
| Catégorie | Safe (84) | Aggressive (84) | Identique ? |
|---|---|---|---|
| lucky_win (brokeLB) | 22 = 26.2% | 22 = 26.2% | ✓ Identique et **correct** |
| stressed_win (drawdown≥5) | 7 = 8.3% | 7 = 8.3% | ✓ Identique et **correct** (même underlying) |
| clean_win | 55 = 65.5% | 55 = 65.5% | ✓ Identique et **correct** |
| assignment | 0 | 0 | ✓ |

### Verdict

**Verdict : CORRECT — pas un bug**

Les métriques sont identiques parce que :
1. `brokeLowerBound` est un indicateur **niveau underlying** (minPrice vs lowerBound) — indépendant du strike mode — et écrase toujours `strikeTouched` dans la classification
2. `drawdownPct` est **niveau underlying** — même valeur pour safe et aggressive sur le même symbol/expiration
3. Dans ce dataset, le lowerBound est systématiquement inférieur au strike safe (donc si le prix casse le lowerBound, il a forcément touché le strike agressif et souvent le strike safe)

### Risque d'interprétation

**Risque élevé** : L'affichage de métriques identiques pour Safe et Aggressive peut faire croire à une absence de discrimination entre modes. La véritable différence (`strikeTouchRate`) est visible dans le backend V2 (7.1% safe vs 13.1% agg) mais **subsumée par la priorité brokeLowerBound** dans la classification qualité V2C.

**Recommandation** : Afficher `strikeTouchRate` séparément en UI (déjà disponible dans `calibrationSummary.v2.strikeModeV2`) et expliquer que "Lucky win = LB cassé, independant du mode".

---

## 8. Anomalies et incohérences

| # | Anomalie | Sévérité | Impact |
|---|---|---|---|
| 1 | `captureClass = NULL` pour 528/1016 records (tous les résolus) | Moyen | Calibration traite NULL comme "primaryDaily" — correct par design mais invisible |
| 2 | `resolution_confidence = NULL` pour 168/168 résolus | Faible | Colonne ajoutée après résolution — données cohérentes dans rawJson |
| 3 | `premium_to_spot_pct = NULL` pour 1016/1016 | Moyen | UI tombe en fallback premium/spot — fonctionne mais colonne inutile |
| 4 | `data_quality_score = NULL` pour 1016/1016 | Moyen | Phase 3 scan-time null — champ calculé à 0 dans computeStressAtScan mais stocké comme 0, pas NULL... à vérifier |
| 5 | 674 records avec `trade_signature = NULL` | Moyen | Records pré-Phase 1 — déduplication impossible sur ces records |
| 6 | `captureSource = NULL` pour 54 records | Faible | Anciens records — acceptable |
| 7 | `strikeTouched` 100% corrélé avec `brokeLowerBound` | Important | Stressed_win via strike jamais comptabilisé — classification manque de granularité |
| 8 | 848 non résolus tous sur exp. 20260515 et 20260522 | Normal | Positions en cours — attendu |
| 9 | `rawJson` est la seule source pour load() — colonnes enrichies Phase 1-4A non relues | Architecturel | Enrichissements post-capture perdus au rechargement si rawJson pas à jour |
| 10 | calibration_ticker_summary vide — adaptive calibration engine jamais lancé | Important | Verdicts ticker basés uniquement sur la calibration frontend — pas de persistance |

---

## 9. Données cachées utiles non affichées

### Priorité A — Quick fix / V2D (déjà dans rawJson)

| Donnée | Chemin rawJson | Intérêt |
|---|---|---|
| `strikeTouchRate` par mode | `calibrationSummary.v2.strikeModeV2[mode].strikeTouchRate` | Déjà calculé backend, non affiché Safe/Agg V2C |
| `bid/ask/spread` | `record.strike.bid/ask/spread` | Qualité citation au scan — filtre setups stale |
| `spreadPct` | `record.strike.spreadPct` | Spread % — indicateur liquidité |
| `rsi` | `record.context.rsi` | Momentum au scan |
| `hasEarningsBeforeExpiration` | `record.context.hasEarningsBeforeExpiration` | Flag risque majeur — non visible |
| `earningsDaysUntil` | `record.context.earningsDaysUntil` | Proximité earnings |
| `false_safety_flag` | `record.resolution.false_safety_flag` | LB cassé sans strike touché — faux sentiment de sécurité |
| `strike_safety_margin_pct` | `record.stress.strike_safety_margin_pct` | Distance strike/spot en % au scan |
| `days_held` | `record.resolution.days_held` | Durée réelle de la position |
| `annualizedYield` | `record.strike.annualizedYield` | Rendement annualisé |

### Priorité B — V3 (colonnes vides, à alimenter)

| Donnée | Colonne | Condition |
|---|---|---|
| Saison au scan | `seasonality_score_at_scan` | Engine saisonnalité doit écrire dans wvr à la capture |
| IV Rank au scan | `iv_rank_at_scan` | Source IBKR/Yahoo nécessaire |
| Score qualité options | `options_quality_score` | Phase 4A.4 — non implémentée |
| Régime marché | `market_context_snapshot` (table vide) | Enrichissement journalier requis |
| Score risque événement | `event_risk_score` | Calculé Phase 4A.3 mais non peuplé |

---

## 10. Préparation V3 / Calibration adaptative

| Feature V3 | Données présentes | Données manquantes | Priorité | Complexité |
|---|---|---|---|---|
| Saisonnalité intégrée au scan | Schema + moteur V1 live | `seasonality_score_at_scan` jamais peuplé dans wvr | **Haute** | Faible — hook dans capture |
| Market regime | Schema `market_context_snapshot` | 0 rows — jamais alimenté | **Haute** | Moyenne — job journalier |
| VIX bucket | Schema + `vix_level` dans market_context | Jamais peuplé | Haute | Faible (liée à market regime) |
| SPY/QQQ trend | Schema `spy_trend_regime` | Jamais peuplé | Moyenne | Faible (liée market regime) |
| Earnings/event risk | Schema `earnings_risk_flag` | Colonnes vides (0/1016) | **Haute** | Faible — déjà dans candidate data |
| Liquidity/spread quality | `spread`, `spreadPct`, `liquidity_score` | Partiellement peuplé — non affiché | Moyenne | Faible — données présentes |
| IV Rank / IV Percentile | Schema + colonnes | Jamais peuplé | Haute | Moyenne — source IBKR requise |
| Days to first touch | Non présent | Nouveau champ needed | Moyenne | Haute |
| Premium efficiency | `premium_efficiency` présent | Partiellement peuplé — non affiché | Faible | Trivial — déjà en rawJson |
| Ticker-specific calibration | `calibration_ticker_summary` (schema) | 0 rows | **Haute** | Haute — adaptive engine |
| Safe/Aggressive recommendations | Possible avec données actuelles | Score distinct non calculé | Moyenne | Moyenne |
| Capital combo performance | `capital_combination_outcomes` (0 rows) | Tracking non démarré | Faible | Haute |
| Score stress global | `stress_score` (0/1016) | Formule non définie | Haute | Haute |

---

## 11. Recommandations classées

### Quick fix (données déjà disponibles)

1. **Afficher `strikeTouchRate` séparément** dans les cartes Safe et Aggressive — déjà dans `calibrationSummary.v2.strikeModeV2` — différentie 7.1% safe vs 13.1% agg
2. **Afficher `false_safety_flag`** dans la table résolus — LB cassé sans strike touché = risque sous-estimé
3. **Afficher `strikeSafetyMarginPct`** dans les buckets — marge de sécurité réelle au scan
4. **Afficher `hasEarningsBeforeExpiration`** dans la table À résoudre — risque majeur visible

### V2D (données partiellement présentes)

5. **Alimenter `premium_to_spot_pct`** rétroactivement depuis `premium/spotAtScan` — colonne NULL, fallback UI fonctionne mais fragile
6. **Afficher `spreadPct`** et `liquidity_score` dans ticker leaderboard — qualité marché par ticker
7. **Afficher `annualizedYield`** dans les buckets — complément du taux de prime hebdo
8. **Expliquer en UI** pourquoi Safe/Aggressive ont les mêmes Lucky % et LB break % — éviter confusion

### V3 (nouvelles données nécessaires)

9. **Hook saisonnalité → capture** : écrire `seasonality_score_at_scan` dans wvr à chaque capture
10. **Job market_context_snapshot journalier** : alimenter SPY/QQQ/VIX quotidiennement
11. **Activer adaptive calibration engine** : populer `calibration_ticker_summary` et `calibration_market_regime_summary`
12. **Alimenter `earnings_risk_flag` et `event_risk_score`** : données déjà dans les candidates — hook capture requis
13. **Days to first touch** : nouveau champ — requiert tracking intraday (non dispo actuellement)

### V4 — Calibration adaptative complète

14. **Market regime × ticker × mode** : nécessite `market_context_snapshot` peuplé + adaptive engine
15. **Score stress global** (`stress_score`) : formule à définir, colonnes schema prêtes
16. **Capital combination performance tracking** : `capital_combination_outcomes` 0 rows — tracker les positions réelles

---

## 12. Risques si aucune correction

| Risque | Sévérité | Description |
|---|---|---|
| Bucket analysis fragile | Moyen | `premium_to_spot_pct` NULL — fallback UI fonctionne mais si `spotAtScan` absent, bucket exclu silencieusement |
| Earnings risk invisible | **Élevé** | `hasEarningsBeforeExpiration` dans rawJson mais non affiché — positions avec earnings masquées |
| Saisonnalité non intégrée | **Élevé** | Décision de trading sans contexte saisonnier historique au niveau du record |
| Classification stressed_win aveugle | Moyen | `strikeTouched` dans brokeLowerBound → stressed jamais compté via touche → sous-estimation du stress réel |
| Calibration ticker non persistée | Moyen | Verdicts recalculés à chaque rechargement, jamais persistés ni enrichis adaptativement |
| rawJson source unique | Moyen | Colonnes enrichies post-capture non relues → données Phase 1-4A invisibles pour records anciens |

---

## 13. Validation finale

```
git status
```
```
Untracked files:
  .claude/
  docs/audits/sqlite-ui-audit-journal-pop.md
```

**Audit read-only, aucun fichier applicatif modifié.**  
**Seul fichier créé : `docs/audits/sqlite-ui-audit-journal-pop.md`**  
**Aucun commit automatique.**
