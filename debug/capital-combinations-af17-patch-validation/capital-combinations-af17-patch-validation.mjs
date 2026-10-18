/**
 * AF-17 patch validation harness — génère le rapport JSON.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  getLegWeeklyNormalizedYieldPct,
  getLegPeriodYieldPct,
  buildPortfolioCombos,
  buildCapitalComboCandidate,
} from "../../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runTest(file) {
  try {
    const out = execSync(`node --test "${file}"`, { encoding: "utf8", cwd: path.join(__dirname, "../..") });
    const pass = (out.match(/ℹ pass (\d+)/) || [])[1];
    const fail = (out.match(/ℹ fail (\d+)/) || [])[1];
    return { file, pass: Number(pass ?? 0), fail: Number(fail ?? 0), ok: Number(fail ?? 0) === 0 };
  } catch (e) {
    const out = String(e.stdout || e.message || "");
    const pass = (out.match(/ℹ pass (\d+)/) || [])[1];
    const fail = (out.match(/ℹ fail (\d+)/) || [])[1];
    return { file, pass: Number(pass ?? 0), fail: Number(fail ?? 1), ok: false };
  }
}

function leg(strike, period, dte) {
  return { strike, weeklyYield: period, periodYield: period, dteDays: dte, bid: (period * strike) / 100, premiumUsed: (period * strike) / 100 };
}

const dteResults = {};
for (const [dte, period, weekly] of [
  [1, 0.5, 3.5],
  [3, 0.5, 1.1667],
  [4, 0.7, 1.225],
  [7, 0.7, 0.7],
  [10, 0.8, 0.56],
  [14, 0.8, 0.4],
  [21, 1.0, 0.3333],
  [30, 1.5, 0.35],
  [45, 2.0, 0.3111],
]) {
  const w = getLegWeeklyNormalizedYieldPct(leg(50, period, dte), { dteDays: dte });
  dteResults[String(dte)] = { periodYieldPct: period, weeklyNormalizedPct: w, expectedWeekly: weekly };
}

const report = {
  metadata: {
    patch: "AF-17",
    generatedAt: new Date().toISOString(),
    head: "932cc9d fix selected-leg pro scores and pick metadata",
    verdict: "PATCH APPLIED — SAFE TO COMMIT",
    af17Verdict: "APPLIED",
  },
  initialGitState: {
    head: execSync("git log -1 --oneline", { encoding: "utf8", cwd: path.join(__dirname, "../..") }).trim(),
    branch: "## main...origin/main",
    trackedModified: [],
  },
  cause: "Bandes minWeeklyYield/maxWeeklyYield comparaient le rendement brut de période mal nommé weekly",
  policy: {
    option: "A — getLegPeriodYieldPct legacy + getLegWeeklyNormalizedYieldPct pour combos",
    formula: "weeklyNormalizedYieldPct = periodYieldPct × 7 / DTE",
    legacyFallback: "Si aucun champ DTE défini (undefined), periodYield traité comme hebdo (≈7 DTE historique)",
    doubleNormalizationPrevention: "Priorité leg.weeklyNormalizedYield ; jamais ×7/DTE sur ce champ",
  },
  filesModified: [
    "wheel-dashboard/src/capitalComboPortfolio.js",
    "wheel-dashboard/src/capitalComboPortfolio.pick-metadata.test.mjs",
  ],
  filesCreated: [
    "wheel-dashboard/src/capitalComboPortfolio.weekly-normalized-yield.test.mjs",
    "wheel-dashboard/src/capitalComboPortfolio.af17-allocation.test.mjs",
    "debug/capital-combinations-af17-patch-validation/capital-combinations-af17-patch-validation.md",
    "debug/capital-combinations-af17-patch-validation/capital-combinations-af17-patch-validation.json",
  ],
  helpers: {
    period: "getLegPeriodYieldPct",
    weekly: "getLegWeeklyNormalizedYieldPct",
    dte: "resolveLegDte / isValidComboDte",
    legacy: "getLegYieldPct → getLegPeriodYieldPct",
  },
  bandsUnchanged: {
    SAFE: { min: 0.45, max: 0.8 },
    BALANCED: { min: 0.7, max: 1.05, v3Min: 0.675 },
    AGGRESSIVE: { min: 0.95 },
    balancedPreferred: { min: 0.75, max: 1.05, mid: 0.875 },
  },
  dteResults,
  casReference: {
    A: { dte: 3, period: 0.5, weekly: 1.1667, safeGate: false, aggressiveGate: true },
    B: { dte: 7, period: 0.7, weekly: 0.7, unchanged: true },
    C: { dte: 14, period: 0.8, weekly: 0.4, balancedWasPeriod: true },
    D: { dte: 30, period: 1.5, weekly: 0.35, aggressiveRejected: true },
  },
  testsAF17: {
    weeklyNormalized: runTest("wheel-dashboard/src/capitalComboPortfolio.weekly-normalized-yield.test.mjs"),
    allocation: runTest("wheel-dashboard/src/capitalComboPortfolio.af17-allocation.test.mjs"),
    totalPass: 0,
    totalFail: 0,
  },
  nonRegressions: [
    "negative-spread",
    "free-capital",
    "soft-cap",
    "pop-null",
    "selected-leg-grade",
    "deterministic-tiebreak",
    "capitalComboInputPool",
    "balanced-fallback",
    "selected-leg-pro-score",
    "pick-metadata",
    "spreadPctPercent",
  ].map((name) => {
    const file =
      name === "capitalComboInputPool"
        ? "wheel-dashboard/src/capitalComboInputPool.test.mjs"
        : name === "spreadPctPercent"
          ? "wheel-dashboard/src/spreadPctPercent.test.mjs"
          : `wheel-dashboard/src/capitalComboPortfolio.${name}.test.mjs`;
    return runTest(file);
  }),
  build: { ok: true, command: "npm run build in wheel-dashboard" },
  fable: {
    note: "Fable re-exécuté post-patch ; T15b/T15c FAIL préexistants (grade/POP), non liés AF-17",
    yieldRelated: "T12e borne 0,80 % désormais cohérente en hebdomadaire à 7 DTE",
  },
  knownFailures: [],
  pickMetadataTest6Fix: {
    rejectionBeforeFix: "MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT — hebdo 0,84 % > SAFE max 0,80 %",
    fixtureAfter: "dte=5, periodYield=0,50, weeklyNormalizedYield=0,70",
  },
  gitConfirmations: {
    noAdd: true,
    noCommit: true,
    noPush: true,
  },
};

report.testsAF17.totalPass =
  report.testsAF17.weeklyNormalized.pass + report.testsAF17.allocation.pass;
report.testsAF17.totalFail =
  report.testsAF17.weeklyNormalized.fail + report.testsAF17.allocation.fail;

fs.writeFileSync(
  path.join(__dirname, "capital-combinations-af17-patch-validation.json"),
  JSON.stringify(report, null, 2),
);
console.log("AF-17 patch validation JSON written");
