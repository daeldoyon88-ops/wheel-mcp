# Validation - Market Context Snapshot -> table dediee

## Scope

- Backend Journal POP uniquement.
- Aucun changement UI.
- Aucun changement scanner.
- Aucun changement Yahoo/IBKR.
- Aucun changement scoring E2b.
- Aucun backfill.
- Aucune modification de la DB de production.

## Patch confirme

- `insertMarketContextSnapshot` est branche apres la sauvegarde Journal POP existante.
- L'appel est garde par:
  - methode presente;
  - `marketContextSnapshot` existant;
  - au moins un record cree.
- Une seule ligne representative est inseree par capture, basee sur le premier record cree (`uniqueRecords[0]`).
- Le snapshot utilise est celui deja construit dans `captureFromCandidates()` et transmis aux records.
- L'echec d'insertion dediee ne casse pas la capture Journal POP: warning seulement.

## Compatibilite

- `market_context_snapshot_json` existant dans `wheel_validation_records` reste intact.
- Les tests existants confirment que le snapshot marche ne change pas les verdicts Objectif 1 % ni Top 20.
- Pas de refetch Yahoo/IBKR ajoute.
- Pas de modification Pine TradingView.

## Tests

| Commande | Resultat |
|---|---|
| `node --check app\journal\wheelValidationService.js` | OK |
| `node --check app\journal\wheelValidationService.marketContextPersistence.test.mjs` | OK |
| `node --check server.js` | OK |
| `node --test app\journal\wheelValidationService.marketContextPersistence.test.mjs` | OK - 3/3 |
| `node --test app\journal\marketContextSnapshot.test.mjs` | OK - 12/12 |

## Risques restants

- `S5TH` reste `null` / non disponible dans le snapshot actuel. Ce patch ne le refetch pas.
- La table `market_context_snapshot` n'a pas de colonne `scanSessionId`; l'insertion dediee utilise donc le `record_id` representatif avec `scan_date`, `ticker` et `expiration`.
- Les colonnes `spy_30d_return`, `qqq_30d_return`, `vix_percentile` et `broad_market_score` restent `null` tant que le snapshot source ne fournit pas ces donnees.

## Git

- Aucun `git add`.
- Aucun commit.
- Entrees du patch dans `git status --short` final:
  - ` M app/journal/wheelValidationService.js`
  - `?? app/journal/wheelValidationService.marketContextPersistence.test.mjs`
  - `?? debug/market-context-snapshot-table-persistence-patch-validation.json`
  - `?? debug/market-context-snapshot-table-persistence-patch-validation.md`
  - `?? debug/market-context-snapshot-table-persistence-patch-validation.mjs`
- Le statut contient aussi de nombreux fichiers non suivis preexistants dans `debug/`, `scripts/`, JSON de scan et `wheel-dashboard/data`; ils n'ont pas ete modifies par ce patch.
