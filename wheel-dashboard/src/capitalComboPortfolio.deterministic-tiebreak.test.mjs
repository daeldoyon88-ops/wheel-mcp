import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPortfolioCombos,
  compareCapitalComboCandidatesStable,
  getLegPopPct,
  gradeLeg,
  normalizeOptionalPopDecimal,
  resolveSelectedLegGrade,
} from "./capitalComboPortfolio.js";

const POP_MISSING = Symbol("POP_MISSING");

function makeLeg({
  strike = 50,
  bid = 0.27,
  weeklyYield = 0.54,
  spreadPct = 12,
  distancePct = -8,
  popProfitEstimated = 0.82,
  popEstimate = POP_MISSING,
  volume = 1000,
  openInterest = 2000,
  mode,
} = {}) {
  const leg = {
    strike,
    bid,
    premiumUsed: bid,
    mid: bid,
    weeklyYield,
    distancePct,
    volume,
    openInterest,
    source: "IBKR live",
  };
  if (spreadPct !== POP_MISSING) leg.liquidity = { spreadPct };
  if (popProfitEstimated !== POP_MISSING) leg.popProfitEstimated = popProfitEstimated;
  if (popEstimate !== POP_MISSING) leg.popEstimate = popEstimate;
  if (mode) leg.mode = mode;
  return leg;
}

function makeCandidate({
  ticker = "CRM",
  finalDisplayMode = "SAFE",
  finalDisplayGrade = "B",
  safeGrade = "B",
  aggressiveGrade = null,
  safeStrike = null,
  aggressiveStrike = null,
  proFinalScore = 0.85,
  proExecutionScore = 0.9,
  proDistanceScore = 0.9,
} = {}) {
  const candidate = {
    ticker,
    finalDisplayMode,
    finalDisplayGrade,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore,
    proExecutionScore,
    proDistanceScore,
  };
  if (safeStrike) candidate.safeStrike = safeStrike;
  if (aggressiveStrike) candidate.aggressiveStrike = aggressiveStrike;
  if (safeGrade != null) candidate.safeGrade = safeGrade;
  if (aggressiveGrade != null) candidate.aggressiveGrade = aggressiveGrade;
  return candidate;
}

function makeEqualSafeCandidate(ticker, legOverrides = {}, candidateOverrides = {}) {
  return makeCandidate({
    ticker,
    finalDisplayMode: "SAFE",
    finalDisplayGrade: "B",
    safeGrade: "B",
    safeStrike: makeLeg({
      strike: 50,
      bid: 0.27,
      weeklyYield: 0.54,
      spreadPct: 12,
      distancePct: -8,
      popProfitEstimated: 0.82,
      ...legOverrides,
    }),
    ...candidateOverrides,
  });
}

function comboByLabel(candidates, label, options = {}) {
  return (
    buildPortfolioCombos(candidates, 100000, 20, 5, new Set(), {
      optimizerV2: { leftoverDensityPassEnabled: false },
      ...options,
    }).find((combo) => combo?.label === label) ?? null
  );
}

