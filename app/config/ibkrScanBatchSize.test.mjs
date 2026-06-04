import assert from "node:assert/strict";
import test from "node:test";

import {
  IBKR_SCAN_BATCH_SIZE_DEFAULT,
  IBKR_SCAN_BATCH_SIZE_MAX,
  IBKR_SCAN_BATCH_SIZE_MIN,
  resolveIbkrScanBatchSize,
} from "./ibkr.js";

test("resolveIbkrScanBatchSize: défaut 50 sans variable", () => {
  assert.equal(resolveIbkrScanBatchSize(undefined), 50);
  assert.equal(resolveIbkrScanBatchSize(""), 50);
  assert.equal(IBKR_SCAN_BATCH_SIZE_DEFAULT, 50);
});

test("resolveIbkrScanBatchSize: valeur explicite respectée dans les bornes", () => {
  assert.equal(resolveIbkrScanBatchSize("30"), 30);
  assert.equal(resolveIbkrScanBatchSize("5"), 5);
  assert.equal(resolveIbkrScanBatchSize("50"), 50);
});

test("resolveIbkrScanBatchSize: clamp prudent [5, 50]", () => {
  assert.equal(resolveIbkrScanBatchSize("0"), IBKR_SCAN_BATCH_SIZE_MIN);
  assert.equal(resolveIbkrScanBatchSize("4"), IBKR_SCAN_BATCH_SIZE_MIN);
  assert.equal(resolveIbkrScanBatchSize("100"), IBKR_SCAN_BATCH_SIZE_MAX);
  assert.equal(resolveIbkrScanBatchSize("-7"), IBKR_SCAN_BATCH_SIZE_MIN);
});

test("resolveIbkrScanBatchSize: valeur non numérique -> défaut", () => {
  assert.equal(resolveIbkrScanBatchSize("abc"), IBKR_SCAN_BATCH_SIZE_DEFAULT);
});
