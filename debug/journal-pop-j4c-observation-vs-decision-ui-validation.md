# Validation J4-C — Couche UI « Observationnel vs décision réelle » (Journal POP)

> Généré le 2026-06-07 · Phase J4-C · **UI/métriques dérivées seulement, additif**
> Aucune modification du scoring, du tri Top 20, des verdicts, des formules POP/Objectif 1 %+, du scanner, d'IBKR/Yahoo, de l'Archive Funnel ni de la DB. Aucun backfill. Aucun `git add`/commit.

## Objectif

Distinguer dans l'UI les **assignations observationnelles** (variantes SAFE/AGRESSIF × DTE × scan) des **expirations assignées distinctes** (événements réels ticker + expiration), pour signaler quand le risque affiché est gonflé par duplication. Le Top 20 reste le Top 20 observationnel ; on ajoute uniquement des champs explicatifs.

Constat J4-B repris : le Journal POP additionne des variantes d'observation comme des trades distincts (TQQQ = 6 obs assignées pour 1 expiration réelle, ratio 6×).

## Fichiers modifiés

| Fichier | Nature | Δ |
| --- | --- | --- |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Frontend (helpers + composants + rendu) | +361 lignes, **0 suppression** (purement additif) |

Aucun autre fichier de code modifié. `app/journal/wheelValidationService.js` **non touché** (les champs nécessaires existaient déjà côté frontend).

## Fichiers créés

- `debug/journal-pop-j4c-observation-vs-decision-ui-validation.md` (ce rapport)
- `debug/journal-pop-j4c-observation-vs-decision-ui-validation.json`

## Fonctions / helpers ajoutés (frontend, additif)

| Helper / composant | Rôle |
| --- | --- |
| `OBS_VS_DECISION_TOOLTIP` (const) | Texte tooltip « Les observations comptent SAFE/AGRESSIF/DTE/scans séparément… ». |
| `getObservationVsDecisionMetrics(eventUniqueness)` | Dérive `assignedObservationCount`, `distinctAssignedExpirationCount`, `selectedTradeCount`, `duplicationRatio`, `inflated`, `reading`. |
| `formatDuplicationRatio(ratio)` | Formate `6.0×`. |
| `getRecordAssignmentDepthPct(record)` | Profondeur numérique `(close-strike)/strike*100` (réutilise les accesseurs strike/close existants ; ne modifie pas `classifyDteBreakdownAssignmentDepth`). |
| `buildAssignedExpirationBreakdown({ ticker, records })` | Liste des expirations assignées : nb d'observations, modes, DTE, strikes, close, répartition profondeur. |
| `buildSafeVsAggressiveReading({ ticker, records })` | Lecture **descriptive** (pas un verdict moteur) : SAFE aurait évité ? réduit la profondeur ? AGRESSIF valait le risque ? |
| `ObsVsDecisionInline` (composant) | Ligne compacte sous le ticker : « Assign. obs. / Exp. assignées / Duplication » + avertissement si ratio ≥ 2. |
| `ObsVsDecisionLegend` (composant) | Légende compacte « Observationnel vs réel ». |
| `ObsVsDecisionModalSection` (composant) | Micro-section du modal détail ticker. |

Extensions **additives** de fonctions existantes (aucun champ existant retiré/renommé) :
- `buildDynamicTop20DteBreakdown` : ajout `row.distinctExpirationCount` par DTE + bloc `obsVsDecision { metrics, assignedExpirations, safeVsAggressive, dteObsVsExp }` dans le retour.

## Sections UI touchées

1. **Tableau Top 20 principal** — cellule Ticker : ajout de `ObsVsDecisionInline` sous le bouton ticker (Assign. obs. · Exp. assignées · Duplication × + avertissement « Risque gonflé par variantes »). Tooltip explicatif.
2. **En-tête Top 20** — ajout de `ObsVsDecisionLegend` sous `JournalPopCountersLegend`.
3. **Modal « Détail Journal POP par DTE »** — ajout de `ObsVsDecisionModalSection` (cartes Observations assignées / Expirations assignées / Ratio duplication, lecture, table des expirations assignées, lecture SAFE vs AGRESSIF, ligne Obs. DTE vs Exp. DTE) + `ObsVsDecisionLegend`.

## Définitions (conformes à la demande)

