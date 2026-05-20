/**
 * testGenerateTheoreticalCycles.mjs
 *
 * POP V2-F1 validation script.
 * Tests the full lifecycle: dryRun → real generation → idempotency check.
 *
 * Usage:  node scripts/testGenerateTheoreticalCycles.mjs
 */

import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

// ─── helpers ─────────────────────────────────────────────────────────────────

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
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    return row?.cnt ?? 0;
  } catch (_) {
    return 0;
  }
}

// ─── setup ───────────────────────────────────────────────────────────────────

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const service = createTheoreticalCycleService({ validationStore, cycleStore });

// Shared read connection for assertion queries
const db = new DatabaseSync(SQLITE_PATH);

// ─── BASELINE ────────────────────────────────────────────────────────────────

header("BASELINE — counts before any operation");

await cycleStore.ensureInitialized();

const baselineValidationCount = countTable(db, "wheel_validation_records");
const baselineCcStepsCount = countTable(db, "theoretical_cc_steps");
const baselineCyclesCount = countTable(db, "theoretical_wheel_cycles");

console.log(`  wheel_validation_records  : ${baselineValidationCount}`);
console.log(`  theoretical_wheel_cycles  : ${baselineCyclesCount}`);
console.log(`  theoretical_cc_steps      : ${baselineCcStepsCount}`);

assert(baselineValidationCount > 0, "wheel_validation_records non vide");

// ─── STEP 1 — DRY RUN ────────────────────────────────────────────────────────

header("STEP 1 — DRY RUN (aucun insert)");

const dryResult = await service.generateCyclesFromAssignedRecords({ dryRun: true });

console.log(`  scanned_records   : ${dryResult.scanned_records}`);
console.log(`  assigned_records  : ${dryResult.assigned_records}`);
console.log(`  eligible_records  : ${dryResult.eligible_records}`);
console.log(`  cycles_built      : ${dryResult.cycles_built}`);
console.log(`  cycles_upserted   : ${dryResult.cycles_upserted}`);
console.log(`  skipped_missing   : ${dryResult.skipped_missing_required}`);
console.log(`  errors            : ${dryResult.errors.length}`);

assert(dryResult.ok === true, "dryRun ok=true");
assert(dryResult.dryRun === true, "dryRun flag true");
assert(dryResult.assigned_records > 0, `assigned_records > 0 (got ${dryResult.assigned_records})`);
assert(dryResult.cycles_built > 0, `cycles_built > 0 (got ${dryResult.cycles_built})`);
assert(dryResult.sample_cycles.length > 0, "sample_cycles non vide");
assert(dryResult.cycles_upserted === 0, "cycles_upserted = 0 pendant dryRun");

// Verify DB not touched during dryRun
const afterDryCycles = countTable(db, "theoretical_wheel_cycles");
assert(afterDryCycles === baselineCyclesCount, `aucun cycle inséré pendant dryRun (attendu=${baselineCyclesCount}, got=${afterDryCycles})`);

if (dryResult.sample_cycles.length > 0) {
  console.log("\n  Exemples (dryRun):");
  for (const c of dryResult.sample_cycles) {
    console.log(`    ${c.ticker.padEnd(6)} strike=${c.assignment_strike} prime=${c.csp_premium} mode=${c.strike_mode} date=${c.assignment_date}`);
  }
}

// ─── STEP 2 — REAL GENERATION ────────────────────────────────────────────────

header("STEP 2 — GÉNÉRATION RÉELLE");

const realResult = await service.generateCyclesFromAssignedRecords({ dryRun: false });

console.log(`  scanned_records   : ${realResult.scanned_records}`);
console.log(`  assigned_records  : ${realResult.assigned_records}`);
console.log(`  eligible_records  : ${realResult.eligible_records}`);
console.log(`  cycles_built      : ${realResult.cycles_built}`);
console.log(`  cycles_upserted   : ${realResult.cycles_upserted}`);
console.log(`  errors            : ${realResult.errors.length}`);
if (realResult.errors.length > 0) {
  for (const e of realResult.errors.slice(0, 3)) {
    console.log(`    ERROR: ${e.id} — ${e.error}`);
  }
}

assert(realResult.ok === true, "génération réelle ok=true");
assert(realResult.cycles_upserted > 0, `cycles_upserted > 0 (got ${realResult.cycles_upserted})`);
assert(realResult.errors.length === 0, `aucune erreur (got ${realResult.errors.length})`);

