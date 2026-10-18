# Schéma forensic IBKR / Yahoo — v2 (additif)

Document de contrat d'export. Aucune décision financière. Les CSV historiques ne sont pas réinterprétés : un `0` ancien reste un `0` d'export, pas une preuve d'absence.

## Version

- `schemaVersion` JSON : `ibkr_rejection_forensics_v2`
- CSV : les 19 colonnes historiques restent en tête, dans le même ordre. Colonnes additives à la fin.

## Unités

| Champ | Unité | Note |
|---|---|---|
| `aggressiveSpreadPct`, `bestSafeSpreadPct`, `topPutCandidatesSummary[].spreadPct` | **fraction 0–1** | `0.75` = 75 %. Pas de conversion silencieuse ×100. |
| `aggressiveYieldPct`, `bestSafeYieldPct`, `*OtmPct`, `premiumDeficitPct`, `premiumCoveragePct` | pourcent | déjà convertis ×100 côté serveur pour les yields. |
| `*Bid`, `*Ask`, `*Mid`, `*PrimeUsed`, `targetPremium`, `premiumDeficitDollar` | USD / action | |
| `underlyingPrice`, `lowerBound`, `*Strike` | USD | un strike absent est `null`, jamais `0`. |
| `durationMs` | millisecondes | |

## Provenance

| Préfixe / champ | Provenance |
|---|---|
| `yahooTrace.request` | Requête Yahoo réellement envoyée (symbole, endpoint, expiration demandée, horodatage, erreur). |
| `yahooTrace.response` | Réponse **avant** normalisation Wheel (expiration réelle, identités, bid/ask bruts, absents vs zéros). |
| `yahooTrace.wheel` | Traitement Wheel (EM et fallbacks, borne basse, cible, candidats, motif). |
| `forensicTrace.quoteTrace[]` | Cotations IBKR observées sur les tickers déjà demandés. |
| `forensicTrace.ibkrErrorEvents[]` | Codes/messages IBKR reçus via `errorEvent`, s'ils existent. |
| `errorDetail` / `failureStage` | Sous-motif ATM/EM **sans** changer `error` ni `reason`. |
| `marketDataTypeReceivedLabel` | Seulement si un type a été **observé** sur un ticker ; sinon `unknown`. |
| `yahooIbkrComparison` | Classification Yahoo/IBKR pour un **même contrat** déjà présent dans l'export. |

Une donnée absente de l'export n'est pas une preuve d'absence chez le fournisseur.

## Compatibilité

- Consommateurs des 19 colonnes CSV : inchangés.
- JSON : champs historiques conservés ; `aggressiveStrike` d'un rejet sans contrat agressif devient `null` (plus `0`).
- Ne pas relire les CSV `2026-10-16` pour y chercher des nulls : la distinction d'origine y est perdue.
