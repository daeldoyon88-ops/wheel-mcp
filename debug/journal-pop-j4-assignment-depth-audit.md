# Audit J4-A — Profondeur d'assignation (Journal POP)

> **Lecture seule** — généré le 2026-06-07T14:20:18 · 3184 records · 334 assignations analysées
> Source : `C:\Users\melan\Desktop\wheel-mcp-remote\data\wheelValidationJournal.sqlite`

## Verdict global

**334 assignations analysées (hors retests intraday). 104 proches (31.1%), 118 modérées, 112 profondes, 0 indéterminées (seuils MOTEUR 1.5 %/4 %). 72 cas répondent aux critères « exploitable » (≤1 % sous strike & rendement CSP ≥0.5 %). Les assignations proches sont majoritairement exploitables pour de la vente de CC ≥ strike ; les profondes restent le vrai risque de capital bloqué.**

- Hypothèse « exploitable » : Confirmée partiellement : une grande part des assignations sont proches du strike (capital récupérable via CC), donc « assigné » n'équivaut pas à « perdant ».
- Réserve principale : Incohérence de dénominateur (Q7) entre niveau profil (/assignations) et DTE-breakdown (/observations) ; seuils moteur (1.5/4) ≠ proposés (1/3).

## Définitions utilisées

**Moteur (autorité — `classifyAssignmentDepth`) :**

- Formule : `(close - strike) / strike * 100` (négatif pour une assignation).
- `proche` : −1.5 % à 0 % · `modérée` : −4 % à −1.5 % · `profonde` : < −4 % · `indéterminée` : close/strike manquant.

**Proposée utilisateur (comparaison seulement) :**

- Formule : `(strike - close) / strike * 100` (positif pour une assignation).
- `proche` : 0–1 % · `modérée` : >1–3 % · `profonde` : >3 %.

> Le moteur applique 1.5 % / 4 % (signe négatif). L'utilisateur propose 1 % / 3 % (signe positif). Distribution principale = MOTEUR (autorité). La table « proposée » est fournie pour comparaison uniquement, sans rien changer.

## 1. Totaux d'assignations

- Assignations brutes : **463** · hors retests intraday : **334** (exclues : 129)
- Modes : SAFE **142** · AGRESSIF **192** · AUTRE **0**
- Expirations distinctes touchées par une assignation : **4**

### Par ticker (Top 15)

| Ticker | Assignations |
| --- | --- |
| SLV | 14 |
| GDX | 13 |
| BMNR | 13 |
| PINS | 13 |
| AAL | 11 |
| UBER | 10 |
| XYZ | 9 |
| TEM | 9 |
| SMCI | 8 |
| IONQ | 7 |
| CDE | 7 |
| PAAS | 7 |
| TTD | 6 |
| TQQQ | 6 |
| SOFI | 6 |

### Par DTE

| DTE | Assignations |
| --- | --- |
| 1 | 3 |
| 2 | 11 |
| 3 | 43 |
| 4 | 88 |
| 5 | 8 |
| 7 | 115 |
| 8 | 32 |
| 9 | 16 |
| 10 | 11 |
| 14 | 7 |

### Par expiration (Top 12)

| Expiration | Assignations |
| --- | --- |
| 20260605 | 148 |
| 20260515 | 115 |
| 20260522 | 50 |
| 20260529 | 21 |

## 2. Distribution proche / modérée / profonde

| Classification | Proche | Modérée | Profonde | Indéterminée | Total |
| --- | --- | --- | --- | --- | --- |
| MOTEUR (1.5/4 %) | 104 (31.1%) | 118 (35.3%) | 112 (33.5%) | 0 (0%) | 334 |
| PROPOSÉE (1/3 %) | 72 (21.6%) | 111 (33.2%) | 151 (45.2%) | 0 (0%) | 334 |

## 3. Tickers focus

