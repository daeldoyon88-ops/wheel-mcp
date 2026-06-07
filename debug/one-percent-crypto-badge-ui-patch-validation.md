# Validation — Badge crypto-block UI dans « Objectif 1 %+ — Wheel complet »

**Date :** 2026-06-07
**Portée :** UI seulement
**Fichier modifié :** `wheel-dashboard/src/components/JournalPopPanel.jsx`
**Helper crypto utilisé :** `getTickerDisplayMeta()` (`wheel-dashboard/src/tickerMeta.js`) → source unique `app/watchlist/cryptoWheelFilter.js`

## Objectif

Afficher un badge visible sur les tickers crypto/digital-asset bloqués dans la
section « Objectif 1 %+ — Wheel complet » du Journal POP, **sans les masquer** et
**sans toucher** au backend, scanner, scoring E2b, IBKR/Yahoo, Pine ou DB.

## Changement appliqué

Dans la cellule ticker du shortlist 1 %+ (`displayedOnePercentProfiles.map(...)`,
~ligne 6208), le ticker reste affiché tel quel et un badge s'ajoute en dessous :

- **Crypto bloqué** (`isCryptoBlocked`) → badge rouge
  `Crypto bloqué — exclu Wheel`
  tooltip : `crypto_blocked_except_bitx · BITX seul autorisé` (raison officielle
  via `cryptoBlockReason`).
- **Crypto relié équité** (`isCryptoRelatedEquity`, ex. COIN/MSTR) → badge ambre
  informatif `Crypto relié` (non bloquant).
- Tout autre ticker (dont **BITX**) → aucun badge.

Aucune liste crypto n'est dupliquée dans le composant : tout vient de
`getTickerDisplayMeta()`, qui dérive de `cryptoWheelFilter.js`.

## Garanties

| Garantie | Statut |
| --- | --- |
| UI seulement | ✅ |
| Badge ajouté dans Objectif 1 %+ | ✅ |
| Aucun masquage par défaut (RIOT/IREN/IBIT/CIFR/BMNR/WULF restent visibles) | ✅ |
| `cryptoWheelFilter.js` non modifié | ✅ |
| Backend / scanner / scoring E2b / DB / Pine non modifiés | ✅ |
| BITX préservé (pas de badge bloquant) | ✅ |
| COIN/MSTR non bloqués (badge informatif uniquement) | ✅ |
| `filteredOnePercentProfiles` / `displayedOnePercentProfiles` / Top 20 E2b intacts | ✅ |
| Vite build OK | ✅ |
| `git diff --check` OK | ✅ |
| Aucun `git add` / aucun commit | ✅ |

## Commandes lancées

```
npx vite build            # ✓ built in 3.55s — JournalPopPanel-*.js émis
git diff --check          # exit 0 (aucun whitespace error)
node debug/one-percent-crypto-badge-ui-patch-validation.mjs   # ALL CHECKS PASS
```

## Résultat des checks automatiques

Voir `one-percent-crypto-badge-ui-patch-validation.json` — 10/10 PASS :

1. Import `getTickerDisplayMeta` depuis `../tickerMeta.js`
2. `tickerMeta.js` dérive de `cryptoWheelFilter.js`
3. Badge `Crypto bloqué — exclu Wheel` présent
4. Badge informatif `Crypto relié` présent
5. Tooltip raison officielle + « BITX seul autorisé »
6. Ticker toujours rendu (aucun masquage)
7. Aucun filtre crypto ajouté au pipeline 1 %+
8. `cryptoWheelFilter.js` intact (BITX exception, COIN/MSTR non bloqués)
9. `filteredOnePercentProfiles` préservé
10. `displayedOnePercentProfiles` préservé

## Risques restants

- **Couverture badge = couverture de la liste source.** Un nouveau ticker crypto
  non présent dans `CRYPTO_DIGITAL_ASSET_BLOCKED_SYMBOLS` n'aura pas de badge —
  c'est volontaire (source unique). Pour l'étendre, modifier `cryptoWheelFilter.js`
  (hors périmètre de ce patch).
- **Affichage seulement.** Les tickers crypto bloqués restent dans le shortlist 1 %+
  (non masqués, conforme à la consigne). Le badge signale l'exclusion Wheel mais ne
  retire pas la ligne ; un utilisateur doit lire le badge pour l'interpréter.
- Aucun impact runtime au-delà d'un appel `getTickerDisplayMeta()` par ligne rendue
  (lookup mémoire, négligeable).