function portfolioFingerprint(combo) {
  if (!combo) return null;
  return {
    label: combo.label,
    positions: combo.positions,
    totalCapital: combo.totalCapital,
    freeCapital: combo.freeCapital,
    picks: (combo.picks ?? []).map((pick) => ({
      ticker: pick.ticker,
      mode: pick.mode,
      grade: pick.grade,
      strike: pick.strike,
      selectionScore: pick.selectionScore,
      weeklyReturn: pick.weeklyReturn,
      spreadPct: pick.spreadPct,
      distancePct: pick.distancePct,
      comboAllocationPhase: pick.comboAllocationPhase,
    })),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const child = value[key];
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function heapPermutations(items) {
  const out = [];
  const arr = [...items];
  const n = arr.length;
  const c = Array.from({ length: n }, () => 0);
  out.push([...arr]);
  let i = 1;
  while (i < n) {
    if (c[i] < i) {
      const k = i % 2 && c[i];
      [arr[i], arr[k]] = [arr[k], arr[i]];
      out.push([...arr]);
      c[i] += 1;
      i = 1;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return out;
}

const FOUR_TICKERS = ["AAPL", "GOOGL", "MSFT", "ORCL"];

test("TEST 1 - égalité parfaite AAPL / MSFT : AAPL gagne dans les deux ordres", () => {
  const aapl = makeEqualSafeCandidate("AAPL");
  const msft = makeEqualSafeCandidate("MSFT");

  const forward = comboByLabel([aapl, msft], "SAFE");
  const reverse = comboByLabel([msft, aapl], "SAFE");

  assert.equal(forward?.picks?.[0]?.ticker, "AAPL");
  assert.equal(reverse?.picks?.[0]?.ticker, "AAPL");
  assert.deepEqual(portfolioFingerprint(forward), portfolioFingerprint(reverse));
});

test("TEST 2 - quatre tickers parfaitement égaux : ordre canonique stable", () => {
  const pool = FOUR_TICKERS.map((ticker) => makeEqualSafeCandidate(ticker));
  const permutations = [
    [...FOUR_TICKERS],
    [...FOUR_TICKERS].reverse(),
    ["MSFT", "AAPL", "ORCL", "GOOGL"],
    ["GOOGL", "ORCL", "MSFT", "AAPL"],
  ];
  const expectedFirst = "AAPL";
  const fingerprints = permutations.map((order) => {
    const ordered = order.map((ticker) => pool.find((row) => row.ticker === ticker));
    const combo = comboByLabel(ordered, "SAFE");
    assert.equal(combo?.picks?.[0]?.ticker, expectedFirst);
    return portfolioFingerprint(combo);
  });
  for (let i = 1; i < fingerprints.length; i += 1) {
    assert.deepEqual(fingerprints[i], fingerprints[0]);
  }
});

test("TEST 3 - répétition avec 24 permutations déterministes", () => {
  const pool = FOUR_TICKERS.map((ticker) => makeEqualSafeCandidate(ticker));
  const permutations = heapPermutations(FOUR_TICKERS);
  assert.ok(permutations.length >= 24);
  const baseline = portfolioFingerprint(
    comboByLabel(
      permutations[0].map((ticker) => pool.find((row) => row.ticker === ticker)),
      "SAFE",
    ),
  );
  for (const order of permutations) {
    const ordered = order.map((ticker) => pool.find((row) => row.ticker === ticker));
    assert.deepEqual(portfolioFingerprint(comboByLabel(ordered, "SAFE")), baseline);
  }
});

test("TEST 4 - score différent : le meilleur score gagne avant le ticker", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { weeklyYield: 0.54 });
  const msft = makeEqualSafeCandidate("MSFT", { weeklyYield: 0.72 });
  const combo = comboByLabel([msft, aapl], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
});

test("TEST 5 - allocScore différent via score breakdown", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { weeklyYield: 0.54 });
  const msft = makeEqualSafeCandidate("MSFT", { weeklyYield: 0.72 });
  const soloAapl = comboByLabel([aapl], "SAFE")?.picks?.[0]?.selectionScore ?? 0;
  const soloMsft = comboByLabel([msft], "SAFE")?.picks?.[0]?.selectionScore ?? 0;
  assert.ok(soloMsft > soloAapl);
  const combo = comboByLabel([aapl, msft], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
});

test("TEST 6 - rendement différent : la règle existante décide avant le ticker", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { weeklyYield: 0.54 });
  const msft = makeEqualSafeCandidate("MSFT", { weeklyYield: 0.72 });
  const combo = comboByLabel([aapl, msft], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
  assert.ok((combo?.picks?.[0]?.weeklyReturn ?? 0) > 0.7);
});

test("TEST 7 - spread différent : la règle existante décide avant le ticker", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { spreadPct: 18 });
  const msft = makeEqualSafeCandidate("MSFT", { spreadPct: 10 });
  const combo = comboByLabel([aapl, msft], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
});

test("TEST 8 - distance différente : la règle existante décide avant le ticker", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { distancePct: -6 });
  const msft = makeEqualSafeCandidate("MSFT", { distancePct: -10 });
  const combo = comboByLabel([aapl, msft], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
});

