# Validation patch AF-08 — Soft-cap contrats uniquement

Date : 2026-07-11 · Base : 3509ef3 · POLITIQUE B validée par l'audit.

## 1. Résumé

La tolérance `×1.1` appliquée aux caps en dollars pendant la phase soft a été
supprimée du moteur (`capitalComboPortfolio.js`) et du miroir de simulation
(`alternativeCompositionSimV1.js`). La phase soft n'assouplit désormais **que le
nombre de contrats** (`maxContractsPerTicker + 1`) ; toutes les limites en
dollars (ticker, position, secteur, thème, high-beta, capital déployable)
restent strictes dans toutes les phases. 27 tests AF-08 (24 scénarios exigés +
3 miroir sim) passent, toutes les suites existantes sont intactes (AF-02 6/6,
AF-03 15/15, AF-05 26/26, AF-06 22/22, AF-07 30/30, spread 15/15), le harnais
Fable reste à sa baseline (30 PASS / 8 FAIL historiques / 5 INFO /
criticalConfirmed = 0, T8a PASS), le build Vite passe. Verdict : SAFE TO COMMIT.

## 2. État Git initial

- `git rev-parse --show-toplevel` → `C:/Users/melan/Desktop/wheel-mcp-remote` ✔
- `git log -3 --oneline` → HEAD = `3509ef3 fix balanced capital combo fallback leg selection` ✔
- `git status -sb` → `## main...origin/main` (synchronisée, ni ahead ni behind) ✔
- `git diff --name-only` / `--stat` → aucun fichier suivi modifié avant patch ✔
- Untracked préexistants (debug/*, afe-*.md, …) intacts ✔

## 3. Décision politique B

Le soft-cap signifie exclusivement :

- au maximum `maxContractsPerTicker + 1` contrats par ticker ;
- uniquement si le capital total de la ligne reste sous les caps stricts en dollars ;
- jamais de nouvelle ligne au-dessus du cap ticker strict ;
- jamais de renforcement au-dessus du cap ticker strict ;
- jamais d'assouplissement des caps secteur, thème ou high-beta ;
- jamais de dépassement du capital déployable.

La tolérance `×1.1` sur les caps en dollars est supprimée. Les caps stricts
(`tickerCapPct`, `positionCapPct`, `maxThemeCapitalPct`, `maxSectorCapitalPct`,
`maxHighBetaCapitalPct`, `maxContractsPerTicker`, `maxPositions`, configurations
des trois modes, caps institutionnels BALANCED V3) sont inchangés.

## 4. Architecture avant patch

Dans `evaluateCandidate` (moteur, l.2308+ ; miroir sim, l.342+), deux familles
de contrôles coexistent :

1. **Premier contrôle de cap** (moteur l.2332-2334 ; sim l.370-372) :
   `nextPositionCapital > tickerCapLimit || > positionCapLimit` → `ticker_cap_reached`.
   Avant patch, en phase soft, ces deux limites étaient gonflées à ×1,1
   (moteur l.2316-2317 ; sim l.352-353).
2. **Re-checks cluster stricts** (moteur l.2360-2385 ; sim l.399-423) : ticker,
   thème, secteur, high-beta **sans** tolérance — mais appliqués uniquement si
   `enforceClusterCaps` est vrai (`nextDistinctPositions >= minTargetPositions
   || !hasDiversifyingAlternative`).

La distinction clé : **assouplir le nombre de contrats** (l.2314 :
`maxContractsAllowed = useSoftCaps ? maxContractsPerTicker + 1 : …`) est la
politique voulue ; **assouplir les dollars** (×1,1) était l'anomalie AF-08.

## 5. Cause exacte

Le premier contrôle de cap était le **seul** contrôle en dollars garanti dans
toutes les branches : quand `enforceClusterCaps === false` (portefeuille sous
`minTargetPositions` avec alternative diversifiante), les re-checks stricts
sont sautés. En phase soft, ce premier contrôle tolérait 110 % du cap → une
nouvelle ligne pouvait engager jusqu'à `tickerCapDollars × 1,1`.

## 6. Facteur ×1,1 supprimé

Avant (moteur, l.2316-2317) :

```js
const tickerCapLimit = useSoftCaps ? tickerCapDollars * 1.1 : tickerCapDollars;
const positionCapLimit = useSoftCaps ? positionCapDollars * 1.1 : positionCapDollars;
```

Après (moteur, l.2316-2318) :

```js
// AF-08 : la phase soft n'assouplit que le nombre de contrats (+1), jamais les caps en dollars.
const tickerCapLimit = tickerCapDollars;
const positionCapLimit = positionCapDollars;
```

Miroir sim : mêmes remplacements avec `this.` (avant l.352-353, après l.352-354).
`git diff --stat` : 2 fichiers, 6 insertions(+), 4 suppressions(−). Aucune autre
règle modifiée.

## 7. Caps stricts préservés

- `tickerCapDollars = usableCapital × tickerCapPct` (moteur l.2012 ; sim l.202) — inchangé ;
- `positionCapDollars = usableCapital × positionCapPct` (moteur l.2013 ; sim l.203) — inchangé ;
- pct de config des trois modes (AGGRESSIVE 0,50 / BALANCED 0,30 / SAFE 0,30) — inchangés ;
- re-checks thème/secteur/high-beta et leurs pct — inchangés ;
- `enforceClusterCaps` et la logique de diversification — inchangés ;
- caps institutionnels BALANCED V3, `maxPositions`, `freeCapital` — inchangés.

Vérifié par TEST 4 (contrat exactement à 3 000 $ accepté en phase stricte) et
TEST 5 (3 050 $ rejeté).

## 8. +1 contrat préservé

`maxContractsAllowed = useSoftCaps ? maxContractsPerTicker + 1 : maxContractsPerTicker`
(moteur l.2314 ; sim l.348-350) est intact. Vérifié par TESTS 7-9 (le contrat
supplémentaire passe en phase soft dans les trois modes quand les dollars
restent sous le cap strict) et TEST 11 (jamais de +2, même avec 7 300 $ libres).

## 9. Scénario nouvelle ligne 3 200 $

SAFE, 10 000 $ déployables, cap ticker strict 30 % = 3 000 $, contrat 3 200 $ :

- avant patch : accepté en `primary_soft_cap` quand le re-check cluster était
  sauté (3 200 ≤ 3 300 = ancien cap soft) ;
- après patch : **rejeté au premier contrôle strict** (`ticker_cap_reached`),
  aucun pick — TESTS 1, 12 ; répliqué BALANCED (TEST 2) et AGGRESSIVE 5 200 $
  vs cap 5 000 $ (TEST 3). Aucun cap soft à 3 300 $ n'existe plus (TEST 6).

## 10. Scénario renforcement 900 $

SAFE, 900 $/contrat, `maxContractsPerTicker = 2` : le 3e contrat (2 700 $ ≤
3 000 $) est **autorisé** en phase soft — pick à 3 contrats, `capitalUsed`
2 700 $, `comboAllocationPhase = "primary_soft_cap"` (TESTS 7, 21 ; miroir
SIM 2). Le comportement voulu du soft-cap est préservé.

## 11. Scénario renforcement 1 600 $

SAFE, 1 600 $/contrat : 2 contrats = 3 200 $ > 3 000 $ → le 2e contrat est
**rejeté**, phase soft comprise — pick à 1 contrat, 1 600 $ (TEST 10 ; miroir
SIM 3).

## 12. Fermeture de la brèche enforceClusterCaps

Scénario O reproduit sur le vrai moteur (TEST 12) : MSFT 2 500 $ pris en
strict ; ORCL 2 400 $ bloqué par le cap secteur Technology (4 900 $ > 4 000 $) ;
fenêtre soft ouverte avec `enforceClusterCaps === false` pour KO 3 200 $
(2 lignes < minTarget 3, ORCL restant alternative diversifiante). Après patch,
KO est rejeté **dès le premier contrôle strict**, sans dépendre du re-check
cluster. `enforceClusterCaps` et la logique de diversification n'ont pas été
réécrits : la seule suppression du ×1,1 ferme la brèche. Preuve par rejeu
pré-fix (copie scratchpad hors dépôt avec ×1,1 restauré) : TEST 12-équivalent
et MIROIR SIM 1 échouaient (« KO … ne doit jamais être sélectionné »,
« 3 200 $ > cap strict 3 000 $ doit rester rejeté en soft »), confirmant que
les tests discriminent bien la régression.

## 13. SAFE

- nouvelle ligne 3 200 $ : rejetée (TESTS 1, 12) ;
- frontières : 3 000 $ accepté strict / 3 050 $ rejeté / 3 300 $ rejeté (TESTS 4-6) ;
- +1 contrat 900 $ : 3 contrats, 2 700 $, phase soft (TEST 7) ;
- renforcement 1 600 $ : bloqué à 1 contrat (TEST 10) ;
- secteur ≤ 4 000 $, high-beta ≤ 3 500 $ (TESTS 18, 20).

## 14. BALANCED

- nouvelle ligne 3 200 $ : rejetée, `ticker_cap_reached` (TEST 2) ;
- +1 contrat 700 $ : 4 contrats (3+1), 2 800 $ ≤ 3 000 $, phase soft (TEST 8) ;
- AF-07 intacte : jambe SAFE en bande 0,75-1,05 sélectionnée sous le cap
  (TEST 14) ; si cette jambe dépasse le cap strict, le candidat est rejeté —
  AF-07 ne contourne pas AF-08 (TEST 15).

## 15. AGGRESSIVE

- nouvelle ligne 5 200 $ (entre cap strict 5 000 $ et ancien ×1,1 5 500 $) :
  rejetée (TEST 3) ;
- +1 contrat 900 $ : 5 contrats (4+1), 4 500 $ ≤ 5 000 $, phase soft (TEST 9) ;
- thème high_beta_growth ≤ 5 000 $ (TEST 19).

## 16. Caps secteur/thème/high-beta

Jamais assouplis, avant comme après patch (aucune modification de ces règles) :

- secteur : SAFE Technology 4 900 $ > 4 000 $ → 2e ligne bloquée,
  `sector_cap_reached` (TEST 18) ;
- thème : AGGRESSIVE high_beta_growth 5 200 $ > 5 000 $ → 2e ligne bloquée,
  `theme_cap_reached` (TEST 19) ;
- high-beta : SAFE 4 000 $ > 3 500 $ → 2e ligne bloquée,
  `high_beta_cap_reached` (TEST 20).

## 17. Capital déployable

`combo.totalCapital ≤ usableCapital` vérifié pour chaque combo (TEST 17) ;
caps recalculés sur l'enveloppe quand `maxCapitalPct < 100 %` (20 000 $ × 50 %
→ caps sur 10 000 $, TEST 16) ; aucun pick ne dépasse
`usableCapital × tickerCapPct` dans aucun scénario (TEST 22). La garde
`nextUsed > usableCapital` (l.2331) était déjà stricte et n'a pas changé.

## 18. Miroir alternativeCompositionSimV1

- Lignes modifiées : 352-354 (`VirtualAllocator.evaluateCandidate`) — mêmes
  suppressions du ×1,1, même commentaire AF-08 ;
- `maxContractsAllowed` (+1) conservé (l.348-350) ;
- le miroir applique la même politique que le moteur : vérifié par les tests
  MIROIR SIM 1-3 sur `VirtualAllocator` (classe déjà exportée et testable —
  aucune logique parallèle créée) ;
- phases soft du simulateur inchangées (`sim_primary_soft` l.542, fallback soft
  du filler l.499-502) ; dashboard.jsx non modifié.

## 19. Matrice des tests AF-08

`node --test wheel-dashboard/src/capitalComboPortfolio.soft-cap.test.mjs`
→ **27 tests, 27 PASS, 0 FAIL** (les 24 scénarios exigés + 3 miroir sim).

| # | Scénario | Résultat |
|---|---|---|
| 1 | SAFE nouvelle ligne 3 200 $ > cap strict → 0 pick, ticker_cap_reached | PASS |
| 2 | BALANCED nouvelle ligne 3 200 $ → 0 pick, ticker_cap_reached | PASS |
| 3 | AGGRESSIVE 5 200 $ entre cap strict et ancien ×1,1 → 0 pick | PASS |
| 4 | Exactement au cap strict (3 000 $) → accepté, phase stricte | PASS |
| 5 | Juste au-dessus (3 050 $) → rejeté | PASS |
| 6 | Ancien cap ×1,1 exact (3 300 $) → rejeté | PASS |
| 7 | +1 contrat SAFE 900 $ → 3 contrats, primary_soft_cap | PASS |
| 8 | +1 contrat BALANCED 700 $ → 4 contrats, primary_soft_cap | PASS |
| 9 | +1 contrat AGGRESSIVE 900 $ → 5 contrats, primary_soft_cap | PASS |
| 10 | Renforcement 1 600 $ dépassant cap → 1 contrat | PASS |
| 11 | maxContractsPerTicker+1 = maximum absolu | PASS |
| 12 | Brèche O fermée (enforceClusterCaps false) | PASS |
| 13 | Ordre inversé → mêmes picks (AF-05) | PASS |
| 14 | AF-07 préservée (jambe SAFE en bande) | PASS |
| 15 | AF-07 + AF-08 (jambe en bande au-dessus du cap → rejet) | PASS |
| 16 | maxCapitalPct 50 % → caps sur usableCapital | PASS |
| 17 | totalCapital ≤ usableCapital pour chaque combo | PASS |
| 18 | Cap secteur strict + diagnostic | PASS |
| 19 | Cap thème strict | PASS |
| 20 | Cap high-beta strict | PASS |
| 21 | Diagnostic de phase primary_soft_cap | PASS |
| 22 | Aucun soft dollar résiduel (tous picks ≤ cap strict) | PASS |
| 23 | Aucune mutation (deep-freeze pool + jambes) | PASS |
| 24 | Répétition ×20 → picks/contrats/capital/phases/scores identiques | PASS |
| M1-M3 | Miroir VirtualAllocator (nouvelle ligne, +1, renforcement) | PASS |

## 20. Non-régressions

`node --check` : PASS sur les 3 fichiers (moteur, sim, test).

| Suite | Attendu | Obtenu |
|---|---|---|
| AF-08 soft-cap | ≥ 24/24 | **27/27 PASS** |
| AF-02 pop-null | 6/6 | **6/6 PASS** |
| AF-03 selected-leg-grade | 15/15 | **15/15 PASS** |
| AF-05 deterministic-tiebreak | 26/26 | **26/26 PASS** |
| AF-06 capitalComboInputPool | 22/22 | **22/22 PASS** |
| AF-07 balanced-fallback | 30/30 | **30/30 PASS** |
| spreadPctPercent | 15/15 | **15/15 PASS** |

Aucun ancien test modifié. Aucune règle financière modifiée.

## 21. Harnais Fable

`node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs`
(lecture seule, harnais non modifié) :

- totals : 43 checks — **30 PASS / 8 FAIL / 5 INFO / criticalConfirmed = 0** —
  identique à la baseline (8 FAIL historiques : T2b, T2c, T3a, T4a, T6a, T15a,
  T15b, T15c ; 5 INFO : T1f, T11g, T12b, T12d, T12e) ;
- **T8a : PASS → PASS** (aucun changement de statut). Avant patch, il
  démontrait que le contrat 3 200 $ passait la limite soft 3 300 $ mais était
  rattrapé par le re-check strict (portefeuille vide ⇒ enforceClusterCaps
  vrai) ; après patch, actual identique (`positions: 0`,
  `ticker_cap_reached: 2`) — le rejet a simplement lieu dès le premier
  contrôle. La note interne du harnais (« la tolérance ×1,1 est morte pour les
  nouvelles lignes ») référence les anciennes lignes de code mais reste
  factuellement vraie : check historique, pas une régression ;
- aucun nouveau FAIL réel, aucun PASS→FAIL.

## 22. Build

`npm.cmd run build` depuis `wheel-dashboard` : **PASS** (vite v5.4.21,
1 950 modules, 3,55 s). Warnings préexistants uniquement : directives
« use client » framer-motion ignorées + chunk > 500 kB. Aucune nouvelle erreur.

## 23. Fichiers modifiés

Modifiés (git diff --stat : 2 fichiers, +6/−4) :

- `wheel-dashboard/src/capitalComboPortfolio.js` (l.2316-2318) ;
- `wheel-dashboard/src/alternativeCompositionSimV1.js` (l.352-354).

Créés :

- `wheel-dashboard/src/capitalComboPortfolio.soft-cap.test.mjs` (27 tests) ;
- `debug/capital-combinations-af08-patch-validation/capital-combinations-af08-patch-validation.md` ;
- `debug/capital-combinations-af08-patch-validation/capital-combinations-af08-patch-validation.json`.

Aucun autre fichier créé ou modifié. Aucun `git add`/`commit`/`push`.

## 24. Limites

- Le rejeu pré-fix (preuve de discrimination) a été fait sur une copie
  scratchpad hors dépôt lors de la première passe (7 tests) : 2 échecs
  attendus sur les scénarios « nouvelle ligne ». Les 20 tests ajoutés ensuite
  n'ont pas été rejoués contre le code pré-fix ; par construction, TESTS 2, 3,
  6 et 12 reproduisent la même brèche ×1,1 (valeurs entre cap strict et
  ancien cap ×1,1).
- Pour un renforcement, la tolérance ×1,1 était déjà neutralisée par le
  re-check strict (la porte diversification force `enforceClusterCaps` à
  vrai) : sa suppression y est une clarification de politique, pas un
  changement de comportement observable.
- Les caps thème testables sont limités aux thèmes réels du moteur
  (`high_beta_growth` ; `crypto_miner` est inaccessible en pool car ces
  tickers sont « Crypto bloqué » dans tickerMeta).
- Le harnais Fable garde ses 8 FAIL historiques documentés (hors périmètre
  AF-08) ; sa note T8a cite des numéros de ligne antérieurs au patch.

## 25. État Git final

- `git status -sb` → `## main...origin/main` ; seuls fichiers suivis modifiés :
  `wheel-dashboard/src/capitalComboPortfolio.js`,
  `wheel-dashboard/src/alternativeCompositionSimV1.js` ;
- `git diff --name-only` → ces deux fichiers uniquement ;
- `git diff --stat` → 2 fichiers, 6 insertions(+), 4 suppressions(−) ;
- nouveaux untracked AF-08 : le fichier de test + le dossier de rapports ;
- untracked préexistants intacts ; aucun add/commit/push effectué.

**Verdict : SAFE TO COMMIT.**
