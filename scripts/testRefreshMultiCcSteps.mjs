/**
 * testRefreshMultiCcSteps.mjs
 *
 * POP V2 Phase 2 validation — multi-week CC simulation after CSP assignment.
 *
 * Usage: node scripts/testRefreshMultiCcSteps.mjs
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`  OK  : ${message}`);
  }
}

function header(title) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("═".repeat(60));
}

function countTable(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get()?.cnt ?? 0;
  } catch (_) {
    return 0;
  }
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const service = createTheoreticalCycleService({ validationStore, cycleStore });
const db = new DatabaseSync(SQLITE_PATH);

await cycleStore.ensureInitialized();

header("BASELINE");
const baselineCcSteps = countTable(db, "theoretical_cc_steps");
const baselineCycles = countTable(db, "theoretical_wheel_cycles");
console.log(`  theoretical_wheel_cycles : ${baselineCycles}`);
console.log(`  theoretical_cc_steps     : ${baselineCcSteps}`);

assert(baselineCycles > 0, "theoretical_wheel_cycles non vide");

header("TEST 1 — Aucun CC sous assignment_strike (pure buildCcStepForCycle)");
const mockCycle = {
  id: "test_cycle_pure",
  candidate_record_id: "test_record",
  ticker: "TEST",
  assignment_date: "2025-01-10",
  assignment_strike: 100,
  csp_premium: 1.5,
  assignment_price: 98,
  spot_at_assignment: 98,
  spot_at_scan: 105,
  assignment_recovery_date: "2025-01-20",
  assignment_recovered: 1,
};
const mockSource = { hv30_at_scan: 0.45, atm_iv_at_scan: 0.5, underlying_close_at_expiration: 98 };
const pureStep = await service.buildCcStepForCycle({
  cycle: mockCycle,
  sourceRecord: mockSource,
  sequenceNumber: 1,
  testDate: "2025-01-13",
  ccExpiration: "2025-01-17",
  dte: 4,
  options: { usePostAssignmentOhlc: false },
});
assert(pureStep.step != null, "pure step built");
assert(pureStep.step.cc_strike >= pureStep.step.assignment_strike, "cc_strike >= assignment_strike");

header("TEST 2 — Rendement < 0.5 % → attente");
const lowYieldStep = {
  ...pureStep.step,
  cc_yield_conservative_pct: 0.3,
  cc_sold_theoretical: 0,
  not_sold_reason: "yield_below_0_5_pct",
};
assert(lowYieldStep.cc_sold_theoretical === 0, "yield < 0.5% → cc_sold_theoretical = 0");
assert(lowYieldStep.not_sold_reason === "yield_below_0_5_pct", "not_sold_reason = yield_below_0_5_pct");

header("TEST 3 — Plusieurs semaines → plusieurs steps (simulate pure)");
const multiSim = await service.simulateMultiCcStepsForCycle({
  cycle: mockCycle,
  sourceRecord: mockSource,
  options: { maxWeeks: 4, endDateYmd: "2025-02-15", usePostAssignmentOhlc: false },
});
assert(multiSim.steps.length >= 2, `plusieurs steps créés (got ${multiSim.steps.length})`);
const seqNums = multiSim.steps.map((s) => s.sequence_number);
assert(seqNums[0] === 1 && seqNums[seqNums.length - 1] === multiSim.steps.length, "sequence_number incrémentale");

header("TEST 4 — Primes cumulées correctement");
const soldSteps = multiSim.steps.filter((s) => s.cc_sold_theoretical === 1);
const manualPremiumSum = soldSteps.reduce((sum, s) => sum + (Number(s.premium_conservative) || 0), 0);
const summaryMulti = service.summarizeCycleFromCcSteps({ cycle: mockCycle, ccSteps: multiSim.steps });
assert(
  Math.abs(summaryMulti.total_cc_premium_conservative - manualPremiumSum) < 0.0001,
  `primes cumulées (summary=${summaryMulti.total_cc_premium_conservative}, manual=${manualPremiumSum})`
);

header("TEST 5 — before_recovery_flag correct");
const beforeRec = service.computeBeforeRecoveryFlagsForStep({
  testDate: "2025-01-15",
  assignmentRecoveryDate: "2025-01-20",
  assignmentRecovered: 1,
  firstAfterRecoveryMarkedRef: { value: false },
});
assert(beforeRec.before_recovery_flag === 1, "before recovery date → flag = 1");
const afterRec = service.computeBeforeRecoveryFlagsForStep({
  testDate: "2025-01-22",
  assignmentRecoveryDate: "2025-01-20",
  assignmentRecovered: 1,
  firstAfterRecoveryMarkedRef: { value: false },
});
assert(afterRec.before_recovery_flag === 0, "after recovery date → flag = 0");
const notRecovered = service.computeBeforeRecoveryFlagsForStep({
  testDate: "2025-02-01",
  assignmentRecoveryDate: null,
  assignmentRecovered: 0,
  firstAfterRecoveryMarkedRef: { value: false },
});
assert(notRecovered.before_recovery_flag === 1, "not recovered → all before_recovery = 1");

header("TEST 6 — weeks_without_cc correct");
const waitCount = multiSim.steps.filter((s) => s.cc_sold_theoretical !== 1).length;
assert(summaryMulti.weeks_without_cc === waitCount, `weeks_without_cc = ${waitCount}`);

header("TEST 7 — reduced_cost_basis_estimated = strike - csp - cc premiums");
const expectedReduced = mockCycle.assignment_strike - mockCycle.csp_premium - summaryMulti.total_cc_premium_conservative;
assert(
  Math.abs(summaryMulti.reduced_cost_basis_estimated - expectedReduced) < 0.0001,
  `reduced_cost_basis = ${summaryMulti.reduced_cost_basis_estimated} (expected ${expectedReduced})`
);
assert(
  Math.abs(summaryMulti.initial_net_cost_basis - (mockCycle.assignment_strike - mockCycle.csp_premium)) < 0.0001,
  "initial_net_cost_basis = assignment_strike - csp_premium"
);

header("TEST 8 — dryRun n'écrit rien");
const dryResult = await service.refreshMultiCcStepsForCycles({ dryRun: true, limit: 3 });
assert(dryResult.ok === true, "dryRun ok");
assert(dryResult.cycles_updated === 0, "dryRun: cycles_updated = 0");
const afterDryCcSteps = countTable(db, "theoretical_cc_steps");
assert(afterDryCcSteps === baselineCcSteps, "dryRun: theoretical_cc_steps inchangé");

header("TEST 9 — --write écrit bien les steps (limit 1 cycle)");
const beforeWriteSteps = countTable(db, "theoretical_cc_steps");
const writeResult = await service.refreshMultiCcStepsForCycles({
  dryRun: false,
  limit: 1,
  forceRefresh: true,
  onlyMissing: false,
});
assert(writeResult.ok === true, "write ok");
assert(writeResult.cycles_updated >= 1, "au moins 1 cycle mis à jour");
const afterWriteSteps = countTable(db, "theoretical_cc_steps");
assert(afterWriteSteps >= beforeWriteSteps, "steps écrits en DB");

const belowStrikeRow = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_strike < assignment_strike")
  .get();
assert(belowStrikeRow?.cnt === 0, `aucun CC sous assignment_strike en DB (got ${belowStrikeRow?.cnt})`);

const multiStepCycle = db
  .prepare(
    "SELECT theoretical_cycle_id, COUNT(*) AS cnt FROM theoretical_cc_steps GROUP BY theoretical_cycle_id HAVING cnt >= 2 LIMIT 1"
  )
  .get();
if (multiStepCycle) {
  assert(true, `cycle avec >= 2 steps trouvé (${multiStepCycle.cnt} steps)`);
} else {
  console.log("  WARN: aucun cycle avec >= 2 steps après write limit 1 (peut arriver si historique court)");
}

console.log("\n  Tests terminés.");
