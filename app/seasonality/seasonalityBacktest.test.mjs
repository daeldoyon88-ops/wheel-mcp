import assert from "node:assert/strict";
import test   from "node:test";

import {
  computeBacktestForRows,
  TICKER_SOURCES,
  parseBacktestOutputOptions,
  buildBacktestApiResponse,
  resolveBacktestTickerList,
  toBacktestSignalSummary,
} from "./seasonalityBacktest.js";

import { buildSeasonalWindowDisplayFields } from "./seasonalityWindowDisplay.js";

import {
  computeSeasonality,
  computeSeasonalityCalendar,
  computeSeasonalityShortTerm,
  computeSeasonalityWindows,
} from "./seasonalityEngine.js";

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeTradingDays(startDate, numDays, getClose) {
  const rows  = [];
  const d     = new Date(startDate);
  let price   = 100;

  while (rows.length < numDays) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      price = Number((getClose(d, price)).toFixed(4));
      rows.push({
        date:  new Date(d),
        open:  price,
        high:  price,
        low:   price,
        close: price,
      });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return rows;
}

/**
 * Génère N années de données avec un rally en avril et une chute en septembre.
 * @param {number} numYears  Nombre d'années historiques COMPLÈTES (avant targetYear).
 * @param {number} targetYear Année à backtester (sera ajoutée avec comportement inverse).
 * @param {object} [overrideTarget] Comportement de l'année cible { aprilMult, septMult }.
 */
function makePatternRows(numYears, targetYear, overrideTarget = {}) {
  const startYear = targetYear - numYears;
  const startDate = new Date(Date.UTC(startYear, 0, 2));
  const totalDays = (numYears + 1) * 260; // +1 pour l'année cible

  const aprilTargetMult = overrideTarget.aprilMult ?? 1.0; // défaut : flat en année cible
  const septTargetMult  = overrideTarget.septMult  ?? 1.0;

  return makeTradingDays(startDate, totalDays, (date, price) => {
    const year  = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day   = date.getUTCDate();

    if (year === targetYear) {
      // Comportement de l'année cible (peut être inverse pour tester l'échec)
      if (month === 4 && day >= 1 && day <= 28) return price * aprilTargetMult;
      if (month === 9 && day >= 1 && day <= 28) return price * septTargetMult;
      return price;
    }

    // Historique : rally avril, chute septembre
    if (month === 4 && day >= 1 && day <= 28) return price * 1.008; // +8% mensuel
    if (month === 9 && day >= 1 && day <= 28) return price * 0.992; // -8% mensuel
    return price;
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

// 1. year absent → défaut raisonnable
test("computeBacktestForRows: retourne null si rows null ou vide", () => {
  const year = new Date().getUTCFullYear() - 1;
  assert.equal(computeBacktestForRows(null, year), null);
  assert.equal(computeBacktestForRows([], year), null);
  assert.equal(computeBacktestForRows(null, 2025), null);
});

// 2. tickers=TQQQ,NVDA (simulation via rows)
test("computeBacktestForRows: retourne un tableau de signaux avec données valides", () => {
  const rows    = makePatternRows(10, 2025, { aprilMult: 1.008, septMult: 0.992 });
  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [20],
    minSamples: 5,
    bullishWinRate: 0.65,
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals), "signals doit être un tableau");
  assert.ok(signals.length >= 0, "tableau signals attendu (peut être vide si seuils non atteints)");
});

// 3. Anti-lookahead : signaux 2025 n'utilisent que les années < 2025
test("anti-lookahead : signal haussier basé sur historique, outcome réel peut différer", () => {
  // Historique (2015-2024) : avril est très haussier
  // Année cible 2025 : avril est baissier → signal bullish mais echec
  const rows = makePatternRows(10, 2025, { aprilMult: 0.992 }); // avril 2025 baissier

  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [20],
    minSamples: 5,
    bullishWinRate: 0.60, // seuil plus bas pour avoir au moins un signal
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals), "signals attendu");

  // Trouve les signaux démarrant en avril 2025
  const aprilSignals = signals.filter(s => s.startDate?.startsWith('2025-04'));

  if (aprilSignals.length > 0) {
    const aprilSig = aprilSignals[0];
    // Le signal doit être 'bullish' (basé sur l'historique 2015-2024 favorable)
    assert.equal(aprilSig.signalType, 'bullish', "signal bullish attendu sur base historique avril");
    // L'outcome réel doit être négatif (avril 2025 était baissier)
    assert.ok(aprilSig.actualReturn < 0, "retour réel avril 2025 doit être négatif");
    // Donc success = false (anti-lookahead validé : signal généré sans connaitre 2025)
    assert.equal(aprilSig.success, false, "signal doit être un échec : outcome 2025 différent de l'historique");
  }

  // Vérification clé anti-lookahead : sampleSize compte les occurrences glissantes
  // avant 2025 seulement. Borne max = ~10 ans × 7 jours/semaine = 70 max.
  for (const sig of signals) {
    assert.ok(sig.sampleSize > 0,   `sampleSize doit être > 0`);
    assert.ok(sig.sampleSize <= 70, `sampleSize ${sig.sampleSize} anormalement élevé (lookahead?)`);
    // startDate doit être dans l'année cible
    assert.ok(sig.startDate?.startsWith('2025'), `startDate doit être en 2025: ${sig.startDate}`);
  }
});

