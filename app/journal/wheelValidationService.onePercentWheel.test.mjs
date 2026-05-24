import test from "node:test";
import assert from "node:assert/strict";
import { computeOnePercentWheelProfiles } from "./wheelValidationService.js";

function buildResolvedRecord({
  ticker = "TEST",
  mode = "safe",
  yieldPct = 1,
  assigned = false,
  expiration = "20250110",
  scanDate = "20250101",
}) {
  const strike = 100;
  const premium = (yieldPct / 100) * strike;
  return {
    symbol: ticker,
    strikeMode: mode,
    expiration,
    scanDate,
    captureClass: "primaryDaily",
    strike: { strike, popEstimate: 0.92, bid: premium, ask: premium + 0.02 },
    resolution: {
      resolved: true,
      assigned,
      expiredWorthless: !assigned,
      strikeTouched: false,
      brokeLowerBound: false,
      popPredictionCorrect: !assigned,
      underlying_close_at_expiration: assigned ? strike - 0.5 : strike + 2,
    },
  };
}

function buildClosedCycle({ ticker = "TEST", mode = "safe", pnl = 50, returnPct = 2 }) {
  return {
    ticker,
    strike_mode: mode,
    cycle_status: "closed",
    status: "closed_theoretical",
    close_reason: "cc_called_away",
    assignment_recovered: 1,
    cc_sold_count: 2,
    cc_not_sold_count: 0,
    total_cc_premium_conservative: 1.5,
    total_pnl_contract: pnl,
    return_on_assignment_pct: returnPct,
    days_in_cycle: 45,
    first_cc_step: { cc_sold_theoretical: 1, cc_yield_conservative_pct: 1.2 },
  };
}

test("computeOnePercentWheelProfiles — n < 30 ne peut pas afficher 1 % défendable", () => {
  const records = Array.from({ length: 25 }, (_, index) =>
    buildResolvedRecord({
      ticker: "SMALL",
      expiration: `202501${String(10 + index).padStart(2, "0")}`,
      scanDate: `202501${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "SMALL" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(!profile.verdicts.includes("1 % défendable"));
  assert.notEqual(profile.primaryVerdict, "1 % défendable");
});

test("computeOnePercentWheelProfiles — cycles ouverts exclus du P/L fermé", () => {
  const records = Array.from({ length: 35 }, (_, index) =>
    buildResolvedRecord({
      ticker: "PNL",
      yieldPct: 1.1,
      assigned: index % 4 === 0,
      expiration: `202502${String(10 + (index % 20)).padStart(2, "0")}`,
      scanDate: `202502${String((index % 28) + 1).padStart(2, "0")}`,
    }),
  );
  const cycles = [
    buildClosedCycle({ ticker: "PNL", pnl: 80, returnPct: 3 }),
    {
      ticker: "PNL",
      strike_mode: "safe",
      cycle_status: "open",
      status: "open",
      assignment_recovered: 0,
      cc_sold_count: 0,
      cc_not_sold_count: 3,
      total_pnl_contract: -500,
      return_on_assignment_pct: -10,
    },
  ];
  const result = computeOnePercentWheelProfiles(records, cycles, { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "PNL" && p.groupType === "ticker");
  assert.equal(profile.wheel.cyclesOpen, 1);
  assert.equal(profile.wheel.cyclesClosed, 1);
  assert.equal(profile.wheel.avgWheelPnl, 80);
});

test("computeOnePercentWheelProfiles — exclut intradayRetest et expirations futures", () => {
  const records = [
    buildResolvedRecord({ ticker: "FILT", expiration: "20270115" }),
    {
      ...buildResolvedRecord({ ticker: "FILT", expiration: "20250105" }),
      captureClass: "intradayRetest",
    },
    {
      ...buildResolvedRecord({ ticker: "FILT", expiration: "20270101" }),
      resolution: { resolved: false },
    },
  ];
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  assert.equal(result.summary.recordsUsed, 0);
});

test("computeOnePercentWheelProfiles — profil ticker+mode seulement si échantillon suffisant", () => {
  const records = Array.from({ length: 12 }, (_, index) =>
    buildResolvedRecord({
      ticker: "MODE",
      mode: "safe",
      expiration: `202503${String(10 + index).padStart(2, "0")}`,
      scanDate: `202503${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24", minModeProfileN: 15 });
  assert.ok(result.profiles.some((p) => p.ticker === "MODE" && p.groupType === "ticker"));
  assert.ok(!result.profiles.some((p) => p.ticker === "MODE" && p.groupType === "ticker_mode"));
});

test("computeOnePercentWheelProfiles — verdictReasons explique un profil stressé", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "STRESS",
      yieldPct: 1.1,
      expiration: `202504${String(10 + (index % 20)).padStart(2, "0")}`,
      scanDate: `202504${String((index % 28) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "STRESS" }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 3 === 0,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "STRESS" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(Array.isArray(profile.verdictReasons));
  assert.ok(profile.verdictReasons.length > 0);
  assert.ok(profile.verdictReasons.includes("Rendement CSP élevé"));
  if (profile.primaryVerdict === "1 % stressé") {
    assert.ok(
      profile.verdictReasons.some((reason) =>
        ["Touch élevé", "LB cassé élevé", "Wheel non disponible", "Assignation élevée"].includes(reason),
      ),
    );
  }
});

test("computeOnePercentWheelProfiles — verdictReasons mentionne échantillon préliminaire", () => {
  const records = Array.from({ length: 20 }, (_, index) =>
    buildResolvedRecord({
      ticker: "PRELIM",
      yieldPct: 1.05,
      expiration: `202505${String(10 + index).padStart(2, "0")}`,
      scanDate: `202505${String(index + 1).padStart(2, "0")}`,
    }),
  );
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "PRELIM" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(profile.verdictReasons.includes("Échantillon préliminaire"));
});
