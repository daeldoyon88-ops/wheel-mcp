# Validation patch AF-11 — Spread négatif et marché croisé

## 1. Résumé

Patch AF-11 appliqué à HEAD `832faf2`. Les spreads négatifs et les marchés croisés (`bid > ask`) sont rejetés strictement dans le moteur capital combo, le score V2, le rescue SAFE et `wheelMetrics`. Pool Research hors marché préservé (quotes frozen/delayed cohérentes admissibles).

## 2. État Git initial

- Racine : `C:/Users/melan/Desktop/wheel-mcp-remote`
- HEAD : `832faf2` fix multi-contract capital display
- `main` synchronisée avec `origin/main`
- Aucun fichier suivi modifié avant patch

## 3. Politique retenue

**POLITIQUE A — REJET STRICT** + **POLITIQUE C** (bid/ask prioritaires quand disponibles).

Un spread exécutable valide doit être fini, `>= 0` et `<= maxSpread`. Jamais de clamp d'un spread négatif à 0.

## 4. Source de vérité spread

`resolveLegSpreadDiagnostics` / `resolveLegSpreadPctPercent` dans `capitalComboPortfolio.js`.

## 5. Unités

Sortie en points de pourcentage (5 = 5 %). Fraction IBKR `0.05` → 5 % via `toSpreadPctPercent`.

## 6. bid < ask

Spread recalculé : `((ask - bid) / mid) * 100`. Jambe valide si autres critères OK.

## 7. bid = ask

Spread = 0. Valide.

## 8. bid > ask

`CROSSED_MARKET` — spread `null`, jambe invalide, score 0, même si `spreadPct` fourni positif.

## 9. Spread négatif sans bid/ask

`NEGATIVE_SPREAD_PCT` — rejet, spread `null`.

## 10. Validation SAFE

`hasSafeLegValid` : `spread >= 0 && spread <= 35`.

## 11. Validation AGGRESSIVE

`hasAggLegValid` : `spread >= 0 && spread <= 35`.

## 12. Grade

`gradeLeg` : `spread < 0` → `REJECT`. Aucun A/B pour négatif.

## 13. Score spread

`normalizeComboSpreadScore` : `value < 0` → 0. `0 %` → score maximal.

## 14. Score V2

`scoreSpreadBlock` : crossed/négatif → 0 point + warning.

## 15. Rescue

`isSpreadAcceptable` : `>= 0 && <= 20`. `putSpreadPct` priorise bid/ask.

## 16. Duel CLEAN / CROSSED

CLEAN gagne ; CROSSED absent du portefeuille.

## 17. BALANCED AF-07

Jambe SAFE propre conservée ; jambe AGG crossed exclue.

## 18. Pool Research hors marché

Aucune condition `isMarketOpen`. Pas de blocage global marché fermé.

## 19. Frozen/delayed

Quote cohérente `bid <= ask` admissible malgré statut frozen/delayed.

## 20. Diagnostics

`CROSSED_MARKET`, `NEGATIVE_SPREAD_PCT`, `INVALID_MID` exportés via `SPREAD_PCT_REJECTION`.

## 21. Tests AF-11

32 tests — **32 PASS** (`capitalComboPortfolio.negative-spread.test.mjs`).

## 22. Non-régressions

**213 / 213 PASS** (11 suites).

## 23. Fable

29 PASS / 9 FAIL / 5 INFO — `criticalConfirmed = 0`.

- **T7a** : PASS → FAIL (correction AF-11 attendue, pas régression)
- **T1a** : spread recalculé bid/ask (4.26 vs 4.3 fixture)
- Autres FAIL : historiques (T3a, T4a, T6a, T9a, T15*)

## 24. Build

`npm run build` — **PASS** (warnings framer-motion / chunk size préexistants).

## 25. Fichiers modifiés

- `wheel-dashboard/src/capitalComboPortfolio.js`
- `wheel-dashboard/src/scoreV2.js`
- `app/calculations/wheelMetrics.js`
- `app/calculations/safeSpreadRescue.js`
- `wheel-dashboard/src/capitalComboPortfolio.balanced-fallback.test.mjs` (fixtures bid/ask alignées AF-11)

## 26. Fichiers créés

- `wheel-dashboard/src/capitalComboPortfolio.negative-spread.test.mjs`
- `debug/capital-combinations-af11-patch-validation/capital-combinations-af11-patch-validation.md`
- `debug/capital-combinations-af11-patch-validation/capital-combinations-af11-patch-validation.json`

## 27. Limites

- Aucune occurrence live négative dans données locales inspectées
- Impact picks live non mesuré (défaut synthétique seulement)
- Fable T1a : écart mineur spread recalculé

## 28. État Git final

- HEAD inchangé : `832faf2`
- 5 fichiers suivis modifiés, 2 artefacts créés (test + rapport)
- Aucun `git add`, `commit`, `push`

## 29. Verdict

**SAFE TO COMMIT**
