/**
 * testRefreshAssignmentRecovery.mjs
 *
 * POP V2 Phase 1 validation — CSP assignment recovery metrics.
 *
 * Usage: node scripts/testRefreshAssignmentRecovery.mjs
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
const baselineValidation = countTable(db, "wheel_validation_records");
const baselineCycles = countTable(db, "theoretical_wheel_cycles");
const baselineCcSteps = countTable(db, "theoretical_cc_steps");
console.log(`  wheel_validation_records : ${baselineValidation}`);
console.log(`  theoretical_wheel_cycles : ${baselineCycles}`);
console.log(`  theoretical_cc_steps     : ${baselineCcSteps}`);

assert(baselineCycles > 0, "theoretical_wheel_cycles non vide");

header("TEST 1 — computeAssignmentRecoveryMetrics (pure)");
const pure = service.computeAssignmentRecoveryMetrics({
  assignmentDate: "2025-01-10",
  assignmentStrike: 100,
  candles: [
    { date: "2025-01-13", open: 95, high: 98, low: 94, close: 97 },
    { date: "2025-01-14", open: 98, high: 101, low: 97, close: 99 },
    { date: "2025-01-15", open: 99, high: 102, low: 98, close: 101 },
  ],
});
assert(pure.assignment_recovered === 1, "pure: recovered when close >= strike");
assert(pure.days_to_strike_close_above === 3, `pure: days close above = 3 (got ${pure.days_to_strike_close_above})`);
assert(pure.days_to_strike_touch === 2, `pure: touch on day 2 (got ${pure.days_to_strike_touch})`);
assert(pure.days_below_assignment_strike === 2, `pure: 2 days below before recovery (got ${pure.days_below_assignment_strike})`);
assert(pure.assignment_recovery_date === "2025-01-15", "pure: recovery date correct");

const pureNot = service.computeAssignmentRecoveryMetrics({
  assignmentDate: "2025-01-10",
  assignmentStrike: 100,
  candles: [
    { date: "2025-01-13", open: 95, high: 98, low: 94, close: 97 },
    { date: "2025-01-14", open: 96, high: 99, low: 95, close: 98 },
  ],
});
assert(pureNot.assignment_recovered === 0, "pure: not recovered when close stays below");
assert(pureNot.assignment_recovery_date == null, "pure: no recovery date");
assert(pureNot.days_to_strike_close_above == null, "pure: days close above null");

header("TEST 2 — dryRun refresh (no DB writes)");
const dryResult = await service.refreshAssignmentRecoveryForCycles({ dryRun: true, limit: 5 });
assert(dryResult.ok === true, "dryRun ok");
assert(dryResult.cycles_updated === 0, "dryRun: cycles_updated = 0");

const afterDryValidation = countTable(db, "wheel_validation_records");
const afterDryCcSteps = countTable(db, "theoretical_cc_steps");
assert(afterDryValidation === baselineValidation, "dryRun: wheel_validation_records inchangé");
assert(afterDryCcSteps === baselineCcSteps, "dryRun: theoretical_cc_steps inchangé");

header("TEST 3 — idempotence check (onlyMissing)");
const first = await service.refreshAssignmentRecoveryForCycles({ dryRun: true, limit: 3, onlyMissing: true });
const second = await service.refreshAssignmentRecoveryForCycles({ dryRun: true, limit: 3, onlyMissing: true });
assert(first.cycles_scanned === second.cycles_scanned, "idempotence dryRun: même nombre scanné");

console.log("\n  Tests terminés.");