| Ticker | n résolus | n assignés | % assign. | proches | modérées | profondes | indét. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TQQQ | 52 | 6 | 11.5% | 0 | 1 | 5 | 0 |
| APLD | 38 | 3 | 7.9% | 0 | 1 | 2 | 0 |
| HOOD | 52 | 3 | 5.8% | 0 | 3 | 0 | 0 |
| SOFI | 36 | 6 | 16.7% | 0 | 1 | 5 | 0 |
| BAC | 8 | 2 | 25% | 2 | 0 | 0 | 0 |
| CCL | 40 | 4 | 10% | 4 | 0 | 0 | 0 |
| HIMS | 32 | 0 | 0% | 0 | 0 | 0 | 0 |

### TQQQ — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260605 | SAFE | 7 | 76 | 73.05 | -3.88 | moderee | 3.88 | 0.62 |
| 20260605 | SAFE | 4 | 78 | 73.05 | -6.35 | profonde | 6.35 | 0.58 |
| 20260605 | SAFE | 3 | 79 | 73.05 | -7.53 | profonde | 7.53 | 0.58 |
| 20260605 | AGGRESSIVE | 7 | 79 | 73.05 | -7.53 | profonde | 7.53 | 1.1 |

### APLD — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260605 | SAFE | 4 | 40.5 | 39.62 | -2.17 | moderee | 2.17 | 0.59 |
| 20260605 | AGGRESSIVE | 7 | 41.5 | 39.62 | -4.53 | profonde | 4.53 | 1.54 |
| 20260605 | AGGRESSIVE | 4 | 43 | 39.62 | -7.86 | profonde | 7.86 | 1.3 |

### HOOD — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260522 | AGGRESSIVE | 8 | 75 | 73.64 | -1.81 | moderee | 1.81 | 1.13 |
| 20260605 | AGGRESSIVE | 4 | 84 | 82.47 | -1.82 | moderee | 1.82 | 1.02 |
| 20260605 | AGGRESSIVE | 7 | 84 | 82.47 | -1.82 | moderee | 1.82 | 1.07 |

### SOFI — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260605 | SAFE | 7 | 16.5 | 16.03 | -2.85 | moderee | 2.85 | 0.55 |
| 20260605 | SAFE | 3 | 17 | 16.03 | -5.71 | profonde | 5.71 | 0.82 |
| 20260605 | AGGRESSIVE | 3 | 17 | 16.03 | -5.71 | profonde | 5.71 | 0.82 |
| 20260605 | SAFE | 4 | 17 | 16.03 | -5.71 | profonde | 5.71 | 0.53 |

### BAC — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260515 | SAFE | 7 | 50 | 49.77 | -0.46 | proche | 0.46 | 0.54 |
| 20260515 | AGGRESSIVE | 7 | 50 | 49.77 | -0.46 | proche | 0.46 | 0.54 |

### CCL — exemples (plus proches d'abord)

| Expiration | Mode | DTE | Strike | Close | Prof.% moteur | Classe | Prof.% proposée | Rend. CSP% |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20260515 | AGGRESSIVE | 7 | 25 | 24.64 | -1.44 | proche | 1.44 | 1.16 |
| 20260515 | AGGRESSIVE | 7 | 25 | 24.64 | -1.44 | proche | 1.44 | 1.08 |
| 20260515 | AGGRESSIVE | 7 | 25 | 24.64 | -1.44 | proche | 1.44 | 0.96 |
| 20260515 | AGGRESSIVE | 8 | 25 | 24.64 | -1.44 | proche | 1.44 | 1 |

## 4. Meilleurs cas — assignations proches exploitables

Critères : profondeur proposée ≤ 1 %, rendement CSP ≥ 0.5 %. **72** cas trouvés.

