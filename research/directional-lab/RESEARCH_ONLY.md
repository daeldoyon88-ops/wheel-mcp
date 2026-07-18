# RESEARCH ONLY — LABORATOIRE EXPÉRIMENTAL

Ce dossier (`research/directional-lab/`) est un **laboratoire de recherche
expérimental**, entièrement isolé du reste du dépôt.

## Ce que ce laboratoire N'EST PAS

- **Aucune influence sur la production.** Rien ici n'est importé par le
  scanner, le serveur (`server.js`), le dashboard, les scripts ou quelque
  code de production que ce soit. Le test
  `test/no-production-coupling.test.mjs` le vérifie mécaniquement.
- **Aucun signal financier réel.** Les stratégies présentes sont des
  *baselines techniques* servant à valider le pipeline. Elles ne constituent
  ni une recommandation d'achat, ni une recommandation de vente, ni un
  conseil financier.
- **Aucune connexion IBKR.** Le laboratoire n'ouvre aucune connexion réseau,
  n'appelle aucune API (ni IBKR, ni Yahoo, ni aucune autre) et ne télécharge
  aucune donnée.
- **Aucun ordre.** Aucun ordre n'est passé, simulé en direct, ni transmis à
  quelque courtier que ce soit. Les « fills » sont des simulations
  historiques causales.
- **Aucune modification du scanner.** SAFE, BALANCED, AGGRESSIVE, les
  strikes, le ranking, les caps, le score Elite, le Journal POP et
  `universe.master.json` ne sont ni lus pour décision, ni modifiés.
- **Aucune écriture persistante externe.** Ni le laboratoire ni l'agent qui
  y travaille ne créent ou ne modifient automatiquement une mémoire
  d'agent, un index de mémoire ou quelque fichier persistant que ce soit
  hors de `research/directional-lab/`. Les fichiers temporaires des tests
  vivent sous le répertoire temporaire du système et sont supprimés par les
  tests eux-mêmes. Un test de couplage vérifie qu'aucun code du laboratoire
  ne référence de tels chemins.

## Ce que ce laboratoire EST

- Un contrat de données strict (`DailyBarV1`) avec séparation raw/adjusted.
- Un moteur de features **causal** (aucune bougie future visible à t).
- Un backtester **causal** (signal au close t → exécution à l'open t+1,
  stops gap-aware actifs à partir de la séance suivante).
- Quatre baselines à paramètres fixes, sans aucune optimisation.
- Une infrastructure walk-forward avec purge/embargo.
- Un univers de recherche versionné de 120 titres, indépendant du scanner.

## Statut des résultats

**Tous les résultats produits ici sont non validés tant qu'ils ne sont pas
confirmés hors échantillon.** Les sorties du pilote portent la mention
`PILOT_TECHNICAL_ONLY` : elles vérifient que le pipeline fonctionne (dates,
causalité, métriques, reproductibilité), rien de plus.

Les fichiers de données locaux lus par le laboratoire (sous `debug/`) sont
ouverts **en lecture seule** et ne sont jamais modifiés, déplacés ou stagés.
