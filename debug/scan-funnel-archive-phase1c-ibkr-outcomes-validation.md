# Scan Funnel Archive — Phase 1C IBKR Outcomes Validation

Généré : 2026-06-07T12:26:12.950Z
Résultat global : ✅ OK

## Source des outcomes IBKR
- **Primaire** : `ibkrDirectResult.shortlist` (retenus) et `ibkrDirectResult.rejected` (rejetés)
- **Secondaire** : `funnelRows[].ibkrStatus` via `buildYahooIbkrFunnel`
- **Correctif capture** : `archiveScanFunnel({ sourceOverrides: { ibkrDirectResult, ibkrDirectSentTickers, displayedSymbols } })` au moment de la réponse IBKR — évite le ref stale (`useEffect` vs `setTimeout(0)`)
- **ui_lost** : ticker `ibkr_retained` absent de `displayedSymbols` → `filtered_after_ibkr`

## Périmètre
- Pas de changement DB / routes / server.js / scanner / scoring / providers / Pine
- Fichiers modifiés : helper + test + `dashboard.jsx` (passage sourceOverrides minimal)

## Scénario Phase 1C
| Stage | Count |
|---|---|
| ui_displayed | 1 |
| ui_lost | 1 |
| ibkr_retained | 2 |
| ibkr_rejected | 1 |
| ibkr_sent | 3 |
| yahoo_returned | 0 |
| yahoo_rejected | 0 |
| crypto_blocked | 0 |
| watchlist_rejected | 1 |

## Fichiers suivis modifiés
- `wheel-dashboard/src/dashboard.jsx`
- `wheel-dashboard/src/scanFunnelArchivePayload.js`
- `wheel-dashboard/src/scanFunnelArchivePayload.test.mjs`

## Vérifications

| # | Vérification | Statut | Détail |
|---|---|---|---|
| 1 | source IBKR identifiée : ibkrDirectResult.shortlist + rejected | ✅ | dashboard passe sourceOverrides.ibkrDirectResult au moment de archiveScanFunnel (évite ref stale) |
| 2 | ibkr_retained généré (AAA, CCC) | ✅ | count=2 |
| 3 | ibkr_rejected généré avec reason (BBB) | ✅ |  |
| 4 | ui_lost généré (CCC retenu non affiché) | ✅ |  |
| 5 | ui_displayed inchangé (AAA) | ✅ |  |
| 6 | ibkr_sent count = 3 | ✅ | count=3 |
| 7 | ibkr_retained count = 2 | ✅ |  |
| 8 | ibkr_rejected count = 1 | ✅ |  |
| 9 | ui_displayed count = 1 | ✅ |  |
| 10 | ui_lost count = 1 | ✅ |  |
| 11 | metadata retained compact (strike/grade, pas optionChain) | ✅ |  |
| 12 | sanitization : pas rawJson/optionChain/greeks | ✅ |  |
| 13 | backward compat : sans ibkrDirectResult → ibkr_sent + ui_displayed seulement | ✅ |  |
| 14 | cap 800 respecté | ✅ | count=9 |
| 15 | priorité Phase 1B conservée (FUNNEL_STAGE_PRIORITY inchangé) | ✅ |  |
| 16 | sous saturation watchlist, ibkr_retained/rejected/ui_lost conservés | ✅ |  |
| 17 | tests unitaires scanFunnelArchivePayload | ✅ |  |
| 18 | tests store scanFunnelArchiveStore | ✅ |  |
| 19 | priorité Phase 1B inchangée (validation inline) | ✅ |  |
| 20 | vite build OK | ✅ |  |
| 21 | git diff --check OK | ✅ |  |
| 22 | aucun DB/routes/server/scanner/scoring/providers/Pine modifié | ✅ |  |
| 23 | fichiers code Phase 1C modifiés (helper + test + dashboard sourceOverrides) | ✅ | wheel-dashboard/src/dashboard.jsx, wheel-dashboard/src/scanFunnelArchivePayload.js, wheel-dashboard/src/scanFunnelArchivePayload.test.mjs |

## Garanties
- `ibkr_retained` / `ibkr_rejected` / `ui_lost` générés quand la source est fournie
- Backward compat : sans `ibkrDirectResult`, comportement Phase 1/1B inchangé
- Cap 800 et priorité Phase 1B conservés
- Aucun git add / commit