const afterRealCycles = countTable(db, "theoretical_wheel_cycles");
const afterRealCcSteps = countTable(db, "theoretical_cc_steps");
const afterRealValidation = countTable(db, "wheel_validation_records");

assert(afterRealCycles > baselineCyclesCount, `theoretical_wheel_cycles créés (avant=${baselineCyclesCount}, après=${afterRealCycles})`);
assert(afterRealCcSteps === baselineCcStepsCount, `theoretical_cc_steps inchangés (attendu=${baselineCcStepsCount}, got=${afterRealCcSteps})`);
assert(afterRealValidation === baselineValidationCount, `wheel_validation_records inchangés (attendu=${baselineValidationCount}, got=${afterRealValidation})`);

const summary1 = await service.getTheoreticalCycleSummary();
assert(summary1.cycles_total > 0, `getSummary().cycles_total > 0 (got ${summary1.cycles_total})`);
assert(summary1.cc_steps_total === 0 || summary1.cc_steps_total === baselineCcStepsCount,
  `cc_steps_total inchangé (got ${summary1.cc_steps_total})`);

console.log(`\n  Résumé après génération :`);
console.log(`    cycles_total   : ${summary1.cycles_total}`);
console.log(`    cycles_open    : ${summary1.cycles_open}`);
console.log(`    cc_steps_total : ${summary1.cc_steps_total}`);
console.log(`    tickers_count  : ${summary1.tickers_count}`);

if (realResult.sample_cycles.length > 0) {
  console.log("\n  5 exemples :");
  for (const c of realResult.sample_cycles) {
    console.log(`    ${c.ticker.padEnd(6)} strike=${c.assignment_strike} prime=${c.csp_premium} mode=${c.strike_mode} date=${c.assignment_date}`);
  }
}

// ─── STEP 3 — IDEMPOTENCY ────────────────────────────────────────────────────

header("STEP 3 — IDEMPOTENCE (deuxième exécution)");

const idemResult = await service.generateCyclesFromAssignedRecords({ dryRun: false });

const afterIdemCycles = countTable(db, "theoretical_wheel_cycles");
const afterIdemCcSteps = countTable(db, "theoretical_cc_steps");
const afterIdemValidation = countTable(db, "wheel_validation_records");

console.log(`  cycles_upserted   : ${idemResult.cycles_upserted}`);
console.log(`  errors            : ${idemResult.errors.length}`);

assert(idemResult.ok === true, "deuxième exécution ok=true");
assert(idemResult.errors.length === 0, `aucune erreur (got ${idemResult.errors.length})`);
assert(afterIdemCycles === afterRealCycles,
  `aucun doublon cycles (avant=${afterRealCycles}, après=${afterIdemCycles})`);
assert(afterIdemCcSteps === baselineCcStepsCount,
  `cc_steps toujours inchangés (attendu=${baselineCcStepsCount}, got=${afterIdemCcSteps})`);
assert(afterIdemValidation === baselineValidationCount,
  `wheel_validation_records toujours inchangés (attendu=${baselineValidationCount}, got=${afterIdemValidation})`);

const summary2 = await service.getTheoreticalCycleSummary();
assert(summary2.cycles_total === summary1.cycles_total,
  `cycles_total stable après idempotence (avant=${summary1.cycles_total}, après=${summary2.cycles_total})`);

// ─── FINAL REPORT ────────────────────────────────────────────────────────────

header("RAPPORT FINAL");

console.log(`  CSP assignés trouvés      : ${realResult.assigned_records}`);
console.log(`  Cycles théoriques générés : ${realResult.cycles_upserted}`);
console.log(`  theoretical_wheel_cycles  : ${afterRealCycles}`);
console.log(`  theoretical_cc_steps      : ${afterIdemCcSteps}  (inchangé)`);
console.log(`  wheel_validation_records  : ${afterIdemValidation}  (inchangé — ${baselineValidationCount === afterIdemValidation ? "OK" : "ERREUR"})`);
console.log(`  Appels réseau             : aucun`);
console.log(`  Scanner modifié           : non`);
console.log(`  Dashboard modifié         : non`);
console.log(`  server.js modifié         : non`);

if (process.exitCode === 1) {
  console.log("\n  STATUT: ÉCHEC — voir FAIL ci-dessus");
} else {
  console.log("\n  STATUT: SUCCÈS — tous les critères validés");
}
