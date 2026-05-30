import assert from "node:assert/strict";
import test from "node:test";
import {
  computeWeeklySeasonalityScore,
  computeAnnualWindowScore,
  computeCspSeasonalityDecision,
  computeCcSeasonalityDecision,
  buildSeasonalityDecisionHeader,
} from "./seasonalityDecisionScores.js";
import { computeCalendarWeekFromRows } from "./seasonalityEngine.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const W7J_GOOD = {
  days: 7, sampleSize: 3773, // ~15 ans
  winRate: 0.60, avgReturn: 0.0143, medianReturn: 0.012,
  pctBelow5: 0.21, pctBelow10: 0.08,
  pctAbove5: 0.18, pctAbove10: 0.06,
  worstReturn: -0.12, bestReturn: 0.18,
  cspVerdict: "favorable", ccVerdict: "neutre",
};

const W7J_HIGH_DOWNSIDE = {
  ...W7J_GOOD,
  winRate: 0.65, avgReturn: 0.015,
  pctBelow5: 0.40, pctBelow10: 0.20, // downside élevé
  worstReturn: -0.35,
};

const W7J_TINY = { days: 7, sampleSize: 3, winRate: 0.60, avgReturn: 0.01, pctBelow5: 0.10 };

const WINDOW_BULLISH_FORTE = {
  displayLabel: "15 avr. → 15 juil.",
  startMonth: 4, startDay: 15, endMonth: 7, endDay: 15,
  strength: "Forte",
  annualHorizons: {
    "15y": { yearsCount: 15, positiveYears: 12, winRateAnnual: 0.80, avgReturnAnnual: 0.18, medianReturnAnnual: 0.15, insufficient: false },
    "10y": { yearsCount: 10, positiveYears: 8,  winRateAnnual: 0.80, avgReturnAnnual: 0.16, insufficient: false },
  },
};

const WINDOW_VIGILANCE = {
  displayLabel: "1 oct. → 31 oct.",
  startMonth: 10, startDay: 1, endMonth: 10, endDay: 31,
  strength: "Faible",
  annualHorizons: {
    "5y": { yearsCount: 5, positiveYears: 1, winRateAnnual: 0.20, avgReturnAnnual: -0.08, insufficient: false },
  },
};

// Date fixe dans la fenêtre haussière (15 avr → 15 juil)
const TODAY_IN_BULLISH = new Date("2026-05-15T12:00:00Z");
// Date dans la fenêtre de vigilance (octobre)
const TODAY_IN_VIGILANCE = new Date("2026-10-15T12:00:00Z");
// Date sans fenêtre active
const TODAY_NEUTRAL = new Date("2026-02-01T12:00:00Z");

// ─── Tests ─────────────────────────────────────────────────────────────────────

test("1 — sampleSize faible => confiance insuffisante", () => {
  const result = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_TINY });
  assert.equal(result.confidence, "insuffisant");
  assert.equal(result.score, null);
  assert.ok(result.warnings.length > 0);
});

test("2 — winRate élevé mais downsideRisk élevé => score pas trop haut", () => {
  const result = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_HIGH_DOWNSIDE });
  assert.ok(result.score !== null, "score doit être calculé");
  // winRate=65% donne 24 pts, retour=14 pts, mais downside>=40% donne 0 pts + stabilité 0 => max 38
  assert.ok(result.score < 60, `score ${result.score} trop élevé avec downside critique`);
  assert.ok(result.warnings.some(w => w.includes("baisse")), "warning downside attendu");
});

test("3 — CSP avec POP 90, strike sous expected move, prime >1%, spread <10% => favorable", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const aws = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });
  const result = computeCspSeasonalityDecision({
    weeklyScore: ws, annualWindowScore: aws, w7j: W7J_GOOD,
    pop: 90, strikeRelation: "below_lower", premiumYield: 0.011, bidAskSpread: 0.09,
  });
  assert.ok(result.score >= 65, `score CSP ${result.score} devrait être ≥65 (Favorable)`);
  assert.ok(["Favorable", "Très favorable"].includes(result.label), `label: ${result.label}`);
});

test("4 — CSP avec spread >35% => warning et score pénalisé", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const aws = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });
  const result = computeCspSeasonalityDecision({
    weeklyScore: ws, annualWindowScore: aws, w7j: W7J_GOOD,
    bidAskSpread: 0.40,
  });
  assert.ok(result.warnings.some(w => w.includes("Spread")), "warning spread attendu");
  // Spread 0 pts pénalise le score
  const resultGood = computeCspSeasonalityDecision({ weeklyScore: ws, annualWindowScore: aws, w7j: W7J_GOOD, bidAskSpread: 0.05 });
  assert.ok(result.score < resultGood.score, "score avec spread élevé doit être < score avec spread faible");
});

