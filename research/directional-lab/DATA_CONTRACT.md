# DATA CONTRACT — DailyBarV1 et politique raw/adjusted

## 1. DailyBarV1

Contrat implémenté dans `src/contracts/dailyBarV1.mjs`.

```json
{
  "schemaVersion": "DailyBarV1",
  "symbol": "APLD",
  "sessionDate": "2026-07-13",
  "eventTime": "2026-07-13T20:00:00.000Z",
  "availableAt": "2026-07-13T20:00:00.000Z",
  "timezone": "America/New_York",
  "source": "debug/ohlc-cache-APLD.json",
  "currency": "USD",
  "raw":      { "open": null, "high": null, "low": null, "close": null, "volume": null },
  "adjusted": { "open": 10.1, "high": 10.4, "low": 9.9, "close": 10.2, "volume": 1200000,
                "adjustmentType": "SPLIT_ADJUSTED", "adjustmentFactor": null },
  "corporateActions": { "splitFactor": null, "cashDividend": null },
  "qualityFlags": ["RAW_OHLC_MISSING"],
  "lineage": { "loadedFrom": "...", "loaderVersion": "jsonDailyAdapter/1", "rowIndex": 1063 }
}
```

Règles structurelles (validées par `dailyBarProblems`) :

- `sessionDate` est une **date civile** `YYYY-MM-DD`; aucune conversion via
  la `Date` locale, jamais (voir `src/time/civilDate.mjs`, arithmétique UTC
  pure).
- `eventTime` = fin réelle de séance (16:00 ET convertie en UTC par la règle
  DST américaine post-2007, calculée sans fuseau local).
- `availableAt` = premier instant où la barre était réellement utilisable;
  `availableAt >= eventTime` obligatoire.
- Prix négatif interdit; volume négatif interdit; `high >= open/close/low`;
  `low <= open/close/high` (OHLC impossible signalé).
- Doublons et dates non triées détectés au niveau série
  (`validateDailyBars`), jamais corrigés silencieusement.

## 2. Missingness — null reste null

- Un volume absent devient `null` + flag `VOLUME_MISSING`, **jamais 0**.
- Aucune donnée future, aucun forward-fill de prix ni d'événement.
- Toute fenêtre rolling contenant un null produit null.
- Chaque feature nulle porte un `missingReason`
  (`INSUFFICIENT_HISTORY`, `VOLUME_MISSING`, `BENCHMARK_UNAVAILABLE`,
  `NO_COMPLETED_WEEK`, ...). La paire null↔reason est imposée par
  `featureValue()` (exception sinon).

## 3. Politique raw / adjusted

Quatre bases de prix (`selectPriceBasis`) :

| Base | Contenu | Conditions |
|------|---------|-----------|
| `RAW` | OHLC brut natif | refusée si le raw est absent (jamais substituée) |
| `SPLIT_ADJUSTED` | OHLC ajusté splits, close hors dividendes | `adjustmentType` doit correspondre |
| `TOTAL_RETURN_ADJUSTED` | OHLC ajusté splits+dividendes | uniquement si natif |
| `DERIVED_ADJUSTED` | raw × (adjustedClose/rawClose) | explicite seulement; chaque barre flaggée `DERIVED_FROM_CLOSE_RATIO` + ratio conservé; **refusée en mode strict** |

Règles absolues :

- raw et adjusted sont stockés **séparément**; aucun mélange implicite;
- une règle de trading ne peut pas combiner adjusted close et raw open/high/
  low sans transformation déclarée (testé dans
  `test/split-adjustment.test.mjs`);
- les dividendes sont traités séparément du prix : les caches locaux ne
  fournissant pas les montants par barre, ils ne sont **pas** inclus et le
  warning `DIVIDENDS_NOT_INCLUDED` est émis (rendement total sous-estimé);
- les splits doivent préserver la continuité économique : quantités et coûts
  restent cohérents sur la base ajustée (fixture `split-bars.json` :
  aucun faux drawdown, aucun faux stop);
- un saut de prix > 50 % sans split documenté est signalé
  `SPLIT_SUSPECT` — signalé, pas corrigé.

## 4. Splits et dividendes (CorporateActionV1)

`src/contracts/corporateActionV1.mjs` : `SPLIT` (splitFactor > 0, ex. 2 pour
2:1) ou `CASH_DIVIDEND` (cashAmount ≥ 0), avec `effectiveDate` civile et
`source`. Les événements ne sont jamais forward-fillés ni fusionnés dans les
prix. Les ratios texte des caches (`"1:6"`) sont parsés explicitement
(`parseSplitRatio`) et marqués `SPLIT_DOCUMENTED` sur la barre concernée.

## 5. availableAt et lineage

- Chaque barre, chaque feature, chaque signal et chaque snapshot de régime
  porte un `availableAt`.
- La feature Weekly porte l'`availableAt` de la barre qui a **terminé** la
  semaine précédente (vendredi de la semaine complète), pas celui du jour
  courant.
- `lineage` trace : fichier source, version du loader, index de ligne, date
  source originale, et le cas échéant `totalReturnClose` (adjclose transporté
  séparément, jamais mélangé à l'OHLC).

## 6. DatasetManifestV1

`buildDatasetManifest` produit, en lecture seule : hash sha256 du fichier
source (toute mutation ultérieure est détectée par `validateDatasetManifest
--verifyHash`), couverture (firstDate/lastDate/barCount), disponibilité
(volume, raw OHLC, adjusted OHLC/close, splits), gapStats (jours ouvrés
manquants, plus long trou), qualityFlags et warnings.
