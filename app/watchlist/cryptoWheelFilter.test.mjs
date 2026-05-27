import test from "node:test";
import assert from "node:assert/strict";
import {
  CRYPTO_BLOCK_REASON,
  collectCryptoFilterDiagnostics,
  getCryptoBlockReason,
  isCryptoAllowed,
  isCryptoDigitalAssetBlocked,
  isCryptoRelatedEquity,
  filterCryptoBlockedSymbols,
} from "./cryptoWheelFilter.js";

test("ETHA et GBTC sont bloqués", () => {
  assert.equal(isCryptoDigitalAssetBlocked("ETHA"), true);
  assert.equal(isCryptoDigitalAssetBlocked("GBTC"), true);
  assert.equal(getCryptoBlockReason("ETHA"), CRYPTO_BLOCK_REASON);
});

test("BITX reste autorisé", () => {
  assert.equal(isCryptoAllowed("BITX"), true);
  assert.equal(isCryptoDigitalAssetBlocked("BITX"), false);
  assert.equal(getCryptoBlockReason("BITX"), null);
});

test("MSTR et COIN ne sont pas bloqués automatiquement", () => {
  assert.equal(isCryptoDigitalAssetBlocked("MSTR"), false);
  assert.equal(isCryptoDigitalAssetBlocked("COIN"), false);
  assert.equal(isCryptoRelatedEquity("MSTR"), true);
  assert.equal(isCryptoRelatedEquity("COIN"), true);
});

test("filterCryptoBlockedSymbols retire les digital assets", () => {
  const kept = filterCryptoBlockedSymbols(["TQQQ", "ETHA", "BITX", "GBTC", "SOFI"]);
  assert.deepEqual(kept, ["TQQQ", "BITX", "SOFI"]);
});

test("collectCryptoFilterDiagnostics — liste supprimés et BITX conservé", () => {
  const diag = collectCryptoFilterDiagnostics(["ETHA", "GBTC", "BITX", "TQQQ"]);
  assert.equal(diag.cryptoBlockedRemovedCount, 2);
  assert.deepEqual(diag.cryptoBlockedRemovedSymbols, ["ETHA", "GBTC"]);
  assert.deepEqual(diag.cryptoAllowedRetained, ["BITX"]);
});