| Ticker | Exp. | selExp | Mode | DTE | Strike | Close | Prof.% | Rend.CSP% | n résolus tk | scanSession | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IREN | 20260515 | 20260515 | AGGRESSIVE | 7 | 53 | 52.94 | 0.11 | 2.08 | 20 | 20260508_1 | proche |
| IREN | 20260515 | 20260515 | AGGRESSIVE | 5 | 53 | 52.94 | 0.11 | 1.6 | 20 | 20260510_0 | proche |
| IONQ | 20260515 | 20260515 | AGGRESSIVE | 3 | 52 | 51.95 | 0.1 | 1.5 | 32 | 20260512_1 | proche |
| IONQ | 20260515 | 20260515 | AGGRESSIVE | 2 | 52 | 51.95 | 0.1 | 1.19 | 32 | 20260513_1 | proche |
| PAAS | 20260522 | 20260522 | AGGRESSIVE | 14 | 54 | 53.94 | 0.11 | 1.2 | 10 | 20260508_1 | proche |
| CVNA | 20260522 | 20260522 | AGGRESSIVE | 10 | 68.5 | 68.28 | 0.32 | 1.33 | 14 | 20260512_1 | proche |
| FCX | 20260522 | 20260522 | AGGRESSIVE | 8 | 62 | 61.99 | 0.02 | 0.97 | 18 | 20260514_1 | proche |
| RIOT | 20260515 | 20260515 | AGGRESSIVE | 2 | 23.5 | 23.49 | 0.04 | 0.89 | 22 | 20260513_1 | proche |
| AAL | 20260605 | 20260605 | SAFE | 4 | 13.5 | 13.5 | 0 | 0.81 | 38 | 20260601_1 | proche |
| AAL | 20260605 | 20260605 | AGGRESSIVE | 4 | 13.5 | 13.5 | 0 | 0.81 | 38 | 20260601_1 | proche |
| FCX | 20260522 | 20260522 | SAFE | 9 | 62 | 61.99 | 0.02 | 0.82 | 18 | 20260513_1 | proche |
| FCX | 20260522 | 20260522 | AGGRESSIVE | 9 | 62 | 61.99 | 0.02 | 0.82 | 18 | 20260513_1 | proche |
| EXPE | 20260522 | 20260522 | AGGRESSIVE | 1 | 215 | 214.65 | 0.16 | 0.95 | 2 | 20260521_0 | proche |
| IBIT | 20260522 | 20260522 | AGGRESSIVE | 9 | 43 | 42.96 | 0.09 | 0.86 | 16 | 20260513_1 | proche |
| NVO | 20260522 | 20260522 | AGGRESSIVE | 9 | 45 | 44.96 | 0.09 | 0.8 | 16 | 20260513_1 | proche |
| BMNR | 20260522 | 20260522 | AGGRESSIVE | 14 | 19 | 18.88 | 0.63 | 1.32 | 24 | 20260508_1 | proche |
| TEM | 20260515 | 20260515 | AGGRESSIVE | 7 | 44 | 43.93 | 0.16 | 0.77 | 12 | 20260508_1 | proche |
| IGV | 20260605 | 20260605 | AGGRESSIVE | 7 | 96 | 95.85 | 0.16 | 0.73 | 20 | 20260529_1 | proche |
| TEM | 20260515 | 20260515 | SAFE | 7 | 44 | 43.93 | 0.16 | 0.68 | 12 | 20260508_1 | proche |
| TEM | 20260515 | 20260515 | SAFE | 7 | 44 | 43.93 | 0.16 | 0.68 | 12 | 20260508_1 | proche |
| B | 20260605 | 20260605 | SAFE | 4 | 39.5 | 39.46 | 0.1 | 0.61 | 6 | 20260601_1 | proche |
| B | 20260605 | 20260605 | AGGRESSIVE | 4 | 39.5 | 39.46 | 0.1 | 0.61 | 6 | 20260601_1 | proche |
| TTD | 20260605 | 20260605 | SAFE | 3 | 20 | 19.95 | 0.25 | 0.75 | 16 | 20260602_0 | proche |
| TTD | 20260605 | 20260605 | SAFE | 7 | 20 | 19.95 | 0.25 | 0.75 | 16 | 20260529_1 | proche |
| TTD | 20260605 | 20260605 | AGGRESSIVE | 7 | 20 | 19.95 | 0.25 | 0.75 | 16 | 20260529_1 | proche |

