import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { createWheelScanner } from "./wheelScanner.js";
import { buildResearchExpandedPool } from "../watchlist/researchExpandedPool.js";
import {
  readStoredPoolCapacity, readStoredResearchExpandedLimit,
  callResearchExpandedPool, loadResearchExpandedPoolWithFallback,
} from "../../wheel-dashboard/src/preIbkrPool.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scannerPath = path.join(root, "app/scanners/wheelScanner.js");
const scannerSource = fs.readFileSync(scannerPath, "utf8");
const ui = fs.readFileSync(path.join(root, "wheel-dashboard/src/dashboard.jsx"), "utf8").replace(/\r\n/g, "\n");
const server = fs.readFileSync(path.join(root, "server.js"), "utf8").replace(/\r\n/g, "\n");
const sizes = [120, 180, 200, 250, 300, 400];
globalThis.fetch = async () => { throw new Error("Network forbidden in capacity fixtures"); };
const expiration = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const symbols = n => Array.from({ length: n }, (_, i) => `FIX${String(i).padStart(3, "0")}`);
const candidate = symbol => {
  const i = Number(symbol.slice(3));
  return { symbol, ok: true, passesFilter: true, qualityScore: i,
    finalScore: (i * 31) % 397, safeStrike: { strike: 90, premium: 1.5, annualizedYield: ((i * 7) % 401) / 100 } };
};

function sourceModule(source, filename) {
  const absoluteImports = source.replace(/from\s+(["'])(\.[^"']+)\1/g,
    (_, quote, relative) => `from ${quote}${pathToFileURL(path.resolve(path.dirname(filename), relative)).href}${quote}`);
  const relocated = absoluteImports.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(filename).href));
  return import(`data:text/javascript;base64,${Buffer.from(relocated + "\n//# sourceURL=" + pathToFileURL(filename).href + ".capacity-fixture").toString("base64")}`);
}

// Exercise the real batching, aggregation, diagnostics and comparators, with the
// financial primitive replaced only inside this in-memory test module.
const fixtureModule = await sourceModule(scannerSource.replace(
  "  async function scanTicker(symbol, expiration) {",
  "  async function scanTicker(symbol, expiration) { return globalThis.__wheelCapacityScanTicker(symbol, expiration); }\n  async function originalScanTicker(symbol, expiration) {"
), scannerPath);
function fixtureScanner(handler = async symbol => candidate(symbol)) {
  globalThis.__wheelCapacityScanTicker = handler;
  return fixtureModule.createWheelScanner({});
}

for (const size of sizes) {
  test(`${size}: complete Yahoo batches, global ranking, deduplication and no silent truncation`, async () => {
    const seen = [], completed = [];
    let active = 0, maxActive = 0;
    const scanner = fixtureScanner(async symbol => {
      if (Number(symbol.slice(3)) >= 200) assert.equal(completed.length >= 200, true);
      seen.push(symbol); active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve(); active--; completed.push(symbol);
      return candidate(symbol);
    });
    const pool = symbols(size);
    const result = await scanner.scanShortlistContinued({ expiration, tickers: [...pool, " fix000 ", "FIX000"], maxTickers: size, topN: 55, sort: "quality" });
    assert.equal(result.status, 200);
    const p = result.payload;
    const expectedBatches = size > 200 ? [200, size - 200] : [size];
    assert.deepEqual(p.scanCapacity.batches.map(b => b.scanned), expectedBatches);
    assert.equal(p.scanCapacity.complete, true);
    assert.equal(p.scanCapacity.available, size);
    assert.equal(p.scanned, size); assert.equal(p.kept, size); assert.equal(p.returned, 65);
    assert.deepEqual(p.shortlist.map(c => c.symbol), [...pool].reverse().slice(0, 65));
    assert.equal(new Set(seen).size, size); assert.equal(seen.length, size);
    assert.equal(maxActive, 8);
    const all = await scanner.scanShortlistContinued({ expiration, tickers: pool, maxTickers: size, topN: 400, sort: "quality" });
    assert.equal(all.payload.shortlist.length, size);
    console.log(JSON.stringify({ size, yahooBatches: expectedBatches, scanned: p.scanned, kept: p.kept, maxWorkers: maxActive }));
  });
}

