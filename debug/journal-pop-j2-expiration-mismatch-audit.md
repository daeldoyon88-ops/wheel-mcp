# Audit J2 — expiration ≠ selectedExpiration (Journal POP)

> **Lecture seule** — généré le 2026-06-07T13:53:40
> Source : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite` · 3184 records

## Verdict global

**Aucune incohérence détectée**

- Résolution actuelle : **resolveExpiredRecords utilise selectedExpiration (corrigé) — confirmé par notes de résolution**
- Éligibilité profil / Top 20 : **isOnePercentProfileRecord utilise expiration (cohorte) — INCOHÉRENT, métriques éligibles 7j trop tôt**
- Réconciliation J1 : J1 comptait 84 = mismatch dans l'échantillon profil. Total brut = 0 (0 résolus primaryDaily + 0 pending intradayRetest).

## Distribution

| Métrique | Valeur |
| --- | --- |
| Records incohérents (total) | **0** |
| Dans échantillon profil (J1) | **0** |
| Résolus | **0** |
| Pending | **0** |
| Assignés (résolus) | **0** |
| Non assignés (résolus) | **0** |
| Tickers affectés | **0** |
| Résolus via selectedExpiration (notes) | **0** / 0 |
| Contre-facteur : assign. différente si cohorte utilisée | **0** / 0 |
| Catastrophes évitées (stocké = selected, ≠ cohorte) | **0** |
| Fausses assignations actuelles vs selected | **0** |
| Pending intradayRetest (2026-05-29) | **0** |

### Par expiration (cohorte)


### Par selectedExpiration (contrat réel)


### Par mode


### Par scanDate


## Quel champ est utilisé où ?

| Étape | Champ utilisé | Constant ? |
| --- | --- | --- |
| **Création record** (`normalizeRecord`) | `expiration` ← candidate.expiration ; `selectedExpiration` ← options UI | Non — source divergente |
| **Résolution** (`resolveExpiredRecords`) | `selectedExpiration ?? expiration` | Oui (corrigé) |
| **Profil / n Top 20** (`isOnePercentProfileRecord`) | `expiration ?? expirationCohort` | Non — utilise cohorte |
| **Risque événement / DTE UI** | `selectedExpiration ?? expiration` | Oui |
| **Groupement cohortes** | `expirationCohort` / `expiration` | Oui |

## Cause probable

À la capture, normalizeRecord écrit expiration depuis candidate.expiration (souvent cohorte/scanner) alors que selectedExpiration vient du picker UI (+7j). Pas un bug de résolution récent — propagation incohérente à la création.

Lots identifiés :
- **2026-05-08** : 84 records (20260508→20260515 et 20260515→20260522) — résolus
- **2026-05-29** : 58 records (20260605→20260612) — pending (contrat pas encore expiré au 2026-06-07)

## Impact assignation (index closes journal)

Règle CSP : `assigned = close ≤ strike`. Closes indexés depuis `resolution.notes` des records résolus du journal.

**Constat : 0/0 résolus ont utilisé selectedExpiration** (confirmé par notes auto_resolved_from_yahoo_close_YYYY-MM-DD).

Aucune différence contre-facteur détectée.

## Impact tickers focus (Top 20 / Objectif 1%+)

| Ticker | Mismatch | Résolus | Pending | Dans profil | Assign. changeraient | Top 20 | Verdict 1%+ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 0 | 0 | 0 | 0 | 0 | #13 | 1 % stressé |
| APLD | 0 | 0 | 0 | 0 | 0 | #11 | 1 % stressé |
| HOOD | 0 | 0 | 0 | 0 | 0 | #1 | 1 % défendable |
| SOFI | 0 | 0 | 0 | 0 | 0 | — | assignation défavorable |
| BAC | 0 | 0 | 0 | 0 | 0 | — | très préliminaire |

## Exemples concrets


## Recommandation de correction

**Option recommandée : Combinaison C + D + backfill expiration (A allégé) — pas de re-résolution urgente pour les 84**

1) Patch capture (normalizeRecord) · 2) Patch éligibilité profil (isOnePercentProfileRecord) · 3) Backfill expiration sur 142 records · 4) Warning UI · 5) Surveiller les 58 pending intradayRetest

### Patch proposé (NON appliqué)

- **Fichier** : `app/journal/wheelValidationService.js`
- **Fonction** : `normalizeRecord`
- **Changement** : Si options.selectedExpiration est fourni : expiration = selectedExpiration (synchroniser les deux champs à la capture).

### Options évaluées

- **A_correctHistoricalRecords** : Backfill expiration = selectedExpiration sur les 142 records (données). Re-résolution NON requise pour les 84 déjà résolus sur selectedExpiration.
- **B_excludeFromMetrics** : Exclure les mismatch selected_future des métriques jusqu'à backfill — utile seulement si patch C retardé.
- **C_fixResolutionLogic** : Aligner isOnePercentProfileRecord + normalizeRecord sur selectedExpiration ?? expiration.
- **D_uiWarning** : Badge « expiration≠selected » dans Journal POP pour les lignes concernées.

### Risques si on ne corrige pas
- 0 records avec champ expiration obsolète (cohorte -7j)
- 0 assignations auraient été fausses si resolveExpiredRecords utilisait expiration au lieu de selectedExpiration
- Éligibilité profil basée sur cohorte → métriques comptées 7j trop tôt
- 58 pending intradayRetest (20260605→20260612) — risque si résolution future ignore selectedExpiration
- 3 tickers focus dans Top 20 portent des n incluant ces records

## Liste complète des records incohérents

Total : **0** lignes (voir JSON `mismatchRecords` pour le détail complet).

<details><summary>Aperçu (20 premiers)</summary>

| id | ticker | mode | DTE | scanDate | expiration | selectedExp | résolu | assigné |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

</details>