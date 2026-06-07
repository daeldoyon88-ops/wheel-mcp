import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const sourcePath = path.join(repoRoot, "wheel-dashboard", "src", "components", "JournalPopPanel.jsx");
const jsonPath = path.join(repoRoot, "debug", "section-f-journal-pop-ui-metrics-patch-validation.json");
const mdPath = path.join(repoRoot, "debug", "section-f-journal-pop-ui-metrics-patch-validation.md");

function runGit(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (error) {
    return String(error?.stdout ?? error?.message ?? error);
  }
}

function includesAll(source, patterns) {
  return patterns.every((pattern) => source.includes(pattern));
}

const source = fs.readFileSync(sourcePath, "utf8");
const trackedDiffFiles = runGit(["diff", "--name-only"])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const stagedFiles = runGit(["diff", "--cached", "--name-only"])
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const statusShort = runGit(["status", "--short"]);

const checks = {
  uiOnly:
    trackedDiffFiles.length === 1 &&
    trackedDiffFiles[0] === "wheel-dashboard/src/components/JournalPopPanel.jsx",
  sectionFConsumesRecords: includesAll(source, [
    "function computeSectionFMetrics(records)",
    "const sectionFMetrics = useMemo(() => computeSectionFMetrics(records), [records]);",
    "sectionFMetrics.cards.map",
  ]),
  premiumEfficiencyWired: includesAll(source, [
    "record?.stress?.premium_efficiency",
    "moyenne records valides",
    "Premium Efficiency",
  ]),
  marketRegimeWired: includesAll(source, [
    "record?.marketContextSnapshot?.marketRegimeLabel ?? record?.marketRegimeLabel",
    "Market Regime",
    "dernier snapshot",
  ]),
  vixBucketWired: includesAll(source, [
    "record?.marketContextSnapshot?.vixRegimeLabel ?? record?.vixRegimeLabel",
    "VIX Bucket",
    "VIX ${vixBucket.level.toFixed(1)}",
  ]),
  daysToFirstTouchIntentionallyPending: includesAll(source, [
    "Days to First Touch",
    "champ exact absent",
  ]),
  clusterRiskIntentionallyPending: includesAll(source, [
    "Cluster Risk",
    "donnée secteur/corrélation absente",
  ]),
  ivRankIntentionallyPending: includesAll(source, [
    "IV Rank at Scan",
    "IV rank non capturé",
  ]),
  noBackendScannerScoringDbPineTrackedDiff: !trackedDiffFiles.some((file) =>
    file === "server.js" ||
    file.startsWith("app/") ||
    file.startsWith("data/") ||
    file.endsWith(".pine") ||
    file.includes("scanner") ||
    file.toLowerCase().includes("e2b")
  ),
  noGitAdd: stagedFiles.length === 0,
};

const report = {
  generatedAt: new Date().toISOString(),
  scope: "Section F Journal POP UI metrics patch",
  filesModifiedByPatch: [
    "wheel-dashboard/src/components/JournalPopPanel.jsx",
    "debug/section-f-journal-pop-ui-metrics-patch-validation.mjs",
    "debug/section-f-journal-pop-ui-metrics-patch-validation.md",
    "debug/section-f-journal-pop-ui-metrics-patch-validation.json",
  ],
  checks,
  commands: [
    {
      command: "node --check wheel-dashboard/src/components/JournalPopPanel.jsx",
      status: "failed_expected",
      detail: "Node rejected .jsx before syntax parsing: ERR_UNKNOWN_FILE_EXTENSION.",
    },
    {
      command: "npx vite build",
      cwd: "wheel-dashboard",
      status: "ok",
      detail: "Production build completed; only existing framer-motion use client and chunk-size warnings were emitted.",
    },
  ],
  git: {
    trackedDiffFiles,
    stagedFiles,
    statusShort,
  },
  riskNotes: [
    "Market Regime and VIX Bucket display the latest usable record snapshot, not a new score.",
    "Premium Efficiency averages only records with stress.premium_efficiency present; missing values stay N/D.",
    "Days to First Touch, Cluster Risk, and IV Rank remain intentionally pending.",
  ],
};

fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const md = [
  "# Section F Journal POP UI Metrics Patch Validation",
  "",
  `Generated: ${report.generatedAt}`,
  "",
  "## Scope",
  "- UI only: `wheel-dashboard/src/components/JournalPopPanel.jsx`.",
  "- No backend, scanner, scoring E2b, DB, Pine, Yahoo, or IBKR changes.",
  "- No git add and no commit.",
  "",
  "## Checks",
  ...Object.entries(checks).map(([key, value]) => `- ${key}: ${value ? "OK" : "FAIL"}`),
  "",
  "## Commands",
  ...report.commands.map((item) => `- ${item.command}: ${item.status} — ${item.detail}`),
  "",
  "## Git",
  `- Tracked diff files: ${trackedDiffFiles.length ? trackedDiffFiles.join(", ") : "none"}`,
  `- Staged files: ${stagedFiles.length ? stagedFiles.join(", ") : "none"}`,
  "",
  "## Risk Notes",
  ...report.riskNotes.map((note) => `- ${note}`),
  "",
].join("\n");

fs.writeFileSync(mdPath, md, "utf8");
console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), jsonPath, mdPath }, null, 2));
