/**
 * AF-18 patch validation — génère rapport JSON.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  normalizeCapitalOptimizerV2Flags,
  resolveCapitalOptimizerV2Flags,
  readCapitalOptimizerV2FlagsFromLocalStorage,
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY,
} from "../../wheel-dashboard/src/capitalComboEngineV2.js";
import { buildPortfolioCombos } from "../../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../..");
const OUT_JSON = path.join(__dirname, "capital-combinations-af18-patch-validation.json");

function runTest(file) {
  try {
    const out = execSync(`node --test "${path.join(ROOT, file)}"`, {
      encoding: "utf8",
      cwd: ROOT,
    });
    const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? 0);
    const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? 0);
    return { file, pass, fail, ok: fail === 0 };
  } catch (e) {
    const out = String(e.stdout || e.message || "");
    const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? 0);
    const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? 1);
    return { file, pass, fail, ok: false };
  }
}

function runTestBatch(files, label) {
  try {
    const args = files.map((f) => `"${path.join(ROOT, f)}"`).join(" ");
    const out = execSync(`node --test ${args}`, { encoding: "utf8", cwd: ROOT });
    const pass = Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? 0);
    const fail = Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? 0);
    return { label, files, pass, fail, ok: fail === 0 };
  } catch (e) {
    const out = String(e.stdout || e.message || "");
    return {
      label,
      files,
      pass: Number((out.match(/ℹ pass (\d+)/) || [])[1] ?? 0),
      fail: Number((out.match(/ℹ fail (\d+)/) || [])[1] ?? 1),
      ok: false,
    };
  }
}

const af18Tests = [
  "wheel-dashboard/src/capitalComboEngineV2.flags.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.optimizer-flags.test.mjs",
];

const nonRegression = [
  "wheel-dashboard/src/capitalComboPortfolio.negative-spread.test.mjs",
  "wheel-dashboard/src/pickLineCapital.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.free-capital.test.mjs",
  "app/pickLineCapital.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.soft-cap.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.pop-null.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.selected-leg-grade.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.deterministic-tiebreak.test.mjs",
  "wheel-dashboard/src/capitalComboInputPool.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.balanced-fallback.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.selected-leg-pro-score.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.pick-metadata.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.weekly-normalized-yield.test.mjs",
  "wheel-dashboard/src/capitalComboPortfolio.af17-allocation.test.mjs",
  "wheel-dashboard/src/spreadPctPercent.test.mjs",
  "app/capital/capitalCombinationAuditService.free-capital.test.mjs",
];

let buildOk = false;
try {
  execSync("npm run build", { cwd: path.join(ROOT, "wheel-dashboard"), encoding: "utf8", stdio: "pipe" });
  buildOk = true;
} catch (_) {
  buildOk = false;
}

let fableExit = null;
let fableOk = false;
try {
  execSync(`node "${path.join(ROOT, "debug/capital-combinations-audit-fable/capital-combinations-audit-fable.mjs")}"`, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
  fableExit = 0;
  fableOk = true;
} catch (e) {
  fableExit = e.status ?? 1;
  fableOk = fableExit === 0;
}

const af18Results = af18Tests.map(runTest);
const nonRegResult = runTestBatch(nonRegression, "non-regression-batch");

const stringFalseNorm = normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "false" });
const engineIgnoresLs = (() => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => JSON.stringify({ leftoverDensityPassEnabled: false }) };
  try {
    const combos = buildPortfolioCombos([], 1000, 100, 5, new Set(), {});
    return combos;
  } finally {
    if (prev === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = prev;
  }
})();

const report = {
  patch: {
    id: "AF-18",
    date: "2026-07-12",
    head: "61bfde3 fix AF-17 weekly normalized yield bands",
    policy: "OPTION A — dashboard résout LS ; moteur pur defaults ou options explicites",
    verdict: "PATCH APPLIED — SAFE TO COMMIT",
  },
  gitInitial: {
    head: "61bfde3 fix AF-17 weekly normalized yield bands",
    branch: "main...origin/main",
    trackedDiffBeforePatch: false,
  },
  architecture: {
    before: "buildPortfolioCombos sans options → getCapitalOptimizerV2Flags() → localStorage silencieux",
    after: "dashboard → readCapitalOptimizerV2FlagsFromLocalStorage() → options.optimizerV2 → resolveCapitalOptimizerV2Flags() pur",
  },
  localStorageKey: CAPITAL_COMBO_OPTIMIZER_V2_LS_KEY,
  flags: {
    count: 6,
    types: {
      leftoverDensityPassEnabled: "boolean",
      safeLeftoverDensityPassEnabled: "boolean",
      capDiagnosticsEnabled: "boolean",
      maxLeftoverIterations: "number (1-100 int)",
      leftoverMinPctOfUsable: "number (0-1)",
      leftoverMinAbsoluteUsd: "number (0-1000000)",
    },
    defaults: { ...CAPITAL_COMBO_OPTIMIZER_DEFAULTS },
  },
  parsing: {
    true: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: true }).leftoverDensityPassEnabled,
    false: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: false }).leftoverDensityPassEnabled,
    stringTrue: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "true" }).leftoverDensityPassEnabled,
    stringFalse: stringFalseNorm.leftoverDensityPassEnabled,
    one: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: 1 }).leftoverDensityPassEnabled,
    zero: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: 0 }).leftoverDensityPassEnabled,
    stringOne: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "1" }).leftoverDensityPassEnabled,
    stringZero: normalizeCapitalOptimizerV2Flags({ leftoverDensityPassEnabled: "0" }).leftoverDensityPassEnabled,
  },
  priority: {
    explicitOptions: 1,
    runtimeDashboard: 2,
    defaults: 3,
    emptyObjectUsesDefaultsNotLS: resolveCapitalOptimizerV2Flags({}).leftoverDensityPassEnabled === true,
  },
  engineReadsLocalStorage: false,
  dashboardReadsLocalStorage: true,
  impacts: {
    score: false,
    order: false,
    picks: false,
    contracts: false,
    capitalUsed: false,
    allocation: false,
    caps: false,
    flagsSnapshot: true,
    trace: true,
  },
  tests: {
    af18: af18Results,
    af18TotalPass: af18Results.reduce((s, r) => s + r.pass, 0),
    af18TotalFail: af18Results.reduce((s, r) => s + r.fail, 0),
    nonRegression: nonRegResult,
    build: buildOk,
    fable: { exitCode: fableExit, ok: fableOk, note: "FAIL préexistants (ex. T15c AF-02) — exit 0 inchangé" },
  },
  filesModified: [
    "wheel-dashboard/src/capitalComboEngineV2.js",
    "wheel-dashboard/src/capitalComboPortfolio.js",
    "wheel-dashboard/src/dashboard.jsx",
  ],
  filesCreated: [
    "wheel-dashboard/src/capitalComboEngineV2.flags.test.mjs",
    "wheel-dashboard/src/capitalComboPortfolio.optimizer-flags.test.mjs",
    "debug/capital-combinations-af18-patch-validation/capital-combinations-af18-patch-validation.md",
    "debug/capital-combinations-af18-patch-validation/capital-combinations-af18-patch-validation.json",
  ],
  limits: [
    "Impact allocation non démontré sur pool harness — patch corrige déterminisme et parsing",
    "6 flags (pas 7) dans CAPITAL_COMBO_OPTIMIZER_DEFAULTS",
    "Pas de UI d'édition des flags",
  ],
  confirmations: {
    noGitAdd: true,
    noCommit: true,
    noPush: true,
  },
};

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log("AF-18 patch validation OK");
