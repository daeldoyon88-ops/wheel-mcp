# Validation patch AF-12 + AF-15

## 1. Résumé

Patch conservateur appliqué dans `capitalComboPortfolio.js` uniquement :
- **AF-12** : scores professionnels recalculés depuis `selectedLeg` au bucket.
- **AF-15** : métadonnées d'audit projetées dans `createPick`.

Allocation financière inchangée (strike, prime, capital, contrats, caps).

## 2. État Git initial

- HEAD : `b6bf608`
- Branche : `main...origin/main`
- Worktree propre (aucun fichier suivi modifié avant patch)

## 3. Cause AF-12

`proFinalScore` / `proDistanceScore` provenaient du scanner (toujours jambe SAFE) et n'étaient pas recalculés dans `bucketResolvedPool`.

## 4. Cause AF-15

`createPick` ne copiait pas expiration, bid/ask, rank, identifiants contrat ni timestamps.

## 5. Cause commune

Projection incomplète `selectedLeg → candidat bucket → pick`.

## 6. Formule score professionnel

Identique à `wheelScanner.computeProScore` :
- `executionScore = spreadScore*0.5 + volumeScore*0.3 + oiScore*0.2`
- `distanceScore = min(abs(distanceDecimal)/0.1, 1)`
- `finalScore = weeklyYieldDecimal × executionScore × distanceScore`

## 7. Unités

- Rendement jambe combo : **%** → converti en decimal `/100` pour le score pro.
- Distance jambe combo : **%** (ex. -10.1) → decimal abs si `|pct|>1`.
- Spread : % via `resolveLegSpreadPctPercent`.

## 8. Projection selectedLeg

Helpers exportés :
- `resolveSelectedLegProScore(candidate)`
- `projectSelectedLegMetadata(candidate)`

## 9. SAFE

Score et metadata de la jambe SAFE recalculés/copiés.

## 10. AGGRESSIVE

Score pro de la jambe AGGRESSIVE — plus de score SAFE hérité.

## 11. BALANCED

Score/metadata de la jambe réellement retenue (SAFE ou AGGRESSIVE).

## 12. Fallback AF-07

Score/metadata suivent la jambe fallback conforme.

## 13. Écart 3,6 points

Biais historique `quality weight × ΔqualityNorm` supprimé quand les scores jambe diffèrent (TEST 7 : Δ jusqu'à 6 pts avec scores explicites 0 vs 1).

## 14. Expiration

`selectedLeg.expiration` prioritaire ; fallback parent ; `expirationMismatch` diagnostic.

## 15. DTE

`selectedLeg.dte` puis parent `dteDays`.

## 16. Bid/ask/mid

- `selectedLeg.bid/ask/mid` prioritaire
- Fallback `candidate.bid/ask/mid` seulement si absent sur jambe
- **Jamais** dérivé de `premium`, `premiumUsed`, `primeUsed` ou `selectedPremiumUnit`

## 17. Rank et identifiants

`rank`, `finalRank`, `optionSymbol`, `conId`, `contractId`.

## 18. Timestamp et marketDataType

`quoteTimestamp`, `marketDataType`, `quoteSource` (`selectedLeg.quoteSource` → `candidate.quoteSource` uniquement).

## 19. Compatibilité legacy

Fallback parent pour SAFE ou objet sans jambes ; valeurs neutres 0 pour scores invalides.

## 20. Allocation inchangée

233/233 tests non-régression PASS.

## 21. Tests AF-12

`selected-leg-pro-score.test.mjs` : **20/20 PASS**

## 22. Tests AF-15

`pick-metadata.test.mjs` : **37/37 PASS** (incl. mid strict + quoteSource sans source générique)

## 23. Non-régressions

**270/270 PASS** (11 suites existantes + 2 nouvelles).

## 24. Fable

| Métrique | Avant | Après |
|---|---|---|
| PASS | 29 | 28 |
| FAIL | 9 | 10 |
| CRITICAL | 0 | 0 |

- **T1g** : PASS → FAIL — **check obsolète** (metadata maintenant présentes). Non régression.
- Autres FAIL : pré-existants (AF-11 spread, AF-02 POP).

## 25. Build

`npm run build` : **PASS** (warnings framer-motion préexistants).

## 26. Fichiers modifiés

- `wheel-dashboard/src/capitalComboPortfolio.js`

## 27. Fichiers créés

- `wheel-dashboard/src/capitalComboPortfolio.selected-leg-pro-score.test.mjs`
- `wheel-dashboard/src/capitalComboPortfolio.pick-metadata.test.mjs`
- Ce rapport + JSON

## 28. Limites

- `pick.mode` inchangé (AF-01 non touché).
- `mid` ne dérive jamais de champs premium.
- `quoteSource` n'utilise pas `source` générique.
- Pas de gate expiration moteur nouvelle.
- Fable T1g doit être mis à jour dans un commit séparé si souhaité.

## 29. État Git final

- HEAD : `b6bf608` (inchangé)
- 1 fichier suivi modifié, 2 tests + rapport untracked
- Aucun git add / commit / push

## 30. Verdict

**SAFE TO COMMIT** — AF-12 et AF-15 corrigés sans impact allocation.
