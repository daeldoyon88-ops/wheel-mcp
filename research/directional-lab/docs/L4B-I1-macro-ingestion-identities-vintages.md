# L4B-I1 — Identités macro, vintages, registries, ingestion policy et snapshot

Document de phase. **Les valeurs contractuelles font autorité dans le code fermé**,
pas dans ce fichier. Ce document décrit le périmètre, les invariants et la
frontière avec L4B-I2.

## Objectif

Construire la fondation causale, point-in-time, vintage-aware, append-only,
déterministe et content-addressed sur laquelle les features macro L4B seront
ensuite calculées.

L4B-I1 **ne produit aucune feature macro finale**. Aucune courbe, spread,
CPI MoM/YoY, chômage, claims, régime, score, signal ni publication A/B/C/L4B.

## Scope

Huit schémas canonical (`snapshots`) ajoutés :

1. `MacroSeriesIdentityCore/1`
2. `MacroSeriesRegistryManifest/1`
3. `MacroObservationIdentityCore/1`
4. `MacroVintageIdentityCore/1`
5. `MacroObservationVintageCore/1`
6. `MacroVintageSetManifest/1`
7. `MacroIngestionPolicy/1`
8. `MacroDatasetSnapshotManifest/1`

Après L4B-I1 : `SNAPSHOT_NAMESPACE_SCHEMA_VERSIONS.length === 97`,
`NORMALIZED_NAMESPACE_SCHEMA_VERSIONS.length === 5`.

## Exclusions

Non inclus dans I1 (phases suivantes) :

- `MacroDatasetBinding/1`
- `MacroReleaseCalendarRegistryManifest/1`
- `MacroMaterializationReport/1`
- bundles / policies / rows / reports de features macro
- Publication Policy/Manifest/Registry v2
- resolver as-of de session (L4B-I2)

## Identité de série

`MacroSeriesIdentityCore/1` représente l’identité permanente d’une série :
juridiction, devise, autorité, code canonical, fréquence, unités, ajustement
saisonnier, convention d’observation, politique de révision, autorité de
release, `methodologyVersionId` (référence CAS), `validFrom` / `validThrough`
(dates civiles).

Les titres d’affichage et codes fournisseur mutables sont **exclus** de ce
cœur : ils ne doivent jamais influencer l’identité permanente (adversarial #57).

Tout changement d’unité, de saisonnalité, de fréquence, de méthode, de
convention ou d’autorité **produit une nouvelle identité**. Aucune mutation
in-place.

## Series registry append-only

`MacroSeriesRegistryManifest/1` est un manifest CAS append-only :

- genesis et append avec `supersedesRegistryManifestId`
- statuts `ACTIVE | DEPRECATED | REPLACED`
- un seul tip `ACTIVE` par `canonicalSeriesCode`
- cycles de remplacement refusés
- ordre canonical déterministe
- aucune suppression / mutation historique

## Identité d’observation

`MacroObservationIdentityCore/1` pinne une période économique pour une série.
Elle ne contient **ni valeur, ni release, ni séquence, ni path/URL**. Deux
vintages d’une même observation partagent le même `observationIdentityId`.

## Distinction identité / contenu de vintage

| Objet | Rôle |
| --- | --- |
| `MacroVintageIdentityCore/1` | Identité temporelle : observation + `availableAt` + séquence + `sourceDocumentId` |
| `MacroObservationVintageCore/1` | Contenu CAS : valeur fixed-point, `revisionKind`, parent, complétude, mode de résolution |

Deux contenus distincts sous la même identité temporelle →
`MARKET_DATA_MACRO_VINTAGE_CONFLICT`. La valeur ne fait **pas** partie de
l’identité logique.

## `availableAt` et `releaseTimeResolutionMode`

`availableAt` est l’autorité causale (UTC ISO strict, millisecondes pinées).

Modes fermés :

- `OFFICIAL_TIMESTAMP` — `releaseTimestamp` requis; `availableAt` = timestamp
  officiel normalisé UTC
- `SERIES_AUTHORITY_POLICY` — dérivation déterministe via une règle pinée
  (`sourceAuthority` + `canonicalSeriesCode` + timezone + heure civile)
- `UNKNOWN_REJECTED` — refuse l’ingestion; jamais stocké comme disponible

Interdits : `Date.now`, mtime, heure d’ingestion, timezone machine, UTC-5 fixe,
règle globale `DEFAULT_ALL_SERIES_08_30`.

## Policy d’ingestion

`MacroIngestionPolicy/1` est un singleton fermé V1
(`MACRO_INGESTION_L4B_I1_V1`) :

- scope de séries US fermé (FRB / NY Fed / Treasury / BLS / FOMC)
- `latestReferencePolicy = FORBIDDEN`
- `networkDuringComputationPolicy = FORBIDDEN`
- `registryMutationPolicy = APPEND_ONLY`
- classes de complétude et séries revision-sensitive / publication-attested
  listées explicitement

## Fixed-point

Valeurs wire `{ atoms: string, scale: integer }` sans `parseFloat` / `toFixed` /
`Math.round` / NaN / Infinity / `-0`. Compatibilité unit/scale vérifiée. I1 ne
calcule aucune transformation métier.

## Revisions, conflits, cycles, append-only

Kinds : `INITIAL | REVISION | CORRECTION | BENCHMARK_REVISION | WITHDRAWAL`.

Graph parental : acyclique, local à une observation, une seule chaîne active
(branches concurrentes = conflit). Registries série et vintage set :
append-only strict.

## `sourceDocumentId`

Référence CAS pinée dans le namespace `source`. Jamais une URL, un path, un
timestamp ou un hash absent du store. Le verifier charge et vérifie la
référence.

## Vintage set et snapshot

`MacroVintageSetManifest/1` pinne l’ensemble ordonné de vintages; compteurs,
bornes et digests sont **toujours recomputés**.

`MacroDatasetSnapshotManifest/1` pinne policy + registry + vintage set. Le
verifier reconstruit la valeur attendue et compare CanonicalJSON
byte-for-byte. Aucune référence `latest`, aucun timestamp de création, aucun
path.

## Empty snapshot

Registry configurable + vintage set vide → `observationCount = 0`,
`vintageCount = 0`, `firstAvailableAt = lastAvailableAt = null`,
`emptySnapshot = true`, digests d’arrays vides. Aucune date fabriquée.

## Replay, multi-store, anti-lookahead

- Replay dans un store neuf → mêmes bytes / IDs / digests / compteurs
- Multi-store A/B(/C) → IDs et bytes identiques
- Prefix invariance : objets futurs non pinés dans le store ne modifient pas un
  snapshot déjà piné
- Aucun scan global CAS pour chercher `latest`

## Schémas et modules

| Module | Rôle |
| --- | --- |
| `src/contracts/macroIngestionContractsL4BV1.mjs` | Normalizers, enums, digests, dérivation NY |
| `src/macro/macroIngestionPolicyL4BV1.mjs` | Builder / verifier policy |
| `src/macro/macroSeriesRegistryL4BV1.mjs` | Identités série + registry |
| `src/macro/macroObservationVintageL4BV1.mjs` | Observation + vintage identité/contenu |
| `src/macro/macroVintageSetL4BV1.mjs` | Vintage set + graph |
| `src/macro/macroDatasetSnapshotL4BV1.mjs` | Snapshot dataset |
| `test/helpers/independentMacroIngestionOracleL4BV1.mjs` | Oracle indépendant |

## Phase suivante

**L4B-I2** — resolver as-of, calendrier de publication, binding macro et
materialization report. Les contrats I1 ne doivent pas être rouverts pour
permettre ce resolver.