## 5. Pires cas — assignations profondes risquées

Critère : profondeur proposée > 3 %. **151** cas.

| Ticker | Exp. | Mode | DTE | Strike | Close | Prof.% | Rend.CSP% | Rend.−Perte | n résolus tk | Classe |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MSTR | 20260605 | AGGRESSIVE | 7 | 146 | 120.44 | 17.51 | 1.07 | -16.44 | 12 | profonde |
| MSTR | 20260605 | SAFE | 7 | 141 | 120.44 | 14.58 | 0.59 | -13.99 | 12 | profonde |
| JOBY | 20260605 | AGGRESSIVE | 4 | 11 | 9.55 | 13.18 | 1.09 | -12.09 | 4 | profonde |
| UUUU | 20260605 | AGGRESSIVE | 4 | 17 | 15.03 | 11.59 | 1.06 | -10.53 | 6 | profonde |
| CDE | 20260605 | AGGRESSIVE | 3 | 18.5 | 16.37 | 11.51 | 1.35 | -10.16 | 18 | profonde |
| FIG | 20260605 | AGGRESSIVE | 4 | 24.5 | 21.75 | 11.22 | 1.18 | -10.04 | 4 | profonde |
| AG | 20260605 | AGGRESSIVE | 4 | 19 | 16.99 | 10.58 | 1 | -9.58 | 6 | profonde |
| SLV | 20260515 | SAFE | 2 | 77 | 69.04 | 10.34 | 0.57 | -9.77 | 30 | profonde |
| SLV | 20260515 | AGGRESSIVE | 2 | 77 | 69.04 | 10.34 | 0.57 | -9.77 | 30 | profonde |
| NOW | 20260605 | AGGRESSIVE | 4 | 125 | 112.45 | 10.04 | 1.08 | -8.96 | 22 | profonde |
| IONQ | 20260605 | AGGRESSIVE | 3 | 63 | 56.78 | 9.87 | 0.76 | -9.11 | 32 | profonde |
| IONQ | 20260605 | AGGRESSIVE | 4 | 63 | 56.78 | 9.87 | 1.4 | -8.47 | 32 | profonde |
| TQQQ | 20260605 | AGGRESSIVE | 3 | 81 | 73.05 | 9.81 | 0.91 | -8.9 | 52 | profonde |
| PLTR | 20260605 | AGGRESSIVE | 4 | 150 | 135.53 | 9.65 | 0.85 | -8.8 | 10 | profonde |
| FIG | 20260605 | SAFE | 4 | 24 | 21.75 | 9.38 | 0.83 | -8.55 | 4 | profonde |
| AFRM | 20260605 | AGGRESSIVE | 4 | 70 | 63.61 | 9.13 | 0.74 | -8.39 | 30 | profonde |
| CDE | 20260605 | SAFE | 3 | 18 | 16.37 | 9.06 | 0.83 | -8.23 | 18 | profonde |
| JOBY | 20260605 | SAFE | 4 | 10.5 | 9.55 | 9.05 | 0.57 | -8.48 | 4 | profonde |
| JOBY | 20260605 | SAFE | 7 | 10.5 | 9.55 | 9.05 | 0.95 | -8.1 | 4 | profonde |
| JOBY | 20260605 | AGGRESSIVE | 7 | 10.5 | 9.55 | 9.05 | 0.95 | -8.1 | 4 | profonde |

## 6. Audit du code existant (profondeur)

