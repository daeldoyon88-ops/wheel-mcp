import test from "node:test";
import assert from "node:assert/strict";
import {
  isUsMarketClosedDate,
  getAdjustedExpirationForClosedMarket,
  getUsMarketHolidayLabel,
  buildExpirationOptions,
} from "./marketCalendar.js";

test("isUsMarketClosedDate — fériés US 2026", () => {
  assert.equal(isUsMarketClosedDate("2026-06-19"), true); // Juneteenth (vendredi)
  assert.equal(isUsMarketClosedDate("2026-07-03"), true); // Independence Day observé (vendredi)
  assert.equal(isUsMarketClosedDate("2026-12-25"), true); // Christmas (vendredi)
  assert.equal(isUsMarketClosedDate("20260619"), true); // format compact accepté
});

test("isUsMarketClosedDate — week-ends et jours ouverts", () => {
  assert.equal(isUsMarketClosedDate("2026-06-20"), true); // samedi
  assert.equal(isUsMarketClosedDate("2026-06-21"), true); // dimanche
  assert.equal(isUsMarketClosedDate("2026-06-18"), false); // jeudi ouvert
  assert.equal(isUsMarketClosedDate("2026-06-26"), false); // vendredi ouvert
  assert.equal(isUsMarketClosedDate("invalid"), false);
});

test("getAdjustedExpirationForClosedMarket — vendredi fermé → jeudi précédent", () => {
  const adj = getAdjustedExpirationForClosedMarket("2026-06-19");
  assert.equal(adj.closed, true);
  assert.equal(adj.adjusted, "2026-06-18"); // jeudi précédent, PAS le lundi suivant
  assert.equal(adj.reason, "friday_to_thursday");
  assert.equal(adj.holidayLabel, "Juneteenth");
  assert.equal(adj.blocked, false);
});

test("getAdjustedExpirationForClosedMarket — lundi fermé → mardi suivant", () => {
  const adj = getAdjustedExpirationForClosedMarket("2026-05-25"); // Memorial Day (lundi)
  assert.equal(adj.closed, true);
  assert.equal(adj.adjusted, "2026-05-26"); // mardi suivant, PAS le vendredi précédent
  assert.equal(adj.reason, "monday_to_tuesday");
});

test("getAdjustedExpirationForClosedMarket — expiration ouverte inchangée", () => {
  const adj = getAdjustedExpirationForClosedMarket("2026-06-26");
  assert.equal(adj.closed, false);
  assert.equal(adj.adjusted, "2026-06-26");
  assert.equal(adj.reason, "open");
});

test("getAdjustedExpirationForClosedMarket — week-end → prochaine date ouverte", () => {
  const adj = getAdjustedExpirationForClosedMarket("2026-06-20"); // samedi
  assert.equal(adj.closed, true);
  assert.equal(adj.adjusted, "2026-06-22"); // lundi suivant (ouvert)
  assert.equal(adj.reason, "next_open_day");
  assert.ok(adj.warning);
});

test("getUsMarketHolidayLabel", () => {
  assert.equal(getUsMarketHolidayLabel("2026-06-19"), "Juneteenth");
  assert.equal(getUsMarketHolidayLabel("2026-06-18"), null);
});

test("buildExpirationOptions — Juneteenth remplacé, vendredis normaux intacts", () => {
  const opts = buildExpirationOptions([
    "2026-06-12",
    "2026-06-19", // Juneteenth fermé
    "2026-06-26",
  ]);

  // Vendredi ouvert : strictement inchangé.
  assert.deepEqual(
    { value: opts[0].value, label: opts[0].label, closed: opts[0].closed },
    { value: "2026-06-12", label: "2026-06-12", closed: false }
  );

  // Juneteenth : la valeur envoyée au scan devient le jeudi précédent.
  assert.equal(opts[1].value, "2026-06-18");
  assert.equal(opts[1].original, "2026-06-19");
  assert.equal(opts[1].closed, true);
  assert.equal(opts[1].blocked, false);
  assert.match(opts[1].label, /2026-06-18/);
  assert.match(opts[1].label, /2026-06-19/);

  // Vendredi ouvert suivant : inchangé.
  assert.equal(opts[2].value, "2026-06-26");
  assert.equal(opts[2].closed, false);
});
