# Validation J5-B3-A — Preview score réaliste (simulation)

> Phase J5-B3-A · 2026-06-07 · **additif uniquement** — aucun score officiel, tri ni verdict modifié.

## Objectif

Calculer un **score réaliste simulé** à partir de `dynamicTop20Score` + `realisticDecisionMetrics`, afficher l'impact de rang potentiel, **sans** modifier le classement Top 20 réel.

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| `app/journal/wheelValidationService.js` | `computeRealisticPreviewScore`, `attachRealisticPreviewToDynamicTop20Result` |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | UI compacte + modal preview |

## Fichiers créés

| Fichier | Nature |
| --- | --- |
| `app/journal/wheelValidationService.realisticPreviewScore.test.mjs` | Tests unitaires |
| `debug/journal-pop-j5b3a-realistic-score-preview-validation.mjs` | Script rapport |
| `debug/journal-pop-j5b3a-realistic-score-preview-validation.md` | Rapport |
| `debug/journal-pop-j5b3a-realistic-score-preview-validation.json` | Rapport machine |

## Fonctions ajoutées

- **`computeRealisticPreviewScore(profileOrRow)`** — exportée. Base = `dynamicTop20Score` ; ajustements légers via duplication, profondeur réelle, échantillon, assignation, rendement, win rate.
- **`attachRealisticPreviewToDynamicTop20Result(result)`** — interne. Attache `realisticPreview` + `realisticPreviewRank` après construction du Top 20 ; **ne re-trie pas** les tableaux officiels.

## Champs ajoutés

```
realisticPreview: {
  score, baseScore, rankImpactReason, penalties, bonuses,
  confidence, wouldImprove, wouldDecline, rankDelta, previewOnly
}
realisticPreviewRank
```

## Preuve « Top 20 réel non modifié »

- Ordre officiel identique avec/sans `realisticDecisionMetrics` : **OUI**
- `dynamicTop20Score` inchangé sur chaque ligne Top 20 : **OUI**
- Les tableaux `top20`, `nearEntry`, etc. gardent le même ordre ; seuls des champs additifs sont écrits sur les objets ligne.

### Top 20 officiel (ordre inchangé)

| Rang | Ticker | Score officiel | Preview | Rang sim. | Delta |
| --- | --- | --- | --- | --- | --- |
| 1 | HOOD | 100 | 100 | 1 | 0 |
| 2 | CCL | 100 | 100 | 2 | 0 |
| 3 | HIMS | 100 | 100 | 3 | 0 |
| 4 | DAL | 100 | 93 | 6 | -2 |
| 5 | NOK | 85 | 84 | 8 | -3 |
| 6 | U | 85 | 96 | 4 | +2 |
| 7 | HPE | 85 | 81 | 9 | -2 |
| 8 | BNO | 85 | 81 | 10 | -2 |
| 9 | DOW | 85 | 86 | 7 | +2 |
| 10 | INTC | 82 | 93 | 5 | +5 |
| 11 | APLD | 69 | 80 | 11 | 0 |
| 12 | AFRM | 69 | 42 | 31 | -19 |
| 13 | TQQQ | 67 | 65 | 15 | -2 |
| 14 | RIVN | 65 | 68 | 13 | +1 |
| 15 | APA | 65 | 58 | 19 | -4 |
| 16 | FLY | 65 | 66 | 14 | +2 |
| 17 | CSCO | 65 | 63 | 17 | 0 |
| 18 | FISV | 65 | 58 | 20 | -2 |
| 19 | DOCU | 65 | 76 | 12 | +7 |
| 20 | CNC | 65 | 63 | 16 | +4 |

## Tickers qui monteraient (preview)

- **DOCU** : rang 19 → 12 (win rate réel élevé)
- **INTC** : rang 10 → 5 (duplication élevée / rendement réel solide)
- **CNC** : rang 20 → 16 (échantillon faible / win rate réel élevé)
- **U** : rang 6 → 4 (duplication élevée / rendement réel solide)
- **DOW** : rang 9 → 7 (échantillon faible / assignation réelle inférieure)
- **FLY** : rang 16 → 14 (échantillon faible / rendement réel solide)
- **RIVN** : rang 14 → 13 (rendement réel solide)

## Tickers qui descendraient (preview)

- **AFRM** : rang 12 → 31 (profondeur réelle / rendement réel solide)
- **APA** : rang 15 → 19 (échantillon faible / win rate réel élevé)
- **NOK** : rang 5 → 8 (duplication élevée / rendement réel solide)
- **DAL** : rang 4 → 6 (duplication élevée / win rate réel élevé)
- **HPE** : rang 7 → 9 (échantillon faible / win rate réel élevé)
- **BNO** : rang 8 → 10 (duplication élevée / rendement réel solide)
- **TQQQ** : rang 13 → 15 (duplication élevée / rendement réel solide)
- **FISV** : rang 18 → 20 (échantillon faible / win rate réel élevé)

## Focus TQQQ / APLD / HOOD / SOFI / CCL / HIMS

| Ticker | Rang off. | Rang sim. | Score off. | Preview | Raison |
| --- | --- | --- | --- | --- | --- |
| TQQQ | 13 | 15 | 67 | 65 | duplication élevée / rendement réel solide |
| APLD | 11 | 11 | 69 | 80 | duplication élevée / rendement réel solide |
| HOOD | 1 | 1 | 100 | 100 | duplication élevée / rendement réel solide |
| SOFI | 4 | 117 | 21 | 19 | duplication élevée / rendement réel solide |
| CCL | 2 | 2 | 100 | 100 | duplication élevée / assignation réelle inférieure |
| HIMS | 3 | 3 | 100 | 100 | duplication élevée / rendement réel solide |

## Limites

- Pondération légère — pas la formule finale J5-B3.
- Preview rank compare tous les profils des buckets top20/nearEntry/watchValidate/insufficientSample.
- Ne remplace pas dynamicTop20Score ni le tri officiel.
- BALANCED reste post-mortem pour la sélection décision.

## Tests / build

- `node --test app/journal/*.test.mjs` → **144 pass / 0 fail** (dont 6 tests `realisticPreviewScore`)
- `npx vite build` (wheel-dashboard) → **✓ built in 4.37s** (chunk `JournalPopPanel` 347.52 kB)
- `git diff --check` → **OK** (exit 0)
- `node debug/journal-pop-j5b3a-realistic-score-preview-validation.mjs` → `top20Unchanged: true`
