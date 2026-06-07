import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScanFunnelArchivePayload,
  MAX_FUNNEL_EVENTS,
  MAX_WATCHLIST_REJECTED_EVENTS,
} from "./scanFunnelArchivePayload.js";

/** Fixture 3 tickers : SOFI ui_displayed, RIOT crypto_blocked, XYZ yahoo_rejected. */
function fixtureSources() {
  return {
    scanSessionId: "scan-fixture",
    scanTimestamp: "2026-06-07T12:00:00.000Z",
    selectedExpiration: "2026-06-19",
    dteAtScan: 12,
    poolSource: "watchlist",
    captureSource: "ibkr_auto_final",
    displayedSymbols: ["SOFI"],
    cryptoBlockedRemovedSymbols: ["RIOT"],
    yahooRejectedBySymbol: { XYZ: "low_liquidity" },
    metadata: { archiveComplete: true },
  };
}

function eventFor(payload, symbol, stage) {
  return payload.events.find((e) => e.symbol === symbol && e.stage === stage);
}

test("fixture — SOFI ui_displayed / RIOT crypto_blocked / XYZ yahoo_rejected", () => {
  const payload = buildScanFunnelArchivePayload(fixtureSources());
  assert.equal(payload.scanSessionId, "scan-fixture");
  assert.equal(payload.selectedExpiration, "2026-06-19");
  assert.equal(payload.dteAtScan, 12);

  assert.ok(eventFor(payload, "SOFI", "ui_displayed"), "SOFI doit être ui_displayed");
  assert.ok(eventFor(payload, "RIOT", "crypto_blocked"), "RIOT doit être crypto_blocked");
  assert.ok(eventFor(payload, "XYZ", "yahoo_rejected"), "XYZ doit être yahoo_rejected");
  assert.equal(eventFor(payload, "XYZ", "yahoo_rejected").reason, "low_liquidity");
});

test("crypto exclusif — un ticker crypto bloqué n'émet que crypto_blocked", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-crypto",
    cryptoBlockedRemovedSymbols: ["RIOT"],
    // RIOT apparaît aussi ailleurs : ces stages doivent être ignorés.
    displayedSymbols: ["RIOT"],
    yahooRejectedBySymbol: { RIOT: "should_be_ignored" },
    ibkrDirectSentTickers: ["RIOT"],
  });
  const riotEvents = payload.events.filter((e) => e.symbol === "RIOT");
  assert.equal(riotEvents.length, 1);
  assert.equal(riotEvents[0].stage, "crypto_blocked");
});

test("BITX non bloqué s'il n'est pas dans cryptoBlockedRemovedSymbols", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-bitx",
    displayedSymbols: ["BITX"],
    cryptoBlockedRemovedSymbols: ["RIOT"],
  });
  assert.equal(eventFor(payload, "BITX", "crypto_blocked"), undefined);
  assert.ok(eventFor(payload, "BITX", "ui_displayed"), "BITX doit rester ui_displayed");
});

test("funnelRows — yahoo_returned / ibkr_sent / ibkr_rejected / ibkr_retained", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-funnel",
    funnelRows: [
      { ticker: "AAA", yahooRank: 1, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" },
      { ticker: "BBB", yahooRank: 2, inShortlist: true, sentIbkr: true, ibkrStatus: "rejected", reason: "spread_too_wide" },
    ],
    displayedSymbols: ["AAA"],
  });
  assert.ok(eventFor(payload, "AAA", "yahoo_returned"));
  assert.ok(eventFor(payload, "AAA", "ibkr_sent"));
  assert.ok(eventFor(payload, "AAA", "ibkr_retained"));
  assert.ok(eventFor(payload, "AAA", "ui_displayed"));
  assert.ok(eventFor(payload, "BBB", "ibkr_rejected"));
  assert.equal(eventFor(payload, "BBB", "ibkr_rejected").reason, "spread_too_wide");
  // BBB retenu nulle part en UI mais rejeté IBKR → pas ui_lost (ui_lost = retenu non affiché).
  assert.equal(eventFor(payload, "BBB", "ui_lost"), undefined);
});

test("ui_lost — retenu IBKR mais absent de l'UI", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-uilost",
    funnelRows: [{ ticker: "CCC", inShortlist: true, sentIbkr: true, ibkrStatus: "retained" }],
    displayedSymbols: [], // pas affiché
  });
  assert.ok(eventFor(payload, "CCC", "ibkr_retained"));
  assert.ok(eventFor(payload, "CCC", "ui_lost"));
});

test("pas de rawJson dans metadata (sanitization)", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-meta",
    metadata: { archiveComplete: true, rawJson: '{"x":1}', note: "ok" },
  });
  assert.equal(payload.metadata.rawJson, undefined);
  assert.equal(payload.metadata.note, "ok");
  assert.equal(payload.metadata.archiveComplete, true);
});

test("archiveComplete par défaut selon présence de scanSessionId", () => {
  const withId = buildScanFunnelArchivePayload({ scanSessionId: "x" });
  assert.equal(withId.metadata.archiveComplete, true);
  const withoutId = buildScanFunnelArchivePayload({});
  assert.equal(withoutId.metadata.archiveComplete, false);
  assert.equal(withoutId.scanSessionId, null);
});