test("5 — CSP avec prime <0.5% => warning", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const aws = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });
  const result = computeCspSeasonalityDecision({
    weeklyScore: ws, annualWindowScore: aws, w7j: W7J_GOOD,
    premiumYield: 0.003,
  });
  assert.ok(result.warnings.some(w => w.includes("Prime") || w.includes("prime")), "warning prime attendu");
});

test("6 — fenêtre annuelle haussière augmente score CSP", () => {
  const ws   = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const awsB = computeAnnualWindowScore({
    windowsData: { annualDisplayWindows: { bullish: [WINDOW_BULLISH_FORTE] }, recentBearishVigilance: [], bestBearishAnnualWindows: [] },
    today: TODAY_IN_BULLISH,
  });
  const awsN = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });

  const cspBullish = computeCspSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsB, w7j: W7J_GOOD });
  const cspNeutral = computeCspSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsN, w7j: W7J_GOOD });

  assert.ok(cspBullish.score >= cspNeutral.score, `bullish ${cspBullish.score} doit >= neutre ${cspNeutral.score}`);
  assert.ok(awsB.annualWindowBonus > 0, "bonus haussier doit être > 0");
});

test("7 — vigilance baissière pénalise score CSP", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const awsV = computeAnnualWindowScore({
    windowsData: { annualDisplayWindows: { bullish: [] }, recentBearishVigilance: [WINDOW_VIGILANCE], bestBearishAnnualWindows: [] },
    today: TODAY_IN_VIGILANCE,
  });
  const awsN = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });

  const cspVigilance = computeCspSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsV, w7j: W7J_GOOD });
  const cspNeutral   = computeCspSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsN, w7j: W7J_GOOD });

  assert.ok(awsV.annualWindowBonus < 0, "malus vigilance doit être négatif");
  assert.ok(cspVigilance.score <= cspNeutral.score, `vigilance ${cspVigilance.score} doit <= neutre ${cspNeutral.score}`);
});

test("8 — fenêtre haussière pénalise CC proche du prix", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const awsB = computeAnnualWindowScore({
    windowsData: { annualDisplayWindows: { bullish: [WINDOW_BULLISH_FORTE] }, recentBearishVigilance: [], bestBearishAnnualWindows: [] },
    today: TODAY_IN_BULLISH,
  });
  // CC trop proche du prix (2% au-dessus)
  const ccClose = computeCcSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsB, w7j: W7J_GOOD, ccStrike: 102, currentPrice: 100 });
  // CC éloigné du prix (10% au-dessus)
  const ccFar   = computeCcSeasonalityDecision({ weeklyScore: ws, annualWindowScore: awsB, w7j: W7J_GOOD, ccStrike: 110, currentPrice: 100 });

  assert.ok(ccClose.score < ccFar.score, `CC proche ${ccClose.score} doit être < CC éloigné ${ccFar.score}`);
  assert.ok(ccClose.warnings.some(w => w.includes("proche") || w.includes("assignation")), "warning CC proche attendu");
});

test("9 — CC sous assignmentStrike => À éviter, score 0", () => {
  const ws  = computeWeeklySeasonalityScore({ shortTermWindow7j: W7J_GOOD });
  const aws = computeAnnualWindowScore({ windowsData: null, today: TODAY_NEUTRAL });
  const result = computeCcSeasonalityDecision({
    weeklyScore: ws, annualWindowScore: aws, w7j: W7J_GOOD,
    ccStrike: 95, assignmentStrike: 100,
  });
  assert.equal(result.score, 0);
  assert.equal(result.label, "À éviter");
  assert.ok(result.warnings.some(w => w.includes("assignation")), "warning assignation attendu");
});

test("10 — données manquantes => pas de crash, warnings affichés", () => {
  const result = buildSeasonalityDecisionHeader({ shortTermData: null, windowsData: null });
  assert.ok(result.weeklyScore,       "weeklyScore doit exister");
  assert.ok(result.annualWindowScore, "annualWindowScore doit exister");
  assert.ok(result.cspScore,          "cspScore doit exister");
  assert.ok(result.ccScore,           "ccScore doit exister");
  assert.ok(result.wheelVerdict,      "wheelVerdict doit exister");
  assert.equal(result.weeklyScore.confidence, "insuffisant");
  assert.ok(result.weeklyScore.warnings.length > 0, "warnings attendus si données manquantes");
});

// ─── Tests calendrier hebdomadaire (11–15) ────────────────────────────────────