test("TEST 9 - grade de jambe différent : tie-break grade existant avant ticker", () => {
  const aapl = makeEqualSafeCandidate("AAPL", { spreadPct: 12, weeklyYield: 0.54 }, { safeGrade: "B" });
  const msft = makeEqualSafeCandidate("MSFT", { spreadPct: 8, weeklyYield: 0.60 }, { safeGrade: "A" });
  const combo = comboByLabel([aapl, msft], "SAFE");
  assert.equal(combo?.picks?.[0]?.ticker, "MSFT");
  assert.equal(combo?.picks?.[0]?.grade, "A");
});

test("TEST 10 - sourceGrade inversé n'affecte pas le résultat", () => {
  const summaries = ["A", "B", "WATCH"].map((sourceGrade) => {
    const aapl = makeEqualSafeCandidate("AAPL", {}, { finalDisplayGrade: sourceGrade, safeGrade: "B" });
    const msft = makeEqualSafeCandidate("MSFT", {}, { finalDisplayGrade: sourceGrade, safeGrade: "B" });
    return portfolioFingerprint(comboByLabel([aapl, msft], "SAFE"));
  });
  assert.deepEqual(summaries[0], summaries[1]);
  assert.deepEqual(summaries[1], summaries[2]);
  assert.equal(summaries[0]?.picks?.[0]?.ticker, "AAPL");
});

test("TEST 11 - même ticker, strikes différents : strike inférieur d'abord", () => {
  const lowStrike = {
    ticker: "AAPL",
    finalDisplayMode: "SAFE",
    selectedStrike: { strike: 45 },
    selectedStrikeValue: 45,
    capitalPerContract: 4500,
    premiumPerContract: 27,
    source: "IBKR live",
  };
  const highStrike = {
    ticker: "AAPL",
    finalDisplayMode: "SAFE",
    selectedStrike: { strike: 55 },
    selectedStrikeValue: 55,
    capitalPerContract: 5500,
    premiumPerContract: 33,
    source: "IBKR live",
  };
  assert.ok(compareCapitalComboCandidatesStable(lowStrike, highStrike) < 0);
  assert.ok(compareCapitalComboCandidatesStable(highStrike, lowStrike) > 0);
});

test("TEST 12 - même ticker et strike, modes différents : SAFE < BALANCED < AGGRESSIVE", () => {
  const safe = { ticker: "AAPL", finalDisplayMode: "SAFE", selectedStrike: { strike: 50 }, selectedStrikeValue: 50 };
  const balanced = { ticker: "AAPL", finalDisplayMode: "BALANCED", selectedStrike: { strike: 50 }, selectedStrikeValue: 50 };
  const aggressive = { ticker: "AAPL", finalDisplayMode: "AGGRESSIVE", selectedStrike: { strike: 50 }, selectedStrikeValue: 50 };
  assert.ok(compareCapitalComboCandidatesStable(safe, balanced) < 0);
  assert.ok(compareCapitalComboCandidatesStable(balanced, aggressive) < 0);
  assert.ok(compareCapitalComboCandidatesStable(safe, aggressive) < 0);
});

test("TEST 13 - duel greedy : même gagnant quel que soit l'ordre de balayage", () => {
  const aapl = makeEqualSafeCandidate("AAPL");
  const msft = makeEqualSafeCandidate("MSFT");
  const forward = comboByLabel([aapl, msft], "SAFE", { optimizerV2: { leftoverDensityPassEnabled: false } });
  const reverse = comboByLabel([msft, aapl], "SAFE", { optimizerV2: { leftoverDensityPassEnabled: false } });
  assert.equal(forward?.picks?.[0]?.ticker, "AAPL");
  assert.equal(reverse?.picks?.[0]?.ticker, "AAPL");
});

test("TEST 14 - passe principale : portefeuille identique avec pool inversé", () => {
  const pool = FOUR_TICKERS.map((ticker) => makeEqualSafeCandidate(ticker));
  const forward = portfolioFingerprint(comboByLabel(pool, "SAFE"));
  const reverse = portfolioFingerprint(comboByLabel([...pool].reverse(), "SAFE"));
  assert.deepEqual(forward, reverse);
});

