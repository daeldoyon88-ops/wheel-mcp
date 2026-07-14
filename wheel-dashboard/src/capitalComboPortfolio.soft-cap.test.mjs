import test from "node:test";
import assert from "node:assert/strict";

import { buildPortfolioCombos } from "./capitalComboPortfolio.js";
import { VirtualAllocator } from "./alternativeCompositionSimV1.js";

// ─── AF-08 / POLITIQUE B ─────────────────────────────────────────────────────
// La phase soft n'assouplit que le nombre de contrats (maxContractsPerTicker+1),
// jamais les caps en dollars : aucune tolérance ×1.1 sur tickerCapLimit ni
// positionCapLimit. Les caps secteur/thème/high-beta et le capital déployable
// restent stricts dans toutes les phases. Tests sur le vrai moteur de
// production (buildPortfolioCombos) + miroir simulation (VirtualAllocator).

function makeSafeLeg(strike, weeklyYield = 0.6, dteDays = 7) {
  return {
    strike,
    bid: 0.6,
    premiumUsed: 0.6,
    mid: 0.6,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct: -8,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeAggLeg(strike, weeklyYield = 1.2, dteDays = 7) {
  return {
    strike,
    bid: 0.6,
    premiumUsed: 0.6,
    mid: 0.6,
    weeklyYield,
    periodYield: weeklyYield,
    dteDays,
    distancePct: -8,
    liquidity: { spreadPct: 8 },
    volume: 500,
    openInterest: 1000,
    source: "IBKR live",
    popProfitEstimated: 0.86,
  };
}

function makeCandidate(ticker, { safeStrike = null, aggressiveStrike = null, dteDays = 7 } = {}) {
  const candidate = {
    ticker,
    dteDays,
    optionsSource: "IBKR live",
    hasEarningsBeforeExpiration: false,
    hasUpcomingEarningsBeforeExpiration: false,
    earningsDaysUntil: null,
    proFinalScore: 0.8,
    proExecutionScore: 0.9,
    proDistanceScore: 1,
  };
  if (safeStrike) candidate.safeStrike = safeStrike;
  if (aggressiveStrike) candidate.aggressiveStrike = aggressiveStrike;
  return candidate;
}

function combosFor(candidates, capital, maxCapitalPct = 100, maxPositions = 5) {
  return buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions, new Set(), { optimizerV2: {} }) ?? [];
}

function comboByLabel(combos, label) {
  return (combos || []).find((combo) => combo?.label === label) ?? null;
}

function rejectionTotals(combo) {
  return combo?.capDiagnosticsV2?.rejectionTotalsAcrossCycles ?? {};
}

function snapshotCombos(combos) {
  return JSON.stringify(
    (combos || []).map((combo) => ({
      label: combo.label,
      totalCapital: combo.totalCapital,
      picks: (combo.picks ?? []).map((p) => ({
        ticker: p.ticker,
        contracts: p.contracts,
        capitalUsed: p.capitalUsed,
        phase: p.comboAllocationPhase,
        score: p.selectionScore,
      })),
    })),
  );
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// Pool mixte partagé (TESTS 17, 22, 23, 24) — couvre SAFE, BALANCED et AGGRESSIVE.
function makeMixedPool() {
  return [
    makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) }),
    makeCandidate("ORCL", { safeStrike: makeSafeLeg(24) }),
    makeCandidate("KO", { safeStrike: makeSafeLeg(9) }),
    makeCandidate("NKE", { safeStrike: makeSafeLeg(28, 0.9) }),
    makeCandidate("TGT", { safeStrike: makeSafeLeg(26, 0.8) }),
    makeCandidate("NFLX", { aggressiveStrike: makeAggLeg(30) }),
    makeCandidate("AMD", { aggressiveStrike: makeAggLeg(28) }),
  ];
}

