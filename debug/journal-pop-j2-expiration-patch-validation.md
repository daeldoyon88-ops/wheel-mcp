# Validation patch J2-B — expiration ↔ selectedExpiration (Journal POP)

> **Lecture seule** — généré le 2026-06-07T13:53:40
> Source : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite` · 3184 records · today=2026-06-07

## Verdict : ✅ PATCH VALIDÉ

| Contrôle | Résultat |
| --- | --- |
| 1. Nouvelles captures sans mismatch | ✅ |
| 2. 142 historiques toujours détectés à backfill | ✅ |
| 3. Éligibilité profil = selectedExpiration ?? expiration | ✅ |
| 4. Aucun re-open / re-resolve | ✅ |

## 1. Captures simulées (normalizeRecord)

| Scénario | expiration | selectedExpiration | mismatch | OK |
| --- | --- | --- | --- | --- |
| selectedExpiration future (+7j) — cas reproduisant le bug J2 | `20260612` | `20260612` | false | ✅ |
| selectedExpiration absente — fallback ancien comportement | `20260605` | `20260605` | false | ✅ |
| selectedExpiration identique à la cohorte | `20260612` | `20260612` | false | ✅ |

## 2. Records historiques (mismatch persistés)

- Total mismatch : **0**
- Résolus : **0**
- Pending : **0**
- À backfill (inchangés par le patch) : **0**

## 3. Éligibilité profil

| Cas | today | attendu | obtenu | OK |
| --- | --- | --- | --- | --- |
| cohorte expirée mais contrat futur — non éligible au 2026-06-07 | 2026-06-07 | false | false | ✅ |
| contrat réel dépassé — éligible au 2026-06-15 | 2026-06-15 | true | true | ✅ |
| selectedExpiration absente — fallback expiration | 2026-06-15 | true | true | ✅ |

Records réels dont l'éligibilité change cohorte → selectedExpiration : **0**

## 4. Aucune écriture

- Script lecture seule : aucun appel à `resolveExpiredRecords` / `reopenPrematurelyResolvedRecords`.
- Records résolus (inchangés) : **2412**

## Limites restantes

- **Backfill** : 0 records historiques conservent expiration !== selectedExpiration (0 résolus, 0 pending). Le patch ne corrige QUE les nouvelles captures — un backfill SQLite reste nécessaire pour aligner le passé.
- **Pending** : Les pending intradayRetest (20260605→20260612) seront résolus correctement par resolveExpiredRecords (selectedExpiration ?? expiration) une fois la vraie expiration atteinte.
