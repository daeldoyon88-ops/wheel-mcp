import { DatabaseSync } from "node:sqlite";

export function createTheoreticalCycleService({ validationStore, cycleStore } = {}) {
  if (!validationStore?.sqlitePath) throw new Error("createTheoreticalCycleService: validationStore with sqlitePath is required");
  if (!cycleStore?.upsertCycle) throw new Error("createTheoreticalCycleService: cycleStore with upsertCycle is required");

  const sqlitePath = validationStore.sqlitePath;

  // ─────────────────────────────────────────────
  // buildCycleFromAssignedRecord
  // Pure function — receives a flat SQLite row from wheel_validation_records.
  // Returns a cycle object compatible with cycleStore.upsertCycle(), or null if invalid.
  // ─────────────────────────────────────────────
  function buildCycleFromAssignedRecord(record) {
    if (!record?.id) return null;
    const ticker = record.symbol ?? record.ticker ?? null;
    if (!ticker) return null;
    if (record.strike == null) return null;

    const isAssigned = record.assigned_flag === 1 || record.assigned_flag === true;
    if (!isAssigned) return null;

    const strike = Number(record.strike);
    if (!Number.isFinite(strike)) return null;

    const csp_premium = record.premium != null ? Number(record.premium) : null;

    const assignment_price =
      record.underlying_close_at_expiration != null ? Number(record.underlying_close_at_expiration) :
      record.expirationClosePrice != null ? Number(record.expirationClosePrice) :
      record.expiration_close_price != null ? Number(record.expiration_close_price) :
      null;

    // Prefer expiration date, then resolution date, then resolvedAt
    const assignment_date =
      record.expiration != null ? record.expiration :
      record.resolutionDate != null ? record.resolutionDate :
      record.resolvedAt != null ? record.resolvedAt :
      null;

    const spot_at_scan =
      record.spotAtScan != null ? Number(record.spotAtScan) :
      record.underlying_price_at_scan != null ? Number(record.underlying_price_at_scan) :
      record.spot_at_scan != null ? Number(record.spot_at_scan) :
      null;

    const reduced_cost_basis_estimated =
      Number.isFinite(strike) && csp_premium != null && Number.isFinite(csp_premium)
        ? strike - csp_premium
        : null;

    // data_quality: prefer numeric score, fall back to confidence string
    const data_quality =
      record.data_quality_score != null ? String(record.data_quality_score) :
      record.resolution_confidence != null ? record.resolution_confidence :
      null;

    return {
      id: `theoretical_cycle_${record.id}`,
      candidate_record_id: String(record.id),
      trade_signature: record.trade_signature ?? null,
      scan_session_id: record.scanSessionId ?? record.scan_session_id ?? null,
      scan_timestamp: record.scanTimestamp ?? record.scan_timestamp ?? null,
      scan_date: record.scanDate ?? record.scan_date ?? null,
      ticker,
      expiration: record.expiration ?? record.selectedExpiration ?? null,
      assignment_date,
      assignment_strike: strike,
      assignment_price,
      spot_at_scan,
      spot_at_assignment: assignment_price,
      strike_mode: record.strikeMode ?? record.strike_mode ?? null,
      csp_strike: strike,
      csp_premium,
      csp_yield_pct: record.annualizedYield != null ? Number(record.annualizedYield) : null,
      pop_estimate:
        record.popEstimate != null ? Number(record.popEstimate) :
        record.pop_estimate != null ? Number(record.pop_estimate) :
        null,
      distance_strike_from_spot_pct:
        record.distance_strike_from_spot_pct != null ? Number(record.distance_strike_from_spot_pct) : null,
      status: "open",
      current_step: 0,
      days_to_strike_touch: null,
      days_to_strike_close_above: null,
      days_below_assignment_strike: null,
      max_drawdown_pct:
        record.drawdownPct != null ? Number(record.drawdownPct) :
        record.drawdown_pct != null ? Number(record.drawdown_pct) :
        null,
      total_cc_premium_estimated: 0,
      total_cc_premium_conservative: 0,
      total_premium_estimated: csp_premium ?? 0,
      reduced_cost_basis_estimated,
      cc_sellable_steps_count: 0,
      cc_wait_steps_count: 0,
      best_cc_threshold_reached: null,
      source_prime_method: "not_priced_yet",
      confidence_level: record.resolution_confidence ?? "unknown",
      data_quality,
      raw: {
        source: "wheel_validation_records",
        assigned_flag: record.assigned_flag,
        resolved_source: record.resolved_source ?? null,
        resultStatus: record.resultStatus ?? null,
        outcomeStatus: record.outcomeStatus ?? null,
      },
    };
  }

  // ─────────────────────────────────────────────
  // generateCyclesFromAssignedRecords
  // Reads assigned CSP records from wheel_validation_records and creates
  // theoretical_wheel_cycles entries. Safe to re-run (idempotent via upsert).
  // ─────────────────────────────────────────────
  async function generateCyclesFromAssignedRecords({ limit = null, dryRun = false, includeExisting = false } = {}) {
    await cycleStore.ensureInitialized();

    // Open a read connection against the validation store's SQLite file.
    // Both stores share the same DB file; this is a read-only usage.
    const db = new DatabaseSync(sqlitePath);

    const totalRow = db.prepare("SELECT COUNT(*) AS cnt FROM wheel_validation_records").get();
    const scanned_records = totalRow?.cnt ?? 0;

    const assignedCountRow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE resolved = 1 AND assigned_flag = 1"
    ).get();
    const assigned_records = assignedCountRow?.cnt ?? 0;

    let sql =
      "SELECT * FROM wheel_validation_records WHERE resolved = 1 AND assigned_flag = 1 " +
      "AND strike IS NOT NULL AND symbol IS NOT NULL ORDER BY scanTimestamp DESC";
    if (limit != null) sql += ` LIMIT ${Number(limit)}`;

    const rows = db.prepare(sql).all();

    const errors = [];
    const built = [];
    let cycles_upserted = 0;
    let skipped_not_assigned = 0;
    let skipped_missing_required = 0;

    for (const row of rows) {
      const cycle = buildCycleFromAssignedRecord(row);
      if (!cycle) {
        skipped_missing_required++;
        continue;
      }
      built.push(cycle);

      if (!dryRun) {
        try {
          await cycleStore.upsertCycle(cycle);
          cycles_upserted++;
        } catch (err) {
          errors.push({ id: cycle.id, error: String(err?.message ?? err) });
        }
      }
    }

    const sample_cycles = built.slice(0, 5).map((c) => ({
      id: c.id,
      ticker: c.ticker,
      assignment_strike: c.assignment_strike,
      csp_premium: c.csp_premium,
      assignment_date: c.assignment_date,
      strike_mode: c.strike_mode,
      status: c.status,
    }));

    return {
      ok: true,
      dryRun,
      scanned_records,
      assigned_records,
      eligible_records: built.length,
      cycles_built: built.length,
      cycles_upserted,
      skipped_not_assigned,
      skipped_missing_required,
      errors,
      sample_cycles,
    };
  }

  async function listTheoreticalCycles(limit = 100) {
    return cycleStore.listCycles(limit);
  }

  async function getTheoreticalCycleSummary() {
    return cycleStore.getSummary();
  }

  return {
    buildCycleFromAssignedRecord,
    generateCyclesFromAssignedRecords,
    listTheoreticalCycles,
    getTheoreticalCycleSummary,
  };
}
