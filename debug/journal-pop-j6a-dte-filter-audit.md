# Audit J6-A — Filtre DTE réel du Top réaliste (IONQ)

> Généré le 2026-06-10T19:21:21 · 3184 records · source : C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite

## Cohérence

- Vue `all` meta.dteFilter : null
- Vue `all` == Top réaliste global (sans filtre) : oui
- Top réaliste / horizon : Tous=16 · 7 DTE=0 · 4 DTE=0 · 3 DTE=0

## IONQ par horizon DTE

| DTE | Bucket | Top réaliste ? | Score | selTrades | Rend. réel % | Assign. réelle % | Profonde réelle % | n | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tous DTE | À valider | non | 16 | 5 | 1.43 | 0 | — | 32 | hors Top réaliste — bucket « À valider » |
| 7 DTE | Proches d'entrer | non | 76 | 4 | 1.35 | 0 | — | 12 | hors Top réaliste — échantillon décision réelle insuffisant (<3 décisions ou <15 observations) |
| 4 DTE | Échantillons insuffisants | non | 0 | 1 | 1.4 | 100 | 100 | 2 | échantillon insuffisant à cet horizon |
| 3 DTE | Échantillons insuffisants | non | 0 | 2 | 0.65 | 50 | 100 | 4 | échantillon insuffisant à cet horizon |

## Effet du DTE

- Le risque IONQ dépend du DTE : non (même statut sur tous les horizons disponibles)
- Acceptables en 7 DTE mais PAS en 3 DTE : —
- Acceptables en 3 DTE mais PAS en 7 DTE : —

Lecture : chaque vue est un recalcul complet (decisionMetrics, rendement réel, assignation réelle, score, garde-fous) sur les seules observations de l'horizon DTE. Le filtre est appliqué AVANT le scoring, pas après.
