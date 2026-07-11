# Validation patch AF-06 — Indépendance du pool vis-à-vis des filtres UI

Date : 2026-07-11
Base : commit `6799766` (fix deterministic capital combo tie-breaking)

## 1. Résumé

La barre de recherche (et le tri, et le filtre Mode UI) contaminait le pool
transmis au moteur de combinaisons : le useMemo `combos` de `dashboard.jsx`
recevait `filtered`, un tableau déjà filtré par `query` (recherche), `filter`
(chip Mode « UI seulement ») et trié par `sortBy`/`sortOrder`. Écrire un ticker
dans la recherche réduisait donc le pool du moteur à la seule ligne visible, et
la recommandation financière devenait ce ticker (ou disparaissait si la
recherche ne trouvait rien).

Correctif : introduction d'un pool canonique `comboCandidateRows`
(= `enrichedCandidates` + filtre métier d'expiration uniquement), calculé par le
nouveau helper pur `capitalComboInputPool.js`. Le moteur reçoit ce pool ; le
tableau reçoit `filtered` = filtres visuels appliqués au-dessus du pool. Aucune
règle financière modifiée. 22/22 tests AF-06 PASS, AF-02 6/6, AF-03 15/15,
AF-05 26/26, spread 15/15, Fable identique à la baseline (31 PASS / 7 FAIL
historiques / 5 INFO), build PASS.

Verdict : **SAFE TO COMMIT** (avec deux caveats documentés en §26).

## 2. Reproduction utilisateur

Comportement observé : le dashboard affiche une combinaison de capital ;
l'utilisateur tape un ticker dans la recherche ; les lignes visibles changent
**et** la combinaison recommandée change aussi.

Reproduction déterministe (harnais Node, fixtures contrôlées AAPL/MSFT/ORCL/SOFI,
réplique exacte de l'ancien `filtered` + vrai `buildPortfolioCombos`) :

| Scénario | Lignes envoyées au moteur | Portefeuille SAFE |
|---|---|---|
| recherche vide | 4 | AAPL+SOFI |
| recherche "ORCL" | 1 | ORCL |
| recherche "ZZZZ_NOT_FOUND" | 0 | (aucun combo) |

Méthode : le flux React n'a pas été exécuté dans un navigateur ; la logique du
useMemo `filtered` (HEAD 6799766, lignes 13209-13270) a été répliquée à
l'identique dans un harnais Node et branchée sur les vraies fonctions de
production (`buildPortfolioCombos`, `getFinalDisplayRecommendation`,
`candidateRowMatchesSelectedExpiration`). Harnais : scratchpad
`af06-before-proof.mjs` et `af06-before-after.mjs` (non versionnés).

## 3. État Git initial

```
racine   : C:/Users/melan/Desktop/wheel-mcp-remote
HEAD     : 6799766 fix deterministic capital combo tie-breaking
branche  : main...origin/main (synchronisés)
tracked  : aucun fichier modifié avant AF-06
untracked: nombreux fichiers debug/* préexistants, non touchés
```

## 4. Flux des données avant correction

```
backendCandidates | snapshotCandidates
  → activeCandidates        (useMemo, slice topN, dataSource)        dashboard.jsx:13177
  → enrichedCandidates      (useMemo, merge IBKR, re-rank)           dashboard.jsx:13194
  → filtered                (useMemo : query + filter Mode UI + tri
                             + expiration, dans cet ordre)           dashboard.jsx:13209-13270
      → tableau (CremeDeLaCremePanel items={filtered})               dashboard.jsx:~17429
      → combos = buildPortfolioCombos(filtered, …)  ← CONTAMINATION  dashboard.jsx:13367-13375
```

Dépendances de l'ancien `filtered` :
`[enrichedCandidates, query, filter, sortBy, sortOrder, selectedExpiration, dataSource]`.
Dépendances de `combos` : `[filtered, capital, maxCapitalPct, maxPositions,
ibkrRejectedSymbols]` — donc transitivement dépendant de `query`, `filter`,
`sortBy`, `sortOrder`.

## 5. Cause exacte

`buildPortfolioCombos` recevait `filtered`, variable qui applique la recherche
texte (`item.ticker/name.includes(query)`), le filtre Mode UI
(`getFinalDisplayRecommendation(item)?.finalDisplayMode === filter`) et le tri
avant le seul filtre métier de ce niveau (expiration). Tout contrôle visuel
modifiait donc l'entrée du moteur.

## 6. Classification des filtres

| Contrôle UI | État | Variable/fonction | Visuel ou métier | Doit modifier le tableau | Doit modifier le pool combo | Justification |
|---|---|---|---|---|---|---|
| Barre de recherche « Ticker ou nom... » | `query` | `rowMatchesSearchQuery` | Visuel | Oui | Non | Sert uniquement à retrouver une ligne ; commentaire diagnostic « recherche partielle ou tri » |
| Select « Mode: Tous/SAFE/AGRESSIF » | `filter` | `rowMatchesModeFilter` | Visuel | Oui | Non | Commentaire code : « Filtre Mode (UI seulement) » ; title : « affiche uniquement les lignes… » ; les buckets du moteur (SAFE/BALANCED/AGGRESSIVE) sont construits en interne par buildPortfolioCombos indépendamment de ce chip |
| Select « Trier par » | `sortBy` | tri dans `buildVisibleTableRows` | Visuel | Oui (ordre) | Non | Ordre d'affichage ; AF-05 garantit le départage canonique côté moteur |
| Select « Ordre: asc/desc » | `sortOrder` | idem | Visuel | Oui (ordre) | Non | idem |
| Expiration sélectionnée | `selectedExpiration` | `candidateRowMatchesSelectedExpiration` | Métier | Oui | Oui | Expiration cible des jambes ; conservé dans le pool canonique |
| Capital / % capital / positions max | `capital`, `maxCapitalPct`, `maxPositions` | args `buildPortfolioCombos` | Métier | Non | Oui | Configuration financière du portefeuille |
| Rejets IBKR | `ibkrRejectedSymbols` | arg `buildPortfolioCombos` | Métier | Non (affichage séparé) | Oui | Blocage explicite de tickers |
| Top N Yahoo retournés | `topN` | slice dans `activeCandidates` | Métier/config | Oui | Oui (en amont) | Taille de shortlist persistée (`wheel.topYahooReturned`), appliquée en amont du pool ET de l'affichage, alimente aussi les envois IBKR — pas un simple réglage d'affichage ; comportement inchangé |
| Filtres crypto | `isCryptoDigitalAssetBlocked` | amont (pool de scan) | Métier | Oui | Oui (en amont) | Règle crypto ; inchangé |
| Éligibilité combo (grade, POP, spread, yield, caps…) | interne moteur | `buildCapitalComboCandidate`, modeConfigs | Métier | Non | Oui | Interne à buildPortfolioCombos ; intact |
| Pagination / limite de lignes | — | — | — | — | — | N'existe pas (le tableau affiche toutes les lignes filtrées) → NON APPLICABLE |
| Expansion/sélection d'une ligne | `setSelectedItem`, `highlightedTicker` | props d'affichage | Visuel | Oui | Non | N'entre jamais dans le calcul des combos |
| `dataSource` (snapshot/ibkr_direct) | `dataSource` | ordre de base ibkrRank dans le tri visible | État pipeline | Oui (ordre) | Non (ordre seulement) | N'affecte que l'ordre d'affichage ; le pool canonique n'est pas trié, AF-05 départage côté moteur |

## 7. Pool canonique

`comboCandidateRows` (dashboard.jsx) :

```js
const comboCandidateRows = useMemo(
  () => buildComboCandidatePool(enrichedCandidates, { selectedExpiration }),
  [enrichedCandidates, selectedExpiration]
);
```

`buildComboCandidatePool` (capitalComboInputPool.js) applique uniquement
`candidateRowMatchesSelectedExpiration` et retourne un nouveau tableau (ordre
source préservé, aucune mutation). Indépendant de `query`, `filter`, `sortBy`,
`sortOrder`, pagination, expansion de ligne.

## 8. Lignes visibles du tableau

`filtered` (dashboard.jsx) :

```js
const filtered = useMemo(() => {
  const sorted = buildVisibleTableRows(comboCandidateRows, {
    query, modeFilter: filter, sortBy, sortOrder, dataSource,
    getSpreadPct: getSafeSpreadPct,
  });
  // console.debug DEV inchangé
  return sorted;
}, [comboCandidateRows, query, filter, sortBy, sortOrder, dataSource]);
```

Le tableau (`CremeDeLaCremePanel items={filtered}`), la seasonality, les
compteurs d'affichage et les envois IBKR de la shortlist affichée continuent de
consommer `filtered`, comme avant.

## 9. Correctif appliqué

Fichiers modifiés/créés :

1. **`wheel-dashboard/src/capitalComboInputPool.js`** (créé) — helper pur :
   `rowMatchesSearchQuery`, `rowMatchesModeFilter`, `buildComboCandidatePool`,
   `buildVisibleTableRows` (logique de tri portée à l'identique depuis
   l'ancien `filtered`, `getSpreadPct` injecté).
2. **`wheel-dashboard/src/dashboard.jsx`** :
   - import du helper ;
   - ancien useMemo `filtered` remplacé par la paire `comboCandidateRows`
     (pool canonique) + `filtered` (lignes visibles) ;
   - `combos = buildPortfolioCombos(comboCandidateRows, …)` ;
   - funnel de diagnostic : `ibkrRejectedRemoved`, `comboBasePoolCount` et
     `_inspBucketSummary` calculés sur `comboCandidateRows` (le stage « Combo
     Pool » décrit désormais le pool réellement transmis au moteur) ;
   - `PortfolioCombos candidates={comboCandidateRows}` (l'inspecteur de combos
     reste cohérent avec l'entrée réelle du moteur).

Aucun moteur de scoring, aucune règle SAFE/BALANCED/AGGRESSIVE, aucun cap,
aucun tie-break modifiés.

## 10. Dépendances React

- `comboCandidateRows` : `[enrichedCandidates, selectedExpiration]` — aucune
  dépendance visuelle.
- `filtered` : `[comboCandidateRows, query, filter, sortBy, sortOrder,
  dataSource]` — la recherche n'apparaît que dans les dépendances du tableau.
- `combos` : `[comboCandidateRows, capital, maxCapitalPct, maxPositions,
  ibkrRejectedSymbols]` — `query`/`filter`/`sortBy`/`sortOrder` absents,
  directement et transitivement.
- Funnel diag : `comboCandidateRows` ajouté au tableau de dépendances
  (`filtered` y reste pour `filteredFinalCount`, compteur d'affichage).
- Aucune mutation : `buildComboCandidatePool` retourne un `filter()` (copie) ;
  `buildVisibleTableRows` trie `filteredItems.slice()` ; vérifié par deep-freeze
  (TEST 19). Pas de closure périmée ni de boucle de rendu introduite : mêmes
  useMemo, dépendances complètes.

## 11. Recherche vide

Pool moteur = 4/4 admissibles, tableau complet, portefeuille SAFE = SOFI+ORCL
(fixtures), empreinte = référence X. (TEST 1)

## 12. Recherche ticker présent

`query="ORCL"` : tableau = [ORCL] seul, pool moteur = 4, empreinte = X
(identique à la recherche vide). Idem `query="AAPL"` (ticker gagnant). (TESTS 2, 16)

## 13. Recherche ticker absent

`query="ZZZZ_NOT_FOUND"` : tableau vide (message « Aucun résultat avec ce
filtre. » rendu par dashboard.jsx quand `filtered.length === 0`), pool moteur
= 4, empreinte = X. (TESTS 3, 17)

## 14. Recherches successives

AAPL → MSFT → SOFI → NOT_FOUND : le tableau varie ([AAPL], [MSFT], [SOFI], []),
l'empreinte reste strictement X à chaque étape ; séquence vide → ORCL → vide :
empreinte X aux trois états, tableau revenu à 4 lignes. Variantes de casse et
d'espaces (`orcl`, ` ORCL`, `OrCl`) : même visible, pool inchangé. (TESTS 5-7)

## 15. Tri et ordre d'affichage

Tri quality ASC : tableau [SOFI, ORCL, MSFT, AAPL] ; DESC : [AAPL, MSFT, ORCL,
SOFI] ; tri weeklyReturn et spread ASC/DESC : ordres distincts. Empreinte = X
dans tous les cas ; ordre canonique du pool inchangé. Pool source inversé :
empreinte X (AF-05 préservée). Adaptation : l'UI n'a pas de tri alphabétique
ticker ; TEST 8 utilise le tri « quality », TEST 9 « weeklyReturn » et
« spread ». (TESTS 8, 9, 18)

## 16. Filtres visuels

Filtre Mode UI = AGGRESSIVE sur un pool 100 % SAFE : tableau vide, empreinte X ;
Mode = SAFE : tableau complet, empreinte X. Pagination : NON APPLICABLE (aucune
pagination ni limite d'affichage dans le tableau principal). (TESTS 10, 11)

## 17. Filtres métier préservés

- Expiration : sélectionner 2026-07-17 vs 2026-07-24 change le pool (3 vs 1
  candidats) et le portefeuille. (TEST 12)
- Ticker bloqué : `ibkrRejectedSymbols={SOFI}` → SOFI exclu des picks,
  combinaison différente. (TEST 13)
- Capital : maxCapitalPct 20 vs 40 → empreintes différentes (le patch ne gèle
  pas la combinaison). (TEST 15)
- Buckets : SAFE ≠ AGGRESSIVE ; chaque bucket invariant sous recherche ; aucune
  jambe BALANCED créée. (TEST 14)

## 18. Empreinte du portefeuille

Empreinte comparée (ordre des picks = ordre canonique produit par le moteur,
aucun tri arbitraire ajouté) :

```json
{ "comboLabel", "picks": [{ "ticker", "selectedMode", "strike", "contracts",
  "capitalRequired", "premium", "score" }],
  "capitalUsed", "freeCapital", "totalPremium", "portfolioYield" }
```

Avant correction : l'empreinte variait avec la recherche (ORCL seul, puis
vide). Après correction : strictement identique sur recherche vide / ticker
gagnant / ticker non gagnant / sans résultat / tri ASC / tri DESC / filtre Mode
UI (7 scénarios, cf. JSON `beforeResults`/`afterResults`).

## 19. Matrice de tests AF-06

`node --test wheel-dashboard/src/capitalComboInputPool.test.mjs` :
**22/22 PASS** (TESTS 1-20 de la mission + précondition baseline + test
unitaire `rowMatchesSearchQuery`). TEST 10 documenté NON APPLICABLE
(pas de pagination). Les tests exercent le vrai code de production
(`buildComboCandidatePool`, `buildVisibleTableRows`, `buildPortfolioCombos`),
câblés comme dans dashboard.jsx.

## 20. Non-régression AF-02

`capitalComboPortfolio.pop-null.test.mjs` : **6/6 PASS**. Fichier non modifié.

## 21. Non-régression AF-03

`capitalComboPortfolio.selected-leg-grade.test.mjs` : **15/15 PASS**. Fichier non modifié.

## 22. Non-régression AF-05

`capitalComboPortfolio.deterministic-tiebreak.test.mjs` : **26/26 PASS**.
`spreadPctPercent.test.mjs` : **15/15 PASS**. Fichiers non modifiés.

## 23. Harnais Fable

`node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs` :
**31 PASS / 7 FAIL / 5 INFO**, strictement identique à la baseline avant patch
(mêmes IDs : FAIL = T2b, T2c, T3a, T4a, T15a, T15b, T15c ; INFO = T1f, T11g,
T12b, T12d, T12e). Aucun check rendu obsolète : le harnais teste
capitalComboPortfolio.js directement, sans passer par les filtres UI. **0
nouveau FAIL réel.**

## 24. Build

`npm.cmd run build` (wheel-dashboard) : **PASS** (`✓ built in 3.27s`).
Warnings préexistants non bloquants : directives « use client » de
framer-motion ignorées au bundling, chunk index > 500 kB.

## 25. Fichiers modifiés

Modifié : `wheel-dashboard/src/dashboard.jsx` (34 insertions, 61 suppressions).
Créés : `wheel-dashboard/src/capitalComboInputPool.js`,
`wheel-dashboard/src/capitalComboInputPool.test.mjs`,
`debug/capital-combinations-af06-patch-validation/` (2 rapports).
Aucun autre fichier touché ; aucun untracked préexistant supprimé.

## 26. Limites

1. **Pas d'exécution navigateur** : la preuve avant/après et les tests passent
   par un harnais Node qui réplique le câblage des useMemo et appelle les
   vraies fonctions de production ; l'UI React complète n'a pas été pilotée
   (pas de test E2E navigateur dans le repo pour ce panneau).
2. **Trim de la recherche** : `rowMatchesSearchQuery` ignore les espaces de
   bord (` ORCL` trouve ORCL), exigé par TEST 5 et aligné sur le compteur
   `removedBySearch` du diagnostic pipeline qui trimait déjà. L'ancien filtre
   d'affichage ne trimait pas — micro-changement volontaire, purement visuel.
3. **Ordre des étapes** : l'expiration est désormais filtrée avant les filtres
   visuels (au lieu d'après le tri). Les filtres commutent et le tri est
   stable ; seul micro-effet possible : en `ibkr_direct`, la détection
   `hasBackendIbkrOrder` s'évalue sur les lignes déjà filtrées par expiration
   (plus cohérent qu'avant, où une ligne hors expiration pouvait forcer le
   tri de repli). Affichage seulement, pool non concerné.
4. **Funnel de diagnostic** : le stage « Combo Pool » (et
   `finalComboConversionRatePct`) décrit désormais le pool canonique ; pendant
   une recherche il peut dépasser « Filtered Final » (ratio > 100 %), ce qui
   est le reflet exact du comportement corrigé.
5. Les compteurs IBKR batch et la seasonality restent basés sur la shortlist
   affichée (`filtered`), comportement identique à avant le patch.

## 27. État Git final

```
git status -sb : ## main...origin/main
 M wheel-dashboard/src/dashboard.jsx
?? wheel-dashboard/src/capitalComboInputPool.js
?? wheel-dashboard/src/capitalComboInputPool.test.mjs
?? debug/capital-combinations-af06-patch-validation/
(+ untracked préexistants inchangés)

git diff --name-only : wheel-dashboard/src/dashboard.jsx
git diff --stat      : 1 fichier, 34 insertions(+), 61 suppressions(-)
```

Aucun `git add`, aucun commit, aucun push, aucune commande git destructive,
aucune installation de dépendance.

**Verdict : SAFE TO COMMIT** — la recherche, le tri et le filtre Mode UI ne
modifient plus le portefeuille ; les filtres métier restent actifs ; toutes les
suites de tests et le build passent ; aucun nouveau FAIL Fable.
