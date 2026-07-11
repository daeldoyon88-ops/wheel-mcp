# Validation patch AF-07 — Fallback BALANCED conforme

Date : 2026-07-11 — Moteur : `wheel-dashboard/src/capitalComboPortfolio.js` — Commit de base : `7700aed`

## 1. Résumé

AF-07 est **confirmée et corrigée**. Le bucket BALANCED pouvait figer une jambe
AGGRESSIVE hors bande de rendement (fallback aveugle) puis rejeter le candidat
entier aux gates min/max, sans jamais essayer la jambe SAFE pourtant conforme.
Le correctif introduit un helper générique `resolveCompatibleLegForMode` qui
évalue séquentiellement toutes les jambes disponibles selon leurs propres
données : une jambe hors bande n'empêche plus d'essayer la suivante, aucune
jambe hors bande n'est forcée, et les préférences historiques (bande préférée,
MID, égalité → SAFE, fallback AGGRESSIVE d'abord) sont conservées à
l'identique. 30/30 tests AF-07 PASS ; AF-02/AF-03/AF-05/AF-06/spread tous
PASS ; harnais Fable sans régression réelle (seul le check T6a qui démontrait
le défaut devient obsolète) ; build PASS. Verdict : **SAFE TO COMMIT WITH
CAVEAT** (caveat AF-01 d'affichage, préexistant et hors périmètre).

## 2. État Git initial

Vérifié en début de mission (avant patch) puis à la reprise :

```
racine        : C:/Users/melan/Desktop/wheel-mcp-remote
HEAD          : 7700aed fix capital combo independence from UI filters
branche       : main synchronisée avec origin/main
fichiers suivis modifiés avant AF-07 : aucun
untracked préexistants : intacts (debug/*, rapports d'audit, etc.)
```

À la reprise de session : seul `wheel-dashboard/src/capitalComboPortfolio.js`
modifié (152 insertions, 26 suppressions) ;
`capitalComboPortfolio.balanced-fallback.test.mjs` untracked, conforme à
l'état attendu.

## 3. Reprise après interruption de session

La session précédente avait déjà : reproduit AF-07 sur le moteur réel avant
patch (script temporaire hors dépôt, import direct du moteur), appliqué le
patch (helper + branchement BALANCED), créé les 30 tests, et vérifié le cas
principal après patch. La présente session a :

- vérifié l'état Git et relu intégralement le diff et le fichier de test ;
- exécuté la suite AF-07 : 28/30, puis corrigé **2 fixtures** (aucun code
  moteur retouché) :
  - TEST 15 : le grade de la jambe AGGRESSIVE suit la règle moteur existante
    « priorityGrade ?? grade dérivé ?? grade stocké » (patch grade-source,
    mai 2026) — la fixture attendait à tort le grade stocké ; spread AGG passé
    de 12 à 10 pour que le grade dérivé « A » reste discriminant d'une fuite
    SAFE (« B ») ;
  - TEST 30 : `premiumCollected` n'est pas arrondi par le moteur (produit
    flottant brut) — comparaison à tolérance 1e-9 au lieu de `toFixed(2)` ;
- relancé la suite complète : 30/30 PASS ;
- exécuté non-régressions, harnais Fable, build, et produit les rapports.

## 4. Architecture BALANCED avant correction

Dans `buildPortfolioCombos` → `makeCombo(mode)` → `bucketResolvedPool`
(map par candidat), branche `else` du bucket BALANCED (ex-lignes 1682-1709) :

1. bande de choix de jambe codée en dur `[0.75, 1.05)`, `MID = 0.875` ;
2. si SAFE et AGG dans la bande : la plus proche du MID (égalité → SAFE) ;
3. sinon SAFE si dans la bande ; sinon AGG si dans la bande ;
4. **sinon AGG aveuglément si valide ; sinon SAFE** — sans aucun test de bande ;
5. la jambe choisie est figée dans le candidat (une seule jambe par candidat),
   puis les gates `weeklyReturn >= modeAlloc.minWeeklyYield` (0,675 via patch
   V3) et `weeklyReturn < modeAlloc.maxWeeklyYield` (1,05) rejettent le
   candidat entier — aucun mécanisme de réessai.

