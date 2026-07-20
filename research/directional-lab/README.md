# Directional Lab — Phase 1

Laboratoire de recherche directionnelle isolé et backtester causal.
**Research-only** : voir [RESEARCH_ONLY.md](./RESEARCH_ONLY.md). Aucune
influence sur la production, aucun signal réel, aucun réseau, aucun ordre.

## Objectif

Construire une fondation honnête pour tester plus tard : entrées, maintien,
protection des profits, sorties partielles/complètes, réentrées, régimes de
marché, confluences (tendance/momentum/volatilité/volume/contexte) et la
qualité directionnelle d'un sous-jacent utilisé dans une stratégie Wheel.

Phase 1 ne cherche **pas** la meilleure stratégie, ne garantit aucun
rendement, n'optimise aucun paramètre et n'entraîne aucun modèle.

## Architecture

```
research/directional-lab/
  RESEARCH_ONLY.md          statut research-only (à lire en premier)
  DATA_CONTRACT.md          contrat DailyBarV1, raw/adjusted, missingness
  TEMPORAL_RULES.md         invariants temporels (close t -> open t+1, etc.)
  RESEARCH_PROTOCOL.md      protocole anti-overfitting (walk-forward, etc.)
  config/
    research-universe.v1.json   120 titres research-only (IA + contrôles)
    pilot-universe.v1.json      sources locales découvertes et admissibles
    baseline-configs.v1.json    coûts + paramètres fixes des baselines
  src/
    cli.mjs                 point d'entrée unique
    contracts/              10 contrats V1 (bar, action, manifest, feature,
                            régime, signal, ordre, fill, trade, résultat)
    data/                   adaptateurs JSON/CSV read-only, normalisation,
                            validation, manifest+hash, découverte allowlist,
                            sélection de base de prix cohérente
    time/                   dates civiles UTC pures, sessions US (DST
                            déterministe), split chronologique, purge/embargo
    features/               rolling null-aware, MA/EMA, momentum, volatilité,
                            volume, structure, force relative, featureEngine
    regime/                 régime de marché V1 (QQQ/SPY requis, IWM/VIX
                            optionnels, UNKNOWN si couverture insuffisante)
    strategy/               interface commune + 4 baselines à paramètres fixes
    execution/              commission, slippage, fill open, stop gap-aware
    backtest/               position, portefeuille, moteur causal, walk-forward
    metrics/                rendements, drawdown, risque, trades, excursions
    reporting/              stdout, JSON déterministe, rapport qualité
  test/                     18 suites (114 tests) anti-look-ahead + fixtures
```

## Commandes

Toutes les commandes s'exécutent depuis la racine du dépôt, n'écrivent rien
par défaut (stdout seulement) et acceptent `--output CHEMIN` explicite.

```bash
# Valider un fichier de données local (read-only)
node research/directional-lab/src/cli.mjs validate --symbol APLD --input "debug/ohlc-cache-APLD.json"

# Construire un manifest (hash sha256, couverture, qualité)
node research/directional-lab/src/cli.mjs manifest --symbol APLD --input "debug/ohlc-cache-APLD.json"

# Calculer les features (snapshot par défaut : dernière séance)
node research/directional-lab/src/cli.mjs features --symbol APLD --input "debug/ohlc-cache-APLD.json" --price-basis SPLIT_ADJUSTED

# Lancer une baseline
node research/directional-lab/src/cli.mjs backtest --symbol APLD --input "debug/ohlc-cache-APLD.json" --strategy MA50 --price-basis SPLIT_ADJUSTED

# Pilote technique (6 symboles x 4 baselines, PILOT_TECHNICAL_ONLY)
node research/directional-lab/src/cli.mjs pilot

# Vérifier l'univers (doit compter exactement 120 après déduplication)
node research/directional-lab/src/cli.mjs universe-check

# Tests
node --test research/directional-lab/test/*.test.mjs
```

Stratégies disponibles : `BUY_HOLD`, `MA50`, `EMA21_EMA50`, `TREND_ATR`.
Bases de prix : `RAW`, `SPLIT_ADJUSTED`, `TOTAL_RETURN_ADJUSTED`,
`DERIVED_ADJUSTED` (refusée en mode strict; toujours flaggée).

## Formats supportés

- `OHLC_CACHE_JSON_V1` : les caches locaux `{symbol, rows:[{date, open,
  high, low, close, volume, [adjclose]}]}` présents sous `debug/` (lus en
  lecture seule, jamais modifiés ni stagés).
- `CSV_DAILY_V1` : CSV `date,open,high,low,close,volume[,adjclose]
  [,splitFactor][,cashDividend]`. Entêtes normalisées (`src/data/
  csvHeader.mjs`) : insensibles à la casse, au BOM UTF-8, aux espaces et
  aux underscores; synonymes usuels mappés (`Adj Close`, `Adjusted Close`,
  `session_date`, `split_factor`, `Dividend`, ...); colonnes inconnues
  signalées dans `ignoredColumns` (jamais interprétées); collisions après
  normalisation refusées (`CSV_HEADER_COLLISION`); lignes au mauvais nombre
  de cellules refusées avec leur numéro de ligne; champs entre guillemets
  hors périmètre (refus explicite).

## Corporate actions