test("counts dérivés des events + override par counts fournis", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-counts",
    displayedSymbols: ["A", "B"],
    cryptoBlockedRemovedSymbols: ["RIOT"],
    counts: { preIbkrCount: 250 }, // fourni → conservé
  });
  assert.equal(payload.counts.uiDisplayedCount, 2);
  assert.equal(payload.counts.cryptoBlockedCount, 1);
  assert.equal(payload.counts.preIbkrCount, 250);
});

test("cap MAX_FUNNEL_EVENTS respecté", () => {
  const displayedSymbols = [];
  for (let i = 0; i < MAX_FUNNEL_EVENTS + 50; i += 1) displayedSymbols.push(`S${i}`);
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-cap",
    displayedSymbols,
  });
  assert.ok(payload.events.length <= MAX_FUNNEL_EVENTS);
  assert.equal(payload.events.length, MAX_FUNNEL_EVENTS);
});

test("Phase 1B — priorisation : UI/IBKR/Yahoo conservés, watchlist_rejected limité", () => {
  // Beaucoup de watchlist_rejected (assez pour saturer le cap à eux seuls) +
  // quelques events proches de la décision finale.
  const watchlistRejectedBySymbol = {};
  for (let i = 0; i < MAX_FUNNEL_EVENTS + 400; i += 1) {
    watchlistRejectedBySymbol[`WL${i}`] = "excluded_by_watchlist_limit";
  }
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-prio",
    watchlistRejectedBySymbol,
    cryptoBlockedRemovedSymbols: ["RIOT"],
    funnelRows: [
      { ticker: "AAA", yahooRank: 1, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" },
      { ticker: "BBB", yahooRank: 2, inShortlist: true, sentIbkr: true, ibkrStatus: "rejected", reason: "spread_too_wide" },
      { ticker: "CCC", yahooRank: 3, inShortlist: true, sentIbkr: true, ibkrStatus: "retained" }, // retenu non affiché → ui_lost
    ],
    displayedSymbols: ["AAA"],
  });

  // A. les stages proches de la décision finale sont conservés
  assert.ok(eventFor(payload, "AAA", "ui_displayed"), "ui_displayed conservé");
  assert.ok(eventFor(payload, "CCC", "ui_lost"), "ui_lost conservé");
  assert.ok(eventFor(payload, "AAA", "ibkr_retained"), "ibkr_retained conservé");
  assert.ok(eventFor(payload, "BBB", "ibkr_rejected"), "ibkr_rejected conservé");
  assert.ok(eventFor(payload, "AAA", "ibkr_sent"), "ibkr_sent conservé");
  assert.ok(eventFor(payload, "AAA", "yahoo_returned"), "yahoo_returned conservé");

  // B. watchlist_rejected plafonné à MAX_WATCHLIST_REJECTED_EVENTS
  const wlCount = payload.events.filter((e) => e.stage === "watchlist_rejected").length;
  assert.ok(wlCount <= MAX_WATCHLIST_REJECTED_EVENTS, `watchlist_rejected=${wlCount} <= ${MAX_WATCHLIST_REJECTED_EVENTS}`);
  assert.equal(wlCount, MAX_WATCHLIST_REJECTED_EVENTS);

  // C. cap 800 respecté
  assert.ok(payload.events.length <= MAX_FUNNEL_EVENTS, `events=${payload.events.length} <= ${MAX_FUNNEL_EVENTS}`);

  // D. crypto_blocked reste présent
  assert.ok(eventFor(payload, "RIOT", "crypto_blocked"), "crypto_blocked conservé");
});

test("Phase 1B — watchlist_rejected limité même sous le cap 800", () => {
  const watchlistRejectedBySymbol = {};
  for (let i = 0; i < MAX_WATCHLIST_REJECTED_EVENTS + 100; i += 1) {
    watchlistRejectedBySymbol[`WL${i}`] = "excluded_by_watchlist_limit";
  }
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-wl-cap",
    watchlistRejectedBySymbol,
  });
  const wlCount = payload.events.filter((e) => e.stage === "watchlist_rejected").length;
  assert.equal(wlCount, MAX_WATCHLIST_REJECTED_EVENTS);
  assert.ok(payload.events.length <= MAX_FUNNEL_EVENTS);
});

test("Phase 1B — crypto_blocked priorisé avant watchlist_rejected sous saturation", () => {
  const watchlistRejectedBySymbol = {};
  for (let i = 0; i < MAX_FUNNEL_EVENTS + 200; i += 1) {
    watchlistRejectedBySymbol[`WL${i}`] = "excluded_by_watchlist_limit";
  }
  const cryptoBlockedRemovedSymbols = [];
  for (let i = 0; i < 60; i += 1) cryptoBlockedRemovedSymbols.push(`CRX${i}`);
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-crypto-prio",
    watchlistRejectedBySymbol,
    cryptoBlockedRemovedSymbols,
  });
  const cryptoCount = payload.events.filter((e) => e.stage === "crypto_blocked").length;
  assert.equal(cryptoCount, 60, "tous les crypto_blocked conservés avant watchlist_rejected");
  assert.ok(payload.events.length <= MAX_FUNNEL_EVENTS);
});

test("payload ne contient aucune chaîne d'options / objet candidat complet", () => {
  const payload = buildScanFunnelArchivePayload({
    scanSessionId: "scan-clean",
    funnelRows: [{ ticker: "AAA", inShortlist: true, sentIbkr: true, ibkrStatus: "retained" }],
  });
  const json = JSON.stringify(payload);
  assert.equal(json.includes("optionChain"), false);
  assert.equal(json.includes("greeks"), false);
  assert.equal(json.includes("rawJson"), false);
});
