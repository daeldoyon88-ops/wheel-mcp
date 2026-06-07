import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createScanFunnelArchiveStore, MAX_EVENTS } from "./scanFunnelArchiveStore.js";

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sfa-test-"));
  return path.join(dir, "journal.sqlite");
}

function sampleEvents() {
  return [
    { symbol: "SOFI", stage: "ui_displayed", rank: 1 },
    { symbol: "RIOT", stage: "crypto_blocked", reason: "crypto_blocked" },
    { symbol: "XYZ", stage: "yahoo_rejected", reason: "low_liquidity" },
  ];
}

test("ensureInitialized — crée les tables de façon idempotente", async () => {
  const sqlitePath = tmpDbPath();
  const store = createScanFunnelArchiveStore({ sqlitePath });
  await store.ensureInitialized();
  // Deuxième appel ne doit pas throw (idempotent).
  await store.ensureInitialized();
  // Un store distinct sur le même fichier doit fonctionner sans recréer/casser.
  const store2 = createScanFunnelArchiveStore({ sqlitePath });
  await store2.ensureInitialized();
  assert.ok(true);
});

test("archiveSession + getSession — persiste session + events", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  const res = await store.archiveSession({
    scanSessionId: "scan-001",
    scanTimestamp: "2026-06-07T12:00:00.000Z",
    selectedExpiration: "2026-06-19",
    dteAtScan: 12,
    poolSource: "watchlist",
    captureSource: "ibkr_auto_final",
    counts: { uiDisplayedCount: 1, ibkrRetainedCount: 0 },
    metadata: { archiveComplete: true },
    events: sampleEvents(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.scanSessionId, "scan-001");
  assert.equal(res.eventsArchived, 3);

  const got = await store.getSession("scan-001");
  assert.ok(got);
  assert.equal(got.session.scan_session_id, "scan-001");
  assert.equal(got.session.dte_at_scan, 12);
  assert.equal(got.session.ui_displayed_count, 1);
  assert.deepEqual(got.session.metadata, { archiveComplete: true });
  assert.equal(got.events.length, 3);
  const riot = got.events.find((e) => e.symbol === "RIOT");
  assert.equal(riot.stage, "crypto_blocked");
});

test("getSession — null si session absente", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  const got = await store.getSession("does-not-exist");
  assert.equal(got, null);
});

test("archiveSession — re-archiver le même scanSessionId ne duplique pas les events", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  await store.archiveSession({ scanSessionId: "scan-dup", events: sampleEvents() });
  await store.archiveSession({ scanSessionId: "scan-dup", events: sampleEvents() });
  const got = await store.getSession("scan-dup");
  assert.equal(got.events.length, 3, "les events ne doivent pas être dupliqués");
  // Une seule session.
  const sessions = await store.listSessions({ limit: 50 });
  assert.equal(sessions.filter((s) => s.scan_session_id === "scan-dup").length, 1);
});

test("archiveSession — dédup interne par symbol+stage", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  await store.archiveSession({
    scanSessionId: "scan-dedup",
    events: [
      { symbol: "AAA", stage: "ibkr_sent" },
      { symbol: "aaa", stage: "ibkr_sent" }, // même couple après normalisation
      { symbol: "AAA", stage: "ibkr_rejected" },
    ],
  });
  const got = await store.getSession("scan-dedup");
  assert.equal(got.events.length, 2);
});

test("archiveSession — refuse scanSessionId absent", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  const res = await store.archiveSession({ events: sampleEvents() });
  assert.equal(res.ok, false);
  assert.match(res.error, /scanSessionId/);
});

test("archiveSession — refuse > MAX_EVENTS", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  const events = [];
  for (let i = 0; i < MAX_EVENTS + 1; i += 1) {
    events.push({ symbol: `S${i}`, stage: "yahoo_returned" });
  }
  const res = await store.archiveSession({ scanSessionId: "scan-big", events });
  assert.equal(res.ok, false);
  assert.match(res.error, /too many events/);
  // Rien ne doit avoir été archivé.
  const got = await store.getSession("scan-big");
  assert.equal(got, null);
});

test("archiveSession — ne stocke jamais rawJson dans metadata_json", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  await store.archiveSession({
    scanSessionId: "scan-meta",
    metadata: { archiveComplete: true, rawJson: '{"huge":"payload"}', note: "ok" },
    events: [{ symbol: "AAA", stage: "ui_displayed", metadata: { rawJson: "x", keep: 1 } }],
  });
  const got = await store.getSession("scan-meta");
  assert.equal(got.session.metadata.rawJson, undefined);
  assert.equal(got.session.metadata.note, "ok");
  const ev = got.events[0];
  assert.equal(ev.metadata.rawJson, undefined);
  assert.equal(ev.metadata.keep, 1);
});

test("listSessions — ordre récent + event_count", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  await store.archiveSession({ scanSessionId: "s1", events: [{ symbol: "A", stage: "ui_displayed" }] });
  await store.archiveSession({ scanSessionId: "s2", events: sampleEvents() });
  const sessions = await store.listSessions({ limit: 10 });
  assert.equal(sessions.length, 2);
  const s2 = sessions.find((s) => s.scan_session_id === "s2");
  assert.equal(s2.event_count, 3);
});

test("purgeOldSessions — respecte maxSessions", async () => {
  const store = createScanFunnelArchiveStore({ sqlitePath: tmpDbPath() });
  for (let i = 0; i < 5; i += 1) {
    await store.archiveSession({
      scanSessionId: `p${i}`,
      events: [{ symbol: "A", stage: "ui_displayed" }],
    });
  }
  const res = await store.purgeOldSessions({ maxSessions: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.removed, 3);
  const remaining = await store.listSessions({ limit: 50 });
  assert.equal(remaining.length, 2);
});
