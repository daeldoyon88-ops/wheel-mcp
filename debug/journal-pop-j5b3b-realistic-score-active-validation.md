# Validation J5-B3-B — Score réaliste actif (score principal Top 20)

> Phase J5-B3-B · 2026-06-07 · 3184 records · 216 profils
> Le score réaliste (décision réelle BALANCED + garde-fous) **pilote désormais le classement Top 20**. L'ancien score E2b est conservé en référence.

## Confirmations

- Top 20 utilise le score réaliste actif (`dynamicTop20ScoreSource = "realistic"`) : **OUI**
- Ancien score conservé (`dynamicTop20ScoreLegacy`) : **OUI**
- Pas de deuxième classement (un seul Top 20, `scoreType = dynamicTop20ScoreRealistic`) : **OUI**

## Garde-fous actifs

```
{
  "exploitableForTop20Count": 9,
  "exploitableMinScore": 35,
  "exploitableMinN": 10,
  "realisticMinSelectedTradeCount": 5,
  "realisticMinSelectedYieldPct": 0.5,
  "realisticMaxDeepAssignmentRatePct": 50
}
```

## Fichiers modifiés

| Fichier | Nature |
| --- | --- |
| `app/journal/wheelValidationService.js` | `computeRealisticPreviewScore` (garde-fous), `computeRealisticActiveScoreForProfile`, `buildRealisticActiveReasonSummary`, `computeE2bDynamicTop20` (tri/buckets par score réaliste), `mapDynamicTop20ProfileRow` (champs legacy/realistic), `attachRealisticPreviewToDynamicTop20Result` (base legacy) |
| `wheel-dashboard/src/components/JournalPopPanel.jsx` | Colonne « Score réaliste », ancien score en référence, badges confiance/admissibilité, textes « actif » |

## Champs ajoutés / renommés (ligne Top 20, pipeline E2b)

- `dynamicTop20Score` = **score réaliste actif** (pilote le classement)
- `dynamicTop20ScoreRealistic` = score réaliste
- `dynamicTop20ScoreSource` = `"realistic"`
- `dynamicTop20ScoreLegacy` = ancien score compétitif E2b (référence)
- `dynamicTop20ScoreLaboratory` = ancien score laboratoire observationnel (référence secondaire)
- `realisticActive` = { score, baseScore, eligibleForTop20, eligibilityReason, confidence, confidenceBadge, penalties, bonuses }
- `realisticReasonSummary` = raison lisible (score réaliste + ancien score + n déc. / assign. / prof. / rend. / dup.)

## Top 20 APRÈS (trié par score réaliste actif)

| Rang | Ticker | Score réaliste | Ancien E2b | n déc. | Assign.% | Prof.% | Rend.% | Dup. | Statut |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | HOOD | 100 | 100 | 5 | 0 | — | 1.02 | 10.4 | top20_experimental |
| 2 | CCL | 100 | 100 | 5 | 0 | — | 0.98 | 8 | top20_experimental |
| 3 | HIMS | 100 | 100 | 5 | 0 | — | 1.13 | 6.4 | top20_experimental |
| 4 | U | 96 | 85 | 5 | 0 | — | 1.19 | 4.4 | top20_experimental |
| 5 | INTC | 93 | 82 | 5 | 0 | — | 1.78 | 6.8 | top20_experimental |
| 11 | APLD | 80 | 69 | 5 | 0 | — | 1.59 | 7.6 | top20_experimental |
| 12 | DOCU | 76 | 65 | 5 | 0 | — | 0.82 | 2 | top20_experimental |
| 13 | RIVN | 68 | 65 | 5 | 20 | 0 | 0.82 | 2.8 | top20_experimental |
| 15 | TQQQ | 65 | 67 | 5 | 20 | 0 | 1.34 | 10.4 | top20_experimental |

## Entrants / sortants vs ancien Top 20 (par score E2b)

