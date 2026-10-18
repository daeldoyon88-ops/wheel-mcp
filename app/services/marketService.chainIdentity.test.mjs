import assert from "node:assert/strict";
import test from "node:test";

import {
  createMarketService,
  describeYahooChainIdentity,
  ymdFromOccOptionSymbol,
  ymdFromProviderExpiration,
} from "./marketService.js";

test("ymdFromOccOptionSymbol lit la date encodée, pas lastTradeDate", () => {
  assert.equal(ymdFromOccOptionSymbol("TQQQ261030P00050000"), "2026-10-30");
  assert.equal(ymdFromOccOptionSymbol("AAPL261023C00150000"), "2026-10-23");
  assert.equal(ymdFromOccOptionSymbol(null), null);
});

test("ymdFromProviderExpiration accepte Date et unix", () => {
  assert.equal(ymdFromProviderExpiration(new Date("2026-10-30T00:00:00Z")), "2026-10-30");
  assert.equal(ymdFromProviderExpiration("2026-10-23"), "2026-10-23");
});

test("describeYahooChainIdentity — identique / discordante / absente", () => {
  const match = describeYahooChainIdentity({
    requestedExpiration: "2026-10-23",
    optionsNode: { expirationDate: new Date("2026-10-23T00:00:00Z") },
    firstPut: { contractSymbol: "TQQQ261023P00050000" },
  });
  assert.equal(match.expirationMismatch, false);
  assert.equal(match.returnedExpiration, "2026-10-23");

  const mismatch = describeYahooChainIdentity({
    requestedExpiration: "2026-10-23",
    optionsNode: { expirationDate: new Date("2026-10-30T00:00:00Z") },
    firstPut: { contractSymbol: "TQQQ261030P00050000" },
  });
  assert.equal(mismatch.expirationMismatch, true);
  assert.equal(mismatch.returnedExpiration, "2026-10-30");
  assert.equal(mismatch.expirationMismatchReason, "yahoo_chain_expiration_mismatch");

  const absent = describeYahooChainIdentity({
    requestedExpiration: "2026-10-23",
    optionsNode: {},
    firstPut: { contractSymbol: "NODATE" },
  });
  assert.equal(absent.expirationMismatch, false);
  assert.equal(absent.returnedExpiration, null);
  assert.equal(absent.expirationMismatchReason, null);
});

test("getOptionChain conserve identité réelle et ne stamp pas l'expiration demandée si discordante", async () => {
  const provider = {
    async getOptions() {
      return {
        quote: { regularMarketPrice: 55 },
        options: [{
          expirationDate: new Date("2026-10-30T00:00:00Z"),
          calls: [{
            contractSymbol: "TQQQ261030C00055000",
            strike: 55,
            bid: 1,
            ask: 1.1,
            lastTradeDate: new Date("2026-10-15T19:59:00Z"),
            multiplier: 100,
          }],
          puts: [{
            contractSymbol: "TQQQ261030P00050000",
            strike: 50,
            bid: null,
            ask: 0.3,
            volume: null,
            openInterest: 0,
            lastTradeDate: new Date("2026-10-15T19:59:00Z"),
            multiplier: 100,
          }],
        }],
      };
    },
  };
  const svc = createMarketService(provider);
  const chain = await svc.getOptionChain("TQQQ", "2026-10-23");
  assert.equal(chain.requestedExpiration, "2026-10-23");
  assert.equal(chain.returnedExpiration, "2026-10-30");
  assert.equal(chain.expirationMismatch, true);
  assert.equal(chain.expirationMismatchReason, "yahoo_chain_expiration_mismatch");
  const put = chain.puts[0];
  assert.equal(put.expiration, "2026-10-30");
  assert.equal(put.contractSymbol, "TQQQ261030P00050000");
  assert.equal(put.bid, null);
  assert.equal(put.multiplier, 100);
  assert.ok(put.lastTradeDate);
  assert.equal(put.lastTradeDateIsNotBidAskTime, true);
  assert.notEqual(put.expiration, chain.requestedExpiration);
});

test("getOptionChain expiration identique : pas de discordance, bid 0 conservé", async () => {
  const provider = {
    async getOptions() {
      return {
        quote: { regularMarketPrice: 55 },
        options: [{
          expirationDate: new Date("2026-10-23T00:00:00Z"),
          puts: [{ contractSymbol: "TQQQ261023P00050000", strike: 50, bid: 0, ask: 0.4, multiplier: 100 }],
          calls: [],
        }],
      };
    },
  };
  const chain = await createMarketService(provider).getOptionChain("TQQQ", "2026-10-23");
  assert.equal(chain.expirationMismatch, false);
  assert.equal(chain.puts[0].bid, 0);
  assert.equal(chain.puts[0].expiration, "2026-10-23");
});
