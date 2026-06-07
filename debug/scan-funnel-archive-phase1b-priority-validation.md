# Scan Funnel Archive — Phase 1B Priority Validation

Généré : 2026-06-07T12:04:53.405Z
Résultat global : ✅ OK
Périmètre : frontend helper only (scanFunnelArchivePayload.js + test)

## Constantes
- `MAX_FUNNEL_EVENTS` = 800
- `MAX_WATCHLIST_REJECTED_EVENTS` = 250
- Ordre de priorité : `ui_displayed > ui_lost > ibkr_retained > ibkr_rejected > ibkr_sent > yahoo_returned > yahoo_rejected > crypto_blocked > watchlist_rejected`

## Scénario de saturation (watchlist_rejected massif + crypto + UI/IBKR)
- Events finaux après priorisation : **303** (cap 800)

| Stage | Count conservé |
|---|---|
| ui_displayed | 1 |
| ui_lost | 1 |
| ibkr_retained | 2 |
| ibkr_rejected | 1 |
| ibkr_sent | 3 |
| yahoo_returned | 3 |
| yahoo_rejected | 2 |
| crypto_blocked | 40 |
| watchlist_rejected | 250 |

## Fichiers suivis modifiés
- `wheel-dashboard/src/scanFunnelArchivePayload.js`
- `wheel-dashboard/src/scanFunnelArchivePayload.test.mjs`

## Vérifications

| # | Vérification | Statut | Détail |
|---|---|---|---|
| 1 | patch frontend helper seulement (constantes Phase 1B exportées) | ✅ | MAX=800 WL=250 order=ui_displayed>ui_lost>ibkr_retained>ibkr_rejected>ibkr_sent>yahoo_returned>yahoo_rejected>crypto_blocked>watchlist_rejected |
| 2 | ui_displayed conservé | ✅ |  |
| 3 | ui_lost conservé | ✅ |  |
| 4 | ibkr_retained conservé | ✅ |  |
| 5 | ibkr_rejected conservé | ✅ |  |
| 6 | ibkr_sent conservé | ✅ |  |
| 7 | yahoo_returned conservé | ✅ |  |
| 8 | yahoo_rejected conservé | ✅ | count=2 |
| 9 | watchlist_rejected limité (<= 250) | ✅ | count=250 |
| 10 | watchlist_rejected exactement plafonné à 250 sous saturation | ✅ | count=250 |
| 11 | cap 800 respecté | ✅ | count=303 |
| 12 | crypto_blocked présent (tous conservés) | ✅ | count=40 |
| 13 | crypto exclusif conservé (RIOT n'émet que crypto_blocked) | ✅ |  |
| 14 | BITX non bloqué (ui_displayed) | ✅ |  |
| 15 | structure du payload inchangée | ✅ | scanSessionId,scanTimestamp,selectedExpiration,dteAtScan,poolSource,captureSource,counts,metadata,events |
| 16 | payload compact (pas de rawJson/optionChain/greeks) | ✅ |  |
| 17 | aucun fichier backend/server/routes/DB/dashboard/scanner/scoring/Pine modifié | ✅ |  |
| 18 | seuls le helper et son test (suivis) modifiés | ✅ | wheel-dashboard/src/scanFunnelArchivePayload.js, wheel-dashboard/src/scanFunnelArchivePayload.test.mjs |

## Garanties Phase 1B
- Patch frontend helper seulement (`scanFunnelArchivePayload.js` + son test).
- Aucune modification backend / server.js / routes / DB / dashboard.jsx / scanner / scoring E2b / IBKR-Yahoo providers / Pine.
- Events UI/IBKR priorisés (proches de la décision finale).
- `watchlist_rejected` plafonné à 250 (n'écrase plus l'archive).
- Cap 800 respecté.
- Crypto exclusif conservé (un ticker crypto bloqué n'émet que `crypto_blocked`).
- Structure / contrat du payload inchangés.