- **Entrants** : _aucun_
- **Sortants** : DAL, DOW, NOK, HPE, BNO, AFRM, FLY, CSCO, CNC, APA, FISV

## Tickers qui montent (score réaliste actif)

- **GAP** : rang 118 → 35 (+83) · score réaliste actif 32 — ancien score obs. 23 — assignation réelle inférieure, rendement réel solide, win rate réel élevé — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 1.51% · dup. 4×
- **GDX** : rang 173 → 129 (+44) · score réaliste actif 0 — ancien score obs. -50 — assignation réelle inférieure, profondeur réelle, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 3 · assign. 66.7% · prof. 50% · rend. 0.64% · dup. 4.67×
- **PLTR** : rang 167 → 135 (+32) · score réaliste actif 0 — ancien score obs. -49 — assignation réelle inférieure, profondeur réelle, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 2 · assign. 50% · prof. 100% · rend. 0.88% · dup. 5×
- **WFC** : rang 174 → 143 (+31) · score réaliste actif 0 — ancien score obs. -50 — assignation réelle inférieure, profondeur réelle, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 2 · assign. 50% · prof. 100% · rend. 0.64% · dup. 3×
- **PAAS** : rang 164 → 134 (+30) · score réaliste actif 0 — ancien score obs. -46 — assignation réelle inférieure, win rate réel élevé, rendement réel solide — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.85% · dup. 10×
- **UBER** : rang 175 → 147 (+28) · score réaliste actif 0 — ancien score obs. -50 — assignation réelle inférieure, échantillon faible, duplication élevée — échantillon décision réelle insuffisant (<5) — n déc. 4 · assign. 50% · prof. 0% · rend. 0.63% · dup. 4.5×
- **CDE** : rang 176 → 151 (+25) · score réaliste actif 0 — ancien score obs. -50 — profondeur réelle — n déc. 5 · assign. 40% · prof. 50% · rend. 0.88% · dup. 3.6×
- **SLV** : rang 177 → 153 (+24) · score réaliste actif 0 — ancien score obs. -50 — assignation réelle inférieure, profondeur réelle, duplication élevée — assignation profonde réelle >50 % — n déc. 5 · assign. 20% · prof. 100% · rend. 0.79% · dup. 6×
- **XYZ** : rang 178 → 155 (+23) · score réaliste actif 0 — ancien score obs. -50 — assignation réelle inférieure, rendement réel solide, profondeur réelle — échantillon décision réelle insuffisant (<5) — n déc. 4 · assign. 25% · prof. 100% · rend. 0.98% · dup. 5.5×
- **NVO** : rang 165 → 148 (+17) · score réaliste actif 0 — ancien score obs. -47 — échantillon faible, duplication élevée — échantillon décision réelle insuffisant (<5) — n déc. 3 · assign. 33.3% · prof. 0% · rend. 0.6% · dup. 5.33×

## Tickers qui descendent (score réaliste actif)

- **MSTR** : rang 35 → 133 (-98) · score réaliste actif 0 — ancien score obs. 26 — profondeur réelle, duplication élevée, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 2 · assign. 50% · prof. 100% · rend. 1.18% · dup. 6×
- **BAC** : rang 33 → 116 (-83) · score réaliste actif 20 — ancien score obs. 30 — échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 3 · assign. 33.3% · prof. 0% · rend. 0.57% · dup. 2.67×
- **VG** : rang 45 → 114 (-69) · score réaliste actif 21 — ancien score obs. 25 — win rate réel élevé, rendement réel solide, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.83% · dup. 4×
- **LW** : rang 51 → 118 (-67) · score réaliste actif 18 — ancien score obs. 25 — win rate réel élevé, échantillon faible, duplication élevée — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.75% · dup. 4×
- **UPS** : rang 53 → 115 (-62) · score réaliste actif 21 — ancien score obs. 25 — win rate réel élevé, rendement réel solide, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.84% · dup. 4×
- **KKR** : rang 38 → 73 (-35) · score réaliste actif 23 — ancien score obs. 25 — win rate réel élevé, rendement réel solide, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.92% · dup. 4×
- **AMBA** : rang 129 → 161 (-32) · score réaliste actif 0 — ancien score obs. -17 — assignation réelle inférieure, win rate réel élevé, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.64% · dup. 2×
- **TEVA** : rang 146 → 172 (-26) · score réaliste actif 0 — ancien score obs. -34 — assignation réelle inférieure, win rate réel élevé, rendement réel solide — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.87% · dup. 4×
- **EXPE** : rang 139 → 162 (-23) · score réaliste actif 0 — ancien score obs. -28 — assignation réelle inférieure, win rate réel élevé, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 0.68% · dup. 2×
- **TEAM** : rang 37 → 59 (-22) · score réaliste actif 26 — ancien score obs. 25 — rendement réel solide, win rate réel élevé, échantillon faible — échantillon décision réelle insuffisant (<5) — n déc. 1 · assign. 0% · rend. 1.11% · dup. 4×

