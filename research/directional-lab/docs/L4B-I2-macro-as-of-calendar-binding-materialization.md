# L4B-I2 — macro as-of, calendrier et matérialisation

Ce document décrit l’intention de L4B-I2; il n’est pas une autorité de contrat.

## Objectif et exclusions

L’étape rend disponibles des objets déterministes pour répondre à « ce qui était
connu à un cutoff précis ». Elle ne télécharge aucune donnée, ne choisit jamais
« latest », et ne produit pas encore de signaux ou de features directionnels.

## Politique et resolveurs

`MacroAsOfResolutionPolicy/1` est un singleton fermé. Le resolveur de vintage
utilise un `MacroVintageSetManifest` épinglé, conserve seulement
`availableAt <= knowledgeCutoff`, puis choisit la pointe d’une chaîne causale
unique. Une absence retourne `NOT_AVAILABLE`; un retrait devient `WITHDRAWN`.
Une restauration après retrait est refusée en V1.

Le calendrier applique la même discipline avec
`calendarKnowledgeAvailableAt <= knowledgeCutoff`. La date planifiée informe
l’utilisateur mais ne prouve jamais que les données étaient disponibles.
Les versions SCHEDULED, RESCHEDULED, DELAYED, CANCELLED et RELEASED sont
append-only et gardent la même identité logique d’événement.

## Binding et rapport

`MacroDatasetBinding/1` épingle snapshot, politique as-of, calendrier et cutoff.
La juridiction, devise et capacité temporelle sont dérivées plutôt que fournies
librement. `MacroMaterializationReport/1` recompte les observations résolues,
indisponibles, retirées, les vintages futurs rejetés, les états du calendrier et
les digests canoniques. Les compteurs fournis ou modifiés ne font pas autorité.

## Anti-lookahead et schémas

Chaque référence est un id CAS explicite. Les objets non épinglés et les
versions postérieures au cutoff sont ignorés. Les quatre schémas I2 sont la
politique as-of, le registre calendrier, le binding et le rapport.

## Prochaine phase

L4B-F1 pourra consommer ces autorités épinglées pour créer des features, sans
relâcher les règles de point-in-time ni ajouter une référence latest.