// Pool du scénario de brèche O (TESTS 12, 13) — SAFE 10 000 $ :
// MSFT 2 500 $ pris en strict, ORCL 2 400 $ bloqué cap secteur Technology
// (4 900 $ > 4 000 $), fenêtre soft avec enforceClusterCaps=false pour KO
// 3 200 $ (> cap ticker strict 3 000 $) grâce à l'alternative diversifiante.
function makeBreachOPool() {
  return [
    makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) }),
    makeCandidate("ORCL", { safeStrike: makeSafeLeg(24) }),
    makeCandidate("KO", { safeStrike: makeSafeLeg(32) }),
  ];
}

// ─── Nouvelles lignes au-dessus du cap ticker strict (TESTS 1-3) ─────────────

test("TEST 1 — SAFE : nouvelle ligne 3 200 $ > cap strict 3 000 $ rejetée (aucun pick, ticker_cap_reached)", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(32) })], 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 0);
  assert.ok((rejectionTotals(combo).ticker_cap_reached ?? 0) >= 1, "diagnostic ticker_cap_reached attendu");
});

test("TEST 2 — BALANCED : nouvelle ligne 3 200 $ > cap strict 3 000 $ rejetée (aucun pick, ticker_cap_reached)", () => {
  const combo = comboByLabel(
    combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(32, 0.9) })], 10000),
    "BALANCED",
  );
  assert.ok(combo, "combo BALANCED attendu");
  assert.equal(combo.picks.length, 0);
  assert.ok((rejectionTotals(combo).ticker_cap_reached ?? 0) >= 1, "diagnostic ticker_cap_reached attendu");
});

test("TEST 3 — AGGRESSIVE : nouvelle ligne 5 200 $ entre cap strict 5 000 $ et ancien ×1.1 5 500 $ rejetée", () => {
  const combo = comboByLabel(
    combosFor([makeCandidate("NFLX", { aggressiveStrike: makeAggLeg(52) })], 10000),
    "AGGRESSIVE",
  );
  assert.ok(combo, "combo AGGRESSIVE attendu");
  assert.equal(combo.picks.length, 0);
  assert.ok((rejectionTotals(combo).ticker_cap_reached ?? 0) >= 1, "diagnostic ticker_cap_reached attendu");
});

// ─── Frontière exacte du cap strict (TESTS 4-6) ──────────────────────────────

test("TEST 4 — exactement au cap strict (3 000 $) : accepté en phase stricte", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(30) })], 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 1);
  assert.equal(combo.picks[0].capitalUsed, 3000);
  assert.equal(combo.picks[0].contracts, 1);
  assert.equal(combo.picks[0].comboAllocationPhase, "primary_strict");
});

test("TEST 5 — juste au-dessus du cap strict (3 050 $) : rejeté", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(30.5) })], 10000), "SAFE");
  assert.equal(combo?.picks?.length ?? 0, 0);
});

test("TEST 6 — valeur de l'ancien cap ×1.1 exact (3 300 $) : rejeté", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(33) })], 10000), "SAFE");
  assert.equal(combo?.picks?.length ?? 0, 0);
});

// ─── +1 contrat sous le cap strict en dollars (TESTS 7-9) ────────────────────

test("TEST 7 — SAFE : 3e contrat (soft +1) à 900 $ accepté, 2 700 $ ≤ 3 000 $, phase primary_soft_cap", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(9) })], 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 1);
  const pick = combo.picks[0];
  assert.equal(pick.contracts, 3, "maxContractsPerTicker(2)+1 attendu");
  assert.equal(pick.capitalUsed, 2700);
  assert.equal(pick.comboAllocationPhase, "primary_soft_cap");
  assert.equal(combo.totalCapital, 2700);
});

test("TEST 8 — BALANCED : 4e contrat (soft +1) à 700 $ accepté, 2 800 $ ≤ 3 000 $, phase primary_soft_cap", () => {
  const combo = comboByLabel(
    combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(7, 0.9) })], 10000),
    "BALANCED",
  );
  assert.ok(combo, "combo BALANCED attendu");
  assert.equal(combo.picks.length, 1);
  const pick = combo.picks[0];
  assert.equal(pick.contracts, 4, "maxContractsPerTicker(3)+1 attendu");
  assert.equal(pick.capitalUsed, 2800);
  assert.equal(pick.comboAllocationPhase, "primary_soft_cap");
});

