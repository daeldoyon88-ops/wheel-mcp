# Validation — rafraîchissement harness Fable (post AF-01 → AF-18)

Date : 2026-07-12  
HEAD : `c18b744 fix UI capital combos mode metadata inspector parity and labels`  
Portée : harness Fable uniquement — **aucun moteur / UI modifié**.

## 1. État Git initial

| Contrôle | Résultat |
|----------|----------|
| HEAD | `c18b744` |
| Branche | `main...origin/main` |
| `git diff --name-only` | vide |
| `git diff --cached --name-only` | vide |
| Verdict | **SAFE TO UPDATE FABLE** |

Harness Fable : **untracked** (`debug/capital-combinations-audit-fable/`).

## 2. Baseline Fable

```text
node debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs
```

| Métrique | Valeur |
|----------|--------|
| PASS | 28 |
| FAIL | 10 |
| INFO | 5 |
| checks | 43 |

FAIL : T1a, T1g, T3a, T4a, T6a, T7a, T9a, T15a, T15b, T15c.

## 3–4. Matrice des 10 FAIL + classification

| ID | Ancienne hypothèse | Obtenu | AF | Commit | Classification |
|----|-------------------|--------|-----|--------|----------------|
| T1a | spreadPct = 4.3 (liquidity) | 4.255… (bid/ask) | AF-11 | b6bf608 | **CHECK OBSOLÈTE** |
| T1g | metadata absente | metadata présente | AF-15/01 | 932cc9d / c18b744 | **CHECK OBSOLÈTE** |
| T3a | grade SOURCE flippe gagnant | AAPL / AAPL stable | AF-04/05 | 6799766 | **CHECK OBSOLÈTE** |
| T4a | ordre entrée flippe gagnant | AAPL / AAPL | AF-05 | 6799766 | **CHECK OBSOLÈTE** |
| T6a | AGG hors bande exclut SAFE | SAFE retenue | AF-07 | 3509ef3 | **CHECK OBSOLÈTE** |
| T7a | spread négatif accepté | pick absent | AF-11 | b6bf608 | **CHECK OBSOLÈTE** |
| T9a | freeCapital = brut − used | usable − used | AF-09 | bafc9f7 | **CHECK OBSOLÈTE** |
| T15a | POP null → WATCH | A / A | AF-02 | 92444e4 | **CHECK OBSOLÈTE** |
| T15b | POP null → exclu SAFE | pick A, pop null | AF-02/03 | 92444e4 | **CHECK OBSOLÈTE** |
| T15c | POP null écrase grade A AGG | pick A | AF-02/03 | 92444e4 | **CHECK OBSOLÈTE** |

**Bugs réels trouvés : 0.**

## 5. Règles actuelles (résumé)

- AF-11 : bid/ask prioritaires ; marché croisé / spread négatif rejetés.
- AF-15 / AF-01 : pick enrichi (expiration, DTE, bid/ask/mid, selectedLegMode, bucketMode, scannerMode).
- AF-04 / AF-05 : grade de jambe + tie-break `compareCapitalComboCandidatesStable`.
- AF-07 : `resolveCompatibleLegForMode` — jambe hors bande n’empêche pas la suivante.
- AF-09 : `freeCapital = usableCapital − capitalUsed`.
- AF-02 / AF-03 : POP null non coercé en 0 ; grade jambe / stocké cohérent.

## 6. Changements par check

| ID | Avant | Après |
|----|-------|-------|
| T1a | assert spread 4.3 | assert spread bid/ask ≈ 4.255… + positif |
| T1g | assert champs absents | assert champs présents + modes SAFE/SAFE/AGGRESSIVE |
| T3a | expect flip AAPL↔MSFT | expect AAPL stable (anti-régression grade source) |
| T4a | expect flip ordre | expect AAPL stable (anti-régression ordre entrée) |
| T6a | expect CRM exclu | expect CRM+ORCL SAFE strike 40 |
| T7a | expect pick −22 % | expect absent + contrôle positif MSFT valide |
| T9a | expect brut−used | expect usable−used (= 15000) |
| T15a | expect WATCH/A | expect A/A + normalizeOptionalPopDecimal null |
| T15b | expect exclusion | expect pick A, popEstimate null |
| T15c | expect exclusion | expect pick A, popEstimate null |
| T1f | INFO « absent attendu » | INFO présence informative (AF-07) |

## 7–9. Conservés / ajoutés / supprimés

- **Conservés** : tous les IDs T1–T15 existants (format PASS/FAIL/INFO).
- **Ajoutés** : T16a–T16e (robustesse AF-05/18/17/07/02 via helpers purs).
- **Supprimés** : 0.
- **Test de garde optionnel** : non créé (`capitalComboFableContracts.test.mjs`) — couverture dans Fable.

## 10. Résultat Fable final

| | Baseline | Après |
|--|----------|-------|
| PASS | 28 | **43** |
| FAIL | 10 | **0** |
| INFO | 5 | **5** |
| checks | 43 | **48** |

Nouveaux FAIL : **aucun**.

## 11–13. Non-régressions

| Suite | Résultat |
|-------|----------|
| 18 suites Capital Combinations | **417 / 417 PASS** |
| Backend free-capital | **5 / 5 PASS** |
| `npm run build` (Vite) | **PASS** |

Fichiers moteur / UI : **aucun modifié**.

## 14. Bugs réels découverts

Aucun.

## 15. Couverture avant / après

| Contrat | Avant | Après |
|---------|-------|-------|
| Spread négatif / croisé | T7a (hypothèse bug) | T7a anti-régression + positif |
| Grade / POP null | T15* (hypothèse bug) | T15* + T16e |
| Tie-break | T3a/T4a (hypothèse bug) | T3a/T4a + T16a |
| Fallback BALANCED | T6a (hypothèse bug) | T6a + T16d |
| freeCapital | T9a (hypothèse bug) | T9a formule AF-09 |
| Metadata | T1g (hypothèse absence) | T1g présence |
| AF-17 | partiel INFO T12e | **T16c** |
| AF-18 | absent Fable | **T16b** |

Couverture nette : **équivalente ou meilleure** (10 FAIL → anti-régressions + 5 gardes helpers).

## 16. Limitations

1. Checks PASS historiques « DÉFAUT CONFIRMÉ » (T1d, T2b, T8a, T10a) non retargetés (hors lot FAIL).
2. AF-06 (pool canonique) documenté via unitaires, pas rejoué dans Fable.
3. Harness / rapports restent untracked sous `debug/`.

## 17–18. Fichiers

**Modifié :**

- `debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs`

**Créés :**

- `debug/capital-combinations-fable-refresh-validation/capital-combinations-fable-refresh-validation.md`
- `debug/capital-combinations-fable-refresh-validation/capital-combinations-fable-refresh-validation.json`

## 19–22. Git

- `git diff --name-only` (suivis) : vide
- `git diff --cached` : vide
- **aucun git add / commit / push**

## 23. Verdict

**FABLE REFRESH APPLIED — SAFE TO COMMIT**

Message recommandé :

```text
refresh Fable harness assertions for AF-01 to AF-18 current rules
```

Prochaine étape : commit explicite du dossier harness (+ rapports) quand Daël le demande.
