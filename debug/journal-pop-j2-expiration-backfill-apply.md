# Backfill J2-C — expiration = selectedExpiration (APPLY)

> Généré le 2026-06-07T13:53:24 · ✅ SUCCÈS
> DB : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite`
> Backup : `C:\Users\melan\Desktop\wheel-mcp-remote\debug\backups\wheelValidationJournal-before-j2-expiration-backfill-20260607-095323.sqlite`

## Résultat

| Métrique | Avant | Après |
| --- | --- | --- |
| recordCount | 3184 | 3184 |
| totalMismatch | 142 | 0 |
| resolvedCount | 2412 | 2412 |
| assignedCount | 463 | 463 |
| pendingCount | 772 | 772 |

**Records backfillés : 142**

## Validation

| Contrôle | Résultat |
| --- | --- |
| totalMismatchAfter = 0 | ✅ (0) |
| recordCount inchangé | ✅ |
| resolvedCount inchangé | ✅ |
| assignedCount inchangé | ✅ |
| pendingCount inchangé | ✅ |
| aucun selectedExpiration vidé | ✅ |
| aucune resolution modifiée | ✅ |
| violations d'intégrité | ✅ 0 |

## Focus tickers (count total, inchangé)

| Ticker | Avant | Après |
| --- | --- | --- |
| TQQQ | 86 | 86 |
| APLD | 68 | 68 |
| HOOD | 86 | 86 |
| SOFI | 64 | 64 |
| BAC | 10 | 10 |