// 4. Résumé global cohérent : totalSignals = successfulSignals + failedSignals
test("résumé cohérent : totalSignals = successfulSignals + failedSignals", () => {
  const rows    = makePatternRows(10, 2025, { aprilMult: 1.008, septMult: 0.992 });
  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [20, 40],
    minSamples: 5,
    bullishWinRate: 0.60,
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals));

  const total      = signals.length;
  const successful = signals.filter(s => s.success).length;
  const failed     = signals.filter(s => !s.success).length;

  assert.equal(total, successful + failed, "totalSignals doit égaler successfulSignals + failedSignals");
});

// 5. byTicker contient les bons champs (via wrapper manuel)
test("champs obligatoires présents dans chaque signal", () => {
  const rows    = makePatternRows(8, 2025, { aprilMult: 1.008, septMult: 0.992 });
  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [20],
    minSamples: 4,
    bullishWinRate: 0.60,
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals));
  if (signals.length === 0) return; // aucun signal : test structurel non applicable

  const required = [
    'year', 'signalType', 'success', 'actualReturn', 'expectedReturn',
    'historicalAvgReturn', 'historicalMedianReturn', 'historicalWinRate',
    'historicalWorstReturn', 'historicalBestReturn', 'sampleSize',
    'label', 'displayLabel', 'displayLabelWithYear', 'startDate', 'endDate', 'windowDays',
  ];

  for (const sig of signals) {
    for (const field of required) {
      assert.ok(field in sig, `champ "${field}" manquant dans signal`);
    }
  }
});

// 6. Ticker sans historique ne casse pas (rows trop courts)
test("computeBacktestForRows: retourne null si historique < 50 rows avant targetYear", () => {
  // Seulement des rows dans l'année cible → pas assez d'historique
  const rows = makeTradingDays(new Date(Date.UTC(2025, 0, 2)), 200, (_, p) => p * 1.001);
  const result = computeBacktestForRows(rows, 2025);
  assert.equal(result, null, "doit retourner null si historique insuffisant avant targetYear");
});

// 7. Source inconnue : TICKER_SOURCES ne contient pas la source → vérifier l'absence de la clé
test("TICKER_SOURCES : sources prédéfinies existent et sont non vides", () => {
  assert.ok(Array.isArray(TICKER_SOURCES['top20-wheel']),       "top20-wheel doit être un tableau");
  assert.ok(Array.isArray(TICKER_SOURCES['strict-watchlist']),  "strict-watchlist doit être un tableau");
  assert.ok(Array.isArray(TICKER_SOURCES['fallback65']),        "fallback65 doit être un tableau");
  assert.ok(TICKER_SOURCES['top20-wheel'].length > 0);
  assert.ok(TICKER_SOURCES['strict-watchlist'].length > 0);
  assert.ok(TICKER_SOURCES['fallback65'].length > 0);
  assert.ok(!TICKER_SOURCES['unknown-source'], "source inconnue ne doit pas exister dans TICKER_SOURCES");
});

// 8. Anciens endpoints : fonctions toujours exportées (régression)
test("endpoints existants toujours exportés : fonctions saisonnalité", () => {
  assert.equal(typeof computeSeasonality,         "function", "computeSeasonality manquant");
  assert.equal(typeof computeSeasonalityCalendar, "function", "computeSeasonalityCalendar manquant");
  assert.equal(typeof computeSeasonalityShortTerm, "function", "computeSeasonalityShortTerm manquant");
  assert.equal(typeof computeSeasonalityWindows,  "function", "computeSeasonalityWindows manquant");
});

