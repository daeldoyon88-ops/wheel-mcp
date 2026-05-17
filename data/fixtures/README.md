# Fixtures simulateur capital combos

## Fichiers

- **`latest-capital-combo-export.json`** — même contenu minimal que ci-dessous par défaut. Remplace-le par ton export Inspecteur après un scan réel (voir flux).
- **`minimal-capital-combo-replay.json`** — jeu factice (~12 titres Core) uniquement pour vérifier que le script Node tourne sans IBKR/Yahoo.

## Obtenir un export rejouable (indispensable pour ta shortlist réelle)

1. Démarre le dashboard (`wheel-dashboard`), lance une shortlist comme d’habitude.
2. Ouvre **Inspecteur Combinaisons capital** puis **Export JSON**.
3. Le fichier inclut désormais `comboReplayCandidates` + `maxCapitalPct`, `maxPositions`, `ibkrRejectedSymbolsSnapshot`, `optimizerV2FlagsSnapshot`.
4. Copie ce fichier ici (ex. `data/fixtures/latest-capital-combo-export.json`) et lance la simulation.

## Commandes

Depuis la racine du repo `wheel-mcp-remote` :

```bash
node scripts/simulateCapitalCombosFromFixture.js data/fixtures/latest-capital-combo-export.json
```

Ou :

```bash
npm run simulate:capital-combos
```

Pour un autre fichier :

```bash
npm run simulate:capital-combos -- chemin/vers/export.json
```

## Anciens exports

Les fichiers `combos-inspector-*.json` **sans** `comboReplayCandidates` ne peuvent pas rejouer le moteur : il manque les cartes candidats. Refais un export avec le dashboard à jour.
