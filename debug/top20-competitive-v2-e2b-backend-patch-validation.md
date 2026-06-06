# Validation — Top 20 compétitif V2 E2b backend

**Date :** 2026-06-06
**Statut validation script :** OK (13/13)
**Scope :** backend Journal POP read-only, aucun `git add`, aucun commit.

## Résumé

- Records lus : 3184
- Profils 1 %+ Wheel : 209
- Top 20 E2b : 20
- Crypto exclus : 10
- Version formule : E2b

## Top 20 avant / après

### Avant (legacy, sans `records`)

1. HIMS (119) · 2. HOOD (114) · 3. CCL (99) · 4. NOK (85) · 5. U (85) · 6. BNO (85) · 7. DAL (75) · 8. HPE (75) · 9. DOW (75) · 10. FCX (34)

### Après E2b

1. HOOD (100) · 2. HIMS (100) · 3. CCL (98) · 4. DAL (85) · 5. NOK (85) · 6. U (85) · 7. BNO (85) · 8. HPE (85) · 9. DOW (85) · 10. INTC (82 +8) · 11. AFRM (69 +8) · 12. APLD (67 +8) · 13. RIVN (65) · 14. APA (65) · 15. CZR (65) · 16. DOCU (65) · 17. CNC (65) · 18. HAL (65) · 19. SLB (65) · 20. TQQQ (62 +11)

## Comparaison ciblée

| Ticker | Bucket avant | Score avant | Rang avant | Bucket E2b | Score E2b | Rang E2b | Bonus robuste | Crypto-block |
|---|---|---:|---:|---|---:|---:|---:|---|
| TQQQ | excludedHighYield | 37 | 1 | top20 | 62 | 20 | 11 | non |
| APLD | excludedHighYield | 15 | 5 | top20 | 67 | 12 | 8 | non |
| INTC | excludedHighYield | 37 | 2 | top20 | 82 | 10 | 8 | non |
| AFRM | excludedHighYield | 15 | 6 | top20 | 69 | 11 | 8 | non |
| IONQ | excludedHighYield | -43 | 28 | watchValidate | 0 | 9 | 0 | non |
| TEM | excludedHighYield | 17 | 4 | excludedHighYield | -31 | 4 | 0 | non |
| MP | insufficientSample | 20 | 2 | insufficientSample | 25 | 27 | 0 | non |
| CDE | excludedHighYield | -63 | 34 | excludedHighYield | -50 | 10 | 0 | non |
| GDX | missing | N/D | N/D | excludedHighYield | -50 | 16 | 0 | non |
| SLV | missing | N/D | N/D | excludedHighYield | -50 | 12 | 0 | non |

## Checks

| Check | Résultat | Détail |
|---|---|---|
| TQQQ Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":37,"beforeRank":1,"afterBucket":"top20","afterScore":62,"afterRank":20,"robustHistoryBonus":11,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":50,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":5,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":1}} |
| APLD Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":15,"beforeRank":5,"afterBucket":"top20","afterScore":67,"afterRank":12,"robustHistoryBonus":8,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":36,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":5,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":1}} |
| INTC Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":37,"beforeRank":2,"afterBucket":"top20","afterScore":82,"afterRank":10,"robustHistoryBonus":8,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":34,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":4,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":1}} |
| AFRM Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":15,"beforeRank":6,"afterBucket":"top20","afterScore":69,"afterRank":11,"robustHistoryBonus":8,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":30,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":4,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":1}} |
| IONQ pas Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":-43,"beforeRank":28,"afterBucket":"watchValidate","afterScore":0,"afterRank":9,"robustHistoryBonus":0,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":28,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":4,"distinctAssignedExpirationCount":2,"distinctDeepAssignmentExpirationCount":1}} |
| TEM pas Top 20 E2b | OK | {"beforeBucket":"excludedHighYield","beforeScore":17,"beforeRank":4,"afterBucket":"excludedHighYield","afterScore":-31,"afterRank":4,"robustHistoryBonus":0,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":12,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":1,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":0}} |
| MP pas Top 20 E2b | OK | {"beforeBucket":"insufficientSample","beforeScore":20,"beforeRank":2,"afterBucket":"insufficientSample","afterScore":25,"afterRank":27,"robustHistoryBonus":0,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":4,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":2,"distinctAssignedExpirationCount":1,"distinctDeepAssignmentExpirationCount":0}} |
| CDE bas ou exclu | OK | {"beforeBucket":"excludedHighYield","beforeScore":-63,"beforeRank":34,"afterBucket":"excludedHighYield","afterScore":-50,"afterRank":10,"robustHistoryBonus":0,"hardExclusionReasonsV2":["Risque confirmé répété : LB critique + (≥2 expirations profondes ou win<70 % ou assignation>35 %)","Garde-fou défensif : LB critique + assignation>25 % + win<80 %"],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":18,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":3,"distinctAssignedExpirationCount":2,"distinctDeepAssignmentExpirationCount":2}} |
| GDX bas ou exclu | OK | {"beforeBucket":"missing","beforeScore":null,"beforeRank":null,"afterBucket":"excludedHighYield","afterScore":-50,"afterRank":16,"robustHistoryBonus":0,"hardExclusionReasonsV2":[],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":12,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":2,"distinctAssignedExpirationCount":2,"distinctDeepAssignmentExpirationCount":2}} |
| SLV bas ou exclu | OK | {"beforeBucket":"missing","beforeScore":null,"beforeRank":null,"afterBucket":"excludedHighYield","afterScore":-50,"afterRank":12,"robustHistoryBonus":0,"hardExclusionReasonsV2":["Risque confirmé répété : LB critique + (≥2 expirations profondes ou win<70 % ou assignation>35 %)","Garde-fou défensif : LB critique + assignation>25 % + win<80 %"],"cryptoBlocked":false,"rankingFormulaVersion":"E2b","diagnostics":{"n":28,"winRatePct":null,"assignmentRatePct":null,"distinctExpirationCount":3,"distinctAssignedExpirationCount":2,"distinctDeepAssignmentExpirationCount":2}} |
| Top 20 count = 20 | OK | top20=20 |
| Aucun crypto bloqué dans Top 20 | OK | {"top20":["HOOD","HIMS","CCL","DAL","NOK","U","BNO","HPE","DOW","INTC","AFRM","APLD","RIVN","APA","CZR","DOCU","CNC","HAL","SLB","TQQQ"],"excludedCrypto":["BLSH","BMNR","BTDR","CIFR","CORZ","CRCL","IBIT","IREN","RIOT","WULF"]} |
| rankingFormulaVersion = "E2b" | OK | {"rows":189,"missing":[]} |

## Compatibilité

- `options.records` absent : chemin legacy conservé.
- `options.records` présent : `rankingFormulaVersion` vaut `E2b` sur les lignes retournées.
- Pine TradingView non touché.
- Crypto-block conservé : aucun ticker crypto exclu dans le Top 20.
- UI compatible : champs legacy conservés, diagnostics E2b ajoutés.
- Build Vite : vite build OK (confirmé par `npx vite build`).
- Aucun `git add`, aucun commit.

