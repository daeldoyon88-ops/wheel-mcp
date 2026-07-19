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