test("TEST 9 — AGGRESSIVE : 5e contrat (soft +1) à 900 $ accepté, 4 500 $ ≤ 5 000 $, phase primary_soft_cap", () => {
  const combo = comboByLabel(
    combosFor([makeCandidate("NFLX", { aggressiveStrike: makeAggLeg(9) })], 10000),
    "AGGRESSIVE",
  );
  assert.ok(combo, "combo AGGRESSIVE attendu");
  assert.equal(combo.picks.length, 1);
  const pick = combo.picks[0];
  assert.equal(pick.contracts, 5, "maxContractsPerTicker(4)+1 attendu");
  assert.equal(pick.capitalUsed, 4500);
  assert.equal(pick.comboAllocationPhase, "primary_soft_cap");
});

// ─── Renforcement et limite de contrats (TESTS 10-11) ────────────────────────

test("TEST 10 — renforcement dépassant le cap strict : 2e contrat à 1 600 $ (3 200 $ > 3 000 $) rejeté", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(16) })], 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 1);
  assert.equal(combo.picks[0].contracts, 1, "le 2e contrat doit être rejeté même en phase soft");
  assert.equal(combo.picks[0].capitalUsed, 1600);
});

test("TEST 11 — maxContractsPerTicker+1 reste le maximum absolu malgré le capital libre", () => {
  // 7 300 $ encore libres après 3 × 900 $ : aucun 4e contrat ne doit apparaître.
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(9) })], 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks[0].contracts, 3);
  assert.ok(combo.freeCapital >= 7000, "capital libre abondant attendu");
});

// ─── Brèche enforceClusterCaps (scénario O) et déterminisme (TESTS 12-13) ────

test("TEST 12 — scénario de brèche O fermé : KO 3 200 $ absent même quand enforceClusterCaps est faux", () => {
  const combo = comboByLabel(combosFor(makeBreachOPool(), 10000), "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  const tickers = combo.picks.map((p) => p.ticker);
  assert.ok(!tickers.includes("KO"), "KO (3 200 $ > cap strict 3 000 $) ne doit jamais être sélectionné");
  assert.equal(combo.picks.length, 1, "une seule ligne doit tenir sous les caps stricts");
  for (const pick of combo.picks) {
    assert.ok(pick.capitalUsed <= 3000, `${pick.ticker}: ${pick.capitalUsed} $ dépasse le cap ticker strict`);
  }
  assert.ok((rejectionTotals(combo).ticker_cap_reached ?? 0) >= 1, "rejet au contrôle de cap attendu");
});

test("TEST 13 — ordre du pool inversé : mêmes picks, contrats et capital (AF-05 préservée)", () => {
  const forward = combosFor(makeBreachOPool(), 10000);
  const reversed = combosFor(makeBreachOPool().reverse(), 10000);
  assert.equal(snapshotCombos(forward), snapshotCombos(reversed));
});

// ─── Interaction AF-07 (TESTS 14-15) ─────────────────────────────────────────

test("TEST 14 — AF-07 préservée : jambe SAFE en bande sélectionnée pour BALANCED sous le cap strict", () => {
  const candidate = makeCandidate("NKE", {
    safeStrike: makeSafeLeg(25, 0.8),
    aggressiveStrike: makeAggLeg(28, 1.5),
  });
  const combo = comboByLabel(combosFor([candidate], 10000), "BALANCED");
  assert.ok(combo, "combo BALANCED attendu");
  assert.equal(combo.picks.length, 1);
  assert.equal(combo.picks[0].strike, 25, "la jambe SAFE (en bande 0,75-1,05) doit être sélectionnée");
});

test("TEST 15 — AF-07 + AF-08 : jambe SAFE en bande mais au-dessus du cap strict → candidat rejeté", () => {
  const candidate = makeCandidate("NKE", {
    safeStrike: makeSafeLeg(32, 0.8),
    aggressiveStrike: makeAggLeg(28, 1.5),
  });
  const combo = comboByLabel(combosFor([candidate], 10000), "BALANCED");
  assert.ok(combo, "combo BALANCED attendu");
  assert.equal(combo.picks.length, 0, "AF-07 ne doit pas contourner AF-08");
  assert.ok((rejectionTotals(combo).ticker_cap_reached ?? 0) >= 1);
});

// ─── Enveloppe usableCapital (TESTS 16-17) ───────────────────────────────────

test("TEST 16 — maxCapitalPct 50 % : caps calculés sur usableCapital, aucun dépassement", () => {
  // 20 000 $ bruts × 50 % = 10 000 $ déployables → cap ticker SAFE 3 000 $.
  const combos = combosFor(
    [makeCandidate("KO", { safeStrike: makeSafeLeg(32) }), makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) })],
    20000,
    50,
  );
  const combo = comboByLabel(combos, "SAFE");
  assert.ok(combo, "combo SAFE attendu");
  const tickers = combo.picks.map((p) => p.ticker);
  assert.ok(!tickers.includes("KO"), "3 200 $ > 3 000 $ (30 % de l'enveloppe 10 000 $) doit être rejeté");
  assert.deepEqual(tickers, ["MSFT"]);
  assert.ok(combo.picks[0].capitalUsed <= 3000);
  assert.ok(combo.totalCapital <= 10000);
});