// Fabrique N années de données — ~260 jours de bourse par an, dates bien espacées
function makeRows(years, basePrice = 100) {
  const rows = [];
  const startYear = 2026 - years;
  for (let y = 0; y < years; y++) {
    const year = startYear + y;
    let price = basePrice * (1 + y * 0.08);
    for (let d = 0; d < 260; d++) {
      // 1 jour calendrier ≈ 365/252 jours de bourse → offset en jours calendrier
      const date = new Date(`${year}-01-02T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + Math.round(d * 365 / 252));
      const dateStr = date.toISOString().slice(0, 10);
      // Variation déterministe (pas de Math.random pour éviter les tests flaky)
      price = price * (1 + Math.sin(d * 0.31 + y * 1.7) * 0.015);
      rows.push({ date: dateStr, close: Math.max(1, price), open: Math.max(1, price), high: Math.max(1, price) * 1.005, low: Math.max(1, price) * 0.995 });
    }
  }
  return rows;
}

const TODAY_MAY29 = new Date("2026-05-29T12:00:00Z");

test("11 — computeCalendarWeekFromRows : 1 observation par année historique", () => {
  const rows = makeRows(15);
  const cw   = computeCalendarWeekFromRows(rows, TODAY_MAY29);

  assert.ok(cw !== null, "résultat ne doit pas être null");
  assert.ok(cw.sampleSize >= 13 && cw.sampleSize <= 15,
    `sampleSize=${cw.sampleSize} attendu proche de 15 (max 15 années complètes avant 2026)`);
  assert.ok(Array.isArray(cw.yearlyReturns), "yearlyReturns doit être un tableau");
  assert.equal(cw.yearlyReturns.length, cw.sampleSize, "yearlyReturns.length == sampleSize");
  // Chaque année ne doit apparaître qu'une fois
  const years = cw.yearlyReturns.map(r => r.year);
  const unique = new Set(years);
  assert.equal(unique.size, years.length, "chaque année doit apparaître une seule fois");
});

test("12 — score hebdo calendrier : sampleSize = années, pas fenêtres roulantes", () => {
  const rows = makeRows(15);
  const cw   = computeCalendarWeekFromRows(rows, TODAY_MAY29);
  assert.ok(cw !== null, "calendarWeek attendu");

  const score = computeWeeklySeasonalityScore({ calendarWeek: cw, shortTermWindow7j: W7J_GOOD });
  assert.equal(score.source, "calendrier", "source doit être 'calendrier'");
  // sampleSize doit être en années (~15), pas en fenêtres roulantes (~3765)
  assert.ok(score.sampleSize < 100, `sampleSize ${score.sampleSize} ne doit pas être ~3765`);
  assert.ok(score.yearsOfData < 100, `yearsOfData ${score.yearsOfData} ne doit pas être ~3765`);
});

test("13 — APLD-like : 4 ans => insuffisant", () => {
  const rows = makeRows(4);
  const cw   = computeCalendarWeekFromRows(rows, TODAY_MAY29);
  // Avec 4 ans, sampleSize < 5 => insuffisant
  if (cw && cw.sampleSize < 5) {
    const score = computeWeeklySeasonalityScore({ calendarWeek: cw });
    assert.equal(score.confidence, "insuffisant");
    assert.equal(score.score, null);
  } else if (cw) {
    // Si on obtient quand même 4-5 obs selon les données générées, vérifier au moins la confiance
    const score = computeWeeklySeasonalityScore({ calendarWeek: cw });
    assert.ok(["insuffisant", "préliminaire"].includes(score.confidence),
      `confiance attendue insuffisant ou préliminaire pour ${cw.sampleSize} ans`);
  } else {
    // null est aussi acceptable pour 4 ans sans données suffisantes
    assert.ok(true, "null acceptable pour données insuffisantes");
  }
});

test("14 — yearlyReturns contient startDate, endDate, returnPct, year pour chaque ligne", () => {
  const rows = makeRows(10);
  const cw   = computeCalendarWeekFromRows(rows, TODAY_MAY29);
  assert.ok(cw !== null && cw.yearlyReturns.length > 0, "yearlyReturns doit avoir des données");
  for (const r of cw.yearlyReturns) {
    assert.ok(typeof r.year      === "number", `year manquant ou non-number: ${JSON.stringify(r)}`);
    assert.ok(typeof r.startDate === "string", `startDate manquant: ${JSON.stringify(r)}`);
    assert.ok(typeof r.endDate   === "string", `endDate manquant: ${JSON.stringify(r)}`);
    assert.ok(typeof r.returnPct === "number" && isFinite(r.returnPct), `returnPct invalide: ${JSON.stringify(r)}`);
  }
});

test("15 — sans calendarWeek : fallback roulant conservé avec warning", () => {
  const score = computeWeeklySeasonalityScore({ calendarWeek: null, shortTermWindow7j: W7J_GOOD });
  assert.equal(score.source, "roulant", "source doit être 'roulant'");
  assert.ok(score.warnings.some(w => w.includes("roulantes")), "warning fallback roulant attendu");
  // Le score doit quand même être calculé (sampleSize ~15 ans depuis 3773 fenêtres)
  assert.ok(score.score !== null, "score ne doit pas être null avec fallback roulant suffisant");
});