## 5. Cause exacte

Le fallback de l'étape 4 choisissait AGGRESSIVE sans vérifier la bande
effective. Zone défectueuse : jambe SAFE dans `[0,675 ; 0,75)` (conforme à la
bande effective V3 mais sous la bande préférée) + jambe AGG hors bande
(≥ 1,05) ⇒ AGG figée ⇒ candidat rejeté `MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT`
⇒ SAFE conforme jamais essayée. Posséder une jambe AGG « en plus » excluait le
candidat de BALANCED (paradoxe démontré par le check T6a du harnais Fable).

## 6. Reproduction avant patch

**Exécutée réellement** sur le moteur réel non modifié (import direct de
`capitalComboPortfolio.js` à l'état 7700aed, script temporaire hors dépôt,
avant application du patch) — pas une simulation :

| Scénario | Entrée | Résultat avant patch |
|---|---|---|
| S1 principal | SAFE 0,70 % (conforme) + AGG 2,0 % (hors bande) | picks BALANCED **vides** ; rejet `MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT` avec `weeklyReturnPct: 2` → **preuve que la jambe AGG a été essayée** |
| S1 contrôle | même jambe SAFE 0,70 % seule (sans AGG) | pick présent (strike 40, grade A) → **preuve que SAFE était conforme** |

## 7. Bande BALANCED et unités

- **Bande effective** (gates du mode, inchangée) : `[minWeeklyYield ;
  maxWeeklyYield)` = **[0,675 ; 1,05)** — min 0,675 issu du patch runtime
  `computeBalancedInstitutionalV3` (`minWeeklyYield: 0.675`, base config
  0,70), max 1,05 de la config `balanced`.
- **Bande préférée historique** (choix de jambe, inchangée) : **[0,75 ; 1,05)**,
  MID 0,875 — littéraux extraits tels quels dans la constante exportée
  `BALANCED_PREFERRED_LEG_YIELD_BAND`.
- **Unités** : points de pourcentage hebdomadaires (0,70 = 0,70 %/semaine).
  Aucun mélange ratio/pourcentage : `getLegYieldPct` retourne déjà des points
  de %.
- Dans les tests, les bornes effectives sont **extraites des diagnostics du
  moteur réel** (`MIN_WEEKLY_YIELD_NOT_MET.minWeeklyYieldPct`,
  `MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT.maxWeeklyYieldConfig`) — aucune valeur
  de bande codée en dur.

## 8. Convention des bornes

Convention du moteur, reprise à l'identique par le helper :

- **min inclusif** : `weeklyReturn >= minWeeklyYield` (rendement == min ⇒ accepté) ;
- **max exclusif** : `weeklyReturn < maxWeeklyYield` (rendement == max ⇒ rejeté) ;
- `maxWeeklyYield == null` ⇒ pas de plafond ;
- rendement inconnu (null/undefined/NaN) ⇒ non conforme ;
- aucune tolérance epsilon, aucun arrondi (comparaisons flottantes directes).

Vérifiée par les TESTS 10 (min exact accepté), 11 (max exact rejeté),
12 (min − 0,001 rejeté puis jambe suivante), 13 (max + 0,001 rejeté puis
jambe suivante).

## 9. Helper resolveCompatibleLegForMode

```js
resolveCompatibleLegForMode({
  legCandidates,          // liste ordonnée de descripteurs de jambes
  minYieldPctInclusive,   // borne basse effective (modeAlloc.minWeeklyYield)
  maxYieldPctExclusive,   // borne haute effective (modeAlloc.maxWeeklyYield, null = aucun)
  preferredBand = null,   // { minInclusivePct, maxExclusivePct, midTargetPct }
})
```