test("all three original comparators apply globally, including ties", async () => {
  const scanner = fixtureScanner();
  for (const sort of ["quality", "score", "yield"]) {
    const expected = symbols(400).map(candidate).sort((a, b) => {
      const primary = sort === "quality" ? b.qualityScore - a.qualityScore : sort === "score" ? b.finalScore - a.finalScore : 0;
      return primary || b.safeStrike.annualizedYield - a.safeStrike.annualizedYield;
    });
    const p = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), maxTickers: 400, topN: 30, sort })).payload;
    assert.deepEqual(p.shortlist.map(c => c.symbol), expected.slice(0, sort === "quality" ? 40 : 30).map(c => c.symbol));
  }
  const tied = fixtureScanner(async symbol => ({ ...candidate(symbol), qualityScore: 50, finalScore: 1, safeStrike: { annualizedYield: 0.5 } }));
  for (const sort of ["quality", "score", "yield"]) {
    const p = (await tied.scanShortlistContinued({ expiration, tickers: symbols(400), topN: 400, sort })).payload;
    assert.deepEqual(p.shortlist.map(c => c.symbol), symbols(400));
  }
});

test("rejections, timeout and partial errors survive both batches", async () => {
  const scanner = fixtureScanner(async symbol => {
    if (["FIX002", "FIX202"].includes(symbol)) return { symbol, ok: false, reason: "expiration_not_available" };
    if (["FIX003", "FIX203"].includes(symbol)) throw new Error("fixture_timeout");
    if (symbol === "FIX204") return { ...candidate(symbol), passesFilter: false, debug: { reasonKept: "premium_below_target" } };
    return candidate(symbol);
  });
  const p = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), maxTickers: 400, topN: 400 })).payload;
  assert.equal(p.scanned, 400); assert.equal(p.kept, 395);
  assert.equal(p.rejected.length, 3); assert.equal(p.errors.length, 2);
  assert.equal(p.rejectionReasonCounts.expiration_not_available, 2);
  assert.equal(p.rejectionReasonCounts.fixture_timeout, 2);
  assert.equal(p.stageRejectCounts.premium_below_target, 1);
  assert.equal(p.scanCapacity.complete, true); assert.equal(p.scanCapacity.status, "partial_errors");
  const survivors = new Set(p.shortlist.map(c => c.symbol));
  for (const symbol of ["FIX002", "FIX003", "FIX202", "FIX203", "FIX204"]) assert.equal(survivors.has(symbol), false);
});

test("abort before the second batch preserves completed results and marks unprocessed symbols", async () => {
  const controller = new AbortController();
  const scanner = fixtureScanner(async symbol => {
    if (symbol === "FIX199") controller.abort();
    return candidate(symbol);
  });
  const p = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), topN: 400, signal: controller.signal })).payload;
  assert.equal(p.scanned, 200); assert.equal(p.scanCapacity.complete, false);
  assert.equal(p.scanCapacity.stopReason, "aborted");
  assert.deepEqual(p.scanCapacity.unprocessedTickers, symbols(400).slice(200));
  controller.abort();
  const stopped = await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), signal: controller.signal });
  assert.equal(stopped.payload.scanned, 0);
});

test("abort inside a batch accounts for the in-flight eight workers without starting more", async () => {
  const controller = new AbortController();
  const scanner = fixtureScanner(async symbol => { controller.abort(); return candidate(symbol); });
  const p = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), signal: controller.signal })).payload;
  assert.equal(p.scanned, 8); assert.equal(p.scanCapacity.unprocessedTickers.length, 392);
  assert.equal(p.scanCapacity.batches[0].complete, false);
});

test("available pool, requested cap and incomplete pool remain distinct; unit cap stays 200", async () => {
  const scanner = fixtureScanner();
  const p = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(65), maxTickers: 400, topN: 400 })).payload;
  assert.equal(p.scanCapacity.requested, 400); assert.equal(p.scanCapacity.available, 65);
  assert.equal(p.scanned, 65); assert.equal(p.scanCapacity.poolInsufficient, true); assert.equal(p.scanCapacity.complete, true);
  const limited = (await scanner.scanShortlistContinued({ expiration, tickers: symbols(400), maxTickers: 120 })).payload;
  assert.equal(limited.scanned, 120); assert.equal(limited.scanCapacity.limitedByRequest, 280);
  assert.equal((await scanner.scanShortlist({ expiration, tickers: symbols(201) })).status, 400);
  for (const maxTickers of [0, 401, 2.5, "400", NaN]) assert.equal((await scanner.scanShortlistContinued({ expiration, tickers: symbols(1), maxTickers })).status, 400);
});

