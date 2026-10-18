# Audit des combinaisons de capital

Audit indépendant (« fable »), 2026-07-11 — lecture seule, constats dérivés exclusivement du code source, de deux snapshots du dépôt et d'un harnais de tests dédié (`capital-combinations-audit-fable.mjs`, 43 vérifications, exécution déterministe, exit 0).

Chaque constat porte une **nature de preuve** parmi : *purement visuel* · *mécanisme théoriquement possible* (prouvé par lecture de code, non déclenché) · *bug reproductible par test* (cas contrôlé exécuté) · *impact démontré sur portefeuille* (la composition change dans le test, ou sur données réelles rejouées).

## 1. Résumé exécutif

Les trois simulations SAFE / BALANCED / AGGRESSIVE **isolent correctement les valeurs financières par jambe** : le bucket SAFE consomme exclusivement `_safeLeg`, AGGRESSIVE exclusivement `_aggLeg`, et tous les calculs financiers recodés indépendamment (capital, primes, rendements, remplissage, distance pondérée, concentration) concordent avec le portefeuille SAFE observé (25 400 $ utilisés / 100 $ libres / 99,6 % / 0,6118 % / −11,82 % / CRWV 29,92 % → « 30 % »).

Le cas NFLX est tranché : la ligne SAFE utilise bien la jambe SAFE (66 / 0,46 $ / 0,697 % / −10,1 % / POP 93,5), le grade affiché est le **grade de jambe** (safeGrade A) et la composante « grade +24 » est le **poids SAFE (24)** — AGGRESSIVE aurait donné +20, BALANCED +22. Seul `pick.mode` hérite du candidat principal (« AGGRESSIVE ») : **défaut d'étiquette uniquement** pour ce portefeuille.

