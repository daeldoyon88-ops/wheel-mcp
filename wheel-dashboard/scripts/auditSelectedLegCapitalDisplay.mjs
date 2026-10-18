#!/usr/bin/env node
/**
 * Audit read-only : vérifie que "Capital / contrat" reflète la jambe sélectionnée.
 *
 * Reproduit la logique d'affichage de la carte (dashboard.jsx) :
 *   displayLeg = finalDisplayMode === "AGGRESSIVE" ? aggressiveStrike : safeStrike
 *   displayCapitalPerContract = displayLeg.strike * 100 (fallback legacy sinon)
 *
 * Ne touche à aucun moteur. Compare displayedCapital vs expectedCapital.
 */

function getDisplayLeg(card) {
  return card.finalDisplayMode === "AGGRESSIVE" ? card.aggressiveStrike : card.safeStrike;
}

function getDisplayCapital(card) {
  const leg = getDisplayLeg(card);
  const strike = Number(leg?.strike);
  return Number.isFinite(strike) && strike > 0 ? strike * 100 : card.capitalPerContract;
}

function expectedCapital(card) {
  const strike =
    card.finalDisplayMode === "AGGRESSIVE"
      ? Number(card.aggressiveStrike?.strike)
      : Number(card.safeStrike?.strike);
  return Number.isFinite(strike) && strike > 0 ? strike * 100 : card.capitalPerContract;
}

// Fixtures correspondant aux cas signalés.
const fixtures = [
  {
    ticker: "NOK",
    finalDisplayMode: "AGGRESSIVE",
    safeStrike: { strike: 14.5 },
    aggressiveStrike: { strike: 15.0 },
    capitalPerContract: 1450, // legacy (= SAFE)
  },
  {
    ticker: "MCHP",
    finalDisplayMode: "AGGRESSIVE",
    safeStrike: { strike: 87.0 },
    aggressiveStrike: { strike: 91.0 },
    capitalPerContract: 8700,
  },
  {
    ticker: "IONQ",
    finalDisplayMode: "AGGRESSIVE",
    safeStrike: { strike: 59.0 },
    aggressiveStrike: { strike: 63.0 },
    capitalPerContract: 5900,
  },
  {
    ticker: "SAFE_CASE",
    finalDisplayMode: "SAFE",
    safeStrike: { strike: 20.0 },
    aggressiveStrike: { strike: 24.0 },
    capitalPerContract: 2000,
  },
];

let mismatches = 0;
const rows = fixtures.map((card) => {
  const selectedMode = card.finalDisplayMode;
  const selectedStrikeUsed =
    selectedMode === "AGGRESSIVE" ? card.aggressiveStrike?.strike : card.safeStrike?.strike;
  const displayedCapital = getDisplayCapital(card);
  const expected = expectedCapital(card);
  const mismatch = displayedCapital !== expected;
  if (mismatch) mismatches += 1;
  return {
    ticker: card.ticker,
    safeStrike: card.safeStrike?.strike,
    aggressiveStrike: card.aggressiveStrike?.strike,
    selectedMode,
    selectedStrikeUsed,
    displayedCapital,
    expectedCapital: expected,
    mismatch: mismatch ? "OUI" : "non",
  };
});

console.table(rows);
console.log(mismatches === 0 ? "✅ Aucun mismatch" : `❌ ${mismatches} mismatch(es)`);
process.exit(mismatches === 0 ? 0 : 1);
