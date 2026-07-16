import assert from "node:assert/strict";
import test from "node:test";

import {
  getCalendarDte,
  getDteDays,
  selectPutStrikes,
  WHEEL_MARKET_TIME_ZONE,
} from "./wheelMetrics.js";
import { getCanonicalPeriodYieldBand } from "../../wheel-dashboard/src/capitalComboPortfolio.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPECTED_DTES = Object.freeze({
  "2026-07-17": 1,
  "2026-07-24": 8,
  "2026-07-31": 15,
});

function assertExpectedDtes(asOfDate, timeZone = WHEEL_MARKET_TIME_ZONE) {
  for (const [expirationDate, expected] of Object.entries(EXPECTED_DTES)) {
    assert.equal(
      getCalendarDte({ asOfDate, expirationDate, timeZone }),
      expected,
      `${String(asOfDate)} -> ${expirationDate}`,
    );
  }
}

test("DTE civil: 2026-07-16 produit 1, 8 et 15", () => {
  assertExpectedDtes("2026-07-16");
  assert.equal(getDteDays("2026-07-17", "2026-07-16"), 1);
  assert.equal(getDteDays("2026-07-24", "2026-07-16"), 8);
  assert.equal(getDteDays("2026-07-31", "2026-07-16"), 15);
});

test("DTE civil: stable à toutes les heures du 2026-07-16 à New York", () => {
  for (const time of ["00:01", "09:30", "12:00", "15:59", "23:59"]) {
    assertExpectedDtes(`2026-07-16T${time}:00-04:00`);
  }
});

test("DTE civil: reproduit l'ancien 7 puis corrige à 8 en fin de journée", () => {
  const legacyHours =
    new Date("2026-07-24T00:00:00-04:00").getTime() -
    new Date("2026-07-16T23:59:00-04:00").getTime();
  assert.equal(Math.round(legacyHours / DAY_MS), 7);
  assert.equal(getDteDays("2026-07-24", "2026-07-16T23:59:00-04:00"), 8);
});

test("DTE civil: frontières de mois, année et année bissextile", () => {
  for (const [asOfDate, expirationDate, expected] of [
    ["2026-07-31", "2026-08-01", 1],
    ["2026-12-31", "2027-01-01", 1],
    ["2027-02-28", "2027-03-01", 1],
    ["2028-02-28", "2028-02-29", 1],
    ["2028-02-28", "2028-03-01", 2],
  ]) {
    assert.equal(getCalendarDte({ asOfDate, expirationDate }), expected);
  }
});

test("DTE civil: formats actifs YYYY-MM-DD, YYYYMMDD et Date", () => {
  assert.equal(getCalendarDte({ asOfDate: "2026-07-16", expirationDate: "2026-07-24" }), 8);
  assert.equal(getCalendarDte({ asOfDate: "20260716", expirationDate: "20260724" }), 8);
  assert.equal(
    getCalendarDte({
      asOfDate: new Date("2026-07-16T12:00:00-04:00"),
      expirationDate: new Date("2026-07-24T12:00:00-04:00"),
    }),
    8,
  );
});

test("DTE civil: une référence civile explicite est indépendante du fuseau", () => {
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const timeZone of [WHEEL_MARKET_TIME_ZONE, "UTC", localTimeZone]) {
    assertExpectedDtes("2026-07-16", timeZone);
  }
});

test("DTE civil: même jour, passé et valeurs invalides sont documentés", () => {
  assert.equal(getCalendarDte({ asOfDate: "2026-07-16", expirationDate: "2026-07-16" }), 0);
  assert.equal(getCalendarDte({ asOfDate: "2026-07-16", expirationDate: "2026-07-15" }), -1);
  assert.equal(getCalendarDte({ asOfDate: "2026-07-16", expirationDate: "2026-02-30" }), null);
  assert.equal(getCalendarDte({ asOfDate: "invalide", expirationDate: "2026-07-24" }), null);
  assert.equal(
    getCalendarDte({
      asOfDate: "2026-07-16",
      expirationDate: "2026-07-24",
      timeZone: "Fuseau/Invalide",
    }),
    null,
  );
  assert.equal(getDteDays("2026-07-16", "2026-07-16"), 1);
  assert.equal(getDteDays("2026-07-15", "2026-07-16"), 1);
  assert.ok(Number.isNaN(getDteDays("invalide", "2026-07-16")));
});

test("hybrid-period-v1 reçoit 1, 8 et 15 sans modifier sa formule", () => {
  const band1 = getCanonicalPeriodYieldBand("SAFE", 1);
  const band8 = getCanonicalPeriodYieldBand("SAFE", 8);
  const band15 = getCanonicalPeriodYieldBand("SAFE", 15);

  assert.equal(band1.dteDays, 1);
  assert.equal(band1.effectivePeriodMinPct, (26 * 7) / 365);
  assert.equal(band8.dteDays, 8);
  assert.equal(band8.effectivePeriodMinPct, (26 * 8) / 365);
  assert.equal(band15.dteDays, 15);
  assert.equal(band15.effectivePeriodMinPct, (26 * 15) / 365);
});

function put(strike, bid, openInterest = 100) {
  return {
    strike,
    bid,
    ask: bid + 0.05,
    lastPrice: bid,
    volume: 100,
    openInterest,
    impliedVolatility: 0.4,
  };
}

test("sélection des puts inchangée quand le même DTE explicite est fourni", () => {
  const result = selectPutStrikes({
    puts: [put(94, 0.9), put(92, 0.7), put(93, 0.8)],
    spot: 100,
    lowerBoundForSelection: 95,
    dteDays: 8,
  });

  assert.deepEqual(result.eligible.map((row) => row.strike), [92, 93, 94]);
  assert.equal(result.aggressiveStrike?.strike, 94);
  assert.equal(result.safeStrike?.strike, 93);
  assert.equal(result.safeSelectionMode, "first_liquid_strike_below_aggressive_meeting_target");

  const fallback = selectPutStrikes({
    puts: [put(94, 0.9)],
    spot: 100,
    lowerBoundForSelection: 95,
    dteDays: 8,
  });
  assert.equal(fallback.aggressiveStrike?.strike, 94);
  assert.equal(fallback.safeStrike?.strike, 94);
  assert.equal(fallback.safeSelectionMode, "fallback_to_aggressive_no_lower_strike_meeting_target");
});
