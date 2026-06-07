# Scan Funnel Archive — Phase 1 Validation

Généré : 2026-06-07T11:38:46.807Z
Résultat global : ✅ OK
Cap events : 800

## Fichiers créés
- `app/journal/scanFunnelArchiveStore.js`
- `app/journal/scanFunnelArchiveRoutes.js`
- `app/journal/scanFunnelArchiveStore.test.mjs`
- `wheel-dashboard/src/scanFunnelArchivePayload.js`
- `wheel-dashboard/src/scanFunnelArchivePayload.test.mjs`

## Fichiers suivis modifiés
- `server.js`
- `wheel-dashboard/src/dashboard.jsx`

## Vérifications

| # | Vérification | Statut | Détail |
|---|---|---|---|
| 1 | store dédié créé (scanFunnelArchiveStore.js) | ✅ |  |
| 2 | routes dédiées créées (scanFunnelArchiveRoutes.js) | ✅ |  |
| 3 | tables idempotentes (double ensureInitialized sans erreur) | ✅ |  |
| 4 | archiveSession ok | ✅ | {"ok":true,"scanSessionId":"valid-001","eventsArchived":3} |
| 5 | getSession retourne session + events | ✅ |  |
| 6 | re-archive même scanSessionId ne duplique pas | ✅ | events=3 |
| 7 | refuse > 800 events | ✅ | too many events: 801 > 800 |
| 8 | payload: RIOT crypto_blocked exclusif | ✅ |  |
| 9 | payload: BITX non bloqué (ui_displayed) | ✅ |  |
| 10 | payload: SOFI ui_displayed | ✅ |  |
| 11 | payload: XYZ yahoo_rejected | ✅ |  |
| 12 | payload compact: pas de rawJson | ✅ |  |
| 13 | payload compact: pas d'optionChain/greeks | ✅ |  |
| 14 | payload: cap 800 respecté | ✅ |  |
| 15 | même SQLite que Journal POP (défaut) | ✅ | C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite |
| 16 | store: aucun refetch / provider | ✅ |  |
| 17 | routes: aucune logique Yahoo/IBKR (pas de fetch/provider) | ✅ |  |
| 18 | payload helper: pur, aucun fetch/provider | ✅ |  |
| 19 | aucun fichier interdit modifié (scanner/scoring/Pine/ticker_memory/JournalPop capture) | ✅ |  |
| 20 | seuls server.js + dashboard.jsx modifiés (suivis) | ✅ | server.js, wheel-dashboard/src/dashboard.jsx |

## Garanties
- Store dédié + endpoint dédié, même SQLite que Journal POP (sqlitePath injecté).
- Aucun refetch Yahoo/IBKR : l'archive ne consomme que des données déjà calculées.
- Aucun changement scanner / scoring E2b / Pine / ticker_scan_memory / Journal POP capture.
- Payload compact : aucun rawJson, aucune chaîne d'options, aucun greek complet.
- Max 800 events, dédup symbol+stage, idempotent par scanSessionId.
- Archive best-effort côté dashboard (void fetch, console.warn, ne bloque pas le scan).
