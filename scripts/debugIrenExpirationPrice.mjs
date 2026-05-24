/**
 * debugIrenExpirationPrice.mjs — read-only debug for IREN CC expiration price (Phase 3)
 * Usage: node scripts/debugIrenExpirationPrice.mjs [TICKER]
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { createMarketService } from "../app/services/marketService.js";
import { YahooMarketDataProvider } from "../app/data_providers/yahooMarketDataProvider.js";
import { createWheelValidationStoreSqlite } from "../app/journal/wheelValidationStoreSqlite.js";
import { createTheoreticalCycleStoreSqlite } from "../app/theory/theoreticalCycleStoreSqlite.js";
import { createTheoreticalCycleService } from "../app/theory/theoreticalCycleService.js";

const SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const ticker = (process.argv[2] ?? "IREN").toUpperCase();

const db = new DatabaseSync(SQLITE_PATH);
const validationStore = createWheelValidationStoreSqlite();
const cycleStore = createTheoreticalCycleStoreSqlite();
const marketService = createMarketService(new YahooMarketDataProvider());
const service = createTheoreticalCycleService({ validationStore, cycleStore, marketService });

console.log(`\n=== DEBUG EXPIRATION PRICE — ${ticker} ===\n`);

const cycles = db
  .prepare(
    `SELECT id, ticker, assignment_strike, cycle_status, final_exit_date, close_reason,
            assignment_date, scan_date, csp_premium
     FROM theoretical_wheel_cycles WHERE ticker = ?`
  )
  .all(ticker);

console.log("theoretical_wheel_cycles:");
console.log(JSON.stringify(cycles, null, 2));

for (const cycle of cycles) {
  const steps = db
    .prepare(
      `SELECT theoretical_cycle_id, ticker, sequence_number, test_date, cc_expiration,
              cc_strike, cc_sold_theoretical, expiration_close, expiration_price_source,
              result_at_expiration, called_away_theoretical, expired_otm, assignment_strike
       FROM theoretical_cc_steps
       WHERE theoretical_cycle_id = ?
       ORDER BY sequence_number`
    )
    .all(cycle.id);

  console.log(`\ntheoretical_cc_steps (cycle ${cycle.id}):`);
  console.log(JSON.stringify(steps, null, 2));

  for (const step of steps) {
    const rawExp = step.cc_expiration;
    const normalized = service.normalizeDateToYmd(rawExp);
    console.log(`\n--- Step seq=${step.sequence_number} ---`);
    console.log(`  cc_expiration raw     : "${rawExp}" (type: ${typeof rawExp})`);
    console.log(`  cc_expiration normalized: ${normalized}`);
    console.log(`  cc_strike             : ${step.cc_strike}`);
    console.log(`  cc_sold_theoretical   : ${step.cc_sold_theoretical}`);

    if (!normalized) {
      console.log("  SKIP: cannot normalize cc_expiration");
      continue;
    }

    const lookbackStart = (() => {
      const d = new Date(`${normalized}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 5);
      return d.toISOString().slice(0, 10);
    })();
    const rangeEnd = (() => {
      const d = new Date(`${normalized}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    })();

    console.log(`  OHLC range request    : ${lookbackStart} → ${rangeEnd} (usMarketDates)`);

    const range = await marketService.getDailyOhlcRange(cycle.ticker, lookbackStart, rangeEnd, {
      usMarketDates: true,
    });
    console.log(`  getDailyOhlcRange ok  : ${range?.ok}`);
    console.log(`  candles count         : ${range?.candles?.length ?? 0}`);
    if (range?.error) console.log(`  range error           : ${range.error}`);

    const aroundDates = ["2026-05-20", "2026-05-21", "2026-05-22"];
    console.log("  candles around expiration:");
    for (const d of aroundDates) {
      const c = range?.candles?.find((x) => x.date === d);
      console.log(`    ${d}: ${c ? JSON.stringify(c) : "NOT IN RANGE"}`);
    }
    if (range?.candles?.length) {
      console.log("  all candles in range:");
      for (const c of range.candles) {
        console.log(`    ${c.date}: close=${c.close}`);
      }
    }

    const resolution = service.resolveExpirationClosePrice({
      ccExpirationYmd: normalized,
      candles: range?.candles ?? [],
      todayYmd: "2026-05-24",
    });
    console.log("  resolveExpirationClosePrice:", JSON.stringify(resolution));

    const outcome = service.computeCcStepExpirationOutcome({
      step,
      priceResolution: resolution,
      todayYmd: "2026-05-24",
    });
    console.log("  computeCcStepExpirationOutcome:", JSON.stringify(outcome));
  }
}

console.log("\n=== cc_expiration format audit (top 10) ===");
const formatAudit = db
  .prepare(
    `SELECT cc_expiration, COUNT(*) AS cnt
     FROM theoretical_cc_steps
     WHERE cc_expiration IS NOT NULL
     GROUP BY cc_expiration
     ORDER BY cnt DESC
     LIMIT 10`
  )
  .all();
console.log(JSON.stringify(formatAudit, null, 2));

const nonDash = db
  .prepare(
    `SELECT cc_expiration, COUNT(*) AS cnt
     FROM theoretical_cc_steps
     WHERE cc_expiration IS NOT NULL AND cc_expiration NOT LIKE '%-%'
     GROUP BY cc_expiration
     LIMIT 10`
  )
  .all();
console.log("Non YYYY-MM-DD formats:", JSON.stringify(nonDash, null, 2));
