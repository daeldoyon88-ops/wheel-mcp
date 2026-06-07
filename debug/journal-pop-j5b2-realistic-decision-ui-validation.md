# Validation J5-B2 — Affichage UI « décision réelle BALANCED » (Journal POP)

> Phase J5-B2 · 2026-06-07 · **additif / affichage uniquement** — aucun score, statut, tri ni verdict modifié.

## Objectif

Afficher dans l'UI Top 20 / détail ticker les métriques `realisticDecisionMetrics`
ajoutées au service en J5-B1, pour comparer la lecture **observationnelle** actuelle
à la base **décision réelle BALANCED** (1 décision par ticker × `selectedExpiration`).
**Pas** de second classement, **pas** de modification du score ni du tri du Top 20.

## Fichiers modifiés

| Fichier | Nature | Lignes |
| --- | --- | --- |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Modifié (additif, affichage) | +252 / -0 |

`app/journal/wheelValidationService.js` : **NON modifié** (`git diff --stat` vide).

## Fichiers créés

| Fichier | Nature |
| --- | --- |
| `debug/journal-pop-j5b2-realistic-decision-ui-validation.md` | Rapport |
| `debug/journal-pop-j5b2-realistic-decision-ui-validation.json` | Rapport machine |

## Composants / helpers ajoutés (tous dans `JournalPopPanel.jsx`)

- `REALISTIC_DECISION_TOOLTIP` — texte tooltip partagé.
- `hasRealisticDecisionMetrics(rdm)` — garde « données présentes » (`selectedTradeCount > 0`).
- `REALISTIC_DECISION_BADGE_TONE` — table de tons des badges.
- `getRealisticDecisionBadges(rdm, observationalAssignmentRate)` — badges **descriptifs**
  (jamais utilisés dans le score) :
  - `duplicationRatio >= 4` → « duplication élevée » ;
  - `selectedAssignmentRatePct <= assignmentRate observationnel` → « risque réduit après dédup. » ;
  - `selectedDeepAssignmentRatePct > 30` → « profondeur à surveiller » ;
  - `selectedTradeCount < 5` → « échantillon faible ».
- `RealisticDecisionBadgeRow` — rendu des badges.
- `formatRealisticModeSplit(split)` — « SAFE n · AGRESSIF n (· AUTRE n) ».
- `formatRealisticDteSplit(split)` — « 3DTE:3 · 7DTE:2 » (tri croissant DTE, affichage seulement).
- `RealisticDecisionInline` — ligne compacte Top 20 sous le ticker.
- `RealisticDecisionLegend` — légende compacte « Décision réelle BALANCED ».
- `RealisticDecisionModalSection` — section comparative du modal détail ticker.

Helpers réutilisés sans modification : `formatPercent`, `formatDuplicationRatio`, `numberOrNull`.

## Sections UI touchées

1. **Top 20 principal — colonne Ticker** (`filteredDynamicTop20Main.map`) : ajout de
   `<RealisticDecisionInline rdm={row.realisticDecisionMetrics} observationalAssignmentRate={row.assignmentRate} />`
   sous le bouton ticker et sous l'inline J4-C existant.
   Rendu compact :
   `Décisions 5 · Assign. réelle 20 % · Prof. réelle 0 % · Rend. réel 0,95 % · Dup. 6,0×`
   (+ badges descriptifs sur une 2e ligne si applicables).
2. **Légende Top 20** : ajout de `<RealisticDecisionLegend className="mt-2" />` sous la légende J4-C.
3. **`buildDynamicTop20DteBreakdown`** : ajout d'un bloc additif `realisticDecision`
   = `{ metrics: globalProfile.realisticDecisionMetrics, observational: { assignmentRate, deepAssignmentRate, avgCspYieldPct } }`
   (lecture seule des champs déjà portés sur la ligne, aucun recalcul).
4. **Modal détail ticker** (`DynamicTop20DteBreakdownModal`) : ajout de
   `<RealisticDecisionModalSection realisticDecision={breakdown?.realisticDecision} />`
   + `<RealisticDecisionLegend />`. La section affiche :
   - tableau comparatif obs. vs réel (n résolues/décisions, assignation, profondeur, rendement, duplication) ;
   - Mode choisi (`selectedModeSplit`), DTE choisis (`selectedDteSplit`) ;
   - Décisions / assignées (`selectedTradeCount`, `selectedAssignedCount`) ;
   - Assignations proches / modérées / profondes (`selectedNear/Moderate/DeepAssignmentCount`) ;
   - badges descriptifs.