test("TEST 17 — capital total : combo.totalCapital ≤ usableCapital pour chaque combo", () => {
  for (const combo of combosFor(makeMixedPool(), 10000)) {
    assert.ok(
      combo.totalCapital <= 10000,
      `${combo.label}: totalCapital ${combo.totalCapital} > usableCapital 10000`,
    );
  }
});

// ─── Caps de cluster jamais assouplis (TESTS 18-20) ──────────────────────────

test("TEST 18 — cap secteur strict : la phase soft ne dépasse pas 40 % SAFE, diagnostic cohérent", () => {
  // MSFT 2 500 $ + ORCL 2 400 $ = 4 900 $ > 4 000 $ (cap secteur Technology).
  const combo = comboByLabel(
    combosFor(
      [makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) }), makeCandidate("ORCL", { safeStrike: makeSafeLeg(24) })],
      10000,
    ),
    "SAFE",
  );
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 1, "la 2e ligne Technology doit rester bloquée, phase soft comprise");
  const sectorCapital = combo.picks
    .filter((p) => p.sectorKey === "technology")
    .reduce((sum, p) => sum + p.capitalUsed, 0);
  assert.ok(sectorCapital <= 4000, `capital secteur ${sectorCapital} > cap strict 4 000 $`);
  assert.ok((rejectionTotals(combo).sector_cap_reached ?? 0) >= 1, "diagnostic sector_cap_reached attendu");
});

test("TEST 19 — cap thème strict : la phase soft ne dépasse pas 50 % AGGRESSIVE", () => {
  // APLD (Technology) + OKLO (Energy), tous deux thème high_beta_growth :
  // 2 600 $ + 2 600 $ = 5 200 $ > 5 000 $ (cap thème AGGRESSIVE), secteurs distincts.
  const combo = comboByLabel(
    combosFor(
      [
        makeCandidate("APLD", { aggressiveStrike: makeAggLeg(26) }),
        makeCandidate("OKLO", { aggressiveStrike: makeAggLeg(26) }),
      ],
      10000,
    ),
    "AGGRESSIVE",
  );
  assert.ok(combo, "combo AGGRESSIVE attendu");
  assert.equal(combo.picks.length, 1, "la 2e ligne high_beta_growth doit rester bloquée par le cap thème");
  const themeCapital = combo.picks
    .filter((p) => p.concentrationTheme === "high_beta_growth")
    .reduce((sum, p) => sum + p.capitalUsed, 0);
  assert.ok(themeCapital <= 5000, `capital thème ${themeCapital} > cap strict 5 000 $`);
  assert.ok((rejectionTotals(combo).theme_cap_reached ?? 0) >= 1, "diagnostic theme_cap_reached attendu");
});

