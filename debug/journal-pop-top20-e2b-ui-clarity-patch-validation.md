# Validation — Patch UI clarté Top 20 E2b

> Généré le 2026-06-07T00:02:23 · **read-only** · aucun git add / commit

## Résumé

- **Scoring E2b modifié ?** Non
- **Backend modifié ?** Non
- **Top 20 inchangé ?** Oui (20 titres, mêmes rangs/scores moteur)
- **Vite build ?** OK
- **Validation globale ?** **OK**

## Checks

| Check | Résultat | Détail |
| --- | --- | --- |
| Backend wheelValidationService.js non modifié (git diff vide) | OK | {"diffBytes":0} |
| Patch limité à JournalPopPanel.jsx | OK | {"diffBytes":19595} |
| UI marker présent : Top20SampleTierBadge | OK | "" |
| UI marker présent : getTop20SampleTier | OK | "" |
| UI marker présent : formatAssignmentDepthCell | OK | "" |
| UI marker présent : Bonus robuste | OK | "" |
| UI marker présent : Proche (% assign.) | OK | "" |
| UI marker présent : Profonde (% assign.) | OK | "" |
| UI marker présent : ASSIGN_DEPTH_PERCENT_TOOLTIP | OK | "" |
| UI marker présent : resolveEventRiskDisplay | OK | "" |
| UI marker présent : buildHumanTop20ExclusionReason | OK | "" |
| UI marker présent : Mesurable · n ≥ 30 | OK | "" |
| UI marker présent : Incubateur · 10–14 | OK | "" |
| Top 20 E2b = 20 titres (scoring inchangé) | OK | {"count":20} |
| Formule E2b active | OK | {"readOnly":true,"experimental":true,"scoreType":"competitiveScoreV2","rankingFo |
| TQQQ Top 20 avec bonus robuste > 0 | OK | {"rank":13,"ticker":"TQQQ","score":67,"n":52,"robustHistoryBonus":11} |
| APLD Top 20 avec bonus robuste > 0 | OK | {"rank":11,"ticker":"APLD","score":69,"n":38,"robustHistoryBonus":8} |
| INTC Top 20 avec bonus robuste > 0 | OK | {"rank":10,"ticker":"INTC","score":82,"n":34,"robustHistoryBonus":8} |
| AFRM Top 20 avec bonus robuste > 0 | OK | {"rank":12,"ticker":"AFRM","score":69,"n":30,"robustHistoryBonus":8} |
| Badge tier HOOD → mesurable | OK | {"rank":1,"ticker":"HOOD","score":100,"n":52,"robustHistoryBonus":0} |
| Badge tier NOK → preliminaire | OK | {"rank":5,"ticker":"NOK","score":85,"n":28,"robustHistoryBonus":0} |
| Badge tier RIVN → incubateur | OK | {"rank":14,"ticker":"RIVN","score":65,"n":14,"robustHistoryBonus":0} |
| TQQQ profonde = 5/6 (83.3%) | OK | "5/6 (83.3%)" |
| APLD profonde = 2/3 | OK | "2/3 (66.7%)" |
| AFRM profonde = 2/2 | OK | "2/2 (100%)" |
| CCL proche = 4/4 | OK | "4/4 (100%)" |
| TTD risque événement priorisé = Risque confirmé | OK | {"category":"Risque confirmé","label":"Risque confirmé répété"} |
| PINS risque événement priorisé = Risque confirmé | OK | {"category":"Risque confirmé","label":"Risque confirmé répété"} |
| SLV risque événement priorisé = Risque confirmé | OK | {"category":"Risque confirmé","label":"Risque confirmé répété"} |
| TEM risque événement = Surveillé (win 25 % / assign 75 %) | OK | {"category":"Surveillé","label":"Win très faible — risque élevé"} |
| Vite build OK | OK | "" |

## Top 20 snapshot (scoring inchangé)

1. HOOD score=100 n=52 · 2. CCL score=100 n=40 · 3. HIMS score=100 n=32 · 4. DAL score=100 n=30 · 5. NOK score=85 n=28 · 6. U score=85 n=22 · 7. HPE score=85 n=22 · 8. BNO score=85 n=20 · 9. DOW score=85 n=16 · 10. INTC score=82 n=34 +8 · 11. APLD score=69 n=38 +8 · 12. AFRM score=69 n=30 +8 · 13. TQQQ score=67 n=52 +11 · 14. RIVN score=65 n=14 · 15. APA score=65 n=14 · 16. FLY score=65 n=10 · 17. CSCO score=65 n=10 · 18. FISV score=65 n=10 · 19. DOCU score=65 n=10 · 20. CNC score=65 n=10

## Améliorations UI confirmées

- Badges Mesurable / Préliminaire / Incubateur (affichage seulement)
- Colonnes Proche/Profonde (% assign.) + tooltip + fraction X/Y quand profil 1 %+ disponible
- Badge Bonus robuste +N pour TQQQ/APLD/INTC/AFRM
- Raisons d'exclusion humaines prioritaires (TEM, hardExclude, etc.)
- Risque événement : hardExclude > confirmé > surveillé > unique
