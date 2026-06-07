# Validation J3 — Libellés UI / lisibilité Journal POP

> **UI seulement** — généré le 2026-06-07 · aucun changement de formule, de score, de verdict, ni de backend.
> Portée : `wheel-dashboard/src/components/JournalPopPanel.jsx` (présentation uniquement).

## Verdict

**OK — clarté des compteurs améliorée sans toucher aux calculs.** Les en-têtes, tooltips et une
légende repliable lèvent les ambiguïtés signalées par l'audit J1 (n global vs n DTE cible,
% profondes / assignations, SAFE + AGRESSIF additionnés, observations normalisées vs records bruts).

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Libellés, tooltips, légende compacte (affichage seulement) |

## Fichiers créés

| Fichier | Nature |
| --- | --- |
| `debug/journal-pop-j3-ui-labels-validation.md` | Ce rapport |
| `debug/journal-pop-j3-ui-labels-validation.json` | Rapport machine |

## Libellés / sections touchés

| # | Problème audit | Correctif UI | Emplacement |
| --- | --- | --- | --- |
| 1 | « n » du Top 20 ambigu | En-tête `n` → **`n global`** + tooltip `N_GLOBAL_TOOLTIP` (records résolus, SAFE+AGRESSIF, tous DTE ; ≠ expirations distinctes / scans / obs normalisées) | Tableau « Top 20 expérimental » |
| 2 | DTE mélangés | Modal DTE : en-tête `n` → **`n DTE cible`** + tooltip ; ligne « n global = SAFE + AGRESSIF · tous DTE … pour le détail par DTE cible, cliquer un ticker » | Top 20 (bandeau + modal DTE breakdown) |
| 3 | SAFE + AGRESSIF additionnés | Rappel visible « n global = SAFE + AGRESSIF » dans bandeau Top 20 ; note de base dans Objectif 1 %+ ; couvert aussi par la légende | Top 20 + Objectif 1 %+ |
| 4 | deepAssignmentRate ambigu | En-têtes déjà « Proche / Profonde (% assign.) » (Top 20) ; tooltips `ASSIGN_DEPTH_PERCENT_TOOLTIP` ajoutés sur Objectif 1 %+ (Assign. proche / profonde) et modal DTE | Top 20 + Objectif 1 %+ + modal DTE |
| 5 | Observations normalisées | Sous-titre enrichi : « Base différente du Top 20 : observations normalisées ≠ records bruts. » | Section « Observations normalisées » |
| 6 | SAFE vs AGRESSIF | `SAFE_AGG_NORMALIZED_NOTE` enrichi : « Peut différer du n global Top 20. min(nSAFE, nAGRESSIF) sert à comparer prudemment les deux modes. » | Section « SAFE vs AGRESSIF » |
| 7 | Manque de légende | Nouveau composant repliable `JournalPopCountersLegend` (`<details>`) : n global / n DTE cible / assignation % / profondes / assignations / observations normalisées | Top 20 + Objectif 1 %+ |

## Détails par profil Objectif 1 %+

- En-tête `n` conservé (la colonne Mode peut valoir SAFE/AGRESSIF/GLOBAL) ; tooltip `N_PROFILE_TOOLTIP`
  précise « records résolus pour le mode indiqué ; GLOBAL = SAFE + AGRESSIF, tous DTE ».
- Note de base ajoutée au-dessus du tableau : « n global = SAFE + AGRESSIF additionnés, tous DTE
  (même base que le Top 20). La colonne Mode précise SAFE / AGRESSIF / GLOBAL. »

## Confirmation — aucune formule changée

- Aucune modification de `app/`, du backend, de la DB, du scanner, d'Archive Funnel, d'IBKR/Yahoo.
- Aucun recalcul : `row.n`, `profile.n`, `deepAssignmentRate`, scores E2b, verdicts, rangs inchangés
  (seuls le texte d'en-tête et des `title`/notes ont changé ; `getTop20SampleTier(row.n)` lit toujours `row.n`).
- Aucun `git add`, aucun commit, aucun backfill.

## Résultats tests / build

| Étape | Commande | Résultat |
| --- | --- | --- |
| Build | `npx vite build` (wheel-dashboard) | ✅ built in ~4s, 1947 modules, JournalPopPanel chunk OK |
| Tests | `node --test app/journal/*.test.mjs` | ✅ 129 pass / 0 fail |
| Whitespace | `git diff --check` | ✅ propre (exit 0) |

## Limites restantes

- La légende et les libellés ne corrigent pas les doublons SAFE+AGRESSIF ni les rescans dans `n`
  (choix moteur volontaire, hors périmètre J3) — ils sont seulement **expliqués**.
- La fraction « X / Y assignations profondes » n'est pas affichée (les profils exposent un taux %, pas
  toujours le numérateur/dénominateur côté payload) ; le tooltip explicite la base à défaut.
- Les obligations de double-comptage (audit J1 §« Risques de double-count ») restent des sujets
  moteur, non traités ici.