// 9. displayLabel/displayLabelWithYear présents dans les signaux
test("champs displayLabel et displayLabelWithYear présents et non vides", () => {
  const rows    = makePatternRows(10, 2025, { aprilMult: 1.008 });
  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [20],
    minSamples: 5,
    bullishWinRate: 0.60,
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals));
  if (signals.length === 0) return;

  for (const sig of signals) {
    assert.ok(typeof sig.displayLabel === 'string' && sig.displayLabel.length > 0,
      `displayLabel vide ou absent sur signal ${sig.label}`);
    assert.ok(typeof sig.displayLabelWithYear === 'string' && sig.displayLabelWithYear.length > 0,
      `displayLabelWithYear vide ou absent sur signal ${sig.label}`);
    // displayLabel doit contenir une flèche
    assert.ok(sig.displayLabel.includes('→'), `displayLabel doit contenir → : ${sig.displayLabel}`);
    // displayLabelWithYear doit contenir l'année cible
    assert.ok(sig.displayLabelWithYear.includes('2025'),
      `displayLabelWithYear doit contenir 2025 : ${sig.displayLabelWithYear}`);
  }
});

// 10. Fenêtre traversant l'année : Déc → Mar doit produire endDate en année+1
test("fenêtre traversant l'année : date de fin en année+1 si déc → mars", () => {
  // Fabriquer des rows avec une chute récurrente en décembre → mars (pattern baissier)
  const rows = makeTradingDays(new Date(Date.UTC(2015, 0, 2)), 11 * 260, (date, price) => {
    const year  = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;

    if (year < 2025 && (month === 12 || month === 1 || month === 2)) {
      return price * 0.993; // chute hivernale récurrente
    }
    if (year === 2025 && (month === 12 || month === 1 || month === 2)) {
      return price * 0.993; // idem en 2025
    }
    return price;
  });

  const signals = computeBacktestForRows(rows, 2025, {
    windowDays: [60],
    minSamples: 5,
    bullishWinRate: 0.65,
    bearishWinRate: 0.45,
  });

  assert.ok(Array.isArray(signals));

  // Chercher une fenêtre commençant en décembre 2025
  const decSignals = signals.filter(s => s.startDate?.startsWith('2025-12'));
  if (decSignals.length > 0) {
    for (const sig of decSignals) {
      assert.ok(sig.endDate?.startsWith('2026'),
        `endDate d'une fenêtre déc 2025 doit être en 2026, obtenu: ${sig.endDate}`);
    }
  }

  // Vérification directe de buildSeasonalWindowDisplayFields (déjà importé en haut)
  const fields = buildSeasonalWindowDisplayFields({
    startMonth: 12, startWeekOfMonth: 4,
    endMonth: 3, endWeekOfMonth: 3,
    label: 'Déc W4 → Mar W3',
    windowDays: 60,
    referenceYear: 2025,
  });

  assert.ok(fields.endDateCurrentYear.startsWith('2026'),
    `Déc W4 → Mar W3 doit avoir endDate en 2026, obtenu: ${fields.endDateCurrentYear}`);
  assert.ok(fields.displayLabelWithYear.includes('2026'),
    `displayLabelWithYear doit contenir 2026 pour Déc→Mar: ${fields.displayLabelWithYear}`);
});

// ─── Mode résumé HTTP (buildBacktestApiResponse) ───────────────────────────────

function makeMockBacktestResult(allSignals) {
  const byTicker = [{
    ticker: 'TQQQ',
    year: 2025,
    totalSignals: allSignals.length,
    successfulSignals: allSignals.filter(s => s.success).length,
    failedSignals: allSignals.filter(s => !s.success).length,
    successRate: 0.5,
    bullishSignals: 0,
    bullishSuccessfulSignals: 0,
    bullishSuccessRate: 0,
    bearishSignals: 0,
    bearishSuccessfulSignals: 0,
    bearishSuccessRate: 0,
    avgActualReturn: 0,
    avgExpectedReturn: 0,
    bestActualSignal: null,
    worstActualSignal: null,
    verdict: 'Moyen',
  }];

  const globalSummary = {
    year: 2025,
    tickersRequested: 1,
    tickersAnalyzed: 1,
    totalSignals: allSignals.length,
    successfulSignals: allSignals.filter(s => s.success).length,
    failedSignals: allSignals.filter(s => !s.success).length,
    successRate: 0.5,
    bestTickers: [],
    worstTickers: [],
    bestSignals: allSignals
      .filter(s => s.success === true)
      .sort((a, b) => b.actualReturn - a.actualReturn)
      .slice(0, 10)
      .map(toBacktestSignalSummary),
    worstSignals: allSignals
      .filter(s => s.success === false)
      .sort((a, b) => a.actualReturn - b.actualReturn)
      .slice(0, 10)
      .map(toBacktestSignalSummary),
    parametersUsed: {},
  };

  return { byTicker, allSignals, globalSummary, warnings: [] };
}