test("global diagnostics retain the full 400-symbol funnel after the output cap", async () => {
  const flag = "YAHOO_FUNNEL_DIAGNOSTICS";
  const old = process.env[flag]; process.env[flag] = "1";
  try {
    const p = (await fixtureScanner().scanShortlistContinued({ expiration, tickers: symbols(400), topN: 30, sort: "quality" })).payload;
    assert.equal(p.scanFunnelDiagnosticsV1.scannedTickerCount, 400);
    assert.equal(p.scanFunnelDiagnosticsV1.returnedTickerCap, 40);
    assert.equal(p.scanFunnelDiagnosticsV1.passedCandidates.length, 400);
  } finally { if (old === undefined) delete process.env[flag]; else process.env[flag] = old; }
});

const requireUi = createRequire(path.join(root, "wheel-dashboard/package.json"));
const { transformSync } = requireUi("esbuild");
const fakeReact = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
function evaluateUiControl(label, context) {
  const start = ui.lastIndexOf("<EditableScanInput", ui.indexOf(`label="${label}"`));
  const end = ui.indexOf("/>", start) + 2;
  const code = transformSync(`const control = (${ui.slice(start, end)});`, { loader: "jsx", jsxFactory: "React.createElement" }).code;
  const sandbox = { React: fakeReact, EditableScanInput: "input-control", readStoredPoolCapacity, readStoredResearchExpandedLimit, ...context };
  return vm.runInNewContext(`${code}\ncontrol;`, sandbox);
}
function persistenceEffect(key, context) {
  const at = ui.indexOf(`window.localStorage.setItem("${key}"`);
  const start = ui.lastIndexOf("  useEffect(() => {", at);
  const end = ui.indexOf("\n  }, [", at);
  const code = ui.slice(start + "  useEffect(() => {".length, end);
  vm.runInNewContext(code, context);
}

