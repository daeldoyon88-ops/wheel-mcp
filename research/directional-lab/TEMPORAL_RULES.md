# TEMPORAL RULES — invariants causaux non négociables

Implémentés dans le moteur et verrouillés par les tests listés en fin de
fichier. Toute stratégie future DOIT respecter ces règles.

## 1. Signal : close t → open t+1

- Les features de la séance t utilisent uniquement les données disponibles
  au plus tard à la clôture de t (préfixe `[0..t]`).
- Un signal créé à la clôture t ne peut **jamais** être exécuté à la clôture
  t. `createOrder`/`createFill` lèvent une exception si
  `fillDate <= decisionDate` (violation impossible par construction).
- L'exécution normale la plus tôt possible est l'**open t+1** :
  - entrée : close t → ordre en attente → fill open t+1 **+** slippage;
  - sortie : close t → ordre en attente → fill open t+1 **−** slippage.

## 2. Stops (gap-aware)

- Un stop décidé à la clôture t est **actif à partir de la séance t+1**
  (il ne peut pas se déclencher sur le range de sa propre séance de décision).
- Si l'open de t+1 traverse le stop défavorablement (gap) : fill à
  l'**open** ajusté du slippage de gap — jamais au niveau théorique du stop.
  Exemple verrouillé par test : stop 100, open 90 → fill ≈ 90 − slippage.
- Sinon, si le low de la séance atteint le stop : fill au niveau du stop
  moins le slippage normal.
- **Un stop ne protège jamais contre un gap nocturne** et le moteur ne le
  prétend jamais.

## 3. Weekly

- Une feature Weekly utilisée le jour t provient exclusivement de la
  **dernière semaine ISO complètement terminée** (`isoWeek < isoWeek(t)`).
- La semaine en cours est interdite tous les jours, **y compris le vendredi
  à sa propre clôture** (elle ne devient utilisable que la semaine suivante).
- L'`availableAt` de la feature Weekly est la clôture du dernier jour de la
  semaine terminée.

## 4. Pivots

- Un pivot nécessitant des bougies futures n'existe qu'après sa
  confirmation; son `availableAt` doit refléter ce délai.
- **V1 n'implémente aucun pivot** (aucun pivot full-history n'est toléré).
  Le test `temporal-causality` vérifie qu'aucune feature « pivot » n'est
  exposée. TODO Phase ultérieure : pivots confirmés avec availableAt décalé.

## 5. Supports / résistances

- Tout niveau structurel est calculé uniquement sur le préfixe `[0..t]` :
  plus haut/plus bas 20 jours **précédents** (jour courant exclu), sommet
  causal = max préfixe. Aucune connaissance des séances futures.

## 6. Labels futurs

- Les labels (cibles de recherche) sont autorisés uniquement comme sorties
  d'évaluation, **jamais comme features**. Exemple V1 : `falseExits` est un
  diagnostic post-hoc calculé après le backtest, jamais réinjecté.
- Features et labels doivent rester physiquement séparés.
- Lorsque des horizons de labels se chevauchent : appliquer **purge** (retrait
  des observations d'entraînement dont l'horizon mord sur le test) et
  **embargo** (retrait des observations juste après le test) —
  `src/time/purgeEmbargo.mjs`.

## 7. Dates et sessions

- Dates civiles `YYYY-MM-DD`, arithmétique 100 % UTC (`civilDate.mjs`),
  aucune dépendance au fuseau local de Windows, aucune date courante
  implicite dans les calculs.
- Clôture 16:00 America/New_York convertie en UTC par la règle DST
  américaine post-2007 calculée de façon déterministe (`marketSession.mjs`).
  Limite documentée : demi-séances non modélisées.

## 8. Déterminisme

- Aucun aléatoire sans seed, aucun horodatage mural dans les résultats.
- Deux exécutions identiques produisent le même `resultHash` (sha256 d'une
  sérialisation stable à clés triées qui refuse NaN/Infinity).

## Verrouillage par les tests

| Invariant | Test |
|---|---|
| Same-close interdit | `same-close-fill-prohibited.test.mjs`, `temporal-causality.test.mjs` |
| Next-open exact (± slippage) | `next-open-fill.test.mjs` |
| Gap-stop à l'open, stop t+1 | `gap-stop-fill.test.mjs` |
| Mutation du futur sans effet sur t | `feature-causality.test.mjs` |
| Weekly terminée seulement | `weekly-completion.test.mjs` |
| Aucun pivot non confirmé | `temporal-causality.test.mjs` |
| Null préservé | `null-preservation.test.mjs` |
| Split sans faux drawdown/stop | `split-adjustment.test.mjs` |
| Raw/adjusted jamais mélangés | `split-adjustment.test.mjs` |
| Déterminisme | `deterministic-results.test.mjs` |
| Purge/embargo | `purge-embargo.test.mjs`, `walk-forward.test.mjs` |
| Aucun couplage production/réseau | `no-production-coupling.test.mjs` |