L'audit confirme cependant 18 anomalies : 0 CRITICAL, **2 HIGH** (POP absent coercé en 0 % ⇒ grade dérivé WATCH qui écrase un grade stocké A et exclut le candidat ; fallback de grade vers le candidat principal quand `safeGrade` est absent, avec bascule de portefeuille démontrée CRM ↔ ORCL), 8 MEDIUM, 6 LOW, 2 UI ONLY. Six anomalies ont fait **changer un portefeuille dans un test contrôlé** ; aucune n'est démontrée sur le scan réellement observé (dont le snapshot n'existe pas dans le dépôt).

## 2. Verdict global

**PARTIAL**

- Aucune erreur financière (0 CRITICAL) : sélection de jambe, capital, primes, rendements, remplissage, concentration → conformes.
- Défauts confirmés de métadonnées et de sélection conditionnelle (2 HIGH démontrés par test), plus des incohérences d'affichage et de conception.

## 3. État Git initial

Capturé avant toute action (`git rev-parse --show-toplevel` ; `git status -sb`) :

- Racine : `C:/Users/melan/Desktop/wheel-mcp-remote` — conforme à l'attendu.
- Branche : `main...origin/main`.
- **0 fichier suivi modifié** (`git diff --name-only` vide).
- 180 entrées untracked préexistantes (lots `debug/*`, `scripts/*`, `result-scan-30.json`, `test-scan*.json`, `sqlite3`, `start-wheel-lab.bat`, `wheel-dashboard/data/wheelValidationJournal.sqlite`, `wheel-dashboard/scripts/`, etc.) — intactes.
- `debug/capital-combinations-audit/` (audit antérieur) préexistant — **non lu après consigne d'indépendance, non modifié**.

## 4. Architecture et flux de données

Flux reconstruit et vérifié fichier par fichier :

```
wheelScanner.js (scanTicker → safeStrike/aggressiveStrike, computeProScore(safeStrike) :372,731)
  → dashboard.jsx ibkrStrikeToDashboardStrike :3935-4024
      (spreadPct fraction×100 :4014 ; weeklyYield = premiumYield×100 = rendement PÉRIODE :3945-3960 ;
       popEstimate/popProfitEstimated initialisés à null :3999-4001)
  → mergeIbkrIntoDashboardCandidate :4080-4310
      (applyPop :4122-4152 ; computeModeRecommendation :467+ → safeGrade/aggressiveGrade ;
       getFinalDisplayRecommendation → finalDisplayMode/Grade :4284-4285 ; pro*Score hérités Yahoo ou 0 :4293-4295)
  → useMemo filtered :13209-13270 (recherche texte + filtre Mode UI + tri UI + FILTRE EXPIRATION :13269)
  → buildPortfolioCombos(filtered, capital, maxCapitalPct, maxPositions, rejetsIBKR) :13367-13375
      → buildCapitalComboCandidate :1156-1297 (jambes _safeLeg/_aggLeg + métriques par jambe ;
        _comboGradeScore figé sur le grade SOURCE :1229)
      → makeCombo par mode :1499
          bucketResolvedPool :1521-1613 (remplace selectedLeg/strike/prime/spread/yield/distance/POP/capital/grade ;
            NE remplace PAS finalDisplayMode)
          gates :1629-1704 (capital, grade/watch, bande yield, executionScore, spread, distance, filtres qualité)
          scoring buildCapitalComboScoreBreakdown :933-1040 (recalculé par bucket :1626)
          tri :1714-1720 (allocScore → _comboGradeScore SOURCE → yield → spread → distance)
          allocation gloutonne :2532-2545 (strict → soft ×1,1) ; filler :2547-2555 (pas SAFE) ;
            leftover densité V2 :2557-2624 (SAFE désactivé par défaut)
          createPick :2193-2223 (mode = finalDisplayMode SOURCE :2196 ; grade = grade bucket :2197 ;
            ni expiration, ni bid/ask, ni rang)
          agrégats :2653-2748 (rendement pondéré, concentration sur capital UTILISÉ, warnings) ; retour :3061-3087
            (freeCapital = capital BRUT − utilisé :3069)
  → UI : cartes résumé + summaryFor :10290-10296 ; modale ComboDetailModal :9996-10169 ;
    accordéon détails :10534-10839 ; carte RISQUE dominant :10301-10310 ; snapshot SQLite :10323-10357 ;
    Inspector _INSP_BUCKETS :8994-9052
```

Provenance des champs du pick final (vérifiée) :

| Provenance | Champs |
|---|---|
| Jambe du bucket | strike, premiumUnit, premiumCollected, capitalRequired/capitalUsed, weeklyReturn, spreadPct, distancePct, popEstimate, grade (si grade de jambe présent), proExecutionScore (recalculé :1600), _qualityOverlay (recalculé :1606-1611), selectionScore (recalculé :1626) |
| Candidat principal (source) | **mode** (:2196), grade en *fallback* si grade de jambe absent (:1586), **_comboGradeScore** (tie-break :1229→1716), selectedStrike.mode (:1494), proFinalScore/proDistanceScore dans qualityNorm (:949-951 — scanner = jambe SAFE), source/premiumKind |
| Absents du pick | expiration, bid, ask, finalRank/rang scanner (non consommés par l'allocateur) |

## 5. Résultats SAFE

- **Isolation financière : PASS.** Fixture NFLX (T1a) : strike 66, prime 0,46, 0,6970 %, spread 4,3, −10,1, POP 93,5, 6 600 $ — tous issus de la jambe SAFE. Rejeu réel : strikes des picks = strikes de jambe SAFE.
- **Grade : PASS nominal / FAIL conditionnel.** `safeGrade` présent ⇒ grade de jambe (T1b). `safeGrade` absent ⇒ fallback vers le grade du candidat principal (:1586) avec bascule de portefeuille démontrée (T2, AF-03).
- **Mode : FAIL métadonnée (visuel).** `pick.mode` = mode source (T1d, AF-01).
- **Portefeuille observé** : tous les recalculs concordent (§9) ; toutes les jambes ∈ bande [0,45 ; 0,80) et spreads ≤ 15 % (T11d).
- **Rejeu a3b 7 DTE** : SAFE réduit à 1 position (SMCI×3, 6 900 $, 27,1 % de remplissage, concentration 100 %) — double contrainte structurelle : cap ticker 30 % (7 650 $) exclut NVDA/INTC/PLTR/MRVL (contrats 9 900-19 000 $) et borne 0,80 % **période** exclut le reste à 7 DTE (T12d/T12e, AF-17).

## 6. Résultats BALANCED

- Choix de jambe par bande [0,75 ; 1,05) puis **fallback AGGRESSIVE avant SAFE** (:1546-1572). Défaut démontré (T6a, AF-07) : une jambe AGG hors bande (2,0 %) est choisie puis rejetée par `maxWeeklyYield`, alors que la jambe SAFE du même candidat (0,70 % ≥ min V3 0,675) aurait passé — *posséder une meilleure jambe AGGRESSIVE retire le ticker du mode*.
- Patch runtime V3 (`computeBalancedInstitutionalV3` :589-670) : minWeeklyYield 0,675, maxSpreadPct 22, caps dynamiques — l'Inspector affiche encore 0,70/20 (AF-14).
- Rejeu a3b : 3 positions (SOFI×4, SMCI×3, RBLX×1), 18 700 $ (73,3 %) ; **les 3 badges affichent « AGGRESSIVE » y compris sur jambes SAFE en bande** (AF-01 en données réelles).

## 7. Résultats AGGRESSIVE

- **Isolation financière : PASS** (T1e ; jambe SAFE absente ⇒ jamais de substitution, T13a).
- **Grade dérivé : FAIL conditionnel (HIGH, AF-02).** La chaîne `aggGrade` (:1192-1200) préfère le grade **dérivé** au grade **stocké** ; avec POP de jambe `null` (état réel du mapping UI quand l'estimation échoue), `gradeLeg` coerce null → 0 % → WATCH, qui écrase un « A » stocké ⇒ candidat exclu (T15c : avec POP ⇒ pick A ; sans POP ⇒ combo vide).
- Rejeu a3b : 4 positions (SMCI×2, RIVN×2, CVNA, HOOD), 24 900 $ (97,6 %), warnings « High beta 41 % » / « Ticker dominant 41 % » conformes aux formules codées.

## 8. Validation ligne par ligne

### 8.1 Portefeuille SAFE observé (données fournies — snapshot absent du dépôt)

Aucun snapshot du dépôt ne contient NFLX/CRWV/NOK ⇒ la *transmission runtime* exacte de ce scan est **« Non vérifiable avec le snapshot actuel »**. Validation en deux volets : (a) arithmétique sur les valeurs observées, (b) mécanisme de transmission prouvé sur fixture contrôlée NFLX (T1).

| Ticker | Jambe utilisée | Strike attendu/affiché | Prime | Rend. attendu (prime/strike) | Rend. affiché | Distance | Capital (strike×100) | Bande SAFE [0,45;0,80) | Spread ≤ 15 | Statut |
|---|---|---|---|---|---|---|---|---|---|---|
| NFLX | SAFE | 66 / 66 | 0,46 | 0,6970 % | 0,70 % | −10,1 | 6 600 | oui | 4,3 ✓ | **PASS financier / FAIL badge mode** (T1a/T1d) |
| TQQQ | SAFE | 68 / 68 | 0,40 | 0,5882 % | 0,59 % | −12,0 | 6 800 | oui | 7,2 ✓ | PASS arithmétique ; transmission non vérifiable |
| CRWV | SAFE | 76 / 76 | 0,45 | 0,5921 % | 0,59 % | −14,4 | 7 600 | oui | 8,5 ✓ | PASS arithmétique ; transmission non vérifiable |
| NOK | SAFE | 11 / 11 | 0,07 | 0,6364 % | 0,64 % | −11,6 | 1 100 | oui | 13,3 ✓ (grade B attendu : spread > 10) | PASS arithmétique ; transmission non vérifiable |
| SOFI | SAFE | 17 / 17 | 0,09 | 0,5294 % | 0,53 % | −9,5 | 1 700 | oui | 10,5 ✓ | PASS arithmétique ; transmission non vérifiable |
| RIVN | SAFE | 16 / 16 | 0,09 | 0,5625 % | 0,56 % | −8,5 | 1 600 | oui | 10,5 ✓ | PASS arithmétique ; transmission non vérifiable |

Colonnes bid/ask/POP individuels/scores transmis/rangs : non transportées par `createPick` (:2193-2223, T1g) et absentes des données fournies ⇒ « Non vérifiable avec le snapshot actuel ». Le mécanisme prouvé en T1 (fixture NFLX aux mêmes valeurs) montre que ces champs financiers viennent bien de la jambe SAFE quand ils existent.

### 8.2 Fixture NFLX (transmission contrôlée, T1)

| Champ | Attendu (jambe SAFE) | Transmis (pick moteur) | Statut |
|---|---|---|---|
| strike / premiumUnit | 66 / 0,46 | 66 / 0,46 | PASS |
| weeklyReturn / spreadPct / distancePct / popEstimate | 0,6970 / 4,3 / −10,1 / 93,5 | idem | PASS |
| capitalRequired / premiumCollected | 6 600 / 46 | idem | PASS |
| grade | A (safeGrade) | A | PASS |
| composante grade du score | +24 (poids SAFE) | +24 (AGG : +20 vérifié T1e) | PASS |
| mode | SAFE (jambe utilisée) | **AGGRESSIVE** (source) | **FAIL métadonnée** |

### 8.3 Rejeu réel a3b (expiration 2026-07-10, 25 500 $ / 100 % / 10 pos.)

| Mode | Positions | Capital utilisé | Libre | Picks (strike×contrats, badge mode) | Invariants vérifiés |
|---|---|---|---|---|---|
| SAFE | 1 | 6 900 $ (27,1 %) | 18 600 $ | SMCI 23×3 — badge **AGGRESSIVE** | Σ capitalUsed = totalCapital ; freeCapital = 25 500 − utilisé ; strike ∈ jambe SAFE |
| BALANCED | 3 | 18 700 $ (73,3 %) | 6 800 $ | SOFI 17×4, SMCI 23×3, RBLX 50×1 — 3 badges **AGGRESSIVE** | idem (T12c-BALANCED PASS) |
| AGGRESSIVE | 4 | 24 900 $ (97,6 %) | 600 $ | SMCI 24.5×2, RIVN 17×2, CVNA 63×1, HOOD 103×1 | idem (T12c-AGGRESSIVE PASS) |

## 9. Calculs financiers indépendants

| Métrique | Formule attendue | Formule codée (preuve) | Exemple numérique | Verdict |
|---|---|---|---|---|
| Capital CSP | strike × 100 × contrats | capitalPerContract = strike×100 (:1583-1585) ; cumul par contrat (:2235,2243) | 66×100 = 6 600 $ ; Σ = 25 400 $ | PASS |
| Prime totale | prime × 100 × contrats | premiumPerContract = prime×100 (:1602) ; cumul (:2236) | 0,46×100 = 46 $ ; Σ = 156 $ | PASS |
| Rendement à expiration | prime ÷ strike × 100 | leg.weeklyYield = premiumYield×100 (dashboard:3945-3955) ; fallback (premium/strike)×100 (:790-800) | 0,46/66 = 0,6970 % | PASS (mais rendement **période** malgré le nom — AF-17) |
| Rendement portefeuille | Σ primes ÷ déployable × 100 | summaryFor (:10290-10296) | 156/25 500 = **0,6118 %** ≈ 0,61 % | PASS |
| POP moyen | pondéré | Σ(POP×capitalUsed)/Σ(capitalUsed) (:9976-9987) | 1 seul POP fourni → valeur ~97 % **non vérifiable** | PASS formule / NON VÉRIFIABLE valeur |
| Distance OTM moyenne | pondérée par capital | weightedMetricByCapital (:10540) | −300 210/25 400 = **−11,8193 %** ≈ −12 % (moyenne simple −11,02 % ne collerait pas) | PASS |
| Spread % | homogène en % | fraction IBKR ×100 au merge (:4014) ; pas de double conversion (:25-54) | 0,0426 → 4,26 % | PASS (réserve bid>ask — AF-11) |
| Remplissage | utilisé ÷ déployable | used/usableCapital×100 (:2658) | 25 400/25 500 = 99,6078 % | PASS |
| Capital libre (objet combo) | déployable − utilisé | **capital BRUT − utilisé** (:3069) | maxCapitalPct 50 : 35 000 au lieu de 15 000 (T9a) | **FAIL si maxCapitalPct < 100** (AF-09) ; sans effet ici (100 %) |
| Concentration ticker | max ÷ dénominateur explicite | max(tickerUsed)/capital **UTILISÉ** ×100, seuil > 25 (:2728-2746) | CRWV 7 600/25 400 = 29,921 % → « 30 % » | PASS calcul / libellé ambigu (AF-16) |

Pièges spécifiquement vérifiés : prime÷spot (non — strike au dénominateur), bid/mid/ask (bid prioritaire :775-784), prime/action vs contrat (×100 systématique), spread absolu vs % (conversion unique :4014), mélange de jambes (bucket exclusif :1529-1543), arrondi prématuré (seul totalScore est arrondi, en fin :981-993), rendement position vs portefeuille (formules distinctes), POP simple vs pondéré (pondéré), distance avec mauvais spot (distance pré-calculée au merge, spot unique :4007-4010).

## 10. Score, grade et provenance des métadonnées

- Score recalculé **par bucket** (:1626) sur les valeurs de la jambe : yield/spread/distance/grade du bucket. Poids grade : SAFE 24, BALANCED 22, AGGRESSIVE 20 — le « +24 » observé sur NFLX **prouve** l'usage des poids SAFE (T1c) ; H4 rejetée.
- `proExecutionScore` recalculé par jambe (:1600) ; **`proFinalScore`/`proDistanceScore` hérités du scanner qui les calcule toujours sur la jambe SAFE** (wheelScanner:372-394,731) et injectés dans qualityNorm (:949-951) — biais borné ≈ ≤ 3,6 pts en bucket AGGRESSIVE (AF-12, mécanisme prouvé, flip non démontré). En IBKR direct ils valent 0 (:4293-4295).
- **Fallback de grade** : `resolvedGrade = bucketGrade ?? finalDisplayGrade` (:1586) — grade source appliqué à la jambe si le grade de jambe manque (AF-03, bascule CRM↔ORCL démontrée).
- **POP null coercé en 0 %** dans gradeLeg/getAggressivePriorityGrade (`Number(null)===0`, :530,543) ⇒ la clause explicite `pop == null || pop >= 80` est inatteignable ; en bucket AGGRESSIVE le **dérivé écrase le stocké** (:1192-1200) (AF-02, exclusions démontrées T15).
- **Tie-break n°2 du tri = `_comboGradeScore`**, figé sur le grade SOURCE (:1229,1252,:1716) — à score entier strictement égal, la classification source décide (AF-04, flip AAPL↔MSFT démontré, score 75 identique).
- `finalRank`/rangs scanner : **non consommés** par l'allocateur (aucune lecture dans makeCombo/createPick) — pas de contamination possible par ce canal.

## 11. Allocation du capital

Algorithme : **glouton itératif par sweeps** (strict → soft-cap ×1,1 → filler [pas SAFE] → leftover densité V2 [SAFE désactivé par défaut]), pas de solveur global (`alternateOrderingKnapsackNotSimulated` assumé dans le code :2939). Sélection par `marginalScore = allocScore + bonus diversification (16/7) − pénalité projetée` (:2113-2117), duel strict `>` puis allocScore (:2161-2170).

- Déterminisme : même input ⇒ même output (T5a, T12a) ; ordre inversé sans égalités ⇒ identique (T5c, T12b sur 25 tickers réels).
- **Égalités parfaites ⇒ premier de l'ordre d'entrée** (T4a, AF-05) ; l'ordre d'entrée est le tri/filtre de l'UI (:13249-13270) — le pool des combos dépend aussi de la recherche texte et du filtre Mode (AF-06).
- **Soft-cap incohérent** : limite ×1,1 posée (:2042-2043) puis re-check strict sans le facteur (:2089) ⇒ passe soft morte pour toute nouvelle ligne au-dessus du cap strict (T8a : contrat 3 200 $ ≤ 3 300 soft mais > 3 000 strict ⇒ portefeuille vide, `ticker_cap_reached ×2`) (AF-08).
- Multi-contrats : cumuls internes corrects (contracts/capitalUsed/premiumCollected :2233-2236) ; plafonds par mode respectés (2/3/4, +1 en soft).
- Portefeuille SAFE observé revalidé : 6 600+6 800+7 600+1 100+1 700+1 600 = **25 400 $** ; libre 100 $ ; remplissage 99,6078 % (T11a).
- `combo.freeCapital` = capital **brut** − utilisé (:3069) — persisté tel quel dans le snapshot SQLite (:10336) alors que l'UI principale recalcule le libre déployable (:10021,10556,10715) (AF-09, T9a).

## 12. Concentration et diversification

- Dénominateur moteur = **capital utilisé** (:2728-2735) ; seuil ticker dominant **> 25 %** (:2746) ; le préfixe UI donne exactement le message observé : « Concentration élevée : Ticker dominant 30% du capital » (:10609).
- CRWV : 7 600/25 400 = 29,921 % → arrondi « 30 % » ; sur le déployable 29,804 % → aussi « 30 % » (indiscernable à l'affichage ; le code utilise l'utilisé). Message cohérent, libellé « du capital » ambigu (AF-16).
- Caps cluster (thème/secteur/high-beta) appliqués après `minTargetPositions` ou sans alternative diversifiante (:2086-2111) ; composition crypto/spéculatif (:1935-1962). Rejeu réel : warnings « High beta 41 % » / « Ticker dominant 41 % » conformes.
- **Carte/modale RISQUE** : ticker dominant calculé sur `capitalRequired` (1 lot) (:10301-10310) ⇒ avec contrats > 1, divergence démontrée moteur 54,79 % vs affichage 78,43 % (T10a, AF-10 — le moteur, lui, est correct).

## 13. Cohérence de l'interface

| Élément | Constat | Origine |
|---|---|---|
| Badge « Mode / Grade » (modale :10127, accordéon :10751) | mode = source, grade = jambe ⇒ « AGGRESSIVE A » possible sur jambe SAFE | AF-01 (moteur, champ mal choisi) |
| Score détaillé (tooltip/summary) | cohérent : grade de jambe × poids du mode courant (+24 SAFE) | conforme |
| Cartes résumé vs accordéon | mêmes formules (`summaryFor` :10290-10296 vs :10534-10540) | conforme |
| « Libre dép. » (:10556,10715,10021) | recalculé usable − totalCapital : correct | conforme (mais persistance :10336 = valeur moteur brute, AF-09) |
| Colonne « Capital » (:10140,10779) | coût d'UN lot avec ×N séparé ; « Prime tot. » est un total | AF-10 (incohérence interne de ligne) |
| Carte RISQUE (:10301-10310) | dominant sur capitalRequired | AF-10 |
| Inspector (:8994-9052, :9860-9866) | affiche `allowedModes` comme critère (jamais appliqué) ; BALANCED 0,70/20 vs runtime V3 0,675/22 et texte carte « ≥0,675 · ≤22 % » (:10558-10563) | AF-13, AF-14 |
| « Rend. moy. » carte (:10427) | en réalité prime totale/déployable (rendement de portefeuille) | AF-16 |
| Mini-carte technique | non auditée (hors périmètre statique exécutable) | — |

## 14. Cas limites

Couverts par le harnais (43 vérifications — détail intégral dans le JSON, `harnessResults`) :

| Cas | Résultat | Preuve |
|---|---|---|
| Candidat principal AGGRESSIVE utilisé en SAFE / SAFE en AGGRESSIVE / BALANCED en SAFE | PASS — bucket purement par jambe ; le mode source n'influe ni financier ni score (seul badge + tie-break) | T1, T14a |
| Jambe SAFE ou AGGRESSIVE absente | PASS — aucune substitution (`NO_BUCKET_LEG_FOR_MODE`) | T13a |
| Prime nulle / manquante ; spread absent | PASS — jambe invalide, candidat exclu | T13b, T13c |
| bid > ask (spread négatif) | **FAIL** — accepté, noté au maximum, sélectionné | T7a (AF-11) |
| POP absent / nul | Non bloquant si grades stockés (T13d) ; **FAIL** sinon : coercion null→0 % ⇒ WATCH ⇒ exclusion (SAFE T15b, AGGRESSIVE T15c avec écrasement du A stocké) | T15 (AF-02) |
| Grade de jambe absent | **FAIL** — fallback grade source, portefeuille modifié | T2 (AF-03) |
| Mode absent | PASS — dérivé par getFinalDisplayRecommendation (rejeu T12) | T12 |
| Égalité exacte de scores / de rendement | **FAIL** — grade source puis ordre d'entrée décident | T3a, T4a (AF-04/05) |
| Changement d'ordre candidats/tickers | PASS sans égalités (T5c, T12b réel) ; FAIL sur égalités parfaites | T4a |
| Même scan exécuté deux fois | PASS — identique | T5a, T12a |
| Contrats > 1 ; limite ticker légèrement dépassée ; capital insuffisant | cumuls corrects ; soft-cap mort (T8a) ; `contract_size_too_large` correct | T10a, T8a |
| Portefeuille ~100 % rempli | PASS — recalcul indépendant 99,6078 % | T11a |
| Expiration divergente entre jambes | **non contrôlé structurellement** — aucune validation moteur, barrière unique = filtre UI :13269 | AF-15 (lecture code) |
| scoreBreakdown absent en entrée | PASS — recalculé par bucket (:1626) | code |
| finalRank d'une autre jambe | PASS — champ jamais consommé | code (grep) |
| Quote livrée obsolète / marché fermé | l'allocateur consomme l'objet reçu tel quel — fraîcheur à garantir en amont | code |

## 15. Déterminisme et mutations possibles

- **Aucune mutation des entrées** : pool entièrement gelé (`Object.freeze` récursif) avant exécution, aucun TypeError en mode strict (T1h) ; le moteur ne travaille que sur des copies par spread.
- **Isolation des trois modes confirmée** : `picks`/`pickMap`/`used` locaux à chaque `makeCombo` (:1735-1737) ; aucun objet pick partagé par référence entre SAFE et AGGRESSIVE (T5b) ; `VirtualAllocator` (simulations alternatives) possède son propre état et ne mute pas le baseline (lecture intégrale du module).
- Déterminisme : 2 exécutions identiques (T5a, T12a) ; ordre inversé/mélangé identique **hors égalités parfaites** (T5c, T12b sur données réelles : aucune égalité dans ce pool).
- Dépendances d'environnement : flags `optimizerV2` surchargés par localStorage si aucun override (EngineV2:20-34) — transparents via `flagsSnapshot` (:2999) ; harnais figé sur `{}` (AF-18).

## 16. Hypothèses confirmées ou rejetées

| Hyp. | Énoncé (résumé) | Verdict | Preuve |
|---|---|---|---|
| H1 | SAFE utilise les valeurs financières de la jambe SAFE | **CONFIRMÉE** | T1a + :1521-1613 + rejeu réel |
| H2 | SAFE conserve incorrectement le mode du candidat principal | **CONFIRMÉE** | T1d ; :1588-1612, :2196 ; 4 badges réels (T12d) |
| H3 | SAFE conserve incorrectement le grade du candidat principal | **PARTIELLEMENT CONFIRMÉE** | Nominal : non (T1b). Fallback safeGrade absent : oui, avec bascule (T2) |
| H4 | Le score SAFE utilise le bonus de grade AGGRESSIVE | **REJETÉE** | +24 = poids SAFE (:1459) ; AGG +20 (T1c/T1e) |
| H5 | Un mauvais grade peut modifier l'ordre | **CONFIRMÉE (cas contrôlé)** | T2c, T3a ; occurrence réelle non démontrée (T12b) |
| H6 | Un mauvais grade peut modifier le portefeuille final | **CONFIRMÉE (cas contrôlé)** | T2c (CRM↔ORCL), T3a (AAPL↔MSFT) |
| H7 | Le problème est uniquement visuel | **CONFIRMÉE pour le portefeuille observé** | T1a-c + T14a ; les mécanismes non visuels exigent des conditions absentes de ce scan |
| H8 | Capital SAFE correct | **CONFIRMÉE** | T11a (25 400/100/99,6078 %) |
| H9 | Rendement portefeuille correct | **CONFIRMÉE** | T11b (0,6118 %) |
| H10 | POP moyen correct | **NON VÉRIFIABLE** (formule pondérée confirmée) | T11g |
| H11 | Concentration 30 % correcte | **CONFIRMÉE** | T11f (29,921 % sur capital utilisé, seuil > 25) |
| H12 | Les trois combinaisons sont isolées | **CONFIRMÉE** | T1h, T5a/b/c, T12a |

## 17. Problèmes confirmés

Colonnes : nature de preuve = *visuel* / *mécanisme possible* / *reproductible par test* / *portefeuille modifié en test* / *démontré sur données réelles rejouées*.

| ID | Gravité | Mode | Ticker | Catégorie | Champ | Valeur attendue | Valeur réelle | Impact (nature de preuve) | Fichier | Fonction | Certitude | Correction minimale proposée |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AF-01 | UI ONLY | Tous | NFLX (ex.) ; réels : SMCI/SOFI/RBLX | METADATA/UI | pick.mode | mode de la jambe utilisée | finalDisplayMode source (« AGGRESSIVE A » sur jambe SAFE) | Badge trompeur ; zéro effet calcul/allocation (T14a) — *visuel, reproduit + 4 cas réels (T12d)* | capitalComboPortfolio.js:1588-1612, 2196 ; dashboard.jsx:10127,10751 | bucketResolvedPool / createPick | CONFIRMÉ | selectedLegMode = mode.label dans le pick (garder sourceMode) ; adapter 2 rendus |
| AF-02 | **HIGH** | AGGRESSIVE surtout (+ recommandation dérivée) | Tous si POP indisponible | SELECTION/SCORING | popDecimal → grade | POP inconnu non bloquant (clause `pop == null`) | `Number(null)=0` ⇒ POP 0 % ⇒ WATCH ; **dérivé écrase le A stocké** (:1192-1200) | Exclusion du combo — *portefeuille modifié en test* (T15b/c) ; réel non démontré (scan observé avait des POP) | capitalComboPortfolio.js:530,543,686-692,1186-1200 | gradeLeg / getAggressivePriorityGrade / buildCapitalComboCandidate | CONFIRMÉ (test) | garde null (`popDecimal == null ? null : Number(...)*100`) + stocké A/B avant dérivé |
| AF-03 | **HIGH** | SAFE (et BALANCED) | Tous si safeGrade absent | METADATA/SCORING | grade bucket | grade de la jambe, sinon dérivé de CETTE jambe | fallback = grade du candidat principal (:1586) | **CRM ↔ ORCL : portefeuille modifié en test** (T2b/c : safeGrade null ⇒ CRM A +24 sélectionné ; safeGrade B ⇒ ORCL) ; réel non démontré (merge fournit normalement safeGrade :4277) | capitalComboPortfolio.js:1586,1603 | bucketResolvedPool | CONFIRMÉ (test) | fallback = gradeLeg(jambe bucket) |
| AF-04 | MEDIUM | Tous | Ex æquo exacts | SCORING/METADATA | _comboGradeScore | départage sur attributs du bucket | tie-break n°2 = grade SOURCE, jamais recalculé (:1229→1716) | **AAPL ↔ MSFT à score 75 strictement égal : portefeuille modifié en test** (T3a) ; aucune égalité dans le pool réel (T12b) | capitalComboPortfolio.js:1229,1252,1716 | buildCapitalComboCandidate / tri | CONFIRMÉ (test) | recalculer _comboGradeScore post-bucket |
| AF-05 | MEDIUM | Tous | Ex æquo exacts | ALLOCATION/DATA FLOW | ordre de sélection | tie-break final stable | premier de l'ordre d'entrée gagne ; ordre d'entrée = tri/filtre UI (:13249-13270) | **Ordre inversé ⇒ portefeuille différent en test** (T4a) | capitalComboPortfolio.js:1714-1720,2161-2170 | tri / pickBestCandidate | CONFIRMÉ (test) | dernier critère stable (ticker asc) :1719 et :2166 |
| AF-06 | MEDIUM | Tous | Tous | DATA FLOW/DESIGN | pool d'entrée combos | pool stable par expiration | `filtered` = recherche + filtre Mode + tri UI (:13209-13270 → :13368) | Une recherche ou un filtre Mode reconstruit les 3 combos sur un sous-ensemble — *mécanisme prouvé par code* (non exécutable hors React) | dashboard.jsx:13209-13270,13367-13375 | useMemo filtered/combos | CONFIRMÉ (code) | baser les combos sur la liste expiration-scopée pré-filtres, ou l'afficher |
| AF-07 | MEDIUM | BALANCED | Bi-jambes hors bande | SELECTION/DESIGN | fallback de jambe | jambe conforme si elle existe | AGG d'abord sans test de bande ⇒ rejet ; la SAFE conforme jamais essayée (:1546-1572) | **Inclusion/exclusion inversée en test** (T6a : avec jambe AGG 2,0 % ⇒ exclu ; sans ⇒ inclus à 0,70 %) | capitalComboPortfolio.js:1546-1572,630,1659-1665 | bucketResolvedPool (balanced) | CONFIRMÉ (test) | fallback testant [minV3, max) par jambe |
| AF-08 | MEDIUM | Tous | Gros contrats | ALLOCATION/DESIGN | soft-cap ×1,1 | tolérance appliquée partout | re-check cluster strict sans ×1,1 (:2089) | **Portefeuille vide au lieu d'une ligne en test** (T8a : 3 200 ≤ 3 300 soft mais > 3 000 strict) | capitalComboPortfolio.js:2040-2043,2058,2086-2091 | evaluateCandidate | CONFIRMÉ (test) | même facteur au re-check, OU documenter soft = renforts seulement |
| AF-09 | MEDIUM | Tous | n/a | CALCULATION/DATA FLOW | combo.freeCapital | déployable − utilisé | **brut − utilisé** (:3069) ; persisté tel quel (:10336) | 35 000 au lieu de 15 000 à maxCapitalPct 50 — *reproductible par test* (T9a) ; UI principale recalcule juste ; sans effet sur le scan observé (100 %) | capitalComboPortfolio.js:3069 ; dashboard.jsx:10336 | makeCombo / handleSaveSnapshot | CONFIRMÉ (test) | freeCapital = usable − used (ou 2 champs) |
| AF-10 | UI ONLY | Tous | Contrats > 1 | UI | dominant RISQUE + colonne Capital | sur capitalUsed | sur capitalRequired (1 lot) (:10301-10310,10140,10779) | 78,43 % affiché vs 54,79 % moteur — *visuel, formule UI rejouée sur picks moteur réels* (T10a) ; totaux moteur corrects | dashboard.jsx:10301-10310,10140,10779 | dominant / ComboDetailModal / lignes | CONFIRMÉ | capitalUsed partout dans ces agrégats |
| AF-11 | LOW | Tous | Quotes croisées | CALCULATION/FALLBACK | spread négatif | bid > ask rejeté/signalé | accepté, note de spread MAXIMALE, sélectionné | *Mécanisme possible* (requiert corruption amont) — reproduit sur donnée synthétique (T7a) | capitalComboPortfolio.js:1205,914-919 | hasSafeLegValid / normalizeComboSpreadScore | CONFIRMÉ (mécanisme) | exiger spread ≥ 0 dans has*LegValid |
| AF-12 | MEDIUM | AGG/BAL (jambe agg) | Tous | SCORING/DATA FLOW | qualityNorm (proFinalScore/proDistanceScore) | sous-scores de la jambe scorée | hérités du scanner = toujours jambe SAFE (wheelScanner:372,731 ; :949-951) ; seul proExecutionScore recalculé (:1600) ; 0 en IBKR direct (:4293-4295) | ≤ ~3,6 pts d'une autre jambe — *mécanisme possible*, provenance prouvée, flip non démontré | capitalComboPortfolio.js:949-951,1600 ; wheelScanner.js:372-394,731 | buildCapitalComboScoreBreakdown / computeProScore | CONFIRMÉ (provenance) | recalculer les 2 sous-scores sur la jambe bucket, ou les retirer du qualityNorm combo |
| AF-13 | LOW | Tous | n/a | DESIGN/UI | allowedModes | appliqué ou absent | déclaré 3× (:1331,1396,1453), jamais consommé (grep + T14a) ; affiché comme critère (:9862) | Filtre imaginaire à l'écran — *visuel/documentaire* | capitalComboPortfolio.js + dashboard.jsx:8997-9035,9862 | modeConfigs / Inspector | CONFIRMÉ | supprimer des configs et du texte Inspector |
| AF-14 | LOW | BALANCED | n/a | UI | critères Inspector | miroir du runtime | 0,70/20 affichés vs V3 réel 0,675/22 (:630,639) et texte carte (:10558-10563) | Deux écrans se contredisent — *visuel* | dashboard.jsx:9014-9032 | _INSP_BUCKETS | CONFIRMÉ | dériver l'Inspector des valeurs V3 |
| AF-15 | LOW | Tous | n/a | DATA FLOW | expiration/bid/ask/rang du pick | transportés + expiration validée au moteur | absents (T1g) ; aucune validation moteur — barrière unique :13269 | Défense en profondeur absente — *mécanisme possible* ; aucune contamination réelle observée | capitalComboPortfolio.js:2193-2223 ; dashboard.jsx:13269 | createPick / filtered | CONFIRMÉ (absence) | copier expiration/bid/ask de selectedLeg ; assert d'homogénéité |
| AF-16 | LOW | Tous | n/a | UI | libellés agrégats | dénominateurs explicites | « du capital » = capital UTILISÉ (:2746) ; « Rend. moy. » = prime/déployable (:10427) | Ambiguïté de lecture — *visuel* (T11f : 29,92 vs 29,80 → tous deux « 30 % ») | capitalComboPortfolio.js:2746 ; dashboard.jsx:10427 | clusterWarnings / carte | CONFIRMÉ | préciser « du capital utilisé » ; renommer « Rend. port. » |
| AF-17 | MEDIUM | SAFE surtout, BALANCED | Tous à DTE ≠ 7 | DESIGN AMBIGUITY | bandes min/maxWeeklyYield | rendement comparable entre DTE | leg.weeklyYield = rendement PÉRIODE (:3945-3960) consommé tel quel (:790-800) ; weeklyNormalizedYield inutilisé ; borne SAFE 0,80 appliquée au period yield | ***Démontré sur données réelles rejouées*** : SAFE 1 position/27,1 %, concentration 100 % à 7 DTE (T12d/T12e) — comportement structurel, pas une erreur de calcul | dashboard.jsx:3945-3960 ; capitalComboPortfolio.js:790-800,1449-1450 | ibkrStrikeToDashboardStrike / getLegYieldPct / gates | CONFIRMÉ (structurel) | décision produit : bandes en rendement 7 j normalisé ou bornes par DTE — rejouer les harnais avant tout changement |
| AF-18 | LOW | Tous | n/a | FALLBACK | flags optimizerV2 | même input ⇒ même portefeuille | fusion silencieuse localStorage sans override (EngineV2:20-34 ; appel UI sans override :13368-13374) | Reproductibilité inter-navigateurs conditionnelle — *mécanisme confirmé*, transparent via flagsSnapshot (:2999) | capitalComboEngineV2.js:20-34 ; capitalComboPortfolio.js:56-61,1500 | getCapitalOptimizerV2Flags | CONFIRMÉ | afficher les flags effectifs ; les injecter dans tout replay |

**Bilan : 18 anomalies — 0 CRITICAL · 2 HIGH · 8 MEDIUM · 6 LOW · 2 UI ONLY.**

Portefeuille modifié dans un test contrôlé : AF-02, AF-03, AF-04, AF-05, AF-07, AF-08 (+ AF-17 démontré structurellement sur données réelles rejouées). Purement visuels : AF-01, AF-10, AF-13, AF-14, AF-16.

## 18. Hypothèses rejetées

- **H4** : le « +24 » de NFLX n'est pas un bonus AGGRESSIVE — c'est le poids grade SAFE (24) appliqué au grade de jambe A ; AGGRESSIVE aurait produit +20, BALANCED +22 (T1c/T1e).
- **H3 (volet nominal)** : quand `safeGrade` existe, le grade du candidat principal n'est PAS conservé — le bucket le remplace (T1b).
- Contamination par `finalRank`/rangs scanner : impossible — champs jamais consommés par l'allocateur (grep exhaustif).
- Mutation inter-modes / état partagé : rejetée — deep-freeze sans erreur, aucune référence partagée, déterminisme confirmé (T1h, T5, T12a).

## 19. Limites de l'audit

1. **Le scan exact du portefeuille observé n'existe pas dans le dépôt** (NFLX/CRWV/NOK absents des deux snapshots) : validation arithmétique + mécanisme sur fixture, pas de rejeu bit-à-bit ; bid/ask, POP individuels et scores affichés de ce scan : « Non vérifiable avec le snapshot actuel ».
2. `computeModeRecommendation` (dashboard.jsx:467-~800, production des grades stockés) non audité exhaustivement — les fréquences live de AF-02/AF-03 en dépendent.
3. Le rejeu a3b passe par un mapper réimplémenté (miroir documenté de :3935-4024) ; grades recalculés via `gradeLeg` sans POP (quotes frozen) — fidèle au moteur, approximatif vs merge complet.
4. UI non exécutée (pas de navigateur) : constats UI par lecture de code, chiffrés en rejouant les formules sur des picks moteur réels (T10a).
5. Aucun serveur/scan live/IBKR démarré ; localStorage inapplicable sous Node (flags figés `{}`).

## 20. Recommandations minimales

| # | Cible | Action minimale | Fichiers/fonctions | Risque régression | Tests |
|---|---|---|---|---|---|
| 1 | AF-02 | Garde null dans gradeLeg/getAggressivePriorityGrade + grade stocké A/B prioritaire sur le dérivé | capitalComboPortfolio.js:530,543,1192-1200 | faible (POP présent inchangé) | T15a/b/c + rejeu a3b |
| 2 | AF-01/13 | `selectedLegMode` dans le pick + affichage ; retirer allowedModes de l'Inspector | :1588-1612,2196 ; dashboard:10127,10751,9862 | faible (badges/snapshots à revalider) | T1d, T14a, T12d |
| 3 | AF-03/04 | Fallback grade = gradeLeg(jambe bucket) ; recalcul _comboGradeScore post-bucket | :1586 ; :1229/1716 | moyen (change des sélections où safeGrade manquait) | T2, T3 + avant/après sur scans réels |
| 4 | AF-05 | Tie-break final stable (ticker asc) | :1719, :2166 | faible | T4a |
| 5 | AF-09/10/14/16 | freeCapital déployable (+ persistance) ; capitalUsed dans RISQUE/lignes ; aligner Inspector ; libellés | :3069 ; dashboard:10301-10310,10336,9014-9032 ; :2746 | faible | T9a, T10a |
| 6 | AF-06/07/08/17 | Décisions produit à trancher AVANT patch (pool vs filtres UI ; fallback BALANCED ; portée du soft-cap ; normalisation DTE) | dashboard:13209-13375 ; :1546-1572, :2089, :1449-1450 | moyen à fort (change des portefeuilles) | T6a, T8a + rejeux 1/7 DTE existants |

Si la séparation source/jambe est retenue (AF-01/03/04) : les structures existantes suffisent — ajouter `selectedLegMode` (string) et conserver `mode` actuel renommé conceptuellement `sourceMode` dans le pick ; `selectedLegGrade` existe déjà de fait (grade bucket). Pas besoin d'un remodelage plus large.

## 21. Plan de correction proposé

**Proposition uniquement — aucune correction exécutée.**

1. Patch ponctuel `gradeLeg`/`getAggressivePriorityGrade` (garde null) + inversion stocké/dérivé dans la chaîne `aggGrade` — 3 lignes, réversible.
2. `bucketResolvedPool` : ajouter `selectedLegMode: mode.label` ; `createPick` : `mode: candidate.selectedLegMode ?? candidate.finalDisplayMode` + champ `sourceMode` ; mettre à jour les deux rendus badge.
3. `:1586` : fallback `gradeLeg(bucketLeg)` ; recalcul `_comboGradeScore` après résolution bucket ; tie-break stable en fin de comparateur et du duel greedy.
4. Corrections d'agrégats UI (capitalUsed) + `freeCapital` déployable + miroirs Inspector + libellés.
5. Sujets produit (AF-06/07/08/17) : décision explicite avant tout code, chaque option changeant des portefeuilles réels.

## 22. Plan de tests après correction

- Rejouer `capital-combinations-audit-fable.mjs` : T1d et T12d(badges) doivent basculer vers le mode de jambe ; T15b/c doivent sélectionner sans POP ; T2c ne doit plus dépendre de la présence de safeGrade ; T3a/T4a doivent devenir indépendants de la source/de l'ordre ; T8a doit produire 1 ligne si le soft-cap est généralisé ; T9a doit rendre 15 000.
- Rejouer le snapshot a3b et un scan 1 DTE : composition identique hors cas corrigés ; comparer avant/après ligne à ligne.
- Vérifier un snapshot SQLite sauvegardé (freeCapital) et la carte RISQUE avec un portefeuille multi-contrats réel.
- Valider en séance POP ON que les grades stockés/derived coïncident.

## 23. Fichiers qui pourraient devoir être modifiés plus tard

- `wheel-dashboard/src/capitalComboPortfolio.js` (gradeLeg, getAggressivePriorityGrade, buildCapitalComboCandidate, bucketResolvedPool, createPick, tri, evaluateCandidate, retour makeCombo)
- `wheel-dashboard/src/dashboard.jsx` (badges :10127/:10751, dominant :10301-10310, colonnes capital :10140/:10779, snapshot :10336, Inspector :8994-9052/:9862, libellés :10427, pool combos :13209-13375)
- `wheel-dashboard/src/capitalComboEngineV2.js` (exposition des flags effectifs) — optionnel
- Tests dédiés du moteur combo (aucun n'existe actuellement pour ces chemins)

## 24. Confirmation de non-modification

- Aucun fichier existant du projet modifié, reformaté, déplacé, renommé ou supprimé.
- Backend, intégration IBKR, scanner, Journal POP, Pine Script, caches/snapshots : intacts.
- `package.json`/`package-lock.json`/`node_modules` : intacts ; aucune installation.
- Aucun `git add`, `commit`, `push`, `checkout`, `restore`, `reset`, `stash`, `clean`.
- `debug/capital-combinations-audit/` (audit antérieur) : non lu (après consigne), non modifié.
- Seuls fichiers créés : `debug/capital-combinations-audit-fable/capital-combinations-audit-fable.{mjs,json,md}`.

## 25. État Git final

- `git diff --name-only` : **vide** (0 fichier suivi modifié).
- `git status -sb` : branche `main...origin/main` ; uniques ajouts = le dossier `debug/capital-combinations-audit-fable/` (3 fichiers autorisés) ; les 180 untracked préexistants sont inchangés.