Descripteur : `{ mode, leg, yieldPct, strikeValue, capital, grade, valid,
priority }`. Le helper : ignore les descripteurs invalides (`valid !== true`
ou `leg` absent) ; traite null/undefined/NaN comme non conformes ; applique
min inclusif / max exclusif ; **continue après chaque jambe hors bande** ;
retourne **null si aucune jambe n'est conforme** (aucune jambe forcée) ; ne
mute aucun objet ; ne recalcule ni jambe ni score. `priority` (croissant)
sépare les groupes : une jambe conforme du groupe le plus prioritaire gagne
avant tout groupe suivant — prévu pour la future vraie jambe BALANCED
(priority 0) devant les fallbacks SAFE/AGGRESSIVE (priority 1).

Fonction interne `pickFirstValidLegDescriptor` : dernier recours quand aucune
jambe n'est conforme — reprend l'ancien fallback (AGG puis SAFE) uniquement
pour conserver le chemin et les diagnostics de rejet aval existants (le
candidat est ensuite rejeté par les gates min/max comme avant).

## 10. Ordre des fallbacks

Liste fournie par le bucket BALANCED : `[AGGRESSIVE (priority 1), SAFE
(priority 1)]` — ordre de fallback historique, avec commentaire indiquant où
insérer la future jambe BALANCED (priority 0) en tête. L'ordre départage
lorsque plusieurs jambes sont conformes hors bande préférée, mais **n'empêche
jamais** l'essai de la suivante quand la première est invalide ou hors bande.

## 11. Règle lorsque plusieurs jambes sont conformes

Préférences historiques strictement conservées (démontré avant/après) :

1. dans la **bande préférée [0,75 ; 1,05)** : la jambe la plus proche du MID
   0,875 gagne ; **égalité exacte de distance → SAFE** (reproduction de la
   règle `<=` d'origine : la jambe listée en dernier gagne l'égalité) ;
2. **hors bande préférée mais dans la bande effective** ([0,675 ; 0,75)) :
   première conforme dans l'ordre de la liste → **AGGRESSIVE avant SAFE**
   (comportement historique observable, ex. S3b avant/après identiques) ;
3. spread, distance, POP, score qualité **ne sont pas** des critères de choix
   de jambe (TESTS 19-21) — aucune nouvelle préférence créée.

## 12. Intégration dans buildCapitalComboCandidate

`buildCapitalComboCandidate` est **inchangé** : il continue de fournir les
données per-bucket (`_safeLeg`, `_aggLeg`, `_safeYieldPct`, `_aggYieldPct`,
`_hasSafeLegValid`, `_hasAggLegValid`, strikes, capitaux, grades). Le
branchement réel du helper est dans `buildPortfolioCombos` → `makeCombo` →
`bucketResolvedPool`, branche BALANCED (lignes ~1787-1835 après patch). Le
descripteur retenu alimente `bucketLeg`/`bucketStrikeValue`/`bucketCapital`/
`bucketGrade`/`bucketMode`, puis le pipeline existant inchangé recalcule tous
les champs depuis cette seule jambe.

## 13. SAFE conforme / AGGRESSIVE hors bande

Avant : AGG essayée → hors bande → candidat rejeté (S1, exécuté).
Après : AGG évaluée → hors bande → **le moteur continue** → SAFE conforme →
candidat accepté avec la jambe SAFE (strike 40, prime 0,28, rendement 0,70 %,
spread 8, distance −9, POP 91, grade A). TEST 1 + TESTS 13/14.

## 14. SAFE hors bande / AGGRESSIVE conforme

Avant : AGG dans la bande préférée → AGG (déjà correct).
Après : identique — AGG sélectionnée (S2 avant/après strictement identiques ;
TEST 2, TEST 12). Aucun changement.

## 15. Deux jambes conformes

Avant/après strictement identiques (S3a, S3b exécutés des deux côtés) :