## Impact sur les tickers focus

| Ticker | Rang av. | Rang ap. | Score réaliste | Ancien E2b | n déc. | Admissible | Raison |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HOOD | 1 | 1 | 100 | 100 | 5 | oui | score réaliste actif 100 — ancien score obs. 100 — rendement réel solide, win rate réel élevé, assignation réelle inférieure — n déc. 5 · assign. 0% · rend. 1.02% · dup. 10.4× |
| CCL | 2 | 2 | 100 | 100 | 5 | oui | score réaliste actif 100 — ancien score obs. 100 — assignation réelle inférieure, win rate réel élevé, rendement réel solide — n déc. 5 · assign. 0% · rend. 0.98% · dup. 8× |
| HIMS | 3 | 3 | 100 | 100 | 5 | oui | score réaliste actif 100 — ancien score obs. 100 — rendement réel solide, win rate réel élevé, duplication élevée — n déc. 5 · assign. 0% · rend. 1.13% · dup. 6.4× |
| APLD | 11 | 11 | 80 | 69 | 5 | oui | score réaliste actif 80 — ancien score obs. 69 — rendement réel solide, win rate réel élevé, assignation réelle inférieure — n déc. 5 · assign. 0% · rend. 1.59% · dup. 7.6× |
| TQQQ | 13 | 15 | 65 | 67 | 5 | oui | score réaliste actif 65 — ancien score obs. 67 — rendement réel solide, duplication élevée — n déc. 5 · assign. 20% · prof. 0% · rend. 1.34% · dup. 10.4× |
| INTC | 10 | 5 | 93 | 82 | 5 | oui | score réaliste actif 93 — ancien score obs. 82 — rendement réel solide, win rate réel élevé, assignation réelle inférieure — n déc. 5 · assign. 0% · rend. 1.78% · dup. 6.8× |
| AFRM | 12 | 31 | 42 | 69 | 4 | non | échantillon décision réelle insuffisant (<5) |
| SOFI | 119 | 117 | 19 | 21 | 5 | oui | score réaliste actif 19 — ancien score obs. 21 — rendement réel solide, duplication élevée — n déc. 5 · assign. 20% · prof. 0% · rend. 1.02% · dup. 7.2× |

## Limites restantes

- Comparaison AVANT reconstruite à partir de dynamicTop20ScoreLegacy (ancien score E2b) sur le même pool de profils.
- Le score réaliste s'appuie sur la sélection BALANCED post-mortem pour la base décision — légitime en analyse, jamais en capture live.
- n max après déduplication ≈ distinctExpirationCount ; selectedTradeCount<5 reste fréquent → near_entry / insufficient_sample.
- Scanner / IBKR / Yahoo / Archive Funnel / DB / formules POP : non touchés.

## Tests / build

- `node --test app/journal/*.test.mjs` — voir rapport agent.
- `npx vite build` (wheel-dashboard) — voir rapport agent.
- `git diff --check` — voir rapport agent.