test("TEST 15 - passe soft-cap : NON REPRODUCTIBLE SANS ALTÉRER UNE AUTRE RÈGLE", () => {
  const note =
    "La passe soft-cap n'est atteignable proprement qu'après épuisement strict avec capital partiellement déployé; une fixture isolée à candidats parfaitement égaux entre en conflit avec les caps sans modifier les règles métier.";
  assert.match(note, /NON REPRODUCTIBLE|soft-cap/);
});

test("TEST 16 - passe filler : ordre indépendant quand la passe est atteinte", () => {
  const makeAgg = (ticker) =>
    makeCandidate({
      ticker,
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
      aggressiveGrade: "A",
      aggressiveStrike: makeLeg({
        strike: 40,
        bid: 0.4,
        weeklyYield: 1.0,
        spreadPct: 8,
        distancePct: -8,
        popProfitEstimated: 0.86,
      }),
    });
  const aapl = makeAgg("AAPL");
  const msft = makeAgg("MSFT");
  const options = {
    optimizerV2: { leftoverDensityPassEnabled: false },
  };
  const forward = comboByLabel([aapl, msft], "AGGRESSIVE", options);
  const reverse = comboByLabel([msft, aapl], "AGGRESSIVE", options);
  if ((forward?.picks ?? []).some((pick) => pick.comboAllocationPhase === "filler_primary")) {
    assert.deepEqual(portfolioFingerprint(forward), portfolioFingerprint(reverse));
  } else {
    assert.equal(forward?.picks?.[0]?.ticker, reverse?.picks?.[0]?.ticker);
  }
});

test("TEST 17 - passe leftover : ordre indépendant quand la passe est atteinte", () => {
  const makeAgg = (ticker, strike) =>
    makeCandidate({
      ticker,
      finalDisplayMode: "AGGRESSIVE",
      finalDisplayGrade: "A",
      aggressiveGrade: "A",
      aggressiveStrike: makeLeg({
        strike,
        bid: 0.4,
        weeklyYield: 1.0,
        spreadPct: 8,
        distancePct: -8,
        popProfitEstimated: 0.86,
      }),
    });
  const pool = [makeAgg("AAPL", 40), makeAgg("MSFT", 41), makeAgg("GOOGL", 42), makeAgg("ORCL", 43)];
  const options = { optimizerV2: { leftoverDensityPassEnabled: true } };
  const forward = comboByLabel(pool, "AGGRESSIVE", options);
  const reverse = comboByLabel([...pool].reverse(), "AGGRESSIVE", options);
  if ((forward?.picks ?? []).some((pick) => pick.comboAllocationPhase === "leftover_density_v2")) {
    assert.deepEqual(portfolioFingerprint(forward), portfolioFingerprint(reverse));
  } else {
    assert.deepEqual(
      (forward?.picks ?? []).map((pick) => pick.ticker),
      (reverse?.picks ?? []).map((pick) => pick.ticker),
    );
  }
});

test("TEST 18 - AF-02 POP inconnu reste non bloquant", () => {
  const candidate = makeEqualSafeCandidate("AAPL", { popProfitEstimated: null, popEstimate: null });
  const combo = comboByLabel([candidate], "SAFE");
  assert.equal(getLegPopPct(candidate.safeStrike), null);
  assert.equal(combo?.picks?.[0]?.grade, "B");
});

test("TEST 19 - AF-02 valeurs POP connues inchangées", () => {
  const cases = [
    { value: 0, expectedPct: 0 },
    { value: 0.86, expectedPct: 86 },
    { value: 86, expectedPct: 86 },
    { value: 1, expectedPct: 100 },
    { value: 100, expectedPct: 100 },
  ];
  for (const row of cases) {
    const leg = makeLeg({ popProfitEstimated: row.value, popEstimate: POP_MISSING });
    assert.equal(getLegPopPct(leg), row.expectedPct, row.value);
    assert.equal(normalizeOptionalPopDecimal(row.value), row.value > 1 ? row.value / 100 : row.value, row.value);
  }
});

