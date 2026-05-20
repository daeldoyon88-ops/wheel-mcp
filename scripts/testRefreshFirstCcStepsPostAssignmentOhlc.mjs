/**
 * testRefreshFirstCcStepsPostAssignmentOhlc.mjs
 *
 * POP V2-F2C validation script.
 * Refreshes step-1 theoretical covered calls using post-assignment daily OHLC
 * when available, with official pricing anchored to the next-session open.
 *
 * Usage: node scripts/testRefreshFirstCcStepsPostAssignmentOhlc.mjs
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";

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
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(72));
}

function countTable(db, table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get();
    return row?.cnt ?? 0;
  } catch (_) {
    return 0;
  }
}

function normDate(value) {
  if (!value) return null;
  const digits = String(value).replace(/-/g, "");
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return String(value).slice(0, 10);
}

function parseRaw(rawJson) {
  try {
    return rawJson ? JSON.parse(rawJson) : {};
  } catch (_) {
    return {};
  }
}

function fmtNumber(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const service = createTheoreticalCycleService({ validationStore, cycleStore });
const db = new DatabaseSync(SQLITE_PATH);

await cycleStore.ensureInitialized();

const baselineValidation = countTable(db, "wheel_validation_records");
const baselineCycles = countTable(db, "theoretical_wheel_cycles");
const baselineCcSteps = countTable(db, "theoretical_cc_steps");
const baselineSeq1 = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE sequence_number = 1")
  .get()?.cnt ?? 0;
const baselineMissingStep1Open = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM theoretical_wheel_cycles c
  LEFT JOIN theoretical_cc_steps s
    ON s.theoretical_cycle_id = c.id
   AND s.sequence_number = 1
  WHERE c.status = 'open'
    AND s.id IS NULL
`).get()?.cnt ?? 0;

header("BASELINE");
console.log(`  wheel_validation_records : ${baselineValidation}`);
console.log(`  theoretical_wheel_cycles : ${baselineCycles}`);
console.log(`  theoretical_cc_steps     : ${baselineCcSteps}`);
console.log(`  step-1 count             : ${baselineSeq1}`);
console.log(`  open cycles missing step1: ${baselineMissingStep1Open}`);

assert(baselineValidation > 0, "wheel_validation_records non vide");
assert(baselineCycles > 0, "theoretical_wheel_cycles non vide");

header("STEP 1 - DRY RUN");
const dryResult = await service.generateFirstCcStepsForOpenCycles({
  dryRun: true,
  forceRefresh: true,
  usePostAssignmentOhlc: true,
  officialPriceRule: "open",
});

console.log(`  cycles_scanned   : ${dryResult.cycles_scanned}`);
console.log(`  cycles_eligible  : ${dryResult.cycles_eligible}`);
console.log(`  steps_built      : ${dryResult.steps_built}`);
console.log(`  steps_upserted   : ${dryResult.steps_upserted}`);
console.log(`  skipped_existing : ${dryResult.skipped_existing}`);
console.log(`  errors           : ${dryResult.errors.length}`);

assert(dryResult.ok === true, "dryRun ok=true");
assert(dryResult.dryRun === true, "dryRun flag=true");
assert(dryResult.steps_built > 0, `steps_built > 0 (got ${dryResult.steps_built})`);
assert(dryResult.steps_upserted === 0, "steps_upserted = 0 en dryRun");
assert(dryResult.sample_steps.length > 0, "sample_steps dryRun non vide");

let dryDatesOk = true;
let dryStrikesOk = true;
let dryPriceRuleOk = true;
let dryPriceQualityOk = true;
for (const step of dryResult.sample_steps) {
  if (step.assignment_date && normDate(step.test_date) < normDate(step.assignment_date)) dryDatesOk = false;
  if (step.cc_strike != null && step.assignment_strike != null && Number(step.cc_strike) < Number(step.assignment_strike)) dryStrikesOk = false;
  if (!step.priceRule) dryPriceRuleOk = false;
  if (!step.priceQuality) dryPriceQualityOk = false;
}
assert(dryDatesOk, "test_date >= assignment_date pour les sample_steps dryRun");
assert(dryStrikesOk, "cc_strike >= assignment_strike pour les sample_steps dryRun");
assert(dryPriceRuleOk, "priceRule present sur les sample_steps dryRun");
assert(dryPriceQualityOk, "priceQuality present sur les sample_steps dryRun");

console.log("\n  Exemples dryRun :");
for (const step of dryResult.sample_steps.slice(0, 10)) {
  const sold = step.cc_sold_theoretical === 1 ? "sold" : "wait";
  console.log(
    `    ${String(step.ticker).padEnd(6)} asgn=${step.assignment_date} test=${step.test_date}` +
    ` rule=${step.priceRule} quality=${step.priceQuality}` +
    ` open=${fmtNumber(step.stock_open, 2)} close=${fmtNumber(step.stock_close, 2)}` +
    ` used=${fmtNumber(step.stock_price_used, 2)} strike=${fmtNumber(step.cc_strike, 2)}` +
    ` yld=${fmtNumber(step.cc_yield_conservative_pct, 3)} ${sold}`
  );
}

assert(countTable(db, "theoretical_wheel_cycles") === baselineCycles, "cycles inchanges apres dryRun");
assert(countTable(db, "theoretical_cc_steps") === baselineCcSteps, "cc_steps inchanges apres dryRun");
assert(countTable(db, "wheel_validation_records") === baselineValidation, "wheel_validation_records inchanges apres dryRun");

header("STEP 2 - REAL RUN");
const realResult = await service.generateFirstCcStepsForOpenCycles({
  dryRun: false,
  forceRefresh: true,
  usePostAssignmentOhlc: true,
  officialPriceRule: "open",
});

console.log(`  cycles_scanned   : ${realResult.cycles_scanned}`);
console.log(`  cycles_eligible  : ${realResult.cycles_eligible}`);
console.log(`  steps_built      : ${realResult.steps_built}`);
console.log(`  steps_upserted   : ${realResult.steps_upserted}`);
console.log(`  skipped_existing : ${realResult.skipped_existing}`);
console.log(`  cc_sold          : ${realResult.cc_sold_theoretical_count}`);
console.log(`  cc_wait          : ${realResult.cc_wait_count}`);
console.log(`  errors           : ${realResult.errors.length}`);

assert(realResult.ok === true, "realRun ok=true");
assert(realResult.steps_upserted > 0, `steps_upserted > 0 (got ${realResult.steps_upserted})`);
assert(realResult.errors.length === 0, `aucune erreur (got ${realResult.errors.length})`);

const afterRealValidation = countTable(db, "wheel_validation_records");
const afterRealCycles = countTable(db, "theoretical_wheel_cycles");
const afterRealCcSteps = countTable(db, "theoretical_cc_steps");
const afterRealSeq1 = db
  .prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE sequence_number = 1")
  .get()?.cnt ?? 0;

assert(afterRealValidation === baselineValidation, `wheel_validation_records inchange (got ${afterRealValidation})`);
assert(afterRealCycles === baselineCycles, `theoretical_wheel_cycles inchange (got ${afterRealCycles})`);
assert(
  afterRealSeq1 <= baselineSeq1 + baselineMissingStep1Open,
  `step-1 count ne depasse pas les manquants initiaux (before=${baselineSeq1}, after=${afterRealSeq1})`
);
assert(
  afterRealCcSteps <= baselineCcSteps + baselineMissingStep1Open,
  `theoretical_cc_steps ne double pas (before=${baselineCcSteps}, after=${afterRealCcSteps})`
);

header("STEP 3 - INVARIANTS DB");
const duplicates = db.prepare(`
  SELECT theoretical_cycle_id, COUNT(*) AS cnt
  FROM theoretical_cc_steps
  WHERE sequence_number = 1
  GROUP BY theoretical_cycle_id
  HAVING cnt > 1
`).all();
assert(duplicates.length === 0, `aucun doublon sequence_number=1 (violations=${duplicates.length})`);

const invalidStrikes = db.prepare(`
  SELECT COUNT(*) AS cnt
  FROM theoretical_cc_steps
  WHERE sequence_number = 1
    AND cc_strike < assignment_strike
`).get()?.cnt ?? 0;
assert(invalidStrikes === 0, `cc_strike >= assignment_strike pour tous les step-1 (violations=${invalidStrikes})`);

const refreshedRows = db.prepare(`
  SELECT
    s.ticker,
    c.assignment_date,
    s.test_date,
    s.stock_open,
    s.stock_close,
    s.stock_price_used,
    s.assignment_strike,
    s.cc_strike,
    s.premium_conservative,
    s.cc_yield_conservative_pct,
    s.cc_sold_theoretical,
    s.raw_json
  FROM theoretical_cc_steps s
  JOIN theoretical_wheel_cycles c
    ON c.id = s.theoretical_cycle_id
  WHERE s.sequence_number = 1
    AND c.status = 'open'
  ORDER BY s.updated_at DESC
`).all();

const counters = {
  next_session_open: 0,
  next_session_close: 0,
  next_session_high_low_midpoint: 0,
  fallback_total: 0,
  usedPostAssignmentOhlc: 0,
  usedFallback: 0,
};

for (const row of refreshedRows) {
  const raw = parseRaw(row.raw_json);
  const priceRule = String(raw.priceRule ?? "");
  if (priceRule === "next_session_open") counters.next_session_open += 1;
  if (priceRule === "next_session_close") counters.next_session_close += 1;
  if (priceRule === "next_session_high_low_midpoint") counters.next_session_high_low_midpoint += 1;
  if (priceRule.startsWith("fallback_")) counters.fallback_total += 1;
  if (raw.usedPostAssignmentOhlc === true) counters.usedPostAssignmentOhlc += 1;
  if (raw.usedFallback === true) counters.usedFallback += 1;
}

console.log(`  next_session_open              : ${counters.next_session_open}`);
console.log(`  next_session_close             : ${counters.next_session_close}`);
console.log(`  next_session_high_low_midpoint : ${counters.next_session_high_low_midpoint}`);
console.log(`  fallback_* total               : ${counters.fallback_total}`);
console.log(`  usedPostAssignmentOhlc=true    : ${counters.usedPostAssignmentOhlc}`);
console.log(`  usedFallback=true              : ${counters.usedFallback}`);

header("STEP 4 - 10 EXEMPLES");
for (const row of refreshedRows.slice(0, 10)) {
  const raw = parseRaw(row.raw_json);
  const sold = row.cc_sold_theoretical === 1 ? "sold" : "wait";
  console.log(
    `  ${String(row.ticker).padEnd(6)}` +
    ` asgn=${row.assignment_date}` +
    ` test=${row.test_date}` +
    ` rule=${raw.priceRule ?? "?"}` +
    ` quality=${raw.priceQuality ?? "?"}` +
    ` open=${fmtNumber(row.stock_open, 2)}` +
    ` close=${fmtNumber(row.stock_close, 2)}` +
    ` used=${fmtNumber(row.stock_price_used, 2)}` +
    ` strike=${fmtNumber(row.cc_strike, 2)}` +
    ` prem=${fmtNumber(row.premium_conservative, 4)}` +
    ` yld=${fmtNumber(row.cc_yield_conservative_pct, 3)}` +
    ` ${sold}`
  );
}

header("RAPPORT FINAL");
console.log(`  dryRun steps_built               : ${dryResult.steps_built}`);
console.log(`  realRun steps_upserted           : ${realResult.steps_upserted}`);
console.log(`  wheel_validation_records before  : ${baselineValidation}`);
console.log(`  wheel_validation_records after   : ${afterRealValidation}`);
console.log(`  theoretical_cc_steps before      : ${baselineCcSteps}`);
console.log(`  theoretical_cc_steps after       : ${afterRealCcSteps}`);
console.log(`  open step-1 with OHLC            : ${counters.usedPostAssignmentOhlc}`);
console.log(`  open step-1 fallback             : ${counters.usedFallback}`);
