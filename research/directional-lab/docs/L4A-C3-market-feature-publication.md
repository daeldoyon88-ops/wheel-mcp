# L4A-C3 — publication des features de marché A/B/C

L4A-C3 publie ensemble les familles techniques (L4A-A), volume/structure
(L4A-B) et saisonnalité (L4A-C) sans copier ni fusionner leurs rows. Le
scanner, le dashboard, les modèles, les labels et les signaux restent hors
périmètre.

## Autorité et manifest de références

`MarketFeaturePublicationAuthorityPolicy/1` ferme la version
`MARKET_FEATURE_SET_L4A_ABC/1`, l'ordre A/B/C, la vérification complète des
trois familles, l'alignement exact des rows et l'interdiction de toute
résolution implicite.

`MarketFeaturePublicationManifest/1` référence séparément, pour chaque
famille, le source bundle, la policy de calcul, les rows, le report et le
`TransformImplementationManifest/2`. Le builder appelle les verifiers
autoritaires A, B et C, puis dérive les autorités communes depuis le binding
I6 vérifié. Les reports A/B historiques ne sont pas modifiés : leur digest est
calculé dans C3 depuis leurs rows vérifiées avec
`SHA-256(CanonicalJSON([{sessionDate, subjectBarIdentityId}, ...]))`.

Comme les reports historiques A/B ne portent pas eux-mêmes leur identité
d'implémentation, C3 ferme pour chaque famille le profil
`TransformImplementationManifest/2` (version runtime, liste canonique des
modules et hashes normalisés de leur contenu). Le builder publie ce profil et
le verifier le recalcule depuis les modules réellement exécutés. Un autre
manifest de bon schéma reste donc refusé; C conserve en plus son pin direct
source bundle/report.

Une publication est valide seulement si les trois familles ont exactement le
même instrument, binding, snapshot, objet OHLCV normalisé, calendrier,
knowledge cutoff, capacité temporelle, price basis, traitement corporate
action et couverture ordonnée. Une publication vide exige trois familles
vides et le digest canonique de `[]`.

## Registry append-only

`MarketFeaturePublicationRegistryManifest/1` utilise la clé logique :

```text
instrumentIdentityId
datasetSnapshotBindingId
publicationAuthorityPolicyId
featureSetVersion
```

Un registry genesis est vide. Chaque registry enfant référence explicitement
son parent, conserve toutes ses entrées byte-for-byte et ajoute exactement une
entrée. Une entrée peut superséder explicitement le tip unique de la même clé.
Les parents absents, branches concurrentes, tips multiples, cycles, recul du
knowledge cutoff et supersessions cross-key sont refusés.

## Résolution as-of

`resolveMarketFeaturePublicationAsOf` exige quatre entrées explicites : un
store, un registry piné, la clé logique complète et un
`asOfKnowledgeCutoff`. Il ne consulte aucun registry non référencé et ne fait
aucune recherche globale dans le CAS. Il filtre la chaîne visible au cutoff et
retourne son tip causal unique; absence et ambiguïté sont des erreurs
déterministes.

## Replay et multi-store

Les documents ne contiennent ni heure courante, ni URL, ni hostname, ni cache
mutable, ni chemin physique. Les tableaux sont canoniquement ordonnés. Avec les
mêmes autorités CAS, un replay ou un autre store produit les mêmes bytes, IDs,
tips et résultat as-of, indépendamment du bruit et de l'ordre d'insertion.

La prochaine phase, après validation et release gate de C3, est L4B (Fed, taux
et macroéconomie). Elle n'est pas implémentée ici.
