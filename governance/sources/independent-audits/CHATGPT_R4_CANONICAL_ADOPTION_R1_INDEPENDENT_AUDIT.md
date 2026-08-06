# Audit indépendant — Adoption canonique R4 et validation du dépôt vivant R1

## Verdict

`R4_CANONICAL_ADOPTION_AND_LIVE_REPOSITORY_VALIDATION_R1_INDEPENDENT_AUDIT_PASS_FOR_OBS_R2_01_CLOSURE_AND_I4_AUTHORIZATION_WITH_NONBLOCKING_HYBRID_REPLAY_SOURCE_ROOT_OBSERVATION`

Le package d’adoption est **accepté**. Aucun défaut bloquant n’a été trouvé dans les octets livrés, le mapping, les 14 fichiers adoptés, les manifests/seals, la génération déterministe ou les contre-tests.

Cette audit autorise :

```text
OBS-R2-01 → fermeture COMPLETE_CONFIRMED
I4        → démarrage autorisé
```

Il n’autorise pas GATE13.

## ZIP livré

```text
Taille                 1 416 223 octets
SHA-256                b88705d093b694041463a3d510e8a48b26b6978376bf4711acc810b4670023e0
Entrées                72
CRC                    PASS
JSON                    41/41 valides
Backslash              0
Hors package/          0
Chemins dangereux      0
Doublons                0
Symlinks                0
```

## Manifest et seal

```text
Entrées couvertes      69
Manquants               0
Hash mismatches         0
Size mismatches         0
Manifest SHA-256        f6d23a5b0f1f7150b7939351659c91277e47ad71f0975039ebadf5b79b27c5f4
Triples digest          a5f14baad4a787b05fa5a28f5373c7e2fc7d3b48ba927d23b3aafd34229be0c5
Seal SHA-256            022197f52ddcfe4bfe850e9d0899e398e3d8d1f6dc432085cb0e87aa8bc258b7
Receipt SHA-256         aa8662739e8686f9299f67a18d82d997508b1042d1fa089edc1ab62b67b4f5cc
Seal                    PASS
```

Les trois fichiers non couverts sont exactement les artefacts postérieurs au contenu scellé :

```text
seals/CONTENT_MANIFEST.json
seals/CONTENT_SEAL.json
final/DETACHED_TERMINAL_VERIFICATION_RECEIPT.json
```

## Adoption vérifiée

```text
Fichiers présents dans adopted/repository   14
Fichiers provenant du ZIP R4 comparés       13
Mismatches byte-à-byte                       0
Décision propriétaire copiée à l’identique  OUI
canonicalAdoptionPath=false                  5/5
```

Les listes de chemins sont identiques entre :

- les fichiers réellement embarqués;
- le mapping R2;
- le manifest d’adoption;
- la décision propriétaire;
- l’allowlist du delta;
- les 14 nouveaux changements Git déclarés.

## Rejeu direct indépendant

Deux générations ont été exécutées depuis les outils adoptés :

```text
Run 1 map          a41bf05fcc4186c83f4e7928562250a260311cc92ccbbe31c37843af6dbeb92b
Run 2 map          a41bf05fcc4186c83f4e7928562250a260311cc92ccbbe31c37843af6dbeb92b
Carte adoptée      a41bf05fcc4186c83f4e7928562250a260311cc92ccbbe31c37843af6dbeb92b

Run 1 provenance   bd87bc283590e97522552ce484f7b31c5a5b4199590ef86a2fbadfac192294ce
Run 2 provenance   bd87bc283590e97522552ce484f7b31c5a5b4199590ef86a2fbadfac192294ce
Provenance adoptée bd87bc283590e97522552ce484f7b31c5a5b4199590ef86a2fbadfac192294ce
```

Validateur de provenance :

```text
exitCode                           0
valid                              true
errors                             0
primitiveTargetCount               463
provenanceRowCount                 463
uniqueTargetPointerCount           463
uncoveredPrimitiveFields             0
orphanProvenanceRows                 0
duplicateTargetPointers              0
six compteurs de liaison              0
failedTransformationReplays           0
```

Contre-tests rejoués directement :

```text
54/54 probants
```

## Résolution de l’autorité externe

La carte adoptée lie :

```text
SRC-R1-EXTERNAL-PASS
→ governance/sources/GATE12_L3_RECLOSURE_R1_EXTERNAL_REINSPECTION_REPORT.json
→ SHA-256 8d524eb4969d669ddb01d443d787c1e9f13e6e634e2f8eef0f2c4fbc1e08bd08
```

Le fichier adopté possède exactement ce hash. Les événements GATE12 et GATE13 du ledger épinglé utilisent la même autorité et le même hash.

## Preuves live scellées

Les sorties brutes correspondent exactement aux rapports structurés :

```text
Ledger avec source-map     exit 0 · valid=true  · 41 événements · 0 finding
Ledger sans source-map     exit 2 · valid=false · 3 findings
Tests positifs             35/35
Contre-tests               54/54
Nouveaux fichiers          14
Hors allowlist              0
Supprimés / renommés        0 / 0
Staging                     0
Ledger invariant            OUI
Rollback sandbox            PASS
```

L’échec sans `--source-map` est bien une observation pré-I4, pas un défaut de l’adoption.

## Observations non bloquantes

### ADOPT-AUD-OBS-01 — Source root de rejeu hybride

Le rejeu utilise trois entrées provenant du dépôt vivant :

- ledger;
- registre des gates;
- rapport externe.

Les neuf autres entrées normatives historiques proviennent du source root scellé de R4. Les hashes sont épinglés et le résultat est déterministe, mais il faut décrire cette preuve comme un **rejeu hybride live + sources historiques scellées**, et non comme un rejeu composé uniquement de sources résidentes du dépôt.

Pour le durcissement, I4 ou une tâche ultérieure devrait enregistrer un emplacement durable/CAS du source root complet, afin de ne pas dépendre d’une extraction sous `Temp`.

### ADOPT-AUD-OBS-02 — Phrase historique périmée dans PT-R2-21

Le résultat `35/35` conserve une phrase historique disant que le rapport externe n’était pas adopté. Cette phrase est désormais périmée. Elle ne commande pas le test et les sorties live actuelles montrent correctement `0 finding`.

### ADOPT-AUD-OBS-03 — Self-test final détaché

Le fichier interne `PACKAGE_CANDIDATE_SELFTEST.json` concerne le candidat pré-final de 65 entrées. Le ZIP final de 72 entrées a été testé après sa création, hors du ZIP, pour éviter une récursion. Le présent audit a vérifié directement le ZIP final de 72 entrées.

## Limite de l’audit

Le dépôt Windows n’est pas monté dans ce bac à sable. Les commandes Git et le vrai `validate-status-ledger.mjs` n’ont donc pas été réexécutés directement ici. Leurs sorties brutes, les scripts d’exécution et les preuves scellées sont toutefois cohérents entre eux et avec les octets adoptés.

## Disposition

```text
Package d’adoption   ACCEPTÉ
R5 nécessaire        NON
OBS-R2-01            AUTORISÉ À FERMER
I4                    AUTORISÉ À COMMENCER
GATE13                NON AUTORISÉ PAR CET AUDIT
```

## Suite

```text
enregistrer cet audit
→ fermer OBS-R2-01
→ lancer I4
→ intégrer automatiquement la source-map dans l’entrée normale
→ tests et contre-tests I4
→ audit indépendant I4
→ I4 COMPLETE_CONFIRMED
```