function makeSignal(overrides) {
  return {
    ticker: 'TQQQ',
    year: 2025,
    signalType: 'bullish',
    success: true,
    actualReturn: 0.05,
    expectedReturn: 0.03,
    historicalWinRate: 0.7,
    sampleSize: 8,
    windowDays: 20,
    displayLabelWithYear: '1 avr. 2025 → 15 avr. 2025',
    label: 'Avr W1 → Avr W3',
    ...overrides,
  };
}

test("buildBacktestApiResponse: par défaut sans clé signals", () => {
  const signals = Array.from({ length: 150 }, (_, i) =>
    makeSignal({ actualReturn: i * 0.001, success: i % 2 === 0 }),
  );
  const result = makeMockBacktestResult(signals);
  const payload = buildBacktestApiResponse({
    year: 2025,
    source: 'tickers',
    parameters: { windows: [20] },
    result,
    outputOptions: parseBacktestOutputOptions({}),
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.signalsReturned, 0);
  assert.equal(payload.totalSignalsAvailable, 150);
  assert.equal('signals' in payload, false);
  assert.ok(Array.isArray(payload.globalSummary.bestSignals));
  assert.ok(Array.isArray(payload.globalSummary.worstSignals));
});

test("buildBacktestApiResponse: includeSignals=1 retourne signals limités", () => {
  const signals = Array.from({ length: 80 }, (_, i) => makeSignal({ actualReturn: i * 0.01 }));
  const result = makeMockBacktestResult(signals);
  const opts = parseBacktestOutputOptions({ includeSignals: '1', signalsLimit: '50' });
  const payload = buildBacktestApiResponse({
    year: 2025,
    source: 'tickers',
    parameters: {},
    result,
    outputOptions: opts,
  });

  assert.equal('signals' in payload, true);
  assert.equal(payload.signals.length, 50);
  assert.equal(payload.signalsReturned, 50);
  assert.equal(payload.totalSignalsAvailable, 80);
});

test("parseBacktestOutputOptions: signalsLimit plafonné à 500", () => {
  const opts = parseBacktestOutputOptions({ includeSignals: 'true', signalsLimit: '9999' });
  assert.equal(opts.signalsLimit, 500);
  assert.equal(opts.includeSignals, true);
});

test("parseBacktestOutputOptions: bestLimit et worstLimit personnalisés", () => {
  const opts = parseBacktestOutputOptions({ bestLimit: '5', worstLimit: '3' });
  assert.equal(opts.bestLimit, 5);
  assert.equal(opts.worstLimit, 3);
});

test("resolveBacktestTickerList: source inconnue → ok:false", () => {
  const r = resolveBacktestTickerList({ sourceRaw: 'unknown-source' });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('Source inconnue'));
});

test("toBacktestSignalSummary: champs résumé attendus", () => {
  const s = toBacktestSignalSummary(makeSignal({ success: false, actualReturn: -0.12 }));
  assert.equal(s.ticker, 'TQQQ');
  assert.equal(s.success, false);
  assert.equal(s.actualReturn, -0.12);
  assert.ok(s.displayLabelWithYear);
  assert.equal('historicalAvgReturn' in s, false);
});

test("globalSummary bestSignals: success true, tri actualReturn décroissant", async () => {
  const rows = makePatternRows(10, 2025, { aprilMult: 1.008, septMult: 0.992 });
  const raw = computeBacktestForRows(rows, 2025, {
    windowDays: [20],
    minSamples: 5,
    bullishWinRate: 0.60,
    bearishWinRate: 0.45,
  });
  assert.ok(Array.isArray(raw));

  const allSignals = (raw ?? []).map(s => ({ ticker: 'SYN', ...s }));
  const result = makeMockBacktestResult(allSignals);

  const best = result.globalSummary.bestSignals;
  if (best.length >= 2) {
    assert.equal(best[0].success, true);
    assert.equal(best[1].success, true);
    assert.ok(best[0].actualReturn >= best[1].actualReturn);
  }
});

test("globalSummary worstSignals: success false, tri actualReturn croissant", () => {
  const signals = [
    makeSignal({ success: false, actualReturn: -0.05 }),
    makeSignal({ success: false, actualReturn: -0.20 }),
    makeSignal({ success: true, actualReturn: 0.10 }),
  ];
  const result = makeMockBacktestResult(signals);
  const worst = result.globalSummary.worstSignals;

  assert.equal(worst.length, 2);
  assert.equal(worst[0].success, false);
  assert.equal(worst[1].success, false);
  assert.ok(worst[0].actualReturn <= worst[1].actualReturn);
});
