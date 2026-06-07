# Backfill J2-C — expiration = selectedExpiration (DRY-RUN)

> **Aucune mutation** — généré le 2026-06-07T13:53:12
> DB : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite` · 3184 records

## Résumé

| Métrique | Valeur |
| --- | --- |
| totalMismatch | **142** (attendu 142) |
| Conforme à l'attendu | ✅ oui |
| resolvedMismatch | 84 |
| pendingMismatch | 58 |
| Tickers affectés | 57 |

## Distribution par ticker

- TQQQ : 4
- PATH : 4
- NOK : 4
- HOOD : 4
- GDX : 4
- CSCO : 4
- CCL : 4
- APLD : 4
- XYZ : 4
- PINS : 4
- IONQ : 4
- HPQ : 4
- HPE : 4
- AAL : 4
- W : 2
- TTD : 2
- TEAM : 2
- SOFI : 2
- RKT : 2
- RIVN : 2
- PLTR : 2
- OWL : 2
- NCLH : 2
- MDT : 2
- INTC : 2
- HIMS : 2
- F : 2
- DOCU : 2
- DG : 2
- CRWV : 2
- CPNG : 2
- CMCSA : 2
- CDE : 2
- AG : 2
- ABNB : 2
- U : 2
- SMCI : 2
- SLV : 2
- PAAS : 2
- NOW : 2
- MRNA : 2
- MP : 2
- IREN : 2
- DAL : 2
- CZR : 2
- CIFR : 2
- BMNR : 2
- RIOT : 2
- NVO : 2
- MGM : 2
- IGV : 2
- GM : 2
- FLY : 2
- FISV : 2
- ETSY : 2
- BNO : 2
- BITO : 2

## Distribution par captureClass

- primaryDaily : 84
- intradayRetest : 58

## Distribution par scanDate

- 2026-05-08 : 84
- 2026-05-29 : 58

## Exemples focus

### TQQQ (4)
- `20260605` → `20260612` · safe · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260605` → `20260612` · aggressive · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260515` → `20260522` · safe · scan 2026-05-08 · primaryDaily · résolu=true assigné=false
- `20260515` → `20260522` · aggressive · scan 2026-05-08 · primaryDaily · résolu=true assigné=false

### APLD (4)
- `20260605` → `20260612` · safe · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260605` → `20260612` · aggressive · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260515` → `20260522` · safe · scan 2026-05-08 · primaryDaily · résolu=true assigné=false
- `20260515` → `20260522` · aggressive · scan 2026-05-08 · primaryDaily · résolu=true assigné=false

### HOOD (4)
- `20260605` → `20260612` · safe · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260605` → `20260612` · aggressive · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260515` → `20260522` · safe · scan 2026-05-08 · primaryDaily · résolu=true assigné=false
- `20260515` → `20260522` · aggressive · scan 2026-05-08 · primaryDaily · résolu=true assigné=false

### SOFI (2)
- `20260605` → `20260612` · safe · scan 2026-05-29 · intradayRetest · résolu=false assigné=null
- `20260605` → `20260612` · aggressive · scan 2026-05-29 · intradayRetest · résolu=false assigné=null

### BAC (0)
- _aucun_

## Mutation planifiée (NON appliquée)

- SET expiration = selectedExpiration (colonne + rawJson) sur les records ciblés
- Ne touche pas : selectedExpiration, resolution, assigned, resolved, strike, premium, annualizedYield, popEstimate, dteAtScan, strikeMode, scanSessionId, expirationCohort, schéma DB
