import test from "node:test";
import assert from "node:assert/strict";
import { createWheelValidationService } from "./wheelValidationService.js";

function makeCandidate(symbol = "TQQQ") {
  return {
    symbol,
    expiration: "20260620",
    safeStrike: { strike: 50, premium: 0.5, bid: 0.48, ask: 0.52 },
    aggressiveStrike: { strike: 55, premium: 0.7, bid: 0.68, ask: 0.72 },
  };
}

function makeMarketContextSnapshot() {
  return {
    source: "Yahoo",
    snapshotTimestamp: "2026-06-05T14:00:00.000Z",
    spyPrice: 600.12,
    spyMa50: 590.5,
    spyMa200: 560.25,
    qqqPrice: 520.34,
    qqqMa50: 510.1,
    qqqMa200: 480.75,
    vixLevel: 16.4,
    marketRegimeLabel: "favorable",
    spyTrendLabel: "haussier",
    qqqTrendLabel: "haussier",
    vixRegimeLabel: "normal",
    breadthLabel: "inconnu",
    marketRiskLabel: "normal",
    warnings: ["s5th_non_disponible"],
  };
}

function makeStore(overrides = {}) {
  const journal = { version: "1.0", records: [] };
  const calls = {
    save: [],
    insertMarketContextSnapshot: [],
  };
  return {
    calls,
    store: {
      load: async () => journal,
      save: async (nextJournal) => {
        calls.save.push(nextJournal);
        return nextJournal;
      },
      insertMarketContextSnapshot: async (snapshotRow) => {
        calls.insertMarketContextSnapshot.push(snapshotRow);
        if (overrides.throwOnInsert) throw new Error("sqlite insert failed");
        return { changes: 1 };
      },
      ...overrides.store,
    },
  };
}

test("captureFromCandidates persiste un seul market_context_snapshot par capture avec le snapshot deja construit", async () => {
  const snapshot = makeMarketContextSnapshot();
  const { store, calls } = makeStore();
  let marketFetchCount = 0;
  const service = createWheelValidationService({
    store,
    marketService: {
      getSupportResistance: async () => {
        marketFetchCount += 1;
        throw new Error("unexpected market refetch");
      },
    },
  });

  const result = await service.captureFromCandidates([makeCandidate("TQQQ")], {
    scanTimestamp: "2026-06-05T14:00:00.000Z",
    scanSessionId: "scan-market-context-1",
    marketContextSnapshot: snapshot,
  });

  assert.equal(result.captured, 2);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.insertMarketContextSnapshot.length, 1);
  assert.equal(marketFetchCount, 0);

  const inserted = calls.insertMarketContextSnapshot[0];
  assert.equal(inserted.record_id, result.records[0].id);
  assert.equal(inserted.scan_date, "2026-06-05");
  assert.equal(inserted.ticker, "TQQQ");
  assert.equal(inserted.expiration, "20260620");
  assert.equal(inserted.qqq_price, snapshot.qqqPrice);
  assert.equal(inserted.spy_price, snapshot.spyPrice);
  assert.equal(inserted.vix_level, snapshot.vixLevel);
  assert.equal(inserted.market_regime, snapshot.marketRegimeLabel);
  assert.equal(result.records[0].marketContextSnapshot, snapshot);
  assert.equal(result.records[1].marketContextSnapshot, snapshot);
});

test("captureFromCandidates continue si insertMarketContextSnapshot echoue", async () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    const { store, calls } = makeStore({ throwOnInsert: true });
    const service = createWheelValidationService({ store });

    const result = await service.captureFromCandidates([makeCandidate("TQQQ")], {
      scanTimestamp: "2026-06-05T14:00:00.000Z",
      scanSessionId: "scan-market-context-throw",
      marketContextSnapshot: makeMarketContextSnapshot(),
    });

    assert.equal(result.captured, 2);
    assert.equal(calls.save.length, 1);
    assert.equal(calls.insertMarketContextSnapshot.length, 1);
    assert.ok(warnings.some((message) => message.includes("insertMarketContextSnapshot failed")));
  } finally {
    console.warn = originalWarn;
  }
});

test("captureFromCandidates ignore la table dediee sans snapshot ou sans record cree", async () => {
  const withoutSnapshot = makeStore();
  const serviceWithoutSnapshot = createWheelValidationService({ store: withoutSnapshot.store });
  const resultWithoutSnapshot = await serviceWithoutSnapshot.captureFromCandidates([makeCandidate("TQQQ")], {
    scanTimestamp: "2026-06-05T14:00:00.000Z",
    scanSessionId: "scan-market-context-no-snapshot",
  });

  assert.equal(resultWithoutSnapshot.captured, 2);
  assert.equal(withoutSnapshot.calls.insertMarketContextSnapshot.length, 0);

  const withoutRecords = makeStore();
  const serviceWithoutRecords = createWheelValidationService({ store: withoutRecords.store });
  const resultWithoutRecords = await serviceWithoutRecords.captureFromCandidates(
    [{ symbol: "BAD", expiration: "20260620" }],
    {
      scanTimestamp: "2026-06-05T14:00:00.000Z",
      scanSessionId: "scan-market-context-no-records",
      marketContextSnapshot: makeMarketContextSnapshot(),
    }
  );

  assert.equal(resultWithoutRecords.captured, 0);
  assert.equal(withoutRecords.calls.save.length, 0);
  assert.equal(withoutRecords.calls.insertMarketContextSnapshot.length, 0);
});
