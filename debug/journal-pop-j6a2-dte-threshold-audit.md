# Audit J6-A2 — Seuils du Top réaliste adaptés aux vues DTE

> Généré le 2026-06-11T15:10:12 · 3290 records · source : C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite

## Cohérence (vue Tous DTE inchangée)

- Vue `all` meta.dteFilter : null
- Vue `all` == Top réaliste global (sans filtre) : oui
- Vue `all` contient un bucket dte_confirm : non
- Top réaliste « Tous DTE » : 16 profils

## Avant / Après par horizon DTE

| DTE | Top AVANT | Top APRÈS | Proches AVANT | Proches APRÈS | Promus (dte_confirm) |
| --- | --- | --- | --- | --- | --- |
| 7 DTE | 0 | 13 | 23 | 10 | APA, APLD, BNO, CCL, DAL, DOCU, FCX, HOOD, IGV, IONQ, NOK, SMCI, TQQQ |
| 4 DTE | 0 | 2 | 2 | 0 | DAL, HOOD |
| 3 DTE | 0 | 3 | 8 | 5 | HIMS, HOOD, INTC |

## IONQ par horizon DTE

| DTE | Bucket | Top ? | Realistic bucket | Score | selTrades | Rend. réel % | Assign. % | Profonde % | n | Promu DTE ? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 DTE | Top réaliste | oui | dte_confirm | 76 | 4 | 1.35 | 0 | — | 12 | oui |
| 4 DTE | Échantillons insuffisants | non | rejected | 0 | 1 | 1.4 | 100 | 100 | 2 | non |
| 3 DTE | Échantillons insuffisants | non | rejected | 0 | 2 | 0.65 | 50 | 100 | 4 | non |

## APLD par horizon DTE

| DTE | Bucket | Top ? | Realistic bucket | Score | selTrades | Rend. réel % | Assign. % | Profonde % | n | Promu DTE ? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 DTE | Top réaliste | oui | dte_confirm | 76 | 4 | 1.36 | 0 | — | 12 | oui |
| 4 DTE | À valider | non | dte_confirm | 0 | 3 | 1.52 | 33.3 | 0 | 6 | non |
| 3 DTE | Proches d'entrer | non | rejected | 56 | 2 | 1.39 | 0 | — | 6 | non |

## TQQQ par horizon DTE

| DTE | Bucket | Top ? | Realistic bucket | Score | selTrades | Rend. réel % | Assign. % | Profonde % | n | Promu DTE ? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 DTE | Top réaliste | oui | dte_confirm | 53 | 4 | 1.06 | 25 | 0 | 12 | oui |
| 4 DTE | À valider | non | rejected | 0 | 3 | 0.94 | 33.3 | 100 | 6 | non |
| 3 DTE | Proches d'entrer | non | rejected | 26 | 3 | 1.09 | 33.3 | 100 | 10 | non |

## HOOD par horizon DTE

| DTE | Bucket | Top ? | Realistic bucket | Score | selTrades | Rend. réel % | Assign. % | Profonde % | n | Promu DTE ? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 DTE | Top réaliste | oui | dte_confirm | 71 | 4 | 0.84 | 0 | — | 12 | oui |
| 4 DTE | Top réaliste | oui | dte_confirm | 56 | 3 | 0.78 | 0 | — | 6 | oui |
| 3 DTE | Top réaliste | oui | dte_confirm | 66 | 4 | 0.88 | 0 | — | 12 | oui |

Lecture : « AVANT » = seuil strict global (strict ≥5 décisions, confirm 3–4 décisions seulement si observations≥15). « APRÈS » = seuil DTE adapté (dte_confirm : 3–4 décisions + garde-fous qualité OK + score ≥35, plancher observationnel abaissé à n≥5 sur l'horizon, sans exiger observations≥15). Les profils dangereux (rendement <0,5 %, profondeur >50 %) ou à échantillon insuffisant (<3 décisions, n<5 obs sur l'horizon) restent exclus.
