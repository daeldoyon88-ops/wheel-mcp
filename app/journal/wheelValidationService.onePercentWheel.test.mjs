import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLowerBoundStressForOnePercentProfile,
  computeDynamicTop20WheelProfiles,
  computeOnePercentWheelProfiles,
} from "./wheelValidationService.js";

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
        [
          "Touch élevé",
          "LB cassé élevé",
          "LB cassé avec stress",
          "LB cassé critique",
          "Wheel non disponible",
          "Assignation élevée",
        ].includes(reason),
      ),
    );
  }
});

test("classifyLowerBoundStressForOnePercentProfile — LB élevé sans dommage (profil type APLD)", () => {
  const result = classifyLowerBoundStressForOnePercentProfile({
    n: 26,
    csp: {
      recordsResolved: 26,
      lowerBoundBreakRate: 38.5,
      realWinRate: 100,
      assignmentRate: 0,
      strikeTouchRate: 23.1,
    },
    assignment: { profondeRatePct: null, profondeCount: 0 },
    wheel: { cyclesClosed: 0, cyclesAvailable: 0 },
  });
  assert.equal(result.lbStressClass, "sans_dommage");
  assert.equal(result.lbStressLabel, "LB cassé sans dommage");
});

test("classifyLowerBoundStressForOnePercentProfile — LB critique (profil type SMCI)", () => {
  const result = classifyLowerBoundStressForOnePercentProfile({
    n: 22,
    csp: {
      recordsResolved: 22,
      lowerBoundBreakRate: 90.9,
      realWinRate: 77.3,
      assignmentRate: 22.7,
      strikeTouchRate: 54.5,
    },
    assignment: { profondeRatePct: 0, profondeCount: 0 },
    wheel: { cyclesClosed: 12, cyclesAvailable: 12, avgWheelPnl: 97, recoveryRatePct: 100 },
  });
  assert.equal(result.lbStressClass, "critique");
  assert.equal(result.lbStressLabel, "LB cassé critique");
});