Politique canonique par base dans `src/data/corporateActionPolicy.mjs`
(`splitFactor` = actions après/avant, ex. 2 = 2:1, 0.2 = reverse 1:5;
`cashDividend` = cash par action admissible à l'ex-date) :

- **RAW** : le moteur applique les splits à la position avant l'open
  (fractions refusées : `FRACTIONAL_SPLIT_RESULT_UNSUPPORTED`, pas de
  cash-in-lieu) et crédite les dividendes en cash sur la quantité détenue
  à la clôture précédente (droit causal : une vente à l'open de l'ex-date
  conserve le dividende, un achat à l'open ne le reçoit pas);
- **SPLIT_ADJUSTED** : splits jamais réappliqués (`SPLIT_ALREADY_EMBEDDED`);
  dividendes crédités lorsque les montants existent; split+dividende même
  séance **autorisé**;
- **TOTAL_RETURN_ADJUSTED** : rien n'est réappliqué ni crédité (déjà dans
  les prix, aucun double comptage); split+dividende informatif autorisé;
- **DERIVED_ADJUSTED** : toute corporate action refuse le backtest
  (`CORPORATE_ACTION_AMBIGUOUS_FOR_DERIVED_ADJUSTED`);
- **RAW** split + dividende la même séance : refus
  `CORPORATE_ACTION_ORDER_AMBIGUOUS`;
- dividende déclaré sans position : `CASH_DIVIDEND_NOT_ENTITLED`
  (cashImpact 0);
- CSV header-only / sans lignes de données : `CSV_NO_DATA_ROWS`.

Chaque événement laisse une trace déterministe dans
`corporateActionEvents` et les dividendes crédités s'additionnent dans
`totalDividendsCash`, séparés du PnL des trades, des commissions et du
slippage. Suites dédiées : `dividend-accounting.test.mjs`,
`raw-split-accounting.test.mjs`, `csv-header-normalization.test.mjs`,
`manifest-coverage.test.mjs`, `missing-reasons.test.mjs`,
`contract-hardening.test.mjs`, `correctif-a-p2.test.mjs`.

Le laboratoire n'écrit jamais hors de son dossier : aucune mémoire
d'agent, aucun index persistant, aucun checkpoint externe (scan
insensible à la casse / séparateurs dans
`no-production-coupling.test.mjs`; ce scan ne contrôle que le **code du
laboratoire**, pas le comportement global de l'agent). Les tests
utilisent uniquement le répertoire temporaire du système et
suppriment leurs fichiers.

## Reproduire un résultat

Le moteur est entièrement déterministe : aucun horodatage mural, aucun
aléatoire. Chaque `BacktestResultV1` porte un `resultHash` (sha256 de la
sérialisation stable triée). Relancer la même commande sur le même fichier
produit le même hash (`test/deterministic-results.test.mjs`).

## Ajouter plus tard…

- **Une source de données** : écrire un adaptateur dans `src/data/` qui
  produit des `DailyBarV1` via `normalizeDailyBars` en déclarant
  explicitement `ohlcBasis`; ne jamais mélanger raw et adjusted.
- **Une stratégie** : implémenter l'interface de
  `src/strategy/strategyInterface.mjs` (fonction `decide(ctx)` pure,
  aucun accès aux bougies futures, intents `ENTER_LONG/HOLD/REDUCE_25/
  REDUCE_50/EXIT/NO_ACTION`), l'enregistrer dans `STRATEGIES` de `cli.mjs`.
- **Un benchmark** : passer `benchmarks: {SYM: series}` au featureEngine ou
  au régime; série absente → `BENCHMARK_UNAVAILABLE`, date absente →
  `BENCHMARK_DATE_MISSING`.

## L1 — snapshots de données immuables (fixtures uniquement)

L1 sépare quatre identités : les octets source exacts (`sourceObjectId`),
les barres normalisées exactes (`normalizedObjectId`), le processus
déterministe (`DatasetSnapshotCore/1`) et une acquisition particulière
(`DatasetSnapshotRecord/1`). `sourceAcquiredAt` reste nullable et n’est
jamais déduit de `ingestedIntoLabAt`.

`CanonicalJSON/1` produit du JSON UTF-8 compact, sans BOM, avec clés triées
et exactement un LF inclus dans le SHA-256. La validation/normalisation reste
propre à chaque schéma; le sérialiseur générique ne connaît aucune règle
financière. Le manifest `TransformImplementationManifest/1` couvre une liste
explicite de modules par chemins logiques relatifs et hash de leurs octets.

Le CAS exige un root absolu déjà existant. Il peut créer ses sous-dossiers,
mais ne supprime jamais un objet permanent. Les URI sont relatives et
portables. Chaque lecture revérifie taille et SHA-256; chaque écriture prend
un lock par hash, écrit et synchronise un temporaire dans le même dossier,
puis publie par une primitive atomique sans remplacement ou échoue fermé.
Les locks abandonnés demandent une récupération administrative explicite.

Threat model L1 : protection contre erreurs de programmation, traversal,
chemins absolus, symlinks/junctions détectables, overwrite accidentel,
corruption, troncature, publication partielle et concurrence coopérative.
L1 ne prétend pas résister à un administrateur local hostile, un malware
privilégié, une course de remplacement de junction au niveau système, ni une
attaque kernel/filesystem.

Ce lot ne contient que des fixtures synthétiques. Il n’accède à aucun réseau,
n’implémente aucune stratégie et ne suppose aucun droit de redistribution de
données. Les tests CAS utilisent exclusivement le répertoire temporaire du
système; aucun CAS de test n’est écrit dans le dépôt.

## L2A — manifests de qualité de snapshot (fixtures uniquement)

L2A ajoute une enveloppe Phase 2 autour d'un snapshot L1, sans modifier
`DatasetManifestV1` ni aucun consommateur Phase 1 :

- **`SnapshotDatasetManifestV1`** référence le core et le record L1, une
  copie canonique optionnelle du `DatasetManifestV1` historique (pièce de
  preuve seulement : son `sourcePath` local est préservé mais n'entre jamais
  dans `snapshotCoreId`, `sourceObjectId` ni `normalizedObjectId`), plus des
  ensembles triés et uniques de vérifications de matérialisation et de
  records d'évaluation de qualité. Ajouter une évaluation publie un
  **nouveau** manifest; l'ancien reste immuable dans le CAS.
- **`DatasetMaterializationVerification/1`** rejoue réellement les octets
  source relus du CAS à travers le registre fermé `materializerRegistry/1`.
  L'API officielle accepte un `pipelineProfileId`, jamais des callbacks
  `adapt`/`normalize`. Le pipeline reçoit le snapshot core complet et
  recanonicalise en
  `CanonicalDailyBars/1`, recalcule le hash et le compare au
  `normalizedObjectId` attendu. Toute incohérence est `FAIL` (jamais
  `WARN`); rien n'est réparé ni réécrit. Un seul octet source changé ou une
  transformation différente produit un mismatch détecté.
- **`TransformImplementationManifest/2`** est le manifest officiel L2A.
  Sa politique `TransformSourceText/1` décode les modules JavaScript en UTF-8
  strict, refuse BOM, UTF-8 invalide et surrogates invalides, normalise CRLF
  et CR isolé vers LF, et préserve tout le reste ainsi que la présence d'une
  LF finale. V1 reste reconnu sans changement pour les preuves L1. Le manifest
  V2 canonique est stocké dans le CAS; son object ID est le
  `transformImplementationHash`.
- **`TransformPipelineProfileV1`** déclare explicitement les rôles du
  pipeline (`SOURCE_ADAPTER`, `DAILY_BAR_NORMALIZER`,
  `MATERIALIZER_REGISTRY`, `CANONICAL_DAILY_BARS`, `PRICE_BASIS_POLICY`, et
  `CORPORATE_ACTION_POLICY` lorsqu'exigée) avec chemins logiques ET hash de
  contenu. La couverture contre le `TransformImplementationManifest/2`
  transforme un module oublié ou modifié en erreur explicite. Liste
  explicite versionnée, pas d'analyse de dépendances transitives.
- **`DatasetQualityPolicyV1` + `DatasetQualityAssessmentCore/1` +
  `DatasetQualityAssessmentRecord/1`** séparent la politique versionnée et
  hashée, les faits déterministes d'une évaluation (aucune horloge murale,
  aucun chemin local, aucune note humaine) et son exécution horodatée
  (`assessedAt` injecté par l'appelant, jamais `Date.now()`). Mêmes faits →
  même core ID; deux exécutions → deux record IDs. Base d'évaluation
  `OBSERVED_SERIES_ONLY` : uniquement la série observée, aucun calendrier
  officiel, jour férié ou early close inventé. `PASS`/`WARN`/`FAIL` sont des
  statuts techniques des contrôles exécutés — aucun score sur 100, aucune
  admissibilité scientifique (`admissibleFor` est refusé par contrat), et un
  mouvement observé important reste un diagnostic, jamais un split confirmé.
  Le calcul read-only `computeDatasetSnapshotQualityAssessment` est séparé de
  la persistance. La vérification relit toute la provenance et recalcule le
  core exact; un check, une métrique, une raison ou un résumé forgé est refusé.
  `executionIdentity` est fermé à `{ runnerId, runId, environment }`, avec
  `environment` dans `LOCAL_TEST | LOCAL_MANUAL | CI`; chemins physiques et
  clés supplémentaires sont interdits.

Depuis un seul `SnapshotDatasetManifestV1`, la vérification traverse le
snapshot complet, chaque materialization verification, son profile et son
transform manifest V2, puis chaque record/core de qualité, sa policy et les
dépendances de matérialisation recalculées.

Ce lot reste entièrement sur fixtures synthétiques : aucun cache réel
(APLD, IONQ, TQQQ, TECL, SPY, QQQ, IWM, VIX, DIA) n'est importé.

### Objets CAS orphelins

Le CAS est append-only. Une opération multi-étapes (source → normalisé →
core → record → vérifications → évaluations → manifest) peut échouer après
avoir déjà écrit des objets : un objet source, normalisé, core ou quality
core peut donc exister sans manifest final. Un tel objet est un **orphelin
CAS**. Un orphelin n'est **pas** une corruption : il reste adressé par son
hash et vérifiable individuellement. Règles L1/L2A :

- aucun nettoyage automatique; aucun objet supprimé silencieusement;
- seul un `SnapshotDatasetManifestV1` vérifié représente un ensemble publié
  complet — le manifest est toujours la **dernière** écriture;
- aucun manifest incomplet n'est publié : si une étape échoue avant la
  publication, il n'existe simplement aucun manifest;
- les orphelins sont réutilisables tels quels lors d'une nouvelle
  tentative (même contenu → même ID → `created:false`);
- un futur garbage collector serait un lot séparé, explicite et audité —
  jamais un effet de bord.

Le test `l2a-integration.test.mjs` simule un échec d'écriture juste avant
la publication du manifest et vérifie ces garanties.

## L2B — identité permanente des instruments (fixtures uniquement)

L2B résout un problème distinct de L1/L2A : **un ticker n’est pas une
identité**. Un symbole peut changer, être réutilisé après radiation, différer
selon le fournisseur, ou coexister sur plusieurs marchés. L2B n’importe aucune
donnée réelle et n’appelle ni Yahoo ni IBKR. Aucun réseau.

### Authority policy et graine opaque

`InstrumentIdentityAuthorityPolicy/1` fixe le format de graine. La politique
initiale exige `identitySeedFormat = HEX_LOWERCASE` et
`identitySeedLength = 64` (256 bits en hex minuscule). Le builder **ne génère
jamais** de graine : l’appelant fournit un token conforme.

Le système garantit le **format opaque**, pas l’intention humaine. Un ticker
comme `APLD` est refusé parce qu’il viole la policy, pas parce qu’il serait
« mathématiquement impossible » en dehors de cette policy. Même policy + même
seed + même `instrumentKind` → même `instrumentIdentityId`.

### Ticker vs identité

| Concept | Rôle |
|---------|------|
| `authorityPolicyId` | Policy CAS qui contraint le format de seed |
| `instrumentIdentityId` | Identité opaque permanente (= object ID du `InstrumentIdentityCore/1`) |
| `identitySeed` | Token opaque hex 64 fourni explicitement — jamais un ticker libre |
| Alias (`InstrumentAliasBindingCore/1`) | Symbole historique dans un namespace versionné, `[from, toExclusive)` |
| Révocation explicite | Coupe la période active ; le binding original reste intact |
| Provider binding | Identifiant stable propre au fournisseur (pas un ticker) |
| Descriptor | Noms / devise / statut ; `instrumentKind` doit matcher l’identity core |
| Registry global | Ensemble autoritatif de manifests + snapshot bindings |

### Chaîne d’objets (registre global)

```text
InstrumentIdentityAuthorityPolicy/1
  → InstrumentIdentityCore/1
  → InstrumentIdentityRecord/1
  → InstrumentDescriptorCore/1
  → SymbolNamespacePolicy/1          (namespaceId + namespaceVersion explicite)
  → InstrumentAliasBindingCore/1
  → ProviderInstrumentBindingCore/1
  → InstrumentAliasRevocationCore/1 / ProviderInstrumentRevocationCore/1
  → InstrumentIdentityManifest/1     (append-only récursif via supersedes)
  → DatasetSnapshotInstrumentBinding/1
  → InstrumentIdentityRegistryManifest/1   (registre global append-only)
```

Tous ces schémas sont enregistrés de façon **additive** dans le namespace CAS
`snapshots`. Les contrats L1/L2A publiés ne sont pas modifiés.

Les `evidenceObjectIds` génériques sont **retirés** de L2B : aucun contrat de
preuve vérifiable n’existe encore ; des hashes non relus ne sont pas acceptés.

### Registre global et résolution officielle

Le resolver officiel accepte **uniquement** :

```text
resolveInstrumentIdentityAsOf({ store, registryManifestId, namespacePolicyId,
  providerId, venueId, symbol, currency, asOfDate })
```

Il refuse `identityManifestId`, `identityManifestIds`, `manifests` et
`aliases`. Omettre un manifest concurrent est donc impossible : le registre
est reluj et vérifié en entier (chaîne `supersedes` incluse). Les manifests
historiques restent listés (append-only) ; résolution et unicité utilisent
les manifests tip.

Unicité globale vérifiée à la construction du registre :

- aliases actifs (même namespace/provider/venue/lookup/currency + chevauchement)
  → `INSTRUMENT_ALIAS_AMBIGUOUS` ;
- provider IDs (même provider + providerInstrumentId + chevauchement, identités
  distinctes) → `PROVIDER_INSTRUMENT_BINDING_AMBIGUOUS` ;
- un `snapshotCoreId` → au plus une identité (doublons sémantiquement
  identiques tolérés) → sinon `SNAPSHOT_INSTRUMENT_BINDING_CONFLICT`.

Résultats as-of : `RESOLVED`, `INSTRUMENT_ALIAS_NOT_FOUND`,
`INSTRUMENT_ALIAS_AMBIGUOUS`, `INSTRUMENT_ALIAS_REVOKED`,
`SYMBOL_NAMESPACE_MISMATCH`.

### Append-only

Si `M2.supersedesManifestId = M1`, tous les sets d’IDs de M1 sont inclus dans
M2 (records, descriptors, aliases, providers, révocations). Même règle pour
les registres : `identityManifestIds` et `snapshotInstrumentBindingIds` du
précédent sont conservés. La chaîne entière est reparcourue ; une dépendance
ancienne manquante ou corrompue bloque la tip.

### Révocations

Plus de pseudo-révocation via `bindingStatus = REVOKED`. Une révocation
référence explicitement le binding révoqué, la même identité, une
`effectiveFrom ≥ validFrom`, et un `reasonCode` fermé. Le binding actif ne
gagne jamais contre sa révocation à/après la date effective.

### Séparation L2B / L2C

L2B ne modélise **pas** les corporate actions (splits, dividendes, fusions).
Ces événements appartiennent au ledger L2C.

### Tests

La suite `test/instrument-identity-l2b.test.mjs` couvre authority/seed,
registre global, unicité aliases/providers/snapshots, append-only, chaînes
historiques, révocations, namespace versionné, cohérence descriptor, entrées
invalides, récupération ID-only et un E2E synthétique. Aucun réseau, aucune
donnée réelle.

## L2C — registre bitemporel des corporate actions

L2C complète les couches sans les redéfinir : L1 conserve les snapshots
immuables, L2A leurs preuves et évaluations, L2B l'identité permanente des
instruments, et L2C l'identité permanente B2 des événements, leurs claims et
leur résolution temporelle. Les fixtures L2C sont exclusivement synthétiques;
aucun réseau, fournisseur réel ou code de production n'est utilisé.

L'identité `CorporateActionIdentityCore/1` contient seulement une policy
d'autorité et un seed hexadécimal fourni par l'appelant. Ticker, instrument,
provider, date, ratio et horloge n'entrent jamais dans cette identité. Les
instruments concernés sont des `CorporateActionParticipantCore/1` séparés :
un événement multi-instruments (fusion, spin-off, conversion) doit donc être
indexé par chaque ledger instrument participant.

Le DAG CAS autorisé est :

```text
InstrumentIdentityRegistryManifest (L2B, piné)
Policies / TimeZoneRuleset
  -> CorporateActionIdentityCore
  -> SourcePayload -> SourceAttestation -> Observation -> ObservationRecord
  -> ProviderBinding / Participant / Revision / Adjudication
  -> CorporateActionEventManifest
  -> InstrumentCorporateActionLedgerManifest
  -> CorporateActionRegistryManifest
  -> PriceAdjustmentPlan / EntitlementPlan
  -> CorporateActionPlanManifest
  -> DatasetSnapshotCorporateActionBinding
  -> DatasetSnapshotCorporateActionBindingAuthorityPolicy
  -> DatasetSnapshotCorporateActionBindingRegistryManifest
```

`CorporateActionRegistryManifest/1` pinne obligatoirement un
`InstrumentIdentityRegistryManifest/1` L2B. L'existence physique d'un core L2B
dans le CAS ne suffit pas : chaque `instrumentIdentityId` participant doit
appartenir à l'ensemble autoritaire reconstruit depuis ce registre piné.
Le graphe reste acyclique (L2B ne référence jamais L2C).

Le registry corporate-action est autoritaire et ne référence jamais un plan ou
un binding snapshot. Events, ledgers, registry, plan manifests et binding
registries sont append-only; chaque vérification reparcourt les ancêtres et
relit les dépendances CAS. La récupération depuis le seul ID du registry L2C
couvre le registre L2B piné, les manifests/cores d'identité, ledgers, events,
observations, records, provenance, bindings provider, participants, révisions,
adjudications, policies et rulesets atteignables.

Pour un `bindingRegistryManifestId` autoritaire explicitement piné, un
`snapshotCoreId` possède au plus un binding cohérent. La vérification
structurelle individuelle d'un binding ne prouve pas l'unicité globale parmi
toutes les racines CAS possibles.

La bitemporalité sépare date économique et temps de connaissance. L'API
officielle exige `registryManifestId` et `knowledgeCutoff`; une information est
visible seulement si `knowledgeTimeUpperBound <= knowledgeCutoff`. Il n'existe
aucun « latest » implicite. En précision `DATE_ONLY`, les bornes UTC sont
relues dans une table `TimeZoneRuleset/1` stockée en CAS : ni ICU, ni `Intl`, ni
timezone locale ne recalculent ces bornes.

La provenance embedded conserve réellement le JSON canonique ou le texte UTF-8
(maximum 1 048 576 octets) avec digest et longueur recalculés. Le mode
digest-only est une attestation, jamais une promesse de récupération du
document. L2C refuse les secrets et localisateurs sensibles détectables dans
ses champs structurés et applique un filtrage best-effort au contenu
embedded. Le système ne peut pas prouver qu'un payload arbitraire ne
contient aucune information sensible. L'appelant doit fournir un
payload synthétique, public ou préalablement expurgé.

Une observation reste immuable même si elle est erronée; les corrections sont
de nouvelles révisions (`revisionReasonCode` fermé) et les décisions sont des
adjudications append-only (`decisionReasonCodes`) qui doivent considérer
toutes les observations visibles. Un changement de `eventKind` exige une
reclassification explicite adjudiquée; il n'y a pas de mutation silencieuse.

Les plans de prix sont distincts des entitlements. `RAW` ne transforme pas les
OHLCV; `SPLIT_ADJUSTED` produit des facteurs rationnels exacts pour split,
reverse split et stock dividend; `PROVIDER_ADJUSTED` exige une déclaration
fermée empêchant l'ambiguïté de double ajustement. Le producteur total-return
est hors V1. Dividendes cash et ajustements de quantité restent dans le plan
d'entitlements et ne modifient jamais une série RAW. Fusions, spin-offs,
conversions, liquidations et règles économiques incomplètes échouent de façon
fermée plutôt que d'être ajustés arbitrairement.

Les suites permanentes `test/corporate-action-l2c.test.mjs` et
`test/corporate-action-l2c-r1.test.mjs` couvrent identité B2, pin L2B
autoritaire, rulesets, provenance best-effort, anti-fuite 2:1/3:1, append-only,
récupération ID-only, plans séparés, binding registry autoritaire,
reclassification explicite, cardinalité des rôles et entrées publiques invalides.

## L3-I1 — fondations market data

L3-I1 ajoute exactement douze schémas CAS, sans produire de snapshot L1 réel
ou synthétique et sans modifier L1/L2A/L2B/L2C :

```text
MarketCalendarAuthorityPolicy/1
MarketSessionCalendarCore/1
MarketCalendarRegistryManifest/1
MarketDataIngestionPolicy/1
MarketDataIngestionLineageCore/1
MarketDataIngestionRegistryAuthorityPolicy/1
MarketDataSourceArtifactCore/1
MarketDataSourceAttestationCore/1
MarketDataAcquisitionRecordCore/1
MarketDataParseResultCore/1
MarketDataSourceTemporalEvidenceCore/1
MarketDataBarIdentityCore/1
```

Toutes les API publiques échouent avec `MarketDataL3Error { code, message,
details }`, jamais avec un `TypeError` brut. Les champs inconnus, versions de
schéma non supportées, références absentes, corrompues ou du mauvais type sont
distingués. Les builders publient dans le namespace CAS `snapshots`, relisent
l'objet publié et les verifiers repartent de l'ID CAS. Le registre calendrier
est récupérable depuis son seul ID et reparcourt toute sa chaîne `supersedes`.

### Calendrier

`MarketSessionCalendarCore/1` transporte uniquement des sessions explicites
dans une couverture civile demi-ouverte. Une date fermée est une absence de
session : aucune règle lundi-vendredi n'est inventée. `openUtc`, `closeUtc` et
`marketValidTime` sont fournis; `marketValidTime` doit être exactement le
close. `REGULAR_SESSION` et `HALF_DAY_SESSION` sont autorisés par une policy
de venue (`ARCX`, `XNAS`, `XNYS`) qui pinne un `TimeZoneRuleset/1` CAS.
Le module legacy `time/marketSession.mjs` n'est jamais importé par L3.

Un registre calendrier est append-only. Les intervalles de couverture doivent
former une couverture continue; des cores peuvent se chevaucher uniquement
si toute session commune est identique. La vérification ne prétend rien sur
un sibling qui n'est pas dans la chaîne du registry ID explicitement pinné.

### Policy d'ingestion et lignée

La policy V1 ferme les domaines suivants : instruments `EQUITY`, `ETF`,
`ETN`; fréquence `DAILY_REGULAR_SESSION`; bases `RAW`, `SPLIT_ADJUSTED`;
dataset `EOD_OHLCV`; formats `CSV_UTF8`, `CANONICAL_JSON`; unknown fields
`REJECT`; doublons identiques `REJECT` ou `ACCEPT_IDENTICAL`; volume
`NULLABLE_NON_NEGATIVE_DECIMAL_STRING`. `maxArtifactBytes` est un entier sûr
strictement positif. Aucune compression, URL ou chemin n'est un paramètre V1.

Modes de connaissance :

- `CAPTURE_TIME_ONLY` exige les deux noms de champs fournisseur à `null`;
- `PROVIDER_PUBLICATION_TIME_ATTESTED` exige
  `providerPublicationTimeField`;
- `PROVIDER_REVISION_HISTORY_ATTESTED` exige le champ de publication et
  `providerRevisionIdField`.

`MarketDataIngestionLineageCore/1` contient seulement provider, identité
instrument, fréquence, venue, base de prix et type de dataset. Les IDs des
registres L2B, calendrier et L2C sont des contextes d'autorité externes fournis
au builder/verifier; ils n'entrent jamais dans le core. Un descendant de
registre conserve donc l'ID de lignée, tandis qu'un changement de provider ou
de base de prix le change.

### Provenance, parsing et preuve temporelle

Un `MarketDataSourceArtifactCore/1` référence uniquement des octets déjà
capturés dans le CAS source. Digest, longueur, limite de taille, format et
media type sont revérifiés. Le screening de secrets structurés est
best-effort : il ne prouve pas qu'un payload arbitraire est exempt de secrets.

`MarketDataSourceAttestationCore/1` est une union fermée. Le mode
`EMBEDDED_ARTIFACT` pinne l'artifact et garde les quatre champs digest-only à
`null`; les valeurs effectives sont relues depuis l'artifact. Le mode
`DIGEST_ONLY` conserve digest, longueur, format et provider, sans promettre la
récupération d'octets. Ce lot ne publie aucun snapshot officiel à partir du
mode digest-only.

`MarketDataAcquisitionRecordCore/1` exige un `acquisitionTimeUtc` explicite,
le endpoint logique fermé `EOD_OHLCV_DATASET`, le dataset `EOD_OHLCV` et une
`executionIdentity` fermée `{ runnerId, runId, environment }`. Aucun appel à
`Date.now()` n'est utilisé pour construire un fait d'acquisition.

Le builder de `MarketDataParseResultCore/1` relit l'artifact embedded et parse
strictement `CSV_UTF8` ou une table `CANONICAL_JSON { headerFields, rows }`.
Il conserve header, ordre des lignes, cellules textuelles, ligne vide ou
fautive, digest par ligne et erreurs syntaxiques; aucune décision économique
n'est prise. Le verifier reparse les octets et compare le résultat canonique.

Une `MarketDataSourceTemporalEvidenceCore/1` doit pointer une cellule exacte
du ParseResult : index, chemin `/cells/<index>`, valeur brute et digest sont
revérifiés. Le timestamp V1 est un instant UTC strict. Une preuve de révision
exige en plus que `providerRevisionId` soit présent dans le champ fournisseur
épinglé de la même ligne. Une valeur fournie seulement par l'appelant n'est
jamais une preuve.

### Identité de barre

`MarketDataBarIdentityCore/1` contient exactement identité instrument,
fréquence, venue, date de session et `sessionKind = DAILY_REGULAR_SESSION`.
Provider, base de prix, lignée, registre, calendrier, timestamp, ticker,
prix et volume sont exclus. La même barre garde donc le même ID entre deux
providers, deux bases de prix ou deux descendants de registre.

Les suites synthétiques permanentes sont
`test/market-data-l3-i1.test.mjs` et
`test/market-data-l3-i1-adversarial.test.mjs`. Elles n'utilisent ni réseau,
ni Yahoo, ni IBKR, ni données réelles.

## L3-I2 — candidats normalisés et delta de révisions

L3-I2 ajoute exactement huit schémas CAS, sans implémenter un ingestion
manifest, un registre d'ingestion final, un resolver as-of ou un snapshot :

```text
MarketDataNormalizedCandidate/1
MarketDataCandidateSetCore/1
MarketDataValidationReport/1
MarketDataBarObservationCore/1
MarketDataBarCorrectionCore/1
MarketDataAcceptedCandidatePublicationManifest/1
NormalizedMarketDataDeltaChunk/1
NormalizedMarketDataDeltaAssemblyManifest/1
```

`MarketDataNormalizedCandidate/1` est une union fermée discriminée par
`candidateKind`. Les cinq variantes sont `BAR_INITIAL_VALUE`,
`BAR_VALUE_REVISION`, `BAR_WITHDRAWAL`, `BAR_RESTORATION` et
`SESSION_DATE_CORRECTION`. Un champ appartenant à une autre variante est
refusé. Les valeurs OHLCV sont des chaînes d'atoms décimaux avec scales
entières de 0 à 18; aucun float ne porte l'autorité. Le volume reste nullable
avec l'équivalence stricte `volumeAtoms = null` si et seulement si
`volumeScale = null`. Les bases V1 restent `RAW` et `SPLIT_ADJUSTED`.

Les trois modes temporels I1 sont projetés sans contamination :

- `CAPTURE_TIME_ONLY` conserve lower à `null`, upper à l'acquisition et
  evidence/revision à `null`, même si la policy expose des champs provider;
- `PROVIDER_PUBLICATION_TIME_ATTESTED` exige une preuve de publication et des
  bornes égales à son timestamp;
- `PROVIDER_REVISION_HISTORY_ATTESTED` exige la même égalité et le même
  `providerRevisionId` que la preuve de révision.

Le CandidateSet ne contient aucune disposition. Il ferme une acquisition, un
ParseResult, une policy, une lignée et les registres L2B/L2C/calendrier
explicitement pinnés. Le validator reçoit une vue de base explicite : IDs de
corrections visibles et terminales, identités occupées/publiées et pins du
registre d'ingestion synthétique. Il n'existe aucun « current tip » implicite
et aucun « latest ». I2 ne découvre pas d'état global et ne choisit aucun tip
implicite : la complétude de la vue est l'autorité explicitement pinnée fournie
par la couche d'ingestion future. Tout élément fourni est recoupé contre le
graphe visible (terminaux dérivés, lignée, barre, cycles, branches) ; I2 ne
prétend pas découvrir des corrections omises de la vue. I3 rendra cette vue
récupérable depuis le registre canonique. Les `terminalCorrectionIds` fournis
ne sont jamais l'autorité : ils doivent égaler exactement les feuilles dérivées
du graphe visible. Le ValidationReport partitionne exactement le CandidateSet
en `ACCEPTED`, `REJECTED`, `QUARANTINED`, `DUPLICATE` ou `CONFLICTING`; ses
reason codes, fatal errors et warnings sont fermés, triés et uniques. Un
rapport avec `fatalErrors` non vides ne peut contenir aucune décision
`ACCEPTED`. Les dispositions stockées ne sont jamais une autorité autonome :
avant toute publication, le publisher réexécute le validateur déterministe
canonique sur la vue pinnée et refuse toute divergence avec
`MARKET_DATA_VALIDATION_FAILED`.

Une observation est la projection immuable et sans perte d'un candidat
accepté. Une correction est l'un des six nœuds fermés `INITIAL_ROOT`,
`VALUE_REVISION`, `WITHDRAWAL`, `RESTORATION`,
`SESSION_DATE_WITHDRAWAL` ou `SESSION_DATE_REPLACEMENT`. Une correction de
date est une paire explicite : retrait de l'ancienne identité puis racine de
remplacement liée au retrait. Parent absent, invisible, étranger, stale,
branche concurrente et destination occupée échouent avec des codes distincts.

L'ordre d'autorité est : CandidateSet, ValidationReport, objets acceptés,
publication manifest, delta chunks, delta assembly. Les objets physiques CAS
ne deviennent pas autoritaires hors du publication manifest. L'assembly est
strictement delta-only : son union d'observations/corrections égale à la fois
l'union des chunks et le publication manifest; aucun historique antérieur ni
objet rejeté n'est admis. La taille maximale V1 est
`MAX_NORMALIZED_MARKET_DATA_DELTA_CHUNK_SIZE_V1 = 100` objets par chunk. Les
plages sont civiles, demi-ouvertes et exactes.

Si aucun candidat n'est accepté, le publisher ne crée aucun publication
manifest, chunk ou assembly et retourne `NO_AUTHORITATIVE_DELTA` avec deux IDs
à `null`. Un succès avec au moins un candidat accepté retourne exactement
`PUBLISHED` (aucun alias). Une erreur fatale ou un rapport non recomputable
retourne `MARKET_DATA_VALIDATION_FAILED`. Une restauration n'accepte que
l'observation effectivement en vigueur immédiatement avant le `WITHDRAWAL`
ciblé.

Les suites permanentes `test/market-data-l3-i2.test.mjs` et
`test/market-data-l3-i2-adversarial.test.mjs` utilisent uniquement des
fixtures synthétiques. Le second test génère son harness de contre-tests sous
`os.tmpdir()`; aucun harness temporaire n'est écrit dans le dépôt.

## L3-I3 — manifeste d'ingestion et registre autoritaire

L3-I3 ajoute exactement deux schémas CAS et l'orchestration déterministe
`runIngestion`. Les objets I2 peuvent exister physiquement dans le CAS sans
être autoritaires : seule une entrée dans un
`MarketDataIngestionRegistryManifest/1` explicitement piné constitue la
frontière d'autorité.

```text
MarketDataIngestionManifest/1
MarketDataIngestionRegistryManifest/1
```

Le manifeste d'ingestion est strictement delta-only. Il ferme la lignée, la
policy, les registres L2B/L2C/calendrier pinés, l'artifact/attestation/
acquisition, le ParseResult, le CandidateSet, le ValidationReport, le
publication manifest I2 et le delta assembly. Les tableaux
`newBarObservationIds` / `newBarCorrectionIds` sont triés, uniques, et égaux
exactement aux unions du publication manifest et de l'assembly. Un parent
historique référencé par une correction n'est jamais ajouté comme nouvel
objet du delta.

`priceBasis` et `corporateActionTreatment` sont dérivés (jamais acceptés comme
vérité libre) :

```text
RAW ↔ RAW_SOURCE_UNTRANSFORMED
SPLIT_ADJUSTED ↔ PROVIDER_SPLIT_ADJUSTED_UNTRANSFORMED
```

`temporalCapability` est le minimum des modes de connaissance des objets
contributifs de cette ingestion :

```text
CAPTURE_TIME_ONLY → RETROSPECTIVE_CAPTURE_ONLY
PROVIDER_PUBLICATION_TIME_ATTESTED → POINT_IN_TIME_PUBLICATION_ATTESTED
PROVIDER_REVISION_HISTORY_ATTESTED → POINT_IN_TIME_REVISION_HISTORY_ATTESTED
```

Le registre est append-only, racine vide autorisée, tips par lignée, aucun
« latest » global, aucune recherche globale de tip. L'API fermée
`appendMarketDataIngestionRegistry` exige le registre de base piné, le parent
attendu (y compris `null` pour une première tip) et un seul
`ingestionManifestId`.

`runIngestion` orchestre parse → normalisation atoms-table fermée →
`validateMarketDataCandidateSet` → `publishValidatedMarketDataDelta` (publisher
I2 durci obligatoire) → manifeste d'ingestion → append du registre. Zéro
accepted non fatal → `NO_AUTHORITATIVE_DELTA` sans nouveau manifeste ni
registre. Fatals → `MARKET_DATA_VALIDATION_FAILED`, jamais convertis en no-op.
Aucun snapshot officiel n'est produit en I3.

La normalisation économique V1 n'accepte que la table atoms fermée dont les
noms de colonnes sont des champs de contrats existants (replacementValues,
pins CandidateSet, `sessionDate`, `knowledgeMode`, plus les champs temporels
déclarés par la policy). Aucun mapping de colonnes fournisseur n'est inventé.

Les suites `test/market-data-l3-i3.test.mjs` et
`test/market-data-l3-i3-adversarial.test.mjs` utilisent uniquement des
fixtures synthétiques. Le harness adversatif vit exclusivement sous
`os.tmpdir()`.

## L3-I4 — resolver point-in-time (série résolue)

L3-I4 répond exactement à : sous un registre d'ingestion explicitement piné
et un instant `knowledgeCutoff`, quelle série de marché était prouvablement
connaissable à cet instant? Il n'ajoute aucun snapshot L1 officiel, aucun
schéma I5, aucun réseau, aucun Yahoo/IBKR, et aucun impact sur le scanner
ou le dashboard de production.

Contrat ajouté (71 schémas canoniques au total) :

```text
MarketDataResolvedSeriesManifest/1
```

Chaîne d'autorité :

```text
MarketDataIngestionRegistryManifest
→ chaîne autoritaire de MarketDataIngestionManifest
→ observations et corrections autoritaires
→ filtrage objet par objet au cutoff
→ reconstruction des chaînes visibles
→ tip visible par barIdentityId
→ MarketDataResolvedSeriesManifest
```

### API fermée

```js
resolveMarketDataAsOf({
  store,
  ingestionRegistryManifestId,
  ingestionLineageId,
  knowledgeCutoff,
})

buildMarketDataResolvedSeriesManifest({
  store,
  ingestionRegistryManifestId,
  ingestionLineageId,
  knowledgeCutoff,
  corporateActionRegistryManifestId,
})

verifyMarketDataResolvedSeriesManifest({
  store,
  resolvedSeriesManifestId,
})

verifyMarketDataResolvedSeries({
  store,
  resolvedSeriesManifestId,
  ingestionRegistryManifestId,
})
```

Toutes les clés sont obligatoires. Aucun registre, lignée ou cutoff implicite.
Aucun read model libre fourni par l'appelant. Aucune horloge système.

### Visibilité objet par objet

La règle canonique est `knowledgeTimeUpperBound <= knowledgeCutoff`, appliquée
à chaque observation et chaque correction. Une même ingestion peut contenir
simultanément un objet visible et un objet invisible. Le filtrage n'est jamais
fait seulement au niveau de l'ingestion.

`knowledgeCutoff` est un instant UTC canonique explicite fourni par l'appelant.
Il définit la borne supérieure de connaissance prouvable; il n'est pas « now »
et ne lit jamais `Date.now()`.

Modes :

- `CAPTURE_TIME_ONLY` — visible si `acquisitionTimeUtc <= knowledgeCutoff`;
- `PROVIDER_PUBLICATION_TIME_ATTESTED` — une acquisition tardive peut être
  visible historiquement si la publication attestée est ≤ cutoff;
- `PROVIDER_REVISION_HISTORY_ATTESTED` — une correction acquise tardivement
  peut être visible historiquement si sa révision attestée était disponible
  ≤ cutoff.

Aucune rétroactivité sans preuve.

### Connaissance historique non prouvable

Si la lignée a des objets autoritaires mais qu'aucun n'est visible au cutoff
(ex. première capture-only le 2026-07-18, cutoff 2026-06-01), le resolver
refuse avec `MARKET_DATA_HISTORICAL_KNOWLEDGE_NOT_PROVABLE`. Une série vide
n'est jamais retournée comme état historique valide.

### Chaînes de corrections et tips

Les corrections visibles sont regroupées par
`(ingestionLineageId, barIdentityId)`. Les arêtes
`parentCorrectionId → childCorrectionId` sont reconstruites; racine unique,
parent récupérable et visible, même lignée/barre, aucun cycle, aucune branche,
aucun root concurrent. Les tips ne sont jamais choisis par ordre CAS ni par
ordre d'insertion.

Dispositions fermées : `PRESENT`, `WITHDRAWN`, `MOVED_TO_OTHER_SESSION`.

### Préfixe contributif et non-interférence

`contributingRegistryPrefixId` est le premier registre de la chaîne
racine → pin d'appel qui liste tous les ingestion manifests contributifs.
Appendre une ingestion future non contributive sous un pin descendant produit
le même manifeste logique (même `resolvedSeriesManifestId`). Une révision
historique tardive mais prouvablement antérieure au cutoff devient
contributive : le préfixe et l'ID du manifeste changent.

### Capacité temporelle et pins

`temporalCapability` est le minimum dérivé des modes de connaissance de tous
les objets contributifs. Une capacité persistée divergente est refusée. Les
pins identité, calendrier et corporate-action sont dérivés des contributeurs
(chaîne unique, couverture des sessions, pin descendant le plus avancé).
Aucune transformation de prix L2C n'est appliquée en I4; bases et treatments
mixtes sont refusés.

### Limites honnêtes d'I4

I4 ne gère pas encore : macro, Fed, features, modèle prédictif, classement
SAFE/BALANCED/AGRESSIVE, scanner de production, ni snapshots L1 officiels.
Il résout uniquement la série de marché prouvable sous un pin et un cutoff.

Les suites `test/market-data-l3-i4.test.mjs` et
`test/market-data-l3-i4-adversarial.test.mjs` utilisent uniquement des
fixtures synthétiques. Le harness adversatif vit exclusivement sous
`os.tmpdir()`.

## L3-I5 — matérialisation officielle de snapshot (source bundle + politique)

L3-I5 répond exactement à : quel dataset byte-reproductible a été matérialisé
à partir de cette série point-in-time, selon quelle politique, avec quelles
sources et quel résultat d'intégrité?

Frontière nette :

```text
L3-I4 → décide quelles observations sont historiquement visibles
L3-I5 → matérialise exactement ces observations dans un snapshot officiel
```

L3-I5 ne refait pas la résolution temporelle. Aucune recherche `latest`.
Aucune transformation de prix (pas de split adjust, pas de total return, pas
de forward-fill, pas d'indicateur).

**L3-I5 est un pipeline de recherche hors ligne. Il ne fait partie d'aucun
chemin critique de scan.**

Contrats ajoutés (74 schémas canoniques au total) :

```text
MarketDataSnapshotSourceBundle/1
MarketDataSnapshotMaterializationPolicy/1
MarketDataSnapshotMaterializationReport/1
```

Contenu normalisé L1 additif (namespace `normalized`, hors décompte 74) :

```text
MarketDataEodOhlcvCanonicalRows/1
```

Cette extension L1 minimale est nécessaire parce que `CanonicalDailyBars/1`
force des nombres IEEE et ne peut pas préserver les atomes/échelles L3 sans
coercition. Le writer/verifier L1 existants acceptent désormais ce second
schéma de contenu, sans second stockage ni second hash.

### Source bundle

Dérivé uniquement d'un `MarketDataResolvedSeriesManifest/1` pleinement
vérifié. Les listes contributives ne sont jamais acceptées de l'appelant.
Un pin de registre descendant du préfixe contributif est accepté; un pin
sibling est refusé.

### Politique fermée

Une seule politique V1, sans paramètre économique libre :

- format `MARKET_DATA_EOD_OHLCV_CANONICAL_ROWS_V1`
- `PRESENT_ONLY` / `SESSION_DATE_THEN_BAR_IDENTITY`
- `WITHDRAWN` et `MOVED_TO_OTHER_SESSION` omis (aucune ligne de prix pour
  l'ancienne identité)
- `priceTransformation = NONE`, `corporateActionTransformation = NONE`
- sérialisation `CanonicalJSON/1`, atomes L3 préservés

### Projection et ordre

Une ligne par entrée `PRESENT`, ordonnée par `sessionDate` puis
`barIdentityId`. L3-I4 garantit une seule lignée/instrument; la dimension
multi-instrument n'est pas inventée. Les atomes OHLCV, la devise et la
`priceBasis` viennent de l'observation résolue; la `sessionDate` vient de
l'identité de barre.

### Stockage L1 officiel

```text
lignes canoniques
→ CanonicalJSON/1
→ buildDatasetSnapshot (writer L1)
→ SnapshotDatasetManifestV1
→ verifyDatasetSnapshot + verifySnapshotDatasetManifest
→ MarketDataSnapshotMaterializationReport/1
```

Snapshots vides officiels supportés (`MATERIALIZED_EMPTY`) lorsqu'aucune
entrée n'est `PRESENT`.

### API

```js
buildMarketDataSnapshotSourceBundle({ store, resolvedSeriesManifestId, ingestionRegistryManifestId })
verifyMarketDataSnapshotSourceBundle({ store, snapshotSourceBundleId, ingestionRegistryManifestId })
buildMarketDataSnapshotMaterializationPolicy({ store })
materializeMarketDataSnapshot({
  store, ingestionRegistryManifestId, resolvedSeriesManifestId, materializationPolicyId,
})
verifyMaterializedMarketDataSnapshot({
  store, ingestionRegistryManifestId, materializationReportId,
})
```

### Propriétés

- Idempotence : mêmes IDs malgré l'ordre CAS, les orphelins, le replay.
- Non-interférence : append futur non contributif → mêmes IDs; révision
  historique contributive → nouveaux IDs.
- Échec atomique : relance après arrêt partiel → mêmes IDs, aucun faux
  rapport, aucun `latest`.
- Provenance fermée : snapshot → report → policy → source bundle →
  resolved-series → préfixe → ingestions → acquisitions → artifacts →
  observations → corrections → identité / calendrier / corporate-action.

### Limites honnêtes d'I5

I5 ne publie pas encore le binding officiel ni le registre append-only
(ces contrats appartiennent à I6, ci-dessous). Pas de macro, pas de Fed,
pas de features, pas de modèle, pas de réseau, pas d'API Yahoo/IBKR,
aucun impact scanner.

Les suites `test/market-data-l3-i5.test.mjs` et
`test/market-data-l3-i5-adversarial.test.mjs` utilisent uniquement des
fixtures synthétiques. Le harness adversatif (50 contre-tests) vit
exclusivement sous `os.tmpdir()`.

## L3-I6 — Binding officiel de snapshot et registre append-only

L3-I6 est la dernière phase de l'infrastructure L3. Elle publie un binding
officiel et versionné entre :

```text
MarketDataResolvedSeriesManifest/1
MarketDataSnapshotSourceBundle/1
MarketDataSnapshotMaterializationPolicy/1
MarketDataSnapshotMaterializationReport/1
snapshot L1 officiel
évaluation de qualité L2A
```

puis l'inscrit dans un registre append-only explicitement piné :

```text
série point-in-time I4
→ matérialisation I5
→ snapshot L1
→ évaluation de qualité L2A
→ MarketDataDatasetSnapshotBinding/1
→ MarketDataDatasetSnapshotBindingRegistryManifest/1
```

L3-I6 répond exactement à : quel snapshot officiel, quelle série historique,
quelle politique de matérialisation et quelle évaluation de qualité
constituent la publication autoritaire pour cette lignée, ce cutoff et cette
politique, sous ce registre de bindings explicitement piné?

Aucune sélection `latest`. Aucune autorité globale implicite. Un binding
présent dans le CAS n'est pas autoritaire tant qu'il n'est pas tip sous le
registre piné.

**L3-I6 est un pipeline de recherche hors ligne. Il ne fait partie d'aucun
chemin critique de scan.**

Contrats ajoutés (77 schémas canoniques au total ; 29 contrats L3) :

```text
MarketDataDatasetSnapshotBinding/1
MarketDataDatasetSnapshotBindingAuthorityPolicy/1
MarketDataDatasetSnapshotBindingRegistryManifest/1
```

### Authority policy

Politique fermée, déterministe (`buildMarketDataDatasetSnapshotBindingAuthorityPolicy({ store })`) :

- `authorityScope = MARKET_DATA_SNAPSHOT_BINDING`
- `bindingUniquenessKeyVersion = INGESTION_LINEAGE_KNOWLEDGE_CUTOFF_MATERIALIZATION_POLICY_V1`

### Publication key

Chaque binding porte `bindingPublicationKey` dérivée exclusivement des
objets référencés :

```text
ingestionLineageId
knowledgeCutoff
materializationPolicyId
```

Jamais acceptée librement comme déclaration d'autorité. L'unicité de tip
reste relative au registre piné.

### Binding officiel

Le binding est un objet de références et de provenance. Il ferme au minimum :

- resolved-series, source bundle, materialization policy, materialization report
- `datasetSnapshotManifestId`, `snapshotCoreId`, `snapshotRecordId`, `normalizedObjectId`
- `qualityAssessmentId` (record L2A) + `qualityAssessmentCoreId`
- `ingestionRegistryManifestId` = préfixe contributif I4 (pas un pin descendant non contributif)
- lignée, cutoff, capacité temporelle, pins identité/calendrier/L2C
- `priceBasis` / `corporateActionTreatment`

Il ne copie ni les lignes, ni les barres, ni les rapports complets.

### Qualité L2A obligatoire

Absence → `MARKET_DATA_QUALITY_ASSESSMENT_REQUIRED`.
L2A ne décide pas l'admissibilité scientifique ; le binding conserve la
conclusion L2A (PASS / WARN / FAIL) sans la réinterpréter, pourvu que
l'évaluation cible exactement le même snapshot.

### Supersession

`supersedesBindingId` est obligatoire (`null` pour la première publication
d'une clé). Le parent attendu doit être exactement le tip de cette clé sous
le registre de base piné. Aucun builder ne cherche automatiquement le tip.

### Registry root et append

Root déterministe : `supersedes = null`, `bindingIds = []`, `bindingTips = []`.

`appendMarketDataDatasetSnapshotBindingRegistry` ajoute exactement un
binding, met à jour exactement un tip, conserve l'historique et les autres
tips byte-identiques, conserve la même authority policy.

### Orchestration

```js
publishOfficialMarketDataSnapshotBinding({
  store, baseBindingRegistryManifestId, expectedParentBindingId,
  materializationReportId, qualityAssessmentId,
})
```

Ordre : vérifier registre + policy + parent → report I5 → snapshot L1 →
qualité L2A → construire binding → append → retourner les deux IDs.

### Propriétés

- Autorité relative au pin uniquement ; aucun scan CAS pour un « officiel ».
- Stale-base / parent historique non tip / sibling / branche →
  `MARKET_DATA_SNAPSHOT_BINDING_CONFLICT` (ou codes d'autorité/cycle).
- Idempotence préférée : même tip déjà autoritaire sous le pin → mêmes IDs,
  pas de version artificielle (`noop`).
- Échec atomique : binding orphelin non autoritaire avant append ; relance
  déterministe.
- Non-interférence : pin d'ingestion descendant non contributif → même
  `bindingId` ; révision historique contributive → nouveau binding qui
  supersède.
- Clés indépendantes (cutoff / lignée) : tips isolés ; append K1 sans effet
  sur K2.

### Limites honnêtes d'I6 / fin de L3

Après I6, la fondation L3 est complète localement. I6 n'ajoute pas :

- features, macro, Fed, modèle
- réseau, Yahoo, IBKR, API
- intégration scanner / dashboard
- recherche `latest` ou autorité globale hors pin
- second format de snapshot au-delà du V1 EOD OHLCV I5

Les suites `test/market-data-l3-i6.test.mjs` et
`test/market-data-l3-i6-adversarial.test.mjs` utilisent uniquement des
fixtures synthétiques. Le harness adversatif (60 contre-tests) vit
exclusivement sous `os.tmpdir()`.

## L4A-A — features techniques point-in-time

L4A-A est un pipeline de recherche hors ligne qui consomme exclusivement des
bindings officiels L3-I6. Il relit leur snapshot L1
`MarketDataEodOhlcvCanonicalRows/1`, vérifie toute la fermeture I6/I5/I4/L1/L2A,
puis calcule quatre familles isolées :

- A1 : rendements simples 1/3/5/10/20/60 et drawdowns causalement bornés ;
- A2 : true range, ATR14 Wilder, ranges/gaps et volatilités réalisées ;
- A3 : RSI14, MACD 12/26/9, stochastique, Stoch RSI, CCI20 et ROC ;
- A4 : SMA/EMA, distances, pentes, états de tendance, ADX14 et force relative.

Trois contrats portent le total canonique de 77 à 80 :

```text
MarketTechnicalFeatureSourceBundle/1
MarketTechnicalFeatureComputationPolicy/1
MarketTechnicalFeatureComputationReport/1
```

`MarketTechnicalFeatureRows/1` est un contenu fermé du namespace
`normalized`; comme le contenu OHLCV I5, il ne compte pas parmi les 80 schémas
de métadonnées `snapshots`.

### Politique numérique et seeds

Le chemin autoritaire utilise uniquement des atomes `BigInt`, une échelle de
calcul 24, des sorties prix/ratios à l'échelle 12 et l'arrondi `HALF_EVEN`.
Les résultats ne dépendent ni de `parseFloat`, ni de `Number(atome)`, ni de
`Math.sqrt`, ni d'une arithmétique flottante native. La racine carrée est
entière et déterministe.

- ATR14 : moyenne des 14 premiers TR, puis Wilder ; le premier TR vaut
  `high - low`.
- RSI14 : moyenne des 14 premières variations, puis Wilder ; plat = 50,
  gains seuls = 100, pertes seules = 0.
- EMA : SMA complète de période `n`, puis alpha exact `2/(n+1)` ; le signal
  MACD attend neuf lignes MACD admissibles.
- Stoch RSI : raw sur 14 RSI, puis SMA3 de raw pour K, puis SMA3 de K pour D.
- ADX14 : 14 variations TR/+DM/-DM pour le premier DI/DX, puis moyenne des
  14 premiers DX pour le seed ADX.
- Les pics égaux de drawdown choisissent la session la plus récente.

Une feature absente est toujours `null` avec une raison fermée : jamais un
zéro de remplacement. Les débuts de série sont conservés, y compris avant
SMA200/EMA200. Les volatilités utilisent l'écart-type échantillonnal des
rendements simples observés et l'annualisation déterministe `sqrt(252)`.

### Benchmarks et absence de lookahead

Les rôles fermés sont `MARKET`, `SECTOR` et `UNDERLYING`, au plus un binding
par rôle. Un benchmark configuré doit partager cutoff, fréquence EOD,
calendrier compatible, devise, price basis et traitement corporate action.
L'alignement est exclusivement la `sessionDate` exacte : aucun forward-fill,
backward-fill, voisin le plus proche, téléchargement ou interpolation. Une
session absente produit `BENCHMARK_SESSION_MISSING`.

Chaque ligne à la session `t` ne lit que des sessions `<= t`. Un append futur
ne modifie donc aucun byte historique. Un registre de bindings descendant qui
n'ajoute rien au binding source est réduit à son premier pin autoritaire et ne
contamine ni le source bundle, ni les rows, ni le rapport.

### API et portée

```js
buildMarketTechnicalFeatureSourceBundle({ store, subject, benchmarks })
buildMarketTechnicalFeatureComputationPolicy({ store })
computeMarketTechnicalFeatures({
  store, technicalFeatureSourceBundleId, technicalFeatureComputationPolicyId,
})
verifyMarketTechnicalFeatureComputation({
  store, technicalFeatureComputationReportId,
})
```

Le verifier relit les bindings et snapshots, recalcule A1–A4, compare toutes
les lignes puis le rapport complet; un digest seul ne suffit pas. L4A-A ne
transforme pas les prix, n'entraîne aucun modèle, ne produit ni score ni
recommandation, et n'est importé ni par le scanner, ni par `server.js`, ni par
le dashboard.

## L4A-B — volume, participation et structure de prix

L4A-B est un artefact **séparé** de L4A-A. Il consomme exclusivement un rapport
L4A-A déjà vérifié, le binding officiel L3-I6 sous-jacent et le snapshot L1
EOD OHLCV. Il ne modifie jamais `MarketTechnicalFeatureRows/1`, ni les IDs, ni
les formules L4A-A. L4A-C réunira plus tard les deux artefacts; L4A-C n'est
pas implémenté.

Trois contrats portent le total canonique de 80 à 83 :

```text
MarketVolumeStructureFeatureSourceBundle/1
MarketVolumeStructureFeatureComputationPolicy/1
MarketVolumeStructureFeatureComputationReport/1
```

`MarketVolumeStructureFeatureRows/1` est un contenu fermé du namespace
`normalized` et ne compte pas parmi les 83 schémas `snapshots`.

### Familles B1 et B2

- B1 volume / participation : moyennes 20/50 sur séances **précédentes**
  uniquement, volume relatif, percentile 60
  `(2·countLess + countEqual)/(2·N)`, OBV partant de 0 au début du snapshot,
  multiplicateur / volume money-flow, ligne A/D, CMF20, MFI14, confirmations
  et divergences prix-volume descriptives.
- B1 VWAP EOD approximatif : rolling 20/60 et ancré sur le dernier swing
  high/low confirmé. Ce n'est **jamais** un VWAP intraday d'échange.
- B2 pivots causaux : rayon 3, confirmation à `i+3`, plateaux interdits,
  compression du flux alterné (extrême puis plus récemment confirmé) sans
  réécriture historique.
- B2 supports / résistances : pivots confirmés dans un lookback 252, tolérance
  `max(level×0.005, ATR14×0.25)`, contacts sur 120 séances.
- B2 breakouts / faux breakouts : niveaux de la ligne précédente; échec
  constaté seulement quand le close repasse de l'autre côté dans les 5
  séances suivantes.
- B2 gaps complets ouverts, congestion descriptive
  (`efficiency ≤ 0.30` et `range20 ≤ 4×ATR14%`), Fibonacci déterministe
  `236/382/500/618/786` sur la jambe alternée active.

### Convention d'ancrage EOD VWAP

Un pivot n'est utilisable qu'à partir de sa date de confirmation. À cette
date, les barres depuis la séance du pivot sont déjà connues et peuvent
entrer dans la somme ancrée — jamais de données futures.

### Fixed-point et absence de lookahead

Même politique numérique que L4A-A : BigInt, échelle interne 24, sorties 12,
`HALF_EVEN`, ratios entiers exacts. Aucun `parseFloat`, `Number(atome)`,
`Math.round`, `Math.sqrt` ou flottant autoritaire. Chaque ligne à `t` ne lit
que des sessions `≤ t`; un append futur (y compris dix années extrêmes) ne
change aucun byte historique.

### API et portée

```js
buildMarketVolumeStructureFeatureSourceBundle({
  store, technicalFeatureComputationReportId,
})
buildMarketVolumeStructureFeatureComputationPolicy({ store })
computeMarketVolumeStructureFeatures({
  store,
  volumeStructureFeatureSourceBundleId,
  volumeStructureFeatureComputationPolicyId,
})
verifyMarketVolumeStructureFeatureComputation({
  store, volumeStructureFeatureComputationReportId,
})
```

Le verifier complet revérifie L4A-A, le binding I6, la policy, relit OHLCV et
les rows L4A-A, recalcule toutes les features B, reconstruit rows et report,
puis compare octet par octet. L4A-B reste hors scanner, hors dashboard, sans
réseau, sans Yahoo, sans IBKR, sans modèle, sans score et sans
recommandation.

## Limites connues (V1)

- Les caches locaux fournissent un OHLC split-adjusted **sans montants de
  dividendes par barre** : pour ces fichiers le rendement total des payeurs
  de dividendes (SPY, QQQ) reste sous-estimé (warning
  `DIVIDENDS_NOT_INCLUDED`). Lorsque `cashDividend` est fourni (CSV), le
  moteur le crédite causalement (voir « Corporate actions »).
- Actions entières uniquement : un split produisant une quantité
  fractionnaire refuse le backtest (`FRACTIONAL_SPLIT_RESULT_UNSUPPORTED`),
  aucun cash-in-lieu n'est simulé.
- Pas de demi-séances (early closes) dans `marketSession`.
- Pas de raw OHLC natif dans les caches : la base `RAW` est refusée pour
  ces fichiers plutôt que fabriquée.
- Un seul symbole par portefeuille, cash account, actions entières,
  aucune marge — les ETF à levier restent des instruments à levier mais le
  portefeuille n'en ajoute pas.
- Baselines à paramètres fixes : aucune conclusion de performance ne doit
  en être tirée (`PILOT_TECHNICAL_ONLY`).
