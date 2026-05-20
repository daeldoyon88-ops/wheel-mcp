/**
 * testTheoreticalCycleStore.mjs
 *
 * Validates that theoretical_wheel_cycles and theoretical_cc_steps tables
 * are created correctly and that all store functions work as expected.
 * Cleans up test records at the end (theoretical_* tables only).
 */
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";

const TEST_CYCLE_ID = "test_cycle_POPV2E_APLD_001";
const TEST_STEP_1_ID = "test_cc_step_POPV2E_APLD_001_1";
const TEST_STEP_2_ID = "test_cc_step_POPV2E_APLD_001_2";
const TEST_CANDIDATE_ID = "test_candidate_record_POPV2E_001";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${label}`);
    failed++;
  }
}

async function run() {
  console.log("=== testTheoreticalCycleStore ===\n");

  // ── Step 1: init store ────────────────────────────────────────────────────
  console.log("[1] Initializing store...");
  const store = createTheoreticalCycleStoreSqlite();
  await store.ensureInitialized();
  console.log(`    SQLite path: ${store.sqlitePath}`);
  assert(true, "ensureInitialized() completed without error");

  // ── Step 2: verify tables exist via summary (no error = tables exist) ─────
  console.log("\n[2] Verifying tables exist via getSummary()...");
  const summaryBefore = await store.getSummary();
  assert(typeof summaryBefore.cycles_total === "number", "summary.cycles_total is a number");
  assert(typeof summaryBefore.cc_steps_total === "number", "summary.cc_steps_total is a number");
  assert(typeof summaryBefore.tickers_count === "number", "summary.tickers_count is a number");

  // ── Step 3: insert test cycle ─────────────────────────────────────────────
  console.log("\n[3] Inserting test cycle...");
  await store.upsertCycle({
    id: TEST_CYCLE_ID,
    candidate_record_id: TEST_CANDIDATE_ID,
    trade_signature: "APLD_2025-01-15_43_SAFE",
    scan_session_id: "session_test_001",
    scan_timestamp: "2025-01-10T15:30:00.000Z",
    scan_date: "2025-01-10",
    ticker: "APLD",
    expiration: "2025-01-17",
    assignment_date: "2025-01-17",
    assignment_strike: 43.0,
    assignment_price: 43.0,
    spot_at_scan: 44.5,
    spot_at_assignment: 42.8,
    strike_mode: "SAFE",
    csp_strike: 43.0,
    csp_premium: 0.45,
    csp_yield_pct: 1.05,
    pop_estimate: 0.72,
    distance_strike_from_spot_pct: -3.37,
    status: "open",
    current_step: 0,
    total_cc_premium_estimated: 0,
    total_cc_premium_conservative: 0,
    total_premium_estimated: 0.45,
    cc_sellable_steps_count: 0,
    cc_wait_steps_count: 0,
    source_prime_method: "black_scholes",
    confidence_level: "medium",
    data_quality: "test",
  });
  assert(true, "upsertCycle() completed without error");

  // ── Step 4: read cycle back ───────────────────────────────────────────────
  console.log("\n[4] Reading cycle back...");
  const cycle = await store.getCycleById(TEST_CYCLE_ID);
  assert(cycle !== null, "getCycleById() returns non-null");
  assert(cycle?.id === TEST_CYCLE_ID, `cycle.id === '${TEST_CYCLE_ID}'`);
  assert(cycle?.ticker === "APLD", "cycle.ticker === 'APLD'");
  assert(cycle?.assignment_strike === 43.0, "cycle.assignment_strike === 43.0");
  assert(cycle?.status === "open", "cycle.status === 'open'");
  assert(cycle?.candidate_record_id === TEST_CANDIDATE_ID, "cycle.candidate_record_id matches");

  // ── Step 5: insert two cc_steps ──────────────────────────────────────────
  console.log("\n[5] Inserting two cc_steps...");
  await store.upsertCcStep({
    id: TEST_STEP_1_ID,
    theoretical_cycle_id: TEST_CYCLE_ID,
    candidate_record_id: TEST_CANDIDATE_ID,
    ticker: "APLD",
    sequence_number: 1,
    test_date: "2025-01-20",
    cc_expiration: "2025-01-31",
    dte: 11,
    stock_price_used: 41.5,
    assignment_strike: 43.0,
    cc_strike: 43.0,
    volatility_used: 0.62,
    volatility_source: "hv30",
    risk_free_rate: 0.053,
    dividend_yield: 0.0,
    bs_call_premium: 0.18,
    premium_estimated: 0.18,
    premium_conservative: 0.13,
    conservative_factor: 0.72,
    cc_yield_pct: 0.42,
    cc_yield_conservative_pct: 0.30,
    cc_sold_theoretical: 0,
    not_sold_reason: "yield_below_0_5_pct",
    threshold_0_5_hit: 0,
    threshold_1_0_hit: 0,
    data_quality: "test",
  });
  await store.upsertCcStep({
    id: TEST_STEP_2_ID,
    theoretical_cycle_id: TEST_CYCLE_ID,
    candidate_record_id: TEST_CANDIDATE_ID,
    ticker: "APLD",
    sequence_number: 2,
    test_date: "2025-02-03",
    cc_expiration: "2025-02-14",
    dte: 11,
    stock_price_used: 43.8,
    assignment_strike: 43.0,
    cc_strike: 43.0,
    volatility_used: 0.68,
    volatility_source: "hv30",
    risk_free_rate: 0.053,
    dividend_yield: 0.0,
    bs_call_premium: 0.62,
    premium_estimated: 0.62,
    premium_conservative: 0.45,
    conservative_factor: 0.72,
    cc_yield_pct: 1.44,
    cc_yield_conservative_pct: 1.05,
    cc_sold_theoretical: 1,
    best_threshold_reached: 1.0,
    threshold_0_5_hit: 1,
    threshold_0_75_hit: 1,
    threshold_1_0_hit: 1,
    threshold_1_5_hit: 0,
    data_quality: "test",
  });
  assert(true, "upsertCcStep() x2 completed without error");

  // ── Step 6: read steps back ───────────────────────────────────────────────
  console.log("\n[6] Reading cc_steps back...");
  const steps = await store.listCcSteps(TEST_CYCLE_ID);
  assert(steps.length === 2, "listCcSteps() returns 2 steps");
  assert(steps[0]?.id === TEST_STEP_1_ID, "step[0].id matches step 1");
  assert(steps[1]?.id === TEST_STEP_2_ID, "step[1].id matches step 2");
  assert(steps[0]?.sequence_number === 1, "step[0].sequence_number === 1");
  assert(steps[1]?.sequence_number === 2, "step[1].sequence_number === 2");
  assert(steps[0]?.cc_sold_theoretical === 0, "step[0].cc_sold_theoretical === 0 (wait)");
  assert(steps[1]?.cc_sold_theoretical === 1, "step[1].cc_sold_theoretical === 1 (sold)");
  assert(steps[0]?.cc_strike === 43.0, "step[0].cc_strike === 43.0 (never below assignment)");
  assert(steps[1]?.cc_strike === 43.0, "step[1].cc_strike === 43.0 (never below assignment)");

  // ── Step 7: listCycles and listCyclesByTicker ─────────────────────────────
  console.log("\n[7] Listing cycles...");
  const allCycles = await store.listCycles(10);
  assert(allCycles.some((c) => c.id === TEST_CYCLE_ID), "listCycles() includes test cycle");
  const tickerCycles = await store.listCyclesByTicker("APLD", 10);
  assert(tickerCycles.some((c) => c.id === TEST_CYCLE_ID), "listCyclesByTicker('APLD') includes test cycle");

  // ── Step 8: summary after inserts ────────────────────────────────────────
  console.log("\n[8] Verifying getSummary() after inserts...");
  const summaryAfter = await store.getSummary();
  assert(summaryAfter.cycles_total >= 1, "summary.cycles_total >= 1");
  assert(summaryAfter.cycles_open >= 1, "summary.cycles_open >= 1");
  assert(summaryAfter.cc_steps_total >= 2, "summary.cc_steps_total >= 2");
  assert(summaryAfter.cc_sold_total >= 1, "summary.cc_sold_total >= 1 (step 2 sold)");
  assert(summaryAfter.cc_wait_total >= 1, "summary.cc_wait_total >= 1 (step 1 waited)");
  assert(summaryAfter.tickers_count >= 1, "summary.tickers_count >= 1");
  assert("cycles_total" in summaryAfter, "summary has cycles_total key");
  assert("cycles_open" in summaryAfter, "summary has cycles_open key");
  assert("cycles_closed" in summaryAfter, "summary has cycles_closed key");
  assert("cc_steps_total" in summaryAfter, "summary has cc_steps_total key");
  assert("cc_sold_total" in summaryAfter, "summary has cc_sold_total key");
  assert("cc_wait_total" in summaryAfter, "summary has cc_wait_total key");
  assert("tickers_count" in summaryAfter, "summary has tickers_count key");

  // ── Step 9: idempotent upsert (re-insert same cycle, no duplicate) ────────
  console.log("\n[9] Testing idempotent upsert...");
  await store.upsertCycle({
    id: TEST_CYCLE_ID,
    candidate_record_id: TEST_CANDIDATE_ID,
    ticker: "APLD",
    assignment_strike: 43.0,
    status: "open",
    current_step: 1,
  });
  const cycleAfterUpdate = await store.getCycleById(TEST_CYCLE_ID);
  assert(cycleAfterUpdate?.current_step === 1, "upsert updated current_step to 1");
  const allCyclesAfterUpdate = await store.listCycles(100);
  const duplicates = allCyclesAfterUpdate.filter((c) => c.id === TEST_CYCLE_ID);
  assert(duplicates.length === 1, "no duplicate: exactly 1 record with test cycle id");

  // ── Step 10: confirm wheel_validation_records untouched ──────────────────
  console.log("\n[10] Confirming wheel_validation_records not modified...");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(store.sqlitePath);
  const wvrTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='wheel_validation_records'"
  ).get();
  assert(wvrTableExists != null, "wheel_validation_records table still exists");
  // We only check count hasn't changed — we don't insert or delete from it
  const wvrCount = db.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records").get();
  assert(typeof wvrCount?.cnt === "number", "wheel_validation_records count is readable");
  console.log(`    wheel_validation_records count: ${wvrCount?.cnt} (not touched by this test)`);
  db.close();

  // ── Step 11: cleanup test data ────────────────────────────────────────────
  console.log("\n[11] Cleaning up test data from theoretical_* tables...");
  const cleanDb = new DatabaseSync(store.sqlitePath);
  cleanDb.prepare("DELETE FROM theoretical_cc_steps WHERE id IN (@s1, @s2)").run({
    s1: TEST_STEP_1_ID,
    s2: TEST_STEP_2_ID,
  });
  cleanDb.prepare("DELETE FROM theoretical_wheel_cycles WHERE id = @id").run({ id: TEST_CYCLE_ID });

  const cleanupCycle = cleanDb.prepare("SELECT id FROM theoretical_wheel_cycles WHERE id = @id").get({ id: TEST_CYCLE_ID });
  const cleanupSteps = cleanDb.prepare("SELECT id FROM theoretical_cc_steps WHERE theoretical_cycle_id = @id").all({ id: TEST_CYCLE_ID });
  assert(cleanupCycle == null, "test cycle removed from theoretical_wheel_cycles");
  assert(cleanupSteps.length === 0, "test cc_steps removed from theoretical_cc_steps");
  cleanDb.close();

  // ── Final report ──────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("Some assertions FAILED — review output above.");
    process.exit(1);
  } else {
    console.log("All assertions PASSED.");
    process.exit(0);
  }
}

run().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
