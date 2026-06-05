import assert from "node:assert/strict";
import test from "node:test";

import {
  IBKR_SCAN_CONCURRENCY_DEFAULT,
  IBKR_SCAN_CONCURRENCY_MAX,
  IBKR_SCAN_CONCURRENCY_MIN,
  resolveIbkrScanConcurrency,
} from "./ibkr.js";

test("resolveIbkrScanConcurrency: défaut 5 sans variable", () => {
  assert.equal(resolveIbkrScanConcurrency(undefined), 5);
  assert.equal(resolveIbkrScanConcurrency(""), 5);
  assert.equal(IBKR_SCAN_CONCURRENCY_DEFAULT, 5);
});

test("resolveIbkrScanConcurrency: valeur explicite respectée dans les bornes", () => {
  assert.equal(resolveIbkrScanConcurrency("3"), 3);
  assert.equal(resolveIbkrScanConcurrency("1"), 1);
  assert.equal(resolveIbkrScanConcurrency("5"), 5);
});

test("resolveIbkrScanConcurrency: clamp [1, 5]", () => {
  assert.equal(resolveIbkrScanConcurrency("0"), IBKR_SCAN_CONCURRENCY_MIN);
  assert.equal(resolveIbkrScanConcurrency("-2"), IBKR_SCAN_CONCURRENCY_MIN);
  assert.equal(resolveIbkrScanConcurrency("6"), IBKR_SCAN_CONCURRENCY_MAX);
  assert.equal(resolveIbkrScanConcurrency("100"), IBKR_SCAN_CONCURRENCY_MAX);
});

test("resolveIbkrScanConcurrency: valeur non numérique -> défaut 5", () => {
  assert.equal(resolveIbkrScanConcurrency("abc"), IBKR_SCAN_CONCURRENCY_DEFAULT);
});