for (const size of sizes) {
  test(`${size}: actual JSX controls, localStorage, Strict build and Yahoo/Research transport`, async () => {
    const storage = new Map(); let strict = 150, research = 200;
    evaluateUiControl("Strict max", { strictWatchlistLimit: strict, setStrictWatchlistLimit: v => { strict = v; } }).props.onChange({ target: { value: String(size) } });
    evaluateUiControl("Research limit", { researchExpandedLimit: research, setResearchExpandedLimit: v => { research = v; } }).props.onChange({ target: { value: String(size) } });
    assert.equal(strict, size); assert.equal(research, size);
    const window = { localStorage: { setItem: (k, v) => storage.set(k, v) } };
    persistenceEffect("wheel.strictWatchlistLimit", { window, strictWatchlistLimit: strict });
    persistenceEffect("wheel.researchExpandedLimit", { window, researchExpandedLimit: research });
    assert.equal(readStoredPoolCapacity(storage.get("wheel.strictWatchlistLimit")), size);
    assert.equal(readStoredResearchExpandedLimit(storage.get("wheel.researchExpandedLimit")), size);
    const bodyLine = ui.match(/const body = \{ \.\.\.DEFAULT_BUILD_WATCHLIST_BODY, limit: strictWatchlistLimit[^\n]+/)[0];
    const body = vm.runInNewContext(`${bodyLine}\nbody`, { DEFAULT_BUILD_WATCHLIST_BODY: { limit: 150 }, strictWatchlistLimit: strict, watchlistOtmProbePct: 5 });
    assert.equal(body.limit, size);
    const begin = ui.indexOf("async function callScanShortlist(");
    const fn = ui.slice(begin, ui.indexOf("\nfunction buildAutoJournalStrikePayload", begin));
    let request;
    const call = vm.runInNewContext(`${fn}\ncallScanShortlist`, { API_BASE: "http://offline.invalid", fetch: async (url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; } });
    await call({ expiration, tickers: symbols(size), topN: 55, maxTickers: size });
    assert.equal(request.maxTickers, size); assert.equal(request.tickers.length, size);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, pool: symbols(size) }) }; };
      await callResearchExpandedPool({ limit: size }); assert.equal(request.limit, size);
      const pool = buildResearchExpandedPool({ limit: size });
      assert.equal(pool.stats.limitApplied, size); assert.equal(pool.pool.length, size);
      assert.equal(pool.poolSource, "research_expanded");
      globalThis.fetch = async () => { throw new Error("fixture_offline"); };
      const fallback = await loadResearchExpandedPoolWithFallback({ limit: size });
      assert.equal(fallback.source, "static_fallback"); assert.equal(fallback.usedStaticFallback, true);
      assert.equal(fallback.stats.limitApplied, size);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("existing defaults, invalid stored values and route side effects remain bounded", () => {
  assert.equal(readStoredPoolCapacity(null), 150); assert.equal(readStoredResearchExpandedLimit(null), 200);
  assert.equal(buildResearchExpandedPool().stats.limitApplied, 200);
  for (const raw of ["", "bad", "401", "-1", "1.5"]) { assert.equal(readStoredPoolCapacity(raw), 150); assert.equal(readStoredResearchExpandedLimit(raw), 200); }
  assert.match(ui, /readStoredNumber\("wheel\.topYahooReturned", 55\)/);
  assert.match(ui, /readStoredNumber\("wheel\.ibkrAuditDepth", 50\)/);
  assert.match(ui, /limit: 150,/);
  const route = server.slice(server.indexOf('app.post("/scan_shortlist"'), server.indexOf('app.get("/journal/wheel-validation"'));
  assert.equal((route.match(/await wheelScanner\.scanShortlistContinued\(/g) || []).length, 1);
  assert.equal((route.match(/scanMetricsState.lastRefreshAt =/g) || []).length, 1);
  const incomplete = ui.slice(ui.indexOf("      if (payload.scanCapacity?.complete === false)"), ui.indexOf("      if (mapped.length > 0) {", ui.indexOf("      if (payload.scanCapacity?.complete === false)")));
  assert.match(incomplete, /IBKR auto non lancé/); assert.match(incomplete, /return;/);
});

test("the unchanged IBKR loop continues in batches of 50 using Yahoo survivors only", async () => {
  const batchAt = ui.indexOf("const ibkrScanBatchSize = await fetchIbkrScanBatchSize();");
  const start = ui.indexOf("        let cursor = 0;", batchAt);
  const end = ui.indexOf("        const payload = mergeIbkrProgressPayloads", start);
  const code = ui.slice(start, end);
  for (const { size, reject } of [...sizes.map(size => ({ size, reject: false })), { size: 400, reject: true }]) {
    const yahoo = (await fixtureScanner(async symbol => reject && symbol === "FIX000"
      ? { symbol, ok: false, reason: "fixture_rejected" } : candidate(symbol))
      .scanShortlistContinued({ expiration, tickers: symbols(size), topN: 400 })).payload;
    const calls = [], candidatePool = yahoo.shortlist.map(c => c.symbol), testedSymbols = [];
    const context = { candidatePool, hardEvaluationCap: size, desiredFinalKept: size, retainedSymbols: new Set(),
      testedSymbols, payloads: [], ibkrScanBatchSize: 50, expLocked: expiration, ibkrAutoClientIdStart: 1240,
      finalTarget: size, setIbkrDirectSentTickers() {}, setRefreshStage() {}, ymdToIbkr: x => x.replaceAll("-", ""),
      callIbkrDirectScan: async request => { calls.push(request); return { shortlist: [] }; } };
    await vm.runInNewContext(`(async () => { ${code} })()`, context);
    assert.deepEqual([...testedSymbols], candidatePool);
    assert.equal(testedSymbols.includes("FIX000"), !reject);
    assert(calls.every(c => c.tickers.length <= 50 && c.tickers.every(t => candidatePool.includes(t))));
    assert.equal(calls.length, Math.ceil(size / 50));
    console.log(JSON.stringify({ size, yahooSurvivors: candidatePool.length, ibkrBatches: calls.map(c => c.tickers.length), providerCalls: 0 }));
  }
});

const baselineDir = process.env.WHEEL_CAPACITY_BASELINE;
test("financial bytes and real scanTicker results match checkpoint preimages", { skip: !baselineDir }, async () => {
  const baselinePath = path.join(baselineDir, "app/scanners/wheelScanner.js");
  const before = fs.readFileSync(baselinePath, "utf8");
  assert.equal(scannerSource.slice(0, scannerSource.indexOf("  function sortShortlist(")), before.slice(0, before.indexOf("  async function scanShortlist(")));
  const baseline = await sourceModule(before, scannerPath);
  const researchFilename = path.join(root, "app/watchlist/researchExpandedPool.js");
  const oldResearch = await sourceModule(fs.readFileSync(path.join(baselineDir, "app/watchlist/researchExpandedPool.js"), "utf8"), researchFilename);
  for (const limit of [150, 200]) assert.deepEqual(buildResearchExpandedPool({ limit }), oldResearch.buildResearchExpandedPool({ limit }));
  assert.deepEqual(buildResearchExpandedPool({ limit: 400 }).pool.slice(0, 200), oldResearch.buildResearchExpandedPool({ limit: 200 }).pool);
  const market = {
    getOptionExpirations: async () => ({ availableExpirations: [expiration] }),
    getQuote: async () => ({ regularMarketPrice: 100, exchangeTimezoneName: "America/New_York" }),
    getExpectedMove: async () => ({ expectedMove: 5, currentPrice: 100 }),
    getOptionChain: async () => ({ currentPrice: 100, calls: [], puts: [80, 85, 90, 94, 96, 100].map(strike => ({ strike, bid: 1.5, ask: 1.6, lastPrice: 1.55, impliedVolatility: 0.4, openInterest: 2000, volume: 1000 })) }),
    getTechnicals: async () => ({ rsi14: 45, sma20: 98, sma50: 95 }),
    getSupportResistance: async () => ({ support: 90, resistance: 110 }),
  };
  const current = createWheelScanner(market), previous = baseline.createWheelScanner(market);
  const a = await current.scanTicker("FIX001", expiration), b = await previous.scanTicker("FIX001", expiration);
  assert.deepEqual(a, b); assert.equal(a.ok, true); assert(a.safeStrike); assert(a.aggressiveStrike);
  const oldUi = fs.readFileSync(path.join(baselineDir, "wheel-dashboard/src/dashboard.jsx"), "utf8").replace(/\r\n/g, "\n");
  const ibkr = s => s.slice(s.indexOf("const ibkrScanBatchSize = await fetchIbkrScanBatchSize();"), s.indexOf("        const payload = mergeIbkrProgressPayloads", s.indexOf("const ibkrScanBatchSize = await fetchIbkrScanBatchSize();")));
  assert.equal(ibkr(ui), ibkr(oldUi));
  const oldServer = fs.readFileSync(path.join(baselineDir, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const ibkrNormalizer = s => {
    const start = s.indexOf("function runIbkrShadowWheelBatch(body = {}) {");
    const end = s.indexOf('\napp.post("/scan_shortlist"', start);
    assert(start >= 0 && end > start);
    return s.slice(start, end);
  };
  assert.equal(ibkrNormalizer(server), ibkrNormalizer(oldServer));
  const p = await current.scanShortlistContinued({ expiration, tickers: symbols(400), topN: 400, sort: "quality" });
  assert.equal(p.payload.scanned, 400); assert.equal(p.payload.shortlist.length, 400);
  for (const size of sizes) {
    const oldPayload = (await previous.scanShortlist({ expiration, tickers: symbols(Math.min(size, 200)), topN: 400, sort: "quality" })).payload;
    const newPayload = (await current.scanShortlistContinued({ expiration, tickers: symbols(Math.min(size, 200)), topN: 400, sort: "quality" })).payload;
    const { scanCapacity, ...financialPayload } = newPayload;
    assert.deepEqual(financialPayload, oldPayload);
    const expected = [];
    for (let cursor = 0; cursor < size; cursor += 200) {
      const batch = await previous.scanShortlist({ expiration, tickers: symbols(size).slice(cursor, cursor + 200), topN: 400, sort: "quality" });
      assert.equal(batch.payload.errors.length, 0); assert.equal(batch.payload.rejected.length, 0);
      expected.push(...batch.payload.shortlist);
    }
    expected.sort((a, b) => b.qualityScore - a.qualityScore || b.safeStrike.annualizedYield - a.safeStrike.annualizedYield);
    const actual = (await current.scanShortlistContinued({ expiration, tickers: symbols(size), maxTickers: size, topN: 400, sort: "quality" })).payload;
    assert.deepEqual(actual.shortlist, expected);
    assert.equal(actual.scanned, size); assert.equal(actual.kept, size);
    console.log(JSON.stringify({ size, financialCandidateParity: expected.length, differentFields: 0 }));
  }
});

test("the actual Strict builder supplies all six requested capacities without changing its selection", async () => {
  const filename = path.join(root, "app/watchlist/watchlistBuilder.js");
  const source = fs.readFileSync(filename, "utf8").replace(
    'import { loadMasterUniverse, loadMergedUniverse } from "./universeLoader.js";',
    'const loadMergedUniverse = () => globalThis.__wheelCapacityUniverse; const loadMasterUniverse = loadMergedUniverse;'
  );
  assert.notEqual(source, fs.readFileSync(filename, "utf8"));
  globalThis.__wheelCapacityUniverse = symbols(450).map(symbol => ({ symbol, enabled: true, category: "core" }));
  const module = await sourceModule(source, filename);
  for (const size of sizes) {
    const cache = new Map();
    const builder = module.createWatchlistBuilder({ cache,
      marketService: { getQuote: async () => ({ regularMarketPrice: 100, averageDailyVolume3Month: 2_000_000, regularMarketVolume: 2_000_000 }) } });
    const p = await builder.buildWatchlist({ limit: size, categories: ["core"], maxPrice: 200, minVolume: 500_000,
      requireLiquidOptions: false, requireWeeklyOptions: false, maxContractCapital: 25500 });
    assert.equal(p.watchlist.length, size); assert.equal(p.stats.limitApplied, size);
    assert.deepEqual(p.watchlist, symbols(size));
  }
});

test("the HTTP route executes once for 400 and aggregates before its single side-effect phase", async () => {
  let handler, responseBody, metricsUpdates = 0;
  const metrics = { set lastRefreshAt(value) { metricsUpdates++; } };
  const route = server.slice(server.indexOf('app.post("/scan_shortlist"'), server.indexOf('app.get("/journal/wheel-validation"'));
  const scanner = fixtureScanner(); let scannerCalls = 0;
  vm.runInNewContext(route, {
    app: { post: (_route, fn) => { handler = fn; } }, AbortController,
    wheelScanner: { scanShortlistContinued: async args => { scannerCalls++; return scanner.scanShortlistContinued(args); } },
    scanMetricsState: metrics, isYahooLiquidityV3SimulationEnabled: () => false,
  });
  const response = { writableEnded: false, once() {}, status(code) { assert.equal(code, 200); return this; }, json(body) { responseBody = body; } };
  await handler({ body: { expiration, tickers: symbols(400), maxTickers: 400, topN: 400, sort: "quality" } }, response);
  assert.equal(scannerCalls, 1); assert.equal(metricsUpdates, 1);
  assert.equal(responseBody.scanned, 400); assert.equal(responseBody.shortlist.length, 400);
  assert.deepEqual(responseBody.scanCapacity.batches.map(b => b.scanned), [200, 200]);
});

test("a failed whole batch is explicit and never reported as a complete scan", async () => {
  const module = await sourceModule(scannerSource.replace('result = await scanShortlist(', 'result = await globalThis.__wheelCapacityBatch('), scannerPath);
  const unit = fixtureScanner();
  globalThis.__wheelCapacityBatch = args => {
    if (args.tickers[0] === "FIX200") throw new Error("fixture_batch_failure");
    return unit.scanShortlist(args);
  };
  const p = (await module.createWheelScanner({}).scanShortlistContinued({ expiration, tickers: symbols(400), topN: 400 })).payload;
  assert.equal(p.scanned, 200); assert.equal(p.scanCapacity.complete, false);
  assert.equal(p.scanCapacity.stopReason, "batch_failed");
  assert.equal(p.scanCapacity.batches[1].error, "fixture_batch_failure");
  assert.equal(p.scanCapacity.unprocessedTickers.length, 200);
});
