# Paramètres utilisateur Wheel Stable

Procédure adoptée par la décision Owner `OWNER_APPROVE_WHEEL_STABLE_USER_SETTINGS_R1`, étendue par `OWNER_ADOPT_WHEEL_STABLE_SCAN_CAPACITY_400_R2_MAINTENANCE_R1`. La capacité de pool et la continuation Yahoo jusqu'à 400 sont validées hors fournisseur.

## Usage ordinaire après installation et validation

Choisir une valeur dans un contrôle existant, à l'intérieur de ses bornes validées, est un usage de Wheel. Cela ne modifie ni le code, ni un contrat, ni le ledger de gouvernance. Aucune Gate, signature, publication ou réinspection de gouvernance n'est requise pour ce simple usage.

| Contrôle | Rôle | Bornes prévues | Défaut conservé | Stockage |
| --- | --- | --- | --- | --- |
| Strict max | Maximum du pool Strict et de titres à examiner | 1 à 400 | 150 | `wheel.strictWatchlistLimit` |
| Research limit | Maximum du pool Research et de titres à examiner | 1 à 400 | 200 | `wheel.researchExpandedLimit` |
| Depth | Maximum de titres soumis à l'audit IBKR en lecture seule | plafond 400; minimum effectif existant 10 | 50 | `wheel.ibkrAuditDepth` |
| Yahoo | Maximum demandé de candidats Yahoo conservés avant l'audit | 1 à 400 dans le contrôle | 55 | `wheel.topYahooReturned` |

Les valeurs déjà mémorisées sont conservées. Les valeurs 120, 180, 200, 250, 300 et 400 sont des choix possibles pour Depth; 400 n'est jamais imposé. La saisie reste libre sous le plafond.

Pour examiner 400 titres, choisir Strict max 400 puis « Rebuild watchlist », ou Research limit 400 (rechargement du pool existant). Cliquer ensuite « Refresh shortlist ». Une modification Strict ne reconstruit pas automatiquement la watchlist. Les filtres, catégories, provenance Research et règles de sélection restent identiques. Le pool peut contenir moins de titres que demandé; le secours statique conserve sa provenance et sa taille réelle.

Le scanner garde sa primitive Yahoo limitée à 200 titres. Une seule requête `/scan_shortlist` poursuit automatiquement les lots : 120, 180 et 200 restent un seul lot; 250 fait 200 + 50; 300 fait 200 + 100; 400 fait 200 + 200. Les lots sont séquentiels, avec les huit workers Yahoo existants. Tous les survivants des lots sont agrégés avant le classement global et la limite de retours Yahoo, challengers compris. Les doublons de symboles sont examinés une seule fois.

Pour transmettre jusqu'à 400 survivants à IBKR, choisir aussi Yahoo 400 et Depth 400. Avec Yahoo 55 par défaut, la limite de sortie et les challengers existants restent applicables même si 400 titres ont été examinés. Wheel ne peut auditer que les candidats effectivement retournés par la présélection Yahoo.

La ligne Yahoo distingue demandé, disponible, examiné, lots et état. `pool insuffisant` signifie que moins de titres étaient disponibles. `partial_errors` indique que tous les titres sélectionnés ont été tentés mais que certains ont produit une erreur. `incomplete` indique un arrêt ou un lot non terminé; IBKR automatique et la capture finale Journal ne sont alors pas lancés. À la déconnexion, les appels déjà en vol peuvent finir, mais aucun nouveau groupe de workers n'est lancé. Aucun timeout, budget ou critère financier n'est assoupli.

Yahoo peut conserver ses challengers selon la règle existante; ce comportement n'est pas changé. Les lots IBKR gardent leur configuration existante, de 5 à 50 titres, 50 par défaut. Les budgets, la concurrence, les timeouts et les critères d'éligibilité restent identiques. La capture Journal POP conserve sa borne existante, indépendante du plafond d'audit.

La sauvegarde utilise le stockage local du navigateur et de l'origine utilisée : `localhost:5173` et `127.0.0.1:5173` ont des stockages distincts. Utiliser la même adresse pour retrouver ses réglages. Une autre session de navigateur ne partage pas nécessairement ces préférences.

## Modification des bornes ou de la logique

Changer le plafond 400 dans les sources, créer un nouveau paramètre, changer une valeur par défaut dans le code, modifier les critères SAFE/Expected Move/POP/scoring/liquidité ou modifier les budgets, la concurrence, les fournisseurs, les ordres, le stockage des données ou la gouvernance reste une intervention sur le produit. Elle exige une autorisation de maintenance adaptée et les contrôles ciblés applicables.

Une intervention de maintenance locale peut employer le mécanisme existant `LOCAL_EXPLICIT_AUTHORITY`, classe `MAINTENANCE`, sans ouvrir une nouvelle Gate : périmètre fini, état initial vérifié, différentiel minimal, tests ciblés, précontrôle de configuration et d'autorité, puis reçu de consommation unique. Une préférence d'interface ne doit jamais servir à désactiver ces contrôles.

## Validation sans scan

Ne pas cliquer Refresh pendant une validation de réglages. Le rafraîchissement automatique de la shortlist est déjà désactivé dans les sources. Le montage de l'interface appelle toutefois les routes de construction d'univers et de pool research : une validation navigateur sans fournisseur doit simuler ou bloquer ces transports avant ouverture. Les tests hors réseau du correctif ne constituent pas une preuve de capacité réelle de marché à 400 titres.
