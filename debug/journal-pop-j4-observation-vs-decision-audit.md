# Audit J4-B — Observations vs décisions réelles (Journal POP)

> **Lecture seule** — généré le 2026-06-07T14:27:04 · 3184 records · 334 assignations observationnelles
> Source : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite`

## Verdict global

**334 assignations observationnelles (hors retests intraday) ne représentent que 108 expirations distinctes assignées (ratio 3.09×). Le Journal POP additionne actuellement des variantes SAFE/AGRESSIF/DTE/scan comme si chacune était un trade distinct — ce qui gonfle artificiellement les taux d'assignation par ticker.**

- TQQQ : Les 6 assignations observationnelles ne représentent qu'1 expiration réelle distincte — duplication par SAFE/AGRESSIF/DTE/scan. Ratio duplication TQQQ : 6× (6 obs / 1 exp).
- Implication : Pour juger si SAFE > AGRESSIF ou quel DTE est meilleur, utiliser strategy_choice_count. Pour simuler un trader qui ne vend qu'un put par expiration, utiliser selected_trade_count (= expiration_count).

## Définitions des signatures

| Signature | Clé | Usage |
| --- | --- | --- |
| A. observation_signature | ticker + selExp + scanSessionId + DTE + mode + strike | Variante complète d'observation |
| B. expiration_signature | ticker + selectedExpiration | Événement d'expiration réel |
| C. strategy_choice_signature | ticker + selExp + DTE + mode | Choix stratégique DTE/mode |
| D. trade_candidate_signature | ticker + selExp + DTE + strike | Candidat de trade concret |
| selected_trade_count | = expiration_signature | 1 contrat par expiration (simulation réaliste) |

## 1. Tickers focus

| Ticker | Obs. résolues | Obs. assignées | Exp. distinctes | Sessions scan | DTE | Modes | Strikes | Ratio dup. |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 52 | 6 | 1 | 3 | 3, 4, 7 | AGGRESSIVE, SAFE | 76, 78, 79, 80, 81 | 6 |
| APLD | 38 | 3 | 1 | 2 | 4, 7 | AGGRESSIVE, SAFE | 40.5, 41.5, 43 | 3 |
| HOOD | 52 | 3 | 2 | 3 | 4, 7, 8 | AGGRESSIVE | 75, 84 | 1.5 |
| SOFI | 36 | 6 | 1 | 3 | 3, 4, 7 | AGGRESSIVE, SAFE | 16.5, 17, 17.5 | 6 |
| BAC | 8 | 2 | 1 | 1 | 7 | AGGRESSIVE, SAFE | 50 | 2 |
| CCL | 40 | 4 | 1 | 4 | 7, 8 | AGGRESSIVE | 25 | 4 |
| HIMS | 32 | 0 | 0 | 0 | — | — | — | — |

## 2. TQQQ — détail des assignations observationnelles

**Les 6 assignations observationnelles ne représentent qu'1 expiration réelle distincte — duplication par SAFE/AGRESSIF/DTE/scan.**

- Observations assignées : **6**
- Expirations distinctes : **1**
- Choix stratégiques (DTE×mode) : **6**
- Candidats trade (DTE×strike) : **6**
- Ratio duplication : **6×**

| selExp | expiration | scanDate | scanSessionId | DTE | mode | strike | close | depth% | depth | assigned | rend.% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260605 | 20260605 | 2026-06-02 | 20260602_094 | 3 | AGGRESSIVE | 81 | 73.05 | -9.81 | profonde | oui | 0.91 |
| 20260605 | 20260605 | 2026-06-02 | 20260602_094 | 3 | SAFE | 79 | 73.05 | -7.53 | profonde | oui | 0.58 |
| 20260605 | 20260605 | 2026-06-01 | 20260601_112 | 4 | AGGRESSIVE | 80 | 73.05 | -8.69 | profonde | oui | 0.87 |
| 20260605 | 20260605 | 2026-06-01 | 20260601_112 | 4 | SAFE | 78 | 73.05 | -6.35 | profonde | oui | 0.58 |
| 20260605 | 20260605 | 2026-05-29 | 20260529_112 | 7 | AGGRESSIVE | 79 | 73.05 | -7.53 | profonde | oui | 1.1 |
| 20260605 | 20260605 | 2026-05-29 | 20260529_112 | 7 | SAFE | 76 | 73.05 | -3.88 | moderee | oui | 0.62 |

## 3. Comparaison des signatures

### Global

| Métrique | Count |
| --- | --- |
| observation_signature (A) | 334 |
| expiration_signature (B) | 108 |
| strategy_choice_signature (C) | 305 |
| trade_candidate_signature (D) | 225 |
| selected_trade_count | 108 |
| raw observation count | 334 |

### Focus tickers

| Ticker | Obs (A) | Exp (B) | Stratégie (C) | Candidat (D) | Trade choisi | Ratio |
| --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 6 | 1 | 6 | 6 | 1 | 6 |
| APLD | 3 | 1 | 3 | 3 | 1 | 3 |
| HOOD | 3 | 2 | 3 | 3 | 2 | 1.5 |
| SOFI | 6 | 1 | 6 | 5 | 1 | 6 |
| BAC | 2 | 1 | 2 | 1 | 1 | 2 |
| CCL | 4 | 1 | 2 | 2 | 1 | 4 |
| HIMS | 0 | 0 | 0 | 0 | 0 | — |

## 4. Ratio de duplication (inflationRatio)

| Ticker | observationAssignedCount | distinctExpirationAssignedCount | inflationRatio |
| --- | --- | --- | --- |
| TQQQ | 6 | 1 | 6 |
| APLD | 3 | 1 | 3 |
| HOOD | 3 | 2 | 1.5 |
| SOFI | 6 | 1 | 6 |
| BAC | 2 | 1 | 2 |
| CCL | 4 | 1 | 4 |
| HIMS | 0 | 0 | — |

**Global** : 334 / 108 = **3.09×**

## 5. SAFE vs AGRESSIF (focus tickers)

Pour chaque ticker × selectedExpiration × DTE : comparer si SAFE ou AGRESSIF aurait évité l'assignation et lequel payait plus.

| Ticker | selExp | DTE | close | SAFE? | AGG? | strike SAFE | strike AGG | rend SAFE% | rend AGG% | SAFE évite? | AGG évite? | plus sûr | plus payant |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| APLD | 20260605 | 4 | 39.62 | oui | oui | 40.5 | 43 | 0.59 | 1.3 | non | non | SAFE | AGGRESSIVE |
| APLD | 20260605 | 7 | 39.62 | — | oui | — | 41.5 | — | 1.54 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| BAC | 20260515 | 7 | 49.77 | oui | oui | 50 | 50 | 0.54 | 0.54 | non | non | TIE | TIE |
| CCL | 20260515 | 7 | 24.64 | — | oui | — | 25 | — | 0.96 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| CCL | 20260515 | 8 | 24.64 | — | oui | — | 25 | — | 1 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| HOOD | 20260522 | 8 | 73.64 | — | oui | — | 75 | — | 1.13 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| HOOD | 20260605 | 4 | 82.47 | — | oui | — | 84 | — | 1.02 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| HOOD | 20260605 | 7 | 82.47 | — | oui | — | 84 | — | 1.07 | — | non | AGGRESSIVE_ONLY_ASSIGNED | AGGRESSIVE_ONLY |
| SOFI | 20260605 | 3 | 16.03 | oui | oui | 17 | 17 | 0.82 | 0.82 | non | non | TIE | TIE |
| SOFI | 20260605 | 4 | 16.03 | oui | oui | 17 | 17.5 | 0.53 | 0.91 | non | non | SAFE | AGGRESSIVE |
| SOFI | 20260605 | 7 | 16.03 | oui | oui | 16.5 | 17 | 0.55 | 0.88 | non | non | SAFE | AGGRESSIVE |
| TQQQ | 20260605 | 3 | 73.05 | oui | oui | 79 | 81 | 0.58 | 0.91 | non | non | SAFE | AGGRESSIVE |
| TQQQ | 20260605 | 4 | 73.05 | oui | oui | 78 | 80 | 0.58 | 0.87 | non | non | SAFE | AGGRESSIVE |
| TQQQ | 20260605 | 7 | 73.05 | oui | oui | 76 | 79 | 0.62 | 1.1 | non | non | SAFE | AGGRESSIVE |

## 6. DTE — observations vs expirations distinctes

### Global

| DTE | Par observations | Par expirations distinctes |
| --- | --- | --- |
| 2 | 11 | 7 |
| 3 | 43 | 22 |
| 4 | 88 | 47 |
| 7 | 115 | 50 |
| autres | 77 | 35 |

### Par ticker focus

#### TQQQ

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 2 | 1 |
| 4 | 2 | 1 |
| 7 | 2 | 1 |
| autres | 0 | 0 |

#### APLD

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 0 | 0 |
| 4 | 2 | 1 |
| 7 | 1 | 1 |
| autres | 0 | 0 |

#### HOOD

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 0 | 0 |
| 4 | 1 | 1 |
| 7 | 1 | 1 |
| autres | 1 | 1 |

#### SOFI

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 2 | 1 |
| 4 | 2 | 1 |
| 7 | 2 | 1 |
| autres | 0 | 0 |

#### BAC

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 0 | 0 |
| 4 | 0 | 0 |
| 7 | 2 | 1 |
| autres | 0 | 0 |

#### CCL

| DTE | Observations | Expirations distinctes |
| --- | --- | --- |
| 2 | 0 | 0 |
| 3 | 0 | 0 |
| 4 | 0 | 0 |
| 7 | 3 | 1 |
| autres | 1 | 1 |

## 7. Métriques futures recommandées

- **observation_count** — Comparer les variantes SAFE/AGRESSIF/DTE sur le même scan — utile pour la recherche de formule. (Chaque record résolu (mode × DTE × strike × scanSession).)
- **expiration_count** — Mesurer le risque réel par événement d'expiration — 1 ticker × 1 selectedExpiration. (Événements d'expiration distincts assignés.)
- **strategy_choice_count** — Comparer quel DTE/mode performe — ticker × expiration × DTE × mode. (Choix stratégiques distincts (sans distinguer le strike si mode fixe le strike).)
- **trade_candidate_count** — Comparer les strikes candidats pour un DTE donné — ticker × expiration × DTE × strike. (Candidats de trade distincts.)
- **selected_trade_count** — Simulation réaliste : 1 contrat choisi par expiration — le dénominateur le plus proche d'une décision humaine. (1 par ticker × selectedExpiration (choix unique implicite).)

> **Recommandation principale** : Pour le Journal POP orienté décision : afficher selected_trade_count (expirations assignées) comme métrique principale, et observation_count comme métrique secondaire « variantes testées ».

## 8. Recommandations J4-C (UI)

| Élément UI | Priorité | Description |
| --- | --- | --- |
| Assignations observationnelles | haute | Afficher explicitement le nombre de records assignés (SAFE + AGRESSIF + DTE) avec libellé « observationnel » pour éviter la confusion avec des trades réels. |
| Expirations assignées | haute | Ajouter le compteur distinct ticker×selectedExpiration — c'est le vrai nombre d'événements de risque. |
| Ratio de duplication | haute | Montrer inflationRatio = observations / expirations (ex. TQQQ 6/1 = 6.0×) pour signaler le double-comptage stratégique. |
| SAFE aurait évité ? | moyenne | Pour chaque expiration assignée en AGRESSIF, indiquer si le strike SAFE du même DTE/scan aurait évité l'assignation (close ≥ strike SAFE). |
| AGRESSIF valait le risque ? | moyenne | Comparer rendement CSP AGRESSIF vs profondeur d'assignation — badge si prime plus élevée mais assignation plus profonde que SAFE. |
| DTE : observations vs expirations | moyenne | Dans le breakdown DTE, afficher deux colonnes : par observations ET par expirations distinctes (corrige l'ambiguïté J4-A/Q7). |