## Champs `realisticDecisionMetrics` consommés

`policy`, `selectedTradeCount`, `selectedAssignedCount`, `selectedAssignmentRatePct`,
`selectedNearAssignmentCount`, `selectedModerateAssignmentCount`, `selectedDeepAssignmentCount`,
`selectedDeepAssignmentRatePct`, `selectedAvgCspYieldPct`, `selectedModeSplit`, `selectedDteSplit`,
`duplicationRatio`, `observationResolvedCount`.

Contreparties observationnelles lues sur la ligne (déjà présentes) : `assignmentRate`,
`deepAssignmentRate`, `avgCspYieldPct`.

## Preuve « Top 20 score/tri non modifié »

1. **`git diff --stat`** : 1 fichier, **+252 / -0** — purement additif, aucune ligne
   existante supprimée ou réécrite.
2. **Service intact** : `git diff --stat app/journal/wheelValidationService.js` est **vide**.
   Les formules de score, le tri et les statuts vivent dans le service ; ils ne sont pas touchés.
3. **Aucune écriture vers le scoring** : `realisticDecisionMetrics` est uniquement **lu**
   pour l'affichage (`RealisticDecisionInline`, `RealisticDecisionModalSection`). Aucun
   appel à `computeDynamicTop20LaboratoryScore`, `dynamicTop20Score`, `dynamicTop20Status`
   ou un comparateur `sort` du classement n'est ajouté/modifié. Le seul `.sort` introduit
   trie les clés DTE **pour l'affichage** dans `formatRealisticDteSplit`.
4. **Ordre `filteredDynamicTop20Main` inchangé** : aucune transformation du tableau de
   lignes ; on rend une cellule supplémentaire par ligne, dans le même ordre.

## Gestion des données manquantes

- `RealisticDecisionInline` : retourne `null` si `realisticDecisionMetrics` absent ou
  `selectedTradeCount === 0` (rien affiché, UI intacte).
- `RealisticDecisionModalSection` : affiche « Décision réelle : non disponible pour ce
  ticker. » si le bloc est absent/vide.

## Résultats tests / build

- `npx vite build` (wheel-dashboard) → **✓ built in 3.77s** (aucune erreur ; chunk
  `JournalPopPanel` 341.71 kB).
- `node --test app/journal/*.test.mjs` → **138 pass / 0 fail**.
- `git diff --check` → **OK** (exit 0, aucun trailing whitespace / conflit).

## Vérification manuelle attendue

- Top 20 conserve les mêmes tickers et le même ordre (HOOD, CCL, HIMS, DAL, …).
- Les champs « Décisions / Assign. réelle / Prof. réelle / Rend. réel / Dup. » apparaissent
  sous chaque ticker du Top 20 principal.
- TQQQ : lecture compatible J5-A/J5-B1 (5 expirations, assign. réelle ≈ 20 %, prof. réelle 0 %,
  mode AGRESSIF dominant, DTE 3 — cf. audit J5-A tableau focus).
- Aucun score, aucun statut, aucun verdict ne change.
- Aucun warning console bloquant (build propre).

## Contraintes respectées

`dynamicTop20Score`, `dynamicTop20Status`, tri Top 20, verdicts, formules POP, Objectif 1 %+,
scanner, IBKR/Yahoo, Archive Funnel, DB : **non touchés**. Aucun backfill. Aucun `git add`,
aucun commit. Modifs limitées à `JournalPopPanel.jsx` (+ rapports debug).

## Limites restantes

- Format numérique : les nombres suivent la convention existante de l'UI (`formatPercent`
  → « 20.0% », `formatDuplicationRatio` → « 6.0× ») plutôt que la virgule française des
  exemples du brief, pour rester cohérent avec `ObsVsDecisionInline` (J4-C). Le contenu
  affiché est identique.
- Les badges sont **descriptifs** et n'entrent dans aucun calcul ; ils n'apparaissent que
  lorsque les seuils sont franchis.
- Les contreparties observationnelles du modal (`assignmentRate`, `deepAssignmentRate`,
  `avgCspYieldPct`) viennent du profil/ligne (base observationnelle existante) ; aucune
  recomputation n'est faite côté UI.
- Le bloc reste post-analyse : J5-B2 améliore la lisibilité uniquement, le classement
  observationnel n'est pas migré (objet des phases J5-B3+).