test("TEST 20 — cap high-beta strict : la phase soft ne dépasse pas 35 % SAFE", () => {
  // APLD + OKLO en SAFE : 2 000 $ + 2 000 $ = 4 000 $ > 3 500 $ (cap high-beta),
  // sous le cap thème 4 000 $ — le rejet doit être high_beta_cap_reached.
  const combo = comboByLabel(
    combosFor(
      [
        makeCandidate("APLD", { safeStrike: makeSafeLeg(20) }),
        makeCandidate("OKLO", { safeStrike: makeSafeLeg(20) }),
      ],
      10000,
    ),
    "SAFE",
  );
  assert.ok(combo, "combo SAFE attendu");
  assert.equal(combo.picks.length, 1, "la 2e ligne high-beta doit rester bloquée, phase soft comprise");
  const highBetaCapital = combo.picks
    .filter((p) => p.isHighBeta)
    .reduce((sum, p) => sum + p.capitalUsed, 0);
  assert.ok(highBetaCapital <= 3500, `capital high-beta ${highBetaCapital} > cap strict 3 500 $`);
  assert.ok((rejectionTotals(combo).high_beta_cap_reached ?? 0) >= 1, "diagnostic high_beta_cap_reached attendu");
});

// ─── Diagnostics, invariants et robustesse (TESTS 21-24) ─────────────────────

test("TEST 21 — diagnostic de phase : le contrat supplémentaire est tracé primary_soft_cap", () => {
  const combo = comboByLabel(combosFor([makeCandidate("KO", { safeStrike: makeSafeLeg(9) })], 10000), "SAFE");
  const pick = combo?.picks?.[0];
  assert.ok(pick);
  assert.equal(pick.comboAllocationPhase, "primary_soft_cap");
});

test("TEST 22 — aucun soft dollar résiduel : chaque pick ≤ usableCapital × tickerCapPct", () => {
  const capPctByLabel = { SAFE: 0.3, BALANCED: 0.3, AGGRESSIVE: 0.5 };
  const scenarios = [
    { combos: combosFor(makeMixedPool(), 10000), usable: 10000 },
    { combos: combosFor(makeBreachOPool(), 10000), usable: 10000 },
    {
      combos: combosFor(
        [makeCandidate("KO", { safeStrike: makeSafeLeg(32) }), makeCandidate("MSFT", { safeStrike: makeSafeLeg(25) })],
        20000,
        50,
      ),
      usable: 10000,
    },
  ];
  for (const { combos, usable } of scenarios) {
    for (const combo of combos) {
      const capPct = capPctByLabel[combo.label];
      if (!capPct) continue;
      for (const pick of combo.picks ?? []) {
        assert.ok(
          pick.capitalUsed <= usable * capPct + 1e-9,
          `${combo.label}/${pick.ticker}: ${pick.capitalUsed} $ > cap strict ${usable * capPct} $`,
        );
      }
    }
  }
});

test("TEST 23 — aucune mutation : pool et jambes deep-freeze, aucune exception", () => {
  const pool = makeMixedPool().map((candidate) => deepFreeze(candidate));
  const combos = combosFor(pool, 10000);
  assert.ok(Array.isArray(combos) && combos.length > 0, "combos attendus sur pool gelé");
});

test("TEST 24 — répétition ×20 : mêmes picks, contrats, capital, phases et scores", () => {
  const reference = snapshotCombos(combosFor(makeMixedPool(), 10000));
  for (let run = 1; run <= 20; run += 1) {
    assert.equal(
      snapshotCombos(combosFor(makeMixedPool(), 10000)),
      reference,
      `run ${run}: résultat différent de la référence`,
    );
  }
});

// ─── Miroir simulation alternativeCompositionSimV1 (VirtualAllocator) ────────

const SAFE_LIKE_MODE_ALLOC = Object.freeze({
  tickerCapPct: 0.3,
  positionCapPct: 0.3,
  maxContractsPerTicker: 2,
  minTargetPositions: 3,
  maxThemeCapitalPct: 0.4,
  maxSectorCapitalPct: 0.4,
  maxHighBetaCapitalPct: 0.35,
});