| Élément | Fichier | Ligne ~ | Rôle / dénominateur |
| --- | --- | --- | --- |
| classifyAssignmentDepth | app/journal/wheelValidationService.js | 1920 | (closeExpiration - strike) / strike * 100  (NÉGATIF pour une assignation) ; seuils 1.5 %/4 % |
| summarizeAssignmentDepthCounts | app/journal/wheelValidationService.js | 1975 | compte proche/moderee/profonde/nd |
| summarizeOnePercentAssignmentMetrics | app/journal/wheelValidationService.js | 2240 | procheRatePct/profondeRatePct = **/assignations** |
| DTE-breakdown (near/deepAssignmentRate) | wheel-dashboard/src/components/JournalPopPanel.jsx | 2806, 3035, 3043 | near/deepAssignmentRate = **/observations** ⚠ |
| formatAssignmentDepthCell | wheel-dashboard/src/components/JournalPopPanel.jsx | 2463 | affiche /assignations en priorité, repli /observations |
| Légende UI | wheel-dashboard/src/components/JournalPopPanel.jsx | 2398 | « profondes / assignations » |
| verdict « assignation exploitable » (existant) | app/journal/wheelValidationService.js (+ JournalPopPanel.jsx) | 2336, 5125 | verdict + filtre UI déjà présents |

## 7. UI « proche/profonde [% assign.] » — dénominateur réel

- **Niveau profil** : proches/assignations & profondes/assignations (CORRECT vs légende).
- **Niveau DTE-breakdown** : nearAssignmentRate/deepAssignmentRate = /observations (NON conforme à la légende).
- **Verdict** : Au niveau PROFIL la colonne respecte « / assignations ». Au niveau DTE-breakdown les taux sont calculés « / observations ». formatAssignmentDepthCell privilégie le profil mais peut retomber sur la valeur /observations → libellé « % assign. » potentiellement trompeur dans le repli.

## 8. Recommandations J4-B

### 1. Critique
- **reconcile-denominator** — Aligner le dénominateur de nearAssignmentRate/deepAssignmentRate (DTE-breakdown, /observations) avec la légende et le niveau profil (/assignations), OU renommer explicitement chaque taux selon son dénominateur. Risque actuel : la colonne « % assign. » affiche tantôt /assignations tantôt /observations.

### 2. Important
- **threshold-reconciliation** — Décider d'un seuil unique. Le moteur utilise 1.5 % / 4 % (proche/modérée/profonde) ; l'utilisateur propose 1 % / 3 %. Si la définition Wheel « exploitable » est ≤ 1 %, ajuster le seuil PROCHE du moteur à 1 % (patch moteur dédié, hors J4-A) ou documenter l'écart dans l'UI.
- **exploitable-metric** — Formaliser une métrique « assignation exploitable » = (profondeur ≤ seuil proche) ∧ (rendement CSP ≥ 0.5 %) ∧ (CC vendable ≥ strike). Le verdict « assignation exploitable » existe déjà (service ~2336, filtre UI ~5125) mais n'intègre pas le rendement CSP ni la contrainte CC ≥ strike.

### 3. UI seulement
- **depth-fraction-display** — Afficher systématiquement la fraction X/Y à côté des % (proches X/assignations Y, profondes X/assignations Y) pour lever l'ambiguïté du dénominateur.
- **exploitable-badge** — Ajouter un badge « proche exploitable » sur les lignes assignées proches avec rendement CSP ≥ 0.5 %, distinct du badge « profonde ».

### 4. Future CC post-assignation
- **cc-yield-after-assignment** — Brancher l'audit sur les cycles CC post-assignation (return_on_assignment_pct, prime CC, recovery au strike) pour mesurer le rendement RÉELLEMENT capturé après une assignation proche — boucle Wheel complète CSP → assignation proche → CC ≥ strike.
- **cc-floor-rule** — Encoder la règle « CC jamais sous le prix d'assignation » et « rendement/prime CC ≥ 0.5 % » comme garde-fou dans la future recommandation CC post-assignation.