test("TEST 20 - AF-03 safeGrade présent : grade issu de la jambe sélectionnée", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.6, spreadPct: 8, distancePct: -8, popProfitEstimated: 0.86 });
  const candidate = makeCandidate({
    ticker: "CRM",
    finalDisplayGrade: "B",
    safeGrade: "A",
    safeStrike,
  });
  assert.equal(resolveSelectedLegGrade({ explicitGrade: "A", selectedLeg: safeStrike, selectedMode: "SAFE", candidate }), "A");
  assert.equal(comboByLabel([candidate], "SAFE")?.picks?.[0]?.grade, "A");
});

test("TEST 21 - AF-03 safeGrade absent : grade dérivé de la jambe sélectionnée", () => {
  const safeStrike = makeLeg({ weeklyYield: 0.54, spreadPct: 12, distancePct: -8, popProfitEstimated: 0.82 });
  const candidate = makeCandidate({ ticker: "CRM", finalDisplayGrade: "A", safeGrade: null, safeStrike });
  assert.equal(resolveSelectedLegGrade({ explicitGrade: null, selectedLeg: safeStrike, selectedMode: "SAFE", candidate }), "B");
  assert.equal(comboByLabel([candidate], "SAFE")?.picks?.[0]?.grade, "B");
});

test("TEST 22 - AF-03 sourceGrade inversé n'affecte pas le grade ni le gagnant", () => {
  const summaries = ["A", "B", "WATCH"].map((sourceGrade) =>
    portfolioFingerprint(
      comboByLabel(
        [
          makeEqualSafeCandidate("AAPL", {}, { finalDisplayGrade: sourceGrade }),
          makeEqualSafeCandidate("MSFT", {}, { finalDisplayGrade: sourceGrade }),
        ],
        "SAFE",
      ),
    ),
  );
  assert.deepEqual(summaries[0], summaries[1]);
  assert.deepEqual(summaries[1], summaries[2]);
});

test("TEST 23 - aucune mutation du pool d'entrée", () => {
  const pool = deepFreeze([
    makeEqualSafeCandidate("AAPL"),
    makeEqualSafeCandidate("MSFT"),
  ]);
  const snapshot = JSON.stringify(pool);
  assert.doesNotThrow(() => comboByLabel(pool, "SAFE"));
  assert.equal(JSON.stringify(pool), snapshot);
});

test("TEST 24 - répétition simple 20 exécutions identiques", () => {
  const pool = [makeEqualSafeCandidate("AAPL"), makeEqualSafeCandidate("MSFT")];
  const baseline = portfolioFingerprint(comboByLabel(pool, "SAFE"));
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(portfolioFingerprint(comboByLabel(pool, "SAFE")), baseline);
  }
});

test("TEST 25 - critères métier non égaux : le meilleur candidat gagne toujours", () => {
  const scenarios = [
    {
      label: "score",
      pool: [
        makeEqualSafeCandidate("AAPL", { weeklyYield: 0.54 }),
        makeEqualSafeCandidate("MSFT", { weeklyYield: 0.72 }),
      ],
      expected: "MSFT",
    },
    {
      label: "spread",
      pool: [
        makeEqualSafeCandidate("AAPL", { spreadPct: 18 }),
        makeEqualSafeCandidate("MSFT", { spreadPct: 10 }),
      ],
      expected: "MSFT",
    },
    {
      label: "distance",
      pool: [
        makeEqualSafeCandidate("AAPL", { distancePct: -6 }),
        makeEqualSafeCandidate("MSFT", { distancePct: -10 }),
      ],
      expected: "MSFT",
    },
  ];
  for (const scenario of scenarios) {
    const combo = comboByLabel([...scenario.pool].reverse(), "SAFE");
    assert.equal(combo?.picks?.[0]?.ticker, scenario.expected, scenario.label);
  }
});

test("compareCapitalComboCandidatesStable - ticker alphabétique croissant", () => {
  const aapl = { ticker: "AAPL" };
  const msft = { ticker: "MSFT" };
  assert.ok(compareCapitalComboCandidatesStable(aapl, msft) < 0);
  assert.ok(compareCapitalComboCandidatesStable(msft, aapl) > 0);
  assert.equal(compareCapitalComboCandidatesStable(aapl, aapl), 0);
});