- `assignedObservationCount` = nombre d'observations assignées éligibles (DTE 2/3/4/7, résolu, hors retest intraday) = `eventUniqueness.assignedCount`.
- `distinctAssignedExpirationCount` = nombre de paires distinctes `ticker + selectedExpiration` assignées = `eventUniqueness.distinctAssignedExpirationCount`.
- `duplicationRatio` = `assignedObservationCount / distinctAssignedExpirationCount`.
- `selectedTradeCount` = `distinctAssignedExpirationCount` (≈ 1 trade par expiration).
- Avertissement affiché si `duplicationRatio ≥ 2` **et** `assignedObservationCount > 0` (jamais affiché si 0 assignation).

Ces métriques réutilisent `computeTickerEventUniqueness` (déjà présent), qui calcule `selectedExpiration` via `getRecordExpirationKey`. Elles sont cohérentes avec l'audit J4-B (TQQQ 6/1 = 6×).

## Confirmations

- ✅ Top 20 **non modifié** dans son tri et son scoring (aucune touche à `dynamicTop20Status`, `dynamicTop20Score`, à l'ordre des rows, ni au backend de tri).
- ✅ Aucune formule moteur modifiée (POP, Objectif 1 %+, profondeur `classifyAssignmentDepth`, scoring E2b inchangés).
- ✅ Aucun verdict modifié (`primaryVerdict`, `classifyEventRiskVerdict`, libellés de verdict inchangés ; la lecture SAFE/AGRESSIF est descriptive, non branchée au moteur).
- ✅ Aucune route scanner / IBKR / Yahoo / Archive Funnel touchée.
- ✅ Aucune DB modifiée, aucun backfill.
- ✅ `app/journal/wheelValidationService.js` non modifié (diff vide).
- ✅ Changement purement additif : +361 lignes, 0 suppression.
- ✅ Aucun `git add`, aucun commit.

## Validation exécutée

| Contrôle | Commande | Résultat |
| --- | --- | --- |
| Build frontend | `npx vite build` (dans `wheel-dashboard`) | ✅ built in ~4.2s, `JournalPopPanel-*.js` émis |
| Tests journal | `node --test app/journal/*.test.mjs` | ✅ 129 pass / 0 fail |
| Whitespace/diff | `git diff --check` | ✅ aucun problème |
| Diff additif | `git diff --stat` | ✅ 1 fichier, +361 / 0 suppression |

## Vérification manuelle attendue (UI)

- Le Top 20 conserve ses tickers et leur ordre (rang/score inchangés ; la ligne obs/exp est purement informative sous le ticker).
- Les nouveaux champs montrent observationnel vs expiration réelle (Assign. obs. / Exp. assignées / Duplication).
- TQQQ doit afficher **6 obs. / 1 expiration / duplication 6×** et l'avertissement « Risque gonflé par variantes : 6 obs. pour 1 expiration » (valeurs dérivées de `computeTickerEventUniqueness`, cohérentes avec l'audit J4-B).
- Aucun score ni verdict ne change.

## Limites restantes (à traiter en phase backend additive si souhaité)

1. **Périmètre DTE** : les métriques obs/exp utilisent le filtre éligible `DYNAMIC_TOP20_DTE_TARGETS = [2,3,4,7]` + résolu + hors retest intraday (cohérent avec la couche événement existante). Les observations hors de ces DTE ne sont pas comptées dans la ligne compacte. C'est volontaire (aligné sur le détail par DTE), mais l'audit J4-B « global » (334/108) inclut d'autres DTE — l'agrégat global n'est donc pas affiché ici, seulement le par-ticker sur DTE ciblés.
2. **Lecture SAFE/AGRESSIF** : descriptive et qualitative (oui/non/partiel/à confirmer/données insuffisantes), comparée sur paires `expiration × DTE` où SAFE et AGRESSIF coexistent. Pas de score, pas de branchement moteur — conforme à la demande.
3. **close par expiration** : pris du premier record assigné disponible de l'expiration (les observations partagent la même close d'expiration ; cohérent avec les données J4-B).
4. **Objectif 1 %+ (table profils)** : la ligne compacte est ajoutée au Top 20 expérimental (table principale). Le bloc Objectif 1 %+ historique partage les mêmes données ; une extension symétrique éventuelle reste possible mais non requise par J4-C (le Top 20 est la cible principale).
5. Une exposition backend additive de `observation_count` / `expiration_count` (recommandation §7 de l'audit) reste possible plus tard ; non nécessaire ici car le frontend dispose déjà des records bruts.
