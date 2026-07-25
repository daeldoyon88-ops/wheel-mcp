import { authoritativeCase } from './helpers/earningsOfficialTestHarnessL4CIV1.mjs';

authoritativeCase("I1-M001", "registry", "registry theoretical snapshots = 129", "");
authoritativeCase("I1-M002", "registry", "normalized remains 5", "");
authoritativeCase("I1-M003", "registry", "KEEP_NEW count = 16", "");
authoritativeCase("I1-M004", "registry", "REUSE TransformImplementationManifest/2", "");
authoritativeCase("I1-M005", "registry", "REJECT EarningsParserImplementationManifest/1", "");
authoritativeCase("I1-M006", "registry", "test inventory final count lock = TOTAL_FINAL", "");
authoritativeCase("I1-M007", "registry", "no duplicate official IDs", "");
authoritativeCase("I1-M008", "registry", "DAG reaches filings from snapshot", "");
authoritativeCase("I1-M009", "registry", "DAG reaches observations via ExtractionSet", "");
authoritativeCase("I1-M010", "registry", "no latest in any pin", "");
authoritativeCase("I1-M011", "registry", "no network during computation doctrine lock", "");
authoritativeCase("I1-M013", "registry", "file→category coverage includes extraction-set file", "");
authoritativeCase("I1-M014", "registry", "PASS C checklist final 45 questions", "");
authoritativeCase("I1-M015", "registry", "edgeCount === derived N: traversal table → edgeCount===N", "");
authoritativeCase("I1-M016", "registry", "design registry: KEEP_NEW=16 REUSE=1 REJECT=1 registry 129/5 → assert equal", "");