function makeSimCandidate(ticker, capitalPerContract) {
  return {
    ticker,
    capitalPerContract,
    premiumPerContract: 60,
    allocScore: 50,
    _qualityOverlay: { qualityTier: "high", qualityScore: 1, concentrationTheme: null, qualityWarnings: [] },
    _tickerMeta: { sector: "unknown" },
  };
}

test("MIROIR SIM 1 — nouvelle ligne au-dessus du cap ticker strict rejetée en phase soft", () => {
  // Fenêtre enforceClusterCaps=false (portefeuille vide < minTarget, alternative
  // diversifiante présente) : seul tickerCapLimit protège — l'ancien ×1.1
  // acceptait 3 200 $ ≤ 3 300 $.
  const oversized = makeSimCandidate("XXL", 3200);
  const diversifier = makeSimCandidate("DIV", 2400);
  const allocator = new VirtualAllocator([oversized, diversifier], SAFE_LIKE_MODE_ALLOC, 10000, 5, 3);

  const strictEval = allocator.evaluateCandidate(oversized, false);
  assert.equal(strictEval.ok, false);
  assert.equal(strictEval.reason, "ticker_cap_reached");

  const softEval = allocator.evaluateCandidate(oversized, true);
  assert.equal(softEval.ok, false, "3 200 $ > cap strict 3 000 $ doit rester rejeté en soft");
  assert.equal(softEval.reason, "ticker_cap_reached");
});

test("MIROIR SIM 2 — le contrat soft +1 reste autorisé sous le cap strict en dollars", () => {
  const cheap = makeSimCandidate("CHP", 900);
  const allocator = new VirtualAllocator([cheap], SAFE_LIKE_MODE_ALLOC, 10000, 5, 1);

  for (let i = 0; i < 2; i += 1) {
    const evaluated = allocator.evaluateCandidate(cheap, false);
    assert.equal(evaluated.ok, true, `contrat strict n°${i + 1} attendu`);
    allocator.applySelection(evaluated, "sim_primary_strict");
  }

  const thirdStrict = allocator.evaluateCandidate(cheap, false);
  assert.equal(thirdStrict.ok, false, "le 3e contrat doit être refusé en strict (maxContractsPerTicker=2)");
  assert.equal(thirdStrict.reason, "ticker_cap_reached");

  const thirdSoft = allocator.evaluateCandidate(cheap, true);
  assert.equal(thirdSoft.ok, true, "le 3e contrat (2 700 $ ≤ 3 000 $) doit passer en soft");
  allocator.applySelection(thirdSoft, "sim_primary_soft");

  const fourthSoft = allocator.evaluateCandidate(cheap, true);
  assert.equal(fourthSoft.ok, false, "jamais plus de maxContractsPerTicker+1 contrats");

  assert.equal(allocator.picks[0].contracts, 3);
  assert.equal(allocator.picks[0].capitalUsed, 2700);
});

test("MIROIR SIM 3 — renforcement au-dessus du cap strict rejeté en phase soft", () => {
  const midsized = makeSimCandidate("MID", 1600);
  const allocator = new VirtualAllocator([midsized], SAFE_LIKE_MODE_ALLOC, 10000, 5, 1);

  const first = allocator.evaluateCandidate(midsized, false);
  assert.equal(first.ok, true);
  allocator.applySelection(first, "sim_primary_strict");

  const secondStrict = allocator.evaluateCandidate(midsized, false);
  assert.equal(secondStrict.ok, false);
  assert.equal(secondStrict.reason, "ticker_cap_reached");

  const secondSoft = allocator.evaluateCandidate(midsized, true);
  assert.equal(secondSoft.ok, false, "2 × 1 600 $ = 3 200 $ > 3 000 $ doit rester rejeté en soft");
  assert.equal(secondSoft.reason, "ticker_cap_reached");

  assert.equal(allocator.picks[0].contracts, 1);
  assert.equal(allocator.picks[0].capitalUsed, 1600);
});