- toutes deux en bande préférée, AGG plus proche du MID → AGG (TEST 3a) ;
- égalité exacte au MID (0,85 vs 0,90) → SAFE (TEST 3b) ;
- toutes deux sous la bande préférée ([0,675 ; 0,75)) → AGG (TEST 3c).

## 16. Aucune jambe conforme

Avant : AGG figée → rejet `MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT`.
Après : identique — dernier recours = même jambe, même blocker, mêmes
diagnostics (S4 avant/après identiques ; TEST 4 vérifie picks vides + blocker
+ helper retournant null). Aucune jambe hors bande n'entre au portefeuille.

## 17. Données de la jambe sélectionnée

Une seule jambe traverse le pipeline : `selectedLeg`, `selectedStrikeValue`,
`selectedPremiumUnit`, `selectedSpreadPct`, `selectedYieldPct`,
`selectedDistancePct`, `_popForCombo`, `capitalPerContract`,
`premiumPerContract`, grade et breakdown de score sont tous recalculés depuis
`bucketLeg` par le chemin existant. TESTS 14/15 (valeurs discriminantes sur
chaque champ) et TEST 30 (empreinte complète : capitalUsed = contrats ×
strike × 100, premiumCollected = contrats × prime × 100, etc.) : aucune fuite
SAFE↔AGGRESSIVE.

## 18. Grade et AF-03

Le grade vient de la jambe réellement sélectionnée
(`resolveSelectedLegGrade({ explicitGrade: bucketGrade, selectedLeg:
bucketLeg, selectedMode: bucketMode })`, chemin inchangé). TEST 16 : grade
source A/B/WATCH sans effet sur grade et score du pick (grade dérivé « B » de
la jambe SAFE dans les trois cas). Rappel de la règle existante côté
AGGRESSIVE : grade prioritaire ?? grade dérivé de la jambe ?? grade stocké.
AF-03 : 15/15 PASS.

## 19. POP et AF-02

Normalisation POP inchangée. TEST 17 : POP null reste inconnue
(`popEstimate: null` sur le pick, grade dérivé sans coercition à 0). TEST 18 :
POP réelle 0 conserve le comportement existant (grade dérivé WATCH ⇒ exclusion
du bucket, `watchPremiumFilter` exigeant POP ≥ 88). AF-02 : 6/6 PASS.

## 20. Déterminisme et AF-05