test("computeOnePercentWheelProfiles — LB élevé sans dommage ne force plus 1 % stressé seul", () => {
  const records = Array.from({ length: 26 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "APLD",
      yieldPct: 1.09,
      expiration: `202506${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202506${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "APLD" }).resolution,
      strikeTouched: index % 5 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: true,
      expiredWorthless: true,
      assigned: false,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "APLD" && p.groupType === "ticker");
  assert.ok(profile);
  assert.equal(profile.lowerBoundStress?.lbStressClass, "sans_dommage");
  assert.notEqual(profile.primaryVerdict, "1 % stressé");
  assert.ok(profile.verdictReasons.includes("LB cassé sans dommage"));
});

test("computeOnePercentWheelProfiles — LB critique garde 1 % stressé", () => {
  const records = Array.from({ length: 22 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "SMCI",
      yieldPct: 0.95,
      assigned: index % 4 === 0,
      expiration: `202507${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202507${String((index % 20) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "SMCI", assigned: index % 4 === 0 }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 2 === 0 || index % 3 === 0,
      popPredictionCorrect: index % 4 !== 0,
      expiredWorthless: index % 4 !== 0,
    },
  }));
  const result = computeOnePercentWheelProfiles(records, [], { today: "2026-05-24" });
  const profile = result.profiles.find((p) => p.ticker === "SMCI" && p.groupType === "ticker");
  assert.ok(profile);
  assert.ok(["avec_stress", "critique"].includes(profile.lowerBoundStress?.lbStressClass));
  assert.equal(profile.primaryVerdict, "1 % stressé");
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

function buildTickerProfilesFromRecords(records, cycles = [], options = {}) {
  return computeOnePercentWheelProfiles(records, cycles, options).profiles.filter(
    (profile) => profile.groupType === "ticker",
  );
}

test("computeDynamicTop20WheelProfiles — retourne au maximum 20 profils Top 20", () => {
  const records = [];
  for (let tickerIndex = 0; tickerIndex < 30; tickerIndex += 1) {
    const ticker = `T${String(tickerIndex).padStart(2, "0")}`;
    for (let index = 0; index < 35; index += 1) {
      records.push(
        buildResolvedRecord({
          ticker,
          yieldPct: 0.85 + (tickerIndex % 5) * 0.03,
          expiration: `202508${String(10 + (index % 18)).padStart(2, "0")}`,
          scanDate: `202508${String((index % 24) + 1).padStart(2, "0")}`,
        }),
      );
    }
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.length <= 20);
  assert.equal(result.summary.top20Count, result.top20.length);
});

test("computeDynamicTop20WheelProfiles — n < 15 plafonné hors Top 20 si assez de profils robustes", () => {
  const records = [];
  for (let tickerIndex = 0; tickerIndex < 25; tickerIndex += 1) {
    const ticker = `ROB${String(tickerIndex).padStart(2, "0")}`;
    const count = tickerIndex < 3 ? 12 : 35;
    for (let index = 0; index < count; index += 1) {
      records.push(
        buildResolvedRecord({
          ticker,
          yieldPct: tickerIndex < 3 ? 1.2 : 0.95,
          expiration: `202509${String(10 + (index % 18)).padStart(2, "0")}`,
          scanDate: `202509${String((index % 24) + 1).padStart(2, "0")}`,
        }),
      );
    }
  }
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  const smallProfiles = profiles.filter((profile) => (profile.csp?.recordsResolved ?? 0) < 15);
  assert.ok(smallProfiles.length >= 3);
  for (const small of smallProfiles) {
    assert.ok(!result.top20.some((row) => row.ticker === small.ticker));
  }
  assert.ok(
    result.watchValidate.some((row) => row.dynamicTop20Status === "watch_validate") ||
      result.insufficientSample.length > 0,
  );
});

test("computeDynamicTop20WheelProfiles — profil défavorable à rendement élevé classé excludedHighYield", () => {
  const records = Array.from({ length: 35 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "FAUX1",
      yieldPct: 1.15,
      assigned: index % 2 === 0,
      expiration: `202510${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202510${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "FAUX1", assigned: index % 2 === 0 }).resolution,
      strikeTouched: index % 2 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: index % 2 !== 0,
      expiredWorthless: index % 2 !== 0,
    },
  }));
  const profiles = buildTickerProfilesFromRecords(records, [], { today: "2026-05-24" });
  const fauxProfile = profiles.find((profile) => profile.ticker === "FAUX1");
  assert.ok(fauxProfile);
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(
    result.excludedHighYield.some((row) => row.ticker === "FAUX1") ||
      fauxProfile.primaryVerdict === "faux 1 %",
  );
  if (fauxProfile.primaryVerdict === "faux 1 %") {
    assert.ok(result.excludedHighYield.some((row) => row.ticker === "FAUX1"));
    assert.ok(!result.top20.some((row) => row.ticker === "FAUX1" && !row.avoidContext));
  }
});

test("computeDynamicTop20WheelProfiles — profil TQQQ-like peut entrer Top 20", () => {
  const records = Array.from({ length: 40 }, (_, index) => ({
    ...buildResolvedRecord({
      ticker: "TQQQ",
      yieldPct: 0.98,
      expiration: `202511${String(10 + (index % 18)).padStart(2, "0")}`,
      scanDate: `202511${String((index % 24) + 1).padStart(2, "0")}`,
    }),
    resolution: {
      ...buildResolvedRecord({ ticker: "TQQQ" }).resolution,
      strikeTouched: index % 8 === 0,
      brokeLowerBound: index % 3 === 0,
      popPredictionCorrect: true,
      expiredWorthless: true,
      assigned: false,
    },
  }));
  const cycles = [buildClosedCycle({ ticker: "TQQQ", pnl: 120, returnPct: 4.5 })];
  const profiles = buildTickerProfilesFromRecords(records, cycles, { today: "2026-05-24" });
  const tqqq = profiles.find((profile) => profile.ticker === "TQQQ");
  assert.ok(tqqq);
  assert.equal(tqqq.lowerBoundStress?.lbStressClass, "sans_dommage");
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.ok(result.top20.some((row) => row.ticker === "TQQQ"));
  const row = result.top20.find((item) => item.ticker === "TQQQ");
  assert.ok(row.dynamicTop20Score > 70);
});

test("computeDynamicTop20WheelProfiles — contextAvailability indique IV/saisonnalité non intégrés", () => {
  const profiles = buildTickerProfilesFromRecords(
    Array.from({ length: 35 }, (_, index) =>
      buildResolvedRecord({
        ticker: "CTX",
        expiration: `202512${String(10 + (index % 18)).padStart(2, "0")}`,
        scanDate: `202512${String((index % 24) + 1).padStart(2, "0")}`,
      }),
    ),
    [],
    { today: "2026-05-24" },
  );
  const result = computeDynamicTop20WheelProfiles(profiles, { today: "2026-05-24" });
  assert.equal(result.summary.contextAvailability.ivIntegrated, false);
  assert.equal(result.summary.contextAvailability.seasonalityIntegrated, false);
  assert.equal(result.summary.contextAvailability.marketContextIntegrated, false);
  assert.match(result.summary.contextAvailability.note, /non encore intégrés/i);
});
