import { authoritativeCase } from './helpers/earningsOfficialTestHarnessL4CIV1.mjs';

authoritativeCase("I1-H008", "historical", "P1/P2 EventSet stable", "");
authoritativeCase("I1-H009", "historical", "P1/P2 RevisionSet stable", "");
authoritativeCase("I1-H010", "historical", "P1/P2 ExtractionSet may differ", "");
authoritativeCase("I1-H011", "historical", "P1/P2 Snapshot differs if interpretation changes", "");
authoritativeCase("I1-H012", "historical", "economic identities stable across parser change", "");
authoritativeCase("I1-H013", "historical", "taxonomy change same docs new ExtractionSet+Snapshot", "");
authoritativeCase("I1-H014", "historical", "extraction policy change same docs new ExtractionSet+Snapshot", "");
authoritativeCase("I1-H015", "historical", "snapshot counters include extractionReportCount + metricObservationCount", "");
authoritativeCase("I1-H016", "historical", "snapshot digests include extraction + grouped observation digests", "");
authoritativeCase("I1-H017", "historical", "empty snapshot: empty ExtractionSet + empty digests domain preimages", "");
authoritativeCase("I1-H018", "historical", "snapshot pins include ExtractionSet + series + supersedes", "");