Le helper est une fonction pure de la liste ordonnée construite depuis les
données du candidat (aucun index d'entrée, aucun aléa, aucune horloge).
TEST 22 : pool inversé ⇒ portefeuille BALANCED strictement identique.
TEST 25 : 20 exécutions ⇒ même jambe, même score, même portefeuille.
AF-05 : 26/26 PASS.

## 21. Pool canonique et AF-06

TEST 23 : recherche UI simulée (`buildVisibleTableRows`, query « oracle » ⇒
1 ligne visible) — le moteur consomme le pool canonique
(`buildComboCandidatePool`) et CRM (non visible) reste dans le portefeuille.
`dashboard.jsx` non modifié. AF-06 : 22/22 PASS.

## 22. Compatibilité future balancedLeg

Structurelle uniquement (pas de validation de bout en bout) : la liste de
descripteurs accepte une entrée `{ mode: "BALANCED", priority: 0, leg:
candidate.balancedLeg, ... }` en tête, sans réécrire la logique. TEST 26 :
jambe BALANCED fictive conforme (priority 0) gagne devant les fallbacks, même
hors bande préférée. TEST 27 : BALANCED fictive hors bande ⇒ la logique
continue et sélectionne SAFE conforme. **Aucun champ `balancedLeg` n'a été
ajouté au moteur** (TEST 26 le vérifie sur le candidat réel).

## 23. Matrice des 30 tests

`wheel-dashboard/src/capitalComboPortfolio.balanced-fallback.test.mjs` —
**30/30 PASS** (après correction de 2 fixtures, voir §3) :

| # | Sujet | Résultat |
|---|---|---|
| 1 | Reproduction AF-07 : SAFE conforme + AGG trop élevée ⇒ SAFE | PASS |
| 2 | SAFE trop faible + AGG conforme ⇒ AGG | PASS |
| 3 | Deux conformes : MID / égalité → SAFE / sous-bande → AGG | PASS |
| 4 | Aucune conforme ⇒ rejet, aucune jambe forcée, helper → null | PASS |
| 5 | SAFE absente ⇒ AGG | PASS |
| 6 | AGG absente ⇒ SAFE | PASS |
| 7 | Aucune jambe ⇒ rejet propre sans exception | PASS |
| 8 | Rendement SAFE inconnu (null/undefined/NaN) ⇒ AGG | PASS |
| 9 | Rendement AGG inconnu ⇒ SAFE | PASS |
| 10 | Min exact accepté (inclusif) | PASS |
| 11 | Max exact rejeté (exclusif) + blocker existant | PASS |
| 12 | Min − ε rejeté puis jambe suivante | PASS |
| 13 | Max + ε rejeté puis jambe suivante | PASS |
| 14 | Pick 100 % SAFE, aucune fuite AGG | PASS |
| 15 | Pick 100 % AGG, aucune fuite SAFE | PASS |
| 16 | AF-03 : grade source sans effet | PASS |
| 17 | AF-02 : POP null reste inconnue | PASS |
| 18 | POP réelle 0 : comportement existant | PASS |
| 19 | Spread ≠ critère de choix de jambe | PASS |
| 20 | Distance ≠ critère de choix de jambe | PASS |
| 21 | Score qualité ≠ critère de choix de jambe | PASS |
| 22 | AF-05 : ordre inversé ⇒ portefeuille identique | PASS |
| 23 | AF-06 : pool canonique vs lignes visibles filtrées | PASS |
| 24 | Deep-freeze : aucune mutation, aucune exception | PASS |
| 25 | 20 répétitions identiques | PASS |
| 26 | Future BALANCED fictive conforme gagne (helper) | PASS |
| 27 | Future BALANCED fictive hors bande ⇒ SAFE (helper) | PASS |
| 28 | Bucket SAFE strictement inchangé | PASS |
| 29 | Bucket AGGRESSIVE strictement inchangé | PASS |
| 30 | Empreinte financière cohérente avec une seule jambe | PASS |

## 24. Preuve avant / après

Avant = **exécuté** sur le moteur réel pré-patch ; Après = **exécuté** sur le
moteur réel patché (mêmes fixtures, même script, hors dépôt). Bande effective
[0,675 ; 1,05), préférée [0,75 ; 1,05).

| Scénario | SAFE yield | AGG yield | Jambe avant | Résultat avant | Jambe après | Résultat après |
|---|---|---|---|---|---|---|
| SAFE conforme / AGG trop élevée | 0,70 | 2,00 | AGG (aveugle) | **rejeté** (MAX_WEEKLY_YIELD) | **SAFE** | **accepté** (strike 40, 0,70 %) |
| SAFE trop faible / AGG conforme | 0,50 | 0,90 | AGG | accepté (43) | AGG | accepté (43) — identique |
| Deux conformes (tie MID 0,85/0,90) | 0,85 | 0,90 | SAFE | accepté (40) | SAFE | accepté (40) — identique |
| Deux conformes sous bande préférée | 0,70 | 0,72 | AGG | accepté (43) | AGG | accepté (43) — identique |
| Aucune conforme | 0,50 | 2,00 | AGG | rejeté (MAX_WEEKLY_YIELD) | AGG (dernier recours) | rejeté — identique |
| SAFE seule | 0,70 | — | SAFE | accepté (40) | SAFE | accepté (40) — identique |
| AGG seule | — | 0,90 | AGG | accepté (43) | AGG | accepté (43) — identique |

Le SEUL comportement modifié est le cas AF-07 : un candidat BALANCED
auparavant rejeté à tort est désormais accepté avec une jambe réellement
conforme. Tous les autres chemins sont bit-à-bit identiques.

## 25. Impact réel sur le portefeuille

Pool : CRM (SAFE 0,70 % conforme spread 8 + AGG 2,0 % hors bande) et ORCL
(SAFE 0,70 % conforme spread 19 ⇒ score plus bas). Capital 100 000, demande
maxPositions=1.

- **Avant** (exécuté pré-patch) : CRM bloqué avant le pool scoré
  (`MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT`, la jambe AGG 2,0 ayant été figée) ;
  picks BALANCED = `[ORCL]` — ORCL en tête **par forfait**.
- **Après** : CRM réintégré, **rang 1 du pool scoré** (score composite 81 vs
  72 pour ORCL) ; picks = `[CRM, ORCL]`, CRM premier.

Précision importante (vérifiée, non falsifiée) : les deux picks dans le même
combo malgré maxPositions=1 sont un comportement **préexistant** de BALANCED
V3 — `computeBalancedInstitutionalV3` applique `lineCap = max(5,
min(globalCap, targetLines))`, soit un **plancher de 5 lignes** quel que soit
maxPositions demandé (`balancedEffectiveMaxPositions: 5` dans les
diagnostics). Ce plancher existe à l'identique dans le commit 7700aed et n'est
pas touché par AF-07. AF-07 ne « remplace » donc pas ORCL par CRM : elle
réintègre un candidat meilleur (81 > 72) qui prend la tête du portefeuille,
ORCL restant en 2ᵉ ligne sous le plafond V3.

## 26. Non-régressions

Aucun test existant modifié. Résultats :

| Suite | Attendu | Obtenu |
|---|---|---|
| AF-07 balanced-fallback | 30/30 | **30 PASS / 0 FAIL** |
| AF-02 pop-null | 6/6 | **6 PASS / 0 FAIL** |
| AF-03 selected-leg-grade | 15/15 | **15 PASS / 0 FAIL** |
| AF-05 deterministic-tiebreak | 26/26 | **26 PASS / 0 FAIL** |
| AF-06 capitalComboInputPool | 22/22 | **22 PASS / 0 FAIL** |
| spreadPctPercent | 15/15 | **15 PASS / 0 FAIL** |

## 27. Harnais Fable

Lecture seule, non modifié. Baseline (ré-exécutée avant patch) : 31 PASS /
7 FAIL / 5 INFO — FAILs historiques T2b, T2c, T3a, T4a, T15a, T15b, T15c.
Après patch : **30 PASS / 8 FAIL / 5 INFO**. Diff exhaustif check par check —
exactement 2 changements, tous deux conséquences directes du correctif :

| ID | Avant | Après | Analyse |
|---|---|---|---|
| T6a | PASS (`avecJambeAgg: "(combo null)"`) | FAIL (`avecJambeAgg: "CRM"`) | Check « DÉMONTRÉ — candidat avec jambe AGG 2,0 % ⇒ EXCLU » : il **démontrait AF-07**. CRM est maintenant inclus avec sa jambe SAFE conforme ⇒ **check historique obsolète**, pas une régression (severité non CRITICAL, exit code 0). |
| T1f | INFO « absent (attendu) » | INFO « présent (inattendu) » | NFLX safe 0,697 % ≥ min V3 0,675 ⇒ conforme ⇒ désormais présent dans BALANCED. Statut INFO inchangé, comportement attendu du fix. |

Aucun nouveau FAIL réel. Les 7 FAILs historiques restent identiques.

## 28. Build

`npm.cmd run build` depuis `wheel-dashboard` : **PASS** (`✓ built in 3.54s`,
1950 modules). Warnings préexistants uniquement : directives « use client »
framer-motion ignorées + avertissement de taille de chunk (772 kB). Aucune
nouvelle erreur, aucun nouveau warning.

## 29. Fichiers modifiés

Modifié (suivi) :

- `wheel-dashboard/src/capitalComboPortfolio.js` — constante
  `BALANCED_PREFERRED_LEG_YIELD_BAND`, helper exporté
  `resolveCompatibleLegForMode`, fonction interne
  `pickFirstValidLegDescriptor`, remplacement de la branche BALANCED du
  `bucketResolvedPool` (152 insertions, 26 suppressions). Branches SAFE et
  AGGRESSIVE intactes ; aucune bande, pondération ou cap modifié.

Créés (untracked) :

- `wheel-dashboard/src/capitalComboPortfolio.balanced-fallback.test.mjs` (30 tests) ;
- `debug/capital-combinations-af07-patch-validation/capital-combinations-af07-patch-validation.md` ;
- `debug/capital-combinations-af07-patch-validation/capital-combinations-af07-patch-validation.json`.

Scripts de reproduction : dossier temporaire Windows hors dépôt uniquement.
Aucun `git add`, aucun commit, aucun push.

## 30. Limites

1. **AF-01 (hors périmètre, documenté)** : `pick.mode` reflète toujours le
   mode du candidat source — un pick BALANCED utilisant la jambe SAFE peut
   afficher `mode: "AGGRESSIVE"`. Les données financières, elles, viennent
   à 100 % de la jambe sélectionnée. Non corrigé ici, conformément au mandat.
2. **Miroir UI** : `dashboard.jsx` (~lignes 9110-9138, panneau diagnostic
   bucket) duplique l'ancienne sélection inline ; pour un candidat récupéré
   par AF-07 (zone [0,675 ; 0,75)), ce panneau d'affichage peut montrer la
   jambe AGG alors que le moteur retient SAFE. Fichier interdit de
   modification dans cette mission — documenté seulement.
3. La conformité vérifiée par le helper porte sur la **bande de rendement**
   (périmètre AF-07). Les autres gates (spread, exécution, distance, filtres
   qualité, capital) restent évalués en aval sur la jambe retenue ; une jambe
   conforme en rendement mais rejetée par un gate aval ne déclenche pas de
   réessai de l'autre jambe — comportement identique à l'existant.
4. Compatibilité future `balancedLeg` : **structurelle** (priority 0, TESTS
   26/27 au niveau helper), pas une validation de bout en bout — la vraie
   jambe n'existe pas encore.
5. Un rendement inconnu sur une jambe **par ailleurs valide** est impossible
   au niveau moteur (`_has*LegValid` exige un rendement fini > 0) ; le cas est
   couvert au niveau helper (TESTS 8/9) et par l'invalidité de jambe au niveau
   moteur.
6. Les checks Fable T6a (FAIL obsolète) et T1f (INFO) décrivent désormais
   l'ancien comportement ; leur mise à jour appartient à une mission
   ultérieure (harnais interdit de modification ici).
7. `maxPositions` demandé n'est pas le plafond effectif de BALANCED V3
   (plancher préexistant de 5 lignes) — vérifié, non modifié.

## 31. État Git final

```
HEAD          : 7700aed (inchangé)
branche       : main...origin/main (synchronisée)
git diff --name-only :
  wheel-dashboard/src/capitalComboPortfolio.js
git diff --stat :
  1 fichier modifié, 152 insertions(+), 26 suppressions(-)
untracked AF-07 :
  wheel-dashboard/src/capitalComboPortfolio.balanced-fallback.test.mjs
  debug/capital-combinations-af07-patch-validation/ (2 rapports)
untracked préexistants : intacts
Aucun git add. Aucun commit. Aucun push.
```

**Verdict : SAFE TO COMMIT WITH CAVEAT** — correctif complet et prouvé ;
caveat unique : l'étiquette `pick.mode` (AF-01, préexistant, hors périmètre)
et le miroir d'affichage dashboard.jsx, documentés ci-dessus.
